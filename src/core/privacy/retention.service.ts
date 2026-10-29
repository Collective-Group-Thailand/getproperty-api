import { OBJECT_STORAGE, type ObjectStorage } from '@collective/integrations/storage';
import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { StorageLedger } from '../storage/storage-ledger';

interface PolicyRow {
  target: 'document_class' | 'table';
  target_key: string;
  retain_seconds: number;
  basis: string;
  action: 'delete' | 'anonymise' | 'archive';
}

/** Tables the job may purge and the column each policy's period counts from (whitelist; no dynamic SQL from data). */
const TABLES: Record<string, { column: string; sql: (cutoff: string) => string }> = {
  'platform.otp_challenge': {
    column: 'created_at',
    sql: (c) => `DELETE FROM platform.otp_challenge WHERE created_at < '${c}'::timestamptz`,
  },
  'platform.auth_session': {
    column: 'expires_at',
    sql: (c) => `DELETE FROM platform.auth_session WHERE expires_at < '${c}'::timestamptz`,
  },
  'platform.idempotency_key': {
    column: 'expires_at',
    sql: (c) => `DELETE FROM platform.idempotency_key WHERE expires_at < '${c}'::timestamptz`,
  },
  'platform.notification': {
    column: 'created_at',
    sql: (c) => `DELETE FROM platform.notification WHERE created_at < '${c}'::timestamptz`,
  },
};

export interface RetentionReport {
  target: string;
  key: string;
  action: string;
  executed: boolean;
  affected: number;
  note?: string;
}

/**
 * Retention job (D-025; `platform.retention_policy`, worker, daily). Policies whose basis is marked ⚖ (pending legal
 * review) are **reported, never executed** (seed note: "no deletion before review"); `archive` actions are reported
 * until the archive target exists (B6.5). Executed table purges use a whitelist of tables and columns; document
 * classes delete the object and soft-delete the row (`delete_reason = retention`). One audit row per run.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: StorageLedger,
  ) {}

  async run(): Promise<RetentionReport[]> {
    const now = this.clock.now();
    return RequestContext.run({ actor: systemActor('retention') }, async () => {
      const policies = await this.db.platform(
        (tx) =>
          tx.$queryRaw<PolicyRow[]>`
          SELECT DISTINCT ON (target, target_key) target::text AS target, target_key,
                 extract(epoch FROM retain_for)::float8 AS retain_seconds, basis, action::text AS action
            FROM platform.retention_policy WHERE effective_from <= ${now.toISOString()}::date
           ORDER BY target, target_key, effective_from DESC`,
      );
      const report: RetentionReport[] = [];
      for (const p of policies) {
        const cutoff = new Date(now.getTime() - p.retain_seconds * 1000).toISOString();
        const pending = p.basis.includes('⚖');
        if (p.target === 'table') {
          const table = TABLES[p.target_key];
          if (!table) {
            report.push({
              target: p.target,
              key: p.target_key,
              action: p.action,
              executed: false,
              affected: 0,
              note: 'not purgeable by this job',
            });
            continue;
          }
          const count = await this.db.platform((tx) =>
            tx.$queryRawUnsafe<{ n: number }[]>(
              `SELECT count(*)::int AS n FROM ${p.target_key} WHERE ${table.column} < $1::timestamptz`,
              cutoff,
            ),
          );
          const affected = count[0]?.n ?? 0;
          if (pending || p.action !== 'delete') {
            report.push({
              target: p.target,
              key: p.target_key,
              action: p.action,
              executed: false,
              affected,
              note: pending ? 'pending legal review (⚖)' : 'action not automated',
            });
            continue;
          }
          await this.db.platform((tx) => tx.$executeRawUnsafe(table.sql(cutoff)));
          report.push({ target: p.target, key: p.target_key, action: p.action, executed: true, affected });
        } else {
          const docs = await this.db.platform((tx) =>
            tx.document.findMany({
              where: {
                retentionClass: p.target_key,
                deletedAt: null,
                createdAt: { lt: new Date(cutoff) },
                // D-286: a document under a legal hold is never deleted before its retention date
                OR: [
                  { documentLegalHoldDocument: null },
                  { documentLegalHoldDocument: { releasedAt: { not: null } } },
                  { documentLegalHoldDocument: { retainUntil: { lte: now } } },
                ],
              },
              select: { id: true, storageKey: true, thumbnailKey: true },
              take: 1000,
            }),
          );
          if (pending || p.action !== 'delete') {
            report.push({
              target: p.target,
              key: p.target_key,
              action: p.action,
              executed: false,
              affected: docs.length,
              note: pending ? 'pending legal review (⚖)' : 'action not automated',
            });
            continue;
          }
          for (const d of docs) {
            // G1: the quota drops by the file and its derivatives; G review #7: the row update (where the legal-hold
            // guard fires) commits first, the objects go after
            const keys = await this.db.platform(async (tx) => {
              const derivatives = await this.ledger.uncount(tx, d.id);
              await tx.document.update({
                where: { id: d.id },
                data: { deletedAt: now, deleteReason: 'retention', uploadState: 'deleted' },
              });
              return [d.storageKey, ...(d.thumbnailKey ? [d.thumbnailKey] : []), ...derivatives];
            });
            for (const key of new Set(keys)) await this.storage.delete(key).catch(() => undefined);
          }
          report.push({
            target: p.target,
            key: p.target_key,
            action: p.action,
            executed: true,
            affected: docs.length,
          });
        }
      }
      await this.audit.recordAlone({
        action: 'retention.executed',
        metadata: { runAt: now.toISOString(), report: report.map((r) => ({ ...r })) },
      });
      this.logger.log(
        `retention: ${report.filter((r) => r.executed).length} policies executed, ${report.length} evaluated`,
      );
      return report;
    });
  }
}

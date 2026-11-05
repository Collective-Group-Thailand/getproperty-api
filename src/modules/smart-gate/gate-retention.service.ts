import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, Logger } from '@nestjs/common';

export interface GateRetentionReport {
  tenantId: string;
  cutoff: string;
  visits: number;
  photos: number;
  invites: number;
  vehicles: number;
  blacklist: number;
}

const BATCH = 500;

/**
 * Job `gate-retention` (daily, D-315 PDPA, D-327): for every tenant with gate data, everything older than
 * `gate.retention_days` (90; a tenant may shorten it) is **deleted** — visits (their events cascade) and their photos
 * (objects deleted, `core.document` rows deleted), invites that ended before the cutoff, remembered cars expired or
 * revoked before it, revoked blacklist entries. One audit row + event per tenant with counts only. Runs as gp_platform.
 */
@Injectable()
export class GateRetentionService {
  private readonly logger = new Logger(GateRetentionService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(): Promise<GateRetentionReport[]> {
    return RequestContext.run({ actor: systemActor('gate-retention') }, async () => {
      const now = this.clock.now();
      const tenants = await this.db.platform(
        (tx) =>
          tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT tenant_id FROM smart.visit UNION SELECT tenant_id FROM smart.visit_invite
          UNION SELECT tenant_id FROM smart.remembered_vehicle UNION SELECT tenant_id FROM smart.gate_blacklist`,
      );
      const out: GateRetentionReport[] = [];
      for (const { tenant_id: tenantId } of tenants) {
        const days = await this.settings.valueAt<number>('gate.retention_days', now, { tenantId });
        const cutoff = new Date(now.getTime() - days * 86_400_000);
        out.push(await this.purgeTenant(tenantId, cutoff));
      }
      return out;
    });
  }

  async purgeTenant(tenantId: string, cutoff: Date): Promise<GateRetentionReport> {
    const report: GateRetentionReport = {
      tenantId,
      cutoff: cutoff.toISOString(),
      visits: 0,
      photos: 0,
      invites: 0,
      vehicles: 0,
      blacklist: 0,
    };
    for (;;) {
      const batch = await this.db.platform((tx) =>
        tx.visit.findMany({
          where: { tenantId, createdAt: { lt: cutoff } },
          select: { id: true, photoDocumentId: true },
          take: BATCH,
        }),
      );
      if (!batch.length) break;
      const keys: string[] = [];
      await this.db.platform(async (tx) => {
        const docIds = batch.map((b) => b.photoDocumentId).filter((d): d is string => Boolean(d));
        const docs = docIds.length ? await tx.document.findMany({ where: { id: { in: docIds } } }) : [];
        for (const d of docs)
          keys.push(
            ...(await this.documents.purgeStored(tx, d, { at: this.clock.now(), reason: 'retention' })),
          );
        // the visits first (their events cascade; photo references are gone), then the document rows themselves
        await tx.visit.deleteMany({ where: { id: { in: batch.map((b) => b.id) } } });
        if (docs.length) await tx.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
        report.visits += batch.length;
        report.photos += docs.length;
      });
      await this.documents.deleteObjects(keys);
      if (batch.length < BATCH) break;
    }
    await this.db.platform(async (tx) => {
      // invites ended before the cutoff and no longer referenced by a kept visit (visits keep invite_id SET NULL)
      report.invites = (
        await tx.visitInvite.deleteMany({
          where: {
            tenantId,
            OR: [{ validTo: { lt: cutoff } }, { revokedAt: { lt: cutoff } }, { rejectedAt: { lt: cutoff } }],
          },
        })
      ).count;
      report.vehicles = (
        await tx.rememberedVehicle.deleteMany({
          where: { tenantId, OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
        })
      ).count;
      report.blacklist = (
        await tx.gateBlacklist.deleteMany({ where: { tenantId, revokedAt: { lt: cutoff } } })
      ).count;
      const total = report.visits + report.invites + report.vehicles + report.blacklist;
      if (!total) return;
      await this.audit.record(tx, {
        action: 'gate.retention_purged',
        tenantId,
        subjectType: 'smart.visit',
        subjectId: null,
        metadata: { ...report },
      });
      await this.events.record(tx, {
        type: 'gate.retention_purged',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        tenantId,
        payload: { ...report },
      });
    });
    if (report.visits || report.invites || report.vehicles || report.blacklist)
      this.logger.log(
        `gate retention ${tenantId}: ${report.visits} visits, ${report.photos} photos, ${report.invites} invites, ${report.vehicles} vehicles, ${report.blacklist} blacklist`,
      );
    return report;
  }
}

import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { TenantTx } from '@database/tenant-tx';
import {
  STORAGE_INVENTORY,
  type StorageInventoryPort,
} from '@integrations/storage-inventory/storage-inventory.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { SettingsService } from '../settings/settings.service';
import { StorageLedger, sumTotals } from './storage-ledger';

const MAX_LISTED = 100;

export interface ReconciliationResult {
  reportId: string;
  tenantId: string;
  s3Bytes: bigint;
  s3Objects: number;
  dbBytes: bigint;
  dbObjects: number;
  driftBytes: bigint;
  corrected: boolean;
  orphans: string[];
  missing: string[];
  resized: number;
}

/**
 * Nightly reconciliation (G1, D-286): what object storage really holds under each tenant's prefix (`t/<tenant>/`,
 * ListObjectsV2) against the ledger and counters. Each counted document's bytes / objects are set to what its keys
 * occupy; the counters are set to the ledger's sums (`storage.reconciliation.auto_correct`, default on). Objects no
 * document claims (orphans of rolled-back writes, files never completed) and keys a counted document lacks are
 * reported, never deleted here. One append-only report row per tenant and run; a drift is evented.
 */
@Injectable()
export class StorageReconciliationService {
  private readonly logger = new Logger('StorageReconciliation');

  constructor(
    private readonly db: TenantTx,
    private readonly ledger: StorageLedger,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    @Inject(STORAGE_INVENTORY) private readonly inventory: StorageInventoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Worker job `storage-reconcile` (daily): every live tenant. */
  async run(): Promise<number> {
    const tenants = await this.db.platform((tx) =>
      tx.tenant.findMany({ where: { deletedAt: null }, select: { id: true } }),
    );
    let done = 0;
    await RequestContext.run({ actor: systemActor('storage-reconcile') }, async () => {
      for (const t of tenants) {
        try {
          await this.reconcile(t.id);
          done += 1;
        } catch (error) {
          this.logger.error(`reconciliation of tenant ${t.id} failed: ${(error as Error).message}`);
        }
      }
    });
    return done;
  }

  async reconcile(tenantId: string): Promise<ReconciliationResult> {
    const now = this.clock.now();
    const autoCorrect = await this.settings.valueAt<boolean>('storage.reconciliation.auto_correct', now);
    const stored = new Map<string, number>();
    for await (const o of this.inventory.list(`t/${tenantId}/`)) stored.set(o.key, o.sizeBytes);
    return this.db.platform(
      async (tx) => {
        const before = sumTotals(await this.ledger.totals(tx, tenantId));
        const rows = await tx.$queryRaw<
          {
            document_id: string;
            storage_key: string;
            derivative_keys: string[];
            bytes: bigint;
            objects: number;
          }[]
        >`
          SELECT s.document_id, d.storage_key, s.derivative_keys, s.bytes, s.objects
            FROM platform.document_storage s JOIN core.document d ON d.id = s.document_id
           WHERE s.tenant_id = ${tenantId}::uuid AND s.counted
           FOR UPDATE OF s`;
        const claimed = new Set<string>();
        const missing: string[] = [];
        let resized = 0;
        for (const r of rows) {
          let bytes = 0n;
          let objects = 0;
          const present: string[] = [];
          for (const key of [r.storage_key, ...r.derivative_keys]) {
            claimed.add(key);
            const size = stored.get(key);
            if (size === undefined) {
              missing.push(key);
              continue;
            }
            bytes += BigInt(size);
            objects += 1;
            present.push(key);
          }
          if (bytes !== r.bytes || objects !== r.objects) {
            resized += 1;
            if (autoCorrect)
              await tx.documentStorage.update({
                where: { documentId: r.document_id },
                data: { bytes, objects, derivativeKeys: present.filter((k) => k !== r.storage_key) },
              });
          }
        }
        // claim the objects of documents that are not counted (deleted rows, never completed uploads) as known keys
        // too, so only keys without any row are orphans
        const rest = [...stored.keys()].filter((k) => !claimed.has(k));
        const baseOf = (k: string) => k.replace(/\.(thumb\.webp|w\d+\.webp)$/, '');
        const bases = [...new Set(rest.map(baseOf))];
        const known = bases.length
          ? await tx.$queryRaw<{ storage_key: string }[]>`
              SELECT storage_key FROM core.document WHERE tenant_id = ${tenantId}::uuid AND storage_key = ANY(${bases}::text[])`
          : [];
        const knownKeys = new Set(known.map((k) => k.storage_key));
        const orphans = rest.filter((k) => !knownKeys.has(baseOf(k)));
        let s3Bytes = 0n;
        for (const size of stored.values()) s3Bytes += BigInt(size);
        const after = autoCorrect ? await this.ledger.recount(tx, tenantId) : null;
        if (after) await this.ledger.setTotals(tx, tenantId, after);
        const driftBytes = s3Bytes - before.bytes;
        const details = {
          orphans: orphans.slice(0, MAX_LISTED),
          orphanCount: orphans.length,
          missing: missing.slice(0, MAX_LISTED),
          missingCount: missing.length,
          resizedDocuments: resized,
          countedAfter: after ? sumTotals(after).bytes.toString() : null,
        };
        const report = await tx.storageReconciliation.create({
          data: {
            tenantId,
            ranAt: now,
            s3Bytes,
            s3Objects: BigInt(stored.size),
            dbBytes: before.bytes,
            dbObjects: BigInt(before.objects),
            driftBytes,
            corrected:
              autoCorrect && (resized > 0 || (after !== null && sumTotals(after).bytes !== before.bytes)),
            details,
          },
        });
        if (driftBytes !== 0n || missing.length || orphans.length)
          await this.events.record(tx, {
            type: 'storage.drift_detected',
            aggregateType: 'tenant',
            aggregateId: tenantId,
            tenantId,
            payload: {
              driftBytes: driftBytes.toString(),
              orphans: orphans.length,
              missing: missing.length,
              corrected: autoCorrect,
            },
          });
        return {
          reportId: report.id,
          tenantId,
          s3Bytes,
          s3Objects: stored.size,
          dbBytes: before.bytes,
          dbObjects: before.objects,
          driftBytes,
          corrected: autoCorrect,
          orphans,
          missing,
          resized,
        };
      },
      { tenantId },
    );
  }
}

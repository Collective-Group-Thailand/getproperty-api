import { type Tx } from '@database/prisma.service';
import { type StorageCategory } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

export const STORAGE_CATEGORIES: readonly StorageCategory[] = [
  'listing_media',
  'attachment',
  'system_legal',
  'system_other',
];

export type CategoryTotals = Record<StorageCategory, { bytes: bigint; objects: number }>;

export const emptyTotals = (): CategoryTotals =>
  Object.fromEntries(STORAGE_CATEGORIES.map((c) => [c, { bytes: 0n, objects: 0 }])) as CategoryTotals;

/**
 * What a tenant stores, kept exact in the caller's transaction (G1, D-286): `platform.document_storage` holds one row
 * per counted document (the file + its thumbnails / renditions, its category) and `platform.storage_usage` the sums
 * per tenant × category (the row of each pair is locked by the upsert, so concurrent writers serialise). Every
 * method is a no-op for platform files (no tenant) and idempotent where a retry can happen. Counters never go below
 * zero; drift is corrected by the nightly reconciliation.
 */
@Injectable()
export class StorageLedger {
  private async bump(tx: Tx, tenantId: string, category: StorageCategory, bytes: bigint, objects: number) {
    if (bytes === 0n && objects === 0) return;
    await tx.$executeRaw`
      INSERT INTO platform.storage_usage (tenant_id, category, bytes, objects)
      VALUES (${tenantId}::uuid, ${category}::platform.storage_category, GREATEST(0, ${bytes}::bigint), GREATEST(0, ${objects}::int))
      ON CONFLICT (tenant_id, category) DO UPDATE
        SET bytes = GREATEST(0, platform.storage_usage.bytes + ${bytes}::bigint),
            objects = GREATEST(0, platform.storage_usage.objects + ${objects}::int),
            updated_at = now()`;
  }

  /** A stored file starts counting (upload completed, generated file recorded). */
  async count(
    tx: Tx,
    input: { documentId: string; tenantId: string | null; category: StorageCategory; bytes: bigint },
  ): Promise<void> {
    if (!input.tenantId) return;
    const existing = await tx.documentStorage.findUnique({ where: { documentId: input.documentId } });
    if (existing?.counted) return;
    if (existing)
      await tx.documentStorage.update({
        where: { documentId: input.documentId },
        data: { counted: true, category: input.category, bytes: input.bytes, objects: 1, derivativeKeys: [] },
      });
    else
      await tx.documentStorage.create({
        data: {
          documentId: input.documentId,
          tenantId: input.tenantId,
          category: input.category,
          bytes: input.bytes,
          objects: 1,
        },
      });
    await this.bump(tx, input.tenantId, input.category, input.bytes, 1);
  }

  /** The stored file was replaced by another size (a listing photo re-encoded without its metadata). */
  async resize(tx: Tx, documentId: string, fromBytes: bigint, toBytes: bigint): Promise<void> {
    const row = await tx.documentStorage.findUnique({ where: { documentId } });
    if (!row?.counted || fromBytes === toBytes) return;
    const delta = toBytes - fromBytes;
    await tx.documentStorage.update({ where: { documentId }, data: { bytes: row.bytes + delta } });
    await this.bump(tx, row.tenantId, row.category, delta, 0);
  }

  /** A derivative object (thumbnail, rendition) of a counted document; the same key again replaces its size. */
  async addDerivative(
    tx: Tx,
    documentId: string,
    key: string,
    bytes: bigint,
    previousBytes = 0n,
  ): Promise<void> {
    const row = await tx.documentStorage.findUnique({ where: { documentId } });
    if (!row?.counted) return;
    const known = row.derivativeKeys.includes(key);
    const delta = known ? bytes - previousBytes : bytes;
    await tx.documentStorage.update({
      where: { documentId },
      data: {
        bytes: row.bytes + delta,
        objects: row.objects + (known ? 0 : 1),
        derivativeKeys: known ? row.derivativeKeys : [...row.derivativeKeys, key],
      },
    });
    await this.bump(tx, row.tenantId, row.category, delta, known ? 0 : 1);
  }

  /** Moves a counted document to another category (it came under a legal hold). */
  async moveCategory(tx: Tx, documentId: string, category: StorageCategory): Promise<void> {
    const row = await tx.documentStorage.findUnique({ where: { documentId } });
    if (!row || row.category === category) return;
    await tx.documentStorage.update({ where: { documentId }, data: { category } });
    if (!row.counted) return;
    await this.bump(tx, row.tenantId, row.category, -row.bytes, -row.objects);
    await this.bump(tx, row.tenantId, category, row.bytes, row.objects);
  }

  /**
   * The document's objects are gone (purged, retention, evidence purge): it stops counting. Returns the derivative
   * keys the caller deletes with the file (empty when it was not counted).
   */
  async uncount(tx: Tx, documentId: string): Promise<string[]> {
    const row = await tx.documentStorage.findUnique({ where: { documentId } });
    if (!row?.counted) return [];
    await tx.documentStorage.update({ where: { documentId }, data: { counted: false } });
    await this.bump(tx, row.tenantId, row.category, -row.bytes, -row.objects);
    return row.derivativeKeys;
  }

  /** The counters as stored. */
  async totals(tx: Tx, tenantId: string): Promise<CategoryTotals> {
    const totals = emptyTotals();
    for (const r of await tx.storageUsage.findMany({ where: { tenantId } }))
      totals[r.category] = { bytes: r.bytes, objects: r.objects };
    return totals;
  }

  /** The exact sums of the ledger (what the counters must equal). */
  async recount(tx: Tx, tenantId: string): Promise<CategoryTotals> {
    const totals = emptyTotals();
    const rows = await tx.$queryRaw<{ category: StorageCategory; bytes: bigint; objects: number }[]>`
      SELECT category, coalesce(sum(bytes), 0)::bigint AS bytes, coalesce(sum(objects), 0)::int AS objects
        FROM platform.document_storage WHERE tenant_id = ${tenantId}::uuid AND counted GROUP BY category`;
    for (const r of rows) totals[r.category] = { bytes: r.bytes, objects: r.objects };
    return totals;
  }

  /** Overwrites the counters with the given sums (reconciliation). */
  async setTotals(tx: Tx, tenantId: string, totals: CategoryTotals): Promise<void> {
    for (const category of STORAGE_CATEGORIES)
      await tx.$executeRaw`
        INSERT INTO platform.storage_usage (tenant_id, category, bytes, objects)
        VALUES (${tenantId}::uuid, ${category}::platform.storage_category, ${totals[category].bytes}::bigint, ${totals[category].objects}::int)
        ON CONFLICT (tenant_id, category) DO UPDATE
          SET bytes = EXCLUDED.bytes, objects = EXCLUDED.objects, updated_at = now()`;
  }
}

export const sumTotals = (t: CategoryTotals) =>
  STORAGE_CATEGORIES.reduce(
    (acc, c) => ({ bytes: acc.bytes + t[c].bytes, objects: acc.objects + t[c].objects }),
    { bytes: 0n, objects: 0 },
  );

import {
  type Admission,
  admit,
  countedBytes,
  crossedThresholds,
  monthlyStorageCharge,
  type QuotaState,
  quotaState,
  type RetentionClass,
  type StorageCharge,
  type StoragePolicy,
  storagePolicy,
  type StorageUsage,
} from '@collective/documents';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type DocumentKind } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { SettingsService } from '../settings/settings.service';
import {
  COUNTED_RECORDS,
  type CountedRecordType,
  type StoragePackSetting,
  type StorageTenantType,
} from './storage-settings';

/**
 * Retention class of each uploadable document kind for storage admission (D-276): legal documents are always stored,
 * operational files are accepted even when full (and billed), optional uploads are held only when the tenant would be
 * over its allowance and overage is not sold. A customer's data is never deleted or locked for being over.
 */
export const STORAGE_RETENTION: Record<DocumentKind, RetentionClass> = {
  contract: 'legal',
  utility_invoice: 'legal',
  id_document: 'legal',
  meter_photo: 'operational',
  inspection_photo: 'operational',
  service_photo: 'operational',
  slip: 'operational',
  logo: 'operational',
  log_bundle: 'operational',
  floor_plan: 'optional',
  as_built: 'optional',
  certificate: 'optional',
  warranty: 'optional',
  tariff_source: 'optional',
  other: 'optional',
} as Record<DocumentKind, RetentionClass>;

export interface TenantStoragePolicy {
  /** null = metering not active for this tenant type (no free allowance set yet). */
  policy: StoragePolicy | null;
  /** The setting version ids used — stored on each snapshot for audit. */
  version: string;
  recordBytes: Record<string, number>;
  freeGb: string | null;
  pricePerGbMonth: string | null;
}

export interface StorageStatus {
  asOf: string;
  usage: StorageUsage;
  usedBytes: bigint;
  state: QuotaState | null;
  freeGb: string | null;
  pricePerGbMonth: string | null;
}

/**
 * Storage metering per tenant (D-276) on `@collective/documents`: usage = live files at their size + records at the
 * counted size of their type; a daily snapshot per tenant (job `storage-metering`), notices at the thresholds (domain
 * event `storage.threshold_crossed` → LINE + in-app to the owner), admission of uploads, and the monthly charge for
 * the platform invoice (D-250). Every number is a setting (`storage.*`); while the free allowance of a tenant type is
 * null nothing is held and no notice is sent.
 */
@Injectable()
export class StorageMeteringService {
  private readonly logger = new Logger('StorageMetering');

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The policy of a tenant at `at` from the `storage.*` settings (tenant overrides first). */
  async policyFor(tenantId: string, tenantType: string, at: Date): Promise<TenantStoragePolicy> {
    const scope = { tenantId };
    const [free, price, packs, recordBytes, notices] = await Promise.all([
      this.settings.at('storage.free_gb', at, scope),
      this.settings.at('storage.price_per_gb_month', at, scope),
      this.settings.at('storage.packs', at, scope),
      this.settings.at('storage.record_bytes', at, scope),
      this.settings.at('storage.notice_at_percent', at, scope),
    ]);
    const type = tenantType as StorageTenantType;
    const freeGb = ((free?.value as Record<string, string | null> | undefined)?.[type] ?? null) || null;
    const pricePerGbMonth =
      ((price?.value as Record<string, string | null> | undefined)?.[type] ?? null) || null;
    const bytes = (recordBytes?.value as Record<string, number> | undefined) ?? { _default: 1024 };
    const { _default: defaultRecordBytes = 1024, ...perType } = bytes;
    const version = [free, price, packs, recordBytes, notices].map((v) => v?.versionId ?? '-').join(',');
    const policy =
      freeGb === null
        ? null
        : storagePolicy({
            freeGb,
            pricePerGbMonth,
            packs: (packs?.value as StoragePackSetting[] | undefined) ?? [],
            recordBytes: perType,
            defaultRecordBytes,
            noticeAtPercent: (notices?.value as number[] | undefined) ?? [80, 100],
          });
    return { policy, version, recordBytes: bytes, freeGb, pricePerGbMonth };
  }

  /** What a tenant stores now: live files (uploaded, not deleted) and its counted records. */
  async usage(tx: Tx, tenantId: string): Promise<StorageUsage> {
    const files = await tx.$queryRawUnsafe<{ bytes: bigint | null }[]>(
      `SELECT sum(size_bytes)::bigint AS bytes FROM core.document
        WHERE tenant_id = $1::uuid AND deleted_at IS NULL AND upload_state IN ('uploaded', 'verified')`,
      tenantId,
    );
    const records: Record<string, number> = {};
    for (const [type, table] of Object.entries(COUNTED_RECORDS) as [CountedRecordType, string][]) {
      const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      records[type] = rows[0]?.n ?? 0;
    }
    return { fileBytes: files[0]?.bytes ?? 0n, records };
  }

  /** Counted bytes with only the record sizes (also when metering is not active for the tenant type). */
  private counted(usage: StorageUsage, recordBytes: Record<string, number>): bigint {
    const { _default = 1024, ...perType } = recordBytes;
    return countedBytes(usage, {
      freeBytes: 0n,
      pricePerGbMonthSatang: null,
      packs: [],
      recordBytes: Object.fromEntries(Object.entries(perType).map(([k, v]) => [k, BigInt(v)])),
      defaultRecordBytes: BigInt(_default),
      noticeAtPercent: [80, 100],
    });
  }

  /**
   * Worker job `storage-metering` (hourly, idempotent): the snapshot of the current Bangkok day for every tenant that
   * has none yet, then the threshold notices. Runs as gp_platform (cross-tenant job, D-152).
   */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const day = bangkokDate(now);
    const tenants = await this.db.platform((tx) =>
      tx.tenant.findMany({
        where: {
          deletedAt: null,
          status: { not: 'deactivated' },
          storageUsageDailyTenant: { none: { day: new Date(`${day}T00:00:00Z`) } },
        },
        select: { id: true, type: true },
      }),
    );
    let done = 0;
    for (const tenant of tenants) {
      try {
        await this.snapshot(tenant.id, tenant.type, day, now);
        done += 1;
      } catch (error) {
        this.logger.error(`storage snapshot of tenant ${tenant.id} failed: ${(error as Error).message}`);
      }
    }
    return done;
  }

  /** One tenant's snapshot for `day` (no-op when it exists) and the notices it crosses. */
  async snapshot(tenantId: string, tenantType: string, day: string, now: Date): Promise<void> {
    const p = await this.policyFor(tenantId, tenantType, now);
    await this.db.platform(
      async (tx) => {
        const usage = await this.usage(tx, tenantId);
        const state = p.policy ? quotaState(usage, p.policy) : null;
        const counted = state?.usedBytes ?? this.counted(usage, p.recordBytes);
        const inserted = await tx.$executeRawUnsafe(
          `INSERT INTO platform.storage_usage_daily
             (tenant_id, day, file_bytes, record_counts, counted_bytes, allowance_bytes, policy_version, computed_at)
           VALUES ($1::uuid, $2::date, $3::bigint, $4::jsonb, $5::bigint, $6::bigint, $7, $8)
           ON CONFLICT (tenant_id, day) DO NOTHING`,
          tenantId,
          day,
          usage.fileBytes,
          JSON.stringify(usage.records),
          counted,
          state?.allowanceBytes ?? null,
          p.version,
          now,
        );
        if (!inserted || !state || !p.policy) return;
        await this.notices(tx, tenantId, day, state, p.policy);
      },
      { tenantId },
    );
  }

  /** Opens a notice per threshold reached that has no open notice; clears those the tenant fell back below. */
  private async notices(tx: Tx, tenantId: string, day: string, state: QuotaState, policy: StoragePolicy) {
    const open = await tx.storageNotice.findMany({ where: { tenantId, clearedAt: null } });
    const openPct = new Set(open.map((n) => n.thresholdPct));
    const reached = crossedThresholds({ ...state, usedBasisPoints: 0 }, state, policy).filter(
      (pct) => !openPct.has(pct),
    );
    const fellBelow = open.filter((n) => state.usedBasisPoints < n.thresholdPct * 100);
    const now = this.clock.now();
    if (fellBelow.length)
      await tx.storageNotice.updateMany({
        where: { id: { in: fellBelow.map((n) => n.id) } },
        data: { clearedAt: now },
      });
    // one message for the highest threshold reached today (80 and 100 on the same day → the 100 % message)
    for (const pct of reached)
      await tx.storageNotice.create({
        data: {
          tenantId,
          thresholdPct: pct,
          crossedOn: new Date(`${day}T00:00:00Z`),
          usedBytes: state.usedBytes,
          allowanceBytes: state.allowanceBytes,
          sentAt: now,
        },
      });
    const top = reached.at(-1);
    if (top !== undefined)
      await this.events.record(tx, {
        type: 'storage.threshold_crossed',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        tenantId,
        payload: {
          thresholdPct: top,
          usedPercent: Math.floor(state.usedBasisPoints / 100),
          usedBytes: state.usedBytes.toString(),
          allowanceBytes: state.allowanceBytes.toString(),
          day,
        },
      });
  }

  /** The tenant's current position (console usage bar): live usage against the policy in force now. */
  async status(tx: Tx, tenantId: string, tenantType: string): Promise<StorageStatus> {
    const now = this.clock.now();
    const p = await this.policyFor(tenantId, tenantType, now);
    const usage = await this.usage(tx, tenantId);
    const state = p.policy ? quotaState(usage, p.policy) : null;
    return {
      asOf: now.toISOString(),
      usage,
      usedBytes: state?.usedBytes ?? this.counted(usage, p.recordBytes),
      state,
      freeGb: p.freeGb,
      pricePerGbMonth: p.pricePerGbMonth,
    };
  }

  /**
   * Upload admission (D-276): never refuses legal or operational files; an optional upload is refused only when it
   * would put the tenant over its allowance while overage is not sold. Metering not active → always accepted.
   */
  async admitUpload(tx: Tx, tenantId: string, kind: DocumentKind, sizeBytes: number): Promise<Admission> {
    const retention = STORAGE_RETENTION[kind] ?? 'optional';
    // legal and operational files are always stored: no usage query on their (frequent) uploads
    if (retention !== 'optional') return { accepted: true, overage: false };
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { type: true } });
    if (!tenant) return { accepted: true, overage: false };
    const p = await this.policyFor(tenantId, tenant.type, this.clock.now());
    if (!p.policy) return { accepted: true, overage: false };
    const state = quotaState(await this.usage(tx, tenantId), p.policy);
    return admit({ retention, bytes: BigInt(sizeBytes) }, state, p.policy);
  }

  /**
   * The storage charge of a month (`YYYY-MM`) from the daily snapshots, for the platform invoice line `storage`
   * (D-250, B7.2). Days without a snapshot repeat the previous day; null when metering was not active.
   */
  async monthlyCharge(
    tx: Tx,
    tenantId: string,
    tenantType: string,
    month: string,
  ): Promise<StorageCharge | null> {
    const first = `${month}-01`;
    const next = addCalendarDays(`${month}-28`, 4).slice(0, 7);
    const end = `${next}-01`;
    const rows = await tx.storageUsageDaily.findMany({
      where: { tenantId, day: { gte: new Date(`${first}T00:00:00Z`), lt: new Date(`${end}T00:00:00Z`) } },
      orderBy: { day: 'asc' },
    });
    if (rows.length === 0) return null;
    const p = await this.policyFor(tenantId, tenantType, startOfBangkokDay(end));
    if (!p.policy) return null;
    const byDay = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r.countedBytes]));
    const daily: bigint[] = [];
    let last = rows[0]!.countedBytes;
    for (let d = first; d < end; d = addCalendarDays(d, 1)) {
      last = byDay.get(d) ?? last;
      daily.push(last);
    }
    return monthlyStorageCharge({ dailyUsedBytes: daily, policy: p.policy });
  }
}

export interface StorageOverviewRow {
  tenantId: string;
  displayName: string;
  type: string;
  day: string;
  usedBytes: bigint;
  fileBytes: bigint;
  allowanceBytes: bigint | null;
}

/** The latest snapshot of every tenant (platform admin overview, D-279), most used first. Run as gp_platform. */
export async function storageOverview(tx: Tx): Promise<StorageOverviewRow[]> {
  const rows = await tx.$queryRawUnsafe<
    {
      tenant_id: string;
      display_name: string;
      type: string;
      day: Date;
      counted_bytes: bigint;
      file_bytes: bigint;
      allowance_bytes: bigint | null;
    }[]
  >(
    `SELECT DISTINCT ON (u.tenant_id) u.tenant_id, t.display_name, t.type::text AS type, u.day, u.counted_bytes,
            u.file_bytes, u.allowance_bytes
       FROM platform.storage_usage_daily u JOIN core.tenant t ON t.id = u.tenant_id
      WHERE t.deleted_at IS NULL
      ORDER BY u.tenant_id, u.day DESC`,
  );
  return rows
    .map((r) => ({
      tenantId: r.tenant_id,
      displayName: r.display_name,
      type: r.type,
      day: r.day.toISOString().slice(0, 10),
      usedBytes: r.counted_bytes,
      fileBytes: r.file_bytes,
      allowanceBytes: r.allowance_bytes,
    }))
    .sort((a, b) => (b.usedBytes > a.usedBytes ? 1 : b.usedBytes < a.usedBytes ? -1 : 0));
}

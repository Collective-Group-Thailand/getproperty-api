import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import { type CutoffSetting, periodOf } from '@modules/smart-readings/cutoff';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

export type Bucket = '15m' | '1h' | '1d';

interface FifteenMinuteRow {
  asset_item_id: string;
  bucket: Date;
  usage: Decimal.Value | null;
  last_register: Decimal.Value;
  points: number;
  avg_power_w: Decimal.Value | null;
  avg_flow_lpm: Decimal.Value | null;
}
const STEP_MS: Record<Bucket, number> = { '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 };
/** At most this many buckets per request (31 days of 15 min, 400 days of hours, ~5 years of days). */
export const MAX_BUCKETS = 3000;

export interface SeriesPoint {
  bucket: Date;
  usage: Decimal | null;
  lastRegister: Decimal | null;
  points: number;
  avgPowerW: Decimal | null;
  avgFlowLpm: Decimal | null;
}

/** Validates a series window: from < to, not more than MAX_BUCKETS buckets. */
export function seriesWindow(from: Date, to: Date, bucket: Bucket): void {
  if (!(from.getTime() < to.getTime()))
    throw new DomainException('validation.failed', {
      errors: [{ path: 'to', code: 'after', message: 'to must be after from' }],
    });
  if ((to.getTime() - from.getTime()) / STEP_MS[bucket] > MAX_BUCKETS)
    throw new DomainException('validation.failed', {
      errors: [
        { path: 'from', code: 'range', message: `at most ${MAX_BUCKETS} ${bucket} buckets per request` },
      ],
    });
}

/**
 * Usage series (D-030: never billing data): hourly / daily from the rollups under RLS, 15-minute through the
 * tenant-checking function over raw points (T-14, ADR-0014 — the only API read of raw telemetry, amends D-184): an
 * owner's meter (`GET /v1/owner/meters/{assetItemId}/series`) and a resident's daily usage per utility across the
 * meters of the leased unit, swaps included (`GET /v1/resident/leases/{id}/usage`, D-063).
 */
@Injectable()
export class SeriesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: ResidentLeasesService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** Σ usage of meters over [from, to) from the hourly rollup (null when nothing was measured). */
  private async total(tx: Tx, assetItemIds: string[], from: Date, to: Date): Promise<Decimal | null> {
    if (!(from.getTime() < to.getTime())) return null;
    const r = await tx.telemetry1h.aggregate({
      where: { assetItemId: { in: assetItemIds }, bucket: { gte: from, lt: to } },
      _sum: { usage: true },
      _count: { _all: true },
    });
    return r._count._all > 0 ? new Decimal((r._sum.usage ?? 0).toString()) : null;
  }

  private async rows(
    tx: Tx,
    assetItemIds: string[],
    from: Date,
    to: Date,
    bucket: Bucket,
    platform = false,
  ): Promise<(SeriesPoint & { assetItemId: string })[]> {
    if (bucket === '15m') {
      // T-14 (ADR-0014): computed from raw points — under the caller's tenant check, or (platform reads that proved
      // access themselves, e.g. a resident's lease) without it
      const found = platform
        ? await tx.$queryRaw<FifteenMinuteRow[]>`
            SELECT asset_item_id::text, bucket, usage, last_register, points, avg_power_w, avg_flow_lpm
              FROM smart.telemetry_15m_rows(${assetItemIds}::uuid[], ${from}, ${to})`
        : await tx.$queryRaw<FifteenMinuteRow[]>`
            SELECT asset_item_id::text, bucket, usage, last_register, points, avg_power_w, avg_flow_lpm
              FROM smart.telemetry_15m_series(${assetItemIds}::uuid[], ${from}, ${to})`;
      return found.map((r) => ({
        assetItemId: r.asset_item_id,
        bucket: r.bucket,
        usage: r.usage === null ? null : new Decimal(r.usage.toString()),
        lastRegister: new Decimal(r.last_register.toString()),
        points: r.points,
        avgPowerW: r.avg_power_w === null ? null : new Decimal(r.avg_power_w.toString()),
        avgFlowLpm: r.avg_flow_lpm === null ? null : new Decimal(r.avg_flow_lpm.toString()),
      }));
    }
    const where = { assetItemId: { in: assetItemIds }, bucket: { gte: from, lt: to } };
    const select = {
      assetItemId: true,
      bucket: true,
      usage: true,
      lastRegister: true,
      points: true,
      avgPowerW: true,
      avgFlowLpm: true,
    } as const;
    const found =
      bucket === '1h'
        ? await tx.telemetry1h.findMany({ where, select, orderBy: { bucket: 'asc' } })
        : await tx.telemetry1d.findMany({ where, select, orderBy: { bucket: 'asc' } });
    return found.map((r) => ({
      assetItemId: r.assetItemId,
      bucket: r.bucket,
      usage: r.usage ? new Decimal(r.usage.toString()) : null,
      lastRegister: new Decimal(r.lastRegister.toString()),
      points: r.points,
      avgPowerW: r.avgPowerW ? new Decimal(r.avgPowerW.toString()) : null,
      avgFlowLpm: r.avgFlowLpm ? new Decimal(r.avgFlowLpm.toString()) : null,
    }));
  }

  /** One meter of my tenant (RLS + Staff building scope). */
  meterSeries(ctx: TenantContext, assetItemId: string, from: Date, to: Date, bucket: Bucket) {
    seriesWindow(from, to, bucket);
    return this.db.tenant(ctx, async (tx) => {
      const item = await tx.assetItem.findFirst({
        where: { id: assetItemId, category: { in: ['meter_electric', 'meter_water'] } },
      });
      if (!item || (ctx.buildingIds && !ctx.buildingIds.includes(item.buildingId)))
        throw new DomainException('http.not_found');
      return {
        unit: item.category === 'meter_electric' ? ('kwh' as const) : ('m3' as const),
        points: await this.rows(tx, [assetItemId], from, to, bucket),
      };
    });
  }

  /**
   * Daily (or hourly) usage of the unit of my lease per utility, summed over the meters that served the unit while
   * the lease ran; empty for manual (Lite) meters — they have no telemetry.
   */
  async residentUsage(leaseId: string, bucket: Bucket, from?: Date, to?: Date) {
    const a = await this.leases.access(leaseId);
    const now = this.clock.now();
    const end = to ?? now;
    const start = from ?? new Date(end.getTime() - 30 * 86_400_000);
    seriesWindow(start, end, bucket);
    // access is proven: read through gp_platform (the lessor may be a unit grantee of someone else's building, D-152)
    return this.db.platform(async (tx) => {
      const lease = await tx.lease.findFirstOrThrow({ where: { id: leaseId, tenantId: a.ctx.tenantId } });
      const leaseStart = lease.startDate;
      const windowStart = start.getTime() < leaseStart.getTime() ? leaseStart : start;
      const assignments = await tx.meterAssignment.findMany({
        where: {
          unitId: lease.unitId,
          validFrom: { lt: end },
          OR: [{ validTo: null }, { validTo: { gt: windowStart } }],
        },
      });
      const out: {
        utility: 'electric' | 'water';
        unit: 'kwh' | 'm3';
        points: { bucket: Date; usage: Decimal }[];
      }[] = [];
      const summary: {
        utility: 'electric' | 'water';
        unit: 'kwh' | 'm3';
        total: Decimal;
        previousTotal: Decimal | null;
        cycleToDate: { from: Date; usage: Decimal; estimated: boolean } | null;
      }[] = [];
      const unit = await tx.unit.findUniqueOrThrow({
        where: { id: lease.unitId },
        select: { propertyId: true },
      });
      const cutoff = await this.settings.valueAt<CutoffSetting>('billing.cutoff', now, {
        tenantId: lease.tenantId,
        propertyId: unit.propertyId,
      });
      const period = periodOf(cutoff, now);
      const span = end.getTime() - windowStart.getTime();
      const previousFrom = new Date(windowStart.getTime() - span);
      for (const utility of ['electric', 'water'] as const) {
        const ids = assignments.filter((x) => x.utility === utility).map((x) => x.assetItemId);
        if (!ids.length) continue;
        const rows = await this.rows(tx, ids, windowStart, end, bucket, true);
        const sums = new Map<number, Decimal>();
        for (const r of rows)
          sums.set(r.bucket.getTime(), (sums.get(r.bucket.getTime()) ?? new Decimal(0)).plus(r.usage ?? 0));
        out.push({
          utility,
          unit: utility === 'electric' ? 'kwh' : 'm3',
          points: [...sums.entries()]
            .sort((x, y) => x[0] - y[0])
            .map(([t, usage]) => ({ bucket: new Date(t), usage })),
        });
        // LIFF #12 (D-203): totals computed here so the app never adds meter quantities up
        const total = await this.total(tx, ids, windowStart, end);
        if (total === null) continue;
        const previousTotal =
          previousFrom.getTime() >= leaseStart.getTime()
            ? await this.total(tx, ids, previousFrom, windowStart)
            : null;
        const cycleFrom = period.start.getTime() < leaseStart.getTime() ? leaseStart : period.start;
        const cycleUsage = await this.total(tx, ids, cycleFrom, now);
        summary.push({
          utility,
          unit: utility === 'electric' ? 'kwh' : 'm3',
          total,
          previousTotal,
          cycleToDate: cycleUsage === null ? null : { from: cycleFrom, usage: cycleUsage, estimated: true },
        });
      }
      return { leaseId, unitId: lease.unitId, from: windowStart, to: end, series: out, summary };
    });
  }
}

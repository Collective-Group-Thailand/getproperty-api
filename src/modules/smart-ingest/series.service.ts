import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

export type Bucket = '15m' | '1h' | '1d';

const TABLE: Record<Bucket, 'telemetry15m' | 'telemetry1h' | 'telemetry1d'> = {
  '15m': 'telemetry15m',
  '1h': 'telemetry1h',
  '1d': 'telemetry1d',
};
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
 * Usage series from the rollups only (D-162: the API never reads raw telemetry; D-030: never billing data): an
 * owner's meter (`GET /v1/owner/meters/{assetItemId}/series`) and a resident's daily usage per utility across the
 * meters of the leased unit, swaps included (`GET /v1/resident/leases/{id}/usage`, D-063).
 */
@Injectable()
export class SeriesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: ResidentLeasesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async rows(
    tx: Tx,
    assetItemIds: string[],
    from: Date,
    to: Date,
    bucket: Bucket,
  ): Promise<(SeriesPoint & { assetItemId: string })[]> {
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
      TABLE[bucket] === 'telemetry15m'
        ? await tx.telemetry15m.findMany({ where, select, orderBy: { bucket: 'asc' } })
        : TABLE[bucket] === 'telemetry1h'
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
      for (const utility of ['electric', 'water'] as const) {
        const ids = assignments.filter((x) => x.utility === utility).map((x) => x.assetItemId);
        if (!ids.length) continue;
        const rows = await this.rows(tx, ids, windowStart, end, bucket);
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
      }
      return { leaseId, unitId: lease.unitId, from: windowStart, to: end, series: out };
    });
  }
}

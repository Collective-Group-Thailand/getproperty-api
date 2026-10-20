import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { Prisma } from '@generated/prisma/client';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { FACT_KEYS, type FactKey, FACTS_BY_EVENT, factStatements, ROLLUP_BUCKETS } from './analytics-facts';
import { type BenchmarkMetric, bucketStats, districtKey, sizeBand } from './benchmark-rules';

const DAY = 86_400_000;

export interface RollupTotal {
  value: Decimal;
  count: number;
}

export interface SeriesPoint {
  bucketStart: string;
  value: string;
  count: number;
}

/**
 * Analytics (B6.3, D-083, D-217): facts (`platform.analytics_fact`, monthly partitions — D-162) written by the
 * `analytics` subscriber around domain events and by the hourly `analytics-rollup` job (every tenant, the last two
 * days — the derivation also produces the facts about deadlines and days: on-time payment once a due date passed,
 * reminder effectiveness a week after a reminder, meter uptime per building-day, the month's compliance score);
 * rollups (`platform.analytics_rollup`) per tenant and building by Bangkok day / week / month, which the pilot KPIs
 * and the owner insights read; anonymised benchmarks (`platform.benchmark_bucket`) of opted-in tenants (consent
 * `analytics.anonymised` of an Owner), only for buckets of at least 5 tenants.
 */
@Injectable()
export class AnalyticsService implements EventSubscriber, OnModuleInit {
  readonly name = 'analytics';
  readonly eventTypes = Object.keys(FACTS_BY_EVENT);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** The facts an event changes, for the event's tenant and the hour around it (idempotent), then their rollups. */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (!event.tenantId) return;
    const at = new Date(event.occurredAt).getTime();
    const now = this.clock.now().getTime();
    const from = new Date(Math.min(at, now) - 2 * 3_600_000);
    const to = new Date(Math.max(at, now) + 60_000);
    await this.derive(tx, { tenantId: event.tenantId, from, to }, FACTS_BY_EVENT[event.type]);
    await this.rollup(tx, { tenantId: event.tenantId, from, to });
  }

  private async ensurePartitions(tx: Tx, from: Date, to: Date): Promise<void> {
    // facts may sit up to a month before `from` (month-level facts) — make every month of the span exist
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
    for (
      let m = start;
      m.getTime() <= to.getTime();
      m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
    )
      await tx.$queryRaw`SELECT platform.ensure_analytics_partition(${m}::timestamptz)`;
  }

  /** Writes the facts of [from, to) (one tenant or all); returns the rows written per fact. */
  async derive(
    tx: Tx,
    scope: { tenantId: string | null; from: Date; to: Date },
    only: readonly FactKey[] = FACT_KEYS,
  ): Promise<Record<string, number>> {
    await this.ensurePartitions(tx, scope.from, scope.to);
    const reminderDays = Number(
      (await this.settings.at('analytics.reminder_effective_days', scope.to))?.value ?? 7,
    );
    const statements = factStatements({ ...scope, now: this.clock.now(), reminderDays });
    const out: Record<string, number> = {};
    for (const key of only) out[key] = await tx.$executeRaw(statements[key]);
    return out;
  }

  /**
   * Recomputes every day / week / month bucket that [from, to) touches (each bucket from all its facts), per tenant
   * (`building_id` NULL) and per building.
   */
  async rollup(tx: Tx, scope: { tenantId: string | null; from: Date; to: Date }): Promise<number> {
    const tenant = scope.tenantId ? Prisma.sql`AND f.tenant_id = ${scope.tenantId}::uuid` : Prisma.empty;
    let n = 0;
    for (const bucket of ROLLUP_BUCKETS)
      n += await tx.$executeRaw`
        WITH bounds AS (
          SELECT (date_trunc(${bucket}, ${scope.from}::timestamptz AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok') AS s,
                 ((date_trunc(${bucket}, ${scope.to}::timestamptz AT TIME ZONE 'Asia/Bangkok') + ('1 ' || ${bucket})::interval)
                    AT TIME ZONE 'Asia/Bangkok') AS e)
        INSERT INTO platform.analytics_rollup
          (tenant_id, building_id, fact, bucket, bucket_start, value, count, min_value, max_value, computed_at)
        SELECT f.tenant_id, b.building_id, f.fact, ${bucket}::platform.rollup_bucket,
               date_trunc(${bucket}, f.time AT TIME ZONE 'Asia/Bangkok')::date,
               sum(f.value), count(*)::int, min(f.value), max(f.value), now()
          FROM platform.analytics_fact f
          CROSS JOIN bounds
          CROSS JOIN LATERAL (SELECT NULL::uuid AS building_id
                              UNION ALL SELECT f.building_id WHERE f.building_id IS NOT NULL) b
         WHERE f.time >= bounds.s AND f.time < bounds.e ${tenant}
         GROUP BY 1, 2, 3, 5
        ON CONFLICT (tenant_id, building_id, fact, bucket, bucket_start)
          DO UPDATE SET value = EXCLUDED.value, count = EXCLUDED.count, min_value = EXCLUDED.min_value,
                        max_value = EXCLUDED.max_value, computed_at = EXCLUDED.computed_at`;
    return n;
  }

  /** Facts + rollups of one tenant over a window (the KPI endpoint makes its window current before reading). */
  async refresh(tx: Tx, tenantId: string, from: Date, to: Date): Promise<void> {
    await this.derive(tx, { tenantId, from, to });
    await this.rollup(tx, { tenantId, from, to });
  }

  /** Worker job `analytics-rollup` (hourly): every tenant's facts and rollups of the last two days. */
  async sweep(): Promise<void> {
    const now = this.clock.now();
    const from = new Date(now.getTime() - 2 * DAY);
    const to = new Date(now.getTime() + 60_000);
    await this.db.platform(async (tx) => {
      await this.derive(tx, { tenantId: null, from, to });
      await this.rollup(tx, { tenantId: null, from, to });
    });
  }

  // ------------------------------------------------------------------------------------------------------ reads

  /** Day-bucket totals per fact of a tenant (all buildings) from the Bangkok day of `from` to that of `to`. */
  async totals(tx: Tx, tenantId: string, from: Date, to: Date): Promise<Map<string, RollupTotal>> {
    const rows = await tx.$queryRaw<{ fact: string; v: string; n: number }[]>`
      SELECT fact, sum(value)::text AS v, sum(count)::int AS n FROM platform.analytics_rollup
       WHERE tenant_id = ${tenantId}::uuid AND building_id IS NULL AND bucket = 'day'
         AND bucket_start >= ${bangkokDate(from)}::date AND bucket_start <= ${bangkokDate(to)}::date
       GROUP BY fact`;
    return new Map(rows.map((r) => [r.fact, { value: new Decimal(r.v), count: r.n }]));
  }

  /** The average of the latest day bucket of a fact in the window (e.g. the latest loss %). */
  async latest(tx: Tx, tenantId: string, fact: string, from: Date, to: Date): Promise<string | null> {
    const rows = await tx.$queryRaw<{ v: string | null }[]>`
      SELECT (value / nullif(count, 0))::numeric(18,4)::text AS v FROM platform.analytics_rollup
       WHERE tenant_id = ${tenantId}::uuid AND building_id IS NULL AND bucket = 'day' AND fact = ${fact}
         AND bucket_start >= ${bangkokDate(from)}::date AND bucket_start <= ${bangkokDate(to)}::date
       ORDER BY bucket_start DESC LIMIT 1`;
    return rows[0]?.v ?? null;
  }

  /** Month series of facts for the insights (average per bucket = value / count), oldest first. */
  async series(
    tx: Tx,
    tenantId: string,
    facts: readonly string[],
    fromMonth: string,
    buildingId: string | null = null,
  ): Promise<Map<string, SeriesPoint[]>> {
    const rows = await tx.$queryRaw<{ fact: string; d: string; v: string; n: number }[]>`
      SELECT fact, bucket_start::text AS d, value::text AS v, count AS n FROM platform.analytics_rollup
       WHERE tenant_id = ${tenantId}::uuid AND building_id IS NOT DISTINCT FROM ${buildingId}::uuid
         AND bucket = 'month' AND fact = ANY(${[...facts]}::text[]) AND bucket_start >= ${fromMonth}::date
       ORDER BY bucket_start`;
    const out = new Map<string, SeriesPoint[]>(facts.map((f) => [f, []]));
    for (const r of rows) out.get(r.fact)?.push({ bucketStart: r.d, value: r.v, count: r.n });
    return out;
  }

  // ------------------------------------------------------------------------------------------------- benchmarks

  /** Tenants whose Owner granted the anonymised-analytics consent (D-083 data use, PDPA ⚖). */
  async optedIn(tx: Tx, tenantIds?: string[]): Promise<Set<string>> {
    const rows = await tx.$queryRaw<{ tenant_id: string }[]>`
      SELECT DISTINCT m.tenant_id FROM core.membership m
        JOIN platform.v_consent_state c ON c.subject_type = 'user' AND c.subject_id = m.user_id
       WHERE m.role = 'owner' AND m.status = 'active' AND m.deleted_at IS NULL
         AND c.purpose_key = 'analytics.anonymised' AND c.granted
         ${tenantIds ? Prisma.sql`AND m.tenant_id = ANY(${tenantIds}::uuid[])` : Prisma.empty}`;
    return new Set(rows.map((r) => r.tenant_id));
  }

  /** One tenant's benchmark values over the last 90 days and the bucket keys it falls into. */
  async tenantBenchmarkValues(tx: Tx, tenantId: string, now: Date) {
    const from = new Date(now.getTime() - 90 * DAY);
    const totals = await this.totals(tx, tenantId, from, now);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { type: true } });
    const units = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM core.unit u JOIN core.building b ON b.id = u.building_id
       WHERE (b.owner_tenant_id = ${tenantId}::uuid OR b.operator_tenant_id = ${tenantId}::uuid)
         AND u.deleted_at IS NULL AND b.deleted_at IS NULL AND u.status <> 'inactive'`;
    const rents = await tx.$queryRaw<{ address: unknown; v: string }[]>`
      SELECT b.address, avg(l.rent / u.area_sqm)::numeric(18,4)::text AS v
        FROM ops.lease l JOIN core.unit u ON u.id = l.unit_id JOIN core.building b ON b.id = l.building_id
       WHERE l.tenant_id = ${tenantId}::uuid AND l.status IN ('active', 'notice_given') AND u.area_sqm > 0
       GROUP BY b.address`;
    const shared = [`type:${tenant.type}`, `type:${tenant.type}|size:${sizeBand(units[0]?.n ?? 0)}`];
    const ratio = (f: string, times = 1) => {
      const t = totals.get(f);
      return t && t.count > 0 ? t.value.times(times).div(t.count) : null;
    };
    const values: { metric: BenchmarkMetric; keys: string[]; value: Decimal }[] = [];
    const loss = ratio('loss.pct');
    if (loss) values.push({ metric: 'loss_pct', keys: shared, value: loss });
    const onTime = ratio('payment.on_time', 100);
    if (onTime) values.push({ metric: 'on_time_payment_pct', keys: shared, value: onTime });
    const byDistrict = new Map<string, Decimal[]>();
    for (const r of rents) {
      const key = districtKey(r.address);
      if (key) byDistrict.set(key, [...(byDistrict.get(key) ?? []), new Decimal(r.v)]);
    }
    for (const [key, vs] of byDistrict)
      values.push({
        metric: 'rent_per_m2',
        keys: [key],
        value: vs.reduce((s, v) => s.plus(v), new Decimal(0)).div(vs.length),
      });
    return values;
  }

  /**
   * Worker job `analytics-benchmarks` (daily): refreshes the 90-day rollups of every opted-in tenant, groups one
   * value per tenant into buckets (tenant type, type × size band, province / district for rent per m²) and publishes
   * the percentiles of every bucket with k ≥ 5 tenants (smaller buckets are not stored). Returns the buckets written.
   */
  async benchmarks(): Promise<number> {
    const now = this.clock.now();
    const asOf = bangkokDate(now);
    return this.db.platform(async (tx) => {
      const tenants = [...(await this.optedIn(tx))];
      const buckets = new Map<string, Decimal[]>();
      for (const tenantId of tenants) {
        await this.refresh(tx, tenantId, new Date(now.getTime() - 90 * DAY), now);
        for (const v of await this.tenantBenchmarkValues(tx, tenantId, now))
          for (const key of v.keys) {
            const k = `${v.metric}\u0000${key}`;
            buckets.set(k, [...(buckets.get(k) ?? []), v.value]);
          }
      }
      let written = 0;
      for (const [k, values] of buckets) {
        const stats = bucketStats(values);
        if (!stats) continue;
        const [metric, bucketKey] = k.split('\u0000') as [BenchmarkMetric, string];
        await tx.benchmarkBucket.upsert({
          where: { metric_bucketKey_asOf: { metric, bucketKey, asOf: new Date(`${asOf}T00:00:00Z`) } },
          create: { metric, bucketKey, asOf: new Date(`${asOf}T00:00:00Z`), computedAt: now, ...stats },
          update: { computedAt: now, ...stats },
        });
        written += 1;
      }
      // buckets of today that fell below k since an earlier run today are withdrawn
      const keep = [...buckets.entries()].filter(([, v]) => bucketStats(v)).map(([k]) => k);
      const stale = await tx.benchmarkBucket.findMany({ where: { asOf: new Date(`${asOf}T00:00:00Z`) } });
      for (const b of stale)
        if (!keep.includes(`${b.metric}\u0000${b.bucketKey}`))
          await tx.benchmarkBucket.delete({ where: { id: b.id } });
      return written;
    });
  }

  /** The benchmark rows a tenant may compare itself with (it must have opted in itself: give to get). */
  async benchmarksFor(tx: Tx, tenantId: string) {
    const now = this.clock.now();
    if (!(await this.optedIn(tx, [tenantId])).has(tenantId)) return { optedIn: false, items: [] };
    const mine = await this.tenantBenchmarkValues(tx, tenantId, now);
    const items = [];
    for (const v of mine)
      for (const key of v.keys) {
        const b = await tx.benchmarkBucket.findFirst({
          where: { metric: v.metric, bucketKey: key },
          orderBy: { asOf: 'desc' },
        });
        if (b)
          items.push({
            metric: v.metric,
            bucketKey: key,
            k: b.k,
            p25: b.p25.toFixed(4),
            p50: b.p50.toFixed(4),
            p75: b.p75.toFixed(4),
            asOf: b.asOf.toISOString().slice(0, 10),
            mine: v.value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
          });
      }
    return { optedIn: true, items };
  }

  /** Bangkok midnight of the first day of the month `n` months before `now`. */
  monthsBack(n: number): string {
    const d = bangkokDate(this.clock.now());
    const [y, m] = d.split('-').map(Number) as [number, number];
    const t = new Date(Date.UTC(y, m - 1 - n, 1));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  /** Start of the Bangkok month `YYYY-MM-01` as an instant. */
  monthStart(day: string): Date {
    return startOfBangkokDay(day);
  }
}

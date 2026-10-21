import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { IngestPipeline } from './ingest-pipeline.service';

const ROLLUP_CURSOR = 'telemetry-rollup';

/** ISO 8601 duration `P24M`, `P5Y`, `P90D`, `P6M` → milliseconds (calendar months ≈ 30.44 days). */
export function durationMs(iso: string): number {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(iso);
  if (!m) throw new RangeError(`not a P…Y…M…D duration: ${iso}`);
  const [, y, mo, d] = m;
  return Math.round((Number(y ?? 0) * 365.25 + Number(mo ?? 0) * 30.44 + Number(d ?? 0)) * 86_400_000);
}

/**
 * Telemetry housekeeping on the worker (D-162, D-234): the rollup job folds new points (by `received_at` cursor) into
 * `smart.telemetry_1h` and `_1d` (Asia/Bangkok days) — 15-minute series are computed from raw points on read (T-14,
 * ADR-0014, so they live exactly as long as raw points: `telemetry.retention.raw`, O-014) — registers, points, average power / flow — and
 * recomputes `usage` (difference of the last register with the previous bucket, rollover-aware with the meter's
 * assignment `rollover_at`); partitions are created three months ahead and dropped after `telemetry.retention.raw`
 * (health samples after `.health`); dedup marks are purged after `.seqMarks`, rollups after `.rollups`. The gateway
 * sweep marks gateways offline after `health.gateway_missed_heartbeats` missed heartbeats (D-034).
 */
@Injectable()
export class TelemetryMaintenanceService {
  private readonly logger = new Logger(TelemetryMaintenanceService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly pipeline: IngestPipeline,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Folds every point received since the cursor into the rollups; returns the number of 15-minute buckets touched. */
  async rollup(): Promise<number> {
    const now = this.clock.now();
    return this.db.platform(
      async (tx) => {
        const cursor = await tx.rollupCursor.findUnique({ where: { name: ROLLUP_CURSOR } });
        const since = cursor?.processedUntil ?? new Date(0);
        // affected (asset item, 15-minute bucket) pairs of the newly received points
        const touched = await tx.$queryRaw<{ asset_item_id: string; min_time: Date; max_time: Date }[]>`
          SELECT asset_item_id::text, min(time) AS min_time, max(time) AS max_time FROM smart.telemetry_point
           WHERE received_at > ${since} AND received_at <= ${now} GROUP BY asset_item_id`;
        if (!touched.length) {
          await tx.rollupCursor.upsert({
            where: { name: ROLLUP_CURSOR },
            create: { name: ROLLUP_CURSOR, processedUntil: now },
            update: { processedUntil: now },
          });
          return 0;
        }
        let buckets = 0;
        for (const t of touched) {
          // whole Bangkok days around the affected points: the 1d bucket and usage need neighbours
          const from = new Date(
            Math.floor((t.min_time.getTime() + 7 * 3_600_000) / 86_400_000) * 86_400_000 - 7 * 3_600_000,
          );
          const to = new Date(
            Math.floor((t.max_time.getTime() + 7 * 3_600_000) / 86_400_000) * 86_400_000 +
              86_400_000 -
              7 * 3_600_000,
          );
          // T-14 (ADR-0014): no stored 15-minute rows — the hourly rollup folds the raw points directly
          buckets += await this.foldHour(tx, t.asset_item_id, from, to, now);
          await this.foldDay(tx, t.asset_item_id, from, to, now);
          for (const table of ['smart.telemetry_1h', 'smart.telemetry_1d'])
            await this.usage(tx, table, t.asset_item_id, from, to);
        }
        await tx.rollupCursor.upsert({
          where: { name: ROLLUP_CURSOR },
          create: { name: ROLLUP_CURSOR, processedUntil: now },
          update: { processedUntil: now },
        });
        return buckets;
      },
      { timeout: 120_000 },
    );
  }

  /** Hourly buckets from the raw points (platform-only table, gp_platform). */
  private foldHour(
    tx: Parameters<Parameters<TenantTx['platform']>[0]>[0],
    assetItemId: string,
    from: Date,
    to: Date,
    now: Date,
  ) {
    return tx.$executeRaw`
      INSERT INTO smart.telemetry_1h AS r (asset_item_id, bucket, tenant_id, building_id, unit, first_time, last_time,
             first_register, last_register, min_register, max_register, points, avg_power_w, avg_flow_lpm, updated_at)
      SELECT asset_item_id, b, (array_agg(tenant_id))[1], (array_agg(building_id))[1], (array_agg(unit))[1],
             min(time), max(time),
             (array_agg(register ORDER BY time ASC, seq ASC))[1], (array_agg(register ORDER BY time DESC, seq DESC))[1],
             min(register), max(register), count(*)::int,
             avg((extra ->> 'powerW')::numeric), avg((extra ->> 'flowLpm')::numeric), ${now}
        FROM (SELECT p.*, to_timestamp(floor(extract(epoch FROM p.time) / 3600) * 3600) AS b FROM smart.telemetry_point p
               WHERE p.asset_item_id = ${assetItemId}::uuid AND p.time >= ${from} AND p.time < ${to}) x
       GROUP BY asset_item_id, b
      ON CONFLICT (asset_item_id, bucket) DO UPDATE SET first_time = EXCLUDED.first_time, last_time = EXCLUDED.last_time,
             first_register = EXCLUDED.first_register, last_register = EXCLUDED.last_register,
             min_register = EXCLUDED.min_register, max_register = EXCLUDED.max_register, points = EXCLUDED.points,
             avg_power_w = EXCLUDED.avg_power_w, avg_flow_lpm = EXCLUDED.avg_flow_lpm, updated_at = EXCLUDED.updated_at`;
  }

  /** Daily buckets start at 00:00 Asia/Bangkok. */
  private foldDay(
    tx: Parameters<Parameters<TenantTx['platform']>[0]>[0],
    assetItemId: string,
    from: Date,
    to: Date,
    now: Date,
  ) {
    return tx.$executeRaw`
      INSERT INTO smart.telemetry_1d AS r (asset_item_id, bucket, tenant_id, building_id, unit, first_time, last_time, first_register,
             last_register, min_register, max_register, points, avg_power_w, avg_flow_lpm, updated_at)
      SELECT asset_item_id, (date_trunc('day', bucket AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok') AS b,
             (array_agg(tenant_id))[1], (array_agg(building_id))[1], (array_agg(unit))[1], min(first_time), max(last_time),
             (array_agg(first_register ORDER BY first_time ASC))[1], (array_agg(last_register ORDER BY last_time DESC))[1],
             min(min_register), max(max_register), sum(points)::int,
             sum(avg_power_w * points) / nullif(sum(points) FILTER (WHERE avg_power_w IS NOT NULL), 0),
             sum(avg_flow_lpm * points) / nullif(sum(points) FILTER (WHERE avg_flow_lpm IS NOT NULL), 0), ${now}
        FROM smart.telemetry_1h WHERE asset_item_id = ${assetItemId}::uuid AND bucket >= ${from} AND bucket < ${to}
       GROUP BY asset_item_id, b
      ON CONFLICT (asset_item_id, bucket) DO UPDATE SET first_time = EXCLUDED.first_time, last_time = EXCLUDED.last_time,
             first_register = EXCLUDED.first_register, last_register = EXCLUDED.last_register, min_register = EXCLUDED.min_register,
             max_register = EXCLUDED.max_register, points = EXCLUDED.points, avg_power_w = EXCLUDED.avg_power_w,
             avg_flow_lpm = EXCLUDED.avg_flow_lpm, updated_at = EXCLUDED.updated_at`;
  }

  /**
   * `usage` of every bucket in the window: last register − last register of the previous bucket (the first bucket
   * ever: last − first); a decrease from the top 10 % of the meter's `rollover_at` to its bottom 10 % is a rollover,
   * any other decrease counts 0 (a fault for review, never negative usage).
   */
  private usage(
    tx: Parameters<Parameters<TenantTx['platform']>[0]>[0],
    table: string,
    assetItemId: string,
    from: Date,
    to: Date,
  ) {
    return tx.$executeRawUnsafe(
      `WITH ro AS (SELECT coalesce(max(rollover_at), 99999.999) AS top FROM core.meter_assignment WHERE asset_item_id = $1::uuid),
            seq AS (SELECT bucket, first_register, last_register,
                           lag(last_register) OVER (ORDER BY bucket) AS prev
                      FROM ${table} WHERE asset_item_id = $1::uuid AND bucket >= $2::timestamptz - interval '2 days' AND bucket < $3)
       UPDATE ${table} t SET usage = CASE
                WHEN s.prev IS NULL THEN s.last_register - s.first_register
                WHEN s.last_register >= s.prev THEN s.last_register - s.prev
                WHEN s.prev >= ro.top * 0.9 AND s.last_register <= ro.top * 0.1 THEN ro.top + 0.001 - s.prev + s.last_register
                ELSE 0 END
         FROM seq s, ro
        WHERE t.asset_item_id = $1::uuid AND t.bucket = s.bucket AND s.bucket >= $2`,
      assetItemId,
      from,
      to,
    );
  }

  /** Partitions three months ahead; retention by partition drop and purge (daily). */
  async partitionsAndRetention(): Promise<{ dropped: string[]; marksPurged: number }> {
    const now = this.clock.now();
    const retention = await this.settings.valueAt<{
      raw: string;
      health: string;
      rollups: string;
      seqMarks: string;
    }>('telemetry.retention', now);
    return this.db.platform(async (tx) => {
      for (let m = 0; m <= 3; m += 1) {
        const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 15));
        await tx.$queryRaw`SELECT smart.ensure_month_partition('smart.telemetry_point'::regclass, ${at})`;
        await tx.$queryRaw`SELECT smart.ensure_month_partition('smart.device_health_sample'::regclass, ${at})`;
      }
      const raw = await tx.$queryRaw<{ d: string[] }[]>`
        SELECT smart.drop_month_partitions_before('smart.telemetry_point'::regclass, ${new Date(now.getTime() - durationMs(retention.raw))}) AS d`;
      const health = await tx.$queryRaw<{ d: string[] }[]>`
        SELECT smart.drop_month_partitions_before('smart.device_health_sample'::regclass, ${new Date(now.getTime() - durationMs(retention.health))}) AS d`;
      const marks = await tx.ingestSeqMark.deleteMany({
        where: { receivedAt: { lt: new Date(now.getTime() - durationMs(retention.seqMarks)) } },
      });
      const rollupBefore = new Date(now.getTime() - durationMs(retention.rollups));
      await tx.telemetry1h.deleteMany({ where: { bucket: { lt: rollupBefore } } });
      await tx.telemetry1d.deleteMany({ where: { bucket: { lt: rollupBefore } } });
      const dropped = [...(raw[0]?.d ?? []), ...(health[0]?.d ?? [])];
      if (dropped.length) this.logger.log({ event: 'telemetry_partitions_dropped', dropped }, 'retention');
      return { dropped, marksPurged: marks.count };
    });
  }

  /** Gateways silent for `missed × heartbeatS` → offline (D-034); missed heartbeats counted on the latest row. */
  async gatewaySweep(): Promise<number> {
    const now = this.clock.now();
    const missed = await this.settings.valueAt<number>('health.gateway_missed_heartbeats', now);
    const rows = await this.db.platform((tx) =>
      tx.deviceHealthLatest.findMany({
        where: { computedStatus: { not: 'offline' }, lastHeartbeatAt: { not: null } },
        include: { gateway: true },
      }),
    );
    let offline = 0;
    for (const r of rows) {
      const defaults = await this.settings.valueAt<{ heartbeatS: number }>('devices.gateway_defaults', now, {
        tenantId: r.tenantId,
      });
      const silentMs = now.getTime() - r.lastHeartbeatAt!.getTime();
      const count = Math.floor(silentMs / (defaults.heartbeatS * 1000));
      if (count >= missed) {
        await this.pipeline.offline(r.gateway, false, Math.min(count, 32_000));
        offline += 1;
      } else if (count !== r.missedHeartbeats)
        await this.db.platform((tx) =>
          tx.deviceHealthLatest.update({
            where: { gatewayDeviceId: r.gatewayDeviceId },
            data: { missedHeartbeats: count },
          }),
        );
    }
    return offline;
  }

  // ------------------------------------------------------------------------------------------------ dead letters

  listDeadLetters(f: {
    reason?: string;
    gatewayDeviceId?: string;
    replayed?: boolean;
    skip: number;
    take: number;
  }) {
    return this.db.platform(async (tx) => {
      const where = {
        ...(f.reason ? { reason: f.reason as never } : {}),
        ...(f.gatewayDeviceId ? { gatewayDeviceId: f.gatewayDeviceId } : {}),
        ...(f.replayed === undefined
          ? {}
          : f.replayed
            ? { replayedAt: { not: null } }
            : { replayedAt: null }),
      };
      return {
        rows: await tx.ingestDeadLetter.findMany({
          where,
          orderBy: { receivedAt: 'desc' },
          skip: f.skip,
          take: f.take,
        }),
        total: await tx.ingestDeadLetter.count({ where }),
      };
    });
  }

  /** Feeds a dead letter through the pipeline again (after a fix or a binding); the outcome is recorded. */
  async replayDeadLetter(id: string) {
    const row = await this.db.platform((tx) => tx.ingestDeadLetter.findUnique({ where: { id } }));
    if (!row) throw new DomainException('http.not_found');
    if (row.replayedAt && row.replayOutcome === 'accepted')
      throw new DomainException('ingest.not_replayable');
    this.pipeline.forgetGateways();
    const outcome = await this.pipeline.handle(
      row.topic,
      Buffer.from(row.payload),
      row.channel as 'mqtt' | 'https_batch',
    );
    const label = outcome.status === 'dead_letter' ? `refused: ${outcome.reason}` : 'accepted';
    return this.db.platform(async (tx) => {
      const updated = await tx.ingestDeadLetter.update({
        where: { id },
        data: {
          replayedAt: this.clock.now(),
          replayedBy: userIdOf(RequestContext.actor()),
          replayOutcome: label,
        },
      });
      await this.audit.record(tx, {
        action: 'ingest.dead_letter_replayed',
        subjectType: 'smart.ingest_dead_letter',
        subjectId: id,
        metadata: { outcome: label },
      });
      return { deadLetter: updated, outcome };
    });
  }
}

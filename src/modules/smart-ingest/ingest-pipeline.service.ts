import { uuidv7 } from '@common/ids/uuidv7';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type Device,
  type DeviceEventSeverity,
  type DeviceEventType,
  type DeviceStatus,
  type IngestFailure,
  type Prisma,
} from '@generated/prisma/client';
import { IngestService } from '@modules/ingest/ingest.service';
import { type CommandAck } from '@modules/ingest/protocol/command.dto';
import {
  DeviceEventType as WireEventType,
  MeterHealthStatus,
  ReadingQuality,
} from '@modules/ingest/protocol/enums';
import { type DeviceEvent } from '@modules/ingest/protocol/events.dto';
import { type Health } from '@modules/ingest/protocol/health.dto';
import { type TelemetryBatch } from '@modules/ingest/protocol/telemetry.dto';
import { DeviceCommandsService } from '@modules/smart-devices/commands.service';
import { GatewayConfigService } from '@modules/smart-devices/gateway-config.service';
import { OtaService } from '@modules/smart-devices/ota.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

/** A gateway clock more than 10 minutes ahead of receipt makes a reading `clock_suspect` (protocol §1). */
export const CLOCK_SKEW_MS = 10 * 60_000;

export interface RejectedReading {
  meterId: string;
  seq: number;
  reason: 'unbound_meter' | 'duplicate';
}

export interface TelemetryResult {
  accepted: number;
  duplicates: number;
  rejected: RejectedReading[];
}

export type PipelineOutcome =
  | { status: 'telemetry'; gatewayId: string; result: TelemetryResult }
  | { status: 'health' | 'lwt' | 'event' | 'ack'; gatewayId: string }
  | { status: 'dead_letter'; reason: IngestFailure; deadLetterId: string };

export interface PipelineCounters {
  batches: number;
  points: number;
  duplicates: number;
  unbound: number;
  deadLetters: number;
  lastLagMs: number | null;
}

interface ChannelRow {
  meter_device_id: string;
  meter_asset_item_id: string;
  tenant_id: string;
  building_id: string;
  utility: 'electric' | 'water';
  valid_from: Date;
  valid_to: Date | null;
}

const HEALTH_DEGRADED = (h: Health) => h.meters.some((m) => m.status !== MeterHealthStatus.Ok);

const SEVERITY_OF: Partial<Record<DeviceEventType, DeviceEventSeverity>> = {
  unbound_meter: 'warning',
  batch_too_large: 'warning',
  invalid_payload: 'warning',
  gateway_offline: 'critical',
  gateway_online: 'info',
};

/**
 * The B3.2 ingest pipeline shared by the MQTT ingest process and `POST /v1/device/readings/batch`: validate (DTOs
 * of `contract/device-protocol.json`), authorise each `(gatewayId, meterId)` against the meter channels open at the
 * reading's time, deduplicate `(meterId, seq)` per D-143 (in-process LRU → `smart.ingest_seq_mark` window, with
 * `smart.device.last_seq` as watermark; `meter_reading UQ(device_id, seq)` is the last line), persist
 * `smart.telemetry_point` (monthly partitions, D-162), gateway health / LWT, device events and command acks, and emit
 * `reading.candidate` (the first reading of each promotion interval), `device.online/offline/degraded`,
 * `device.event_received`. Refused payloads land in `smart.ingest_dead_letter` for the admin to replay.
 */
@Injectable()
export class IngestPipeline {
  private readonly logger = new Logger(IngestPipeline.name);
  readonly counters: PipelineCounters = {
    batches: 0,
    points: 0,
    duplicates: 0,
    unbound: 0,
    deadLetters: 0,
    lastLagMs: null,
  };
  private readonly months = new Set<string>();
  private readonly recent = new Map<string, Set<string>>();
  private readonly gateways = new Map<string, { device: Device | null; at: number }>();

  constructor(
    private readonly db: TenantTx,
    private readonly validator: IngestService,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    private readonly configs: GatewayConfigService,
    private readonly commands: DeviceCommandsService,
    private readonly ota: OtaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** One MQTT message or HTTPS batch. `expectedGatewayId` = the authenticated gateway (HTTPS). */
  async handle(
    topic: string,
    payload: Buffer | string,
    channel: 'mqtt' | 'https_batch' = 'mqtt',
    expectedGatewayId?: string,
  ): Promise<PipelineOutcome> {
    const outcome = await this.validator.handle(topic, payload);
    const gatewayId = this.validator.parseTopic(topic)?.gatewayId ?? null;
    if (outcome.status === 'rejected') {
      const id = await this.deadLetter(
        topic,
        payload,
        channel,
        gatewayId,
        outcome.reason,
        outcome.detail ?? null,
      );
      return { status: 'dead_letter', reason: outcome.reason, deadLetterId: id };
    }
    if (expectedGatewayId && outcome.gatewayId !== expectedGatewayId) {
      const id = await this.deadLetter(
        topic,
        payload,
        channel,
        gatewayId,
        'gateway_mismatch',
        'authenticated gateway differs',
      );
      return { status: 'dead_letter', reason: 'gateway_mismatch', deadLetterId: id };
    }
    const gateway = await this.gateway(outcome.gatewayId);
    if (!gateway) {
      const id = await this.deadLetter(topic, payload, channel, null, 'unknown_gateway', outcome.gatewayId);
      return { status: 'dead_letter', reason: 'unknown_gateway', deadLetterId: id };
    }
    if (outcome.status === 'lwt') {
      await this.offline(gateway, true);
      return { status: 'lwt', gatewayId: gateway.id };
    }
    switch (outcome.kind) {
      case 'telemetry':
        return {
          status: 'telemetry',
          gatewayId: gateway.id,
          result: await this.telemetry(gateway, outcome.payload as TelemetryBatch, channel),
        };
      case 'health':
        await this.health(gateway, outcome.payload as Health);
        return { status: 'health', gatewayId: gateway.id };
      case 'events':
        await this.deviceEvent(gateway, outcome.payload as DeviceEvent);
        return { status: 'event', gatewayId: gateway.id };
      case 'cmd/ack':
        await this.db.platform((tx) => this.commands.ack(tx, gateway.id, outcome.payload as CommandAck));
        return { status: 'ack', gatewayId: gateway.id };
    }
  }

  /**
   * `handle` for the MQTT subscriber: transient database errors (pool exhausted, serialization, deadlock) are retried
   * three times with backoff; a payload that still cannot be stored becomes a `processing_error` dead letter so the
   * admin can replay it — QoS 1 messages are acknowledged on receipt, so nothing may be dropped silently.
   */
  async handleSafely(topic: string, payload: Buffer | string): Promise<PipelineOutcome | null> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.handle(topic, payload);
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
    const message = last instanceof Error ? last.message : String(last);
    this.logger.error({ event: 'ingest_processing_error', topic }, `ingest failed on ${topic}: ${message}`);
    try {
      const id = await this.deadLetter(
        topic,
        payload,
        'mqtt',
        this.validator.parseTopic(topic)?.gatewayId ?? null,
        'processing_error',
        message,
      );
      return { status: 'dead_letter', reason: 'processing_error', deadLetterId: id };
    } catch {
      return null;
    }
  }

  /** The gateway row (30 s cache); null when unknown, not a gateway, retired or not assigned to a building. */
  private async gateway(id: string): Promise<Device | null> {
    const cached = this.gateways.get(id);
    const now = Date.now();
    if (cached && now - cached.at < 30_000) return cached.device;
    const device = await this.db.platform((tx) => tx.device.findUnique({ where: { id } }));
    const ok =
      device &&
      device.kind === 'gateway' &&
      device.tenantId &&
      device.buildingId &&
      device.status !== 'retired'
        ? device
        : null;
    this.gateways.set(id, { device: ok, at: now });
    return ok;
  }

  /** Drops the cached gateway rows (tests, after status changes). */
  forgetGateways(): void {
    this.gateways.clear();
  }

  // ------------------------------------------------------------------------------------------------ telemetry

  private async telemetry(
    gateway: Device,
    batch: TelemetryBatch,
    channel: 'mqtt' | 'https_batch',
  ): Promise<TelemetryResult> {
    const receivedAt = this.clock.now();
    const lagMs = Math.max(0, receivedAt.getTime() - new Date(batch.sentAt).getTime());
    this.counters.batches += 1;
    this.counters.lastLagMs = lagMs;
    // D-227 (review #4): a seq is unique within the gateway's sequence space (gateway + its state epoch), not per meter
    // — a replaced or re-flashed gateway, or a meter moved to another gateway, restarts at 1 without being dropped
    const stream = seqStreamOf(gateway.id, batch.seqEpoch);
    const recentKey = (meterId: string) => `${stream}|${meterId}`;
    // fast path: seqs this process stored recently are duplicates without a database round trip
    const fresh = batch.readings.filter((r) => !this.recent.get(recentKey(r.meterId))?.has(String(r.seq)));
    const fastDuplicates = batch.readings.length - fresh.length;
    const seen: [string, string][] = [];
    const monthsReady: string[] = [];
    const result = await this.db.platform(
      async (tx) => {
        const earliest = fresh.reduce((min, r) => Math.min(min, Date.parse(r.readAt)), Date.now());
        const channels = await tx.$queryRaw<ChannelRow[]>`
          SELECT c.meter_device_id::text, c.meter_asset_item_id::text, c.tenant_id::text, c.building_id::text,
                 CASE WHEN a.category = 'meter_electric' THEN 'electric' ELSE 'water' END AS utility, c.valid_from, c.valid_to
            FROM smart.meter_channel c JOIN core.asset_item a ON a.id = c.meter_asset_item_id
           WHERE c.gateway_device_id = ${gateway.id}::uuid AND c.meter_device_id IS NOT NULL
             AND (c.valid_to IS NULL OR c.valid_to > ${new Date(earliest)})`;
        const authorised: { r: TelemetryBatch['readings'][number]; c: ChannelRow; t: Date }[] = [];
        const rejected: RejectedReading[] = [];
        for (const r of fresh) {
          const t = new Date(r.readAt);
          const c = channels.find(
            (x) =>
              x.meter_device_id === r.meterId &&
              x.valid_from.getTime() <= t.getTime() &&
              (!x.valid_to || x.valid_to.getTime() > t.getTime()),
          );
          if (c) authorised.push({ r, c, t });
          else rejected.push({ meterId: r.meterId, seq: r.seq, reason: 'unbound_meter' });
        }
        if (rejected.length) await this.unbound(tx, gateway, rejected, receivedAt);
        if (!authorised.length)
          return { accepted: 0, duplicates: fastDuplicates, rejected, candidates: [] as Candidate[] };

        // D-143: the dedup window decides; only newly marked (device, seq) pairs are stored
        const marked = await tx.$queryRaw<{ device_id: string; seq: string }[]>`
          INSERT INTO smart.ingest_seq_mark (device_id, seq_stream, seq, received_at)
          SELECT d::uuid, ${stream}, s::bigint, ${receivedAt} FROM unnest(${authorised.map((a) => a.r.meterId)}::text[], ${authorised.map((a) => String(a.r.seq))}::text[]) AS x(d, s)
          ON CONFLICT DO NOTHING
          RETURNING device_id::text, seq::text`;
        const keep = new Set(marked.map((m) => `${m.device_id}|${m.seq}`));
        const stored = authorised.filter((a) => keep.has(`${a.r.meterId}|${a.r.seq}`));
        // caches are updated only after the commit (a rolled-back batch must be accepted on retry)
        for (const a of authorised) seen.push([a.r.meterId, String(a.r.seq)]);
        if (!stored.length)
          return {
            accepted: 0,
            duplicates: fastDuplicates + authorised.length,
            rejected,
            candidates: [] as Candidate[],
          };

        for (const month of new Set(stored.map((a) => a.t.toISOString().slice(0, 7)))) {
          if (this.months.has(month)) continue;
          await tx.$queryRaw`SELECT smart.ensure_month_partition('smart.telemetry_point'::regclass, ${new Date(`${month}-15T00:00:00Z`)})`;
          monthsReady.push(month);
        }
        const quality = (a: (typeof stored)[number]) =>
          a.t.getTime() > receivedAt.getTime() + CLOCK_SKEW_MS ? ReadingQuality.ClockSuspect : a.r.quality;
        await tx.$executeRaw`
          INSERT INTO smart.telemetry_point (time, received_at, tenant_id, building_id, asset_item_id, device_id,
                                             gateway_device_id, seq, register, unit, quality, config_version, extra)
          SELECT t::timestamptz, ${receivedAt}, tid::uuid, bid::uuid, aid::uuid, did::uuid, ${gateway.id}::uuid, s::bigint,
                 r::numeric, u::smart.meter_unit, q::smart.reading_quality, ${batch.configVersion}::int, nullif(e, '')::jsonb
            FROM unnest(${stored.map((a) => a.t.toISOString())}::text[], ${stored.map((a) => a.c.tenant_id)}::text[],
                        ${stored.map((a) => a.c.building_id)}::text[], ${stored.map((a) => a.c.meter_asset_item_id)}::text[],
                        ${stored.map((a) => a.r.meterId)}::text[], ${stored.map((a) => String(a.r.seq))}::text[],
                        ${stored.map((a) => a.r.register)}::text[], ${stored.map((a) => a.r.unit)}::text[],
                        ${stored.map(quality)}::text[], ${stored.map((a) => (a.r.extra ? JSON.stringify(a.r.extra) : ''))}::text[])
              AS x(t, tid, bid, aid, did, s, r, u, q, e)
          ON CONFLICT DO NOTHING`;

        // watermark + presence of the meter devices, latest telemetry per meter
        const maxSeq = new Map<string, number>();
        const lastTime = new Map<string, Date>();
        for (const a of stored) {
          maxSeq.set(a.r.meterId, Math.max(maxSeq.get(a.r.meterId) ?? 0, a.r.seq));
          const prev = lastTime.get(a.c.meter_asset_item_id);
          if (!prev || prev.getTime() < a.t.getTime()) lastTime.set(a.c.meter_asset_item_id, a.t);
        }
        // set-based (one statement each, whatever the number of meters in the batch — B6.5 load target)
        await tx.$executeRaw`
          UPDATE smart.device d SET last_seq = GREATEST(coalesce(d.last_seq, 0), x.s::bigint), last_seen_at = ${receivedAt},
                 status = CASE WHEN d.status IN ('provisioned', 'offline', 'degraded') THEN 'online'::smart.device_status ELSE d.status END,
                 status_changed_at = CASE WHEN d.status IN ('provisioned', 'offline', 'degraded') THEN ${receivedAt} ELSE d.status_changed_at END
            FROM unnest(${[...maxSeq.keys()]}::text[], ${[...maxSeq.values()].map(String)}::text[]) AS x(id, s)
           WHERE d.id = x.id::uuid`;
        const statusRows = [...lastTime].map(([assetItemId, t]) => ({
          assetItemId,
          t,
          c: stored.find((a) => a.c.meter_asset_item_id === assetItemId)!.c,
        }));
        await tx.$executeRaw`
          INSERT INTO smart.meter_status (asset_item_id, tenant_id, building_id, last_telemetry_at)
          SELECT a::uuid, tid::uuid, bid::uuid, t::timestamptz
            FROM unnest(${statusRows.map((r) => r.assetItemId)}::text[], ${statusRows.map((r) => r.c.tenant_id)}::text[],
                        ${statusRows.map((r) => r.c.building_id)}::text[], ${statusRows.map((r) => r.t.toISOString())}::text[])
              AS x(a, tid, bid, t)
          ON CONFLICT (asset_item_id) DO UPDATE SET last_telemetry_at = GREATEST(coalesce(smart.meter_status.last_telemetry_at, EXCLUDED.last_telemetry_at), EXCLUDED.last_telemetry_at)`;
        await tx.$executeRaw`
          UPDATE smart.device_health_latest SET ingest_lag_ms = ${Math.min(lagMs, 2_000_000_000)}::int WHERE gateway_device_id = ${gateway.id}::uuid`;
        await tx.$executeRaw`UPDATE smart.device SET last_seen_at = ${receivedAt} WHERE id = ${gateway.id}::uuid`;

        const candidates = await this.candidates(tx, stored, quality, channel, stream);
        return {
          accepted: stored.length,
          duplicates: fastDuplicates + authorised.length - stored.length,
          rejected,
          candidates,
        };
      },
      { timeout: 30_000 },
    );
    for (const [meterId, seq] of seen) {
      const set = this.recent.get(recentKey(meterId)) ?? new Set<string>();
      set.add(seq);
      if (set.size > 5000) set.delete(set.values().next().value!);
      this.recent.set(recentKey(meterId), set);
    }
    for (const month of monthsReady) this.months.add(month);
    this.counters.points += result.accepted;
    this.counters.duplicates += result.duplicates;
    this.counters.unbound += result.rejected.length;
    return {
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: result.rejected,
    };
  }

  /**
   * `reading.candidate` for the first reading of each promotion interval (setting `readings.iot_promotion_minutes`,
   * Asia/Bangkok-aligned) of each meter — the billing readings (D-030) without copying every interval point.
   */
  private async candidates(
    tx: Tx,
    stored: { r: TelemetryBatch['readings'][number]; c: ChannelRow; t: Date }[],
    quality: (a: { r: TelemetryBatch['readings'][number]; c: ChannelRow; t: Date }) => string,
    channel: 'mqtt' | 'https_batch',
    stream: string,
  ): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const intervals = new Map<string, number>();
    const buckets = new Map<string, { assetItemId: string; start: Date; end: Date }>();
    for (const a of stored) {
      let minutes = intervals.get(a.c.tenant_id);
      if (minutes === undefined) {
        minutes = await this.settings.valueAt<number>('readings.iot_promotion_minutes', this.clock.now(), {
          tenantId: a.c.tenant_id,
        });
        intervals.set(a.c.tenant_id, minutes);
      }
      const ms = minutes * 60_000;
      const offset = 7 * 3_600_000;
      const start = new Date(Math.floor((a.t.getTime() + offset) / ms) * ms - offset);
      buckets.set(`${a.c.meter_asset_item_id}|${start.toISOString()}`, {
        assetItemId: a.c.meter_asset_item_id,
        start,
        end: new Date(start.getTime() + ms),
      });
    }
    // the first stored point of every (meter, interval) bucket in one statement
    const list = [...buckets.values()];
    const firsts = list.length
      ? await tx.$queryRaw<
          { asset_item_id: string; start: Date; device_id: string; seq: string; time: Date }[]
        >`
          SELECT b.aid AS asset_item_id, b.s AS start, f.device_id::text, f.seq::text, f.time
            FROM unnest(${list.map((b) => b.assetItemId)}::text[], ${list.map((b) => b.start.toISOString())}::text[],
                        ${list.map((b) => b.end.toISOString())}::text[]) AS b(aid, s, e)
            CROSS JOIN LATERAL (
              SELECT t.device_id, t.seq, t.time FROM smart.telemetry_point t
               WHERE t.asset_item_id = b.aid::uuid AND t.time >= b.s::timestamptz AND t.time < b.e::timestamptz
               ORDER BY t.time ASC, t.seq ASC LIMIT 1) f`
      : [];
    const winners = new Map(firsts.map((f) => [`${f.asset_item_id}|${new Date(f.start).toISOString()}`, f]));
    for (const b of list) {
      const winner = winners.get(`${b.assetItemId}|${b.start.toISOString()}`);
      if (!winner) continue;
      const a = stored.find(
        (x) =>
          x.c.meter_asset_item_id === b.assetItemId &&
          x.r.meterId === winner.device_id &&
          String(x.r.seq) === winner.seq &&
          // D-227: seqs repeat across gateway sequence spaces — the winner is this batch's point only at its time
          x.t.getTime() === new Date(winner.time).getTime(),
      );
      if (!a) continue; // the first reading of the bucket arrived earlier and was already a candidate
      const candidate: Candidate = {
        assetItemId: a.c.meter_asset_item_id,
        tenantId: a.c.tenant_id,
        buildingId: a.c.building_id,
        deviceId: a.r.meterId,
        seq: String(a.r.seq),
        seqStream: stream,
        readAt: a.t.toISOString(),
        register: new Decimal(a.r.register).toFixed(3),
        quality: quality(a),
        via: channel,
      };
      out.push(candidate);
      await this.events.record(tx, {
        type: 'reading.candidate',
        aggregateType: 'asset_item',
        aggregateId: candidate.assetItemId,
        tenantId: candidate.tenantId,
        buildingId: candidate.buildingId,
        payload: { ...candidate },
      });
    }
    return out;
  }

  private async unbound(tx: Tx, gateway: Device, rejected: RejectedReading[], at: Date): Promise<void> {
    const meters = [...new Set(rejected.map((r) => r.meterId))];
    await this.audit.record(tx, {
      action: 'ingest.unbound_meter_rejected',
      tenantId: gateway.tenantId,
      buildingId: gateway.buildingId,
      subjectType: 'smart.device',
      subjectId: gateway.id,
      outcome: 'denied',
      metadata: { meterIds: meters.slice(0, 50), readings: rejected.length },
    });
    await this.recordEvent(tx, gateway, {
      type: 'unbound_meter',
      occurredAt: at,
      message: `${rejected.length} reading(s) for ${meters.length} meter(s) not bound to this gateway`,
      data: { meterIds: meters.slice(0, 50), readings: rejected.length },
    });
  }

  // ------------------------------------------------------------------------------------------------ health

  private async health(gateway: Device, h: Health): Promise<void> {
    const now = this.clock.now();
    const degraded = HEALTH_DEGRADED(h);
    const status: DeviceStatus = degraded ? 'degraded' : 'online';
    await this.db.platform(async (tx) => {
      await this.sample(tx, gateway, now, {
        agentVersion: h.agentVersion,
        configVersion: h.configVersion,
        uptimeS: h.uptimeS,
        bufferedReadings: h.bufferedReadings,
        diskFreeMb: h.diskFreeMb,
        cpuPct: h.cpuPct,
        memPct: h.memPct,
        link: h.link,
        rssi: h.rssi,
        meters: h.meters as unknown as Prisma.InputJsonValue,
        isLwt: false,
      });
      const latest = {
        tenantId: gateway.tenantId!,
        buildingId: gateway.buildingId!,
        lastHeartbeatAt: now,
        agentVersion: h.agentVersion,
        configVersion: h.configVersion,
        uptimeS: h.uptimeS,
        bufferedReadings: h.bufferedReadings,
        diskFreeMb: h.diskFreeMb,
        cpuPct: h.cpuPct,
        memPct: h.memPct,
        link: h.link,
        rssi: h.rssi,
        meters: h.meters as unknown as Prisma.InputJsonValue,
        isLwt: false,
        missedHeartbeats: 0,
        computedStatus: status,
      };
      await tx.deviceHealthLatest.upsert({
        where: { gatewayDeviceId: gateway.id },
        create: { gatewayDeviceId: gateway.id, ...latest },
        update: latest,
      });
      const current = await tx.device.findUniqueOrThrow({ where: { id: gateway.id } });
      await tx.device.update({
        where: { id: gateway.id },
        data: {
          lastSeenAt: now,
          firmwareVersion: h.agentVersion,
          ...(current.status !== status ? { status, statusChangedAt: now } : {}),
        },
      });
      if (current.status !== status) await this.transition(tx, gateway, current.status, status, now);
      // a config reported in health after its publication counts as applied (config_applied may be lost)
      if (h.configVersion > 0 && (current.configAppliedVersion ?? 0) < h.configVersion)
        await this.configs.onGatewayReport(tx, gateway.id, h.configVersion, true, null);
    });
    this.gateways.delete(gateway.id);
  }

  private async sample(
    tx: Tx,
    gateway: Device,
    at: Date,
    data: Omit<Prisma.DeviceHealthSampleCreateInput, 'time' | 'gatewayDeviceId' | 'tenantId' | 'buildingId'>,
  ) {
    const month = at.toISOString().slice(0, 7);
    if (!this.months.has(`h${month}`)) {
      await tx.$queryRaw`SELECT smart.ensure_month_partition('smart.device_health_sample'::regclass, ${at})`;
      this.months.add(`h${month}`);
    }
    await tx.deviceHealthSample.createMany({
      data: [
        {
          time: at,
          gatewayDeviceId: gateway.id,
          tenantId: gateway.tenantId!,
          buildingId: gateway.buildingId!,
          ...data,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** LWT (broker) or the missed-heartbeat sweep: the gateway is offline (D-034). */
  async offline(gateway: Device, lwt: boolean, missed = 0): Promise<void> {
    const now = this.clock.now();
    await this.db.platform(async (tx) => {
      const current = await tx.device.findUniqueOrThrow({ where: { id: gateway.id } });
      if (lwt) await this.sample(tx, gateway, now, { isLwt: true });
      await tx.deviceHealthLatest.upsert({
        where: { gatewayDeviceId: gateway.id },
        create: {
          gatewayDeviceId: gateway.id,
          tenantId: gateway.tenantId!,
          buildingId: gateway.buildingId!,
          isLwt: lwt,
          missedHeartbeats: missed,
          computedStatus: 'offline',
        },
        update: { isLwt: lwt, missedHeartbeats: missed, computedStatus: 'offline' },
      });
      if (current.status === 'offline' || current.status === 'retired') return;
      await tx.device.update({
        where: { id: gateway.id },
        data: { status: 'offline', statusChangedAt: now },
      });
      await this.transition(tx, gateway, current.status, 'offline', now, lwt ? 'lwt' : 'missed_heartbeats');
    });
    this.gateways.delete(gateway.id);
  }

  private async transition(
    tx: Tx,
    gateway: Device,
    from: DeviceStatus,
    to: DeviceStatus,
    at: Date,
    cause: string | null = null,
  ): Promise<void> {
    if (to === 'offline' || (to === 'online' && from === 'offline'))
      await this.recordEvent(tx, gateway, {
        type: to === 'offline' ? 'gateway_offline' : 'gateway_online',
        occurredAt: at,
        message: to === 'offline' ? `gateway offline (${cause ?? 'unknown'})` : 'gateway back online',
        data: { from, to, cause },
      });
    await this.events.record(tx, {
      type: to === 'offline' ? 'device.offline' : to === 'degraded' ? 'device.degraded' : 'device.online',
      aggregateType: 'device',
      aggregateId: gateway.id,
      tenantId: gateway.tenantId,
      buildingId: gateway.buildingId,
      payload: { deviceId: gateway.id, serial: gateway.serial, from, to, cause, since: at.toISOString() },
    });
  }

  // ------------------------------------------------------------------------------------------------ events

  private async deviceEvent(gateway: Device, e: DeviceEvent): Promise<void> {
    await this.db.platform(async (tx) => {
      const exists = await tx.deviceEvent.findUnique({ where: { eventId: e.eventId } });
      if (exists) return;
      await this.recordEvent(tx, gateway, {
        eventId: e.eventId,
        type: e.type,
        severity: e.severity,
        occurredAt: new Date(e.occurredAt),
        deviceId: e.meterId ?? null,
        configVersion: e.configVersion ?? null,
        message: e.message ?? null,
        data: e.data,
      });
      const version = e.configVersion ? Number.parseInt(e.configVersion, 10) : NaN;
      if (
        (e.type === WireEventType.ConfigApplied || e.type === WireEventType.ConfigRejected) &&
        Number.isInteger(version)
      )
        await this.configs.onGatewayReport(
          tx,
          gateway.id,
          version,
          e.type === WireEventType.ConfigApplied,
          e.message ?? (typeof e.data?.error === 'string' ? e.data.error : null),
        );
      if (e.type.startsWith('ota_')) await this.ota.onDeviceEvent(tx, gateway.id, e.type, e.data);
    });
  }

  private async recordEvent(
    tx: Tx,
    gateway: Device,
    e: {
      eventId?: string;
      type: DeviceEventType;
      severity?: DeviceEventSeverity;
      occurredAt: Date;
      deviceId?: string | null;
      configVersion?: string | null;
      message?: string | null;
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    const severity = e.severity ?? SEVERITY_OF[e.type] ?? 'info';
    await tx.deviceEvent.create({
      data: {
        eventId: e.eventId ?? uuidv7(),
        tenantId: gateway.tenantId,
        buildingId: gateway.buildingId,
        gatewayDeviceId: gateway.id,
        deviceId: e.deviceId ?? null,
        type: e.type,
        severity,
        occurredAt: e.occurredAt,
        receivedAt: this.clock.now(),
        configVersion: e.configVersion ?? null,
        message: e.message?.slice(0, 500) ?? null,
        data: (e.data ?? {}) as Prisma.InputJsonValue,
      },
    });
    await this.events.record(tx, {
      type: 'device.event_received',
      aggregateType: 'device',
      aggregateId: gateway.id,
      tenantId: gateway.tenantId,
      buildingId: gateway.buildingId,
      payload: { gatewayDeviceId: gateway.id, type: e.type, severity, meterDeviceId: e.deviceId ?? null },
    });
  }

  // ------------------------------------------------------------------------------------------------ dead letters

  private async deadLetter(
    topic: string,
    payload: Buffer | string,
    channel: 'mqtt' | 'https_batch',
    gatewayId: string | null,
    reason: IngestFailure,
    detail: string | null,
  ): Promise<string> {
    this.counters.deadLetters += 1;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const known = gatewayId ? await tx.device.findUnique({ where: { id: gatewayId } }) : null;
      const row = await tx.ingestDeadLetter.create({
        data: {
          topic: topic.slice(0, 200),
          channel,
          gatewayDeviceId: known?.id ?? null,
          reason,
          detail: detail?.slice(0, 1000) ?? null,
          payload: new Uint8Array(body.subarray(0, 1_048_576)),
          receivedAt: now,
        },
      });
      if (known && known.tenantId) {
        if (reason === 'batch_too_large')
          await this.recordEvent(tx, known, {
            type: 'batch_too_large',
            occurredAt: now,
            message: detail ?? 'batch above 200 readings',
            data: { deadLetterId: row.id },
          });
        else await this.invalidThreshold(tx, known, now);
      }
      return row.id;
    });
  }

  /** `device.invalid_payload` once the gateway reached the threshold within the window (protocol §5). */
  private async invalidThreshold(tx: Tx, gateway: Device, now: Date): Promise<void> {
    const rule = await this.settings.valueAt<{ count: number; window: string }>(
      'ingest.invalid_payload_alert',
      now,
    );
    const hours = /^PT(\d+)H$/.exec(rule.window)?.[1];
    const minutes = /^PT(\d+)M$/.exec(rule.window)?.[1];
    const windowMs = hours ? Number(hours) * 3_600_000 : minutes ? Number(minutes) * 60_000 : 3_600_000;
    const since = new Date(now.getTime() - windowMs);
    const count = await tx.ingestDeadLetter.count({
      where: { gatewayDeviceId: gateway.id, receivedAt: { gte: since }, reason: { not: 'batch_too_large' } },
    });
    if (count < rule.count) return;
    const already = await tx.deviceEvent.count({
      where: { gatewayDeviceId: gateway.id, type: 'invalid_payload', occurredAt: { gte: since } },
    });
    if (already) return;
    await this.recordEvent(tx, gateway, {
      type: 'invalid_payload',
      occurredAt: now,
      message: `${count} invalid payloads within ${rule.window}`,
      data: { count, window: rule.window },
    });
  }
}

export interface Candidate {
  assetItemId: string;
  tenantId: string;
  buildingId: string;
  deviceId: string;
  seq: string;
  /** D-227: the gateway sequence space the seq belongs to (`<gatewayId>/<seqEpoch or ->`). */
  seqStream: string;
  readAt: string;
  register: string;
  quality: string;
  via: 'mqtt' | 'https_batch';
}

/** D-227: the dedup scope of a gateway's seqs — the gateway and the epoch of its state database (`-` before 1.1). */
export function seqStreamOf(gatewayId: string, seqEpoch: string | undefined | null): string {
  return `${gatewayId}/${seqEpoch ?? '-'}`;
}

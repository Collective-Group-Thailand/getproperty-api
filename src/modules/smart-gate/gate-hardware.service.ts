import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { residentUnitRoles } from '@core/identity/resident-units';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type DeviceCommand,
  type Gate,
  type GateDevice,
  type PlateDetection,
  type ResidentVehicle,
  type VisitActorKind,
} from '@generated/prisma/client';
import { DeviceEventType } from '@modules/ingest/protocol/enums';
import { type DeviceEvent } from '@modules/ingest/protocol/events.dto';
import { type GateStateData, type PlateDetectedData } from '@modules/ingest/protocol/gate.dto';
import { residentUserId } from '@modules/ops-juristic/resident-unit-access';
import { DeviceCommandsService } from '@modules/smart-devices/commands.service';
import { GatewayConfigService } from '@modules/smart-devices/gateway-config.service';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  insideGeofence,
  isLateRead,
  lprAutoEntry,
  matchPlate,
  normaliseLprPlate,
  openRetryAfter,
  type PlateCandidate,
  readClockSuspect,
} from './gate-hardware-rules';
import { normalisePlate, type PlateInput } from './gate-rules';
import { GATE_UNIT_ROLES, guardContext, HOUSEHOLD_DECIDERS, VisitsService } from './visits.service';

const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/** Reasons a guard may give on the tablet (the LPR and the resident app have their own). */
export const GUARD_OPEN_REASONS = ['visit', 'resident', 'delivery', 'service', 'emergency', 'other'] as const;
export type GuardOpenReason = (typeof GUARD_OPEN_REASONS)[number];

/** Edge gateways in these states can carry a gate device. */
const USABLE_GATEWAY = ['assigned', 'provisioned', 'online', 'degraded', 'offline'];

export interface OpenBy {
  kind: Extract<VisitActorKind, 'guard' | 'resident' | 'device'>;
  id: string | null;
}

export interface OpenResult {
  gateId: string;
  commands: DeviceCommand[];
}

export type DetectionRow = PlateDetection & { unit: { id: string; unitNo: string } | null };

/**
 * J4.2 (D-316, D-328): barrier relays and LPR cameras on getproperty-edge gateways, the `gate.open` command (guard,
 * resident app, known plate), the device events `gate.state` / `plate.detected`, the units' own car register and the
 * pending plate reads the gate tablet claims. Every open is one transaction under the gate's row lock (the per-gate
 * interval holds with several API processes) with its commands, audit row and domain event.
 */
@Injectable()
export class GateHardwareService extends TenantScopedRepository {
  private readonly logger = new Logger(GateHardwareService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly commands: DeviceCommandsService,
    private readonly configs: GatewayConfigService,
    private readonly visits: VisitsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private now(): Date {
    return this.clock.now();
  }

  // ------------------------------------------------------------------------------------------------ owner: devices

  /** Attach a barrier relay or an LPR camera of an edge gateway (a provisioned gateway of a building of the estate). */
  async attach(
    ctx: TenantContext,
    gateId: string,
    input: {
      kind: 'barrier' | 'lpr';
      name: string;
      edgeDeviceId: string;
      channel: string;
      pulseMs?: number | null;
    },
  ): Promise<GateDevice> {
    const name = input.name.trim();
    if (!name || name.length > 120) throw invalid('name', 'length', '1–120 characters');
    if (!/^[A-Za-z0-9_.:-]{1,32}$/.test(input.channel))
      throw invalid('channel', 'pattern', 'letters, digits, _ . : - (1–32)');
    if (input.kind !== 'barrier' && input.pulseMs != null)
      throw invalid('pulseMs', 'barrier_only', 'a pulse only for a barrier');
    const now = this.now();
    try {
      return await this.db.tenant(ctx, async (tx) => {
        const gate = this.found(await tx.gate.findFirst({ where: { id: gateId, tenantId: ctx.tenantId } }));
        const edge = await tx.device.findFirst({ where: { id: input.edgeDeviceId, tenantId: ctx.tenantId } });
        const building = edge?.buildingId
          ? await tx.building.findFirst({ where: { id: edge.buildingId, propertyId: gate.propertyId } })
          : null;
        if (!edge || edge.kind !== 'gateway' || !USABLE_GATEWAY.includes(edge.status) || !building)
          throw new DomainException('gate.edge_device_invalid');
        const taken = await tx.gateDevice.findFirst({
          where: { edgeDeviceId: edge.id, channel: input.channel, state: { not: 'revoked' } },
          select: { id: true },
        });
        if (taken) throw new DomainException('gate.channel_taken');
        const device = await tx.gateDevice.create({
          data: {
            tenantId: ctx.tenantId,
            gateId: gate.id,
            kind: input.kind,
            name,
            state: 'active',
            edgeDeviceId: edge.id,
            channel: input.channel,
            pulseMs: input.kind === 'barrier' ? (input.pulseMs ?? null) : null,
            enrolledAt: now,
            createdAt: now,
            updatedAt: now,
            createdBy: this.by(),
          },
        });
        await this.syncFlags(tx, gate.id);
        await this.configs.compile(tx, edge.id);
        await this.audit.record(tx, {
          action: 'gate.edge_device_attached',
          tenantId: ctx.tenantId,
          buildingId: edge.buildingId,
          subjectType: 'smart.gate_device',
          subjectId: device.id,
          metadata: { gateId: gate.id, kind: input.kind, edgeDeviceId: edge.id, channel: input.channel },
        });
        await this.events.record(tx, {
          type: 'gate.edge_device_attached',
          aggregateType: 'gate',
          aggregateId: gate.id,
          tenantId: ctx.tenantId,
          payload: { gateId: gate.id, gateDeviceId: device.id, kind: input.kind, edgeDeviceId: edge.id },
        });
        return device;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new DomainException('gate.channel_taken');
      throw error;
    }
  }

  /** Detach a barrier / camera (idempotent); the gateway config drops it. */
  async detach(
    ctx: TenantContext,
    gateId: string,
    gateDeviceId: string,
    reason: string,
  ): Promise<GateDevice> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 500) throw invalid('reason', 'length', '3–500 characters');
    return this.db.tenant(ctx, async (tx) => {
      const device = this.found(
        await tx.gateDevice.findFirst({
          where: { id: gateDeviceId, gateId, tenantId: ctx.tenantId, kind: { in: ['barrier', 'lpr'] } },
        }),
      );
      if (device.state === 'revoked') return device;
      const now = this.now();
      const updated = await tx.gateDevice.update({
        where: { id: device.id },
        data: {
          state: 'revoked',
          revokedAt: now,
          revokedBy: this.by(),
          revokeReason: text,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      await this.syncFlags(tx, gateId);
      if (device.edgeDeviceId) await this.configs.compile(tx, device.edgeDeviceId);
      await this.audit.record(tx, {
        action: 'gate.edge_device_detached',
        tenantId: ctx.tenantId,
        subjectType: 'smart.gate_device',
        subjectId: device.id,
        metadata: { gateId, kind: device.kind },
      });
      await this.events.record(tx, {
        type: 'gate.edge_device_detached',
        aggregateType: 'gate',
        aggregateId: gateId,
        tenantId: ctx.tenantId,
        payload: { gateId, gateDeviceId: device.id, kind: device.kind },
      });
      return updated;
    });
  }

  private by(): string | null {
    const actor = RequestContext.actor();
    return actor?.type === 'user' ? actor.publicId : null;
  }

  /** `smart.gate.barrier` / `lpr` follow the live hardware of the gate. */
  private async syncFlags(tx: Tx, gateId: string): Promise<void> {
    const live = await tx.gateDevice.findMany({
      where: { gateId, state: 'active', kind: { in: ['barrier', 'lpr'] } },
      select: { kind: true },
    });
    await tx.gate.update({
      where: { id: gateId },
      data: {
        barrier: live.some((d) => d.kind === 'barrier'),
        lpr: live.some((d) => d.kind === 'lpr'),
        updatedAt: this.now(),
      },
    });
  }

  // ------------------------------------------------------------------------------------------------ open

  /**
   * One barrier open of a gate inside the caller's transaction: lock the gate, check the per-gate interval
   * (`gate.open.min_interval_seconds`, 429 with Retry-After), one `gate.open` per live barrier, the gate's
   * `last_open_at`, audit + event (visit timeline `gate_opened` when it opens for a visit). `soft` (LPR): returns null
   * instead of refusing (no barrier, too soon).
   */
  async openIn(
    tx: Tx,
    gate: Pick<Gate, 'id' | 'tenantId' | 'propertyId'>,
    input: { reason: string; note?: string | null; visitId?: string | null; by: OpenBy; soft?: boolean },
    auditMeta: Record<string, unknown> = {},
  ): Promise<OpenResult | null> {
    const now = this.now();
    await tx.$queryRaw`SELECT id FROM smart.gate WHERE id = ${gate.id}::uuid FOR UPDATE`;
    const row = await tx.gate.findUniqueOrThrow({ where: { id: gate.id } });
    const barriers = await tx.gateDevice.findMany({
      where: { gateId: gate.id, kind: 'barrier', state: 'active', edgeDeviceId: { not: null } },
      include: { edgeDevice: { select: { id: true, tenantId: true, buildingId: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const usable = barriers.filter((b) => b.edgeDevice && b.edgeDevice.status !== 'retired');
    if (!usable.length) {
      if (input.soft) return null;
      throw new DomainException('gate.no_barrier');
    }
    const scope = { tenantId: gate.tenantId, propertyId: gate.propertyId };
    const minInterval = await this.settings.valueAt<number>('gate.open.min_interval_seconds', now, scope);
    const retry = openRetryAfter(row.lastOpenAt, now, minInterval);
    if (retry > 0) {
      if (input.soft) return null;
      throw new DomainException('gate.open_rate_limited', {
        headers: { 'Retry-After': String(retry) },
        params: { seconds: retry },
      });
    }
    const defaultPulse = await this.settings.valueAt<number>('gate.barrier.pulse_ms', now, scope);
    const commands: DeviceCommand[] = [];
    for (const b of usable)
      commands.push(
        await this.commands.issueGateOpen(tx, b.edgeDevice!, {
          gateId: gate.id,
          deviceId: b.id,
          reason: input.reason,
          ...(input.visitId ? { visitId: input.visitId } : {}),
          pulseMs: b.pulseMs ?? defaultPulse,
        }),
      );
    await tx.gate.update({ where: { id: gate.id }, data: { lastOpenAt: now } });
    const commandIds = commands.map((c) => c.id);
    const payload = { reason: input.reason, by: input.by.kind, commandIds };
    if (input.visitId) {
      const visit = await tx.visit.findUniqueOrThrow({ where: { id: input.visitId } });
      await this.visits.record(tx, visit, 'gate.open_requested', 'gate_opened', input.by, payload);
    } else
      await this.events.record(tx, {
        type: 'gate.open_requested',
        aggregateType: 'gate',
        aggregateId: gate.id,
        tenantId: gate.tenantId,
        payload: { gateId: gate.id, ...payload },
      });
    await this.audit.record(tx, {
      action: 'gate.open_requested',
      tenantId: gate.tenantId,
      subjectType: 'smart.gate',
      subjectId: gate.id,
      metadata: {
        by: input.by.kind,
        reason: input.reason,
        ...(input.note ? { note: input.note } : {}),
        visitId: input.visitId ?? null,
        commandIds,
        ...auditMeta,
      },
    });
    return { gateId: gate.id, commands };
  }

  /** `POST /v1/guard/gates/{gateId}/actions/open`: only the gate of the shift (another gate = 404). */
  async guardOpen(
    gateId: string,
    input: { reason: GuardOpenReason; note?: string | null; visitId?: string | null },
  ): Promise<OpenResult> {
    const g = guardContext();
    if (gateId !== g.gateId) throw new DomainException('http.not_found');
    if (!(GUARD_OPEN_REASONS as readonly string[]).includes(input.reason))
      throw invalid('reason', 'isIn', GUARD_OPEN_REASONS.join(', '));
    const note = input.note?.trim() || null;
    if (input.reason === 'other' && (!note || note.length < 3))
      throw invalid('note', 'required', 'why the barrier opens (3–200 characters)');
    if (note && note.length > 200) throw invalid('note', 'maxLength', 'at most 200 characters');
    return this.db.tenant(g.ctx, async (tx) => {
      const gate = this.found(await tx.gate.findFirst({ where: { id: g.gateId, tenantId: g.tenantId } }));
      if (gate.state !== 'active') throw new DomainException('gate.inactive');
      if (input.visitId) {
        const visit = await tx.visit.findFirst({ where: { id: input.visitId, gateId: gate.id } });
        if (!visit) throw new DomainException('http.not_found');
      }
      return (await this.openIn(tx, gate, {
        reason: input.reason,
        note,
        visitId: input.visitId ?? null,
        by: { kind: 'guard', id: g.userId },
      }))!;
    });
  }

  /** Units the signed-in resident holds a gate role on today. */
  private async myGateUnits(tx: Tx, userId: string): Promise<string[]> {
    const roles = await residentUnitRoles(tx, userId, bangkokDate(this.now()));
    return [
      ...new Set(
        roles.filter((r) => (GATE_UNIT_ROLES as readonly string[]).includes(r.role)).map((r) => r.unitId),
      ),
    ];
  }

  /** `GET /v1/resident/gates`: barrier gates of my estates, whether I may open them, my units' cars. */
  async residentGates() {
    const userId = residentUserId();
    const now = this.now();
    return this.db.platform(async (tx) => {
      const unitIds = await this.myGateUnits(tx, userId);
      if (!unitIds.length) return [];
      const vehicles = await tx.residentVehicle.findMany({
        where: { unitId: { in: unitIds }, removedAt: null },
        include: { unit: { select: { id: true, unitNo: true } } },
        orderBy: [{ unitId: 'asc' }, { createdAt: 'asc' }],
      });
      const units = await tx.unit.findMany({
        where: { id: { in: unitIds } },
        select: { id: true, propertyId: true, tenantId: true },
      });
      const propertyIds = [...new Set(units.map((u) => u.propertyId))];
      const gates = await tx.gate.findMany({
        where: { propertyId: { in: propertyIds }, state: 'active', barrier: true },
        include: { property: { select: { name: true } } },
        orderBy: [{ propertyId: 'asc' }, { name: 'asc' }],
      });
      const out = [];
      for (const gate of gates) {
        const scope = { tenantId: gate.tenantId, propertyId: gate.propertyId };
        out.push({
          gate,
          propertyName: gate.property.name,
          enabled: await this.settings.valueAt<boolean>('gate.resident_open.enabled', now, scope),
          requireGeofence: await this.settings.valueAt<boolean>(
            'gate.resident_open.require_geofence',
            now,
            scope,
          ),
          vehicles: vehicles.filter((v) => v.propertyId === gate.propertyId),
        });
      }
      return out;
    });
  }

  /**
   * `POST /v1/resident/gates/{gateId}/actions/open`: one of the cars registered on a unit I hold a gate role on today,
   * in the gate's estate (anything else 404); the setting must allow it, the geofence (when required) must hold — only
   * the decision is audited, never the coordinates; at most `gate.resident_open.max_per_hour` per login.
   */
  async residentOpen(
    gateId: string,
    input: { vehicleId: string; location?: { lat: number; lng: number; accuracyM?: number | null } | null },
  ): Promise<OpenResult> {
    const userId = residentUserId();
    const now = this.now();
    const found = await this.db.platform(async (tx) => {
      const vehicle = await tx.residentVehicle.findUnique({ where: { id: input.vehicleId } });
      if (!vehicle || vehicle.removedAt) throw new DomainException('http.not_found');
      const units = await this.myGateUnits(tx, userId);
      if (!units.includes(vehicle.unitId)) throw new DomainException('http.not_found');
      const gate = await tx.gate.findUnique({ where: { id: gateId } });
      if (!gate || gate.propertyId !== vehicle.propertyId || gate.state !== 'active')
        throw new DomainException('http.not_found');
      const property = await tx.property.findUniqueOrThrow({
        where: { id: gate.propertyId },
        select: { lat: true, lng: true },
      });
      const recent = await tx.auditLog.count({
        where: {
          actorId: userId,
          action: 'gate.open_requested',
          outcome: 'success',
          occurredAt: { gte: new Date(now.getTime() - 3_600_000) },
        },
      });
      return { vehicle, gate, property, recent };
    });
    const { vehicle, gate, property } = found;
    const scope = { tenantId: gate.tenantId, propertyId: gate.propertyId };
    if (!(await this.settings.valueAt<boolean>('gate.resident_open.enabled', now, scope)))
      throw new DomainException('gate.resident_open_disabled');
    const perHour = await this.settings.valueAt<number>('gate.resident_open.max_per_hour', now, scope);
    if (found.recent >= perHour)
      throw new DomainException('gate.open_rate_limited', { headers: { 'Retry-After': '600' } });
    let geofence: 'not_required' | 'inside' = 'not_required';
    if (await this.settings.valueAt<boolean>('gate.resident_open.require_geofence', now, scope)) {
      const loc = input.location;
      if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng))
        throw invalid('location', 'required', 'the phone location (lat, lng) — checked, never stored');
      if (property.lat === null || property.lng === null)
        throw new DomainException('gate.geofence_unavailable');
      const radius = await this.settings.valueAt<number>('gate.resident_open.radius_m', now, scope);
      const inside = insideGeofence(
        { lat: Number(property.lat), lng: Number(property.lng) },
        { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM ?? null },
        radius,
      );
      if (!inside) {
        // the decision only — never the coordinates (D-328)
        await this.audit.recordAlone({
          action: 'gate.open_requested',
          tenantId: gate.tenantId,
          subjectType: 'smart.gate',
          subjectId: gate.id,
          outcome: 'denied',
          metadata: { by: 'resident', vehicleId: vehicle.id, unitId: vehicle.unitId, geofence: 'outside' },
        });
        throw new DomainException('gate.outside_geofence');
      }
      geofence = 'inside';
    }
    return this.db.tenant(
      systemTenantContext(gate.tenantId),
      async (tx) =>
        (await this.openIn(
          tx,
          gate,
          { reason: 'resident_app', by: { kind: 'resident', id: userId } },
          { vehicleId: vehicle.id, unitId: vehicle.unitId, geofence },
        ))!,
    );
  }

  // ------------------------------------------------------------------------------------------------ device events

  /** The `data` a device-event row keeps: ids and the state only — never the plate (PDPA, D-328). */
  redactedData(e: DeviceEvent): Record<string, unknown> | undefined {
    if (e.type === DeviceEventType.PlateDetected) {
      const d = e.data as unknown as PlateDetectedData;
      return { gateId: d.gateId, deviceId: d.deviceId ?? null, confidence: d.confidence };
    }
    return e.data;
  }

  /**
   * `gate.state` / `plate.detected` from an edge gateway (ingest, as gp_platform, inside the device-event
   * transaction). Acted on only when the gateway drives a live device of that kind at that gate; otherwise refused
   * (audited) and ignored. Never throws for business reasons (the message is acknowledged on receipt).
   */
  async onDeviceEvent(
    tx: Tx,
    gateway: { id: string; tenantId: string | null },
    e: DeviceEvent,
  ): Promise<void> {
    if (e.type !== DeviceEventType.GateState && e.type !== DeviceEventType.PlateDetected) return;
    const data = e.data as unknown as GateStateData | PlateDetectedData;
    const kind = e.type === DeviceEventType.GateState ? 'barrier' : 'lpr';
    const devices = await tx.gateDevice.findMany({
      where: {
        gateId: data.gateId,
        kind,
        state: 'active',
        edgeDeviceId: gateway.id,
        ...(data.deviceId ? { id: data.deviceId } : {}),
      },
      include: { gate: true },
    });
    const device = devices.length === 1 ? devices[0]! : null;
    if (!device || device.gate.state !== 'active' || device.tenantId !== gateway.tenantId) {
      await this.refuse(tx, gateway, e, devices.length > 1 ? 'device_ambiguous' : 'not_bound');
      return;
    }
    if (e.type === DeviceEventType.GateState) await this.gateState(tx, device, data as GateStateData);
    else await this.plateDetected(tx, device, e.eventId, data as PlateDetectedData);
  }

  private async refuse(
    tx: Tx,
    gateway: { id: string; tenantId: string | null },
    e: DeviceEvent,
    reason: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'gate.device_event_refused',
      tenantId: gateway.tenantId,
      subjectType: 'smart.device',
      subjectId: gateway.id,
      outcome: 'denied',
      metadata: { type: e.type, eventId: e.eventId, gateId: (e.data as { gateId?: string })?.gateId, reason },
    });
  }

  private async gateState(tx: Tx, device: GateDevice & { gate: Gate }, data: GateStateData): Promise<void> {
    const at = new Date(data.at);
    if (!device.hwStateAt || device.hwStateAt.getTime() <= at.getTime())
      await tx.gateDevice.update({
        where: { id: device.id },
        data: { hwState: data.state, hwStateAt: at, lastSeenAt: this.now() },
      });
    await this.events.record(tx, {
      type: 'gate.barrier_state',
      aggregateType: 'gate',
      aggregateId: device.gateId,
      tenantId: device.tenantId,
      payload: {
        gateId: device.gateId,
        gateDeviceId: device.id,
        state: data.state,
        ...(data.commandId ? { commandId: data.commandId } : {}),
      },
    });
  }

  private async plateDetected(
    tx: Tx,
    device: GateDevice & { gate: Gate },
    eventId: string,
    data: PlateDetectedData,
  ): Promise<void> {
    const gate = device.gate;
    const now = this.now();
    const scope = { tenantId: gate.tenantId, propertyId: gate.propertyId };
    const plate = normaliseLprPlate(data.plate);
    if (!plate) {
      await this.audit.record(tx, {
        action: 'gate.device_event_refused',
        tenantId: gate.tenantId,
        subjectType: 'smart.gate_device',
        subjectId: device.id,
        outcome: 'denied',
        metadata: { type: 'plate.detected', eventId, reason: 'unreadable_plate' },
      });
      return;
    }
    await tx.gateDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } });
    // CR-017 / D-330: a read that reaches us later than gate.lpr.max_event_age_seconds after the camera read it (edge
    // outage, queued) is history — the car is no longer at the barrier. It is kept as a past read only: no entry, no
    // gate.open, nothing for the guard to claim. An unreadable read time cannot prove it is live → history too; so is
    // a read time further ahead than gate.lpr.max_clock_skew_seconds (gateway clock suspect, D-336).
    const detectedAt = new Date(data.at);
    const maxAge = await this.settings.valueAt<number>('gate.lpr.max_event_age_seconds', now, scope);
    const maxSkew = await this.settings.valueAt<number>('gate.lpr.max_clock_skew_seconds', now, scope);
    const historical = isLateRead(detectedAt, now, maxAge, maxSkew);
    const clockSuspect = readClockSuspect(detectedAt, now, maxSkew);
    // one car, one entry: the same plate again at this gate within the window is ignored (no row kept). Live reads
    // compare receipt times among live reads; late reads compare read times among late reads (a flushed queue of
    // frames keeps one row) — a late read never suppresses the next live read, nor the other way round.
    const repeat = await this.settings.valueAt<number>('gate.lpr.repeat_seconds', now, scope);
    const again = await tx.plateDetection.findFirst({
      where: {
        gateId: gate.id,
        plateCategory: plate.category,
        plateNumber: plate.number,
        ...(historical
          ? {
              state: 'historical',
              detectedAt: {
                gte: new Date(detectedAt.getTime() - repeat * 1000),
                lte: new Date(detectedAt.getTime() + repeat * 1000),
              },
            }
          : { state: { not: 'historical' }, receivedAt: { gte: new Date(now.getTime() - repeat * 1000) } }),
      },
      select: { id: true },
    });
    if (again) return;
    const minConfidence = Number(await this.settings.valueAt<string>('gate.lpr.min_confidence', now, scope));
    const sameRead = {
      tenantId: gate.tenantId,
      propertyId: gate.propertyId,
      plateCategory: plate.category,
      plateNumber: plate.number,
      ...(plate.province ? { plateProvince: plate.province } : {}),
    };
    const blacklisted = await tx.gateBlacklist.findFirst({
      where: { ...sameRead, revokedAt: null },
      select: { id: true },
    });
    // sequential: one connection per interactive transaction
    const residentCars = await tx.residentVehicle.findMany({ where: { ...sameRead, removedAt: null } });
    const remembered = await tx.rememberedVehicle.findMany({
      where: { ...sameRead, revokedAt: null, expiresAt: { gt: now } },
    });
    const candidates: PlateCandidate[] = [
      ...residentCars.map((v) => ({
        id: v.id,
        unitId: v.unitId,
        source: 'resident_vehicle' as const,
        plate: { category: v.plateCategory, number: v.plateNumber, province: v.plateProvince },
      })),
      ...remembered.map((v) => ({
        id: v.id,
        unitId: v.unitId,
        source: 'remembered_vehicle' as const,
        plate: { category: v.plateCategory, number: v.plateNumber, province: v.plateProvince },
      })),
    ];
    const result = matchPlate(plate, candidates);
    const known = result.match === 'resident_vehicle' || result.match === 'remembered_vehicle';
    // D-336 (J review A6): without a province the read is not sure enough to enter on its own
    const confident = lprAutoEntry(plate, data.confidence >= minConfidence);
    const match = blacklisted ? 'blacklisted' : known && !confident ? 'low_confidence' : result.match;
    const candidate = known ? result.candidate : null;
    const enters = !historical && Boolean(candidate) && confident && !blacklisted;
    let visitId: string | null = null;
    if (enters && candidate) {
      const rememberedRow =
        candidate.source === 'remembered_vehicle' ? remembered.find((r) => r.id === candidate.id)! : null;
      const visitorCar = rememberedRow?.kind === 'visitor';
      const visit = await tx.visit.create({
        data: {
          tenantId: gate.tenantId,
          gateId: gate.id,
          propertyId: gate.propertyId,
          unitId: candidate.unitId,
          kind: visitorCar ? 'guest' : 'resident_vehicle',
          state: 'entered',
          entryBasis: candidate.source === 'resident_vehicle' ? 'resident_vehicle' : 'remembered_vehicle',
          plateCategory: candidate.plate.category,
          plateNumber: candidate.plate.number,
          plateProvince: candidate.plate.province,
          clientRef: eventId,
          enteredAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      visitId = visit.id;
      const actor = { kind: 'device' as const, id: device.id };
      await this.visits.record(tx, visit, 'gate.visit.recorded', 'created', actor, {
        kind: visit.kind,
        entryBasis: visit.entryBasis,
        residentsAsked: 0,
      });
      // the household hears about a remembered visitor's car, not about its own car coming home
      await this.visits.record(tx, visit, 'gate.visit.entered', 'entered', actor, {
        entryBasis: visit.entryBasis,
        notifyResidents: visitorCar,
      });
      await this.audit.record(tx, {
        action: 'gate.visit_recorded',
        tenantId: gate.tenantId,
        subjectType: 'smart.visit',
        subjectId: visit.id,
        metadata: {
          gateId: gate.id,
          unitId: visit.unitId,
          kind: visit.kind,
          state: 'entered',
          entryBasis: visit.entryBasis,
          source: 'lpr',
        },
      });
    }
    const detection = await tx.plateDetection.create({
      data: {
        tenantId: gate.tenantId,
        gateId: gate.id,
        gateDeviceId: device.id,
        eventId,
        plateCategory: plate.category,
        plateNumber: plate.number,
        plateProvince: plate.province,
        confidence: data.confidence.toFixed(3),
        detectedAt: Number.isNaN(detectedAt.getTime()) ? now : detectedAt,
        receivedAt: now,
        imageRef: data.imageRef ?? null,
        state: historical ? 'historical' : enters ? 'matched' : 'pending',
        match,
        unitId: candidate?.unitId ?? null,
        matchedVehicleId: candidate?.id ?? null,
        visitId,
      },
    });
    await this.events.record(tx, {
      type: 'gate.plate_detected',
      aggregateType: 'plate_detection',
      aggregateId: detection.id,
      tenantId: gate.tenantId,
      payload: {
        gateId: gate.id,
        plateDetectionId: detection.id,
        match,
        state: detection.state,
        visitId,
        unitId: detection.unitId,
      },
    });
    if (historical)
      await this.audit.record(tx, {
        action: 'gate.plate_read_late',
        tenantId: gate.tenantId,
        subjectType: 'smart.plate_detection',
        subjectId: detection.id,
        metadata: {
          gateId: gate.id,
          eventId,
          match,
          reason: clockSuspect ? 'clock_suspect' : 'late',
          ageSeconds: Number.isNaN(detectedAt.getTime())
            ? null
            : Math.round((now.getTime() - detectedAt.getTime()) / 1000),
          maxAgeSeconds: maxAge,
          maxSkewSeconds: maxSkew,
        },
      });
    if (
      enters &&
      visitId &&
      (await this.settings.valueAt<boolean>('gate.auto_open_known_plates', now, scope))
    )
      await this.openIn(tx, gate, {
        reason: 'lpr_known_plate',
        visitId,
        by: { kind: 'device', id: device.id },
        soft: true,
      });
  }

  // ------------------------------------------------------------------------------------------------ guard: reads

  /** Plate reads of the gate of the shift: pending (not expired) by default, or every read of the last hour. */
  async guardDetections(view: 'pending' | 'recent'): Promise<DetectionRow[]> {
    const g = guardContext();
    const now = this.now();
    const minutes = await this.settings.valueAt<number>('gate.lpr.pending_minutes', now, {
      tenantId: g.tenantId,
      propertyId: g.propertyId,
    });
    return this.db.tenant(g.ctx, (tx) =>
      tx.plateDetection.findMany({
        where:
          view === 'pending'
            ? {
                gateId: g.gateId,
                state: 'pending',
                receivedAt: { gte: new Date(now.getTime() - minutes * 60_000) },
              }
            : { gateId: g.gateId, receivedAt: { gte: new Date(now.getTime() - 3_600_000) } },
        include: { unit: { select: { id: true, unitNo: true } } },
        orderBy: { receivedAt: 'desc' },
        take: 50,
      }),
    );
  }

  /** Claim (pre-fill the visit form) or dismiss a pending read of this gate; the first guard wins (409 after). */
  async guardDecideDetection(id: string, decision: 'claim' | 'dismiss'): Promise<DetectionRow> {
    const g = guardContext();
    const now = this.now();
    const minutes = await this.settings.valueAt<number>('gate.lpr.pending_minutes', now, {
      tenantId: g.tenantId,
      propertyId: g.propertyId,
    });
    return this.db.tenant(g.ctx, async (tx) => {
      const row = this.found(await tx.plateDetection.findFirst({ where: { id, gateId: g.gateId } }));
      const fresh = row.receivedAt.getTime() >= now.getTime() - minutes * 60_000;
      const moved = await tx.plateDetection.updateMany({
        where: { id: row.id, state: 'pending' },
        data:
          decision === 'claim'
            ? { state: fresh ? 'claimed' : 'expired', claimedAt: now, claimedBy: g.userId }
            : { state: 'dismissed', claimedAt: now, claimedBy: g.userId },
      });
      if (moved.count !== 1 || (decision === 'claim' && !fresh))
        throw new DomainException('plate_detection.invalid_state');
      await this.audit.record(tx, {
        action: decision === 'claim' ? 'gate.plate_claimed' : 'gate.plate_dismissed',
        tenantId: g.tenantId,
        subjectType: 'smart.plate_detection',
        subjectId: row.id,
        metadata: { gateId: g.gateId },
      });
      await this.events.record(tx, {
        type: 'gate.plate_detection.changed',
        aggregateType: 'plate_detection',
        aggregateId: row.id,
        tenantId: g.tenantId,
        payload: {
          gateId: g.gateId,
          plateDetectionId: row.id,
          state: decision === 'claim' ? 'claimed' : 'dismissed',
        },
      });
      return tx.plateDetection.findUniqueOrThrow({
        where: { id: row.id },
        include: { unit: { select: { id: true, unitNo: true } } },
      });
    });
  }

  /** Barrier / LPR state of the gate of the shift (tablet header). */
  async guardHardware() {
    const g = guardContext();
    return this.db.tenant(g.ctx, (tx) =>
      tx.gateDevice.findMany({
        where: { gateId: g.gateId, state: 'active', kind: { in: ['barrier', 'lpr'] } },
        select: { id: true, kind: true, name: true, hwState: true, hwStateAt: true, lastSeenAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** Job `gate-visits`: pending plate reads older than `gate.lpr.pending_minutes` expire. */
  async expireDetections(limit = 500): Promise<number> {
    return RequestContext.run({ actor: systemActor('gate-visits') }, async () => {
      const now = this.now();
      const rows = await this.db.platform((tx) =>
        tx.plateDetection.findMany({
          where: { state: 'pending', receivedAt: { lt: new Date(now.getTime() - 60_000) } },
          select: { id: true, tenantId: true, receivedAt: true, gate: { select: { propertyId: true } } },
          take: limit,
        }),
      );
      let expired = 0;
      for (const r of rows) {
        const minutes = await this.settings.valueAt<number>('gate.lpr.pending_minutes', now, {
          tenantId: r.tenantId,
          propertyId: r.gate.propertyId,
        });
        if (r.receivedAt.getTime() >= now.getTime() - minutes * 60_000) continue;
        const moved = await this.db.platform((tx) =>
          tx.plateDetection.updateMany({ where: { id: r.id, state: 'pending' }, data: { state: 'expired' } }),
        );
        expired += moved.count;
      }
      return expired;
    });
  }

  // ------------------------------------------------------------------------------------------------ resident cars

  private async unitFor(unitId: string, roles: readonly string[]) {
    const userId = residentUserId();
    return this.db.platform(async (tx) => {
      const mine = (await residentUnitRoles(tx, userId, bangkokDate(this.now()))).filter(
        (r) => r.unitId === unitId && roles.includes(r.role),
      );
      if (!mine.length) throw new DomainException('http.not_found');
      const unit = this.found(await tx.unit.findUnique({ where: { id: unitId } }));
      return { userId, unit, ctx: systemTenantContext(unit.tenantId) };
    });
  }

  async residentVehicles(unitId: string): Promise<ResidentVehicle[]> {
    const { unit, ctx } = await this.unitFor(unitId, GATE_UNIT_ROLES);
    return this.db.tenant(ctx, (tx) =>
      tx.residentVehicle.findMany({
        where: { unitId: unit.id, removedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** The household (co-owner, tenant, co-tenant) registers one of its cars (409 when already registered). */
  async addResidentVehicle(unitId: string, input: { plate: PlateInput; label?: string | null }) {
    const { userId, unit, ctx } = await this.unitFor(unitId, HOUSEHOLD_DECIDERS);
    const plate = normalisePlate(input.plate);
    if (!plate) throw invalid('plate', 'required', 'the full plate');
    const label = input.label?.trim() || null;
    if (label && label.length > 80) throw invalid('label', 'maxLength', 'at most 80 characters');
    try {
      return await this.db.tenant(ctx, async (tx) => {
        const now = this.now();
        const row = await tx.residentVehicle.create({
          data: {
            tenantId: unit.tenantId,
            propertyId: unit.propertyId,
            unitId: unit.id,
            plateCategory: plate.category,
            plateNumber: plate.number,
            plateProvince: plate.province,
            label,
            registeredByUserId: userId,
            createdAt: now,
            updatedAt: now,
          },
        });
        await this.audit.record(tx, {
          action: 'gate.resident_vehicle_added',
          tenantId: unit.tenantId,
          subjectType: 'smart.resident_vehicle',
          subjectId: row.id,
          metadata: { unitId: unit.id },
        });
        await this.events.record(tx, {
          type: 'gate.resident_vehicle.changed',
          aggregateType: 'resident_vehicle',
          aggregateId: row.id,
          tenantId: unit.tenantId,
          payload: { residentVehicleId: row.id, unitId: unit.id, removed: false },
        });
        return row;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new DomainException('http.conflict');
      throw error;
    }
  }

  async removeResidentVehicle(unitId: string, vehicleId: string): Promise<void> {
    const { userId, unit, ctx } = await this.unitFor(unitId, HOUSEHOLD_DECIDERS);
    await this.db.tenant(ctx, async (tx) => {
      const row = this.found(
        await tx.residentVehicle.findFirst({ where: { id: vehicleId, unitId: unit.id } }),
      );
      if (row.removedAt) return;
      await this.removeVehicleIn(tx, row, userId, 'removed_by_household');
    });
  }

  async removeVehicleIn(tx: Tx, row: ResidentVehicle, by: string | null, reason: string): Promise<void> {
    const now = this.now();
    await tx.residentVehicle.update({
      where: { id: row.id },
      data: { removedAt: now, removedBy: by, removeReason: reason, updatedAt: now },
    });
    await this.audit.record(tx, {
      action: 'gate.resident_vehicle_removed',
      tenantId: row.tenantId,
      subjectType: 'smart.resident_vehicle',
      subjectId: row.id,
      metadata: { unitId: row.unitId, reason },
    });
    await this.events.record(tx, {
      type: 'gate.resident_vehicle.changed',
      aggregateType: 'resident_vehicle',
      aggregateId: row.id,
      tenantId: row.tenantId,
      payload: { residentVehicleId: row.id, unitId: row.unitId, removed: true },
    });
  }

  /** Owner `GET /v1/owner/gate-vehicles`: registered cars of the tenant's units (gate.read). */
  ownerVehicles(ctx: TenantContext, filter: { unitId?: string; propertyId?: string }) {
    return this.db.tenant(ctx, (tx) =>
      tx.residentVehicle.findMany({
        where: {
          tenantId: ctx.tenantId,
          removedAt: null,
          ...(filter.unitId ? { unitId: filter.unitId } : {}),
          ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
        },
        orderBy: [{ unitId: 'asc' }, { createdAt: 'asc' }],
        take: 500,
      }),
    );
  }
}

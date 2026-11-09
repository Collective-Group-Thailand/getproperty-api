import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { isUuid } from '@common/ids/uuidv7';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { residentUnitRoles } from '@core/identity/resident-units';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type GatePolicyAction,
  type Prisma,
  type Visit,
  type VisitActorKind,
  type VisitEntryBasis,
  type VisitEventKind,
  type VisitKind,
} from '@generated/prisma/client';
import { residentUserId } from '@modules/ops-juristic/resident-unit-access';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { unitResidentUserIds } from './gate-residents';
import {
  CANCELLABLE,
  checkIdLast4,
  deliverySkipsApproval,
  effectivePolicy,
  entryAllowed,
  type HousePolicy,
  inviteTokenHash,
  normalisePlate,
  type Plate,
  type PlateInput,
  type PolicyActionName,
  samePlate,
} from './gate-rules';

const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/** Roles of a unit whose people the gate asks and who may read and answer the unit's visits (not payer-only). */
export const GATE_UNIT_ROLES = ['co_owner', 'tenant', 'co_tenant', 'family'] as const;
/** Roles that may set the house policy and create invites (they decide who comes to the house). */
export const HOUSEHOLD_DECIDERS = ['co_owner', 'tenant', 'co_tenant'] as const;

const MAX_PHOTO_BYTES = 2_000_000;
const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];
/** Clock skew a tablet may have when it says when it recorded an offline visit. */
const FUTURE_SKEW_MS = 5 * 60_000;

/** The guard's shift, from the token's scopes (J4.1). */
export interface GuardContext {
  tenantId: string;
  propertyId: string;
  gateId: string;
  gateDeviceId: string;
  shiftId: string;
  userId: string;
  ctx: TenantContext;
}

export function guardContext(): GuardContext {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user' || actor.audience !== 'guard') throw new DomainException('auth.unauthenticated');
  const scope = (p: string) => actor.scopes.find((s) => s.startsWith(`${p}:`))?.slice(p.length + 1);
  const tenantId = scope('tenant');
  const propertyId = scope('property');
  const gateId = scope('gate');
  const gateDeviceId = scope('gate_device');
  const shiftId = scope('shift');
  if (!tenantId || !propertyId || !gateId || !gateDeviceId || !shiftId)
    throw new DomainException('auth.unauthenticated');
  return {
    tenantId,
    propertyId,
    gateId,
    gateDeviceId,
    shiftId,
    userId: actor.publicId,
    ctx: { tenantId, source: 'token', role: 'guard', buildingIds: null },
  };
}

export interface CreateVisitInput {
  clientRef: string;
  kind: VisitKind;
  unitId?: string | null;
  plate?: PlateInput | null;
  visitorName?: string | null;
  idLast4?: string | null;
  note?: string | null;
  recordedAt?: string | null;
  enteredOffline?: boolean;
}

export type VisitRow = Visit & {
  unit: { id: string; unitNo: string; buildingId: string } | null;
  gate: { id: string; name: string };
};

export interface VisitActor {
  kind: VisitActorKind;
  id: string | null;
}

const VISIT_INCLUDE = {
  unit: { select: { id: true, unitNo: true, buildingId: true } },
  gate: { select: { id: true, name: true } },
} as const;

/**
 * Visits at the gate (J4.1, D-315, D-327): the guard records a visit, the residents of the destination unit are asked
 * (first answer wins), the house policy applies when nobody answers in time, the guard stamps entry and exit. Invites,
 * remembered cars and the delivery drop point let visitors in at once (notify-only); the blacklist refuses a plate.
 * Every change is one transaction with its audit row, its domain event and its `smart.visit_event` (same id).
 */
@Injectable()
export class VisitsService {
  private readonly logger = new Logger(VisitsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private now(): Date {
    return this.clock.now();
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** Domain event + visit event with the same id (the gate stream's Last-Event-ID) — one call per change. */
  async record(
    tx: Tx,
    visit: Pick<Visit, 'id' | 'tenantId' | 'gateId' | 'unitId' | 'state'>,
    type: DomainEventType,
    kind: VisitEventKind,
    actor: VisitActor,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const envelope = await this.events.record(tx, {
      type,
      aggregateType: 'visit',
      aggregateId: visit.id,
      tenantId: visit.tenantId,
      payload: {
        visitId: visit.id,
        gateId: visit.gateId,
        unitId: visit.unitId,
        state: visit.state,
        ...payload,
      },
    });
    await tx.visitEvent.create({
      data: {
        id: envelope.id,
        tenantId: visit.tenantId,
        gateId: visit.gateId,
        visitId: visit.id,
        kind,
        actorKind: actor.kind,
        actorId: actor.id,
        payload: payload as Prisma.InputJsonValue,
        occurredAt: new Date(envelope.occurredAt),
      },
    });
    return envelope.id;
  }

  async policyOf(
    tx: Tx,
    tenantId: string,
    propertyId: string,
    unitId: string | null,
  ): Promise<HousePolicy & { custom: boolean }> {
    const now = this.now();
    const scope = { tenantId, propertyId };
    const defaults = {
      timeoutSeconds: await this.settings.valueAt<number>('gate.policy.timeout_seconds', now, scope),
      action: await this.settings.valueAt<PolicyActionName>('gate.policy.action', now, scope),
    };
    const row = unitId ? await tx.houseGatePolicy.findUnique({ where: { unitId } }) : null;
    return effectivePolicy(row, defaults);
  }

  private async lockVisit(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM smart.visit WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private async guardVisit(tx: Tx, g: GuardContext, id: string): Promise<VisitRow> {
    const v = await tx.visit.findFirst({
      where: { id, tenantId: g.tenantId, propertyId: g.propertyId },
      include: VISIT_INCLUDE,
    });
    if (!v) throw new DomainException('http.not_found');
    return v;
  }

  private async blacklisted(tx: Tx, tenantId: string, propertyId: string, plate: Plate | null) {
    if (!plate) return null;
    return tx.gateBlacklist.findFirst({
      where: {
        tenantId,
        propertyId,
        plateCategory: plate.category,
        plateNumber: plate.number,
        plateProvince: plate.province,
        revokedAt: null,
      },
      select: { id: true },
    });
  }

  private async remembered(tx: Tx, unitId: string | null, plate: Plate | null) {
    if (!unitId || !plate) return null;
    return tx.rememberedVehicle.findFirst({
      where: {
        unitId,
        plateCategory: plate.category,
        plateNumber: plate.number,
        plateProvince: plate.province,
        revokedAt: null,
        expiresAt: { gt: this.now() },
      },
      select: { id: true, kind: true },
    });
  }

  // ------------------------------------------------------------------------------------------------ guard

  /**
   * `POST /v1/guard/visits`. A replay with the same `clientRef` (offline queue) returns the existing visit — never a
   * duplicate (`replayed: true`). The outcome is decided here: blacklisted → denied; offline entry → entered; a
   * remembered car or a delivery to an estate with a drop point → entered (notify-only); a unit nobody can be asked →
   * the house policy at once; otherwise requested with the house timeout and every resident of the unit asked.
   */
  async create(input: CreateVisitInput): Promise<{ visit: VisitRow; replayed: boolean }> {
    const g = guardContext();
    if (!isUuid(input.clientRef)) throw invalid('clientRef', 'isUuid', 'a uuid generated by the tablet');
    const existing = await this.db.tenant(g.ctx, (tx) =>
      tx.visit.findFirst({ where: { gateId: g.gateId, clientRef: input.clientRef }, include: VISIT_INCLUDE }),
    );
    if (existing) return { visit: existing, replayed: true };
    const plate = normalisePlate(input.plate);
    const idLast4 = checkIdLast4(input.idLast4);
    const visitorName = input.visitorName?.trim() || null;
    if (visitorName && visitorName.length > 120)
      throw invalid('visitorName', 'maxLength', 'at most 120 characters');
    const note = input.note?.trim() || null;
    if (note && note.length > 500) throw invalid('note', 'maxLength', 'at most 500 characters');
    if (!input.unitId && input.kind !== 'other') throw invalid('unitId', 'required', 'the destination unit');
    const now = this.now();
    let recordedAt: Date | null = null;
    if (input.recordedAt) {
      recordedAt = new Date(input.recordedAt);
      if (Number.isNaN(recordedAt.getTime())) throw invalid('recordedAt', 'isDate', 'an ISO 8601 instant');
      const maxHours = await this.settings.valueAt<number>('gate.offline_max_hours', now, {
        tenantId: g.tenantId,
      });
      if (recordedAt.getTime() > now.getTime() + FUTURE_SKEW_MS)
        throw invalid('recordedAt', 'future', 'not in the future');
      if (recordedAt.getTime() < now.getTime() - maxHours * 3_600_000)
        throw new DomainException('visit.offline_too_old', { params: { hours: maxHours } });
    }
    if (input.enteredOffline && !recordedAt)
      throw invalid('recordedAt', 'required', 'when the entry was recorded');
    const today = bangkokDate(now);
    // the people to ask (identity lookup as gp_platform)
    const residents = input.unitId
      ? await this.db.platform((tx) => unitResidentUserIds(tx, input.unitId!, today))
      : [];
    try {
      const visit = await this.db.tenant(g.ctx, async (tx) => {
        const gate = await tx.gate.findFirst({ where: { id: g.gateId, tenantId: g.tenantId } });
        if (!gate || gate.state !== 'active') throw new DomainException('gate.inactive');
        if (input.unitId) {
          const unit = await tx.unit.findFirst({
            where: { id: input.unitId, propertyId: g.propertyId, deletedAt: null },
            select: { id: true },
          });
          if (!unit) throw new DomainException('http.not_found');
        }
        const policy = await this.policyOf(tx, g.tenantId, g.propertyId, input.unitId ?? null);
        const scope = { tenantId: g.tenantId, propertyId: g.propertyId };
        const blocked = await this.blacklisted(tx, g.tenantId, g.propertyId, plate);
        const car = blocked ? null : await this.remembered(tx, input.unitId ?? null, plate);
        const dropPoint =
          input.kind === 'delivery' &&
          deliverySkipsApproval(
            policy,
            await this.settings.valueAt<boolean>('gate.delivery_drop_point', now, scope),
          );
        let state: Visit['state'] = 'requested';
        let entryBasis: VisitEntryBasis | null = null;
        let decisionReason: string | null = null;
        let respondBy: Date | null = null;
        let timeoutAction: GatePolicyAction | null = null;
        if (blocked) {
          state = 'denied';
          decisionReason = 'blacklisted';
        } else if (input.enteredOffline) {
          state = 'entered';
          entryBasis = 'offline';
        } else if (car) {
          state = 'entered';
          entryBasis = 'remembered_vehicle';
        } else if (dropPoint) {
          state = 'entered';
          entryBasis = 'delivery_drop_point';
        } else if (!input.unitId) {
          // no house to ask: the guard decides (enter or cancel)
          state = 'approved';
          decisionReason = 'no_destination';
        } else if (!residents.length) {
          // D-315: never wait for a house nobody can be asked about — its policy applies at once
          state = 'timed_out';
          timeoutAction = policy.action;
          decisionReason = 'nobody_reachable';
          respondBy = now;
        } else {
          respondBy = new Date(now.getTime() + policy.timeoutSeconds * 1000);
          timeoutAction = policy.action;
        }
        const enteredAt = state === 'entered' ? (input.enteredOffline ? recordedAt! : now) : null;
        const created = await tx.visit.create({
          data: {
            tenantId: g.tenantId,
            gateId: g.gateId,
            propertyId: g.propertyId,
            unitId: input.unitId ?? null,
            kind: input.kind,
            state,
            entryBasis,
            plateCategory: plate?.category ?? null,
            plateNumber: plate?.number ?? null,
            plateProvince: plate?.province ?? null,
            visitorName,
            idLast4,
            clientRef: input.clientRef,
            note,
            recordedAt,
            respondBy,
            timeoutAction,
            decidedAt: state === 'requested' || state === 'entered' ? null : now,
            decisionReason,
            enteredAt,
            shiftId: g.shiftId,
            createdBy: g.userId,
            createdAt: now,
            updatedAt: now,
          },
          include: VISIT_INCLUDE,
        });
        const guard: VisitActor = { kind: 'guard', id: g.userId };
        await this.record(
          tx,
          created,
          state === 'requested' ? 'gate.visit.requested' : 'gate.visit.recorded',
          'created',
          guard,
          {
            kind: created.kind,
            residentsAsked: state === 'requested' ? residents.length : 0,
            ...(entryBasis ? { entryBasis } : {}),
            ...(decisionReason ? { reason: decisionReason } : {}),
            ...(car ? { rememberedVehicleId: car.id } : {}),
          },
        );
        if (state === 'timed_out')
          await this.record(
            tx,
            created,
            'gate.visit.timed_out',
            'policy_applied',
            { kind: 'system', id: null },
            {
              action: timeoutAction,
              reason: decisionReason,
            },
          );
        if (state === 'entered')
          await this.record(tx, created, 'gate.visit.entered', 'entered', guard, {
            entryBasis,
            notifyResidents: true,
          });
        await this.audit.record(tx, {
          action: 'gate.visit_recorded',
          tenantId: g.tenantId,
          subjectType: 'smart.visit',
          subjectId: created.id,
          metadata: { gateId: g.gateId, unitId: created.unitId, kind: created.kind, state, entryBasis },
        });
        return created;
      });
      return { visit, replayed: false };
    } catch (error) {
      // two replays of the same offline record racing: the unique (gate, client_ref) keeps one — answer it
      if ((error as { code?: string }).code === 'P2002') {
        const again = await this.db.tenant(g.ctx, (tx) =>
          tx.visit.findFirst({
            where: { gateId: g.gateId, clientRef: input.clientRef },
            include: VISIT_INCLUDE,
          }),
        );
        if (again) return { visit: again, replayed: true };
      }
      throw error;
    }
  }

  /** A 5-minute link to a visit photo of the tenant (null once deleted). */
  async photoLink(ctx: TenantContext, documentId: string | null): Promise<string | null> {
    if (!documentId) return null;
    const doc = await this.db.tenant(ctx, (tx) =>
      tx.document.findFirst({ where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null } }),
    );
    return doc ? (await this.documents.signedUrl(doc)).url : null;
  }

  /** `GET /v1/guard/me`: the shift, the guard, the gate and its property. */
  async guardMe() {
    const g = guardContext();
    return this.db.tenant(g.ctx, async (tx) => {
      const shift = await tx.guardShift.findFirst({
        where: { id: g.shiftId, tenantId: g.tenantId },
        include: { guard: true, gate: { include: { property: true } }, gateDevice: true },
      });
      if (!shift) throw new DomainException('http.not_found');
      return shift;
    });
  }

  /** The privacy notice shown next to the visitor fields (`gate.privacy_notice`, PDPA D-025). */
  async privacyNotice(
    tenantId: string,
  ): Promise<{ version: number; th: string; en: string; retentionDays: number }> {
    const now = this.now();
    const notice = await this.settings.valueAt<{ version: number; th: string; en: string }>(
      'gate.privacy_notice',
      now,
      {
        tenantId,
      },
    );
    return {
      version: notice.version,
      th: notice.th,
      en: notice.en,
      retentionDays: await this.settings.valueAt<number>('gate.retention_days', now, { tenantId }),
    };
  }

  /**
   * `GET /v1/guard/units?q=`: the unit picker — unit number, building, whether anyone of the house can be asked in
   * LINE (no names), the house policy. `hasArrears` exists only while `gate.show_arrears` is on (⚖ O-038; off).
   */
  async guardUnits(q: string | undefined, limit: number) {
    const g = guardContext();
    const now = this.now();
    const showArrears = await this.settings.valueAt<boolean>('gate.show_arrears', now, {
      tenantId: g.tenantId,
    });
    const text = q?.trim();
    const units = await this.db.tenant(g.ctx, (tx) =>
      tx.unit.findMany({
        where: {
          propertyId: g.propertyId,
          deletedAt: null,
          // J-CR (D-335): the house number or the soi / building name
          ...(text
            ? {
                OR: [
                  { unitNo: { contains: text, mode: 'insensitive' as const } },
                  { building: { name: { contains: text, mode: 'insensitive' as const } } },
                ],
              }
            : {}),
        },
        select: { id: true, unitNo: true, buildingId: true, building: { select: { name: true } } },
        orderBy: [{ unitNo: 'asc' }],
        take: limit,
      }),
    );
    const today = bangkokDate(now);
    const reach = await this.db.platform(async (tx) => {
      const out = new Map<string, number>();
      for (const u of units) {
        const ids = await unitResidentUserIds(tx, u.id, today);
        const withLine = ids.length
          ? await tx.userAccount.count({ where: { id: { in: ids }, lineUserId: { not: null } } })
          : 0;
        out.set(u.id, withLine);
      }
      return out;
    });
    const arrears = showArrears
      ? await this.db.tenant(g.ctx, async (tx) => {
          const rows = await tx.receivableBalance.groupBy({
            by: ['unitId'],
            where: { unitId: { in: units.map((u) => u.id) }, balance: { gt: 0 } },
            _count: { _all: true },
          });
          return new Set(rows.map((r) => r.unitId));
        })
      : null;
    return this.db.tenant(g.ctx, async (tx) => {
      const out = [];
      for (const u of units)
        out.push({
          unitId: u.id,
          unitNo: u.unitNo,
          buildingId: u.buildingId,
          buildingName: u.building.name,
          lineLinked: (reach.get(u.id) ?? 0) > 0,
          policy: await this.policyOf(tx, g.tenantId, g.propertyId, u.id),
          ...(arrears ? { hasArrears: arrears.has(u.id) } : {}),
        });
      return out;
    });
  }

  async guardGet(id: string) {
    const g = guardContext();
    return this.db.tenant(g.ctx, async (tx) => {
      const v = await this.guardVisit(tx, g, id);
      const events = await tx.visitEvent.findMany({
        where: { visitId: id },
        orderBy: { id: 'asc' },
        select: { id: true, kind: true, actorKind: true, occurredAt: true, payload: true },
      });
      return { ...v, events };
    });
  }

  /** `gate.tablet.auto_lock_minutes` of the property (J-CR, D-335). */
  async autoLockMinutes(tenantId: string, propertyId: string): Promise<number> {
    return (
      (await this.settings.valueAt<number>('gate.tablet.auto_lock_minutes', this.now(), {
        tenantId,
        propertyId,
      })) ?? 5
    );
  }

  /**
   * Display names of the residents who decided or asked to be called on these visits (J-CR): user id → name, read
   * through the platform role (logins are not tenant rows). The gate shows first names only (D-315).
   */
  async userNames(
    visits: readonly { decidedByUserId: string | null; callMeUserId: string | null }[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(visits.flatMap((v) => [v.decidedByUserId, v.callMeUserId]).filter((x): x is string => !!x)),
    ];
    if (!ids.length) return new Map();
    const rows = await this.db.platform((p) =>
      p.userAccount.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
    );
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }

  /** The gate's lists: `waiting` (requested / approved / timed out), `inside` (entered), `today` (all of the day). */
  async guardList(view: 'waiting' | 'inside' | 'today', limit: number): Promise<VisitRow[]> {
    const g = guardContext();
    const now = this.now();
    const startOfDay = new Date(`${bangkokDate(now)}T00:00:00+07:00`);
    const where: Prisma.VisitWhereInput =
      view === 'waiting'
        ? {
            state: { in: ['requested', 'approved', 'timed_out'] },
            createdAt: { gte: new Date(now.getTime() - 86_400_000) },
          }
        : view === 'inside'
          ? { state: 'entered' }
          : { createdAt: { gte: startOfDay } };
    return this.db.tenant(g.ctx, (tx) =>
      tx.visit.findMany({
        where: { tenantId: g.tenantId, gateId: g.gateId, ...where },
        include: VISIT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    );
  }

  /** `POST …/actions/enter`: approved / timed out (not deny) — or a guard override with a reason (D-315). */
  async enter(id: string, reason: string | null): Promise<VisitRow> {
    const g = guardContext();
    const text = reason?.trim() || null;
    if (text && (text.length < 3 || text.length > 500)) throw invalid('reason', 'length', '3–500 characters');
    return this.db.tenant(g.ctx, async (tx) => {
      await this.guardVisit(tx, g, id);
      await this.lockVisit(tx, id);
      const v = await tx.visit.findUniqueOrThrow({ where: { id } });
      if (v.state === 'entered') return this.guardVisit(tx, g, id);
      const allowed = entryAllowed(v.state, v.timeoutAction, text);
      if (!allowed.ok) throw new DomainException(allowed.code as 'visit.denied');
      const basis: VisitEntryBasis = allowed.override
        ? 'guard_override'
        : v.state === 'timed_out'
          ? 'policy'
          : (v.entryBasis ?? 'approval');
      const now = this.now();
      const updated = await tx.visit.update({
        where: { id },
        data: {
          state: 'entered',
          entryBasis: basis,
          enteredAt: now,
          ...(allowed.override ? { decidedAt: now, decisionReason: text } : {}),
          version: { increment: 1 },
        },
      });
      await this.record(
        tx,
        updated,
        'gate.visit.entered',
        'entered',
        { kind: 'guard', id: g.userId },
        {
          entryBasis: basis,
          notifyResidents: basis !== 'approval',
          ...(allowed.override ? { override: true } : {}),
        },
      );
      await this.audit.record(tx, {
        action: 'gate.visit_entered',
        tenantId: g.tenantId,
        subjectType: 'smart.visit',
        subjectId: id,
        metadata: { entryBasis: basis, ...(allowed.override ? { overrideReason: text } : {}) },
      });
      return this.guardVisit(tx, g, id);
    });
  }

  async guardExit(id: string): Promise<VisitRow> {
    const g = guardContext();
    return this.db.tenant(g.ctx, async (tx) => {
      await this.guardVisit(tx, g, id);
      return this.exitIn(tx, id, { kind: 'guard', id: g.userId }, () => this.guardVisit(tx, g, id));
    });
  }

  private async exitIn(
    tx: Tx,
    id: string,
    actor: VisitActor,
    reload: () => Promise<VisitRow>,
  ): Promise<VisitRow> {
    await this.lockVisit(tx, id);
    const v = await tx.visit.findUniqueOrThrow({ where: { id } });
    if (v.state === 'exited') return reload();
    if (v.state !== 'entered')
      throw new DomainException('visit.invalid_state', { params: { state: v.state } });
    const updated = await tx.visit.update({
      where: { id },
      data: { state: 'exited', exitedAt: this.now(), exitedBy: actor.kind, version: { increment: 1 } },
    });
    await this.record(tx, updated, 'gate.visit.exited', 'exited', actor);
    await this.audit.record(tx, {
      action: 'gate.visit_exited',
      tenantId: v.tenantId,
      subjectType: 'smart.visit',
      subjectId: id,
      metadata: { by: actor.kind },
    });
    return reload();
  }

  async cancel(id: string, reason: string | null): Promise<VisitRow> {
    const g = guardContext();
    const text = reason?.trim() || null;
    if (text && text.length > 500) throw invalid('reason', 'maxLength', 'at most 500 characters');
    return this.db.tenant(g.ctx, async (tx) => {
      await this.guardVisit(tx, g, id);
      await this.lockVisit(tx, id);
      const v = await tx.visit.findUniqueOrThrow({ where: { id } });
      if (v.state === 'cancelled') return this.guardVisit(tx, g, id);
      if (!CANCELLABLE.includes(v.state))
        throw new DomainException('visit.invalid_state', { params: { state: v.state } });
      const updated = await tx.visit.update({
        where: { id },
        data: { state: 'cancelled', cancelledAt: this.now(), cancelReason: text, version: { increment: 1 } },
      });
      await this.record(tx, updated, 'gate.visit.cancelled', 'cancelled', { kind: 'guard', id: g.userId });
      await this.audit.record(tx, {
        action: 'gate.visit_cancelled',
        tenantId: g.tenantId,
        subjectType: 'smart.visit',
        subjectId: id,
        metadata: {},
      });
      return this.guardVisit(tx, g, id);
    });
  }

  /** `POST …/photo`: one photo per visit (a new one replaces it; the old object is deleted). */
  async addPhoto(id: string, contentBase64: string, mimeType: string): Promise<VisitRow> {
    const g = guardContext();
    if (!PHOTO_MIME.includes(mimeType)) throw invalid('mimeType', 'isIn', PHOTO_MIME.join(', '));
    const body = Buffer.from(contentBase64, 'base64');
    if (!body.length || body.length > MAX_PHOTO_BYTES)
      throw invalid('contentBase64', 'size', `1 byte – ${MAX_PHOTO_BYTES} bytes decoded`);
    const v0 = await this.db.tenant(g.ctx, (tx) => this.guardVisit(tx, g, id));
    if (v0.state === 'exited' || v0.state === 'cancelled')
      throw new DomainException('visit.invalid_state', { params: { state: v0.state } });
    const uploaded = await this.documents.uploadGenerated({
      tenantId: g.tenantId,
      kind: 'other',
      scopeType: 'property',
      scopeId: g.propertyId,
      buildingId: v0.unit?.buildingId ?? null,
      title: 'visit photo',
      mimeType,
      body,
      retentionClass: 'visitor',
    });
    const stale: string[] = [];
    const out = await this.db.tenant(g.ctx, async (tx) => {
      await this.lockVisit(tx, id);
      const v = await tx.visit.findUniqueOrThrow({ where: { id }, include: { photoDocument: true } });
      const doc = await this.documents.recordGenerated(tx, uploaded);
      await tx.visit.update({ where: { id }, data: { photoDocumentId: doc.id, version: { increment: 1 } } });
      if (v.photoDocument)
        stale.push(
          ...(await this.documents.purgeStored(tx, v.photoDocument, { at: this.now(), reason: 'replaced' })),
        );
      await this.record(
        tx,
        v,
        'gate.visit.photo_added',
        'photo_added',
        { kind: 'guard', id: g.userId },
        {
          documentId: doc.id,
        },
      );
      await this.audit.record(tx, {
        action: 'gate.visit_photo_added',
        tenantId: g.tenantId,
        subjectType: 'smart.visit',
        subjectId: id,
        metadata: { documentId: doc.id },
      });
      return this.guardVisit(tx, g, id);
    });
    await this.documents.deleteObjects(stale);
    return out;
  }

  /**
   * `POST /v1/guard/invites/actions/scan`: a valid invite of this estate → a visit `entered` at once (uses counted
   * atomically under a row lock). Unknown token or another estate's invite → 404.
   */
  async scanInvite(input: {
    token: string;
    clientRef: string;
    plate?: PlateInput | null;
  }): Promise<{ visit: VisitRow; replayed: boolean }> {
    const g = guardContext();
    if (!isUuid(input.clientRef)) throw invalid('clientRef', 'isUuid', 'a uuid generated by the tablet');
    const existing = await this.db.tenant(g.ctx, (tx) =>
      tx.visit.findFirst({ where: { gateId: g.gateId, clientRef: input.clientRef }, include: VISIT_INCLUDE }),
    );
    if (existing) return { visit: existing, replayed: true };
    const plate = normalisePlate(input.plate);
    const hash = inviteTokenHash(input.token);
    const now = this.now();
    const visit = await this.db.tenant(g.ctx, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM smart.visit_invite WHERE token_hash = ${hash} AND tenant_id = ${g.tenantId}::uuid
           AND property_id = ${g.propertyId}::uuid FOR UPDATE`;
      if (!rows[0]) throw new DomainException('http.not_found');
      const inv = await tx.visitInvite.findUniqueOrThrow({ where: { id: rows[0].id } });
      if (inv.state !== 'active')
        throw new DomainException('visit_invite.not_active', { params: { state: inv.state } });
      if (inv.validFrom > now || inv.validTo <= now) throw new DomainException('visit_invite.outside_window');
      if (inv.uses >= inv.maxUses) throw new DomainException('visit_invite.used_up');
      const invitePlate = inv.plateNumber
        ? { category: inv.plateCategory!, number: inv.plateNumber, province: inv.plateProvince! }
        : null;
      if (invitePlate && plate && !samePlate(invitePlate, plate))
        throw new DomainException('visit_invite.plate_mismatch');
      const usePlate = plate ?? invitePlate;
      if (await this.blacklisted(tx, g.tenantId, g.propertyId, usePlate))
        throw new DomainException('visit.denied');
      await tx.visitInvite.update({
        where: { id: inv.id },
        data: { uses: { increment: 1 }, version: { increment: 1 } },
      });
      const created = await tx.visit.create({
        data: {
          tenantId: g.tenantId,
          gateId: g.gateId,
          propertyId: g.propertyId,
          unitId: inv.unitId,
          kind: inv.visitorKind,
          state: 'entered',
          entryBasis: 'invite',
          plateCategory: usePlate?.category ?? null,
          plateNumber: usePlate?.number ?? null,
          plateProvince: usePlate?.province ?? null,
          visitorName: inv.visitorName,
          inviteId: inv.id,
          clientRef: input.clientRef,
          enteredAt: now,
          shiftId: g.shiftId,
          createdBy: g.userId,
          createdAt: now,
          updatedAt: now,
        },
        include: VISIT_INCLUDE,
      });
      const guard: VisitActor = { kind: 'guard', id: g.userId };
      await this.record(tx, created, 'gate.visit.recorded', 'created', guard, {
        kind: created.kind,
        entryBasis: 'invite',
        inviteId: inv.id,
      });
      await this.record(tx, created, 'gate.visit.entered', 'entered', guard, {
        entryBasis: 'invite',
        notifyResidents: true,
      });
      await this.audit.record(tx, {
        action: 'gate.invite_used',
        tenantId: g.tenantId,
        subjectType: 'smart.visit_invite',
        subjectId: inv.id,
        metadata: { visitId: created.id, uses: inv.uses + 1, maxUses: inv.maxUses },
      });
      return created;
    });
    return { visit, replayed: false };
  }

  /** `GET /v1/guard/visits/changes` and the SSE replay: the gate's visit events after `after` (last 24 h, ≤ 500). */
  async changes(after: string | null, limit = 500) {
    const g = guardContext();
    return this.changesOf(g, after, limit);
  }

  async changesOf(g: Pick<GuardContext, 'ctx' | 'gateId'>, after: string | null, limit = 500) {
    if (after && !isUuid(after)) throw invalid('after', 'isUuid', 'a visit event id');
    const since = new Date(this.now().getTime() - 86_400_000);
    return this.db.tenant(g.ctx, (tx) =>
      tx.visitEvent.findMany({
        where: { gateId: g.gateId, occurredAt: { gte: since }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true, visitId: true, kind: true, occurredAt: true },
      }),
    );
  }

  // ------------------------------------------------------------------------------------------------ resident

  /** The visit of a unit the signed-in resident holds a gate role on today; anything else is a 404. */
  private async residentVisit(id: string): Promise<{ visit: Visit; userId: string; ctx: TenantContext }> {
    const userId = residentUserId();
    const today = bangkokDate(this.now());
    return this.db.platform(async (tx) => {
      const visit = await tx.visit.findUnique({ where: { id } });
      if (!visit?.unitId) throw new DomainException('http.not_found');
      const roles = await residentUnitRoles(tx, userId, today);
      if (
        !roles.some(
          (r) => r.unitId === visit.unitId && (GATE_UNIT_ROLES as readonly string[]).includes(r.role),
        )
      )
        throw new DomainException('http.not_found');
      return { visit, userId, ctx: { tenantId: visit.tenantId, source: 'path' } };
    });
  }

  /** Units the resident holds a gate role on today. */
  async residentUnits(): Promise<string[]> {
    const userId = residentUserId();
    const today = bangkokDate(this.now());
    const roles = await this.db.platform((tx) => residentUnitRoles(tx, userId, today));
    return [
      ...new Set(
        roles.filter((r) => (GATE_UNIT_ROLES as readonly string[]).includes(r.role)).map((r) => r.unitId),
      ),
    ];
  }

  async residentList(filter: { unitId?: string; state?: string }, skip: number, take: number) {
    const units = await this.residentUnits();
    if (filter.unitId && !units.includes(filter.unitId)) throw new DomainException('http.not_found');
    const unitIds = filter.unitId ? [filter.unitId] : units;
    if (!unitIds.length) return { rows: [] as VisitRow[], total: 0 };
    const where: Prisma.VisitWhereInput = {
      unitId: { in: unitIds },
      ...(filter.state ? { state: filter.state as Visit['state'] } : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.visit.findMany({
        where,
        include: VISIT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      total: await tx.visit.count({ where }),
    }));
  }

  async residentGet(id: string) {
    const { ctx } = await this.residentVisit(id);
    return this.db.tenant(ctx, async (tx) => {
      const v = await tx.visit.findUniqueOrThrow({ where: { id }, include: VISIT_INCLUDE });
      const policy = await this.policyOf(tx, v.tenantId, v.propertyId, v.unitId);
      const decidedBy = v.decidedByUserId
        ? await this.db.platform((p) =>
            p.userAccount.findUnique({ where: { id: v.decidedByUserId! }, select: { displayName: true } }),
          )
        : null;
      return { visit: v, policy, decidedByName: decidedBy?.displayName ?? null };
    });
  }

  /**
   * `POST /v1/resident/visits/{id}/actions/approve|deny|call-me`. **First answer wins**: the row is locked and only a
   * `requested` visit takes a decision; a later answer gets `accepted: false` with the decision already taken (and who
   * took it). The same resident repeating the same decision is idempotent (`accepted: true`). `call-me` asks the guard
   * to phone and decides nothing.
   */
  async answer(
    id: string,
    answer: 'approve' | 'deny' | 'call_me',
    options: { rememberVehicle?: boolean } = {},
  ): Promise<{ accepted: boolean; visit: VisitRow; decidedByName: string | null }> {
    const { userId, ctx } = await this.residentVisit(id);
    const now = this.now();
    const result = await this.db.tenant(ctx, async (tx) => {
      await this.lockVisit(tx, id);
      const v = await tx.visit.findUniqueOrThrow({ where: { id } });
      const resident: VisitActor = { kind: 'resident', id: userId };
      const target = answer === 'approve' ? 'approved' : 'denied';
      if (answer === 'call_me') {
        if (v.state !== 'requested') return false;
        const updated = await tx.visit.update({
          where: { id },
          data: { callMeAt: now, callMeUserId: userId, version: { increment: 1 } },
        });
        await this.record(tx, updated, 'gate.visit.answered', 'answered', resident, { answer: 'call_me' });
        await this.audit.record(tx, {
          action: 'gate.visit_answered',
          tenantId: v.tenantId,
          subjectType: 'smart.visit',
          subjectId: id,
          metadata: { answer: 'call_me' },
        });
        return true;
      }
      if (v.state !== 'requested') return v.state === target && v.decidedByUserId === userId;
      const updated = await tx.visit.update({
        where: { id },
        data: { state: target, decidedAt: now, decidedByUserId: userId, version: { increment: 1 } },
      });
      await this.record(tx, updated, 'gate.visit.answered', 'answered', resident, { answer });
      await this.audit.record(tx, {
        action: 'gate.visit_answered',
        tenantId: v.tenantId,
        subjectType: 'smart.visit',
        subjectId: id,
        metadata: { answer },
      });
      if (answer === 'approve' && options.rememberVehicle && v.plateNumber && v.unitId)
        await this.rememberIn(tx, {
          tenantId: v.tenantId,
          propertyId: v.propertyId,
          unitId: v.unitId,
          plate: { category: v.plateCategory!, number: v.plateNumber, province: v.plateProvince! },
          kind: 'visitor',
          label: null,
          userId,
        });
      return true;
    });
    const view = await this.residentGet(id);
    return { accepted: result, visit: view.visit, decidedByName: view.decidedByName };
  }

  async residentExit(id: string): Promise<VisitRow> {
    const { userId, ctx } = await this.residentVisit(id);
    return this.db.tenant(ctx, (tx) =>
      this.exitIn(tx, id, { kind: 'resident', id: userId }, () =>
        tx.visit.findUniqueOrThrow({ where: { id }, include: VISIT_INCLUDE }),
      ),
    );
  }

  /** Remembers a car for a unit (`gate.remember_days`): the live row of the same plate is extended. */
  async rememberIn(
    tx: Tx,
    input: {
      tenantId: string;
      propertyId: string;
      unitId: string;
      plate: Plate;
      kind: 'resident' | 'visitor';
      label: string | null;
      userId: string;
      days?: number;
    },
  ) {
    const now = this.now();
    const maxDays = await this.settings.valueAt<number>('gate.remember_days', now, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
    });
    const days = Math.min(input.days ?? maxDays, maxDays);
    const expiresAt = new Date(now.getTime() + days * 86_400_000);
    const where = {
      unitId: input.unitId,
      plateCategory: input.plate.category,
      plateNumber: input.plate.number,
      plateProvince: input.plate.province,
      revokedAt: null,
    };
    const live = await tx.rememberedVehicle.findFirst({ where });
    const row = live
      ? await tx.rememberedVehicle.update({
          where: { id: live.id },
          data: { expiresAt, kind: input.kind, label: input.label ?? live.label, updatedAt: now },
        })
      : await tx.rememberedVehicle.create({
          data: {
            tenantId: input.tenantId,
            propertyId: input.propertyId,
            unitId: input.unitId,
            kind: input.kind,
            plateCategory: input.plate.category,
            plateNumber: input.plate.number,
            plateProvince: input.plate.province,
            label: input.label,
            expiresAt,
            createdByUserId: input.userId,
            createdAt: now,
            updatedAt: now,
          },
        });
    await this.audit.record(tx, {
      action: 'gate.vehicle_remembered',
      tenantId: input.tenantId,
      subjectType: 'smart.remembered_vehicle',
      subjectId: row.id,
      metadata: { unitId: input.unitId, days },
    });
    await this.events.record(tx, {
      type: 'gate.vehicle_remembered',
      aggregateType: 'remembered_vehicle',
      aggregateId: row.id,
      tenantId: input.tenantId,
      payload: { rememberedVehicleId: row.id, unitId: input.unitId, expiresAt: expiresAt.toISOString() },
    });
    return row;
  }

  // ------------------------------------------------------------------------------------------------ jobs

  /**
   * Job `gate-visits` (every 15 s): `requested` visits past `respond_by` → `timed_out` with their house policy action
   * (snapshot at creation); open visits older than `gate.open_visit_alert_hours` reported once. Each visit in its own
   * transaction under a row lock (a resident answering at the same instant wins or loses cleanly).
   */
  async sweep(limit = 200): Promise<{ timedOut: number; overstayed: number }> {
    return RequestContext.run({ actor: systemActor('gate-visits') }, async () => {
      const now = this.now();
      const due = await this.db.platform((tx) =>
        tx.visit.findMany({
          where: { state: 'requested', respondBy: { lte: now } },
          select: { id: true, tenantId: true },
          orderBy: { respondBy: 'asc' },
          take: limit,
        }),
      );
      let timedOut = 0;
      for (const d of due) {
        const done = await this.db.tenant(systemTenantContext(d.tenantId), async (tx) => {
          await this.lockVisit(tx, d.id);
          const v = await tx.visit.findUniqueOrThrow({ where: { id: d.id } });
          if (v.state !== 'requested' || !v.respondBy || v.respondBy > now) return false;
          const updated = await tx.visit.update({
            where: { id: v.id },
            data: {
              state: 'timed_out',
              decidedAt: now,
              decisionReason: 'timeout',
              version: { increment: 1 },
            },
          });
          await this.record(
            tx,
            updated,
            'gate.visit.timed_out',
            'policy_applied',
            { kind: 'system', id: null },
            {
              action: v.timeoutAction,
              reason: 'timeout',
            },
          );
          await this.audit.record(tx, {
            action: 'gate.visit_timed_out',
            tenantId: v.tenantId,
            subjectType: 'smart.visit',
            subjectId: v.id,
            metadata: { action: v.timeoutAction },
          });
          return true;
        });
        if (done) timedOut += 1;
      }
      const open = await this.db.platform((tx) =>
        tx.visit.findMany({
          where: {
            state: 'entered',
            overstayNotifiedAt: null,
            enteredAt: { lte: new Date(now.getTime() - 3_600_000) },
          },
          select: { id: true, tenantId: true, propertyId: true, enteredAt: true },
          take: limit,
        }),
      );
      let overstayed = 0;
      for (const o of open) {
        const hours = await this.settings.valueAt<number>('gate.open_visit_alert_hours', now, {
          tenantId: o.tenantId,
          propertyId: o.propertyId,
        });
        if (o.enteredAt!.getTime() > now.getTime() - hours * 3_600_000) continue;
        const done = await this.db.tenant(systemTenantContext(o.tenantId), async (tx) => {
          const marked = await tx.visit.updateMany({
            where: { id: o.id, state: 'entered', overstayNotifiedAt: null },
            data: { overstayNotifiedAt: now },
          });
          if (marked.count !== 1) return false;
          const v = await tx.visit.findUniqueOrThrow({ where: { id: o.id } });
          await this.record(
            tx,
            v,
            'gate.visit.overstayed',
            'overstayed',
            { kind: 'system', id: null },
            { hours },
          );
          return true;
        });
        if (done) overstayed += 1;
      }
      if (timedOut || overstayed)
        this.logger.log(`gate visits: ${timedOut} timed out, ${overstayed} overstayed`);
      return { timedOut, overstayed };
    });
  }
}

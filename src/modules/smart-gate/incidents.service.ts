import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { residentUnitRoles } from '@core/identity/resident-units';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Incident,
  type IncidentEvent,
  type IncidentEventKind,
  type IncidentKind,
  type IncidentState,
  type Prisma,
  type VisitActorKind,
} from '@generated/prisma/client';
import { residentUserId } from '@modules/ops-juristic/resident-unit-access';
import { Inject, Injectable } from '@nestjs/common';

import { sosCancellable, visitActiveAt } from './gate-hardware-rules';
import { GATE_UNIT_ROLES, guardContext } from './visits.service';

const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

const MAX_PHOTO_BYTES = 2_000_000;
const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const ACTIVE: IncidentState[] = ['open', 'acknowledged'];

export type IncidentRow = Incident & {
  unit: { id: string; unitNo: string; buildingId: string } | null;
  gate: { id: string; name: string } | null;
  property: { id: string; name: string };
};

const INCIDENT_INCLUDE = {
  unit: { select: { id: true, unitNo: true, buildingId: true } },
  gate: { select: { id: true, name: true } },
  property: { select: { id: true, name: true } },
} as const;

export interface IncidentActor {
  kind: VisitActorKind;
  id: string | null;
}

/**
 * J4.2 SOS / incidents (D-317, D-328): a resident's SOS (LINE) or the gate tablet's SOS button raises an incident of
 * the estate; every gate of the estate, the office (owner, manager, staff) and the committee hear it at once (urgent);
 * a guard or the office acknowledges (the resident sees it) and resolves; the resident may cancel within
 * `gate.sos.cancel_seconds`. The incident keeps the visits inside the estate at that time.
 */
@Injectable()
export class IncidentsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private now(): Date {
    return this.clock.now();
  }

  /** Domain event + incident event with the same id (one call per change). */
  private async record(
    tx: Tx,
    incident: Pick<Incident, 'id' | 'tenantId' | 'propertyId' | 'unitId' | 'state'>,
    type: DomainEventType,
    kind: IncidentEventKind,
    actor: IncidentActor,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const gateIds = (
      await tx.gate.findMany({
        where: { propertyId: incident.propertyId, state: 'active' },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((g) => g.id);
    const envelope = await this.events.record(tx, {
      type,
      aggregateType: 'incident',
      aggregateId: incident.id,
      tenantId: incident.tenantId,
      payload: {
        incidentId: incident.id,
        propertyId: incident.propertyId,
        unitId: incident.unitId,
        state: incident.state,
        gateIds,
        ...payload,
      },
    });
    await tx.incidentEvent.create({
      data: {
        id: envelope.id,
        tenantId: incident.tenantId,
        incidentId: incident.id,
        kind,
        actorKind: actor.kind,
        actorId: actor.id,
        payload: payload as Prisma.InputJsonValue,
        occurredAt: new Date(envelope.occurredAt),
      },
    });
    return envelope.id;
  }

  /** Visits of the estate inside at `at` (entered, not exited before `at − window`). */
  private async activeVisitIds(tx: Tx, tenantId: string, propertyId: string, at: Date): Promise<string[]> {
    const window = await this.settings.valueAt<number>('gate.incident.visit_window_minutes', at, {
      tenantId,
    });
    const rows = await tx.visit.findMany({
      where: {
        tenantId,
        propertyId,
        enteredAt: { lte: at },
        OR: [{ exitedAt: null }, { exitedAt: { gte: new Date(at.getTime() - window * 60_000) } }],
      },
      select: { id: true, enteredAt: true, exitedAt: true },
      orderBy: { enteredAt: 'asc' },
      take: 500,
    });
    return rows.filter((v) => visitActiveAt(v, at, window)).map((v) => v.id);
  }

  private checkKind(kind: string): IncidentKind {
    if (!['fire', 'medical', 'intrusion', 'other'].includes(kind))
      throw invalid('kind', 'isIn', 'fire, medical, intrusion, other');
    return kind as IncidentKind;
  }

  private checkNote(note: string | null | undefined, max = 500): string | null {
    const text = note?.trim() || null;
    if (text && text.length > max) throw invalid('note', 'maxLength', `at most ${max} characters`);
    return text;
  }

  private async create(
    tx: Tx,
    input: {
      tenantId: string;
      propertyId: string;
      unitId: string | null;
      gateId: string | null;
      kind: IncidentKind;
      source: 'resident_sos' | 'guard';
      note: string | null;
      photoDocumentId: string | null;
      raisedByUserId: string | null;
      actor: IncidentActor;
    },
  ): Promise<IncidentRow> {
    const now = this.now();
    const visitIds = await this.activeVisitIds(tx, input.tenantId, input.propertyId, now);
    const incident = await tx.incident.create({
      data: {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        unitId: input.unitId,
        gateId: input.gateId,
        kind: input.kind,
        source: input.source,
        note: input.note,
        photoDocumentId: input.photoDocumentId,
        raisedByUserId: input.raisedByUserId,
        visitIds,
        createdAt: now,
        createdBy: input.raisedByUserId,
        updatedAt: now,
      },
      include: INCIDENT_INCLUDE,
    });
    await this.record(tx, incident, 'gate.incident.raised', 'raised', input.actor, {
      kind: input.kind,
      source: input.source,
      visits: visitIds.length,
    });
    await this.audit.record(tx, {
      action: 'gate.incident_raised',
      tenantId: input.tenantId,
      buildingId: incident.unit?.buildingId ?? null,
      subjectType: 'smart.incident',
      subjectId: incident.id,
      metadata: { kind: input.kind, source: input.source, unitId: input.unitId, gateId: input.gateId },
    });
    return incident;
  }

  // ------------------------------------------------------------------------------------------------ resident

  /** Units I hold a gate role on today. */
  private async myUnits(userId: string): Promise<string[]> {
    const roles = await this.db.platform((tx) => residentUnitRoles(tx, userId, bangkokDate(this.now())));
    return [
      ...new Set(
        roles.filter((r) => (GATE_UNIT_ROLES as readonly string[]).includes(r.role)).map((r) => r.unitId),
      ),
    ];
  }

  /**
   * `POST /v1/resident/sos`. An SOS of the same unit by me that is still open is returned (`existing: true`) rather
   * than raised twice; more than `gate.sos.max_per_hour` SOS of my login in an hour → 429 (never dropped silently).
   */
  async residentRaise(input: {
    unitId: string;
    kind: string;
    note?: string | null;
    photo?: { contentBase64: string; mimeType: string } | null;
  }): Promise<{ incident: IncidentRow; existing: boolean; cancellableUntil: string | null }> {
    const userId = residentUserId();
    const kind = this.checkKind(input.kind);
    const note = this.checkNote(input.note);
    if (!(await this.myUnits(userId)).includes(input.unitId)) throw new DomainException('http.not_found');
    const unit = await this.db.platform((tx) => tx.unit.findUniqueOrThrow({ where: { id: input.unitId } }));
    const ctx = systemTenantContext(unit.tenantId);
    const now = this.now();
    const cancelSeconds = await this.settings.valueAt<number>('gate.sos.cancel_seconds', now, {
      tenantId: unit.tenantId,
    });
    const until = (i: Incident) =>
      sosCancellable(i.createdAt, now, cancelSeconds) && ACTIVE.includes(i.state)
        ? new Date(i.createdAt.getTime() + cancelSeconds * 1000).toISOString()
        : null;
    const open = await this.db.tenant(ctx, (tx) =>
      tx.incident.findFirst({
        where: { unitId: unit.id, raisedByUserId: userId, state: { in: ACTIVE } },
        include: INCIDENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (open) return { incident: open, existing: true, cancellableUntil: until(open) };
    const perHour = await this.settings.valueAt<number>('gate.sos.max_per_hour', now, {
      tenantId: unit.tenantId,
    });
    const recent = await this.db.tenant(ctx, (tx) =>
      tx.incident.count({
        where: { raisedByUserId: userId, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
      }),
    );
    if (recent >= perHour)
      throw new DomainException('incident.rate_limited', { headers: { 'Retry-After': '600' } });
    let photoDocumentId: string | null = null;
    if (input.photo) {
      if (!PHOTO_MIME.includes(input.photo.mimeType))
        throw invalid('photo.mimeType', 'isIn', PHOTO_MIME.join(', '));
      const body = Buffer.from(input.photo.contentBase64, 'base64');
      if (!body.length || body.length > MAX_PHOTO_BYTES)
        throw invalid('photo.contentBase64', 'size', `1 byte – ${MAX_PHOTO_BYTES} bytes decoded`);
      const uploaded = await this.documents.uploadGenerated({
        tenantId: unit.tenantId,
        kind: 'other',
        scopeType: 'property',
        scopeId: unit.propertyId,
        buildingId: unit.buildingId,
        title: 'incident photo',
        mimeType: input.photo.mimeType,
        body,
        retentionClass: 'service_photo',
      });
      photoDocumentId = (await this.db.tenant(ctx, (tx) => this.documents.recordGenerated(tx, uploaded))).id;
    }
    const incident = await this.db.tenant(ctx, (tx) =>
      this.create(tx, {
        tenantId: unit.tenantId,
        propertyId: unit.propertyId,
        unitId: unit.id,
        gateId: null,
        kind,
        source: 'resident_sos',
        note,
        photoDocumentId,
        raisedByUserId: userId,
        actor: { kind: 'resident', id: userId },
      }),
    );
    return { incident, existing: false, cancellableUntil: until(incident) };
  }

  /** Incidents of my units (newest first) or one of them; another unit's = 404. */
  async residentList(unitId?: string): Promise<IncidentRow[]> {
    const userId = residentUserId();
    const units = await this.myUnits(userId);
    if (unitId && !units.includes(unitId)) throw new DomainException('http.not_found');
    const ids = unitId ? [unitId] : units;
    if (!ids.length) return [];
    return this.db.platform((tx) =>
      tx.incident.findMany({
        where: { unitId: { in: ids } },
        include: INCIDENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }

  async residentGet(id: string): Promise<{ incident: IncidentRow; cancellableUntil: string | null }> {
    const userId = residentUserId();
    const units = await this.myUnits(userId);
    const incident = await this.db.platform((tx) =>
      tx.incident.findUnique({ where: { id }, include: INCIDENT_INCLUDE }),
    );
    if (!incident?.unitId || !units.includes(incident.unitId)) throw new DomainException('http.not_found');
    const now = this.now();
    const cancelSeconds = await this.settings.valueAt<number>('gate.sos.cancel_seconds', now, {
      tenantId: incident.tenantId,
    });
    const mine = incident.raisedByUserId === userId && ACTIVE.includes(incident.state);
    return {
      incident,
      cancellableUntil:
        mine && sosCancellable(incident.createdAt, now, cancelSeconds)
          ? new Date(incident.createdAt.getTime() + cancelSeconds * 1000).toISOString()
          : null,
    };
  }

  /** The resident who raised it cancels within `gate.sos.cancel_seconds` (409 after; idempotent when cancelled). */
  async residentCancel(id: string, reason?: string | null): Promise<IncidentRow> {
    const userId = residentUserId();
    const { incident } = await this.residentGet(id);
    if (incident.raisedByUserId !== userId) throw new DomainException('http.not_found');
    if (incident.state === 'cancelled') return incident;
    const text = this.checkNote(reason, 300);
    const now = this.now();
    const cancelSeconds = await this.settings.valueAt<number>('gate.sos.cancel_seconds', now, {
      tenantId: incident.tenantId,
    });
    if (!ACTIVE.includes(incident.state)) throw new DomainException('incident.invalid_state');
    if (!sosCancellable(incident.createdAt, now, cancelSeconds))
      throw new DomainException('incident.cancel_window_passed');
    return this.db.tenant(systemTenantContext(incident.tenantId), async (tx) => {
      const moved = await tx.incident.updateMany({
        where: { id, state: { in: ACTIVE } },
        data: {
          state: 'cancelled',
          cancelledAt: now,
          cancelReason: text,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      if (moved.count !== 1) throw new DomainException('incident.invalid_state');
      const row = await tx.incident.findUniqueOrThrow({ where: { id }, include: INCIDENT_INCLUDE });
      await this.record(tx, row, 'gate.incident.cancelled', 'cancelled', { kind: 'resident', id: userId });
      await this.audit.record(tx, {
        action: 'gate.incident_cancelled',
        tenantId: row.tenantId,
        subjectType: 'smart.incident',
        subjectId: id,
        metadata: { unitId: row.unitId },
      });
      return row;
    });
  }

  // ------------------------------------------------------------------------------------------------ guard / operator

  /** The tablet's own SOS button (source guard). */
  async guardRaise(input: {
    kind: string;
    unitId?: string | null;
    note?: string | null;
  }): Promise<IncidentRow> {
    const g = guardContext();
    const kind = this.checkKind(input.kind);
    const note = this.checkNote(input.note);
    return this.db.tenant(g.ctx, async (tx) => {
      if (input.unitId) {
        const unit = await tx.unit.findFirst({ where: { id: input.unitId, propertyId: g.propertyId } });
        if (!unit) throw new DomainException('http.not_found');
      }
      return this.create(tx, {
        tenantId: g.tenantId,
        propertyId: g.propertyId,
        unitId: input.unitId ?? null,
        gateId: g.gateId,
        kind,
        source: 'guard',
        note,
        photoDocumentId: null,
        raisedByUserId: g.userId,
        actor: { kind: 'guard', id: g.userId },
      });
    });
  }

  /** Incidents of the estate of the shift: active ones (default) or the last 24 h. */
  async guardList(view: 'active' | 'recent'): Promise<IncidentRow[]> {
    const g = guardContext();
    return this.db.tenant(g.ctx, (tx) =>
      tx.incident.findMany({
        where: {
          tenantId: g.tenantId,
          propertyId: g.propertyId,
          ...(view === 'active'
            ? { state: { in: ACTIVE } }
            : { createdAt: { gte: new Date(this.now().getTime() - 86_400_000) } }),
        },
        include: INCIDENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }

  async guardGet(id: string): Promise<{ incident: IncidentRow; events: IncidentEvent[] }> {
    const g = guardContext();
    return this.db.tenant(g.ctx, async (tx) => {
      const incident = this.found(
        await tx.incident.findFirst({
          where: { id, tenantId: g.tenantId, propertyId: g.propertyId },
          include: INCIDENT_INCLUDE,
        }),
      );
      const events = await tx.incidentEvent.findMany({
        where: { incidentId: id },
        orderBy: { occurredAt: 'asc' },
      });
      return { incident, events };
    });
  }

  guardDecide(id: string, action: 'acknowledge' | 'resolve', note?: string | null): Promise<IncidentRow> {
    const g = guardContext();
    return this.decide(
      g.ctx,
      { id, propertyId: g.propertyId },
      action,
      { kind: 'guard', id: g.userId },
      note,
    );
  }

  operatorDecide(
    ctx: TenantContext,
    id: string,
    action: 'acknowledge' | 'resolve',
    note?: string | null,
  ): Promise<IncidentRow> {
    const actor = RequestContext.actor();
    return this.decide(
      ctx,
      { id },
      action,
      { kind: 'operator', id: actor?.type === 'user' ? actor.publicId : null },
      note,
    );
  }

  /** acknowledge: open → acknowledged (idempotent once acknowledged); resolve: open | acknowledged → resolved. */
  private decide(
    ctx: TenantContext,
    where: { id: string; propertyId?: string },
    action: 'acknowledge' | 'resolve',
    actor: IncidentActor,
    note?: string | null,
  ): Promise<IncidentRow> {
    const text = this.checkNote(note, 1000);
    return this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM smart.incident WHERE id = ${where.id}::uuid FOR UPDATE`;
      const row = this.found(
        await tx.incident.findFirst({
          where: { ...where, tenantId: ctx.tenantId },
          include: INCIDENT_INCLUDE,
        }),
      );
      const now = this.now();
      if (action === 'acknowledge') {
        if (row.state === 'acknowledged') return row;
        if (row.state !== 'open') throw new DomainException('incident.invalid_state');
      } else if (!ACTIVE.includes(row.state)) {
        if (row.state === 'resolved') return row;
        throw new DomainException('incident.invalid_state');
      }
      const updated = await tx.incident.update({
        where: { id: row.id },
        data:
          action === 'acknowledge'
            ? {
                state: 'acknowledged',
                acknowledgedAt: now,
                acknowledgedBy: actor.id,
                updatedAt: now,
                version: { increment: 1 },
              }
            : {
                state: 'resolved',
                acknowledgedAt: row.acknowledgedAt ?? now,
                acknowledgedBy: row.acknowledgedBy ?? actor.id,
                resolvedAt: now,
                resolvedBy: actor.id,
                resolutionNote: text,
                updatedAt: now,
                version: { increment: 1 },
              },
        include: INCIDENT_INCLUDE,
      });
      if (action === 'resolve' && row.state === 'open')
        await this.record(
          tx,
          { ...updated, state: 'acknowledged' },
          'gate.incident.acknowledged',
          'acknowledged',
          actor,
          {
            by: actor.kind,
          },
        );
      await this.record(
        tx,
        updated,
        action === 'acknowledge' ? 'gate.incident.acknowledged' : 'gate.incident.resolved',
        action === 'acknowledge' ? 'acknowledged' : 'resolved',
        actor,
        { by: actor.kind, ...(text && action === 'acknowledge' ? { note: text } : {}) },
      );
      await this.audit.record(tx, {
        action: action === 'acknowledge' ? 'gate.incident_acknowledged' : 'gate.incident_resolved',
        tenantId: row.tenantId,
        subjectType: 'smart.incident',
        subjectId: row.id,
        metadata: { by: actor.kind },
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------------ owner log

  private reason(value: string | undefined): string {
    const text = value?.trim() ?? '';
    if (text.length < 5 || text.length > 500) throw invalid('reason', 'length', '5–500 characters');
    return text;
  }

  /** The incident log (reason required, one `gate.incident_log_read` audit row per read, like the visit log). */
  async log(
    ctx: TenantContext,
    filter: { reason?: string; propertyId?: string; state?: IncidentState; from?: string; to?: string },
    skip: number,
    take: number,
  ): Promise<{ rows: IncidentRow[]; total: number }> {
    const reason = this.reason(filter.reason);
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.IncidentWhereInput = {
        tenantId: ctx.tenantId,
        ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
        ...(filter.state ? { state: filter.state } : {}),
        ...(filter.from || filter.to
          ? {
              createdAt: {
                ...(filter.from ? { gte: new Date(filter.from) } : {}),
                ...(filter.to ? { lt: new Date(filter.to) } : {}),
              },
            }
          : {}),
      };
      const rows = await tx.incident.findMany({
        where,
        include: INCIDENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      });
      const total = await tx.incident.count({ where });
      await this.audit.record(tx, {
        action: 'gate.incident_log_read',
        tenantId: ctx.tenantId,
        subjectType: 'smart.incident',
        subjectId: null,
        metadata: {
          reason,
          count: rows.length,
          ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
        },
      });
      return { rows, total };
    });
  }

  /** One incident with its timeline and the visits inside the estate at the time (reason required, audited). */
  async logGet(ctx: TenantContext, id: string, reason: string | undefined) {
    const text = this.reason(reason);
    return this.db.tenant(ctx, async (tx) => {
      const incident = this.found(
        await tx.incident.findFirst({ where: { id, tenantId: ctx.tenantId }, include: INCIDENT_INCLUDE }),
      );
      const events = await tx.incidentEvent.findMany({
        where: { incidentId: id },
        orderBy: { occurredAt: 'asc' },
      });
      const visits = incident.visitIds.length
        ? await tx.visit.findMany({
            where: { id: { in: incident.visitIds } },
            include: {
              unit: { select: { id: true, unitNo: true } },
              gate: { select: { id: true, name: true } },
            },
            orderBy: { enteredAt: 'asc' },
          })
        : [];
      await this.audit.record(tx, {
        action: 'gate.incident_log_read',
        tenantId: ctx.tenantId,
        subjectType: 'smart.incident',
        subjectId: id,
        metadata: { reason: text },
      });
      return { incident, events, visits };
    });
  }
}

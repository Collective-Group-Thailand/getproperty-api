import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type BookingStatus,
  type Facility,
  type FacilityBooking,
  type FacilityKind,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { bangkokWeek, type BookingPolicy, bookingPolicy, bookingProblems } from './community-rules';

export interface FacilityInput {
  buildingId: string;
  name: string;
  kind: FacilityKind;
  capacity?: number | null;
  rules?: Record<string, unknown>;
  bookingPolicy?: Partial<BookingPolicy>;
  isActive?: boolean;
}

export const BOOKING_INCLUDE = {
  facility: { select: { id: true, name: true, kind: true } },
  unit: { select: { id: true, unitNo: true } },
} satisfies Prisma.FacilityBookingInclude;
export type BookingRow = Prisma.FacilityBookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;

const by = () => userIdOf(RequestContext.actor());
const LIVE: BookingStatus[] = ['requested', 'confirmed'];

/** True when Prisma / PostgreSQL refused the row for the no-overlap exclusion constraint. */
function overlapViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string; meta?: Record<string, unknown> };
  const text = `${e.message ?? ''} ${JSON.stringify(e.meta ?? {})}`;
  return text.includes('facility_booking_no_overlap') || text.includes('23P01');
}

/**
 * Facilities and bookings (B5.3, blueprint A1.6): common facilities of a building with a booking policy (slots,
 * opening hours, longest booking, how far ahead, quota per unit per week, approval). A booking is `confirmed` at
 * once or `requested` when the facility needs approval; two live bookings of one facility never overlap — the
 * database refuses it (exclusion constraint) and the API answers 409 `facility.slot_taken`.
 */
@Injectable()
export class FacilitiesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  list(ctx: TenantContext, f: { buildingId?: string; includeInactive?: boolean }): Promise<Facility[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.facility.findMany({
        where: this.own(ctx, {
          deletedAt: null,
          ...(f.buildingId ? { buildingId: f.buildingId } : {}),
          ...(f.includeInactive ? {} : { isActive: true }),
          ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}),
        }),
        orderBy: [{ name: 'asc' }],
      }),
    );
  }

  async get(ctx: TenantContext, id: string): Promise<Facility> {
    return this.found(
      await this.db.tenant(ctx, (tx) =>
        tx.facility.findFirst({ where: this.own(ctx, { id, deletedAt: null }) }),
      ),
    );
  }

  async create(ctx: TenantContext, input: FacilityInput): Promise<Facility> {
    return this.db.tenant(ctx, async (tx) => {
      const b = await tx.building.findFirst({
        where: {
          id: input.buildingId,
          deletedAt: null,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        },
      });
      if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(input.buildingId)))
        throw new DomainException('http.not_found');
      return tx.facility.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: b.id,
          name: input.name.trim(),
          kind: input.kind,
          capacity: input.capacity ?? null,
          rules: (input.rules ?? {}) as Prisma.InputJsonValue,
          bookingPolicy: bookingPolicy(input.bookingPolicy) as unknown as Prisma.InputJsonValue,
          isActive: input.isActive ?? true,
          createdBy: by(),
        },
      });
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: Partial<Omit<FacilityInput, 'buildingId'>>,
  ): Promise<Facility> {
    return this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.facility.findFirst({ where: this.own(ctx, { id, deletedAt: null }) }));
      return tx.facility.update({
        where: { id: row.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.rules !== undefined ? { rules: input.rules as Prisma.InputJsonValue } : {}),
          ...(input.bookingPolicy !== undefined
            ? {
                bookingPolicy: bookingPolicy({
                  ...(row.bookingPolicy as object),
                  ...input.bookingPolicy,
                }) as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
    });
  }

  bookings(ctx: TenantContext, facilityId: string, range: { from: Date; to: Date }): Promise<BookingRow[]> {
    return this.db.tenant(ctx, async (tx) => {
      const f = this.found(await tx.facility.findFirst({ where: this.own(ctx, { id: facilityId }) }));
      return tx.facilityBooking.findMany({
        where: { facilityId: f.id, startsAt: { lt: range.to }, endsAt: { gt: range.from } },
        include: BOOKING_INCLUDE,
        orderBy: { startsAt: 'asc' },
      });
    });
  }

  /**
   * Books a slot for a unit (the resident app, or staff on behalf of a unit): policy checks, quota per unit per week
   * (Monday–Sunday, Asia/Bangkok) over live bookings, then the insert — the exclusion constraint refuses overlaps.
   */
  async bookIn(
    tx: Tx,
    input: {
      facility: Facility;
      unitId: string;
      partyId: string | null;
      startsAt: Date;
      endsAt: Date;
      note?: string | null;
    },
  ): Promise<FacilityBooking> {
    const { facility } = input;
    if (!facility.isActive || facility.deletedAt)
      throw new DomainException('facility.unavailable', { params: { status: 'inactive' } });
    const policy = bookingPolicy(facility.bookingPolicy);
    const problems = bookingProblems(policy, input.startsAt, input.endsAt, this.clock.now());
    if (problems.length)
      throw new DomainException('validation.failed', {
        errors: problems.map((message) => ({ path: 'startsAt', code: 'policy', message })),
      });
    const week = bangkokWeek(input.startsAt);
    const used = await tx.facilityBooking.count({
      where: {
        facilityId: facility.id,
        unitId: input.unitId,
        status: { in: LIVE },
        startsAt: { gte: week.from, lt: week.to },
      },
    });
    if (used >= policy.maxPerUnitPerWeek)
      throw new DomainException('facility.quota_exceeded', { params: { quota: policy.maxPerUnitPerWeek } });
    let booking: FacilityBooking;
    try {
      booking = await tx.facilityBooking.create({
        data: {
          tenantId: facility.tenantId,
          buildingId: facility.buildingId,
          facilityId: facility.id,
          unitId: input.unitId,
          partyId: input.partyId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          status: policy.requiresApproval ? 'requested' : 'confirmed',
          note: input.note ?? null,
          createdAt: this.clock.now(),
          createdBy: by(),
        },
      });
    } catch (error) {
      // the whole transaction rolls back with the problem
      if (overlapViolation(error)) throw new DomainException('facility.slot_taken');
      throw error;
    }
    await this.changed(tx, booking, null);
    return booking;
  }

  private async changed(tx: Tx, b: FacilityBooking, from: BookingStatus | null): Promise<void> {
    await this.events.record(tx, {
      type: 'facility_booking.changed',
      aggregateType: 'facility_booking',
      aggregateId: b.id,
      tenantId: b.tenantId,
      buildingId: b.buildingId,
      payload: {
        bookingId: b.id,
        facilityId: b.facilityId,
        unitId: b.unitId,
        partyId: b.partyId,
        from,
        to: b.status,
        startsAt: b.startsAt.toISOString(),
      },
    });
  }

  /** Owner decisions and cancellations (`approve`, `reject`, `cancel`, `no_show`). */
  async decide(
    ctx: TenantContext,
    id: string,
    action: 'approve' | 'reject' | 'cancel' | 'no_show',
    reason?: string | null,
  ): Promise<BookingRow> {
    await this.db.tenant(ctx, async (tx) => {
      const b = this.found(
        await tx.facilityBooking.findFirst({
          where: this.own(ctx, { id, ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}) }),
        }),
      );
      await this.decideIn(tx, b, action, reason);
    });
    return this.getBooking(ctx, id);
  }

  async decideIn(
    tx: Tx,
    b: FacilityBooking,
    action: 'approve' | 'reject' | 'cancel' | 'no_show',
    reason?: string | null,
  ): Promise<FacilityBooking> {
    const allowed: Record<typeof action, BookingStatus[]> = {
      approve: ['requested'],
      reject: ['requested'],
      cancel: ['requested', 'confirmed'],
      no_show: ['confirmed'],
    };
    if (!allowed[action].includes(b.status))
      throw new DomainException('facility.booking_invalid_state', { params: { status: b.status } });
    const to: BookingStatus =
      action === 'approve' ? 'confirmed' : action === 'no_show' ? 'no_show' : 'cancelled';
    const updated = await tx.facilityBooking.update({
      where: { id: b.id },
      data: {
        status: to,
        ...(action === 'approve' || action === 'reject'
          ? { decidedBy: by(), decidedAt: this.clock.now() }
          : {}),
        ...(action === 'reject' || action === 'cancel' ? { cancelReason: reason ?? null } : {}),
        version: { increment: 1 },
        updatedBy: by(),
      },
    });
    await this.changed(tx, updated, b.status);
    return updated;
  }

  async getBooking(ctx: TenantContext, id: string): Promise<BookingRow> {
    return this.found(
      await this.db.tenant(ctx, (tx) =>
        tx.facilityBooking.findFirst({ where: this.own(ctx, { id }), include: BOOKING_INCLUDE }),
      ),
    );
  }
}

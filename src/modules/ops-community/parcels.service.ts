import { timingSafeEqual } from 'node:crypto';

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Parcel, type ParcelStatus, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { parcelPin } from './community-rules';

export const PARCEL_INCLUDE = {
  unit: { select: { id: true, unitNo: true } },
  recipient: { select: { id: true, displayName: true } },
} satisfies Prisma.ParcelInclude;
export type ParcelRow = Prisma.ParcelGetPayload<{ include: typeof PARCEL_INCLUDE }>;

const by = () => userIdOf(RequestContext.actor());
const field = (p: { id: string; tenantId: string }) => ({
  tenantId: p.tenantId,
  table: 'ops.parcel',
  column: 'pickup_pin',
  rowId: p.id,
});

/**
 * Parcels (B5.3, D-073): staff photograph a parcel for a unit; the residents of the unit are told on LINE
 * (`parcel.received`, quiet hours, topic `parcels`) and pick it up by showing their 6-digit PIN (encrypted with the
 * tenant key; shown in the resident app) — or staff confirm the hand-over without it; an unclaimed parcel is
 * returned with a reason.
 */
@Injectable()
export class ParcelsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    private readonly keys: TenantDataKeys,
    private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  list(
    ctx: TenantContext,
    f: {
      buildingId?: string;
      unitId?: string;
      status?: ParcelStatus;
      open?: boolean;
      skip: number;
      take: number;
    },
  ) {
    const where: Prisma.ParcelWhereInput = this.own(ctx, {
      ...(f.buildingId ? { buildingId: f.buildingId } : {}),
      ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}),
      ...(f.unitId ? { unitId: f.unitId } : {}),
      ...(f.status
        ? { status: f.status }
        : f.open
          ? { status: { in: ['received', 'notified'] as ParcelStatus[] } }
          : {}),
    });
    return this.db.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.parcel.findMany({
          where,
          include: PARCEL_INCLUDE,
          orderBy: { receivedAt: 'desc' },
          skip: f.skip,
          take: f.take,
        }),
        tx.parcel.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async get(ctx: TenantContext, id: string): Promise<ParcelRow> {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<ParcelRow> {
    return this.found(
      await tx.parcel.findFirst({
        where: this.own(ctx, { id, ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}) }),
        include: PARCEL_INCLUDE,
      }),
    );
  }

  async receive(
    ctx: TenantContext,
    input: {
      unitId: string;
      recipientPartyId?: string | null;
      carrier?: string | null;
      trackingNo?: string | null;
      photoDocumentId: string;
      notes?: string | null;
    },
  ): Promise<ParcelRow> {
    const photo = await this.db.tenant(ctx, (tx) =>
      tx.document.findFirst({
        where: { id: input.photoDocumentId, tenantId: ctx.tenantId, deletedAt: null },
      }),
    );
    if (!photo || !['service_photo', 'other', 'inspection_photo'].includes(photo.kind))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'photoDocumentId', code: 'unknown', message: 'an uploaded photo of the parcel' }],
      });
    if (photo.uploadState === 'presigned') await this.documents.complete(ctx, photo.id, {});
    const id = await this.db.tenant(ctx, async (tx) => {
      const unit = this.found(await tx.unit.findFirst({ where: { id: input.unitId, deletedAt: null } }));
      const building = await tx.building.findFirst({
        where: {
          id: unit.buildingId,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        },
      });
      if (!building || (ctx.buildingIds && !ctx.buildingIds.includes(unit.buildingId)))
        throw new DomainException('http.not_found');
      if (input.recipientPartyId) {
        const party = await tx.party.findFirst({
          where: { id: input.recipientPartyId, tenantId: ctx.tenantId },
        });
        if (!party) throw new DomainException('http.not_found');
      }
      const now = this.clock.now();
      const row = { id: uuidv7(now.getTime()), tenantId: ctx.tenantId };
      const created = await tx.parcel.create({
        data: {
          ...row,
          buildingId: unit.buildingId,
          unitId: unit.id,
          recipientPartyId: input.recipientPartyId ?? null,
          carrier: input.carrier ?? null,
          trackingNo: input.trackingNo ?? null,
          photoDocumentId: photo.id,
          receivedBy: by(),
          receivedAt: now,
          pickupPinEnc: await this.keys.encrypt(tx, field(row), parcelPin()),
          notes: input.notes ?? null,
          createdAt: now,
          createdBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'parcel.received',
        aggregateType: 'parcel',
        aggregateId: created.id,
        tenantId: ctx.tenantId,
        buildingId: created.buildingId,
        payload: { parcelId: created.id, unitId: unit.id, recipientPartyId: created.recipientPartyId },
      });
      return created.id;
    });
    return this.get(ctx, id);
  }

  /** The PIN of a parcel (for the resident app). */
  async pin(tx: Tx, parcel: Parcel): Promise<string> {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${parcel.tenantId}, true)`;
    return this.keys.decrypt(tx, field(parcel), parcel.pickupPinEnc);
  }

  /** Hand-over: with the resident's PIN (`resident_pin`) or confirmed by staff without it (`staff`). */
  async pickUp(
    ctx: TenantContext,
    id: string,
    input: { pin?: string | null; staffConfirmed?: boolean; pickedUpByPartyId?: string | null },
  ): Promise<ParcelRow> {
    await this.db.tenant(ctx, async (tx) => {
      const parcel = await this.load(tx, ctx, id);
      if (!['received', 'notified'].includes(parcel.status))
        throw new DomainException('parcel.invalid_state', { params: { status: parcel.status } });
      let confirmedBy: 'resident_pin' | 'staff';
      if (input.pin) {
        const expected = Buffer.from(await this.pin(tx, parcel));
        const given = Buffer.from(input.pin);
        if (expected.length !== given.length || !timingSafeEqual(expected, given))
          throw new DomainException('parcel.pin_mismatch');
        confirmedBy = 'resident_pin';
      } else if (input.staffConfirmed) {
        confirmedBy = 'staff';
      } else {
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'pin', code: 'required', message: 'the resident’s PIN, or staffConfirmed = true' },
          ],
        });
      }
      const now = this.clock.now();
      await tx.parcel.update({
        where: { id: parcel.id },
        data: {
          status: 'picked_up',
          pickedUpAt: now,
          pickupConfirmedBy: confirmedBy,
          pickedUpByPartyId: input.pickedUpByPartyId ?? parcel.recipientPartyId,
          handedOverBy: by(),
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'parcel.picked_up',
        aggregateType: 'parcel',
        aggregateId: parcel.id,
        tenantId: parcel.tenantId,
        buildingId: parcel.buildingId,
        payload: { parcelId: parcel.id, unitId: parcel.unitId, confirmedBy },
      });
    });
    return this.get(ctx, id);
  }

  async returnToSender(ctx: TenantContext, id: string, reason: string): Promise<ParcelRow> {
    await this.db.tenant(ctx, async (tx) => {
      const parcel = await this.load(tx, ctx, id);
      if (!['received', 'notified'].includes(parcel.status))
        throw new DomainException('parcel.invalid_state', { params: { status: parcel.status } });
      await tx.parcel.update({
        where: { id: parcel.id },
        data: {
          status: 'returned',
          returnedAt: this.clock.now(),
          returnReason: reason,
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'parcel.returned',
        aggregateType: 'parcel',
        aggregateId: parcel.id,
        tenantId: parcel.tenantId,
        buildingId: parcel.buildingId,
        payload: { parcelId: parcel.id, unitId: parcel.unitId, reason },
      });
    });
    return this.get(ctx, id);
  }

  /** Subscriber step: the residents were told (`received` → `notified`). */
  async markNotified(tx: Tx, parcelId: string): Promise<void> {
    await tx.parcel.updateMany({
      where: { id: parcelId, status: 'received' },
      data: { status: 'notified', notifiedAt: this.clock.now() },
    });
  }
}

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type Furnishing,
  type Listing,
  type ListingPhoto,
  type PortfolioUnitKind,
  Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

export interface ListingTransit {
  name: string;
  line?: string | null;
  distanceM: number;
}

export interface ListingFields {
  titleTh?: string;
  titleEn?: string | null;
  descriptionTh?: string;
  descriptionEn?: string | null;
  /** THB per month, decimal string. */
  rent?: string;
  depositMonths?: number;
  advanceMonths?: number;
  minTermMonths?: number;
  /** `YYYY-MM-DD` (Bangkok) or null = now. */
  availableFrom?: string | null;
  furnishing?: Furnishing | null;
  petsAllowed?: boolean;
  smokingAllowed?: boolean;
  facilities?: string[];
  showUnitNo?: boolean;
  /** D-265: the average of the last confirmed utility bills on the public listing. */
  showUtilityHistory?: boolean;
  transit?: ListingTransit | null;
}

export interface ListingCreateInput extends ListingFields {
  unitId: string;
  titleTh: string;
  rent: string;
}

export interface WeeklySlot {
  weekday: number;
  from: string;
  to: string;
  /** D-295 (G7): `self` = a self-viewing window (no one on site); accompanied when absent. */
  mode?: 'accompanied' | 'self';
}
export interface AvailabilityException {
  date: string;
  closed?: boolean;
  from?: string;
  to?: string;
}
export interface AvailabilityInput {
  weekly: WeeklySlot[];
  exceptions?: AvailabilityException[];
  slotMinutes?: number;
}

export type ListingWithParts = Listing & {
  photos: (ListingPhoto & {
    document: { width: number | null; height: number | null; storageKey: string };
  })[];
  availability: { weekly: unknown; exceptions: unknown; slotMinutes: number } | null;
};

/** Reasons a submitted listing waits for a moderator (D-252); stored on the listing, shown to the owner. */
export type ReviewReason = 'first_listing' | 'price_outlier' | 'flagged_words';

const LIVE = ['pending_review', 'published', 'paused'] as const;
const EDITABLE = ['draft', 'rejected', 'paused', 'published', 'pending_review'] as const;
const KIND_SLUG: Record<PortfolioUnitKind, string> = {
  condo_unit: 'condo',
  house: 'house',
  townhouse: 'townhouse',
  room: 'room',
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (path: string, message: string, code = 'invalid') =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/** The unit kind a listing shows: the portfolio kind when the landlord set one, else from the unit type. */
export function kindOf(
  detailKind: PortfolioUnitKind | null | undefined,
  unitType: string,
): PortfolioUnitKind {
  if (detailKind) return detailKind;
  if (unitType === 'condo_unit') return 'condo_unit';
  if (unitType === 'house') return 'house';
  return 'room';
}

/** One line for the public page (D-252: the full address; the unit number only when the owner shows it). */
export function addressLine(address: unknown, unitNo: string | null): string | null {
  const a = (address ?? {}) as Record<string, string | null | undefined>;
  const parts = [a.line1, a.subdistrict, a.district, [a.province, a.postcode].filter(Boolean).join(' ')]
    .map((part) => (part ?? '').trim())
    .filter(Boolean);
  if (!parts.length) return null;
  return [unitNo, ...parts].filter(Boolean).join(', ');
}

/**
 * Rental listings of the owner surface (B7.2, D-252): a listing is drafted from a unit (its searchable facts are
 * copied and refreshed on every save), gets photos (documents of kind `listing_photo`, cleaned by the scan job) and
 * viewing availability, and is submitted — published at once when nothing needs a look, otherwise queued for a
 * moderator with its reasons (first listing of an unverified owner, a rent far from the district median, flagged
 * words; every rule a setting). One live listing per unit. Pause, resume and close are the owner's.
 */
@Injectable()
export class ListingsService {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private include = {
    photos: {
      orderBy: { sortOrder: 'asc' },
      include: { document: { select: { width: true, height: true, storageKey: true } } },
    },
    availability: { select: { weekly: true, exceptions: true, slotMinutes: true } },
  } satisfies Prisma.ListingInclude;

  private async found(tx: Tx, ctx: TenantContext, id: string): Promise<ListingWithParts> {
    const listing = await tx.listing.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: this.include,
    });
    if (!listing) throw new DomainException('http.not_found');
    return listing;
  }

  /**
   * The unit's searchable facts, read through the tenant's own visibility (a unit it cannot see is a 404). G2
   * (D-293): an agency lists another tenant's unit under its active mandate — the facts are then read as the platform
   * once the mandate is checked (a unit grant does not show the building row), and the mandate is returned.
   */
  private async snapshot(tx: Tx, ctx: TenantContext, unitId: string, showUnitNo: boolean) {
    let mandateId: string | null = null;
    let unit = await tx.unit.findFirst({
      where: { id: unitId, tenantId: ctx.tenantId, deletedAt: null },
      include: { building: { include: { property: true } } },
    });
    let detail = unit ? await tx.unitDetail.findUnique({ where: { unitId } }) : null;
    if (!unit) {
      const mandate = await tx.listingMandate.findFirst({
        where: { tenantId: ctx.tenantId, unitId, state: 'active' },
        select: { id: true },
      });
      if (!mandate) throw new DomainException('http.not_found');
      mandateId = mandate.id;
      [unit, detail] = await this.db.platform(async (p) => [
        await p.unit.findFirst({
          where: { id: unitId, deletedAt: null },
          include: { building: { include: { property: true } } },
        }),
        await p.unitDetail.findUnique({ where: { unitId } }),
      ]);
      if (!unit) throw new DomainException('http.not_found');
    }
    const address = (unit.building.address ?? unit.building.property.address ?? {}) as Record<
      string,
      string | null
    >;
    const kind = kindOf(detail?.kind, unit.type);
    return {
      mandateId,
      buildingId: unit.buildingId,
      unitKind: kind,
      sizeSqm: unit.areaSqm,
      bedrooms: detail?.bedrooms ?? null,
      bathrooms: detail?.bathrooms ?? null,
      floorLabel: detail?.floorLabel ?? null,
      province: address.province ?? null,
      district: address.district ?? null,
      addressText: addressLine(address, showUnitNo ? unit.unitNo : null),
      lat: unit.building.property.lat,
      lng: unit.building.property.lng,
      furnishing: detail?.furnishing ?? null,
    };
  }

  private fields(input: ListingFields): Prisma.ListingUncheckedUpdateInput {
    const data: Prisma.ListingUncheckedUpdateInput = {};
    if (input.titleTh !== undefined) data.titleTh = input.titleTh.trim();
    if (input.titleEn !== undefined) data.titleEn = input.titleEn?.trim() || null;
    if (input.descriptionTh !== undefined) data.descriptionTh = input.descriptionTh.trim();
    if (input.descriptionEn !== undefined) data.descriptionEn = input.descriptionEn?.trim() || null;
    if (input.rent !== undefined) {
      const rent = new Decimal(input.rent);
      if (rent.lte(0)) throw invalid('rent', 'rent must be above zero', 'min');
      data.rent = rent.toFixed(2);
    }
    if (input.depositMonths !== undefined) data.depositMonths = input.depositMonths;
    if (input.advanceMonths !== undefined) data.advanceMonths = input.advanceMonths;
    if (input.minTermMonths !== undefined) data.minTermMonths = input.minTermMonths;
    if (input.availableFrom !== undefined)
      data.availableFrom = input.availableFrom ? new Date(`${input.availableFrom}T00:00:00Z`) : null;
    if (input.furnishing !== undefined) data.furnishing = input.furnishing;
    if (input.petsAllowed !== undefined) data.petsAllowed = input.petsAllowed;
    if (input.smokingAllowed !== undefined) data.smokingAllowed = input.smokingAllowed;
    if (input.facilities !== undefined)
      data.facilities = [...new Set(input.facilities.map((f) => f.trim()).filter(Boolean))].slice(0, 40);
    if (input.showUnitNo !== undefined) data.showUnitNo = input.showUnitNo;
    if (input.showUtilityHistory !== undefined) data.showUtilityHistory = input.showUtilityHistory;
    if (input.transit !== undefined) {
      data.transitName = input.transit?.name.trim() || null;
      data.transitLine = input.transit?.line?.trim() || null;
      data.transitDistanceM = input.transit ? input.transit.distanceM : null;
    }
    return data;
  }

  async list(ctx: TenantContext, filter: { state?: Listing['state']; unitId?: string } = {}) {
    return this.db.tenant(
      ctx,
      async (tx) =>
        (await tx.listing.findMany({
          where: { tenantId: ctx.tenantId, state: filter.state, unitId: filter.unitId },
          include: this.include,
          orderBy: { createdAt: 'desc' },
        })) as ListingWithParts[],
    );
  }

  async get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.found(tx, ctx, id));
  }

  async create(ctx: TenantContext, input: ListingCreateInput) {
    return this.db.tenant(ctx, async (tx) => {
      const now = this.clock.now();
      const id = uuidv7(now.getTime());
      const snap = await this.snapshot(tx, ctx, input.unitId, input.showUnitNo ?? false);
      const fields = this.fields(input) as Prisma.ListingUncheckedCreateInput;
      const slug = `${KIND_SLUG[snap.unitKind]}-${snap.bedrooms ?? 0}br-${id.replace(/-/g, '').slice(-10)}`;
      const { furnishing, ...facts } = snap;
      await tx.listing.create({
        data: {
          ...fields,
          ...facts,
          furnishing: input.furnishing === undefined ? furnishing : input.furnishing,
          id,
          tenantId: ctx.tenantId,
          unitId: input.unitId,
          slug,
          titleTh: input.titleTh.trim(),
          rent: new Decimal(input.rent).toFixed(2),
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await tx.listingAvailability.create({ data: { listingId: id, tenantId: ctx.tenantId } });
      await this.audit.record(tx, {
        action: 'listing.created',
        tenantId: ctx.tenantId,
        buildingId: snap.buildingId,
        subjectType: 'ops.listing',
        subjectId: id,
        after: { unitId: input.unitId, slug, rent: new Decimal(input.rent).toFixed(2) },
      });
      return this.found(tx, ctx, id);
    });
  }

  async update(ctx: TenantContext, id: string, input: ListingFields) {
    const result = await this.db.tenant(ctx, async (tx) => {
      const listing = await this.found(tx, ctx, id);
      if (!(EDITABLE as readonly string[]).includes(listing.state))
        throw new DomainException('listing.invalid_state');
      const snap = await this.snapshot(tx, ctx, listing.unitId, input.showUnitNo ?? listing.showUnitNo);
      const { furnishing: _unitFurnishing, ...facts } = snap;
      void _unitFurnishing;
      await tx.listing.update({
        where: { id },
        data: {
          ...this.fields(input),
          ...facts,
          updatedBy: userIdOf(RequestContext.actor()),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'listing.updated',
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: id,
        after: { fields: Object.keys(input) },
      });
      const updated = await this.found(tx, ctx, id);
      // G4 (D-288): a new rent of a public listing edits its Facebook Page posts
      if (listing.state === 'published' && !updated.rent.equals(listing.rent))
        await this.events.record(tx, {
          type: 'listing.price_changed',
          aggregateType: 'listing',
          aggregateId: id,
          tenantId: ctx.tenantId,
          buildingId: listing.buildingId,
          payload: { listingId: id, unitId: listing.unitId, rent: updated.rent.toFixed(2) },
        });
      return { listing: updated, wasPublic: listing.state === 'published' };
    });
    // A published listing whose new words need a look goes back to the queue (hidden until approved).
    if (result.wasPublic) {
      const reasons = await this.reviewReasons(ctx, result.listing, { contentOnly: true });
      if (reasons.length) return this.toReview(ctx, id, reasons);
    }
    return result.listing;
  }

  // ------------------------------------------------------------------------------------------------- photos

  async addPhoto(ctx: TenantContext, id: string, input: { documentId: string; caption?: string | null }) {
    return this.db.tenant(ctx, async (tx) => {
      const listing = await this.found(tx, ctx, id);
      if (listing.state === 'closed') throw new DomainException('listing.invalid_state');
      const max = await this.settings.valueAt<number>('listing.photos.max', this.clock.now());
      if (listing.photos.length >= max)
        throw invalid('documentId', `a listing has at most ${max} photos`, 'max');
      const doc = await tx.document.findFirst({
        where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!doc || doc.kind !== 'listing_photo' || doc.scanStatus !== 'clean')
        throw new DomainException('listing.photo_invalid');
      if (listing.photos.some((p) => p.documentId === doc.id)) throw new DomainException('http.conflict');
      await tx.listingPhoto.create({
        data: {
          tenantId: ctx.tenantId,
          listingId: id,
          documentId: doc.id,
          sortOrder: listing.photos.length,
          caption: input.caption?.trim() || null,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      return this.found(tx, ctx, id);
    });
  }

  async removePhoto(ctx: TenantContext, id: string, photoId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const listing = await this.found(tx, ctx, id);
      if (!listing.photos.some((p) => p.id === photoId)) throw new DomainException('http.not_found');
      await tx.listingPhoto.delete({ where: { id: photoId } });
      const rest = listing.photos.filter((p) => p.id !== photoId);
      for (const [index, photo] of rest.entries())
        if (photo.sortOrder !== index)
          await tx.listingPhoto.update({ where: { id: photo.id }, data: { sortOrder: index } });
      return this.found(tx, ctx, id);
    });
  }

  /** New order (every photo id once) and captions; the first photo is the cover. */
  async arrangePhotos(ctx: TenantContext, id: string, photos: { id: string; caption?: string | null }[]) {
    return this.db.tenant(ctx, async (tx) => {
      const listing = await this.found(tx, ctx, id);
      const ids = new Set(listing.photos.map((p) => p.id));
      if (
        photos.length !== ids.size ||
        photos.some((p) => !ids.has(p.id)) ||
        new Set(photos.map((p) => p.id)).size !== ids.size
      )
        throw invalid('photos', 'list every photo of the listing exactly once');
      for (const [index, photo] of photos.entries())
        await tx.listingPhoto.update({
          where: { id: photo.id },
          data: {
            sortOrder: index,
            ...(photo.caption !== undefined ? { caption: photo.caption?.trim() || null } : {}),
          },
        });
      return this.found(tx, ctx, id);
    });
  }

  // ------------------------------------------------------------------------------------------- availability

  async setAvailability(ctx: TenantContext, id: string, input: AvailabilityInput) {
    for (const [i, slot] of input.weekly.entries()) {
      if (!Number.isInteger(slot.weekday) || slot.weekday < 0 || slot.weekday > 6)
        throw invalid(`weekly.${i}.weekday`, 'weekday is 0 (Sunday) … 6');
      if (!HHMM.test(slot.from) || !HHMM.test(slot.to) || slot.from >= slot.to)
        throw invalid(`weekly.${i}`, 'from and to are HH:MM with from before to');
      if (slot.mode !== undefined && slot.mode !== 'accompanied' && slot.mode !== 'self')
        throw invalid(`weekly.${i}.mode`, 'mode is accompanied or self');
    }
    for (const [i, ex] of (input.exceptions ?? []).entries()) {
      if (!DAY.test(ex.date)) throw invalid(`exceptions.${i}.date`, 'date is YYYY-MM-DD');
      if (!ex.closed && (!ex.from || !ex.to || !HHMM.test(ex.from) || !HHMM.test(ex.to) || ex.from >= ex.to))
        throw invalid(`exceptions.${i}`, 'an exception is closed or has from and to (HH:MM)');
    }
    return this.db.tenant(ctx, async (tx) => {
      await this.found(tx, ctx, id);
      await tx.listingAvailability.update({
        where: { listingId: id },
        data: {
          weekly: input.weekly.map((w) => ({
            weekday: w.weekday,
            from: w.from,
            to: w.to,
            ...(w.mode === 'self' ? { mode: 'self' } : {}),
          })),
          exceptions: (input.exceptions ?? []) as unknown as Prisma.InputJsonValue,
          ...(input.slotMinutes ? { slotMinutes: input.slotMinutes } : {}),
          updatedBy: userIdOf(RequestContext.actor()),
        },
      });
      return this.found(tx, ctx, id);
    });
  }

  // -------------------------------------------------------------------------------------------- submit & life

  /** Whether the unit's owner is verified (an approved verification of this tenant for the unit). */
  async verified(tx: Tx, tenantId: string, unitId: string): Promise<boolean> {
    const row = await tx.listingVerification.findFirst({
      where: { tenantId, unitId, state: 'approved' },
      select: { id: true },
    });
    return Boolean(row);
  }

  /** The review rules of D-252 (all settings). `contentOnly`: the words check alone (edits of a public listing). */
  private async reviewReasons(
    ctx: TenantContext,
    listing: Listing,
    options: { contentOnly?: boolean } = {},
  ): Promise<ReviewReason[]> {
    const now = this.clock.now();
    const reasons: ReviewReason[] = [];
    const words = await this.settings.valueAt<string[]>('listing.review.flagged_words', now);
    const text = [listing.titleTh, listing.titleEn, listing.descriptionTh, listing.descriptionEn]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    if (words.some((word) => text.includes(word.toLowerCase()))) reasons.push('flagged_words');
    if (options.contentOnly) return reasons;

    const [firstRule, outlierPct, comparablesMin] = await Promise.all([
      this.settings.valueAt<boolean>('listing.review.first_listing', now),
      this.settings.valueAt<number>('listing.review.price_outlier_percent', now),
      this.settings.valueAt<number>('listing.review.comparables_min', now),
    ]);
    await this.db.platform(async (tx) => {
      // G2: an agency's listing counts the unit owner's verification (D-293)
      const verifier = listing.mandateId
        ? ((await tx.listingMandate.findUnique({ where: { id: listing.mandateId } }))?.ownerTenantId ??
          ctx.tenantId)
        : ctx.tenantId;
      if (firstRule && !(await this.verified(tx, verifier, listing.unitId))) {
        const before = await tx.listing.count({
          where: { tenantId: ctx.tenantId, publishedAt: { not: null }, id: { not: listing.id } },
        });
        if (before === 0) reasons.push('first_listing');
      }
      if (outlierPct > 0 && listing.district && listing.unitKind) {
        const rows = await tx.$queryRaw<{ n: bigint; median: Prisma.Decimal | null }[]>`
          SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY rent)::numeric(14,2) AS median
            FROM ops.listing
           WHERE state = 'published' AND hidden_at IS NULL AND id <> ${listing.id}::uuid
             AND district = ${listing.district} AND unit_kind = ${listing.unitKind}::ops.portfolio_unit_kind`;
        const { n, median } = rows[0] ?? { n: 0n, median: null };
        if (median && Number(n) >= comparablesMin) {
          const m = new Decimal(median.toString());
          const low = m.mul(1 - outlierPct / 100);
          const high = m.mul(1 + outlierPct / 100);
          const rent = new Decimal(listing.rent.toString());
          if (rent.lt(low) || rent.gt(high)) reasons.push('price_outlier');
        }
      }
    });
    return reasons;
  }

  /** What is missing before a listing can be submitted (D-252: ≥ N photos, size, rooms, address, title, rent). */
  private async missing(
    listing: ListingWithParts,
  ): Promise<{ path: string; code: string; message: string }[]> {
    const min = await this.settings.valueAt<number>('listing.photos.min', this.clock.now());
    const errors: { path: string; code: string; message: string }[] = [];
    if (listing.photos.length < min)
      errors.push({ path: 'photos', code: 'min', message: `at least ${min} photos` });
    if (listing.sizeSqm === null)
      errors.push({ path: 'unit.areaSqm', code: 'required', message: 'the unit size' });
    if (listing.bedrooms === null)
      errors.push({ path: 'unit.bedrooms', code: 'required', message: 'bedrooms' });
    if (listing.bathrooms === null)
      errors.push({ path: 'unit.bathrooms', code: 'required', message: 'bathrooms' });
    if (!listing.province || !listing.addressText)
      errors.push({ path: 'unit.address', code: 'required', message: 'the address of the unit' });
    return errors;
  }

  async submit(ctx: TenantContext, id: string) {
    const listing = await this.db.tenant(ctx, async (tx) => {
      const current = await this.found(tx, ctx, id);
      if (current.state !== 'draft' && current.state !== 'rejected')
        throw new DomainException('listing.invalid_state');
      // refresh the unit's facts first: the landlord may have completed the unit since the draft
      const snap = await this.snapshot(tx, ctx, current.unitId, current.showUnitNo);
      const { furnishing: _f, ...facts } = snap;
      void _f;
      await tx.listing.update({ where: { id }, data: facts });
      const fresh = await this.found(tx, ctx, id);
      const errors = await this.missing(fresh);
      if (errors.length) throw new DomainException('listing.incomplete', { errors });
      const live = await this.db.platform((p) =>
        p.listing.findFirst({
          where: { unitId: current.unitId, state: { in: [...LIVE] }, id: { not: id } },
          select: { id: true },
        }),
      );
      if (live) throw new DomainException('listing.duplicate_unit');
      return fresh;
    });
    const reasons = await this.reviewReasons(ctx, listing);
    return reasons.length ? this.toReview(ctx, id, reasons) : this.publish(ctx, id, 'listing.submitted');
  }

  private async toReview(ctx: TenantContext, id: string, reasons: ReviewReason[]) {
    return this.db.tenant(ctx, async (tx) => {
      const listing = await this.found(tx, ctx, id);
      try {
        await tx.listing.update({
          where: { id },
          data: {
            state: 'pending_review',
            reviewReasons: reasons,
            rejectedReason: null,
            version: { increment: 1 },
          },
        });
      } catch (error) {
        throw this.duplicate(error);
      }
      await this.audit.record(tx, {
        action: 'listing.submitted',
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: id,
        before: { state: listing.state },
        after: { state: 'pending_review', reviewReasons: reasons },
      });
      await this.events.record(tx, {
        type: 'listing.review_requested',
        aggregateType: 'listing',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        payload: { listingId: id, unitId: listing.unitId, reasons },
      });
      return this.found(tx, ctx, id);
    });
  }

  private duplicate(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
      ? new DomainException('listing.duplicate_unit')
      : error;
  }

  private async publish(ctx: TenantContext, id: string, action: 'listing.submitted' | 'listing.published') {
    return this.db.tenant(ctx, async (tx) => {
      const listing = await this.found(tx, ctx, id);
      const now = this.clock.now();
      try {
        await tx.listing.update({
          where: { id },
          data: {
            state: 'published',
            publishedAt: now,
            reviewReasons: [],
            rejectedReason: null,
            pausedAt: null,
            version: { increment: 1 },
          },
        });
      } catch (error) {
        throw this.duplicate(error);
      }
      await this.audit.record(tx, {
        action,
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: id,
        before: { state: listing.state },
        after: { state: 'published' },
      });
      await this.events.record(tx, {
        type: 'listing.published',
        aggregateType: 'listing',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        payload: { listingId: id, unitId: listing.unitId, slug: listing.slug, rent: listing.rent.toFixed(2) },
      });
      return this.found(tx, ctx, id);
    });
  }

  async pause(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const listing = await this.found(tx, ctx, id);
      if (listing.state !== 'published') throw new DomainException('listing.invalid_state');
      await tx.listing.update({
        where: { id },
        data: { state: 'paused', pausedAt: this.clock.now(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'listing.paused',
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: id,
        before: { state: 'published' },
        after: { state: 'paused' },
      });
      await this.events.record(tx, {
        type: 'listing.paused',
        aggregateType: 'listing',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        payload: { listingId: id, unitId: listing.unitId },
      });
      return this.found(tx, ctx, id);
    });
  }

  async resume(ctx: TenantContext, id: string) {
    const listing = await this.get(ctx, id);
    if (listing.state !== 'paused' || listing.hiddenAt) throw new DomainException('listing.invalid_state');
    return this.publish(ctx, id, 'listing.published');
  }

  async close(ctx: TenantContext, id: string, reason: 'leased' | 'withdrawn' = 'withdrawn') {
    return this.db.tenant(ctx, async (tx) => {
      const listing = await this.found(tx, ctx, id);
      if (listing.state === 'closed') throw new DomainException('listing.invalid_state');
      await tx.listing.update({
        where: { id },
        data: {
          state: 'closed',
          closedAt: this.clock.now(),
          closedReason: reason,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'listing.closed',
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: id,
        before: { state: listing.state },
        after: { state: 'closed', reason },
      });
      await this.events.record(tx, {
        type: 'listing.closed',
        aggregateType: 'listing',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        payload: { listingId: id, unitId: listing.unitId, reason },
      });
      return this.found(tx, ctx, id);
    });
  }

  /**
   * B7.4 (D-253): "re-open the listing" — a new draft copied from a closed listing of the unit (texts, terms,
   * facilities, transit, photos in order, viewing times), the unit's facts refreshed. Submit it as usual.
   */
  async relist(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const from = await this.found(tx, ctx, id);
      if (from.state !== 'closed') throw new DomainException('listing.invalid_state');
      const now = this.clock.now();
      const newId = uuidv7(now.getTime());
      const snap = await this.snapshot(tx, ctx, from.unitId, from.showUnitNo);
      const { furnishing: _furnishing, ...facts } = snap;
      void _furnishing;
      const slug = `${KIND_SLUG[snap.unitKind]}-${snap.bedrooms ?? 0}br-${newId.replace(/-/g, '').slice(-10)}`;
      await tx.listing.create({
        data: {
          ...facts,
          id: newId,
          tenantId: ctx.tenantId,
          unitId: from.unitId,
          slug,
          titleTh: from.titleTh,
          titleEn: from.titleEn,
          descriptionTh: from.descriptionTh,
          descriptionEn: from.descriptionEn,
          rent: from.rent,
          depositMonths: from.depositMonths,
          advanceMonths: from.advanceMonths,
          minTermMonths: from.minTermMonths,
          furnishing: from.furnishing,
          petsAllowed: from.petsAllowed,
          smokingAllowed: from.smokingAllowed,
          facilities: from.facilities,
          showUnitNo: from.showUnitNo,
          showUtilityHistory: from.showUtilityHistory,
          transitName: from.transitName,
          transitLine: from.transitLine,
          transitDistanceM: from.transitDistanceM,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      for (const photo of from.photos)
        await tx.listingPhoto.create({
          data: {
            tenantId: ctx.tenantId,
            listingId: newId,
            documentId: photo.documentId,
            sortOrder: photo.sortOrder,
            caption: photo.caption,
          },
        });
      await tx.listingAvailability.create({
        data: {
          listingId: newId,
          tenantId: ctx.tenantId,
          weekly: from.availability?.weekly ?? [],
          exceptions: from.availability?.exceptions ?? [],
          slotMinutes: from.availability?.slotMinutes ?? 30,
        },
      });
      await this.audit.record(tx, {
        action: 'listing.created',
        tenantId: ctx.tenantId,
        buildingId: snap.buildingId,
        subjectType: 'ops.listing',
        subjectId: newId,
        after: { unitId: from.unitId, slug, relistedFrom: id },
      });
      return this.found(tx, ctx, newId);
    });
  }

  // ----------------------------------------------------------------------------------------- verification

  async verification(ctx: TenantContext, unitId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { id: unitId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!unit) throw new DomainException('http.not_found');
      return tx.listingVerification.findFirst({
        where: { tenantId: ctx.tenantId, unitId },
        orderBy: { submittedAt: 'desc' },
      });
    });
  }

  /** Ownership evidence for the "เจ้าของตัวจริง" badge (D-252): certificate documents of this tenant. */
  async requestVerification(
    ctx: TenantContext,
    unitId: string,
    input: {
      evidenceKind: 'title_deed' | 'condo_title' | 'sale_contract';
      documentIds: string[];
      note?: string | null;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { id: unitId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!unit) throw new DomainException('http.not_found');
      const ids = [...new Set(input.documentIds)];
      const docs = await tx.document.findMany({
        where: { id: { in: ids }, tenantId: ctx.tenantId, kind: 'certificate', deletedAt: null },
        select: { id: true, scanStatus: true, uploadState: true },
      });
      if (
        docs.length !== ids.length ||
        docs.some(
          (d) => d.scanStatus === 'infected' || d.scanStatus === 'failed' || d.uploadState === 'presigned',
        )
      )
        throw invalid('documentIds', 'uploaded certificate documents of this tenant');
      if (
        await tx.listingVerification.findFirst({ where: { unitId, state: 'pending' }, select: { id: true } })
      )
        throw new DomainException('listing.verification_pending');
      const row = await tx.listingVerification.create({
        data: {
          tenantId: ctx.tenantId,
          unitId,
          evidenceKind: input.evidenceKind,
          evidenceDocumentIds: ids,
          note: input.note?.trim() || null,
          submittedBy: userIdOf(RequestContext.actor()),
          submittedAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        action: 'listing.verification_submitted',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'platform.listing_verification',
        subjectId: row.id,
        after: { unitId, evidenceKind: input.evidenceKind, documents: ids.length },
      });
      return row;
    });
  }
}

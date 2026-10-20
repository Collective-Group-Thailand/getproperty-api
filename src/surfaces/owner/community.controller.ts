import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { CLOCK, type Clock } from '@core/clock/clock';
import {
  type Announcement,
  type BuildingRule,
  type Contact,
  type Facility,
  type Parcel,
} from '@generated/prisma/client';
import { AnnouncementsService } from '@modules/ops-community/announcements.service';
import {
  bookingPolicy,
  cleanAudience,
  cleanTranslations,
  localized,
} from '@modules/ops-community/community-rules';
import { type BookingRow, FacilitiesService } from '@modules/ops-community/facilities.service';
import { type ParcelRow, ParcelsService } from '@modules/ops-community/parcels.service';
import { ResidentCommunityService } from '@modules/ops-community/resident-community.service';
import { BuildingRulesService } from '@modules/ops-community/rules-contacts.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, type Surface, SURFACES } from '../surfaces';
import {
  AnnouncementCreateDto,
  AnnouncementDto,
  AnnouncementListQuery,
  AnnouncementReadsDto,
  AnnouncementUpdateDto,
  AvailabilityDto,
  AvailabilityQuery,
  BookingCreateDto,
  BookingDecisionDto,
  BookingDto,
  BookingRangeQuery,
  BookingsDto,
  type BookingStatusName,
  BuildingRuleCreateDto,
  BuildingRuleDto,
  BuildingRulesDto,
  ContactCreateDto,
  ContactDto,
  type ContactKindName,
  ContactQuery,
  ContactsDto,
  ContactUpdateDto,
  FacilitiesDto,
  FacilityCreateDto,
  FacilityDto,
  type FacilityKindName,
  FacilityQuery,
  FacilityUpdateDto,
  ParcelCreateDto,
  ParcelDto,
  ParcelListQuery,
  ParcelPickUpDto,
  type ParcelStatusName,
  type PickupConfirmationName,
  ResidentAnnouncementsDto,
  ResidentFacilityQuery,
  ResidentParcelsDto,
  ResidentRulesDto,
  RuleAckRequestDto,
  RuleAcksDto,
} from './community.dto';
import { ReasonDto } from './governance.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;

// ---------------------------------------------------------------------------------------------- mappers

const announcementDto = (a: Announcement & { _count?: { reads: number } }): AnnouncementDto => ({
  id: a.id,
  buildingId: a.buildingId,
  title: a.title,
  bodyTh: a.bodyTh,
  translations: cleanTranslations(a.translations),
  audienceFilter: cleanAudience(a.audienceFilter),
  pinned: a.pinned,
  publishedAt: isoOrNull(a.publishedAt),
  expiresAt: isoOrNull(a.expiresAt),
  archivedAt: isoOrNull(a.archivedAt),
  readCount: a._count?.reads ?? 0,
  version: a.version,
  createdAt: iso(a.createdAt),
});

const parcelDto = (p: ParcelRow | (Parcel & { unit: { unitNo: string } })): ParcelDto => ({
  id: p.id,
  buildingId: p.buildingId,
  unitId: p.unitId,
  unitNo: p.unit.unitNo,
  recipientPartyId: p.recipientPartyId,
  carrier: p.carrier,
  trackingNo: p.trackingNo,
  photoDocumentId: p.photoDocumentId,
  status: p.status as ParcelStatusName,
  receivedAt: iso(p.receivedAt),
  notifiedAt: isoOrNull(p.notifiedAt),
  pickedUpAt: isoOrNull(p.pickedUpAt),
  pickupConfirmedBy: p.pickupConfirmedBy as PickupConfirmationName | null,
  returnedAt: isoOrNull(p.returnedAt),
  returnReason: p.returnReason,
  notes: p.notes,
});

const facilityDto = (f: Facility): FacilityDto => ({
  id: f.id,
  buildingId: f.buildingId,
  name: f.name,
  kind: f.kind as FacilityKindName,
  capacity: f.capacity,
  bookingPolicy: bookingPolicy(f.bookingPolicy),
  isActive: f.isActive,
});

const bookingDto = (b: BookingRow): BookingDto => ({
  id: b.id,
  facilityId: b.facilityId,
  facilityName: b.facility.name,
  unitId: b.unitId,
  unitNo: b.unit.unitNo,
  startsAt: iso(b.startsAt),
  endsAt: iso(b.endsAt),
  status: b.status as BookingStatusName,
  cancelReason: b.cancelReason,
  note: b.note,
});

const ruleDto = (r: BuildingRule & { _count?: { acks: number } }): BuildingRuleDto => ({
  id: r.id,
  buildingId: r.buildingId,
  version: r.version,
  title: r.title,
  bodyTh: r.bodyTh,
  translations: cleanTranslations(r.translations),
  effectiveFrom: dateOnly(r.effectiveFrom)!,
  publishedAt: isoOrNull(r.publishedAt),
  acknowledgements: r._count?.acks ?? 0,
});

const contactDto = (c: Contact): ContactDto => ({
  id: c.id,
  buildingId: c.buildingId,
  kind: c.kind as ContactKindName,
  name: c.name,
  phone: c.phone,
  lineId: c.lineId,
  notes: c.notes,
  sortOrder: c.sortOrder,
});

// --------------------------------------------------------------------------------------------- examples

const ANNOUNCEMENT_EXAMPLE = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  title: 'งดจ่ายน้ำวันเสาร์',
  bodyTh: 'งดจ่ายน้ำเวลา 9:00–12:00 เพื่อล้างถังเก็บน้ำ',
  translations: { en: { title: 'Water outage on Saturday', body: 'No water from 9:00 to 12:00.' } },
  audienceFilter: {},
  pinned: true,
  publishedAt: FAKE.dateTime,
  expiresAt: null,
  archivedAt: null,
  readCount: 12,
  version: 2,
  createdAt: FAKE.dateTime,
};
const PARCEL_EXAMPLE = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  recipientPartyId: null,
  carrier: 'Kerry Express',
  trackingNo: 'KEX0000000001',
  photoDocumentId: FAKE.uuid,
  status: 'notified',
  receivedAt: FAKE.dateTime,
  notifiedAt: FAKE.dateTime,
  pickedUpAt: null,
  pickupConfirmedBy: null,
  returnedAt: null,
  returnReason: null,
  notes: null,
};
const POLICY_EXAMPLE = {
  slotMinutes: 60,
  openFrom: '08:00',
  openTo: '22:00',
  maxDurationMinutes: 120,
  maxAdvanceDays: 14,
  maxPerUnitPerWeek: 2,
  requiresApproval: false,
};
const FACILITY_EXAMPLE = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  name: 'ห้องประชุมชั้น 1',
  kind: 'meeting_room',
  capacity: 10,
  bookingPolicy: POLICY_EXAMPLE,
  isActive: true,
};
const BOOKING_EXAMPLE = {
  id: FAKE.uuid,
  facilityId: FAKE.uuid,
  facilityName: 'ห้องประชุมชั้น 1',
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  startsAt: '2026-11-03T10:00:00+07:00',
  endsAt: '2026-11-03T11:00:00+07:00',
  status: 'confirmed',
  cancelReason: null,
  note: null,
};
const RULE_EXAMPLE = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  version: 2,
  title: 'ระเบียบการอยู่อาศัย',
  bodyTh: 'ห้ามส่งเสียงดังหลัง 22:00 น.',
  translations: {},
  effectiveFrom: FAKE.date,
  publishedAt: FAKE.dateTime,
  acknowledgements: 30,
};
const CONTACT_EXAMPLE = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  kind: 'emergency',
  name: 'สำนักงานอาคาร',
  phone: FAKE.phone,
  lineId: '@getproperty',
  notes: null,
  sortOrder: 0,
};

// ======================================================================================== owner console

/** Announcements of the owner console (`/v1/owner/announcements`, B5.3, D-073). */
@ApiTags('owner.announcements')
@ApiSurface(SURFACES.owner)
@Controller('owner/announcements')
export class OwnerAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @TenantScoped()
  @Can('announcement.manage')
  @ApiEndpoint({
    id: 'owner.announcements.list',
    summary: 'Announcements',
    description: 'Drafts and published announcements (pinned first) with their read count.',
    implements: ['D-073'],
  })
  @ApiPaginated(AnnouncementDto, { example: ANNOUNCEMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: AnnouncementListQuery,
  ): Promise<Page<AnnouncementDto>> {
    const { rows, total } = await this.announcements.list(ctx, { ...q, ...toSkipTake(q) });
    return paginated(rows.map(announcementDto), total, q);
  }

  @Post()
  @TenantScoped()
  @Can('announcement.manage')
  @ApiEndpoint({
    id: 'owner.announcements.create',
    summary: 'Write an announcement',
    description:
      'For a building or every building, in Thai with translations (en, my, km, lo, zh) and an optional audience (floors / units); `publish: true` publishes it now — a LINE push to the residents in the audience (quiet hours and consent apply).',
    implements: ['D-073', 'D-014'],
  })
  @ApiJsonBody(AnnouncementCreateDto, {
    buildingId: FAKE.buildingId,
    title: 'งดจ่ายน้ำวันเสาร์',
    bodyTh: 'งดจ่ายน้ำเวลา 9:00–12:00 เพื่อล้างถังเก็บน้ำ',
    translations: { en: { title: 'Water outage on Saturday', body: 'No water from 9:00 to 12:00.' } },
    pinned: true,
    publish: true,
  })
  @ApiSuccess(201, { description: 'Created', type: AnnouncementDto, example: ANNOUNCEMENT_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'auth.forbidden')
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: AnnouncementCreateDto,
  ): Promise<AnnouncementDto> {
    return announcementDto(
      await this.announcements.create(ctx, {
        ...body,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      }),
    );
  }

  @Get(':announcementId')
  @TenantScoped()
  @Can('announcement.manage')
  @ApiEndpoint({
    id: 'owner.announcements.get',
    summary: 'One announcement',
    description: 'With its translations, audience and read count.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'The announcement', type: AnnouncementDto, example: ANNOUNCEMENT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('announcementId', ParseUUIDPipe) id: string,
  ): Promise<AnnouncementDto> {
    return announcementDto(await this.announcements.get(ctx, id));
  }

  @Patch(':announcementId')
  @TenantScoped()
  @Can('announcement.manage')
  @ApiEndpoint({
    id: 'owner.announcements.update',
    summary: 'Change an announcement',
    description:
      'A draft changes entirely; a published one only its pin and expiry (409 `announcement.published` otherwise).',
    implements: ['D-073'],
  })
  @ApiJsonBody(AnnouncementUpdateDto, { pinned: false })
  @ApiSuccess(200, { description: 'Changed', type: AnnouncementDto, example: ANNOUNCEMENT_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'announcement.published')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('announcementId', ParseUUIDPipe) id: string,
    @Body() body: AnnouncementUpdateDto,
  ): Promise<AnnouncementDto> {
    return announcementDto(
      await this.announcements.update(ctx, id, {
        ...body,
        expiresAt:
          body.expiresAt === undefined ? undefined : body.expiresAt ? new Date(body.expiresAt) : null,
      }),
    );
  }

  @Post(':announcementId/actions/publish')
  @HttpCode(200)
  @TenantScoped()
  @Can('announcement.manage')
  @ApiEndpoint({
    id: 'owner.announcements.publish',
    summary: 'Publish a draft',
    description:
      'LINE push to the residents in the audience (quiet hours, consent, the announcements topic).',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'Published', type: AnnouncementDto, example: ANNOUNCEMENT_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'announcement.published')
  async publish(
    @CurrentTenant() ctx: TenantContext,
    @Param('announcementId', ParseUUIDPipe) id: string,
  ): Promise<AnnouncementDto> {
    return announcementDto(await this.announcements.publish(ctx, id));
  }

  @Post(':announcementId/actions/archive')
  @HttpCode(200)
  @TenantScoped()
  @Can('announcement.manage')
  @ApiEndpoint({
    id: 'owner.announcements.archive',
    summary: 'Take an announcement down',
    description: 'Residents stop seeing it; it stays in the history with its read receipts.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, {
    description: 'Archived',
    type: AnnouncementDto,
    example: { ...ANNOUNCEMENT_EXAMPLE, pinned: false, archivedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(...WRITE)
  async archive(
    @CurrentTenant() ctx: TenantContext,
    @Param('announcementId', ParseUUIDPipe) id: string,
  ): Promise<AnnouncementDto> {
    return announcementDto(await this.announcements.archive(ctx, id));
  }

  @Get(':announcementId/reads')
  @TenantScoped()
  @Can('announcement.manage')
  @ApiEndpoint({
    id: 'owner.announcements.reads',
    summary: 'Read receipts',
    description: 'Who read it and when, against the number of residents in the audience today.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, {
    description: 'Receipts',
    type: AnnouncementReadsDto,
    example: { audience: 40, data: [{ partyId: FAKE.uuid, name: FAKE.nameTh, readAt: FAKE.dateTime }] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async reads(
    @CurrentTenant() ctx: TenantContext,
    @Param('announcementId', ParseUUIDPipe) id: string,
  ): Promise<AnnouncementReadsDto> {
    const r = await this.announcements.reads(ctx, id);
    return {
      audience: r.audience,
      data: r.reads.map((x) => ({ partyId: x.partyId, name: x.party.displayName, readAt: iso(x.readAt) })),
    };
  }
}

/** Parcels at the desk (`/v1/{owner,staff}/parcels`, B5.3, D-073). */
export function parcelsController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.parcels`)
  @ApiSurface(SURFACES[surface])
  @Controller(`${surface}/parcels`)
  class ParcelsController {
    constructor(readonly parcels: ParcelsService) {}

    @Get()
    @TenantScoped()
    @Can('parcel.manage')
    @ApiEndpoint({
      id: `${surface}.parcels.list`,
      summary: 'Parcels',
      description: 'Parcels of my buildings, newest first; `open=true` = waiting for pick-up.',
      implements: ['D-073', 'D-090'],
    })
    @ApiPaginated(ParcelDto, { example: PARCEL_EXAMPLE })
    @ApiStandardErrors('validation.failed', ...T)
    async list(@CurrentTenant() ctx: TenantContext, @Query() q: ParcelListQuery): Promise<Page<ParcelDto>> {
      const { rows, total } = await this.parcels.list(ctx, { ...q, ...toSkipTake(q) });
      return paginated(rows.map(parcelDto), total, q);
    }

    @Post()
    @TenantScoped()
    @Can('parcel.manage')
    @ApiEndpoint({
      id: `${surface}.parcels.receive`,
      summary: 'Record a parcel',
      description:
        'For a unit with the photo staff took; the residents of the unit (or the named recipient) are told on LINE and get a pick-up PIN in the app.',
      implements: ['D-073'],
    })
    @ApiJsonBody(ParcelCreateDto, {
      unitId: FAKE.uuid,
      carrier: 'Kerry Express',
      trackingNo: 'KEX0000000001',
      photoDocumentId: FAKE.uuid,
    })
    @ApiSuccess(201, {
      description: 'Recorded',
      type: ParcelDto,
      example: { ...PARCEL_EXAMPLE, status: 'received', notifiedAt: null },
    })
    @ApiStandardErrors(...WRITE)
    async receive(@CurrentTenant() ctx: TenantContext, @Body() body: ParcelCreateDto): Promise<ParcelDto> {
      return parcelDto(await this.parcels.receive(ctx, body));
    }

    @Get(':parcelId')
    @TenantScoped()
    @Can('parcel.manage')
    @ApiEndpoint({
      id: `${surface}.parcels.get`,
      summary: 'One parcel',
      description: 'The parcel and its hand-over.',
      implements: ['D-073'],
    })
    @ApiSuccess(200, { description: 'The parcel', type: ParcelDto, example: PARCEL_EXAMPLE })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async get(
      @CurrentTenant() ctx: TenantContext,
      @Param('parcelId', ParseUUIDPipe) id: string,
    ): Promise<ParcelDto> {
      return parcelDto(await this.parcels.get(ctx, id));
    }

    @Post(':parcelId/actions/pick-up')
    @HttpCode(200)
    @TenantScoped()
    @Can('parcel.manage')
    @ApiEndpoint({
      id: `${surface}.parcels.pickUp`,
      summary: 'Hand a parcel over',
      description:
        'With the PIN the resident shows (422 `parcel.pin_mismatch` for a wrong one) or `staffConfirmed: true` (recorded as a staff hand-over).',
      implements: ['D-073'],
    })
    @ApiJsonBody(ParcelPickUpDto, { pin: '482913' })
    @ApiSuccess(200, {
      description: 'Picked up',
      type: ParcelDto,
      example: {
        ...PARCEL_EXAMPLE,
        status: 'picked_up',
        pickedUpAt: FAKE.dateTime,
        pickupConfirmedBy: 'resident_pin',
      },
    })
    @ApiStandardErrors(...WRITE, 'parcel.invalid_state', 'parcel.pin_mismatch')
    async pickUp(
      @CurrentTenant() ctx: TenantContext,
      @Param('parcelId', ParseUUIDPipe) id: string,
      @Body() body: ParcelPickUpDto,
    ): Promise<ParcelDto> {
      return parcelDto(await this.parcels.pickUp(ctx, id, body));
    }

    @Post(':parcelId/actions/return')
    @HttpCode(200)
    @TenantScoped()
    @Can('parcel.manage')
    @ApiEndpoint({
      id: `${surface}.parcels.return`,
      summary: 'Return a parcel to the carrier',
      description: 'An unclaimed parcel, with a reason.',
      implements: ['D-073'],
    })
    @ApiJsonBody(ReasonDto, { reason: 'ไม่มีผู้มารับเกิน 14 วัน' })
    @ApiSuccess(200, {
      description: 'Returned',
      type: ParcelDto,
      example: {
        ...PARCEL_EXAMPLE,
        status: 'returned',
        returnedAt: FAKE.dateTime,
        returnReason: 'ไม่มีผู้มารับ',
      },
    })
    @ApiStandardErrors(...WRITE, 'parcel.invalid_state')
    async returnParcel(
      @CurrentTenant() ctx: TenantContext,
      @Param('parcelId', ParseUUIDPipe) id: string,
      @Body() body: ReasonDto,
    ): Promise<ParcelDto> {
      return parcelDto(await this.parcels.returnToSender(ctx, id, body.reason));
    }
  }
  return ParcelsController;
}

/** Facilities and their bookings (`/v1/owner/facilities`, `/v1/owner/facility-bookings`, blueprint A1.6). */
@ApiTags('owner.facilities')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerFacilitiesController {
  constructor(
    private readonly facilities: FacilitiesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('facilities')
  @TenantScoped()
  @Can('community.read')
  @ApiEndpoint({
    id: 'owner.facilities.list',
    summary: 'Facilities',
    description: 'Common facilities of my buildings with their booking policy.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'Facilities', type: FacilitiesDto, example: { data: [FACILITY_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: FacilityQuery): Promise<FacilitiesDto> {
    return { data: (await this.facilities.list(ctx, { ...q, includeInactive: true })).map(facilityDto) };
  }

  @Post('facilities')
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.facilities.create',
    summary: 'Add a facility',
    description:
      'Meeting room, fitness, pool, BBQ, visitor parking …; the policy sets slots, opening hours, the longest booking, how far ahead, the weekly quota per unit and whether bookings need approval.',
    implements: ['D-073'],
  })
  @ApiJsonBody(FacilityCreateDto, {
    buildingId: FAKE.buildingId,
    name: 'ห้องประชุมชั้น 1',
    kind: 'meeting_room',
    capacity: 10,
    bookingPolicy: POLICY_EXAMPLE,
  })
  @ApiSuccess(201, { description: 'Created', type: FacilityDto, example: FACILITY_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: FacilityCreateDto): Promise<FacilityDto> {
    return facilityDto(await this.facilities.create(ctx, body));
  }

  @Patch('facilities/:facilityId')
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.facilities.update',
    summary: 'Change a facility',
    description: 'Name, kind, capacity, policy (merged), open or closed for bookings.',
    implements: ['D-073'],
  })
  @ApiJsonBody(FacilityUpdateDto, { bookingPolicy: { requiresApproval: true } })
  @ApiSuccess(200, { description: 'Changed', type: FacilityDto, example: FACILITY_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('facilityId', ParseUUIDPipe) id: string,
    @Body() body: FacilityUpdateDto,
  ): Promise<FacilityDto> {
    return facilityDto(await this.facilities.update(ctx, id, body));
  }

  @Get('facilities/:facilityId/bookings')
  @TenantScoped()
  @Can('community.read')
  @ApiEndpoint({
    id: 'owner.facilities.bookings',
    summary: 'Bookings of a facility',
    description: 'Bookings overlapping the range (default: the next 31 days).',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'Bookings', type: BookingsDto, example: { data: [BOOKING_EXAMPLE] } })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async bookings(
    @CurrentTenant() ctx: TenantContext,
    @Param('facilityId', ParseUUIDPipe) id: string,
    @Query() q: BookingRangeQuery,
  ): Promise<BookingsDto> {
    const from = q.from ? new Date(q.from) : this.clock.now();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 31 * 86_400_000);
    return { data: (await this.facilities.bookings(ctx, id, { from, to })).map(bookingDto) };
  }

  private async decide(
    ctx: TenantContext,
    id: string,
    action: 'approve' | 'reject' | 'cancel' | 'no_show',
    reason?: string | null,
  ): Promise<BookingDto> {
    return bookingDto(await this.facilities.decide(ctx, id, action, reason));
  }

  @Post('facility-bookings/:bookingId/actions/approve')
  @HttpCode(200)
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.facilityBookings.approve',
    summary: 'Approve a booking',
    description: 'A requested booking of a facility that needs approval becomes confirmed.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'Confirmed', type: BookingDto, example: BOOKING_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'facility.booking_invalid_state')
  approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('bookingId', ParseUUIDPipe) id: string,
  ): Promise<BookingDto> {
    return this.decide(ctx, id, 'approve');
  }

  @Post('facility-bookings/:bookingId/actions/reject')
  @HttpCode(200)
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.facilityBookings.reject',
    summary: 'Reject a booking',
    description: 'A requested booking is refused with an optional reason (the slot frees up).',
    implements: ['D-073'],
  })
  @ApiJsonBody(BookingDecisionDto, { reason: 'ปิดปรับปรุง' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: BookingDto,
    example: { ...BOOKING_EXAMPLE, status: 'cancelled', cancelReason: 'ปิดปรับปรุง' },
  })
  @ApiStandardErrors(...WRITE, 'facility.booking_invalid_state')
  reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('bookingId', ParseUUIDPipe) id: string,
    @Body() body: BookingDecisionDto,
  ): Promise<BookingDto> {
    return this.decide(ctx, id, 'reject', body.reason);
  }

  @Post('facility-bookings/:bookingId/actions/cancel')
  @HttpCode(200)
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.facilityBookings.cancel',
    summary: 'Cancel a booking',
    description: 'A requested or confirmed booking is cancelled (the slot frees up).',
    implements: ['D-073'],
  })
  @ApiJsonBody(BookingDecisionDto, { reason: 'ปิดปรับปรุง' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: BookingDto,
    example: { ...BOOKING_EXAMPLE, status: 'cancelled' },
  })
  @ApiStandardErrors(...WRITE, 'facility.booking_invalid_state')
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('bookingId', ParseUUIDPipe) id: string,
    @Body() body: BookingDecisionDto,
  ): Promise<BookingDto> {
    return this.decide(ctx, id, 'cancel', body.reason);
  }

  @Post('facility-bookings/:bookingId/actions/no-show')
  @HttpCode(200)
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.facilityBookings.noShow',
    summary: 'Mark a no-show',
    description: 'The unit did not come; recorded on the confirmed booking.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, {
    description: 'No-show',
    type: BookingDto,
    example: { ...BOOKING_EXAMPLE, status: 'no_show' },
  })
  @ApiStandardErrors(...WRITE, 'facility.booking_invalid_state')
  noShow(
    @CurrentTenant() ctx: TenantContext,
    @Param('bookingId', ParseUUIDPipe) id: string,
  ): Promise<BookingDto> {
    return this.decide(ctx, id, 'no_show');
  }
}

/** Building rules and contacts (`/v1/owner/buildings/{id}/rules`, `/v1/owner/contacts`, D-073). */
@ApiTags('owner.buildingRules')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerRulesContactsController {
  constructor(private readonly rules: BuildingRulesService) {}

  @Get('buildings/:buildingId/rules')
  @TenantScoped()
  @Can('community.read')
  @ApiEndpoint({
    id: 'owner.buildingRules.list',
    summary: 'Rule versions of a building',
    description: 'Every version, newest first, with how many residents acknowledged it.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'Versions', type: BuildingRulesDto, example: { data: [RULE_EXAMPLE] } })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async versions(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<BuildingRulesDto> {
    return { data: (await this.rules.versions(ctx, buildingId)).map(ruleDto) };
  }

  @Post('buildings/:buildingId/rules')
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.buildingRules.publish',
    summary: 'Publish a new version of the rules',
    description:
      'The next version, in force from its date (never backdated); residents are asked on LINE to read and acknowledge it, and new lessees acknowledge it when they sign (B2.3).',
    implements: ['D-073'],
  })
  @ApiJsonBody(BuildingRuleCreateDto, {
    title: 'ระเบียบการอยู่อาศัย',
    bodyTh: 'ห้ามส่งเสียงดังหลัง 22:00 น.',
    effectiveFrom: FAKE.date,
  })
  @ApiSuccess(201, {
    description: 'Published',
    type: BuildingRuleDto,
    example: { ...RULE_EXAMPLE, acknowledgements: 0 },
  })
  @ApiStandardErrors(...WRITE)
  async publish(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: BuildingRuleCreateDto,
  ): Promise<BuildingRuleDto> {
    return ruleDto(await this.rules.publish(ctx, buildingId, body));
  }

  @Get('building-rules/:ruleId/acknowledgements')
  @TenantScoped()
  @Can('community.read')
  @ApiEndpoint({
    id: 'owner.buildingRules.acknowledgements',
    summary: 'Who acknowledged a version',
    description: 'Residents who acknowledged it, with the lease it was given for and when.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, {
    description: 'Acknowledgements',
    type: RuleAcksDto,
    example: {
      data: [{ partyId: FAKE.uuid, name: FAKE.nameTh, leaseId: FAKE.uuid, ackedAt: FAKE.dateTime }],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async acknowledgements(
    @CurrentTenant() ctx: TenantContext,
    @Param('ruleId', ParseUUIDPipe) id: string,
  ): Promise<RuleAcksDto> {
    return {
      data: (await this.rules.acknowledgements(ctx, id)).map((a) => ({
        partyId: a.partyId,
        name: a.party.displayName,
        leaseId: a.leaseId,
        ackedAt: iso(a.ackedAt),
      })),
    };
  }

  @Get('contacts')
  @TenantScoped()
  @Can('community.read')
  @ApiEndpoint({
    id: 'owner.contacts.list',
    summary: 'Contacts',
    description: 'Emergency, building, vendor and utility contacts (of a building and the tenant-wide ones).',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'Contacts', type: ContactsDto, example: { data: [CONTACT_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', ...T)
  async contacts(@CurrentTenant() ctx: TenantContext, @Query() q: ContactQuery): Promise<ContactsDto> {
    return { data: (await this.rules.contacts(ctx, q)).map(contactDto) };
  }

  @Post('contacts')
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.contacts.create',
    summary: 'Add a contact',
    description: 'With a phone, a LINE id or a party; shown to the residents of the building.',
    implements: ['D-073'],
  })
  @ApiJsonBody(ContactCreateDto, {
    buildingId: FAKE.buildingId,
    kind: 'emergency',
    name: 'สำนักงานอาคาร',
    phone: FAKE.phone,
  })
  @ApiSuccess(201, { description: 'Added', type: ContactDto, example: CONTACT_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async createContact(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ContactCreateDto,
  ): Promise<ContactDto> {
    return contactDto(await this.rules.createContact(ctx, body));
  }

  @Patch('contacts/:contactId')
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.contacts.update',
    summary: 'Change a contact',
    description: 'Kind, name, phone, LINE id, notes, order.',
    implements: ['D-073'],
  })
  @ApiJsonBody(ContactUpdateDto, { phone: FAKE.phone })
  @ApiSuccess(200, { description: 'Changed', type: ContactDto, example: CONTACT_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async updateContact(
    @CurrentTenant() ctx: TenantContext,
    @Param('contactId', ParseUUIDPipe) id: string,
    @Body() body: ContactUpdateDto,
  ): Promise<ContactDto> {
    return contactDto(await this.rules.updateContact(ctx, id, body));
  }

  @Delete('contacts/:contactId')
  @HttpCode(204)
  @TenantScoped()
  @Can('community.manage')
  @ApiEndpoint({
    id: 'owner.contacts.remove',
    summary: 'Remove a contact',
    description: 'Residents no longer see it.',
    implements: ['D-073'],
  })
  @ApiSuccess(204, { description: 'Removed' })
  @ApiStandardErrors(...WRITE)
  async removeContact(
    @CurrentTenant() ctx: TenantContext,
    @Param('contactId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.rules.removeContact(ctx, id);
  }
}

// =============================================================================================== resident

/** Community in the LIFF (`/v1/resident/*`, B5.3, D-073). */
@ApiTags('resident.community')
@ApiSurface(SURFACES.resident)
@Controller('resident')
export class ResidentCommunityController {
  constructor(private readonly community: ResidentCommunityService) {}

  @Get('announcements')
  @ApiEndpoint({
    id: 'resident.community.announcements',
    summary: 'Announcements for me',
    description:
      'Published, not expired announcements of my units’ buildings (and tenant-wide ones) whose audience includes one of my units, pinned first, in my language when translated.',
    implements: ['D-073', 'D-014'],
  })
  @ApiSuccess(200, {
    description: 'Announcements',
    type: ResidentAnnouncementsDto,
    example: {
      data: [
        {
          id: FAKE.uuid,
          language: 'en',
          title: 'Water outage on Saturday',
          body: 'No water from 9:00 to 12:00.',
          pinned: true,
          publishedAt: FAKE.dateTime,
          readAt: null,
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed')
  async announcements(): Promise<ResidentAnnouncementsDto> {
    return {
      data: (await this.community.announcements()).map((a) => ({
        id: a.row.id,
        language: a.language,
        title: a.title,
        body: a.body,
        pinned: a.row.pinned,
        publishedAt: iso(a.row.publishedAt!),
        readAt: isoOrNull(a.readAt),
      })),
    };
  }

  @Post('announcements/:announcementId/actions/read')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.community.readAnnouncement',
    summary: 'Mark an announcement read',
    description: 'The read receipt of my party (the first read counts); 404 when it is not for me.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, {
    description: 'Read',
    type: ResidentAnnouncementsDto,
    example: {
      data: [
        {
          id: FAKE.uuid,
          language: 'th',
          title: 'งดจ่ายน้ำวันเสาร์',
          body: 'งดจ่ายน้ำเวลา 9:00–12:00',
          pinned: true,
          publishedAt: FAKE.dateTime,
          readAt: FAKE.dateTime,
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async read(@Param('announcementId', ParseUUIDPipe) id: string): Promise<ResidentAnnouncementsDto> {
    const a = await this.community.markRead(id);
    return {
      data: [
        {
          id: a.row.id,
          language: a.language,
          title: a.title,
          body: a.body,
          pinned: a.row.pinned,
          publishedAt: iso(a.row.publishedAt!),
          readAt: isoOrNull(a.readAt),
        },
      ],
    };
  }

  @Get('parcels')
  @ApiEndpoint({
    id: 'resident.community.parcels',
    summary: 'Parcels for my units',
    description:
      'Parcels of my units received since my current occupancy began (a former occupant’s parcels are never shown, D-224), newest first, with the pick-up PIN while the parcel waits at the desk.',
    implements: ['D-073', 'D-224'],
  })
  @ApiSuccess(200, {
    description: 'Parcels',
    type: ResidentParcelsDto,
    example: { data: [{ ...PARCEL_EXAMPLE, pin: '482913' }] },
  })
  @ApiStandardErrors('validation.failed')
  async parcels(): Promise<ResidentParcelsDto> {
    return { data: (await this.community.myParcels()).map((p) => ({ ...parcelDto(p), pin: p.pin })) };
  }

  @Get('facilities')
  @ApiEndpoint({
    id: 'resident.community.facilities',
    summary: 'Facilities of my building',
    description: 'Open facilities of the building of a unit I occupy, with their booking policy.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'Facilities', type: FacilitiesDto, example: { data: [FACILITY_EXAMPLE] } })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async facilities(@Query() q: ResidentFacilityQuery): Promise<FacilitiesDto> {
    return { data: (await this.community.facilitiesOf(q.unitId)).map(facilityDto) };
  }

  @Get('facilities/:facilityId/availability')
  @ApiEndpoint({
    id: 'resident.community.availability',
    summary: 'Busy times of a facility on a day',
    description: 'Booked times (no other unit is named; mine are marked) on a Bangkok calendar day.',
    implements: ['D-073', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Availability',
    type: AvailabilityDto,
    example: {
      facility: FACILITY_EXAMPLE,
      date: FAKE.date,
      busy: [
        {
          startsAt: '2026-11-03T10:00:00+07:00',
          endsAt: '2026-11-03T11:00:00+07:00',
          status: 'confirmed',
          mine: false,
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async availability(
    @Param('facilityId', ParseUUIDPipe) id: string,
    @Query() q: AvailabilityQuery,
  ): Promise<AvailabilityDto> {
    const r = await this.community.availability(id, q.date);
    return {
      facility: facilityDto(r.facility),
      date: q.date,
      busy: r.busy.map((b) => ({
        startsAt: iso(b.startsAt),
        endsAt: iso(b.endsAt),
        status: b.status as BookingStatusName,
        mine: b.mine,
      })),
    };
  }

  @Get('facility-bookings')
  @ApiEndpoint({
    id: 'resident.community.bookings',
    summary: 'My bookings',
    description: 'Bookings of my units made since my current occupancy began (D-224), newest first.',
    implements: ['D-073', 'D-224'],
  })
  @ApiSuccess(200, { description: 'Bookings', type: BookingsDto, example: { data: [BOOKING_EXAMPLE] } })
  @ApiStandardErrors('validation.failed')
  async bookings(): Promise<BookingsDto> {
    return { data: (await this.community.myBookings()).map(bookingDto) };
  }

  @Post('facility-bookings')
  @ApiEndpoint({
    id: 'resident.community.book',
    summary: 'Book a facility',
    description:
      'For a unit I occupy, in whole slots inside the opening hours and the weekly quota of my unit (422 `facility.quota_exceeded`); confirmed at once or waiting for approval; a slot someone already holds is 409 `facility.slot_taken`.',
    implements: ['D-073'],
  })
  @ApiJsonBody(BookingCreateDto, {
    facilityId: FAKE.uuid,
    unitId: FAKE.uuid,
    startsAt: '2026-11-03T10:00:00+07:00',
    endsAt: '2026-11-03T11:00:00+07:00',
  })
  @ApiSuccess(201, { description: 'Booked', type: BookingDto, example: BOOKING_EXAMPLE })
  @ApiStandardErrors(
    'http.not_found',
    'http.bad_request',
    'validation.failed',
    'facility.unavailable',
    'facility.quota_exceeded',
    'facility.slot_taken',
  )
  async book(@Body() body: BookingCreateDto): Promise<BookingDto> {
    return bookingDto(
      await this.community.book({
        facilityId: body.facilityId,
        unitId: body.unitId,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        note: body.note ?? null,
      }),
    );
  }

  @Post('facility-bookings/:bookingId/actions/cancel')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.community.cancelBooking',
    summary: 'Cancel my booking',
    description: 'A requested or confirmed booking of my unit.',
    implements: ['D-073'],
  })
  @ApiJsonBody(BookingDecisionDto, { reason: 'ติดธุระ' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: BookingDto,
    example: { ...BOOKING_EXAMPLE, status: 'cancelled' },
  })
  @ApiStandardErrors(
    'http.not_found',
    'http.bad_request',
    'validation.failed',
    'facility.booking_invalid_state',
  )
  async cancelBooking(
    @Param('bookingId', ParseUUIDPipe) id: string,
    @Body() body: BookingDecisionDto,
  ): Promise<BookingDto> {
    return bookingDto(await this.community.cancelBooking(id, body.reason ?? null));
  }

  @Get('building-rules')
  @ApiEndpoint({
    id: 'resident.community.rules',
    summary: 'The building rules in force',
    description:
      'The version in force for a unit I occupy, in my language when translated, and whether I acknowledged it.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, {
    description: 'Rules',
    type: ResidentRulesDto,
    example: {
      ruleId: FAKE.uuid,
      version: 2,
      title: 'ระเบียบการอยู่อาศัย',
      body: 'ห้ามส่งเสียงดังหลัง 22:00 น.',
      language: 'th',
      effectiveFrom: FAKE.date,
      acknowledgedAt: null,
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async rules(@Query() q: ResidentFacilityQuery): Promise<ResidentRulesDto> {
    return this.rulesDto(await this.community.rulesOf(q.unitId));
  }

  @Post('building-rules/actions/acknowledge')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.community.acknowledgeRules',
    summary: 'Acknowledge the building rules',
    description:
      'Records that I read the version in force (with my lease); 404 when the building has no rules.',
    implements: ['D-073'],
  })
  @ApiJsonBody(RuleAckRequestDto, { unitId: FAKE.uuid })
  @ApiSuccess(200, {
    description: 'Acknowledged',
    type: ResidentRulesDto,
    example: {
      ruleId: FAKE.uuid,
      version: 2,
      title: 'ระเบียบการอยู่อาศัย',
      body: 'ห้ามส่งเสียงดังหลัง 22:00 น.',
      language: 'th',
      effectiveFrom: FAKE.date,
      acknowledgedAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('http.not_found', 'http.bad_request', 'validation.failed')
  async acknowledge(@Body() body: RuleAckRequestDto): Promise<ResidentRulesDto> {
    return this.rulesDto(await this.community.acknowledge(body.unitId));
  }

  private rulesDto(r: Awaited<ReturnType<ResidentCommunityService['rulesOf']>>): ResidentRulesDto {
    if (!r.rule)
      return {
        ruleId: null,
        version: null,
        title: null,
        body: null,
        language: 'th',
        effectiveFrom: null,
        acknowledgedAt: null,
      };
    const text = localized(r.rule, r.rule.translations, r.language);
    return {
      ruleId: r.rule.id,
      version: r.rule.version,
      title: text.title,
      body: text.body,
      language: text.language,
      effectiveFrom: dateOnly(r.rule.effectiveFrom),
      acknowledgedAt: isoOrNull(r.acknowledgedAt),
    };
  }

  @Get('contacts')
  @ApiEndpoint({
    id: 'resident.community.contacts',
    summary: 'Contacts of my building',
    description: 'Emergency, building, vendor and utility contacts for a unit I occupy.',
    implements: ['D-073'],
  })
  @ApiSuccess(200, { description: 'Contacts', type: ContactsDto, example: { data: [CONTACT_EXAMPLE] } })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async contacts(@Query() q: ResidentFacilityQuery): Promise<ContactsDto> {
    return { data: (await this.community.contactsOf(q.unitId)).map(contactDto) };
  }
}

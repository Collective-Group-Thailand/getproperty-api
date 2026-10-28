import { Public } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page, PageQuery } from '@common/pagination/pagination.dto';
import { type RentalHandoff } from '@generated/prisma/client';
import { firstName, RentalHandoffsService } from '@modules/bridge-integrations/rental-handoffs.service';
import { type OfferRow, RelocationService } from '@modules/ops-listings/relocation.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiParam, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { type Request } from 'express';

import { FACTS_EXAMPLE, handoffFactsDto } from '../owner/growth-network.controller';
import { HandoffFactsDto, RentalHandoffStateName } from '../owner/growth-network.dto';
import { PublicListingSummaryDto, SUMMARY_EXAMPLE } from '../public/listings.controller';
import { ApiSurface, SURFACES } from '../surfaces';
import { MoneyInput, MoneyOutput } from './fields';
import { dateOnly, iso, isoOrNull } from './mappers';

const lang = (header: string | undefined): 'th' | 'en' =>
  header?.toLowerCase().startsWith('en') ? 'en' : 'th';
const TOKEN_PARAM = {
  name: 'token',
  example: 'q3K8xF0bW2yR9mT4vN6pL1sA7dE5gH0j',
  description: 'The token of the invitation link getbuild showed the buyer.',
};

// ------------------------------------------------------------------------------------------- public: handoff

export class PublicHandoffDto {
  @ApiProperty({
    enum: RentalHandoffStateName,
    enumName: 'RentalHandoffState',
    description:
      '`invited` = can be claimed; `expired` also when the date passed and the job has not run yet.',
  })
  state!: RentalHandoffStateName;

  @ApiProperty({ example: 'Somchai', description: 'Only the first name of the buyer (minimisation).' })
  buyerFirstName!: string;

  @ApiProperty({
    type: HandoffFactsDto,
    description: 'What the landlord wizard and the listing draft are prefilled with.',
  })
  facts!: HandoffFactsDto;

  @ApiProperty({ format: 'date' })
  transferDate!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

const PUBLIC_HANDOFF_EXAMPLE: PublicHandoffDto = {
  state: RentalHandoffStateName.Invited,
  buyerFirstName: 'Somchai',
  facts: FACTS_EXAMPLE,
  transferDate: FAKE.date,
  expiresAt: '2026-12-01T10:00:00+07:00',
};

/**
 * The buyer's side of a getbuild rental handoff (G8, D-299): open the invitation link (preview, no sign-in) or decline
 * it; claiming needs a landlord account (`POST /v1/owner/rental-handoffs/actions/claim`).
 */
@ApiTags('public.handoffs')
@ApiSurface(SURFACES.public)
@Controller('public/handoffs')
export class PublicHandoffsController {
  constructor(private readonly handoffs: RentalHandoffsService) {}

  private dto(r: RentalHandoff): PublicHandoffDto {
    return {
      state: this.handoffs.effectiveState(r) as RentalHandoffStateName,
      buyerFirstName: firstName(r.buyerDisplayName),
      facts: handoffFactsDto(r.facts),
      transferDate: dateOnly(r.transferDate)!,
      expiresAt: iso(r.expiresAt),
    };
  }

  @Get(':token')
  @Public()
  @ApiParam(TOKEN_PARAM)
  @ApiEndpoint({
    id: 'public.handoffs.get',
    summary: 'Preview a rental handoff invitation',
    description:
      'What getbuild told getproperty about the unit the buyer bought (project, place, size, rooms) and the invitation’s state — the buyer’s first name only, no contact data (D-025). Unknown token: 404 (D-299).',
    implements: ['D-289', 'D-299'],
  })
  @ApiSuccess(200, { description: 'Invitation', type: PublicHandoffDto, example: PUBLIC_HANDOFF_EXAMPLE })
  @ApiStandardErrors('http.not_found')
  async get(@Param('token') token: string): Promise<PublicHandoffDto> {
    return this.dto(await this.handoffs.preview(token));
  }

  @Post(':token/actions/decline')
  @HttpCode(200)
  @Public()
  @ApiParam(TOKEN_PARAM)
  @ApiEndpoint({
    id: 'public.handoffs.decline',
    summary: 'Decline a rental handoff invitation',
    description:
      'The buyer does not want to rent the unit out through getproperty: the invitation closes (a repeated decline answers the same). Claimed or expired: `handoff.invalid_state`; unknown token: 404 (D-299).',
    implements: ['D-299'],
  })
  @ApiSuccess(200, {
    description: 'Declined',
    type: PublicHandoffDto,
    example: { ...PUBLIC_HANDOFF_EXAMPLE, state: RentalHandoffStateName.Declined },
  })
  @ApiStandardErrors('http.not_found', 'handoff.invalid_state')
  async decline(@Param('token') token: string): Promise<PublicHandoffDto> {
    return this.dto(await this.handoffs.decline(token));
  }
}

// ------------------------------------------------------------------------------------------- admin: handoffs

export class AdminRentalHandoffListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: RentalHandoffStateName, enumName: 'RentalHandoffState' })
  @IsOptional()
  @IsEnum(RentalHandoffStateName)
  state?: RentalHandoffStateName;
}

export class AdminRentalHandoffDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RentalHandoffStateName, enumName: 'RentalHandoffState' })
  state!: RentalHandoffStateName;

  @ApiProperty({ example: FAKE.tenantId, description: 'The developer tenant in getbuild.' })
  developerRef!: string;

  @ApiProperty({ example: 'bldg-a' })
  buildingRef!: string;

  @ApiProperty({ example: 'u-101' })
  unitRef!: string;

  @ApiProperty({ format: 'date' })
  transferDate!: string;

  @ApiProperty({ example: 'getbuild:dev-campaign-2026' })
  campaignTag!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The landlord tenant that claimed it.',
  })
  tenantId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  listingId!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'getbuild received the link.',
  })
  deliveredAt!: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  deliveryAttempts!: number;

  @ApiProperty({ type: String, nullable: true, example: null })
  lastDeliveryError!: string | null;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

const adminHandoffDto = (r: RentalHandoff, state: RentalHandoff['state']): AdminRentalHandoffDto => ({
  id: r.id,
  state: state as RentalHandoffStateName,
  developerRef: r.developerRef,
  buildingRef: r.buildingRef,
  unitRef: r.unitRef,
  transferDate: dateOnly(r.transferDate)!,
  campaignTag: r.campaignTag,
  tenantId: r.state === 'accepted' || r.state === 'listed' ? r.tenantId : null,
  listingId: r.listingId,
  deliveredAt: isoOrNull(r.deliveredAt),
  deliveryAttempts: r.deliveryAttempts,
  lastDeliveryError: r.lastDeliveryError,
  expiresAt: iso(r.expiresAt),
  createdAt: iso(r.createdAt),
});

const ADMIN_HANDOFF_EXAMPLE: AdminRentalHandoffDto = {
  id: FAKE.uuid,
  state: RentalHandoffStateName.Invited,
  developerRef: FAKE.tenantId,
  buildingRef: 'bldg-a',
  unitRef: 'u-101',
  transferDate: FAKE.date,
  campaignTag: 'getbuild:dev-campaign-2026',
  tenantId: null,
  listingId: null,
  deliveredAt: FAKE.dateTime,
  deliveryAttempts: 1,
  lastDeliveryError: null,
  expiresAt: '2026-12-01T10:00:00+07:00',
  createdAt: FAKE.dateTime,
};

/** getbuild rental handoffs for the platform team (G8, D-299, O-033): delivery state, resend. No buyer data. */
@ApiTags('admin.rentalHandoffs')
@ApiSurface(SURFACES.admin)
@Controller('admin/rental-handoffs')
export class AdminRentalHandoffsController {
  constructor(private readonly handoffs: RentalHandoffsService) {}

  @Get()
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.rentalHandoffs.list',
    summary: 'getbuild rental handoffs',
    description:
      'Every handoff from `unit.transferred` with rental intent, newest first: refs, campaign, delivery to getbuild (attempts, last error), state (D-299, O-033).',
    implements: ['D-299'],
  })
  @ApiPaginated(AdminRentalHandoffDto, { example: ADMIN_HANDOFF_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: AdminRentalHandoffListQuery): Promise<Page<AdminRentalHandoffDto>> {
    const { rows, total } = await this.handoffs.adminList({ state: q.state, ...toSkipTake(q) });
    return paginated(
      rows.map((r) => adminHandoffDto(r, this.handoffs.effectiveState(r))),
      total,
      q,
    );
  }

  @Post(':handoffId/actions/resend')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.tenant.manage')
  @ApiEndpoint({
    id: 'admin.rentalHandoffs.resend',
    summary: 'Resend the invitation to getbuild',
    description:
      'A new single-use link goes to getbuild now (the previous one stops working) and the attempt counter restarts; with `GETBUILD_MODE=off` it waits for the job. Not invited any more: `handoff.invalid_state` (D-299).',
    implements: ['D-299'],
  })
  @ApiSuccess(200, { description: 'Resent', type: AdminRentalHandoffDto, example: ADMIN_HANDOFF_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'handoff.invalid_state')
  async resend(@Param('handoffId', ParseUUIDPipe) id: string): Promise<AdminRentalHandoffDto> {
    const r = await this.handoffs.resend(id);
    return adminHandoffDto(r, this.handoffs.effectiveState(r));
  }
}

// ------------------------------------------------------------------------------------------- resident: relocation

/** `ops.relocation_offer_state`. */
export enum RelocationOfferStateName {
  Open = 'open',
  Dismissed = 'dismissed',
  Withdrawn = 'withdrawn',
  Closed = 'closed',
}

export class RelocationDestinationDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ari',
    description:
      'An area / station slug of `GET /v1/public/listings/areas`; or give a province (+ district).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 100)
  areaSlug?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'เชียงใหม่' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 100)
  province?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'เมืองเชียงใหม่' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 100)
  district?: string | null;

  @MoneyInput({
    example: '12000',
    description: 'Highest monthly rent to show.',
    optional: true,
    nullable: true,
  })
  maxRent?: string | null;
}

export class RelocationDestinationOutDto {
  @ApiProperty({ type: String, nullable: true, example: null })
  areaSlug!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'เชียงใหม่' })
  province!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'เมืองเชียงใหม่' })
  district!: string | null;

  @MoneyOutput({ example: '12000.00', description: 'Highest rent shown.', nullable: true })
  maxRent!: string | null;
}

export class RelocationOfferDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  leaseId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({
    example: FAKE.propertyName,
    description: 'My current landlord (who does not see this offer).',
  })
  landlordName!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  moveOutDate!: string | null;

  @ApiProperty({ enum: RelocationOfferStateName, enumName: 'RelocationOfferState' })
  state!: RelocationOfferStateName;

  @ApiProperty({ type: RelocationDestinationOutDto, nullable: true, description: 'Null until I tell it.' })
  destination!: RelocationDestinationOutDto | null;

  @ApiProperty({
    type: [PublicListingSummaryDto],
    description:
      'Public listings in the destination (`relocation.offer.max_listings`), only while open and consented.',
  })
  listings!: PublicListingSummaryDto[];

  @ApiProperty({ type: [String], format: 'uuid', description: 'Listings I enquired about from this offer.' })
  enquiredListingIds!: string[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class RelocationOffersDto {
  @ApiProperty({
    description:
      'My consent `resident.relocation` is granted (current version); false = no offer shows listings.',
  })
  consented!: boolean;

  @ApiProperty({ type: [RelocationOfferDto] })
  data!: RelocationOfferDto[];
}

export class RelocationEnquireDto {
  @ApiProperty({
    example: 'condo-1br-0a1b2c3d4e',
    description: 'A public listing (for example one of the offer).',
  })
  @IsString()
  @Matches(/^[a-z0-9-]{3,120}$/)
  listingSlug!: string;

  @ApiProperty({ example: 'สนใจห้องนี้ ย้ายเข้าได้ต้นเดือนหน้า' })
  @IsString()
  @Length(1, 2000)
  message!: string;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2026-12-01' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  moveInDate?: string | null;

  @ApiProperty({
    example: true,
    description:
      'Send my rent record (B7.11) to the new landlord with this enquiry — the only way it travels.',
  })
  @IsBoolean()
  shareRentRecord!: boolean;

  @ApiProperty({
    example: true,
    description: 'I agree to purpose `prospect.enquiry` of the new landlord (D-025).',
  })
  @IsBoolean()
  consent!: boolean;
}

export class RelocationEnquiryDto {
  @ApiProperty({ format: 'uuid', description: 'My enquiry (see `/v1/prospect/me/enquiries`).' })
  leadId!: string;

  @ApiProperty({ format: 'uuid' })
  listingId!: string;

  @ApiProperty({ description: 'A new enquiry (false = a message in the open one).' })
  created!: boolean;

  @ApiProperty({ description: 'My rent record was shared (false when asked but no month is confirmed yet).' })
  rentRecordShared!: boolean;
}

const offerDto = (o: OfferRow, listings: unknown[]): RelocationOfferDto => ({
  id: o.id,
  leaseId: o.leaseId,
  unitNo: o.lease.unit.unitNo,
  landlordName: o.lease.tenant.displayName,
  moveOutDate: dateOnly(o.moveOutDate),
  state: o.state as RelocationOfferStateName,
  destination:
    o.areaSlug || o.province
      ? {
          areaSlug: o.areaSlug,
          province: o.province,
          district: o.district,
          maxRent: o.maxRent ? o.maxRent.toFixed(2) : null,
        }
      : null,
  listings: listings as PublicListingSummaryDto[],
  enquiredListingIds: o.clickedListingIds,
  createdAt: iso(o.createdAt),
});

const OFFER_EXAMPLE: RelocationOfferDto = {
  id: FAKE.uuid,
  leaseId: '0199f2a0-0000-7000-8000-0000000000d1',
  unitNo: FAKE.unitCode,
  landlordName: FAKE.propertyName,
  moveOutDate: '2026-12-31',
  state: RelocationOfferStateName.Open,
  destination: { areaSlug: null, province: 'เชียงใหม่', district: 'เมืองเชียงใหม่', maxRent: '12000.00' },
  listings: [SUMMARY_EXAMPLE as unknown as PublicListingSummaryDto],
  enquiredListingIds: [],
  createdAt: FAKE.dateTime,
};

/**
 * Relocation network (G8, D-289 (2), D-299): when I move out and consented to `resident.relocation`, getproperty
 * shows places in the area I am moving to; I enquire and, if I want, send my rent record to the new landlord.
 * Without that consent: no offer, no matching, `relocation.consent_required`.
 */
@ApiTags('resident.relocationOffers')
@ApiSurface(SURFACES.resident)
@Controller('resident/relocation-offers')
export class ResidentRelocationOffersController {
  constructor(private readonly relocation: RelocationService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.relocationOffers.list',
    summary: 'Places where I am moving',
    description:
      'My relocation offers (one per lease under notice, only if I consented to `resident.relocation`), each with the public listings in its destination while it is open; `consented: false` when the consent is not (or no longer) granted — then nothing is matched and open offers close (D-299, D-025).',
    implements: ['D-289', 'D-299', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Offers',
    type: RelocationOffersDto,
    example: { consented: true, data: [OFFER_EXAMPLE] },
  })
  @ApiStandardErrors('auth.unauthenticated')
  async list(@Req() req: Request): Promise<RelocationOffersDto> {
    const { consented, offers } = await this.relocation.list(lang(req.headers['accept-language']));
    return { consented, data: offers.map((o) => offerDto(o.offer, o.listings)) };
  }

  @Put(':offerId/destination')
  @ApiEndpoint({
    id: 'resident.relocationOffers.setDestination',
    summary: 'Where I am moving',
    description:
      'An area slug, or a province (+ district), and a budget — used only to show me listings there; erased when the offer closes or I withdraw the consent. No consent: `relocation.consent_required`; offer closed: `relocation.invalid_state`; not mine: 404 (D-299).',
    implements: ['D-299', 'D-025'],
  })
  @ApiJsonBody(RelocationDestinationDto, {
    province: 'เชียงใหม่',
    district: 'เมืองเชียงใหม่',
    maxRent: '12000',
  })
  @ApiSuccess(200, { description: 'Set', type: RelocationOfferDto, example: OFFER_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'relocation.consent_required',
    'relocation.invalid_state',
  )
  async setDestination(
    @Param('offerId', ParseUUIDPipe) id: string,
    @Body() body: RelocationDestinationDto,
    @Req() req: Request,
  ): Promise<RelocationOfferDto> {
    const offer = await this.relocation.setDestination(id, body);
    const { offers } = await this.relocation.list(lang(req.headers['accept-language']));
    return offerDto(offer, offers.find((o) => o.offer.id === id)?.listings ?? []);
  }

  @Post(':offerId/actions/enquire')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.relocationOffers.enquire',
    summary: 'Enquire about a place (and send my rent record)',
    description:
      'Sends my message to the listing’s owner as a prospect enquiry (B7.3; consent `prospect.enquiry` of that owner) and — only when `shareRentRecord` — shares my rent record with that enquiry (B7.11); nothing travels otherwise. No consent `resident.relocation`: `relocation.consent_required`; offer closed: `relocation.invalid_state`; not mine: 404 (D-299, D-256).',
    implements: ['D-299', 'D-256', 'D-252'],
  })
  @ApiJsonBody(RelocationEnquireDto, {
    listingSlug: 'condo-1br-0a1b2c3d4e',
    message: 'สนใจห้องนี้ ย้ายเข้าได้ต้นเดือนหน้า',
    shareRentRecord: true,
    consent: true,
  })
  @ApiSuccess(200, {
    description: 'Sent',
    type: RelocationEnquiryDto,
    example: {
      leadId: FAKE.uuid,
      listingId: '0199f2a0-0000-7000-8000-0000000000d2',
      created: true,
      rentRecordShared: true,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'relocation.consent_required',
    'relocation.invalid_state',
    'listing.consent_required',
    'listing.enquiry_limit',
    'listing.bank_account_in_message',
  )
  async enquire(
    @Param('offerId', ParseUUIDPipe) id: string,
    @Body() body: RelocationEnquireDto,
  ): Promise<RelocationEnquiryDto> {
    return this.relocation.enquire(id, body);
  }

  @Post(':offerId/actions/dismiss')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.relocationOffers.dismiss',
    summary: 'Not interested',
    description:
      'Closes the offer and erases its destination; the consent stays as it is (withdraw it in my privacy settings). Closed already: `relocation.invalid_state` (D-299).',
    implements: ['D-299'],
  })
  @ApiSuccess(200, {
    description: 'Dismissed',
    type: RelocationOfferDto,
    example: { ...OFFER_EXAMPLE, state: RelocationOfferStateName.Dismissed, destination: null, listings: [] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'relocation.invalid_state')
  async dismiss(@Param('offerId', ParseUUIDPipe) id: string): Promise<RelocationOfferDto> {
    return offerDto(await this.relocation.dismiss(id), []);
  }
}

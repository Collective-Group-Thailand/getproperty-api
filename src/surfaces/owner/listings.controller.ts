import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { TenantTx } from '@database/tenant-tx';
import { type ListingVerification } from '@generated/prisma/client';
import { ListingInsightsService } from '@modules/ops-listings/listing-insights.service';
import { ListingsService, type ListingWithParts } from '@modules/ops-listings/listings.service';
import { PublicListingsService } from '@modules/ops-listings/public-listings.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { ListingComparablesDto } from '../shared/listing-insights.dto';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  LISTING_EXAMPLE,
  ListingAvailabilityDto,
  type ListingCloseReasonName,
  ListingCreateDto,
  ListingDto,
  ListingPhotoAddDto,
  ListingPhotosArrangeDto,
  type ListingReviewReasonName,
  ListingStateName,
  ListingUpdateDto,
  UnitVerificationDto,
  VERIFICATION_EXAMPLE,
  VerificationDto,
  VerificationRequestDto,
} from './listings.dto';
import { type FurnishingName, type PortfolioUnitKindName } from './portfolio.controller';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const WRITE = [
  'validation.failed',
  'http.bad_request',
  'http.not_found',
  'listing.invalid_state',
  ...T,
] as const;

export function verificationDto(v: ListingVerification): VerificationDto {
  return {
    id: v.id,
    unitId: v.unitId,
    state: v.state as VerificationDto['state'],
    evidenceKind: v.evidenceKind as VerificationDto['evidenceKind'],
    evidenceCount: v.evidencePurgedAt ? 0 : v.evidenceDocumentIds.length,
    submittedAt: v.submittedAt.toISOString(),
    decidedAt: v.decidedAt?.toISOString() ?? null,
    decisionNote: v.decisionNote,
  };
}

/**
 * Rental listings of the owner (B7.2, D-252): draft from a unit, photos (presign `listing_photo` → upload →
 * complete, then attach), viewing availability, submit (published at once, or queued for a moderator with the
 * reasons), pause, resume, close; owner verification of a unit for the "เจ้าของตัวจริง" badge.
 */
@ApiTags('owner.listings')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerListingsController {
  constructor(
    private readonly listings: ListingsService,
    private readonly photos: PublicListingsService,
    private readonly db: TenantTx,
    private readonly insights: ListingInsightsService,
  ) {}

  private async dto(ctx: TenantContext, l: ListingWithParts): Promise<ListingDto> {
    const verified = await this.db.platform((tx) => this.listings.verified(tx, ctx.tenantId, l.unitId));
    const photos = [];
    for (const p of l.photos)
      photos.push({
        id: p.id,
        documentId: p.documentId,
        sortOrder: p.sortOrder,
        caption: p.caption,
        url: (await this.photos.photo(p.document, p.caption, 480)).url,
      });
    return {
      id: l.id,
      unitId: l.unitId,
      buildingId: l.buildingId,
      state: l.state as ListingStateName,
      slug: l.slug,
      titleTh: l.titleTh,
      titleEn: l.titleEn,
      descriptionTh: l.descriptionTh,
      descriptionEn: l.descriptionEn,
      rent: l.rent.toFixed(2),
      depositMonths: l.depositMonths,
      advanceMonths: l.advanceMonths,
      minTermMonths: l.minTermMonths,
      availableFrom: l.availableFrom?.toISOString().slice(0, 10) ?? null,
      furnishing: l.furnishing as FurnishingName | null,
      petsAllowed: l.petsAllowed,
      smokingAllowed: l.smokingAllowed,
      facilities: l.facilities,
      showUnitNo: l.showUnitNo,
      showUtilityHistory: l.showUtilityHistory,
      utility: await this.db.tenant(ctx, (tx) => this.insights.utility(tx, l)),
      transit:
        l.transitName && l.transitDistanceM !== null
          ? { name: l.transitName, line: l.transitLine, distanceM: l.transitDistanceM }
          : null,
      unitKind: l.unitKind as PortfolioUnitKindName | null,
      sizeSqm: l.sizeSqm?.toFixed(2) ?? null,
      bedrooms: l.bedrooms,
      bathrooms: l.bathrooms,
      floorLabel: l.floorLabel,
      province: l.province,
      district: l.district,
      address: l.addressText,
      photos,
      availability: {
        weekly: (l.availability?.weekly ?? []) as ListingDto['availability']['weekly'],
        exceptions: (l.availability?.exceptions ?? []) as ListingDto['availability']['exceptions'],
        slotMinutes: l.availability?.slotMinutes ?? 30,
      },
      reviewReasons: l.reviewReasons as ListingReviewReasonName[],
      rejectedReason: l.rejectedReason,
      hidden: Boolean(l.hiddenAt),
      reportCount: l.reportCount,
      verifiedOwner: verified,
      publishedAt: l.publishedAt?.toISOString() ?? null,
      closedReason: l.closedReason as ListingCloseReasonName | null,
      version: l.version,
    };
  }

  @Get('listings')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.listings.list',
    summary: 'My listings',
    description: 'Every listing of the tenant, newest first, filtered by state or unit (D-252).',
    implements: ['D-252'],
  })
  @ApiQuery({ name: 'state', required: false, enum: ListingStateName, enumName: 'ListingState' })
  @ApiQuery({ name: 'unitId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiSuccess(200, { description: 'Listings', type: [ListingDto], example: [LISTING_EXAMPLE] })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query('state') state?: ListingStateName,
    @Query('unitId') unitId?: string,
  ): Promise<ListingDto[]> {
    const rows = await this.listings.list(ctx, { state: state as never, unitId });
    const out = [];
    for (const row of rows) out.push(await this.dto(ctx, row));
    return out;
  }

  @Post('listings')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.create',
    summary: 'Draft a listing',
    description:
      'A draft listing of a unit (D-252). The unit’s kind, size, rooms, floor and address are copied (and refreshed on every save) so the public search reads one record; the unit number appears in the public address only with `showUnitNo`. Nothing is public until submitted.',
    implements: ['D-252'],
  })
  @ApiJsonBody(ListingCreateDto, {
    unitId: FAKE.uuid,
    titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
    rent: '15000.00',
    depositMonths: 2,
    advanceMonths: 1,
    minTermMonths: 12,
    transit: { name: 'BTS อารีย์', line: 'BTS สายสุขุมวิท', distanceM: 350 },
  })
  @ApiSuccess(201, {
    description: 'Draft',
    type: ListingDto,
    example: { ...LISTING_EXAMPLE, state: 'draft' },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...T)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: ListingCreateDto): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.create(ctx, body));
  }

  @Get('listings/:listingId')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.listings.get',
    summary: 'One listing',
    description: 'A listing with its photos, availability and review state (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, { description: 'Listing', type: ListingDto, example: LISTING_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.get(ctx, id));
  }

  @Get('listings/:listingId/comparables')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.listings.comparables',
    summary: 'Rent band of comparable listings',
    description:
      'Comparable listings — same kind and bedrooms, size within ±20 %, same district or within 1 km of the same station, published now or let in the last 12 months — their rent band (25th / 50th / 75th percentile) and median days to let (D-269). Nothing below `listing.comparables.min`; never per competitor, never public.',
    implements: ['D-269'],
  })
  @ApiSuccess(200, {
    description: 'Comparables',
    type: ListingComparablesDto,
    example: {
      band: { p25: '12500.00', p50: '14000.00', p75: '16000.00' },
      medianDaysToLet: 21,
      sampleSize: 12,
      minimum: 8,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async comparables(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
  ): Promise<ListingComparablesDto> {
    return this.insights.comparables(ctx, id);
  }

  @Patch('listings/:listingId')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.update',
    summary: 'Edit a listing',
    description:
      'Terms, texts, facilities, transit. Allowed until closed; editing a published listing whose new text needs a look sends it back to review (hidden until approved, D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(ListingUpdateDto, { rent: '14500.00', petsAllowed: true })
  @ApiSuccess(200, { description: 'Updated', type: ListingDto, example: LISTING_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'listing.duplicate_unit')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
    @Body() body: ListingUpdateDto,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.update(ctx, id, body));
  }

  @Post('listings/:listingId/photos')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.addPhoto',
    summary: 'Attach a photo',
    description:
      'Appends an uploaded, scanned document of kind `listing_photo` (EXIF and location already removed, WebP renditions made). At most `listing.photos.max` photos (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(ListingPhotoAddDto, { documentId: FAKE.uuid, caption: 'ห้องนั่งเล่น' })
  @ApiSuccess(201, { description: 'Attached', type: ListingDto, example: LISTING_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'listing.photo_invalid', 'http.conflict')
  async addPhoto(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
    @Body() body: ListingPhotoAddDto,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.addPhoto(ctx, id, body));
  }

  @Put('listings/:listingId/photos')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.arrangePhotos',
    summary: 'Order photos',
    description: 'New order and captions of every photo; the first is the cover (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(ListingPhotosArrangeDto, { photos: [{ id: FAKE.uuid, caption: 'ห้องนอน' }] })
  @ApiSuccess(200, { description: 'Arranged', type: ListingDto, example: LISTING_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async arrange(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
    @Body() body: ListingPhotosArrangeDto,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.arrangePhotos(ctx, id, body.photos));
  }

  @Delete('listings/:listingId/photos/:photoId')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.removePhoto',
    summary: 'Remove a photo',
    description: 'Detaches a photo; the others close up in order (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, { description: 'Removed', type: ListingDto, example: LISTING_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async removePhoto(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.removePhoto(ctx, id, photoId));
  }

  @Put('listings/:listingId/availability')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.setAvailability',
    summary: 'Set viewing availability',
    description:
      'Weekly windows (Asia/Bangkok) and date exceptions in which viewings can be booked (D-252, B7.3).',
    implements: ['D-252'],
  })
  @ApiJsonBody(ListingAvailabilityDto, {
    weekly: [{ weekday: 6, from: '10:00', to: '16:00' }],
    exceptions: [],
    slotMinutes: 30,
  })
  @ApiSuccess(200, { description: 'Saved', type: ListingDto, example: LISTING_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async availability(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
    @Body() body: ListingAvailabilityDto,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.setAvailability(ctx, id, body));
  }

  @Post('listings/:listingId/actions/relist')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.relist',
    summary: 'Re-open a closed listing',
    description:
      "One tap before a lease ends (B7.4, D-253): a new draft copied from a closed listing of the unit — texts, terms, facilities, transit, photos in order and viewing times — with the unit's facts refreshed. Submit it as usual (one live listing per unit).",
    implements: ['D-252', 'D-253'],
  })
  @ApiSuccess(201, {
    description: 'New draft',
    type: ListingDto,
    example: { ...LISTING_EXAMPLE, state: 'draft' },
  })
  @ApiStandardErrors(...WRITE)
  async relist(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.relist(ctx, id));
  }

  @Post('listings/:listingId/actions/submit')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.submit',
    summary: 'Submit a listing',
    description:
      'Checks completeness (`listing.incomplete`: photos ≥ `listing.photos.min`, size, rooms, address), one live listing per unit (`listing.duplicate_unit`), then publishes at once — or queues for a moderator with `reviewReasons`: first listing of an unverified owner, rent far from the district median, flagged words (all settings, D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, { description: 'Published or queued', type: ListingDto, example: LISTING_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'listing.incomplete', 'listing.duplicate_unit')
  async submit(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.submit(ctx, id));
  }

  @Post('listings/:listingId/actions/pause')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.pause',
    summary: 'Pause a listing',
    description: 'Takes a published listing off the public pages until resumed (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'Paused',
    type: ListingDto,
    example: { ...LISTING_EXAMPLE, state: 'paused' },
  })
  @ApiStandardErrors(...WRITE)
  async pause(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.pause(ctx, id));
  }

  @Post('listings/:listingId/actions/resume')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.resume',
    summary: 'Resume a listing',
    description: 'Publishes a paused listing again (not while hidden by moderation, D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, { description: 'Published', type: ListingDto, example: LISTING_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'listing.duplicate_unit')
  async resume(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.resume(ctx, id));
  }

  @Post('listings/:listingId/actions/close')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.close',
    summary: 'Close a listing',
    description: 'Withdraws the listing for good (a new one can be drafted later, D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'Closed',
    type: ListingDto,
    example: { ...LISTING_EXAMPLE, state: 'closed', closedReason: 'withdrawn' },
  })
  @ApiStandardErrors(...WRITE)
  async close(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
  ): Promise<ListingDto> {
    return this.dto(ctx, await this.listings.close(ctx, id));
  }

  @Get('units/:unitId/verification')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.listings.verification',
    summary: 'Owner verification of a unit',
    description: 'Whether the unit\u2019s owner is verified and the latest request (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'Verification state',
    type: UnitVerificationDto,
    example: { verified: false, latest: VERIFICATION_EXAMPLE },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async verification(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<UnitVerificationDto> {
    const row = await this.listings.verification(ctx, unitId);
    const verified = await this.db.platform((tx) => this.listings.verified(tx, ctx.tenantId, unitId));
    return { verified, latest: row ? verificationDto(row) : null };
  }

  @Post('units/:unitId/verification')
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listings.requestVerification',
    summary: 'Ask for owner verification',
    description:
      'Sends ownership evidence (title deed, condo title or sale-purchase contract as `certificate` documents) to platform Support for the "เจ้าของตัวจริง" badge on every listing of the unit. Evidence is deleted `listing.verification.evidence_retention_days` after the decision (D-252, O-018).',
    implements: ['D-252'],
  })
  @ApiJsonBody(VerificationRequestDto, { evidenceKind: 'condo_title', documentIds: [FAKE.uuid] })
  @ApiSuccess(201, { description: 'Requested', type: VerificationDto, example: VERIFICATION_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.verification_pending',
    ...T,
  )
  async requestVerification(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: VerificationRequestDto,
  ): Promise<VerificationDto> {
    return verificationDto(await this.listings.requestVerification(ctx, unitId, body));
  }
}

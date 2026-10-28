import { Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { toBangkokIso } from '@common/time/bangkok';
import { ListingInsightsService } from '@modules/ops-listings/listing-insights.service';
import { ListingLeadsService } from '@modules/ops-listings/listing-leads.service';
import { ListingModerationService } from '@modules/ops-listings/listing-moderation.service';
import { ListingOgImageService } from '@modules/ops-listings/listing-og-image.service';
import { ListingShareService } from '@modules/ops-listings/listing-share.service';
import { PublicListingsService } from '@modules/ops-listings/public-listings.service';
import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { type Request, type Response } from 'express';

import { ListingChannelName, ViewingSlotsDto } from '../owner/leads.dto';
import { FurnishingName, PortfolioUnitKindName } from '../owner/portfolio.controller';
import { MoneyOutput } from '../shared/fields';
import { ListingUtilityDto, PublicAreasDto } from '../shared/listing-insights.dto';
import { PublicShareLinkDto } from '../shared/listing-share.dto';
import { ViewingModeName } from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';

const CACHE = 'public, max-age=300, stale-while-revalidate=600';
const SEARCH_LIMIT = { default: { limit: 120, ttl: seconds(60) } };
const REPORT_LIMIT = { default: { limit: 5, ttl: seconds(600) } };

export enum ListingSortName {
  Newest = 'newest',
  RentAsc = 'rent_asc',
  RentDesc = 'rent_desc',
}
export enum ListingReportReasonName {
  Scam = 'scam',
  WrongInfo = 'wrong_info',
  NotAvailable = 'not_available',
  Duplicate = 'duplicate',
  Offensive = 'offensive',
  Other = 'other',
}

const MONEY_QUERY = /^\d{1,9}(\.\d{1,2})?$/;

export class PublicListingQueryDto {
  @ApiPropertyOptional({
    example: 'อารีย์',
    description: 'Words in the title, address, district, province or station.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ enum: PortfolioUnitKindName, enumName: 'PortfolioUnitKind' })
  @IsOptional()
  @IsEnum(PortfolioUnitKindName)
  kind?: PortfolioUnitKindName;

  @ApiPropertyOptional({ example: 'กรุงเทพมหานคร' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  province?: string;

  @ApiPropertyOptional({ example: 'พญาไท' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  district?: string;

  @ApiPropertyOptional({
    example: 'ari',
    pattern: '^[a-z0-9-]{1,80}$',
    description: 'An area or station slug from `GET /v1/public/listings/areas` (D-272).',
  })
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,80}$/)
  area?: string;

  @ApiPropertyOptional({ example: '8000', description: 'THB per month, decimal string.' })
  @IsOptional()
  @Matches(MONEY_QUERY)
  minRent?: string;

  @ApiPropertyOptional({ example: '20000' })
  @IsOptional()
  @Matches(MONEY_QUERY)
  maxRent?: string;

  @ApiPropertyOptional({ example: '25', description: 'Square metres at least.' })
  @IsOptional()
  @Matches(MONEY_QUERY)
  minSize?: string;

  @ApiPropertyOptional({ type: 'integer', example: 1, description: 'Bedrooms at least.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  bedrooms?: number;

  @ApiPropertyOptional({ enum: FurnishingName, enumName: 'Furnishing' })
  @IsOptional()
  @IsEnum(FurnishingName)
  furnishing?: FurnishingName;

  @ApiPropertyOptional({ example: '1', pattern: '^1$', description: '`1` = pets allowed only.' })
  @IsOptional()
  @Matches(/^1$/)
  pets?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-12-01',
    description: 'Available on or before this day.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  availableBy?: string;

  @ApiPropertyOptional({ enum: ListingSortName, enumName: 'ListingSort' })
  @IsOptional()
  @IsEnum(ListingSortName)
  sort?: ListingSortName;

  @ApiPropertyOptional({ description: 'Opaque cursor of the next page.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ type: 'integer', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class PublicListingPhotoDto {
  @ApiProperty({
    example: 'https://storage.invalid/t/…/photo.w960.webp',
    description: 'Signed for an hour; WebP, no EXIF.',
  })
  url!: string;

  @ApiProperty({ type: 'integer', example: 960 })
  width!: number;

  @ApiProperty({ type: 'integer', example: 720 })
  height!: number;

  @ApiProperty({ type: String, nullable: true })
  caption!: string | null;
}

export class PublicTransitDto {
  @ApiProperty({ example: 'BTS อารีย์' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'BTS สายสุขุมวิท' })
  line!: string | null;

  @ApiProperty({ type: 'integer', example: 350 })
  distanceM!: number;
}

export class PublicListingSummaryDto {
  @ApiProperty({ example: 'condo-1br-0a1b2c3d4e' })
  slug!: string;

  @ApiProperty({
    example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
    description: 'English title for `Accept-Language: en` when the owner wrote one.',
  })
  title!: string;

  @ApiProperty({ enum: PortfolioUnitKindName, enumName: 'PortfolioUnitKind', nullable: true })
  unitKind!: PortfolioUnitKindName | null;

  @MoneyOutput({ example: '15000.00', description: 'Monthly rent.' })
  rent!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  depositMonths!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  advanceMonths!: number;

  @ApiProperty({ type: 'integer', example: 12 })
  minTermMonths!: number;

  @ApiProperty({ type: String, nullable: true, example: '28.50' })
  sizeSqm!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1 })
  bedrooms!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1 })
  bathrooms!: number | null;

  @ApiProperty({ enum: FurnishingName, enumName: 'Furnishing', nullable: true })
  furnishing!: FurnishingName | null;

  @ApiProperty()
  petsAllowed!: boolean;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  availableFrom!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'กรุงเทพมหานคร' })
  province!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'พญาไท' })
  district!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The full address (D-252); the unit number only when the owner shows it.',
  })
  address!: string | null;

  @ApiProperty({ type: PublicTransitDto, nullable: true })
  nearestTransit!: PublicTransitDto | null;

  @ApiProperty({ type: PublicListingPhotoDto, nullable: true })
  cover!: PublicListingPhotoDto | null;

  @ApiProperty({ description: 'The unit’s owner is verified (badge "เจ้าของตัวจริง").' })
  verifiedOwner!: boolean;

  @ApiProperty({
    example: false,
    description:
      'The owner verified their identity at the e-KYC provider (D-267); a second badge beside the ownership one.',
  })
  ownerIdentityVerified!: boolean;

  @ApiProperty({
    example: true,
    description:
      'G4 (D-296) badge "ว่างจริง": getproperty’s own lease data shows nobody lives there — no current occupancy, no lease in force or waiting for signature — and the unit had a lease on the platform that ended (`listing.verified_vacant.require_history`). Never from the owner’s say-so.',
  })
  verifiedVacant!: boolean;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-10-31',
    description: 'The day the last lease on getproperty ended, when `verifiedVacant`; else null.',
  })
  vacantSince!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt!: string;
}

export class PublicListingsPageDto {
  @ApiProperty({ type: [PublicListingSummaryDto] })
  data!: PublicListingSummaryDto[];

  @ApiProperty({ type: 'integer', example: 42 })
  total!: number;

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PublicGeoDto {
  @ApiProperty({ example: 13.7799 })
  lat!: number;

  @ApiProperty({ example: 100.5446 })
  lng!: number;
}

export class PublicListingDetailDto extends PublicListingSummaryDto {
  @ApiProperty()
  description!: string;

  @ApiProperty({ type: [String] })
  facilities!: string[];

  @ApiProperty({ type: [PublicListingPhotoDto], description: 'In order, 1600 px renditions.' })
  photos!: PublicListingPhotoDto[];

  @ApiProperty({ type: String, nullable: true })
  floor!: string | null;

  @ApiProperty({ type: PublicGeoDto, nullable: true, description: 'The map pin (D-252: public).' })
  geo!: PublicGeoDto | null;

  @ApiProperty({ example: 'มาลี มีสุข' })
  ownerDisplayName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'landlord-0a1b2c3d4e',
    description:
      'The owner’s public page `GET /v1/public/owners/{slug}` (D-274) when it is open (verified and not switched off); else null.',
  })
  ownerProfileSlug!: string | null;

  @ApiProperty()
  smokingAllowed!: boolean;

  @ApiProperty({
    type: ListingUtilityDto,
    nullable: true,
    description: 'The unit’s real utility cost (D-265).',
  })
  utility!: ListingUtilityDto | null;

  @ApiProperty({
    example: 'https://api.getproperty.co/v1/public/listings/condo-1br-0a1b2c3d4e/og-image',
    description: 'G4: the 1200 × 630 Open Graph card (`og:image`, Facebook / LINE previews), a stable URL.',
  })
  ogImageUrl!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'G4: schema.org JSON-LD (`Offer` of an `Apartment` / `House` / `Room` / `Accommodation` with a monthly THB `UnitPriceSpecification`) to embed as `application/ld+json`; only facts already on the page (D-252).',
    example: {
      '@context': 'https://schema.org',
      '@type': 'Offer',
      price: '15000.00',
      priceCurrency: 'THB',
      itemOffered: { '@type': 'Apartment', numberOfBedrooms: 1 },
    },
  })
  jsonLd!: Record<string, unknown>;
}

export class PublicSitemapEntryDto {
  @ApiProperty({ example: 'condo-1br-0a1b2c3d4e' })
  slug!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class PublicSitemapDto {
  @ApiProperty({ type: [PublicSitemapEntryDto] })
  data!: PublicSitemapEntryDto[];
}

export class ListingReportDto {
  @ApiProperty({
    enum: ListingReportReasonName,
    enumName: 'ListingReportReason',
    example: ListingReportReasonName.Scam,
  })
  @IsEnum(ListingReportReasonName)
  reason!: ListingReportReasonName;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ขอให้โอนมัดจำก่อนดูห้อง' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string | null;
}

export class ListingReportedDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  received!: boolean;
}

const SUMMARY_EXAMPLE = {
  slug: 'condo-1br-0a1b2c3d4e',
  title: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
  unitKind: 'condo_unit',
  rent: '15000.00',
  depositMonths: 2,
  advanceMonths: 1,
  minTermMonths: 12,
  sizeSqm: '28.50',
  bedrooms: 1,
  bathrooms: 1,
  furnishing: 'fully_furnished',
  petsAllowed: false,
  availableFrom: '2026-12-01',
  province: 'กรุงเทพมหานคร',
  district: 'พญาไท',
  address: 'ถนนพหลโยธิน, พญาไท, กรุงเทพมหานคร 10400',
  nearestTransit: { name: 'BTS อารีย์', line: 'BTS สายสุขุมวิท', distanceM: 350 },
  cover: { url: 'https://storage.invalid/p.w960.webp', width: 960, height: 720, caption: null },
  verifiedOwner: true,
  ownerIdentityVerified: true,
  verifiedVacant: true,
  vacantSince: '2026-10-31',
  publishedAt: '2026-11-01T10:00:00+07:00',
};

const lang = (header: string | undefined): 'th' | 'en' =>
  header?.toLowerCase().startsWith('en') ? 'en' : 'th';

/**
 * The public listings of the marketing site (B7.3 part 1, D-252): search, detail and sitemap — anonymous, cacheable
 * for 5 minutes — and the viewers' report button (rate-limited; enough reports hide a listing pending review).
 */
@ApiTags('public.listings')
@ApiSurface(SURFACES.public)
@Controller('public/listings')
export class PublicListingsController {
  constructor(
    private readonly listings: PublicListingsService,
    private readonly moderation: ListingModerationService,
    private readonly leads: ListingLeadsService,
    private readonly insights: ListingInsightsService,
    private readonly ogImages: ListingOgImageService,
  ) {}

  @Get()
  @Public()
  @Throttle(SEARCH_LIMIT)
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.listings.search',
    summary: 'Search rental listings',
    description:
      'Published listings of active tenants (D-252): words, kind, province / district, rent range, size, bedrooms (at least), furnishing, pets, available-by, sort; cursor pages of up to 50 with the total. Each card has the full address (the unit number only when the owner shows it), the cover photo and the verified-owner flag. Anonymous, cacheable (5 min), rate-limited.',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'One page',
    type: PublicListingsPageDto,
    example: { data: [SUMMARY_EXAMPLE], total: 1, nextCursor: null },
  })
  @ApiStandardErrors('validation.failed', 'http.too_many_requests')
  async search(@Query() query: PublicListingQueryDto, @Req() req: Request): Promise<PublicListingsPageDto> {
    return (await this.listings.search(
      { ...query, pets: query.pets === '1' ? true : undefined },
      lang(req.headers['accept-language']),
    )) as unknown as PublicListingsPageDto;
  }

  @Get('sitemap')
  @Public()
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.listings.sitemap',
    summary: 'Listings for the sitemap',
    description:
      'Slug and last change of every public listing, newest first (D-252), for the web sitemap and llms.txt.',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'Entries',
    type: PublicSitemapDto,
    example: { data: [{ slug: 'condo-1br-0a1b2c3d4e', updatedAt: '2026-11-01T10:00:00+07:00' }] },
  })
  @ApiStandardErrors()
  async sitemap(): Promise<PublicSitemapDto> {
    return (await this.listings.sitemap()) as unknown as PublicSitemapDto;
  }

  @Get('areas')
  @Public()
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.listings.areas',
    summary: 'Areas and stations with listings',
    description:
      'Every district and transit station with published listings (D-272): count, the rent band of their listings once there are `listing.comparables.min` of them (D-269), and whether the page may be indexed (`listing.area.index_min`). Filter the search with `?area=<slug>`.',
    implements: ['D-272', 'D-269'],
  })
  @ApiSuccess(200, {
    description: 'Areas',
    type: PublicAreasDto,
    example: {
      data: [
        {
          slug: 'phaya-thai',
          name: 'พญาไท',
          nameEn: 'Phaya Thai',
          kind: 'district',
          province: 'กรุงเทพมหานคร',
          provinceEn: 'Bangkok',
          line: null,
          count: 14,
          band: { p25: '12500.00', p50: '14000.00', p75: '16000.00' },
          indexable: true,
        },
      ],
    },
  })
  @ApiStandardErrors()
  async areas(): Promise<PublicAreasDto> {
    return { data: await this.insights.areas() };
  }

  @Get(':slug')
  @Public()
  @Throttle(SEARCH_LIMIT)
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.listings.get',
    summary: 'One listing',
    description:
      'The public page of a listing (D-252): description, facilities, every photo in order, floor, map pin, the owner’s display name and verified flag, the real utility cost (D-265), the verified-vacant badge, the Open Graph card URL and the schema.org JSON-LD (G4, D-296). `404` when it is not (or no longer) public.',
    implements: ['D-252', 'D-265', 'D-296'],
  })
  @ApiSuccess(200, {
    description: 'Listing',
    type: PublicListingDetailDto,
    example: {
      ...SUMMARY_EXAMPLE,
      description: 'ห้องมุม แสงดี เฟอร์นิเจอร์ครบ',
      facilities: ['pool', 'fitness'],
      photos: [SUMMARY_EXAMPLE.cover],
      floor: '12',
      geo: { lat: 13.7799, lng: 100.5446 },
      ownerDisplayName: 'มาลี มีสุข',
      ownerProfileSlug: 'landlord-0a1b2c3d4e',
      smokingAllowed: false,
      utility: {
        electricity: { kind: 'flat', pricePerUnit: '7.0000', tiers: [], minimumCharge: null },
        water: { kind: 'flat', pricePerUnit: '18.0000', tiers: [], minimumCharge: '100.00' },
        fixedCharges: [{ kind: 'common_fee', name: 'ค่าส่วนกลาง', amount: '500.00' }],
        averageBill3m: '1240.50',
        basedOnBills: 3,
      },
      ogImageUrl: 'https://api.getproperty.co/v1/public/listings/condo-1br-0a1b2c3d4e/og-image',
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Offer',
        url: 'https://getproperty.co/rent/condo-1br-0a1b2c3d4e',
        price: '15000.00',
        priceCurrency: 'THB',
        itemOffered: { '@type': 'Apartment', numberOfBedrooms: 1 },
      },
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'http.too_many_requests')
  async get(@Param('slug') slug: string, @Req() req: Request): Promise<PublicListingDetailDto> {
    return (await this.listings.detail(
      slug.slice(0, 80),
      lang(req.headers['accept-language']),
    )) as unknown as PublicListingDetailDto;
  }

  @Get(':slug/og-image')
  @Public()
  @Throttle(SEARCH_LIMIT)
  @ApiEndpoint({
    id: 'public.listings.ogImage',
    summary: 'Open Graph card of a listing',
    description:
      'The 1200 × 630 PNG previewed by Facebook, LINE and search engines for the listing page and for its Facebook Page posts (G4, D-296): cover photo, rent, title, place, facts, the verified badges and the getproperty logo. Rendered again only when what it shows changes (`ETag` = its content hash); cacheable for an hour. `404` when the listing is not public.',
    implements: ['D-296', 'D-288'],
  })
  @ApiProduces('image/png')
  @ApiResponse({
    status: 200,
    description: 'The PNG card (1200 × 630)',
    content: { 'image/png': { schema: { type: 'string', format: 'binary' }, example: '<PNG, 1200 × 630>' } },
  })
  @ApiStandardErrors('http.not_found', 'http.too_many_requests')
  async ogImage(@Param('slug') slug: string, @Res() res: Response): Promise<void> {
    const image = await this.ogImages.image(slug.slice(0, 80));
    res.status(200);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(image.body.length));
    res.setHeader('ETag', `"${image.etag}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(image.body);
  }

  @Get(':slug/viewing-slots')
  @Public()
  @Throttle(SEARCH_LIMIT)
  @Header('Cache-Control', 'public, max-age=30')
  @ApiEndpoint({
    id: 'public.listings.viewingSlots',
    summary: 'Free viewing times',
    description:
      'Free slots of a published listing’s viewing availability from `from` (`YYYY-MM-DD`, default today in Bangkok) for `days` days (default 14), leaving out times already requested or confirmed and those inside `listing.viewing.min_notice_hours` or beyond `listing.viewing.horizon_days` (D-252). Each slot has a `mode`; `self` slots (G7, D-295) appear only while the listing can offer self-viewing (`viewing.self.enabled`, an active unit lock of the listing tenant, the unit vacant) and need a verified prospect. No personal data.',
    implements: ['D-252', 'D-295'],
  })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 60 } })
  @ApiSuccess(200, {
    description: 'Free slots',
    type: ViewingSlotsDto,
    example: {
      slotMinutes: 30,
      selfViewing: true,
      slots: [
        { startsAt: '2026-11-07T10:00:00+07:00', endsAt: '2026-11-07T10:30:00+07:00', mode: 'accompanied' },
        { startsAt: '2026-11-08T09:00:00+07:00', endsAt: '2026-11-08T09:30:00+07:00', mode: 'self' },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'http.too_many_requests')
  async viewingSlots(
    @Param('slug') slug: string,
    @Query('from') from?: string,
    @Query('days') days?: string,
  ): Promise<ViewingSlotsDto> {
    const span = days && /^\d{1,2}$/.test(days) ? Math.min(60, Math.max(1, Number(days))) : 14;
    const result = await this.leads.slots(slug.slice(0, 80), from, span);
    return {
      slotMinutes: result.slotMinutes,
      selfViewing: result.selfViewing,
      slots: result.slots.map((s) => ({
        startsAt: toBangkokIso(s.startsAt),
        endsAt: toBangkokIso(s.endsAt),
        mode: s.mode as ViewingModeName,
      })),
    };
  }

  @Post(':slug/reports')
  @Public()
  @Throttle(REPORT_LIMIT)
  @ApiEndpoint({
    id: 'public.listings.report',
    summary: 'Report a listing',
    description:
      'A viewer flags a listing (scam, wrong information, not available, duplicate, offensive, other). One open report per viewer; after `listing.report.hide_after` open reports the listing is hidden until a moderator decides (D-252). Who reported is never shown to the owner.',
    implements: ['D-252'],
  })
  @ApiJsonBody(ListingReportDto, { reason: 'scam', details: 'ขอให้โอนมัดจำก่อนดูห้อง' })
  @ApiSuccess(201, { description: 'Received', type: ListingReportedDto, example: { received: true } })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'listing.report_duplicate',
    'http.too_many_requests',
  )
  async report(@Param('slug') slug: string, @Body() body: ListingReportDto): Promise<ListingReportedDto> {
    await this.moderation.report(slug.slice(0, 80), body);
    return { received: true };
  }
}

export class PublicOwnerVerificationDto {
  @ApiProperty({
    enum: ['unit_ownership'],
    enumName: 'PublicOwnerVerificationLevel',
    example: 'unit_ownership',
    description:
      'What the platform verified: ownership of the listed units (D-252); identity follows with D-267.',
  })
  level!: 'unit_ownership';

  @ApiProperty({ type: 'integer', example: 2 })
  verifiedUnits!: number;

  @ApiProperty({ example: true, description: 'The owner’s identity is verified too (e-KYC, D-267).' })
  identityVerified!: boolean;
}

/** The public page of a verified owner (D-274): no contact details. */
export class PublicOwnerDto {
  @ApiProperty({ example: 'landlord-0a1b2c3d4e' })
  slug!: string;

  @ApiProperty({ example: 'มาลี มีสุข' })
  displayName!: string;

  @ApiProperty({ type: PublicOwnerVerificationDto })
  verification!: PublicOwnerVerificationDto;

  @ApiProperty({ format: 'date', example: '2026-10-25' })
  memberSince!: string;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 42,
    description: 'Median minutes to the first answer on an enquiry (12 months; null with fewer than 3).',
  })
  medianReplyMinutes!: number | null;

  @ApiProperty({
    type: [PublicListingSummaryDto],
    description: 'Published listings, newest first (up to 50).',
  })
  listings!: PublicListingSummaryDto[];

  @ApiProperty({ type: 'integer', example: 3 })
  listingCount!: number;
}

@ApiTags('public.owners')
@ApiSurface(SURFACES.public)
@Controller('public/owners')
export class PublicOwnersController {
  constructor(private readonly listings: PublicListingsService) {}

  @Get(':slug')
  @Public()
  @Throttle(SEARCH_LIMIT)
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.owners.get',
    summary: 'A verified owner’s page',
    description:
      'Display name, what the platform verified, member since, median reply time to enquiries and the published listings of an owner with at least one approved ownership verification (D-274, D-252). `404` when there is none or the owner switched the page off (`listing.public_profile.enabled`). No phone, e-mail or address of the owner.',
    implements: ['D-274', 'D-252'],
  })
  @ApiSuccess(200, {
    description: 'Owner',
    type: PublicOwnerDto,
    example: {
      slug: 'landlord-0a1b2c3d4e',
      displayName: 'มาลี มีสุข',
      verification: { level: 'unit_ownership', verifiedUnits: 2, identityVerified: true },
      memberSince: '2026-10-25',
      medianReplyMinutes: 42,
      listings: [SUMMARY_EXAMPLE],
      listingCount: 1,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'http.too_many_requests')
  async get(@Param('slug') slug: string, @Req() req: Request): Promise<PublicOwnerDto> {
    return (await this.listings.ownerProfile(
      slug.slice(0, 80),
      lang(req.headers['accept-language']),
    )) as unknown as PublicOwnerDto;
  }
}

@ApiTags('public.shareLinks')
@ApiSurface(SURFACES.public)
@Controller('public/share-links')
export class PublicShareLinksController {
  constructor(private readonly share: ListingShareService) {}

  @Post(':code/open')
  @HttpCode(200)
  @Public()
  @Throttle(SEARCH_LIMIT)
  @ApiEndpoint({
    id: 'public.shareLinks.open',
    summary: 'Open a share link',
    description:
      'A short link of a listing’s share kit was opened (`<web>/s/{code}`, D-268): counts the click and answers the listing to show and the UTM of its channel. `404` when the code is unknown or the listing is no longer public (the web then shows the search).',
    implements: ['D-268'],
  })
  @ApiSuccess(200, {
    description: 'Where to go',
    type: PublicShareLinkDto,
    example: {
      slug: 'condo-1br-0193f2a4b1',
      channel: 'facebook_group',
      utm: { source: 'facebook_group', medium: 'share', campaign: 'listing' },
    },
  })
  @ApiStandardErrors('http.not_found', 'http.too_many_requests')
  async open(@Param('code') code: string): Promise<PublicShareLinkDto> {
    const { slug, channel } = await this.share.open(code.slice(0, 16));
    return {
      slug,
      channel: channel as ListingChannelName,
      utm: { source: channel, medium: 'share', campaign: 'listing' },
    };
  }
}

import { Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { toBangkokIso } from '@common/time/bangkok';
import { ListingLeadsService } from '@modules/ops-listings/listing-leads.service';
import { ListingModerationService } from '@modules/ops-listings/listing-moderation.service';
import { PublicListingsService } from '@modules/ops-listings/public-listings.service';
import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
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
import { type Request } from 'express';

import { ViewingSlotsDto } from '../owner/leads.dto';
import { FurnishingName, PortfolioUnitKindName } from '../owner/portfolio.controller';
import { MoneyOutput } from '../shared/fields';
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

  @ApiProperty()
  smokingAllowed!: boolean;
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

  @Get(':slug')
  @Public()
  @Throttle(SEARCH_LIMIT)
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.listings.get',
    summary: 'One listing',
    description:
      'The public page of a listing (D-252): description, facilities, every photo in order, floor, map pin, the owner’s display name and verified flag. `404` when it is not (or no longer) public.',
    implements: ['D-252'],
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
      smokingAllowed: false,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'http.too_many_requests')
  async get(@Param('slug') slug: string, @Req() req: Request): Promise<PublicListingDetailDto> {
    return (await this.listings.detail(
      slug.slice(0, 80),
      lang(req.headers['accept-language']),
    )) as unknown as PublicListingDetailDto;
  }

  @Get(':slug/viewing-slots')
  @Public()
  @Throttle(SEARCH_LIMIT)
  @Header('Cache-Control', 'public, max-age=30')
  @ApiEndpoint({
    id: 'public.listings.viewingSlots',
    summary: 'Free viewing times',
    description:
      'Free slots of a published listing’s viewing availability from `from` (`YYYY-MM-DD`, default today in Bangkok) for `days` days (default 14), leaving out times already requested or confirmed and those inside `listing.viewing.min_notice_hours` or beyond `listing.viewing.horizon_days` (D-252). No personal data.',
    implements: ['D-252'],
  })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 60 } })
  @ApiSuccess(200, {
    description: 'Free slots',
    type: ViewingSlotsDto,
    example: {
      slotMinutes: 30,
      slots: [{ startsAt: '2026-11-07T10:00:00+07:00', endsAt: '2026-11-07T10:30:00+07:00' }],
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
      slots: result.slots.map((s) => ({
        startsAt: toBangkokIso(s.startsAt),
        endsAt: toBangkokIso(s.endsAt),
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

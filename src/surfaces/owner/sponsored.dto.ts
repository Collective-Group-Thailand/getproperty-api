import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  AUDIENCE_LANGUAGE_VALUES,
  AudienceLanguageName,
  AudienceUnitKindName,
  QuietHoursWindowDto,
} from '../shared/audience.dto';
import { MoneyInput, MoneyOutput } from '../shared/fields';
import { GrowthInvoiceDto } from './growth.dto';

// G6 (D-287, D-300): sponsored broadcast for buyers (owner console) and the platform team.

/** `platform.sponsored_campaign_state`. */
export enum SponsoredCampaignStateName {
  Draft = 'draft',
  Scheduled = 'scheduled',
  Sending = 'sending',
  Sent = 'sent',
  Cancelled = 'cancelled',
  Rejected = 'rejected',
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PRICE_4 = '^\\d{1,10}\\.\\d{4}$';

/** The closed segment whitelist (D-300): nothing else can be targeted. */
export class SponsoredSegmentDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['ari'],
    description: 'Area / station slugs of `GET /v1/public/listings/areas`; empty = any area.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(/^[a-z0-9-]{1,100}$/, { each: true })
  areas?: string[];

  @MoneyInput({
    example: '8000',
    description: 'People whose budget reaches at least this.',
    optional: true,
    nullable: true,
  })
  budgetMin?: string | null;

  @MoneyInput({
    example: '20000',
    description: 'People whose budget starts at most at this.',
    optional: true,
    nullable: true,
  })
  budgetMax?: string | null;

  @ApiPropertyOptional({ enum: AudienceUnitKindName, enumName: 'PortfolioUnitKind', isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsEnum(AudienceUnitKindName, { each: true })
  unitKinds?: AudienceUnitKindName[];

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2026-12-01' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DAY)
  moveInFrom?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2027-01-31' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DAY)
  moveInTo?: string | null;

  @ApiPropertyOptional({
    enum: AudienceLanguageName,
    enumName: 'ResidentLanguage',
    isArray: true,
    example: [],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(AUDIENCE_LANGUAGE_VALUES, { each: true })
  languages?: string[];
}

export class SponsoredSegmentOutDto {
  @ApiProperty({ type: [String], example: ['ari'] })
  areas!: string[];

  @MoneyOutput({ example: null, nullable: true, description: 'Budget from.' })
  budgetMin!: string | null;

  @MoneyOutput({ example: null, nullable: true, description: 'Budget to.' })
  budgetMax!: string | null;

  @ApiProperty({ enum: AudienceUnitKindName, enumName: 'PortfolioUnitKind', isArray: true })
  unitKinds!: AudienceUnitKindName[];

  @ApiProperty({ type: String, format: 'date', nullable: true })
  moveInFrom!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  moveInTo!: string | null;

  @ApiProperty({ type: [String], example: [] })
  languages!: string[];
}

export class SponsoredEstimateRequestDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'My own published listings (1–`broadcast.sponsored.max_listings`).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  listingIds!: string[];

  @ApiProperty({ type: SponsoredSegmentDto })
  @ValidateNested()
  @Type(() => SponsoredSegmentDto)
  segment!: SponsoredSegmentDto;

  @ApiProperty({ type: 'integer', example: 1000, description: 'Send to at most this many people.' })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxRecipients!: number;
}

export class SponsoredCampaignCreateDto extends SponsoredEstimateRequestDto {
  @ApiProperty({ example: 'คอนโดอารีย์ ต้นเดือนธันวา' })
  @IsString()
  @Length(1, 120)
  name!: string;
}

export class SponsoredScheduleDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When to start sending (now when empty; up to 90 days ahead).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  scheduledAt?: string | null;
}

export class SponsoredCampaignListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: SponsoredCampaignStateName, enumName: 'SponsoredCampaignState' })
  @IsOptional()
  @IsEnum(SponsoredCampaignStateName)
  state?: SponsoredCampaignStateName;
}

export class SponsoredCostDto {
  @ApiProperty({ type: 'integer', example: 1000 })
  recipients!: number;

  @MoneyOutput({ example: '500.00', description: 'Before VAT.' })
  subtotal!: string;

  @MoneyOutput({ example: '35.00', description: 'VAT.' })
  vatAmount!: string;

  @MoneyOutput({ example: '535.00', description: 'Incl. VAT.' })
  total!: string;
}

export class SponsoredProductDto {
  @ApiProperty({
    example: false,
    description:
      'Sponsored broadcasts may be scheduled (`broadcast.sponsored.enabled`, off until LINE Thailand confirms, O-023).',
  })
  enabled!: boolean;

  @ApiProperty({
    example: false,
    description: 'A price per recipient is set (O-027); false = "ยังไม่เปิดขาย".',
  })
  onSale!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    pattern: PRICE_4,
    example: null,
    description: 'Price per delivered recipient before VAT (4 decimals; THB); null = not on sale.',
  })
  pricePerRecipient!: string | null;

  @ApiProperty({ example: '0.0700' })
  vatRate!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({
    type: 'integer',
    example: 500,
    description: 'A campaign must reach at least this many people.',
  })
  minimumRecipients!: number;

  @ApiProperty({ type: 'integer', example: 5 })
  maxListings!: number;

  @ApiProperty({ type: 'integer', example: 2, description: 'No person gets more sponsored messages a week.' })
  maxPerWeek!: number;
}

export class SponsoredEstimateDto {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 1000,
    description: 'People who would get it now (≤ maxRecipients); null below the minimum — never a person.',
  })
  estimated!: number | null;

  @ApiProperty({ example: false })
  belowMinimum!: boolean;

  @ApiProperty({ type: 'integer', example: 500 })
  minimumRecipients!: number;

  @ApiProperty({
    type: SponsoredCostDto,
    nullable: true,
    description: 'Null when not on sale or below the minimum.',
  })
  cost!: SponsoredCostDto | null;

  @ApiProperty({ type: SponsoredProductDto })
  product!: SponsoredProductDto;
}

export class SponsoredCampaignListingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'condo-1br-0a1b2c3d4e' })
  slug!: string;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  title!: string;

  @ApiProperty({ example: true })
  public!: boolean;
}

export class SponsoredCampaignDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'คอนโดอารีย์ ต้นเดือนธันวา' })
  name!: string;

  @ApiProperty({ enum: SponsoredCampaignStateName, enumName: 'SponsoredCampaignState' })
  state!: SponsoredCampaignStateName;

  @ApiProperty({ type: [SponsoredCampaignListingDto] })
  listings!: SponsoredCampaignListingDto[];

  @ApiProperty({ type: SponsoredSegmentOutDto })
  segment!: SponsoredSegmentOutDto;

  @ApiProperty({ type: 'integer', example: 1000 })
  maxRecipients!: number;

  @ApiProperty({ type: 'integer', nullable: true, example: 1000, description: 'Null below the minimum.' })
  estimated!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    pattern: PRICE_4,
    example: '0.5000',
    description: 'Snapshot at scheduling.',
  })
  pricePerRecipient!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '0.0700' })
  vatRate!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 500 })
  minimumRecipients!: number | null;

  @ApiProperty({ type: 'integer', example: 0, description: 'People it was delivered to (aggregate).' })
  delivered!: number;

  @ApiProperty({ type: 'integer', example: 0, description: 'Clicks on the campaign’s links (aggregate).' })
  clicks!: number;

  @ApiProperty({ type: GrowthInvoiceDto, nullable: true, description: 'The purchase invoice once sent.' })
  invoice!: GrowthInvoiceDto | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  rejectReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  sendingStartedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class SponsoredReportDto {
  @ApiProperty({ format: 'uuid' })
  campaignId!: string;

  @ApiProperty({ enum: SponsoredCampaignStateName, enumName: 'SponsoredCampaignState' })
  state!: SponsoredCampaignStateName;

  @ApiProperty({ type: 'integer', example: 812 })
  sent!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: null,
    description: 'Not available: LINE gives no per-message opens for a multicast.',
  })
  opened!: number | null;

  @ApiProperty({ type: 'integer', example: 64 })
  clicks!: number;

  @ApiProperty({
    type: 'integer',
    example: 5,
    description: 'Enquiries on these listings by people who got the message, within `attributionDays`.',
  })
  leads!: number;

  @ApiProperty({ type: 'integer', example: 7 })
  attributionDays!: number;

  @ApiProperty({ type: GrowthInvoiceDto, nullable: true })
  invoice!: GrowthInvoiceDto | null;
}

export class AdminSponsoredCampaignDto extends SponsoredCampaignDto {
  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'มาลี มีสุข' })
  tenantName!: string;
}

export class BroadcastSettingsUpdateDto {
  @ApiPropertyOptional({ description: 'Only after LINE Thailand’s written confirmation (O-023).' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 7 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7)
  maxPerWeek?: number;

  @ApiPropertyOptional({ type: QuietHoursWindowDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuietHoursWindowDto)
  quietHours?: QuietHoursWindowDto;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxListings?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 168 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  sendWindowHours?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  attributionDays?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 36 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36)
  deliveryKeepMonths?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 90 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  preferencesKeepDays?: number;

  @ApiProperty({
    example: 'LINE Thailand confirmed by e-mail 2026-11-10 (O-023)',
    description: 'Recorded on every changed setting version.',
  })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class ConsentTextDto {
  @ApiProperty({ example: 'รับห้องแนะนำจาก getproperty (รวมโฆษณา)' })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ example: '…', description: 'Markdown: purpose, data used, profiling note, how to stop.' })
  @IsString()
  @Length(20, 10_000)
  bodyMarkdown!: string;
}

export class BroadcastConsentTextCreateDto {
  @ApiProperty({ type: ConsentTextDto })
  @ValidateNested()
  @Type(() => ConsentTextDto)
  th!: ConsentTextDto;

  @ApiProperty({ type: ConsentTextDto })
  @ValidateNested()
  @Type(() => ConsentTextDto)
  en!: ConsentTextDto;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'From now when empty; never backdated.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  effectiveFrom?: string | null;
}

export class BroadcastConsentTextDto {
  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  effectiveFrom!: string;

  @ApiProperty({ type: ConsentTextDto })
  th!: ConsentTextDto;

  @ApiProperty({ type: ConsentTextDto })
  en!: ConsentTextDto;
}

export class BroadcastSettingsDto {
  @ApiProperty({ example: false })
  enabled!: boolean;

  @ApiProperty({ type: 'integer', example: 2 })
  maxPerWeek!: number;

  @ApiProperty({ type: QuietHoursWindowDto })
  quietHours!: QuietHoursWindowDto;

  @ApiProperty({ type: 'integer', example: 5 })
  maxListings!: number;

  @ApiProperty({ type: 'integer', example: 24 })
  sendWindowHours!: number;

  @ApiProperty({ type: 'integer', example: 7 })
  attributionDays!: number;

  @ApiProperty({ type: 'integer', example: 12 })
  deliveryKeepMonths!: number;

  @ApiProperty({ type: 'integer', example: 30 })
  preferencesKeepDays!: number;

  @ApiProperty({
    type: BroadcastConsentTextDto,
    nullable: true,
    description: 'The `platform.recommendations` text in force (th / en).',
  })
  consentText!: BroadcastConsentTextDto | null;

  @ApiProperty({
    type: 'integer',
    example: 1240,
    description: 'People consenting at the current version (aggregate).',
  })
  consenting!: number;
}

export const PRODUCT_EXAMPLE: SponsoredProductDto = {
  enabled: false,
  onSale: false,
  pricePerRecipient: null,
  vatRate: '0.0700',
  currency: 'THB',
  minimumRecipients: 500,
  maxListings: 5,
  maxPerWeek: 2,
};

export const CAMPAIGN_EXAMPLE: SponsoredCampaignDto = {
  id: FAKE.uuid,
  name: 'คอนโดอารีย์ ต้นเดือนธันวา',
  state: SponsoredCampaignStateName.Draft,
  listings: [
    {
      id: '0199f2a0-0000-7000-8000-0000000000d2',
      slug: 'condo-1br-0a1b2c3d4e',
      title: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
      public: true,
    },
  ],
  segment: {
    areas: ['ari'],
    budgetMin: null,
    budgetMax: null,
    unitKinds: [AudienceUnitKindName.CondoUnit],
    moveInFrom: null,
    moveInTo: null,
    languages: [],
  },
  maxRecipients: 1000,
  estimated: 1000,
  scheduledAt: null,
  pricePerRecipient: null,
  vatRate: null,
  minimumRecipients: null,
  delivered: 0,
  clicks: 0,
  invoice: null,
  rejectReason: null,
  sendingStartedAt: null,
  completedAt: null,
  createdAt: FAKE.dateTime,
};

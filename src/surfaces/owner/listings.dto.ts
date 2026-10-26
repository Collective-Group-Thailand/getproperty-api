import { FAKE } from '@common/openapi/examples';
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
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MoneyInput, MoneyOutput } from '../shared/fields';
import { ListingUtilityDto } from '../shared/listing-insights.dto';
import { FurnishingName, PortfolioUnitKindName } from './portfolio.controller';

export enum ListingStateName {
  Draft = 'draft',
  PendingReview = 'pending_review',
  Published = 'published',
  Paused = 'paused',
  Closed = 'closed',
  Rejected = 'rejected',
}
export enum ListingCloseReasonName {
  Leased = 'leased',
  Withdrawn = 'withdrawn',
  Hidden = 'hidden',
}
export enum ListingReviewReasonName {
  FirstListing = 'first_listing',
  PriceOutlier = 'price_outlier',
  FlaggedWords = 'flagged_words',
}
export enum OwnershipEvidenceName {
  TitleDeed = 'title_deed',
  CondoTitle = 'condo_title',
  SaleContract = 'sale_contract',
}
export enum ListingVerificationStateName {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
}

export class ListingTransitDto {
  @ApiProperty({ example: 'BTS อารีย์' })
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'BTS สายสุขุมวิท' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  line?: string | null;

  @ApiProperty({ type: 'integer', example: 350, description: 'Walking distance in metres.' })
  @IsInt()
  @Min(0)
  @Max(50000)
  distanceM!: number;
}

class ListingFieldsDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'One-bedroom with a city view near BTS Ari' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  titleEn?: string | null;

  @ApiPropertyOptional({ example: 'ห้องมุม แสงดี เฟอร์นิเจอร์ครบ เดินไป BTS 5 นาที' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  descriptionTh?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ type: 'integer', example: 2, description: 'Months of rent held as deposit.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  depositMonths?: number;

  @ApiPropertyOptional({ type: 'integer', example: 1, description: 'Months of rent paid in advance.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  advanceMonths?: number;

  @ApiPropertyOptional({ type: 'integer', example: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  minTermMonths?: number;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2026-12-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  availableFrom?: string | null;

  @ApiPropertyOptional({ enum: FurnishingName, enumName: 'Furnishing', nullable: true })
  @IsOptional()
  @IsEnum(FurnishingName)
  furnishing?: FurnishingName | null;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  petsAllowed?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  smokingAllowed?: boolean;

  @ApiPropertyOptional({ type: [String], example: ['pool', 'fitness', 'parking', 'washing_machine'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  facilities?: string[];

  @ApiPropertyOptional({
    example: false,
    description:
      'Show the unit number in the public address (D-252: the rest of the address is always public).',
  })
  @IsOptional()
  @IsBoolean()
  showUnitNo?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'D-265: show the average of the unit’s last confirmed utility bills (only with at least `listing.utility_history.min_bills` of them; the rates are always shown).',
  })
  @IsOptional()
  @IsBoolean()
  showUtilityHistory?: boolean;

  @ApiPropertyOptional({ type: ListingTransitDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingTransitDto)
  transit?: ListingTransitDto | null;
}

export class ListingCreateDto extends ListingFieldsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  unitId!: string;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  @IsString()
  @Length(1, 120)
  titleTh!: string;

  @MoneyInput({ example: '15000.00', description: 'Monthly rent.' })
  rent!: string;
}

export class ListingUpdateDto extends ListingFieldsDto {
  @ApiPropertyOptional({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  titleTh?: string;

  @MoneyInput({ example: '15000.00', description: 'Monthly rent.', optional: true })
  rent?: string;
}

export class ListingPhotoAddDto {
  @ApiProperty({ format: 'uuid', description: 'A scanned document of kind `listing_photo` of this tenant.' })
  @IsUUID()
  documentId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ห้องนั่งเล่น' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  caption?: string | null;
}

export class ListingPhotoOrderItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  caption?: string | null;
}

export class ListingPhotosArrangeDto {
  @ApiProperty({
    type: [ListingPhotoOrderItemDto],
    description: 'Every photo once, in the new order (first = cover).',
  })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ListingPhotoOrderItemDto)
  photos!: ListingPhotoOrderItemDto[];
}

export class WeeklySlotDto {
  @ApiProperty({ type: 'integer', example: 6, description: '0 = Sunday … 6 = Saturday.' })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty({ example: '10:00' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  from!: string;

  @ApiProperty({ example: '16:00' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  to!: string;
}

export class AvailabilityExceptionDto {
  @ApiProperty({ format: 'date', example: '2026-12-31' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  closed?: boolean;

  @ApiPropertyOptional({ example: '13:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  from?: string;

  @ApiPropertyOptional({ example: '15:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  to?: string;
}

export class ListingAvailabilityDto {
  @ApiProperty({ type: [WeeklySlotDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WeeklySlotDto)
  weekly!: WeeklySlotDto[];

  @ApiProperty({ type: [AvailabilityExceptionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityExceptionDto)
  exceptions?: AvailabilityExceptionDto[];

  @ApiProperty({ type: 'integer', example: 30, description: 'Length of one viewing slot in minutes.' })
  @IsOptional()
  @IsIn([15, 20, 30, 45, 60, 90, 120])
  slotMinutes?: number;
}

export class ListingPhotoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ type: 'integer', example: 0 })
  sortOrder!: number;

  @ApiProperty({ type: String, nullable: true })
  caption!: string | null;

  @ApiProperty({
    example: 'https://storage.invalid/t/…/photo.w480.webp',
    description: 'A 480 px preview (signed).',
  })
  url!: string;
}

export class ListingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  unitId!: string;

  @ApiProperty({ format: 'uuid' })
  buildingId!: string;

  @ApiProperty({ enum: ListingStateName, enumName: 'ListingState', example: ListingStateName.Published })
  state!: ListingStateName;

  @ApiProperty({
    example: 'condo-1br-0a1b2c3d4e',
    description: 'Public page: /rent/{slug} on the marketing host.',
  })
  slug!: string;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  titleTh!: string;

  @ApiProperty({ type: String, nullable: true })
  titleEn!: string | null;

  @ApiProperty()
  descriptionTh!: string;

  @ApiProperty({ type: String, nullable: true })
  descriptionEn!: string | null;

  @MoneyOutput({ example: '15000.00', description: 'Monthly rent.' })
  rent!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  depositMonths!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  advanceMonths!: number;

  @ApiProperty({ type: 'integer', example: 12 })
  minTermMonths!: number;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  availableFrom!: string | null;

  @ApiProperty({ enum: FurnishingName, enumName: 'Furnishing', nullable: true })
  furnishing!: FurnishingName | null;

  @ApiProperty()
  petsAllowed!: boolean;

  @ApiProperty()
  smokingAllowed!: boolean;

  @ApiProperty({ type: [String] })
  facilities!: string[];

  @ApiProperty()
  showUnitNo!: boolean;

  @ApiProperty({
    example: true,
    description: 'D-265: the average of the last confirmed utility bills is shown.',
  })
  showUtilityHistory!: boolean;

  @ApiProperty({
    type: ListingUtilityDto,
    nullable: true,
    description: 'What the public listing shows of the unit’s utility cost (D-265).',
  })
  utility!: ListingUtilityDto | null;

  @ApiProperty({ type: ListingTransitDto, nullable: true })
  transit!: ListingTransitDto | null;

  @ApiProperty({ enum: PortfolioUnitKindName, enumName: 'PortfolioUnitKind', nullable: true })
  unitKind!: PortfolioUnitKindName | null;

  @ApiProperty({ type: String, nullable: true, example: '28.50' })
  sizeSqm!: string | null;

  @ApiProperty({ type: 'integer', nullable: true })
  bedrooms!: number | null;

  @ApiProperty({ type: 'integer', nullable: true })
  bathrooms!: number | null;

  @ApiProperty({ type: String, nullable: true })
  floorLabel!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'กรุงเทพมหานคร' })
  province!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'พญาไท' })
  district!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The public address line (D-252).' })
  address!: string | null;

  @ApiProperty({ type: [ListingPhotoDto] })
  photos!: ListingPhotoDto[];

  @ApiProperty({ type: ListingAvailabilityDto })
  availability!: ListingAvailabilityDto;

  @ApiProperty({
    enum: ListingReviewReasonName,
    enumName: 'ListingReviewReason',
    isArray: true,
    description: 'Why a submitted listing waits for a moderator.',
  })
  reviewReasons!: ListingReviewReasonName[];

  @ApiProperty({ type: String, nullable: true, description: 'The moderator’s reason when rejected.' })
  rejectedReason!: string | null;

  @ApiProperty({ description: 'Hidden from the public pending review (reports or a moderator).' })
  hidden!: boolean;

  @ApiProperty({ type: 'integer', description: 'Open reports from viewers (never who reported).' })
  reportCount!: number;

  @ApiProperty({ description: 'The unit’s owner is verified (badge "เจ้าของตัวจริง").' })
  verifiedOwner!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt!: string | null;

  @ApiProperty({ enum: ListingCloseReasonName, enumName: 'ListingCloseReason', nullable: true })
  closedReason!: ListingCloseReasonName | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class VerificationRequestDto {
  @ApiProperty({
    enum: OwnershipEvidenceName,
    enumName: 'OwnershipEvidence',
    example: OwnershipEvidenceName.CondoTitle,
  })
  @IsEnum(OwnershipEvidenceName)
  evidenceKind!: OwnershipEvidenceName;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Uploaded documents of kind `certificate` (presign with scope `unit`). 1–5.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  documentIds!: string[];

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class VerificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  unitId!: string;

  @ApiProperty({ enum: ListingVerificationStateName, enumName: 'ListingVerificationState' })
  state!: ListingVerificationStateName;

  @ApiProperty({ enum: OwnershipEvidenceName, enumName: 'OwnershipEvidence' })
  evidenceKind!: OwnershipEvidenceName;

  @ApiProperty({ type: 'integer', description: 'Evidence files (deleted after the retention, O-018).' })
  evidenceCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The reason when rejected.' })
  decisionNote!: string | null;
}

export class UnitVerificationDto {
  @ApiProperty({
    description: 'An approved verification exists: the badge shows on the unit\u2019s listings.',
  })
  verified!: boolean;

  @ApiProperty({ type: VerificationDto, nullable: true, description: 'The latest request, if any.' })
  latest!: VerificationDto | null;
}

export const LISTING_EXAMPLE = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  buildingId: FAKE.buildingId,
  state: 'published',
  slug: 'condo-1br-0a1b2c3d4e',
  titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
  titleEn: null,
  descriptionTh: 'ห้องมุม แสงดี เฟอร์นิเจอร์ครบ',
  descriptionEn: null,
  rent: '15000.00',
  depositMonths: 2,
  advanceMonths: 1,
  minTermMonths: 12,
  availableFrom: '2026-12-01',
  furnishing: 'fully_furnished',
  petsAllowed: false,
  smokingAllowed: false,
  facilities: ['pool', 'fitness'],
  showUnitNo: false,
  showUtilityHistory: true,
  utility: null,
  transit: { name: 'BTS อารีย์', line: 'BTS สายสุขุมวิท', distanceM: 350 },
  unitKind: 'condo_unit',
  sizeSqm: '28.50',
  bedrooms: 1,
  bathrooms: 1,
  floorLabel: '12',
  province: 'กรุงเทพมหานคร',
  district: 'พญาไท',
  address: 'ถนนพหลโยธิน, พญาไท, กรุงเทพมหานคร 10400',
  photos: [
    {
      id: FAKE.uuid,
      documentId: FAKE.uuid,
      sortOrder: 0,
      caption: null,
      url: 'https://storage.invalid/p.w480.webp',
    },
  ],
  availability: { weekly: [{ weekday: 6, from: '10:00', to: '16:00' }], exceptions: [], slotMinutes: 30 },
  reviewReasons: [],
  rejectedReason: null,
  hidden: false,
  reportCount: 0,
  verifiedOwner: true,
  publishedAt: FAKE.dateTime,
  closedReason: null,
  version: 3,
};

export const VERIFICATION_EXAMPLE = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  state: 'pending',
  evidenceKind: 'condo_title',
  evidenceCount: 1,
  submittedAt: FAKE.dateTime,
  decidedAt: null,
  decisionNote: null,
};

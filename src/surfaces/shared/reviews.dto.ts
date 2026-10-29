import { PageMeta, PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import { UserLanguageName } from './me.dto';

/** G9 (D-301): verified building reviews — DTOs shared by the resident, public, owner and admin surfaces. */

export enum BuildingReviewStateName {
  PendingModeration = 'pending_moderation',
  Published = 'published',
  Rejected = 'rejected',
  Hidden = 'hidden',
  Withdrawn = 'withdrawn',
}

export enum ReviewIneligibleReasonName {
  NotStarted = 'not_started',
  TooEarly = 'too_early',
  WindowClosed = 'window_closed',
}

export class ConsentPurposeTextDto {
  @ApiProperty({ example: 'review.publish' })
  purposeKey!: string;

  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'The current version; send it as `consentVersion`.',
  })
  version!: number;

  @ApiProperty({ example: 'เผยแพร่รีวิวอาคารของฉัน' })
  title!: string;

  @ApiProperty({ example: 'ร่าง ⚖ — เลือกได้ …', description: 'Plain-language purpose (Markdown, ⚖ draft).' })
  bodyMarkdown!: string;
}

export class ReviewTenureDto {
  @ApiProperty({ example: '2025-01', description: 'Month the reviewer started living there (`YYYY-MM`).' })
  from!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-03',
    description: 'Month they moved out (`YYYY-MM`); null = still living there. Exact dates are never shown.',
  })
  to!: string | null;
}

export class ReviewEligibilityDto {
  @ApiProperty({ example: true })
  eligible!: boolean;

  @ApiProperty({
    enum: ReviewIneligibleReasonName,
    enumName: 'ReviewIneligibleReason',
    nullable: true,
    description:
      '`not_started` (never lived under this lease, or only as a guarantor), `too_early` (before `review.min_tenure_months`), `window_closed` (more than `review.window_after_end_days` after moving out).',
  })
  reason!: ReviewIneligibleReasonName | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: null,
    description: 'With `too_early`: the first day a review is possible.',
  })
  eligibleFrom!: string | null;

  @ApiProperty({ type: ReviewTenureDto, nullable: true })
  tenure!: ReviewTenureDto | null;
}

export class MyReviewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: BuildingReviewStateName, enumName: 'BuildingReviewState' })
  state!: BuildingReviewStateName;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 4 })
  rating!: number;

  @ApiProperty({ type: String, nullable: true, description: 'Null once withdrawn (erased).' })
  body!: string | null;

  @ApiProperty({ example: 'th' })
  language!: string;

  @ApiProperty({ type: ReviewTenureDto })
  tenure!: ReviewTenureDto;

  @ApiProperty({ format: 'date-time' })
  submittedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'With `rejected`: the moderator’s reason.' })
  moderationReason!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The building owner’s public reply.' })
  ownerReply!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ownerRepliedAt!: string | null;
}

export class ResidentReviewDto {
  @ApiProperty({ type: ReviewEligibilityDto })
  eligibility!: ReviewEligibilityDto;

  @ApiProperty({
    type: MyReviewDto,
    nullable: true,
    description: 'My review of this lease, if any (one per lease).',
  })
  review!: MyReviewDto | null;

  @ApiProperty({
    type: ConsentPurposeTextDto,
    nullable: true,
    description: 'The `review.publish` text to show and accept with the review (never pre-ticked).',
  })
  consent!: ConsentPurposeTextDto | null;
}

export class ReviewSubmitDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiProperty({
    example: 'ตึกสะอาด ลิฟต์เร็ว นิติฯ ตอบไว แต่ที่จอดรถน้อย',
    minLength: 10,
    maxLength: 2000,
    description:
      'No phone numbers, e-mail, LINE ids, links, bank accounts or ID numbers (`review.personal_data`).',
  })
  @IsString()
  @Length(10, 2000)
  body!: string;

  @ApiPropertyOptional({ enum: UserLanguageName, enumName: 'ResidentLanguage', example: UserLanguageName.Th })
  @IsOptional()
  @IsEnum(UserLanguageName)
  language?: UserLanguageName;

  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'The `review.publish` version I read and accept (must be the current one).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  consentVersion!: number;
}

export class PublicReviewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 4 })
  rating!: number;

  @ApiProperty({ example: 'ตึกสะอาด ลิฟต์เร็ว นิติฯ ตอบไว แต่ที่จอดรถน้อย' })
  body!: string;

  @ApiProperty({ example: 'th' })
  language!: string;

  @ApiProperty({ type: ReviewTenureDto })
  tenure!: ReviewTenureDto;

  @ApiProperty({
    example: true,
    description: 'Always true: only people who lived under a lease on getproperty can review (D-301).',
  })
  verifiedTenant!: boolean;

  @ApiProperty({ format: 'date-time' })
  publishedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  ownerReply!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ownerRepliedAt!: string | null;
}

export class ReviewSummaryDto {
  @ApiProperty({ type: 'integer', example: 12 })
  count!: number;

  @ApiProperty({ type: String, nullable: true, example: '4.3', description: 'Average rating, one decimal.' })
  average!: string | null;

  @ApiProperty({
    type: [Number],
    example: [0, 1, 1, 4, 6],
    description: 'Published reviews per star, index 0 = 1 star.',
  })
  distribution!: number[];
}

export class PublicReviewsDto {
  @ApiProperty({ type: ReviewSummaryDto })
  summary!: ReviewSummaryDto;

  @ApiProperty({ type: [PublicReviewDto] })
  data!: PublicReviewDto[];

  @ApiProperty({ type: PageMeta })
  meta!: PageMeta;
}

export class OwnerReviewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  buildingId!: string;

  @ApiProperty({ example: 'ไอดีโอ โมบิ อารีย์' })
  buildingName!: string;

  @ApiProperty({ enum: BuildingReviewStateName, enumName: 'BuildingReviewState' })
  state!: BuildingReviewStateName;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 4 })
  rating!: number;

  @ApiProperty({ type: String, nullable: true })
  body!: string | null;

  @ApiProperty({ example: 'th' })
  language!: string;

  @ApiProperty({ type: ReviewTenureDto })
  tenure!: ReviewTenureDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'With `hidden`: the moderator’s reason.' })
  moderationReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ownerReply!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ownerRepliedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When this tenant reported the review to the moderators (open report).',
  })
  reportedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reportReason!: string | null;
}

export class AdminReviewDto extends OwnerReviewDto {
  @ApiProperty({ format: 'uuid', description: 'The lessor tenant of the reviewed lease.' })
  tenantId!: string;

  @ApiProperty({ format: 'date-time' })
  submittedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  moderatedAt!: string | null;
}

export class ReviewReplyDto {
  @ApiProperty({
    example: 'ขอบคุณสำหรับรีวิวครับ เดือนหน้าเราจะเพิ่มที่จอดรถอีก 10 คัน',
    minLength: 1,
    maxLength: 1000,
    description: 'Public; no contact or account data (`review.personal_data`).',
  })
  @IsString()
  @Length(1, 1000)
  reply!: string;
}

export class OwnerReviewListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({
    enum: [BuildingReviewStateName.Published, BuildingReviewStateName.Hidden],
    enumName: 'OwnerReviewState',
  })
  @IsOptional()
  @IsIn([BuildingReviewStateName.Published, BuildingReviewStateName.Hidden])
  state?: BuildingReviewStateName;
}

export class AdminReviewListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: BuildingReviewStateName, enumName: 'BuildingReviewState' })
  @IsOptional()
  @IsEnum(BuildingReviewStateName)
  state?: BuildingReviewStateName;

  @ApiPropertyOptional({ type: Boolean, description: 'true = with an open owner report only.' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : (value as unknown)))
  @IsBoolean()
  reported?: boolean;
}

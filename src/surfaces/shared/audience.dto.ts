import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { ResidentLanguageName as AudienceLanguageName } from '../owner/parties.dto';
import { PortfolioUnitKindName as AudienceUnitKindName } from '../owner/portfolio.controller';
import { MoneyInput, MoneyOutput } from './fields';

// G6 (D-287, D-300): recommendations consent, preferences and history of a person (resident / prospect LIFF).

/** `ops.portfolio_unit_kind` — what kind of place (the public listings' enum). */
export { AudienceUnitKindName };

export const AUDIENCE_LANGUAGE_VALUES = ['th', 'en', 'my', 'km', 'lo', 'zh'] as const;
/** Languages of the LIFF (th, en, my, km, lo, zh) — the resident language enum. */
export { AudienceLanguageName };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class QuietHoursDto {
  @ApiProperty({ example: '22:00', pattern: HHMM.source, description: 'Local time (Asia/Bangkok), HH:MM.' })
  @IsString()
  @Matches(HHMM)
  start!: string;

  @ApiProperty({ example: '07:00', pattern: HHMM.source })
  @IsString()
  @Matches(HHMM)
  end!: string;
}

export class AudiencePreferencesInputDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['ari', 'chatuchak'],
    description: 'Up to 10 area / station slugs of `GET /v1/public/listings/areas`; empty = anywhere.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(/^[a-z0-9-]{1,100}$/, { each: true })
  areas?: string[];

  @MoneyInput({
    example: '8000',
    description: 'Lowest monthly rent I look at.',
    optional: true,
    nullable: true,
  })
  @ValidateIf((_, v) => v !== null)
  budgetMin?: string | null;

  @MoneyInput({
    example: '15000',
    description: 'Highest monthly rent I look at.',
    optional: true,
    nullable: true,
  })
  @ValidateIf((_, v) => v !== null)
  budgetMax?: string | null;

  @ApiPropertyOptional({
    enum: AudienceUnitKindName,
    enumName: 'PortfolioUnitKind',
    isArray: true,
    example: [AudienceUnitKindName.CondoUnit],
    description: 'Empty = any kind.',
  })
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
    example: 'th',
    description: 'Language of the messages (Thai, else English text is sent).',
  })
  @IsOptional()
  @IsIn(AUDIENCE_LANGUAGE_VALUES)
  language?: string;

  @ApiPropertyOptional({
    type: QuietHoursDto,
    nullable: true,
    description: 'My own quiet hours; null = the platform default (`broadcast.sponsored.quiet_hours`).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => QuietHoursDto)
  quietHours?: QuietHoursDto | null;
}

export class RecommendationsUpdateDto {
  @ApiPropertyOptional({
    type: 'integer',
    example: 1,
    description:
      'I tick “receive recommended places” now: the version of the text I was shown (it must be the current one). Leave it out to keep an earlier grant; nothing is ever granted without it.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  consentVersion?: number;

  @ApiProperty({ type: AudiencePreferencesInputDto })
  @ValidateNested()
  @Type(() => AudiencePreferencesInputDto)
  preferences!: AudiencePreferencesInputDto;
}

export class RecommendationsConsentDto {
  @ApiProperty({ example: 'platform.recommendations' })
  purposeKey!: string;

  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'The current version; send it as `consentVersion`.',
  })
  version!: number;

  @ApiProperty({ example: 'th' })
  language!: string;

  @ApiProperty({ example: 'รับห้องแนะนำจาก getproperty (รวมโฆษณา)' })
  title!: string;

  @ApiProperty({
    example: 'ร่าง ⚖ — เลือกรับหรือไม่ก็ได้ …',
    description: 'Plain-language purpose with the profiling note (Markdown).',
  })
  bodyMarkdown!: string;

  @ApiProperty({ format: 'date-time' })
  effectiveFrom!: string;

  @ApiProperty({
    example: false,
    description: 'True only after my explicit grant of the current version — never pre-ticked (D-300).',
  })
  granted!: boolean;

  @ApiProperty({ type: 'integer', nullable: true, example: null, description: 'The version I last granted.' })
  grantedVersion!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  capturedAt!: string | null;
}

export class QuietHoursOutDto {
  @ApiProperty({ example: '21:00' })
  start!: string;

  @ApiProperty({ example: '08:00' })
  end!: string;
}

/** Quiet hours with their time zone (the platform default; also the admin setting's shape). */
export class QuietHoursWindowDto {
  @ApiProperty({ example: '21:00', pattern: HHMM.source })
  @IsString()
  @Matches(HHMM)
  start!: string;

  @ApiProperty({ example: '08:00', pattern: HHMM.source })
  @IsString()
  @Matches(HHMM)
  end!: string;

  @ApiProperty({ example: 'Asia/Bangkok' })
  @IsString()
  @Length(3, 64)
  timezone!: string;
}

export class AudiencePreferencesDto {
  @ApiProperty({ type: [String], example: ['ari'] })
  areas!: string[];

  @MoneyOutput({ example: '8000.00', nullable: true, description: 'Lowest rent.' })
  budgetMin!: string | null;

  @MoneyOutput({ example: '15000.00', nullable: true, description: 'Highest rent.' })
  budgetMax!: string | null;

  @ApiProperty({ enum: AudienceUnitKindName, enumName: 'PortfolioUnitKind', isArray: true })
  unitKinds!: AudienceUnitKindName[];

  @ApiProperty({ type: String, format: 'date', nullable: true })
  moveInFrom!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  moveInTo!: string | null;

  @ApiProperty({ example: 'th' })
  language!: string;

  @ApiProperty({ type: QuietHoursOutDto, nullable: true })
  quietHours!: QuietHoursOutDto | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class RecommendationsDto {
  @ApiProperty({ type: RecommendationsConsentDto })
  consent!: RecommendationsConsentDto;

  @ApiProperty({
    type: AudiencePreferencesDto,
    nullable: true,
    description: 'Null while I have not consented (or withdrew).',
  })
  preferences!: AudiencePreferencesDto | null;

  @ApiProperty({
    type: 'integer',
    example: 2,
    description: 'At most this many sponsored messages in any 7 days (`broadcast.sponsored.max_per_week`).',
  })
  maxPerWeek!: number;

  @ApiProperty({ type: QuietHoursWindowDto, description: 'The default quiet hours when I set none.' })
  quietHours!: QuietHoursWindowDto;
}

export class RecommendationHistoryListingDto {
  @ApiProperty({ example: 'condo-1br-0a1b2c3d4e' })
  slug!: string;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  title!: string;

  @ApiProperty({ description: 'Still published (false = the page no longer opens).' })
  public!: boolean;
}

export class RecommendationHistoryItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  sentAt!: string;

  @ApiProperty({ example: 'โฆษณา', description: 'Every sponsored message was labelled as an ad.' })
  label!: string;

  @ApiProperty({ example: 'มาลี มีสุข', description: 'Who paid for it (the listing owner or agency).' })
  sponsor!: string;

  @ApiProperty({ type: [RecommendationHistoryListingDto] })
  listings!: RecommendationHistoryListingDto[];
}

export const RECOMMENDATIONS_EXAMPLE: RecommendationsDto = {
  consent: {
    purposeKey: 'platform.recommendations',
    version: 1,
    language: 'th',
    title: 'รับห้องแนะนำจาก getproperty (รวมโฆษณา)',
    bodyMarkdown: 'ร่าง ⚖ — เลือกรับหรือไม่ก็ได้ ไม่มีผลต่อการใช้บริการอื่น …',
    effectiveFrom: FAKE.dateTime,
    granted: true,
    grantedVersion: 1,
    capturedAt: FAKE.dateTime,
  },
  preferences: {
    areas: ['ari'],
    budgetMin: '8000.00',
    budgetMax: '15000.00',
    unitKinds: [AudienceUnitKindName.CondoUnit],
    moveInFrom: '2026-12-01',
    moveInTo: '2027-01-31',
    language: 'th',
    quietHours: null,
    updatedAt: FAKE.dateTime,
  },
  maxPerWeek: 2,
  quietHours: { start: '21:00', end: '08:00', timezone: 'Asia/Bangkok' },
};

export const HISTORY_EXAMPLE: RecommendationHistoryItemDto = {
  id: FAKE.uuid,
  sentAt: FAKE.dateTime,
  label: 'โฆษณา',
  sponsor: 'มาลี มีสุข',
  listings: [{ slug: 'condo-1br-0a1b2c3d4e', title: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', public: true }],
};

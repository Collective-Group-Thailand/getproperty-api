import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

import { ConsentPurposeTextDto } from '../shared/reviews.dto';

/** G9 (D-301): the AI listing assistant and energy insight → getenergy (owner console). */

export enum AssistantLanguageName {
  Th = 'th',
  En = 'en',
  Zh = 'zh',
}

export class ListingAssistantRequestDto {
  @ApiProperty({
    enum: AssistantLanguageName,
    enumName: 'AssistantLanguage',
    isArray: true,
    example: ['th', 'en', 'zh'],
    description: 'Languages to draft (1–3).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsEnum(AssistantLanguageName, { each: true })
  languages!: AssistantLanguageName[];

  @ApiPropertyOptional({
    example: true,
    description:
      'Also let the assistant look at the first `listing.assistant.max_photos` photos (read only — photos are never changed).',
  })
  @IsOptional()
  @IsBoolean()
  includePhotos?: boolean;
}

export class ListingDraftDto {
  @ApiProperty({ example: 'คอนโด 1 ห้องนอน 28.5 ตร.ม. ใกล้ BTS อารีย์', maxLength: 120 })
  title!: string;

  @ApiProperty({ example: 'ห้องมุม แสงดี เฟอร์นิเจอร์ครบ …', maxLength: 5000 })
  description!: string;
}

export class ListingAssistantDraftsDto {
  @ApiProperty({ type: ListingDraftDto, nullable: true })
  th!: ListingDraftDto | null;

  @ApiProperty({ type: ListingDraftDto, nullable: true })
  en!: ListingDraftDto | null;

  @ApiProperty({
    type: ListingDraftDto,
    nullable: true,
    description: 'Simplified Chinese (not stored on the listing).',
  })
  zh!: ListingDraftDto | null;
}

export class ListingAssistantResultDto {
  @ApiProperty({
    type: ListingAssistantDraftsDto,
    description: 'Drafts per requested language; null for the others.',
  })
  drafts!: ListingAssistantDraftsDto;

  @ApiProperty({ example: 'text-default' })
  model!: string;

  @ApiProperty({ type: 'integer', example: 3, description: 'Photos the assistant looked at.' })
  photosUsed!: number;

  @ApiProperty({ type: 'integer', example: 4 })
  usedThisMonth!: number;

  @ApiProperty({ type: 'integer', example: 30, description: '`listing.assistant.monthly_limit`.' })
  monthlyLimit!: number;

  @ApiProperty({ example: 'ข้อความนี้ร่างโดย AI จากข้อมูลประกาศของคุณ กรุณาตรวจทานให้ถูกต้องก่อนบันทึก' })
  disclaimer!: string;
}

export class ListingAssistantQuotaDto {
  @ApiProperty({ example: true, description: '`listing.assistant.enabled` for this tenant.' })
  enabled!: boolean;

  @ApiProperty({ type: 'integer', example: 4 })
  usedThisMonth!: number;

  @ApiProperty({ type: 'integer', example: 30 })
  monthlyLimit!: number;
}

export enum EnergyScoreReasonName {
  Ok = 'ok',
  InsufficientData = 'insufficient_data',
}

export enum EnergyBasisName {
  Main = 'main',
  Sum = 'sum',
}

export enum EnergyInsightStateName {
  OptedIn = 'opted_in',
  OptedOut = 'opted_out',
}

export class EnergyMetricsDto {
  @ApiProperty({ type: 'integer', example: 30, description: 'Days in the window with electricity data.' })
  dataDays!: number;

  @ApiProperty({
    enum: EnergyBasisName,
    enumName: 'EnergyBasis',
    description: '`main` = the building’s main meters; `sum` = unit + common-area meters.',
  })
  basis!: EnergyBasisName;

  @ApiProperty({ example: '18250.500', description: 'kWh in the window.' })
  totalKwh!: string;

  @ApiProperty({ example: '4380.120', description: 'kWh of common-area meters.' })
  commonAreaKwh!: string;

  @ApiProperty({ type: String, nullable: true, example: '0.2400', description: 'Common-area share (0–1).' })
  commonAreaShare!: string | null;

  @ApiProperty({ example: '48.200', description: 'Highest hourly demand (kW).' })
  peakKw!: string;

  @ApiProperty({ example: '25.347', description: 'Average hourly demand (kW).' })
  averageKw!: string;

  @ApiProperty({ type: String, nullable: true, example: '0.5259', description: 'Average ÷ peak (0–1).' })
  loadFactor!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '9.50',
    description: 'Pump running hours per day (common-area meters labelled pump); null without such a meter.',
  })
  pumpHoursPerDay!: string | null;
}

export class EnergyPenaltiesDto {
  @ApiProperty({ example: '5.3' })
  commonShare!: string;

  @ApiProperty({ example: '0.0' })
  lowLoadFactor!: string;

  @ApiProperty({ example: '3.8' })
  pumpHours!: string;
}

export class EnergyOptinDto {
  @ApiProperty({ enum: EnergyInsightStateName, enumName: 'EnergyInsightState' })
  state!: EnergyInsightStateName;

  @ApiProperty({ format: 'date-time' })
  optedInAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  optedOutAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Last snapshot sent to getenergy.',
  })
  lastSharedAt!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 82 })
  lastScore!: number | null;
}

export class EnergyInsightDto {
  @ApiProperty({ format: 'uuid' })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    minimum: 0,
    maximum: 100,
    example: 82,
    description: 'Energy score (100 = best); null with `insufficient_data`.',
  })
  score!: number | null;

  @ApiProperty({ enum: EnergyScoreReasonName, enumName: 'EnergyScoreReason' })
  reason!: EnergyScoreReasonName;

  @ApiProperty({ example: 'v1', description: 'Version of `energy.insight.score_model` (O-036).' })
  scoreModel!: string;

  @ApiProperty({ format: 'date', example: '2026-10-01', description: 'First day of the window.' })
  windowFrom!: string;

  @ApiProperty({ format: 'date', example: '2026-10-30', description: 'Last day of the window.' })
  windowTo!: string;

  @ApiProperty({ type: EnergyMetricsDto })
  metrics!: EnergyMetricsDto;

  @ApiProperty({ type: EnergyPenaltiesDto, description: 'Points taken off per factor.' })
  penalties!: EnergyPenaltiesDto;

  @ApiProperty({
    example: true,
    description: 'This tenant owns the building and may opt in / out (operators read).',
  })
  canOptIn!: boolean;

  @ApiProperty({
    type: EnergyOptinDto,
    nullable: true,
    description: 'Sharing with getenergy; null = never opted in.',
  })
  optin!: EnergyOptinDto | null;

  @ApiProperty({
    type: ConsentPurposeTextDto,
    nullable: true,
    description: 'The `energy.insight` text to accept.',
  })
  consent!: ConsentPurposeTextDto | null;
}

export class EnergyOptInDto {
  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'The `energy.insight` version the owner read and accepts (must be the current one).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  consentVersion!: number;
}

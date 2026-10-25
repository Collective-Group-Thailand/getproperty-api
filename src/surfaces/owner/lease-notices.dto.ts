import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { LanguageName } from '../shared/common.dto';
import { MoneyOutput } from '../shared/fields';
import { LessorReasonName } from './leases.dto';

/** `ops.lease_notice_kind` (B7.5, D-253). */
export enum LeaseNoticeKindName {
  RentIncrease = 'rent_increase',
  RenewalOffer = 'renewal_offer',
  NonRenewal = 'non_renewal',
  Termination = 'termination',
  LatePayment = 'late_payment',
}

export class LeaseNoticeCreateDto {
  @ApiProperty({
    enum: LeaseNoticeKindName,
    enumName: 'LeaseNoticeKind',
    example: LeaseNoticeKindName.RenewalOffer,
  })
  @IsEnum(LeaseNoticeKindName)
  kind!: LeaseNoticeKindName;

  @ApiPropertyOptional({
    enum: LanguageName,
    enumName: 'Language',
    description: "Letter language; default the lease's contract language.",
  })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2027-11-01',
    description:
      'rent_increase: the date the new rent applies (after the lease ends, at least `lease.notice.rent_increase_days` ahead); termination: the date the lease ends. Ignored for renewal_offer (the day after the lease ends) and non_renewal (the end date).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveDate?: string;

  @ApiPropertyOptional({
    type: String,
    example: '15500.00',
    description: 'rent_increase (required) and renewal_offer (default the current rent): the monthly rent.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,9}(\.\d{1,2})?$/)
  newRent?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 120,
    example: 12,
    description: 'renewal_offer: the new term (default the current one).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  renewalMonths?: number;

  @ApiPropertyOptional({
    enum: LessorReasonName,
    enumName: 'LessorReason',
    description:
      'termination: the legal ground (required): lessee_breach, disturbance, unlawful_use or mutual_agreement (end_of_term is the non_renewal letter).',
  })
  @IsOptional()
  @IsEnum(LessorReasonName)
  reasonCode?: LessorReasonName;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 2000,
    example: 'ขอบคุณที่เช่ากับเรามาตลอดปี',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string | null;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: [],
    description: 'termination: uploaded evidence (a breach needs it, D-176).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  evidenceDocumentIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: [],
    description: 'Acknowledged compliance warnings (D-021a).',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  acknowledgementIds?: string[];
}

export class LeaseNoticeItemDto {
  @ApiProperty({ example: 'INV-2026-00042' })
  number!: string;

  @ApiProperty({ format: 'date', example: '2026-10-05' })
  dueDate!: string;

  @MoneyOutput({ example: '15000.00', description: 'Overdue balance.' })
  balance!: string;
}

export class LeaseNoticeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({
    enum: LeaseNoticeKindName,
    enumName: 'LeaseNoticeKind',
    example: LeaseNoticeKindName.RenewalOffer,
  })
  kind!: LeaseNoticeKindName;

  @ApiProperty({ example: 'NTC-2026-00001' })
  number!: string;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  language!: LanguageName;

  @ApiProperty({ format: 'date', example: FAKE.date })
  issuedOn!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-11-01' })
  effectiveDate!: string | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-09',
    description: 'Answer (renewal offer) or pay (late payment) by.',
  })
  respondBy!: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 37,
    description: 'Days between the letter and its effect (or the days given to pay).',
  })
  noticeDays!: number | null;

  @MoneyOutput({
    example: '15500.00',
    description: 'New monthly rent (rent change, renewal offer).',
    nullable: true,
  })
  newRent!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 12 })
  renewalMonths!: number | null;

  @MoneyOutput({ example: null, description: 'Total overdue (late payment).', nullable: true })
  amountDue!: string | null;

  @ApiProperty({ enum: LessorReasonName, enumName: 'LessorReason', nullable: true, example: null })
  reasonCode!: LessorReasonName | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  message!: string | null;

  @ApiProperty({
    type: () => [LeaseNoticeItemDto],
    description: 'The overdue invoices of a late-payment notice.',
  })
  items!: LeaseNoticeItemDto[];

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'The PDF (pdf_notice).',
  })
  documentId!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: FAKE.dateTime,
    description: 'When it was sent to the resident in LINE.',
  })
  sentAt!: string | null;
}

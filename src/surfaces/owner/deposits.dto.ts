import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { DecimalInput, MoneyInput, MoneyOutput } from '../shared/fields';

export enum DepositStatusName {
  Pending = 'pending',
  Held = 'held',
  Settling = 'settling',
  Refunded = 'refunded',
  ForfeitedPartially = 'forfeited_partially',
  Forfeited = 'forfeited',
  Disputed = 'disputed',
}
export enum SettlementStatusName {
  Opened = 'opened',
  Inspected = 'inspected',
  Proposed = 'proposed',
  Agreed = 'agreed',
  Disputed = 'disputed',
  Refunded = 'refunded',
  Closed = 'closed',
}
export enum ResidentResponseName {
  Accepted = 'accepted',
  Disputed = 'disputed',
}
export enum RefundMethodName {
  BankTransfer = 'bank_transfer',
  Cash = 'cash',
  Offset = 'offset',
}
export enum DeductionKindName {
  Damage = 'damage',
  MissingItem = 'missing_item',
  Cleaning = 'cleaning',
  UnpaidInvoice = 'unpaid_invoice',
  Other = 'other',
}
export enum WearCategoryName {
  NormalWear = 'normal_wear',
  Damage = 'damage',
}
export enum InspectionTypeName {
  MoveIn = 'move_in',
  MoveOut = 'move_out',
  Periodic = 'periodic',
}
export enum InspectionCreateTypeName {
  MoveIn = 'move_in',
  MoveOut = 'move_out',
}
export enum InspectionStatusName {
  Scheduled = 'scheduled',
  InProgress = 'in_progress',
  Completed = 'completed',
  Signed = 'signed',
}
export enum ItemConditionName {
  Good = 'good',
  Fair = 'fair',
  Damaged = 'damaged',
  Missing = 'missing',
  NotApplicable = 'not_applicable',
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ------------------------------------------------------------------------------------------- deposits

export class DeductionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: DeductionKindName, enumName: 'DeductionKind', example: DeductionKindName.Damage })
  kind!: DeductionKindName;

  @ApiProperty({ example: 'ผนังเป็นรูจากการเจาะยึดชั้นวาง 3 จุด' })
  description!: string;

  @MoneyOutput({ example: '800.00', description: 'Deducted amount.' })
  amount!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'The move-out inspection line.',
  })
  inspectionItemId!: string | null;

  @ApiProperty({ type: [String], format: 'uuid', example: [FAKE.uuid] })
  evidenceDocumentIds!: string[];

  @ApiProperty({ type: Boolean, nullable: true, example: null })
  residentAccepted!: boolean | null;
}

export class SettlementDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: SettlementStatusName,
    enumName: 'SettlementStatus',
    example: SettlementStatusName.Proposed,
  })
  status!: SettlementStatusName;

  @ApiProperty({ format: 'date-time', example: '2026-11-30T10:00:00+07:00' })
  moveOutAt!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-12-07T10:00:00+07:00',
    description: 'Move-out + `deposit.refund_days` (D-023).',
  })
  deadlineAt!: string;

  @ApiProperty({ example: false, description: 'Refund after the deadline (SLA breach or late refund).' })
  isLate!: boolean;

  @MoneyOutput({ example: '4500.00', description: 'Security deposit held.' })
  depositHeld!: string;

  @MoneyOutput({ example: '800.00', description: 'Sum of the deductions.' })
  deductionsTotal!: string;

  @MoneyOutput({ example: '350.50', description: 'Final utilities not yet invoiced.' })
  utilitiesFinal!: string;

  @MoneyOutput({
    example: '0.00',
    description:
      'Advance rent the final invoice did not use (D-177): paid back with the deposit, never forfeited (compliance.no_forfeiture).',
  })
  advanceRentUnused!: string;

  @MoneyOutput({ example: '3349.50', description: 'Proposed refund.', nullable: true })
  proposedRefund!: string | null;

  @MoneyOutput({ example: '3349.50', description: 'Refund the resident accepted.', nullable: true })
  agreedRefund!: string | null;

  @ApiProperty({ enum: ResidentResponseName, enumName: 'ResidentResponse', nullable: true, example: null })
  residentResponse!: ResidentResponseName | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  disputeReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  refundedAt!: string | null;

  @MoneyOutput({ example: '3349.50', description: 'Refund paid.', nullable: true })
  refundAmount!: string | null;

  @ApiProperty({ enum: RefundMethodName, enumName: 'RefundMethod', nullable: true, example: null })
  refundMethod!: RefundMethodName | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  statementNumber!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  moveOutInspectionId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  moveInInspectionId!: string | null;

  @ApiProperty({ type: () => [DeductionDto] })
  items!: DeductionDto[];
}

export class DepositDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'CTR-2026-00001' })
  leaseNumber!: string | null;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.nameTh })
  lesseeName!: string | null;

  @ApiProperty({ enum: DepositStatusName, enumName: 'DepositStatus', example: DepositStatusName.Settling })
  status!: DepositStatusName;

  @MoneyOutput({ example: '4500.00', description: 'Security deposit.' })
  amountSecurity!: string;

  @MoneyOutput({ example: '4500.00', description: 'Advance rent (applied to rent, not refunded here).' })
  amountAdvanceRent!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  receivedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'DPR-2026-00001' })
  receiptNumber!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'A renewal carried this deposit over.',
  })
  carriedFromDepositId!: string | null;

  @ApiProperty({ type: () => SettlementDto, nullable: true })
  settlement!: SettlementDto | null;

  @ApiProperty({ type: [String], example: ['add-deduction', 'propose'] })
  nextActions!: string[];

  @ApiProperty({ type: 'integer', example: 3 })
  version!: number;
}

export class DepositListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: DepositStatusName, enumName: 'DepositStatus' })
  @IsOptional()
  @IsEnum(DepositStatusName)
  status?: DepositStatusName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  leaseId?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Only late (true) or on-time (false) settlements.' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : (value as unknown)))
  @IsBoolean()
  late?: boolean;
}

export class DepositSummaryCountsDto {
  @ApiProperty({ type: 'integer', example: 1 })
  pending!: number;

  @ApiProperty({ type: 'integer', example: 10 })
  held!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  settling!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  disputed!: number;

  @ApiProperty({ type: 'integer', example: 4 })
  refunded!: number;

  @ApiProperty({ type: 'integer', example: 2 })
  forfeitedPartially!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  forfeited!: number;
}

export class DepositSummaryDto {
  @ApiProperty({ type: () => DepositSummaryCountsDto })
  byStatus!: DepositSummaryCountsDto;

  @ApiProperty({ type: 'integer', example: 1, description: 'Open settlements due within 3 days.' })
  settlementsDueSoon!: number;

  @ApiProperty({ type: 'integer', example: 0, description: 'Open settlements past their deadline.' })
  settlementsOverdue!: number;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description: 'Settlements refunded late (compliance score, B6).',
  })
  lateRefunds!: number;
}

export class RecordReceiptDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'Default now.',
  })
  @IsOptional()
  @IsDateString()
  receivedAt?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'โอนเข้าบัญชี 12 ต.ค.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string | null;
}

export class DeductionCreateDto {
  @ApiProperty({ enum: DeductionKindName, enumName: 'DeductionKind', example: DeductionKindName.Damage })
  @IsEnum(DeductionKindName)
  kind!: DeductionKindName;

  @ApiProperty({ example: 'ผนังเป็นรูจากการเจาะยึดชั้นวาง 3 จุด' })
  @IsString()
  @Length(3, 500)
  description!: string;

  @MoneyInput({ example: '800.00', description: 'Amount to deduct (> 0).' })
  amount!: string;

  @ApiPropertyOptional({
    enum: WearCategoryName,
    enumName: 'WearCategory',
    default: WearCategoryName.Damage,
    description: '`normal_wear` is refused (compliance.deposit_wear).',
  })
  @IsOptional()
  @IsEnum(WearCategoryName)
  wearCategory?: WearCategoryName;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Required for damage / missing items.',
  })
  @IsOptional()
  @IsUUID()
  inspectionItemId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: [FAKE.uuid],
    description: 'Photos, receipts (uploaded files).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  evidenceDocumentIds?: string[];
}

export class ProposeSettlementDto {
  @MoneyInput({
    example: '350.50',
    description: 'Final utilities not yet invoiced (default 0).',
    optional: true,
  })
  utilitiesFinal?: string;
}

export class RecordRefundDto {
  @MoneyInput({ example: '3349.50', description: 'Refund paid (≥ the agreed / proposed refund).' })
  amount!: string;

  @ApiProperty({ enum: RefundMethodName, enumName: 'RefundMethod', example: RefundMethodName.BankTransfer })
  @IsEnum(RefundMethodName)
  method!: RefundMethodName;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'KBANK 2026-12-03 10:12' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'Default now.',
  })
  @IsOptional()
  @IsDateString()
  refundedAt?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Transfer slip (required for bank transfers).',
  })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string | null;
}

export class DocumentDownloadDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  documentId!: string;

  @ApiProperty({ example: 'DPS-2026-00001' })
  number!: string;

  @ApiProperty({
    example: 'https://storage.example.com/statement.pdf?X-Amz-Signature=abc',
    description: 'Valid 5 minutes.',
  })
  url!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:20:00+07:00' })
  expiresAt!: string;
}

// ------------------------------------------------------------------------------------------- inspections

export class InspectionItemDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'walls', description: 'Template key, `asset:<id>` or `meter:<utility>`.' })
  itemKey!: string;

  @ApiProperty({ example: 'ผนังและสี' })
  label!: string;

  @ApiProperty({ type: String, nullable: true, example: 'room' })
  area!: string | null;

  @ApiProperty({
    enum: ItemConditionName,
    enumName: 'ItemCondition',
    nullable: true,
    example: ItemConditionName.Good,
  })
  condition!: ItemConditionName | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ type: [String], format: 'uuid', example: [FAKE.uuid] })
  photoDocumentIds!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1234.500',
    description: 'Meter register (meter lines).',
  })
  meterRegister!: string | null;
}

export class InspectionDto {
  @ApiProperty({
    type: [String],
    example: ['complete'],
    description: 'Actions (`…/actions/{name}`) the caller may take now — never infer them from the status.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: InspectionTypeName, enumName: 'InspectionType', example: InspectionTypeName.MoveOut })
  type!: InspectionTypeName;

  @ApiProperty({
    enum: InspectionStatusName,
    enumName: 'InspectionStatus',
    example: InspectionStatusName.InProgress,
  })
  status!: InspectionStatusName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  leaseId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  scheduledFor!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  startedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  completedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'From the `inspection_report` series.',
  })
  reportNumber!: string | null;

  @ApiProperty({ example: true })
  staffSigned!: boolean;

  @ApiProperty({ example: false })
  residentSigned!: boolean;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ type: () => [InspectionItemDto] })
  items!: InspectionItemDto[];

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;
}

export class InspectionListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  leaseId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: InspectionTypeName, enumName: 'InspectionType' })
  @IsOptional()
  @IsEnum(InspectionTypeName)
  type?: InspectionTypeName;

  @ApiPropertyOptional({ enum: InspectionStatusName, enumName: 'InspectionStatus' })
  @IsOptional()
  @IsEnum(InspectionStatusName)
  status?: InspectionStatusName;
}

export class InspectionCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  leaseId!: string;

  @ApiProperty({
    enum: InspectionCreateTypeName,
    enumName: 'InspectionCreateType',
    example: InspectionCreateTypeName.MoveIn,
  })
  @IsEnum(InspectionCreateTypeName)
  type!: InspectionCreateTypeName;

  @ApiPropertyOptional({ type: String, format: 'date-time', example: FAKE.dateTime })
  @IsOptional()
  @IsDateString()
  scheduledFor?: string;
}

export class InspectionItemPatchDto {
  @ApiProperty({ example: 'walls' })
  @IsString()
  @MaxLength(80)
  itemKey!: string;

  @ApiPropertyOptional({ enum: ItemConditionName, enumName: 'ItemCondition', nullable: true })
  @IsOptional()
  @IsEnum(ItemConditionName)
  condition?: ItemConditionName | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'มีรอยขีดข่วนเล็กน้อย' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: [FAKE.uuid],
    description: 'Replaces the photos of the line.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  photoDocumentIds?: string[];

  @DecimalInput({
    example: '1234.500',
    description: 'Meter register (meter lines only).',
    optional: true,
    nullable: true,
  })
  meterRegister?: string | null;
}

export class InspectionItemsUpdateDto {
  @ApiProperty({ type: () => [InspectionItemPatchDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InspectionItemPatchDto)
  items!: InspectionItemPatchDto[];
}

export class InspectionCompleteDto {
  @ApiPropertyOptional({ example: PNG_BASE64, description: 'Inspector’s drawn signature (PNG ≤ 200 KB).' })
  @IsOptional()
  @IsString()
  @IsBase64()
  @MaxLength(280_000)
  staffSignaturePng?: string;

  @ApiPropertyOptional({
    example: PNG_BASE64,
    description: 'Resident’s signature on the staff device (PNG ≤ 200 KB).',
  })
  @IsOptional()
  @IsString()
  @IsBase64()
  @MaxLength(280_000)
  residentSignaturePng?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ผู้เช่าคืนกุญแจครบ 2 ดอก' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class ComparisonSideDto {
  @ApiProperty({
    enum: ItemConditionName,
    enumName: 'ItemCondition',
    nullable: true,
    example: ItemConditionName.Good,
  })
  condition!: ItemConditionName | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ type: [String], format: 'uuid', example: [FAKE.uuid] })
  photoDocumentIds!: string[];

  @ApiProperty({ type: String, nullable: true, example: null })
  meterRegister!: string | null;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The inspection line (use it for a deduction).',
  })
  inspectionItemId!: string;
}

export class ComparisonLineDto {
  @ApiProperty({ example: 'walls' })
  itemKey!: string;

  @ApiProperty({ example: 'ผนังและสี' })
  label!: string;

  @ApiProperty({ type: String, nullable: true, example: 'room' })
  area!: string | null;

  @ApiProperty({ type: () => ComparisonSideDto, nullable: true })
  moveIn!: ComparisonSideDto | null;

  @ApiProperty({ type: () => ComparisonSideDto, nullable: true })
  moveOut!: ComparisonSideDto | null;

  @ApiProperty({ example: true, description: 'The condition changed between move-in and move-out.' })
  changed!: boolean;
}

export class InspectionComparisonDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  moveInInspectionId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  moveOutInspectionId!: string | null;

  @ApiProperty({ type: () => [ComparisonLineDto] })
  lines!: ComparisonLineDto[];
}

// ------------------------------------------------------------------------------------------- resident

export class ResidentDeductionDto extends DeductionDto {
  @ApiProperty({
    type: [String],
    example: ['https://storage.example.com/photo.jpg?X-Amz-Signature=abc'],
    description: '5-minute links to the evidence photos.',
  })
  evidenceUrls!: string[];
}

export class ResidentDepositDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ enum: DepositStatusName, enumName: 'DepositStatus', example: DepositStatusName.Settling })
  status!: DepositStatusName;

  @MoneyOutput({ example: '4500.00', description: 'Security deposit.' })
  amountSecurity!: string;

  @MoneyOutput({ example: '4500.00', description: 'Advance rent.' })
  amountAdvanceRent!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ type: String, nullable: true, example: 'DPR-2026-00001' })
  receiptNumber!: string | null;

  @ApiProperty({ type: () => SettlementDto, nullable: true })
  settlement!: SettlementDto | null;

  @ApiProperty({ type: () => [ResidentDeductionDto] })
  deductions!: ResidentDeductionDto[];

  @ApiProperty({ type: [String], example: ['accept', 'dispute'] })
  nextActions!: string[];
}

export class ResidentDisputeDto {
  @ApiProperty({ example: 'รูบนผนังมีอยู่ก่อนเข้าอยู่ ดูภาพตอนตรวจรับห้อง' })
  @IsString()
  @Length(3, 1000)
  reason!: string;
}

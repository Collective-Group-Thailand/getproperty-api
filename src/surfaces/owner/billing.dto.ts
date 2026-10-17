import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, type ApiPropertyOptions } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { DecimalInput, MoneyInput, MoneyOutput } from '../shared/fields';
import {
  BillingCycleStatusName,
  EstimatePolicyName,
  InvoiceChargeStatusName,
  InvoiceLineKindName,
  InvoiceLineSourceTypeName,
  InvoiceStatusName,
  NoteReasonName,
  RateBasisName,
  RatePlanKindName,
} from '../shared/status.enums';

const ACK_IDS: ApiPropertyOptions = {
  type: [String],
  format: 'uuid',
  example: [],
  description:
    'Acknowledgements of compliance warnings (409 `compliance.acknowledgement_required` → acknowledge → repeat, D-021a).',
};

const ackIds = () =>
  applyDecorators(
    ApiPropertyOptional(ACK_IDS),
    IsOptional(),
    IsArray(),
    IsUUID('all', { each: true }),
    ArrayMaxSize(50),
  );

// ------------------------------------------------------------------------------------------- rate plans

export class RatePlanVersionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-11-01' })
  effectiveFrom!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  effectiveTo!: string | null;

  @ApiProperty({ enum: RateBasisName, enumName: 'RateBasis', example: RateBasisName.PerUnit })
  basis!: RateBasisName;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Tiers interpreted by the billing engine (schema-design §4.2.2): `{kind: flat, pricePerUnit}`, `{kind: tiered, tiers: [{fromUnits, toUnits, pricePerUnit}]}`, `{kind: fixed, amount, byUnitType?}` or `{kind: budget, amount}` (condo common fee by ownership ratio). Prices are decimal strings.',
    example: { kind: 'flat', unit: 'kwh', pricePerUnit: '7.0000' },
  })
  tiers!: Record<string, unknown>;

  @MoneyOutput({ example: null, nullable: true, description: 'Minimum charge (water, D-141).' })
  minimumCharge!: string | null;

  @ApiProperty({
    description: 'The rate is above the utility rate at the representative consumption (D-021a).',
    example: false,
  })
  aboveCap!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'The cap comparison stored at save: the utility tariff version with the lowest effective average rate at the representative consumption, that rate and the tenant rate (D-021a).',
    example: {
      utilityTariffVersionId: FAKE.uuid,
      provider: 'mea',
      tariffCode: '1.1.1',
      representativeUnits: '150.000',
      effectiveAverageRate: '3.2169',
      tenantRate: '7.0000',
      aboveCap: true,
    },
  })
  capCheck!: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  complianceAcknowledgementId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ description: 'In force today (Asia/Bangkok).', example: true })
  inForce!: boolean;
}

export class RatePlanDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Null: tenant-wide plan.',
  })
  buildingId!: string | null;

  @ApiProperty({ enum: RatePlanKindName, enumName: 'RatePlanKind', example: RatePlanKindName.Power })
  kind!: RatePlanKindName;

  @ApiProperty({ example: 'ค่าไฟห้องพัก' })
  name!: string;

  @ApiProperty({ description: 'Default plan of its kind for the building (or tenant).', example: true })
  isDefault!: boolean;

  @ApiProperty({ type: [RatePlanVersionDto], description: 'Newest first.' })
  versions!: RatePlanVersionDto[];

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class RatePlanListQuery {
  @ApiPropertyOptional({ enum: RatePlanKindName, enumName: 'RatePlanKind' })
  @IsOptional()
  @IsEnum(RatePlanKindName)
  kind?: RatePlanKindName;

  @ApiPropertyOptional({ format: 'uuid', description: 'Plans of this building and tenant-wide plans.' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class RatePlanCreateDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Omit for a tenant-wide plan.',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiProperty({ enum: RatePlanKindName, enumName: 'RatePlanKind' })
  @IsEnum(RatePlanKindName)
  kind!: RatePlanKindName;

  @ApiProperty({ example: 'ค่าไฟห้องพัก', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class RatePlanUpdateDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class RatePlanVersionCreateDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-11-01',
    description: 'Today or later (never backdated, D-021a); default today.',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  effectiveFrom?: string;

  @ApiProperty({ enum: RateBasisName, enumName: 'RateBasis' })
  @IsEnum(RateBasisName)
  basis!: RateBasisName;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      kind: 'tiered',
      unit: 'kwh',
      tiers: [{ fromUnits: '0', toUnits: '150', pricePerUnit: '4.0000' }],
    },
    description: 'See `RatePlanVersion.tiers`.',
  })
  @IsObject()
  tiers!: Record<string, unknown>;

  @MoneyInput({
    example: '100.00',
    description: 'Minimum charge (water, D-141).',
    optional: true,
    nullable: true,
  })
  minimumCharge?: string | null;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ackIds()
  acknowledgementIds?: string[];
}

// ------------------------------------------------------------------------------------------- invoices

export class MeterSegmentEndDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  readingId!: string | null;

  @ApiProperty({ example: '1234.500', description: 'Register (decimal string).' })
  register!: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-25T23:59:00+07:00' })
  readAt!: string;

  @ApiProperty({
    example: 'iot',
    description: 'Reading source (D-012); `assignment` = the register recorded when the meter was assigned.',
  })
  source!: string;
}

export class MeterSegmentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  meterAssignmentId!: string;

  @ApiProperty({ example: 'A-101-E', description: 'Meter code of the assignment.' })
  code!: string;

  @ApiProperty({ type: MeterSegmentEndDto, nullable: true })
  from!: MeterSegmentEndDto | null;

  @ApiProperty({ type: MeterSegmentEndDto, nullable: true })
  to!: MeterSegmentEndDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '120.000',
    description: 'Units of the segment (multiplier and rollover applied); null without a closing reading.',
  })
  units!: string | null;
}

export class InvoiceLineDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  lineNo!: number;

  @ApiProperty({
    enum: InvoiceLineSourceTypeName,
    enumName: 'InvoiceLineSourceType',
    example: InvoiceLineSourceTypeName.Meter,
  })
  sourceType!: InvoiceLineSourceTypeName;

  @ApiProperty({
    enum: InvoiceLineKindName,
    enumName: 'InvoiceLineKind',
    example: InvoiceLineKindName.Electricity,
  })
  lineKind!: InvoiceLineKindName;

  @ApiProperty({ example: 'ค่าไฟฟ้า 120 หน่วย × 7.0000' })
  description!: string;

  @ApiProperty({ example: '120.000' })
  quantity!: string;

  @ApiProperty({ type: String, nullable: true, example: 'kwh' })
  unit!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '7.0000',
    description: 'Price per unit, 4 decimals.',
  })
  unitPrice!: string | null;

  @MoneyOutput({ example: '840.00', description: 'Line amount (negative for offsets and discounts).' })
  amount!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-01' })
  periodFrom!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-31' })
  periodTo!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '1114.500' })
  registerFrom!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '1234.500' })
  registerTo!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '120.000' })
  units!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'iot',
    description: 'Source of the closing reading (D-012).',
  })
  readingSource!: string | null;

  @ApiProperty({ example: false, description: 'An estimate, settled on a later invoice (D-031).' })
  isEstimated!: boolean;

  @ApiProperty({
    type: [MeterSegmentDto],
    description: 'Meter segments (a swap inside the period gives two).',
  })
  meterSegments!: MeterSegmentDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '3.9900',
    description: 'Utility effective rate (D-021a).',
  })
  capPerUnit!: string | null;

  @ApiProperty({ example: true })
  aboveCap!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  complianceAcknowledgementId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  ratePlanVersionId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  utilityTariffVersionId!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: null,
    description: 'Pro-rata of a partial period: days, daysInPeriod, factor, from, to (D-041).',
  })
  proRata!: Record<string, unknown> | null;

  @ApiProperty({
    type: 'array',
    nullable: true,
    items: { type: 'object', additionalProperties: true },
    example: null,
    description: 'Tier blocks of a tiered price.',
  })
  tierBreakdown!: Record<string, unknown>[] | null;

  @ApiProperty({ example: false })
  vatApplicable!: boolean;
}

export class NoteLineDto {
  @ApiProperty({ type: 'integer', example: 1 })
  lineNo!: number;

  @ApiProperty({ enum: InvoiceLineKindName, enumName: 'InvoiceLineKind' })
  lineKind!: InvoiceLineKindName;

  @ApiProperty({ example: 'แก้ไขค่าไฟจากการอ่านมิเตอร์ผิด' })
  description!: string;

  @MoneyOutput({ example: '70.00', description: 'Amount.' })
  amount!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  refInvoiceLineId!: string | null;
}

export class NoteDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'CRN-2026-00001' })
  number!: string;

  @ApiProperty({ enum: NoteReasonName, enumName: 'NoteReason' })
  reason!: NoteReasonName;

  @ApiProperty({ example: 'อ่านมิเตอร์ผิด 10 หน่วย' })
  reasonText!: string;

  @MoneyOutput({ example: '70.00', description: 'Subtotal.' })
  subtotal!: string;

  @MoneyOutput({ example: '0.00', description: 'VAT.' })
  vatAmount!: string;

  @MoneyOutput({ example: '70.00', description: 'Total.' })
  total!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ type: [NoteLineDto] })
  lines!: NoteLineDto[];
}

export class InvoiceSummaryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'INV-2026-00042', description: 'Null while draft.' })
  number!: string | null;

  @ApiProperty({ enum: InvoiceStatusName, enumName: 'InvoiceStatus', example: InvoiceStatusName.Issued })
  status!: InvoiceStatusName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  billedPartyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  billedPartyName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  leaseId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'CTR-2026-00001' })
  leaseNumber!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  billingCycleId!: string | null;

  @ApiProperty({ description: 'The final invoice of a lease at move-out (D-177).', example: false })
  isFinal!: boolean;

  @ApiProperty({ type: String, format: 'date', example: '2026-10-01' })
  periodStart!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-10-31' })
  periodEnd!: string;

  @ApiProperty({ format: 'date-time', type: String, nullable: true, example: FAKE.dateTime })
  issuedAt!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-11-05' })
  dueDate!: string | null;

  @MoneyOutput({ example: '5344.00', description: 'Sum of the lines.' })
  subtotal!: string;

  @MoneyOutput({ example: '0.00', description: 'VAT (tenant VAT-registered only).' })
  vatAmount!: string;

  @MoneyOutput({ example: '5344.00', description: 'Invoice total.' })
  total!: string;

  @MoneyOutput({
    example: '0.00',
    description: 'Unpaid balance of earlier invoices shown on this one (D-193).',
  })
  priorBalance!: string;

  @MoneyOutput({ example: '5344.00', description: 'Total + prior balance: the QR amount.' })
  amountDue!: string;

  @MoneyOutput({ example: '0.00', description: 'Paid.' })
  paidTotal!: string;

  @MoneyOutput({ example: '0.00', description: 'Credited (credit notes).' })
  creditedTotal!: string;

  @MoneyOutput({ example: '0.00', description: 'Debited (debit notes).' })
  debitedTotal!: string;

  @MoneyOutput({ example: '5344.00', description: 'Outstanding on this invoice.' })
  balance!: string;

  @ApiProperty({ example: false })
  hasEstimate!: boolean;

  @ApiProperty({ example: true })
  hasAboveCapLine!: boolean;

  @ApiProperty({
    type: [String],
    example: [],
    description:
      'Why a draft cannot be issued yet: `missing_reading:<assignment>`, `register_decrease:…`, `missing_rate_plan:<kind>`, `no_cap_reference:<utility>`, `negative_total`.',
  })
  reviewFlags!: string[];

  @ApiProperty({ type: [String], example: ['tariff_cap_acknowledged'] })
  complianceFlags!: string[];

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;
}

export class InvoiceDto extends InvoiceSummaryDto {
  @ApiProperty({ type: [InvoiceLineDto] })
  lines!: InvoiceLineDto[];

  @ApiProperty({ type: [NoteDto] })
  creditNotes!: NoteDto[];

  @ApiProperty({ type: [NoteDto] })
  debitNotes!: NoteDto[];

  @ApiProperty({ format: 'date-time', type: String, nullable: true, example: null })
  voidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  voidReason!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  replacesInvoiceId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  replacedByInvoiceId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'INV2026000042',
    description: 'Payment reference (QR).',
  })
  promptpayRef!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'sha256 (hex) of the canonical issue snapshot (§4.2.3).',
  })
  snapshotSha256!: string | null;

  @ApiProperty({ type: [String], example: ['credit_note', 'debit_note'] })
  nextActions!: string[];
}

export class InvoiceListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: InvoiceStatusName, enumName: 'InvoiceStatus' })
  @IsOptional()
  @IsEnum(InvoiceStatusName)
  status?: InvoiceStatusName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  leaseId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Billed party.' })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  billingCycleId?: string;

  @ApiPropertyOptional({ example: '2026-10', description: 'Period ending in this month (YYYY-MM).' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period?: string;
}

export class InvoiceVoidDto {
  @ApiProperty({ example: 'คำนวณจากเลขมิเตอร์ที่อ่านผิด', maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Recompute a replacement draft for the same period (D-040).',
  })
  @IsOptional()
  @IsBoolean()
  reissue?: boolean;
}

export class InvoiceVoidResultDto {
  @ApiProperty({ type: InvoiceDto })
  voided!: InvoiceDto;

  @ApiProperty({ type: InvoiceDto, nullable: true })
  replacement!: InvoiceDto | null;
}

export class NoteLineInputDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'The invoice line corrected (credit ≤ its amount).' })
  @IsOptional()
  @IsUUID()
  refInvoiceLineId?: string;

  @ApiPropertyOptional({ enum: InvoiceLineKindName, enumName: 'InvoiceLineKind' })
  @IsOptional()
  @IsEnum(InvoiceLineKindName)
  lineKind?: InvoiceLineKindName;

  @ApiProperty({ example: 'แก้ไขค่าไฟ 10 หน่วย', maxLength: 300 })
  @IsString()
  @Length(1, 300)
  description!: string;

  @MoneyInput({ example: '70.00', description: 'Amount (positive).' })
  amount!: string;
}

export class NoteCreateDto {
  @ApiProperty({ enum: NoteReasonName, enumName: 'NoteReason' })
  @IsEnum(NoteReasonName)
  reason!: NoteReasonName;

  @ApiProperty({ example: 'อ่านมิเตอร์ผิด 10 หน่วย', maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reasonText!: string;

  @ApiProperty({ type: [NoteLineInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => NoteLineInputDto)
  lines!: NoteLineInputDto[];
}

// ------------------------------------------------------------------------------------------- one-off charges

/** The line kinds an owner may queue for the next invoice (subset of `InvoiceLineKind`). */
export enum InvoiceChargeKindName {
  OneOff = 'one_off',
  Discount = 'discount',
}

export class InvoiceChargeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  leaseId!: string | null;

  @ApiProperty({
    enum: InvoiceLineKindName,
    enumName: 'InvoiceLineKind',
    example: InvoiceLineKindName.OneOff,
  })
  lineKind!: InvoiceLineKindName;

  @ApiProperty({ example: 'ค่าทำกุญแจสำรอง' })
  description!: string;

  @ApiProperty({ example: '1.000' })
  quantity!: string;

  @ApiProperty({ example: '150.0000' })
  unitPrice!: string;

  @MoneyOutput({ example: '150.00', description: 'Amount (negative for a discount).' })
  amount!: string;

  @ApiProperty({ enum: InvoiceChargeStatusName, enumName: 'InvoiceChargeStatus' })
  status!: InvoiceChargeStatusName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  appliedInvoiceLineId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class InvoiceChargeCreateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  unitId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Default: the lessee of the unit’s live lease.' })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  leaseId?: string;

  @ApiProperty({
    enum: InvoiceChargeKindName,
    enumName: 'InvoiceChargeKind',
    example: InvoiceChargeKindName.OneOff,
  })
  @IsEnum(InvoiceChargeKindName)
  lineKind!: InvoiceChargeKindName;

  @ApiProperty({ example: 'ค่าทำกุญแจสำรอง', maxLength: 300 })
  @IsString()
  @Length(1, 300)
  description!: string;

  @DecimalInput({ example: '1', description: 'Quantity (default 1).', optional: true })
  quantity?: string;

  @MoneyInput({ example: '150.00', description: 'Price per quantity (a discount is entered positive).' })
  unitPrice!: string;
}

export class InvoiceChargeListQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: InvoiceChargeStatusName, enumName: 'InvoiceChargeStatus' })
  @IsOptional()
  @IsEnum(InvoiceChargeStatusName)
  status?: InvoiceChargeStatusName;
}

export class InvoiceChargeCancelDto {
  @ApiProperty({ example: 'ซ้ำกับรายการเดิม', maxLength: 300 })
  @IsString()
  @Length(3, 300)
  reason!: string;
}

// ------------------------------------------------------------------------------------------- billing cycles

export class BillingCycleDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  propertyId!: string;

  @ApiProperty({ example: 'อาคารสุขใจ' })
  propertyName!: string;

  @ApiProperty({ example: '2026-10', description: 'Period key (cut-off month).' })
  periodKey!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-09-26' })
  periodStart!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-10-25' })
  periodEnd!: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-25T23:59:00+07:00' })
  cutOffAt!: string;

  @ApiProperty({ enum: BillingCycleStatusName, enumName: 'BillingCycleStatus', example: 'computed' })
  status!: BillingCycleStatusName;

  @ApiProperty({
    type: 'integer',
    example: 60,
    description: 'IoT readings window around the cut-off (minutes).',
  })
  readingsWindowMinutes!: number;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-26T23:59:00+07:00',
    description: 'Staff readings accepted until (D-031).',
  })
  graceDeadlineAt!: string;

  @ApiProperty({ enum: EstimatePolicyName, enumName: 'EstimatePolicy', example: 'block' })
  estimatePolicy!: EstimatePolicyName;

  @ApiProperty({ format: 'date-time', type: String, nullable: true, example: null })
  readingsRequestedAt!: string | null;

  @ApiProperty({ format: 'date-time', type: String, nullable: true, example: FAKE.dateTime })
  computedAt!: string | null;

  @ApiProperty({ format: 'date-time', type: String, nullable: true, example: null })
  issuedAt!: string | null;

  @ApiProperty({ format: 'date-time', type: String, nullable: true, example: null })
  closedAt!: string | null;

  @ApiProperty({
    format: 'date-time',
    type: String,
    nullable: true,
    example: null,
    description: 'When the cycle issues itself.',
  })
  autoIssueAt!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { billables: 11, drafts: 11, needsReview: 0, issued: 0, total: '58784.00', flags: {} },
  })
  stats!: Record<string, unknown>;

  @ApiProperty({ type: [String], example: ['compute', 'issue'] })
  nextActions!: string[];

  @ApiProperty({ type: 'integer', example: 3 })
  version!: number;
}

export class BillingCycleDetailDto extends BillingCycleDto {
  @ApiProperty({ type: [InvoiceSummaryDto], description: 'One row per billed party × unit.' })
  invoices!: InvoiceSummaryDto[];
}

export class BillingCycleListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional({ enum: BillingCycleStatusName, enumName: 'BillingCycleStatus' })
  @IsOptional()
  @IsEnum(BillingCycleStatusName)
  status?: BillingCycleStatusName;
}

export class BillingCycleOpenDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  propertyId!: string;

  @ApiPropertyOptional({ example: '2026-10', description: 'Default: the current period.' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  periodKey?: string;
}

/** Body of the issue actions (a cycle or one invoice): the acknowledgements of compliance warnings. */
export class IssueDto {
  @ackIds()
  acknowledgementIds?: string[];
}

export class BillingCycleIssueResultDto extends BillingCycleDetailDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Drafts not issued and why (review flags or a refused compliance rule).',
    example: [{ invoiceId: FAKE.uuid, unitNo: '305', reason: 'missing_reading' }],
  })
  skipped!: Record<string, unknown>[];
}

// ------------------------------------------------------------------------------------------- resident

export class ResidentInvoiceLineDto {
  @ApiProperty({ type: 'integer', example: 2 })
  lineNo!: number;

  @ApiProperty({ enum: InvoiceLineKindName, enumName: 'InvoiceLineKind' })
  lineKind!: InvoiceLineKindName;

  @ApiProperty({ example: 'ค่าไฟฟ้า 120 หน่วย × 7.0000' })
  description!: string;

  @ApiProperty({ example: '120.000' })
  quantity!: string;

  @ApiProperty({ type: String, nullable: true, example: 'kwh' })
  unit!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '7.0000' })
  unitPrice!: string | null;

  @MoneyOutput({ example: '840.00', description: 'Amount.' })
  amount!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-01' })
  periodFrom!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-31' })
  periodTo!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1114.500',
    description: 'Opening register (D-022).',
  })
  registerFrom!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1234.500',
    description: 'Closing register (D-022).',
  })
  registerTo!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'iot', description: 'Reading source badge (D-012).' })
  readingSource!: string | null;

  @ApiProperty({ example: false })
  isEstimated!: boolean;
}

export class ResidentInvoiceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'INV-2026-00042' })
  number!: string;

  @ApiProperty({ enum: InvoiceStatusName, enumName: 'InvoiceStatus', example: InvoiceStatusName.Issued })
  status!: InvoiceStatusName;

  @ApiProperty({ example: 'หอพักสุขใจ', description: 'The issuing company (the tenant).' })
  issuerName!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ type: String, format: 'date', example: '2026-10-01' })
  periodStart!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-10-31' })
  periodEnd!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-11-05' })
  dueDate!: string;

  @ApiProperty({ example: false })
  isFinal!: boolean;

  @ApiProperty({ type: [ResidentInvoiceLineDto] })
  lines!: ResidentInvoiceLineDto[];

  @MoneyOutput({ example: '5344.00', description: 'Invoice total.' })
  total!: string;

  @MoneyOutput({ example: '0.00', description: 'Earlier unpaid balance shown on this invoice.' })
  priorBalance!: string;

  @MoneyOutput({ example: '5344.00', description: 'Amount due at issue.' })
  amountDue!: string;

  @MoneyOutput({ example: '5344.00', description: 'Outstanding now.' })
  balance!: string;

  @ApiProperty({ example: false })
  hasEstimate!: boolean;
}

export class ResidentInvoiceListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: InvoiceStatusName, enumName: 'InvoiceStatus' })
  @IsOptional()
  @IsEnum(InvoiceStatusName)
  status?: InvoiceStatusName;

  @ApiPropertyOptional({ type: Boolean, description: 'Only invoices with a balance.' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : (value as unknown)))
  @IsBoolean()
  unpaid?: boolean;
}

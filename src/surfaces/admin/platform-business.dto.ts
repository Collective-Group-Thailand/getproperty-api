import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
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

import { DecimalInput, MoneyInput, MoneyOutput } from '../shared/fields';
import { SubscriptionStateName, TenantTypeName } from '../shared/me.dto';
import { TemplateVersionStateName } from './admin.dto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PCT = /^\d{1,2}(\.\d{1,4})?$/;

// ------------------------------------------------------------------------------------------- enums

export enum PlanKindName {
  Software = 'software',
  Addon = 'addon',
  HardwareRental = 'hardware_rental',
  HardwareSale = 'hardware_sale',
  Service = 'service',
}
export enum PlanBillingUnitName {
  PerUnit = 'per_unit',
  PerMeterPoint = 'per_meter_point',
  PerBuilding = 'per_building',
  PerTenant = 'per_tenant',
  PerReport = 'per_report',
}
/** The same values as `TemplateVersionState` (one named enum in the contract). */
export const PlanVersionStateName = TemplateVersionStateName;
export type PlanVersionStateName = TemplateVersionStateName;
/** The same values as `SubscriptionState` of `me` (one named enum in the contract). */
export const SubscriptionStatusName = SubscriptionStateName;
export type SubscriptionStatusName = SubscriptionStateName;
export enum BillingPeriodName {
  Monthly = 'monthly',
  Annual = 'annual',
}
export enum PlatformInvoiceStatusName {
  Draft = 'draft',
  Issued = 'issued',
  Paid = 'paid',
  PartiallyPaid = 'partially_paid',
  Overdue = 'overdue',
  Void = 'void',
  Credited = 'credited',
}
export enum PlatformInvoiceKindName {
  First = 'first',
  Monthly = 'monthly',
  Adjustment = 'adjustment',
}
export enum PlatformLineKindName {
  Subscription = 'subscription',
  Addon = 'addon',
  Setup = 'setup',
  HardwareRental = 'hardware_rental',
  HardwareSale = 'hardware_sale',
  AiOverage = 'ai_overage',
  Inspection = 'inspection',
  Discount = 'discount',
  Adjustment = 'adjustment',
}
export enum PlatformPaymentMethodName {
  Qr = 'qr',
  BankTransfer = 'bank_transfer',
  Card = 'card',
  Offset = 'offset',
}
export enum ManualPlatformPaymentMethodName {
  BankTransfer = 'bank_transfer',
  Card = 'card',
}
export enum PlatformCreditNoteStateName {
  Requested = 'requested',
  Issued = 'issued',
  Rejected = 'rejected',
}
export enum HaasStateName {
  Allocated = 'allocated',
  Installed = 'installed',
  InService = 'in_service',
  Replaced = 'replaced',
  Deinstalled = 'deinstalled',
  WrittenOff = 'written_off',
}
export enum SiteSurveyStateName {
  Requested = 'requested',
  Scheduled = 'scheduled',
  Done = 'done',
  Cancelled = 'cancelled',
}
export enum InstallOrderKindName {
  Install = 'install',
  Deinstall = 'deinstall',
  Replace = 'replace',
  SiteSurvey = 'site_survey',
}
export enum InstallOrderStateName {
  Open = 'open',
  InProgress = 'in_progress',
  Done = 'done',
  Cancelled = 'cancelled',
}
export enum InstallItemKindName {
  Gateway = 'gateway',
  MeterDevice = 'meter_device',
}
export enum InstallItemStateName {
  Open = 'open',
  Done = 'done',
}
export enum AiFeatureName {
  MeterOcr = 'meter_ocr',
  InvoiceOcr = 'invoice_ocr',
  ResidentBot = 'resident_bot',
  LegalQa = 'legal_qa',
  Stt = 'stt',
  Minutes = 'minutes',
  Other = 'other',
}
export enum KpiWindowName {
  D30 = '30d',
  D90 = '90d',
}

// ------------------------------------------------------------------------------------------- price plans

export class PriceRangeDto {
  @MoneyOutput({ example: '3000.00', description: 'From.' })
  from!: string;

  @MoneyOutput({ example: '8000.00', description: 'To.' })
  to!: string;
}

export class PricePlanVersionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({ format: 'date', example: '2026-01-01' })
  effectiveFrom!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  effectiveTo!: string | null;

  @ApiProperty({
    enum: PlanBillingUnitName,
    enumName: 'PlanBillingUnit',
    example: PlanBillingUnitName.PerUnit,
  })
  billingUnit!: PlanBillingUnitName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '25.0000',
    description: 'THB per billing unit and month, 4 decimals.',
  })
  unitPrice!: string | null;

  @ApiProperty({
    type: () => PriceRangeDto,
    nullable: true,
    description: 'Quoted plans (no automatic price).',
  })
  priceRange!: PriceRangeDto | null;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [{ upToUnits: 3, monthly: '0.00' }],
    description:
      'Volume tiers (`fromUnits`, `toUnits`, `pricePerUnit`) or flat steps (`upToUnits`, `monthly`).',
  })
  tiers!: Record<string, unknown>[];

  @ApiProperty({ type: 'integer', nullable: true, example: 20 })
  minUnits!: number | null;

  @MoneyOutput({ example: null, description: 'Minimum per month.', nullable: true })
  minMonthly!: string | null;

  @ApiProperty({ example: '15.0000', description: 'Annual prepayment discount, %.' })
  annualDiscountPct!: string;

  @ApiProperty({ type: 'integer', nullable: true, example: null })
  termMonths!: number | null;

  @MoneyOutput({ example: '0.00', description: 'One-off setup fee.' })
  setupFee!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { ocrPhotosPerMonth: 500, ocrOveragePerPhoto: '0.50' },
    description: 'Included allowances (D-161).',
  })
  includedAllowances!: Record<string, unknown>;

  @ApiProperty({ example: '0.0700' })
  vatRate!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { status: 'proposed', decision: 'D-156' },
  })
  terms!: Record<string, unknown>;

  @ApiProperty({
    enum: PlanVersionStateName,
    enumName: 'TemplateVersionState',
    example: PlanVersionStateName.Published,
  })
  state!: PlanVersionStateName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  publishedAt!: string | null;

  @ApiProperty({ type: [String], example: [] })
  nextActions!: string[];
}

export class PricePlanDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'apartment_starter' })
  key!: string;

  @ApiProperty({
    enum: TenantTypeName,
    enumName: 'TenantType',
    nullable: true,
    example: TenantTypeName.Apartment,
  })
  tenantType!: TenantTypeName | null;

  @ApiProperty({ example: 'Apartment Starter' })
  nameTh!: string;

  @ApiProperty({ example: 'Apartment Starter' })
  nameEn!: string;

  @ApiProperty({ enum: PlanKindName, enumName: 'PlanKind', example: PlanKindName.Software })
  kind!: PlanKindName;

  @ApiProperty({ example: true, description: 'Sold now (Phase 1: apartment plans, meter rental, landlord).' })
  isActive!: boolean;

  @ApiProperty({ type: () => [PricePlanVersionDto] })
  versions!: PricePlanVersionDto[];
}

export class PriceRangeInputDto {
  @MoneyInput({ example: '3000.00', description: 'From.' })
  from!: string;

  @MoneyInput({ example: '8000.00', description: 'To.' })
  to!: string;
}

export class PricePlanVersionCreateDto {
  @ApiProperty({
    format: 'date',
    example: '2027-03-01',
    description: 'Not before today (published versions are never backdated).',
  })
  @Matches(DATE)
  effectiveFrom!: string;

  @ApiProperty({
    enum: PlanBillingUnitName,
    enumName: 'PlanBillingUnit',
    example: PlanBillingUnitName.PerUnit,
  })
  @IsEnum(PlanBillingUnitName)
  billingUnit!: PlanBillingUnitName;

  @DecimalInput({
    example: '25',
    description: 'THB per billing unit and month.',
    optional: true,
    nullable: true,
  })
  unitPrice?: string | null;

  @ApiPropertyOptional({ type: () => PriceRangeInputDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRangeInputDto)
  priceRange?: PriceRangeInputDto | null;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true }, example: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  tiers?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: 'integer', nullable: true, example: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minUnits?: number | null;

  @MoneyInput({ example: '0.00', description: 'Minimum per month.', optional: true, nullable: true })
  minMonthly?: string | null;

  @ApiPropertyOptional({ example: '15', pattern: PCT.source })
  @IsOptional()
  @Matches(PCT)
  annualDiscountPct?: string;

  @ApiPropertyOptional({ type: 'integer', nullable: true, example: null })
  @IsOptional()
  @IsInt()
  @Min(1)
  termMonths?: number | null;

  @MoneyInput({ example: '0.00', description: 'Setup fee.', optional: true })
  setupFee?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { ocrPhotosPerMonth: 500, ocrOveragePerPhoto: '0.50' },
  })
  @IsOptional()
  @IsObject()
  includedAllowances?: Record<string, unknown>;

  @ApiPropertyOptional({ example: '0.07', pattern: '^0(\\.\\d{1,4})?$' })
  @IsOptional()
  @Matches(/^0(\.\d{1,4})?$/)
  vatRate?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { status: 'proposed', decision: 'D-156' },
  })
  @IsOptional()
  @IsObject()
  terms?: Record<string, unknown>;
}

// ------------------------------------------------------------------------------------------- subscriptions

export class PlanRefDto {
  @ApiProperty({ example: 'apartment_starter' })
  key!: string;

  @ApiProperty({ example: 'Apartment Starter' })
  nameTh!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  versionId!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class SubscriptionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({ type: () => PlanRefDto })
  plan!: PlanRefDto;

  @ApiProperty({ type: () => [PlanRefDto], description: 'Add-ons (meter rental for Smart).' })
  addons!: PlanRefDto[];

  @ApiProperty({
    enum: SubscriptionStatusName,
    enumName: 'SubscriptionState',
    example: SubscriptionStatusName.Trial,
  })
  state!: SubscriptionStatusName;

  @ApiProperty({ format: 'date-time', example: '2026-11-16T10:00:00+07:00' })
  trialEndsAt!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  startedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  activatedAt!: string | null;

  @ApiProperty({ enum: BillingPeriodName, enumName: 'BillingPeriod', example: BillingPeriodName.Monthly })
  billingPeriod!: BillingPeriodName;

  @ApiProperty({ example: '0.0000', description: 'Discount on every invoice, % (pilot, D-083).' })
  discountPct!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  discountReason!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  pilotAgreementId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  pastDueSince!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  suspendedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  cancelEffectiveDate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancelReason!: string | null;

  @ApiProperty({ example: false, description: 'The tenant is read-only (suspended or cancelled, D-082).' })
  readOnly!: boolean;

  @ApiProperty({ type: [String], example: ['change-plan', 'cancel', 'suspend'] })
  nextActions!: string[];
}

export class SubscriptionCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ example: 'apartment_starter' })
  @Matches(/^[a-z][a-z0-9_]{1,40}$/)
  planKey!: string;

  @ApiPropertyOptional({ type: [String], example: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  addonKeys?: string[];

  @ApiPropertyOptional({
    enum: BillingPeriodName,
    enumName: 'BillingPeriod',
    example: BillingPeriodName.Monthly,
  })
  @IsOptional()
  @IsEnum(BillingPeriodName)
  billingPeriod?: BillingPeriodName;
}

export class SubscriptionChangePlanDto {
  @ApiProperty({ example: 'apartment_smart' })
  @Matches(/^[a-z][a-z0-9_]{1,40}$/)
  planKey!: string;

  @ApiPropertyOptional({ type: [String], example: ['meter_rental'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  addonKeys?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ติดตั้งมิเตอร์ครบทั้งอาคารแล้ว' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class SubscriptionCancelDto {
  @ApiProperty({ example: 'ลูกค้าขายกิจการ' })
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-12-31',
    description: 'Default: the last day of the current month (Asia/Bangkok).',
  })
  @IsOptional()
  @Matches(DATE)
  effectiveDate?: string | null;
}

export class SubscriptionSuspendDto {
  @ApiProperty({ example: 'ค้างชำระเกินกำหนดและติดต่อไม่ได้' })
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiProperty({
    example: 'sample-dormitory',
    description: 'Typed confirmation: the tenant slug (409 `subscription.confirmation_mismatch` otherwise).',
  })
  @IsString()
  @Length(1, 60)
  confirm!: string;
}

export class SubscriptionEventDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'state.active' })
  type!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  occurredAt!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { from: 'trial', to: 'active' } })
  data!: Record<string, unknown>;
}

export class SubscriptionListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: SubscriptionStatusName, enumName: 'SubscriptionState' })
  @IsOptional()
  @IsEnum(SubscriptionStatusName)
  state?: SubscriptionStatusName;
}

export class UsageLineDto {
  @ApiProperty({
    enum: PlatformLineKindName,
    enumName: 'PlatformLineKind',
    example: PlatformLineKindName.Subscription,
  })
  kind!: PlatformLineKindName;

  @ApiProperty({ example: 'Apartment Starter' })
  description!: string;

  @ApiProperty({ example: '20.000' })
  quantity!: string;

  @ApiProperty({ example: '25.0000' })
  unitPrice!: string;

  @MoneyOutput({ example: '500.00', description: 'Line amount (discount lines negative).' })
  amount!: string;
}

export class SubscriptionUsageDto {
  @ApiProperty({ format: 'date', example: '2026-11-01' })
  month!: string;

  @ApiProperty({
    type: 'integer',
    example: 12,
    description: 'Units whose status is not inactive on the 1st (D-082).',
  })
  unitsCounted!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  meterPointsCounted!: number;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description: 'Meter photos read by OCR in the previous month (D-161).',
  })
  ocrImages!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { [FAKE.buildingId]: 12 },
  })
  unitsByBuilding!: Record<string, number>;

  @MoneyOutput({ example: '535.00', description: 'Amount of the month incl. VAT.' })
  amountComputed!: string;

  @ApiProperty({ type: () => [UsageLineDto] })
  lines!: UsageLineDto[];
}

export class UsageCountsDto {
  @ApiProperty({ type: 'integer', example: 12 })
  units!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  meterPoints!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  buildings!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  ocrImages!: number;
}

export class ChargesDto {
  @ApiProperty({ type: () => [UsageLineDto] })
  lines!: UsageLineDto[];

  @MoneyOutput({ example: '500.00', description: 'Before discount and VAT.' })
  subtotal!: string;

  @MoneyOutput({ example: '0.00', description: 'Discount.' })
  discount!: string;

  @MoneyOutput({ example: '35.00', description: 'VAT.' })
  vatAmount!: string;

  @MoneyOutput({ example: '535.00', description: 'Total.' })
  total!: string;
}

export class OwnerSubscriptionDto {
  @ApiProperty({ type: () => SubscriptionDto, nullable: true })
  subscription!: SubscriptionDto | null;

  @ApiProperty({ type: () => UsageCountsDto, nullable: true, description: 'What is counted today.' })
  usageToday!: UsageCountsDto | null;

  @ApiProperty({
    type: () => ChargesDto,
    nullable: true,
    description:
      'What a month would cost with today’s usage (estimate; the invoice of the 1st is the truth).',
  })
  estimate!: ChargesDto | null;

  @ApiProperty({ type: 'integer', example: 0 })
  openInvoices!: number;

  @ApiProperty({ type: [String], example: ['upgrade'] })
  nextActions!: string[];
}

// ------------------------------------------------------------------------------------------- platform invoices

export class PlatformInvoiceLineDto extends UsageLineDto {
  @ApiProperty({ type: 'integer', example: 1 })
  lineNo!: number;
}

export class PlatformPaymentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @MoneyOutput({ example: '535.00', description: 'Amount.' })
  amount!: string;

  @ApiProperty({
    enum: PlatformPaymentMethodName,
    enumName: 'PlatformPaymentMethod',
    example: PlatformPaymentMethodName.Qr,
  })
  method!: PlatformPaymentMethodName;

  @ApiProperty({ type: String, nullable: true, example: 'kbank' })
  provider!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'KB20261105-0001' })
  providerRef!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  paidAt!: string;

  @ApiProperty({ type: String, nullable: true, example: 'PRC-2026-00001' })
  receiptNumber!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  receiptDocumentId!: string | null;
}

export class PlatformCreditNoteDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  invoiceId!: string;

  @ApiProperty({
    enum: PlatformCreditNoteStateName,
    enumName: 'PlatformCreditNoteState',
    example: PlatformCreditNoteStateName.Requested,
  })
  state!: PlatformCreditNoteStateName;

  @ApiProperty({ type: String, nullable: true, example: null })
  number!: string | null;

  @MoneyOutput({ example: '100.00', description: 'Amount credited.' })
  amount!: string;

  @ApiProperty({ example: 'คิดหน่วยเกินจากห้องที่ปิดปรับปรุง' })
  reason!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  requestedBy!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  approvedBy!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  issuedAt!: string | null;

  @ApiProperty({ type: [String], example: ['approve', 'reject'] })
  nextActions!: string[];
}

export class PlatformQrDto {
  @ApiProperty({
    example: '00020101021230...6304ABCD',
    description: 'EMVCo Thai QR (Tag 30) of the platform merchant.',
  })
  payload!: string;

  @ApiProperty({ example: 'PIV202600001' })
  reference!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  expiresAt!: string | null;
}

export class PlatformInvoiceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  subscriptionId!: string;

  @ApiProperty({ example: 'PIV-2026-00001' })
  number!: string;

  @ApiProperty({
    enum: PlatformInvoiceKindName,
    enumName: 'PlatformInvoiceKind',
    example: PlatformInvoiceKindName.Monthly,
  })
  kind!: PlatformInvoiceKindName;

  @ApiProperty({ format: 'date', example: '2026-11-01' })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2026-11-30' })
  periodEnd!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-16T10:00:00+07:00' })
  dueAt!: string;

  @MoneyOutput({ example: '500.00', description: 'Before discount and VAT.' })
  subtotal!: string;

  @MoneyOutput({ example: '0.00', description: 'Discount (pilot, D-083).' })
  discount!: string;

  @MoneyOutput({ example: '35.00', description: 'VAT.' })
  vatAmount!: string;

  @MoneyOutput({ example: '535.00', description: 'Total.' })
  total!: string;

  @MoneyOutput({ example: '0.00', description: 'Paid.' })
  paidTotal!: string;

  @MoneyOutput({ example: '0.00', description: 'Credited.' })
  creditedTotal!: string;

  @MoneyOutput({ example: '535.00', description: 'Still to pay.' })
  openAmount!: string;

  @ApiProperty({
    enum: PlatformInvoiceStatusName,
    enumName: 'PlatformInvoiceStatus',
    example: PlatformInvoiceStatusName.Issued,
  })
  state!: PlatformInvoiceStatusName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  overdueSince!: string | null;

  @ApiProperty({ type: () => PlatformQrDto, nullable: true })
  qr!: PlatformQrDto | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'The PDF (core.document).',
  })
  documentId!: string | null;

  @ApiProperty({ type: () => [PlatformInvoiceLineDto] })
  lines!: PlatformInvoiceLineDto[];

  @ApiProperty({ type: () => [PlatformPaymentDto] })
  payments!: PlatformPaymentDto[];

  @ApiProperty({ type: () => [PlatformCreditNoteDto] })
  creditNotes!: PlatformCreditNoteDto[];

  @ApiProperty({ type: [String], example: ['record-payment', 'request-credit-note'] })
  nextActions!: string[];
}

export class PlatformInvoiceListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: PlatformInvoiceStatusName, enumName: 'PlatformInvoiceStatus' })
  @IsOptional()
  @IsEnum(PlatformInvoiceStatusName)
  state?: PlatformInvoiceStatusName;
}

export class PlatformPaymentCreateDto {
  @MoneyInput({ example: '535.00', description: 'Amount received.' })
  amount!: string;

  @ApiProperty({
    enum: ManualPlatformPaymentMethodName,
    enumName: 'ManualPlatformPaymentMethod',
    example: ManualPlatformPaymentMethodName.BankTransfer,
  })
  @IsEnum(ManualPlatformPaymentMethodName)
  method!: ManualPlatformPaymentMethodName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  @IsDateString()
  paidAt!: string;

  @ApiProperty({
    example: 'KTB-20261105-778899',
    description: 'Bank reference of the transfer (unique per method).',
  })
  @IsString()
  @Length(3, 80)
  reference!: string;
}

export class PlatformCreditNoteRequestDto {
  @MoneyInput({ example: '100.00', description: 'Amount to credit.' })
  amount!: string;

  @ApiProperty({ example: 'คิดหน่วยเกินจากห้องที่ปิดปรับปรุง' })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class PlatformCallbackResultDto {
  @ApiProperty({ example: 'evt_KB202611050001' })
  eventId!: string;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [{ reference: 'PIV202600001', outcome: 'applied' }],
  })
  results!: { reference: string; outcome: string }[];
}

// ------------------------------------------------------------------------------------------- pilots

export class PilotBaselineDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: '72' })
  @IsOptional()
  @IsString()
  timeToBillHours?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '4.5' })
  @IsOptional()
  @IsString()
  invoiceCorrectionRatePct?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '62' })
  @IsOptional()
  @IsString()
  onTimePaymentPct?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '0' })
  @IsOptional()
  @IsString()
  autoReconciledPct?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  lossPct?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  meterUptimePct?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '3.9' })
  @IsOptional()
  @IsString()
  csat?: string | null;
}

export class PilotAgreementUpsertDto {
  @ApiProperty({ format: 'date', example: '2027-02-01' })
  @Matches(DATE)
  signedOn!: string;

  @ApiProperty({
    example: '30',
    description: 'Pilot discount, % — a paid pilot, never 100 (D-083).',
    pattern: PCT.source,
  })
  @Matches(PCT)
  discountPct!: string;

  @ApiProperty({ type: 'integer', example: 6 })
  @IsInt()
  @Min(1)
  @Max(36)
  termMonths!: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  referenceSiteRights?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  anonymisedDataUse?: boolean;

  @ApiPropertyOptional({ example: 'biweekly' })
  @IsOptional()
  @IsIn(['weekly', 'biweekly', 'monthly'])
  feedbackCadence?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: '2027-05-02',
    description: 'Default: signed + 90 days.',
  })
  @IsOptional()
  @Matches(DATE)
  kpiReviewOn?: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true, example: null })
  @IsOptional()
  @IsObject()
  kpiTargets?: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: () => PilotBaselineDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PilotBaselineDto)
  baseline?: PilotBaselineDto | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: null })
  @IsOptional()
  @IsUUID()
  agreementDocumentId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class PilotAgreementDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ format: 'date', example: '2027-02-01' })
  signedOn!: string;

  @ApiProperty({ example: '30.0000' })
  discountPct!: string;

  @ApiProperty({ type: 'integer', example: 6 })
  termMonths!: number;

  @ApiProperty({ example: true })
  referenceSiteRights!: boolean;

  @ApiProperty({ example: true })
  anonymisedDataUse!: boolean;

  @ApiProperty({ example: 'biweekly' })
  feedbackCadence!: string;

  @ApiProperty({ format: 'date', example: '2027-05-02' })
  kpiReviewOn!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { autoReconciledPctMin: '90' } })
  kpiTargets!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { timeToBillHours: '72' } })
  baseline!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  agreementDocumentId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;
}

// ------------------------------------------------------------------------------------------- HaaS & field work

export class HaasAssetEventDto {
  @ApiProperty({ example: 'installed' })
  type!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  occurredAt!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { from: 'allocated' } })
  data!: Record<string, unknown>;
}

export class HaasAssetDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  deviceId!: string;

  @ApiProperty({ example: 'GP-GW-000123' })
  serial!: string;

  @ApiProperty({ example: 'gateway' })
  kind!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.buildingId })
  buildingId!: string | null;

  @ApiProperty({ enum: HaasStateName, enumName: 'HaasState', example: HaasStateName.InService })
  state!: HaasStateName;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-02-01' })
  installedOn!: string | null;

  @ApiProperty({ type: 'integer', example: 36 })
  termMonths!: number;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2030-01-31' })
  termEnd!: string | null;

  @MoneyOutput({ example: '60.00', description: 'Monthly value.' })
  monthlyValue!: string;

  @MoneyOutput({ example: '1800.00', description: 'Acquisition cost.' })
  acquisitionCost!: string;

  @MoneyOutput({ example: '1750.00', description: 'Straight-line book value today (D-081).' })
  bookValue!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  replacedByAssetId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  deinstallOrderId!: string | null;

  @ApiProperty({ type: () => [HaasAssetEventDto] })
  events!: HaasAssetEventDto[];

  @ApiProperty({ type: [String], example: ['install', 'write-off'] })
  nextActions!: string[];
}

export class HaasAssetCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  @IsUUID()
  deviceId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  @IsUUID()
  tenantId!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.buildingId })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiProperty({ type: 'integer', example: 36 })
  @IsInt()
  @Min(1)
  @Max(120)
  termMonths!: number;

  @MoneyInput({ example: '60.00', description: 'Monthly value.' })
  monthlyValue!: string;

  @MoneyInput({ example: '1800.00', description: 'Acquisition cost.' })
  acquisitionCost!: string;
}

export class HaasTransitionDto {
  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2027-02-01' })
  @IsOptional()
  @Matches(DATE)
  date?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'replace: the new device.',
  })
  @IsOptional()
  @IsUUID()
  replacementDeviceId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: null })
  @IsOptional()
  @IsUUID()
  installOrderId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class HaasListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: HaasStateName, enumName: 'HaasState' })
  @IsOptional()
  @IsEnum(HaasStateName)
  state?: HaasStateName;
}

export class InstallItemDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  unitId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.meterId })
  @IsOptional()
  @IsUUID()
  assetItemId!: string | null;

  @ApiProperty({
    example: 'electric_meter',
    description: '`gateway`, `electric_meter`, `water_meter` (device kind).',
  })
  @IsIn(['gateway', 'electric_meter', 'water_meter'])
  deviceKind!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  @IsOptional()
  @IsUUID()
  deviceId!: string | null;

  @ApiProperty({ example: false })
  @IsBoolean()
  done!: boolean;
}

export class InstallOrderDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({
    enum: InstallOrderKindName,
    enumName: 'InstallOrderKind',
    example: InstallOrderKindName.Install,
  })
  kind!: InstallOrderKindName;

  @ApiProperty({
    enum: InstallOrderStateName,
    enumName: 'InstallOrderState',
    example: InstallOrderStateName.Open,
  })
  state!: InstallOrderStateName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  assignedTo!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  dueAt!: string | null;

  @ApiProperty({ type: () => [InstallItemDto] })
  items!: InstallItemDto[];

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  completedAt!: string | null;

  @ApiProperty({ type: [String], example: ['assign', 'start', 'complete-items', 'cancel'] })
  nextActions!: string[];
}

export class InstallOrderCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({
    enum: InstallOrderKindName,
    enumName: 'InstallOrderKind',
    example: InstallOrderKindName.Install,
  })
  @IsEnum(InstallOrderKindName)
  kind!: InstallOrderKindName;

  @ApiProperty({ type: () => [InstallItemDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => InstallItemDto)
  items!: InstallItemDto[];

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: null })
  @IsOptional()
  @IsDateString()
  dueAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class InstallOrderActionDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'assign: a field engineer.',
  })
  @IsOptional()
  @IsUUID()
  assignedTo?: string | null;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'integer' },
    example: [0, 1],
    description: 'complete-items: item positions.',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  itemIndexes?: number[];

  @ApiPropertyOptional({
    type: [String],
    example: [FAKE.uuid],
    description: 'complete-items: the installed device per item.',
  })
  @IsOptional()
  @IsArray()
  deviceIds?: (string | null)[];

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class InstallOrderListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: InstallOrderStateName, enumName: 'InstallOrderState' })
  @IsOptional()
  @IsEnum(InstallOrderStateName)
  state?: InstallOrderStateName;

  @ApiPropertyOptional({ enum: InstallOrderKindName, enumName: 'InstallOrderKind' })
  @IsOptional()
  @IsEnum(InstallOrderKindName)
  kind?: InstallOrderKindName;
}

export class SiteSurveyListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: SiteSurveyStateName, enumName: 'SiteSurveyState' })
  @IsOptional()
  @IsEnum(SiteSurveyStateName)
  state?: SiteSurveyStateName;
}

export class StaffInstallItemDto {
  @ApiProperty({
    enum: InstallItemKindName,
    enumName: 'InstallItemKind',
    example: InstallItemKindName.MeterDevice,
  })
  kind!: InstallItemKindName;

  @ApiProperty({ example: 'electric_meter' })
  deviceKind!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.meterId })
  assetItemId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  deviceId!: string | null;

  @ApiProperty({
    enum: InstallItemStateName,
    enumName: 'InstallItemState',
    example: InstallItemStateName.Open,
  })
  state!: InstallItemStateName;
}

export class StaffInstallUnitDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'null = building-level items (the gateway).',
  })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ type: () => [StaffInstallItemDto] })
  items!: StaffInstallItemDto[];
}

export class StaffInstallOrderDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: InstallOrderKindName,
    enumName: 'InstallOrderKind',
    example: InstallOrderKindName.Install,
  })
  kind!: InstallOrderKindName;

  @ApiProperty({
    enum: InstallOrderStateName,
    enumName: 'InstallOrderState',
    example: InstallOrderStateName.Open,
  })
  state!: InstallOrderStateName;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  dueAt!: string | null;

  @ApiProperty({ type: () => [StaffInstallUnitDto] })
  units!: StaffInstallUnitDto[];
}

export class StaffInstallOrdersDto {
  @ApiProperty({ type: () => [StaffInstallOrderDto] })
  data!: StaffInstallOrderDto[];
}

export class SiteSurveyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'apartment_smart' })
  targetPlanKey!: string;

  @ApiProperty({
    enum: SiteSurveyStateName,
    enumName: 'SiteSurveyState',
    example: SiteSurveyStateName.Requested,
  })
  state!: SiteSurveyStateName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  scheduledFor!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  assignedTo!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, example: {} })
  findings!: Record<string, unknown>;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  installOrderId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class UpgradeRequestDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.buildingId,
    description: 'The building to survey for smart meters.',
  })
  @IsUUID()
  buildingId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'สะดวกวันเสาร์' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class SiteSurveyActionDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-11-20T10:00:00+07:00',
  })
  @IsOptional()
  @IsDateString()
  scheduledFor?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: null })
  @IsOptional()
  @IsUUID()
  assignedTo?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { rs485: 'ok', cabinet: 'ชั้น 1' },
  })
  @IsOptional()
  @IsObject()
  findings?: Record<string, unknown>;

  @ApiPropertyOptional({ example: true, description: 'complete: open the install order (default true).' })
  @IsOptional()
  @IsBoolean()
  install?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

// ------------------------------------------------------------------------------------------- KPIs & AI usage

export class KpiQuery {
  @ApiPropertyOptional({ enum: KpiWindowName, enumName: 'KpiWindow', default: KpiWindowName.D90 })
  @IsOptional()
  @IsEnum(KpiWindowName)
  window?: KpiWindowName;
}

export class KpiResultDto {
  @ApiProperty({ example: 'auto_reconciled' })
  kpi!: string;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'boolean' }], nullable: true, example: '0' })
  baseline!: string | boolean | null;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'boolean' }], nullable: true, example: '95.00' })
  current!: string | boolean | null;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'boolean' }], example: '>=90%' })
  target!: string | boolean;

  @ApiProperty({ type: Boolean, nullable: true, example: true, description: 'null = not enough data.' })
  met!: boolean | null;
}

export class KpiValuesDto {
  @ApiProperty({ type: String, nullable: true, example: '0.25' })
  timeToBillHours!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '0.00' })
  invoiceCorrectionRatePct!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '81.25' })
  onTimePaymentPct!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '95.00' })
  autoReconciledPct!: string | null;

  @ApiProperty({ example: true })
  lossIdentified!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2.2706' })
  latestLossPct!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '99.80' })
  meterUptimePct!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Average 1–5 of repair ratings (B5.1) and the LIFF survey (B6.3); null without any.',
  })
  csat!: string | null;
}

export class Phase1AcceptanceDto {
  @ApiProperty({ type: Boolean, nullable: true, example: true })
  firstFullCycleWithin1h!: boolean | null;

  @ApiProperty({ type: String, nullable: true, example: '72.00' })
  paidByQrPct!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Requests reported by residents through LINE ÷ requests reported by people, % (B6.3).',
  })
  serviceRequestsViaLinePct!: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  buildingsBillingAutomatically!: number;
}

export class PilotKpisDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ enum: KpiWindowName, enumName: 'KpiWindow', example: KpiWindowName.D90 })
  window!: KpiWindowName;

  @ApiProperty({ format: 'date-time', example: '2026-08-01T00:00:00+07:00' })
  from!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  to!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2027-05-02',
    description: 'The 90-day review date of the pilot (D-083).',
  })
  kpiReviewOn!: string | null;

  @ApiProperty({ type: () => [KpiResultDto] })
  kpis!: KpiResultDto[];

  @ApiProperty({ type: () => KpiValuesDto })
  current!: KpiValuesDto;

  @ApiProperty({ type: () => Phase1AcceptanceDto })
  acceptance!: Phase1AcceptanceDto;
}

export class AiUsageMonthDto {
  @ApiProperty({ format: 'date', example: '2026-11-01' })
  month!: string;

  @ApiProperty({ enum: AiFeatureName, enumName: 'AiFeature', example: AiFeatureName.MeterOcr })
  feature!: AiFeatureName;

  @ApiProperty({ type: 'integer', example: 120 })
  calls!: number;

  @ApiProperty({ type: 'integer', example: 120, description: 'Images / tokens / seconds per the feature.' })
  units!: number;

  @MoneyOutput({ example: '0.00', description: 'Cost to the platform (ai.unit_costs, O-009).' })
  costThb!: string;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 500,
    description: 'Included in the plan (meter OCR, D-161).',
  })
  allowance!: number | null;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description: 'Units above the allowance (billed as ai_overage).',
  })
  overage!: number;
}

export class AiUsageDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ type: () => [AiUsageMonthDto] })
  months!: AiUsageMonthDto[];
}

// ------------------------------------------------------------------------------------------- tenant console

export class BillingCycleRefDto {
  @ApiProperty({ example: '2026-10' })
  periodKey!: string;

  @ApiProperty({ example: 'issued' })
  status!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class GatewayCountsDto {
  @ApiProperty({ type: 'integer', example: 1 })
  total!: number;

  @ApiProperty({ type: 'integer', example: 1, description: 'Reported in the last 15 minutes.' })
  online!: number;
}

export enum TenantHealthSignalName {
  PastDue = 'past_due',
  Suspended = 'suspended',
  TrialEnding = 'trial_ending',
  NoCycleThisMonth = 'no_cycle_this_month',
  GatewaysOffline = 'gateways_offline',
}

export class TenantHealthDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({
    example: 'active',
    description: 'Tenant status (`read_only` while suspended or cancelled).',
  })
  status!: string;

  @ApiProperty({
    enum: SubscriptionStatusName,
    enumName: 'SubscriptionState',
    nullable: true,
    example: SubscriptionStatusName.Trial,
  })
  subscriptionState!: SubscriptionStatusName | null;

  @ApiProperty({ type: String, nullable: true, example: 'apartment_starter' })
  planKey!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-11-16T10:00:00+07:00' })
  trialEndsAt!: string | null;

  @ApiProperty({ type: 'integer', example: 12, description: 'Units counted today (status not inactive).' })
  units!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  buildings!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  openPlatformInvoices!: number;

  @MoneyOutput({ example: '0.00', description: 'Overdue on platform invoices.' })
  overduePlatformAmount!: string;

  @ApiProperty({ type: () => BillingCycleRefDto, nullable: true })
  lastBillingCycle!: BillingCycleRefDto | null;

  @ApiProperty({ type: () => GatewayCountsDto })
  gateways!: GatewayCountsDto;

  @ApiProperty({ enum: TenantHealthSignalName, enumName: 'TenantHealthSignal', isArray: true, example: [] })
  signals!: TenantHealthSignalName[];
}

export class TenantFeatureFlagsDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    example: { 'payments.provider.kbank': false, 'module.service_requests': true },
    description: 'Every flag as it resolves for this tenant (override, rollout or default).',
  })
  flags!: Record<string, boolean>;
}

export enum HaasActionName {
  Install = 'install',
  InService = 'in-service',
  Replace = 'replace',
  Deinstall = 'deinstall',
  WriteOff = 'write-off',
}
export enum InstallOrderActionName {
  Assign = 'assign',
  Start = 'start',
  CompleteItems = 'complete-items',
  Complete = 'complete',
  Cancel = 'cancel',
}
export enum SiteSurveyActionName {
  Schedule = 'schedule',
  Complete = 'complete',
  Cancel = 'cancel',
}

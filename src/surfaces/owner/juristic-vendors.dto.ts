import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
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
import { ApproverRoleName, ExpenseApprovalDto, ExpenseStateName } from './juristic-accounting.dto';
import { PartyTypeName } from './parties.dto';
import { ServicePriorityName, WorkOrderStatusName } from './service.dto';

/** J2.2 vendors, service contracts, quotation rounds, evaluations (D-310, D-331). */

// ------------------------------------------------------------------------------------------- enums

export enum VendorCategoryName {
  Security = 'security',
  Cleaning = 'cleaning',
  Gardening = 'gardening',
  Lift = 'lift',
  Pump = 'pump',
  FireSystem = 'fire_system',
  Electrical = 'electrical',
  Plumbing = 'plumbing',
  PestControl = 'pest_control',
  Pool = 'pool',
  Cctv = 'cctv',
  Waste = 'waste',
  BuildingWorks = 'building_works',
  Professional = 'professional',
  Insurance = 'insurance',
  Other = 'other',
}
export enum VendorStateName {
  Active = 'active',
  Blocked = 'blocked',
}
export enum VendorContractStateName {
  Draft = 'draft',
  Active = 'active',
  Expired = 'expired',
  Terminated = 'terminated',
}
export enum ContractInstalmentStateName {
  Scheduled = 'scheduled',
  Requested = 'requested',
  Cancelled = 'cancelled',
}
export enum ContractDocumentKindName {
  Contract = 'contract',
  Amendment = 'amendment',
  Insurance = 'insurance',
  Guarantee = 'guarantee',
  Other = 'other',
}
export enum InstalmentFrequencyName {
  Monthly = 'monthly',
  Quarterly = 'quarterly',
  Semiannual = 'semiannual',
  Annual = 'annual',
  Once = 'once',
}
export enum QuotationRoundStateName {
  Open = 'open',
  AwaitingApproval = 'awaiting_approval',
  Awarded = 'awarded',
  Cancelled = 'cancelled',
}
export enum AwardOutcomeName {
  Contract = 'contract',
  Expense = 'expense',
}
export enum AwardBasisName {
  Resolution = 'resolution',
  Approval = 'approval',
}
export enum SlaBreachKindName {
  Response = 'response',
  Resolve = 'resolve',
  RequestSla = 'request_sla',
}
export enum EvaluationTrendName {
  Improving = 'improving',
  Declining = 'declining',
  Steady = 'steady',
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toBool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

// ------------------------------------------------------------------------------------------- vendors

export class VendorDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The party paid (expense requests, 50 ทวิ).',
  })
  partyId!: string;

  @ApiProperty({ enum: PartyTypeName, enumName: 'PartyType', example: 'company' })
  partyType!: PartyTypeName;

  @ApiProperty({ example: 'บริษัท ลิฟต์ไทย เซอร์วิส จำกัด' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '4321',
    description: 'Last 4 digits of the tax id on the party (the full id is printed only on the 50 ทวิ).',
  })
  taxIdHint!: string | null;

  @ApiProperty({ enum: VendorCategoryName, enumName: 'VendorCategory', isArray: true, example: ['lift'] })
  categories!: VendorCategoryName[];

  @ApiProperty({ type: String, nullable: true, example: FAKE.name })
  contactName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+66810001234' })
  contactPhone!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.email })
  contactEmail!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'กสิกรไทย' })
  bankName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'บจก. ลิฟต์ไทย เซอร์วิส' })
  bankAccountName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '8812',
    description: 'Last 4 digits only — the full account number is never stored.',
  })
  bankAccountLast4!: string | null;

  @ApiProperty({ enum: VendorStateName, enumName: 'VendorState', example: 'active' })
  state!: VendorStateName;

  @ApiProperty({ type: String, nullable: true, example: null })
  blockedReason!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ type: 'integer', example: 1, description: 'Active contracts.' })
  activeContracts!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class VendorCreateDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An existing party of the tenant; without it the party is created from the fields below.',
  })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ enum: PartyTypeName, enumName: 'PartyType', example: 'company' })
  @IsOptional()
  @IsEnum(PartyTypeName)
  type?: PartyTypeName;

  @ApiProperty({ example: 'บริษัท ลิฟต์ไทย เซอร์วิส จำกัด', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({
    example: FAKE.taxId,
    description: '13-digit tax id (check digit verified), kept on the party: the 50 ทวิ needs it (D-329).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[\d\s-]{13,17}$/)
  taxId?: string;

  @ApiPropertyOptional({
    enum: VendorCategoryName,
    enumName: 'VendorCategory',
    isArray: true,
    example: ['lift'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsEnum(VendorCategoryName, { each: true })
  categories?: VendorCategoryName[];

  @ApiPropertyOptional({ example: FAKE.name, maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  contactName?: string;

  @ApiPropertyOptional({ example: FAKE.phone })
  @IsOptional()
  @IsString()
  @Length(6, 30)
  contactPhone?: string;

  @ApiPropertyOptional({ example: FAKE.email })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ example: 'กสิกรไทย', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  bankName?: string;

  @ApiPropertyOptional({ example: 'บจก. ลิฟต์ไทย เซอร์วิส', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  bankAccountName?: string;

  @ApiPropertyOptional({ example: '8812', description: 'Last 4 digits only.' })
  @IsOptional()
  @Matches(/^\d{4}$/)
  bankAccountLast4?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class VendorUpdateDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: '13-digit tax id; null clears it.' })
  @IsOptional()
  @IsString()
  @Matches(/^[\d\s-]{13,17}$/)
  taxId?: string | null;

  @ApiPropertyOptional({ enum: VendorCategoryName, enumName: 'VendorCategory', isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsEnum(VendorCategoryName, { each: true })
  categories?: VendorCategoryName[];

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  contactName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Length(6, 30)
  contactPhone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsEmail()
  contactEmail?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  bankName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  bankAccountName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Matches(/^\d{4}$/)
  bankAccountLast4?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({
    enum: VendorStateName,
    enumName: 'VendorState',
    description: '`blocked` needs `blockedReason` and stops new contracts, quotations and expense requests.',
  })
  @IsOptional()
  @IsEnum(VendorStateName)
  state?: VendorStateName;

  @ApiPropertyOptional({ example: 'ส่งงานล่าช้าซ้ำหลายครั้ง', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Length(3, 1000)
  blockedReason?: string;

  @ApiPropertyOptional({
    type: 'integer',
    example: 1,
    description: 'Optimistic concurrency (412 when stale).',
  })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class VendorListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: VendorStateName, enumName: 'VendorState' })
  @IsOptional()
  @IsEnum(VendorStateName)
  state?: VendorStateName;

  @ApiPropertyOptional({ enum: VendorCategoryName, enumName: 'VendorCategory' })
  @IsOptional()
  @IsEnum(VendorCategoryName)
  category?: VendorCategoryName;

  @ApiPropertyOptional({
    enum: VendorCategoryName,
    enumName: 'VendorCategory',
    isArray: true,
    example: ['lift', 'electrical'],
    description:
      'Vendors offering any of these categories (repeat the parameter or separate with commas; J-CR, D-335). Combined with `category` by AND.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((v) => String(v).split(','))
      .map((v) => v.trim())
      .filter(Boolean),
  )
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(VendorCategoryName, { each: true })
  categories?: VendorCategoryName[];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The vendor of this party (a vendor per party; J-CR, D-335).',
  })
  @IsOptional()
  @IsUUID()
  partyId?: string;
}

// ------------------------------------------------------------------------------------------- contracts

export class SlaTermDto {
  @ApiProperty({ enum: ServicePriorityName, enumName: 'ServicePriority', example: 'urgent' })
  @IsEnum(ServicePriorityName)
  priority!: ServicePriorityName;

  @ApiProperty({ type: 'integer', example: 2, minimum: 1, maximum: 8760, description: 'Hours to respond.' })
  @IsInt()
  @Min(1)
  @Max(8760)
  responseHours!: number;

  @ApiProperty({ type: 'integer', example: 24, minimum: 1, maximum: 8760, description: 'Hours to resolve.' })
  @IsInt()
  @Min(1)
  @Max(8760)
  resolveHours!: number;
}

export class InstalmentPlanDto {
  @ApiProperty({ enum: InstalmentFrequencyName, enumName: 'InstalmentFrequency', example: 'monthly' })
  @IsEnum(InstalmentFrequencyName)
  frequency!: InstalmentFrequencyName;

  @ApiProperty({ type: 'integer', example: 5, minimum: 1, maximum: 28, description: 'Due day of the month.' })
  @IsInt()
  @Min(1)
  @Max(28)
  dueDay!: number;

  @MoneyInput({ example: '16050.00', description: 'Each instalment incl. VAT.' })
  amount!: string;

  @MoneyInput({ example: '1050.00', description: 'VAT part of each instalment.', optional: true })
  vatAmount?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2027-01-05',
    description: 'First due date (default: the first due day on / after the contract start).',
  })
  @IsOptional()
  @Matches(DATE)
  firstDueOn?: string;
}

export class InstalmentPlanViewDto {
  @ApiProperty({ enum: InstalmentFrequencyName, enumName: 'InstalmentFrequency', example: 'monthly' })
  frequency!: InstalmentFrequencyName;

  @ApiProperty({ type: 'integer', example: 5 })
  dueDay!: number;

  @MoneyOutput({ example: '16050.00', description: 'Each instalment incl. VAT.' })
  amount!: string;

  @MoneyOutput({ example: '1050.00', description: 'VAT part of each instalment.' })
  vatAmount!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  firstDueOn!: string | null;
}

export class VendorContractCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  vendorId!: string;

  @ApiProperty({ example: 'สัญญาบำรุงรักษาลิฟต์ 2570', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional({
    example: 'ตรวจเช็กลิฟต์ 4 ตัว เดือนละครั้ง เปลี่ยนอะไหล่สิ้นเปลือง',
    maxLength: 8000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  scope?: string;

  @ApiPropertyOptional({ enum: VendorCategoryName, enumName: 'VendorCategory', example: 'lift' })
  @IsOptional()
  @IsEnum(VendorCategoryName)
  category?: VendorCategoryName;

  @ApiPropertyOptional({
    type: [SlaTermDto],
    maxItems: 4,
    description: 'Response / resolve hours per priority.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => SlaTermDto)
  slaTerms?: SlaTermDto[];

  @ApiProperty({ format: 'date', example: '2027-01-01' })
  @Matches(DATE)
  startsOn!: string;

  @ApiProperty({ format: 'date', example: '2027-12-31' })
  @Matches(DATE)
  endsOn!: string;

  @ApiPropertyOptional({ type: 'integer', example: 60, minimum: 0, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  renewalNoticeDays?: number;

  @MoneyInput({ example: '192600.00', description: 'Contract value incl. VAT.' })
  value!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Expense account the instalment requests post to.' })
  @IsOptional()
  @IsUUID()
  expenseAccountId?: string;

  @ApiPropertyOptional({ example: 'service', description: 'WHT key of `juristic.wht_rates` (⚖ O-041).' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  whtKey?: string;

  @ApiPropertyOptional({ type: InstalmentPlanDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => InstalmentPlanDto)
  instalmentPlan?: InstalmentPlanDto;

  @ApiPropertyOptional({ example: 'ปรับวันละ 500 บาท หากไม่เข้าซ่อมภายในเวลาที่กำหนด', maxLength: 8000 })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  penaltyClauses?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The quotation round awarded to the vendor.' })
  @IsOptional()
  @IsUUID()
  quotationRoundId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'An adopted resolution of the building.' })
  @IsOptional()
  @IsUUID()
  resolutionId?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class VendorContractUpdateDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8000 })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  scope?: string | null;

  @ApiPropertyOptional({ enum: VendorCategoryName, enumName: 'VendorCategory', nullable: true })
  @IsOptional()
  @IsEnum(VendorCategoryName)
  category?: VendorCategoryName | null;

  @ApiPropertyOptional({ type: [SlaTermDto], maxItems: 4 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => SlaTermDto)
  slaTerms?: SlaTermDto[];

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @Matches(DATE)
  startsOn?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @Matches(DATE)
  endsOn?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  renewalNoticeDays?: number;

  @MoneyInput({ example: '192600.00', description: 'Contract value incl. VAT.', optional: true })
  value?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  expenseAccountId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  whtKey?: string | null;

  @ApiPropertyOptional({ type: InstalmentPlanDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => InstalmentPlanDto)
  instalmentPlan?: InstalmentPlanDto | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8000 })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  penaltyClauses?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  quotationRoundId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  resolutionId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({
    type: 'integer',
    example: 1,
    description: 'Optimistic concurrency (412 when stale).',
  })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class VendorContractListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ enum: VendorContractStateName, enumName: 'VendorContractState' })
  @IsOptional()
  @IsEnum(VendorContractStateName)
  state?: VendorContractStateName;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: 365,
    description: 'Active contracts ending within this many days.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  endingWithinDays?: number;
}

export class VendorContractDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  vendorId!: string;

  @ApiProperty({ example: 'บริษัท ลิฟต์ไทย เซอร์วิส จำกัด' })
  vendorName!: string;

  @ApiProperty({ example: 'สัญญาบำรุงรักษาลิฟต์ 2570' })
  title!: string;

  @ApiProperty({ enum: VendorCategoryName, enumName: 'VendorCategory', nullable: true, example: 'lift' })
  category!: VendorCategoryName | null;

  @ApiProperty({ format: 'date', example: '2027-01-01' })
  startsOn!: string;

  @ApiProperty({ format: 'date', example: '2027-12-31' })
  endsOn!: string;

  @ApiProperty({ type: 'integer', example: 60 })
  renewalNoticeDays!: number;

  @ApiProperty({
    format: 'date',
    example: '2027-11-01',
    description: 'Last day to give notice (end − notice days).',
  })
  noticeBy!: string;

  @ApiProperty({
    type: 'integer',
    example: 120,
    description: 'Days until the end (Bangkok); negative after it.',
  })
  daysLeft!: number;

  @MoneyOutput({ example: '192600.00', description: 'Contract value incl. VAT.' })
  value!: string;

  @ApiProperty({ enum: VendorContractStateName, enumName: 'VendorContractState', example: 'active' })
  state!: VendorContractStateName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  renewsContractId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Its renewal draft.',
  })
  renewalId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;
}

export class ContractInstalmentDto {
  @ApiProperty({ type: 'integer', example: 1 })
  seq!: number;

  @ApiProperty({ format: 'date', example: '2027-01-05' })
  dueOn!: string;

  @MoneyOutput({ example: '16050.00', description: 'Incl. VAT.' })
  amount!: string;

  @MoneyOutput({ example: '1050.00', description: 'VAT part.' })
  vatAmount!: string;

  @ApiProperty({ example: 'สัญญาบำรุงรักษาลิฟต์ 2570 งวดที่ 1/12' })
  description!: string;

  @ApiProperty({
    enum: ContractInstalmentStateName,
    enumName: 'ContractInstalmentState',
    example: 'requested',
  })
  state!: ContractInstalmentStateName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  expenseRequestId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'EXP-2027-00001' })
  expenseRequestNumber!: string | null;

  @ApiProperty({ enum: ExpenseStateName, enumName: 'ExpenseState', nullable: true, example: 'submitted' })
  expenseRequestState!: ExpenseStateName | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  requestedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;
}

export class ContractDocumentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  documentId!: string;

  @ApiProperty({ enum: ContractDocumentKindName, enumName: 'ContractDocumentKind', example: 'contract' })
  kind!: ContractDocumentKindName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ContractDocumentAttachDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'An uploaded document of the tenant.' })
  @IsUUID()
  documentId!: string;

  @ApiProperty({ enum: ContractDocumentKindName, enumName: 'ContractDocumentKind', example: 'contract' })
  @IsEnum(ContractDocumentKindName)
  kind!: ContractDocumentKindName;
}

export class ContractPlanDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'ตรวจเช็กลิฟต์ประจำเดือน' })
  title!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  assetItemId!: string;

  @ApiProperty({ example: 'ลิฟต์โดยสาร L1' })
  assetItemName!: string;

  @ApiProperty({ type: 'integer', example: 30 })
  intervalDays!: number;

  @ApiProperty({ format: 'date', example: '2027-02-01' })
  nextDueOn!: string;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  lastWorkOrderId!: string | null;

  @ApiProperty({ enum: WorkOrderStatusName, enumName: 'WorkOrderStatus', nullable: true, example: null })
  lastWorkOrderStatus!: WorkOrderStatusName | null;
}

export class ContractExpenseRefDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'EXP-2027-00001' })
  number!: string | null;

  @ApiProperty({ enum: ExpenseStateName, enumName: 'ExpenseState', example: 'submitted' })
  state!: ExpenseStateName;

  @MoneyOutput({ example: '16050.00', description: 'Amount of the request.' })
  amount!: string;
}

export class ContractAlertDto {
  @ApiProperty({ type: 'integer', example: 90 })
  daysBefore!: number;

  @ApiProperty({ format: 'date', example: '2027-12-31' })
  endsOn!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  sentAt!: string;
}

export class SlaBreachDto {
  @ApiProperty({ enum: SlaBreachKindName, enumName: 'SlaBreachKind', example: 'response' })
  kind!: SlaBreachKindName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  workOrderId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  serviceRequestId!: string | null;

  @ApiProperty({ example: 'ลิฟต์ L2 ค้าง' })
  title!: string;

  @ApiProperty({ enum: ServicePriorityName, enumName: 'ServicePriority', example: 'urgent' })
  priority!: ServicePriorityName;

  @ApiProperty({ type: 'integer', nullable: true, example: 2, description: 'Hours the contract allows.' })
  allowedHours!: number | null;

  @ApiProperty({ type: 'number', nullable: true, example: 5.5, description: 'Hours it took (or has taken).' })
  actualHours!: number | null;
}

export class SlaMonthDto {
  @ApiProperty({ example: '2027-03' })
  month!: string;

  @ApiProperty({ type: 'integer', example: 6, description: 'Work orders of the vendor in the month.' })
  workOrders!: number;

  @ApiProperty({ type: [SlaBreachDto] })
  breaches!: SlaBreachDto[];
}

export class SlaMonthQuery {
  @ApiProperty({ example: '2027-03', description: 'YYYY-MM (Bangkok), within the contract term.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month!: string;
}

export class EvaluationScoreDto {
  @ApiProperty({ example: 'quality' })
  criterion!: string;

  @ApiProperty({ example: 'คุณภาพงาน' })
  labelTh!: string;

  @ApiProperty({ example: 'Quality of work' })
  labelEn!: string;

  @ApiProperty({ type: 'integer', example: 4, minimum: 1, maximum: 5 })
  score!: number;
}

export class VendorEvaluationDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  contractId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  vendorId!: string;

  @ApiProperty({ example: '2027-03' })
  month!: string;

  @ApiProperty({ type: [EvaluationScoreDto] })
  scores!: EvaluationScoreDto[];

  @ApiProperty({ example: '3.75', description: 'Average of the scores (2 decimals).' })
  score!: string;

  @ApiProperty({ type: 'integer', example: 0 })
  incidents!: number;

  @ApiProperty({ type: String, nullable: true, example: null })
  incidentNote!: string | null;

  @ApiProperty({ type: 'integer', example: 1, description: 'Pulled from the vendor’s work orders (D-310).' })
  slaBreaches!: number;

  @ApiProperty({ type: [SlaBreachDto] })
  slaItems!: SlaBreachDto[];

  @ApiProperty({ type: 'integer', example: 6 })
  workOrders!: number;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  evaluatedBy!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class VendorEvaluationListDto {
  @ApiProperty({ type: [VendorEvaluationDto] })
  data!: VendorEvaluationDto[];
}

export class EvaluationScoreInputDto {
  @ApiProperty({ example: 'quality', description: 'A key of `juristic.vendor_evaluation_criteria`.' })
  @IsString()
  @Length(2, 41)
  criterion!: string;

  @ApiProperty({ type: 'integer', example: 4, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;
}

export class VendorEvaluationCreateDto {
  @ApiProperty({ example: '2027-03', description: 'YYYY-MM, within the term, not in the future.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month!: string;

  @ApiProperty({
    type: [EvaluationScoreInputDto],
    minItems: 1,
    maxItems: 12,
    description: 'Every criterion once.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => EvaluationScoreInputDto)
  scores!: EvaluationScoreInputDto[];

  @ApiPropertyOptional({ type: 'integer', example: 0, minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  incidents?: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  incidentNote?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class EvaluationSummaryDto {
  @ApiProperty({ type: 'integer', example: 6, description: 'Evaluations counted (the last 6).' })
  count!: number;

  @ApiProperty({ type: String, nullable: true, example: '3.92' })
  averageScore!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '4.25' })
  lastScore!: string | null;

  @ApiProperty({
    enum: EvaluationTrendName,
    enumName: 'EvaluationTrend',
    nullable: true,
    example: 'improving',
    description: 'Last score vs the average before it (±0.25); null with fewer than 2.',
  })
  trend!: EvaluationTrendName | null;

  @ApiProperty({ type: 'integer', example: 3, description: 'SLA breaches over those evaluations.' })
  slaBreaches!: number;
}

export class VendorContractDetailDto extends VendorContractDto {
  @ApiProperty({ type: String, nullable: true, example: 'ตรวจเช็กลิฟต์ 4 ตัว เดือนละครั้ง' })
  scope!: string | null;

  @ApiProperty({ type: [SlaTermDto] })
  slaTerms!: SlaTermDto[];

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  expenseAccountId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '5300' })
  expenseAccountCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'service' })
  whtKey!: string | null;

  @ApiProperty({ type: InstalmentPlanViewDto, nullable: true })
  instalmentPlan!: InstalmentPlanViewDto | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  penaltyClauses!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  quotationRoundId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  resolutionId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  activatedAt!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  terminatedOn!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  terminationReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  expiredAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ type: [ContractInstalmentDto] })
  instalments!: ContractInstalmentDto[];

  @MoneyOutput({ example: '192600.00', description: 'Σ instalments not cancelled.' })
  instalmentsTotal!: string;

  @ApiProperty({ type: [ContractDocumentDto] })
  documents!: ContractDocumentDto[];

  @ApiProperty({ type: [VendorEvaluationDto], description: 'Monthly evaluations, oldest first.' })
  evaluations!: VendorEvaluationDto[];

  @ApiProperty({
    type: EvaluationSummaryDto,
    description: 'Trend over the last 6 — for the renewal decision.',
  })
  evaluationSummary!: EvaluationSummaryDto;

  @ApiProperty({
    type: [ContractPlanDto],
    description: 'Preventive maintenance plans run under the contract.',
  })
  maintenancePlans!: ContractPlanDto[];

  @ApiProperty({
    type: [ContractExpenseRefDto],
    description: 'Expense requests of the contract (newest 50).',
  })
  expenseRequests!: ContractExpenseRefDto[];

  @ApiProperty({ type: [ContractAlertDto] })
  alerts!: ContractAlertDto[];

  @ApiProperty({
    type: [String],
    example: ['renew', 'terminate', 'attach', 'evaluate'],
    description: 'edit · activate · renew · terminate · attach · evaluate — for the caller.',
  })
  nextActions!: string[];
}

export class VendorContractRenewDto {
  @ApiPropertyOptional({ format: 'date', description: 'Default: the day after the current end.' })
  @IsOptional()
  @Matches(DATE)
  startsOn?: string;

  @ApiProperty({ format: 'date', example: '2028-12-31' })
  @Matches(DATE)
  endsOn!: string;

  @MoneyInput({ example: '198000.00', description: 'New value (default: unchanged).', optional: true })
  value?: string;

  @ApiPropertyOptional({ type: InstalmentPlanDto, nullable: true, description: 'Default: the current plan.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => InstalmentPlanDto)
  instalmentPlan?: InstalmentPlanDto | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'An adopted resolution to renew the same vendor — lets a renewal above the threshold activate without a new quotation round.',
  })
  @IsOptional()
  @IsUUID()
  resolutionId?: string;
}

export class VendorContractTerminateDto {
  @ApiProperty({ example: 'ผู้รับจ้างผิดสัญญา ไม่เข้าซ่อมตามเวลาที่กำหนด', minLength: 3, maxLength: 1000 })
  @IsString()
  @Length(3, 1000)
  reason!: string;

  @ApiPropertyOptional({ format: 'date', description: 'Today (default) … the contract end.' })
  @IsOptional()
  @Matches(DATE)
  effectiveOn?: string;
}

// ------------------------------------------------------------------------------------------- quotations

export class QuotationDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  vendorId!: string;

  @ApiProperty({ example: 'บริษัท ลิฟต์ไทย เซอร์วิส จำกัด' })
  vendorName!: string;

  @MoneyOutput({ example: '192600.00', description: 'Quoted amount incl. VAT.' })
  amount!: string;

  @MoneyOutput({ example: '12600.00', description: 'VAT part.' })
  vatAmount!: string;

  @ApiProperty({ format: 'date', example: '2027-02-28' })
  validUntil!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  documentId!: string;

  @ApiProperty({ format: 'date', example: '2026-12-10' })
  receivedOn!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;
}

export class QuotationRoundDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ example: 'จ้างบำรุงรักษาลิฟต์ 2570' })
  title!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  description!: string | null;

  @ApiProperty({ enum: VendorCategoryName, enumName: 'VendorCategory', nullable: true, example: 'lift' })
  category!: VendorCategoryName | null;

  @MoneyOutput({ example: '200000.00', description: 'Estimate.', nullable: true })
  estimatedAmount!: string | null;

  @ApiProperty({
    enum: QuotationRoundStateName,
    enumName: 'QuotationRoundState',
    example: 'awaiting_approval',
  })
  state!: QuotationRoundStateName;

  @ApiProperty({ type: [QuotationDto], description: 'Cheapest first.' })
  quotations!: QuotationDto[];

  @MoneyOutput({ example: '50000.00', description: 'Threshold of `juristic.quotation_threshold` today.' })
  threshold!: string;

  @ApiProperty({
    example: 3,
    type: 'integer',
    description: 'Quotations needed above the threshold (fewer only with a recorded reason, D-310).',
  })
  minimumQuotations!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  awardedQuotationId!: string | null;

  @ApiProperty({ enum: AwardOutcomeName, enumName: 'AwardOutcome', nullable: true, example: 'contract' })
  outcome!: AwardOutcomeName | null;

  @ApiProperty({ enum: AwardBasisName, enumName: 'AwardBasis', nullable: true, example: 'approval' })
  basis!: AwardBasisName | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  resolutionId!: string | null;

  @ApiProperty({ type: Boolean, nullable: true, example: true, description: 'At the award.' })
  aboveThreshold!: boolean | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  fewerQuotationsReason!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  approvalsRequired!: number | null;

  @ApiProperty({ enum: ApproverRoleName, enumName: 'ExpenseApproverRole', isArray: true, example: ['owner'] })
  approverRoles!: ApproverRoleName[];

  @ApiProperty({ type: 'integer', example: 1, description: 'Approvals given to the current award request.' })
  approvalsGiven!: number;

  @ApiProperty({ type: [ExpenseApprovalDto], description: 'Every decision (all award requests).' })
  approvals!: ExpenseApprovalDto[];

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  awardRequestedBy!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  awardRequestedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  awardedAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  outcomeContractId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  outcomeExpenseRequestId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancelReason!: string | null;

  @ApiProperty({
    type: [String],
    example: ['approve', 'reject', 'cancel'],
    description: 'add_quotation · award · approve · reject · cancel — for the caller.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: 'integer', example: 3 })
  version!: number;
}

export class QuotationRoundCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ example: 'จ้างบำรุงรักษาลิฟต์ 2570', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ enum: VendorCategoryName, enumName: 'VendorCategory' })
  @IsOptional()
  @IsEnum(VendorCategoryName)
  category?: VendorCategoryName;

  @MoneyInput({ example: '200000.00', description: 'Estimate (optional).', optional: true })
  estimatedAmount?: string;
}

export class QuotationCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  vendorId!: string;

  @MoneyInput({ example: '192600.00', description: 'Quoted amount incl. VAT.' })
  amount!: string;

  @MoneyInput({ example: '12600.00', description: 'VAT part.', optional: true })
  vatAmount?: string;

  @ApiProperty({ format: 'date', example: '2027-02-28' })
  @Matches(DATE)
  validUntil!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The quotation document (required).' })
  @IsUUID()
  documentId!: string;

  @ApiPropertyOptional({ format: 'date', description: 'Default today; never in the future.' })
  @IsOptional()
  @Matches(DATE)
  receivedOn?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class QuotationAwardDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'A quotation of the round, still valid.' })
  @IsUUID()
  quotationId!: string;

  @ApiProperty({ enum: AwardOutcomeName, enumName: 'AwardOutcome', example: 'contract' })
  @IsEnum(AwardOutcomeName)
  outcome!: AwardOutcomeName;

  @ApiProperty({ enum: AwardBasisName, enumName: 'AwardBasis', example: 'approval' })
  @IsEnum(AwardBasisName)
  basis!: AwardBasisName;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'basis `resolution`: an adopted resolution of the building.',
  })
  @IsOptional()
  @IsUUID()
  resolutionId?: string;

  @ApiPropertyOptional({
    example: 'มีผู้ให้บริการลิฟต์ยี่ห้อนี้ในพื้นที่เพียง 2 ราย',
    minLength: 10,
    maxLength: 1000,
    description: 'Required above the threshold with fewer than 3 quotations (D-310).',
  })
  @IsOptional()
  @IsString()
  @Length(10, 1000)
  fewerQuotationsReason?: string;

  @ApiPropertyOptional({ format: 'date', description: 'outcome `contract`: start of the contract draft.' })
  @IsOptional()
  @Matches(DATE)
  startsOn?: string;

  @ApiPropertyOptional({ format: 'date', description: 'outcome `contract`: end of the contract draft.' })
  @IsOptional()
  @Matches(DATE)
  endsOn?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'outcome `expense`: the expense account.' })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({ example: 'service', description: 'outcome `expense`: WHT key.' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  whtKey?: string;
}

export class QuotationRoundListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: QuotationRoundStateName, enumName: 'QuotationRoundState' })
  @IsOptional()
  @IsEnum(QuotationRoundStateName)
  state?: QuotationRoundStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'true = awards waiting for my role that I did not ask for.',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  awaitingMe?: boolean;
}

/** Vendors per state for the list's tab badges (J-CR, D-335). */
export class VendorCountsDto {
  @ApiProperty({ type: 'integer', example: 14 }) all!: number;
  @ApiProperty({ type: 'integer', example: 13 }) active!: number;
  @ApiProperty({ type: 'integer', example: 1 }) blocked!: number;
}

/** Contracts per state and the renewal queue for the list's tab badges (J-CR, D-335). */
export class VendorContractCountsDto {
  @ApiProperty({ type: 'integer', example: 9 }) all!: number;
  @ApiProperty({ type: 'integer', example: 1 }) draft!: number;
  @ApiProperty({ type: 'integer', example: 6 }) active!: number;
  @ApiProperty({ type: 'integer', example: 1 }) expired!: number;
  @ApiProperty({ type: 'integer', example: 1 }) terminated!: number;
  @ApiProperty({
    type: 'integer',
    example: 2,
    description: 'Active contracts ending within `endingWithinDays`.',
  })
  endingSoon!: number;
  @ApiProperty({
    type: 'integer',
    example: 90,
    description:
      'The query’s `endingWithinDays`, else the largest threshold of `juristic.contract_expiry_alert_days`.',
  })
  endingWithinDays!: number;
}

/** Quotation rounds per state and the awards awaiting me for the list's tab badges (J-CR, D-335). */
export class QuotationRoundCountsDto {
  @ApiProperty({ type: 'integer', example: 7 }) all!: number;
  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'Awards my role may approve that I did not ask for.',
  })
  awaitingMe!: number;
  @ApiProperty({ type: 'integer', example: 2 }) open!: number;
  @ApiProperty({ type: 'integer', example: 1 }) awaitingApproval!: number;
  @ApiProperty({ type: 'integer', example: 3 }) awarded!: number;
  @ApiProperty({ type: 'integer', example: 1 }) cancelled!: number;
}

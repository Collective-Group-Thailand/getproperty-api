import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
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
} from 'class-validator';

import { MoneyInput, MoneyOutput } from '../shared/fields';

/** J3.3 PM company portfolio: management contracts, portfolio KPIs, staff board (D-150 C3, D-334). */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export enum ManagementContractStateName {
  Draft = 'draft',
  Offered = 'offered',
  Active = 'active',
  Declined = 'declined',
  Cancelled = 'cancelled',
  Ended = 'ended',
  Terminated = 'terminated',
}
export enum ManagementFeePeriodName {
  Monthly = 'monthly',
  Quarterly = 'quarterly',
  Annual = 'annual',
}
export enum PmAssignmentRoleName {
  BuildingManager = 'building_manager',
  AssistantManager = 'assistant_manager',
  Accountant = 'accountant',
  Technician = 'technician',
  AdminOfficer = 'admin_officer',
  SecuritySupervisor = 'security_supervisor',
  Other = 'other',
}
export enum ContractPartySide {
  Juristic = 'juristic',
  Pm = 'pm',
}

// ------------------------------------------------------------------------------------------- requests

export class ManagementContractListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ManagementContractStateName, enumName: 'ManagementContractState' })
  @IsOptional()
  @IsEnum(ManagementContractStateName)
  state?: ManagementContractStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The other party: the PM company (juristic side) or the juristic tenant (PM side).',
  })
  @IsOptional()
  @IsUUID()
  counterpartTenantId?: string;
}

export class ManagementContractCreateDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.buildingId,
    description: 'A building of this juristic tenant.',
  })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.tenantId,
    description: 'The PM company’s getproperty tenant (`pm_company`, shown in its company profile).',
  })
  @IsUUID()
  pmTenantId!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description:
      'The PM company registered as a vendor of this juristic tenant (payee of the fee, its tax id on the 50 ทวิ).',
  })
  @IsUUID()
  vendorId!: string;

  @ApiProperty({ example: 'สัญญาจ้างบริหารจัดการอาคาร 2570', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 8000,
    example: 'บริหารงานนิติบุคคล บัญชี จัดเก็บ ดูแลอาคาร',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  scope?: string | null;

  @MoneyInput({ example: '85600.00', description: 'Fee per billing period, VAT included.' })
  fee!: string;

  @MoneyInput({
    example: '5600.00',
    description: 'VAT part of the fee (default 0).',
    optional: true,
    nullable: true,
  })
  vatAmount?: string | null;

  @ApiPropertyOptional({
    enum: ManagementFeePeriodName,
    enumName: 'ManagementFeePeriod',
    default: ManagementFeePeriodName.Monthly,
  })
  @IsOptional()
  @IsEnum(ManagementFeePeriodName)
  feePeriod?: ManagementFeePeriodName;

  @ApiPropertyOptional({
    example: 5,
    minimum: 1,
    maximum: 28,
    default: 5,
    description: 'Day of the month after each period on which the fee is due (in arrears).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  dueDay?: number;

  @ApiProperty({
    format: 'date',
    example: '2027-01-01',
    description: 'First day of service (not in the past when offered).',
  })
  @Matches(DATE)
  startsOn!: string;

  @ApiProperty({ format: 'date', example: '2027-12-31', description: 'Last day of service.' })
  @Matches(DATE)
  endsOn!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Active expense account the fee posts to (required to offer).',
  })
  @IsOptional()
  @IsUUID()
  expenseAccountId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'services',
    description: 'A key of `juristic.wht_rates`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  whtKey?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Adopted resolution of the building that appoints the manager (required to offer).',
  })
  @IsOptional()
  @IsUUID()
  resolutionId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Signed contract document.',
  })
  @IsOptional()
  @IsUUID()
  documentId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

export class ManagementContractUpdateDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() pmTenantId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() vendorId?: string;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @Length(1, 200) title?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 8000 })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  scope?: string | null;
  @MoneyInput({ example: '85600.00', description: 'Fee per period, VAT included.', optional: true })
  fee?: string;
  @MoneyInput({ example: '5600.00', description: 'VAT part of the fee.', optional: true, nullable: true })
  vatAmount?: string | null;
  @ApiPropertyOptional({ enum: ManagementFeePeriodName, enumName: 'ManagementFeePeriod' })
  @IsOptional()
  @IsEnum(ManagementFeePeriodName)
  feePeriod?: ManagementFeePeriodName;
  @ApiPropertyOptional({ minimum: 1, maximum: 28 }) @IsOptional() @IsInt() @Min(1) @Max(28) dueDay?: number;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(DATE) startsOn?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(DATE) endsOn?: string;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  expenseAccountId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(50) whtKey?:
    string | null;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  resolutionId?: string | null;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  documentId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
  @ApiPropertyOptional({ example: 1, description: 'Optimistic concurrency: the version read.' })
  @IsOptional()
  @IsInt()
  version?: number;
}

/** Same shape as a vendor contract termination (one schema in the contract). */
export { VendorContractTerminateDto as ManagementContractTerminateDto } from './juristic-vendors.dto';
/** Same shape as the import rollback body: a reason of 5–1000 characters. */
export { JuristicImportRollbackDto as ManagementContractReasonDto } from './juristic-imports.dto';

export class PmStaffAssignmentListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() buildingId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional({ type: Boolean, description: 'Only assignments in force today.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  current?: boolean;
}

export class PmStaffAssignmentCreateDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'An active management contract of this PM company.',
  })
  @IsUUID()
  contractId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'An active member of this PM company.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    enum: PmAssignmentRoleName,
    enumName: 'PmAssignmentRole',
    example: PmAssignmentRoleName.BuildingManager,
  })
  @IsEnum(PmAssignmentRoleName)
  role!: PmAssignmentRoleName;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100, example: 'จ.–ศ. 08:00–17:00' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  shift?: string | null;

  @ApiPropertyOptional({ format: 'date', description: 'Default today (or the contract start when later).' })
  @IsOptional()
  @Matches(DATE)
  startsOn?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    description: 'First day no longer assigned (exclusive); open-ended assignments stop with the contract.',
  })
  @IsOptional()
  @Matches(DATE)
  endsOn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class PmStaffAssignmentEndDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    description: 'First day no longer assigned (exclusive); default today.',
  })
  @IsOptional()
  @Matches(DATE)
  endsOn?: string | null;
}

// ------------------------------------------------------------------------------------------- responses

export class ManagementContractAccessDto {
  @ApiProperty({ example: true, description: 'The PM company’s read grant on the building is in force now.' })
  active!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime }) validFrom!:
    string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime }) validTo!:
    string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null }) revokedAt!:
    string | null;
}

export class ManagementContractDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) id!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId }) juristicTenantId!: string;
  @ApiProperty({ example: 'นิติบุคคลอาคารชุด ตัวอย่าง' }) juristicName!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId }) pmTenantId!: string;
  @ApiProperty({ example: 'บริษัท บริหารทรัพย์สิน ตัวอย่าง จำกัด' }) pmName!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId }) buildingId!: string;
  @ApiProperty({ example: 'อาคาร A' }) buildingName!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Juristic side only (null for the PM): the vendor record of the PM company.',
  })
  vendorId!: string | null;
  @ApiProperty({ example: 'สัญญาจ้างบริหารจัดการอาคาร 2570' }) title!: string;
  @ApiProperty({ type: String, nullable: true, example: null }) scope!: string | null;
  @MoneyOutput({ example: '85600.00', description: 'Fee per period, VAT included.' }) fee!: string;
  @MoneyOutput({ example: '5600.00', description: 'VAT part of the fee.' }) vatAmount!: string;
  @ApiProperty({ enum: ManagementFeePeriodName, enumName: 'ManagementFeePeriod', example: 'monthly' })
  feePeriod!: ManagementFeePeriodName;
  @ApiProperty({ example: 5 }) dueDay!: number;
  @ApiProperty({ format: 'date', example: '2027-01-01' }) startsOn!: string;
  @ApiProperty({ format: 'date', example: '2027-12-31' }) endsOn!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Juristic side only.',
  })
  expenseAccountId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'services', description: 'Juristic side only.' })
  whtKey!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'Juristic side only.',
  })
  resolutionId!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Juristic side only.',
  })
  documentId!: string | null;
  @ApiProperty({ enum: ManagementContractStateName, enumName: 'ManagementContractState', example: 'active' })
  state!: ManagementContractStateName;
  @ApiProperty({ type: ManagementContractAccessDto }) access!: ManagementContractAccessDto;
  @ApiProperty({ example: 2, description: 'Periods whose fee was requested.' }) feesRequested!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime }) offeredAt!:
    string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime }) acceptedAt!:
    string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null }) declinedAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true, example: null }) declineReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null }) cancelledAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true, example: null }) cancelReason!: string | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: null,
    description: 'First day without service after a termination.',
  })
  terminatedOn!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null }) terminatedAt!:
    string | null;
  @ApiProperty({ enum: ContractPartySide, enumName: 'ContractPartySide', nullable: true, example: null })
  terminatedBy!: ContractPartySide | null;
  @ApiProperty({ type: String, nullable: true, example: null }) terminationReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null }) endedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, example: null }) note!: string | null;
  @ApiProperty({ type: [String], example: ['terminate'], description: 'What the caller may do now.' })
  nextActions!: string[];
  @ApiProperty({ format: 'date-time', example: FAKE.dateTime }) createdAt!: string;
  @ApiProperty({ example: 3 }) version!: number;
}

export class ManagementFeeExpenseRefDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) id!: string;
  @ApiProperty({ type: String, nullable: true, example: 'EXP-2027-000012' }) number!: string | null;
  @ApiProperty({ example: 'submitted', description: 'State of the expense request (J2.1).' }) state!: string;
}

export class ManagementFeeChargeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) id!: string;
  @ApiProperty({ example: '2027-01', description: '`YYYY-MM`, `YYYY-Qn` or `YYYY`.' }) periodKey!: string;
  @ApiProperty({ format: 'date', example: '2027-01-01' }) periodStart!: string;
  @ApiProperty({ format: 'date', example: '2027-01-31' }) periodEnd!: string;
  @ApiProperty({ example: 31 }) serviceDays!: number;
  @ApiProperty({ example: 31 }) periodDays!: number;
  @MoneyOutput({ example: '85600.00', description: 'Fee requested (prorated by days of service).' })
  amount!: string;
  @MoneyOutput({ example: '5600.00', description: 'VAT part.' }) vatAmount!: string;
  @ApiProperty({ format: 'date', example: '2027-02-05' }) dueOn!: string;
  @ApiProperty({ format: 'date-time', example: FAKE.dateTime }) requestedAt!: string;
  @ApiProperty({
    type: ManagementFeeExpenseRefDto,
    nullable: true,
    description: 'Juristic side only: the expense request (approval and payment follow J2.1).',
  })
  expenseRequest!: ManagementFeeExpenseRefDto | null;
}

export class PmStaffAssignmentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) id!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) contractId!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId }) buildingId!: string;
  @ApiProperty({ example: 'อาคาร A' }) buildingName!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) userId!: string;
  @ApiProperty({ example: 'สมชาย ใจดี' }) displayName!: string;
  @ApiProperty({ enum: PmAssignmentRoleName, enumName: 'PmAssignmentRole', example: 'building_manager' })
  role!: PmAssignmentRoleName;
  @ApiProperty({ type: String, nullable: true, example: 'จ.–ศ. 08:00–17:00' }) shift!: string | null;
  @ApiProperty({ format: 'date', example: '2027-01-01' }) startsOn!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: null, description: 'Exclusive.' })
  endsOn!: string | null;
  @ApiProperty({ type: String, nullable: true, example: null }) note!: string | null;
  @ApiProperty({ format: 'date-time', example: FAKE.dateTime }) createdAt!: string;
  @ApiProperty({ example: 1 }) version!: number;
}

export class PmPortfolioExpiringContractDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) vendorContractId!: string;
  @ApiProperty({ example: 'สัญญาบำรุงรักษาลิฟต์' }) title!: string;
  @ApiProperty({ example: 'บริษัท ลิฟต์ไทย จำกัด' }) vendorName!: string;
  @ApiProperty({ format: 'date', example: '2027-03-31' }) endsOn!: string;
  @ApiProperty({ example: 45 }) daysLeft!: number;
}

export class PmPortfolioLastCycleDto {
  @ApiProperty({ example: '2026-12' }) periodKey!: string;
  @MoneyOutput({ example: '312000.00', description: 'Billed in the cycle, net of credit notes.' })
  billed!: string;
  @ApiProperty({ type: String, nullable: true, example: '91.20' }) collectionRatePct!: string | null;
}

export class PmPortfolioCollectionDto {
  @ApiProperty({ format: 'date', example: '2026-01-02' }) from!: string;
  @ApiProperty({ format: 'date', example: '2027-01-02' }) to!: string;
  @MoneyOutput({
    example: '3744000.00',
    description: 'Billed in the range (cycles starting in it), net of credit notes.',
  })
  billed!: string;
  @MoneyOutput({ example: '3519360.00', description: 'Collected on those invoices.' }) collected!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '94.00',
    description: 'Percent, 2 dp (null: nothing billed).',
  })
  collectionRatePct!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '88.50',
    description: 'Collected within `kpiDays` of each due date.',
  })
  withinDaysRatePct!: string | null;
  @ApiProperty({ example: 30 }) kpiDays!: number;
  @ApiProperty({
    type: PmPortfolioLastCycleDto,
    nullable: true,
    description: 'The latest billing cycle.',
  })
  lastCycle!: { periodKey: string; billed: string; collectionRatePct: string | null } | null;
}

export class PmPortfolioArrearsDto {
  @MoneyOutput({ example: '224640.00', description: 'Overdue now.' }) overdueAmount!: string;
  @ApiProperty({ example: 41 }) overdueInvoices!: number;
  @ApiProperty({ example: 18, description: 'Billed party × unit accounts overdue.' })
  overdueAccounts!: number;
  @MoneyOutput({ example: '96000.00', description: 'Overdue more than 90 days.' }) over90Amount!: string;
}

export class PmPortfolioBudgetDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) budgetId!: string;
  @ApiProperty({ example: 2027 }) fiscalYear!: number;
  @MoneyOutput({ example: '3200000.00', description: 'Budgeted expense + fund lines.' })
  budgetedExpense!: string;
  @MoneyOutput({ example: '1180000.00', description: 'Actual on those accounts so far.' })
  actualExpense!: string;
  @ApiProperty({ type: String, nullable: true, example: '36.88' }) usedPct!: string | null;
}

export class PmPortfolioWorkDto {
  @ApiProperty({ example: 7 }) openRequests!: number;
  @ApiProperty({ example: 2, description: 'Open requests past their SLA hours.' })
  slaBreachedRequests!: number;
  @ApiProperty({ example: 5 }) openWorkOrders!: number;
}

export class PmPortfolioExpiringDto {
  @ApiProperty({ example: 90, description: '`pm.portfolio_expiring_days`.' }) withinDays!: number;
  @ApiProperty({ example: 1 }) vendorContracts!: number;
  @ApiProperty({ type: [PmPortfolioExpiringContractDto] }) items!: PmPortfolioExpiringContractDto[];
}

export class PmPortfolioKpisDto {
  @ApiProperty({ example: 312 }) units!: number;
  @ApiProperty({ type: PmPortfolioCollectionDto }) collection!: PmPortfolioCollectionDto;
  @ApiProperty({ type: PmPortfolioArrearsDto }) arrears!: PmPortfolioArrearsDto;
  @ApiProperty({ type: PmPortfolioBudgetDto, nullable: true, description: 'Approved budget in force today.' })
  budget!: PmPortfolioBudgetDto | null;
  @ApiProperty({ type: PmPortfolioWorkDto }) work!: PmPortfolioWorkDto;
  @ApiProperty({ type: PmPortfolioExpiringDto }) expiring!: PmPortfolioExpiringDto;
}

export class PmPortfolioStaffDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) userId!: string;
  @ApiProperty({ example: 'สมชาย ใจดี' }) displayName!: string;
  @ApiProperty({ enum: PmAssignmentRoleName, enumName: 'PmAssignmentRole', example: 'building_manager' })
  role!: PmAssignmentRoleName;
  @ApiProperty({ type: String, nullable: true, example: 'จ.–ศ. 08:00–17:00' }) shift!: string | null;
}

export class PmPortfolioContractSummaryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) id!: string;
  @MoneyOutput({ example: '85600.00', description: 'Fee per period, VAT included.' }) fee!: string;
  @ApiProperty({ enum: ManagementFeePeriodName, enumName: 'ManagementFeePeriod', example: 'monthly' })
  feePeriod!: ManagementFeePeriodName;
  @ApiProperty({ format: 'date', example: '2027-01-01' }) startsOn!: string;
  @ApiProperty({ format: 'date', example: '2027-12-31' }) endsOn!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: null }) terminatedOn!: string | null;
  @ApiProperty({ example: 363, description: 'Days until the last day of service.' }) daysLeft!: number;
}

export class PmPortfolioBuildingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId }) buildingId!: string;
  @ApiProperty({ example: 'อาคาร A' }) buildingName!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId }) juristicTenantId!: string;
  @ApiProperty({ example: 'นิติบุคคลอาคารชุด ตัวอย่าง' }) juristicName!: string;
  @ApiProperty({ type: String, nullable: true, example: 'condo_act' }) legalForm!: string | null;
  @ApiProperty({ type: PmPortfolioContractSummaryDto }) contract!: PmPortfolioContractSummaryDto;
  @ApiProperty({ type: [PmPortfolioStaffDto], description: 'PM staff assigned today.' })
  staffToday!: PmPortfolioStaffDto[];
  @ApiProperty({ type: PmPortfolioKpisDto }) kpis!: PmPortfolioKpisDto;
}

export class PmPortfolioTotalsDto {
  @ApiProperty({ example: 3 }) buildings!: number;
  @ApiProperty({ example: 820 }) units!: number;
  @MoneyOutput({ example: '9800000.00', description: 'Σ billed (12 months).' }) billed!: string;
  @MoneyOutput({ example: '9210000.00', description: 'Σ collected.' }) collected!: string;
  @ApiProperty({ type: String, nullable: true, example: '93.98' }) collectionRatePct!: string | null;
  @MoneyOutput({ example: '512000.00', description: 'Σ overdue now.' }) overdueAmount!: string;
  @ApiProperty({ example: 19 }) openRequests!: number;
  @ApiProperty({ example: 4 }) slaBreachedRequests!: number;
  @ApiProperty({ example: 3 }) expiringContracts!: number;
}

export class PmPortfolioDto {
  @ApiProperty({ format: 'date', example: '2027-01-02' }) asOf!: string;
  @ApiProperty({ type: [PmPortfolioBuildingDto] }) buildings!: PmPortfolioBuildingDto[];
  @ApiProperty({ type: PmPortfolioTotalsDto }) totals!: PmPortfolioTotalsDto;
}

export class StaffBoardAssignmentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) assignmentId!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId }) buildingId!: string;
  @ApiProperty({ example: 'อาคาร A' }) buildingName!: string;
  @ApiProperty({ enum: PmAssignmentRoleName, enumName: 'PmAssignmentRole', example: 'building_manager' })
  role!: PmAssignmentRoleName;
  @ApiProperty({ type: String, nullable: true, example: null }) shift!: string | null;
  @ApiProperty({ format: 'date', example: '2027-01-01' }) startsOn!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: null }) endsOn!: string | null;
}

export class StaffBoardMemberDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) userId!: string;
  @ApiProperty({ example: 'สมชาย ใจดี' }) displayName!: string;
  @ApiProperty({ example: 'staff', description: 'Role in the PM company.' }) tenantRole!: string;
  @ApiProperty({ type: [StaffBoardAssignmentDto] }) assignments!: StaffBoardAssignmentDto[];
}

export class StaffBoardBuildingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId }) buildingId!: string;
  @ApiProperty({ example: 'อาคาร A' }) buildingName!: string;
  @ApiProperty({ example: 'นิติบุคคลอาคารชุด ตัวอย่าง' }) juristicName!: string;
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) contractId!: string;
  @ApiProperty({ type: [PmPortfolioStaffDto] }) staff!: PmPortfolioStaffDto[];
}

export class StaffBoardUnassignedDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) userId!: string;
  @ApiProperty({ example: 'สมหญิง ขยัน' }) displayName!: string;
  @ApiProperty({ example: 'staff' }) tenantRole!: string;
}

export class StaffBoardDto {
  @ApiProperty({ format: 'date', example: '2027-01-02' }) asOf!: string;
  @ApiProperty({ type: [StaffBoardMemberDto], description: 'Members with an assignment today.' })
  members!: StaffBoardMemberDto[];
  @ApiProperty({ type: [StaffBoardBuildingDto] }) buildings!: StaffBoardBuildingDto[];
  @ApiProperty({
    type: [StaffBoardUnassignedDto],
    description: 'Active members without an assignment today.',
  })
  unassigned!: StaffBoardUnassignedDto[];
}

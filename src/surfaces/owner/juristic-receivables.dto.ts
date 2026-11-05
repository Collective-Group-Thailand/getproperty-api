import { FAKE } from '@common/openapi/examples';
import { PageMeta, PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
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
} from 'class-validator';

import { TokenPairDto } from '../shared/auth.dto';
import { LanguageName } from '../shared/common.dto';
import { MoneyInput, MoneyOutput } from '../shared/fields';
import { BuildingLegalFormName } from '../shared/status.enums';
import { ManualPaymentMethodName } from './payments.dto';

// ------------------------------------------------------------------------------------------- enums

/** `juristic.collection_action` (D-305). */
export enum CollectionActionName {
  Remind = 'remind',
  Surcharge = 'surcharge',
  NoticeLetter = 'notice_letter',
  SuspendServices = 'suspend_services',
  LawyerLetter = 'lawyer_letter',
  LegalAction = 'legal_action',
}

/** `juristic.collection_channel`. */
export enum CollectionChannelName {
  Line = 'line',
  Email = 'email',
  Sms = 'sms',
  Letter = 'letter',
}

/** `juristic.collection_case_state`. */
export enum CollectionCaseStateName {
  Open = 'open',
  Paused = 'paused',
  Resolved = 'resolved',
}

/** `juristic.collection_event_kind`. */
export enum CollectionEventKindName {
  Opened = 'opened',
  Step = 'step',
  Paused = 'paused',
  Resumed = 'resumed',
  DisputeOpened = 'dispute_opened',
  DisputeClosed = 'dispute_closed',
  Resolved = 'resolved',
}

/** `juristic.collection_outcome`. */
export enum CollectionOutcomeName {
  Sent = 'sent',
  Skipped = 'skipped',
  AwaitingApproval = 'awaiting_approval',
  Approved = 'approved',
  Refused = 'refused',
  Failed = 'failed',
}

/** `juristic.letter_batch_state`. */
export enum LetterBatchStateName {
  Queued = 'queued',
  Ready = 'ready',
  Failed = 'failed',
}

/** `juristic.workspace_link_state` (D-270). */
export enum WorkspaceLinkStateName {
  Invited = 'invited',
  Active = 'active',
  Revoked = 'revoked',
}

/** Income groups of budget vs actual. */
export enum IncomeKindName {
  CommonFee = 'common_fee',
  Fund = 'fund',
  Surcharge = 'surcharge',
  Other = 'other',
}

/** Tabs of the receivables console. */
export enum ReceivablesTabName {
  All = 'all',
  AtStep = 'at_step',
  Plan = 'plan',
  Dispute = 'dispute',
}

/** Sort of the receivables console. */
export enum ReceivablesSortName {
  Amount = 'amount',
  Age = 'age',
}

// ------------------------------------------------------------------------------------------- ladders

export class CollectionStepDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: 'integer', example: 3 })
  seq!: number;

  @ApiProperty({
    type: 'integer',
    example: 30,
    description: 'Calendar days after the oldest due date of the case.',
  })
  offsetDays!: number;

  @ApiProperty({
    enum: CollectionActionName,
    enumName: 'CollectionAction',
    example: CollectionActionName.Surcharge,
  })
  action!: CollectionActionName;

  @ApiProperty({
    enum: CollectionChannelName,
    enumName: 'CollectionChannel',
    isArray: true,
    example: [CollectionChannelName.Line, CollectionChannelName.Email],
  })
  channels!: CollectionChannelName[];

  @ApiProperty({ example: 'juristic.collection.surcharge' })
  templateKey!: string;

  @ApiProperty({
    example: false,
    description:
      'Waits for owner / manager / committee approval before it runs (always for suspension, lawyer letter, legal action).',
  })
  requiresApproval!: boolean;

  @ApiProperty({ example: false, description: 'Disabled steps are passed (recorded `skipped`).' })
  enabled!: boolean;

  @ApiProperty({
    example: true,
    description:
      'The step rests on a compliance rule still `pending_legal_verification` (O-038): the console shows the legal-review badge.',
  })
  legalReviewRequired!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'surcharge_disabled',
    description:
      'Why the step can be neither enabled nor run now (its legal gate is closed: `surcharge_disabled`, `surcharge_cap_unset`, `letter_wording_unverified`, `suspend_services_disabled`, `suspend_services_min_days_unset`, `legal_action_disabled`); null = open.',
  })
  gateClosedReason!: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class CollectionLadderDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: BuildingLegalFormName,
    enumName: 'BuildingLegalForm',
    example: BuildingLegalFormName.CondoAct,
  })
  legalForm!: BuildingLegalFormName;

  @ApiProperty({ example: 'ขั้นตอนติดตามยอดค้าง — อาคารชุด' })
  name!: string;

  @ApiProperty({ example: 'condo_act.v1' })
  sourceTemplateKey!: string;

  @ApiProperty({ type: [CollectionStepDto] })
  steps!: CollectionStepDto[];
}

export class CollectionLadderListDto {
  @ApiProperty({ type: [CollectionLadderDto] })
  items!: CollectionLadderDto[];
}

export class CollectionStepUpdateDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 3650, example: 35 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  offsetDays?: number;

  @ApiPropertyOptional({ enum: CollectionChannelName, enumName: 'CollectionChannel', isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsEnum(CollectionChannelName, { each: true })
  channels?: CollectionChannelName[];

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

// ------------------------------------------------------------------------------------------- cases

export class NextStepDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  stepId!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  seq!: number;

  @ApiProperty({
    enum: CollectionActionName,
    enumName: 'CollectionAction',
    example: CollectionActionName.Remind,
  })
  action!: CollectionActionName;

  @ApiProperty({ format: 'date', example: '2027-01-20' })
  dueOn!: string;

  @ApiProperty({ example: false })
  legalReviewRequired!: boolean;

  @ApiProperty({ example: false, description: 'The case waits for this step to be approved or refused.' })
  awaitingApproval!: boolean;
}

export class CollectionEventDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: CollectionEventKindName,
    enumName: 'CollectionEventKind',
    example: CollectionEventKindName.Step,
  })
  kind!: CollectionEventKindName;

  @ApiProperty({ type: 'integer', nullable: true, example: 1 })
  seq!: number | null;

  @ApiProperty({
    enum: CollectionActionName,
    enumName: 'CollectionAction',
    nullable: true,
    example: CollectionActionName.Remind,
  })
  action!: CollectionActionName | null;

  @ApiProperty({
    enum: CollectionOutcomeName,
    enumName: 'CollectionOutcome',
    nullable: true,
    example: CollectionOutcomeName.Sent,
  })
  outcome!: CollectionOutcomeName | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  reason!: string | null;

  @MoneyOutput({ example: null, nullable: true, description: 'The surcharge queued by a surcharge step.' })
  amount!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  invoiceChargeId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Letter PDF of a letter step.',
  })
  documentId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  occurredAt!: string;
}

export class CollectionCaseDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  partyName!: string;

  @ApiProperty({
    enum: BuildingLegalFormName,
    enumName: 'BuildingLegalForm',
    example: BuildingLegalFormName.CondoAct,
  })
  legalForm!: BuildingLegalFormName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  ladderId!: string;

  @ApiProperty({
    enum: CollectionCaseStateName,
    enumName: 'CollectionCaseState',
    example: CollectionCaseStateName.Open,
  })
  state!: CollectionCaseStateName;

  @ApiProperty({
    format: 'date',
    example: '2027-01-05',
    description: 'Due date of the oldest overdue invoice at opening.',
  })
  anchorOn!: string;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description: 'Days spent paused (they move the rest of the ladder back).',
  })
  pausedDays!: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The active payment plan pausing the case.',
  })
  planId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  disputeOpenedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  disputeReason!: string | null;

  @ApiProperty({ type: NextStepDto, nullable: true })
  nextStep!: NextStepDto | null;

  @ApiProperty({ type: [CollectionEventDto] })
  timeline!: CollectionEventDto[];

  @ApiProperty({
    type: [String],
    example: ['open_dispute'],
    description: 'Actions allowed now for the caller.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  openedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  resolvedAt!: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class CollectionCaseListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: CollectionCaseStateName, enumName: 'CollectionCaseState' })
  @IsOptional()
  @IsEnum(CollectionCaseStateName)
  state?: CollectionCaseStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partyId?: string;
}

export class StepDecisionDto {
  @ApiPropertyOptional({ example: 'ที่ประชุมกรรมการอนุมัติ ครั้งที่ 3/2570', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class CaseReasonDto {
  @ApiProperty({
    example: 'เจ้าของร่วมโต้แย้งยอดค่าส่วนกลางเดือนมกราคม',
    minLength: 3,
    maxLength: 600,
    description: 'Recorded on the case timeline (evidence) and told to the owner where the action says so.',
  })
  @IsString()
  @Length(3, 600)
  reason!: string;
}

// ------------------------------------------------------------------------------------------- receivables

export class ReceivableContextDto {
  @ApiProperty({
    type: 'integer',
    example: 2,
    description: 'Units the owner holds today in this juristic tenant.',
  })
  ownsUnits!: number;

  @ApiProperty({ example: true, description: 'The owner does not live in the unit (no current occupancy).' })
  nonResident!: boolean;

  @ApiProperty({ example: false, description: 'The billed party is an agency the owner named (bill-to).' })
  agent!: boolean;
}

export class ReceivableNextStepDto {
  @ApiProperty({
    enum: CollectionActionName,
    enumName: 'CollectionAction',
    example: CollectionActionName.Remind,
  })
  kind!: CollectionActionName;

  @ApiProperty({ format: 'date', example: '2027-01-20' })
  date!: string;

  @ApiProperty({ example: false })
  legalReviewRequired!: boolean;

  @ApiProperty({ example: false })
  awaitingApproval!: boolean;
}

export class ReceivableRowDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  ownerName!: string;

  @ApiProperty({ type: ReceivableContextDto })
  context!: ReceivableContextDto;

  @MoneyOutput({
    example: '7500.00',
    description: 'Open invoice balances + plan / surcharge charges queued + plan instalments not yet billed.',
  })
  outstanding!: string;

  @MoneyOutput({
    example: '120.55',
    description: 'Of which surcharge (open late-fee lines and queued surcharges).',
  })
  surcharge!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-11-05' })
  oldestOverdueOn!: string | null;

  @ApiProperty({ type: 'integer', example: 2 })
  oldestOverdueMonths!: number;

  @ApiProperty({ type: 'integer', example: 66 })
  daysOverdue!: number;

  @ApiProperty({ type: ReceivableNextStepDto, nullable: true })
  nextStep!: ReceivableNextStepDto | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  caseId!: string | null;

  @ApiProperty({
    enum: CollectionCaseStateName,
    enumName: 'CollectionCaseState',
    nullable: true,
    example: CollectionCaseStateName.Open,
    description: 'open or paused (a resolved case is no longer listed); null = no case.',
  })
  caseState!: CollectionCaseStateName | null;

  @ApiProperty({ example: false })
  disputeOpen!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  planId!: string | null;

  @ApiProperty({
    type: [String],
    example: ['line', 'email'],
    description: 'How the owner can be reached: line · email · sms, or letter when none.',
  })
  channels!: string[];
}

export class JuristicReceivableTotalsDto {
  @MoneyOutput({ example: '182340.00', description: 'Σ outstanding of every matching row.' })
  outstanding!: string;

  @MoneyOutput({ example: '2210.40', description: 'Σ surcharge of every matching row.' })
  surcharge!: string;
}

export class ReceivablesPageDto {
  @ApiProperty({ type: [ReceivableRowDto] })
  data!: ReceivableRowDto[];

  @ApiProperty({ type: PageMeta })
  meta!: PageMeta;

  @ApiProperty({ type: JuristicReceivableTotalsDto })
  totals!: JuristicReceivableTotalsDto;
}

export class ReceivablesQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ReceivablesTabName, enumName: 'ReceivablesTab', default: 'all' })
  @IsOptional()
  @IsEnum(ReceivablesTabName)
  tab?: ReceivablesTabName;

  @ApiPropertyOptional({
    enum: ReceivablesSortName,
    enumName: 'ReceivablesSort',
    default: 'amount',
    description:
      '`amount` (outstanding) or `age` (days overdue); `order` desc (default) = largest / oldest first. `q` searches the unit number or the owner name.',
  })
  @IsOptional()
  @IsEnum(ReceivablesSortName)
  declare sort?: ReceivablesSortName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class ReceivablesExportDto {
  @ApiPropertyOptional({ enum: ReceivablesTabName, enumName: 'ReceivablesTab' })
  @IsOptional()
  @IsEnum(ReceivablesTabName)
  tab?: ReceivablesTabName;

  @ApiPropertyOptional({ example: 'A-10' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ReceivablesSortName, enumName: 'ReceivablesSort' })
  @IsOptional()
  @IsEnum(ReceivablesSortName)
  sort?: ReceivablesSortName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

// ------------------------------------------------------------------------------------------- reports

export class AgingCountDto {
  @ApiProperty({ type: 'integer', example: 12 })
  invoices!: number;

  @ApiProperty({ type: 'integer', example: 9, description: 'Distinct party × unit.' })
  accounts!: number;

  @MoneyOutput({ example: '45200.00', description: 'Open balances.' })
  amount!: string;
}

export class AgingBucketDto extends AgingCountDto {
  @ApiProperty({ example: '0-30' })
  key!: string;

  @ApiProperty({ type: 'integer', example: 0 })
  fromDays!: number;

  @ApiProperty({ type: 'integer', nullable: true, example: 30, description: 'null = no upper bound.' })
  toDays!: number | null;
}

export class AgingReportDto {
  @ApiProperty({ type: AgingCountDto, description: 'Open but not yet due.' })
  notDue!: AgingCountDto;

  @ApiProperty({ type: [AgingBucketDto] })
  buckets!: AgingBucketDto[];

  @ApiProperty({ type: AgingCountDto, description: 'Σ of every overdue bucket.' })
  overdue!: AgingCountDto;
}

export class BuildingAgingDto extends AgingReportDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  name!: string;
}

export class JuristicAgingDto {
  @ApiProperty({ format: 'date', example: '2027-01-10' })
  asOf!: string;

  @ApiProperty({ type: [Number], example: [30, 90, 365], description: 'Setting `juristic.aging_buckets`.' })
  bounds!: number[];

  @ApiProperty({ type: AgingReportDto })
  overall!: AgingReportDto;

  @ApiProperty({ type: [BuildingAgingDto] })
  buildings!: BuildingAgingDto[];
}

export class AgingQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class CollectionRateCycleDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  billingCycleId!: string;

  @ApiProperty({ example: '2026-Q4' })
  periodKey!: string;

  @ApiProperty({ example: 'quarterly' })
  frequency!: string;

  @ApiProperty({ format: 'date', example: '2026-10-01' })
  periodStart!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ type: 'integer', example: 312 })
  invoices!: number;

  @MoneyOutput({ example: '1234567.89', description: 'Invoices of the cycle net of credit notes.' })
  billed!: string;

  @MoneyOutput({ example: '1100000.00', description: 'Allocated to them (not reversed), any date.' })
  collected!: string;

  @MoneyOutput({ example: '980000.00', description: 'Paid within `kpiDays` after each invoice’s due date.' })
  collectedWithinDays!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '89.10',
    description: 'Percent, 2 dp; null when nothing billed.',
  })
  collectionRatePct!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '79.38' })
  withinDaysRatePct!: string | null;
}

export class CollectionRateTotalDto {
  @MoneyOutput({ example: '1234567.89', description: 'Σ billed.' })
  billed!: string;

  @MoneyOutput({ example: '1100000.00', description: 'Σ collected.' })
  collected!: string;

  @MoneyOutput({ example: '980000.00', description: 'Σ collected within kpiDays.' })
  collectedWithinDays!: string;

  @ApiProperty({ type: String, nullable: true, example: '89.10' })
  collectionRatePct!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '79.38', description: 'The KPI.' })
  withinDaysRatePct!: string | null;
}

export class CollectionRateDto {
  @ApiProperty({ format: 'date', example: '2026-01-10' })
  from!: string;

  @ApiProperty({ format: 'date', example: '2027-01-10' })
  to!: string;

  @ApiProperty({ type: 'integer', example: 30, description: 'Setting `juristic.kpi_collection_days`.' })
  kpiDays!: number;

  @ApiProperty({ type: [CollectionRateCycleDto] })
  cycles!: CollectionRateCycleDto[];

  @ApiProperty({ type: CollectionRateTotalDto })
  total!: CollectionRateTotalDto;
}

export class CollectionRateQuery {
  @ApiPropertyOptional({
    format: 'date',
    description: 'Cycles starting on or after (default `to` − 365 days).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Cycles starting on or before (default today).' })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class BudgetIncomeLineDto {
  @ApiProperty({ example: 'ค่าส่วนกลาง' })
  label!: string;

  @MoneyOutput({ example: '1200000.00', description: 'Budgeted.' })
  amount!: string;
}

export class IncomeByKindDto {
  @ApiProperty({ enum: IncomeKindName, enumName: 'JuristicIncomeKind', example: IncomeKindName.CommonFee })
  kind!: IncomeKindName;

  @MoneyOutput({ example: '600000.00', description: 'Billed in the budget period, net of credit notes.' })
  amount!: string;
}

export class BudgetActualIncomeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  budgetId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: 'integer', example: 2027 })
  fiscalYear!: number;

  @ApiProperty({ format: 'date', example: '2027-01-01' })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2027-12-31' })
  periodEnd!: string;

  @ApiProperty({ format: 'date', example: '2027-06-30' })
  asOf!: string;

  @MoneyOutput({ example: '1500000.00', description: 'Σ income lines of the budget.' })
  budgetedIncome!: string;

  @ApiProperty({ type: [BudgetIncomeLineDto] })
  incomeLines!: BudgetIncomeLineDto[];

  @MoneyOutput({ example: '740000.00', description: 'Billed so far in the period.' })
  billed!: string;

  @ApiProperty({ type: [IncomeByKindDto] })
  billedByKind!: IncomeByKindDto[];

  @MoneyOutput({ example: '690000.00', description: 'Paid in the period on those invoices.' })
  collected!: string;

  @ApiProperty({ type: String, nullable: true, example: '49.33' })
  billedVsBudgetPct!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '93.24' })
  collectedVsBilledPct!: string | null;

  @ApiProperty({
    example: false,
    description: 'The expense side comes with J2.1 (chart of accounts and journals); false until then.',
  })
  expenseSideAvailable!: boolean;
}

// ------------------------------------------------------------------------------------------- statements

export class StatementInvoiceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'INV-2027-00012' })
  number!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ format: 'date', example: '2027-01-01' })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2027-03-31' })
  periodEnd!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-01-05' })
  dueDate!: string | null;

  @MoneyOutput({ example: '4500.00', description: 'Still to pay on it when the statement was issued.' })
  balance!: string;
}

export class StatementUnitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ example: 'อาคาร A' })
  building!: string;
}

export class StatementDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'STM-2027-00001' })
  number!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  partyName!: string;

  @ApiProperty({ example: '2027-01' })
  period!: string;

  @ApiProperty({ format: 'date', example: '2027-01-01' })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2027-01-31' })
  periodEnd!: string;

  @ApiProperty({ type: [StatementUnitDto] })
  units!: StatementUnitDto[];

  @MoneyOutput({ example: '0.00', description: 'Brought forward (before the month).' })
  opening!: string;

  @MoneyOutput({ example: '9000.00', description: 'Invoices and debit notes issued in the month.' })
  charges!: string;

  @MoneyOutput({ example: '0.00', description: 'Credit notes issued in the month.' })
  credits!: string;

  @MoneyOutput({ example: '0.00', description: 'Paid in the month.' })
  payments!: string;

  @MoneyOutput({ example: '9000.00', description: 'opening + charges − credits − payments.' })
  closing!: string;

  @MoneyOutput({
    example: '9000.00',
    description: 'What is to pay now ("ยอดที่ต้องชำระ"): open balances − credit.',
  })
  amountDue!: string;

  @ApiProperty({ type: [StatementInvoiceDto] })
  openInvoices!: StatementInvoiceDto[];

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  language!: LanguageName;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'null until the worker built the PDF.',
  })
  documentId!: string | null;

  @ApiProperty({
    type: [String],
    example: ['line', 'email'],
    description: 'Where it goes: line · email, or letter.',
  })
  deliveredVia!: string[];

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  letterBatchId!: string | null;

  @ApiProperty({ type: [String], example: [], description: 'Payments booked for this statement.' })
  paymentIds!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;
}

export class StatementListQuery extends PageQuery {
  @ApiPropertyOptional({ example: '2027-01' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partyId?: string;
}

export class StatementIssueDto {
  @ApiProperty({ example: '2027-01', description: 'The Bangkok month (YYYY-MM), not a future one.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only owners billed in this building.' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Only these parties.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  partyIds?: string[];

  @ApiPropertyOptional({
    enum: LanguageName,
    enumName: 'Language',
    description: 'Default: each party’s language.',
  })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: 'th' | 'en';
}

export class StatementIssueResultDto {
  @ApiProperty({ type: [StatementDto] })
  issued!: StatementDto[];

  @ApiProperty({
    type: 'integer',
    example: 0,
    description: 'Parties that already had a statement for the month.',
  })
  skipped!: number;
}

export class StatementPaymentCreateDto {
  @MoneyInput({
    example: '9000.00',
    description: 'Received for the statement (allocated over its open invoices).',
  })
  amount!: string;

  @ApiProperty({
    enum: ManualPaymentMethodName,
    enumName: 'ManualPaymentMethod',
    example: 'bank_transfer_manual',
  })
  @IsEnum(ManualPaymentMethodName)
  method!: ManualPaymentMethodName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  @IsDateString()
  paidAt!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Evidence (required for transfers; for juristic tenants always).',
  })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;

  @ApiPropertyOptional({ example: 'KBank ref 0123', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional({ example: 'โอนจากต่างประเทศ SWIFT BKKBTHBK', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class StatementPaymentSliceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  paymentId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @MoneyOutput({ example: '4500.00', description: 'Booked on this unit.' })
  amount!: string;
}

export class StatementPaymentResultDto {
  @ApiProperty({ type: StatementDto })
  statement!: StatementDto;

  @ApiProperty({ type: [StatementPaymentSliceDto] })
  payments!: StatementPaymentSliceDto[];
}

export class LetterBatchCreateDto {
  @ApiProperty({ example: '2027-01' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period!: string;
}

export class LetterBatchDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: '2027-01' })
  period!: string;

  @ApiProperty({
    enum: LetterBatchStateName,
    enumName: 'LetterBatchState',
    example: LetterBatchStateName.Ready,
  })
  state!: LetterBatchStateName;

  @ApiProperty({
    type: [String],
    example: [FAKE.uuid],
    description: 'Statements printed (owners without digital channels).',
  })
  statementIds!: string[];

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  documentId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  error!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  requestedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  finishedAt!: string | null;
}

// ------------------------------------------------------------------------------------------- D-270 workspace

export class WorkspaceInvitationCreateDto {
  @ApiProperty({ format: 'uuid', description: 'The stub building (status external) of the condo.' })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ type: [String], format: 'uuid', description: 'My units in it to link (1–50).' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  unitIds!: string[];

  @ApiProperty({ example: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง', minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200)
  officeName!: string;

  @ApiPropertyOptional({
    example: FAKE.phone,
    description: 'The office phone (for my reference; nothing is sent).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  officePhone?: string;
}

export class WorkspaceInvitationDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: [String], example: [FAKE.uuid] })
  unitIds!: string[];

  @ApiProperty({ example: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง' })
  officeName!: string;

  @ApiProperty({
    enum: WorkspaceLinkStateName,
    enumName: 'WorkspaceLinkState',
    example: WorkspaceLinkStateName.Invited,
  })
  state!: WorkspaceLinkStateName;

  @ApiProperty({ example: 'Q7XK', description: 'Last 4 characters of the code.' })
  codeHint!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'H4N8R2Q7XK',
    description: 'Returned once, when created.',
  })
  code!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://app.getproperty.co/juristic/join/H4N8R2Q7XK',
  })
  url!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  acceptedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  revokedAt!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class WorkspaceInvitationListDto {
  @ApiProperty({ type: [WorkspaceInvitationDto] })
  items!: WorkspaceInvitationDto[];
}

export class WorkspaceUnitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'เดอะ ตัวอย่าง คอนโด' })
  buildingName!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The landlord as a billed party of this workspace.',
  })
  landlordPartyId!: string;

  @ApiProperty({ example: 'สมชาย ใจดี' })
  landlordName!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  linkedAt!: string;
}

export class WorkspaceUnitListDto {
  @ApiProperty({ type: [WorkspaceUnitDto] })
  items!: WorkspaceUnitDto[];
}

export class WorkspaceInvoiceCreateDto {
  @ApiProperty({ format: 'date', example: '2027-01-01' })
  @IsDateString({ strict: true })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2027-03-31' })
  @IsDateString({ strict: true })
  periodEnd!: string;

  @MoneyInput({ example: '4500.00', description: 'The common fee of the period.' })
  amount!: string;

  @ApiPropertyOptional({ example: 'ค่าส่วนกลาง ไตรมาส 1/2570', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

export class WorkspacePreviewDto {
  @ApiProperty({ example: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง' })
  officeName!: string;

  @ApiProperty({ example: 'เดอะ ตัวอย่าง คอนโด' })
  buildingName!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  units!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;
}

export class WorkspaceAcceptDto {
  @ApiProperty({ example: 'H4N8R2Q7XK' })
  @IsString()
  @Length(8, 20)
  code!: string;

  @ApiProperty({
    enum: ['phone_otp', 'line', 'firebase_google', 'firebase_apple'],
    enumName: 'SignupProvider',
    example: 'phone_otp',
  })
  @IsIn(['phone_otp', 'line', 'firebase_google', 'firebase_apple'])
  provider!: 'phone_otp' | 'line' | 'firebase_google' | 'firebase_apple';

  @ApiPropertyOptional({ description: '`line` / `firebase_*`: the id token.' })
  @IsOptional()
  @IsString()
  @Length(10, 8192)
  idToken?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: '`phone_otp`: the challenge of `…/juristic-workspaces/otp`.',
  })
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @Matches(/^\d{6}$/)
  code6?: string;

  @ApiProperty({
    example: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง',
    description: 'Name of the juristic person (a new workspace).',
  })
  @IsString()
  @Length(1, 200)
  displayName!: string;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language' })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: 'th' | 'en';
}

export class WorkspaceAcceptResultDto {
  @ApiProperty({ example: true, description: 'False when an existing juristic tenant of mine was linked.' })
  created!: boolean;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง' })
  tenantName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  linkId!: string;

  @ApiProperty({ type: TokenPairDto })
  tokens!: TokenPairDto;
}

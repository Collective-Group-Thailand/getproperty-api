import { FAKE } from '@common/openapi/examples';
import { PageMeta, PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

export enum AgingBucketName {
  Current = 'current',
  D1To30 = 'd1_30',
  D31To60 = 'd31_60',
  D61To90 = 'd61_90',
  Over90 = 'd90p',
}

export enum ReceivableSortName {
  Balance = 'balance',
  DaysOverdue = 'days_overdue',
  Unit = 'unit',
}

export enum ReceivableEntryTypeName {
  Invoice = 'invoice',
  Payment = 'payment',
  CreditNote = 'credit_note',
  DebitNote = 'debit_note',
  Refund = 'refund',
  WriteOff = 'write_off',
  DepositOffset = 'deposit_offset',
  Opening = 'opening',
}

export enum ReminderStatusName {
  Scheduled = 'scheduled',
  Sent = 'sent',
  SkippedPaid = 'skipped_paid',
  DeferredQuietHours = 'deferred_quiet_hours',
  Cancelled = 'cancelled',
  Failed = 'failed',
}

export enum ReminderTriggerName {
  Schedule = 'schedule',
  Owner = 'owner',
}

export enum PenaltyStatusName {
  Pending = 'pending',
  Applied = 'applied',
  Waived = 'waived',
}

export class AgingDto {
  @ApiProperty({ example: '0.00', description: 'Not yet due.' })
  current!: string;

  @ApiProperty({ example: '5344.00', description: '1–30 days past due.' })
  d1_30!: string;

  @ApiProperty({ example: '0.00', description: '31–60 days past due.' })
  d31_60!: string;

  @ApiProperty({ example: '0.00', description: '61–90 days past due.' })
  d61_90!: string;

  @ApiProperty({ example: '0.00', description: 'More than 90 days past due.' })
  d90p!: string;
}

const toBool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ReceivableListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    example: 1,
    description: 'Oldest open invoice at least this many days past due.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  minDaysOverdue?: number;

  @ApiPropertyOptional({
    enum: AgingBucketName,
    enumName: 'AgingBucket',
    description: 'Something owed in this bucket.',
  })
  @IsOptional()
  @IsEnum(AgingBucketName)
  bucket?: AgingBucketName;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description: 'Include parties with nothing owed (credit only / open but covered).',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeSettled?: boolean;

  @ApiPropertyOptional({
    enum: ReceivableSortName,
    enumName: 'ReceivableSort',
    default: ReceivableSortName.Balance,
  })
  @IsOptional()
  @IsEnum(ReceivableSortName)
  sortBy?: ReceivableSortName;
}

export class ReceivableDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  partyName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({
    example: '5344.00',
    description: 'Σ open invoice balances − credit (negative = in credit).',
  })
  balance!: string;

  @ApiProperty({ example: '0.00' })
  creditBalance!: string;

  @ApiProperty({ example: 1 })
  openInvoicesCount!: number;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-11-05' })
  oldestDueDate!: string | null;

  @ApiProperty({ example: 12 })
  daysOverdue!: number;

  @ApiProperty({ type: AgingDto })
  aging!: AgingDto;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  updatedAt!: string;
}

export class ReceivableTotalsDto {
  @ApiProperty({ example: 25 })
  count!: number;

  @ApiProperty({ example: '84210.00' })
  balance!: string;

  @ApiProperty({ example: '350.00' })
  creditBalance!: string;

  @ApiProperty({ type: AgingDto })
  aging!: AgingDto;
}

export class ReceivableListDto {
  @ApiProperty({ type: [ReceivableDto] })
  data!: ReceivableDto[];

  @ApiProperty({ type: PageMeta })
  meta!: PageMeta;

  @ApiProperty({
    type: ReceivableTotalsDto,
    description: 'Over every row matching the filters (not only this page).',
  })
  totals!: ReceivableTotalsDto;
}

export class ReceivableEntryQuery extends PageQuery {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  partyId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class ReceivableEntryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: ReceivableEntryTypeName,
    enumName: 'ReceivableEntryType',
    example: ReceivableEntryTypeName.Invoice,
  })
  entryType!: ReceivableEntryTypeName;

  @ApiProperty({
    example: 'invoice',
    description:
      '`invoice`, `invoice_void`, `credit_note`, `debit_note`, `payment`, `payment_reversal`, `refund`.',
  })
  refType!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  refId!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ example: '5344.00', description: 'Signed: + owed more, − owed less.' })
  amount!: string;

  @ApiProperty({ example: '5344.00' })
  runningBalance!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  occurredAt!: string;
}

export class DunningReminderDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 3, description: 'Days after the due date (0 = sent by the owner).' })
  step!: number;

  @ApiProperty({
    enum: ReminderTriggerName,
    enumName: 'ReminderTrigger',
    example: ReminderTriggerName.Schedule,
  })
  triggeredBy!: ReminderTriggerName;

  @ApiProperty({ enum: ReminderStatusName, enumName: 'ReminderStatus', example: ReminderStatusName.Sent })
  status!: ReminderStatusName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  scheduledFor!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  sentAt!: string | null;
}

export class PenaltyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: '100.00' })
  amount!: string;

  @ApiProperty({ example: true, description: 'compliance.late_fee_policy allowed it (⚖ O-002).' })
  allowed!: boolean;

  @ApiProperty({ enum: PenaltyStatusName, enumName: 'PenaltyStatus', example: PenaltyStatusName.Pending })
  status!: PenaltyStatusName;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The line of the next invoice that carries it.',
  })
  appliedInvoiceLineId!: string | null;
}

export class InvoiceRemindersDto {
  @ApiProperty({ type: [DunningReminderDto] })
  reminders!: DunningReminderDto[];

  @ApiProperty({ type: PenaltyDto, nullable: true })
  penalty!: PenaltyDto | null;
}

export class DashboardQuery {
  @ApiPropertyOptional({ example: '2026-11', description: 'Bangkok month (default the current one).' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class DashboardMethodDto {
  @ApiProperty({ example: 'qr' })
  method!: string;

  @ApiProperty({ example: '102344.00' })
  amount!: string;

  @ApiProperty({ example: 19 })
  count!: number;
}

export class DashboardIncomeDto {
  @ApiProperty({ example: '120450.00', description: 'Money received in the month (credit uses excluded).' })
  received!: string;

  @ApiProperty({ example: 24 })
  payments!: number;

  @ApiProperty({ type: [DashboardMethodDto] })
  byMethod!: DashboardMethodDto[];
}

export class DashboardBillingDto {
  @ApiProperty({ example: '128000.00', description: 'Total of the invoices issued in the month.' })
  billed!: string;

  @ApiProperty({ example: 25 })
  invoices!: number;

  @ApiProperty({ example: '112000.00', description: 'Paid on those invoices so far.' })
  collected!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '87.50',
    description: 'collected ÷ (billed + debit − credit notes) × 100.',
  })
  collectedPct!: string | null;

  @ApiProperty({ example: '16000.00' })
  outstanding!: string;
}

export class DashboardArrearsDto {
  @ApiProperty({ example: '16000.00', description: 'Balance of overdue invoices.' })
  balance!: string;

  @ApiProperty({ example: 3 })
  invoices!: number;

  @ApiProperty({ example: 3 })
  parties!: number;

  @ApiProperty({ type: AgingDto })
  aging!: AgingDto;

  @ApiProperty({ example: '350.00' })
  credit!: string;
}

export class DashboardDueTodayDto {
  @ApiProperty({ example: '5344.00' })
  balance!: string;

  @ApiProperty({ example: 1 })
  invoices!: number;
}

export class DashboardAttentionDto {
  @ApiProperty({ example: 2 })
  slipsToReview!: number;

  @ApiProperty({ example: 0 })
  draftsToReview!: number;

  @ApiProperty({
    example: 1,
    description:
      'Open repair requests whose SLA breached (D-159) — `GET …/service-requests?open=true&slaBreached=true`.',
  })
  serviceRequestsOverdue!: number;

  @ApiProperty({ example: 3, description: 'Parcels at the desk (received or notified, D-073).' })
  parcelsWaiting!: number;
}

export class DashboardCycleDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  propertyId!: string;

  @ApiProperty({ example: 'หอพักตัวอย่าง' })
  propertyName!: string;

  @ApiProperty({ example: '2026-10' })
  periodKey!: string;

  @ApiProperty({ example: 'issued', description: 'BillingCycleStatus.' })
  status!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  autoIssueAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  issuedAt!: string | null;
}

export class DashboardComplianceDto {
  @ApiProperty({ example: '96.30' })
  score!: string;

  @ApiProperty({ example: 25 })
  invoicesTotal!: number;

  @ApiProperty({ example: 24 })
  invoicesWithinRate!: number;

  @ApiProperty({ example: 1, description: 'Lines above the utility cap this month.' })
  linesAboveCap!: number;

  @ApiProperty({ example: 1 })
  linesAboveCapAcknowledged!: number;
}

export class DashboardLossDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ example: 'electric' })
  utility!: string;

  @ApiProperty({ format: 'date', example: '2026-10-01' })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2026-10-31' })
  periodEnd!: string;

  @ApiProperty({ type: String, nullable: true, example: '9.38' })
  lossPct!: string | null;

  @ApiProperty({ example: '451.44' })
  lossThb!: string;
}

export class DashboardDto {
  @ApiProperty({ example: '2026-11' })
  month!: string;

  @ApiProperty({ format: 'date', example: '2026-11-17' })
  today!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ type: DashboardIncomeDto })
  income!: DashboardIncomeDto;

  @ApiProperty({ type: DashboardBillingDto })
  billing!: DashboardBillingDto;

  @ApiProperty({ type: DashboardArrearsDto })
  arrears!: DashboardArrearsDto;

  @ApiProperty({ type: DashboardDueTodayDto })
  dueToday!: DashboardDueTodayDto;

  @ApiProperty({ type: DashboardAttentionDto })
  attention!: DashboardAttentionDto;

  @ApiProperty({ type: [DashboardCycleDto] })
  cycles!: DashboardCycleDto[];

  @ApiProperty({ type: DashboardComplianceDto })
  compliance!: DashboardComplianceDto;

  @ApiProperty({ type: [DashboardLossDto] })
  loss!: DashboardLossDto[];
}

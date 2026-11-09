import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { MoneyInput, MoneyOutput } from '../shared/fields';

// ------------------------------------------------------------------------------------------- enums

export enum AccountTypeName {
  Asset = 'asset',
  Liability = 'liability',
  Equity = 'equity',
  Income = 'income',
  Expense = 'expense',
}
export enum JournalSourceName {
  Invoice = 'invoice',
  InvoiceVoid = 'invoice_void',
  CreditNote = 'credit_note',
  DebitNote = 'debit_note',
  Payment = 'payment',
  PaymentReversal = 'payment_reversal',
  Refund = 'refund',
  RevenueRecognition = 'revenue_recognition',
  ExpensePayment = 'expense_payment',
  PettyCash = 'petty_cash',
  FundTransfer = 'fund_transfer',
  Manual = 'manual',
  Opening = 'opening',
  Reversal = 'reversal',
}
export enum ReportGranularityName {
  Month = 'month',
  Quarter = 'quarter',
  Year = 'year',
}
export enum JournalExportFormatName {
  Csv = 'csv',
  Express = 'express',
  FlowAccount = 'flowaccount',
}
export enum ExpenseKindName {
  Expense = 'expense',
  PettyCashTopUp = 'petty_cash_top_up',
}
export enum ExpenseStateName {
  Draft = 'draft',
  Submitted = 'submitted',
  Approved = 'approved',
  Rejected = 'rejected',
  Paid = 'paid',
  Cancelled = 'cancelled',
}
export enum ExpenseDecisionName {
  Approved = 'approved',
  Rejected = 'rejected',
}
export enum ExpensePaymentMethodName {
  BankTransfer = 'bank_transfer',
  Cheque = 'cheque',
  Cash = 'cash',
  Fund = 'fund',
}
export enum ExpenseAttachmentKindName {
  Quotation = 'quotation',
  Invoice = 'invoice',
  Receipt = 'receipt',
  PaymentEvidence = 'payment_evidence',
  Other = 'other',
}
export enum ApproverRoleName {
  Owner = 'owner',
  Manager = 'manager',
  Committee = 'committee',
}
export enum WhtFormName {
  Pnd3 = 'pnd3',
  Pnd53 = 'pnd53',
}
export enum FundKindName {
  Sinking = 'sinking',
  Reserve = 'reserve',
  Other = 'other',
}
export enum FundTransferDirectionName {
  In = 'in',
  Out = 'out',
}
export enum FundTransferStateName {
  Requested = 'requested',
  Posted = 'posted',
  Rejected = 'rejected',
  Cancelled = 'cancelled',
}
export enum PettyCashEntryKindName {
  TopUp = 'top_up',
  Spend = 'spend',
  CountDifference = 'count_difference',
}
export enum BankFormatKeyName {
  Kbank = 'kbank',
  Scb = 'scb',
  Bbl = 'bbl',
  Ktb = 'ktb',
}
export enum BankLineMatchName {
  None = 'none',
  Payment = 'payment',
  Expense = 'expense',
  FundTransfer = 'fund_transfer',
  Ignored = 'ignored',
}
export enum BankMatchKindName {
  Payment = 'payment',
  Expense = 'expense',
  FundTransfer = 'fund_transfer',
}
export enum BankLineStateName {
  Unmatched = 'unmatched',
  Matched = 'matched',
  Ignored = 'ignored',
  All = 'all',
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------------------------------- accounts

export class AccountDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: '4110' })
  code!: string;

  @ApiProperty({ example: 'รายได้ค่าส่วนกลาง' })
  nameTh!: string;

  @ApiProperty({ example: 'Common fee income' })
  nameEn!: string;

  @ApiProperty({ enum: AccountTypeName, enumName: 'JuristicAccountType', example: AccountTypeName.Income })
  type!: AccountTypeName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'income_common_fee',
    description:
      'Posting-rule key of a system account (`receivable`, `bank`, `fund_bank` …); null for added accounts.',
  })
  role!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  fundId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description:
      'The tenant bank account this ledger account stands for (bank statements, payments received there).',
  })
  bankAccountId!: string | null;

  @ApiProperty({
    example: true,
    description: 'Created by the chart template / a fund / a float; cannot be deactivated.',
  })
  isSystem!: boolean;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: true, description: 'Has journal lines (its type can no longer change).' })
  used!: boolean;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class AccountListDto {
  @ApiProperty({ type: [AccountDto] })
  data!: AccountDto[];
}

export class AccountListQuery {
  @ApiPropertyOptional({ enum: AccountTypeName, enumName: 'JuristicAccountType' })
  @IsOptional()
  @IsEnum(AccountTypeName)
  type?: AccountTypeName;

  @ApiPropertyOptional({ type: Boolean, description: 'Only active (true) or inactive (false) accounts.' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : (value as unknown)))
  @IsBoolean()
  active?: boolean;
}

export class AccountCreateDto {
  @ApiProperty({ example: '5145', description: 'Unique in the chart; letters, digits, dot and dash, 1–20.' })
  @Matches(/^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/)
  code!: string;

  @ApiProperty({ example: 'ค่าดูแลสวน', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  nameTh!: string;

  @ApiProperty({ example: 'Gardening', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  nameEn!: string;

  @ApiProperty({ enum: AccountTypeName, enumName: 'JuristicAccountType', example: AccountTypeName.Expense })
  @IsEnum(AccountTypeName)
  type!: AccountTypeName;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An asset account standing for a tenant bank account.',
  })
  @IsOptional()
  @IsUUID()
  bankAccountId?: string;
}

export class AccountUpdateDto {
  @ApiPropertyOptional({ example: 'ค่าจ้างดูแลสวนและภูมิทัศน์', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameTh?: string;

  @ApiPropertyOptional({ example: 'Gardening and landscape', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameEn?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'System accounts cannot be deactivated (422 `account.system`).',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  bankAccountId?: string | null;

  @ApiPropertyOptional({
    type: 'integer',
    example: 1,
    description: 'Optimistic lock: 412 when changed meanwhile.',
  })
  @IsOptional()
  @IsInt()
  version?: number;
}

// ------------------------------------------------------------------------------------------- journals

export class JournalLineDto {
  @ApiProperty({ type: 'integer', example: 1 })
  lineNo!: number;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  accountId!: string;

  @ApiProperty({ example: '1140' })
  accountCode!: string;

  @ApiProperty({ example: 'ลูกหนี้ค่าส่วนกลางและเงินกองทุน – เจ้าของร่วม' })
  accountName!: string;

  @MoneyOutput({ example: '3600.00', description: 'Debit (0.00 when a credit).' })
  debit!: string;

  @MoneyOutput({ example: '0.00', description: 'Credit (0.00 when a debit).' })
  credit!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'A-201' })
  unitNo!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  partyId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'สมชาย ใจดี' })
  partyName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  memo!: string | null;
}

export class JournalDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ format: 'date', example: '2027-01-05' })
  postedOn!: string;

  @ApiProperty({
    enum: JournalSourceName,
    enumName: 'JuristicJournalSource',
    example: JournalSourceName.Invoice,
  })
  sourceType!: JournalSourceName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  sourceId!: string | null;

  @ApiProperty({ example: 'ใบแจ้งหนี้ INV-2027-00012' })
  memo!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  reversesJournalId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  reversedByJournalId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  resolutionId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  fundId!: string | null;

  @MoneyOutput({ example: '3600.00', description: 'Σ debit (= Σ credit).' })
  total!: string;

  @ApiProperty({ type: [JournalLineDto] })
  lines!: JournalLineDto[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class JournalListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'date', example: '2027-01-01' })
  @IsOptional()
  @Matches(DAY)
  from?: string;

  @ApiPropertyOptional({ format: 'date', example: '2027-12-31' })
  @IsOptional()
  @Matches(DAY)
  to?: string;

  @ApiPropertyOptional({ enum: JournalSourceName, enumName: 'JuristicJournalSource' })
  @IsOptional()
  @IsEnum(JournalSourceName)
  sourceType?: JournalSourceName;

  @ApiPropertyOptional({ format: 'uuid', description: 'Journals with a line on this account.' })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class ManualJournalLineInputDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  accountId!: string;

  @MoneyInput({ example: '1500.00', description: 'Debit (omit or 0 for a credit line).', optional: true })
  debit?: string;

  @MoneyInput({ example: '0.00', description: 'Credit (omit or 0 for a debit line).', optional: true })
  credit?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A unit of the journal’s building.' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ example: 'นำส่ง ภ.ง.ด.53 เดือนมกราคม', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string;
}

export class ManualJournalCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ format: 'date', example: '2027-02-07', description: 'Not in the future.' })
  @Matches(DAY)
  postedOn!: string;

  @ApiProperty({ example: 'นำส่งภาษีหัก ณ ที่จ่ายเดือนมกราคม 2570', maxLength: 500 })
  @IsString()
  @Length(1, 500)
  memo!: string;

  @ApiPropertyOptional({ example: false, description: 'An opening-balance journal (source `opening`).' })
  @IsOptional()
  @IsBoolean()
  opening?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Adopted resolution of the building — required when a line credits a fund bank account (D-311).',
  })
  @IsOptional()
  @IsUUID()
  resolutionId?: string;

  @ApiProperty({ type: [ManualJournalLineInputDto], minItems: 2, maxItems: 200 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ManualJournalLineInputDto)
  lines!: ManualJournalLineInputDto[];
}

export class JournalReverseDto {
  @ApiPropertyOptional({
    format: 'date',
    example: '2027-02-10',
    description: 'Default today; not before the journal.',
  })
  @IsOptional()
  @Matches(DAY)
  postedOn?: string;

  @ApiProperty({ example: 'บันทึกบัญชีผิดรหัส', minLength: 3, maxLength: 400 })
  @IsString()
  @Length(3, 400)
  reason!: string;
}

export class BackPostResultDto {
  @ApiProperty({ type: 'integer', example: 42, description: 'Documents posted that had no journal yet.' })
  posted!: number;

  @ApiProperty({ type: 'integer', example: 3, description: 'Revenue-schedule months recognised.' })
  recognised!: number;
}

export class LedgerExportCreateDto {
  @ApiProperty({ enum: JournalExportFormatName, enumName: 'JuristicJournalExportFormat', example: 'csv' })
  @IsEnum(JournalExportFormatName)
  format!: JournalExportFormatName;

  @ApiProperty({ format: 'date', example: '2027-01-01' })
  @Matches(DAY)
  from!: string;

  @ApiProperty({ format: 'date', example: '2027-12-31' })
  @Matches(DAY)
  to!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

// ------------------------------------------------------------------------------------------- reports

export class IncomeStatementQuery {
  @ApiProperty({ format: 'date', example: '2027-01-01' })
  @Matches(DAY)
  from!: string;

  @ApiProperty({ format: 'date', example: '2027-12-31' })
  @Matches(DAY)
  to!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ enum: ReportGranularityName, enumName: 'ReportGranularity', example: 'month' })
  @IsOptional()
  @IsEnum(ReportGranularityName)
  granularity?: ReportGranularityName;
}

export class AsOfQuery {
  @ApiPropertyOptional({ format: 'date', example: '2027-12-31', description: 'Default today (Bangkok).' })
  @IsOptional()
  @Matches(DAY)
  asOf?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class StatementAccountRowDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  accountId!: string;

  @ApiProperty({ example: '4110' })
  code!: string;

  @ApiProperty({ example: 'รายได้ค่าส่วนกลาง' })
  nameTh!: string;

  @ApiProperty({ example: 'Common fee income' })
  nameEn!: string;

  @ApiProperty({
    type: [String],
    example: ['100000.00', '100000.00'],
    description: 'Per period (THB, decimal strings).',
  })
  amounts!: string[];

  @MoneyOutput({ example: '200000.00', description: 'Σ of the periods.' })
  total!: string;
}

export class StatementSectionDto {
  @ApiProperty({ type: [StatementAccountRowDto] })
  accounts!: StatementAccountRowDto[];

  @ApiProperty({ type: [String], example: ['100000.00', '100000.00'], description: 'Σ per period (THB).' })
  byPeriod!: string[];

  @MoneyOutput({ example: '200000.00', description: 'Σ of the section.' })
  total!: string;
}

export class IncomeStatementDto {
  @ApiProperty({ format: 'date', example: '2027-01-01' })
  from!: string;

  @ApiProperty({ format: 'date', example: '2027-12-31' })
  to!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ enum: ReportGranularityName, enumName: 'ReportGranularity', example: 'month' })
  granularity!: ReportGranularityName;

  @ApiProperty({
    type: [String],
    example: ['2027-01', '2027-02'],
    description: 'Months (YYYY-MM), quarters (YYYY-Qn) or years (YYYY).',
  })
  periods!: string[];

  @ApiProperty({ type: StatementSectionDto })
  income!: StatementSectionDto;

  @ApiProperty({ type: StatementSectionDto })
  expense!: StatementSectionDto;

  @ApiProperty({
    type: [String],
    example: ['12000.00', '-3000.00'],
    description: 'Income − expense per period (THB).',
  })
  surplusByPeriod!: string[];

  @MoneyOutput({ example: '9000.00', description: 'Income − expense over the range.' })
  surplus!: string;
}

export class BalanceAccountDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  accountId!: string;

  @ApiProperty({ example: '1130' })
  code!: string;

  @ApiProperty({ example: 'เงินฝากธนาคาร – บัญชีดำเนินงาน' })
  nameTh!: string;

  @ApiProperty({ example: 'Bank — operating account' })
  nameEn!: string;

  @MoneyOutput({ example: '154200.00', description: 'Balance in the account’s normal direction.' })
  balance!: string;
}

export class BalanceSectionDto {
  @ApiProperty({ type: [BalanceAccountDto] })
  accounts!: BalanceAccountDto[];

  @MoneyOutput({ example: '154200.00', description: 'Σ of the section.' })
  total!: string;
}

export class BalanceEquityDto {
  @ApiProperty({ type: [BalanceAccountDto] })
  accounts!: BalanceAccountDto[];

  @MoneyOutput({
    example: '9000.00',
    description: 'Income − expense up to the day (no year-end closing in the light GL).',
  })
  surplusToDate!: string;

  @MoneyOutput({ example: '129000.00', description: 'Σ accounts + surplus to date.' })
  total!: string;
}

export class BalanceSheetDto {
  @ApiProperty({ format: 'date', example: '2027-12-31' })
  asOf!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ type: BalanceSectionDto })
  assets!: BalanceSectionDto;

  @ApiProperty({ type: BalanceSectionDto })
  liabilities!: BalanceSectionDto;

  @ApiProperty({ type: BalanceEquityDto })
  equity!: BalanceEquityDto;

  @ApiProperty({ example: true, description: 'Assets = liabilities + equity.' })
  balanced!: boolean;
}

export class TrialBalanceAccountDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  accountId!: string;

  @ApiProperty({ example: '1140' })
  code!: string;

  @ApiProperty({ example: 'ลูกหนี้ค่าส่วนกลางและเงินกองทุน – เจ้าของร่วม' })
  nameTh!: string;

  @ApiProperty({ example: 'Receivables — co-owners (common fees and fund)' })
  nameEn!: string;

  @ApiProperty({ enum: AccountTypeName, enumName: 'JuristicAccountType', example: AccountTypeName.Asset })
  type!: AccountTypeName;

  @MoneyOutput({ example: '43200.00', description: 'Σ debits.' })
  debit!: string;

  @MoneyOutput({ example: '39600.00', description: 'Σ credits.' })
  credit!: string;

  @MoneyOutput({ example: '3600.00', description: 'Balance in the normal direction.' })
  balance!: string;
}

export class TrialBalanceDto {
  @ApiProperty({ format: 'date', example: '2027-12-31' })
  asOf!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ type: [TrialBalanceAccountDto] })
  accounts!: TrialBalanceAccountDto[];

  @MoneyOutput({ example: '512000.00', description: 'Σ debits.' })
  totalDebit!: string;

  @MoneyOutput({ example: '512000.00', description: 'Σ credits.' })
  totalCredit!: string;

  @ApiProperty({ example: true })
  balanced!: boolean;
}

export class LedgerReceivableBuildingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  name!: string;

  @MoneyOutput({ example: '45200.00', description: 'Balance of the receivable account in the journals.' })
  ledgerReceivable!: string;

  @MoneyOutput({ example: '46000.00', description: 'Σ open invoice balances (J1.2b).' })
  openInvoices!: string;

  @MoneyOutput({ example: '800.00', description: 'Σ the payers’ unused credit.' })
  payerCredit!: string;

  @MoneyOutput({ example: '0.00', description: 'Payment-plan amounts not invoiced yet.' })
  planNotInvoiced!: string;

  @MoneyOutput({ example: '45200.00', description: 'openInvoices − payerCredit + planNotInvoiced.' })
  expected!: string;

  @MoneyOutput({
    example: '0.00',
    description: 'ledgerReceivable − expected (0 when everything was posted).',
  })
  difference!: string;
}

export class LedgerReceivableTotalDto {
  @MoneyOutput({ example: '45200.00', description: 'Σ ledger receivable.' })
  ledgerReceivable!: string;

  @MoneyOutput({ example: '46000.00', description: 'Σ open invoices.' })
  openInvoices!: string;

  @MoneyOutput({ example: '800.00', description: 'Σ payer credit.' })
  payerCredit!: string;

  @MoneyOutput({ example: '0.00', description: 'Σ plan amounts not invoiced.' })
  planNotInvoiced!: string;

  @MoneyOutput({ example: '45200.00', description: 'Σ expected.' })
  expected!: string;

  @MoneyOutput({ example: '0.00', description: 'Σ difference.' })
  difference!: string;
}

export class LedgerReceivablesDto {
  @ApiProperty({ format: 'date', example: '2027-06-30' })
  asOf!: string;

  @ApiProperty({ type: [LedgerReceivableBuildingDto] })
  perBuilding!: LedgerReceivableBuildingDto[];

  @ApiProperty({ type: LedgerReceivableTotalDto })
  total!: LedgerReceivableTotalDto;
}

// ------------------------------------------------------------------------------------------- expenses

export class ExpenseLineInputDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'An active expense account of the chart.' })
  @IsUUID()
  accountId!: string;

  @ApiProperty({ example: 'ค่าจ้างรักษาความปลอดภัย มกราคม 2570', maxLength: 300 })
  @IsString()
  @Length(1, 300)
  description!: string;

  @MoneyInput({ example: '42800.00', description: 'Line amount incl. VAT.' })
  amount!: string;

  @MoneyInput({ example: '2800.00', description: 'VAT included in the amount (default 0).', optional: true })
  vatAmount?: string;

  @ApiPropertyOptional({
    example: 'service',
    description: 'A key of `juristic.wht_rates` (⚖ O-041); the rate is snapshotted.',
  })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]{1,40}$/)
  whtKey?: string;
}

export class ExpenseCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiPropertyOptional({ enum: ExpenseKindName, enumName: 'ExpenseKind', example: ExpenseKindName.Expense })
  @IsOptional()
  @IsEnum(ExpenseKindName)
  kind?: ExpenseKindName;

  @ApiProperty({ example: 'ค่ารักษาความปลอดภัย มกราคม 2570', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The vendor (a party of the tenant; its tax id is printed on the 50 ทวิ).',
  })
  @IsOptional()
  @IsUUID()
  payeePartyId?: string;

  @ApiPropertyOptional({ example: 'บริษัท รักษาความปลอดภัย จำกัด', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  payeeName?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Top-ups only: the petty cash float.' })
  @IsOptional()
  @IsUUID()
  pettyCashId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Paid from this fund — needs `resolutionId` (D-311).' })
  @IsOptional()
  @IsUUID()
  fundId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Adopted resolution of the building.' })
  @IsOptional()
  @IsUUID()
  resolutionId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'J2.2 (D-331): the vendor paid — the payee party (its tax id goes on the 50 ทวิ) and the payee name come from it; a blocked vendor is refused (422 `vendor.blocked`). Above `juristic.quotation_threshold` a vendor purchase not under a contract is submitted only with `quotationRoundId` (422 `expense.quotations_required`).',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'J2.2: an active contract of the vendor for the building.',
  })
  @IsOptional()
  @IsUUID()
  vendorContractId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'J2.2: a quotation round of the building awarded to the vendor.',
  })
  @IsOptional()
  @IsUUID()
  quotationRoundId?: string;

  @ApiPropertyOptional({ example: 'ตามสัญญาจ้างเลขที่ 12/2569', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ type: [ExpenseLineInputDto], maxItems: 50 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ExpenseLineInputDto)
  lines?: ExpenseLineInputDto[];

  @MoneyInput({
    example: '5000.00',
    description: 'Top-ups only: the amount added to the float.',
    optional: true,
  })
  amount?: string;
}

export class ExpenseUpdateDto {
  @ApiPropertyOptional({ example: 'ค่ารักษาความปลอดภัย มกราคม 2570', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  payeePartyId?: string | null;

  @ApiPropertyOptional({ example: 'บริษัท รักษาความปลอดภัย จำกัด', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  payeeName?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  fundId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  resolutionId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'J2.2 (D-331): the vendor paid (payee from the vendor).',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  vendorContractId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  quotationRoundId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({ type: [ExpenseLineInputDto], maxItems: 50, description: 'Replaces every line.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ExpenseLineInputDto)
  lines?: ExpenseLineInputDto[];

  @MoneyInput({ example: '5000.00', description: 'Top-ups only.', optional: true })
  amount?: string;

  @ApiPropertyOptional({
    type: 'integer',
    example: 1,
    description: 'Optimistic lock: 412 when changed meanwhile.',
  })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class ExpenseLineDto {
  @ApiProperty({ type: 'integer', example: 1 })
  lineNo!: number;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  accountId!: string;

  @ApiProperty({ example: '5140' })
  accountCode!: string;

  @ApiProperty({ example: 'ค่าจ้างบริการ (รักษาความปลอดภัย ทำความสะอาด ฯลฯ)' })
  accountName!: string;

  @ApiProperty({ example: 'ค่าจ้างรักษาความปลอดภัย มกราคม 2570' })
  description!: string;

  @MoneyOutput({ example: '42800.00', description: 'Amount incl. VAT.' })
  amount!: string;

  @MoneyOutput({ example: '2800.00', description: 'VAT included.' })
  vatAmount!: string;

  @ApiProperty({ type: String, nullable: true, example: 'service' })
  whtKey!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '3 เตรส' })
  whtIncomeType!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '3.00', description: 'Percent, snapshotted.' })
  whtRatePct!: string | null;

  @MoneyOutput({ example: '1200.00', description: 'Tax withheld: (amount − VAT) × rate, half-up.' })
  whtAmount!: string;
}

export class ExpenseAttachmentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  documentId!: string;

  @ApiProperty({ enum: ExpenseAttachmentKindName, enumName: 'ExpenseAttachmentKind', example: 'quotation' })
  kind!: ExpenseAttachmentKindName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ExpenseApprovalDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  approverUserId!: string;

  @ApiProperty({ enum: ApproverRoleName, enumName: 'ExpenseApproverRole', example: 'committee' })
  role!: ApproverRoleName;

  @ApiProperty({ enum: ExpenseDecisionName, enumName: 'ExpenseDecision', example: 'approved' })
  decision!: ExpenseDecisionName;

  @ApiProperty({ type: String, nullable: true, example: null })
  reason!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ExpenseBandDto {
  @ApiProperty({ example: 'le:100000.00', description: 'Band key (`le:<upTo>` or `gt:<previous upTo>`).' })
  key!: string;

  @MoneyOutput({
    example: '100000.00',
    nullable: true,
    description: 'Inclusive upper bound; null = the last band.',
  })
  upTo!: string | null;

  @ApiProperty({
    enum: ApproverRoleName,
    enumName: 'ExpenseApproverRole',
    isArray: true,
    example: ['owner', 'manager', 'committee'],
  })
  roles!: ApproverRoleName[];

  @ApiProperty({ type: 'integer', example: 2 })
  approvals!: number;
}

export class WhtCertificateRefDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'WHT-2027-00001' })
  number!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The PDF, once built.',
  })
  documentId!: string | null;

  @MoneyOutput({ example: '1200.00', description: 'Tax withheld.' })
  tax!: string;
}

export class ExpenseRequestDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'EXP-2027-00001',
    description: 'Given at submission.',
  })
  number!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ enum: ExpenseKindName, enumName: 'ExpenseKind', example: 'expense' })
  kind!: ExpenseKindName;

  @ApiProperty({ example: 'ค่ารักษาความปลอดภัย มกราคม 2570' })
  title!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  payeePartyId!: string | null;

  @ApiProperty({ example: 'บริษัท รักษาความปลอดภัย จำกัด' })
  payeeName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  pettyCashId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  fundId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  resolutionId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'J2.2 (D-331): the vendor paid.',
  })
  vendorId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'บริษัท รักษาความปลอดภัย จำกัด' })
  vendorName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'J2.2: the vendor contract (instalment requests carry it).',
  })
  vendorContractId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  quotationRoundId!: string | null;

  @ApiProperty({ enum: ExpenseStateName, enumName: 'ExpenseState', example: 'submitted' })
  state!: ExpenseStateName;

  @MoneyOutput({ example: '42800.00', description: 'Σ lines.' })
  amount!: string;

  @MoneyOutput({ example: '1200.00', description: 'Σ WHT.' })
  whtAmount!: string;

  @MoneyOutput({ example: '41600.00', description: 'Paid to the payee: amount − WHT.' })
  netAmount!: string;

  @ApiProperty({ type: ExpenseBandDto, nullable: true, description: 'Snapshotted at submission.' })
  band!: ExpenseBandDto | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  approvalsRequired!: number | null;

  @ApiProperty({ type: 'integer', example: 1 })
  approvalsGiven!: number;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'Who drafted it (never an approver of it).',
  })
  requestedBy!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  submittedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  approvedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  rejectedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  decisionReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancelReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  paidAt!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  paidOn!: string | null;

  @ApiProperty({
    enum: ExpensePaymentMethodName,
    enumName: 'ExpensePaymentMethod',
    nullable: true,
    example: null,
  })
  paymentMethod!: ExpensePaymentMethodName | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  paymentReference!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  paidFromAccountId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  journalId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ type: [ExpenseLineDto] })
  lines!: ExpenseLineDto[];

  @ApiProperty({ type: [ExpenseAttachmentDto] })
  attachments!: ExpenseAttachmentDto[];

  @ApiProperty({ type: [ExpenseApprovalDto] })
  approvals!: ExpenseApprovalDto[];

  @ApiProperty({ type: WhtCertificateRefDto, nullable: true })
  certificate!: WhtCertificateRefDto | null;

  @ApiProperty({
    type: [String],
    example: ['approve', 'reject'],
    description: 'What the caller may do now: edit · submit · cancel · approve · reject · pay · attach.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;
}

export class ExpenseListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ExpenseStateName, enumName: 'ExpenseState' })
  @IsOptional()
  @IsEnum(ExpenseStateName)
  state?: ExpenseStateName;

  @ApiPropertyOptional({ enum: ExpenseKindName, enumName: 'ExpenseKind' })
  @IsOptional()
  @IsEnum(ExpenseKindName)
  kind?: ExpenseKindName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'true = submitted requests my role may approve that I did not request nor decide yet.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : (value as unknown)))
  @IsBoolean()
  awaitingMe?: boolean;
}

export class WhtCertificateListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class ExpenseAttachDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'An uploaded document of the tenant.' })
  @IsUUID()
  documentId!: string;

  @ApiProperty({ enum: ExpenseAttachmentKindName, enumName: 'ExpenseAttachmentKind', example: 'quotation' })
  @IsEnum(ExpenseAttachmentKindName)
  kind!: ExpenseAttachmentKindName;
}

export class ExpensePayDto {
  @ApiProperty({ enum: ExpensePaymentMethodName, enumName: 'ExpensePaymentMethod', example: 'bank_transfer' })
  @IsEnum(ExpensePaymentMethodName)
  method!: ExpensePaymentMethodName;

  @ApiProperty({ format: 'date', example: '2027-02-05', description: 'Not in the future.' })
  @Matches(DAY)
  paidOn!: string;

  @ApiPropertyOptional({ example: 'KBank 0205-8812', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Bank / cheque: the bank or cash account paid from (default the operating bank account).',
  })
  @IsOptional()
  @IsUUID()
  fromAccountId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Transfer slip / cheque copy — required except for cash.',
  })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;
}

export class WhtCertificateItemDto {
  @ApiProperty({ example: '3 เตรส' })
  incomeType!: string;

  @ApiProperty({ example: '3.00', description: 'Percent.' })
  ratePct!: string;

  @MoneyOutput({ example: '40000.00', description: 'Amount paid (excl. VAT).' })
  base!: string;

  @MoneyOutput({ example: '1200.00', description: 'Tax withheld.' })
  tax!: string;
}

export class WhtCertificateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'WHT-2027-00001' })
  number!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  expenseRequestId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  payeePartyId!: string;

  @ApiProperty({ example: 'บริษัท รักษาความปลอดภัย จำกัด' })
  payeeName!: string;

  @ApiProperty({
    example: '5678',
    description: 'Last 4 digits of the payee’s tax id (the PDF carries it in full).',
  })
  payeeTaxIdHint!: string;

  @ApiProperty({ enum: WhtFormName, enumName: 'WhtForm', example: 'pnd53' })
  form!: WhtFormName;

  @ApiProperty({ type: [WhtCertificateItemDto] })
  items!: WhtCertificateItemDto[];

  @MoneyOutput({ example: '40000.00', description: 'Σ base.' })
  base!: string;

  @MoneyOutput({ example: '1200.00', description: 'Σ tax.' })
  tax!: string;

  @ApiProperty({ format: 'date', example: '2027-02-05' })
  paidOn!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  documentId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;
}

// ------------------------------------------------------------------------------------------- funds

export class FundDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ enum: FundKindName, enumName: 'JuristicFundKind', example: 'sinking' })
  kind!: FundKindName;

  @ApiProperty({ example: 'เงินกองทุนอาคารชุด' })
  name!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  bankAccountId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'xxx-x-x4321-x' })
  bankAccountMasked!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The fund bank account of the chart (1160-NN).',
  })
  ledgerBankAccountId!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The fund equity account of the chart (3110-NN).',
  })
  ledgerEquityAccountId!: string;

  @MoneyOutput({ example: '250000.00', description: 'Money held in the fund’s bank account.' })
  bankBalance!: string;

  @MoneyOutput({ example: '310000.00', description: 'Fund equity: contributions billed − used.' })
  equityBalance!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class FundListDto {
  @ApiProperty({ type: [FundDto] })
  data!: FundDto[];
}

export class FundListQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class FundCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ enum: FundKindName, enumName: 'JuristicFundKind', example: 'reserve' })
  @IsEnum(FundKindName)
  kind!: FundKindName;

  @ApiProperty({ example: 'เงินสำรองซ่อมลิฟต์', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The tenant bank account holding the fund.' })
  @IsOptional()
  @IsUUID()
  bankAccountId?: string;
}

export class FundUpdateDto {
  @ApiPropertyOptional({ example: 'เงินกองทุนอาคารชุด', maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  bankAccountId?: string | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    type: 'integer',
    example: 1,
    description: 'Optimistic lock: 412 when changed meanwhile.',
  })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class FundLedgerLineDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  journalId!: string;

  @ApiProperty({ format: 'date', example: '2027-01-31' })
  postedOn!: string;

  @ApiProperty({ enum: JournalSourceName, enumName: 'JuristicJournalSource', example: 'fund_transfer' })
  sourceType!: JournalSourceName;

  @ApiProperty({ example: 'โอนเข้าเงินกองทุนอาคารชุด' })
  memo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  accountId!: string;

  @ApiProperty({ example: '1160-01' })
  accountCode!: string;

  @ApiProperty({ enum: ['fund_bank', 'fund_equity'], enumName: 'FundAccountRole', example: 'fund_bank' })
  accountRole!: string;

  @MoneyOutput({ example: '20000.00', description: 'Debit.' })
  debit!: string;

  @MoneyOutput({ example: '0.00', description: 'Credit.' })
  credit!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  resolutionId!: string | null;
}

export class FundTransferCreateDto {
  @ApiProperty({ enum: FundTransferDirectionName, enumName: 'FundTransferDirection', example: 'out' })
  @IsEnum(FundTransferDirectionName)
  direction!: FundTransferDirectionName;

  @MoneyInput({ example: '120000.00', description: 'Amount moved.' })
  amount!: string;

  @ApiProperty({ format: 'date', example: '2027-03-01', description: 'Not in the future.' })
  @Matches(DAY)
  transferOn!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The bank / cash account on the other side (default the operating bank account).',
  })
  @IsOptional()
  @IsUUID()
  counterAccountId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Adopted resolution of the fund’s building — **required for `out`** (422 `fund.resolution_required`).',
  })
  @IsOptional()
  @IsUUID()
  resolutionId?: string;

  @ApiPropertyOptional({ example: 'SCB 0301-1204', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional({ example: 'ซ่อมระบบปั๊มน้ำตามมติที่ประชุมใหญ่', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class FundTransferDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  fundId!: string;

  @ApiProperty({ example: 'เงินกองทุนอาคารชุด' })
  fundName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ enum: FundTransferDirectionName, enumName: 'FundTransferDirection', example: 'out' })
  direction!: FundTransferDirectionName;

  @MoneyOutput({ example: '120000.00', description: 'Amount.' })
  amount!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  counterAccountId!: string;

  @ApiProperty({ example: '1130' })
  counterAccountCode!: string;

  @ApiProperty({ format: 'date', example: '2027-03-01' })
  transferOn!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  resolutionId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'SCB 0301-1204' })
  reference!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ enum: FundTransferStateName, enumName: 'FundTransferState', example: 'requested' })
  state!: FundTransferStateName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  requestedBy!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  requestedAt!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  decidedBy!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  decisionReason!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  journalId!: string | null;

  @ApiProperty({
    type: [String],
    example: ['approve', 'reject'],
    description: 'approve · reject (never the requester).',
  })
  nextActions!: string[];

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class FundTransferListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  fundId?: string;

  @ApiPropertyOptional({ enum: FundTransferStateName, enumName: 'FundTransferState' })
  @IsOptional()
  @IsEnum(FundTransferStateName)
  state?: FundTransferStateName;
}

// ------------------------------------------------------------------------------------------- petty cash

export class PettyCashLastCountDto {
  @ApiProperty({ format: 'date', example: '2027-01-31' })
  countedOn!: string;

  @MoneyOutput({ example: '4210.00', description: 'Cash counted.' })
  countedAmount!: string;

  @MoneyOutput({ example: '-40.00', description: 'Counted − book (negative = shortage).' })
  difference!: string;
}

export class PettyCashDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'เงินสดย่อยสำนักงานนิติ' })
  name!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  custodianUserId!: string;

  @MoneyOutput({ example: '5000.00', description: 'Agreed float.' })
  floatAmount!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'Its own asset account (1120-NN).' })
  accountId!: string;

  @MoneyOutput({ example: '4250.00', description: 'Σ top-ups − spends ± count differences.' })
  balance!: string;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ type: PettyCashLastCountDto, nullable: true })
  lastCount!: PettyCashLastCountDto | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class PettyCashListDto {
  @ApiProperty({ type: [PettyCashDto] })
  data!: PettyCashDto[];
}

export class PettyCashEntryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: PettyCashEntryKindName, enumName: 'PettyCashEntryKind', example: 'spend' })
  kind!: PettyCashEntryKindName;

  @MoneyOutput({ example: '-350.00', description: 'Signed: + top-up, − spend.' })
  amount!: string;

  @ApiProperty({ format: 'date', example: '2027-01-12' })
  entryOn!: string;

  @ApiProperty({ example: 'ค่าหลอดไฟทางเดิน' })
  description!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  accountId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  receiptDocumentId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  expenseRequestId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  countId!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  journalId!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class PettyCashCountDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'date', example: '2027-01-31' })
  countedOn!: string;

  @MoneyOutput({ example: '4210.00', description: 'Cash counted.' })
  countedAmount!: string;

  @MoneyOutput({ example: '4250.00', description: 'Book balance at the count.' })
  bookBalance!: string;

  @MoneyOutput({ example: '-40.00', description: 'Counted − book.' })
  difference!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  countedBy!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class PettyCashDetailDto extends PettyCashDto {
  @ApiProperty({ type: [PettyCashEntryDto], description: 'Newest first (at most 200).' })
  entries!: PettyCashEntryDto[];

  @ApiProperty({ type: [PettyCashCountDto], description: 'Newest first (at most 50).' })
  counts!: PettyCashCountDto[];
}

export class PettyCashCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ example: 'เงินสดย่อยสำนักงานนิติ', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'An active member (staff, manager, accountant or owner).',
  })
  @IsUUID()
  custodianUserId!: string;

  @MoneyInput({ example: '5000.00', description: 'Agreed float (topped up through expense requests).' })
  floatAmount!: string;
}

export class PettyCashSpendDto {
  @MoneyInput({ example: '350.00', description: 'Spent.' })
  amount!: string;

  @ApiProperty({ format: 'date', example: '2027-01-12' })
  @Matches(DAY)
  spentOn!: string;

  @ApiProperty({ example: 'ค่าหลอดไฟทางเดิน', maxLength: 300 })
  @IsString()
  @Length(1, 300)
  description!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'An active expense account.' })
  @IsUUID()
  accountId!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The receipt (an uploaded document) — required.',
  })
  @IsUUID()
  receiptDocumentId!: string;
}

export class PettyCashCountCreateDto {
  @ApiProperty({ format: 'date', example: '2027-01-31' })
  @Matches(DAY)
  countedOn!: string;

  @MoneyInput({ example: '4210.00', description: 'Cash counted.' })
  countedAmount!: string;

  @ApiPropertyOptional({ example: 'ตรวจนับสิ้นเดือนโดยผู้จัดการ', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

// ------------------------------------------------------------------------------------------- bank statements

export class BankStatementImportDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'A tenant bank account.' })
  @IsUUID()
  bankAccountId!: string;

  @ApiProperty({ enum: BankFormatKeyName, enumName: 'BankStatementFormat', example: 'kbank' })
  @IsEnum(BankFormatKeyName)
  formatKey!: BankFormatKeyName;

  @ApiProperty({ example: 'kbank-2027-01.csv', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  fileName!: string;

  @ApiProperty({
    example: '77u/4Lin4Lix4LiZ4LiX4Li14LmILC4LmA4Lin4Lil4LiyLC4Lij4Liy4Lii4LiB4Liy4LijLA==',
    description: 'The CSV file, base64 (at most 2 MB decoded).',
    maxLength: 2_800_000,
  })
  @IsString()
  @Length(4, 2_800_000)
  content!: string;
}

export class BankStatementDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  bankAccountId!: string;

  @ApiProperty({ example: 'ธนาคารกสิกรไทย' })
  bankName!: string;

  @ApiProperty({ example: 'xxx-x-x4321-x' })
  bankAccountMasked!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The ledger account of the bank account.' })
  accountId!: string;

  @ApiProperty({ enum: BankFormatKeyName, enumName: 'BankStatementFormat', example: 'kbank' })
  formatKey!: BankFormatKeyName;

  @ApiProperty({ example: 'kbank-2027-01.csv' })
  fileName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  fileDocumentId!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-01-02' })
  periodStart!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-01-31' })
  periodEnd!: string | null;

  @ApiProperty({ type: 'integer', example: 38, description: 'Lines imported from this file.' })
  lineCount!: number;

  @ApiProperty({
    type: 'integer',
    example: 2,
    description: 'Lines skipped — already imported by an earlier file.',
  })
  duplicateCount!: number;

  @ApiProperty({ type: 'integer', example: 30 })
  matchedCount!: number;

  @ApiProperty({ type: 'integer', example: 6 })
  unmatchedCount!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  importedAt!: string;
}

export class BankStatementImportResultDto {
  @ApiProperty({ type: BankStatementDto })
  statement!: BankStatementDto;

  @ApiProperty({ example: false, description: 'True when the same file was imported before (nothing new).' })
  replayed!: boolean;

  @ApiProperty({ type: 'integer', example: 38 })
  imported!: number;

  @ApiProperty({ type: 'integer', example: 2 })
  duplicates!: number;

  @ApiProperty({ type: 'integer', example: 30 })
  autoMatched!: number;
}

export class BankStatementListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bankAccountId?: string;
}

export class BankStatementLineDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  statementId!: string;

  @ApiProperty({ type: 'integer', example: 3 })
  lineNo!: number;

  @ApiProperty({ format: 'date', example: '2027-01-05' })
  bookedOn!: string;

  @MoneyOutput({ example: '3600.00', description: 'Signed: + money in, − money out.' })
  amount!: string;

  @ApiProperty({ example: 'รับโอนเงิน PromptPay' })
  description!: string;

  @ApiProperty({ type: String, nullable: true, example: '016027101234ABC' })
  reference!: string | null;

  @MoneyOutput({ example: '154200.00', nullable: true, description: 'Bank balance after the line.' })
  balance!: string | null;

  @ApiProperty({ enum: BankLineMatchName, enumName: 'BankLineMatch', example: 'none' })
  matchKind!: BankLineMatchName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  matchId!: string | null;

  @ApiProperty({ enum: ['auto', 'manual'], enumName: 'BankMatchMethod', nullable: true, example: null })
  matchMethod!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  matchedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  ignoreReason!: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class BankMatchSuggestionDto {
  @ApiProperty({ enum: BankMatchKindName, enumName: 'BankMatchKind', example: 'payment' })
  kind!: BankMatchKindName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @MoneyOutput({ example: '3600.00', description: 'As it appears on the statement.' })
  amount!: string;

  @ApiProperty({ format: 'date', example: '2027-01-05' })
  bookedOn!: string;

  @ApiProperty({ example: 'payment transfer_slip' })
  label!: string;

  @ApiProperty({ example: true, description: 'A reference of the candidate was found in the bank text.' })
  referenceHit!: boolean;

  @ApiProperty({ type: 'integer', example: 0, description: 'Days between the two dates.' })
  days!: number;
}

export class BankStatementLineDetailDto extends BankStatementLineDto {
  @ApiProperty({ type: [BankMatchSuggestionDto], description: 'Ranked candidates (unmatched lines only).' })
  suggestions!: BankMatchSuggestionDto[];
}

export class BankLineListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  statementId?: string;

  @ApiPropertyOptional({ enum: BankLineStateName, enumName: 'BankLineState', example: 'unmatched' })
  @IsOptional()
  @IsEnum(BankLineStateName)
  state?: BankLineStateName;
}

export class BankLineMatchDto {
  @ApiProperty({ enum: BankMatchKindName, enumName: 'BankMatchKind', example: 'payment' })
  @IsEnum(BankMatchKindName)
  kind!: BankMatchKindName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  targetId!: string;
}

/** Expense requests per state for the list's tab badges (J-CR, D-335). */
export class ExpenseRequestCountsDto {
  @ApiProperty({ type: 'integer', example: 12 }) all!: number;
  @ApiProperty({
    type: 'integer',
    example: 2,
    description: 'Submitted requests my role may approve, not requested nor decided by me.',
  })
  awaitingMe!: number;
  @ApiProperty({ type: 'integer', example: 1 }) draft!: number;
  @ApiProperty({ type: 'integer', example: 3 }) submitted!: number;
  @ApiProperty({ type: 'integer', example: 2 }) approved!: number;
  @ApiProperty({ type: 'integer', example: 1 }) rejected!: number;
  @ApiProperty({ type: 'integer', example: 4 }) paid!: number;
  @ApiProperty({ type: 'integer', example: 1 }) cancelled!: number;
}

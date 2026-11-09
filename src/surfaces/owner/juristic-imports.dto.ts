import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

import { LanguageName } from '../shared/common.dto';
import { MoneyInput, MoneyOutput } from '../shared/fields';
import { ImportRowErrorDto } from './assets.dto';

/** J3.1 import wizard for juristic tenants moving from a legacy system (D-313, D-332). */

export enum ImportStateName {
  Draft = 'draft',
  Validated = 'validated',
  Reconciled = 'reconciled',
  Committed = 'committed',
  Live = 'live',
  RolledBack = 'rolled_back',
  Cancelled = 'cancelled',
}
export enum ImportSheetName {
  Register = 'register',
  OpeningBalance = 'opening_balance',
  PaymentHistory = 'payment_history',
  BankBalance = 'bank_balance',
  LegacyBills = 'legacy_bills',
}
export enum ImportUploadSheetName {
  Register = 'register',
  OpeningBalance = 'opening_balance',
  PaymentHistory = 'payment_history',
  BankBalance = 'bank_balance',
}
export enum ImportFormatName {
  Xlsx = 'xlsx',
  Csv = 'csv',
}
export enum ReconcileStatusName {
  Match = 'match',
  Mismatch = 'mismatch',
  NoStatement = 'no_statement',
}
export enum ReconcileAccountTypeName {
  Operating = 'operating',
  Fund = 'fund',
}
export enum ReconcileKindName {
  Receivables = 'receivables',
  Bank = 'bank',
}

const toBool = () =>
  Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------------------------------- requests

export class JuristicImportCreateDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: FAKE.buildingId,
    description: 'A building the juristic tenant operates.',
  })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-10-31',
    description:
      'The legacy cut-off (balances and bank balances are as of this Bangkok date; today or earlier).',
  })
  @Matches(DATE)
  asOfDate!: string;

  @ApiPropertyOptional({ type: String, example: 'ย้ายจากโปรแกรมเดิม', nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

export class JuristicImportListQuery extends PageQuery {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'true: only jobs that block a new one (draft, validated, reconciled, committed); false: only the others (J-CR, D-335).',
  })
  @IsOptional()
  @toBool()
  @IsBoolean()
  open?: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ enum: ImportStateName, enumName: 'ImportState' })
  @IsOptional()
  @IsEnum(ImportStateName)
  state?: ImportStateName;
}

export class JuristicImportTemplateQuery {
  @ApiPropertyOptional({ enum: ImportFormatName, enumName: 'ImportFormat', default: 'xlsx' })
  @IsOptional()
  @IsEnum(ImportFormatName)
  format?: ImportFormatName;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', default: 'th' })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;
}

export class JuristicImportFileUploadDto {
  @ApiProperty({ enum: ImportUploadSheetName, enumName: 'ImportUploadSheet', example: 'register' })
  @IsEnum(ImportUploadSheetName)
  sheet!: ImportUploadSheetName;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'A file uploaded through `files/presign` (kind `other`, CSV or XLSX); or give fileName + content.',
  })
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @ApiPropertyOptional({ example: 'register.csv', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  fileName?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'The file inline, base64 (≤ 5 MB decoded).',
    example: '77u/dW5pdF9ubyxvd25lcl9uYW1lDQo=',
  })
  @IsOptional()
  @IsString()
  @MaxLength(7_000_000)
  content?: string;
}

export class JuristicImportRowsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ImportSheetName, enumName: 'ImportSheet' })
  @IsOptional()
  @IsEnum(ImportSheetName)
  sheet?: ImportSheetName;

  @ApiPropertyOptional({ description: 'Only rows with errors.', default: false })
  @IsOptional()
  @toBool()
  @IsBoolean()
  errorsOnly?: boolean;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', default: 'th' })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;
}

export class JuristicImportBadRowsQuery extends JuristicImportTemplateQuery {
  @ApiProperty({ enum: ImportUploadSheetName, enumName: 'ImportUploadSheet' })
  @IsEnum(ImportUploadSheetName)
  sheet!: ImportUploadSheetName;
}

export class JuristicImportReconcileDto {
  @MoneyInput({
    example: '845210.50',
    description: 'The legacy system’s total of receivables on the as-of date.',
  })
  declaredReceivables!: string;

  @ApiPropertyOptional({
    type: String,
    example: 'ส่วนต่าง 1,250.00 บาท คือเงินรับล่วงหน้าของห้อง A-1203 ที่ระบบเดิมหักไว้แล้ว',
    nullable: true,
    description: 'Required (10–2000) with `documentId` when an item does not match.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The supporting attachment (a document of the tenant).',
  })
  @IsOptional()
  @IsUUID()
  documentId?: string | null;
}

export class JuristicImportCommitDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The owners’ signed bill-to consents (one document for the batch); required when the register names a bill-to.',
  })
  @IsOptional()
  @IsUUID()
  billToConsentDocumentId?: string | null;
}

export class JuristicImportRollbackDto {
  @ApiProperty({ example: 'ไฟล์ทะเบียนผิดชุด จะนำเข้าใหม่', minLength: 5, maxLength: 1000 })
  @IsString()
  @Length(5, 1000)
  reason!: string;
}

export class JuristicImportGoLiveDto {
  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description: 'Send each opening balance to the billed party like a new invoice (false: issued silently).',
  })
  @IsOptional()
  @IsBoolean()
  notifyOpeningBalances?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'Go live with unexplained parallel-cycle differences — only where `juristic.import.allow_unexplained_differences` is true; recorded.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeDifferences?: boolean;
}

export class JuristicImportParallelCycleDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A billing cycle of the building’s property (open or computed).',
  })
  @IsUUID()
  billingCycleId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'The legacy bills file (`files/presign`), or fileName + content.',
  })
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @ApiPropertyOptional({ example: 'legacy-bills-2026-11.csv', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  fileName?: string;

  @ApiPropertyOptional({ description: 'The file inline, base64.', example: '77u/dW5pdF9ubyxhbW91bnQNCg==' })
  @IsOptional()
  @IsString()
  @MaxLength(7_000_000)
  content?: string;
}

export class JuristicImportDifferenceExplainDto {
  @ApiProperty({ example: 'ระบบเดิมคิดค่าที่จอดรถรวมในค่าส่วนกลาง', minLength: 5, maxLength: 1000 })
  @IsString()
  @Length(5, 1000)
  explanation!: string;
}

// ------------------------------------------------------------------------------------------- responses

export class JuristicImportFileDto {
  @ApiProperty({ enum: ImportSheetName, enumName: 'ImportSheet' })
  sheet!: ImportSheetName;
  @ApiProperty({ format: 'uuid' })
  documentId!: string;
  @ApiProperty({ example: 'register.xlsx' })
  fileName!: string;
  @ApiProperty({ enum: ImportFormatName, enumName: 'ImportFormat' })
  format!: ImportFormatName;
  @ApiProperty({ example: 512 })
  rowCount!: number;
  @ApiProperty({ example: 0 })
  errorCount!: number;
  @ApiProperty({ example: 3 })
  warningCount!: number;
  @ApiProperty({ format: 'date-time' })
  uploadedAt!: string;
}

export class JuristicImportTotalsDto {
  @ApiProperty({ example: 500 }) units!: number;
  @ApiProperty({ example: 500 }) unitsNew!: number;
  @ApiProperty({ example: 0 }) unitsAttached!: number;
  @ApiProperty({ example: 25 }) floorsNew!: number;
  @ApiProperty({ example: 530 }) parties!: number;
  @ApiProperty({ example: 530 }) partiesNew!: number;
  @ApiProperty({ example: 0 }) partiesAttached!: number;
  @ApiProperty({ example: 512 }) ownerships!: number;
  @ApiProperty({ example: 2, description: 'Units whose shares sum to less than 100 %.' })
  unitsIncomplete!: number;
  @ApiProperty({ example: 6 }) billTos!: number;
  @ApiProperty({ example: 120 }) openingInvoices!: number;
  @ApiProperty({ example: 120 }) unitsInArrears!: number;
  @MoneyOutput({ example: '812000.00', description: 'Σ principal brought forward.' }) principal!: string;
  @MoneyOutput({ example: '33210.50', description: 'Σ surcharge brought forward.' }) surcharge!: string;
  @MoneyOutput({ example: '845210.50', description: 'Σ principal + surcharge.' }) receivables!: string;
  @ApiProperty({ example: 4800 }) historyCount!: number;
  @MoneyOutput({ example: '5123400.00', description: 'Σ payment history.' }) historyAmount!: string;
  @MoneyOutput({ example: '152300.55', description: 'Σ operating bank opening balances.' })
  bankOperating!: string;
  @MoneyOutput({ example: '880000.00', description: 'Σ fund bank opening balances.' }) bankFund!: string;
  @ApiProperty({ example: 0, description: 'Rows with errors.' }) errors!: number;
  @ApiProperty({ example: 3, description: 'Rows with warnings.' }) warnings!: number;
}

export class JuristicReconcileItemDto {
  @ApiProperty({ example: 'receivables' }) key!: string;
  @ApiProperty({ enum: ReconcileKindName, enumName: 'ReconcileKind' }) kind!: ReconcileKindName;
  @ApiProperty({ example: 'receivables' }) label!: string;
  @MoneyOutput({ example: '845210.50', description: 'What the import brings.' }) imported!: string;
  @MoneyOutput({
    example: '845210.50',
    nullable: true,
    description: 'The declared total, or the bank statement balance (null: no statement).',
  })
  reference!: string | null;
  @MoneyOutput({ example: '0.00', nullable: true, description: 'imported − reference.' }) difference!:
    string | null;
  @ApiProperty({ enum: ReconcileStatusName, enumName: 'ReconcileStatus' }) status!: ReconcileStatusName;
  @ApiProperty({
    enum: ReconcileAccountTypeName,
    enumName: 'ReconcileAccountType',
    nullable: true,
    example: 'operating',
    description:
      'Bank items: the account the row names (J-CR, D-335); null on the receivables item and on reconciliations recorded before.',
  })
  accountType!: ReconcileAccountTypeName | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '4012',
    description: 'Bank items: the last four digits.',
  })
  last4!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Fund items: the fund’s name (from the row or the building’s fund).',
  })
  fundName!: string | null;
}

export class JuristicImportReconciliationDto {
  @ApiProperty({ type: [JuristicReconcileItemDto] }) items!: JuristicReconcileItemDto[];
  @ApiProperty({
    type: Boolean,
    example: false,
    description: 'An item does not match: the commit needs the note and the attachment.',
  })
  explanationRequired!: boolean;
  @MoneyOutput({ example: '845210.50', description: 'The declared receivables.' })
  declaredReceivables!: string;
  @ApiProperty({ type: String, nullable: true, example: null }) note!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', example: null }) documentId!: string | null;
  @ApiProperty({ format: 'date-time' }) reconciledAt!: string;
}

export class JuristicImportJobDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 1 }) number!: number;
  @ApiProperty({ format: 'uuid' }) buildingId!: string;
  @ApiProperty({ example: 'อาคาร A' }) buildingName!: string;
  @ApiProperty({ enum: ImportStateName, enumName: 'ImportState' }) state!: ImportStateName;
  @ApiProperty({ format: 'date', example: '2026-10-31' }) asOfDate!: string;
  @ApiProperty({ type: String, nullable: true, example: null }) note!: string | null;
  @ApiProperty({ type: [JuristicImportFileDto] }) files!: JuristicImportFileDto[];
  @ApiProperty({
    type: JuristicImportTotalsDto,
    nullable: true,
    description: 'Of the last validation (null before).',
  })
  totals!: JuristicImportTotalsDto | null;
  @ApiProperty({ type: JuristicImportReconciliationDto, nullable: true })
  reconciliation!: JuristicImportReconciliationDto | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { floor: 25, unit: 500, party: 530, unit_ownership: 512, invoice: 120, legacy_payment: 4800 },
    description: 'What the commit created, per entity (empty before the commit).',
  })
  created!: Record<string, number>;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) committedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) liveAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) rolledBackAt!: string | null;
  @ApiProperty({ type: String, nullable: true, example: null }) rollbackReason!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) parallelCycleId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) parallelRunAt!: string | null;
  @ApiProperty({
    type: [String],
    example: ['upload', 'validate', 'reconcile', 'cancel'],
    description:
      'What the caller can do now: upload · validate · reconcile · commit · cancel · parallel_cycle · rollback · go_live · export.',
  })
  nextActions!: string[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ example: 3 }) version!: number;
}

export class JuristicImportRowDto {
  @ApiProperty({ enum: ImportSheetName, enumName: 'ImportSheet' }) sheet!: ImportSheetName;
  @ApiProperty({ example: 7, description: 'Row number in the file (the header is row 1).' }) rowNo!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    example: { unit_no: 'A-1201', owner_name: 'สมชาย ใจดี', id_last4: null },
    description: 'The normalised values (ID: the last 4 only; refused values are never kept).',
  })
  data!: Record<string, string | null>;
  @ApiProperty({ type: [ImportRowErrorDto] }) errors!: ImportRowErrorDto[];
  @ApiProperty({ type: [ImportRowErrorDto] }) warnings!: ImportRowErrorDto[];
}

export class JuristicImportPreviewFloorDto {
  @ApiProperty({ example: 12 }) level!: number;
  @ApiProperty({ example: 'ชั้น 12' }) name!: string;
}

export class JuristicImportPreviewInvoiceDto {
  @ApiProperty({ example: 'A-1201' }) unitNo!: string;
  @ApiProperty({ example: 'สมชาย ใจดี' }) ownerName!: string;
  @ApiProperty({ example: 'สมชาย ใจดี' }) billedName!: string;
  @ApiProperty({ format: 'date', example: '2026-07-01' }) periodStart!: string;
  @ApiProperty({ format: 'date', example: '2026-10-31' }) periodEnd!: string;
  @ApiProperty({ example: 4 }) lines!: number;
  @MoneyOutput({ example: '4197.40', description: 'The opening balance.' }) total!: string;
}

export class JuristicImportPreviewDto {
  @ApiProperty({ type: JuristicImportTotalsDto }) totals!: JuristicImportTotalsDto;
  @ApiProperty({ type: [JuristicImportPreviewFloorDto] }) floorsToCreate!: JuristicImportPreviewFloorDto[];
  @ApiProperty({
    type: [JuristicImportPreviewInvoiceDto],
    description: 'The opening balances, largest first (≤ 200).',
  })
  openingBalances!: JuristicImportPreviewInvoiceDto[];
  @ApiProperty({ example: false }) truncated!: boolean;
}

export class JuristicCycleDifferenceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) unitId!: string | null;
  @ApiProperty({ example: 'A-1201' }) unitNo!: string;
  @MoneyOutput({ example: '1043.10', description: 'What the cycle computed for the unit.' })
  computed!: string;
  @MoneyOutput({ example: '1043.10', description: 'What the legacy system billed.' }) legacy!: string;
  @MoneyOutput({ example: '0.00', description: 'computed − legacy.' }) difference!: string;
  @ApiProperty({ type: String, nullable: true, example: null }) explanation!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) explainedAt!: string | null;
}

export class JuristicParallelCycleSummaryDto {
  @ApiProperty({ example: 500 }) units!: number;
  @ApiProperty({ example: 498 }) matching!: number;
  @ApiProperty({ example: 2 }) different!: number;
  @ApiProperty({ example: 1 }) unexplained!: number;
  @MoneyOutput({ example: '521550.00', description: 'Σ computed.' }) computedTotal!: string;
  @MoneyOutput({ example: '521600.00', description: 'Σ legacy.' }) legacyTotal!: string;
  @MoneyOutput({ example: '-50.00', description: 'Σ difference.' }) differenceTotal!: string;
}

export class JuristicParallelCycleReportDto {
  @ApiProperty({ format: 'uuid' }) importJobId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) billingCycleId!: string | null;
  @ApiProperty({ type: String, example: '2026-11', nullable: true }) periodKey!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) runAt!: string | null;
  @ApiProperty({ type: JuristicParallelCycleSummaryDto }) summary!: JuristicParallelCycleSummaryDto;
  @ApiProperty({ type: [JuristicCycleDifferenceDto] }) differences!: JuristicCycleDifferenceDto[];
}

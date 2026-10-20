import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// --------------------------------------------------------------------------------------------------------- e-Tax

export enum EtaxStatusName {
  Queued = 'queued',
  Submitted = 'submitted',
  Signed = 'signed',
  Rejected = 'rejected',
  Failed = 'failed',
}

export enum EtaxSubjectTypeName {
  Receipt = 'receipt',
  TaxInvoice = 'tax_invoice',
  CreditNote = 'credit_note',
  DebitNote = 'debit_note',
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class EtaxListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: EtaxStatusName, enumName: 'EtaxStatus' })
  @IsOptional()
  @IsEnum(EtaxStatusName)
  status?: EtaxStatusName;

  @ApiPropertyOptional({ enum: EtaxSubjectTypeName, enumName: 'EtaxSubjectType' })
  @IsOptional()
  @IsEnum(EtaxSubjectTypeName)
  subjectType?: EtaxSubjectTypeName;

  @ApiPropertyOptional({ example: '2026-11', description: 'Issued in this Bangkok month.' })
  @IsOptional()
  @Matches(MONTH)
  month?: string;
}

export class EtaxSummaryQuery {
  @ApiProperty({ example: '2026-11', description: 'Bangkok month `YYYY-MM`.' })
  @Matches(MONTH)
  month!: string;
}

export class EtaxSubmissionDto {
  @ApiProperty({ type: [String], example: [] })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ enum: EtaxSubjectTypeName, enumName: 'EtaxSubjectType', example: 'receipt' })
  subjectType!: EtaxSubjectTypeName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The receipt / tax invoice.' })
  subjectId!: string;

  @ApiProperty({ example: 'RC2611-0001' })
  number!: string;

  @ApiProperty({
    example: 'T01',
    description:
      'ETDA document type (ขมธอ. 3-2560): T01 receipt, T03 receipt / tax invoice, 388 tax invoice.',
  })
  documentTypeCode!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ example: '4500.00', description: 'Unit: THB' })
  subtotal!: string;

  @ApiProperty({ example: '0.00', description: 'Unit: THB' })
  vatAmount!: string;

  @ApiProperty({ example: '4500.00', description: 'Unit: THB' })
  total!: string;

  @ApiProperty({ example: 'inet' })
  provider!: string;

  @ApiProperty({ type: String, nullable: true, example: 'TX-20261101-0001' })
  providerDocId!: string | null;

  @ApiProperty({ enum: EtaxStatusName, enumName: 'EtaxStatus', example: 'signed' })
  status!: EtaxStatusName;

  @ApiProperty({ type: 'integer', example: 1 })
  attempts!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  nextAttemptAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid, description: 'Our PDF.' })
  sourceDocumentId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'The provider-signed PDF/A-3 (download with `GET /v1/owner/files/{fileId}`).',
  })
  signedPdfDocumentId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  signedXmlDocumentId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  submittedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  signedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  error!: string | null;
}

export class EtaxStatusCountsDto {
  @ApiProperty({ type: 'integer', example: 0 })
  queued!: number;
  @ApiProperty({ type: 'integer', example: 0 })
  submitted!: number;
  @ApiProperty({ type: 'integer', example: 120 })
  signed!: number;
  @ApiProperty({ type: 'integer', example: 1 })
  rejected!: number;
  @ApiProperty({ type: 'integer', example: 0 })
  failed!: number;
}

export class EtaxSignedTotalsDto {
  @ApiProperty({ type: 'integer', example: 120 })
  documents!: number;
  @ApiProperty({ example: '540000.00', description: 'Unit: THB' })
  subtotal!: string;
  @ApiProperty({ example: '1260.00', description: 'Unit: THB' })
  vatAmount!: string;
  @ApiProperty({ example: '541260.00', description: 'Unit: THB' })
  total!: string;
}

export class EtaxTypeTotalDto {
  @ApiProperty({ example: 'T01' })
  typeCode!: string;
  @ApiProperty({ type: 'integer', example: 100 })
  documents!: number;
  @ApiProperty({ example: '450000.00', description: 'Unit: THB' })
  total!: string;
}

export class EtaxSummaryDto {
  @ApiProperty({ example: '2026-11' })
  month!: string;

  @ApiProperty({ example: true, description: '`etax.enabled` at the end of the month.' })
  enabled!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'inet' })
  provider!: string | null;

  @ApiProperty({ type: () => EtaxStatusCountsDto })
  counts!: EtaxStatusCountsDto;

  @ApiProperty({ type: () => EtaxSignedTotalsDto })
  signed!: EtaxSignedTotalsDto;

  @ApiProperty({ type: () => [EtaxTypeTotalDto] })
  byType!: EtaxTypeTotalDto[];
}

// --------------------------------------------------------------------------------------------------------- TM30

export enum Tm30StatusName {
  Due = 'due',
  Generated = 'generated',
  Downloaded = 'downloaded',
  SubmittedManually = 'submitted_manually',
  Cancelled = 'cancelled',
}

export class Tm30ListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.buildingId })
  @IsOptional()
  @IsUUID()
  building?: string;

  @ApiPropertyOptional({ enum: Tm30StatusName, enumName: 'Tm30Status' })
  @IsOptional()
  @IsEnum(Tm30StatusName)
  status?: Tm30StatusName;
}

export class Tm30ExportDto {
  @ApiProperty({ type: [String], example: ['generate', 'mark-submitted', 'cancel'] })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: 'A-101' })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: 'John Smith' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'GB', description: 'ISO 3166-1 alpha-2.' })
  nationality!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-30' })
  arrivalDate!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  movedInAt!: string;

  @ApiProperty({
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'Move-in + `tm30.notify_within_hours` (24 h, Immigration Act B.E. 2522 s.38).',
  })
  dueAt!: string;

  @ApiProperty({ example: false })
  overdue!: boolean;

  @ApiProperty({ enum: Tm30StatusName, enumName: 'Tm30Status', example: 'due' })
  status!: Tm30StatusName;

  @ApiProperty({
    type: [String],
    example: ['passportNo'],
    description:
      'Fields the Immigration Bureau requires that are still missing on the party / occupant profile.',
  })
  missing!: string[];

  @ApiProperty({ example: 'immigration_xlsx_v1' })
  format!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  generatedAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  fileDocumentId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  downloadedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  submittedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Immigration receipt reference.' })
  submissionRef!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancelReason!: string | null;
}

export class Tm30GenerateDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Only these pending notifications (default: every pending one of the building).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  exportIds?: string[];
}

export class Tm30FileDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  fileDocumentId!: string;

  @ApiProperty({ example: 'tm30-A-2026-11-01.xlsx' })
  title!: string;

  @ApiProperty({ example: 'https://storage.example.com/file?X-Amz-Signature=abc' })
  url!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;

  @ApiProperty({ type: () => [Tm30ExportDto] })
  exports!: Tm30ExportDto[];
}

export class Tm30SubmittedDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'When it was submitted (default now; never in the future).',
  })
  @IsOptional()
  @IsDateString()
  submittedAt?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'TM30-6611-000123', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string | null;
}

export class Tm30CancelDto {
  @ApiProperty({ example: 'ผู้เช่าเป็นคนไทย บันทึกสัญชาติผิด', minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

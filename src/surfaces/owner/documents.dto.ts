import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsUUID, Matches, ValidateNested } from 'class-validator';

import { DocumentKindName } from '../shared/status.enums';
import { UtilityName } from './assets.dto';

/** Paper of a billing document (B4.3): A4, or the 80 mm roll of receipt printers (invoices and receipts). */
export enum DocumentPaperName {
  A4 = 'a4',
  Thermal80mm = 'thermal_80mm',
}

export class DocumentPaperQuery {
  @ApiPropertyOptional({ enum: DocumentPaperName, enumName: 'DocumentPaper', default: DocumentPaperName.A4 })
  @IsOptional()
  @IsEnum(DocumentPaperName)
  paper?: DocumentPaperName;
}

export class ResendResultDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  invoiceId!: string;

  @ApiProperty({ example: 'line', description: 'The billed party receives the invoice Flex message again.' })
  channel!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  requestedAt!: string;
}

export enum InvoiceDeliveryKindName {
  Issue = 'issue',
  Resend = 'resend',
  Reminder = 'reminder',
}

/** Delivery state of one message (`platform.notification.state` grouped for the console). */
export enum InvoiceDeliveryStatusName {
  Queued = 'queued',
  Held = 'held',
  Sent = 'sent',
  Delivered = 'delivered',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export class InvoiceDeliveryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'line', description: 'line, sms, email, in_app or web_push.' })
  channel!: string;

  @ApiProperty({
    enum: InvoiceDeliveryKindName,
    enumName: 'InvoiceDeliveryKind',
    example: InvoiceDeliveryKindName.Issue,
  })
  kind!: InvoiceDeliveryKindName;

  @ApiProperty({
    enum: InvoiceDeliveryStatusName,
    enumName: 'InvoiceDeliveryStatus',
    example: InvoiceDeliveryStatusName.Delivered,
    description:
      "`held` = waiting for quiet hours to end or for the resident's consent (D-025, D-063); `delivered` includes read; `cancelled` = not sent on purpose (no address, channel or topic switched off).",
  })
  status!: InvoiceDeliveryStatusName;

  @ApiProperty({
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'Sent, delivered or failed at; else planned for.',
  })
  at!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  error!: string | null;
}

export class InvoiceDeliveriesDto {
  @ApiProperty({ type: () => [InvoiceDeliveryDto] })
  data!: InvoiceDeliveryDto[];
}

export class ReceiptResendResultDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  receiptId!: string;

  @ApiProperty({ example: 'line', description: 'The payer receives the receipt Flex message again.' })
  channel!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  requestedAt!: string;
}

export class FinancialDocumentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: DocumentKindName, enumName: 'DocumentKind', example: DocumentKindName.PdfInvoice })
  kind!: DocumentKindName;

  @ApiProperty({ example: 'ใบแจ้งหนี้ INV-2026-00042.pdf' })
  title!: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty({ type: 'integer', example: 48211 })
  sizeBytes!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  buildingId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class FinancialDocumentListQuery extends PageQuery {
  @ApiProperty({
    example: '2026-11',
    description: 'Bangkok month the documents were generated in (YYYY-MM).',
  })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period!: string;

  @ApiPropertyOptional({ enum: DocumentKindName, enumName: 'DocumentKind' })
  @IsOptional()
  @IsEnum(DocumentKindName)
  kind?: DocumentKindName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

// ------------------------------------------------------------------------------------------- exports

/** `ops.export_kind` (D-051); B4.3 builds `document_archive_zip`, B4.5 the Excel / accounting / VAT formats. */
export enum ExportKindName {
  InvoicesXlsx = 'invoices_xlsx',
  PaymentsXlsx = 'payments_xlsx',
  ArrearsXlsx = 'arrears_xlsx',
  FlowaccountCsv = 'flowaccount_csv',
  PeakCsv = 'peak_csv',
  VatPp30 = 'vat_pp30',
  IncomeExpense = 'income_expense',
  DocumentArchiveZip = 'document_archive_zip',
  ReadingsCsv = 'readings_csv',
  Tm30 = 'tm30',
  UnitsXlsx = 'units_xlsx',
  TaxAnnualSummary = 'tax_annual_summary',
  LossReportCsv = 'loss_report_csv',
}

/** `ops.job_status`. */
export enum ExportStatusName {
  Queued = 'queued',
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
}

export class ExportParamsDto {
  @ApiPropertyOptional({ example: '2026-11', description: 'Bangkok month (YYYY-MM).' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-30',
    description: 'Arrears as of this Bangkok date (`arrears_xlsx`; default today).',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  asOf?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'One building (required for Staff limited to buildings).',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({
    enum: UtilityName,
    enumName: 'Utility',
    example: UtilityName.Electric,
    description: 'The utility of a `loss_report_csv` (with `buildingId` and the billing period).',
  })
  @IsOptional()
  @IsEnum(UtilityName)
  utility?: UtilityName;
}

export class ExportCreateDto {
  @ApiProperty({ enum: ExportKindName, enumName: 'ExportKind', example: ExportKindName.DocumentArchiveZip })
  @IsEnum(ExportKindName)
  kind!: ExportKindName;

  @ApiProperty({ type: ExportParamsDto })
  @ValidateNested()
  @Type(() => ExportParamsDto)
  params!: ExportParamsDto;
}

export class ExportDownloadDto {
  @ApiProperty({
    example: 'https://storage.example.com/export.zip?X-Amz-Signature=abc',
    description: 'Valid 5 minutes.',
  })
  url!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;
}

export class ExportJobDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: ExportKindName, enumName: 'ExportKind', example: ExportKindName.DocumentArchiveZip })
  kind!: ExportKindName;

  @ApiProperty({ enum: ExportStatusName, enumName: 'ExportStatus', example: ExportStatusName.Done })
  status!: ExportStatusName;

  @ApiProperty({ type: ExportParamsDto })
  params!: ExportParamsDto;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 24, description: 'Rows / documents in the file.' })
  rowCount!: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  error!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  requestedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  finishedAt!: string | null;

  @ApiProperty({ type: ExportDownloadDto, nullable: true, description: 'Present when done.' })
  download!: ExportDownloadDto | null;

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;
}

export class ExportListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ExportKindName, enumName: 'ExportKind' })
  @IsOptional()
  @IsEnum(ExportKindName)
  kind?: ExportKindName;
}

// ------------------------------------------------------------------------------------------- admin preview

/** The sample documents of the template preview. */
export enum DocumentSampleName {
  Invoice = 'invoice',
  CreditNote = 'credit_note',
  DebitNote = 'debit_note',
  Receipt = 'receipt',
  ReceiptAdvance = 'receipt_advance',
  TaxInvoice = 'tax_invoice',
  ReceiptTaxInvoice = 'receipt_tax_invoice',
}

export class DocumentTemplatePreviewDto {
  @ApiProperty({ enum: DocumentSampleName, enumName: 'DocumentSample', example: DocumentSampleName.Invoice })
  @IsEnum(DocumentSampleName)
  sample!: DocumentSampleName;

  @ApiPropertyOptional({ enum: DocumentPaperName, enumName: 'DocumentPaper', default: DocumentPaperName.A4 })
  @IsOptional()
  @IsEnum(DocumentPaperName)
  paper?: DocumentPaperName;
}

export class DocumentTemplatePreviewResultDto {
  @ApiProperty({ example: 'invoice_a4_th' })
  templateKey!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  templateVersion!: number;

  @ApiProperty({
    example: 'ใบแจ้งหนี้\nเลขที่ INV-2026-00042 …',
    description: 'The text of the rendered document.',
  })
  text!: string;

  @ApiProperty({ format: 'byte', example: 'JVBERi0xLjQK', description: 'The PDF (base64).' })
  pdfBase64!: string;
}

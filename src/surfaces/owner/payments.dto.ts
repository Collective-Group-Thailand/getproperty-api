import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsDateString,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { MoneyInput, MoneyOutput } from '../shared/fields';
import { PaymentStatusName } from '../shared/status.enums';
import { DocumentRefDto } from './billing.dto';

/** `ops.payment_method` (D-042, D-043). */
export enum PaymentMethodName {
  Qr = 'qr',
  TransferSlip = 'transfer_slip',
  Cash = 'cash',
  BankTransferManual = 'bank_transfer_manual',
  Card = 'card',
  Offset = 'offset',
}

/** `ops.payment_confirmation`. */
export enum PaymentConfirmationName {
  Webhook = 'webhook',
  SettlementFile = 'settlement_file',
  SlipVerified = 'slip_verified',
  SlipReview = 'slip_review',
  Manual = 'manual',
  Credit = 'credit',
}

/** Methods an operator records by hand (with evidence for a transfer). */
export enum ManualPaymentMethodName {
  Cash = 'cash',
  BankTransferManual = 'bank_transfer_manual',
}

/** `ops.slip_status` (D-043). */
export enum SlipStatusName {
  PendingVerification = 'pending_verification',
  AutoConfirmed = 'auto_confirmed',
  PendingReview = 'pending_review',
  Approved = 'approved',
  Rejected = 'rejected',
  Duplicate = 'duplicate',
}

/** Why a slip was not confirmed automatically (`ops.slip_review.reasons`, D-043, D-198). */
export enum SlipReasonName {
  NotRecognised = 'not_recognised',
  DuplicateReference = 'duplicate_reference',
  ReceiverMismatch = 'receiver_mismatch',
  AmountAboveDue = 'amount_above_due',
  AmountBelowDue = 'amount_below_due',
  AmountUnreadable = 'amount_unreadable',
  /** D-220: a QR payment of the same amount for the same payer × unit was already booked around the slip's time. */
  PossibleQrDuplicate = 'possible_qr_duplicate',
}

/** Why a provider payment was held for the owner instead of booked (`ops.payment.held_reason`, D-220). */
export enum PaymentHeldReasonName {
  QrAlreadyPaid = 'qr_already_paid',
  PossibleDuplicateTransfer = 'possible_duplicate_transfer',
}

/** `ops.receipt_kind` (D-044). */
export enum ReceiptKindName {
  Payment = 'payment',
  Deposit = 'deposit',
  Advance = 'advance',
}

/** `ops.settlement_file_status`. */
export enum SettlementFileStatusName {
  Received = 'received',
  Processed = 'processed',
  Failed = 'failed',
}

export class PaymentAllocationDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  invoiceId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'INV-2026-00042' })
  invoiceNumber!: string | null;

  @MoneyOutput({ example: '5344.00', description: 'Allocated to this invoice.' })
  amount!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  reversedAt!: string | null;
}

export class PaymentReceiptRefDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'RCP-2026-00001' })
  number!: string;

  @ApiProperty({ enum: ReceiptKindName, enumName: 'ReceiptKind' })
  kind!: ReceiptKindName;

  @ApiProperty({ example: false })
  voided!: boolean;
}

export class PaymentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: PaymentStatusName, enumName: 'PaymentStatus', example: PaymentStatusName.Confirmed })
  status!: PaymentStatusName;

  @ApiProperty({ enum: PaymentMethodName, enumName: 'PaymentMethod', example: PaymentMethodName.Qr })
  method!: PaymentMethodName;

  @ApiProperty({
    enum: PaymentConfirmationName,
    enumName: 'PaymentConfirmation',
    nullable: true,
    example: 'webhook',
  })
  confirmedVia!: PaymentConfirmationName | null;

  @MoneyOutput({ example: '5344.00', description: 'Received.' })
  amount!: string;

  @MoneyOutput({ example: '0.00', description: 'Withholding tax the payer deducted (D-051).' })
  whtAmount!: string;

  @MoneyOutput({ example: '5344.00', description: 'Allocated to invoices.' })
  allocatedTotal!: string;

  @MoneyOutput({ example: '0.00', description: 'Kept as the payer’s credit (beyond what was due).' })
  creditedAmount!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  invoiceId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  payerPartyId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.nameTh })
  payerName!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'kbank' })
  provider!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'KB202611040001' })
  providerRef!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  paidAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  confirmedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  reconciledAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  evidenceDocumentId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  slipReviewId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  reversedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  reverseReason!: string | null;

  @ApiProperty({
    enum: PaymentHeldReasonName,
    enumName: 'PaymentHeldReason',
    nullable: true,
    example: null,
    description:
      'D-220: set on a provider payment (QR callback or settlement file) held `pending` because it looks like a transfer already booked — its QR was already paid, or a slip / hand-recorded transfer of the same amount for the same payer × unit was booked within `payments.duplicate_window_hours`. A held payment is not allocated, credited or receipted until the owner confirms it (`confirm`) or dismisses it (`dismiss`).',
  })
  heldReason!: PaymentHeldReasonName | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'D-220: the booked payment this held one probably duplicates.',
  })
  duplicateOfPaymentId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  dismissedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  dismissReason!: string | null;

  @ApiProperty({ type: [PaymentAllocationDto] })
  allocations!: PaymentAllocationDto[];

  @ApiProperty({ type: [PaymentReceiptRefDto] })
  receipts!: PaymentReceiptRefDto[];

  @ApiProperty({
    type: [String],
    example: ['reverse'],
    description: '`reverse` (confirmed), `confirm` and `dismiss` (held, D-220).',
  })
  nextActions!: string[];

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class PaymentListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: PaymentStatusName, enumName: 'PaymentStatus' })
  @IsOptional()
  @IsEnum(PaymentStatusName)
  status?: PaymentStatusName;

  @ApiPropertyOptional({ enum: PaymentMethodName, enumName: 'PaymentMethod' })
  @IsOptional()
  @IsEnum(PaymentMethodName)
  method?: PaymentMethodName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Payer party.' })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-11-01',
    description: 'Paid on or after (Bangkok).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-11-30',
    description: 'Paid on or before (Bangkok).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}

export class ManualPaymentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  invoiceId!: string;

  @MoneyInput({ example: '5344.00', description: 'Received.' })
  amount!: string;

  @ApiProperty({ enum: ManualPaymentMethodName, enumName: 'ManualPaymentMethod', example: 'cash' })
  @IsEnum(ManualPaymentMethodName)
  method!: ManualPaymentMethodName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  @IsISO8601({ strict: true })
  paidAt!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Evidence (`files/presign`, kind `slip`): required for a bank transfer.',
  })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;

  @ApiPropertyOptional({ example: 'โอนผ่าน K PLUS 4 พ.ย.', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @MoneyInput({
    example: '0.00',
    description: 'Withholding tax deducted by a company payer (D-051).',
    optional: true,
  })
  whtAmount?: string;
}

// ------------------------------------------------------------------------------------------- slips

export class SlipReviewDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: SlipStatusName, enumName: 'SlipStatus', example: SlipStatusName.PendingReview })
  status!: SlipStatusName;

  @ApiProperty({
    type: [String],
    example: ['amount_below_due'],
    description:
      'Why it was not confirmed automatically: `not_recognised`, `duplicate_reference`, `receiver_mismatch`, `amount_above_due`, `amount_below_due`, `amount_unreadable`, `possible_qr_duplicate` (a QR payment of the same amount was already booked, D-220).',
  })
  reasons!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  invoiceId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'INV-2026-00042' })
  invoiceNumber!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ example: FAKE.nameTh })
  payerName!: string;

  @ApiProperty({ type: String, nullable: true, example: 'SLIP20261104A1' })
  transRef!: string | null;

  @MoneyOutput({ example: '5000.00', nullable: true, description: 'Amount read from the slip.' })
  amountDetected!: string | null;

  @MoneyOutput({ example: '5344.00', description: 'Balance of the invoice now.' })
  invoiceBalance!: string;

  @ApiProperty({ type: String, nullable: true, example: 'xxx1234' })
  receiverAccountMasked!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.nameTh })
  senderName!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  slipDatetime!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  uploadedAt!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The earlier slip with the same reference.',
  })
  duplicateOfId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  paymentId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  rejectReason!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://storage.example.com/slip.jpg?X-Amz-Signature=abc',
    description: 'The slip image (5 minutes; owner views only).',
  })
  imageUrl!: string | null;

  @ApiProperty({ type: [String], example: ['approve', 'reject'] })
  nextActions!: string[];

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;
}

export class SlipReviewListQuery extends PageQuery {
  @ApiPropertyOptional({
    enum: SlipStatusName,
    enumName: 'SlipStatus',
    description: 'Default: waiting for review (pending_review + duplicate).',
  })
  @IsOptional()
  @IsEnum(SlipStatusName)
  status?: SlipStatusName;
}

export class SlipDecisionDto {
  @ApiProperty({ enum: ['approve', 'reject'], enumName: 'SlipDecision', example: 'approve' })
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';

  @MoneyInput({
    example: '5344.00',
    description: 'Approve: the amount received (default: read from the slip).',
    optional: true,
  })
  amount?: string;

  @ApiPropertyOptional({ example: 'ยอดเงินไม่ตรงกับบัญชีที่ได้รับ', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ------------------------------------------------------------------------------------------- settlements

export class SettlementFileDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'kbank' })
  provider!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  bankAccountId!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-11-04' })
  statementDate!: string;

  @ApiProperty({ enum: SettlementFileStatusName, enumName: 'SettlementFileStatus', example: 'processed' })
  status!: SettlementFileStatusName;

  @ApiProperty({ type: 'integer', example: 12 })
  rowsTotal!: number;

  @ApiProperty({ type: 'integer', example: 11 })
  rowsMatched!: number;

  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'Payments created for callbacks that never came.',
  })
  rowsCreated!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  rowsUnmatched!: number;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [],
    description: 'Rows that do not match (unknown reference, another merchant, amount differs).',
  })
  discrepancies!: Record<string, unknown>[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  processedAt!: string | null;
}

export class SettlementUploadDto {
  @ApiProperty({ format: 'uuid', description: 'The receiving account the statement is of.' })
  @IsUUID()
  bankAccountId!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-11-04' })
  @IsDateString({ strict: true })
  statementDate!: string;

  @ApiProperty({ format: 'uuid', description: 'The statement file (`files/presign`, kind `other`).' })
  @IsUUID()
  documentId!: string;
}

// ------------------------------------------------------------------------------------------- receipts & credits

export class ReceiptDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'RCP-2026-00001' })
  number!: string;

  @ApiProperty({ enum: ReceiptKindName, enumName: 'ReceiptKind', example: 'payment' })
  kind!: ReceiptKindName;

  @MoneyOutput({ example: '5344.00', description: 'Received.' })
  amount!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  paymentId!: string | null;

  @ApiProperty({ example: FAKE.nameTh })
  payerName!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  voidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  voidReason!: string | null;

  @ApiProperty({ example: true, description: 'Its PDF is ready.' })
  hasDocument!: boolean;
}

export class ReceiptListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  paymentId?: string;
}

export class PayerCreditDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  partyName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @MoneyOutput({ example: '252.00', description: 'Credit balance (used on the next invoice, or refunded).' })
  balance!: string;
}

export class PayerCreditQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class RefundCreateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  partyId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  unitId!: string;

  @MoneyInput({ example: '252.00', description: 'Paid back (≤ the credit balance).' })
  amount!: string;

  @ApiProperty({ enum: ['bank_transfer', 'cash'], enumName: 'CreditRefundMethod', example: 'bank_transfer' })
  @IsIn(['bank_transfer', 'cash'])
  method!: 'bank_transfer' | 'cash';

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  @IsISO8601({ strict: true })
  refundedAt!: string;

  @ApiPropertyOptional({ example: 'โอนคืน 10 พ.ย.', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Transfer evidence (required for a bank transfer).' })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RefundResultDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  refundId!: string;

  @MoneyOutput({ example: '252.00', description: 'Refunded.' })
  amount!: string;

  @MoneyOutput({ example: '0.00', description: 'Credit left.' })
  creditAfter!: string;
}

// ------------------------------------------------------------------------------------------- resident

export class ResidentQrDto {
  @ApiProperty({
    example: '00020101021230…6304ABCD',
    description: 'EMVCo Thai QR payload (Tag 30) to render.',
  })
  payload!: string;

  @MoneyOutput({ example: '5344.00', description: 'Amount encoded in the QR.' })
  amount!: string;

  @ApiProperty({ example: 'INV202600042' })
  reference!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  expiresAt!: string | null;
}

export class ResidentAccountDto {
  @ApiProperty({ example: 'ธนาคารกสิกรไทย' })
  bankNameTh!: string;

  @ApiProperty({ example: 'บริษัท ตัวอย่าง จำกัด' })
  accountName!: string;

  @ApiProperty({ example: 'xxx-x-x1234-x' })
  accountNoMasked!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1234567890',
    description:
      'The landlord’s receiving account in full (digits), for typing into a banking app — only while something is due; every reveal is audited (`pii.decrypted`, purpose `resident_transfer`; D-043, D-209). Null when nothing is due.',
  })
  accountNo!: string | null;

  @ApiProperty({
    example: '004',
    description: 'Bank code (Bank of Thailand), to offer that bank’s app first.',
  })
  bankCode!: string;
}

/** LIFF #30 (D-228): my transfers for an invoice the office is checking — a count and a time, nothing of the duplicate. */
export class ResidentPaymentCheckingDto {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    example: 1,
    description: 'How many of my payments for this invoice are held for the office.',
  })
  count!: number;

  @ApiProperty({
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'When the oldest of them was received.',
  })
  since!: string;
}

export class ResidentPaymentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  invoiceId!: string;

  @ApiProperty({ example: 'INV-2026-00042' })
  number!: string;

  @MoneyOutput({
    example: '5344.00',
    description: 'Due now (this invoice and earlier unpaid ones, oldest paid first).',
  })
  due!: string;

  @ApiProperty({
    type: ResidentQrDto,
    nullable: true,
    description: 'Null when nothing is due or the landlord takes no QR payments.',
  })
  qr!: ResidentQrDto | null;

  @ApiProperty({
    type: ResidentAccountDto,
    nullable: true,
    description: 'For a plain transfer (then upload the slip).',
  })
  account!: ResidentAccountDto | null;

  @ApiProperty({ example: true })
  allowSlip!: boolean;

  @ApiProperty({ example: false })
  allowPartial!: boolean;

  @ApiProperty({
    type: ResidentPaymentCheckingDto,
    nullable: true,
    description:
      'A QR / bank-settlement payment of mine for this invoice that looks like a transfer already booked is held for the office to check (D-220, D-228): the pay sheet says “a transfer is being checked by the office”. The bill (`due`, the invoice status) stays what decides; null when nothing of mine is held.',
  })
  checking!: ResidentPaymentCheckingDto | null;
}

export class ResidentSlipDto {
  @ApiProperty({
    format: 'byte',
    example: 'iVBORw0KGgo=',
    description: 'The slip image or PDF, base64 (≤ 5 MB).',
  })
  @IsString()
  @IsBase64()
  @MaxLength(7_000_000)
  image!: string;

  @ApiProperty({
    enum: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    enumName: 'SlipMimeType',
    example: 'image/jpeg',
  })
  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  mimeType!: string;
}

export class ResidentSlipResultDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: SlipStatusName, enumName: 'SlipStatus', example: SlipStatusName.PendingVerification })
  status!: SlipStatusName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  uploadedAt!: string;
}

export class ResidentReceiptDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'RCP-2026-00001' })
  number!: string;

  @ApiProperty({ enum: ReceiptKindName, enumName: 'ReceiptKind', example: 'payment' })
  kind!: ReceiptKindName;

  @MoneyOutput({ example: '5344.00', description: 'Received.' })
  amount!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ example: 'หอพักตัวอย่าง' })
  issuerName!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ example: false })
  voided!: boolean;
}

export class ResidentReceiptDetailDto extends ResidentReceiptDto {
  @ApiProperty({
    type: () => [DocumentRefDto],
    description: 'The invoices the payment of this receipt paid (LIFF #19).',
  })
  invoices!: DocumentRefDto[];

  @ApiProperty({ example: true, description: 'The PDF is ready (`GET …/receipts/{id}/document`).' })
  hasDocument!: boolean;
}

export class ResidentSlipOutcomeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: SlipStatusName, enumName: 'SlipStatus', example: SlipStatusName.PendingReview })
  status!: SlipStatusName;

  @ApiProperty({
    enum: SlipReasonName,
    enumName: 'SlipReason',
    isArray: true,
    example: [SlipReasonName.AmountBelowDue],
    description: 'Why the office checks it (empty when confirmed automatically).',
  })
  reasons!: SlipReasonName[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  uploadedAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'When it was confirmed, approved, rejected or found a duplicate; null while it waits.',
  })
  decidedAt!: string | null;
}

export class ResidentSlipOutcomesDto {
  @ApiProperty({ type: () => [ResidentSlipOutcomeDto] })
  data!: ResidentSlipOutcomeDto[];
}

export class WebhookAckDto {
  @ApiProperty({ example: true })
  received!: boolean;

  @ApiProperty({
    example: false,
    description: 'The provider event was received before (nothing done again).',
  })
  duplicate!: boolean;
}

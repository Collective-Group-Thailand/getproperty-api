import { CurrentTenant, Public, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type RawBodyRequest } from '@common/http/json-body-parser';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiCompliance,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { startOfBangkokDay } from '@common/time/bangkok';
import { PaymentWebhooksService } from '@modules/ops-payments/payment-webhooks.service';
import { type PaymentRow, PaymentsService } from '@modules/ops-payments/payments.service';
import { ReceiptsService } from '@modules/ops-payments/receipts.service';
import { ResidentPaymentsService } from '@modules/ops-payments/resident-payments.service';
import { SettlementsService } from '@modules/ops-payments/settlements.service';
import { type SlipRow, SlipsService } from '@modules/ops-payments/slips.service';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { type PaymentStatusName } from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';
import { DocumentDownloadDto } from './deposits.dto';
import { ReceiptResendResultDto } from './documents.dto';
import { ReasonDto } from './governance.dto';
import {
  ManualPaymentDto,
  PayerCreditDto,
  PayerCreditQuery,
  type PaymentConfirmationName,
  PaymentDto,
  PaymentListQuery,
  type PaymentMethodName,
  ReceiptDto,
  type ReceiptKindName,
  ReceiptListQuery,
  RefundCreateDto,
  RefundResultDto,
  ResidentPaymentDto,
  ResidentReceiptDetailDto,
  ResidentReceiptDto,
  ResidentSlipDto,
  ResidentSlipOutcomesDto,
  ResidentSlipResultDto,
  SettlementFileDto,
  type SettlementFileStatusName,
  SettlementUploadDto,
  SlipDecisionDto,
  type SlipReasonName,
  SlipReviewDto,
  SlipReviewListQuery,
  type SlipStatusName,
  WebhookAckDto,
} from './payments.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', 'asset.read_only', ...T] as const;
const m2 = (d: { toFixed(n: number): string }) => d.toFixed(2);
const dayAfter = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function paymentDto(p: PaymentRow): PaymentDto {
  return {
    id: p.id,
    status: p.status as PaymentStatusName,
    method: p.method as PaymentMethodName,
    confirmedVia: (p.confirmedVia as PaymentConfirmationName | null) ?? null,
    amount: m2(p.amount),
    whtAmount: m2(p.whtAmount),
    allocatedTotal: m2(p.allocatedTotal),
    creditedAmount: m2(p.creditedAmount),
    invoiceId: p.invoiceId,
    payerPartyId: p.payerPartyId,
    payerName: p.payer?.displayName ?? null,
    unitId: p.unitId,
    unitNo: p.unit?.unitNo ?? null,
    provider: p.provider,
    providerRef: p.providerRef,
    paidAt: iso(p.paidAt),
    confirmedAt: isoOrNull(p.confirmedAt),
    reconciledAt: isoOrNull(p.reconciledAt),
    evidenceDocumentId: p.evidenceDocumentId,
    slipReviewId: p.slipReviewId,
    notes: p.notes,
    reversedAt: isoOrNull(p.reversedAt),
    reverseReason: p.reverseReason,
    allocations: p.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoice.number,
      amount: m2(a.amount),
      reversedAt: isoOrNull(a.reversedAt),
    })),
    receipts: p.receipts.map((r) => ({
      id: r.id,
      number: r.number,
      kind: r.kind as ReceiptKindName,
      voided: r.voidedAt !== null,
    })),
    nextActions: p.status === 'confirmed' ? ['reverse'] : [],
    version: p.version,
  };
}

function slipDto(s: SlipRow, imageUrl: string | null = null): SlipReviewDto {
  return {
    id: s.id,
    status: s.status as SlipStatusName,
    reasons: s.reasons,
    invoiceId: s.invoiceId,
    invoiceNumber: s.invoice.number,
    unitNo: s.unit?.unitNo ?? null,
    payerName: s.payer.displayName,
    transRef: s.transRef,
    amountDetected: s.amountDetected ? m2(s.amountDetected) : null,
    invoiceBalance: m2(s.invoice.balance),
    receiverAccountMasked: s.receiverAccountMasked,
    senderName: s.senderName,
    slipDatetime: isoOrNull(s.slipDatetime),
    uploadedAt: iso(s.uploadedAt),
    duplicateOfId: s.duplicateOfId,
    paymentId: s.paymentId,
    rejectReason: s.rejectReason,
    imageUrl,
    nextActions: ['pending_review', 'duplicate'].includes(s.status) ? ['approve', 'reject'] : [],
    version: s.version,
  };
}

const PAYMENT_EXAMPLE: PaymentDto = {
  id: FAKE.uuid,
  status: 'confirmed' as PaymentStatusName,
  method: 'qr' as PaymentMethodName,
  confirmedVia: 'webhook' as PaymentConfirmationName,
  amount: '5344.00',
  whtAmount: '0.00',
  allocatedTotal: '5344.00',
  creditedAmount: '0.00',
  invoiceId: FAKE.uuid,
  payerPartyId: FAKE.uuid,
  payerName: FAKE.nameTh,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  provider: 'kbank',
  providerRef: 'KB202611040001',
  paidAt: FAKE.dateTime,
  confirmedAt: FAKE.dateTime,
  reconciledAt: null,
  evidenceDocumentId: null,
  slipReviewId: null,
  notes: null,
  reversedAt: null,
  reverseReason: null,
  allocations: [
    { invoiceId: FAKE.uuid, invoiceNumber: 'INV-2026-00042', amount: '5344.00', reversedAt: null },
  ],
  receipts: [{ id: FAKE.uuid, number: 'RCP-2026-00001', kind: 'payment' as ReceiptKindName, voided: false }],
  nextActions: ['reverse'],
  version: 1,
};
const SLIP_EXAMPLE: SlipReviewDto = {
  id: FAKE.uuid,
  status: 'pending_review' as SlipStatusName,
  reasons: ['amount_below_due'],
  invoiceId: FAKE.uuid,
  invoiceNumber: 'INV-2026-00042',
  unitNo: FAKE.unitCode,
  payerName: FAKE.nameTh,
  transRef: 'SLIP20261104A1',
  amountDetected: '5000.00',
  invoiceBalance: '5344.00',
  receiverAccountMasked: 'xxx1234',
  senderName: FAKE.nameTh,
  slipDatetime: FAKE.dateTime,
  uploadedAt: FAKE.dateTime,
  duplicateOfId: null,
  paymentId: null,
  rejectReason: null,
  imageUrl: 'https://storage.example.com/slip.jpg?X-Amz-Signature=abc',
  nextActions: ['approve', 'reject'],
  version: 2,
};
const SETTLEMENT_EXAMPLE: SettlementFileDto = {
  id: FAKE.uuid,
  provider: 'kbank',
  bankAccountId: FAKE.uuid,
  statementDate: '2026-11-04',
  status: 'processed' as SettlementFileStatusName,
  rowsTotal: 12,
  rowsMatched: 11,
  rowsCreated: 1,
  rowsUnmatched: 0,
  discrepancies: [],
  processedAt: FAKE.dateTime,
};
const RECEIPT_EXAMPLE: ReceiptDto = {
  id: FAKE.uuid,
  number: 'RCP-2026-00001',
  kind: 'payment' as ReceiptKindName,
  amount: '5344.00',
  issuedAt: FAKE.dateTime,
  paymentId: FAKE.uuid,
  payerName: FAKE.nameTh,
  unitNo: FAKE.unitCode,
  voidedAt: null,
  voidReason: null,
  hasDocument: true,
};
const DOWNLOAD_EXAMPLE: DocumentDownloadDto = {
  documentId: FAKE.uuid,
  number: 'RCP-2026-00001',
  url: 'https://storage.example.com/receipt.pdf?X-Amz-Signature=abc',
  expiresAt: FAKE.dateTime,
};

// ------------------------------------------------------------------------------------------- owner payments

@ApiTags('owner.payments')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly slips: SlipsService,
    private readonly settlements: SettlementsService,
    private readonly receipts: ReceiptsService,
  ) {}

  @Get('payments')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.payments.list',
    summary: 'Payments',
    description:
      'Money received into my own account (D-042): by QR callback, settlement file, slip, or recorded by hand; with its allocation over invoices (oldest first), credit and receipts.',
    implements: ['D-042', 'D-044'],
  })
  @ApiPaginated(PaymentDto, { example: PAYMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: PaymentListQuery): Promise<Page<PaymentDto>> {
    const { rows, total } = await this.payments.list(ctx, {
      status: q.status,
      method: q.method,
      invoiceId: q.invoiceId,
      partyId: q.partyId,
      unitId: q.unitId,
      buildingId: q.buildingId,
      from: q.from ? startOfBangkokDay(q.from) : undefined,
      to: q.to ? startOfBangkokDay(dayAfter(q.to)) : undefined,
      ...toSkipTake(q),
    });
    return paginated(rows.map(paymentDto), total, q);
  }

  @Get('payments/:paymentId')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.payments.get',
    summary: 'One payment',
    description: 'Payment with its allocations, credit, receipts and how it was confirmed (D-042, D-044).',
    implements: ['D-042', 'D-044'],
  })
  @ApiSuccess(200, { description: 'The payment', type: PaymentDto, example: PAYMENT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('paymentId', ParseUUIDPipe) id: string,
  ): Promise<PaymentDto> {
    return paymentDto(await this.payments.get(ctx, id));
  }

  @Post('payments')
  @Idempotent()
  @TenantScoped()
  @Can('payment.record')
  @ApiEndpoint({
    id: 'owner.payments.record',
    summary: 'Record a cash or transfer payment',
    description:
      'Money received outside the QR flow: cash, or a transfer with its evidence (required). Allocated to the payer’s open invoices of the unit oldest first; beyond what is due becomes their credit; less than due needs `payments.allow_partial` (D-044). Audited; the receipt follows.',
    implements: ['D-043', 'D-044', 'D-051'],
  })
  @ApiJsonBody(ManualPaymentDto, {
    invoiceId: FAKE.uuid,
    amount: '5344.00',
    method: 'cash',
    paidAt: FAKE.dateTime,
    reference: 'รับเงินสดที่สำนักงาน',
  })
  @ApiSuccess(201, {
    description: 'Recorded',
    type: PaymentDto,
    example: {
      ...PAYMENT_EXAMPLE,
      method: 'cash' as PaymentMethodName,
      confirmedVia: 'manual' as PaymentConfirmationName,
      provider: null,
      providerRef: null,
    },
  })
  @ApiStandardErrors('payment.partial_not_allowed', 'invoice.invalid_state', 'invoice.nothing_due', ...WRITE)
  async record(@CurrentTenant() ctx: TenantContext, @Body() body: ManualPaymentDto): Promise<PaymentDto> {
    return paymentDto(
      await this.payments.recordManual(ctx, {
        invoiceId: body.invoiceId,
        amount: body.amount,
        method: body.method,
        paidAt: new Date(body.paidAt),
        evidenceDocumentId: body.evidenceDocumentId ?? null,
        reference: body.reference ?? null,
        notes: body.notes ?? null,
        whtAmount: body.whtAmount ?? null,
      }),
    );
  }

  @Post('payments/:paymentId/actions/reverse')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('payment.record')
  @ApiEndpoint({
    id: 'owner.payments.reverse',
    summary: 'Reverse a payment',
    description:
      'A payment recorded by mistake or charged back: its allocations are undone (the invoices owe again), its credit withdrawn (refused when already used: `payment.credit_used`), its receipt voided; audited (D-044).',
    implements: ['D-044'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'บันทึกซ้ำ' })
  @ApiSuccess(200, {
    description: 'Reversed',
    type: PaymentDto,
    example: {
      ...PAYMENT_EXAMPLE,
      status: 'reversed' as PaymentStatusName,
      reversedAt: FAKE.dateTime,
      reverseReason: 'บันทึกซ้ำ',
      nextActions: [],
    },
  })
  @ApiStandardErrors('payment.invalid_state', 'payment.credit_used', ...WRITE)
  async reverse(
    @CurrentTenant() ctx: TenantContext,
    @Param('paymentId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<PaymentDto> {
    return paymentDto(await this.payments.reverse(ctx, id, body.reason));
  }

  @Get('slip-reviews')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.slipReviews.list',
    summary: 'Slips waiting for review',
    description:
      'Transfer slips the verifier could not confirm (D-043): with the reasons, the amount read, the receiving account and the earlier slip of the same reference (duplicate warning).',
    implements: ['D-043'],
  })
  @ApiPaginated(SlipReviewDto, { example: { ...SLIP_EXAMPLE, imageUrl: null } })
  @ApiStandardErrors('validation.failed', ...T)
  async slipList(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: SlipReviewListQuery,
  ): Promise<Page<SlipReviewDto>> {
    const { rows, total } = await this.slips.list(ctx, { status: q.status, ...toSkipTake(q) });
    return paginated(
      rows.map((r) => slipDto(r)),
      total,
      q,
    );
  }

  @Get('slip-reviews/:slipReviewId')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.slipReviews.get',
    summary: 'One slip with its image',
    description:
      'The slip, what the verifier read and a 5-minute link to the image (download audited, D-043, D-025).',
    implements: ['D-043', 'D-025'],
  })
  @ApiSuccess(200, { description: 'The slip', type: SlipReviewDto, example: SLIP_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async slipGet(
    @CurrentTenant() ctx: TenantContext,
    @Param('slipReviewId', ParseUUIDPipe) id: string,
  ): Promise<SlipReviewDto> {
    const slip = await this.slips.get(ctx, id);
    return slipDto(slip, (await this.slips.slipLink(ctx, id)).url);
  }

  @Post('slip-reviews/:slipReviewId/actions/decide')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('payment.record')
  @ApiEndpoint({
    id: 'owner.slipReviews.decide',
    summary: 'Approve or reject a slip',
    description:
      'Approve: the payment of the slip amount (or the amount entered) is recorded and allocated — less than due needs `payments.allow_partial`; reject with a reason. Audited (D-043).',
    implements: ['D-043', 'D-044'],
  })
  @ApiJsonBody(SlipDecisionDto, { action: 'approve', amount: '5344.00' })
  @ApiSuccess(200, {
    description: 'Decided',
    type: SlipReviewDto,
    example: {
      ...SLIP_EXAMPLE,
      status: 'approved' as SlipStatusName,
      paymentId: FAKE.uuid,
      nextActions: [],
      imageUrl: null,
    },
  })
  @ApiStandardErrors('slip.invalid_state', 'payment.partial_not_allowed', 'invoice.nothing_due', ...WRITE)
  async decide(
    @CurrentTenant() ctx: TenantContext,
    @Param('slipReviewId', ParseUUIDPipe) id: string,
    @Body() body: SlipDecisionDto,
  ): Promise<SlipReviewDto> {
    return slipDto(await this.slips.decide(ctx, id, body));
  }

  @Get('payment-settlements')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.paymentSettlements.list',
    summary: 'Settlement reconciliations',
    description:
      'Daily (worker) and uploaded provider statements: rows matched, payments created for missed callbacks, discrepancies (D-042).',
    implements: ['D-042'],
  })
  @ApiPaginated(SettlementFileDto, { example: SETTLEMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async settlementList(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ReceiptListQuery,
  ): Promise<Page<SettlementFileDto>> {
    const { rows, total } = await this.settlements.list(ctx, toSkipTake(q));
    return paginated(rows.map(settlementDto), total, q);
  }

  @Post('payment-settlements')
  @Idempotent()
  @TenantScoped()
  @Can('payment.record')
  @ApiEndpoint({
    id: 'owner.paymentSettlements.upload',
    summary: 'Reconcile a provider statement file',
    description:
      'Upload the statement first (`files/presign`); each row is matched by its provider reference: known → matched, our QR reference → the payment is created (a callback was missed), otherwise a discrepancy. One file per account and date (`settlement.duplicate`, D-042).',
    implements: ['D-042'],
  })
  @ApiJsonBody(SettlementUploadDto, {
    bankAccountId: FAKE.uuid,
    statementDate: '2026-11-04',
    documentId: FAKE.uuid,
  })
  @ApiSuccess(201, { description: 'Reconciled', type: SettlementFileDto, example: SETTLEMENT_EXAMPLE })
  @ApiStandardErrors('settlement.duplicate', 'settlement.unreadable', 'payment.unavailable', ...WRITE)
  async settlementUpload(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: SettlementUploadDto,
  ): Promise<SettlementFileDto> {
    return settlementDto(await this.settlements.upload(ctx, body));
  }

  @Get('receipts')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.receipts.list',
    summary: 'Receipts',
    description:
      'One receipt per payment received (advance receipt when nothing was due), voided with a reversed payment (D-044).',
    implements: ['D-044', 'D-050'],
  })
  @ApiPaginated(ReceiptDto, { example: RECEIPT_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async receiptList(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ReceiptListQuery,
  ): Promise<Page<ReceiptDto>> {
    const { rows, total } = await this.receipts.list(ctx, {
      partyId: q.partyId,
      unitId: q.unitId,
      paymentId: q.paymentId,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((r) => ({
        id: r.id,
        number: r.number,
        kind: r.kind as ReceiptKindName,
        amount: m2(r.amount),
        issuedAt: iso(r.issuedAt),
        paymentId: r.paymentId,
        payerName: r.payer.displayName,
        unitNo: r.unit?.unitNo ?? null,
        voidedAt: isoOrNull(r.voidedAt),
        voidReason: r.voidReason,
        hasDocument: r.documentId !== null,
      })),
      total,
      q,
    );
  }

  @Get('receipts/:receiptId/document')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.receipts.document',
    summary: 'Download a receipt (PDF)',
    description: 'The receipt PDF, a 5-minute link (D-044, D-050).',
    implements: ['D-044', 'D-050'],
  })
  @ApiSuccess(200, { description: 'Link', type: DocumentDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'export.not_ready', 'validation.failed', ...T)
  async receiptDocument(
    @CurrentTenant() ctx: TenantContext,
    @Param('receiptId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const { receipt, link } = await this.receipts.document(ctx, id);
    return {
      documentId: receipt.documentId!,
      number: receipt.number,
      url: link.url,
      expiresAt: iso(link.expiresAt),
    };
  }

  @Post('receipts/:receiptId/actions/resend')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('receipt.issue')
  @ApiEndpoint({
    id: 'owner.receipts.resend',
    summary: 'Send a receipt to the payer again',
    description:
      'The receipt LINE Flex message (number, amount, link) goes to the payer again — quiet hours and consent apply; audited `document.resent` (web F2 documents archive: a resident lost a receipt). Voided receipts are not sent (409 `payment.invalid_state`). D-044, D-208.',
    implements: ['D-044', 'D-025', 'D-208'],
  })
  @ApiSuccess(200, {
    description: 'Queued',
    type: ReceiptResendResultDto,
    example: { receiptId: FAKE.uuid, channel: 'line', requestedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('payment.invalid_state', 'http.not_found', 'validation.failed', ...T)
  async receiptResend(
    @CurrentTenant() ctx: TenantContext,
    @Param('receiptId', ParseUUIDPipe) id: string,
  ): Promise<ReceiptResendResultDto> {
    const r = await this.receipts.resend(ctx, id);
    return { receiptId: r.receiptId, channel: 'line', requestedAt: iso(r.requestedAt) };
  }

  @Get('payer-credits')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.payerCredits.list',
    summary: 'Payers’ credit balances',
    description:
      'Money received beyond what was due, per payer × unit (D-044): used automatically on the next invoice, or refunded with evidence.',
    implements: ['D-044'],
  })
  @ApiSuccess(200, {
    description: 'Balances',
    type: [PayerCreditDto],
    example: [
      {
        partyId: FAKE.uuid,
        partyName: FAKE.nameTh,
        unitId: FAKE.uuid,
        unitNo: FAKE.unitCode,
        balance: '252.00',
      },
    ],
  })
  @ApiStandardErrors('validation.failed', ...T)
  async credits(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: PayerCreditQuery,
  ): Promise<PayerCreditDto[]> {
    return this.payments.credits(ctx, q);
  }

  @Post('refunds')
  @Idempotent()
  @TenantScoped()
  @Can('payment.record')
  @ApiEndpoint({
    id: 'owner.refunds.create',
    summary: 'Refund a payer’s credit',
    description:
      'Pay back (part of) a payer’s credit, with the transfer evidence (required for a transfer); never more than the credit (`refund.exceeds_credit`). Audited (D-044).',
    implements: ['D-044'],
  })
  @ApiJsonBody(RefundCreateDto, {
    partyId: FAKE.uuid,
    unitId: FAKE.uuid,
    amount: '252.00',
    method: 'bank_transfer',
    refundedAt: FAKE.dateTime,
    evidenceDocumentId: FAKE.uuid,
  })
  @ApiSuccess(201, {
    description: 'Refunded',
    type: RefundResultDto,
    example: { refundId: FAKE.uuid, amount: '252.00', creditAfter: '0.00' },
  })
  @ApiStandardErrors('refund.exceeds_credit', ...WRITE)
  async refund(@CurrentTenant() ctx: TenantContext, @Body() body: RefundCreateDto): Promise<RefundResultDto> {
    const r = await this.payments.refund(ctx, { ...body, refundedAt: new Date(body.refundedAt) });
    return { refundId: r.refund.id, amount: m2(r.refund.amount), creditAfter: r.creditAfter };
  }
}

function settlementDto(f: {
  id: string;
  provider: string;
  bankAccountId: string;
  statementDate: Date;
  status: string;
  rowsTotal: number;
  rowsMatched: number;
  rowsCreated: number;
  rowsUnmatched: number;
  discrepancies: unknown;
  processedAt: Date | null;
}): SettlementFileDto {
  return {
    id: f.id,
    provider: f.provider,
    bankAccountId: f.bankAccountId,
    statementDate: f.statementDate.toISOString().slice(0, 10),
    status: f.status as SettlementFileStatusName,
    rowsTotal: f.rowsTotal,
    rowsMatched: f.rowsMatched,
    rowsCreated: f.rowsCreated,
    rowsUnmatched: f.rowsUnmatched,
    discrepancies: (f.discrepancies as Record<string, unknown>[]) ?? [],
    processedAt: isoOrNull(f.processedAt),
  };
}

// ------------------------------------------------------------------------------------------- resident

@ApiTags('resident.payments')
@ApiSurface(SURFACES.resident)
@Controller('resident')
export class ResidentPaymentsController {
  constructor(
    private readonly payments: ResidentPaymentsService,
    private readonly slips: SlipsService,
  ) {}

  @Get('invoices/:invoiceId/payment')
  @ApiEndpoint({
    id: 'resident.invoices.payment',
    summary: 'Pay an invoice: Thai QR and account',
    description:
      'What is due now (this invoice and earlier unpaid ones, oldest paid first, D-193), the Thai QR for it (Tag 30, created when missing, expired or for another amount — the money goes to the landlord’s own account, D-042), the account for a plain transfer (in full with its bank code while something is due — the reveal is audited, D-209), and whether slips and partial payments are accepted.',
    implements: ['D-042', 'D-043', 'D-154', 'D-209'],
  })
  @ApiSuccess(200, {
    description: 'Payment',
    type: ResidentPaymentDto,
    example: {
      invoiceId: FAKE.uuid,
      number: 'INV-2026-00042',
      due: '5344.00',
      qr: {
        payload: '00020101021230570016A000000677010112…6304ABCD',
        amount: '5344.00',
        reference: 'INV202600042',
        expiresAt: FAKE.dateTime,
      },
      account: {
        bankNameTh: 'ธนาคารตัวอย่าง',
        accountName: 'บริษัท ตัวอย่าง จำกัด',
        accountNoMasked: 'xxxxxx1234',
        accountNo: '1234561234',
        bankCode: '004',
      },
      allowSlip: true,
      allowPartial: false,
    },
  })
  @ApiStandardErrors('auth.unauthenticated', 'http.not_found', 'validation.failed')
  async payment(@Param('invoiceId', ParseUUIDPipe) id: string): Promise<ResidentPaymentDto> {
    const r = await this.payments.payment(id);
    return {
      invoiceId: r.invoice.id,
      number: r.invoice.number!,
      due: r.due,
      qr: r.qr
        ? {
            payload: r.qr.payload,
            amount: m2(r.qr.amount),
            reference: r.qr.reference,
            expiresAt: isoOrNull(r.qr.expiresAt),
          }
        : null,
      account: r.account
        ? {
            bankNameTh: r.account.bankNameTh,
            accountName: r.account.accountName,
            accountNoMasked: r.account.accountNoMasked,
            accountNo: r.account.accountNo,
            bankCode: r.account.bankCode,
          }
        : null,
      allowSlip: r.allowSlip,
      allowPartial: r.allowPartial,
    };
  }

  @Get('invoices/:invoiceId/slips')
  @ApiEndpoint({
    id: 'resident.invoices.slips',
    summary: 'My slips of an invoice and their outcome',
    description:
      'The slips I sent for this invoice, newest first: confirmed automatically, waiting for the office with the reasons (amount above / below what is due, receiving account mismatch, unreadable, not recognised), duplicate, approved or rejected (D-043, D-198, D-208). 404 when the invoice is not mine.',
    implements: ['D-043', 'D-154', 'D-208'],
  })
  @ApiSuccess(200, {
    description: 'My slips',
    type: ResidentSlipOutcomesDto,
    example: {
      data: [
        {
          id: FAKE.uuid,
          status: 'pending_review',
          reasons: ['amount_below_due'],
          uploadedAt: FAKE.dateTime,
          decidedAt: null,
        },
      ],
    },
  })
  @ApiStandardErrors('auth.unauthenticated', 'http.not_found', 'validation.failed')
  async slipOutcomes(@Param('invoiceId', ParseUUIDPipe) id: string): Promise<ResidentSlipOutcomesDto> {
    const rows = await this.payments.slips(id);
    return {
      data: rows.map((r) => ({
        id: r.id,
        status: r.status as SlipStatusName,
        reasons: r.reasons as SlipReasonName[],
        uploadedAt: iso(r.uploadedAt),
        decidedAt: isoOrNull(
          r.reviewedAt ?? (['auto_confirmed', 'duplicate'].includes(r.status) ? r.updatedAt : null),
        ),
      })),
    };
  }

  @Post('invoices/:invoiceId/slips')
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.invoices.uploadSlip',
    summary: 'Send the slip of a transfer',
    description:
      'The fallback when paying by transfer instead of QR (D-043, `payments.allow_slip`): the slip is verified; it is confirmed automatically when it is real, unused, to the landlord’s account and for what is due — otherwise the landlord reviews it. An optional `Idempotency-Key` makes a retry on a flaky connection answer the first slip instead of creating another (LIFF #18).',
    implements: ['D-043', 'D-154', 'D-208'],
  })
  @ApiJsonBody(ResidentSlipDto, { image: 'iVBORw0KGgo=', mimeType: 'image/jpeg' })
  @ApiSuccess(201, {
    description: 'Received',
    type: ResidentSlipResultDto,
    example: { id: FAKE.uuid, status: 'pending_verification', uploadedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(
    'auth.unauthenticated',
    'http.not_found',
    'validation.failed',
    'slip.not_allowed',
    'http.bad_request',
    'invoice.nothing_due',
    'http.payload_too_large',
  )
  async uploadSlip(
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Body() body: ResidentSlipDto,
  ): Promise<ResidentSlipResultDto> {
    const image = Buffer.from(body.image, 'base64');
    if (image.length > 5_000_000) throw new DomainException('http.payload_too_large');
    const slip = await this.slips.submit(id, { image, mimeType: body.mimeType });
    return { id: slip.id, status: slip.status as SlipStatusName, uploadedAt: iso(slip.uploadedAt) };
  }

  @Get('receipts')
  @ApiEndpoint({
    id: 'resident.receipts.list',
    summary: 'My receipts',
    description: 'Receipts of my payments, newest first (D-044, D-063).',
    implements: ['D-044', 'D-063', 'D-154'],
  })
  @ApiPaginated(ResidentReceiptDto, {
    example: {
      id: FAKE.uuid,
      number: 'RCP-2026-00001',
      kind: 'payment' as ReceiptKindName,
      amount: '5344.00',
      issuedAt: FAKE.dateTime,
      issuerName: 'หอพักตัวอย่าง',
      unitNo: FAKE.unitCode,
      voided: false,
    },
  })
  @ApiStandardErrors('auth.unauthenticated', 'validation.failed')
  async receipts(@Query() q: ReceiptListQuery): Promise<Page<ResidentReceiptDto>> {
    const { rows, total } = await this.payments.receipts(toSkipTake(q));
    return paginated(
      rows.map((r) => ({
        id: r.id,
        number: r.number,
        kind: r.kind as ReceiptKindName,
        amount: m2(r.amount),
        issuedAt: iso(r.issuedAt),
        issuerName: r.tenant.displayName,
        unitNo: r.unit?.unitNo ?? null,
        voided: r.voidedAt !== null,
      })),
      total,
      q,
    );
  }

  @Get('receipts/:receiptId')
  @ApiEndpoint({
    id: 'resident.receipts.get',
    summary: 'One of my receipts',
    description:
      'The receipt with the invoices its payment paid (the LINE receipt message links here, LIFF #19); 404 when it is not mine (D-044, D-208).',
    implements: ['D-044', 'D-154', 'D-208'],
  })
  @ApiSuccess(200, {
    description: 'The receipt',
    type: ResidentReceiptDetailDto,
    example: {
      id: FAKE.uuid,
      number: 'RCP-2026-00001',
      kind: 'payment',
      amount: '5344.00',
      issuedAt: FAKE.dateTime,
      issuerName: 'หอพักตัวอย่าง',
      unitNo: FAKE.unitCode,
      voided: false,
      invoices: [{ id: FAKE.uuid, number: 'INV-2026-00042' }],
      hasDocument: true,
    },
  })
  @ApiStandardErrors('auth.unauthenticated', 'http.not_found', 'validation.failed')
  async receipt(@Param('receiptId', ParseUUIDPipe) id: string): Promise<ResidentReceiptDetailDto> {
    const { receipt: r, invoices } = await this.payments.receipt(id);
    return {
      id: r.id,
      number: r.number,
      kind: r.kind as ReceiptKindName,
      amount: m2(r.amount),
      issuedAt: iso(r.issuedAt),
      issuerName: r.tenant.displayName,
      unitNo: r.unit?.unitNo ?? null,
      voided: r.voidedAt !== null,
      invoices,
      hasDocument: r.documentId !== null,
    };
  }

  @Get('receipts/:receiptId/document')
  @ApiEndpoint({
    id: 'resident.receipts.document',
    summary: 'Download my receipt (PDF)',
    description: 'A 5-minute link; 404 when it is not mine (D-044, D-063).',
    implements: ['D-044', 'D-063', 'D-154'],
  })
  @ApiSuccess(200, { description: 'Link', type: DocumentDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('auth.unauthenticated', 'http.not_found', 'export.not_ready', 'validation.failed')
  async receiptDocument(@Param('receiptId', ParseUUIDPipe) id: string): Promise<DocumentDownloadDto> {
    const { receipt, link } = await this.payments.receiptDocument(id);
    return {
      documentId: receipt.documentId!,
      number: receipt.number,
      url: link.url,
      expiresAt: iso(link.expiresAt),
    };
  }
}

// ------------------------------------------------------------------------------------------- webhooks

@ApiTags('webhooks.payments')
@ApiSurface(SURFACES.webhooks)
@Controller({ path: 'webhooks/payments', version: VERSION_NEUTRAL })
export class PaymentWebhooksController {
  constructor(private readonly webhooks: PaymentWebhooksService) {}

  @Post(':provider')
  @HttpCode(200)
  @Public()
  @ApiHeader({
    name: 'X-Provider-Signature',
    required: false,
    description:
      'Signature over the raw body with the merchant’s webhook secret (fake / generic: `sha256=<hex HMAC-SHA256>`; KBank `X-Kbank-Signature`, SCB `X-Scb-Signature`, Opn `Omise-Signature` + `Omise-Signature-Timestamp`).',
  })
  @ApiEndpoint({
    id: 'webhooks.payments.callback',
    summary: 'Payment provider callback',
    description:
      'KBank / SCB / Opn (O-001) POST a signed payment confirmation for a merchant. The API finds the merchant, verifies the signature with its secret (401 `webhook.signature_invalid` otherwise), stores the callback once per provider event id and answers 200 at once; the worker confirms each paid reference whose QR was issued for that same merchant account, idempotently on the provider transaction reference (D-042).',
    implements: ['D-042', 'ADR-0008'],
  })
  @ApiBody({
    required: true,
    description: 'The provider’s JSON event (per provider; the fake provider’s shape shown).',
    schema: { type: 'object', additionalProperties: true },
    examples: {
      paid: {
        summary: 'One paid reference',
        value: {
          eventId: 'evt_KB202611040001',
          merchantRef: 'M-0001',
          payments: [
            {
              providerRef: 'KB202611040001',
              reference: 'INV202600042',
              amount: '5344.00',
              paidAt: '2026-11-04T02:15:00.000Z',
              status: 'paid',
            },
          ],
        },
      },
    },
  })
  @ApiSuccess(200, {
    description: 'Accepted',
    type: WebhookAckDto,
    example: { received: true, duplicate: false },
  })
  @ApiStandardErrors(
    'webhook.signature_invalid',
    'webhook.malformed',
    'http.not_found',
    'http.malformed_json',
  )
  async callback(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | undefined>,
    @Req() req: RawBodyRequest,
  ): Promise<WebhookAckDto> {
    const r = await this.webhooks.receive(provider, headers, req.rawBody);
    return { received: true, duplicate: r.duplicate };
  }
}

export const _compliance = ApiCompliance;

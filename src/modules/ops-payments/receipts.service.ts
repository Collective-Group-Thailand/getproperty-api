import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Document, type Prisma, type Receipt, type TaxInvoice } from '@generated/prisma/client';
import { BillingDocuments } from '@modules/ops-documents/billing-documents.service';
import {
  formatAddress,
  issuerOf,
  PAYMENT_METHOD_TH,
  type ReceiptView,
  receiptView,
} from '@modules/ops-documents/document-views';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

const D = (v: { toString(): string } | Decimal.Value) => new Decimal(v.toString());

export interface ReceiptLine {
  description: string;
  reference: string | null;
  amount: string;
}

/**
 * Receipts (B4.4, D-044, D-050): every confirmed payment (not a use of credit) gets one numbered document in the
 * worker (`payment.confirmed`) — a receipt (`receipt` series; `advance` when nothing was due), or for a
 * VAT-registered tenant whose invoices carried VAT a receipt-tax invoice (`receipt_tax_invoice` series, VAT split
 * from the invoices paid). The PDF is stored and linked once, `receipt.issued` / `tax_invoice.issued` notify the
 * payer by LINE. A reversed payment voids its receipt.
 */
@Injectable()
export class ReceiptsService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'receipts';
  readonly eventTypes = ['payment.confirmed'] as const;

  constructor(
    private readonly db: TenantTx,
    private readonly numbering: DocumentNumbering,
    private readonly billing: BillingDocuments,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    await this.issueFor(tx, event.payload.paymentId as string);
  }

  async issueFor(tx: Tx, paymentId: string): Promise<Receipt | TaxInvoice | null> {
    await tx.$queryRaw`SELECT id FROM ops.payment WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const p = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { allocations: { include: { invoice: true } }, receipts: true, taxInvoices: true },
    });
    if (p.method === 'offset' || p.status !== 'confirmed' || !p.payerPartyId) return null;
    if (p.receipts.length || p.taxInvoices.length) return p.receipts[0] ?? p.taxInvoices[0]!;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId } });
    const lines: ReceiptLine[] = p.allocations.map((a) => ({
      description: a.invoice.isFinal ? 'ชำระใบแจ้งหนี้งวดสุดท้าย' : 'ชำระใบแจ้งหนี้',
      reference: a.invoice.number,
      amount: D(a.amount).toFixed(2),
    }));
    if (D(p.creditedAmount).gt(0))
      lines.push({
        description: 'รับชำระเกินยอด (เครดิตสำหรับใบแจ้งหนี้ถัดไป)',
        reference: null,
        amount: D(p.creditedAmount).toFixed(2),
      });
    // the VAT of what was paid, pro rata of each invoice's VAT (VAT-registered tenants, O-004 / O-007)
    const vat = p.allocations
      .reduce(
        (s, a) =>
          D(a.invoice.total).gt(0)
            ? s.plus(D(a.amount).times(D(a.invoice.vatAmount)).div(D(a.invoice.total)))
            : s,
        new Decimal(0),
      )
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const now = this.clock.now();
    const total = D(p.amount).plus(D(p.whtAmount));
    if (tenant.vatRegistered && vat.gt(0)) {
      const number = await this.numbering.next(tx, p.tenantId, 'receipt_tax_invoice', now);
      const row = await tx.taxInvoice.create({
        data: {
          tenantId: p.tenantId,
          buildingId: p.buildingId,
          unitId: p.unitId,
          kind: 'receipt_tax_invoice',
          invoiceId: p.invoiceId,
          paymentId: p.id,
          buyerPartyId: p.payerPartyId,
          number,
          issuedAt: now,
          subtotal: total.minus(vat).toFixed(2),
          vatAmount: vat.toFixed(2),
          total: total.toFixed(2),
        },
      });
      const doc = await this.render(tx, 'receipt_tax_invoice', row.id, p.id);
      await tx.taxInvoice.update({ where: { id: row.id }, data: { documentId: doc.id } });
      await this.announce(tx, 'tax_invoice.issued', row.id, row.number, p, row.total.toFixed(2));
      return row;
    }
    const number = await this.numbering.next(tx, p.tenantId, 'receipt', now);
    const row = await tx.receipt.create({
      data: {
        tenantId: p.tenantId,
        buildingId: p.buildingId,
        unitId: p.unitId,
        kind: p.allocations.length ? 'payment' : 'advance',
        paymentId: p.id,
        payerPartyId: p.payerPartyId,
        number,
        issuedAt: now,
        amount: total.toFixed(2),
        lines: lines as unknown as Prisma.InputJsonValue,
      },
    });
    const doc = await this.render(tx, 'receipt', row.id, p.id);
    await tx.receipt.update({ where: { id: row.id }, data: { documentId: doc.id } });
    await this.announce(tx, 'receipt.issued', row.id, row.number, p, row.amount.toFixed(2));
    return row;
  }

  /** The receipt view of a receipt / receipt-tax invoice row (PDF, Flex). */
  async viewOf(tx: Tx, kind: 'receipt' | 'receipt_tax_invoice', rowId: string): Promise<ReceiptView> {
    const row =
      kind === 'receipt'
        ? await tx.receipt.findUniqueOrThrow({ where: { id: rowId } })
        : await tx.taxInvoice.findUniqueOrThrow({ where: { id: rowId } });
    const paymentId = row.paymentId!;
    const p = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { allocations: { include: { invoice: true } }, unit: true, payer: true },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: row.tenantId } });
    const lines =
      kind === 'receipt'
        ? ((row as Receipt).lines as unknown as ReceiptLine[])
        : p.allocations.map((a) => ({
            description: 'ชำระใบแจ้งหนี้',
            reference: a.invoice.number,
            amount: D(a.amount).toFixed(2),
          }));
    const isTax = kind === 'receipt_tax_invoice';
    const tax = row as TaxInvoice;
    return receiptView({
      docType: isTax ? 'receipt_tax_invoice' : 'receipt',
      number: row.number,
      issuedOn: row.issuedAt.toISOString().slice(0, 10),
      issuer: issuerOf(
        {
          legalName: tenant.legalName,
          displayName: tenant.displayName,
          taxId: tenant.taxId,
          vatRegistered: tenant.vatRegistered,
          address: tenant.address,
          bankAccount: null,
        },
        null,
      ),
      customer: {
        name: p.payer?.displayName ?? '',
        address: isTax ? formatAddress((p.payer as { address?: unknown } | null)?.address) || null : null,
        taxId: null,
      },
      unitNo: p.unit?.unitNo ?? null,
      kind: kind === 'receipt' ? (row as Receipt).kind : 'payment',
      items: lines,
      method: PAYMENT_METHOD_TH[p.method] ?? p.method,
      paymentReference: p.providerRef,
      subtotal: isTax ? tax.subtotal.toFixed(2) : (row as Receipt).amount.toFixed(2),
      vat: isTax ? { ratePct: '7', amount: tax.vatAmount.toFixed(2) } : null,
      total: isTax ? tax.total.toFixed(2) : (row as Receipt).amount.toFixed(2),
      link: this.billing.receiptLink(row.id),
    });
  }

  private async render(
    tx: Tx,
    kind: 'receipt' | 'receipt_tax_invoice',
    rowId: string,
    paymentId: string,
  ): Promise<Document> {
    const view = await this.viewOf(tx, kind, rowId);
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const doc = await this.documents.storeGenerated(tx, {
      tenantId: p.tenantId,
      kind: kind === 'receipt' ? 'pdf_receipt' : 'pdf_tax_invoice',
      scopeType: p.unitId ? 'unit' : 'building',
      scopeId: p.unitId ?? p.buildingId,
      buildingId: p.buildingId,
      title: `${view.title} ${view.number}.pdf`,
      mimeType: 'application/pdf',
      body: await this.billing.pdf(view, 'a4'),
    });
    await this.events.record(tx, {
      type: 'document.generated',
      aggregateType: 'document',
      aggregateId: doc.id,
      tenantId: p.tenantId,
      buildingId: p.buildingId,
      payload: { documentId: doc.id, docType: kind, subjectId: rowId, number: view.number, paper: 'a4' },
    });
    return doc;
  }

  private async announce(
    tx: Tx,
    type: 'receipt.issued' | 'tax_invoice.issued',
    id: string,
    number: string,
    p: {
      id: string;
      tenantId: string;
      buildingId: string;
      payerPartyId: string | null;
      unitId: string | null;
      invoiceId: string | null;
    },
    amount: string,
  ) {
    await this.audit.record(tx, {
      action: type,
      tenantId: p.tenantId,
      buildingId: p.buildingId,
      subjectType: type === 'receipt.issued' ? 'ops.receipt' : 'ops.tax_invoice',
      subjectId: id,
      metadata: { number, paymentId: p.id, amount },
    });
    await this.events.record(tx, {
      type,
      aggregateType: type === 'receipt.issued' ? 'receipt' : 'tax_invoice',
      aggregateId: id,
      tenantId: p.tenantId,
      buildingId: p.buildingId,
      payload: {
        receiptId: id,
        kind: type === 'receipt.issued' ? 'receipt' : 'receipt_tax_invoice',
        number,
        paymentId: p.id,
        invoiceId: p.invoiceId,
        payerPartyId: p.payerPartyId,
        unitId: p.unitId,
        amount,
      },
    });
  }

  // ------------------------------------------------------------------------------------------- reads

  list(
    ctx: TenantContext,
    q: { partyId?: string; unitId?: string; paymentId?: string; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.ReceiptWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.partyId ? { payerPartyId: q.partyId } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.paymentId ? { paymentId: q.paymentId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.receipt.findMany({
          where,
          include: { payer: { select: { displayName: true } }, unit: { select: { unitNo: true } } },
          orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.receipt.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async document(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const r = this.found(
        await tx.receipt.findFirst({ where: this.own(ctx, { id }), include: { document: true } }),
      );
      if (ctx.buildingIds && !ctx.buildingIds.includes(r.buildingId))
        throw new DomainException('http.not_found');
      if (!r.document) throw new DomainException('export.not_ready');
      return { receipt: r, link: await this.documents.signedUrl(r.document) };
    });
  }
}

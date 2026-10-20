import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type DocumentKind, type Prisma } from '@generated/prisma/client';
import { InvoicesService } from '@modules/ops-billing/invoices.service';
import { ResidentInvoicesService } from '@modules/ops-billing/resident-invoices.service';
import { Inject, Injectable } from '@nestjs/common';

import { BillingDocuments } from './billing-documents.service';
import { type Paper } from './billing-templates';

export const FINANCIAL_KINDS: DocumentKind[] = [
  'pdf_invoice',
  'pdf_note',
  'pdf_receipt',
  'pdf_tax_invoice',
  'pdf_statement',
  'pdf_report',
  'contract',
];

export interface DocumentLink {
  documentId: string;
  number: string;
  url: string;
  expiresAt: Date;
}

/**
 * The document endpoints (B4.3): owner and resident downloads of invoice / note PDFs (A4 or the 80 mm roll,
 * generated on demand when the worker has not yet), the owner's "send again" (`invoice.resent` → the LINE Flex of
 * the invoice to the billed party) and the list of generated financial documents per period.
 */
@Injectable()
export class InvoiceDocumentsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly invoices: InvoicesService,
    private readonly residentInvoices: ResidentInvoicesService,
    private readonly billing: BillingDocuments,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  async invoiceDocument(ctx: TenantContext, invoiceId: string, paper: Paper): Promise<DocumentLink> {
    const inv = await this.invoices.get(ctx, invoiceId);
    if (!inv.issuedAt || !inv.number)
      throw new DomainException('invoice.invalid_state', { params: { status: inv.status } });
    const doc = await this.db.tenant(
      ctx,
      (tx) =>
        paper === 'a4'
          ? this.billing.generateInvoice(tx, invoiceId)
          : this.billing.thermalInvoice(tx, invoiceId),
      { timeout: 60_000 },
    );
    return { documentId: doc.id, number: inv.number, ...(await this.documents.signedUrl(doc)) };
  }

  async noteDocument(ctx: TenantContext, kind: 'credit' | 'debit', noteId: string): Promise<DocumentLink> {
    const note = await this.db.tenant(ctx, async (tx) => {
      const n =
        kind === 'credit'
          ? await tx.creditNote.findFirst({ where: this.own(ctx, { id: noteId }) })
          : await tx.debitNote.findFirst({ where: this.own(ctx, { id: noteId }) });
      const found = this.found(n);
      if (ctx.buildingIds && !ctx.buildingIds.includes(found.buildingId))
        throw new DomainException('http.not_found');
      return found;
    });
    const doc = await this.db.tenant(ctx, (tx) => this.billing.generateNote(tx, kind, noteId), {
      timeout: 60_000,
    });
    return { documentId: doc.id, number: note.number, ...(await this.documents.signedUrl(doc)) };
  }

  /** The resident's own issued invoice (access as `GET /v1/resident/invoices/{id}`). */
  async residentInvoiceDocument(invoiceId: string, paper: Paper): Promise<DocumentLink> {
    const inv = await this.residentInvoices.get({ id: invoiceId });
    const doc = await this.db.platform(
      (tx) =>
        paper === 'a4' ? this.billing.generateInvoice(tx, inv.id) : this.billing.thermalInvoice(tx, inv.id),
      { timeout: 60_000 },
    );
    return { documentId: doc.id, number: inv.number!, ...(await this.documents.signedUrl(doc)) };
  }

  /** `POST /v1/owner/invoices/{id}/actions/resend`: the invoice's LINE message again (audited). */
  async resend(ctx: TenantContext, invoiceId: string): Promise<{ invoiceId: string; requestedAt: Date }> {
    const inv = await this.invoices.get(ctx, invoiceId);
    if (inv.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
    if (!inv.issuedAt || inv.status === 'void')
      throw new DomainException('invoice.invalid_state', { params: { status: inv.status } });
    const now = this.clock.now();
    await this.db.tenant(ctx, async (tx) => {
      await this.audit.record(tx, {
        action: 'document.resent',
        tenantId: ctx.tenantId,
        buildingId: inv.buildingId,
        subjectType: 'ops.invoice',
        subjectId: invoiceId,
        metadata: { number: inv.number, channel: 'line' },
      });
      await this.events.record(tx, {
        type: 'invoice.resent',
        aggregateType: 'invoice',
        aggregateId: invoiceId,
        tenantId: ctx.tenantId,
        buildingId: inv.buildingId,
        payload: { invoiceId, number: inv.number, billedPartyId: inv.billedPartyId, unitId: inv.unitId },
      });
    });
    return { invoiceId, requestedAt: now };
  }

  /**
   * The delivery log of an invoice (web F2, D-208): every message planned for it — the first send once payable
   * (`invoice.payment_ready` → `issue`), the owner's resends (`invoice.resent` → `resend`) and the payment reminders
   * (`invoice.reminder_sent` → `reminder`) — per channel, with its state and failure reason, oldest first.
   */
  async deliveries(ctx: TenantContext, invoiceId: string) {
    await this.invoices.get(ctx, invoiceId);
    return this.db.tenant(ctx, (tx) =>
      tx.notification.findMany({
        where: {
          tenantId: ctx.tenantId,
          recipientType: { in: ['party', 'user'] },
          event: {
            aggregateType: 'invoice',
            aggregateId: invoiceId,
            type: { in: ['invoice.payment_ready', 'invoice.resent', 'invoice.reminder_sent'] },
          },
        },
        include: { event: { select: { type: true, occurredAt: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  /** Generated financial documents of a Bangkok month (owner archive view). */
  list(
    ctx: TenantContext,
    q: { from: Date; to: Date; kind?: DocumentKind; buildingId?: string; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.DocumentWhereInput = {
        tenantId: ctx.tenantId,
        kind: q.kind ? q.kind : { in: FINANCIAL_KINDS },
        createdAt: { gte: q.from, lt: q.to },
        deletedAt: null,
        uploadState: 'verified',
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.document.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.document.count({ where }),
      ]);
      return { rows, total };
    });
  }
}

import { actorEnvelope, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { AccessService } from '@core/tenancy/access.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type PlatformInvoice,
  type PlatformInvoiceKind,
  type PlatformPaymentMethod,
  type Prisma,
  type Subscription,
} from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { PlatformPaymentGateway } from './platform-payment-gateway';
import { type Charges } from './pricing';

export const PLATFORM_INVOICE_INCLUDE = {
  lines: { orderBy: { lineNo: 'asc' } },
  payments: { orderBy: { paidAt: 'asc' } },
  receipts: { orderBy: { issuedAt: 'asc' } },
  creditNotes: { orderBy: { requestedAt: 'asc' } },
  tenant: { select: { id: true, displayName: true, legalName: true, taxId: true, address: true } },
} as const satisfies Prisma.PlatformInvoiceInclude;
export type PlatformInvoiceRow = Prisma.PlatformInvoiceGetPayload<{
  include: typeof PLATFORM_INVOICE_INCLUDE;
}>;

/** States of a platform invoice that still expect money. */
export const OPEN_INVOICE_STATES = ['issued', 'partially_paid', 'overdue'] as const;
/** Open subscription states (one per tenant, D-082). */
export const OPEN_SUBSCRIPTION_STATES = ['trial', 'active', 'past_due', 'suspended'] as const;

const by = () => userIdOf(RequestContext.actor());

/** The QR / payment reference of a platform invoice: its number without separators (unique platform-wide). */
export const referenceOf = (number: string) => number.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export interface PlatformPaymentInput {
  amount: string;
  method: PlatformPaymentMethod;
  provider: string | null;
  providerRef: string | null;
  paidAt: Date;
  evidenceDocumentId?: string | null;
}

/**
 * Platform receivables (B6.1, D-146, D-156): Collective Group (Thailand) invoices its tenants. An invoice is numbered
 * in the platform series (tenant NULL), snapshots the plan versions, usage and company data it used, is immutable
 * apart from its payment state, QR and PDF (trigger), and gets a Thai QR through the platform's own payment adapter
 * (subscriber, after commit). Payments come from the platform merchant's signed callbacks (idempotent on the
 * provider reference) or are recorded by Finance; each one gets a numbered receipt. Credit notes are maker-checker
 * (D-091). A payment that leaves no overdue invoice reinstates the subscription (D-082).
 */
@Injectable()
export class PlatformBillingService {
  private readonly logger = new Logger(PlatformBillingService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly numbering: DocumentNumbering,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly gateway: PlatformPaymentGateway,
    private readonly access: AccessService,
    private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------- issue

  /**
   * Writes and numbers an invoice inside the caller's platform transaction; the QR and PDF follow (subscriber). A
   * `purchase` (G1: storage packages; later boosts and fees) has no subscription (D-250: subscriptions are off) —
   * pass `null` and the tenant; an unpaid purchase is simply not activated, it never suspends anyone.
   */
  async issue(
    tx: Tx,
    sub: Subscription | null,
    input: {
      tenantId?: string;
      kind: PlatformInvoiceKind;
      periodStart: string;
      periodEnd: string;
      charges: Charges;
      usageId?: string | null;
      snapshot: Record<string, unknown>;
    },
  ): Promise<PlatformInvoice> {
    const tenantId = sub?.tenantId ?? input.tenantId;
    if (!tenantId || (!sub && input.kind !== 'purchase'))
      throw new Error('platform invoice: only a purchase is issued without a subscription');
    const now = this.clock.now();
    const dueDays = await this.settings.valueAt<number>('subscription.invoice_due_days', now);
    const company = await this.settings.valueAt<Record<string, unknown>>('platform.company', now);
    const number = await this.numbering.nextPlatform(tx, 'platform_invoice', now);
    const invoice = await tx.platformInvoice.create({
      data: {
        tenantId,
        subscriptionId: sub?.id ?? null,
        usageId: input.usageId ?? null,
        kind: input.kind,
        number,
        periodStart: new Date(`${input.periodStart}T00:00:00Z`),
        periodEnd: new Date(`${input.periodEnd}T00:00:00Z`),
        issuedAt: now,
        dueAt: new Date(now.getTime() + dueDays * 86_400_000),
        subtotal: input.charges.subtotal,
        discount: input.charges.discount,
        vatAmount: input.charges.vatAmount,
        total: input.charges.total,
        state: 'issued',
        snapshot: {
          ...input.snapshot,
          issuer: company,
          charges: input.charges,
        } as unknown as Prisma.InputJsonValue,
        qrReference: referenceOf(number),
        createdBy: by(),
      },
    });
    let lineNo = 0;
    for (const l of input.charges.lines)
      await tx.platformInvoiceLine.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          lineNo: (lineNo += 1),
          kind: l.kind,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
        },
      });
    await this.audit.record(tx, {
      action: 'platform_invoice.issued',
      tenantId,
      subjectType: 'platform.platform_invoice',
      subjectId: invoice.id,
      after: {
        number,
        kind: input.kind,
        total: input.charges.total,
        period: [input.periodStart, input.periodEnd],
      },
    });
    await this.events.record(tx, {
      type: 'platform_invoice.issued',
      aggregateType: 'platform_invoice',
      aggregateId: invoice.id,
      tenantId,
      payload: {
        platformInvoiceId: invoice.id,
        subscriptionId: sub?.id ?? null,
        kind: input.kind,
        number,
        total: input.charges.total,
        dueAt: invoice.dueAt.toISOString(),
      },
    });
    return invoice;
  }

  /** Subscriber (`platform_invoice.issued`): the Thai QR of the platform merchant for the open amount. */
  async attachQr(tx: Tx, invoiceId: string): Promise<boolean> {
    const invoice = await tx.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice || invoice.qrPayload || !OPEN_INVOICE_STATES.includes(invoice.state as never)) return false;
    const open = new Decimal(invoice.total.toString())
      .minus(invoice.paidTotal.toString())
      .minus(invoice.creditedTotal.toString());
    if (open.lte(0)) return false;
    const m = await this.gateway.merchant();
    if (!m) return false;
    const expiresAt = new Date(invoice.dueAt.getTime() + 30 * 86_400_000);
    const qr = await m.adapter.createQr({
      merchant: m.merchant,
      amount: open.toFixed(2),
      reference: invoice.qrReference ?? referenceOf(invoice.number),
      expiresAt,
    });
    await tx.platformInvoice.update({
      where: { id: invoice.id },
      data: { qrPayload: qr.payload, qrExpiresAt: qr.expiresAt ?? expiresAt },
    });
    return true;
  }

  // ------------------------------------------------------------------------------------------- reads

  list(filter: { tenantId?: string; state?: string; skip: number; take: number }) {
    const where: Prisma.PlatformInvoiceWhereInput = {
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(filter.state ? { state: filter.state as never } : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.platformInvoice.findMany({
        where,
        include: PLATFORM_INVOICE_INCLUDE,
        orderBy: { issuedAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.platformInvoice.count({ where }),
    }));
  }

  get(id: string): Promise<PlatformInvoiceRow> {
    return this.db.platform(async (tx) => {
      const row = await tx.platformInvoice.findUnique({ where: { id }, include: PLATFORM_INVOICE_INCLUDE });
      if (!row) throw new DomainException('http.not_found');
      return row;
    });
  }

  /** The owner's own platform invoices (RLS: tenant rows only), newest first. */
  listForTenant(ctx: TenantContext): Promise<PlatformInvoiceRow[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.platformInvoice.findMany({
        where: { tenantId: ctx.tenantId },
        include: PLATFORM_INVOICE_INCLUDE,
        orderBy: { issuedAt: 'desc' },
        take: 60,
      }),
    );
  }

  getForTenant(ctx: TenantContext, id: string): Promise<PlatformInvoiceRow> {
    return this.db.tenant(ctx, async (tx) => {
      const row = await tx.platformInvoice.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: PLATFORM_INVOICE_INCLUDE,
      });
      if (!row) throw new DomainException('http.not_found');
      return row;
    });
  }

  /** Signed URL of the invoice PDF (another tenant's invoice: 404; not rendered yet: 409). */
  async pdfLink(id: string, tenantId?: string) {
    const inv = await this.db.platform((tx) =>
      tx.platformInvoice.findUnique({ where: { id }, include: { document: true } }),
    );
    if (!inv || (tenantId && inv.tenantId !== tenantId)) throw new DomainException('http.not_found');
    if (!inv.document)
      throw new DomainException('platform_invoice.invalid_state', { params: { state: 'pdf_pending' } });
    return {
      documentId: inv.document.id,
      number: inv.number,
      ...(await this.documents.signedUrl(inv.document)),
    };
  }

  // ------------------------------------------------------------------------------------------- payments

  /**
   * Records a payment of a platform invoice inside the caller's platform transaction: idempotent on (provider,
   * provider_ref); never more than what is open (the rest is refused — Finance refunds outside the platform);
   * a numbered receipt per payment; the invoice becomes paid / partially paid; the subscription is reinstated when
   * nothing is overdue any more.
   */
  async recordPayment(tx: Tx, invoiceId: string, input: PlatformPaymentInput) {
    if (input.providerRef) {
      const existing = await tx.platformPayment.findFirst({
        where: { provider: input.provider, providerRef: input.providerRef },
      });
      if (existing) return { payment: existing, duplicate: true };
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM platform.platform_invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
    if (!rows.length) throw new DomainException('http.not_found');
    const invoice = await tx.platformInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (!OPEN_INVOICE_STATES.includes(invoice.state as never))
      throw new DomainException('platform_invoice.invalid_state', { params: { state: invoice.state } });
    const open = new Decimal(invoice.total.toString())
      .minus(invoice.paidTotal.toString())
      .minus(invoice.creditedTotal.toString());
    const amount = new Decimal(input.amount);
    if (amount.lte(0) || amount.gt(open))
      throw new DomainException('platform_invoice.amount_exceeds_open', {
        params: { open: open.toFixed(2) },
      });
    const now = this.clock.now();
    const payment = await tx.platformPayment.create({
      data: {
        tenantId: invoice.tenantId,
        invoiceId,
        amount: amount.toFixed(2),
        method: input.method,
        provider: input.provider,
        providerRef: input.providerRef,
        paidAt: input.paidAt,
        confirmedAt: now,
        recordedBy: input.method === 'qr' ? null : by(),
        evidenceDocumentId: input.evidenceDocumentId ?? null,
      },
    });
    const paidTotal = new Decimal(invoice.paidTotal.toString()).plus(amount);
    const settled = paidTotal.plus(invoice.creditedTotal.toString()).gte(invoice.total.toString());
    await tx.platformInvoice.update({
      where: { id: invoiceId },
      data: {
        paidTotal: paidTotal.toFixed(2),
        state: settled ? 'paid' : 'partially_paid',
        overdueSince: settled ? null : invoice.overdueSince,
        version: { increment: 1 },
      },
    });
    const receiptNumber = await this.numbering.nextPlatform(tx, 'platform_receipt', now);
    const vatShare = new Decimal(invoice.vatAmount.toString())
      .times(amount)
      .div(invoice.total.toString() === '0' ? 1 : invoice.total.toString())
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const receipt = await tx.platformReceipt.create({
      data: {
        tenantId: invoice.tenantId,
        paymentId: payment.id,
        invoiceId,
        number: receiptNumber,
        amount: amount.toFixed(2),
        vatAmount: vatShare.toFixed(2),
        issuedAt: now,
      },
    });
    await tx.platformPayment.update({ where: { id: payment.id }, data: { receiptId: receipt.id } });
    await this.audit.record(tx, {
      action: 'platform_payment.recorded',
      tenantId: invoice.tenantId,
      subjectType: 'platform.platform_payment',
      subjectId: payment.id,
      after: {
        invoice: invoice.number,
        amount: amount.toFixed(2),
        method: input.method,
        provider: input.provider,
        receipt: receiptNumber,
      },
    });
    await this.events.record(tx, {
      type: 'platform_payment.confirmed',
      aggregateType: 'platform_invoice',
      aggregateId: invoiceId,
      tenantId: invoice.tenantId,
      payload: {
        platformInvoiceId: invoiceId,
        platformPaymentId: payment.id,
        platformReceiptId: receipt.id,
        amount: amount.toFixed(2),
        settled,
      },
    });
    // a purchase (no subscription) has nothing to reinstate
    if (invoice.subscriptionId) {
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id: invoice.subscriptionId } });
      await this.reconcile(tx, sub);
    }
    return { payment, duplicate: false };
  }

  /** Finance records a bank transfer (or another manual method) with its bank reference (audited, D-091). */
  async recordManual(invoiceId: string, input: PlatformPaymentInput) {
    const r = await this.db.platform((tx) => this.recordPayment(tx, invoiceId, input));
    await this.refreshAccess();
    return r;
  }

  /**
   * `POST /webhooks/platform-payments/{provider}`: the platform merchant's signed callback. Unknown signature → 401;
   * each paid reference of a platform invoice is recorded once (idempotent on the provider reference); other
   * references are ignored (logged). Answers what was applied.
   */
  async handleCallback(provider: string, headers: Record<string, string | undefined>, rawBody: Buffer) {
    if (!this.gateway.isProvider(provider)) throw new DomainException('http.not_found');
    const m = await this.gateway.merchant();
    const adapter = this.gateway.adapter(provider);
    if (!m || m.merchant.provider !== provider) throw new DomainException('webhook.signature_invalid');
    let parsed;
    try {
      parsed = adapter.parseWebhook(headers, rawBody);
    } catch {
      throw new DomainException('webhook.malformed');
    }
    if (parsed.merchantRef !== m.merchant.merchantRef || !adapter.verifyWebhook(headers, rawBody, m.merchant))
      throw new DomainException('webhook.signature_invalid');
    const results: {
      reference: string;
      outcome: 'applied' | 'duplicate' | 'unknown_reference' | 'ignored';
    }[] = [];
    for (const p of parsed.payments) {
      if (p.status !== 'paid') {
        results.push({ reference: p.reference, outcome: 'ignored' });
        continue;
      }
      const outcome = await this.db.platform(async (tx) => {
        const invoice = await tx.platformInvoice.findFirst({ where: { qrReference: p.reference } });
        if (!invoice) return 'unknown_reference' as const;
        const r = await this.recordPayment(tx, invoice.id, {
          amount: p.amount,
          method: 'qr',
          provider,
          providerRef: p.providerRef,
          paidAt: p.paidAt,
        });
        return r.duplicate ? ('duplicate' as const) : ('applied' as const);
      });
      if (outcome === 'unknown_reference')
        this.logger.warn(
          `platform callback ${parsed.eventId}: no platform invoice for reference ${p.reference}`,
        );
      results.push({ reference: p.reference, outcome });
    }
    await this.refreshAccess();
    return { eventId: parsed.eventId, results };
  }

  // ------------------------------------------------------------------------------------------- credit notes

  /** Maker (D-091): a Finance user asks for a credit note on an issued invoice (≤ what is not yet credited). */
  requestCreditNote(invoiceId: string, input: { amount: string; reason: string }) {
    const userId = by();
    if (!userId) throw new DomainException('auth.unauthenticated');
    return this.db.platform(async (tx) => {
      const invoice = await tx.platformInvoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new DomainException('http.not_found');
      if (invoice.state === 'void' || invoice.state === 'credited')
        throw new DomainException('platform_invoice.invalid_state', { params: { state: invoice.state } });
      const pending = await tx.platformCreditNote.aggregate({
        where: { invoiceId, state: 'requested' },
        _sum: { amount: true },
      });
      const room = new Decimal(invoice.total.toString())
        .minus(invoice.creditedTotal.toString())
        .minus((pending._sum.amount ?? 0).toString());
      if (new Decimal(input.amount).gt(room))
        throw new DomainException('platform_invoice.amount_exceeds_open', {
          params: { open: room.toFixed(2) },
        });
      const note = await tx.platformCreditNote.create({
        data: {
          tenantId: invoice.tenantId,
          invoiceId,
          amount: new Decimal(input.amount).toFixed(2),
          reason: input.reason,
          requestedBy: userId,
        },
      });
      await this.audit.record(tx, {
        action: 'platform_credit_note.requested',
        tenantId: invoice.tenantId,
        subjectType: 'platform.platform_credit_note',
        subjectId: note.id,
        after: { invoice: invoice.number, amount: note.amount.toString(), reason: input.reason },
      });
      return note;
    });
  }

  /**
   * Checker (D-091): another platform user approves (numbered, invoice credited) or rejects. The requester can never
   * decide (409 `platform_credit_note.same_approver`; also a database CHECK).
   */
  async decideCreditNote(noteId: string, approve: boolean) {
    const r = await this.decide(noteId, approve);
    await this.refreshAccess();
    return r;
  }

  private decide(noteId: string, approve: boolean) {
    const userId = by();
    if (!userId) throw new DomainException('auth.unauthenticated');
    return this.db.platform(async (tx) => {
      const note = await tx.platformCreditNote.findUnique({ where: { id: noteId } });
      if (!note) throw new DomainException('http.not_found');
      if (note.state !== 'requested')
        throw new DomainException('platform_invoice.invalid_state', { params: { state: note.state } });
      if (note.requestedBy === userId) throw new DomainException('platform_credit_note.same_approver');
      const now = this.clock.now();
      if (!approve) {
        const rejected = await tx.platformCreditNote.update({
          where: { id: noteId },
          data: { state: 'rejected', decidedAt: now, approvedBy: null },
        });
        await this.audit.record(tx, {
          action: 'platform_credit_note.rejected',
          tenantId: note.tenantId,
          subjectType: 'platform.platform_credit_note',
          subjectId: noteId,
        });
        return rejected;
      }
      await tx.$queryRaw`SELECT id FROM platform.platform_invoice WHERE id = ${note.invoiceId}::uuid FOR UPDATE`;
      const invoice = await tx.platformInvoice.findUniqueOrThrow({ where: { id: note.invoiceId } });
      const credited = new Decimal(invoice.creditedTotal.toString()).plus(note.amount.toString());
      if (credited.plus(invoice.paidTotal.toString()).gt(invoice.total.toString()))
        throw new DomainException('platform_invoice.amount_exceeds_open', {
          params: {
            open: new Decimal(invoice.total.toString())
              .minus(invoice.paidTotal.toString())
              .minus(invoice.creditedTotal.toString())
              .toFixed(2),
          },
        });
      const number = await this.numbering.nextPlatform(tx, 'platform_credit_note', now);
      const issued = await tx.platformCreditNote.update({
        where: { id: noteId },
        data: { state: 'issued', number, approvedBy: userId, decidedAt: now, issuedAt: now },
      });
      const settled = credited.plus(invoice.paidTotal.toString()).gte(invoice.total.toString());
      await tx.platformInvoice.update({
        where: { id: invoice.id },
        data: {
          creditedTotal: credited.toFixed(2),
          state: credited.gte(invoice.total.toString()) ? 'credited' : settled ? 'paid' : invoice.state,
          overdueSince: settled ? null : invoice.overdueSince,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'platform_credit_note.issued',
        tenantId: note.tenantId,
        subjectType: 'platform.platform_credit_note',
        subjectId: noteId,
        after: { number, amount: note.amount.toString(), invoice: invoice.number },
      });
      await this.events.record(tx, {
        type: 'platform_credit_note.issued',
        aggregateType: 'platform_invoice',
        aggregateId: invoice.id,
        tenantId: note.tenantId,
        payload: { platformInvoiceId: invoice.id, platformCreditNoteId: noteId, number },
      });
      if (invoice.subscriptionId) {
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: invoice.subscriptionId } });
        await this.reconcile(tx, sub);
      }
      return issued;
    });
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  /** Appends a subscription history row (append-only) in the caller's transaction. */
  async history(
    tx: Tx,
    sub: Pick<Subscription, 'id' | 'tenantId'>,
    type: string,
    data: Record<string, unknown>,
  ) {
    await tx.subscriptionEvent.create({
      data: {
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        type,
        occurredAt: this.clock.now(),
        actor: actorEnvelope(RequestContext.actor()),
        data: data as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Moves a subscription and keeps the tenant's read-only mode in step (D-082): `suspended` and `cancelled` make the
   * tenant `read_only` (never data loss), any other state makes it `active` again. Evented and audited; access
   * caches drop at once.
   */
  async transition(
    tx: Tx,
    sub: Subscription,
    to: Subscription['state'],
    data: Prisma.SubscriptionUpdateInput,
    reason: string,
  ): Promise<Subscription> {
    if (sub.state === to && Object.keys(data).length === 0) return sub;
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: { ...data, state: to, updatedBy: by(), version: { increment: 1 } },
    });
    const readOnly = to === 'suspended' || to === 'cancelled';
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: sub.tenantId },
      select: { status: true },
    });
    if (tenant.status !== 'deactivated' && (tenant.status === 'read_only') !== readOnly) {
      await tx.tenant.update({
        where: { id: sub.tenantId },
        data: { status: readOnly ? 'read_only' : 'active' },
      });
    }
    if (sub.state !== to) {
      await this.history(tx, sub, `state.${to}`, { from: sub.state, to, reason });
      await this.audit.record(tx, {
        action: 'subscription.state_changed',
        tenantId: sub.tenantId,
        subjectType: 'platform.subscription',
        subjectId: sub.id,
        before: { state: sub.state },
        after: { state: to, reason },
      });
      await this.events.record(tx, {
        type: 'subscription.state_changed',
        aggregateType: 'subscription',
        aggregateId: sub.id,
        tenantId: sub.tenantId,
        payload: { subscriptionId: sub.id, from: sub.state, to, reason },
      });
    }
    return updated;
  }

  /**
   * Drops the operator access caches (tenant status, read-only mode) on every replica; called after a commit that may
   * have moved a subscription.
   */
  async refreshAccess(): Promise<void> {
    await this.access.changed('*');
  }

  /**
   * After money came in or a credit note: a subscription in trial / past_due / suspended with no overdue invoice left
   * becomes active (D-082: trial → active on the first platform payment; past_due / suspended → active when paid).
   */
  async reconcile(tx: Tx, sub: Subscription): Promise<Subscription> {
    if (!['trial', 'past_due', 'suspended'].includes(sub.state)) return sub;
    const overdue = await tx.platformInvoice.count({ where: { subscriptionId: sub.id, state: 'overdue' } });
    if (overdue > 0) return sub;
    const paid = await tx.platformInvoice.count({
      where: { subscriptionId: sub.id, state: { in: ['paid', 'credited'] } },
    });
    if (sub.state === 'trial' && paid === 0) return sub;
    const now = this.clock.now();
    return this.transition(
      tx,
      sub,
      'active',
      { activatedAt: sub.activatedAt ?? now, pastDueSince: null, suspendedAt: null },
      sub.state === 'trial' ? 'first_payment' : 'paid',
    );
  }
}

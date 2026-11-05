import { isJuristicTenantType } from '@collective/asset-core';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Invoice,
  type Payment,
  type PaymentConfirmation,
  type PaymentMethod,
  type PaymentProvider,
  type PaymentQrCode,
  Prisma,
} from '@generated/prisma/client';
import { type AllocationPolicy, planAllocation } from '@modules/ops-billing/engine/allocation';
import { InvoicesService } from '@modules/ops-billing/invoices.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { MerchantResolver } from './merchants';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const OPEN: Invoice['status'][] = ['issued', 'partially_paid', 'overdue'];

export const PAYMENT_INCLUDE = {
  allocations: {
    include: { invoice: { select: { id: true, number: true } } },
    orderBy: { allocatedAt: 'asc' },
  },
  payer: { select: { id: true, displayName: true } },
  unit: { select: { id: true, unitNo: true } },
  receipts: { select: { id: true, number: true, kind: true, voidedAt: true, documentId: true } },
} as const satisfies Prisma.PaymentInclude;
export type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

export interface ConfirmInput {
  tenantId: string;
  buildingId: string;
  unitId: string | null;
  invoiceId: string | null;
  payerPartyId: string;
  leaseId: string | null;
  amount: string;
  method: PaymentMethod;
  confirmedVia: PaymentConfirmation;
  paidAt: Date;
  provider?: PaymentProvider | null;
  providerRef?: string | null;
  providerPayload?: Record<string, unknown> | null;
  bankAccountId?: string | null;
  qrCodeId?: string | null;
  slipDocumentId?: string | null;
  evidenceDocumentId?: string | null;
  slipReviewId?: string | null;
  recordedBy?: string | null;
  notes?: string | null;
  whtAmount?: string;
  /** Allocate to this invoice only and never create a credit (payments from the payer's credit). */
  onlyInvoiceId?: string;
  /**
   * D-326 (J1.2b): allocate over this set of the payer's invoices (a statement's open invoices of one unit) instead of
   * every open invoice of the payer × unit; the excess still becomes the payer's credit.
   */
  targetInvoiceIds?: string[];
  /**
   * D-220: store the payment `pending` for the owner instead of booking it (a provider payment that looks like a
   * transfer already booked) — no allocation, no credit, no receipt.
   */
  hold?: { reason: HeldReason; duplicateOfPaymentId: string | null };
}

/** Why a provider payment waits for the owner (D-220). */
export type HeldReason = 'qr_already_paid' | 'possible_duplicate_transfer';

/**
 * Payments (B4.4, D-042, D-044, D-193): a confirmed payment is allocated to the payer's open invoices of the unit
 * **oldest first** (the QR amount includes the prior balance); what exceeds them is the payer's credit
 * (`ops.payer_credit`, used automatically on the next invoice, or refunded with evidence). Idempotent on
 * (provider, provider_ref). Every payment, reversal and refund is audited and announced through the outbox
 * (`payment.confirmed` → receipt). The Thai QR of an invoice is created for what is due now (balance + earlier
 * open balances), through the tenant's own merchant account.
 */
@Injectable()
export class PaymentsService extends TenantScopedRepository {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly invoices: InvoicesService,
    private readonly merchants: MerchantResolver,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  // ------------------------------------------------------------------------------------------- amounts

  /** Earlier open invoices of the same payer × unit, oldest first, then this one. */
  async openInvoices(tx: Tx, inv: Pick<Invoice, 'tenantId' | 'billedPartyId' | 'unitId'>) {
    return tx.invoice.findMany({
      where: {
        tenantId: inv.tenantId,
        billedPartyId: inv.billedPartyId,
        unitId: inv.unitId,
        status: { in: OPEN },
        balance: { gt: 0 },
      },
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** What the payer owes now when paying this invoice: its balance and every earlier open balance (D-193). */
  async dueFor(tx: Tx, inv: Invoice): Promise<Decimal> {
    if (!inv.issuedAt || !OPEN.includes(inv.status)) return new Decimal(0);
    const open = await this.openInvoices(tx, inv);
    return open
      .filter((o) => o.issuedAt!.getTime() <= inv.issuedAt!.getTime())
      .reduce((s, o) => s.plus(D(o.balance)), new Decimal(0));
  }

  /** Serialises uses of one payer × unit credit (use on issue, refund, reversal). */
  async lockCredit(tx: Tx, partyId: string, unitId: string | null): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit:${partyId}:${unitId ?? '-'}`}))`;
  }

  async creditBalance(tx: Tx, partyId: string, unitId: string | null): Promise<Decimal> {
    const r = await tx.payerCredit.aggregate({ where: { partyId, unitId }, _sum: { amount: true } });
    return D(r._sum.amount ?? 0);
  }

  async allowPartial(tenantId: string): Promise<boolean> {
    return (
      (await this.settings.valueAt<boolean>('payments.allow_partial', this.clock.now(), { tenantId })) ===
      true
    );
  }

  /** A slip or manual amount below what is due needs `payments.allow_partial` (D-044). */
  async assertAmount(tx: Tx, inv: Invoice, amount: Decimal.Value): Promise<void> {
    const due = await this.dueFor(tx, inv);
    if (due.lte(0)) throw new DomainException('invoice.nothing_due');
    if (D(amount).lt(due) && !(await this.allowPartial(inv.tenantId)))
      throw new DomainException('payment.partial_not_allowed', { params: { due: due.toFixed(2) } });
  }

  // ------------------------------------------------------------------------------------------- QR

  /**
   * The active Thai QR of an invoice for what is due now (created through the tenant's merchant when missing,
   * expired, or for another amount); null when nothing is due or the tenant has no QR provider.
   */
  async ensureQr(tx: Tx, invoiceId: string): Promise<PaymentQrCode | null> {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (!inv.issuedAt || !inv.promptpayRef) return null;
    const due = await this.dueFor(tx, inv);
    const now = this.clock.now();
    const active = await tx.paymentQrCode.findFirst({ where: { invoiceId, status: 'active' } });
    if (active && D(active.amount).eq(due) && (!active.expiresAt || active.expiresAt > now)) return active;
    if (active)
      await tx.paymentQrCode.update({
        where: { id: active.id },
        data: { status: active.expiresAt && active.expiresAt <= now ? 'expired' : 'cancelled' },
      });
    if (due.lte(0)) return null;
    const ma = await this.merchants.forBuilding(tx, inv.tenantId, inv.buildingId);
    if (!ma) return null;
    const expiresAt = new Date(now.getTime() + this.config.get('PAYMENTS_QR_TTL_MINUTES') * 60_000);
    const created = await ma.adapter.createQr({
      merchant: ma.merchant,
      amount: due.toFixed(2),
      reference: inv.promptpayRef,
      expiresAt,
    });
    const qr = await tx.paymentQrCode.create({
      data: {
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        unitId: inv.unitId,
        invoiceId,
        provider: ma.merchant.provider,
        bankAccountId: ma.account.id,
        reference: inv.promptpayRef,
        amount: due.toFixed(2),
        payload: created.payload,
        providerQrId: created.providerQrId,
        expiresAt: created.expiresAt ?? expiresAt,
      },
    });
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { qrPayload: qr.payload, qrProvider: qr.provider, qrExpiresAt: qr.expiresAt },
    });
    return qr;
  }

  // ------------------------------------------------------------------------------------------- confirm

  /**
   * Serialises every allocation for one payer × unit (review #3): open balances are read and paid under the same
   * advisory lock as the payer's credit, so concurrent confirmations never allocate the same balance twice and the
   * excess always becomes credit. Advisory transaction locks are re-entrant (applyCredit already holds it).
   */
  async lockPayer(
    tx: Tx,
    input: { payerPartyId: string | null; unitId: string | null; invoiceId: string | null },
  ) {
    await this.lockCredit(tx, input.payerPartyId ?? `invoice-${input.invoiceId ?? '-'}`, input.unitId);
  }

  /** Records a confirmed payment and allocates it; a repeated provider reference returns the first payment. */
  async confirm(tx: Tx, input: ConfirmInput): Promise<{ payment: Payment; duplicate: boolean }> {
    await this.lockPayer(tx, input);
    if (input.provider && input.providerRef) {
      const existing = await tx.payment.findFirst({
        where: { provider: input.provider, providerRef: input.providerRef },
      });
      if (existing) return { payment: existing, duplicate: true };
    }
    const now = this.clock.now();
    if (input.hold) return { payment: await this.holdPayment(tx, input, input.hold), duplicate: false };
    const payment = await tx.payment.create({
      data: {
        tenantId: input.tenantId,
        buildingId: input.buildingId,
        unitId: input.unitId,
        invoiceId: input.invoiceId,
        payerPartyId: input.payerPartyId,
        leaseId: input.leaseId,
        amount: D(input.amount).toFixed(2),
        method: input.method,
        provider: input.provider ?? null,
        providerRef: input.providerRef ?? null,
        providerPayload: (input.providerPayload ?? undefined) as Prisma.InputJsonValue | undefined,
        bankAccountId: input.bankAccountId ?? null,
        qrCodeId: input.qrCodeId ?? null,
        status: 'confirmed',
        paidAt: input.paidAt,
        confirmedAt: now,
        confirmedVia: input.confirmedVia,
        slipDocumentId: input.slipDocumentId ?? null,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
        slipReviewId: input.slipReviewId ?? null,
        recordedBy: input.recordedBy ?? null,
        whtAmount: input.whtAmount ?? '0.00',
        notes: input.notes ?? null,
        createdBy: by(),
      },
    });
    return {
      payment: await this.book(tx, payment, input.confirmedVia, input.onlyInvoiceId, input.targetInvoiceIds),
      duplicate: false,
    };
  }

  /** Allocation, audit and `payment.confirmed` (→ receipt) of a confirmed payment row. */
  private async book(
    tx: Tx,
    payment: Payment,
    confirmedVia: PaymentConfirmation,
    onlyInvoiceId?: string,
    targetInvoiceIds?: string[],
  ): Promise<Payment> {
    const split = await this.allocate(tx, payment, onlyInvoiceId, targetInvoiceIds);
    await this.audit.record(tx, {
      action: confirmedVia === 'manual' ? 'payment.recorded' : 'payment.confirmed',
      tenantId: payment.tenantId,
      buildingId: payment.buildingId,
      subjectType: 'ops.payment',
      subjectId: payment.id,
      metadata: {
        amount: payment.amount.toFixed(2),
        method: payment.method,
        via: confirmedVia,
        providerRef: payment.providerRef,
        allocations: split.allocations,
        credited: split.credited,
      },
    });
    await this.events.record(tx, {
      type: 'payment.confirmed',
      aggregateType: 'payment',
      aggregateId: payment.id,
      tenantId: payment.tenantId,
      buildingId: payment.buildingId,
      payload: {
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        payerPartyId: payment.payerPartyId,
        unitId: payment.unitId,
        amount: payment.amount.toFixed(2),
        method: payment.method,
        via: confirmedVia,
        allocations: split.allocations,
        credited: split.credited,
      },
    });
    return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
  }

  /** D-220: a provider payment stored `pending` for the owner — nothing allocated, credited or receipted. */
  private async holdPayment(
    tx: Tx,
    input: ConfirmInput,
    hold: { reason: HeldReason; duplicateOfPaymentId: string | null },
  ): Promise<Payment> {
    const payment = await tx.payment.create({
      data: {
        tenantId: input.tenantId,
        buildingId: input.buildingId,
        unitId: input.unitId,
        invoiceId: input.invoiceId,
        payerPartyId: input.payerPartyId,
        leaseId: input.leaseId,
        amount: D(input.amount).toFixed(2),
        method: input.method,
        provider: input.provider ?? null,
        providerRef: input.providerRef ?? null,
        providerPayload: (input.providerPayload ?? undefined) as Prisma.InputJsonValue | undefined,
        bankAccountId: input.bankAccountId ?? null,
        qrCodeId: input.qrCodeId ?? null,
        status: 'pending',
        paidAt: input.paidAt,
        confirmedVia: input.confirmedVia,
        heldReason: hold.reason,
        duplicateOfPaymentId: hold.duplicateOfPaymentId,
        notes: input.notes ?? null,
        createdBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: 'payment.held',
      tenantId: payment.tenantId,
      buildingId: payment.buildingId,
      subjectType: 'ops.payment',
      subjectId: payment.id,
      metadata: {
        amount: payment.amount.toFixed(2),
        via: input.confirmedVia,
        providerRef: payment.providerRef,
        reason: hold.reason,
        duplicateOf: hold.duplicateOfPaymentId,
      },
    });
    await this.events.record(tx, {
      type: 'payment.held',
      aggregateType: 'payment',
      aggregateId: payment.id,
      tenantId: payment.tenantId,
      buildingId: payment.buildingId,
      payload: {
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        unitId: payment.unitId,
        amount: payment.amount.toFixed(2),
        reason: hold.reason,
        duplicateOfPaymentId: hold.duplicateOfPaymentId,
      },
    });
    return payment;
  }

  /**
   * The confirmed payment that most likely is the same bank transfer (D-220): a payment by one of `methods` for the
   * same invoice (made for it, or allocated to it), of the same amount, for the same payer × unit, paid within
   * `payments.duplicate_window_hours`. Null when none.
   */
  async sameTransfer(
    tx: Tx,
    input: {
      tenantId: string;
      invoiceId: string;
      payerPartyId: string;
      unitId: string | null;
      amount: string;
      paidAt: Date;
    },
    methods: PaymentMethod[],
  ): Promise<Payment | null> {
    const hours = await this.settings.valueAt<number>('payments.duplicate_window_hours', this.clock.now(), {
      tenantId: input.tenantId,
    });
    const window = Number(hours) * 3_600_000;
    return tx.payment.findFirst({
      where: {
        tenantId: input.tenantId,
        payerPartyId: input.payerPartyId,
        unitId: input.unitId,
        status: 'confirmed',
        method: { in: methods },
        OR: [{ invoiceId: input.invoiceId }, { allocations: { some: { invoiceId: input.invoiceId } } }],
        amount: D(input.amount).toFixed(2),
        paidAt: {
          gte: new Date(input.paidAt.getTime() - window),
          lte: new Date(input.paidAt.getTime() + window),
        },
      },
      orderBy: { paidAt: 'asc' },
    });
  }

  /** The owner books a held payment after all (it was a second transfer): allocated, credited, receipted. */
  async confirmHeld(ctx: TenantContext, paymentId: string): Promise<PaymentRow> {
    await this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops.payment WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = await this.load(tx, ctx, paymentId);
      if (p.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (p.status !== 'pending' || !p.heldReason)
        throw new DomainException('payment.invalid_state', { params: { status: p.status } });
      await this.lockPayer(tx, p);
      const confirmed = await tx.payment.update({
        where: { id: p.id },
        data: {
          status: 'confirmed',
          confirmedAt: this.clock.now(),
          recordedBy: by(),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.book(tx, confirmed, p.confirmedVia ?? 'manual');
    });
    return this.get(ctx, paymentId);
  }

  /** The owner dismisses a held payment: the same transfer was already booked — never allocated or receipted. */
  async dismissHeld(ctx: TenantContext, paymentId: string, reason: string): Promise<PaymentRow> {
    await this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops.payment WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = await this.load(tx, ctx, paymentId);
      if (p.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (p.status !== 'pending' || !p.heldReason)
        throw new DomainException('payment.invalid_state', { params: { status: p.status } });
      const now = this.clock.now();
      await tx.payment.update({
        where: { id: p.id },
        data: {
          status: 'failed',
          dismissedAt: now,
          dismissedBy: by(),
          dismissReason: reason,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'payment.dismissed',
        tenantId: p.tenantId,
        buildingId: p.buildingId,
        subjectType: 'ops.payment',
        subjectId: p.id,
        metadata: { reason, amount: p.amount.toFixed(2), duplicateOf: p.duplicateOfPaymentId },
      });
      await this.events.record(tx, {
        type: 'payment.dismissed',
        aggregateType: 'payment',
        aggregateId: p.id,
        tenantId: p.tenantId,
        buildingId: p.buildingId,
        payload: { paymentId: p.id, amount: p.amount.toFixed(2), reason },
      });
    });
    return this.get(ctx, paymentId);
  }

  /** `payments.allocation_policy` of the tenant (D-325): `oldest_first` (default) or `surcharge_first`. */
  async allocationPolicy(tenantId: string): Promise<AllocationPolicy> {
    const v = await this.settings.valueAt<string>('payments.allocation_policy', this.clock.now(), {
      tenantId,
    });
    return v === 'surcharge_first' ? 'surcharge_first' : 'oldest_first';
  }

  /**
   * The open surcharge (late-fee lines) of each invoice: Σ `late_fee` lines − surcharge already allocated (not
   * reversed) − credit-note lines on those lines; never above the balance (D-325).
   */
  async surchargeOpen(tx: Tx, invoiceIds: string[]): Promise<Map<string, Decimal>> {
    if (!invoiceIds.length) return new Map();
    const rows = await tx.$queryRaw<{ id: string; open: string }[]>`
      SELECT i.id,
             GREATEST(0, LEAST(i.balance,
               COALESCE((SELECT sum(l.amount) FROM ops.invoice_line l WHERE l.invoice_id = i.id AND l.line_kind = 'late_fee'), 0)
               - COALESCE((SELECT sum(a.surcharge_amount) FROM ops.payment_allocation a
                            WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0)
               - COALESCE((SELECT sum(cl.amount) FROM ops.credit_note_line cl
                             JOIN ops.credit_note cn ON cn.id = cl.note_id
                             JOIN ops.invoice_line l ON l.id = cl.ref_invoice_line_id
                            WHERE cn.invoice_id = i.id AND l.line_kind = 'late_fee'), 0)))::text AS open
        FROM ops.invoice i WHERE i.id = ANY(${invoiceIds}::uuid[])`;
    return new Map(rows.map((r) => [r.id, D(r.open)]));
  }

  /**
   * Spreads a confirmed payment over open invoices by the tenant's allocation policy (D-044, D-325): the targets are
   * the payer's open invoices of the unit (or one invoice for a credit offset, or the given set — J1.2b statements);
   * each is locked and read under the lock (review #3); the rest becomes the payer's credit.
   */
  private async allocate(
    tx: Tx,
    payment: Payment,
    onlyInvoiceId?: string,
    targetInvoiceIds?: string[],
  ): Promise<{
    allocations: { invoiceId: string; number: string | null; amount: string; surcharge: string }[];
    credited: string;
  }> {
    const amount = D(payment.amount).plus(D(payment.whtAmount));
    const candidates = onlyInvoiceId
      ? await tx.invoice.findMany({ where: { id: onlyInvoiceId, status: { in: OPEN }, balance: { gt: 0 } } })
      : targetInvoiceIds
        ? await tx.invoice.findMany({
            where: {
              id: { in: targetInvoiceIds },
              tenantId: payment.tenantId,
              billedPartyId: payment.payerPartyId ?? undefined,
              status: { in: OPEN },
              balance: { gt: 0 },
            },
            orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
          })
        : payment.payerPartyId
          ? await this.openInvoices(tx, {
              tenantId: payment.tenantId,
              billedPartyId: payment.payerPartyId,
              unitId: payment.unitId,
            })
          : [];
    // the balances as of now, under the row locks (review #3): never what an earlier read saw
    const locked: { id: string; balance: string; status: string }[] = [];
    for (const inv of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
      const [row] = await tx.$queryRaw<{ id: string; balance: string; status: string }[]>`
        SELECT id, balance::text AS balance, status::text AS status FROM ops.invoice WHERE id = ${inv.id}::uuid FOR UPDATE`;
      if (row && OPEN.includes(row.status as Invoice['status'])) locked.push(row);
    }
    const surcharge = await this.surchargeOpen(
      tx,
      locked.map((l) => l.id),
    );
    const plan = planAllocation(
      amount,
      locked.map((l) => ({
        invoiceId: l.id,
        issuedAt: candidates.find((c) => c.id === l.id)!.issuedAt ?? new Date(0),
        balance: l.balance,
        surchargeOpen: (surcharge.get(l.id) ?? D(0)).toFixed(2),
      })),
      await this.allocationPolicy(payment.tenantId),
    );
    const allocations: { invoiceId: string; number: string | null; amount: string; surcharge: string }[] = [];
    for (const slice of plan.slices) {
      const take = D(slice.amount);
      await tx.paymentAllocation.create({
        data: {
          tenantId: payment.tenantId,
          paymentId: payment.id,
          invoiceId: slice.invoiceId,
          amount: take.toFixed(2),
          surchargeAmount: slice.surcharge,
        },
      });
      const after = await this.invoices.applyBalance(
        tx,
        slice.invoiceId,
        { paid: take, at: payment.paidAt },
        'payment',
      );
      if (D(after.balance).lte(0))
        await tx.paymentQrCode.updateMany({
          where: { invoiceId: slice.invoiceId, status: 'active' },
          data: { status: 'paid', paidAt: payment.paidAt },
        });
      allocations.push({
        invoiceId: slice.invoiceId,
        number: candidates.find((c) => c.id === slice.invoiceId)?.number ?? null,
        amount: take.toFixed(2),
        surcharge: slice.surcharge,
      });
    }
    const remaining = D(plan.remainder);
    let credited = new Decimal(0);
    if (remaining.gt(0) && !onlyInvoiceId && payment.payerPartyId) {
      credited = remaining;
      await tx.payerCredit.create({
        data: {
          tenantId: payment.tenantId,
          buildingId: payment.buildingId,
          unitId: payment.unitId,
          partyId: payment.payerPartyId,
          kind: 'overpayment',
          amount: credited.toFixed(2),
          paymentId: payment.id,
          note: 'received beyond what was due',
          createdBy: by(),
        },
      });
    }
    const allocatedTotal = allocations.reduce((s, a) => s.plus(a.amount), new Decimal(0));
    await tx.payment.update({
      where: { id: payment.id },
      data: { allocatedTotal: allocatedTotal.toFixed(2), creditedAmount: credited.toFixed(2) },
    });
    return { allocations, credited: credited.toFixed(2) };
  }

  /** The payer's credit pays a newly issued invoice first (D-044: credit to the payer's balance by default). */
  async applyCredit(tx: Tx, invoiceId: string): Promise<Payment | null> {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (!inv.issuedAt || !OPEN.includes(inv.status) || D(inv.balance).lte(0)) return null;
    await this.lockCredit(tx, inv.billedPartyId, inv.unitId);
    const credit = await this.creditBalance(tx, inv.billedPartyId, inv.unitId);
    if (credit.lte(0)) return null;
    const amount = Decimal.min(credit, D(inv.balance));
    const { payment } = await this.confirm(tx, {
      tenantId: inv.tenantId,
      buildingId: inv.buildingId,
      unitId: inv.unitId,
      invoiceId: inv.id,
      payerPartyId: inv.billedPartyId,
      leaseId: inv.leaseId,
      amount: amount.toFixed(2),
      method: 'offset',
      confirmedVia: 'credit',
      paidAt: this.clock.now(),
      notes: 'credit of earlier payments',
      onlyInvoiceId: inv.id,
    });
    await tx.payerCredit.create({
      data: {
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        unitId: inv.unitId,
        partyId: inv.billedPartyId,
        kind: 'applied',
        amount: amount.negated().toFixed(2),
        paymentId: payment.id,
        invoiceId: inv.id,
        createdBy: by(),
      },
    });
    return payment;
  }

  // ------------------------------------------------------------------------------------------- owner

  async recordManual(
    ctx: TenantContext,
    input: {
      invoiceId: string;
      amount: string;
      method: 'cash' | 'bank_transfer_manual';
      paidAt: Date;
      evidenceDocumentId?: string | null;
      reference?: string | null;
      notes?: string | null;
      whtAmount?: string | null;
    },
  ): Promise<PaymentRow> {
    if (input.method === 'bank_transfer_manual' && !input.evidenceDocumentId)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'evidenceDocumentId', code: 'required', message: 'a transfer needs its evidence' }],
      });
    const id = await this.db.tenant(ctx, async (tx) => {
      const inv = await this.invoices.load(tx, ctx, input.invoiceId);
      if (inv.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (!inv.issuedAt || !OPEN.includes(inv.status))
        throw new DomainException('invoice.invalid_state', { params: { status: inv.status } });
      await this.assertAmount(tx, inv, D(input.amount).plus(input.whtAmount ?? 0));
      await this.assertManualEvidence(tx, inv.tenantId, input);
      if (input.evidenceDocumentId) {
        const doc = await tx.document.findFirst({
          where: { id: input.evidenceDocumentId, tenantId: ctx.tenantId, deletedAt: null },
        });
        if (!doc) throw new DomainException('http.not_found');
      }
      const { payment } = await this.confirm(tx, {
        tenantId: inv.tenantId,
        buildingId: inv.buildingId,
        unitId: inv.unitId,
        invoiceId: inv.id,
        payerPartyId: inv.billedPartyId,
        leaseId: inv.leaseId,
        amount: input.amount,
        method: input.method,
        confirmedVia: 'manual',
        paidAt: input.paidAt,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
        recordedBy: by(),
        notes: [input.reference, input.notes].filter(Boolean).join(' · ') || null,
        whtAmount: input.whtAmount ? D(input.whtAmount).toFixed(2) : undefined,
      });
      return payment.id;
    });
    return this.get(ctx, id);
  }

  /**
   * D-325 (J1.2a): a juristic tenant records money received outside the platform (cash, a transfer — often from abroad)
   * only with its evidence **and** a note of at least 5 characters (sender bank, SWIFT reference, who paid).
   */
  async assertManualEvidence(
    tx: Tx,
    tenantId: string,
    input: { evidenceDocumentId?: string | null; notes?: string | null; reference?: string | null },
  ): Promise<void> {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { type: true } });
    if (!tenant || !isJuristicTenantType(tenant.type)) return;
    const errors: { path: string; code: string; message: string }[] = [];
    if (!input.evidenceDocumentId)
      errors.push({
        path: 'evidenceDocumentId',
        code: 'required',
        message: 'a juristic person records a manual payment with its evidence',
      });
    const note = [input.reference, input.notes].filter(Boolean).join(' ').trim();
    if (note.length < 5)
      errors.push({
        path: 'notes',
        code: 'required',
        message: 'say where the money came from (at least 5 characters)',
      });
    if (errors.length) throw new DomainException('validation.failed', { errors });
  }

  async reverse(ctx: TenantContext, paymentId: string, reason: string): Promise<PaymentRow> {
    await this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops.payment WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = await this.load(tx, ctx, paymentId);
      if (p.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (p.status !== 'confirmed')
        throw new DomainException('payment.invalid_state', { params: { status: p.status } });
      if (D(p.creditedAmount).gt(0)) {
        await this.lockCredit(tx, p.payerPartyId!, p.unitId);
        const credit = await this.creditBalance(tx, p.payerPartyId!, p.unitId);
        if (credit.lt(D(p.creditedAmount))) throw new DomainException('payment.credit_used');
        await tx.payerCredit.create({
          data: {
            tenantId: p.tenantId,
            buildingId: p.buildingId,
            unitId: p.unitId,
            partyId: p.payerPartyId!,
            kind: 'reversed',
            amount: D(p.creditedAmount).negated().toFixed(2),
            paymentId: p.id,
            note: reason,
            createdBy: by(),
          },
        });
      }
      const now = this.clock.now();
      for (const a of p.allocations.filter((x) => !x.reversedAt)) {
        await this.invoices.applyBalance(
          tx,
          a.invoiceId,
          { paid: D(a.amount).negated(), at: now },
          'reversal',
        );
        await tx.paymentAllocation.update({ where: { id: a.id }, data: { reversedAt: now } });
      }
      if (p.method === 'offset') {
        // the credit it consumed comes back
        const used = await tx.payerCredit.findFirst({ where: { paymentId: p.id, kind: 'applied' } });
        if (used)
          await tx.payerCredit.create({
            data: {
              tenantId: p.tenantId,
              buildingId: p.buildingId,
              unitId: p.unitId,
              partyId: p.payerPartyId!,
              kind: 'overpayment',
              amount: D(used.amount).negated().toFixed(2),
              paymentId: p.id,
              note: `reversal: ${reason}`,
              createdBy: by(),
            },
          });
      }
      await tx.payment.update({
        where: { id: p.id },
        data: {
          status: 'reversed',
          reversedAt: now,
          reverseReason: reason,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      for (const r of p.receipts.filter((x) => !x.voidedAt)) {
        await tx.receipt.update({
          where: { id: r.id },
          data: { voidedAt: now, voidReason: `payment reversed: ${reason}` },
        });
        await this.events.record(tx, {
          type: 'receipt.voided',
          aggregateType: 'receipt',
          aggregateId: r.id,
          tenantId: p.tenantId,
          buildingId: p.buildingId,
          payload: { receiptId: r.id, number: r.number, paymentId: p.id },
        });
        await this.audit.record(tx, {
          action: 'receipt.voided',
          tenantId: p.tenantId,
          buildingId: p.buildingId,
          subjectType: 'ops.receipt',
          subjectId: r.id,
          metadata: { reason },
        });
      }
      await this.audit.record(tx, {
        action: 'payment.reversed',
        tenantId: p.tenantId,
        buildingId: p.buildingId,
        subjectType: 'ops.payment',
        subjectId: p.id,
        metadata: { reason, amount: p.amount.toFixed(2) },
      });
      await this.events.record(tx, {
        type: 'payment.reversed',
        aggregateType: 'payment',
        aggregateId: p.id,
        tenantId: p.tenantId,
        buildingId: p.buildingId,
        payload: { paymentId: p.id, amount: p.amount.toFixed(2), reason },
      });
    });
    return this.get(ctx, paymentId);
  }

  async refund(
    ctx: TenantContext,
    input: {
      partyId: string;
      unitId: string;
      amount: string;
      method: 'bank_transfer' | 'cash';
      refundedAt: Date;
      reference?: string | null;
      evidenceDocumentId?: string | null;
      note?: string | null;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const unit = this.found(await tx.unit.findFirst({ where: { id: input.unitId, deletedAt: null } }));
      if (ctx.buildingIds && !ctx.buildingIds.includes(unit.buildingId))
        throw new DomainException('http.not_found');
      this.found(await tx.party.findFirst({ where: this.own(ctx, { id: input.partyId }) }));
      if (input.method === 'bank_transfer' && !input.evidenceDocumentId)
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'evidenceDocumentId', code: 'required', message: 'a transfer needs its evidence' },
          ],
        });
      await this.lockCredit(tx, input.partyId, input.unitId);
      const credit = await this.creditBalance(tx, input.partyId, input.unitId);
      if (D(input.amount).gt(credit))
        throw new DomainException('refund.exceeds_credit', { params: { credit: credit.toFixed(2) } });
      const refund = await tx.refund.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: unit.buildingId,
          unitId: unit.id,
          partyId: input.partyId,
          amount: D(input.amount).toFixed(2),
          method: input.method,
          reference: input.reference ?? null,
          evidenceDocumentId: input.evidenceDocumentId ?? null,
          refundedAt: input.refundedAt,
          recordedBy: by(),
          note: input.note ?? null,
        },
      });
      await tx.payerCredit.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: unit.buildingId,
          unitId: unit.id,
          partyId: input.partyId,
          kind: 'refunded',
          amount: D(input.amount).negated().toFixed(2),
          refundId: refund.id,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'payment.refunded',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'ops.refund',
        subjectId: refund.id,
        metadata: { amount: refund.amount.toFixed(2), method: refund.method, reference: refund.reference },
      });
      await this.events.record(tx, {
        type: 'payment.refunded',
        aggregateType: 'refund',
        aggregateId: refund.id,
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        payload: {
          refundId: refund.id,
          partyId: input.partyId,
          unitId: unit.id,
          amount: refund.amount.toFixed(2),
        },
      });
      return { refund, creditAfter: credit.minus(input.amount).toFixed(2) };
    });
  }

  // ------------------------------------------------------------------------------------------- reads

  async load(tx: Tx, ctx: TenantContext, id: string): Promise<PaymentRow> {
    const p = this.found(
      await tx.payment.findFirst({ where: this.own(ctx, { id }), include: PAYMENT_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(p.buildingId))
      throw new DomainException('http.not_found');
    return p;
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(
    ctx: TenantContext,
    q: {
      status?: Payment['status'];
      method?: PaymentMethod;
      invoiceId?: string;
      partyId?: string;
      unitId?: string;
      buildingId?: string;
      from?: Date;
      to?: Date;
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.PaymentWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.method ? { method: q.method } : {}),
        ...(q.invoiceId
          ? { OR: [{ invoiceId: q.invoiceId }, { allocations: { some: { invoiceId: q.invoiceId } } }] }
          : {}),
        ...(q.partyId ? { payerPartyId: q.partyId } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        ...(q.from || q.to
          ? { paidAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.payment.findMany({
          where,
          include: PAYMENT_INCLUDE,
          orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.payment.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** Credit balances per payer × unit (owner view). */
  credits(ctx: TenantContext, q: { partyId?: string; unitId?: string }) {
    return this.db.tenant(ctx, async (tx) => {
      const groups = await tx.payerCredit.groupBy({
        by: ['partyId', 'unitId', 'buildingId'],
        where: {
          tenantId: ctx.tenantId,
          ...(q.partyId ? { partyId: q.partyId } : {}),
          ...(q.unitId ? { unitId: q.unitId } : {}),
          ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        },
        _sum: { amount: true },
      });
      const parties = await tx.party.findMany({
        where: { id: { in: groups.map((g) => g.partyId) } },
        select: { id: true, displayName: true },
      });
      const units = await tx.unit.findMany({
        where: { id: { in: groups.map((g) => g.unitId).filter((u): u is string => Boolean(u)) } },
        select: { id: true, unitNo: true },
      });
      return groups.map((g) => ({
        partyId: g.partyId,
        partyName: parties.find((p) => p.id === g.partyId)?.displayName ?? '',
        unitId: g.unitId,
        unitNo: units.find((u) => u.id === g.unitId)?.unitNo ?? null,
        buildingId: g.buildingId,
        balance: D(g._sum.amount ?? 0).toFixed(2),
      }));
    });
  }

  /** Prisma's unique violation on (provider, provider_ref) under a race: the other transaction won. */
  static isDuplicate(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

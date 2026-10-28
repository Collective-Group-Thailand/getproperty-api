import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type PlatformInvoice, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { disputeCredit, type FeeCap, feeInvoice, FEES_PRODUCT } from './growth-products';
import { monthPeriod } from './messaging-addons.service';
import { PlatformBillingService } from './platform-billing.service';

const day = (d: Date) => d.toISOString().slice(0, 10);

export type FeeAccrualState = 'uninvoiced' | 'invoiced' | 'disputed' | 'credited';

export const FEE_ACCRUAL_INCLUDE = {
  tenant: { select: { id: true, displayName: true } },
  deal: { select: { id: true, leaseId: true, unit: { select: { unitNo: true } } } },
  platformInvoiceLine: { include: { invoice: { select: { id: true, number: true, state: true } } } },
  creditNote: { select: { id: true, state: true, number: true, amount: true } },
} as const satisfies Prisma.FeeAccrualInclude;
export type FeeAccrualRow = Prisma.FeeAccrualGetPayload<{ include: typeof FEE_ACCRUAL_INCLUDE }>;

export function accrualState(
  a: Pick<FeeAccrualRow, 'platformInvoiceLineId' | 'creditNote'>,
): FeeAccrualState {
  if (!a.platformInvoiceLineId) return 'uninvoiced';
  if (a.creditNote?.state === 'issued') return 'credited';
  if (a.creditNote?.state === 'requested') return 'disputed';
  return 'invoiced';
}

interface Charged {
  id: string;
  net: string;
  vatRate: string;
}

/**
 * Success and co-broke fees on the platform invoice (G5, D-287, D-293, D-297). G2 accrues a fee per deal at the
 * published price; here each agency gets **one** `purchase` platform invoice per run for the accruals of past Bangkok
 * months (job `growth-fees`, hourly, idempotent — an accrual's invoice line is set once, guarded by the database),
 * a monthly cap per kind (`terms.monthlyCapAmount` of the fee version that priced the month's latest accrual) as a
 * negative discount line. Never deducted from rent, never through the payment gateway (O-020); unpaid fees suspend
 * nothing (D-250). A dispute requests a platform credit note (D-091 maker-checker) for the accrual's charged amount.
 */
@Injectable()
export class FeeInvoicingService {
  private readonly logger = new Logger('FeeInvoicing');

  constructor(
    private readonly db: TenantTx,
    private readonly billing: PlatformBillingService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * One agency's fee invoice for its accruals before `before` (the first day of the current Bangkok month), inside
   * the caller's platform transaction; null when nothing is due.
   */
  async invoiceTenant(tx: Tx, tenantId: string, before: string): Promise<PlatformInvoice | null> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`growth-fees:${tenantId}`}))`;
    const accruals = await tx.feeAccrual.findMany({
      where: { tenantId, platformInvoiceLineId: null, accruedOn: { lt: new Date(`${before}T00:00:00Z`) } },
      include: { pricePlanVersion: true, deal: { select: { unit: { select: { unitNo: true } } } } },
      orderBy: [{ accruedOn: 'asc' }, { id: 'asc' }],
    });
    if (!accruals.length) return null;
    const inputs = accruals.map((a) => ({
      id: a.id,
      kind: a.kind,
      month: day(a.accruedOn).slice(0, 7),
      amount: a.amount.toFixed(2),
      vatRate: a.pricePlanVersion.vatRate.toString(),
      description: `${a.kind === 'success_fee' ? 'Success fee' : 'Co-broke fee'} — ดีลห้อง ${a.deal.unit.unitNo} (${day(a.accruedOn)})`,
    }));
    // the monthly cap of a month and kind: `terms.monthlyCapAmount` of the fee version that priced its latest accrual
    const caps = new Map<string, FeeCap>();
    for (const a of accruals) {
      const month = day(a.accruedOn).slice(0, 7);
      const cap = (a.pricePlanVersion.terms as { monthlyCapAmount?: unknown } | null)?.monthlyCapAmount;
      caps.set(`${month}|${a.kind}`, {
        kind: a.kind,
        month,
        capAmount: typeof cap === 'string' ? cap : null,
      });
    }
    const draft = feeInvoice(inputs, [...caps.values()]);
    const months = [...new Set(inputs.map((i) => i.month))].sort();
    const charged: Charged[] = draft.charged.map((c) => ({ id: c.id, net: c.net, vatRate: c.vatRate }));
    const invoice = await this.billing.issue(tx, null, {
      tenantId,
      kind: 'purchase',
      periodStart: monthPeriod(months[0]!).start,
      periodEnd: monthPeriod(months[months.length - 1]!).end,
      charges: draft.charges,
      snapshot: { product: FEES_PRODUCT, months, accruals: charged, capped: draft.capped, decision: 'D-297' },
    });
    const lines = await tx.platformInvoiceLine.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { lineNo: 'asc' },
      select: { id: true, lineNo: true },
    });
    for (const c of draft.charged) {
      const line = lines.find((l) => l.lineNo === c.lineIndex + 1)!;
      await tx.feeAccrual.update({ where: { id: c.id }, data: { platformInvoiceLineId: line.id } });
    }
    await this.audit.record(tx, {
      action: 'fee.invoiced',
      tenantId,
      subjectType: 'platform.platform_invoice',
      subjectId: invoice.id,
      after: { invoice: invoice.number, months, accruals: accruals.length, total: draft.charges.total },
    });
    await this.events.record(tx, {
      type: 'fee.invoiced',
      aggregateType: 'platform_invoice',
      aggregateId: invoice.id,
      tenantId,
      payload: {
        platformInvoiceId: invoice.id,
        months,
        accrualIds: accruals.map((a) => a.id),
        total: draft.charges.total,
      },
    });
    return invoice;
  }

  /** Job `growth-fees` (hourly, idempotent): every agency with accruals of past months gets its invoice. */
  async invoiceDue(): Promise<number> {
    const before = monthPeriod(bangkokDate(this.clock.now()).slice(0, 7)).start;
    return RequestContext.run({ actor: systemActor('growth-fees') }, async () => {
      const tenants = await this.db.platform((tx) =>
        tx.feeAccrual.groupBy({
          by: ['tenantId'],
          where: { platformInvoiceLineId: null, accruedOn: { lt: new Date(`${before}T00:00:00Z`) } },
        }),
      );
      let issued = 0;
      for (const { tenantId } of tenants) {
        try {
          const invoice = await this.db.platform((tx) => this.invoiceTenant(tx, tenantId, before), {
            tenantId,
          });
          if (invoice) issued += 1;
        } catch (error) {
          this.logger.error(`fee invoice of ${tenantId}: ${(error as Error).message}`);
        }
      }
      return issued;
    });
  }

  // ------------------------------------------------------------------------------------------------- admin

  list(filter: { tenantId?: string; state?: FeeAccrualState; skip: number; take: number }) {
    const where: Prisma.FeeAccrualWhereInput = {
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(filter.state === 'uninvoiced' ? { platformInvoiceLineId: null } : {}),
      ...(filter.state === 'invoiced'
        ? {
            platformInvoiceLineId: { not: null },
            OR: [{ creditNoteId: null }, { creditNote: { state: 'rejected' } }],
          }
        : {}),
      ...(filter.state === 'disputed' ? { creditNote: { state: 'requested' } } : {}),
      ...(filter.state === 'credited' ? { creditNote: { state: 'issued' } } : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.feeAccrual.findMany({
        where,
        include: FEE_ACCRUAL_INCLUDE,
        orderBy: [{ accruedOn: 'desc' }, { id: 'desc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.feeAccrual.count({ where }),
    }));
  }

  /**
   * A dispute (Finance, maker): a platform credit note for the accrual's charged amount incl. VAT on its invoice,
   * linked to the accrual; approved / rejected by another platform user (D-091). Not invoiced yet → 409
   * `fee.not_invoiced`; a note waiting or issued → 409 `fee.already_disputed`; a rejected one may be raised again.
   */
  async dispute(accrualId: string, reason: string): Promise<FeeAccrualRow> {
    await this.db.platform(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ops.fee_accrual WHERE id = ${accrualId}::uuid FOR UPDATE`;
      const accrual = await tx.feeAccrual.findUnique({
        where: { id: accrualId },
        include: { creditNote: true, platformInvoiceLine: { include: { invoice: true } } },
      });
      if (!accrual) throw new DomainException('http.not_found');
      const line = accrual.platformInvoiceLine;
      if (!line) throw new DomainException('fee.not_invoiced');
      if (accrual.creditNote && accrual.creditNote.state !== 'rejected')
        throw new DomainException('fee.already_disputed', { params: { state: accrual.creditNote.state } });
      const invoice = line.invoice;
      const snapshot = (invoice.snapshot ?? {}) as { accruals?: Charged[] };
      const charged = snapshot.accruals?.find((c) => c.id === accrual.id) ?? {
        id: accrual.id,
        net: accrual.amount.toFixed(2),
        vatRate: '0',
      };
      // a credit note never exceeds what is still unpaid (B6.1: money already paid is refunded by Finance outside)
      const room = (await this.billing.creditRoom(tx, invoice)).minus(invoice.paidTotal.toString());
      const amount = disputeCredit(charged.net, charged.vatRate, room.toFixed(2));
      if (Number(amount) <= 0)
        throw new DomainException('platform_invoice.amount_exceeds_open', {
          params: { open: room.toFixed(2) },
        });
      const note = await this.billing.requestCreditNoteIn(tx, invoice.id, {
        amount,
        reason: `ข้อโต้แย้งค่าธรรมเนียม (${accrual.kind}) — ${reason}`,
      });
      await tx.feeAccrual.update({ where: { id: accrual.id }, data: { creditNoteId: note.id } });
      await this.audit.record(tx, {
        action: 'fee.disputed',
        tenantId: accrual.tenantId,
        subjectType: 'ops.fee_accrual',
        subjectId: accrual.id,
        after: { creditNoteId: note.id, amount, reason, invoice: invoice.number },
      });
      await this.events.record(tx, {
        type: 'fee.disputed',
        aggregateType: 'deal',
        aggregateId: accrual.dealId,
        tenantId: accrual.tenantId,
        payload: {
          feeAccrualId: accrual.id,
          platformInvoiceId: invoice.id,
          platformCreditNoteId: note.id,
          amount,
        },
      });
    });
    return this.db.platform(async (tx) =>
      tx.feeAccrual.findUniqueOrThrow({ where: { id: accrualId }, include: FEE_ACCRUAL_INCLUDE }),
    );
  }
}

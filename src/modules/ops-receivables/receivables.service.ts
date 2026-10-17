import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Prisma, type ReceivableEntryType } from '@generated/prisma/client';
import { InvoicesService } from '@modules/ops-billing/invoices.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type AgingBucket, positionOf, totalsOf } from './aging';

const D = (v: { toString(): string } | Decimal.Value) => new Decimal(v.toString());
const OPEN = ['issued', 'partially_paid', 'overdue'] as const;
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export interface ReceivableKey {
  tenantId: string;
  buildingId: string;
  partyId: string;
  unitId: string | null;
}

interface Posting extends ReceivableKey {
  leaseId: string | null;
  entryType: ReceivableEntryType;
  refType: string;
  refId: string;
  amount: Decimal;
  occurredAt: Date;
}

export const BALANCE_INCLUDE = {
  party: { select: { id: true, displayName: true } },
  unit: { select: { id: true, unitNo: true } },
  building: { select: { id: true, name: true } },
} as const satisfies Prisma.ReceivableBalanceInclude;
export type BalanceRow = Prisma.ReceivableBalanceGetPayload<{ include: typeof BALANCE_INCLUDE }>;

/**
 * Receivables (B4.5, D-044, D-045): a ledger per billed party × unit (`ops.receivable_entry`, append-only) posted by
 * the subscriber of the business events — invoice issued +, voided −, credit note −, debit note +, payment − (what
 * came in, its credit part included; a use of credit is no movement), reversal +, refund + — and the materialised
 * position (`ops.receivable_balance`) recomputed from the open invoices and the payer's credit in the same
 * transaction, with aging buckets. Net balance = Σ open invoice balances − credit = Σ entries (from B4.5 on).
 * The `receivables` worker job marks invoices past due `overdue` (`invoice.overdue`, which starts dunning) and
 * refreshes the aging of every open position daily.
 */
@Injectable()
export class ReceivablesService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'receivables';
  readonly eventTypes = [
    'invoice.issued',
    'invoice.voided',
    'credit_note.issued',
    'debit_note.issued',
    'payment.confirmed',
    'payment.reversed',
    'payment.refunded',
  ] as const;
  private readonly logger = new Logger(ReceivablesService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly invoices: InvoicesService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ------------------------------------------------------------------------------------------- ledger

  private async postingOf(tx: Tx, e: DomainEventEnvelope): Promise<Posting | null> {
    const p = e.payload;
    switch (e.type) {
      case 'invoice.issued':
      case 'invoice.voided': {
        const inv = await tx.invoice.findUnique({ where: { id: p.invoiceId as string } });
        if (!inv) return null;
        const issued = e.type === 'invoice.issued';
        return {
          tenantId: inv.tenantId,
          buildingId: inv.buildingId,
          partyId: inv.billedPartyId,
          unitId: inv.unitId,
          leaseId: inv.leaseId,
          entryType: 'invoice',
          refType: issued ? 'invoice' : 'invoice_void',
          refId: inv.id,
          amount: issued ? D(inv.total) : D(inv.total).negated(),
          occurredAt: (issued ? inv.issuedAt : inv.voidedAt) ?? new Date(e.occurredAt),
        };
      }
      case 'credit_note.issued':
      case 'debit_note.issued': {
        const credit = e.type === 'credit_note.issued';
        const note = credit
          ? await tx.creditNote.findUnique({ where: { id: p.noteId as string }, include: { invoice: true } })
          : await tx.debitNote.findUnique({ where: { id: p.noteId as string }, include: { invoice: true } });
        if (!note) return null;
        return {
          tenantId: note.tenantId,
          buildingId: note.buildingId,
          partyId: note.invoice.billedPartyId,
          unitId: note.invoice.unitId,
          leaseId: note.invoice.leaseId,
          entryType: credit ? 'credit_note' : 'debit_note',
          refType: credit ? 'credit_note' : 'debit_note',
          refId: note.id,
          amount: credit ? D(note.total).negated() : D(note.total),
          occurredAt: note.issuedAt,
        };
      }
      case 'payment.confirmed':
      case 'payment.reversed': {
        const pay = await tx.payment.findUnique({ where: { id: p.paymentId as string } });
        // a use of the payer's credit moves nothing: the credit was counted when the money came in
        if (!pay?.payerPartyId || pay.method === 'offset') return null;
        const total = D(pay.amount).plus(D(pay.whtAmount));
        const confirmed = e.type === 'payment.confirmed';
        return {
          tenantId: pay.tenantId,
          buildingId: pay.buildingId,
          partyId: pay.payerPartyId,
          unitId: pay.unitId,
          leaseId: pay.leaseId,
          entryType: 'payment',
          refType: confirmed ? 'payment' : 'payment_reversal',
          refId: pay.id,
          amount: confirmed ? total.negated() : total,
          occurredAt: confirmed ? pay.paidAt : (pay.reversedAt ?? new Date(e.occurredAt)),
        };
      }
      case 'payment.refunded': {
        const r = await tx.refund.findUnique({ where: { id: p.refundId as string } });
        if (!r) return null;
        return {
          tenantId: r.tenantId,
          buildingId: r.buildingId,
          partyId: r.partyId,
          unitId: r.unitId,
          leaseId: null,
          entryType: 'refund',
          refType: 'refund',
          refId: r.id,
          amount: D(r.amount),
          occurredAt: r.refundedAt,
        };
      }
      default:
        return null;
    }
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const posting = await this.postingOf(tx, event);
    if (!posting || posting.amount.eq(0)) return;
    const exists = await tx.receivableEntry.findFirst({ where: { eventId: event.id } });
    if (exists) return;
    await tx.receivableEntry.create({
      data: {
        tenantId: posting.tenantId,
        buildingId: posting.buildingId,
        unitId: posting.unitId,
        partyId: posting.partyId,
        leaseId: posting.leaseId,
        entryType: posting.entryType,
        refType: posting.refType,
        refId: posting.refId,
        amount: posting.amount.toFixed(2),
        occurredAt: posting.occurredAt,
        eventId: event.id,
      },
    });
    await this.refresh(tx, posting, { eventId: event.id, entryType: posting.entryType });
  }

  /**
   * Recomputes the position of a party × unit from its open invoices and credit (as of today in Bangkok) and stores
   * it; `receivable.changed` when the numbers moved.
   */
  async refresh(tx: Tx, key: ReceivableKey, cause: Record<string, unknown> = {}): Promise<BalanceRow | null> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receivable:${key.partyId}:${key.unitId ?? '-'}`}))`;
    const today = bangkokDate(this.clock.now());
    const [open, credit] = await Promise.all([
      tx.invoice.findMany({
        where: {
          tenantId: key.tenantId,
          billedPartyId: key.partyId,
          unitId: key.unitId,
          status: { in: [...OPEN] },
          balance: { gt: 0 },
        },
        select: { balance: true, dueDate: true },
      }),
      tx.payerCredit.aggregate({
        where: { tenantId: key.tenantId, partyId: key.partyId, unitId: key.unitId },
        _sum: { amount: true },
      }),
    ]);
    const pos = positionOf(
      open.map((i) => ({ balance: i.balance.toString(), dueOn: dayOf(i.dueDate) })),
      D(credit._sum.amount ?? 0),
      today,
    );
    const where = { tenantId: key.tenantId, partyId: key.partyId, unitId: key.unitId };
    const existing = await tx.receivableBalance.findFirst({ where });
    const data = {
      buildingId: key.buildingId,
      balance: pos.balance,
      openInvoicesCount: pos.openInvoicesCount,
      oldestDueDate: pos.oldestDueOn ? new Date(`${pos.oldestDueOn}T00:00:00Z`) : null,
      daysOverdue: pos.daysOverdue,
      aging: pos.aging as unknown as Prisma.InputJsonValue,
      creditBalance: pos.creditBalance,
    };
    const unchanged =
      existing &&
      D(existing.balance).eq(pos.balance) &&
      D(existing.creditBalance).eq(pos.creditBalance) &&
      existing.daysOverdue === pos.daysOverdue &&
      existing.openInvoicesCount === pos.openInvoicesCount &&
      JSON.stringify(existing.aging) === JSON.stringify(pos.aging);
    if (unchanged) return null;
    const row = existing
      ? await tx.receivableBalance.update({
          where: { id: existing.id },
          data: { ...data, version: { increment: 1 } },
          include: BALANCE_INCLUDE,
        })
      : await tx.receivableBalance.create({ data: { ...where, ...data }, include: BALANCE_INCLUDE });
    if (!existing || !D(existing.balance).eq(pos.balance))
      await this.events.record(tx, {
        type: 'receivable.changed',
        aggregateType: 'receivable_balance',
        aggregateId: row.id,
        tenantId: key.tenantId,
        buildingId: key.buildingId,
        payload: {
          partyId: key.partyId,
          unitId: key.unitId,
          balance: pos.balance,
          previousBalance: existing ? existing.balance.toFixed(2) : '0.00',
          daysOverdue: pos.daysOverdue,
          ...cause,
        },
      });
    return row;
  }

  // ------------------------------------------------------------------------------------------- daily

  /**
   * Worker job `receivables` (hourly; idempotent): invoices whose due date has passed become `overdue`
   * (`invoice.overdue` → dunning, penalty assessment), and every position with something open is re-aged.
   */
  async sweep(): Promise<{ overdue: number; refreshed: number }> {
    const now = this.clock.now();
    const today = bangkokDate(now);
    return RequestContext.run({ actor: systemActor('receivables') }, async () => {
      const due = await this.db.platform((tx) =>
        tx.invoice.findMany({
          where: {
            status: { in: ['issued', 'partially_paid'] },
            balance: { gt: 0 },
            dueDate: { lt: new Date(`${today}T00:00:00Z`) },
          },
          select: { id: true, tenantId: true },
          orderBy: { dueDate: 'asc' },
          take: 5000,
        }),
      );
      let overdue = 0;
      for (const inv of due) {
        try {
          await this.db.tenant(systemTenantContext(inv.tenantId), async (tx) => {
            const after = await this.invoices.applyBalance(tx, inv.id, {}, 'overdue');
            if (after.status !== 'overdue') return;
            overdue += 1;
            await this.events.record(tx, {
              type: 'invoice.overdue',
              aggregateType: 'invoice',
              aggregateId: inv.id,
              tenantId: after.tenantId,
              buildingId: after.buildingId,
              payload: {
                invoiceId: inv.id,
                number: after.number,
                dueDate: dayOf(after.dueDate),
                balance: after.balance.toFixed(2),
                billedPartyId: after.billedPartyId,
                unitId: after.unitId,
                leaseId: after.leaseId,
              },
            });
          });
        } catch (error) {
          this.logger.error(`overdue ${inv.id}: ${(error as Error).message}`);
        }
      }
      const keys = await this.db.platform(
        (tx) =>
          tx.$queryRaw<ReceivableKey[]>`
          SELECT DISTINCT tenant_id AS "tenantId", building_id AS "buildingId", billed_party_id AS "partyId", unit_id AS "unitId"
            FROM ops.invoice WHERE status IN ('issued', 'partially_paid', 'overdue') AND balance > 0
          UNION
          SELECT tenant_id, building_id, party_id, unit_id FROM ops.receivable_balance
           WHERE open_invoices_count > 0 OR balance <> 0`,
      );
      let refreshed = 0;
      for (const k of keys) {
        try {
          const changed = await this.db.tenant(systemTenantContext(k.tenantId), (tx) => this.refresh(tx, k));
          if (changed) refreshed += 1;
        } catch (error) {
          this.logger.error(`receivable ${k.partyId}/${k.unitId}: ${(error as Error).message}`);
        }
      }
      return { overdue, refreshed };
    });
  }

  // ------------------------------------------------------------------------------------------- owner reads

  /** Arrears list (`GET /v1/owner/receivables`) with totals over every matching row. */
  list(
    ctx: TenantContext,
    q: {
      buildingId?: string;
      partyId?: string;
      unitId?: string;
      minDaysOverdue?: number;
      bucket?: AgingBucket;
      arrearsOnly?: boolean;
      sort?: 'balance' | 'days_overdue' | 'unit';
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.ReceivableBalanceWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        ...(q.partyId ? { partyId: q.partyId } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.minDaysOverdue !== undefined ? { daysOverdue: { gte: q.minDaysOverdue } } : {}),
        ...(q.arrearsOnly !== false
          ? { balance: { gt: 0 } }
          : { OR: [{ balance: { not: 0 } }, { openInvoicesCount: { gt: 0 } }] }),
        ...(q.bucket ? { aging: { path: [q.bucket], not: '0.00' } } : {}),
      };
      const orderBy: Prisma.ReceivableBalanceOrderByWithRelationInput[] =
        q.sort === 'days_overdue'
          ? [{ daysOverdue: 'desc' }, { balance: 'desc' }]
          : q.sort === 'unit'
            ? [{ unit: { unitNo: 'asc' } }]
            : [{ balance: 'desc' }, { daysOverdue: 'desc' }];
      const [rows, all] = await Promise.all([
        tx.receivableBalance.findMany({
          where,
          include: BALANCE_INCLUDE,
          orderBy: [...orderBy, { id: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.receivableBalance.findMany({ where, select: { balance: true, creditBalance: true, aging: true } }),
      ]);
      const totals = totalsOf(
        all.map((r) => ({
          balance: r.balance.toFixed(2),
          creditBalance: r.creditBalance.toFixed(2),
          aging: r.aging as never,
        })),
      );
      return { rows, total: all.length, totals: { ...totals, count: all.length } };
    });
  }

  /** The ledger of one party × unit (`GET /v1/owner/receivables/entries`), oldest first with the running balance. */
  entries(ctx: TenantContext, q: { partyId: string; unitId?: string | null; skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      this.found(await tx.party.findFirst({ where: this.own(ctx, { id: q.partyId }) }));
      const where: Prisma.ReceivableEntryWhereInput = {
        tenantId: ctx.tenantId,
        partyId: q.partyId,
        ...(q.unitId !== undefined ? { unitId: q.unitId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total, before] = await Promise.all([
        tx.receivableEntry.findMany({
          where,
          orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          skip: q.skip,
          take: q.take,
          include: { unit: { select: { unitNo: true } } },
        }),
        tx.receivableEntry.count({ where }),
        q.skip > 0
          ? tx.receivableEntry.findMany({
              where,
              orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
              take: q.skip,
              select: { amount: true },
            })
          : Promise.resolve([] as { amount: Decimal.Value }[]),
      ]);
      let running = before.reduce((s, r) => s.plus(D(r.amount)), new Decimal(0));
      return {
        rows: rows.map((r) => {
          running = running.plus(D(r.amount));
          return { ...r, runningBalance: running.toFixed(2) };
        }),
        total,
      };
    });
  }

  /** One position; 404 when not mine. */
  async position(ctx: TenantContext, partyId: string, unitId: string | null) {
    return this.db.tenant(ctx, async (tx) => {
      const row = await tx.receivableBalance.findFirst({
        where: { tenantId: ctx.tenantId, partyId, unitId },
        include: BALANCE_INCLUDE,
      });
      if (!row || (ctx.buildingIds && !ctx.buildingIds.includes(row.buildingId)))
        throw new DomainException('http.not_found');
      return row;
    });
  }
}

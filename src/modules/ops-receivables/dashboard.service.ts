import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ComplianceScoreService, monthWindow } from '@core/compliance/compliance-score.service';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { AGING_BUCKETS, type AgingBuckets, totalsOf } from './aging';

const m2 = (v: { toString(): string } | null | undefined) => new Decimal((v ?? 0).toString()).toFixed(2);
const pct = (part: Decimal, whole: Decimal) =>
  whole.gt(0) ? part.div(whole).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;

export interface Dashboard {
  month: string;
  today: string;
  buildingId: string | null;
  income: {
    received: string;
    payments: number;
    byMethod: { method: string; amount: string; count: number }[];
  };
  billing: {
    billed: string;
    invoices: number;
    collected: string;
    collectedPct: string | null;
    outstanding: string;
  };
  arrears: { balance: string; invoices: number; parties: number; aging: AgingBuckets; credit: string };
  dueToday: { balance: string; invoices: number };
  attention: { slipsToReview: number; draftsToReview: number };
  cycles: {
    propertyId: string;
    propertyName: string;
    periodKey: string;
    status: string;
    autoIssueAt: string | null;
    issuedAt: string | null;
  }[];
  compliance: {
    score: string;
    invoicesTotal: number;
    invoicesWithinRate: number;
    linesAboveCap: number;
    linesAboveCapAcknowledged: number;
  };
  loss: {
    buildingId: string;
    buildingName: string;
    utility: string;
    periodStart: string;
    periodEnd: string;
    lossPct: string | null;
    lossThb: string;
  }[];
}

/**
 * The owner dashboard, first version (B4.5): income received this month, billed vs collected (of the invoices
 * issued this month), arrears with aging, what falls due today, slips and drafts waiting, the billing cycle of each
 * property, the compliance score of the month (above-cap lines included, D-190) and the latest loss % per building
 * and utility (B3.4). Every number respects building-limited staff.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: TenantTx,
    private readonly scores: ComplianceScoreService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async dashboard(ctx: TenantContext, q: { month?: string; buildingId?: string }): Promise<Dashboard> {
    const now = this.clock.now();
    const today = bangkokDate(now);
    const month = q.month ?? today.slice(0, 7);
    const w = monthWindow(month);
    if (q.buildingId && ctx.buildingIds && !ctx.buildingIds.includes(q.buildingId))
      throw new DomainException('http.not_found');
    const buildingFilter = q.buildingId
      ? { buildingId: q.buildingId }
      : ctx.buildingIds
        ? { buildingId: { in: [...ctx.buildingIds] } }
        : {};
    const scope = { tenantId: ctx.tenantId, ...buildingFilter };
    const data = await this.db.tenant(ctx, async (tx) => {
      if (q.buildingId) {
        const b = await tx.building.findFirst({ where: { id: q.buildingId, deletedAt: null } });
        if (!b) throw new DomainException('http.not_found');
      }
      const todayDate = new Date(`${today}T00:00:00Z`);
      const [received, byMethod, issued, overdue, overdueParties, dueToday, balances, slips, drafts, loss] =
        await Promise.all([
          tx.payment.aggregate({
            where: {
              ...scope,
              status: 'confirmed',
              method: { not: 'offset' },
              paidAt: { gte: w.start, lt: w.end },
            },
            _sum: { amount: true },
            _count: true,
          }),
          tx.payment.groupBy({
            by: ['method'],
            where: {
              ...scope,
              status: 'confirmed',
              method: { not: 'offset' },
              paidAt: { gte: w.start, lt: w.end },
            },
            _sum: { amount: true },
            _count: true,
            orderBy: { method: 'asc' },
          }),
          tx.invoice.aggregate({
            where: { ...scope, issuedAt: { gte: w.start, lt: w.end }, status: { not: 'void' } },
            _sum: { total: true, paidTotal: true, creditedTotal: true, debitedTotal: true, balance: true },
            _count: true,
          }),
          tx.invoice.aggregate({
            where: { ...scope, status: 'overdue', balance: { gt: 0 } },
            _sum: { balance: true },
            _count: true,
          }),
          tx.invoice.groupBy({
            by: ['billedPartyId'],
            where: { ...scope, status: 'overdue', balance: { gt: 0 } },
          }),
          tx.invoice.aggregate({
            where: {
              ...scope,
              status: { in: ['issued', 'partially_paid'] },
              balance: { gt: 0 },
              dueDate: todayDate,
            },
            _sum: { balance: true },
            _count: true,
          }),
          tx.receivableBalance.findMany({
            where: { ...scope, OR: [{ balance: { not: 0 } }, { openInvoicesCount: { gt: 0 } }] },
            select: { balance: true, creditBalance: true, aging: true },
          }),
          tx.slipReview.count({ where: { ...scope, status: { in: ['pending_review', 'duplicate'] } } }),
          tx.invoice.count({ where: { ...scope, status: 'draft' } }),
          tx.lossReport.findMany({
            where: scope,
            orderBy: [{ periodStart: 'desc' }, { computedAt: 'desc' }],
            include: { building: { select: { name: true } } },
            take: 200,
          }),
        ]);
      const properties = await tx.property.findMany({
        where: {
          tenantId: ctx.tenantId,
          deletedAt: null,
          ...(q.buildingId || ctx.buildingIds
            ? {
                buildings: {
                  some: { id: q.buildingId ? q.buildingId : { in: [...(ctx.buildingIds ?? [])] } },
                },
              }
            : {}),
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      const cycles = [];
      for (const p of properties) {
        const c = await tx.billingCycle.findFirst({
          where: { tenantId: ctx.tenantId, propertyId: p.id },
          orderBy: { periodStart: 'desc' },
        });
        if (c)
          cycles.push({
            propertyId: p.id,
            propertyName: p.name,
            periodKey: c.periodKey,
            status: c.status,
            autoIssueAt: c.autoIssueAt?.toISOString() ?? null,
            issuedAt: c.issuedAt?.toISOString() ?? null,
          });
      }
      const latest = new Map<string, (typeof loss)[number]>();
      for (const r of loss) {
        const k = `${r.buildingId}|${r.utility}`;
        if (!latest.has(k)) latest.set(k, r);
      }
      return {
        received,
        byMethod,
        issued,
        overdue,
        overdueParties,
        dueToday,
        balances,
        slips,
        drafts,
        cycles,
        latest,
      };
    });
    const billedNet = new Decimal(m2(data.issued._sum.total))
      .plus(m2(data.issued._sum.debitedTotal))
      .minus(m2(data.issued._sum.creditedTotal));
    const collected = new Decimal(m2(data.issued._sum.paidTotal));
    const totals = totalsOf(
      data.balances.map((b) => ({
        balance: m2(b.balance),
        creditBalance: m2(b.creditBalance),
        aging: {
          ...Object.fromEntries(AGING_BUCKETS.map((k) => [k, '0.00'])),
          ...(b.aging as object),
        } as unknown as AgingBuckets,
      })),
    );
    const score = await this.scores.compute(ctx.tenantId, month);
    return {
      month,
      today,
      buildingId: q.buildingId ?? null,
      income: {
        received: m2(data.received._sum.amount),
        payments: data.received._count,
        byMethod: data.byMethod.map((g) => ({
          method: g.method,
          amount: m2(g._sum.amount),
          count: g._count,
        })),
      },
      billing: {
        billed: m2(data.issued._sum.total),
        invoices: data.issued._count,
        collected: collected.toFixed(2),
        collectedPct: pct(collected, billedNet),
        outstanding: m2(data.issued._sum.balance),
      },
      arrears: {
        balance: m2(data.overdue._sum.balance),
        invoices: data.overdue._count,
        parties: data.overdueParties.length,
        aging: totals.aging,
        credit: totals.creditBalance,
      },
      dueToday: { balance: m2(data.dueToday._sum.balance), invoices: data.dueToday._count },
      attention: { slipsToReview: data.slips, draftsToReview: data.drafts },
      cycles: data.cycles,
      compliance: {
        score: score.score.toFixed(2),
        invoicesTotal: score.invoicesTotal,
        invoicesWithinRate: score.invoicesWithinRate,
        linesAboveCap: score.linesAboveCap,
        linesAboveCapAcknowledged: score.linesAboveCapAcknowledged,
      },
      loss: [...data.latest.values()].map((r) => ({
        buildingId: r.buildingId,
        buildingName: r.building.name,
        utility: r.utility,
        periodStart: r.periodStart.toISOString().slice(0, 10),
        periodEnd: r.periodEnd.toISOString().slice(0, 10),
        lossPct: r.lossPct ? new Decimal(r.lossPct.toString()).toFixed(2) : null,
        lossThb: m2(r.lossThb),
      })),
    };
  }
}

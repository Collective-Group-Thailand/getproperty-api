import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type CollectionAction, type ExportJob } from '@generated/prisma/client';
import { type ExportBuilder, type ExportFile, ExportsService } from '@modules/ops-documents/exports.service';
import { PaymentsService } from '@modules/ops-payments/payments.service';
import { csvOf } from '@modules/ops-receivables/exports/sheets';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { AccountingReportsService } from './accounting/accounting-reports.service';
import {
  agingBounds,
  type AgingReport,
  juristicAging,
  monthsBetween,
  ratePct,
} from './collections/juristic-aging';
import { legalReviewRequired, stepDueOn } from './collections/ladder-templates';
import { residentUnitAccess } from './resident-unit-access';
import { partyChannels } from './statements.service';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

export type ReceivablesTab = 'all' | 'at_step' | 'plan' | 'dispute';
export type ReceivablesSort = 'amount' | 'age';

export interface ReceivableRow {
  unitId: string;
  unitNo: string;
  buildingId: string;
  partyId: string;
  ownerName: string;
  context: { ownsUnits: number; nonResident: boolean; agent: boolean };
  outstanding: string;
  surcharge: string;
  oldestOverdueOn: string | null;
  oldestOverdueMonths: number;
  daysOverdue: number;
  nextStep: {
    kind: CollectionAction;
    dueOn: string;
    legalReviewRequired: boolean;
    awaitingApproval: boolean;
  } | null;
  caseId: string | null;
  caseState: 'open' | 'paused' | null;
  disputeOpen: boolean;
  planId: string | null;
  channels: string[];
}

/** Rows per tab for the same search (J-CR): the console's tab badges. */
export interface ReceivableTabCounts {
  all: number;
  atStep: number;
  plan: number;
  dispute: number;
}

export interface ReceivablesQuery {
  tab?: ReceivablesTab;
  q?: string;
  sort?: ReceivablesSort;
  /** desc (default): largest / oldest first. */
  order?: 'asc' | 'desc';
  buildingId?: string;
}

/**
 * Juristic receivables reports (D-326): the console's receivables list (tabs all · at step · plan · dispute, search by
 * unit or owner, sort by amount or age; per row the owner and context, outstanding, surcharge, oldest overdue months,
 * next ladder step with its legal-review flag, channels) and its CSV export (`juristic_receivables_csv`, worker);
 * aging in the juristic buckets (`juristic.aging_buckets`) per building and overall; collection rate per billing cycle
 * and within `juristic.kpi_collection_days` of the due date; budget vs actual — income from billing, expenses from the journals (J2.1, D-329).
 */
@Injectable()
export class CollectionReportsService extends TenantScopedRepository implements ExportBuilder, OnModuleInit {
  readonly kind = 'juristic_receivables_csv' as const;

  constructor(
    private readonly db: TenantTx,
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
    private readonly exports: ExportsService,
    private readonly accounting: AccountingReportsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.exports.register(this);
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  // ------------------------------------------------------------------------------------------- receivables

  async rowsOf(
    tx: Tx,
    tenantId: string,
    buildingIds: readonly string[] | null | undefined,
    q: ReceivablesQuery,
    counts: ReceivableTabCounts = { all: 0, atStep: 0, plan: 0, dispute: 0 },
  ): Promise<ReceivableRow[]> {
    const today = this.today();
    const scope = q.buildingId ? [q.buildingId] : buildingIds ? [...buildingIds] : null;
    const groups = await tx.$queryRaw<
      {
        party_id: string;
        unit_id: string;
        building_id: string;
        outstanding: string;
        oldest_overdue: Date | null;
        invoice_ids: string[];
      }[]
    >`
      SELECT i.billed_party_id AS party_id, i.unit_id, i.building_id, sum(i.balance)::text AS outstanding,
             min(i.due_date) FILTER (WHERE i.due_date < ${today}::date) AS oldest_overdue,
             array_agg(i.id) AS invoice_ids
        FROM ops.invoice i
       WHERE i.tenant_id = ${tenantId}::uuid AND i.status IN ('issued', 'partially_paid', 'overdue')
         AND i.balance > 0 AND i.unit_id IS NOT NULL
         AND (${scope}::uuid[] IS NULL OR i.building_id = ANY(${scope}::uuid[]))
       GROUP BY 1, 2, 3`;
    const plans = await tx.paymentPlan.findMany({
      where: { tenantId, state: 'active', ...(scope ? { buildingId: { in: scope } } : {}) },
      include: { instalments: true },
    });
    const cases = await tx.collectionCase.findMany({
      where: { tenantId, state: { in: ['open', 'paused'] }, ...(scope ? { buildingId: { in: scope } } : {}) },
      include: {
        ladder: { include: { steps: { orderBy: { seq: 'asc' } } } },
        events: { where: { kind: 'step', outcome: 'sent' }, select: { id: true } },
      },
    });
    const key = (p: string, u: string) => `${p}:${u}`;
    const keys = new Map<string, { partyId: string; unitId: string; buildingId: string }>();
    for (const g of groups)
      keys.set(key(g.party_id, g.unit_id), {
        partyId: g.party_id,
        unitId: g.unit_id,
        buildingId: g.building_id,
      });
    for (const p of plans)
      keys.set(key(p.partyId, p.unitId), { partyId: p.partyId, unitId: p.unitId, buildingId: p.buildingId });
    for (const c of cases)
      keys.set(key(c.partyId, c.unitId), { partyId: c.partyId, unitId: c.unitId, buildingId: c.buildingId });
    if (!keys.size) return [];
    const entries = [...keys.values()];
    const unitIds = [...new Set(entries.map((e) => e.unitId))];
    const partyIds = [...new Set(entries.map((e) => e.partyId))];
    const [units, parties, ownerships, occupancies, billTos, pending] = await Promise.all([
      tx.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, unitNo: true } }),
      tx.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, displayName: true } }),
      tx.unitOwnership.findMany({
        where: {
          tenantId,
          partyId: { in: partyIds },
          validFrom: { lte: asDate(today) },
          OR: [{ validTo: null }, { validTo: { gt: asDate(today) } }],
        },
        select: { partyId: true, unitId: true },
      }),
      tx.occupancy.findMany({
        where: {
          unitId: { in: unitIds },
          partyId: { in: partyIds },
          validFrom: { lte: asDate(today) },
          OR: [{ validTo: null }, { validTo: { gt: asDate(today) } }],
        },
        select: { partyId: true, unitId: true },
      }),
      tx.billTo.findMany({
        where: {
          tenantId,
          billToPartyId: { in: partyIds },
          kind: 'agency',
          validFrom: { lte: asDate(today) },
          OR: [{ validTo: null }, { validTo: { gt: asDate(today) } }],
        },
        select: { billToPartyId: true, unitId: true },
      }),
      tx.invoiceCharge.findMany({
        where: {
          tenantId,
          status: 'pending',
          lineKind: { in: ['late_fee', 'plan_instalment'] },
          partyId: { in: partyIds },
          unitId: { in: unitIds },
        },
        select: { partyId: true, unitId: true, amount: true, lineKind: true },
      }),
    ]);
    const surchargeOpen = await this.payments.surchargeOpen(
      tx,
      groups.flatMap((g) => g.invoice_ids),
    );
    const channelsOf = await partyChannels(this.db, partyIds);
    const rows: ReceivableRow[] = [];
    for (const e of entries) {
      const g = groups.find((x) => x.party_id === e.partyId && x.unit_id === e.unitId);
      const plan = plans.find((p) => p.partyId === e.partyId && p.unitId === e.unitId);
      const c = cases.find((x) => x.partyId === e.partyId && x.unitId === e.unitId);
      const pend = pending.filter((p) => p.partyId === e.partyId && p.unitId === e.unitId);
      const scheduled = plan
        ? plan.instalments.filter((i) => i.state === 'scheduled').reduce((s, i) => s.plus(D(i.amount)), D(0))
        : D(0);
      const outstanding = D(g?.outstanding ?? 0)
        .plus(pend.reduce((s, p) => s.plus(D(p.amount)), D(0)))
        .plus(scheduled);
      const surcharge = (g?.invoice_ids ?? [])
        .reduce((s, id) => s.plus(surchargeOpen.get(id) ?? 0), D(0))
        .plus(pend.filter((p) => p.lineKind === 'late_fee').reduce((s, p) => s.plus(D(p.amount)), D(0)));
      const oldest = g?.oldest_overdue ? day(g.oldest_overdue) : null;
      let nextStep: ReceivableRow['nextStep'] = null;
      if (c && c.state === 'open') {
        const step = c.awaitingStepId
          ? c.ladder.steps.find((s) => s.id === c.awaitingStepId)
          : c.ladder.steps.find((s) => s.seq >= c.nextSeq && s.enabled);
        if (step)
          nextStep = {
            kind: step.action,
            dueOn: stepDueOn(day(c.anchorOn), step.offsetDays, c.pausedDays),
            legalReviewRequired: legalReviewRequired(step.action),
            awaitingApproval: c.awaitingStepId === step.id,
          };
      }
      const channels = channelsOf.get(e.partyId) ?? [];
      rows.push({
        unitId: e.unitId,
        unitNo: units.find((u) => u.id === e.unitId)?.unitNo ?? '',
        buildingId: e.buildingId,
        partyId: e.partyId,
        ownerName: parties.find((p) => p.id === e.partyId)?.displayName ?? '',
        context: {
          ownsUnits: new Set(ownerships.filter((o) => o.partyId === e.partyId).map((o) => o.unitId)).size,
          nonResident: !occupancies.some((o) => o.partyId === e.partyId && o.unitId === e.unitId),
          agent: billTos.some((b) => b.billToPartyId === e.partyId && b.unitId === e.unitId),
        },
        outstanding: outstanding.toFixed(2),
        surcharge: surcharge.toFixed(2),
        oldestOverdueOn: oldest,
        oldestOverdueMonths: oldest ? monthsBetween(oldest, today) : 0,
        daysOverdue: oldest
          ? Math.max(0, Math.round((asDate(today).getTime() - asDate(oldest).getTime()) / 86_400_000))
          : 0,
        nextStep,
        caseId: c?.id ?? null,
        caseState: (c?.state as 'open' | 'paused' | undefined) ?? null,
        disputeOpen: Boolean(c?.disputeOpenedAt),
        planId: plan?.id ?? null,
        channels: channels.length ? channels : ['letter'],
      });
    }
    const tab = q.tab ?? 'all';
    const needle = q.q?.trim().toLowerCase();
    const inTab = (r: ReceivableRow, t: ReceivablesTab) => {
      if (t === 'at_step')
        return Boolean(r.caseId && cases.find((c) => c.id === r.caseId)!.events.length > 0);
      if (t === 'plan') return Boolean(r.planId);
      if (t === 'dispute') return r.disputeOpen;
      return true;
    };
    const base = rows.filter((r) => {
      if (D(r.outstanding).lte(0) && !r.planId && !r.caseId) return false;
      if (needle && !r.unitNo.toLowerCase().includes(needle) && !r.ownerName.toLowerCase().includes(needle))
        return false;
      return true;
    });
    counts.all = base.length;
    counts.atStep = base.filter((r) => inTab(r, 'at_step')).length;
    counts.plan = base.filter((r) => inTab(r, 'plan')).length;
    counts.dispute = base.filter((r) => inTab(r, 'dispute')).length;
    const filtered = base.filter((r) => inTab(r, tab));
    const sort = q.sort ?? 'amount';
    filtered.sort((a, b) =>
      sort === 'age'
        ? b.daysOverdue - a.daysOverdue ||
          D(b.outstanding).comparedTo(a.outstanding) ||
          a.unitNo.localeCompare(b.unitNo)
        : D(b.outstanding).comparedTo(a.outstanding) ||
          b.daysOverdue - a.daysOverdue ||
          a.unitNo.localeCompare(b.unitNo),
    );
    if (q.order === 'asc') filtered.reverse();
    return filtered;
  }

  /** `GET /v1/owner/juristic/receivables`: one page of the list plus the totals of everything that matched. */
  receivables(ctx: TenantContext, q: ReceivablesQuery & { skip: number; take: number }) {
    return this.db.tenant(ctx, async (tx) => {
      if (q.buildingId) await this.ownBuilding(tx, ctx, q.buildingId);
      const counts: ReceivableTabCounts = { all: 0, atStep: 0, plan: 0, dispute: 0 };
      const all = await this.rowsOf(tx, ctx.tenantId, ctx.buildingIds, q, counts);
      return {
        rows: all.slice(q.skip, q.skip + q.take),
        total: all.length,
        counts,
        totals: {
          outstanding: all.reduce((s, r) => s.plus(r.outstanding), D(0)).toFixed(2),
          surcharge: all.reduce((s, r) => s.plus(r.surcharge), D(0)).toFixed(2),
        },
      };
    });
  }

  private async ownBuilding(tx: Tx, ctx: TenantContext, buildingId: string) {
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
      select: { id: true, name: true },
    });
    if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(b.id)))
      throw new DomainException('http.not_found');
    return b;
  }

  /** `POST /v1/owner/juristic/receivables/exports`: the list as CSV, built by the worker. */
  async requestExport(ctx: TenantContext, q: ReceivablesQuery) {
    if (q.buildingId) await this.db.tenant(ctx, (tx) => this.ownBuilding(tx, ctx, q.buildingId!));
    return this.exports.request(ctx, {
      kind: 'juristic_receivables_csv',
      params: {
        tab: q.tab ?? 'all',
        sort: q.sort ?? 'amount',
        ...(q.q ? { q: q.q } : {}),
        ...(q.order ? { order: q.order } : {}),
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
      },
    });
  }

  validate(params: Record<string, unknown>) {
    const problems: { path: string; message: string }[] = [];
    if (params.tab !== undefined && !['all', 'at_step', 'plan', 'dispute'].includes(params.tab as string))
      problems.push({ path: 'tab', message: 'all, at_step, plan or dispute' });
    if (params.sort !== undefined && !['amount', 'age'].includes(params.sort as string))
      problems.push({ path: 'sort', message: 'amount or age' });
    return problems;
  }

  async build(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const p = job.params as ReceivablesQuery;
    const rows = await this.rowsOf(tx, job.tenantId, null, {
      ...p,
      buildingId: job.buildingId ?? p.buildingId,
    });
    const body = csvOf(
      [
        'unit_no',
        'owner',
        'owns_units',
        'non_resident',
        'agent',
        'outstanding',
        'surcharge',
        'oldest_overdue_on',
        'oldest_overdue_months',
        'next_step',
        'next_step_on',
        'legal_review_required',
        'paused',
        'channels',
      ],
      rows.map((r) => [
        r.unitNo,
        r.ownerName,
        r.context.ownsUnits,
        r.context.nonResident ? 'yes' : 'no',
        r.context.agent ? 'yes' : 'no',
        r.outstanding,
        r.surcharge,
        r.oldestOverdueOn,
        r.oldestOverdueMonths,
        r.nextStep?.kind ?? null,
        r.nextStep?.dueOn ?? null,
        r.nextStep ? (r.nextStep.legalReviewRequired ? 'yes' : 'no') : null,
        r.caseState === 'paused' ? 'yes' : 'no',
        r.channels.join(' '),
      ]),
    );
    return {
      fileName: `receivables-${this.today()}.csv`,
      mimeType: 'text/csv',
      body: Buffer.from(body, 'utf8'),
      rowCount: rows.length,
    };
  }

  // ------------------------------------------------------------------------------------------- aging

  /** `GET /v1/owner/juristic/reports/aging`: open balances now, by days past due, per building and overall. */
  aging(ctx: TenantContext, q: { buildingId?: string }) {
    return this.db.tenant(ctx, async (tx) => {
      if (q.buildingId) await this.ownBuilding(tx, ctx, q.buildingId);
      const today = this.today();
      const bounds = agingBounds(
        await this.settings.valueAt<unknown>('juristic.aging_buckets', this.clock.now(), {
          tenantId: ctx.tenantId,
        }),
      );
      const scope = q.buildingId ? [q.buildingId] : ctx.buildingIds ? [...ctx.buildingIds] : undefined;
      const invoices = await tx.invoice.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: { in: ['issued', 'partially_paid', 'overdue'] },
          balance: { gt: 0 },
          ...(scope ? { buildingId: { in: scope } } : {}),
        },
        select: { balance: true, dueDate: true, billedPartyId: true, unitId: true, buildingId: true },
      });
      const items = invoices.map((i) => ({
        balance: i.balance.toString(),
        dueOn: i.dueDate ? day(i.dueDate) : null,
        account: `${i.billedPartyId}:${i.unitId ?? '-'}`,
        buildingId: i.buildingId,
      }));
      const buildingIds = [...new Set(items.map((i) => i.buildingId))];
      const buildings = await tx.building.findMany({
        where: { id: { in: buildingIds } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      const perBuilding: ({ buildingId: string; name: string } & AgingReport)[] = buildings.map((b) => ({
        buildingId: b.id,
        name: b.name,
        ...juristicAging(
          items.filter((i) => i.buildingId === b.id),
          bounds,
          today,
        ),
      }));
      return { asOf: today, bounds, overall: juristicAging(items, bounds, today), buildings: perBuilding };
    });
  }

  // ------------------------------------------------------------------------------------------- collection rate

  /**
   * `GET /v1/owner/juristic/reports/collection-rate`: per billing cycle starting in [from, to] — billed (invoices net
   * of credit notes), collected (allocations not reversed), collected within `juristic.kpi_collection_days` of each
   * invoice's due date, their rates — and the KPI over the range.
   */
  collectionRate(ctx: TenantContext, q: { from?: string; to?: string; buildingId?: string }) {
    const today = this.today();
    const to = q.to ?? today;
    const from = q.from ?? addCalendarDays(to, -365);
    if (!DATE.test(from)) throw invalid('from', 'date', 'a date YYYY-MM-DD');
    if (!DATE.test(to)) throw invalid('to', 'date', 'a date YYYY-MM-DD');
    if (from > to) throw invalid('from', 'range', 'not after `to`');
    return this.db.tenant(ctx, async (tx) => {
      if (q.buildingId) await this.ownBuilding(tx, ctx, q.buildingId);
      const kpiDays = Number(
        (await this.settings.valueAt<number>('juristic.kpi_collection_days', this.clock.now(), {
          tenantId: ctx.tenantId,
        })) ?? 30,
      );
      const scope = q.buildingId ? [q.buildingId] : ctx.buildingIds ? [...ctx.buildingIds] : null;
      const rows = await tx.$queryRaw<
        {
          cycle_id: string;
          period_key: string;
          frequency: string;
          period_start: Date;
          property_id: string;
          invoices: number;
          billed: string;
          credited: string;
          collected: string;
          within: string;
        }[]
      >`
        WITH inv AS (
          SELECT i.id, i.billing_cycle_id, i.total, i.due_date FROM ops.invoice i
            JOIN ops.billing_cycle c ON c.id = i.billing_cycle_id
           WHERE i.tenant_id = ${ctx.tenantId}::uuid AND i.issued_at IS NOT NULL AND i.status NOT IN ('draft', 'void')
             AND c.period_start BETWEEN ${from}::date AND ${to}::date
             AND (${scope}::uuid[] IS NULL OR i.building_id = ANY(${scope}::uuid[])))
        SELECT c.id AS cycle_id, c.period_key, c.frequency::text AS frequency, c.period_start, c.property_id,
               (SELECT count(*)::int FROM inv WHERE inv.billing_cycle_id = c.id) AS invoices,
               (SELECT COALESCE(sum(total), 0) FROM inv WHERE inv.billing_cycle_id = c.id)::text AS billed,
               (SELECT COALESCE(sum(n.total), 0) FROM ops.credit_note n JOIN inv ON inv.id = n.invoice_id
                 WHERE inv.billing_cycle_id = c.id AND n.status <> 'void')::text AS credited,
               (SELECT COALESCE(sum(a.amount), 0) FROM ops.payment_allocation a JOIN inv ON inv.id = a.invoice_id
                 WHERE inv.billing_cycle_id = c.id AND a.reversed_at IS NULL)::text AS collected,
               (SELECT COALESCE(sum(a.amount), 0) FROM ops.payment_allocation a JOIN inv ON inv.id = a.invoice_id
                  JOIN ops.payment p ON p.id = a.payment_id
                 WHERE inv.billing_cycle_id = c.id AND a.reversed_at IS NULL
                   AND (inv.due_date IS NULL OR p.paid_at < ((inv.due_date + (${kpiDays}::int + 1))::timestamp AT TIME ZONE 'Asia/Bangkok')))::text AS within
          FROM ops.billing_cycle c
         WHERE c.tenant_id = ${ctx.tenantId}::uuid AND c.period_start BETWEEN ${from}::date AND ${to}::date
           AND EXISTS (SELECT 1 FROM inv WHERE inv.billing_cycle_id = c.id)
         ORDER BY c.period_start, c.period_key, c.id`;
      let billed = D(0);
      let collected = D(0);
      let within = D(0);
      const cycles = rows.map((r) => {
        const net = D(r.billed).minus(r.credited);
        billed = billed.plus(net);
        collected = collected.plus(r.collected);
        within = within.plus(r.within);
        return {
          billingCycleId: r.cycle_id,
          periodKey: r.period_key,
          frequency: r.frequency,
          periodStart: day(r.period_start),
          propertyId: r.property_id,
          invoices: r.invoices,
          billed: net.toFixed(2),
          collected: D(r.collected).toFixed(2),
          collectedWithinDays: D(r.within).toFixed(2),
          collectionRatePct: ratePct(r.collected, net),
          withinDaysRatePct: ratePct(r.within, net),
        };
      });
      return {
        from,
        to,
        kpiDays,
        cycles,
        total: {
          billed: billed.toFixed(2),
          collected: collected.toFixed(2),
          collectedWithinDays: within.toFixed(2),
          collectionRatePct: ratePct(collected, billed),
          withinDaysRatePct: ratePct(within, billed),
        },
      };
    });
  }

  // ------------------------------------------------------------------------------------------- budget vs actual

  /**
   * `GET /v1/resident/units/{unitId}/budget-vs-actual` (D-304: residents see budget vs actual): the income side of the
   * approved budget of the unit's building whose period contains today, for a resident holding a role on the unit
   * today (co-owner, payer, tenant, family); none approved → 404.
   */
  async residentBudget(unitId: string) {
    const access = await this.db.platform((tx) =>
      residentUnitAccess(
        tx,
        unitId,
        ['co_owner', 'payer', 'tenant', 'co_tenant', 'family'],
        this.clock.now(),
      ),
    );
    const today = this.today();
    const budget = await this.db.tenant(access.ctx, (tx) =>
      tx.budget.findFirst({
        where: {
          tenantId: access.tenantId,
          buildingId: access.buildingId,
          state: 'approved',
          periodStart: { lte: asDate(today) },
          periodEnd: { gte: asDate(today) },
        },
        orderBy: { approvedAt: 'desc' },
      }),
    );
    if (!budget) throw new DomainException('http.not_found');
    return this.actualIncome(access.ctx, budget.id);
  }

  /**
   * `GET /v1/owner/juristic/budgets/{id}/actual-income` (D-304, income side): the budget's income lines against what
   * was billed in its period for its building (invoice lines by kind, net of credit-note lines) and collected (paid
   * on those invoices in the period), and since J2.1 the expense and fund lines against the journals of their accounts.
   */
  actualIncome(ctx: TenantContext, budgetId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const b = this.found(
        await tx.budget.findFirst({ where: this.own(ctx, { id: budgetId }), include: { lines: true } }),
      );
      if (ctx.buildingIds && !ctx.buildingIds.includes(b.buildingId))
        throw new DomainException('http.not_found');
      const start = startOfBangkokDay(day(b.periodStart)).toISOString();
      const end = startOfBangkokDay(addCalendarDays(day(b.periodEnd), 1)).toISOString();
      const byKind = await tx.$queryRaw<{ kind: string; billed: string; credited: string }[]>`
        WITH inv AS (
          SELECT id FROM ops.invoice
           WHERE tenant_id = ${ctx.tenantId}::uuid AND building_id = ${b.buildingId}::uuid AND issued_at IS NOT NULL
             AND status NOT IN ('draft', 'void') AND issued_at >= ${start}::timestamptz AND issued_at < ${end}::timestamptz)
        SELECT k.kind,
               COALESCE((SELECT sum(l.amount) FROM ops.invoice_line l JOIN inv ON inv.id = l.invoice_id
                          WHERE l.line_kind::text = k.kind), 0)::text AS billed,
               COALESCE((SELECT sum(cl.amount) FROM ops.credit_note_line cl JOIN ops.credit_note n ON n.id = cl.note_id
                          JOIN inv ON inv.id = n.invoice_id WHERE cl.line_kind::text = k.kind AND n.status <> 'void'), 0)::text AS credited
          FROM (SELECT DISTINCT l.line_kind::text AS kind FROM ops.invoice_line l JOIN inv ON inv.id = l.invoice_id) k
         ORDER BY 1`;
      const [paid] = await tx.$queryRaw<{ collected: string }[]>`
        SELECT COALESCE(sum(a.amount), 0)::text AS collected FROM ops.payment_allocation a
          JOIN ops.payment p ON p.id = a.payment_id JOIN ops.invoice i ON i.id = a.invoice_id
         WHERE i.tenant_id = ${ctx.tenantId}::uuid AND i.building_id = ${b.buildingId}::uuid AND a.reversed_at IS NULL
           AND i.issued_at >= ${start}::timestamptz AND i.issued_at < ${end}::timestamptz
           AND p.paid_at >= ${start}::timestamptz AND p.paid_at < ${end}::timestamptz`;
      const group = (k: string) =>
        k === 'common_fee' ? 'common_fee' : k === 'fund' ? 'fund' : k === 'late_fee' ? 'surcharge' : 'other';
      const actual = new Map<string, Decimal>();
      for (const r of byKind) {
        const g = group(r.kind);
        actual.set(g, (actual.get(g) ?? D(0)).plus(D(r.billed).minus(r.credited)));
      }
      const budgeted = b.lines.filter((l) => l.kind === 'income').reduce((s, l) => s.plus(D(l.amount)), D(0));
      // J2.1 (D-329): the expense side from the journals
      const expense = await this.accounting.budgetExpenseSide(tx, ctx.tenantId, {
        buildingId: b.buildingId,
        periodStart: day(b.periodStart),
        periodEnd: day(b.periodEnd),
        lines: b.lines.map((l) => ({
          id: l.id,
          kind: l.kind,
          label: l.label,
          amount: l.amount,
          accountId: l.accountId,
          sort: l.sort,
        })),
      });
      const billed = [...actual.values()].reduce((s, v) => s.plus(v), D(0));
      const collected = D(paid?.collected ?? 0);
      return {
        budgetId: b.id,
        buildingId: b.buildingId,
        fiscalYear: b.fiscalYear,
        periodStart: day(b.periodStart),
        periodEnd: day(b.periodEnd),
        asOf: this.today(),
        budgetedIncome: budgeted.toFixed(2),
        incomeLines: b.lines
          .filter((l) => l.kind === 'income')
          .sort((x, y) => x.sort - y.sort)
          .map((l) => ({ label: l.label, amount: D(l.amount).toFixed(2) })),
        billed: billed.toFixed(2),
        billedByKind: ['common_fee', 'fund', 'surcharge', 'other'].map((k) => ({
          kind: k,
          amount: (actual.get(k) ?? D(0)).toFixed(2),
        })),
        collected: collected.toFixed(2),
        billedVsBudgetPct: ratePct(billed, budgeted),
        collectedVsBilledPct: ratePct(collected, billed),
        expenseSideAvailable: true,
        ...expense,
      };
    });
  }
}

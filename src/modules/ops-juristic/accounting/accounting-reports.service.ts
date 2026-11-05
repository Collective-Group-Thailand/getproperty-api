import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type ExportJob } from '@generated/prisma/client';
import { type ExportBuilder, type ExportFile, ExportsService } from '@modules/ops-documents/exports.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type AccountTypeName, debitNormal } from './chart-templates';
import {
  JOURNAL_EXPORT_FORMATS,
  type JournalExportFormat,
  type JournalExportRow,
  renderJournalExport,
} from './export-formats';
import { LedgerService } from './ledger.service';

const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

interface AccountSum {
  account_id: string;
  code: string;
  name_th: string;
  name_en: string;
  type: AccountTypeName;
  role: string | null;
  period: string;
  debit: string;
  credit: string;
}

export interface StatementAccountRow {
  accountId: string;
  code: string;
  nameTh: string;
  nameEn: string;
  amounts: string[];
  total: string;
}

export interface StatementSection {
  accounts: StatementAccountRow[];
  byPeriod: string[];
  total: string;
}

/** Signed balance of an account in its normal direction (assets / expenses debit, the rest credit). */
const normal = (type: AccountTypeName, debit: Decimal.Value, credit: Decimal.Value): Decimal =>
  debitNormal(type) ? D(debit).minus(D(credit)) : D(credit).minus(D(debit));

/** The months (YYYY-MM), quarters (YYYY-Qn) or years (YYYY) from `from` to `to`. */
export function periodsOf(from: string, to: string, granularity: 'month' | 'quarter' | 'year'): string[] {
  const out: string[] = [];
  if (granularity === 'quarter') {
    const q = (d: string) => Number(d.slice(0, 4)) * 4 + Math.floor((Number(d.slice(5, 7)) - 1) / 3);
    for (let n = q(from); n <= q(to); n += 1) out.push(`${Math.floor(n / 4)}-Q${(n % 4) + 1}`);
    return out;
  }
  if (granularity === 'year') {
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) out.push(String(y));
    return out;
  }
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > end) break;
    out.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Juristic financial reports from the journals (D-312, D-329): income / expense statement by month or year, a simple
 * balance sheet (assets = liabilities + equity incl. the surplus to date — no year-end closing in the light GL), the
 * trial balance, the GL receivable against the J1.2b receivable figures (invariant), the expense side of budget vs
 * actual, and the journal exports (CSV / Express / FlowAccount, column maps as data).
 */
@Injectable()
export class AccountingReportsService extends TenantScopedRepository implements OnModuleInit {
  constructor(
    private readonly db: TenantTx,
    private readonly ledger: LedgerService,
    private readonly exports: ExportsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    for (const format of Object.keys(JOURNAL_EXPORT_FORMATS) as JournalExportFormat[]) {
      const map = JOURNAL_EXPORT_FORMATS[format];
      const builder: ExportBuilder = {
        kind: map.exportKind,
        validate: (params) => this.validateExport(params),
        build: (tx, job) => this.buildExport(tx, job, format),
      };
      this.exports.register(builder);
    }
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  private async scope(tx: Tx, ctx: TenantContext, buildingId?: string): Promise<string[] | null> {
    await this.ledger.assertJuristic(tx, ctx.tenantId);
    if (buildingId) {
      const b = await tx.building.findFirst({
        where: {
          id: buildingId,
          deletedAt: null,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        },
        select: { id: true },
      });
      if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(b.id)))
        throw new DomainException('http.not_found');
      return [b.id];
    }
    return ctx.buildingIds ? [...ctx.buildingIds] : null;
  }

  private async sums(
    tx: Tx,
    tenantId: string,
    buildings: string[] | null,
    range: { from?: string; to: string },
    group: 'month' | 'quarter' | 'year' | 'none',
    types?: AccountTypeName[],
  ): Promise<AccountSum[]> {
    const fmt =
      group === 'month' ? 'YYYY-MM' : group === 'quarter' ? 'YYYY-"Q"Q' : group === 'year' ? 'YYYY' : '"all"';
    return tx.$queryRaw<AccountSum[]>`
      SELECT a.id AS account_id, a.code, a.name_th, a.name_en, a.type::text AS type, a.role,
             to_char(j.posted_on, ${fmt}) AS period,
             COALESCE(sum(l.debit), 0)::text AS debit, COALESCE(sum(l.credit), 0)::text AS credit
        FROM juristic.journal_line l
        JOIN juristic.journal j ON j.id = l.journal_id
        JOIN juristic.account a ON a.id = l.account_id
       WHERE j.tenant_id = ${tenantId}::uuid
         AND j.posted_on <= ${range.to}::date
         AND (${range.from ?? null}::date IS NULL OR j.posted_on >= ${range.from ?? null}::date)
         AND (${buildings}::uuid[] IS NULL OR j.building_id = ANY(${buildings}::uuid[]))
         AND (${types ?? null}::text[] IS NULL OR a.type::text = ANY(${types ?? null}::text[]))
       GROUP BY a.id, a.code, a.name_th, a.name_en, a.type, a.role, period
       ORDER BY a.code, period`;
  }

  private section(rows: AccountSum[], type: AccountTypeName, periods: string[]): StatementSection {
    const byAccount = new Map<string, StatementAccountRow & { _amounts: Map<string, Decimal> }>();
    for (const r of rows.filter((x) => x.type === type)) {
      let a = byAccount.get(r.account_id);
      if (!a) {
        a = {
          accountId: r.account_id,
          code: r.code,
          nameTh: r.name_th,
          nameEn: r.name_en,
          amounts: [],
          total: '0.00',
          _amounts: new Map(),
        };
        byAccount.set(r.account_id, a);
      }
      a._amounts.set(r.period, (a._amounts.get(r.period) ?? D(0)).plus(normal(type, r.debit, r.credit)));
    }
    const accounts = [...byAccount.values()]
      .map(({ _amounts, ...a }) => {
        const amounts = periods.map((p) => (_amounts.get(p) ?? D(0)).toFixed(2));
        return { ...a, amounts, total: amounts.reduce((s, v) => s.plus(v), D(0)).toFixed(2) };
      })
      .filter((a) => a.amounts.some((v) => !D(v).eq(0)))
      .sort((x, y) => (x.code < y.code ? -1 : 1));
    const byPeriod = periods.map((_, i) => accounts.reduce((s, a) => s.plus(a.amounts[i]!), D(0)).toFixed(2));
    return { accounts, byPeriod, total: byPeriod.reduce((s, v) => s.plus(v), D(0)).toFixed(2) };
  }

  /** `GET /v1/owner/juristic/reports/income-statement`: income and expense accounts by month / year, surplus. */
  incomeStatement(
    ctx: TenantContext,
    q: { from: string; to: string; buildingId?: string; granularity?: 'month' | 'quarter' | 'year' },
  ) {
    if (!ISO_DAY.test(q.from) || !ISO_DAY.test(q.to) || q.to < q.from)
      throw invalid('to', 'range', 'from ≤ to, YYYY-MM-DD');
    if (addCalendarDays(q.from, 3 * 366) < q.to) throw invalid('to', 'range', 'at most 3 years');
    const granularity = q.granularity ?? 'month';
    return this.db.tenant(ctx, async (tx) => {
      const buildings = await this.scope(tx, ctx, q.buildingId);
      const rows = await this.sums(tx, ctx.tenantId, buildings, q, granularity, ['income', 'expense']);
      const periods = periodsOf(q.from, q.to, granularity);
      const income = this.section(rows, 'income', periods);
      const expense = this.section(rows, 'expense', periods);
      return {
        from: q.from,
        to: q.to,
        buildingId: q.buildingId ?? null,
        granularity,
        periods,
        income,
        expense,
        surplusByPeriod: periods.map((_, i) => D(income.byPeriod[i]!).minus(expense.byPeriod[i]!).toFixed(2)),
        surplus: D(income.total).minus(expense.total).toFixed(2),
      };
    });
  }

  /** `GET /v1/owner/juristic/reports/balance-sheet`: balances as of a day; equity includes the surplus to date. */
  balanceSheet(ctx: TenantContext, q: { asOf?: string; buildingId?: string }) {
    const asOf = q.asOf ?? this.today();
    if (!ISO_DAY.test(asOf)) throw invalid('asOf', 'date', 'YYYY-MM-DD');
    return this.db.tenant(ctx, async (tx) => {
      const buildings = await this.scope(tx, ctx, q.buildingId);
      const rows = await this.sums(tx, ctx.tenantId, buildings, { to: asOf }, 'none');
      const periods = ['all'];
      const pick = (s: StatementSection) =>
        s.accounts.map((a) => ({
          accountId: a.accountId,
          code: a.code,
          nameTh: a.nameTh,
          nameEn: a.nameEn,
          balance: a.total,
        }));
      const assets = this.section(rows, 'asset', periods);
      const liabilities = this.section(rows, 'liability', periods);
      const equity = this.section(rows, 'equity', periods);
      const surplus = D(this.section(rows, 'income', periods).total).minus(
        this.section(rows, 'expense', periods).total,
      );
      const equityTotal = D(equity.total).plus(surplus);
      return {
        asOf,
        buildingId: q.buildingId ?? null,
        assets: { accounts: pick(assets), total: assets.total },
        liabilities: { accounts: pick(liabilities), total: liabilities.total },
        equity: { accounts: pick(equity), surplusToDate: surplus.toFixed(2), total: equityTotal.toFixed(2) },
        balanced: D(assets.total).eq(D(liabilities.total).plus(equityTotal)),
      };
    });
  }

  /** `GET /v1/owner/juristic/reports/trial-balance`: Σ debit, Σ credit and balance per account up to a day. */
  trialBalance(ctx: TenantContext, q: { asOf?: string; buildingId?: string }) {
    const asOf = q.asOf ?? this.today();
    if (!ISO_DAY.test(asOf)) throw invalid('asOf', 'date', 'YYYY-MM-DD');
    return this.db.tenant(ctx, async (tx) => {
      const buildings = await this.scope(tx, ctx, q.buildingId);
      const rows = await this.sums(tx, ctx.tenantId, buildings, { to: asOf }, 'none');
      const accounts = rows.map((r) => ({
        accountId: r.account_id,
        code: r.code,
        nameTh: r.name_th,
        nameEn: r.name_en,
        type: r.type,
        debit: D(r.debit).toFixed(2),
        credit: D(r.credit).toFixed(2),
        balance: normal(r.type, r.debit, r.credit).toFixed(2),
      }));
      const debit = accounts.reduce((s, a) => s.plus(a.debit), D(0));
      const credit = accounts.reduce((s, a) => s.plus(a.credit), D(0));
      return {
        asOf,
        buildingId: q.buildingId ?? null,
        accounts,
        totalDebit: debit.toFixed(2),
        totalCredit: credit.toFixed(2),
        balanced: debit.eq(credit),
      };
    });
  }

  /**
   * `GET /v1/owner/juristic/reports/ledger-receivables`: the GL receivable per building against the J1.2b figures —
   * open invoice balances − the payers' credit + payment-plan amounts not invoiced yet (scheduled instalments and
   * queued instalment charges). The difference is 0 when every document was posted (invariant).
   */
  ledgerReceivables(ctx: TenantContext, q: { buildingId?: string }) {
    return this.db.tenant(ctx, async (tx) => {
      const buildings = await this.scope(tx, ctx, q.buildingId);
      const roles = await this.ledger.roleAccounts(tx, ctx.tenantId);
      const receivable = roles.get('receivable')!;
      const rows = await tx.$queryRaw<
        { building_id: string; name: string; ledger: string; open: string; credit: string; plan: string }[]
      >`
        WITH b AS (
          SELECT id, name FROM core.building
           WHERE (operator_tenant_id = ${ctx.tenantId}::uuid OR owner_tenant_id = ${ctx.tenantId}::uuid) AND deleted_at IS NULL
             AND (${buildings}::uuid[] IS NULL OR id = ANY(${buildings}::uuid[])))
        SELECT b.id AS building_id, b.name,
          COALESCE((SELECT sum(l.debit - l.credit) FROM juristic.journal_line l JOIN juristic.journal j ON j.id = l.journal_id
                     WHERE j.tenant_id = ${ctx.tenantId}::uuid AND j.building_id = b.id AND l.account_id = ${receivable.id}::uuid), 0)::text AS ledger,
          COALESCE((SELECT sum(i.balance) FROM ops.invoice i
                     WHERE i.tenant_id = ${ctx.tenantId}::uuid AND i.building_id = b.id
                       AND i.status IN ('issued', 'partially_paid', 'overdue')), 0)::text AS open,
          COALESCE((SELECT sum(c.amount) FROM ops.payer_credit c
                     WHERE c.tenant_id = ${ctx.tenantId}::uuid AND c.building_id = b.id), 0)::text AS credit,
          (COALESCE((SELECT sum(s.amount) FROM juristic.payment_plan_instalment s JOIN juristic.payment_plan p ON p.id = s.plan_id
                      WHERE p.tenant_id = ${ctx.tenantId}::uuid AND p.building_id = b.id AND p.state = 'active' AND s.state = 'scheduled'), 0)
           + COALESCE((SELECT sum(ch.amount) FROM ops.invoice_charge ch
                        WHERE ch.tenant_id = ${ctx.tenantId}::uuid AND ch.building_id = b.id AND ch.status = 'pending'
                          AND ch.line_kind = 'plan_instalment'), 0))::text AS plan
          FROM b ORDER BY b.name, b.id`;
      const perBuilding = rows.map((r) => {
        const expected = D(r.open).minus(r.credit).plus(r.plan);
        return {
          buildingId: r.building_id,
          name: r.name,
          ledgerReceivable: D(r.ledger).toFixed(2),
          openInvoices: D(r.open).toFixed(2),
          payerCredit: D(r.credit).toFixed(2),
          planNotInvoiced: D(r.plan).toFixed(2),
          expected: expected.toFixed(2),
          difference: D(r.ledger).minus(expected).toFixed(2),
        };
      });
      const sum = (
        k:
          'ledgerReceivable' | 'openInvoices' | 'payerCredit' | 'planNotInvoiced' | 'expected' | 'difference',
      ) => perBuilding.reduce((s, b) => s.plus(b[k]), D(0)).toFixed(2);
      return {
        asOf: this.today(),
        perBuilding,
        total: {
          ledgerReceivable: sum('ledgerReceivable'),
          openInvoices: sum('openInvoices'),
          payerCredit: sum('payerCredit'),
          planNotInvoiced: sum('planNotInvoiced'),
          expected: sum('expected'),
          difference: sum('difference'),
        },
      };
    });
  }

  /**
   * Expense side of budget vs actual (D-304, D-329): each expense / fund line of the budget with an account against
   * Σ debits − credits on that account in the budget period for its building (journals); lines without an account
   * show no actual.
   */
  async budgetExpenseSide(
    tx: Tx,
    tenantId: string,
    budget: {
      buildingId: string;
      periodStart: string;
      periodEnd: string;
      lines: {
        id: string;
        kind: string;
        label: string;
        amount: Decimal.Value;
        accountId: string | null;
        sort: number;
      }[];
    },
  ) {
    const lines = budget.lines
      .filter((l) => l.kind === 'expense' || l.kind === 'fund')
      .sort((a, b) => a.sort - b.sort);
    const accountIds = [...new Set(lines.map((l) => l.accountId).filter((a): a is string => Boolean(a)))];
    const sums = accountIds.length
      ? await tx.$queryRaw<{ account_id: string; type: AccountTypeName; debit: string; credit: string }[]>`
          SELECT l.account_id, a.type::text AS type, COALESCE(sum(l.debit), 0)::text AS debit, COALESCE(sum(l.credit), 0)::text AS credit
            FROM juristic.journal_line l JOIN juristic.journal j ON j.id = l.journal_id JOIN juristic.account a ON a.id = l.account_id
           WHERE j.tenant_id = ${tenantId}::uuid AND j.building_id = ${budget.buildingId}::uuid
             AND j.posted_on >= ${budget.periodStart}::date AND j.posted_on <= ${budget.periodEnd}::date
             AND l.account_id = ANY(${accountIds}::uuid[])
           GROUP BY l.account_id, a.type`
      : [];
    const actualOf = new Map(sums.map((s) => [s.account_id, D(s.debit).minus(D(s.credit))]));
    const out = lines.map((l) => {
      const actual = l.accountId ? (actualOf.get(l.accountId) ?? D(0)) : null;
      return {
        budgetLineId: l.id,
        kind: l.kind,
        label: l.label,
        accountId: l.accountId,
        budgeted: D(l.amount).toFixed(2),
        actual: actual ? actual.toFixed(2) : null,
        remaining: actual ? D(l.amount).minus(actual).toFixed(2) : null,
      };
    });
    const budgeted = out.reduce((s, l) => s.plus(l.budgeted), D(0));
    const actual = out.reduce((s, l) => s.plus(l.actual ?? 0), D(0));
    return { expenseLines: out, budgetedExpense: budgeted.toFixed(2), actualExpense: actual.toFixed(2) };
  }

  // ------------------------------------------------------------------------------------------- exports

  async requestExport(
    ctx: TenantContext,
    q: { format: JournalExportFormat; from: string; to: string; buildingId?: string },
  ) {
    await this.db.tenant(ctx, (tx) => this.scope(tx, ctx, q.buildingId));
    return this.exports.request(ctx, {
      kind: JOURNAL_EXPORT_FORMATS[q.format].exportKind,
      params: { from: q.from, to: q.to, ...(q.buildingId ? { buildingId: q.buildingId } : {}) },
    });
  }

  private validateExport(params: Record<string, unknown>) {
    const problems: { path: string; message: string }[] = [];
    const from = params.from;
    const to = params.to;
    if (typeof from !== 'string' || !ISO_DAY.test(from))
      problems.push({ path: 'from', message: 'YYYY-MM-DD' });
    if (typeof to !== 'string' || !ISO_DAY.test(to)) problems.push({ path: 'to', message: 'YYYY-MM-DD' });
    if (!problems.length && (to as string) < (from as string))
      problems.push({ path: 'to', message: 'from ≤ to' });
    if (!problems.length && addCalendarDays(from as string, 3 * 366) < (to as string))
      problems.push({ path: 'to', message: 'at most 3 years' });
    return problems;
  }

  private async buildExport(tx: Tx, job: ExportJob, format: JournalExportFormat): Promise<ExportFile> {
    const p = job.params as { from: string; to: string; buildingId?: string };
    const buildingId = job.buildingId ?? p.buildingId ?? null;
    const rows = await tx.$queryRaw<
      {
        posted_on: string;
        journal_id: string;
        source_type: string;
        memo: string;
        building: string;
        code: string;
        name_th: string;
        debit: string;
        credit: string;
        unit_no: string | null;
        party: string | null;
      }[]
    >`
      SELECT to_char(j.posted_on, 'YYYY-MM-DD') AS posted_on, j.id AS journal_id, j.source_type::text AS source_type, j.memo,
             b.name AS building, a.code, a.name_th, l.debit::text AS debit, l.credit::text AS credit,
             u.unit_no, p.display_name AS party
        FROM juristic.journal_line l
        JOIN juristic.journal j ON j.id = l.journal_id
        JOIN juristic.account a ON a.id = l.account_id
        JOIN core.building b ON b.id = j.building_id
        LEFT JOIN core.unit u ON u.id = l.unit_id
        LEFT JOIN core.party p ON p.id = l.party_id
       WHERE j.tenant_id = ${job.tenantId}::uuid AND j.posted_on >= ${p.from}::date AND j.posted_on <= ${p.to}::date
         AND (${buildingId}::uuid IS NULL OR j.building_id = ${buildingId}::uuid)
       ORDER BY j.posted_on, j.created_at, j.id, l.line_no`;
    const data: JournalExportRow[] = rows.map((r) => ({
      postedOn: r.posted_on,
      journalNo: `JV-${r.journal_id.replaceAll('-', '').slice(-10).toUpperCase()}`,
      source: r.source_type,
      memo: r.memo,
      building: r.building,
      accountCode: r.code,
      accountName: r.name_th,
      debit: D(r.debit).toFixed(2),
      credit: D(r.credit).toFixed(2),
      unitNo: r.unit_no ?? '',
      party: r.party ?? '',
    }));
    const map = JOURNAL_EXPORT_FORMATS[format];
    return {
      fileName: `journals-${format}-${p.from}-${p.to}.${map.fileExtension}`,
      mimeType: map.fileExtension === 'csv' ? 'text/csv' : 'text/plain',
      body: Buffer.from(renderJournalExport(format, data), 'utf8'),
      rowCount: data.length,
    };
  }
}

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type ManagementContract,
  type PmAssignmentRole,
  type PmStaffAssignment,
  Prisma,
} from '@generated/prisma/client';
import { AccountingReportsService } from '@modules/ops-juristic/accounting/accounting-reports.service';
import { CollectionReportsService } from '@modules/ops-juristic/collection-reports.service';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { ManagementContractsService } from './management-contracts.service';
import { lastServiceDay } from './management-rules';

const by = () => userIdOf(RequestContext.actor());
const day = (d: Date) => d.toISOString().slice(0, 10);
const dayOrNull = (d: Date | null) => (d ? day(d) : null);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
const pct = (part: Decimal, whole: Decimal) =>
  whole.gt(0) ? part.div(whole).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;

const OPEN_REQUESTS = ['new', 'triaged', 'assigned', 'in_progress', 'waiting_parts'] as const;
const OPEN_WORK_ORDERS = ['open', 'assigned', 'accepted', 'in_progress'] as const;

export interface ExpiringContract {
  vendorContractId: string;
  title: string;
  vendorName: string;
  endsOn: string;
  daysLeft: number;
}

export interface BuildingKpis {
  units: number;
  collection: {
    from: string;
    to: string;
    billed: string;
    collected: string;
    collectionRatePct: string | null;
    withinDaysRatePct: string | null;
    kpiDays: number;
    lastCycle: { periodKey: string; billed: string; collectionRatePct: string | null } | null;
  };
  arrears: { overdueAmount: string; overdueInvoices: number; overdueAccounts: number; over90Amount: string };
  budget: {
    budgetId: string;
    fiscalYear: number;
    budgetedExpense: string;
    actualExpense: string;
    usedPct: string | null;
  } | null;
  work: { openRequests: number; slaBreachedRequests: number; openWorkOrders: number };
  expiring: { withinDays: number; vendorContracts: number; items: ExpiringContract[] };
}

export interface PortfolioBuilding {
  contract: ManagementContract;
  juristicName: string;
  buildingName: string;
  legalForm: string | null;
  staffToday: { userId: string; displayName: string; role: PmAssignmentRole; shift: string | null }[];
  kpis: BuildingKpis;
}

export interface StaffBoard {
  asOf: string;
  members: {
    userId: string;
    displayName: string;
    tenantRole: string;
    assignments: { assignment: PmStaffAssignment; buildingName: string }[];
  }[];
  buildings: {
    buildingId: string;
    buildingName: string;
    juristicName: string;
    contractId: string;
    staff: { userId: string; displayName: string; role: PmAssignmentRole; shift: string | null }[];
  }[];
  unassigned: { userId: string; displayName: string; tenantRole: string }[];
}

export interface AssignmentView {
  assignment: PmStaffAssignment;
  displayName: string;
  buildingName: string;
}

/**
 * The PM company portfolio (D-150 C3, D-334): the buildings a `pm_company` tenant manages under an active management
 * contract with a live read grant today, each with aggregate KPIs computed **in the juristic tenant's context after
 * the grant check** (collection rate, arrears, budget use, open work and SLA, contracts expiring) — the PM never reads
 * a resident, an invoice or a journal line; and the staff board (PM members assigned to buildings, staff see only the
 * buildings they are assigned to today).
 */
@Injectable()
export class PmPortfolioService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly contracts: ManagementContractsService,
    private readonly collectionReports: CollectionReportsService,
    private readonly accountingReports: AccountingReportsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private today(): string {
    return this.contracts.today();
  }

  /** The business date the portfolio figures are computed for (Asia/Bangkok). */
  asOf(): string {
    return this.today();
  }

  /**
   * Contracts live today whose `juristic` read grant is in force now (both: a revoked grant hides the building even if
   * the job has not ended the contract yet). PM `staff` members only see the
   * buildings they are assigned to today.
   */
  private async liveContracts(tx: Tx, ctx: TenantContext): Promise<ManagementContract[]> {
    const today = this.today();
    const rows = await tx.managementContract.findMany({
      where: {
        pmTenantId: ctx.tenantId,
        state: { in: ['active', 'terminated'] },
        startsOn: { lte: asDate(today) },
      },
      orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
    });
    const live = rows.filter((c) => ManagementContractsService.liveOn(c, today));
    if (!live.length) return [];
    // the contract's own grant, read by the PM (grantee) under RLS and checked against the business clock
    const now = this.clock.now();
    const grants = await tx.assetAccessGrant.findMany({
      where: {
        id: { in: live.map((c) => c.grantId).filter((g): g is string => Boolean(g)) },
        granteeTenantId: ctx.tenantId,
        scope: 'building',
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      select: { id: true, buildingId: true, modules: true },
    });
    const visible = new Set(
      grants.filter((g) => g.modules.includes('juristic') || g.modules.includes('*')).map((g) => g.id),
    );
    let out = live.filter((c) => c.grantId && visible.has(c.grantId));
    if (ctx.role === 'staff') {
      const me = by();
      const mine = await tx.pmStaffAssignment.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: me ?? '00000000-0000-0000-0000-000000000000',
          startsOn: { lte: asDate(today) },
          OR: [{ endsOn: null }, { endsOn: { gt: asDate(today) } }],
        },
        select: { buildingId: true },
      });
      const allowed = new Set(mine.map((m) => m.buildingId));
      out = out.filter((c) => allowed.has(c.buildingId));
    }
    return out;
  }

  /** `GET /v1/owner/pm/portfolio`: one row per building managed today, with KPIs; totals over the rows. */
  async portfolio(ctx: TenantContext): Promise<{ asOf: string; buildings: PortfolioBuilding[] }> {
    const live = await this.db.tenant(ctx, async (tx) => {
      await this.contracts.assertPm(tx, ctx.tenantId);
      return this.liveContracts(tx, ctx);
    });
    const buildings: PortfolioBuilding[] = [];
    for (const c of live) buildings.push(await this.building(ctx, c));
    return { asOf: this.today(), buildings };
  }

  /** `GET /v1/owner/pm/portfolio/buildings/{buildingId}`: one managed building (another one: 404). */
  async portfolioBuilding(ctx: TenantContext, buildingId: string): Promise<PortfolioBuilding> {
    const c = await this.db.tenant(ctx, async (tx) => {
      await this.contracts.assertPm(tx, ctx.tenantId);
      return (await this.liveContracts(tx, ctx)).find((x) => x.buildingId === buildingId);
    });
    if (!c) throw new DomainException('http.not_found');
    return this.building(ctx, c);
  }

  private async building(ctx: TenantContext, c: ManagementContract): Promise<PortfolioBuilding> {
    const [names, staff] = await this.db.platform(async (tx) =>
      Promise.all([
        Promise.all([
          tx.tenant.findUnique({ where: { id: c.tenantId }, select: { displayName: true } }),
          tx.building.findUnique({ where: { id: c.buildingId }, select: { name: true, legalForm: true } }),
        ]),
        this.staffToday(tx, ctx.tenantId, [c.buildingId]),
      ]),
    );
    return {
      contract: c,
      juristicName: names[0]?.displayName ?? '',
      buildingName: names[1]?.name ?? '',
      legalForm: names[1]?.legalForm ?? null,
      staffToday: staff.get(c.buildingId) ?? [],
      kpis: await this.kpis(ctx.tenantId, c.tenantId, c.buildingId),
    };
  }

  /** KPIs of one building, computed as its juristic tenant (the caller checked the live grant first). */
  async kpis(pmTenantId: string, juristicTenantId: string, buildingId: string): Promise<BuildingKpis> {
    const jctx = systemTenantContext(juristicTenantId);
    const today = this.today();
    const from = addCalendarDays(today, -365);
    const [rate, aging] = await Promise.all([
      this.collectionReports.collectionRate(jctx, { from, to: today, buildingId }),
      this.collectionReports.aging(jctx, { buildingId }),
    ]);
    const withinDays =
      (await this.settings.valueAt<number>('pm.portfolio_expiring_days', this.clock.now(), {
        tenantId: pmTenantId,
      })) ?? 90;
    const rest = await this.db.tenant(jctx, async (tx) => {
      const now = this.clock.now();
      const [units, openRequests, breached, openWorkOrders, expiring, budget] = await Promise.all([
        tx.unit.count({ where: { buildingId, deletedAt: null } }),
        tx.serviceRequest.count({
          where: { tenantId: juristicTenantId, buildingId, status: { in: [...OPEN_REQUESTS] } },
        }),
        tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM ops.service_request
           WHERE tenant_id = ${juristicTenantId}::uuid AND building_id = ${buildingId}::uuid
             AND status::text = ANY(${[...OPEN_REQUESTS]}::text[])
             AND created_at + make_interval(hours => sla_hours) < ${now}`,
        tx.workOrder.count({
          where: { tenantId: juristicTenantId, buildingId, status: { in: [...OPEN_WORK_ORDERS] } },
        }),
        tx.vendorContract.findMany({
          where: {
            tenantId: juristicTenantId,
            buildingId,
            state: 'active',
            endsOn: { lte: asDate(addCalendarDays(today, withinDays)) },
          },
          include: { vendor: { select: { name: true } } },
          orderBy: { endsOn: 'asc' },
          take: 20,
        }),
        tx.budget.findFirst({
          where: {
            tenantId: juristicTenantId,
            buildingId,
            state: 'approved',
            periodStart: { lte: asDate(today) },
            periodEnd: { gte: asDate(today) },
          },
          include: { lines: true },
          orderBy: { fiscalYear: 'desc' },
        }),
      ]);
      const budgetSide = budget
        ? await this.accountingReports.budgetExpenseSide(tx, juristicTenantId, {
            buildingId,
            periodStart: day(budget.periodStart),
            periodEnd: day(budget.periodEnd),
            lines: budget.lines.map((l) => ({
              id: l.id,
              kind: l.kind,
              label: l.label,
              amount: l.amount.toString(),
              accountId: l.accountId,
              sort: l.sort,
            })),
          })
        : null;
      return {
        units,
        openRequests,
        breached: breached[0]?.n ?? 0,
        openWorkOrders,
        expiring,
        budget,
        budgetSide,
      };
    });
    const last = rate.cycles[rate.cycles.length - 1];
    const over90 = aging.overall.buckets
      .filter((b) => b.fromDays > 90)
      .reduce((s, b) => s.plus(b.amount), new Decimal(0));
    return {
      units: rest.units,
      collection: {
        from: rate.from,
        to: rate.to,
        billed: rate.total.billed,
        collected: rate.total.collected,
        collectionRatePct: rate.total.collectionRatePct,
        withinDaysRatePct: rate.total.withinDaysRatePct,
        kpiDays: rate.kpiDays,
        lastCycle: last
          ? { periodKey: last.periodKey, billed: last.billed, collectionRatePct: last.collectionRatePct }
          : null,
      },
      arrears: {
        overdueAmount: aging.overall.overdue.amount,
        overdueInvoices: aging.overall.overdue.invoices,
        overdueAccounts: aging.overall.overdue.accounts,
        over90Amount: over90.toFixed(2),
      },
      budget:
        rest.budget && rest.budgetSide
          ? {
              budgetId: rest.budget.id,
              fiscalYear: rest.budget.fiscalYear,
              budgetedExpense: rest.budgetSide.budgetedExpense,
              actualExpense: rest.budgetSide.actualExpense,
              usedPct: pct(D(rest.budgetSide.actualExpense), D(rest.budgetSide.budgetedExpense)),
            }
          : null,
      work: {
        openRequests: rest.openRequests,
        slaBreachedRequests: rest.breached,
        openWorkOrders: rest.openWorkOrders,
      },
      expiring: {
        withinDays,
        vendorContracts: rest.expiring.length,
        items: rest.expiring.map((v) => ({
          vendorContractId: v.id,
          title: v.title,
          vendorName: v.vendor.name,
          endsOn: day(v.endsOn),
          daysLeft: Math.round((v.endsOn.getTime() - asDate(today).getTime()) / 86_400_000),
        })),
      },
    };
  }

  // ============================================================================================ staff

  /** Assignments current today of a PM tenant on the buildings, with display names (gp_platform reads). */
  private async staffToday(tx: Tx, pmTenantId: string, buildingIds: string[]) {
    const today = asDate(this.today());
    const rows = await tx.pmStaffAssignment.findMany({
      where: {
        tenantId: pmTenantId,
        buildingId: { in: buildingIds },
        startsOn: { lte: today },
        OR: [{ endsOn: null }, { endsOn: { gt: today } }],
      },
      include: { user: { select: { displayName: true } } },
      orderBy: [{ role: 'asc' }, { startsOn: 'asc' }],
    });
    const out = new Map<
      string,
      { userId: string; displayName: string; role: PmAssignmentRole; shift: string | null }[]
    >();
    for (const r of rows) {
      const list = out.get(r.buildingId) ?? [];
      list.push({ userId: r.userId, displayName: r.user.displayName, role: r.role, shift: r.shift });
      out.set(r.buildingId, list);
    }
    return out;
  }

  /** `GET /v1/owner/pm/staff-board`: members with today's assignments, buildings with their staff, unassigned. */
  async staffBoard(ctx: TenantContext): Promise<StaffBoard> {
    const { live, assignments } = await this.db.tenant(ctx, async (tx) => {
      await this.contracts.assertPm(tx, ctx.tenantId);
      const live = await this.liveContracts(tx, ctx);
      const today = asDate(this.today());
      const assignments = await tx.pmStaffAssignment.findMany({
        where: {
          tenantId: ctx.tenantId,
          buildingId: { in: live.map((c) => c.buildingId) },
          startsOn: { lte: today },
          OR: [{ endsOn: null }, { endsOn: { gt: today } }],
        },
        orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
      });
      return { live, assignments };
    });
    const { members, users, tenants, buildings } = await this.db.platform(async (tx) => {
      const members = await tx.membership.findMany({
        where: { tenantId: ctx.tenantId, status: 'active', deletedAt: null },
        select: { userId: true, role: true },
        orderBy: { createdAt: 'asc' },
      });
      const userIds = [...new Set([...members.map((m) => m.userId), ...assignments.map((a) => a.userId)])];
      const [users, tenants, buildings] = await Promise.all([
        tx.userAccount.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }),
        tx.tenant.findMany({
          where: { id: { in: [...new Set(live.map((c) => c.tenantId))] } },
          select: { id: true, displayName: true },
        }),
        tx.building.findMany({
          where: { id: { in: live.map((c) => c.buildingId) } },
          select: { id: true, name: true },
        }),
      ]);
      return { members, users, tenants, buildings };
    });
    const uName = new Map(users.map((u) => [u.id, u.displayName]));
    const tName = new Map(tenants.map((t) => [t.id, t.displayName]));
    const bName = new Map(buildings.map((b) => [b.id, b.name]));
    const visibleMembers = ctx.role === 'staff' ? members.filter((m) => m.userId === by()) : members;
    const boardMembers = visibleMembers.map((m) => ({
      userId: m.userId,
      displayName: uName.get(m.userId) ?? '',
      tenantRole: m.role,
      assignments: assignments
        .filter((a) => a.userId === m.userId)
        .map((a) => ({ assignment: a, buildingName: bName.get(a.buildingId) ?? '' })),
    }));
    return {
      asOf: this.today(),
      members: boardMembers.filter((m) => m.assignments.length),
      buildings: live.map((c) => ({
        buildingId: c.buildingId,
        buildingName: bName.get(c.buildingId) ?? '',
        juristicName: tName.get(c.tenantId) ?? '',
        contractId: c.id,
        staff: assignments
          .filter((a) => a.buildingId === c.buildingId)
          .map((a) => ({
            userId: a.userId,
            displayName: uName.get(a.userId) ?? '',
            role: a.role,
            shift: a.shift,
          })),
      })),
      unassigned: boardMembers
        .filter((m) => !m.assignments.length)
        .map((m) => ({ userId: m.userId, displayName: m.displayName, tenantRole: m.tenantRole })),
    };
  }

  private async assignmentViews(rows: PmStaffAssignment[]): Promise<AssignmentView[]> {
    if (!rows.length) return [];
    const [users, buildings] = await this.db.platform((tx) =>
      Promise.all([
        tx.userAccount.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
          select: { id: true, displayName: true },
        }),
        tx.building.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.buildingId))] } },
          select: { id: true, name: true },
        }),
      ]),
    );
    const uName = new Map(users.map((u) => [u.id, u.displayName]));
    const bName = new Map(buildings.map((b) => [b.id, b.name]));
    return rows.map((a) => ({
      assignment: a,
      displayName: uName.get(a.userId) ?? '',
      buildingName: bName.get(a.buildingId) ?? '',
    }));
  }

  async listAssignments(
    ctx: TenantContext,
    q: { buildingId?: string; userId?: string; current?: boolean; skip: number; take: number },
  ): Promise<{ rows: AssignmentView[]; total: number }> {
    const { rows, total } = await this.db.tenant(ctx, async (tx) => {
      await this.contracts.assertPm(tx, ctx.tenantId);
      const today = asDate(this.today());
      const where: Prisma.PmStaffAssignmentWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
        ...(ctx.role === 'staff' ? { userId: by() ?? '00000000-0000-0000-0000-000000000000' } : {}),
        ...(q.current ? { startsOn: { lte: today }, OR: [{ endsOn: null }, { endsOn: { gt: today } }] } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.pmStaffAssignment.findMany({
          where,
          orderBy: [{ startsOn: 'desc' }, { id: 'asc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.pmStaffAssignment.count({ where }),
      ]);
      return { rows, total };
    });
    return { rows: await this.assignmentViews(rows), total };
  }

  /**
   * Assigns an active member of the PM tenant to a building of an **active** contract, inside its term (422
   * `pm_staff.outside_term`), never twice for overlapping days (409 `pm_staff.overlap`).
   */
  async assign(
    ctx: TenantContext,
    input: {
      contractId: string;
      userId: string;
      role: PmAssignmentRole;
      shift?: string | null;
      startsOn?: string | null;
      endsOn?: string | null;
      note?: string | null;
    },
  ): Promise<AssignmentView> {
    const row = await this.db.tenant(ctx, async (tx) => {
      await this.contracts.assertPm(tx, ctx.tenantId);
      const c = await tx.managementContract.findFirst({
        where: { id: input.contractId, pmTenantId: ctx.tenantId, state: 'active' },
      });
      if (!c) throw new DomainException('http.not_found');
      const today = this.today();
      const startsOn = input.startsOn ?? (day(c.startsOn) > today ? day(c.startsOn) : today);
      if (!DATE.test(startsOn)) throw invalid('startsOn', 'date', 'a date YYYY-MM-DD');
      if (input.endsOn && !DATE.test(input.endsOn)) throw invalid('endsOn', 'date', 'a date YYYY-MM-DD');
      if (input.endsOn && input.endsOn <= startsOn) throw invalid('endsOn', 'range', 'after startsOn');
      const termEnd = addCalendarDays(
        lastServiceDay({ endsOn: day(c.endsOn), terminatedOn: dayOrNull(c.terminatedOn) }),
        1,
      );
      if (startsOn < day(c.startsOn) || startsOn >= termEnd || (input.endsOn && input.endsOn > termEnd))
        throw new DomainException('pm_staff.outside_term');
      const member = await tx.membership.findFirst({
        where: { tenantId: ctx.tenantId, userId: input.userId, status: 'active', deletedAt: null },
      });
      if (!member) throw new DomainException('pm_staff.not_member');
      const overlap = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM juristic.pm_staff_assignment
         WHERE user_id = ${input.userId}::uuid AND building_id = ${c.buildingId}::uuid
           AND daterange(starts_on, ends_on, '[)') && daterange(${startsOn}::date, ${input.endsOn ?? termEnd}::date, '[)')`;
      if (overlap.length) throw new DomainException('pm_staff.overlap');
      const a = await tx.pmStaffAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          contractId: c.id,
          buildingId: c.buildingId,
          userId: input.userId,
          role: input.role,
          shift: input.shift ?? null,
          startsOn: asDate(startsOn),
          // open-ended assignments stop with the contract (the job / termination closes them)
          endsOn: input.endsOn ? asDate(input.endsOn) : null,
          note: input.note ?? null,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'pm.staff_assignment_created',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.pm_staff_assignment',
        subjectId: a.id,
        metadata: {
          userId: a.userId,
          role: a.role,
          startsOn,
          endsOn: input.endsOn ?? null,
          contractId: c.id,
        },
      });
      await this.events.record(tx, {
        type: 'pm.staff_assignment.changed',
        aggregateType: 'pm_staff_assignment',
        aggregateId: a.id,
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        payload: { assignmentId: a.id, userId: a.userId, change: 'created' },
      });
      return a;
    });
    return (await this.assignmentViews([row]))[0]!;
  }

  /** Ends an assignment on `endsOn` (exclusive; default today, never before today nor on / before its start). */
  async endAssignment(
    ctx: TenantContext,
    id: string,
    input: { endsOn?: string | null },
  ): Promise<AssignmentView> {
    const row = await this.db.tenant(ctx, async (tx) => {
      await this.contracts.assertPm(tx, ctx.tenantId);
      const a = await tx.pmStaffAssignment.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!a) throw new DomainException('http.not_found');
      const today = this.today();
      const endsOn = input.endsOn ?? today;
      if (!DATE.test(endsOn)) throw invalid('endsOn', 'date', 'a date YYYY-MM-DD');
      if (a.endsOn && day(a.endsOn) <= today) throw new DomainException('pm_staff.ended');
      if (endsOn < today || endsOn <= day(a.startsOn) || (a.endsOn && endsOn > day(a.endsOn)))
        throw invalid('endsOn', 'range', 'today or later, after the start, not after the current end');
      const updated = await tx.pmStaffAssignment.update({
        where: { id },
        data: {
          endsOn: asDate(endsOn),
          endedAt: this.clock.now(),
          endedBy: by(),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'pm.staff_assignment_ended',
        tenantId: ctx.tenantId,
        buildingId: a.buildingId,
        subjectType: 'juristic.pm_staff_assignment',
        subjectId: id,
        metadata: { endsOn },
      });
      await this.events.record(tx, {
        type: 'pm.staff_assignment.changed',
        aggregateType: 'pm_staff_assignment',
        aggregateId: id,
        tenantId: ctx.tenantId,
        buildingId: a.buildingId,
        payload: { assignmentId: id, userId: a.userId, change: 'ended', endsOn },
      });
      return updated;
    });
    return (await this.assignmentViews([row]))[0]!;
  }

  /** Juristic side `GET /v1/owner/juristic/management-contracts/{id}/staff`: who the PM assigned to the building. */
  async contractStaff(ctx: TenantContext, contractId: string): Promise<AssignmentView[]> {
    const rows = await this.db.tenant(ctx, async (tx) => {
      await this.contracts.load(tx, ctx, 'juristic', contractId);
      return tx.pmStaffAssignment.findMany({
        where: { contractId },
        orderBy: [{ startsOn: 'desc' }, { id: 'asc' }],
      });
    });
    return this.assignmentViews(rows);
  }
}

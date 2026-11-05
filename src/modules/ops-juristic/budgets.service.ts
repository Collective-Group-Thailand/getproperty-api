import { isJuristicTenantType } from '@collective/asset-core';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type BillingFrequency,
  type BudgetLineKind,
  type MeetingKind,
  type Prisma,
  type ResolutionDocumentKind,
} from '@generated/prisma/client';
import { moneyStats, periodBudget, splitBudget } from '@modules/ops-billing/engine/budget-split';
import { type BudgetSplitBy } from '@modules/ops-billing/engine/rate-tiers';
import { RatePlansService } from '@modules/ops-billing/rate-plans.service';
import { MONTHS_OF } from '@modules/smart-readings/cutoff';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value) => new Decimal(v);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);

export const RESOLUTION_INCLUDE = {
  documents: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.ResolutionInclude;
export type ResolutionRow = Prisma.ResolutionGetPayload<{ include: typeof RESOLUTION_INCLUDE }>;

export const BUDGET_INCLUDE = {
  lines: { orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] },
} as const satisfies Prisma.BudgetInclude;
export type BudgetRow = Prisma.BudgetGetPayload<{ include: typeof BUDGET_INCLUDE }>;

export interface BudgetLineInput {
  kind: BudgetLineKind;
  label: string;
  amount: string;
  accountId?: string | null;
}

export interface RatePreviewInput {
  lineIds?: string[];
  kind: 'common_fee' | 'fund';
  splitBy: BudgetSplitBy;
  frequency?: BillingFrequency;
}

/**
 * Budgets and meeting resolutions of a juristic building (J1.1b, D-304 = D-J03, D-320, D-324): a resolution is
 * recorded as a draft, adopted (committee / Owner) or voided; a budget per building and fiscal year is drafted and
 * approved with an adopted resolution (the previous approved budget of that year is superseded). A budget turns into a
 * common-fee / fund **rate draft** — a `budget_split` version with a future effective date (editable until it takes
 * effect) that carries the budget's resolution — with a per-unit preview (min / median / max, Σ = the budget).
 */
@Injectable()
export class JuristicBudgetsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly ratePlans: RatePlansService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** A building the tenant operates or owns, juristic tenants only (else 404). */
  private async building(tx: Tx, ctx: TenantContext, buildingId: string) {
    if (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)) throw new DomainException('http.not_found');
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
    });
    if (!b) throw new DomainException('http.not_found');
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { type: true } });
    if (!isJuristicTenantType(t.type)) throw new DomainException('http.not_found');
    return b;
  }

  private scope(ctx: TenantContext) {
    return ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {};
  }

  // ------------------------------------------------------------------------------------------- resolutions

  private async loadResolution(tx: Tx, ctx: TenantContext, id: string): Promise<ResolutionRow> {
    return this.found(
      await tx.resolution.findFirst({
        where: this.own(ctx, { id, ...this.scope(ctx) }),
        include: RESOLUTION_INCLUDE,
      }),
    );
  }

  listResolutions(
    ctx: TenantContext,
    q: { buildingId?: string; state?: 'draft' | 'adopted' | 'void'; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.ResolutionWhereInput = this.own(ctx, {
        ...this.scope(ctx),
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
        ...(q.state ? { state: q.state } : {}),
      });
      const [rows, total] = await Promise.all([
        tx.resolution.findMany({
          where,
          include: RESOLUTION_INCLUDE,
          orderBy: [{ meetingDate: 'desc' }, { createdAt: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.resolution.count({ where }),
      ]);
      return { rows, total };
    });
  }

  getResolution(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.loadResolution(tx, ctx, id));
  }

  private async resolutionEvent(
    tx: Tx,
    r: { id: string; tenantId: string; buildingId: string },
    change: string,
  ) {
    await this.events.record(tx, {
      type: 'juristic.resolution.changed',
      aggregateType: 'resolution',
      aggregateId: r.id,
      tenantId: r.tenantId,
      buildingId: r.buildingId,
      payload: { resolutionId: r.id, buildingId: r.buildingId, change },
    });
  }

  private unique<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((e: unknown) => {
      if ((e as { code?: string }).code === 'P2002')
        throw new DomainException('validation.failed', {
          errors: [{ path: 'number', code: 'unique', message: 'this meeting kind already has this number' }],
        });
      throw e;
    });
  }

  createResolution(
    ctx: TenantContext,
    input: {
      buildingId: string;
      meetingKind: MeetingKind;
      meetingDate: string;
      number: string;
      title: string;
      text: string;
      votesSummary?: string | null;
    },
  ) {
    return this.unique(() =>
      this.db.tenant(ctx, async (tx) => {
        await this.building(tx, ctx, input.buildingId);
        const r = await tx.resolution.create({
          data: {
            tenantId: ctx.tenantId,
            buildingId: input.buildingId,
            meetingKind: input.meetingKind,
            meetingDate: asDate(input.meetingDate),
            number: input.number.trim(),
            title: input.title.trim(),
            text: input.text,
            votesSummary: input.votesSummary ?? null,
            createdBy: by(),
          },
        });
        await this.audit.record(tx, {
          action: 'juristic.resolution_created',
          tenantId: ctx.tenantId,
          buildingId: r.buildingId,
          subjectType: 'juristic.resolution',
          subjectId: r.id,
          after: {
            meetingKind: r.meetingKind,
            meetingDate: input.meetingDate,
            number: r.number,
            title: r.title,
          },
        });
        await this.resolutionEvent(tx, r, 'created');
        return this.loadResolution(tx, ctx, r.id);
      }),
    );
  }

  updateResolution(
    ctx: TenantContext,
    id: string,
    input: {
      meetingKind?: MeetingKind;
      meetingDate?: string;
      number?: string;
      title?: string;
      text?: string;
      votesSummary?: string | null;
      version?: number;
    },
  ) {
    return this.unique(() =>
      this.db.tenant(ctx, async (tx) => {
        const r = await this.loadResolution(tx, ctx, id);
        if (r.state !== 'draft')
          throw new DomainException('resolution.invalid_state', { params: { state: r.state } });
        if (input.version !== undefined && input.version !== r.version)
          throw new DomainException('concurrency.stale');
        await tx.resolution.update({
          where: { id },
          data: {
            ...(input.meetingKind ? { meetingKind: input.meetingKind } : {}),
            ...(input.meetingDate ? { meetingDate: asDate(input.meetingDate) } : {}),
            ...(input.number ? { number: input.number.trim() } : {}),
            ...(input.title ? { title: input.title.trim() } : {}),
            ...(input.text ? { text: input.text } : {}),
            ...(input.votesSummary !== undefined ? { votesSummary: input.votesSummary } : {}),
            version: { increment: 1 },
            updatedBy: by(),
          },
        });
        await this.audit.record(tx, {
          action: 'juristic.resolution_updated',
          tenantId: ctx.tenantId,
          buildingId: r.buildingId,
          subjectType: 'juristic.resolution',
          subjectId: r.id,
          before: { number: r.number, title: r.title, meetingDate: r.meetingDate.toISOString().slice(0, 10) },
          after: { ...input },
        });
        await this.resolutionEvent(tx, r, 'updated');
        return this.loadResolution(tx, ctx, id);
      }),
    );
  }

  /** `POST …/resolutions/{id}/actions/adopt` (committee / Owner, Idempotency-Key): draft → adopted, irreversible. */
  adoptResolution(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM juristic.resolution WHERE id = ${id}::uuid FOR UPDATE`;
      const r = await this.loadResolution(tx, ctx, id);
      if (r.state !== 'draft')
        throw new DomainException('resolution.invalid_state', { params: { state: r.state } });
      const now = this.clock.now();
      await tx.resolution.update({
        where: { id },
        data: {
          state: 'adopted',
          adoptedAt: now,
          adoptedBy: by(),
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.resolution_adopted',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.resolution',
        subjectId: r.id,
        before: { state: 'draft' },
        after: { state: 'adopted', number: r.number, meetingKind: r.meetingKind },
      });
      await this.resolutionEvent(tx, r, 'adopted');
      return this.loadResolution(tx, ctx, id);
    });
  }

  /** `POST …/actions/void` (committee / Owner): never while an approved budget or a rate version relies on it. */
  voidResolution(ctx: TenantContext, id: string, reason: string) {
    return this.db.tenant(ctx, async (tx) => {
      const r = await this.loadResolution(tx, ctx, id);
      if (r.state === 'void')
        throw new DomainException('resolution.invalid_state', { params: { state: r.state } });
      const used =
        (await tx.budget.count({ where: { resolutionId: id, state: 'approved' } })) +
        (await tx.ratePlanVersion.count({ where: { resolutionId: id } }));
      if (used) throw new DomainException('resolution.invalid_state', { params: { state: 'in_use' } });
      await tx.resolution.update({
        where: { id },
        data: {
          state: 'void',
          voidedAt: this.clock.now(),
          voidReason: reason,
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.resolution_voided',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.resolution',
        subjectId: r.id,
        before: { state: r.state },
        after: { state: 'void', reason },
      });
      await this.resolutionEvent(tx, r, 'voided');
      return this.loadResolution(tx, ctx, id);
    });
  }

  /** Attach minutes / a notice / an attachment (a document of the tenant) — not to a void resolution. */
  addResolutionDocument(
    ctx: TenantContext,
    id: string,
    input: { documentId: string; kind: ResolutionDocumentKind },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const r = await this.loadResolution(tx, ctx, id);
      if (r.state === 'void')
        throw new DomainException('resolution.invalid_state', { params: { state: r.state } });
      const doc = this.found(
        await tx.document.findFirst({
          where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null },
        }),
      );
      await tx.resolutionDocument.upsert({
        where: { resolutionId_documentId: { resolutionId: id, documentId: doc.id } },
        create: {
          tenantId: ctx.tenantId,
          resolutionId: id,
          documentId: doc.id,
          kind: input.kind,
          createdBy: by(),
        },
        update: { kind: input.kind },
      });
      await this.audit.record(tx, {
        action: 'juristic.resolution_document_added',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.resolution',
        subjectId: r.id,
        after: { documentId: doc.id, kind: input.kind },
      });
      await this.resolutionEvent(tx, r, 'document_added');
      return this.loadResolution(tx, ctx, id);
    });
  }

  /** Detach a document — only while the resolution is a draft (the adopted record keeps its minutes). */
  removeResolutionDocument(ctx: TenantContext, id: string, documentId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const r = await this.loadResolution(tx, ctx, id);
      if (r.state !== 'draft')
        throw new DomainException('resolution.invalid_state', { params: { state: r.state } });
      const row = this.found(r.documents.find((d) => d.documentId === documentId));
      await tx.resolutionDocument.delete({ where: { id: row.id } });
      await this.audit.record(tx, {
        action: 'juristic.resolution_document_removed',
        tenantId: ctx.tenantId,
        buildingId: r.buildingId,
        subjectType: 'juristic.resolution',
        subjectId: r.id,
        before: { documentId, kind: row.kind },
      });
      await this.resolutionEvent(tx, r, 'document_removed');
      return this.loadResolution(tx, ctx, id);
    });
  }

  // ------------------------------------------------------------------------------------------- budgets

  private async loadBudget(tx: Tx, ctx: TenantContext, id: string): Promise<BudgetRow> {
    return this.found(
      await tx.budget.findFirst({
        where: this.own(ctx, { id, ...this.scope(ctx) }),
        include: BUDGET_INCLUDE,
      }),
    );
  }

  listBudgets(
    ctx: TenantContext,
    q: {
      buildingId?: string;
      fiscalYear?: number;
      state?: 'draft' | 'approved' | 'superseded';
      skip: number;
      take: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.BudgetWhereInput = this.own(ctx, {
        ...this.scope(ctx),
        ...(q.buildingId ? { buildingId: q.buildingId } : {}),
        ...(q.fiscalYear ? { fiscalYear: q.fiscalYear } : {}),
        ...(q.state ? { state: q.state } : {}),
      });
      const [rows, total] = await Promise.all([
        tx.budget.findMany({
          where,
          include: BUDGET_INCLUDE,
          orderBy: [{ fiscalYear: 'desc' }, { createdAt: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.budget.count({ where }),
      ]);
      return { rows, total };
    });
  }

  getBudget(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.loadBudget(tx, ctx, id));
  }

  /** Σ of the expense and fund lines (what the owners pay for); income lines are shown, not added. */
  private static totalOf(lines: { kind: BudgetLineKind; amount: Decimal.Value }[]): string {
    return lines
      .filter((l) => l.kind !== 'income')
      .reduce((s, l) => s.plus(l.amount), D(0))
      .toFixed(2);
  }

  private async writeLines(tx: Tx, ctx: TenantContext, budgetId: string, lines: BudgetLineInput[]) {
    // J2.1 (D-329): a line's account must be an account of the tenant's chart (FK since migration 0076)
    const accountIds = [...new Set(lines.map((l) => l.accountId).filter((a): a is string => Boolean(a)))];
    if (accountIds.length) {
      const found = await tx.account.count({ where: { id: { in: accountIds }, tenantId: ctx.tenantId } });
      if (found !== accountIds.length) throw new DomainException('http.not_found');
    }
    await tx.budgetLine.deleteMany({ where: { budgetId } });
    if (lines.length)
      await tx.budgetLine.createMany({
        data: lines.map((l, i) => ({
          tenantId: ctx.tenantId,
          budgetId,
          kind: l.kind,
          label: l.label.trim(),
          amount: D(l.amount).toFixed(2),
          accountId: l.accountId ?? null,
          sort: i,
          createdBy: by(),
        })),
      });
  }

  private draftUnique<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((e: unknown) => {
      if ((e as { code?: string }).code === 'P2002')
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'fiscalYear', code: 'unique', message: 'the building already has a draft for this year' },
          ],
        });
      throw e;
    });
  }

  createBudget(
    ctx: TenantContext,
    input: {
      buildingId: string;
      fiscalYear: number;
      name: string;
      periodStart?: string;
      periodEnd?: string;
      lines: BudgetLineInput[];
    },
  ) {
    const periodStart = input.periodStart ?? `${input.fiscalYear}-01-01`;
    const periodEnd = input.periodEnd ?? `${input.fiscalYear}-12-31`;
    if (periodEnd <= periodStart)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'periodEnd', code: 'range', message: 'after periodStart, at most one year' }],
      });
    return this.draftUnique(() =>
      this.db.tenant(ctx, async (tx) => {
        await this.building(tx, ctx, input.buildingId);
        const b = await tx.budget.create({
          data: {
            tenantId: ctx.tenantId,
            buildingId: input.buildingId,
            fiscalYear: input.fiscalYear,
            name: input.name.trim(),
            periodStart: asDate(periodStart),
            periodEnd: asDate(periodEnd),
            total: JuristicBudgetsService.totalOf(input.lines),
            createdBy: by(),
          },
        });
        await this.writeLines(tx, ctx, b.id, input.lines);
        await this.audit.record(tx, {
          action: 'juristic.budget_created',
          tenantId: ctx.tenantId,
          buildingId: b.buildingId,
          subjectType: 'juristic.budget',
          subjectId: b.id,
          after: { fiscalYear: b.fiscalYear, total: b.total.toFixed(2), lines: input.lines.length },
        });
        await this.budgetEvent(tx, b, 'created');
        return this.loadBudget(tx, ctx, b.id);
      }),
    );
  }

  updateBudget(
    ctx: TenantContext,
    id: string,
    input: {
      name?: string;
      periodStart?: string;
      periodEnd?: string;
      lines?: BudgetLineInput[];
      version?: number;
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const b = await this.loadBudget(tx, ctx, id);
      if (b.state !== 'draft')
        throw new DomainException('budget.invalid_state', { params: { state: b.state } });
      if (input.version !== undefined && input.version !== b.version)
        throw new DomainException('concurrency.stale');
      const start = input.periodStart ?? b.periodStart.toISOString().slice(0, 10);
      const end = input.periodEnd ?? b.periodEnd.toISOString().slice(0, 10);
      if (end <= start)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'periodEnd', code: 'range', message: 'after periodStart, at most one year' }],
        });
      if (input.lines) await this.writeLines(tx, ctx, id, input.lines);
      const lines = input.lines ?? b.lines.map((l) => ({ kind: l.kind, amount: l.amount.toString() }));
      await tx.budget.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          periodStart: asDate(start),
          periodEnd: asDate(end),
          total: JuristicBudgetsService.totalOf(lines),
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.budget_updated',
        tenantId: ctx.tenantId,
        buildingId: b.buildingId,
        subjectType: 'juristic.budget',
        subjectId: b.id,
        before: { total: b.total.toFixed(2), lines: b.lines.length },
        after: { total: JuristicBudgetsService.totalOf(lines), lines: lines.length },
      });
      await this.budgetEvent(tx, b, 'updated');
      return this.loadBudget(tx, ctx, id);
    });
  }

  /** `POST …/budgets/{id}/actions/approve` (committee / Owner): with an adopted resolution of the same building. */
  approveBudget(ctx: TenantContext, id: string, resolutionId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM juristic.budget WHERE id = ${id}::uuid FOR UPDATE`;
      const b = await this.loadBudget(tx, ctx, id);
      if (b.state !== 'draft')
        throw new DomainException('budget.invalid_state', { params: { state: b.state } });
      const r = await tx.resolution.findFirst({ where: this.own(ctx, { id: resolutionId }) });
      if (!r || r.state !== 'adopted' || r.buildingId !== b.buildingId)
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'resolutionId', code: 'resolution', message: 'an adopted resolution of the building' },
          ],
        });
      const previous = await tx.budget.findMany({
        where: this.own(ctx, { buildingId: b.buildingId, fiscalYear: b.fiscalYear, state: 'approved' }),
        select: { id: true },
      });
      if (previous.length)
        await tx.budget.updateMany({
          where: { id: { in: previous.map((p) => p.id) } },
          data: { state: 'superseded', updatedBy: by(), version: { increment: 1 } },
        });
      await tx.budget.update({
        where: { id },
        data: {
          state: 'approved',
          resolutionId,
          approvedAt: this.clock.now(),
          approvedBy: by(),
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.budget_approved',
        tenantId: ctx.tenantId,
        buildingId: b.buildingId,
        subjectType: 'juristic.budget',
        subjectId: b.id,
        after: { resolutionId, total: b.total.toFixed(2), superseded: previous.map((p) => p.id) },
      });
      await this.budgetEvent(tx, b, 'approved');
      return this.loadBudget(tx, ctx, id);
    });
  }

  private async budgetEvent(tx: Tx, b: { id: string; tenantId: string; buildingId: string }, change: string) {
    await this.events.record(tx, {
      type: 'juristic.budget.changed',
      aggregateType: 'budget',
      aggregateId: b.id,
      tenantId: b.tenantId,
      buildingId: b.buildingId,
      payload: { budgetId: b.id, buildingId: b.buildingId, change },
    });
  }

  /** The annual amount of the chosen lines (default: expense lines for a common fee, fund lines for a fund). */
  private amountOf(b: BudgetRow, input: RatePreviewInput): string {
    const lines = input.lineIds?.length
      ? b.lines.filter((l) => input.lineIds!.includes(l.id))
      : b.lines.filter((l) => (input.kind === 'fund' ? l.kind === 'fund' : l.kind === 'expense'));
    if (input.lineIds?.length && lines.length !== new Set(input.lineIds).size)
      throw new DomainException('http.not_found');
    const amount = lines.reduce((s, l) => s.plus(l.amount.toString()), D(0));
    if (!amount.gt(0))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'lineIds', code: 'min', message: 'the chosen budget lines sum to zero' }],
      });
    return amount.toFixed(2);
  }

  /** The default plan of the kind for the building (its frequency decides the cycle), if any. */
  private async defaultPlan(tx: Tx, ctx: TenantContext, buildingId: string, kind: 'common_fee' | 'fund') {
    return tx.ratePlan.findFirst({
      where: this.own(ctx, { buildingId, kind, isDefault: true, deletedAt: null }),
    });
  }

  private async previewIn(tx: Tx, ctx: TenantContext, b: BudgetRow, input: RatePreviewInput) {
    const annual = this.amountOf(b, input);
    const plan = await this.defaultPlan(tx, ctx, b.buildingId, input.kind);
    const frequency = input.frequency ?? plan?.frequency ?? 'monthly';
    const months = MONTHS_OF[frequency];
    const cycleAmount = periodBudget({ amount: annual, period: 'year' }, months);
    const units = await tx.unit.findMany({
      where: { buildingId: b.buildingId, deletedAt: null },
      select: { id: true, unitNo: true, areaSqm: true, ownershipRatio: true, landAreaSqwa: true },
      orderBy: { unitNo: 'asc' },
    });
    const r = splitBudget(
      cycleAmount,
      units.map((u) => ({
        unitId: u.id,
        areaSqm: u.areaSqm?.toString() ?? null,
        ownershipRatio: u.ownershipRatio?.toString() ?? null,
        landAreaSqwa: u.landAreaSqwa?.toString() ?? null,
      })),
      input.splitBy,
    );
    const amounts = [...r.amounts.values()];
    const stats = moneyStats(amounts);
    return {
      budgetId: b.id,
      buildingId: b.buildingId,
      kind: input.kind,
      splitBy: input.splitBy,
      frequency,
      annualAmount: annual,
      cycleAmount,
      ...stats,
      sumMatches: stats.sum === cycleAmount,
      unitsCount: units.length,
      missingUnitIds: r.missing,
      units: units
        .filter((u) => r.amounts.has(u.id))
        .map((u) => ({
          unitId: u.id,
          unitNo: u.unitNo,
          weight: r.weights.get(u.id)!,
          amount: r.amounts.get(u.id)!,
        })),
      ratePlanId: plan?.id ?? null,
    };
  }

  /** `POST …/budgets/{id}/rate-preview`: what each unit would pay per cycle (Σ = the cycle's budget exactly). */
  ratePreview(ctx: TenantContext, id: string, input: RatePreviewInput) {
    return this.db.tenant(ctx, async (tx) =>
      this.previewIn(tx, ctx, await this.loadBudget(tx, ctx, id), input),
    );
  }

  /**
   * `POST …/budgets/{id}/actions/create-rate-plan-draft`: an **approved** budget becomes a `budget_split` version of
   * the building's default plan of the kind (created when missing) from `effectiveFrom` (today or later — editable
   * until it takes effect), carrying the budget's resolution. Refused while units lack the weight (preview first).
   */
  async createRateDraft(
    ctx: TenantContext,
    id: string,
    input: RatePreviewInput & { effectiveFrom: string; planName?: string },
  ) {
    const prepared = await this.db.tenant(ctx, async (tx) => {
      const b = await this.loadBudget(tx, ctx, id);
      if (b.state !== 'approved')
        throw new DomainException('budget.invalid_state', { params: { state: b.state } });
      const preview = await this.previewIn(tx, ctx, b, input);
      if (preview.missingUnitIds.length)
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'splitBy',
              code: 'weightMissing',
              message: `${preview.missingUnitIds.length} unit(s) have no ${input.splitBy}`,
            },
          ],
        });
      return { b, preview };
    });
    const { b, preview } = prepared;
    const planId =
      preview.ratePlanId ??
      (
        await this.ratePlans.create(ctx, {
          buildingId: b.buildingId,
          kind: input.kind,
          name: input.planName ?? (input.kind === 'fund' ? 'เงินกองทุน' : 'ค่าส่วนกลาง'),
          isDefault: true,
          frequency: preview.frequency,
        })
      ).id;
    const plan = await this.ratePlans.saveVersion(ctx, planId, {
      effectiveFrom: input.effectiveFrom,
      basis: 'budget_split',
      tiers: { kind: 'budget', amount: preview.annualAmount, period: 'year', splitBy: input.splitBy },
      note: `งบประมาณ ${b.fiscalYear}: ${b.name}`,
      resolutionId: b.resolutionId,
    });
    await this.db.tenant(ctx, async (tx) => {
      await this.audit.record(tx, {
        action: 'juristic.rate_draft_created',
        tenantId: ctx.tenantId,
        buildingId: b.buildingId,
        subjectType: 'juristic.budget',
        subjectId: b.id,
        after: {
          ratePlanId: plan.id,
          effectiveFrom: input.effectiveFrom,
          annualAmount: preview.annualAmount,
          splitBy: input.splitBy,
        },
      });
      await this.budgetEvent(tx, b, 'rate_draft_created');
    });
    return { plan, preview: { ...preview, ratePlanId: plan.id } };
  }

  /** today (Bangkok) — exposed for DTO mappers. */
  today(): string {
    return bangkokDate(this.clock.now());
  }
}

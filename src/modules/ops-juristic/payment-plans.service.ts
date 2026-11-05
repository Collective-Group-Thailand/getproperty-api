import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import {
  billedParty,
  operators,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { isUniqueViolation } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type PaymentPlanState, type Prisma } from '@generated/prisma/client';
import { splitInstalments } from '@modules/ops-billing/engine/allocation';
import { InvoicesService } from '@modules/ops-billing/invoices.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { residentUnitAccess } from './resident-unit-access';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const OPEN = ['issued', 'partially_paid', 'overdue'] as const;
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/** `YYYY-MM-DD` + n calendar months, clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export const PLAN_INCLUDE = {
  instalments: { orderBy: { seq: 'asc' } },
  unit: { select: { id: true, unitNo: true } },
  party: { select: { id: true, displayName: true } },
} as const satisfies Prisma.PaymentPlanInclude;
export type PaymentPlanRow = Prisma.PaymentPlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

export interface PlanInput {
  instalments: number;
  firstDueOn?: string | null;
  note?: string | null;
}

/**
 * Payment plans (D-308 = D-J07, D-325): staff proposes, or the resident requests, an instalment plan of a party's
 * open invoices of a unit; the owner / manager / committee approves. At approval the open balances (the principal)
 * move onto the plan: each covered invoice gets a credit note for its balance (reason `payment_plan`) and the
 * principal is split into monthly instalments (Σ exact). The job `payment-plans` queues each instalment as an invoice
 * charge on the first day of its due month (billed by the next monthly cycle), marks it paid with its invoice and
 * defaults the plan when an instalment is still unpaid `default_after_days` after its invoice's due date: future
 * instalments are cancelled and the rest of the principal is billed at once — the debt is never lost or increased.
 * Every change is audited and announced (`juristic.payment_plan.*`; the J1.2b ladder pauses / resumes on them).
 */
@Injectable()
export class PaymentPlansService extends TenantScopedRepository implements OnModuleInit {
  private readonly logger = new Logger(PaymentPlansService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly invoices: InvoicesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    registerNotifiable('juristic.payment_plan.requested', async (tx, e) =>
      e.tenantId
        ? {
            recipients: await operators(tx, e.tenantId, ['owner', 'manager'], 'owner'),
            data: {
              tenant: { name: await tenantName(tx, e.tenantId) },
              plan: {
                unitNo: e.payload.unitNo,
                instalments: e.payload.instalments,
                principal: e.payload.principal,
              },
              party: { name: e.payload.partyName },
            },
          }
        : null,
    );
    const toResident = async (tx: Tx, e: { tenantId: string | null; payload: Record<string, unknown> }) => {
      const partyId = e.payload.partyId as string | undefined;
      if (!partyId || !e.tenantId) return null;
      return {
        recipients: await billedParty(tx, partyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          plan: {
            unitNo: e.payload.unitNo ?? null,
            instalments: e.payload.instalments ?? null,
            principal: e.payload.principal ?? null,
            firstDueOn: e.payload.firstDueOn ?? null,
            firstAmount: e.payload.firstAmount ?? null,
            accelerated: e.payload.accelerated ?? null,
          },
          link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/units/${e.payload.unitId as string}/payment-plans`,
        },
        consentPurpose: 'resident.service' as const,
      };
    };
    registerNotifiable('juristic.payment_plan.approved', toResident);
    registerNotifiable('juristic.payment_plan.defaulted', toResident);
  }

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  // ------------------------------------------------------------------------------------------- reads

  private async unitOf(tx: Tx, ctx: TenantContext, unitId: string) {
    const unit = await tx.unit.findFirst({ where: { id: unitId, deletedAt: null } });
    if (!unit || (ctx.buildingIds && !ctx.buildingIds.includes(unit.buildingId)))
      throw new DomainException('http.not_found');
    const building = await tx.building.findFirst({ where: { id: unit.buildingId, deletedAt: null } });
    if (!building || (building.operatorTenantId !== ctx.tenantId && building.ownerTenantId !== ctx.tenantId))
      throw new DomainException('http.not_found');
    return unit;
  }

  /** The party's open invoices of the unit in the tenant, oldest first. */
  private openInvoices(tx: Tx, tenantId: string, unitId: string, partyId: string) {
    return tx.invoice.findMany({
      where: { tenantId, unitId, billedPartyId: partyId, status: { in: [...OPEN] }, balance: { gt: 0 } },
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<PaymentPlanRow> {
    const p = this.found(
      await tx.paymentPlan.findFirst({ where: this.own(ctx, { id }), include: PLAN_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(p.buildingId))
      throw new DomainException('http.not_found');
    return p;
  }

  get(ctx: TenantContext, id: string): Promise<PaymentPlanRow> {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(
    ctx: TenantContext,
    q: { state?: PaymentPlanState; unitId?: string; partyId?: string; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.PaymentPlanWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.partyId ? { partyId: q.partyId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.paymentPlan.findMany({
          where,
          include: PLAN_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.paymentPlan.count({ where }),
      ]);
      return { rows, total };
    });
  }

  // ------------------------------------------------------------------------------------------- propose

  private async checkInput(tenantId: string, input: PlanInput): Promise<{ n: number; first: string }> {
    const max = Number(
      await this.settings.valueAt<number>('juristic.plan_max_instalments', this.clock.now(), { tenantId }),
    );
    const n = input.instalments;
    if (!Number.isInteger(n) || n < 2 || n > max)
      throw invalid('instalments', 'range', `between 2 and ${max} monthly instalments`);
    const today = this.today();
    const first = input.firstDueOn ?? addMonths(`${today.slice(0, 8)}01`, 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) throw invalid('firstDueOn', 'date', 'a date YYYY-MM-DD');
    if (first < today) throw invalid('firstDueOn', 'past', 'not before today');
    if (first > addCalendarDays(today, 92))
      throw invalid('firstDueOn', 'range', 'within 3 months from today');
    const note = input.note?.trim() ?? '';
    if (note.length > 1000) throw invalid('note', 'maxLength', 'at most 1000 characters');
    return { n, first };
  }

  private async create(
    tx: Tx,
    input: {
      tenantId: string;
      buildingId: string;
      unitId: string;
      partyId: string;
      kind: 'staff' | 'resident';
      requestedByUser: string | null;
      n: number;
      first: string;
      note: string | null;
    },
  ) {
    const open = await this.openInvoices(tx, input.tenantId, input.unitId, input.partyId);
    const principal = open.reduce((s, i) => s.plus(D(i.balance)), D(0));
    if (principal.lt(input.n)) throw new DomainException('payment_plan.nothing_due');
    let plan;
    try {
      plan = await tx.paymentPlan.create({
        data: {
          tenantId: input.tenantId,
          buildingId: input.buildingId,
          unitId: input.unitId,
          partyId: input.partyId,
          proposedByKind: input.kind,
          requestedByUser: input.requestedByUser,
          instalmentCount: input.n,
          firstDueOn: asDate(input.first),
          proposedPrincipal: principal.toFixed(2),
          invoiceIds: open.map((i) => i.id),
          note: input.note,
          createdBy: by(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainException('payment_plan.open_exists');
      throw error;
    }
    const [unit, party] = await Promise.all([
      tx.unit.findUniqueOrThrow({ where: { id: input.unitId }, select: { unitNo: true } }),
      tx.party.findUniqueOrThrow({ where: { id: input.partyId }, select: { displayName: true } }),
    ]);
    await this.audit.record(tx, {
      action: 'juristic.payment_plan_proposed',
      tenantId: input.tenantId,
      buildingId: input.buildingId,
      subjectType: 'juristic.payment_plan',
      subjectId: plan.id,
      metadata: {
        by: input.kind,
        instalments: input.n,
        principal: principal.toFixed(2),
        firstDueOn: input.first,
      },
    });
    await this.events.record(tx, {
      type: input.kind === 'resident' ? 'juristic.payment_plan.requested' : 'juristic.payment_plan.proposed',
      aggregateType: 'payment_plan',
      aggregateId: plan.id,
      tenantId: input.tenantId,
      buildingId: input.buildingId,
      payload: {
        planId: plan.id,
        unitId: input.unitId,
        unitNo: unit.unitNo,
        partyId: input.partyId,
        partyName: party.displayName,
        instalments: input.n,
        principal: principal.toFixed(2),
      },
    });
    return plan;
  }

  /** `POST /v1/owner/juristic/payment-plans`: staff proposes a plan for a party of a unit. */
  async propose(
    ctx: TenantContext,
    input: PlanInput & { unitId: string; partyId: string },
  ): Promise<PaymentPlanRow> {
    const { n, first } = await this.checkInput(ctx.tenantId, input);
    const id = await this.db.tenant(ctx, async (tx) => {
      const unit = await this.unitOf(tx, ctx, input.unitId);
      this.found(await tx.party.findFirst({ where: { id: input.partyId, deletedAt: null } }));
      const plan = await this.create(tx, {
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        unitId: unit.id,
        partyId: input.partyId,
        kind: 'staff',
        requestedByUser: null,
        n,
        first,
        note: input.note?.trim() || null,
      });
      return plan.id;
    });
    return this.get(ctx, id);
  }

  /** `POST /v1/resident/units/{unitId}/payment-plan-requests`: the billed resident asks for a plan. */
  async residentRequest(unitId: string, input: PlanInput): Promise<PaymentPlanRow> {
    const access = await this.db.platform((tx) =>
      residentUnitAccess(tx, unitId, ['co_owner', 'payer', 'tenant'], this.clock.now()),
    );
    const { n, first } = await this.checkInput(access.tenantId, input);
    const id = await this.db.tenant(access.ctx, async (tx) => {
      // the billed party of mine with something open on the unit (a co-owner and a payer may both be me)
      let partyId = access.partyIds[0]!;
      for (const p of access.partyIds)
        if ((await this.openInvoices(tx, access.tenantId, unitId, p)).length) {
          partyId = p;
          break;
        }
      const plan = await this.create(tx, {
        tenantId: access.tenantId,
        buildingId: access.buildingId,
        unitId,
        partyId,
        kind: 'resident',
        requestedByUser: access.userId,
        n,
        first,
        note: input.note?.trim() || null,
      });
      return plan.id;
    });
    return this.db.tenant(access.ctx, (tx) =>
      tx.paymentPlan.findUniqueOrThrow({ where: { id }, include: PLAN_INCLUDE }),
    );
  }

  async residentList(unitId: string): Promise<PaymentPlanRow[]> {
    const access = await this.db.platform((tx) =>
      residentUnitAccess(tx, unitId, ['co_owner', 'payer', 'tenant'], this.clock.now()),
    );
    return this.db.tenant(access.ctx, (tx) =>
      tx.paymentPlan.findMany({
        where: { tenantId: access.tenantId, unitId, partyId: { in: access.partyIds } },
        include: PLAN_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }

  /** The resident withdraws their own request while it waits. */
  async residentWithdraw(unitId: string, planId: string): Promise<PaymentPlanRow> {
    const access = await this.db.platform((tx) =>
      residentUnitAccess(tx, unitId, ['co_owner', 'payer', 'tenant'], this.clock.now()),
    );
    await this.db.tenant(access.ctx, async (tx) => {
      const plan = await tx.paymentPlan.findFirst({
        where: { id: planId, tenantId: access.tenantId, unitId, partyId: { in: access.partyIds } },
      });
      if (!plan) throw new DomainException('http.not_found');
      await this.end(tx, plan.id, 'cancelled', 'withdrawn by the resident', ['proposed']);
    });
    return this.db.tenant(access.ctx, (tx) =>
      tx.paymentPlan.findUniqueOrThrow({ where: { id: planId }, include: PLAN_INCLUDE }),
    );
  }

  // ------------------------------------------------------------------------------------------- decide

  /**
   * Approval (owner / manager / committee): the balances open **now** are the principal; each covered invoice is
   * credited for its balance (reason `payment_plan`); instalments are scheduled monthly from `firstDueOn`.
   */
  async approve(ctx: TenantContext, id: string): Promise<PaymentPlanRow> {
    await this.db.tenant(
      ctx,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM juristic.payment_plan WHERE id = ${id}::uuid FOR UPDATE`;
        const plan = await this.load(tx, ctx, id);
        if (plan.state !== 'proposed')
          throw new DomainException('payment_plan.invalid_state', { params: { state: plan.state } });
        const open = await this.openInvoices(tx, plan.tenantId, plan.unitId, plan.partyId);
        const principal = open.reduce((s, i) => s.plus(D(i.balance)), D(0));
        if (principal.lt(plan.instalmentCount)) throw new DomainException('payment_plan.nothing_due');
        const ref = `แผนผ่อนชำระ ${plan.id.slice(-8).toUpperCase()}`;
        const creditNoteIds: string[] = [];
        for (const inv of open)
          creditNoteIds.push(
            await this.invoices.noteIn(tx, ctx, 'credit', inv.id, {
              reason: 'payment_plan',
              reasonText: `${ref} — ยอดคงค้างย้ายไปผ่อนชำระเป็นงวด`,
              lines: [
                {
                  lineKind: 'plan_instalment',
                  description: `ยอดคงค้างใบแจ้งหนี้ ${inv.number ?? ''} ย้ายไป${ref}`.trim(),
                  amount: D(inv.balance).toFixed(2),
                },
              ],
            }),
          );
        const amounts = splitInstalments(principal, plan.instalmentCount);
        const first = day(plan.firstDueOn);
        await tx.paymentPlanInstalment.createMany({
          data: amounts.map((amount, i) => ({
            tenantId: plan.tenantId,
            planId: plan.id,
            seq: i + 1,
            dueOn: asDate(addMonths(first, i)),
            amount,
          })),
        });
        const defaultAfter = Number(
          await this.settings.valueAt<number>('juristic.plan_default_days', this.clock.now(), {
            tenantId: plan.tenantId,
          }),
        );
        const now = this.clock.now();
        await tx.paymentPlan.update({
          where: { id },
          data: {
            state: 'active',
            principal: principal.toFixed(2),
            invoiceIds: open.map((i) => i.id),
            creditNoteIds,
            defaultAfterDays: defaultAfter,
            approvedAt: now,
            approvedBy: by(),
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          action: 'juristic.payment_plan_approved',
          tenantId: plan.tenantId,
          buildingId: plan.buildingId,
          subjectType: 'juristic.payment_plan',
          subjectId: id,
          metadata: {
            principal: principal.toFixed(2),
            instalments: amounts,
            invoices: open.map((i) => i.number),
            creditNoteIds,
            defaultAfterDays: defaultAfter,
          },
        });
        await this.events.record(tx, {
          type: 'juristic.payment_plan.approved',
          aggregateType: 'payment_plan',
          aggregateId: id,
          tenantId: plan.tenantId,
          buildingId: plan.buildingId,
          payload: {
            planId: id,
            unitId: plan.unitId,
            unitNo: plan.unit.unitNo,
            partyId: plan.partyId,
            principal: principal.toFixed(2),
            instalments: plan.instalmentCount,
            firstDueOn: first,
            firstAmount: amounts[0],
          },
        });
      },
      { timeout: 60_000 },
    );
    return this.get(ctx, id);
  }

  async reject(ctx: TenantContext, id: string, reason: string): Promise<PaymentPlanRow> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 1000)
      throw invalid('reason', 'length', 'between 3 and 1000 characters');
    await this.db.tenant(ctx, async (tx) => {
      await this.load(tx, ctx, id);
      await this.end(tx, id, 'rejected', text, ['proposed']);
    });
    return this.get(ctx, id);
  }

  /** Cancel a proposed plan, or an active one — the rest of its principal is billed at once (never forgiven). */
  async cancel(ctx: TenantContext, id: string, reason: string): Promise<PaymentPlanRow> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 1000)
      throw invalid('reason', 'length', 'between 3 and 1000 characters');
    await this.db.tenant(ctx, async (tx) => {
      await this.load(tx, ctx, id);
      await this.end(tx, id, 'cancelled', text, ['proposed', 'active']);
    });
    return this.get(ctx, id);
  }

  /**
   * Ends a plan (rejected · cancelled · defaulted). An active plan's scheduled instalments are cancelled and their
   * sum is queued as one charge for the next monthly cycle (acceleration of the original debt, not a penalty).
   */
  private async end(
    tx: Tx,
    id: string,
    to: 'rejected' | 'cancelled' | 'defaulted',
    reason: string,
    from: PaymentPlanState[],
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM juristic.payment_plan WHERE id = ${id}::uuid FOR UPDATE`;
    const plan = await tx.paymentPlan.findUniqueOrThrow({ where: { id }, include: PLAN_INCLUDE });
    if (!from.includes(plan.state))
      throw new DomainException('payment_plan.invalid_state', { params: { state: plan.state } });
    const now = this.clock.now();
    let acceleratedChargeId: string | null = null;
    let accelerated = D(0);
    if (plan.state === 'active') {
      // future instalments: still scheduled, or queued but not yet on an issued invoice (their charge is pending)
      const queued = plan.instalments.filter((i) => i.state === 'billed' && i.invoiceChargeId);
      const pendingCharges = queued.length
        ? await tx.invoiceCharge.findMany({
            where: { id: { in: queued.map((i) => i.invoiceChargeId!) }, status: 'pending' },
            select: { id: true },
          })
        : [];
      const pendingIds = new Set(pendingCharges.map((c) => c.id));
      const rest = plan.instalments.filter(
        (i) => i.state === 'scheduled' || (i.state === 'billed' && pendingIds.has(i.invoiceChargeId ?? '')),
      );
      accelerated = rest.reduce((s, i) => s.plus(D(i.amount)), D(0));
      if (pendingIds.size)
        await tx.invoiceCharge.updateMany({
          where: { id: { in: [...pendingIds] }, status: 'pending' },
          data: {
            status: 'cancelled',
            cancelledAt: now,
            cancelReason: `payment plan ${to}`,
            updatedBy: by(),
          },
        });
      if (rest.length)
        await tx.paymentPlanInstalment.updateMany({
          where: { id: { in: rest.map((i) => i.id) } },
          data: { state: 'cancelled', cancelledAt: now },
        });
      if (accelerated.gt(0)) {
        const charge = await tx.invoiceCharge.create({
          data: {
            tenantId: plan.tenantId,
            buildingId: plan.buildingId,
            unitId: plan.unitId,
            partyId: plan.partyId,
            sourceType: 'adjustment',
            lineKind: 'plan_instalment',
            sourceId: plan.id,
            description:
              to === 'defaulted'
                ? `ยอดคงเหลือตามแผนผ่อนชำระ (ผิดนัดชำระ) ${rest.length} งวด`
                : `ยอดคงเหลือตามแผนผ่อนชำระ (ยกเลิกแผน) ${rest.length} งวด`,
            quantity: '1.000',
            unitPrice: accelerated.toFixed(4),
            amount: accelerated.toFixed(2),
            createdBy: by(),
          },
        });
        acceleratedChargeId = charge.id;
        await this.events.record(tx, {
          type: 'invoice_charge.queued',
          aggregateType: 'invoice_charge',
          aggregateId: charge.id,
          tenantId: plan.tenantId,
          buildingId: plan.buildingId,
          payload: {
            chargeId: charge.id,
            unitId: plan.unitId,
            partyId: plan.partyId,
            amount: accelerated.toFixed(2),
          },
        });
      }
    }
    await tx.paymentPlan.update({
      where: { id },
      data: {
        state: to,
        decidedReason: reason,
        endedAt: now,
        acceleratedChargeId,
        updatedBy: by(),
        version: { increment: 1 },
      },
    });
    await this.audit.record(tx, {
      action: `juristic.payment_plan_${to}`,
      tenantId: plan.tenantId,
      buildingId: plan.buildingId,
      subjectType: 'juristic.payment_plan',
      subjectId: id,
      metadata: { from: plan.state, reason, accelerated: accelerated.toFixed(2), acceleratedChargeId },
    });
    await this.events.record(tx, {
      type: `juristic.payment_plan.${to}`,
      aggregateType: 'payment_plan',
      aggregateId: id,
      tenantId: plan.tenantId,
      buildingId: plan.buildingId,
      payload: {
        planId: id,
        unitId: plan.unitId,
        unitNo: plan.unit.unitNo,
        partyId: plan.partyId,
        from: plan.state,
        reason,
        accelerated: accelerated.toFixed(2),
        acceleratedChargeId,
      },
    });
  }

  // ------------------------------------------------------------------------------------------- job

  /**
   * Job `payment-plans` (hourly): (1) queue the charge of every scheduled instalment of an active plan whose due month
   * has begun; (2) mark billed instalments paid when their invoice is paid, complete plans with every instalment paid;
   * (3) default a plan when a billed instalment's invoice is still open more than `default_after_days` after its due
   * date. Idempotent; each plan in its own transaction.
   */
  async maintain(): Promise<{ queued: number; paid: number; defaulted: number; completed: number }> {
    return RequestContext.run({ actor: systemActor('payment-plans') }, async () => {
      const today = this.today();
      const monthEnd = addCalendarDays(addMonths(`${today.slice(0, 8)}01`, 1), -1);
      const plans = await this.db.platform((tx) =>
        tx.paymentPlan.findMany({
          where: { state: 'active' },
          select: { id: true, tenantId: true },
          orderBy: { id: 'asc' },
          take: 5000,
        }),
      );
      const out = { queued: 0, paid: 0, defaulted: 0, completed: 0 };
      for (const p of plans) {
        try {
          await this.db.tenant(systemTenantContext(p.tenantId), async (tx) => {
            const r = await this.maintainPlan(tx, p.id, today, monthEnd);
            out.queued += r.queued;
            out.paid += r.paid;
            out.defaulted += r.defaulted ? 1 : 0;
            out.completed += r.completed ? 1 : 0;
          });
        } catch (error) {
          this.logger.error(`payment plan ${p.id}: ${(error as Error).message}`);
        }
      }
      return out;
    });
  }

  private async maintainPlan(
    tx: Tx,
    id: string,
    today: string,
    monthEnd: string,
  ): Promise<{ queued: number; paid: number; defaulted: boolean; completed: boolean }> {
    await tx.$queryRaw`SELECT id FROM juristic.payment_plan WHERE id = ${id}::uuid FOR UPDATE`;
    const plan = await tx.paymentPlan.findUniqueOrThrow({ where: { id }, include: PLAN_INCLUDE });
    if (plan.state !== 'active') return { queued: 0, paid: 0, defaulted: false, completed: false };
    const now = this.clock.now();
    let queued = 0;
    let paid = 0;
    const billed = await tx.paymentPlanInstalment.findMany({
      where: { planId: id, state: 'billed' },
      include: {
        invoiceCharge: {
          select: {
            status: true,
            appliedLine: {
              select: { invoice: { select: { id: true, status: true, balance: true, dueDate: true } } },
            },
          },
        },
      },
      orderBy: { seq: 'asc' },
    });
    let late: (typeof billed)[number] | null = null;
    for (const i of billed) {
      const inv = i.invoiceCharge?.appliedLine?.invoice;
      if (!inv || i.invoiceCharge?.status !== 'applied') continue;
      if (inv.status === 'paid' || (inv.status !== 'void' && D(inv.balance).lte(0))) {
        await tx.paymentPlanInstalment.update({ where: { id: i.id }, data: { state: 'paid', paidAt: now } });
        paid += 1;
        continue;
      }
      const due = inv.dueDate ? day(inv.dueDate) : day(i.dueOn);
      const graceEnd = addCalendarDays(due > day(i.dueOn) ? due : day(i.dueOn), plan.defaultAfterDays ?? 30);
      if (!late && OPEN.includes(inv.status as (typeof OPEN)[number]) && today > graceEnd) late = i;
    }
    if (late) {
      await this.end(
        tx,
        id,
        'defaulted',
        `งวดที่ ${late.seq} ค้างชำระเกิน ${plan.defaultAfterDays} วันหลังครบกำหนด`,
        ['active'],
      );
      return { queued, paid, defaulted: true, completed: false };
    }
    for (const i of plan.instalments.filter((x) => x.state === 'scheduled' && day(x.dueOn) <= monthEnd)) {
      const charge = await tx.invoiceCharge.create({
        data: {
          tenantId: plan.tenantId,
          buildingId: plan.buildingId,
          unitId: plan.unitId,
          partyId: plan.partyId,
          sourceType: 'adjustment',
          lineKind: 'plan_instalment',
          sourceId: i.id,
          description: `งวดที่ ${i.seq}/${plan.instalmentCount} แผนผ่อนชำระ (ครบกำหนด ${day(i.dueOn)})`,
          quantity: '1.000',
          unitPrice: D(i.amount).toFixed(4),
          amount: D(i.amount).toFixed(2),
          createdBy: by(),
        },
      });
      await tx.paymentPlanInstalment.update({
        where: { id: i.id },
        data: { state: 'billed', invoiceChargeId: charge.id, billedAt: now },
      });
      await this.events.record(tx, {
        type: 'invoice_charge.queued',
        aggregateType: 'invoice_charge',
        aggregateId: charge.id,
        tenantId: plan.tenantId,
        buildingId: plan.buildingId,
        payload: {
          chargeId: charge.id,
          unitId: plan.unitId,
          partyId: plan.partyId,
          amount: charge.amount.toFixed(2),
        },
      });
      queued += 1;
    }
    const left = await tx.paymentPlanInstalment.count({
      where: { planId: id, state: { in: ['scheduled', 'billed'] } },
    });
    if (left === 0) {
      await tx.paymentPlan.update({
        where: { id },
        data: { state: 'completed', endedAt: now, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'juristic.payment_plan_completed',
        tenantId: plan.tenantId,
        buildingId: plan.buildingId,
        subjectType: 'juristic.payment_plan',
        subjectId: id,
        metadata: { principal: plan.principal?.toFixed(2) ?? null },
      });
      await this.events.record(tx, {
        type: 'juristic.payment_plan.completed',
        aggregateType: 'payment_plan',
        aggregateId: id,
        tenantId: plan.tenantId,
        buildingId: plan.buildingId,
        payload: { planId: id, unitId: plan.unitId, partyId: plan.partyId },
      });
      return { queued, paid, defaulted: false, completed: true };
    }
    return { queued, paid, defaulted: false, completed: false };
  }
}

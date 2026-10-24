import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type BillingPeriod,
  type PricePlan,
  type PricePlanVersion,
  type Prisma,
  type Subscription,
} from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { OPEN_SUBSCRIPTION_STATES, PlatformBillingService } from './platform-billing.service';
import { computeCharges, type PriceTier, type PriceVersion, PricingError, type UsageCounts } from './pricing';

export const SUBSCRIPTION_INCLUDE = {
  planVersion: { include: { plan: true } },
  tenant: { select: { id: true, displayName: true, type: true, status: true } },
  pilotAgreement: true,
} as const satisfies Prisma.SubscriptionInclude;
export type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: typeof SUBSCRIPTION_INCLUDE }>;

type VersionWithPlan = PricePlanVersion & { plan: PricePlan };

const by = () => userIdOf(RequestContext.actor());
const daysInMonth = (day: string) => {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const monthOf = (day: string) => `${day.slice(0, 8)}01`;
const lastDayOfMonth = (day: string) => `${day.slice(0, 8)}${String(daysInMonth(day)).padStart(2, '0')}`;
const nextMonth = (day: string) => addCalendarDays(lastDayOfMonth(day), 1);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

/** A price plan version as the pure pricing engine reads it. */
export function priceVersionOf(v: VersionWithPlan): PriceVersion {
  return {
    planKey: v.plan.key,
    nameTh: v.plan.nameTh,
    kind: v.plan.kind,
    billingUnit: v.billingUnit,
    unitPrice: v.unitPrice?.toString() ?? null,
    tiers: (Array.isArray(v.tiers) ? v.tiers : []) as unknown as PriceTier[],
    minUnits: v.minUnits,
    minMonthly: v.minMonthly?.toString() ?? null,
    annualDiscountPct: v.annualDiscountPct.toString(),
    vatRate: v.vatRate.toString(),
    includedAllowances: (v.includedAllowances ?? {}) as PriceVersion['includedAllowances'],
  };
}

/**
 * Subscriptions of tenants (B6.1, D-082, D-156): created in trial (`subscription.trial_days`, 30) on a published,
 * active price plan version of the tenant's type, with add-ons (meter rental for Smart) and a discount from the pilot
 * agreement (D-083). The hourly `platform-subscriptions` job runs the lifecycle: the trial's end issues the first
 * invoice (pro-rata to the month end; nothing to pay → active at once, e.g. the landlord free tier), the 1st of
 * each month snapshots usage (units counted = units whose status is not inactive, rented meter points, OCR images
 * of the previous month) and issues the month's invoice, an invoice unpaid at due + `subscription.grace_days` makes
 * the subscription past_due, and `subscription.suspend_after_days` later it is suspended — the tenant becomes
 * read-only (owner/staff mutations refused with `subscription.suspended`; residents still see and pay invoices,
 * nothing is deleted). A payment reinstates it. Cancellation takes effect at the end of the paid month and opens a
 * de-install order for the platform's hardware (D-081).
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly billing: PlatformBillingService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------- plans

  /** The published version of an active plan in force on `day` (Bangkok date). */
  async versionInForce(tx: Tx, planKey: string, day: string): Promise<VersionWithPlan> {
    const v = await tx.pricePlanVersion.findFirst({
      where: {
        plan: { key: planKey },
        state: 'published',
        effectiveFrom: { lte: new Date(`${day}T00:00:00Z`) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date(`${day}T00:00:00Z`) } }],
      },
      include: { plan: true },
    });
    if (!v) throw new DomainException('price_plan.not_found', { params: { plan: planKey } });
    return v;
  }

  private async addonVersions(tx: Tx, sub: Pick<Subscription, 'addonPlanVersionIds'>, day: string) {
    if (!sub.addonPlanVersionIds.length) return [];
    const pinned = await tx.pricePlanVersion.findMany({
      where: { id: { in: sub.addonPlanVersionIds } },
      include: { plan: true },
    });
    // the version in force today for each add-on plan (a price change applies from its effective date)
    return Promise.all(pinned.map((p) => this.versionInForce(tx, p.plan.key, day)));
  }

  // ------------------------------------------------------------------------------------------- create & change

  async create(input: {
    tenantId: string;
    planKey: string;
    addonKeys?: string[];
    billingPeriod?: BillingPeriod;
  }): Promise<SubscriptionRow> {
    const now = this.clock.now();
    if (!(await this.enabled(now))) throw new DomainException('subscription.disabled');
    const today = bangkokDate(now);
    const trialDays = await this.settings.valueAt<number>('subscription.trial_days', now);
    return this.db.platform(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: input.tenantId, deletedAt: null } });
      if (!tenant) throw new DomainException('http.not_found');
      const open = await tx.subscription.findFirst({
        where: { tenantId: input.tenantId, state: { in: [...OPEN_SUBSCRIPTION_STATES] } },
      });
      if (open) throw new DomainException('subscription.exists', { params: { state: open.state } });
      const { version, addons } = await this.validatePlan(
        tx,
        tenant.type,
        input.planKey,
        input.addonKeys ?? [],
        today,
      );
      const pilot = await tx.pilotAgreement.findUnique({ where: { tenantId: input.tenantId } });
      const sub = await tx.subscription.create({
        data: {
          tenantId: input.tenantId,
          planVersionId: version.id,
          planKey: version.plan.key,
          addonPlanVersionIds: addons.map((a) => a.id),
          state: 'trial',
          trialEndsAt: new Date(now.getTime() + trialDays * 86_400_000),
          startedAt: now,
          billingPeriod: input.billingPeriod ?? 'monthly',
          discountPct: pilot?.discountPct ?? 0,
          discountReason: pilot ? 'pilot' : null,
          pilotAgreementId: pilot?.id ?? null,
          createdBy: by(),
        },
      });
      await tx.tenant.update({ where: { id: input.tenantId }, data: { plan: version.plan.key } });
      await this.billing.history(tx, sub, 'created', {
        plan: version.plan.key,
        version: version.version,
        addons: addons.map((a) => a.plan.key),
        trialEndsAt: sub.trialEndsAt.toISOString(),
      });
      await this.audit.record(tx, {
        action: 'subscription.created',
        tenantId: input.tenantId,
        subjectType: 'platform.subscription',
        subjectId: sub.id,
        after: { plan: version.plan.key, addons: addons.map((a) => a.plan.key), state: 'trial' },
      });
      await this.events.record(tx, {
        type: 'subscription.created',
        aggregateType: 'subscription',
        aggregateId: sub.id,
        tenantId: input.tenantId,
        payload: {
          subscriptionId: sub.id,
          plan: version.plan.key,
          trialEndsAt: sub.trialEndsAt.toISOString(),
        },
      });
      return tx.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: SUBSCRIPTION_INCLUDE });
    });
  }

  private async validatePlan(tx: Tx, tenantType: string, planKey: string, addonKeys: string[], day: string) {
    const version = await this.versionInForce(tx, planKey, day);
    if (!version.plan.isActive || version.plan.kind === 'addon' || version.plan.kind === 'hardware_rental')
      throw new DomainException('price_plan.not_sold', { params: { plan: planKey } });
    if (version.plan.tenantType && version.plan.tenantType !== tenantType)
      throw new DomainException('subscription.plan_mismatch', { params: { plan: planKey, tenantType } });
    const addons: VersionWithPlan[] = [];
    for (const key of [...new Set(addonKeys)]) {
      const a = await this.versionInForce(tx, key, day);
      const addonOf = ((a.terms ?? {}) as { addonOf?: string[] }).addonOf;
      if (
        !a.plan.isActive ||
        !['addon', 'hardware_rental'].includes(a.plan.kind) ||
        (addonOf && !addonOf.includes(planKey))
      )
        throw new DomainException('price_plan.not_sold', { params: { plan: key } });
      addons.push(a);
    }
    return { version, addons };
  }

  async changePlan(id: string, input: { planKey: string; addonKeys?: string[]; reason?: string | null }) {
    const today = bangkokDate(this.clock.now());
    return this.db.platform(async (tx) => {
      const sub = await this.lockOpen(tx, id);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: sub.tenantId } });
      const { version, addons } = await this.validatePlan(
        tx,
        tenant.type,
        input.planKey,
        input.addonKeys ?? [],
        today,
      );
      await tx.subscription.update({
        where: { id },
        data: {
          planVersionId: version.id,
          planKey: version.plan.key,
          addonPlanVersionIds: addons.map((a) => a.id),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await tx.tenant.update({ where: { id: sub.tenantId }, data: { plan: version.plan.key } });
      await this.billing.history(tx, sub, 'plan_changed', {
        from: sub.planKey,
        to: version.plan.key,
        addons: addons.map((a) => a.plan.key),
        reason: input.reason ?? null,
      });
      await this.audit.record(tx, {
        action: 'subscription.plan_changed',
        tenantId: sub.tenantId,
        subjectType: 'platform.subscription',
        subjectId: id,
        before: { plan: sub.planKey },
        after: { plan: version.plan.key, addons: addons.map((a) => a.plan.key) },
      });
      await this.events.record(tx, {
        type: 'subscription.plan_changed',
        aggregateType: 'subscription',
        aggregateId: id,
        tenantId: sub.tenantId,
        payload: { subscriptionId: id, from: sub.planKey, to: version.plan.key },
      });
      return tx.subscription.findUniqueOrThrow({ where: { id }, include: SUBSCRIPTION_INCLUDE });
    });
  }

  private async lockOpen(tx: Tx, id: string): Promise<Subscription> {
    await tx.$queryRaw`SELECT id FROM platform.subscription WHERE id = ${id}::uuid FOR UPDATE`;
    const sub = await tx.subscription.findUnique({ where: { id } });
    if (!sub) throw new DomainException('http.not_found');
    if (sub.state === 'cancelled')
      throw new DomainException('subscription.invalid_state', { params: { state: sub.state } });
    return sub;
  }

  /**
   * Cancellation (D-082): takes effect at the end of the current Bangkok month (or a later date); until then the
   * tenant keeps working. When it takes effect the job closes the subscription, makes the tenant read-only and
   * opens a de-install order for the platform hardware (D-081).
   */
  async cancel(id: string, input: { reason: string; effectiveDate?: string | null }) {
    const today = bangkokDate(this.clock.now());
    const effective = input.effectiveDate ?? lastDayOfMonth(today);
    if (effective < today)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'effectiveDate', code: 'past', message: 'not before today' }],
      });
    return this.db.platform(async (tx) => {
      const sub = await this.lockOpen(tx, id);
      await tx.subscription.update({
        where: { id },
        data: {
          cancelReason: input.reason,
          cancelEffectiveDate: new Date(`${effective}T00:00:00Z`),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.billing.history(tx, sub, 'cancellation_requested', { reason: input.reason, effective });
      await this.audit.record(tx, {
        action: 'subscription.cancellation_requested',
        tenantId: sub.tenantId,
        subjectType: 'platform.subscription',
        subjectId: id,
        after: { reason: input.reason, effective },
      });
      return tx.subscription.findUniqueOrThrow({ where: { id }, include: SUBSCRIPTION_INCLUDE });
    });
  }

  /** Platform admin: suspend now (typed confirmation in the UI) or reinstate (D-082, audited). */
  async setSuspended(id: string, suspend: boolean, reason: string) {
    const r = await this.db.platform(async (tx) => {
      const sub = await this.lockOpen(tx, id);
      const now = this.clock.now();
      if (suspend) {
        if (sub.state === 'suspended')
          throw new DomainException('subscription.invalid_state', { params: { state: sub.state } });
        await this.billing.transition(
          tx,
          sub,
          'suspended',
          { suspendedAt: now, pastDueSince: sub.pastDueSince ?? now },
          `manual: ${reason}`,
        );
      } else {
        if (sub.state !== 'suspended')
          throw new DomainException('subscription.invalid_state', { params: { state: sub.state } });
        await this.billing.transition(
          tx,
          sub,
          sub.activatedAt ? 'active' : 'trial',
          { suspendedAt: null, pastDueSince: null },
          `manual: ${reason}`,
        );
      }
      return tx.subscription.findUniqueOrThrow({ where: { id }, include: SUBSCRIPTION_INCLUDE });
    });
    await this.billing.refreshAccess();
    return r;
  }

  // ------------------------------------------------------------------------------------------- reads

  current(ctx: TenantContext): Promise<SubscriptionRow | null> {
    return this.db.tenant(ctx, (tx) =>
      tx.subscription.findFirst({
        where: { tenantId: ctx.tenantId },
        include: SUBSCRIPTION_INCLUDE,
        orderBy: { startedAt: 'desc' },
      }),
    );
  }

  get(id: string): Promise<SubscriptionRow> {
    return this.db.platform(async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { id }, include: SUBSCRIPTION_INCLUDE });
      if (!sub) throw new DomainException('http.not_found');
      return sub;
    });
  }

  list(filter: { tenantId?: string; state?: string; skip: number; take: number }) {
    const where: Prisma.SubscriptionWhereInput = {
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(filter.state ? { state: filter.state as never } : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.subscription.findMany({
        where,
        include: SUBSCRIPTION_INCLUDE,
        orderBy: { startedAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.subscription.count({ where }),
    }));
  }

  eventsOf(subscriptionId: string) {
    return this.db.platform((tx) =>
      tx.subscriptionEvent.findMany({ where: { subscriptionId }, orderBy: { occurredAt: 'asc' } }),
    );
  }

  /** The add-ons of a subscription as references (plan key, name, pinned version). */
  async addonRefs(sub: Pick<Subscription, 'addonPlanVersionIds'>) {
    if (!sub.addonPlanVersionIds.length) return [];
    const rows = await this.db.platform((tx) =>
      tx.pricePlanVersion.findMany({
        where: { id: { in: sub.addonPlanVersionIds } },
        include: { plan: true },
      }),
    );
    return rows.map((v) => ({ key: v.plan.key, nameTh: v.plan.nameTh, versionId: v.id, version: v.version }));
  }

  /** OCR photos included per month in the tenant's current plan (D-161), null without a plan or allowance. */
  async ocrAllowance(tenantId: string): Promise<number | null> {
    const sub = await this.db.platform((tx) =>
      tx.subscription.findFirst({
        where: { tenantId, state: { in: [...OPEN_SUBSCRIPTION_STATES] } },
        include: { planVersion: true },
      }),
    );
    const allowances = (sub?.planVersion.includedAllowances ?? {}) as { ocrPhotosPerMonth?: number };
    return typeof allowances.ocrPhotosPerMonth === 'number' ? allowances.ocrPhotosPerMonth : null;
  }

  // ------------------------------------------------------------------------------------------- usage

  /**
   * What a tenant uses on a counting day (D-082, D-156, D-161): units whose status is not inactive (soft-deleted
   * excluded), per building; rented meter points (HaaS meters installed / in service); buildings it owns or
   * operates; meter photos read by OCR in the month before `month`.
   */
  async countUsage(
    tx: Tx,
    tenantId: string,
    month: string,
  ): Promise<UsageCounts & { unitsByBuilding: Record<string, number> }> {
    const units = await tx.$queryRaw<{ building_id: string; n: number }[]>`
      SELECT building_id, count(*)::int AS n FROM core.unit
       WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND status <> 'inactive'
       GROUP BY building_id`;
    const meterPoints = await tx.haasAsset.count({
      where: {
        tenantId,
        state: { in: ['installed', 'in_service'] },
        kind: { in: ['electric_meter', 'water_meter'] },
      },
    });
    const buildings = await tx.building.count({
      where: { deletedAt: null, OR: [{ ownerTenantId: tenantId }, { operatorTenantId: tenantId }] },
    });
    const previous = addCalendarDays(month, -1);
    const ocr = await tx.aiUsageRecord.aggregate({
      where: {
        tenantId,
        feature: 'meter_ocr',
        occurredAt: { gte: startOfBangkokDay(monthOf(previous)), lt: startOfBangkokDay(month) },
      },
      _sum: { inputUnits: true },
    });
    return {
      units: units.reduce((s, r) => s + r.n, 0),
      unitsByBuilding: Object.fromEntries(units.map((r) => [r.building_id, r.n])),
      meterPoints,
      buildings,
      ocrImages: ocr._sum.inputUnits ?? 0,
    };
  }

  /** Price of a period for a subscription (pure engine over the versions in force on `day`). */
  private async charges(
    tx: Tx,
    sub: Subscription,
    usage: UsageCounts,
    day: string,
    proRata?: { days: number; daysInMonth: number },
  ) {
    const plan = await this.versionInForce(tx, sub.planKey, day);
    const addons = await this.addonVersions(tx, sub, day);
    // the OCR overage is billed only once AI usage metering is switched on (D-161, Proposed: off by default)
    const metering = await this.settings.valueAt<{ enabled?: boolean }>(
      'ai.usage_metering',
      this.clock.now(),
    );
    if (!metering.enabled) usage = { ...usage, ocrImages: 0 };
    return {
      plan,
      addons,
      charges: computeCharges({
        plan: priceVersionOf(plan),
        addons: addons.map(priceVersionOf),
        usage,
        proRata,
        billingPeriod: sub.billingPeriod,
        discountPct: sub.discountPct.toString(),
        discountReason: sub.discountReason,
      }),
    };
  }

  /** The owner's estimate of the current month (what the 1st-of-month invoice would be with today's usage). */
  async estimate(ctx: TenantContext) {
    return this.db.platform(async (tx) => {
      const sub = await tx.subscription.findFirst({
        where: { tenantId: ctx.tenantId, state: { in: [...OPEN_SUBSCRIPTION_STATES] } },
      });
      if (!sub) return null;
      const today = bangkokDate(this.clock.now());
      const usage = await this.countUsage(tx, ctx.tenantId, monthOf(today));
      try {
        return { usage, charges: (await this.charges(tx, sub, usage, today)).charges };
      } catch (error) {
        // a plan quoted as a range has no automatic price
        if (error instanceof PricingError) return { usage, charges: null };
        throw error;
      }
    });
  }

  usages(ctx: TenantContext, months = 12) {
    return this.db.tenant(ctx, (tx) =>
      tx.subscriptionUsage.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { month: 'desc' },
        take: months,
      }),
    );
  }

  /** D-250: subscriptions (trial, unit counting, invoices, suspension) run only while the platform setting is on. */
  async enabled(now: Date = this.clock.now()): Promise<boolean> {
    return (await this.settings.valueAt<boolean>('platform.subscriptions.enabled', now)) === true;
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  /**
   * The hourly `platform-subscriptions` job (exactly once across replicas). Each subscription is handled in its own
   * transaction under a row lock; a failure is logged and retried on the next run. Returns the changes made.
   */
  async sweep(): Promise<{ invoices: number; transitions: number }> {
    const now = this.clock.now();
    // D-250: free for operators — the lifecycle runs only while subscriptions are switched on.
    if (!(await this.enabled(now))) return { invoices: 0, transitions: 0 };
    const ids = await this.db.platform((tx) =>
      tx.subscription.findMany({
        where: { state: { in: [...OPEN_SUBSCRIPTION_STATES] } },
        select: { id: true },
        orderBy: { startedAt: 'asc' },
      }),
    );
    let invoices = 0;
    let transitions = 0;
    for (const { id } of ids) {
      try {
        const r = await this.db.platform((tx) => this.step(tx, id, now));
        invoices += r.invoices;
        transitions += r.transitions;
      } catch (error) {
        this.logger.error(`subscription ${id}: lifecycle step failed: ${(error as Error).message}`);
      }
    }
    if (transitions) await this.billing.refreshAccess();
    return { invoices, transitions };
  }

  private async step(tx: Tx, id: string, now: Date): Promise<{ invoices: number; transitions: number }> {
    await tx.$queryRaw`SELECT id FROM platform.subscription WHERE id = ${id}::uuid FOR UPDATE`;
    let sub = await tx.subscription.findUniqueOrThrow({ where: { id } });
    if (!(OPEN_SUBSCRIPTION_STATES as readonly string[]).includes(sub.state))
      return { invoices: 0, transitions: 0 };
    let invoices = 0;
    let transitions = 0;
    const today = bangkokDate(now);

    // 1. trial over → first invoice for the rest of the month (pro-rata); nothing due → active at once
    if (sub.trialEndsAt.getTime() <= now.getTime()) {
      const start = bangkokDate(sub.trialEndsAt);
      const first = await tx.platformInvoice.findFirst({ where: { subscriptionId: id, kind: 'first' } });
      const firstUsage = await tx.subscriptionUsage.findUnique({
        where: {
          subscriptionId_month: { subscriptionId: id, month: new Date(`${monthOf(start)}T00:00:00Z`) },
        },
      });
      if (!first && !firstUsage) {
        const usage = await this.countUsage(tx, sub.tenantId, monthOf(start));
        const dim = daysInMonth(start);
        const days = dim - Number(start.slice(8, 10)) + 1;
        const priced = await this.charges(
          tx,
          sub,
          usage,
          start,
          days === dim ? undefined : { days, daysInMonth: dim },
        );
        const snapshot = await this.snapshotUsage(tx, sub, monthOf(start), usage, priced);
        if (new Decimal(priced.charges.total).gt(0)) {
          await this.billing.issue(tx, sub, {
            kind: 'first',
            periodStart: start,
            periodEnd: lastDayOfMonth(start),
            charges: priced.charges,
            usageId: snapshot.id,
            snapshot: this.invoiceSnapshot(sub, priced, usage),
          });
          invoices += 1;
        } else if (sub.state === 'trial') {
          sub = await this.billing.transition(tx, sub, 'active', { activatedAt: now }, 'nothing_due');
          transitions += 1;
        }
      }
    }

    // 2. the 1st of a month after the trial → usage snapshot + the month's invoice
    const month = monthOf(today);
    if (sub.trialEndsAt.getTime() <= startOfBangkokDay(month).getTime()) {
      const done = await tx.subscriptionUsage.findUnique({
        where: { subscriptionId_month: { subscriptionId: id, month: new Date(`${month}T00:00:00Z`) } },
      });
      if (!done && !(sub.cancelEffectiveDate && dateOnly(sub.cancelEffectiveDate) < month)) {
        const usage = await this.countUsage(tx, sub.tenantId, month);
        const priced = await this.charges(tx, sub, usage, month);
        const snapshot = await this.snapshotUsage(tx, sub, month, usage, priced);
        if (new Decimal(priced.charges.total).gt(0)) {
          await this.billing.issue(tx, sub, {
            kind: 'monthly',
            periodStart: month,
            periodEnd: lastDayOfMonth(month),
            charges: priced.charges,
            usageId: snapshot.id,
            snapshot: this.invoiceSnapshot(sub, priced, usage),
          });
          invoices += 1;
        } else if (sub.state === 'trial') {
          sub = await this.billing.transition(tx, sub, 'active', { activatedAt: now }, 'nothing_due');
          transitions += 1;
        }
      }
    }

    // 3. unpaid after due + grace → invoice overdue, subscription past_due
    const grace = await this.settings.valueAt<number>('subscription.grace_days', now);
    const late = await tx.platformInvoice.findMany({
      where: {
        subscriptionId: id,
        state: { in: ['issued', 'partially_paid'] },
        dueAt: { lt: new Date(now.getTime() - grace * 86_400_000) },
      },
    });
    for (const inv of late) {
      await tx.platformInvoice.update({
        where: { id: inv.id },
        data: { state: 'overdue', overdueSince: now, version: { increment: 1 } },
      });
      await this.events.record(tx, {
        type: 'platform_invoice.overdue',
        aggregateType: 'platform_invoice',
        aggregateId: inv.id,
        tenantId: sub.tenantId,
        payload: { platformInvoiceId: inv.id, number: inv.number, subscriptionId: id },
      });
    }
    const overdue = await tx.platformInvoice.findFirst({
      where: { subscriptionId: id, state: 'overdue' },
      orderBy: { overdueSince: 'asc' },
    });
    if (overdue && (sub.state === 'trial' || sub.state === 'active')) {
      sub = await this.billing.transition(
        tx,
        sub,
        'past_due',
        { pastDueSince: overdue.overdueSince ?? now },
        'invoice_overdue',
      );
      transitions += 1;
    }

    // 4. past_due for `subscription.suspend_after_days` → suspended (read-only, D-082)
    const suspendAfter = await this.settings.valueAt<number>('subscription.suspend_after_days', now);
    if (
      sub.state === 'past_due' &&
      sub.pastDueSince &&
      sub.pastDueSince.getTime() + suspendAfter * 86_400_000 <= now.getTime()
    ) {
      sub = await this.billing.transition(tx, sub, 'suspended', { suspendedAt: now }, 'past_due_too_long');
      transitions += 1;
    }

    // 5. cancellation effective → cancelled, read-only, de-install order for platform hardware (D-081)
    if (sub.cancelEffectiveDate && dateOnly(sub.cancelEffectiveDate) < today) {
      const deinstall = await this.deinstallOrder(tx, sub);
      await this.billing.transition(
        tx,
        sub,
        'cancelled',
        { cancelledAt: now, ...(deinstall ? { deinstallOrder: { connect: { id: deinstall } } } : {}) },
        sub.cancelReason ?? 'cancelled',
      );
      transitions += 1;
    }
    return { invoices, transitions };
  }

  private invoiceSnapshot(
    sub: Subscription,
    priced: { plan: VersionWithPlan; addons: VersionWithPlan[] },
    usage: UsageCounts,
  ): Record<string, unknown> {
    const v = (x: VersionWithPlan) => ({
      plan: x.plan.key,
      versionId: x.id,
      version: x.version,
      billingUnit: x.billingUnit,
      unitPrice: x.unitPrice?.toString() ?? null,
      minUnits: x.minUnits,
      vatRate: x.vatRate.toString(),
      terms: x.terms,
    });
    return {
      subscriptionId: sub.id,
      plan: v(priced.plan),
      addons: priced.addons.map(v),
      usage,
      discountPct: sub.discountPct.toString(),
      discountReason: sub.discountReason,
      pilotAgreementId: sub.pilotAgreementId,
      decision: 'D-156',
    };
  }

  private snapshotUsage(
    tx: Tx,
    sub: Subscription,
    month: string,
    usage: UsageCounts & { unitsByBuilding: Record<string, number> },
    priced: { plan: VersionWithPlan; charges: { total: string; lines: unknown[] } },
  ) {
    return tx.subscriptionUsage.create({
      data: {
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        month: new Date(`${month}T00:00:00Z`),
        unitsCounted: usage.units,
        meterPointsCounted: usage.meterPoints,
        ocrImages: usage.ocrImages,
        unitsByBuilding: usage.unitsByBuilding,
        planVersionId: priced.plan.id,
        amountComputed: priced.charges.total,
        lines: priced.charges.lines as Prisma.InputJsonValue,
        snapshotAt: this.clock.now(),
      },
    });
  }

  /** One de-install order per building with live platform hardware of the tenant (D-081); null when there is none. */
  private async deinstallOrder(tx: Tx, sub: Subscription): Promise<string | null> {
    const assets = await tx.haasAsset.findMany({
      where: { tenantId: sub.tenantId, state: { in: ['allocated', 'installed', 'in_service'] } },
      include: { device: { select: { id: true, assetItemId: true, kind: true } } },
    });
    let first: string | null = null;
    const byBuilding = new Map<string, typeof assets>();
    for (const a of assets) {
      if (!a.buildingId) continue;
      byBuilding.set(a.buildingId, [...(byBuilding.get(a.buildingId) ?? []), a]);
    }
    for (const [buildingId, list] of byBuilding) {
      const order = await tx.installOrder.create({
        data: {
          tenantId: sub.tenantId,
          buildingId,
          kind: 'deinstall',
          subscriptionId: sub.id,
          items: list.map((a) => ({
            unitId: null,
            assetItemId: a.device.assetItemId,
            deviceKind: a.kind,
            deviceId: a.deviceId,
            haasAssetId: a.id,
            done: false,
          })),
          notes: 'ยกเลิกบริการ: ถอดอุปกรณ์ของแพลตฟอร์ม (D-081)',
          createdBy: by(),
        },
      });
      await tx.haasAsset.updateMany({
        where: { id: { in: list.map((a) => a.id) } },
        data: { deinstallOrderId: order.id },
      });
      await this.events.record(tx, {
        type: 'install_order.created',
        aggregateType: 'install_order',
        aggregateId: order.id,
        tenantId: sub.tenantId,
        buildingId,
        payload: { installOrderId: order.id, kind: 'deinstall', subscriptionId: sub.id },
      });
      first ??= order.id;
    }
    return first;
  }
}

export { lastDayOfMonth, monthOf, nextMonth };

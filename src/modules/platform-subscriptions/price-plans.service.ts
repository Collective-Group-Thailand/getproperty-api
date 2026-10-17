import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { TenantTx } from '@database/tenant-tx';
import { type PlanBillingUnit, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

export const PLAN_INCLUDE = {
  versions: { orderBy: { version: 'desc' } },
} as const satisfies Prisma.PricePlanInclude;
export type PlanRow = Prisma.PricePlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

export interface PlanVersionInput {
  effectiveFrom: string;
  billingUnit: PlanBillingUnit;
  unitPrice?: string | null;
  priceRange?: { from: string; to: string } | null;
  tiers?: unknown[];
  minUnits?: number | null;
  minMonthly?: string | null;
  annualDiscountPct?: string;
  termMonths?: number | null;
  setupFee?: string;
  includedAllowances?: Record<string, unknown>;
  vatRate?: string;
  terms?: Record<string, unknown>;
}

const by = () => userIdOf(RequestContext.actor());

/**
 * Price plans and their effective-dated versions (D-156; ADR-0004): the platform admin / Finance adds a draft version
 * and publishes it from a date that is not in the past; publishing closes the version in force the day before
 * (published versions never overlap — exclusion constraint — and are never edited — trigger). Subscriptions price
 * every period at the version in force then; invoices snapshot what they used.
 */
@Injectable()
export class PricePlansService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list() {
    return this.db.platform((tx) =>
      tx.pricePlan.findMany({ include: PLAN_INCLUDE, orderBy: { key: 'asc' } }),
    );
  }

  /** Every plan with its newest published (else newest) version — the public pricing page (D-156, D-180). */
  async catalogue() {
    const plans = await this.list();
    return plans
      .map((p) => ({
        plan: p,
        version: p.versions.find((v) => v.state === 'published') ?? p.versions[0] ?? null,
      }))
      .filter((x) => x.version !== null);
  }

  addVersion(planId: string, input: PlanVersionInput) {
    return this.db.platform(async (tx) => {
      const plan = await tx.pricePlan.findUnique({ where: { id: planId }, include: PLAN_INCLUDE });
      if (!plan) throw new DomainException('http.not_found');
      const version = (plan.versions[0]?.version ?? 0) + 1;
      const row = await tx.pricePlanVersion.create({
        data: {
          planId,
          version,
          effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
          billingUnit: input.billingUnit,
          unitPrice: input.unitPrice ?? null,
          priceRange: input.priceRange ?? undefined,
          tiers: (input.tiers ?? []) as Prisma.InputJsonValue,
          minUnits: input.minUnits ?? null,
          minMonthly: input.minMonthly ?? null,
          annualDiscountPct: input.annualDiscountPct ?? '15',
          termMonths: input.termMonths ?? null,
          setupFee: input.setupFee ?? '0',
          includedAllowances: (input.includedAllowances ?? {}) as Prisma.InputJsonValue,
          vatRate: input.vatRate ?? '0.07',
          terms: (input.terms ?? { status: 'proposed', decision: 'D-156' }) as Prisma.InputJsonValue,
          state: 'draft',
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'price_plan.version_created',
        subjectType: 'platform.price_plan_version',
        subjectId: row.id,
        after: { plan: plan.key, version, effectiveFrom: input.effectiveFrom },
      });
      return row;
    });
  }

  publish(versionId: string) {
    const today = bangkokDate(this.clock.now());
    return this.db.platform(async (tx) => {
      const v = await tx.pricePlanVersion.findUnique({ where: { id: versionId }, include: { plan: true } });
      if (!v) throw new DomainException('http.not_found');
      if (v.state !== 'draft')
        throw new DomainException('price_plan.invalid_state', { params: { state: v.state } });
      const from = v.effectiveFrom.toISOString().slice(0, 10);
      if (from < today) throw new DomainException('settings.backdated');
      const current = await tx.pricePlanVersion.findFirst({
        where: { planId: v.planId, state: 'published', effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (current) {
        if (current.effectiveFrom.toISOString().slice(0, 10) >= from)
          throw new DomainException('price_plan.invalid_state', { params: { state: 'overlaps' } });
        await tx.pricePlanVersion.update({
          where: { id: current.id },
          data: { effectiveTo: new Date(`${addCalendarDays(from, 0)}T00:00:00Z`), updatedBy: by() },
        });
      }
      const published = await tx.pricePlanVersion.update({
        where: { id: versionId },
        data: { state: 'published', publishedAt: this.clock.now(), publishedBy: by(), updatedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'price_plan.version_published',
        subjectType: 'platform.price_plan_version',
        subjectId: versionId,
        after: { plan: v.plan.key, version: v.version, effectiveFrom: from, closes: current?.id ?? null },
      });
      await this.events.record(tx, {
        type: 'price_plan.published',
        aggregateType: 'price_plan',
        aggregateId: v.planId,
        tenantId: null,
        payload: { planKey: v.plan.key, versionId, effectiveFrom: from },
      });
      return published;
    });
  }
}

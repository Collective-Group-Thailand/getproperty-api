import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ComplianceGate, type RuleCheck } from '@core/compliance/compliance-gate.service';
import { evaluateTariffCap, evaluateWaterMinimum } from '@core/compliance/evaluators';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Prisma, type RateBasis, type RatePlanKind } from '@generated/prisma/client';
import { operatedBuilding } from '@modules/ops-units/building-access';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { BillingInputs } from './billing-inputs';
import { capFor } from './engine/invoice-draft';
import { chargeFor, type RateTiers, validateRateVersion } from './engine/rate-tiers';

const by = () => userIdOf(RequestContext.actor());

export const RATE_PLAN_INCLUDE = {
  versions: { orderBy: { effectiveFrom: 'desc' } },
} as const satisfies Prisma.RatePlanInclude;
export type RatePlanRow = Prisma.RatePlanGetPayload<{ include: typeof RATE_PLAN_INCLUDE }>;

export interface VersionInput {
  effectiveFrom?: string;
  tiers: unknown;
  basis: RateBasis;
  minimumCharge?: string | null;
  note?: string | null;
}

const UTILITY: Partial<Record<RatePlanKind, 'electric' | 'water'>> = { power: 'electric', water: 'water' };

/**
 * Rate plans (B4.2, D-021a, D-141, D-151): tenant-set tariffs per building (or tenant-wide) and kind, versioned by
 * effective date. A version is never backdated (`rate_plan.backdated`); a future version may be edited until it takes
 * effect; a version in force is immutable. Saving a power/water version compares its price at the representative
 * consumption (`compliance.tariff_cap.representative_units`) with the utility's effective average rate in force at
 * its effective date (D-140): above → `compliance.tariff_cap` (warn → the Owner acknowledges and repeats the request
 * with the acknowledgement id; `block` where the platform admin set it), stored as `cap_check` + `above_cap` + the
 * acknowledgement. A water minimum is checked against the utility's own minimum (`compliance.water_minimum`, D-141).
 */
@Injectable()
export class RatePlansService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly gate: ComplianceGate,
    private readonly settings: SettingsService,
    private readonly inputs: BillingInputs,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<RatePlanRow> {
    const plan = this.found(
      await tx.ratePlan.findFirst({
        where: this.own(ctx, { id, deletedAt: null }),
        include: RATE_PLAN_INCLUDE,
      }),
    );
    if (plan.buildingId && ctx.buildingIds && !ctx.buildingIds.includes(plan.buildingId))
      throw new DomainException('http.not_found');
    return plan;
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  list(ctx: TenantContext, q: { kind?: RatePlanKind; buildingId?: string }) {
    const where: Prisma.RatePlanWhereInput = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.buildingId ? { OR: [{ buildingId: q.buildingId }, { buildingId: null }] } : {}),
    };
    return this.db.tenant(ctx, (tx) =>
      tx.ratePlan.findMany({
        where,
        include: RATE_PLAN_INCLUDE,
        orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  private async event(
    tx: Tx,
    plan: { id: string; tenantId: string; buildingId: string | null },
    change: string,
  ) {
    await this.events.record(tx, {
      type: 'rate_plan.changed',
      aggregateType: 'rate_plan',
      aggregateId: plan.id,
      tenantId: plan.tenantId,
      buildingId: plan.buildingId,
      payload: { ratePlanId: plan.id, change },
    });
  }

  async create(
    ctx: TenantContext,
    input: { buildingId?: string | null; kind: RatePlanKind; name: string; isDefault: boolean },
  ): Promise<RatePlanRow> {
    return this.db.tenant(ctx, async (tx) => {
      if (input.buildingId) await operatedBuilding(tx, ctx, input.buildingId);
      if (input.isDefault)
        await tx.ratePlan.updateMany({
          where: this.own(ctx, {
            buildingId: input.buildingId ?? null,
            kind: input.kind,
            isDefault: true,
            deletedAt: null,
          }),
          data: { isDefault: false, updatedBy: by(), version: { increment: 1 } },
        });
      const plan = await tx.ratePlan.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: input.buildingId ?? null,
          kind: input.kind,
          name: input.name,
          isDefault: input.isDefault,
          createdBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'rate_plan.changed',
        tenantId: ctx.tenantId,
        buildingId: plan.buildingId,
        subjectType: 'ops.rate_plan',
        subjectId: plan.id,
        after: { kind: plan.kind, name: plan.name, isDefault: plan.isDefault },
      });
      await this.event(tx, plan, 'created');
      return this.load(tx, ctx, plan.id);
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    version: number,
    patch: { name?: string; isDefault?: boolean },
  ): Promise<RatePlanRow> {
    return this.db.tenant(ctx, async (tx) => {
      const plan = await this.load(tx, ctx, id);
      if (plan.version !== version) throw new DomainException('concurrency.stale');
      if (plan.buildingId) await operatedBuilding(tx, ctx, plan.buildingId);
      if (patch.isDefault)
        await tx.ratePlan.updateMany({
          where: this.own(ctx, {
            id: { not: id },
            buildingId: plan.buildingId,
            kind: plan.kind,
            isDefault: true,
            deletedAt: null,
          }),
          data: { isDefault: false, updatedBy: by(), version: { increment: 1 } },
        });
      await tx.ratePlan.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'rate_plan.changed',
        tenantId: ctx.tenantId,
        buildingId: plan.buildingId,
        subjectType: 'ops.rate_plan',
        subjectId: id,
        before: { name: plan.name, isDefault: plan.isDefault },
        after: patch,
      });
      await this.event(tx, plan, 'updated');
      return this.load(tx, ctx, id);
    });
  }

  /** Soft delete; refused while a lease names the plan (409 `rate_plan.in_use`). */
  async remove(ctx: TenantContext, id: string): Promise<void> {
    await this.db.tenant(ctx, async (tx) => {
      const plan = await this.load(tx, ctx, id);
      if (plan.buildingId) await operatedBuilding(tx, ctx, plan.buildingId);
      const leases = await tx.lease.count({
        where: {
          OR: [{ powerRatePlanId: id }, { waterRatePlanId: id }],
          status: { in: ['draft', 'pending_signature', 'active', 'notice_given', 'ending'] },
        },
      });
      if (leases) throw new DomainException('rate_plan.in_use', { params: { leases } });
      await tx.ratePlan.update({
        where: { id },
        data: { deletedAt: this.clock.now(), deletedBy: by(), isDefault: false, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'rate_plan.changed',
        tenantId: ctx.tenantId,
        buildingId: plan.buildingId,
        subjectType: 'ops.rate_plan',
        subjectId: id,
        after: { deleted: true },
      });
      await this.event(tx, plan, 'deleted');
    });
  }

  /** The compliance checks of a power/water version (pure values gathered here, evaluated by the registry). */
  private async checks(
    tx: Tx,
    ctx: TenantContext,
    plan: RatePlanRow,
    input: { effectiveFrom: string; tiers: RateTiers; basis: RateBasis; minimumCharge: string | null },
  ): Promise<{ checks: RuleCheck[]; capCheck: Prisma.InputJsonValue | null; aboveCap: boolean }> {
    const utility = UTILITY[plan.kind];
    if (!utility) return { checks: [], capCheck: null, aboveCap: false };
    const representative = await this.settings.valueAt<{ electric: string; water: string }>(
      'compliance.tariff_cap.representative_units',
      this.clock.now(),
    );
    const units = representative[utility];
    const candidates = await this.inputs.capCandidates(
      tx,
      ctx.tenantId,
      plan.buildingId,
      utility,
      input.effectiveFrom,
    );
    const checks: RuleCheck[] = [];
    const charge = chargeFor({ tiers: input.tiers, basis: input.basis, minimumCharge: null }, { units });
    const cap = capFor(candidates, units);
    let capCheck: Prisma.InputJsonValue | null;
    let aboveCap = false;
    if (cap) {
      const best = candidates.find((c) => c.id === cap.utilityTariffVersionId)!;
      const check = evaluateTariffCap({
        tenantRate: charge.unitPrice,
        units,
        tariff: {
          id: best.id,
          utility,
          provider: best.provider,
          tariffCode: best.tariffCode,
          effectiveFrom: best.effectiveFrom,
          structure: best.structure,
        },
      });
      aboveCap = check.violated;
      capCheck = {
        utilityTariffVersionId: cap.utilityTariffVersionId,
        provider: cap.provider,
        tariffCode: cap.tariffCode,
        representativeUnits: new Decimal(units).toFixed(3),
        effectiveAverageRate: cap.capPerUnit,
        tenantRate: charge.unitPrice,
        aboveCap,
      };
      checks.push({ ...check, shown: { ...check.shown, effectiveFromOfRate: input.effectiveFrom } });
    } else {
      capCheck = { status: 'no_reference', representativeUnits: new Decimal(units).toFixed(3) };
    }
    if (utility === 'water' && input.minimumCharge && new Decimal(input.minimumCharge).gt(0)) {
      const utilityMinimum =
        candidates
          .map((c) => c.structure.minimumCharge?.amount ?? null)
          .filter((x): x is string => x !== null)
          .sort((a, b) => new Decimal(a).comparedTo(b))[0] ?? null;
      checks.push(evaluateWaterMinimum({ minimumCharge: input.minimumCharge, utilityMinimum }));
    }
    return { checks, capCheck, aboveCap };
  }

  /**
   * Adds a version (or edits a future one with the same effective date). 409 `compliance.acknowledgement_required`
   * when the rate is above the utility rate (D-021a); the repeated request carries the acknowledgement id, which must
   * show the same rate and effective date.
   */
  async saveVersion(
    ctx: TenantContext,
    planId: string,
    input: VersionInput,
    acknowledgementIds: string[] = [],
  ): Promise<RatePlanRow> {
    const today = bangkokDate(this.clock.now());
    const effectiveFrom = input.effectiveFrom ?? today;
    if (effectiveFrom < today) throw new DomainException('rate_plan.backdated');
    const plan = await this.db.tenant(ctx, async (tx) => {
      const p = await this.load(tx, ctx, planId);
      if (p.buildingId) await operatedBuilding(tx, ctx, p.buildingId);
      return p;
    });
    const minimumCharge = input.minimumCharge ?? null;
    const problems = validateRateVersion(plan.kind, input.basis, input.tiers, minimumCharge);
    if (problems.length)
      throw new DomainException('validation.failed', {
        errors: problems.map((p) => ({ path: p.path, code: 'rateTiers', message: p.message })),
      });
    const tiers = input.tiers as RateTiers;
    const existing = plan.versions.find((v) => v.effectiveFrom.toISOString().slice(0, 10) === effectiveFrom);
    if (existing && effectiveFrom <= today) throw new DomainException('rate_plan.version_in_force');
    const evaluation = await this.db.tenant(ctx, (tx) =>
      this.checks(tx, ctx, plan, { effectiveFrom, tiers, basis: input.basis, minimumCharge }),
    );
    const gate = await this.gate.enforce(ctx, {
      subjectType: 'ops.rate_plan',
      subjectId: plan.id,
      buildingId: plan.buildingId,
      checks: evaluation.checks,
      acknowledgementIds,
    });
    const capAck = gate.checks.find((c) => c.ruleId === 'compliance.tariff_cap')?.acknowledgementId ?? null;
    return this.db.tenant(ctx, async (tx) => {
      if (capAck) {
        const ack = await tx.complianceAcknowledgement.findUniqueOrThrow({ where: { id: capAck } });
        const shown = ack.shown as { tenantRate?: string; effectiveFromOfRate?: string };
        const now = evaluation.checks.find((c) => c.ruleId === 'compliance.tariff_cap')?.shown as
          { tenantRate?: string } | undefined;
        if (shown.tenantRate !== now?.tenantRate || shown.effectiveFromOfRate !== effectiveFrom)
          throw new DomainException('compliance.acknowledgement_required', {
            // the acknowledgement showed another rate or date: re-evaluate and acknowledge what is saved now
            extensions: {
              ruleId: 'compliance.tariff_cap',
              shown: { tenantRate: now?.tenantRate, effectiveFromOfRate: effectiveFrom },
            },
          });
      }
      const data = {
        tiers: tiers as unknown as Prisma.InputJsonValue,
        basis: input.basis,
        minimumCharge,
        capCheck: evaluation.capCheck ?? undefined,
        aboveCap: evaluation.aboveCap,
        complianceAcknowledgementId: evaluation.aboveCap ? capAck : null,
        note: input.note ?? null,
      };
      const version = existing
        ? await tx.ratePlanVersion.update({ where: { id: existing.id }, data: { ...data, updatedBy: by() } })
        : await tx.ratePlanVersion.create({
            data: {
              ...data,
              tenantId: ctx.tenantId,
              ratePlanId: plan.id,
              effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`),
              createdBy: by(),
            },
          });
      await tx.ratePlan.update({
        where: { id: plan.id },
        data: { version: { increment: 1 }, updatedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'rate_plan.version_saved',
        tenantId: ctx.tenantId,
        buildingId: plan.buildingId,
        subjectType: 'ops.rate_plan_version',
        subjectId: version.id,
        after: {
          effectiveFrom,
          basis: input.basis,
          tiers: tiers as unknown as Prisma.InputJsonValue,
          aboveCap: evaluation.aboveCap,
          acknowledgementId: capAck,
          replaced: Boolean(existing),
        },
      });
      await this.event(tx, plan, existing ? 'version_updated' : 'version_added');
      return this.load(tx, ctx, plan.id);
    });
  }
}

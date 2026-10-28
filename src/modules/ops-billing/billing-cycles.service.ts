import { Semaphore } from '@common/concurrency/semaphore';
import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ComplianceGate } from '@core/compliance/compliance-gate.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type BillingCycle,
  type BillingCycleStatus,
  type EstimatePolicy,
  type Lease,
  type Prisma,
  type RatePlanKind,
} from '@generated/prisma/client';
import { InspectionsService } from '@modules/ops-deposits/inspections.service';
import { LeasesService } from '@modules/ops-leases/leases.service';
import { type CutoffSetting, periodBounds, periodOf } from '@modules/smart-readings/cutoff';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { BillingInputs, toVersionLike } from './billing-inputs';
import { segmentReadingOf } from './billing-inputs';
import {
  computeInvoiceDraft,
  type DraftInput,
  type DraftResult,
  type MeterInput,
  type UnitRatePlanInput,
} from './engine/invoice-draft';
import { addDays, maxDate, minDate } from './engine/periods';
import { estimateRegister, type MeterSegment, segmentUnits } from './engine/readings';
import {
  type DraftTarget,
  INVOICE_INCLUDE,
  InvoicesService,
  ISSUE_SLOTS,
  ISSUE_TX,
} from './invoices.service';

const by = () => userIdOf(RequestContext.actor());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const UTILITIES = ['electric', 'water'] as const;
const PLAN_KIND: Record<(typeof UTILITIES)[number], RatePlanKind> = { electric: 'power', water: 'water' };
const LIVE: Lease['status'][] = ['active', 'notice_given', 'ending', 'ended', 'terminated'];

export const CYCLE_INCLUDE = {
  property: { select: { id: true, name: true, code: true } },
  invoices: {
    include: INVOICE_INCLUDE,
    orderBy: [{ unit: { unitNo: 'asc' } }, { createdAt: 'asc' }],
  },
} as const satisfies Prisma.BillingCycleInclude;
export type CycleRow = Prisma.BillingCycleGetPayload<{ include: typeof CYCLE_INCLUDE }>;

interface Billable {
  kind: 'lease' | 'ownership';
  unitId: string;
  buildingId: string;
  partyId: string;
  lease:
    | (Lease & {
        lines: {
          id: string;
          kind: string;
          description: string;
          amount: Decimal;
          recurrence: 'monthly' | 'once';
          effectiveFrom: Date;
          effectiveTo: Date | null;
        }[];
      })
    | null;
}

/** What the owner may do next with a cycle (UI next actions). */
export function cycleNextActions(c: Pick<BillingCycle, 'status'>): string[] {
  switch (c.status) {
    case 'open':
      return ['compute', 'issue'];
    case 'readings_pending':
      // web F2 (D-208): ask staff for the readings still missing, per meter or all at once
      return ['compute', 'issue', 'request-readings'];
    case 'computed':
      return ['compute', 'issue'];
    case 'issued':
      return ['close'];
    default:
      return [];
  }
}

/**
 * Billing cycles (B4.2, D-011, D-031, D-041): one per property and period (cut-off from `billing.cutoff`). At the
 * cut-off the worker opens/computes the cycle — for each billed party × unit (apartment leases; condo unit owners
 * with common-fee / fund plans) a draft invoice from the engine: rent pro-rata, lease lines, meter lines from the
 * readings that close the period (highest confidence inside the window; staff readings until the grace deadline;
 * then an estimate where `billing.estimate_policy` allows it), the rate plan version in force (the agreed one when a
 * later version charges more — compliance.no_midterm_increase), the utility cap, queued one-offs, estimate
 * settlements. Missing readings keep the cycle `readings_pending` (staff are asked for the round). The owner reviews
 * the per-unit table, recomputes, and issues (idempotent) — or the cycle issues itself after `billing.auto_issue`.
 * Lease end: a final invoice draft to the move-out (advance rent applied), refreshed when the move-out inspection
 * records the registers, linked to the deposit settlement when issued.
 */
/** Drafts computed at once by a cycle (each holds a pooled connection while it reads its inputs). */
const COMPUTE_CONCURRENCY = 4;

@Injectable()
export class BillingCyclesService extends TenantScopedRepository implements OnModuleInit {
  private readonly logger = new Logger(BillingCyclesService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly settings: SettingsService,
    private readonly gate: ComplianceGate,
    private readonly inputs: BillingInputs,
    private readonly invoices: InvoicesService,
    private readonly leases: LeasesService,
    private readonly inspections: InspectionsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    // the final draft never blocks the end of a lease: a failure rolls back to a savepoint and is logged; the owner
    // recomputes it later (`POST /v1/owner/invoices/{id}/actions/recompute` or the next cycle)
    this.leases.onEnded((tx, lease, moveOutAt) =>
      this.guarded(tx, 'final_draft', () => this.finalDraft(tx, lease.id, moveOutAt), lease.id),
    );
    this.inspections.onCompleted(async (tx, inspection) => {
      const leaseId = inspection.leaseId;
      if (inspection.type === 'move_out' && leaseId)
        await this.guarded(tx, 'final_refresh', () => this.refreshFinal(tx, leaseId), leaseId);
    });
    this.invoices.onIssued((tx, invoice) => this.linkSettlement(tx, invoice));
  }

  private async guarded(tx: Tx, name: string, work: () => Promise<void>, subject: string): Promise<void> {
    await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
    try {
      await work();
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    } catch (error) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
      this.logger.error(`${name} of ${subject} failed: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------------------------------------------- periods

  private async cutoffSetting(tenantId: string, propertyId: string, at: Date): Promise<CutoffSetting> {
    return this.settings.valueAt<CutoffSetting>('billing.cutoff', at, { tenantId, propertyId });
  }

  /** The Bangkok dates of a period key and its instants. */
  async periodOfKey(tenantId: string, propertyId: string, key: string) {
    const setting = await this.cutoffSetting(tenantId, propertyId, this.clock.now());
    const b = periodBounds(setting, key);
    return {
      key,
      startInstant: b.start,
      cutOffAt: b.end,
      start: bangkokDate(new Date(b.start.getTime() + 59_999)),
      end: bangkokDate(b.end),
    };
  }

  /** Creates the cycle of a property and period when missing (D-031 settings resolved at the cut-off). */
  async ensureCycle(tx: Tx, tenantId: string, propertyId: string, key: string): Promise<BillingCycle> {
    const existing = await tx.billingCycle.findFirst({ where: { propertyId, periodKey: key } });
    if (existing) return existing;
    const p = await this.periodOfKey(tenantId, propertyId, key);
    const scope = { tenantId, propertyId };
    const windowMinutes = await this.settings.valueAt<number>(
      'readings.iot_window_minutes',
      p.cutOffAt,
      scope,
    );
    const graceHours = await this.settings.valueAt<number>('billing.reading_grace_hours', p.cutOffAt, scope);
    const policy = await this.settings.valueAt<EstimatePolicy>('billing.estimate_policy', p.cutOffAt, scope);
    const cycle = await tx.billingCycle.create({
      data: {
        tenantId,
        propertyId,
        periodKey: key,
        periodStart: asDate(p.start),
        periodEnd: asDate(p.end),
        cutOffAt: p.cutOffAt,
        readingsWindowMinutes: windowMinutes,
        graceDeadlineAt: new Date(p.cutOffAt.getTime() + graceHours * 3_600_000),
        estimatePolicy: policy,
        createdBy: by(),
      },
    });
    await this.events.record(tx, {
      type: 'billing_cycle.opened',
      aggregateType: 'billing_cycle',
      aggregateId: cycle.id,
      tenantId,
      payload: { billingCycleId: cycle.id, propertyId, periodKey: key, cutOffAt: p.cutOffAt.toISOString() },
    });
    return cycle;
  }

  // ------------------------------------------------------------------------------------------- reads

  private async loadCycle(tx: Tx, ctx: TenantContext, id: string): Promise<CycleRow> {
    return this.found(
      await tx.billingCycle.findFirst({ where: this.own(ctx, { id }), include: CYCLE_INCLUDE }),
    );
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.loadCycle(tx, ctx, id));
  }

  list(
    ctx: TenantContext,
    q: { propertyId?: string; status?: BillingCycleStatus; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.BillingCycleWhereInput = this.own(ctx, {
        ...(q.propertyId ? { propertyId: q.propertyId } : {}),
        ...(q.status ? { status: q.status } : {}),
      });
      const [rows, total] = await Promise.all([
        tx.billingCycle.findMany({
          where,
          include: { property: { select: { id: true, name: true, code: true } } },
          orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.billingCycle.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** `POST /v1/owner/billing-cycles`: opens (or returns) the cycle of a property for a period (default: current). */
  async open(ctx: TenantContext, input: { propertyId: string; periodKey?: string }): Promise<CycleRow> {
    const id = await this.db.tenant(ctx, async (tx) => {
      const property = this.found(
        await tx.property.findFirst({ where: this.own(ctx, { id: input.propertyId, deletedAt: null }) }),
      );
      const key =
        input.periodKey ??
        periodOf(await this.cutoffSetting(ctx.tenantId, property.id, this.clock.now()), this.clock.now()).key;
      return (await this.ensureCycle(tx, ctx.tenantId, property.id, key)).id;
    });
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------- compute

  private async billables(tx: Tx, tenantId: string, cycle: BillingCycle): Promise<Billable[]> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { type: true } });
    const buildings = await tx.building.findMany({
      where: {
        propertyId: cycle.propertyId,
        deletedAt: null,
        OR: [{ operatorTenantId: tenantId }, { ownerTenantId: tenantId }],
      },
      select: { id: true },
    });
    const buildingIds = buildings.map((b) => b.id);
    const out: Billable[] = [];
    const leases = await tx.lease.findMany({
      where: {
        tenantId,
        buildingId: { in: buildingIds },
        status: { in: LIVE },
        activatedAt: { not: null },
        startDate: { lte: cycle.periodEnd },
        endDate: { gte: cycle.periodStart },
      },
      include: { lines: true },
      orderBy: { startDate: 'asc' },
    });
    for (const l of leases) {
      // a lease that ended before the cut-off is billed by its final invoice (D-177)
      const endedAt = l.endedAt ?? l.terminatedAt;
      if (endedAt && endedAt.getTime() <= cycle.cutOffAt.getTime()) continue;
      out.push({
        kind: 'lease',
        unitId: l.unitId,
        buildingId: l.buildingId,
        // G8 (D-299): an employer agreement addresses the lease's invoices to the payer
        partyId: l.payerPartyId ?? l.lesseePartyId,
        lease: l,
      });
    }
    if (tenant.type === 'condo_juristic') {
      const owners = await tx.unitOwnership.findMany({
        where: {
          buildingId: { in: buildingIds },
          validFrom: { lte: cycle.periodEnd },
          OR: [{ validTo: null }, { validTo: { gte: cycle.periodStart } }],
        },
      });
      const seen = new Set<string>();
      for (const o of owners) {
        const key = `${o.unitId}|${o.partyId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          kind: 'ownership',
          unitId: o.unitId,
          buildingId: o.buildingId,
          partyId: o.partyId,
          lease: null,
        });
      }
    }
    return out;
  }

  private async meterInputs(
    tx: Tx,
    b: { tenantId: string; buildingId: string; unitId: string; lease: Billable['lease'] },
    window: { start: Date; end: Date; graceUntil: Date; windowMinutes: number; periodEnd: string },
    policy: EstimatePolicy,
    preferFinal: boolean,
    cycleId: string | null,
  ): Promise<{ meters: MeterInput[]; settlements: DraftInput['estimateSettlements']; estimated: number }> {
    const now = this.clock.now();
    const scope = { tenantId: b.tenantId };
    const manualDaysBefore = await this.settings.valueAt<number>('readings.round_window_days', now, scope);
    const meters: MeterInput[] = [];
    const settlements: DraftInput['estimateSettlements'] = [];
    let estimated = 0;
    const agreedDay = b.lease
      ? b.lease.sentForSignatureAt
        ? bangkokDate(b.lease.sentForSignatureAt)
        : day(b.lease.startDate)
      : null;
    for (const utility of UTILITIES) {
      const plan = await this.inputs.planFor(
        tx,
        b.tenantId,
        b.buildingId,
        PLAN_KIND[utility],
        b.lease ? (utility === 'electric' ? b.lease.powerRatePlanId : b.lease.waterRatePlanId) : null,
      );
      const seg = await this.inputs.segmentsFor(tx, {
        unitId: b.unitId,
        utility,
        start: window.start,
        end: window.end,
        windows: { iotMinutes: window.windowMinutes, manualDaysBefore, graceUntil: window.graceUntil },
        preferFinal,
        now,
      });
      if (!seg.segments.length) continue;
      // after the grace deadline a missing closing reading becomes an estimate where the policy allows (D-031)
      if (now.getTime() >= window.graceUntil.getTime() && policy === 'allow')
        for (const s of seg.segments.filter((x) => x.to === null)) {
          const reading = await this.estimate(
            tx,
            s,
            seg.history.get(s.assignmentId) ?? [],
            window.end,
            cycleId,
          );
          if (reading) {
            s.to = segmentReadingOf(reading);
            estimated += 1;
          }
        }
      const units = seg.segments.every((s) => s.to)
        ? seg.segments.reduce((sum, s) => sum.plus(segmentUnits(s) ?? 0), new Decimal(0))
        : new Decimal(0);
      const chosen = plan
        ? BillingInputs.versionForLease(plan.versions, window.periodEnd, agreedDay, units)
        : { version: null, frozen: false };
      meters.push({
        utility,
        segments: seg.segments,
        ratePlanVersion: chosen.version ? toVersionLike(chosen.version) : null,
        rateFrozenByLease: chosen.frozen,
        capCandidates: await this.inputs.capCandidates(
          tx,
          b.tenantId,
          b.buildingId,
          utility,
          window.periodEnd,
        ),
        acknowledgementId: chosen.version?.aboveCap ? chosen.version.complianceAcknowledgementId : null,
      });
      settlements.push(...seg.settlements);
    }
    return { meters, settlements, estimated };
  }

  /** Inserts the estimated reading of a segment at the cut-off (source `estimated`, D-012) — once per cut-off. */
  private async estimate(
    tx: Tx,
    s: MeterSegment,
    history: Parameters<typeof estimateRegister>[0],
    at: Date,
    cycleId: string | null,
  ) {
    const existing = await tx.meterReading.findFirst({
      where: { assetItemId: s.assetItemId, readAt: at, source: 'estimated', reviewState: 'accepted' },
    });
    if (existing) return existing;
    const est = estimateRegister(history, at, s.rolloverAt);
    if (!est) return null;
    const a = await tx.meterAssignment.findUniqueOrThrow({ where: { id: s.assignmentId } });
    const confidence = (
      await this.settings.valueAt<{ estimated: string }>('readings.confidence', this.clock.now())
    ).estimated;
    let batchId: string | null = null;
    if (cycleId) {
      const period = await tx.billingCycle.findUniqueOrThrow({
        where: { id: cycleId },
        select: { periodKey: true },
      });
      const batch =
        (await tx.readingBatch.findFirst({
          where: { buildingId: a.buildingId, kind: 'cycle_estimate', billingCycleId: cycleId },
        })) ??
        (await tx.readingBatch.create({
          data: {
            tenantId: a.tenantId,
            buildingId: a.buildingId,
            kind: 'cycle_estimate',
            billingCycleId: cycleId,
            periodKey: period.periodKey,
            createdBy: by(),
          },
        }));
      batchId = batch.id;
    }
    return tx.meterReading.create({
      data: {
        tenantId: a.tenantId,
        buildingId: a.buildingId,
        assetItemId: a.assetItemId,
        meterAssignmentId: a.id,
        unitId: a.unitId,
        readingBatchId: batchId,
        register: est.register,
        unit: a.utility === 'electric' ? 'kwh' : 'm3',
        readAt: at,
        source: 'estimated',
        confidence,
        reviewState: 'accepted',
        submittedVia: 'cycle_estimate',
        estimateBasis: est.basis,
        note: 'cycle estimate (D-031)',
        createdBy: by(),
      },
    });
  }

  private async vatOf(tx: Tx, tenantId: string, at: Date): Promise<DraftInput['vat']> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { vatRegistered: true },
    });
    const v = await this.settings.valueAt<{ rate: string; applicableLineKinds: string[] }>('tax.vat', at, {
      tenantId,
    });
    return { registered: tenant.vatRegistered, rate: v.rate, applicableKinds: v.applicableLineKinds ?? [] };
  }

  private async pendingCharges(tx: Tx, unitId: string, partyId: string): Promise<DraftInput['charges']> {
    const rows = await tx.invoiceCharge.findMany({
      where: { unitId, partyId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => ({
      id: c.id,
      sourceType: c.sourceType,
      lineKind: c.lineKind,
      description: c.description,
      quantity: c.quantity.toFixed(3),
      unitPrice: c.unitPrice.toFixed(4),
      amount: c.amount.toFixed(2),
    }));
  }

  private leaseInput(l: NonNullable<Billable['lease']>): NonNullable<DraftInput['lease']> {
    return {
      id: l.id,
      number: l.number,
      startDate: day(l.startDate),
      endDate: day(l.endDate),
      rent: l.rent.toFixed(2),
      rentChanges: ((l.rentIncreaseRecorded ?? []) as { effectiveFrom: string; rent: string }[]).map((r) => ({
        effectiveFrom: r.effectiveFrom,
        rent: new Decimal(r.rent).toFixed(2),
      })),
      utilityBillingMode: l.utilityBillingMode,
      lines: l.lines.map((x) => ({
        id: x.id,
        kind: x.kind,
        description: x.description,
        amount: x.amount.toFixed(2),
        recurrence: x.recurrence,
        effectiveFrom: day(x.effectiveFrom),
        effectiveTo: x.effectiveTo ? day(x.effectiveTo) : null,
      })),
    };
  }

  private async unitRatePlans(
    tx: Tx,
    tenantId: string,
    buildingId: string,
    onDay: string,
  ): Promise<UnitRatePlanInput[]> {
    const out: UnitRatePlanInput[] = [];
    for (const kind of ['common_fee', 'fund'] as const) {
      const plan = await this.inputs.planFor(tx, tenantId, buildingId, kind, null);
      const version = plan ? BillingInputs.versionAt(plan.versions, onDay) : null;
      if (plan && version) out.push({ kind, name: plan.name, version: toVersionLike(version) });
    }
    return out;
  }

  /** Computes one billable of a cycle into its draft invoice (own transaction). */
  private async computeBillable(ctx: TenantContext, cycle: BillingCycle, b: Billable): Promise<DraftResult> {
    return this.db.tenant(
      ctx,
      async (tx) => {
        const unit = await tx.unit.findUniqueOrThrow({ where: { id: b.unitId } });
        const period = { start: day(cycle.periodStart), end: day(cycle.periodEnd) };
        const occupancy = b.lease
          ? {
              from: maxDate(period.start, day(b.lease.startDate)),
              to: minDate(period.end, day(b.lease.endDate)),
            }
          : { from: period.start, to: period.end };
        const prevCutoff = new Date(
          (await this.periodOfKey(cycle.tenantId, cycle.propertyId, cycle.periodKey)).startInstant.getTime() -
            1,
        );
        const start = occupancy.from === period.start ? prevCutoff : startOfBangkokDay(occupancy.from);
        const m = await this.meterInputs(
          tx,
          { tenantId: cycle.tenantId, buildingId: b.buildingId, unitId: b.unitId, lease: b.lease },
          {
            start,
            end: cycle.cutOffAt,
            graceUntil: cycle.graceDeadlineAt,
            windowMinutes: cycle.readingsWindowMinutes,
            periodEnd: period.end,
          },
          cycle.estimatePolicy,
          false,
          cycle.id,
        );
        const input: DraftInput = {
          period,
          mode: 'cycle',
          unit: {
            id: unit.id,
            unitNo: unit.unitNo,
            type: unit.type,
            areaSqm: unit.areaSqm?.toFixed(2) ?? null,
            ownershipRatio: unit.ownershipRatio?.toFixed(6) ?? null,
          },
          occupancy,
          lease: b.lease ? this.leaseInput(b.lease) : null,
          meters: b.kind === 'lease' ? m.meters : [],
          unitRatePlans:
            b.kind === 'ownership'
              ? await this.unitRatePlans(tx, cycle.tenantId, b.buildingId, period.end)
              : [],
          charges: await this.pendingCharges(tx, b.unitId, b.partyId),
          estimateSettlements: b.kind === 'lease' ? m.settlements : [],
          advanceRent: null,
          vat: await this.vatOf(tx, cycle.tenantId, cycle.cutOffAt),
        };
        const draft = computeInvoiceDraft(input);
        const target: DraftTarget = {
          tenantId: cycle.tenantId,
          buildingId: b.buildingId,
          unitId: b.unitId,
          billedPartyId: b.partyId,
          leaseId: b.lease?.id ?? null,
          billingCycleId: cycle.id,
          isFinal: false,
          periodStart: occupancy.from,
          periodEnd: occupancy.to,
        };
        // an issued invoice of this target is never recomputed
        const issued = await tx.invoice.findFirst({
          where: {
            billingCycleId: cycle.id,
            unitId: b.unitId,
            billedPartyId: b.partyId,
            status: { notIn: ['draft', 'void'] },
          },
          select: { id: true },
        });
        if (!issued) await this.invoices.persistDraft(tx, target, draft);
        return draft;
      },
      { timeout: 60_000 },
    );
  }

  /** `POST …/actions/compute` and the cut-off job: drafts for every billable of the cycle. */
  async compute(ctx: TenantContext, id: string): Promise<CycleRow> {
    const cycle = await this.db.tenant(ctx, (tx) => this.loadCycle(tx, ctx, id));
    if (!['open', 'readings_pending', 'computed'].includes(cycle.status))
      throw new DomainException('billing_cycle.invalid_state', { params: { status: cycle.status } });
    const billables = await this.db.tenant(ctx, (tx) => this.billables(tx, cycle.tenantId, cycle));
    const flags: Record<string, number> = {};
    let total = new Decimal(0);
    let drafts = 0;
    let needsReview = 0;
    // billables are independent (one draft per unit × party): a few at a time (B6.5 load target, D-207)
    const computeSlots = new Semaphore(COMPUTE_CONCURRENCY);
    const results = await Promise.all(
      billables.map((b) => computeSlots.run(() => this.computeBillable(ctx, cycle, b))),
    );
    for (const d of results) {
      drafts += 1;
      if (d.reviewFlags.length) needsReview += 1;
      total = total.plus(d.total);
      for (const f of d.reviewFlags) {
        const k = f.split(':')[0]!;
        flags[k] = (flags[k] ?? 0) + 1;
      }
      for (const f of d.complianceFlags) {
        const k = f.split(':')[0]!;
        flags[k] = (flags[k] ?? 0) + 1;
      }
    }
    const now = this.clock.now();
    const missing = flags.missing_reading ?? 0;
    const status: BillingCycleStatus = missing > 0 ? 'readings_pending' : 'computed';
    return this.db.tenant(ctx, async (tx) => {
      const fresh = await this.loadCycle(tx, ctx, id);
      const issuedCount = fresh.invoices.filter((i) => i.issuedAt).length;
      const stats = {
        billables: billables.length,
        drafts,
        needsReview,
        issued: issuedCount,
        total: total.toFixed(2),
        flags,
        computedAt: now.toISOString(),
      };
      const autoIssue = await this.settings.valueAt<{ enabled: boolean; afterHours: number }>(
        'billing.auto_issue',
        now,
        { tenantId: cycle.tenantId, propertyId: cycle.propertyId },
      );
      await tx.billingCycle.update({
        where: { id },
        data: {
          status: fresh.status === 'issued' ? 'issued' : status,
          computedAt: now,
          stats: stats,
          autoIssueAt: autoIssue.enabled ? new Date(now.getTime() + autoIssue.afterHours * 3_600_000) : null,
          ...(missing > 0 && !fresh.readingsRequestedAt ? { readingsRequestedAt: now } : {}),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'billing_cycle.computed',
        tenantId: cycle.tenantId,
        subjectType: 'ops.billing_cycle',
        subjectId: id,
        metadata: stats,
      });
      if (missing > 0 && !fresh.readingsRequestedAt)
        await this.events.record(tx, {
          type: 'billing_cycle.readings_requested',
          aggregateType: 'billing_cycle',
          aggregateId: id,
          tenantId: cycle.tenantId,
          payload: {
            billingCycleId: id,
            propertyId: cycle.propertyId,
            periodKey: cycle.periodKey,
            missing,
            graceDeadlineAt: cycle.graceDeadlineAt.toISOString(),
          },
        });
      await this.events.record(tx, {
        type: 'billing_cycle.computed',
        aggregateType: 'billing_cycle',
        aggregateId: id,
        tenantId: cycle.tenantId,
        payload: {
          billingCycleId: id,
          propertyId: cycle.propertyId,
          periodKey: cycle.periodKey,
          status,
          // operators are told once, when the cycle first becomes ready (the worker recomputes pending cycles)
          firstComputed: status === 'computed' && fresh.status !== 'computed' && fresh.status !== 'issued',
          ...stats,
        },
      });
      return this.loadCycle(tx, ctx, id);
    });
  }

  // ------------------------------------------------------------------------------------------- issue

  /**
   * `POST …/actions/issue` (idempotent): issues every draft of the cycle that is ready. Above-cap lines without an
   * acknowledgement need one for the cycle (409 → acknowledge → repeat, D-021a) or are refused under `block`; drafts
   * with missing readings / rate plans / cap references are skipped and reported.
   */
  async issue(ctx: TenantContext, id: string, acknowledgementIds: string[] = []): Promise<CycleRow> {
    const cycle = await this.db.tenant(ctx, (tx) => this.loadCycle(tx, ctx, id));
    if (!['open', 'readings_pending', 'computed', 'issued'].includes(cycle.status))
      throw new DomainException('billing_cycle.invalid_state', { params: { status: cycle.status } });
    const drafts = cycle.invoices.filter((i) => i.status === 'draft');
    // only drafts that can be issued now ask for the cap acknowledgement; the others are skipped below
    const ready = drafts.filter((i) => i.reviewFlags.every((f) => f.startsWith('acknowledgement_required')));
    const above = ready.flatMap((i) =>
      i.lines
        .filter((l) => l.aboveCap)
        .map((l) => ({
          id: l.id,
          unitNo: i.unit?.unitNo ?? null,
          lineKind: l.lineKind,
          unitPrice: l.unitPrice!.toFixed(4),
          capPerUnit: l.capPerUnit!.toFixed(4),
          units: l.units?.toFixed(3) ?? '0',
          acknowledgementId: l.complianceAcknowledgementId,
        })),
    );
    let ackId: string | null = null;
    const capCheck = await this.invoices.tariffCapCheck(ctx, above);
    if (capCheck) {
      const r = await this.gate.enforce(ctx, {
        subjectType: 'ops.billing_cycle',
        subjectId: id,
        checks: [capCheck],
        acknowledgementIds,
      });
      ackId = r.checks[0]?.acknowledgementId ?? null;
    }
    const skipped: { invoiceId: string; reason: string }[] = [];
    let issued = 0;
    // the issue transactions overlap up to the issue slots; numbers stay gapless (the series row is taken last)
    await Promise.all(
      drafts.map(async (d) => {
        const ok = await ISSUE_SLOTS.run(() =>
          this.db.tenant(
            ctx,
            (tx) => this.invoices.issueInTx(tx, ctx, d.id, { ackId, throwOnRefusal: false, skipped }),
            ISSUE_TX,
          ),
        );
        if (ok) issued += 1;
      }),
    );
    const now = this.clock.now();
    return this.db.tenant(ctx, async (tx) => {
      const fresh = await this.loadCycle(tx, ctx, id);
      const remaining = fresh.invoices.filter((i) => i.status === 'draft').length;
      const stats = {
        ...(fresh.stats as Record<string, unknown>),
        issued: fresh.invoices.filter((i) => i.issuedAt).length,
        lastIssue: { at: now.toISOString(), issued, skipped },
      };
      await tx.billingCycle.update({
        where: { id },
        data: {
          status: remaining === 0 && fresh.invoices.length > 0 ? 'issued' : fresh.status,
          issuedAt: remaining === 0 && fresh.invoices.length > 0 ? (fresh.issuedAt ?? now) : fresh.issuedAt,
          stats: stats,
          autoIssueAt: null,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'billing_cycle.issued',
        tenantId: fresh.tenantId,
        subjectType: 'ops.billing_cycle',
        subjectId: id,
        metadata: { issued, skipped, remaining },
      });
      await this.events.record(tx, {
        type: 'billing_cycle.issued',
        aggregateType: 'billing_cycle',
        aggregateId: id,
        tenantId: fresh.tenantId,
        payload: {
          billingCycleId: id,
          periodKey: fresh.periodKey,
          issued,
          skipped: skipped.length,
          remaining,
        },
      });
      return this.loadCycle(tx, ctx, id);
    });
  }

  async close(ctx: TenantContext, id: string): Promise<CycleRow> {
    return this.db.tenant(ctx, async (tx) => {
      const c = await this.loadCycle(tx, ctx, id);
      if (c.status !== 'issued')
        throw new DomainException('billing_cycle.invalid_state', { params: { status: c.status } });
      await tx.billingCycle.update({
        where: { id },
        data: { status: 'closed', closedAt: this.clock.now(), updatedBy: by(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'billing_cycle.closed',
        tenantId: c.tenantId,
        subjectType: 'ops.billing_cycle',
        subjectId: id,
      });
      await this.events.record(tx, {
        type: 'billing_cycle.closed',
        aggregateType: 'billing_cycle',
        aggregateId: id,
        tenantId: c.tenantId,
        payload: { billingCycleId: id, periodKey: c.periodKey },
      });
      return this.loadCycle(tx, ctx, id);
    });
  }

  // ------------------------------------------------------------------------------------------- worker

  /**
   * Worker job `billing-cycles` (D-031): for every property whose cut-off passed, the cycle of that period is opened
   * and computed until it is no longer waiting for readings; computed cycles past `auto_issue_at` issue themselves.
   */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    return RequestContext.run({ actor: systemActor('billing-cycles') }, async () => {
      const properties = await this.db.platform((tx) =>
        tx.property.findMany({ where: { deletedAt: null }, select: { id: true, tenantId: true } }),
      );
      let worked = 0;
      for (const p of properties) {
        try {
          const ctx = systemTenantContext(p.tenantId);
          const setting = await this.cutoffSetting(p.tenantId, p.id, now);
          // the period whose cut-off is the latest one at or before now
          const current = periodOf(setting, now);
          const previousKey =
            current.cutoff.getTime() === now.getTime() ? current.key : previousPeriodKey(current.key);
          const hasUnits = await this.db.tenant(ctx, (tx) =>
            tx.lease.count({
              where: { tenantId: p.tenantId, unit: { propertyId: p.id }, status: { in: LIVE } },
            }),
          );
          if (!hasUnits) continue;
          const cycle = await this.db.tenant(ctx, (tx) =>
            this.ensureCycle(tx, p.tenantId, p.id, previousKey),
          );
          if (cycle.status === 'open' || cycle.status === 'readings_pending') {
            await this.compute(ctx, cycle.id);
            worked += 1;
          } else if (
            cycle.status === 'computed' &&
            cycle.autoIssueAt &&
            cycle.autoIssueAt.getTime() <= now.getTime()
          ) {
            await this.issue(ctx, cycle.id).catch((error: unknown) =>
              this.logger.warn(`auto-issue ${cycle.id}: ${(error as Error).message}`),
            );
            worked += 1;
          }
        } catch (error) {
          this.logger.error(`billing cycle of property ${p.id}: ${(error as Error).message}`);
        }
      }
      return worked;
    });
  }

  // ------------------------------------------------------------------------------------------- final invoice

  /** The lease's final invoice draft at move-out (D-177): to the move-out day, advance rent applied. */
  async finalDraft(tx: Tx, leaseId: string, moveOutAt: Date): Promise<void> {
    const lease = await tx.lease.findUniqueOrThrow({ where: { id: leaseId }, include: { lines: true } });
    const moveOutDay = bangkokDate(moveOutAt);
    const lastIssued = await tx.invoice.findFirst({
      where: { leaseId, status: { notIn: ['draft', 'void'] }, isFinal: false },
      orderBy: { periodEnd: 'desc' },
    });
    const unit = await tx.unit.findUniqueOrThrow({ where: { id: lease.unitId } });
    const setting = await this.cutoffSetting(lease.tenantId, unit.propertyId, moveOutAt);
    const containing = periodOf(setting, moveOutAt);
    const bounds = periodBounds(setting, containing.key);
    const period = {
      start: bangkokDate(new Date(bounds.start.getTime() + 59_999)),
      end: bangkokDate(bounds.end),
    };
    const from = maxDate(
      maxDate(period.start, day(lease.startDate)),
      lastIssued ? addDays(day(lastIssued.periodEnd), 1) : period.start,
    );
    const occupancy = { from, to: moveOutDay };
    const scope = { tenantId: lease.tenantId, propertyId: unit.propertyId };
    const windowMinutes = await this.settings.valueAt<number>(
      'readings.iot_window_minutes',
      moveOutAt,
      scope,
    );
    const graceHours = await this.settings.valueAt<number>('billing.reading_grace_hours', moveOutAt, scope);
    const lastCycle = lastIssued?.billingCycleId
      ? await tx.billingCycle.findUnique({ where: { id: lastIssued.billingCycleId } })
      : null;
    const start = lastCycle?.cutOffAt ?? startOfBangkokDay(from);
    const billable: Billable = {
      kind: 'lease',
      unitId: lease.unitId,
      buildingId: lease.buildingId,
      partyId: lease.payerPartyId ?? lease.lesseePartyId,
      lease,
    };
    const m = await this.meterInputs(
      tx,
      { tenantId: lease.tenantId, buildingId: lease.buildingId, unitId: lease.unitId, lease },
      {
        start,
        end: moveOutAt,
        graceUntil: new Date(moveOutAt.getTime() + graceHours * 3_600_000),
        windowMinutes,
        periodEnd: moveOutDay,
      },
      'block',
      true,
      null,
    );
    const deposit = await tx.deposit.findUnique({ where: { leaseId } });
    const advance =
      deposit && deposit.receivedAt && deposit.amountAdvanceRent.gt(0)
        ? deposit.amountAdvanceRent.toFixed(2)
        : null;
    const input: DraftInput = {
      period,
      mode: 'final',
      unit: {
        id: unit.id,
        unitNo: unit.unitNo,
        type: unit.type,
        areaSqm: unit.areaSqm?.toFixed(2) ?? null,
        ownershipRatio: unit.ownershipRatio?.toFixed(6) ?? null,
      },
      occupancy,
      lease: this.leaseInput(billable.lease!),
      meters: m.meters,
      unitRatePlans: [],
      charges: await this.pendingCharges(tx, lease.unitId, lease.payerPartyId ?? lease.lesseePartyId),
      estimateSettlements: m.settlements,
      advanceRent: advance,
      vat: await this.vatOf(tx, lease.tenantId, moveOutAt),
    };
    const draft = computeInvoiceDraft(input);
    await this.invoices.persistDraft(
      tx,
      {
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        unitId: lease.unitId,
        billedPartyId: lease.payerPartyId ?? lease.lesseePartyId,
        leaseId,
        billingCycleId: null,
        isFinal: true,
        periodStart: from > moveOutDay ? moveOutDay : from,
        periodEnd: moveOutDay,
      },
      draft,
    );
  }

  /** Recomputes a lease's final draft (move-out inspection completed, owner request). */
  async refreshFinal(tx: Tx, leaseId: string): Promise<void> {
    const draft = await tx.invoice.findFirst({ where: { leaseId, isFinal: true, status: 'draft' } });
    if (!draft) return;
    const lease = await tx.lease.findUniqueOrThrow({ where: { id: leaseId } });
    if (!lease.moveOutAt) return;
    await this.finalDraft(tx, leaseId, lease.moveOutAt);
  }

  /** `POST /v1/owner/invoices/{id}/actions/recompute` for a final or replacement draft. */
  async recomputeDraft(ctx: TenantContext, invoiceId: string) {
    const inv = await this.invoices.get(ctx, invoiceId);
    if (inv.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
    if (inv.status !== 'draft')
      throw new DomainException('invoice.invalid_state', { params: { status: inv.status } });
    if (inv.isFinal && inv.leaseId) {
      await this.db.tenant(ctx, (tx) => this.refreshFinal(tx, inv.leaseId!), { timeout: 60_000 });
      const fresh = await this.db.tenant(ctx, (tx) =>
        tx.invoice.findFirstOrThrow({ where: { leaseId: inv.leaseId, isFinal: true, status: 'draft' } }),
      );
      return this.invoices.get(ctx, fresh.id);
    }
    if (inv.billingCycleId) {
      await this.compute(ctx, inv.billingCycleId);
      const fresh = await this.db.tenant(ctx, (tx) =>
        tx.invoice.findFirstOrThrow({
          where: {
            billingCycleId: inv.billingCycleId,
            unitId: inv.unitId,
            billedPartyId: inv.billedPartyId,
            status: 'draft',
          },
        }),
      );
      return this.invoices.get(ctx, fresh.id);
    }
    throw new DomainException('invoice.invalid_state', { params: { status: inv.status } });
  }

  /**
   * Void (D-040) with an optional replacement draft for the same period: a cycle invoice is recomputed into the same
   * cycle, a final invoice into a new final draft; the old one points at its replacement once that exists.
   */
  async voidAndReissue(ctx: TenantContext, invoiceId: string, input: { reason: string; reissue: boolean }) {
    const voided = await this.invoices.voidInvoice(ctx, invoiceId, { reason: input.reason });
    if (!input.reissue) return { voided, replacement: null };
    let replacementId: string | null = null;
    if (voided.billingCycleId && voided.unitId) {
      const cycle = await this.db.tenant(ctx, (tx) => this.loadCycle(tx, ctx, voided.billingCycleId!));
      const billables = await this.db.tenant(ctx, (tx) => this.billables(tx, cycle.tenantId, cycle));
      const b = billables.find((x) => x.unitId === voided.unitId && x.partyId === voided.billedPartyId);
      if (b) {
        await this.computeBillable(ctx, cycle, b);
        replacementId =
          (
            await this.db.tenant(ctx, (tx) =>
              tx.invoice.findFirst({
                where: {
                  billingCycleId: cycle.id,
                  unitId: b.unitId,
                  billedPartyId: b.partyId,
                  status: 'draft',
                },
              }),
            )
          )?.id ?? null;
      }
    } else if (voided.isFinal && voided.leaseId) {
      const lease = await this.db.tenant(ctx, (tx) =>
        tx.lease.findUniqueOrThrow({ where: { id: voided.leaseId! } }),
      );
      if (lease.moveOutAt) {
        await this.db.tenant(ctx, (tx) => this.finalDraft(tx, lease.id, lease.moveOutAt!), {
          timeout: 60_000,
        });
        replacementId =
          (
            await this.db.tenant(ctx, (tx) =>
              tx.invoice.findFirst({ where: { leaseId: lease.id, isFinal: true, status: 'draft' } }),
            )
          )?.id ?? null;
      }
    }
    if (replacementId)
      await this.db.tenant(ctx, async (tx) => {
        await tx.invoice.update({ where: { id: replacementId }, data: { replacesInvoiceId: invoiceId } });
        await tx.invoice.update({ where: { id: invoiceId }, data: { replacedByInvoiceId: replacementId } });
        await this.audit.record(tx, {
          action: 'invoice.reissued',
          tenantId: ctx.tenantId,
          buildingId: voided.buildingId,
          subjectType: 'ops.invoice',
          subjectId: invoiceId,
          metadata: { replacementId },
        });
      });
    return {
      voided: await this.invoices.get(ctx, invoiceId),
      replacement: replacementId ? await this.invoices.get(ctx, replacementId) : null,
    };
  }

  /** An issued final invoice feeds the deposit settlement (D-177): final utilities and unused advance rent. */
  private async linkSettlement(
    tx: Tx,
    invoice: {
      id: string;
      leaseId: string | null;
      isFinal: boolean;
      balance: Decimal | Prisma.Decimal;
      snapshot: unknown;
    },
  ) {
    if (!invoice.isFinal || !invoice.leaseId) return;
    const settlement = await tx.depositSettlement.findFirst({
      where: { leaseId: invoice.leaseId, status: { in: ['opened', 'inspected', 'disputed'] } },
    });
    if (!settlement) return;
    const unused =
      (
        invoice.snapshot as {
          draft?: { advanceRent?: { unused?: string } };
          advanceRent?: { unused?: string };
        } | null
      )?.advanceRent?.unused ?? '0.00';
    await tx.depositSettlement.update({
      where: { id: settlement.id },
      data: {
        finalInvoiceId: invoice.id,
        utilitiesFinal: new Decimal(invoice.balance.toString()).toFixed(2),
        advanceRentUnused: new Decimal(unused).toFixed(2),
        version: { increment: 1 },
      },
    });
  }
}

function previousPeriodKey(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

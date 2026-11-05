import { isJuristicTenantType } from '@collective/asset-core';
import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { evaluateSurchargeCap, evaluateSuspendServices } from '@core/compliance/evaluators';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import {
  billedParty,
  operators,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { WorkflowService } from '@core/workflow/workflow.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type BuildingLegalForm,
  type CollectionAction,
  type CollectionCase,
  type CollectionCaseState,
  type CollectionChannel,
  type CollectionOutcome,
  type CollectionStep,
  type Prisma,
} from '@generated/prisma/client';
import { PaymentsService } from '@modules/ops-payments/payments.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import {
  approvalForced,
  gateClosedReason,
  type GateSettings,
  LADDER_TEMPLATES,
  legalFormOf,
  legalReviewRequired,
  stepDueOn,
} from './collections/ladder-templates';
import { computeSurcharge } from './collections/surcharge';

const by = () => userIdOf(RequestContext.actor());
const D = (v: Decimal.Value | { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const OPEN = ['issued', 'partially_paid', 'overdue'] as const;
const DAY = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY);
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

export const CASE_INCLUDE = {
  unit: { select: { id: true, unitNo: true, buildingId: true } },
  party: { select: { id: true, displayName: true } },
  ladder: { include: { steps: { orderBy: { seq: 'asc' } } } },
  events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.CollectionCaseInclude;
export type CollectionCaseRow = Prisma.CollectionCaseGetPayload<{ include: typeof CASE_INCLUDE }>;

export const LADDER_INCLUDE = {
  steps: { orderBy: { seq: 'asc' } },
} as const satisfies Prisma.CollectionLadderInclude;
export type CollectionLadderRow = Prisma.CollectionLadderGetPayload<{ include: typeof LADDER_INCLUDE }>;

export interface StepPatch {
  offsetDays?: number;
  channels?: CollectionChannel[];
  requiresApproval?: boolean;
  enabled?: boolean;
}

export interface NextStep {
  stepId: string;
  seq: number;
  action: CollectionAction;
  dueOn: string;
  legalReviewRequired: boolean;
  awaitingApproval: boolean;
}

interface Gates extends GateSettings {
  legalForm: BuildingLegalForm;
  ratePct: string | null;
  escalatedRatePct: string | null;
  escalatedCapPct: string | null;
  escalateAfterDays: number | null;
  suspendServices: string[];
}

/**
 * Collections ladder (D-305 = D-J04, D-326) on the workflow engine (definition `collection_case`, D-159):
 * - a **case** per billed party × unit of a juristic tenant opens when one of its invoices becomes overdue (subscriber
 *   of `invoice.overdue`, caught up by the job); its anchor is the due date of the oldest overdue invoice;
 * - the hourly job **`collections`** runs, per open case, the next due step of the tenant's ladder for the building's
 *   legal form (due = anchor + offset + days paused) — at most one effective step per run, each step exactly once
 *   per case (unique final outcome); disabled steps and steps whose legal gate is closed are recorded `skipped`;
 *   a step needing approval waits (`awaiting_approval`) and holds back the later steps until approved or refused;
 * - a case **pauses** while an approved payment plan is active (J1.2a events) or a dispute is open, **resumes** on
 *   default / cancel / completion of the plan or when the dispute closes, and is **resolved** once nothing is owed
 *   (open invoices of the party × unit and plan charges still waiting = 0).
 * Apartments keep the per-invoice dunning (`ops.dunning_reminder`); for juristic tenants dunning stays silent.
 * Every change is one transaction with the timeline row, the audit row and the domain event.
 */
@Injectable()
export class CollectionsService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'juristic-collections';
  readonly eventTypes = [
    'invoice.overdue',
    'invoice.paid',
    'juristic.payment_plan.approved',
    'juristic.payment_plan.defaulted',
    'juristic.payment_plan.cancelled',
    'juristic.payment_plan.completed',
  ] as const;
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly workflow: WorkflowService,
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
    const toResident = async (tx: Tx, e: DomainEventEnvelope) => {
      const partyId = e.payload.partyId as string | undefined;
      if (!partyId || !e.tenantId) return null;
      return {
        recipients: await billedParty(tx, partyId),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          collection: {
            unitNo: e.payload.unitNo ?? '',
            amountDue: e.payload.amountDue ?? '0.00',
            oldestDueOn: e.payload.oldestDueOn ?? '',
            daysOverdue: e.payload.daysOverdue ?? 0,
            amount: e.payload.amount ?? null,
            services: Array.isArray(e.payload.services) ? (e.payload.services as string[]).join(', ') : '',
            reason: e.payload.reason ?? '',
          },
          link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/invoices?unitId=${(e.payload.unitId as string) ?? ''}`,
        },
        consentPurpose: 'resident.service' as const,
      };
    };
    for (const key of [
      'juristic.collection.reminder',
      'juristic.collection.surcharge_added',
      'juristic.collection.services_suspended',
      'juristic.collection.notice_letter',
      'juristic.collection.lawyer_letter',
      'juristic.collection.dispute_opened',
      'juristic.collection.dispute_closed',
    ])
      registerNotifiable(key, toResident);
    const toOperators = async (tx: Tx, e: DomainEventEnvelope) =>
      e.tenantId
        ? {
            // committee members read it in the console (no notification audience of their own)
            recipients: await operators(tx, e.tenantId, ['owner', 'manager'], 'owner'),
            data: {
              tenant: { name: await tenantName(tx, e.tenantId) },
              collection: {
                unitNo: e.payload.unitNo ?? '',
                partyName: e.payload.partyName ?? '',
                action: e.payload.action ?? '',
                amountDue: e.payload.amountDue ?? '0.00',
              },
            },
          }
        : null;
    registerNotifiable('juristic.collection.approval_required', toOperators);
    registerNotifiable('juristic.collection.legal_action', toOperators);
  }

  private now(): Date {
    return this.clock.now();
  }

  private today(): string {
    return bangkokDate(this.now());
  }

  // ------------------------------------------------------------------------------------------- subscriber

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const p = event.payload;
    switch (event.type) {
      case 'invoice.overdue': {
        const inv = await tx.invoice.findUnique({ where: { id: p.invoiceId as string } });
        if (!inv?.unitId || !(await this.isJuristic(tx, inv.tenantId))) return;
        await this.openCase(tx, inv.tenantId, inv.billedPartyId, inv.unitId);
        return;
      }
      case 'invoice.paid': {
        const inv = await tx.invoice.findUnique({ where: { id: p.invoiceId as string } });
        if (!inv?.unitId) return;
        const c = await tx.collectionCase.findFirst({
          where: { partyId: inv.billedPartyId, unitId: inv.unitId, state: 'open' },
        });
        if (c) await this.resolveIfPaid(tx, c.id);
        return;
      }
      case 'juristic.payment_plan.approved': {
        const c = await tx.collectionCase.findFirst({
          where: {
            partyId: p.partyId as string,
            unitId: p.unitId as string,
            state: { in: ['open', 'paused'] },
          },
        });
        if (!c) return;
        await this.lockCase(tx, c.id);
        await tx.collectionCase.update({ where: { id: c.id }, data: { planId: p.planId as string } });
        await this.pause(
          tx,
          c.id,
          'payment_plan',
          `แผนผ่อนชำระ ${(p.planId as string).slice(-8).toUpperCase()}`,
        );
        return;
      }
      case 'juristic.payment_plan.defaulted':
      case 'juristic.payment_plan.cancelled':
      case 'juristic.payment_plan.completed': {
        const c = await tx.collectionCase.findFirst({
          where: { planId: p.planId as string, state: { in: ['open', 'paused'] } },
        });
        if (!c) return;
        await this.lockCase(tx, c.id);
        await tx.collectionCase.update({ where: { id: c.id }, data: { planId: null } });
        await this.resume(tx, c.id, `payment_plan_${event.type.split('.').pop()!}`);
        return;
      }
      default:
        return;
    }
  }

  private async isJuristic(tx: Tx, tenantId: string): Promise<boolean> {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { type: true } });
    return isJuristicTenantType(t?.type);
  }

  private async lockCase(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM juristic.collection_case WHERE id = ${id}::uuid FOR UPDATE`;
  }

  // ------------------------------------------------------------------------------------------- ladders

  /** The tenant's ladder for a legal form, copied from the template on first use (race-safe). */
  async ensureLadder(tx: Tx, tenantId: string, legalForm: BuildingLegalForm) {
    const template = LADDER_TEMPLATES[legalForm];
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO juristic.collection_ladder (tenant_id, legal_form, name, source_template_key, created_by)
      VALUES (${tenantId}::uuid, ${legalForm}::core.building_legal_form, ${template.nameTh}, ${template.key}, ${by()}::uuid)
      ON CONFLICT (tenant_id, legal_form) DO NOTHING RETURNING id`;
    if (inserted[0])
      await tx.collectionStep.createMany({
        data: template.steps.map((s) => ({
          tenantId,
          ladderId: inserted[0]!.id,
          seq: s.seq,
          offsetDays: s.offsetDays,
          action: s.action,
          channels: s.channels,
          templateKey: s.templateKey,
          requiresApproval: s.requiresApproval,
          enabled: s.enabled,
          createdBy: by(),
        })),
      });
    return tx.collectionLadder.findUniqueOrThrow({
      where: { tenantId_legalForm: { tenantId, legalForm } },
      include: LADDER_INCLUDE,
    });
  }

  /** `GET …/collection-ladders`: one ladder per legal form of the tenant's buildings (created on first read). */
  ladders(ctx: TenantContext): Promise<CollectionLadderRow[]> {
    return this.db.tenant(ctx, async (tx) => {
      // ladders exist for juristic tenants only (apartments keep the per-invoice dunning, D-326)
      if (!(await this.isJuristic(tx, ctx.tenantId))) return [];
      const buildings = await tx.building.findMany({
        where: {
          deletedAt: null,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        },
        select: { legalForm: true, type: true },
      });
      const forms = new Set<BuildingLegalForm>(buildings.map((b) => legalFormOf(b)));
      for (const l of await tx.collectionLadder.findMany({ where: { tenantId: ctx.tenantId } }))
        forms.add(l.legalForm);
      const out: CollectionLadderRow[] = [];
      for (const f of [...forms].sort()) out.push(await this.ensureLadder(tx, ctx.tenantId, f));
      return out;
    });
  }

  async ladder(ctx: TenantContext, id: string): Promise<CollectionLadderRow> {
    return this.db.tenant(ctx, async (tx) =>
      this.found(
        await tx.collectionLadder.findFirst({ where: this.own(ctx, { id }), include: LADDER_INCLUDE }),
      ),
    );
  }

  /** The legal measures' gates and rates in force for a tenant and legal form (all closed by default, O-038). */
  async gates(tenantId: string, legalForm: BuildingLegalForm): Promise<Gates> {
    const at = this.now();
    const get = <T>(key: string) => this.settings.valueAt<T>(key, at, { tenantId });
    const statutory = legalForm === 'condo_act' || legalForm === 'land_allocation_act';
    const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
    const pct = (v: unknown) => (typeof v === 'string' && v.length ? v : null);
    return {
      legalForm,
      surchargeEnabled: (await get<boolean>('juristic.surcharge.enabled')) === true,
      surchargeRateCap: statutory ? pct(await get(`juristic.surcharge.${legalForm}.rate_cap`)) : null,
      escalatedCapPct: statutory
        ? pct(await get(`juristic.surcharge.${legalForm}.escalated_rate_cap`))
        : null,
      escalateAfterDays: statutory
        ? num(await get(`juristic.surcharge.${legalForm}.escalate_after_days`))
        : null,
      ratePct: pct(await get('juristic.surcharge.rate_pct_per_year')),
      escalatedRatePct: pct(await get('juristic.surcharge.escalated_rate_pct_per_year')),
      lettersTemplateVersion: pct(await get(`juristic.letters.${legalForm}.template_version`)),
      suspendEnabled: (await get<boolean>('juristic.suspend_services.enabled')) === true,
      suspendMinOverdueDays: statutory
        ? num(await get(`juristic.suspend_services.${legalForm}.min_overdue_days`))
        : null,
      suspendServices: ((await get<string[]>('juristic.suspend_services.services')) ?? []).filter(
        (s) => typeof s === 'string',
      ),
      legalActionEnabled: (await get<boolean>('juristic.legal_action.enabled')) === true,
    };
  }

  /** Why a step may not run / be enabled now (null = allowed). Voluntary / lease forms have no surcharge rule. */
  private closedReason(action: CollectionAction, g: Gates): string | null {
    return gateClosedReason(action, g);
  }

  /**
   * `PATCH …/collection-ladders/{id}/steps/{stepId}` (owner / manager): offsets stay strictly between the neighbours,
   * channels from line · email · sms · letter, approval cannot be dropped for suspension / lawyer letter / legal
   * action, and a legal measure can be enabled only while its gate is open (422 `collections.legal_review_required`).
   */
  async updateStep(
    ctx: TenantContext,
    ladderId: string,
    stepId: string,
    patch: StepPatch,
  ): Promise<CollectionLadderRow> {
    await this.db.tenant(ctx, async (tx) => {
      const ladder = this.found(
        await tx.collectionLadder.findFirst({
          where: this.own(ctx, { id: ladderId }),
          include: LADDER_INCLUDE,
        }),
      );
      const step = this.found(ladder.steps.find((s) => s.id === stepId));
      const i = ladder.steps.indexOf(step);
      const prev = ladder.steps[i - 1];
      const next = ladder.steps[i + 1];
      if (patch.offsetDays !== undefined) {
        if (!Number.isInteger(patch.offsetDays) || patch.offsetDays < 0 || patch.offsetDays > 3650)
          throw invalid('offsetDays', 'range', 'whole days 0–3650');
        if ((prev && patch.offsetDays <= prev.offsetDays) || (next && patch.offsetDays >= next.offsetDays))
          throw invalid('offsetDays', 'order', 'after the previous step and before the next one');
      }
      if (patch.requiresApproval === false && approvalForced(step.action))
        throw new DomainException('collections.approval_required', { params: { action: step.action } });
      if (patch.enabled === true && !step.enabled) {
        const reason = this.closedReason(step.action, await this.gates(ctx.tenantId, ladder.legalForm));
        if (reason)
          throw new DomainException('collections.legal_review_required', {
            params: { action: step.action, reason },
          });
      }
      const channels = patch.channels ? [...new Set(patch.channels)] : undefined;
      await tx.collectionStep.update({
        where: { id: stepId },
        data: {
          ...(patch.offsetDays !== undefined ? { offsetDays: patch.offsetDays } : {}),
          ...(channels ? { channels } : {}),
          ...(patch.requiresApproval !== undefined ? { requiresApproval: patch.requiresApproval } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.collection_step_updated',
        tenantId: ctx.tenantId,
        subjectType: 'juristic.collection_step',
        subjectId: stepId,
        before: {
          offsetDays: step.offsetDays,
          channels: step.channels,
          requiresApproval: step.requiresApproval,
          enabled: step.enabled,
        },
        after: { ...patch, ...(channels ? { channels } : {}) },
      });
      await this.events.record(tx, {
        type: 'juristic.collection_ladder.changed',
        aggregateType: 'collection_ladder',
        aggregateId: ladderId,
        tenantId: ctx.tenantId,
        payload: { ladderId, stepId, legalForm: ladder.legalForm, change: patch },
      });
    });
    return this.ladder(ctx, ladderId);
  }

  // ------------------------------------------------------------------------------------------- amounts

  /** Open invoices of the party × unit in the tenant, oldest due first. */
  private openInvoices(tx: Tx, c: Pick<CollectionCase, 'tenantId' | 'partyId' | 'unitId'>) {
    return tx.invoice.findMany({
      where: {
        tenantId: c.tenantId,
        billedPartyId: c.partyId,
        unitId: c.unitId,
        status: { in: [...OPEN] },
        balance: { gt: 0 },
      },
      orderBy: [{ dueDate: 'asc' }, { issuedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** What the party owes on the unit: open balances + plan charges queued for the next invoice. */
  private async owed(tx: Tx, c: Pick<CollectionCase, 'tenantId' | 'partyId' | 'unitId'>): Promise<Decimal> {
    const open = await this.openInvoices(tx, c);
    const pending = await tx.invoiceCharge.aggregate({
      where: {
        tenantId: c.tenantId,
        partyId: c.partyId,
        unitId: c.unitId,
        status: 'pending',
        lineKind: 'plan_instalment',
      },
      _sum: { amount: true },
    });
    return open.reduce((s, i) => s.plus(D(i.balance)), D(0)).plus(D(pending._sum.amount ?? 0));
  }

  private overdueOf(
    invoices: Awaited<ReturnType<CollectionsService['openInvoices']>>,
    today: string,
  ): typeof invoices {
    return invoices.filter((i) => i.dueDate && day(i.dueDate) < today);
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  /** Opens the case of a party × unit with something overdue (idempotent; null when nothing is overdue). */
  async openCase(tx: Tx, tenantId: string, partyId: string, unitId: string): Promise<CollectionCase | null> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`collection:${partyId}:${unitId}`}))`;
    const existing = await tx.collectionCase.findFirst({
      where: { partyId, unitId, state: { in: ['open', 'paused'] } },
    });
    if (existing) return existing;
    const today = this.today();
    const overdue = this.overdueOf(await this.openInvoices(tx, { tenantId, partyId, unitId }), today);
    if (!overdue.length) return null;
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: unitId },
      select: { unitNo: true, buildingId: true, building: { select: { legalForm: true, type: true } } },
    });
    const legalForm = legalFormOf(unit.building);
    const ladder = await this.ensureLadder(tx, tenantId, legalForm);
    const anchor = day(overdue[0]!.dueDate!);
    const created = await tx.collectionCase.create({
      data: {
        tenantId,
        buildingId: unit.buildingId,
        unitId,
        partyId,
        ladderId: ladder.id,
        legalForm,
        anchorOn: asDate(anchor),
        openedAt: this.now(),
      },
    });
    const instance = await this.workflow.start(tx, {
      tenantId,
      buildingId: unit.buildingId,
      subjectType: 'juristic.collection_case',
      subjectId: created.id,
      definitionKey: 'collection_case',
      context: { unitNo: unit.unitNo, legalForm, anchorOn: anchor },
    });
    const kase = await tx.collectionCase.update({
      where: { id: created.id },
      data: { workflowInstanceId: instance.id },
    });
    await this.timeline(tx, kase, 'opened', {
      payload: { anchorOn: anchor, legalForm, ladderId: ladder.id },
    });
    await this.audit.record(tx, {
      action: 'juristic.collection_case_opened',
      tenantId,
      buildingId: unit.buildingId,
      subjectType: 'juristic.collection_case',
      subjectId: kase.id,
      metadata: { unitNo: unit.unitNo, anchorOn: anchor, legalForm },
    });
    await this.events.record(tx, {
      type: 'juristic.collection_case.opened',
      aggregateType: 'collection_case',
      aggregateId: kase.id,
      tenantId,
      buildingId: unit.buildingId,
      payload: { caseId: kase.id, unitId, unitNo: unit.unitNo, partyId, anchorOn: anchor, legalForm },
    });
    // a plan already active for this party × unit holds the ladder from the start
    const plan = await tx.paymentPlan.findFirst({ where: { unitId, partyId, state: 'active' } });
    if (plan) {
      await tx.collectionCase.update({ where: { id: kase.id }, data: { planId: plan.id } });
      await this.pause(tx, kase.id, 'payment_plan', 'แผนผ่อนชำระที่ใช้อยู่');
    }
    return tx.collectionCase.findUniqueOrThrow({ where: { id: kase.id } });
  }

  private async timeline(
    tx: Tx,
    c: Pick<CollectionCase, 'id' | 'tenantId'>,
    kind: 'opened' | 'step' | 'paused' | 'resumed' | 'dispute_opened' | 'dispute_closed' | 'resolved',
    extra: {
      step?: CollectionStep;
      outcome?: CollectionOutcome;
      reason?: string | null;
      amount?: string | null;
      invoiceChargeId?: string | null;
      payload?: Record<string, unknown>;
    } = {},
  ) {
    return tx.collectionEvent.create({
      data: {
        tenantId: c.tenantId,
        caseId: c.id,
        kind,
        stepId: extra.step?.id ?? null,
        seq: extra.step?.seq ?? null,
        action: extra.step?.action ?? null,
        outcome: extra.outcome ?? null,
        reason: extra.reason ?? null,
        amount: extra.amount ?? null,
        invoiceChargeId: extra.invoiceChargeId ?? null,
        actorUserId: by(),
        payload: (extra.payload ?? {}) as Prisma.InputJsonValue,
        occurredAt: this.now(),
      },
    });
  }

  private async transition(tx: Tx, c: CollectionCase, event: 'pause' | 'resume' | 'resolve'): Promise<void> {
    if (!c.workflowInstanceId) return;
    const instance = await tx.workflowInstance.findUnique({ where: { id: c.workflowInstanceId } });
    if (!instance || instance.closedAt) return;
    await this.workflow.transition(tx, instance.id, event, { caseId: c.id });
  }

  private async pause(tx: Tx, id: string, cause: 'payment_plan' | 'dispute', reason: string): Promise<void> {
    const c = await tx.collectionCase.findUniqueOrThrow({ where: { id } });
    if (c.state !== 'open') return;
    const now = this.now();
    const paused = await tx.collectionCase.update({
      where: { id },
      data: { state: 'paused', pausedAt: now, version: { increment: 1 } },
    });
    await this.transition(tx, c, 'pause');
    await this.timeline(tx, c, 'paused', { reason, payload: { cause } });
    await this.events.record(tx, {
      type: 'juristic.collection_case.paused',
      aggregateType: 'collection_case',
      aggregateId: id,
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      payload: { caseId: id, unitId: c.unitId, partyId: c.partyId, cause, planId: paused.planId },
    });
  }

  /** Resumes a paused case when neither a plan nor a dispute holds it; the pause moves the rest of the ladder back. */
  private async resume(tx: Tx, id: string, cause: string): Promise<void> {
    const c = await tx.collectionCase.findUniqueOrThrow({ where: { id } });
    if (c.state !== 'paused' || c.planId || c.disputeOpenedAt) return;
    const pausedDays = c.pausedAt ? Math.max(0, daysBetween(bangkokDate(c.pausedAt), this.today())) : 0;
    await tx.collectionCase.update({
      where: { id },
      data: {
        state: 'open',
        pausedAt: null,
        pausedDays: c.pausedDays + pausedDays,
        version: { increment: 1 },
      },
    });
    await this.transition(tx, c, 'resume');
    await this.timeline(tx, c, 'resumed', { reason: cause, payload: { pausedDays } });
    await this.events.record(tx, {
      type: 'juristic.collection_case.resumed',
      aggregateType: 'collection_case',
      aggregateId: id,
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      payload: { caseId: id, unitId: c.unitId, partyId: c.partyId, cause, pausedDays },
    });
  }

  /** Resolves an open case when nothing is owed any more (true when resolved). */
  private async resolveIfPaid(tx: Tx, id: string): Promise<boolean> {
    await this.lockCase(tx, id);
    const c = await tx.collectionCase.findUniqueOrThrow({ where: { id } });
    if (c.state !== 'open') return false;
    // an approved plan moved the debt onto instalments (credit notes): the case waits for the plan, it is not paid
    if (await tx.paymentPlan.findFirst({ where: { partyId: c.partyId, unitId: c.unitId, state: 'active' } }))
      return false;
    if ((await this.owed(tx, c)).gt(0)) return false;
    await tx.collectionCase.update({
      where: { id },
      data: {
        state: 'resolved',
        resolvedAt: this.now(),
        resolveReason: 'paid',
        awaitingStepId: null,
        version: { increment: 1 },
      },
    });
    await this.transition(tx, c, 'resolve');
    await this.timeline(tx, c, 'resolved', { reason: 'paid' });
    await this.audit.record(tx, {
      action: 'juristic.collection_case_resolved',
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      subjectType: 'juristic.collection_case',
      subjectId: id,
      metadata: { reason: 'paid' },
    });
    await this.events.record(tx, {
      type: 'juristic.collection_case.resolved',
      aggregateType: 'collection_case',
      aggregateId: id,
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      payload: { caseId: id, unitId: c.unitId, partyId: c.partyId, reason: 'paid' },
    });
    return true;
  }

  // ------------------------------------------------------------------------------------------- job

  /**
   * Job `collections` (hourly; idempotent): (1) opens the cases of overdue invoices of juristic tenants that have none;
   * (2) resolves open cases with nothing owed; (3) runs the next due step of every open case. One transaction per case.
   */
  async run(): Promise<{ opened: number; resolved: number; steps: number }> {
    return RequestContext.run({ actor: systemActor('collections') }, async () => {
      const out = { opened: 0, resolved: 0, steps: 0 };
      const missing = await this.db.platform(
        (tx) =>
          tx.$queryRaw<{ tenant_id: string; party_id: string; unit_id: string }[]>`
          SELECT DISTINCT i.tenant_id, i.billed_party_id AS party_id, i.unit_id
            FROM ops.invoice i JOIN core.tenant t ON t.id = i.tenant_id
           WHERE t.type::text IN ('juristic', 'condo_juristic') AND i.status = 'overdue' AND i.balance > 0
             AND i.unit_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM juristic.collection_case c
                              WHERE c.party_id = i.billed_party_id AND c.unit_id = i.unit_id
                                AND c.state IN ('open', 'paused'))
           LIMIT 5000`,
      );
      for (const m of missing) {
        try {
          const opened = await this.db.tenant(systemTenantContext(m.tenant_id), (tx) =>
            this.openCase(tx, m.tenant_id, m.party_id, m.unit_id),
          );
          if (opened) out.opened += 1;
        } catch (error) {
          this.logger.error(`collection case ${m.party_id}/${m.unit_id}: ${(error as Error).message}`);
        }
      }
      const cases = await this.db.platform((tx) =>
        tx.collectionCase.findMany({
          where: { state: 'open' },
          select: { id: true, tenantId: true },
          orderBy: { id: 'asc' },
          take: 5000,
        }),
      );
      for (const c of cases) {
        try {
          await this.db.tenant(
            systemTenantContext(c.tenantId),
            async (tx) => {
              if (await this.resolveIfPaid(tx, c.id)) out.resolved += 1;
              else if (await this.runCase(tx, c.id)) out.steps += 1;
            },
            { timeout: 60_000 },
          );
        } catch (error) {
          this.logger.error(`collection case ${c.id}: ${(error as Error).message}`);
        }
      }
      return out;
    });
  }

  /**
   * The next due steps of one case (under its row lock): skips are recorded and passed; the first step that acts or
   * waits for an approval ends the run. Returns true when a step acted or started waiting.
   */
  private async runCase(tx: Tx, id: string): Promise<boolean> {
    await this.lockCase(tx, id);
    const c = await tx.collectionCase.findUniqueOrThrow({
      where: { id },
      include: { ladder: { include: { steps: { orderBy: { seq: 'asc' } } } } },
    });
    if (c.state !== 'open' || c.awaitingStepId) return false;
    const today = this.today();
    const overdue = this.overdueOf(await this.openInvoices(tx, c), today);
    if (!overdue.length) return false;
    const gates = await this.gates(c.tenantId, c.legalForm);
    const anchor = day(c.anchorOn);
    for (const step of c.ladder.steps.filter((s) => s.seq >= c.nextSeq)) {
      if (stepDueOn(anchor, step.offsetDays, c.pausedDays) > today) return false;
      const skip = !step.enabled ? 'disabled' : this.closedReason(step.action, gates);
      if (skip) {
        await this.finish(tx, c, step, 'skipped', { reason: skip });
        continue;
      }
      if (step.requiresApproval) {
        await this.timeline(tx, c, 'step', { step, outcome: 'awaiting_approval' });
        await tx.collectionCase.update({
          where: { id },
          data: { awaitingStepId: step.id, version: { increment: 1 } },
        });
        const info = await this.info(tx, c);
        await this.events.record(tx, {
          type: 'juristic.collection.approval_required',
          aggregateType: 'collection_case',
          aggregateId: id,
          tenantId: c.tenantId,
          buildingId: c.buildingId,
          payload: { caseId: id, stepId: step.id, action: step.action, ...info },
        });
        return true;
      }
      await this.perform(tx, c, step, gates, false);
      return true;
    }
    return false;
  }

  /** Party, unit and what is owed, for notices. */
  private async info(tx: Tx, c: CollectionCase) {
    const [unit, party, open] = await Promise.all([
      tx.unit.findUniqueOrThrow({ where: { id: c.unitId }, select: { unitNo: true } }),
      tx.party.findUniqueOrThrow({ where: { id: c.partyId }, select: { displayName: true } }),
      this.openInvoices(tx, c),
    ]);
    const today = this.today();
    const oldest = this.overdueOf(open, today)[0]?.dueDate;
    return {
      unitId: c.unitId,
      unitNo: unit.unitNo,
      partyId: c.partyId,
      partyName: party.displayName,
      amountDue: open.reduce((s, i) => s.plus(D(i.balance)), D(0)).toFixed(2),
      oldestDueOn: oldest ? day(oldest) : null,
      daysOverdue: oldest ? Math.max(0, daysBetween(day(oldest), today)) : 0,
    };
  }

  /** Records a step's final outcome and moves the case to the next step. */
  private async finish(
    tx: Tx,
    c: CollectionCase,
    step: CollectionStep,
    outcome: 'sent' | 'skipped' | 'refused' | 'failed',
    extra: {
      reason?: string | null;
      amount?: string | null;
      invoiceChargeId?: string | null;
      payload?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.timeline(tx, c, 'step', { step, outcome, ...extra });
    await tx.collectionCase.update({
      where: { id: c.id },
      data: { nextSeq: step.seq + 1, awaitingStepId: null, version: { increment: 1 } },
    });
    await this.audit.record(tx, {
      action: 'juristic.collection_step_executed',
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      subjectType: 'juristic.collection_case',
      subjectId: c.id,
      metadata: {
        seq: step.seq,
        action: step.action,
        outcome,
        reason: extra.reason ?? null,
        amount: extra.amount ?? null,
      },
    });
    await this.events.record(tx, {
      type: 'juristic.collection.step_executed',
      aggregateType: 'collection_case',
      aggregateId: c.id,
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      payload: {
        caseId: c.id,
        stepId: step.id,
        seq: step.seq,
        action: step.action,
        outcome,
        channels: step.channels,
        reason: extra.reason ?? null,
        amount: extra.amount ?? null,
        unitId: c.unitId,
        partyId: c.partyId,
      },
    });
  }

  /** Runs a step's effect (re-checking its gate) and records it. */
  private async perform(
    tx: Tx,
    c: CollectionCase,
    step: CollectionStep,
    gates: Gates,
    approved: boolean,
  ): Promise<void> {
    const closed = this.closedReason(step.action, gates);
    if (closed) return this.finish(tx, c, step, 'skipped', { reason: closed });
    const info = await this.info(tx, c);
    const notify = async (type: DomainEventType, extra: Record<string, unknown> = {}) =>
      this.events.record(tx, {
        type,
        aggregateType: 'collection_case',
        aggregateId: c.id,
        tenantId: c.tenantId,
        buildingId: c.buildingId,
        payload: {
          caseId: c.id,
          stepId: step.id,
          action: step.action,
          channels: step.channels,
          ...info,
          ...extra,
        },
      });
    switch (step.action) {
      case 'remind':
        await notify('juristic.collection.reminder');
        return this.finish(tx, c, step, 'sent', { payload: { amountDue: info.amountDue } });
      case 'surcharge':
        return this.surcharge(tx, c, step, gates, info, notify);
      case 'notice_letter':
      case 'lawyer_letter':
        await notify(
          step.action === 'notice_letter'
            ? 'juristic.collection.notice_letter'
            : 'juristic.collection.lawyer_letter',
          { templateVersion: gates.lettersTemplateVersion },
        );
        return this.finish(tx, c, step, 'sent', {
          payload: { templateVersion: gates.lettersTemplateVersion, amountDue: info.amountDue },
        });
      case 'suspend_services': {
        const check = evaluateSuspendServices({
          legalForm: c.legalForm,
          enabled: gates.suspendEnabled,
          minOverdueDays: gates.suspendMinOverdueDays,
          daysOverdue: info.daysOverdue,
          approved,
          services: gates.suspendServices,
        });
        if (check.violated)
          return this.finish(tx, c, step, 'skipped', {
            reason: `${check.ruleId}:${(check.errors ?? []).map((e) => e.code).join(',')}`,
          });
        await notify('juristic.collection.services_suspended', { services: gates.suspendServices });
        return this.finish(tx, c, step, 'sent', { payload: { services: gates.suspendServices } });
      }
      case 'legal_action':
        await notify('juristic.collection.legal_action');
        return this.finish(tx, c, step, 'sent', { payload: { amountDue: info.amountDue } });
      default:
        return this.finish(tx, c, step, 'skipped', { reason: 'unknown_action' });
    }
  }

  /**
   * The surcharge of a step (rule `compliance.<legal_form>_surcharge_cap`): on the open principal of each overdue
   * invoice since the case was last surcharged; queued as a `late_fee` charge (source `penalty`) for the next monthly
   * cycle — never added to an issued invoice (D-040).
   */
  private async surcharge(
    tx: Tx,
    c: CollectionCase,
    step: CollectionStep,
    gates: Gates,
    info: Awaited<ReturnType<CollectionsService['info']>>,
    notify: (type: DomainEventType, extra?: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    const check = evaluateSurchargeCap({
      legalForm: c.legalForm,
      enabled: gates.surchargeEnabled,
      ratePct: gates.ratePct,
      capPct: gates.surchargeRateCap,
      escalatedRatePct: gates.escalatedRatePct,
      escalatedCapPct: gates.escalatedCapPct,
    });
    if (check.violated || c.legalForm === 'voluntary' || c.legalForm === 'lease_contract')
      return this.finish(tx, c, step, 'skipped', {
        reason: `${check.ruleId}:${(check.errors ?? []).map((e) => e.code).join(',') || 'no_rule'}`,
      });
    const today = this.today();
    const overdue = this.overdueOf(await this.openInvoices(tx, c), today);
    const open = await this.payments.surchargeOpen(
      tx,
      overdue.map((i) => i.id),
    );
    const result = computeSurcharge(
      overdue.map((i) => ({
        invoiceId: i.id,
        dueOn: day(i.dueDate!),
        principal: D(i.balance)
          .minus(open.get(i.id) ?? 0)
          .toFixed(2),
      })),
      {
        ratePct: gates.ratePct!,
        capPct: gates.surchargeRateCap!,
        escalatedRatePct: gates.escalatedRatePct,
        escalatedCapPct: gates.escalatedCapPct,
        escalateAfterDays: gates.escalateAfterDays,
      },
      today,
      c.surchargedThrough ? day(c.surchargedThrough) : null,
    );
    if (D(result.total).lte(0))
      return this.finish(tx, c, step, 'skipped', { reason: 'nothing_to_surcharge' });
    const charge = await tx.invoiceCharge.create({
      data: {
        tenantId: c.tenantId,
        buildingId: c.buildingId,
        unitId: c.unitId,
        partyId: c.partyId,
        sourceType: 'penalty',
        lineKind: 'late_fee',
        sourceId: c.id,
        description: `เงินเพิ่มชำระล่าช้า ${result.parts.length} ใบแจ้งหนี้ ถึงวันที่ ${today}`,
        quantity: '1.000',
        unitPrice: D(result.total).toFixed(4),
        amount: result.total,
        createdBy: by(),
      },
    });
    await tx.collectionCase.update({ where: { id: c.id }, data: { surchargedThrough: asDate(today) } });
    await this.events.record(tx, {
      type: 'invoice_charge.queued',
      aggregateType: 'invoice_charge',
      aggregateId: charge.id,
      tenantId: c.tenantId,
      buildingId: c.buildingId,
      payload: { chargeId: charge.id, unitId: c.unitId, partyId: c.partyId, amount: result.total },
    });
    await notify('juristic.collection.surcharge_added', { amount: result.total });
    return this.finish(tx, c, step, 'sent', {
      amount: result.total,
      invoiceChargeId: charge.id,
      payload: {
        ruleId: check.ruleId,
        ratePct: gates.ratePct,
        capPct: gates.surchargeRateCap,
        parts: result.parts,
      } as unknown as Record<string, unknown>,
    });
  }

  // ------------------------------------------------------------------------------------------- operator actions

  private async loadCase(tx: Tx, ctx: TenantContext, id: string): Promise<CollectionCaseRow> {
    const c = this.found(
      await tx.collectionCase.findFirst({ where: this.own(ctx, { id }), include: CASE_INCLUDE }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(c.buildingId))
      throw new DomainException('http.not_found');
    return c;
  }

  get(ctx: TenantContext, id: string): Promise<CollectionCaseRow> {
    return this.db.tenant(ctx, (tx) => this.loadCase(tx, ctx, id));
  }

  list(
    ctx: TenantContext,
    q: { state?: CollectionCaseState; unitId?: string; partyId?: string; skip: number; take: number },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const where: Prisma.CollectionCaseWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.partyId ? { partyId: q.partyId } : {}),
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.collectionCase.findMany({
          where,
          include: CASE_INCLUDE,
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.collectionCase.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /** The next step of a case for the console (null when resolved or nothing left). */
  nextStep(
    c: Pick<CollectionCaseRow, 'state' | 'nextSeq' | 'awaitingStepId' | 'anchorOn' | 'pausedDays'> & {
      ladder: { steps: CollectionStep[] };
    },
  ): NextStep | null {
    if (c.state === 'resolved') return null;
    const step = c.awaitingStepId
      ? c.ladder.steps.find((s) => s.id === c.awaitingStepId)
      : c.ladder.steps.find((s) => s.seq >= c.nextSeq && s.enabled);
    if (!step) return null;
    return {
      stepId: step.id,
      seq: step.seq,
      action: step.action,
      dueOn: stepDueOn(day(c.anchorOn), step.offsetDays, c.pausedDays),
      legalReviewRequired: legalReviewRequired(step.action),
      awaitingApproval: c.awaitingStepId === step.id,
    };
  }

  /** `…/actions/open-dispute`: the ladder pauses while the dispute is open; the resident is told. */
  async openDispute(ctx: TenantContext, id: string, reason: string): Promise<CollectionCaseRow> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 1000)
      throw invalid('reason', 'length', 'between 3 and 1000 characters');
    await this.db.tenant(ctx, async (tx) => {
      await this.loadCase(tx, ctx, id);
      await this.lockCase(tx, id);
      const c = await tx.collectionCase.findUniqueOrThrow({ where: { id } });
      if (c.state === 'resolved' || c.disputeOpenedAt)
        throw new DomainException('collections.invalid_state', { params: { state: c.state } });
      await tx.collectionCase.update({
        where: { id },
        data: { disputeOpenedAt: this.now(), disputeReason: text, version: { increment: 1 } },
      });
      await this.timeline(tx, c, 'dispute_opened', { reason: text });
      await this.pause(tx, id, 'dispute', text);
      await this.audit.record(tx, {
        action: 'juristic.collection_dispute_opened',
        tenantId: c.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.collection_case',
        subjectId: id,
        metadata: { reason: text },
      });
      const info = await this.info(tx, c);
      await this.events.record(tx, {
        type: 'juristic.collection.dispute_opened',
        aggregateType: 'collection_case',
        aggregateId: id,
        tenantId: c.tenantId,
        buildingId: c.buildingId,
        payload: { caseId: id, reason: text, ...info },
      });
    });
    return this.get(ctx, id);
  }

  /** `…/actions/close-dispute`: the ladder resumes (unless a plan still holds it); the resident is told. */
  async closeDispute(ctx: TenantContext, id: string, reason: string): Promise<CollectionCaseRow> {
    const text = reason.trim();
    if (text.length < 3 || text.length > 1000)
      throw invalid('reason', 'length', 'between 3 and 1000 characters');
    await this.db.tenant(ctx, async (tx) => {
      await this.loadCase(tx, ctx, id);
      await this.lockCase(tx, id);
      const c = await tx.collectionCase.findUniqueOrThrow({ where: { id } });
      if (!c.disputeOpenedAt || c.state === 'resolved')
        throw new DomainException('collections.invalid_state', { params: { state: c.state } });
      await tx.collectionCase.update({
        where: { id },
        data: { disputeOpenedAt: null, disputeReason: null, version: { increment: 1 } },
      });
      await this.timeline(tx, c, 'dispute_closed', { reason: text });
      await this.resume(tx, id, 'dispute_closed');
      await this.audit.record(tx, {
        action: 'juristic.collection_dispute_closed',
        tenantId: c.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.collection_case',
        subjectId: id,
        metadata: { reason: text },
      });
      const info = await this.info(tx, c);
      await this.events.record(tx, {
        type: 'juristic.collection.dispute_closed',
        aggregateType: 'collection_case',
        aggregateId: id,
        tenantId: c.tenantId,
        buildingId: c.buildingId,
        payload: { caseId: id, reason: text, ...info },
      });
    });
    return this.get(ctx, id);
  }

  /**
   * Approve (runs the step now, its gate re-checked) or refuse (the ladder moves on) the step a case waits on —
   * owner / manager / committee (`juristic.collections.approve`).
   */
  async decide(
    ctx: TenantContext,
    id: string,
    decision: 'approve' | 'refuse',
    reason: string | null,
  ): Promise<CollectionCaseRow> {
    if (decision === 'refuse') {
      const text = reason?.trim() ?? '';
      if (text.length < 3 || text.length > 1000)
        throw invalid('reason', 'length', 'between 3 and 1000 characters');
    }
    await this.db.tenant(
      ctx,
      async (tx) => {
        await this.loadCase(tx, ctx, id);
        await this.lockCase(tx, id);
        const c = await tx.collectionCase.findUniqueOrThrow({ where: { id } });
        if (!c.awaitingStepId) throw new DomainException('collections.no_pending_approval');
        if (c.state !== 'open')
          throw new DomainException('collections.invalid_state', { params: { state: c.state } });
        const step = await tx.collectionStep.findUniqueOrThrow({ where: { id: c.awaitingStepId } });
        if (decision === 'refuse') return this.finish(tx, c, step, 'refused', { reason: reason!.trim() });
        await this.timeline(tx, c, 'step', { step, outcome: 'approved', reason: reason?.trim() || null });
        await this.perform(tx, c, step, await this.gates(c.tenantId, c.legalForm), true);
      },
      { timeout: 60_000 },
    );
    return this.get(ctx, id);
  }

  /** Days from a due date to today (Bangkok). */
  daysOverdue(dueOn: string): number {
    return Math.max(0, daysBetween(dueOn, this.today()));
  }

  /** The legal-form gates of every step (console badges): the reason a step is closed now, or null. */
  async stepGates(tenantId: string, ladder: CollectionLadderRow): Promise<Map<string, string | null>> {
    const g = await this.gates(tenantId, ladder.legalForm);
    return new Map(ladder.steps.map((s) => [s.id, this.closedReason(s.action, g)]));
  }
}

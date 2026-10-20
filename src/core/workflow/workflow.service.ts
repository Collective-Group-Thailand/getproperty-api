import { actorEnvelope } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type Prisma, type WorkflowInstance } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { BusinessCalendarService } from '../calendar/business-calendar.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { SettingsService } from '../settings/settings.service';
import {
  allowedEvents,
  type Plan,
  planStart,
  planTransition,
  specFromRow,
  type WorkflowDefinitionSpec,
  WorkflowTransitionError,
} from './engine';

export { specFromRow, specToRow } from './engine';

/** SLA `settingKey`s with this prefix read a number from the instance context instead of a setting. */
export const CONTEXT_PREFIX = 'context.';

export type WorkflowGuard = (instance: WorkflowInstance, data: Record<string, unknown>) => boolean;

export interface StartInput {
  tenantId: string;
  buildingId?: string | null;
  subjectType: string;
  subjectId: string;
  definitionKey: string;
  context?: Record<string, unknown>;
  /** When the SLA clock started (default now): e.g. the move-out time of a deposit settlement opened later. */
  clockStart?: Date;
}

/**
 * Workflow engine host (D-159): persists the engine's plans in `ops.workflow_instance/event/timer`, records
 * `workflow.*` domain events through the outbox, resolves SLA settings and the business calendar. Callers pass
 * their transaction so a business change and its workflow step commit together. Timers fire in the worker
 * (`WorkflowTimers`): exactly once, through `fired_at` claimed under a row lock.
 */
@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);
  private readonly guards = new Map<string, WorkflowGuard>();

  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    private readonly settings: SettingsService,
    private readonly calendars: BusinessCalendarService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Definitions (platform and tenant), newest version first per key. */
  listDefinitions() {
    return this.db.platform((tx) =>
      tx.workflowDefinition.findMany({ orderBy: [{ key: 'asc' }, { version: 'desc' }] }),
    );
  }

  /** Modules register the named guards their definitions use (e.g. B2.4 `deductions_have_evidence`). */
  registerGuard(name: string, guard: WorkflowGuard): void {
    this.guards.set(name, guard);
  }

  async definitionFor(tx: Tx, key: string, tenantId: string, version?: number) {
    const rows = await tx.workflowDefinition.findMany({
      where: { key, isActive: true, OR: [{ tenantId }, { tenantId: null }], ...(version ? { version } : {}) },
      orderBy: [{ version: 'desc' }],
    });
    const row = rows.find((r) => r.tenantId === tenantId) ?? rows.find((r) => r.tenantId === null);
    if (!row) throw new Error(`workflow definition ${key} is not seeded`);
    return { row, spec: specFromRow(row) };
  }

  /**
   * SLA values of a definition: settings in force at `at`, or — for `context.<name>` keys — a number stored in the
   * instance context when it started (e.g. the SLA hours of a service request's category, D-072).
   */
  private async settingLookup(
    spec: WorkflowDefinitionSpec,
    tenantId: string,
    at: Date,
    context: Record<string, unknown> = {},
  ) {
    const values = new Map<string, number>();
    for (const s of spec.states) {
      const key = s.sla?.settingKey;
      if (key && !values.has(key)) {
        if (key.startsWith(CONTEXT_PREFIX)) {
          values.set(key, Number(context[key.slice(CONTEXT_PREFIX.length)]));
          continue;
        }
        const v = await this.settings.at(key, at, { tenantId });
        values.set(key, Number(v?.value));
      }
    }
    return (key: string) => values.get(key);
  }

  async start(tx: Tx, input: StartInput): Promise<WorkflowInstance> {
    const now = this.clock.now();
    const { row, spec } = await this.definitionFor(tx, input.definitionKey, input.tenantId);
    const clockStart =
      input.clockStart && input.clockStart.getTime() < now.getTime() ? input.clockStart : now;
    const plan = planStart(
      spec,
      now,
      await this.calendars.calendar(),
      // the SLA settings in force now (when the instance opens), even for a clock started earlier
      await this.settingLookup(spec, input.tenantId, now, input.context),
      clockStart,
    );
    const instance = await tx.workflowInstance.create({
      data: {
        tenantId: input.tenantId,
        buildingId: input.buildingId ?? null,
        definitionId: row.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        state: plan.to,
        stateEnteredAt: now,
        slaDueAt: plan.slaDueAt,
        startedAt: clockStart,
        context: (input.context ?? {}) as Prisma.InputJsonValue,
      },
    });
    await this.persistPlan(tx, instance, plan, 'start', {}, now, spec);
    return instance;
  }

  /** Applies `event`; 409 `workflow.invalid_transition` / `workflow.guard_failed` when not allowed. */
  async transition(
    tx: Tx,
    instanceId: string,
    event: string,
    data: Record<string, unknown> = {},
  ): Promise<WorkflowInstance> {
    const now = this.clock.now();
    const instance = await tx.workflowInstance.findUnique({
      where: { id: instanceId },
      include: { definition: true },
    });
    if (!instance) throw new DomainException('http.not_found');
    const spec = specFromRow(instance.definition);
    let plan: Plan;
    try {
      plan = planTransition(
        spec,
        { state: instance.state, startedAt: instance.startedAt, slaDueAt: instance.slaDueAt },
        event,
        now,
        await this.calendars.calendar(),
        await this.settingLookup(
          spec,
          instance.tenantId,
          now,
          (instance.context ?? {}) as Record<string, unknown>,
        ),
        (name) => {
          const guard = this.guards.get(name);
          return guard ? guard(instance, data) : false;
        },
      );
    } catch (error) {
      if (error instanceof WorkflowTransitionError)
        throw new DomainException(
          error.reason === 'guard_failed' ? 'workflow.guard_failed' : 'workflow.invalid_transition',
          { params: { event, state: instance.state } },
        );
      throw error;
    }
    const updated = await tx.workflowInstance.updateMany({
      where: { id: instance.id, version: instance.version },
      data: {
        state: plan.to,
        stateEnteredAt: now,
        slaDueAt: plan.slaDueAt,
        closedAt: plan.closed ? now : null,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new DomainException('concurrency.stale');
    const fresh = await tx.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    await this.persistPlan(tx, fresh, plan, event, data, now, spec);
    return fresh;
  }

  /**
   * Host-scheduled steps of an instance (timer kind `step`, fired once by the worker as `workflow.step_due`): e.g. the
   * dunning reminders on the days of `reminders.schedule` (B4.5). Steps already in the past are not created.
   */
  async addStepTimers(tx: Tx, instance: WorkflowInstance, fireAts: readonly Date[]) {
    const now = this.clock.now();
    const timers = [];
    for (const fireAt of fireAts)
      timers.push(
        await tx.workflowTimer.create({
          data: {
            tenantId: instance.tenantId,
            instanceId: instance.id,
            kind: 'step',
            fireAt: fireAt.getTime() < now.getTime() ? now : fireAt,
          },
        }),
      );
    return timers;
  }

  /** Events allowed now (UI next actions). */
  async allowedEvents(tx: Tx, instance: WorkflowInstance): Promise<string[]> {
    const def = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: instance.definitionId } });
    return allowedEvents(specFromRow(def), instance.state);
  }

  private async persistPlan(
    tx: Tx,
    instance: WorkflowInstance,
    plan: Plan,
    event: string,
    data: Record<string, unknown>,
    now: Date,
    spec: WorkflowDefinitionSpec,
  ): Promise<void> {
    if (plan.cancelTimers) {
      await tx.workflowTimer.updateMany({
        where: { instanceId: instance.id, firedAt: null, cancelledAt: null },
        data: { cancelledAt: now },
      });
    }
    const timers = [];
    for (const t of plan.timers) {
      timers.push(
        await tx.workflowTimer.create({
          data: { tenantId: instance.tenantId, instanceId: instance.id, kind: t.kind, fireAt: t.fireAt },
        }),
      );
    }
    const type = plan.from === null ? 'workflow.started' : 'workflow.transitioned';
    const envelope = await this.events.record(tx, {
      type,
      aggregateType: 'workflow_instance',
      aggregateId: instance.id,
      tenantId: instance.tenantId,
      buildingId: instance.buildingId,
      payload: {
        instanceId: instance.id,
        definitionKey: spec.key,
        definitionVersion: spec.version,
        subjectType: instance.subjectType,
        subjectId: instance.subjectId,
        from: plan.from,
        to: plan.to,
        event,
        closed: plan.closed,
        slaDueAt: plan.slaDueAt?.toISOString() ?? null,
        timers: timers.map((t) => ({ id: t.id, kind: t.kind, fireAt: t.fireAt.toISOString() })),
      },
    });
    await tx.workflowEvent.create({
      data: {
        tenantId: instance.tenantId,
        instanceId: instance.id,
        fromState: plan.from,
        toState: plan.to,
        event,
        actor: actorEnvelope(RequestContext.actor()),
        occurredAt: now,
        data: data as Prisma.InputJsonValue,
        domainEventId: envelope.id,
      },
    });
  }

  /** For logs and tests. */
  get loggerName(): string {
    return this.logger instanceof Logger ? WorkflowService.name : '';
  }
}

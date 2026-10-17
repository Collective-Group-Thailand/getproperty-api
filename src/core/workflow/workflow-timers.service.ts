import { actorEnvelope, systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';

interface DueTimer {
  id: string;
  kind: 'sla_warn' | 'sla_breach' | 'step' | 'reminder';
  instance_id: string;
  tenant_id: string;
}

/**
 * Fires workflow timers (D-159) in the worker: the BullMQ delayed job of a timer (`fireOne`) and the sweep
 * (`fireDue`, repeatable every 30 s, catches anything a lost job missed). A timer fires **once**: it is claimed
 * with `FOR UPDATE SKIP LOCKED` and `fired_at IS NULL`; the instance's `sla_warned_at` / `sla_breached_at` are set
 * only when still null, so the `workflow.sla_warning` / `workflow.sla_breached` events are emitted once even when
 * a job and the sweep race.
 */
@Injectable()
export class WorkflowTimers {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  fireDue(limit = 200): Promise<number> {
    return this.fire(null, limit);
  }

  async fireOne(timerId: string): Promise<boolean> {
    return (await this.fire(timerId, 1)) === 1;
  }

  private async fire(timerId: string | null, limit: number): Promise<number> {
    const now = this.clock.now();
    return RequestContext.run({ actor: systemActor('workflow-timers') }, () =>
      this.db.platform(async (tx) => {
        const due = await tx.$queryRaw<DueTimer[]>`
          SELECT t.id, t.kind::text AS kind, t.instance_id, t.tenant_id
            FROM ops.workflow_timer t JOIN ops.workflow_instance i ON i.id = t.instance_id
           WHERE t.fired_at IS NULL AND t.cancelled_at IS NULL AND t.fire_at <= ${now.toISOString()}::timestamptz
             AND i.closed_at IS NULL AND (${timerId}::uuid IS NULL OR t.id = ${timerId}::uuid)
           ORDER BY t.fire_at
           LIMIT ${limit}
           FOR UPDATE OF t SKIP LOCKED`;
        for (const timer of due) {
          await tx.workflowTimer.update({
            where: { id: timer.id },
            data: { firedAt: now, attempt: { increment: 1 } },
          });
          if (timer.kind !== 'sla_warn' && timer.kind !== 'sla_breach') continue;
          const column = timer.kind === 'sla_warn' ? 'slaWarnedAt' : 'slaBreachedAt';
          const marked = await tx.workflowInstance.updateMany({
            where: { id: timer.instance_id, closedAt: null, [column]: null },
            data: { [column]: now },
          });
          if (marked.count !== 1) continue;
          const instance = await tx.workflowInstance.findUniqueOrThrow({
            where: { id: timer.instance_id },
            include: { definition: { select: { key: true, version: true } } },
          });
          const type = timer.kind === 'sla_warn' ? 'workflow.sla_warning' : 'workflow.sla_breached';
          const envelope = await this.events.record(tx, {
            type,
            aggregateType: 'workflow_instance',
            aggregateId: instance.id,
            tenantId: instance.tenantId,
            buildingId: instance.buildingId,
            payload: {
              instanceId: instance.id,
              definitionKey: instance.definition.key,
              subjectType: instance.subjectType,
              subjectId: instance.subjectId,
              state: instance.state,
              slaDueAt: instance.slaDueAt?.toISOString() ?? null,
              timerId: timer.id,
            },
          });
          await tx.workflowEvent.create({
            data: {
              tenantId: instance.tenantId,
              instanceId: instance.id,
              fromState: instance.state,
              toState: instance.state,
              event: timer.kind === 'sla_warn' ? 'sla_warning' : 'sla_breached',
              actor: actorEnvelope(RequestContext.actor()),
              occurredAt: now,
              data: { timerId: timer.id },
              domainEventId: envelope.id,
            },
          });
        }
        return due.length;
      }),
    );
  }
}

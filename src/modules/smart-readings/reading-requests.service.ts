import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { operators, registerNotifiable, tenantName } from '@core/notifications/notifiable-events';
import { AccessService } from '@core/tenancy/access.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type ReadingRequest } from '@generated/prisma/client';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { ReadingRoundsService } from './reading-rounds.service';

const by = () => userIdOf(RequestContext.actor());

export interface ReadingRequestInput {
  /** The meter assignments to read; omitted = every meter of the cycle's buildings still missing in the round. */
  meterAssignmentIds?: string[];
  /** A staff login (with `reading.capture` on the building) to assign; null/omitted = any staff. */
  assigneeUserId?: string | null;
  note?: string | null;
}

/**
 * "Request reading → staff task" (web F2 2.3, D-208): the owner asks staff to read meters of a billing cycle still
 * waiting for readings — every missing meter or the ones picked, optionally assigned to one staff login. One open
 * `smart.reading_request` per meter assignment (repeating re-assigns it); the next accepted or pending-review reading
 * of that assignment fulfils it (subscriber). The reading round shows the assignee and B5.4 lists the requests as
 * staff tasks. Notifies the assignee (or the staff of the tenant) through `reading.requested`.
 */
@Injectable()
export class ReadingRequestsService extends TenantScopedRepository implements EventSubscriber, OnModuleInit {
  readonly name = 'reading-requests';
  readonly eventTypes = ['reading.accepted', 'reading.review_requested'] as const;

  constructor(
    private readonly db: TenantTx,
    private readonly rounds: ReadingRoundsService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    this.registry.register(this);
    registerNotifiable('reading.requested', async (tx, e) => {
      if (!e.tenantId) return null;
      const assignee = e.payload.assigneeUserId as string | null | undefined;
      const recipients = (await operators(tx, e.tenantId, ['owner', 'manager', 'staff'], 'staff')).filter(
        (r) => (assignee ? r.id === assignee : r.audience === 'staff'),
      );
      return {
        recipients,
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          request: { count: e.payload.count, periodKey: e.payload.periodKey ?? '-' },
        },
      };
    });
  }

  /** Fulfils the open request of the reading's meter assignment (any source, any reader). */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const readingId = event.payload.readingId as string | undefined;
    if (readingId) await this.fulfilIn(tx, readingId);
  }

  /**
   * Fulfils the open request of a reading's meter assignment (idempotent: the subscriber finds nothing left when the
   * staff task already fulfilled it, B5.4). Returns the fulfilled request, or null.
   */
  async fulfilIn(tx: Tx, readingId: string): Promise<ReadingRequest | null> {
    const reading = await tx.meterReading.findUnique({
      where: { id: readingId },
      select: { id: true, meterAssignmentId: true, readAt: true },
    });
    if (!reading) return null;
    const open = await tx.readingRequest.findFirst({
      where: { meterAssignmentId: reading.meterAssignmentId, status: 'open' },
    });
    if (!open || reading.readAt.getTime() < open.requestedAt.getTime() - 86_400_000) return null;
    return tx.readingRequest.update({
      where: { id: open.id },
      data: { status: 'fulfilled', fulfilledAt: this.clock.now(), fulfilledReadingId: reading.id },
    });
  }

  async request(
    ctx: TenantContext,
    billingCycleId: string,
    input: ReadingRequestInput,
  ): Promise<{ cycle: { id: string; periodKey: string }; requests: (ReadingRequest & { code: string })[] }> {
    const cycle = await this.db.tenant(ctx, async (tx) =>
      this.found(await tx.billingCycle.findFirst({ where: this.own(ctx, { id: billingCycleId }) })),
    );
    if (!['open', 'readings_pending', 'computed'].includes(cycle.status))
      throw new DomainException('billing_cycle.invalid_state', { params: { status: cycle.status } });
    const buildings = await this.db.tenant(ctx, (tx) =>
      tx.building.findMany({
        where: {
          propertyId: cycle.propertyId,
          deletedAt: null,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
          ...(ctx.buildingIds ? { id: { in: [...ctx.buildingIds] } } : {}),
        },
        select: { id: true },
      }),
    );
    const buildingIds = buildings.map((b) => b.id);
    let targets: string[];
    if (input.meterAssignmentIds?.length) {
      const unique = [...new Set(input.meterAssignmentIds)];
      const found = await this.db.tenant(ctx, (tx) =>
        tx.meterAssignment.findMany({
          where: { id: { in: unique }, buildingId: { in: buildingIds }, validTo: null },
          select: { id: true },
        }),
      );
      if (found.length !== unique.length) throw new DomainException('http.not_found');
      targets = unique;
    } else {
      targets = [];
      for (const b of buildingIds)
        for (const round of await this.rounds.current(ctx, b))
          for (const f of round.floors) targets.push(...f.items.map((i) => i.meterAssignmentId));
    }
    const assignee = input.assigneeUserId ?? null;
    if (assignee) {
      const a = await this.access.operator(assignee, ctx.tenantId);
      if (!a || !a.permissions.has('reading.capture'))
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'assigneeUserId',
              code: 'notStaff',
              message: 'a member of the tenant who captures readings',
            },
          ],
        });
    }
    const now = this.clock.now();
    const requests = await this.db.tenant(ctx, async (tx) => {
      const out: (ReadingRequest & { code: string })[] = [];
      for (const id of targets) {
        const m = await tx.meterAssignment.findUniqueOrThrow({
          where: { id },
          select: { id: true, assetItemId: true, buildingId: true, code: true },
        });
        if (assignee) {
          const a = await this.access.operator(assignee, ctx.tenantId);
          if (a?.buildingIds && !a.buildingIds.includes(m.buildingId))
            throw new DomainException('validation.failed', {
              errors: [
                {
                  path: 'assigneeUserId',
                  code: 'buildingScope',
                  message: 'the staff member does not work there',
                },
              ],
            });
        }
        const open = await tx.readingRequest.findFirst({ where: { meterAssignmentId: id, status: 'open' } });
        const row = open
          ? await tx.readingRequest.update({
              where: { id: open.id },
              data: {
                assigneeUserId: assignee,
                billingCycleId: cycle.id,
                dueAt: cycle.graceDeadlineAt,
                note: input.note ?? open.note,
                updatedBy: by(),
              },
            })
          : await tx.readingRequest.create({
              data: {
                tenantId: ctx.tenantId,
                buildingId: m.buildingId,
                billingCycleId: cycle.id,
                meterAssignmentId: m.id,
                assetItemId: m.assetItemId,
                assigneeUserId: assignee,
                requestedAt: now,
                dueAt: cycle.graceDeadlineAt,
                note: input.note ?? null,
                createdBy: by(),
              },
            });
        out.push({ ...row, code: m.code });
      }
      if (!cycle.readingsRequestedAt)
        await tx.billingCycle.update({
          where: { id: cycle.id },
          data: { readingsRequestedAt: now, version: { increment: 1 } },
        });
      await this.audit.record(tx, {
        action: 'reading.requested',
        tenantId: ctx.tenantId,
        subjectType: 'ops.billing_cycle',
        subjectId: cycle.id,
        metadata: { count: out.length, assigneeUserId: assignee },
      });
      if (out.length)
        await this.events.record(tx, {
          type: 'reading.requested',
          aggregateType: 'billing_cycle',
          aggregateId: cycle.id,
          tenantId: ctx.tenantId,
          payload: {
            billingCycleId: cycle.id,
            periodKey: cycle.periodKey,
            count: out.length,
            assigneeUserId: assignee,
            requestIds: out.map((r) => r.id),
            buildingIds: [...new Set(out.map((r) => r.buildingId))],
          },
        });
      return out;
    });
    return { cycle: { id: cycle.id, periodKey: cycle.periodKey }, requests };
  }
}

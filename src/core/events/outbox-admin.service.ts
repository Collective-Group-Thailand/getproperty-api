import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import { type ConsumptionState, type OutboxState } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { QUEUE, QUEUE_NAMES, type QueuePort } from '../queue/queue.port';
import { type SubscriberJob, subscriberJobId } from './event-consumer.service';

/**
 * Dead letters (B1.3 "dead-letter + admin replay"): outbox messages that could not be relayed and subscriber
 * deliveries that exhausted their retries. A replay re-queues the message or the (event, subscriber) job with a new
 * job id; subscribers are idempotent on the inbox, so replaying something that already succeeded does nothing.
 */
@Injectable()
export class OutboxAdminService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  listMessages(state: OutboxState | undefined, take: number) {
    return this.db.platform((tx) =>
      tx.outboxMessage.findMany({
        where: state ? { state } : { state: { in: ['failed', 'dead'] } },
        include: { event: { select: { type: true, tenantId: true, occurredAt: true } } },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    );
  }

  listConsumptions(state: ConsumptionState | undefined, take: number) {
    return this.db.platform((tx) =>
      tx.eventConsumption.findMany({
        where: state ? { state } : { state: { in: ['failed', 'dead'] } },
        include: { event: { select: { type: true, tenantId: true, occurredAt: true } } },
        orderBy: { updatedAt: 'desc' },
        take,
      }),
    );
  }

  async replayMessage(id: string) {
    return this.db.platform(async (tx) => {
      const m = await tx.outboxMessage.findUnique({ where: { id } });
      if (!m) throw new DomainException('http.not_found');
      if (m.state === 'pending' || m.state === 'publishing')
        throw new DomainException('outbox.not_replayable');
      const updated = await tx.outboxMessage.update({
        where: { id },
        data: { state: 'pending', attempts: 0, nextAttemptAt: this.clock.now(), lastError: null },
      });
      await this.audit.record(tx, {
        action: 'outbox.replayed',
        subjectType: 'platform.outbox_message',
        subjectId: id,
        before: { state: m.state, attempts: m.attempts },
      });
      return updated;
    });
  }

  async replayConsumption(id: string) {
    const now = this.clock.now();
    const row = await this.db.platform(async (tx) => {
      const c = await tx.eventConsumption.findUnique({ where: { id } });
      if (!c) throw new DomainException('http.not_found');
      if (c.state === 'processed') throw new DomainException('outbox.not_replayable');
      const updated = await tx.eventConsumption.update({
        where: { id },
        data: { replayedAt: now, replayedBy: userIdOf(RequestContext.actor()) },
      });
      await this.audit.record(tx, {
        action: 'outbox.replayed',
        subjectType: 'platform.event_consumption',
        subjectId: id,
        before: { state: c.state, attempts: c.attempts, subscriber: c.subscriber },
      });
      return updated;
    });
    await this.queue.add<SubscriberJob>(
      QUEUE_NAMES.subscribers,
      row.subscriber,
      { eventId: row.eventId, subscriber: row.subscriber },
      { jobId: `${subscriberJobId(row.eventId, row.subscriber)}__replay-${now.getTime()}` },
    );
    return row;
  }
}

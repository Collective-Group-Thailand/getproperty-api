import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { QUEUE, QUEUE_NAMES, type QueueJob, type QueuePort } from '../queue/queue.port';
import { envelopeOf } from './domain-events';
import { EventSubscriberRegistry } from './subscribers';

export interface DispatchJob {
  eventId: string;
}
export interface SubscriberJob {
  eventId: string;
  subscriber: string;
}

/** BullMQ custom job ids must not contain ':'. */
export const subscriberJobId = (eventId: string, subscriber: string) => `${eventId}__${subscriber}`;

/**
 * Worker side of the outbox: `dispatch` fans a relayed event out to one job per matching subscriber;
 * `consume` runs one subscriber exactly once per event — the inbox row (`platform.event_consumption`, state
 * `processed`) is written in the same transaction as the subscriber's effects, so a redelivered event (duplicate
 * relay, retried job, replay) finds it and does nothing. Failures are recorded (`failed`, then `dead` on the last
 * attempt) and rethrown so BullMQ retries with backoff.
 */
@Injectable()
export class EventConsumer {
  private readonly logger = new Logger(EventConsumer.name);

  constructor(
    private readonly db: TenantTx,
    private readonly registry: EventSubscriberRegistry,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async dispatch(job: QueueJob<DispatchJob>): Promise<void> {
    const event = await this.db.platform((tx) =>
      tx.domainEvent.findUnique({ where: { id: job.data.eventId }, select: { id: true, type: true } }),
    );
    if (!event) {
      this.logger.warn(`dispatch: event ${job.data.eventId} not found`);
      return;
    }
    for (const subscriber of this.registry.for(event.type)) {
      await this.queue.add<SubscriberJob>(
        QUEUE_NAMES.subscribers,
        subscriber.name,
        { eventId: event.id, subscriber: subscriber.name },
        { jobId: subscriberJobId(event.id, subscriber.name) },
      );
    }
  }

  /** Returns `processed`, or `skipped` when this subscriber already handled the event. */
  async consume(job: QueueJob<SubscriberJob>): Promise<'processed' | 'skipped'> {
    const { eventId, subscriber: name } = job.data;
    const subscriber = this.registry.get(name);
    if (!subscriber) throw new Error(`unknown subscriber ${name}`);
    const now = this.clock.now();
    try {
      const outcome = await this.db.platform(async (tx) => {
        const row = await tx.domainEvent.findUnique({ where: { id: eventId } });
        if (!row) throw new Error(`event ${eventId} not found`);
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO platform.event_consumption (event_id, subscriber, state, attempts, processed_at)
          VALUES (${eventId}::uuid, ${name}, 'processed', 1, ${now.toISOString()}::timestamptz)
          ON CONFLICT (event_id, subscriber) DO UPDATE
             SET state = 'processed', processed_at = EXCLUDED.processed_at,
                 attempts = platform.event_consumption.attempts + 1, last_error = NULL
           WHERE platform.event_consumption.state <> 'processed'
          RETURNING id`;
        if (claimed.length === 0) return { status: 'skipped' as const, envelope: null };
        const envelope = envelopeOf(row);
        if (envelope.tenantId)
          await tx.$queryRaw`SELECT set_config('app.tenant_id', ${envelope.tenantId}, true)`;
        await RequestContext.run(
          {
            actor: systemActor(`subscriber:${name}`),
            correlationId: envelope.correlationId,
            causationId: envelope.id,
          },
          () => subscriber.handle(envelope, tx),
        );
        return { status: 'processed' as const, envelope };
      });
      if (outcome.status === 'processed' && outcome.envelope && subscriber.afterCommit) {
        await RequestContext.run(
          {
            actor: systemActor(`subscriber:${name}`),
            correlationId: outcome.envelope.correlationId,
            causationId: outcome.envelope.id,
          },
          () => subscriber.afterCommit!(outcome.envelope),
        );
      }
      return outcome.status;
    } catch (error) {
      await this.recordFailure(eventId, name, job, error as Error);
      throw error;
    }
  }

  private async recordFailure(eventId: string, name: string, job: QueueJob, error: Error): Promise<void> {
    const last = job.attemptsMade + 1 >= job.attempts;
    const state = last ? 'dead' : 'failed';
    this.logger.warn(`subscriber ${name} failed on ${eventId} (${state}): ${error.message}`);
    await this.db
      .platform(
        (tx) => tx.$executeRaw`
          INSERT INTO platform.event_consumption (event_id, subscriber, state, attempts, last_error)
          VALUES (${eventId}::uuid, ${name}, ${state}::platform.consumption_state, 1, ${error.message.slice(0, 1000)})
          ON CONFLICT (event_id, subscriber) DO UPDATE
             SET state = EXCLUDED.state, attempts = platform.event_consumption.attempts + 1, last_error = EXCLUDED.last_error
           WHERE platform.event_consumption.state <> 'processed'`,
      )
      .catch((e: unknown) =>
        this.logger.error(`could not record subscriber failure: ${(e as Error).message}`),
      );
  }
}

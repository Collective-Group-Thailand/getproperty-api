import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { QUEUE, QUEUE_NAMES, type QueuePort } from '../queue/queue.port';

/** Attempts before an outbox message is `dead` (admin replay). Backoff: 2 s · 2^attempt, capped at 10 min. */
export const OUTBOX_MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 600_000;

interface Claimed {
  id: string;
  event_id: string;
  topic: string;
  attempts: number;
}

/**
 * Outbox relay (worker): moves `platform.outbox_message` rows to BullMQ (`gp-events`, job id = event id) in commit
 * order. Rows are claimed with `FOR UPDATE SKIP LOCKED` so replicas never relay the same row twice at once; a crash
 * between publish and mark only causes a duplicate job, which the per-subscriber inbox absorbs (exactly-once
 * effects). Failures back off exponentially; after OUTBOX_MAX_ATTEMPTS the row is `dead` until an admin replays it.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(
    private readonly db: TenantTx,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Relays up to `limit` due messages; returns how many were published. */
  async relayBatch(limit = 100): Promise<number> {
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const rows = await tx.$queryRaw<Claimed[]>`
        SELECT id, event_id, topic, attempts FROM platform.outbox_message
         WHERE state IN ('pending', 'failed') AND next_attempt_at <= ${now.toISOString()}::timestamptz
         ORDER BY created_at, id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`;
      let published = 0;
      for (const row of rows) {
        try {
          await this.queue.add(
            QUEUE_NAMES.events,
            row.topic,
            { eventId: row.event_id },
            { jobId: row.event_id },
          );
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: { state: 'published', publishedAt: now, attempts: row.attempts + 1, lastError: null },
          });
          published += 1;
        } catch (error) {
          const attempts = row.attempts + 1;
          const dead = attempts >= OUTBOX_MAX_ATTEMPTS;
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: {
              state: dead ? 'dead' : 'failed',
              attempts,
              lastError: (error as Error).message.slice(0, 500),
              nextAttemptAt: new Date(now.getTime() + Math.min(2_000 * 2 ** attempts, MAX_BACKOFF_MS)),
            },
          });
          this.logger.warn(`outbox ${row.id} → ${dead ? 'dead' : 'retry'}: ${(error as Error).message}`);
        }
      }
      return published;
    });
  }
}

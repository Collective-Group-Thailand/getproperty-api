import { Logger } from '@nestjs/common';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  type JobOptions,
  type JobProcessor,
  type QueueName,
  type QueuePort,
} from './queue.port';

/**
 * BullMQ over Redis (production, `pnpm dev` with compose). Completed jobs are kept 1 h (so a duplicate add of the
 * same job id within that window is ignored), failed jobs 14 days (the BullMQ-level dead letter; the domain-level
 * dead letter is platform.event_consumption / platform.outbox_message state `dead`, replayed by the admin).
 */
export class BullmqQueue implements QueuePort {
  readonly mode = 'real' as const;
  private readonly logger = new Logger('Queue');
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];

  constructor(private readonly connection: ConnectionOptions) {}

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, prefix: 'gp' });
      q.on('error', (error) => this.logger.error(`queue ${name}: ${error.message}`));
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T>(queue: QueueName, name: string, data: T, options: JobOptions = {}): Promise<void> {
    await this.queue(queue).add(name, data, {
      jobId: options.jobId,
      delay: options.delayMs,
      attempts: options.attempts ?? DEFAULT_ATTEMPTS,
      backoff: { type: 'exponential', delay: options.backoffMs ?? DEFAULT_BACKOFF_MS },
      removeOnComplete: { age: 3_600 },
      removeOnFail: { age: 14 * 86_400 },
    });
  }

  process<T>(queue: QueueName, processor: JobProcessor<T>, options: { concurrency?: number } = {}): void {
    const worker = new Worker(
      queue,
      async (job) =>
        processor({
          id: job.id ?? '',
          name: job.name,
          data: job.data as T,
          attemptsMade: job.attemptsMade,
          attempts: job.opts.attempts ?? DEFAULT_ATTEMPTS,
        }),
      { connection: this.connection, prefix: 'gp', concurrency: options.concurrency ?? 4 },
    );
    worker.on('failed', (job, error) =>
      this.logger.warn(`job ${queue}/${job?.name ?? '?'} ${job?.id ?? ''} failed: ${error.message}`),
    );
    worker.on('error', (error) => this.logger.error(`worker ${queue}: ${error.message}`));
    this.workers.push(worker);
  }

  async repeat(queue: QueueName, name: string, everyMs: number): Promise<void> {
    await this.queue(queue).upsertJobScheduler(
      name,
      { every: everyMs },
      { name, data: {}, opts: { attempts: 1 } },
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}

import { type Clock } from '../clock/clock';
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  type JobOptions,
  type JobProcessor,
  type QueueJob,
  type QueueName,
  type QueuePort,
} from './queue.port';

interface Stored extends QueueJob {
  queue: QueueName;
  runAt: number;
  backoffMs: number;
}

/**
 * In-memory queue for fake mode and tests. Nothing runs by itself: `drain()` processes every job that is due at the
 * clock's "now" (including jobs added while draining), with BullMQ's retry/backoff semantics; jobs that exhaust
 * their attempts land in `failed`. Repeatable jobs are listed in `repeatables` and run by `runRepeatables()`.
 */
export class FakeQueue implements QueuePort {
  readonly mode = 'fake' as const;
  readonly jobs: Stored[] = [];
  readonly completed: QueueJob[] = [];
  readonly failed: (QueueJob & { error: string })[] = [];
  readonly repeatables: { queue: QueueName; name: string; everyMs: number }[] = [];
  private readonly processors = new Map<QueueName, JobProcessor>();
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  add<T>(queue: QueueName, name: string, data: T, options: JobOptions = {}): Promise<void> {
    const id = options.jobId ?? `job-${(this.seq += 1)}`;
    if (this.jobs.some((j) => j.queue === queue && j.id === id)) return Promise.resolve();
    this.jobs.push({
      queue,
      id,
      name,
      data,
      attemptsMade: 0,
      attempts: options.attempts ?? DEFAULT_ATTEMPTS,
      backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
      runAt: this.clock.now().getTime() + (options.delayMs ?? 0),
    });
    return Promise.resolve();
  }

  process<T>(queue: QueueName, processor: JobProcessor<T>): void {
    this.processors.set(queue, processor as JobProcessor);
  }

  repeat(queue: QueueName, name: string, everyMs: number): Promise<void> {
    if (!this.repeatables.some((r) => r.queue === queue && r.name === name))
      this.repeatables.push({ queue, name, everyMs });
    return Promise.resolve();
  }

  /** Runs each repeatable job once (tests call it like one scheduler tick). */
  async runRepeatables(): Promise<void> {
    for (const r of this.repeatables) {
      await this.add(r.queue, r.name, {}, { jobId: `repeat:${r.name}:${(this.seq += 1)}`, attempts: 1 });
    }
    await this.drain();
  }

  /** Processes due jobs until none is left; returns how many ran. */
  async drain(maxRounds = 1000): Promise<number> {
    let ran = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const now = this.clock.now().getTime();
      const job = this.jobs.find((j) => j.runAt <= now && this.processors.has(j.queue));
      if (!job) return ran;
      this.jobs.splice(this.jobs.indexOf(job), 1);
      ran += 1;
      try {
        await this.processors.get(job.queue)!(job);
        this.completed.push(job);
      } catch (error) {
        job.attemptsMade += 1;
        if (job.attemptsMade < job.attempts) {
          job.runAt = now + job.backoffMs * 2 ** (job.attemptsMade - 1);
          this.jobs.push(job);
        } else {
          this.failed.push({ ...job, error: (error as Error).message });
        }
      }
    }
    return ran;
  }

  pending(queue?: QueueName): QueueJob[] {
    return this.jobs.filter((j) => !queue || j.queue === queue);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

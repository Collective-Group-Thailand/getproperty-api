/**
 * Job queues of the worker process (BullMQ in production, an in-memory queue in fake mode — D-159 timers, outbox
 * relay, subscribers, maintenance). Producers only `add`; the worker registers processors. Job ids deduplicate:
 * adding a job whose id is waiting or delayed is a no-op (BullMQ semantics), and every consumer is idempotent on
 * its own key anyway (the event inbox, `fired_at`, notification UQ).
 */
export const QUEUE = Symbol('QUEUE');

export const QUEUE_NAMES = {
  /** One job per relayed domain event: fans out to the subscribers of its type. */
  events: 'gp-events',
  /** One job per (event, subscriber): exactly-once handling through platform.event_consumption. */
  subscribers: 'gp-subscribers',
  /** Delayed jobs per workflow timer (SLA warn/breach), id = timer id. */
  workflowTimers: 'gp-workflow-timers',
  /** Notification deliveries (one per notification row) and quiet-hours releases. */
  notifications: 'gp-notifications',
  /** Repeatable maintenance: outbox relay sweep, timer sweep, held notifications, retention, scans. */
  maintenance: 'gp-maintenance',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface JobOptions {
  jobId?: string;
  delayMs?: number;
  /** Total attempts including the first (default 8). */
  attempts?: number;
  /** First retry delay; doubles per attempt (default 2 s). */
  backoffMs?: number;
}

export interface QueueJob<T = unknown> {
  id: string;
  name: string;
  data: T;
  /** Attempts made before this one. */
  attemptsMade: number;
  /** Total attempts allowed. */
  attempts: number;
}

export type JobProcessor<T = unknown> = (job: QueueJob<T>) => Promise<void>;

export interface QueuePort {
  readonly mode: 'fake' | 'real';
  add<T>(queue: QueueName, name: string, data: T, options?: JobOptions): Promise<void>;
  /** Registers the processor of a queue (worker process only). */
  process<T>(queue: QueueName, processor: JobProcessor<T>, options?: { concurrency?: number }): void;
  /** A repeatable job (`every` ms) registered once across replicas (BullMQ job scheduler). */
  repeat(queue: QueueName, name: string, everyMs: number): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_ATTEMPTS = 8;
export const DEFAULT_BACKOFF_MS = 2_000;

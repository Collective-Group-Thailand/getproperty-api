import { AppConfig } from '@config/app-config';
import { type DispatchJob, EventConsumer, type SubscriberJob } from '@core/events/event-consumer.service';
import { OutboxRelay } from '@core/events/outbox-relay.service';
import { type DeliveryJob, NotificationService } from '@core/notifications/notification.service';
import { NotificationDelivery } from '@core/notifications/notification-delivery.service';
import { RetentionService } from '@core/privacy/retention.service';
import { FakeQueue } from '@core/queue/fake-queue';
import { QUEUE, QUEUE_NAMES, type QueueJob, type QueuePort } from '@core/queue/queue.port';
import { SupportGrantService } from '@core/tenancy/support-grant.service';
import { WorkflowTimers } from '@core/workflow/workflow-timers.service';
import { BULLMQ_REDIS, type RedisClient } from '@database/redis.module';
import { LeasesService } from '@modules/ops-leases/leases.service';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

/** Repeatable maintenance jobs of the worker (exactly once across replicas through BullMQ job schedulers). */
export const MAINTENANCE_JOBS = {
  'outbox-relay': 1_000,
  'workflow-timer-sweep': 30_000,
  'notifications-release': 60_000,
  'support-grants-expire': 300_000,
  retention: 86_400_000,
  'lease-lifecycle': 3_600_000,
} as const;
type MaintenanceJob = keyof typeof MAINTENANCE_JOBS;

/**
 * The worker process (master plan §2): registers the queue processors — event dispatch, subscribers (exactly once
 * through the inbox), workflow timers, notification deliveries — and the repeatable maintenance jobs (outbox relay,
 * timer sweep, quiet-hours release, support-grant expiry, retention). With the in-memory queue (fake Redis) nothing
 * runs by itself: `tick()` runs one cycle (tests), and outside tests a 1-second interval calls it.
 */
@Injectable()
export class WorkerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private interval?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly config: AppConfig,
    @Inject(BULLMQ_REDIS) private readonly bullmq: RedisClient | null,
    @Inject(QUEUE) private readonly queue: QueuePort,
    private readonly relay: OutboxRelay,
    private readonly consumer: EventConsumer,
    private readonly timers: WorkflowTimers,
    private readonly notifications: NotificationService,
    private readonly delivery: NotificationDelivery,
    private readonly supportGrants: SupportGrantService,
    private readonly retention: RetentionService,
    private readonly leases: LeasesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.bullmq && !this.config.useFakeRedis) await this.bullmq.ping();
    this.queue.process<DispatchJob>(QUEUE_NAMES.events, (job) => this.consumer.dispatch(job), {
      concurrency: 8,
    });
    this.queue.process<SubscriberJob>(QUEUE_NAMES.subscribers, async (job) => {
      await this.consumer.consume(job);
    });
    this.queue.process<{ timerId: string }>(QUEUE_NAMES.workflowTimers, async (job) => {
      await this.timers.fireOne(job.data.timerId);
    });
    this.queue.process<DeliveryJob>(QUEUE_NAMES.notifications, async (job) => {
      await this.delivery.deliver(job.data.notificationId);
    });
    this.queue.process(QUEUE_NAMES.maintenance, (job) => this.maintenance(job), { concurrency: 1 });
    for (const [name, every] of Object.entries(MAINTENANCE_JOBS))
      await this.queue.repeat(QUEUE_NAMES.maintenance, name, every);
    if (this.queue.mode === 'fake' && !this.config.isTest) {
      this.logger.warn('in-memory queue (fake Redis): the worker ticks every second in this process only');
      this.interval = setInterval(() => void this.tick(), 1_000);
    }
    this.logger.log(`worker ready (${this.queue.mode} queue)`);
  }

  private async maintenance(job: QueueJob): Promise<void> {
    switch (job.name as MaintenanceJob) {
      case 'outbox-relay':
        await this.relay.relayBatch();
        break;
      case 'workflow-timer-sweep':
        await this.timers.fireDue();
        break;
      case 'notifications-release':
        await this.notifications.releaseHeld();
        break;
      case 'support-grants-expire':
        await this.supportGrants.expireDue();
        break;
      case 'retention':
        await this.retention.run();
        break;
      case 'lease-lifecycle':
        await this.leases.sweep();
        break;
      default:
        this.logger.warn(`unknown maintenance job ${job.name}`);
    }
  }

  /**
   * One full cycle with the in-memory queue: relay the outbox, fire due timers, release held notifications and run
   * the dispatch/subscriber/delivery jobs — repeated until nothing is left (bounded).
   */
  async tick(): Promise<void> {
    if (!(this.queue instanceof FakeQueue) || this.ticking) return;
    this.ticking = true;
    try {
      for (let round = 0; round < 20; round += 1) {
        const relayed = await this.relay.relayBatch();
        const fired = await this.timers.fireDue();
        const released = await this.notifications.releaseHeld();
        const ran = await this.queue.drain();
        if (relayed + fired + released + ran === 0) break;
      }
    } catch (error) {
      this.logger.error(`worker tick failed: ${(error as Error).message}`);
      throw error;
    } finally {
      this.ticking = false;
    }
  }

  onApplicationShutdown(signal?: string): void {
    if (this.interval) clearInterval(this.interval);
    this.logger.log(`worker stopped${signal ? ` (${signal})` : ''}`);
  }
}

import { AppConfig } from '@config/app-config';
import { ComplianceScoreService } from '@core/compliance/compliance-score.service';
import { type DispatchJob, EventConsumer, type SubscriberJob } from '@core/events/event-consumer.service';
import { OutboxRelay } from '@core/events/outbox-relay.service';
import { type DeliveryJob, NotificationService } from '@core/notifications/notification.service';
import { NotificationDelivery } from '@core/notifications/notification-delivery.service';
import { RetentionService } from '@core/privacy/retention.service';
import { FakeQueue } from '@core/queue/fake-queue';
import { QUEUE, QUEUE_NAMES, type QueueJob, type QueuePort } from '@core/queue/queue.port';
import { StorageMeteringService } from '@core/storage/storage-metering.service';
import { SupportGrantService } from '@core/tenancy/support-grant.service';
import { WorkflowTimers } from '@core/workflow/workflow-timers.service';
import { BULLMQ_REDIS, type RedisClient } from '@database/redis.module';
import { IntegrationDeliveryService } from '@modules/bridge-integrations/integration-delivery.service';
import { BillingCyclesService } from '@modules/ops-billing/billing-cycles.service';
import { EtaxService } from '@modules/ops-etax/etax.service';
import { LeasesService } from '@modules/ops-leases/leases.service';
import { SettlementsService } from '@modules/ops-payments/settlements.service';
import { ReceivablesService } from '@modules/ops-receivables/receivables.service';
import { MaintenancePlansService } from '@modules/ops-service/maintenance-plans.service';
import { Tm30Service } from '@modules/ops-tm30/tm30.service';
import { AnalyticsService } from '@modules/platform-analytics/analytics.service';
import { SubscriptionsService } from '@modules/platform-subscriptions/subscriptions.service';
import { AccessCredentialsService } from '@modules/smart-access/access-credentials.service';
import { LocksService } from '@modules/smart-access/locks.service';
import { DeviceCommandsService } from '@modules/smart-devices/commands.service';
import { GatewayConfigService } from '@modules/smart-devices/gateway-config.service';
import { MeterHealthService } from '@modules/smart-health/meter-health.service';
import { UtilityLossService } from '@modules/smart-health/utility-loss.service';
import { TelemetryMaintenanceService } from '@modules/smart-ingest/telemetry-maintenance.service';
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
  // B3 smart metering
  'telemetry-rollup': 60_000,
  'telemetry-partitions': 86_400_000,
  'gateway-health': 60_000,
  'meter-health': 300_000,
  'config-drift': 300_000,
  'device-commands': 30_000,
  // B4 billing & compliance
  'compliance-score': 86_400_000,
  'billing-cycles': 900_000,
  'payment-settlement': 86_400_000,
  receivables: 3_600_000,
  // B6.1 platform business
  'platform-subscriptions': 3_600_000,
  // B5 operations
  'maintenance-plans': 3_600_000,
  'access-credentials': 60_000,
  'lock-sweep': 3_600_000,
  // B6.2 e-Tax & TM30, B6.3 analytics
  'etax-submissions': 60_000,
  'etax-monthly': 3_600_000,
  'tm30-sweep': 3_600_000,
  'analytics-rollup': 3_600_000,
  'analytics-benchmarks': 86_400_000,
  // release review #11 (D-225): safety nets of after-commit effects
  'notifications-requeue': 300_000,
  'gateway-config-publish': 60_000,
  'loss-recompute': 3_600_000,
  // D-238 / T-16: outbox → partner products (webhook on the same box)
  'integration-delivery': 30_000,
  // D-276: daily storage snapshot per tenant (idempotent per Bangkok day) and its notices
  'storage-metering': 3_600_000,
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
    private readonly telemetry: TelemetryMaintenanceService,
    private readonly meterHealth: MeterHealthService,
    private readonly configs: GatewayConfigService,
    private readonly commands: DeviceCommandsService,
    private readonly complianceScores: ComplianceScoreService,
    private readonly billingCycles: BillingCyclesService,
    private readonly settlements: SettlementsService,
    private readonly receivables: ReceivablesService,
    private readonly subscriptions: SubscriptionsService,
    private readonly maintenancePlans: MaintenancePlansService,
    private readonly accessCredentials: AccessCredentialsService,
    private readonly locks: LocksService,
    private readonly etax: EtaxService,
    private readonly tm30: Tm30Service,
    private readonly analytics: AnalyticsService,
    private readonly loss: UtilityLossService,
    private readonly integrations: IntegrationDeliveryService,
    private readonly storageMetering: StorageMeteringService,
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
      case 'telemetry-rollup':
        await this.telemetry.rollup();
        break;
      case 'telemetry-partitions':
        await this.telemetry.partitionsAndRetention();
        break;
      case 'gateway-health':
        await this.telemetry.gatewaySweep();
        break;
      case 'meter-health':
        await this.meterHealth.run();
        break;
      case 'config-drift':
        await this.configs.detectDrift();
        break;
      case 'device-commands':
        await this.commands.sweep();
        break;
      case 'compliance-score':
        await this.complianceScores.runAll();
        break;
      case 'billing-cycles':
        await this.billingCycles.sweep();
        break;
      case 'payment-settlement':
        await this.settlements.daily();
        break;
      case 'receivables':
        await this.receivables.sweep();
        break;
      case 'platform-subscriptions':
        await this.subscriptions.sweep();
        break;
      case 'maintenance-plans':
        await this.maintenancePlans.sweep();
        break;
      case 'access-credentials':
        await this.accessCredentials.sweep();
        break;
      case 'lock-sweep':
        await this.locks.sweep();
        break;
      case 'etax-submissions':
        await this.etax.sweep();
        break;
      case 'etax-monthly':
        await this.etax.monthly();
        break;
      case 'tm30-sweep':
        await this.tm30.sweep();
        break;
      case 'analytics-rollup':
        await this.analytics.sweep();
        break;
      case 'analytics-benchmarks':
        await this.analytics.benchmarks();
        break;
      case 'notifications-requeue':
        await this.notifications.requeueStuck();
        break;
      case 'gateway-config-publish':
        await this.configs.publishPending();
        break;
      case 'loss-recompute':
        await this.loss.recomputeStale();
        break;
      case 'integration-delivery':
        await this.integrations.sweep();
        break;
      case 'storage-metering':
        await this.storageMetering.sweep();
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

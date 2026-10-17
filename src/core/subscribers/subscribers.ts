import { InvalidationBus } from '@common/cache/invalidation-bus';
import { type Tx } from '@database/prisma.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { DocumentsService } from '../documents/documents.service';
import { type DomainEventEnvelope } from '../events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '../events/subscribers';
import { FLAGS_TOPIC } from '../feature-flags/feature-flags.service';
import { NOTIFIABLE_EVENTS } from '../notifications/notifiable-events';
import { NotificationService } from '../notifications/notification.service';
import { QUEUE, QUEUE_NAMES, type QueuePort } from '../queue/queue.port';
import { RealtimeHub } from '../realtime/realtime.hub';
import { SETTINGS_TOPIC } from '../settings/settings.service';
import { TARIFFS_TOPIC } from '../utility-tariffs/utility-tariffs.service';

/** Notifications planned per event; deliveries are queued once the plan committed. */
@Injectable()
export class NotificationsSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'notifications';
  /** Read at dispatch time: modules register resolvers when they load (`registerNotifiable`). */
  get eventTypes(): string[] {
    return Object.keys(NOTIFIABLE_EVENTS);
  }
  private readonly pending = new Map<string, string[]>();

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const resolver = NOTIFIABLE_EVENTS[event.type];
    const plan = resolver ? await resolver(tx, event) : null;
    if (!plan) return;
    this.pending.set(event.id, await this.notifications.plan(tx, event, plan));
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    const ids = this.pending.get(event.id) ?? [];
    this.pending.delete(event.id);
    await this.notifications.enqueue(ids);
  }
}

/** A granted service consent releases the messages that were held for it (≤ 7 days). */
@Injectable()
export class NotificationsConsentSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'notifications-consent';
  readonly eventTypes = ['consent.changed'];
  private readonly pending = new Map<string, string[]>();

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const p = event.payload as {
      subjectType: 'user' | 'party';
      subjectId: string;
      purposeKey: string;
      granted: boolean;
    };
    if (!p.granted || p.purposeKey !== 'resident.service') return;
    this.pending.set(
      event.id,
      await this.notifications.releaseForConsent(tx, { type: p.subjectType, id: p.subjectId }),
    );
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    const ids = this.pending.get(event.id) ?? [];
    this.pending.delete(event.id);
    await this.notifications.enqueue(ids);
  }
}

/** Settings, flags and tariffs changed: every process drops its cache (Redis pub/sub via the bus). */
@Injectable()
export class CacheInvalidationSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'cache-invalidation';
  readonly eventTypes = ['setting.changed', 'feature_flag.changed', 'utility_tariff.published'];
  private readonly toPublish = new Map<string, [string, string]>();

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly bus: InvalidationBus,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(event: DomainEventEnvelope): Promise<void> {
    const topic =
      event.type === 'setting.changed'
        ? SETTINGS_TOPIC
        : event.type === 'feature_flag.changed'
          ? FLAGS_TOPIC
          : TARIFFS_TOPIC;
    const key = event.type === 'setting.changed' ? String(event.payload.key) : event.aggregateId;
    this.toPublish.set(event.id, [topic, key]);
    return Promise.resolve();
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    const entry = this.toPublish.get(event.id);
    this.toPublish.delete(event.id);
    if (entry) await this.bus.publish(entry[0], entry[1]);
  }
}

/** Every event → realtime channels with ids and type only (contract §6). */
@Injectable()
export class RealtimeSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'realtime';
  readonly eventTypes = ['*'];

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly hub: RealtimeHub,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(): Promise<void> {
    return Promise.resolve();
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    const channels: string[] = [];
    if (event.tenantId && event.buildingId)
      channels.push(`building:${event.buildingId}`, `tenant:${event.tenantId}:buildings`);
    else if (event.tenantId) channels.push(`tenant:${event.tenantId}`);
    else channels.push('platform');
    await this.hub.publish({
      type: event.type,
      ids: { eventId: event.id, aggregateType: event.aggregateType, aggregateId: event.aggregateId },
      channels,
    });
  }
}

/** Workflow timers also get a delayed BullMQ job each (the sweep is the safety net). */
@Injectable()
export class WorkflowTimerScheduler implements EventSubscriber, OnModuleInit {
  readonly name = 'workflow-timers';
  readonly eventTypes = ['workflow.started', 'workflow.transitioned'];

  constructor(
    private readonly registry: EventSubscriberRegistry,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(): Promise<void> {
    return Promise.resolve();
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    const timers = (event.payload.timers ?? []) as { id: string; fireAt: string }[];
    const now = this.clock.now().getTime();
    for (const t of timers) {
      await this.queue.add(
        QUEUE_NAMES.workflowTimers,
        'fire',
        { timerId: t.id },
        { jobId: `timer-${t.id}`, delayMs: Math.max(0, new Date(t.fireAt).getTime() - now), attempts: 3 },
      );
    }
  }
}

/** Uploaded files: virus scan, checksum, thumbnail. */
@Injectable()
export class DocumentScanSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'document-scan';
  readonly eventTypes = ['document.uploaded'];
  private readonly logger = new Logger(DocumentScanSubscriber.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const doc = await this.documents.scan(tx, String(event.payload.documentId));
    if (doc?.scanStatus === 'infected') this.logger.warn(`document ${doc.id} is infected`);
  }
}

export const SUBSCRIBERS = [
  NotificationsSubscriber,
  NotificationsConsentSubscriber,
  CacheInvalidationSubscriber,
  RealtimeSubscriber,
  WorkflowTimerScheduler,
  DocumentScanSubscriber,
];

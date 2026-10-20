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

/**
 * Billing events a resident hears on their own channels (LIFF #16, D-208): the unit of the invoice and the logins
 * linked to the billed / paying party. Ids and type only, like every realtime message (contract §6).
 */
export const RESIDENT_REALTIME_EVENTS: readonly string[] = [
  'invoice.issued',
  'invoice.paid',
  'invoice.partially_paid',
  'invoice.balance_changed',
  'invoice.overdue',
  'invoice.voided',
  'payment.confirmed',
  'payment.failed',
  'payment.reversed',
  'receipt.issued',
  'receipt.voided',
  'tax_invoice.issued',
  'slip.review_requested',
  'slip.reviewed',
];

/** Extra realtime channels of an event, resolved inside the subscriber's transaction (modules may add resolvers). */
export type RealtimeChannelResolver = (tx: Tx, event: DomainEventEnvelope) => Promise<string[]>;
const CHANNEL_RESOLVERS = new Map<string, RealtimeChannelResolver[]>();

/** Modules add channels for their event types (e.g. B5 service requests → `unit:` / `work_order:`). */
export function registerRealtimeChannels(types: readonly string[], resolver: RealtimeChannelResolver): void {
  for (const t of types) CHANNEL_RESOLVERS.set(t, [...(CHANNEL_RESOLVERS.get(t) ?? []), resolver]);
}

const asIds = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x.length === 36);

/** `unit:` of the invoices and `user:` of the logins of the billed / paying parties of a billing event. */
export const residentBillingChannels: RealtimeChannelResolver = async (tx, event) => {
  const p = event.payload;
  const invoiceIds = new Set([...asIds(p.invoiceId), ...asIds(p.invoiceIds)]);
  const partyIds = new Set([...asIds(p.payerPartyId), ...asIds(p.billedPartyId)]);
  const unitIds = new Set(asIds(p.unitId));
  for (const id of asIds(p.paymentId)) {
    const payment = await tx.payment.findUnique({
      where: { id },
      select: { payerPartyId: true, unitId: true, allocations: { select: { invoiceId: true } } },
    });
    if (payment?.payerPartyId) partyIds.add(payment.payerPartyId);
    if (payment?.unitId) unitIds.add(payment.unitId);
    for (const a of payment?.allocations ?? []) invoiceIds.add(a.invoiceId);
  }
  for (const id of asIds(p.slipReviewId)) {
    const slip = await tx.slipReview.findUnique({
      where: { id },
      select: { invoiceId: true, payerPartyId: true, unitId: true },
    });
    if (slip) {
      invoiceIds.add(slip.invoiceId);
      partyIds.add(slip.payerPartyId);
      if (slip.unitId) unitIds.add(slip.unitId);
    }
  }
  if (invoiceIds.size) {
    const invoices = await tx.invoice.findMany({
      where: { id: { in: [...invoiceIds] } },
      select: { unitId: true, billedPartyId: true },
    });
    for (const i of invoices) {
      if (i.unitId) unitIds.add(i.unitId);
      partyIds.add(i.billedPartyId);
    }
  }
  const users = partyIds.size
    ? await tx.partyUserLink.findMany({
        where: { partyId: { in: [...partyIds] }, state: 'active' },
        select: { userId: true },
      })
    : [];
  return [...[...unitIds].map((u) => `unit:${u}`), ...new Set(users.map((u) => `user:${u.userId}`))];
};
registerRealtimeChannels(RESIDENT_REALTIME_EVENTS, residentBillingChannels);

/** Every event → realtime channels with ids and type only (contract §6). */
@Injectable()
export class RealtimeSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'realtime';
  readonly eventTypes = ['*'];
  private readonly extra = new Map<string, string[]>();
  private readonly logger = new Logger(RealtimeSubscriber.name);

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly hub: RealtimeHub,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const resolvers = CHANNEL_RESOLVERS.get(event.type);
    if (!resolvers?.length) return;
    const channels = new Set<string>();
    for (const resolve of resolvers) {
      try {
        for (const c of await resolve(tx, event)) channels.add(c);
      } catch (error) {
        // a realtime hint is never worth failing the event for
        this.logger.warn(`realtime channels of ${event.type}: ${(error as Error).message}`);
      }
    }
    if (channels.size) this.extra.set(event.id, [...channels]);
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    const channels: string[] = [];
    if (event.tenantId && event.buildingId)
      channels.push(`building:${event.buildingId}`, `tenant:${event.tenantId}:buildings`);
    else if (event.tenantId) channels.push(`tenant:${event.tenantId}`);
    else channels.push('platform');
    channels.push(...(this.extra.get(event.id) ?? []));
    this.extra.delete(event.id);
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

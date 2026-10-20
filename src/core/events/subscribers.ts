import { type Tx } from '@database/prisma.service';
import { Injectable } from '@nestjs/common';

import { type DomainEventEnvelope } from './domain-events';

/**
 * A consumer of domain events (notifications, cache invalidation, realtime, scans, integration events…). `handle`
 * runs inside the transaction that also marks the event consumed for this subscriber (platform.event_consumption),
 * so its database effects happen exactly once; external effects must be idempotent on the event id.
 */
export interface EventSubscriber {
  /** Stable name (`[a-z][a-z0-9_.-]`), the inbox key: renaming it re-delivers every event. */
  readonly name: string;
  /** Event types handled; `*` suffix matches a prefix (`workflow.*`). */
  readonly eventTypes: readonly string[];
  /** `prepared` is what `prepare` returned for this delivery (undefined without a `prepare`). */
  handle(event: DomainEventEnvelope, tx: Tx, prepared?: unknown): Promise<void>;
  /**
   * Optional slow, external work run **before** the transaction (review #10): rendering a PDF, uploading to object
   * storage, calling a provider. It must not change the database state the subscriber decides on (short reads in
   * their own transactions are fine) and must be safe to repeat — `handle` re-checks the state under its locks and
   * records the result.
   */
  prepare?(event: DomainEventEnvelope): Promise<unknown>;
  /**
   * Optional work after the transaction committed (e.g. enqueue deliveries). A failure is logged and recorded on the
   * inbox row (`last_error`), never retried by the job: whatever it starts must be reconciled by a sweep (review #11).
   */
  afterCommit?(event: DomainEventEnvelope): Promise<void>;
  /** Transaction timeout of `handle` in ms (default `SUBSCRIBER_TX_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
}

/** Explicit timeout of a subscriber transaction: database work only, external I/O belongs in `prepare` (review #10). */
export const SUBSCRIBER_TX_TIMEOUT_MS = 15_000;

export function subscriberMatches(subscriber: EventSubscriber, type: string): boolean {
  return subscriber.eventTypes.some((p) => (p.endsWith('*') ? type.startsWith(p.slice(0, -1)) : p === type));
}

/** Subscribers register themselves at module init (both processes; only the worker consumes). */
@Injectable()
export class EventSubscriberRegistry {
  private readonly subscribers = new Map<string, EventSubscriber>();

  register(subscriber: EventSubscriber): void {
    if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(subscriber.name))
      throw new Error(`invalid subscriber name "${subscriber.name}"`);
    if (this.subscribers.has(subscriber.name) && this.subscribers.get(subscriber.name) !== subscriber)
      throw new Error(`duplicate subscriber "${subscriber.name}"`);
    this.subscribers.set(subscriber.name, subscriber);
  }

  get(name: string): EventSubscriber | undefined {
    return this.subscribers.get(name);
  }

  for(type: string): EventSubscriber[] {
    return [...this.subscribers.values()].filter((s) => subscriberMatches(s, type));
  }

  all(): EventSubscriber[] {
    return [...this.subscribers.values()];
  }
}

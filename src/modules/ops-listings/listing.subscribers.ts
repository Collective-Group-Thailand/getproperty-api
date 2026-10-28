import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { ListingLeadsService } from './listing-leads.service';
import { SelfViewingService } from './self-viewing.service';

/**
 * B7.4 (D-252): when a lease is activated, the unit's live listings close (`leased`), the lead the lease came from
 * is won and the other open leads are lost (`unit_leased`) — exactly once per event through the inbox.
 */
@Injectable()
export class ListingLeaseHooks implements EventSubscriber, OnModuleInit {
  readonly name = 'listing-leases';
  readonly eventTypes = ['lease.activated'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly leads: ListingLeadsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const leaseId = (event.payload.leaseId as string | undefined) ?? event.aggregateId;
    if (typeof leaseId === 'string') await this.leads.onLeaseActivated(tx, leaseId);
  }
}

/**
 * G7 (D-295): the lock log shows a successful unlock with a self-viewing code (`access.viewing_door_opened`, recorded
 * by the lock-log sync) — the viewing records the visitor's entry once and owner and staff are alerted.
 */
@Injectable()
export class SelfViewingDoorHook implements EventSubscriber, OnModuleInit {
  readonly name = 'self-viewing-door';
  readonly eventTypes = ['access.viewing_door_opened'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly selfViewing: SelfViewingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const viewingId = event.payload.viewingId;
    const at = event.payload.at;
    if (typeof viewingId !== 'string' || typeof at !== 'string') return;
    await this.selfViewing.onDoorOpened(tx, viewingId, new Date(at));
  }
}

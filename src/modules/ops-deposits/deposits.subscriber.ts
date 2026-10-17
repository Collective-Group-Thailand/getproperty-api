import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type Tx } from '@database/prisma.service';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { DepositsService } from './deposits.service';

/** The deposit refund deadline passed (D-023): `workflow.sla_breached` of a `deposit_settlement` → late flag. */
@Injectable()
export class DepositDeadlineSubscriber implements EventSubscriber, OnModuleInit {
  readonly name = 'deposit-deadline';
  readonly eventTypes = ['workflow.sla_breached'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly deposits: DepositsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.payload.definitionKey !== 'deposit_settlement') return;
    await this.deposits.onBreach(tx, event.payload.instanceId as string);
  }
}

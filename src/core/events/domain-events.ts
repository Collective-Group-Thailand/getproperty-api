import { type ActorEnvelope, actorEnvelope } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { uuidv7 } from '@common/ids/uuidv7';
import { type Tx } from '@database/prisma.service';
import { type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { type DomainEventType, topicOf } from './event-types';

/** The envelope of schema-design §4.8 — the `platform.domain_event` row, the outbox payload and the job data. */
export interface DomainEventEnvelope<P = Record<string, unknown>> {
  id: string;
  type: DomainEventType;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  tenantId: string | null;
  buildingId: string | null;
  actor: ActorEnvelope;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  payload: P;
}

export interface RecordEventInput<P> {
  type: DomainEventType;
  aggregateType: string;
  aggregateId: string;
  tenantId: string | null;
  buildingId?: string | null;
  payload: P;
  schemaVersion?: number;
}

/**
 * `DomainEvents.record(tx, event)` — writes `platform.domain_event` ⟲ and its `platform.outbox_message` in the
 * caller's transaction (CLAUDE.md: every state change = one transaction + audit + event via the outbox). The
 * worker relay publishes it afterwards; nothing is sent inline. Payloads carry ids and business values only —
 * never secrets, OTPs or full bank/id numbers (D-025).
 */
@Injectable()
export class DomainEvents {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async record<P extends Record<string, unknown>>(
    tx: Tx,
    input: RecordEventInput<P>,
  ): Promise<DomainEventEnvelope<P>> {
    const ctx = RequestContext.current();
    const occurredAt = this.clock.now();
    const envelope: DomainEventEnvelope<P> = {
      id: uuidv7(occurredAt.getTime()),
      type: input.type,
      schemaVersion: input.schemaVersion ?? 1,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      tenantId: input.tenantId,
      buildingId: input.buildingId ?? null,
      actor: actorEnvelope(ctx?.actor),
      occurredAt: occurredAt.toISOString(),
      correlationId: ctx?.correlationId ?? uuidv7(),
      causationId: ctx?.causationId ?? null,
      payload: input.payload,
    };
    await tx.domainEvent.create({
      data: {
        id: envelope.id,
        type: envelope.type,
        aggregateType: envelope.aggregateType,
        aggregateId: envelope.aggregateId,
        tenantId: envelope.tenantId,
        buildingId: envelope.buildingId,
        actor: envelope.actor,
        occurredAt,
        correlationId: envelope.correlationId,
        causationId: envelope.causationId,
        payload: envelope.payload as Prisma.InputJsonValue,
        schemaVersion: envelope.schemaVersion,
      },
    });
    await tx.outboxMessage.create({
      data: { eventId: envelope.id, topic: topicOf(envelope.type), nextAttemptAt: occurredAt },
    });
    return envelope;
  }
}

/** Row → envelope (worker side). */
export function envelopeOf(row: {
  id: string;
  type: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  tenantId: string | null;
  buildingId: string | null;
  actor: unknown;
  occurredAt: Date;
  correlationId: string;
  causationId: string | null;
  payload: unknown;
}): DomainEventEnvelope {
  return {
    id: row.id,
    type: row.type as DomainEventType,
    schemaVersion: row.schemaVersion,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    tenantId: row.tenantId,
    buildingId: row.buildingId,
    actor: row.actor as ActorEnvelope,
    occurredAt: row.occurredAt.toISOString(),
    correlationId: row.correlationId,
    causationId: row.causationId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  };
}

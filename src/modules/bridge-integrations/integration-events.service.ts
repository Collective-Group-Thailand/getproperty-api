import { createHash } from 'node:crypto';

import { PACKAGE_VERSION } from '@collective/asset-core';
import { safeParseIntegrationEvent } from '@collective/asset-core/contracts';
import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type IntegrationEvent, type IntegrationPlatform, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

/** Canonical JSON (sorted keys) for the payload hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const payloadSha256 = (payload: unknown): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(canonical(payload)).digest());

/** An inbound handler applies a validated event inside the receiving transaction; it throws to reject it. */
export type InboundHandler = (
  tx: Tx,
  envelope: Record<string, unknown>,
  row: IntegrationEvent,
) => Promise<void>;

export interface InboundOutcome {
  id: string;
  status: 'applied' | 'rejected' | 'duplicate';
  error?: string;
}

/**
 * `bridge.integration_event` (D-153, schema-design §3.5): every event exchanged with getbuild / getpack, validated
 * against the zod contracts of `@collective/asset-core` and persisted for replay — idempotent on
 * (platform, direction, idempotency_key). Outbound events are written by event subscribers (never inline) with status
 * `pending`; nothing sends them until the consumer platform exists (no transport in Phase 1). Inbound events are
 * stored as `received`, validated, then applied by the handler registered for their type (`applied`) or `rejected`
 * with the reason.
 */
@Injectable()
export class IntegrationEventsService {
  private readonly logger = new Logger(IntegrationEventsService.name);
  private readonly handlers = new Map<string, InboundHandler>();

  constructor(
    private readonly db: TenantTx,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Admin console list (D-214): newest first, filtered; `q` = event type prefix, idempotency key or subject id. */
  async list(filter: {
    state?: IntegrationEvent['status'];
    platform?: IntegrationPlatform;
    direction?: IntegrationEvent['direction'];
    tenantId?: string;
    q?: string;
    skip: number;
    take: number;
  }) {
    const q = filter.q?.trim();
    const where: Prisma.IntegrationEventWhereInput = {
      ...(filter.state ? { status: filter.state } : {}),
      ...(filter.platform ? { platform: filter.platform } : {}),
      ...(filter.direction ? { direction: filter.direction } : {}),
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(q
        ? {
            OR: [
              { eventType: { startsWith: q } },
              { idempotencyKey: q },
              ...(/^[0-9a-f-]{36}$/i.test(q) ? [{ subjectId: q }, { id: q }] : []),
            ],
          }
        : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.integrationEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.integrationEvent.count({ where }),
    }));
  }

  /** Modules register the inbound event types they apply (e.g. `warranty.defect.closed` → B5.1). */
  onInbound(type: string, handler: InboundHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Writes an outbound event (validated against the contract) in the caller's transaction; returns the existing row
   * when the idempotency key was already used (a replayed subscriber writes nothing twice).
   */
  async outbound(
    tx: Tx,
    input: {
      platform: IntegrationPlatform;
      envelope: Record<string, unknown> & { type: string; idempotencyKey: string; occurredAt: string };
      tenantId: string | null;
      buildingId?: string | null;
      subjectType?: string;
      subjectId?: string;
      causationEventId?: string | null;
    },
  ): Promise<IntegrationEvent> {
    const parsed = safeParseIntegrationEvent(input.envelope);
    if (!parsed.success)
      throw new Error(
        `integration event ${input.envelope.type} breaks its contract: ${parsed.error.message}`,
      );
    const existing = await tx.integrationEvent.findUnique({
      where: {
        platform_direction_idempotencyKey: {
          platform: input.platform,
          direction: 'outbound',
          idempotencyKey: input.envelope.idempotencyKey,
        },
      },
    });
    if (existing) return existing;
    const occurredAt = new Date(input.envelope.occurredAt);
    return tx.integrationEvent.create({
      data: {
        direction: 'outbound',
        platform: input.platform,
        eventType: input.envelope.type,
        contractVersion: PACKAGE_VERSION,
        idempotencyKey: input.envelope.idempotencyKey,
        tenantId: input.tenantId,
        buildingId: input.buildingId ?? null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        payload: parsed.data,
        payloadSha256: payloadSha256(parsed.data),
        correlationId: (input.envelope.correlationId as string | undefined) ?? null,
        causationEventId: input.causationEventId ?? null,
        status: 'pending',
        occurredAt,
        ackDueAt: new Date(occurredAt.getTime() + 86_400_000),
      },
    });
  }

  /**
   * Receives an inbound event from `platform`: stored once per idempotency key (a duplicate answers the first
   * outcome), validated against the contract, applied by its handler in the same transaction.
   */
  async receive(platform: IntegrationPlatform, raw: unknown): Promise<InboundOutcome> {
    const now = this.clock.now();
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.slice(0, 300) : null;
    const type = typeof body.type === 'string' ? body.type.slice(0, 100) : 'unknown';
    return RequestContext.run({ actor: systemActor(`integration:${platform}`) }, async () => {
      if (key) {
        const existing = await this.db.platform((tx) =>
          tx.integrationEvent.findUnique({
            where: {
              platform_direction_idempotencyKey: { platform, direction: 'inbound', idempotencyKey: key },
            },
          }),
        );
        if (existing) return { id: existing.id, status: 'duplicate' };
      }
      const parsed = safeParseIntegrationEvent(raw);
      const stored = await this.db.platform((tx) =>
        tx.integrationEvent.create({
          data: {
            direction: 'inbound',
            platform,
            eventType: type,
            contractVersion: PACKAGE_VERSION,
            idempotencyKey: key ?? `invalid:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
            tenantId: null,
            payload: body as Prisma.InputJsonValue,
            payloadSha256: payloadSha256(body),
            correlationId:
              typeof body.correlationId === 'string' && body.correlationId.length === 36
                ? body.correlationId
                : null,
            status: 'received',
            occurredAt:
              typeof body.occurredAt === 'string' && !Number.isNaN(Date.parse(body.occurredAt))
                ? new Date(body.occurredAt)
                : now,
            receivedAt: now,
            ackDueAt: new Date(now.getTime() + 86_400_000),
          },
        }),
      );
      const reject = async (error: string): Promise<InboundOutcome> => {
        await this.db.platform((tx) =>
          tx.integrationEvent.update({
            where: { id: stored.id },
            data: { status: 'rejected', lastError: error.slice(0, 2000), attempts: { increment: 1 } },
          }),
        );
        this.logger.warn({ event: 'integration_rejected', id: stored.id, type, error: error.slice(0, 200) });
        return { id: stored.id, status: 'rejected', error };
      };
      if (!parsed.success) return reject(`contract: ${parsed.error.message}`);
      const handler = this.handlers.get(parsed.data.type);
      if (!handler) return reject(`no consumer for ${parsed.data.type}`);
      try {
        await this.db.platform(async (tx) => {
          await tx.integrationEvent.update({ where: { id: stored.id }, data: { status: 'validated' } });
          await handler(tx, parsed.data, stored);
          await tx.integrationEvent.update({
            where: { id: stored.id },
            data: { status: 'applied', attempts: { increment: 1 }, ackedAt: this.clock.now() },
          });
        });
        return { id: stored.id, status: 'applied' };
      } catch (error) {
        return reject((error as Error).message);
      }
    });
  }
}

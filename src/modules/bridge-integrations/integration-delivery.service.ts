import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { AppConfig } from '@config/app-config';
import { CLOCK, type Clock } from '@core/clock/clock';
import { TenantTx } from '@database/tenant-tx';
import { type IntegrationEvent, type IntegrationPlatform } from '@generated/prisma/client';
import {
  FakeIntegrationTransport,
  type IntegrationTransport,
  IntegrationTransportError,
  SnsIntegrationTransport,
  WebhookIntegrationTransport,
} from '@integrations/integration-webhooks/integration-transport';
import { Inject, Injectable, Logger } from '@nestjs/common';

export const INTEGRATION_PLATFORMS: readonly IntegrationPlatform[] = ['getbuild', 'getpack', 'getenergy'];
/** Attempts before an event is parked `dead` (≈ 26 h with the backoff below — past the 24-h ack window). */
export const MAX_DELIVERY_ATTEMPTS = 12;
/** A claimed row is invisible to other replicas for this long (a crashed sender's rows come back). */
const CLAIM_MS = 120_000;

/** 30 s, 1 min, 2 min … capped at 4 h. */
export function deliveryBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 4 * 3_600_000);
}

const upper = (p: IntegrationPlatform) => p.toUpperCase() as 'GETBUILD' | 'GETPACK' | 'GETENERGY';
export const keysOf = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

/**
 * Outbox → partner transport for cross-product integration events (D-238, blueprint T-16). Subscribers write outbound
 * events into `bridge.integration_event` (`pending`, idempotent on the key, inside their transaction); this job —
 * `integration-delivery`, every 30 s on the worker — claims due rows (`FOR UPDATE SKIP LOCKED` + a claim lease, so
 * replicas never send one event twice at once), sends them through the platform's configured transport
 * (`INTEGRATION_<PLATFORM>_TRANSPORT` = `none` (default: rows wait) | `webhook` | `sns`) and records the outcome:
 * `acked` on the partner's 2xx (it stored the event — receivers dedupe on the idempotency key, so a resend after a lost
 * answer is harmless), `failed` with backoff on a transient error, `dead` on a permanent refusal or after
 * MAX_DELIVERY_ATTEMPTS (the admin console lists them, D-214).
 */
@Injectable()
export class IntegrationDeliveryService {
  private readonly logger = new Logger(IntegrationDeliveryService.name);
  private readonly transports = new Map<IntegrationPlatform, IntegrationTransport | null>();

  constructor(
    private readonly db: TenantTx,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The configured transport of a partner, or null (`none`). */
  transportFor(platform: IntegrationPlatform): IntegrationTransport | null {
    if (this.transports.has(platform)) return this.transports.get(platform)!;
    const p = upper(platform);
    // G9 (O-028): getenergy has no agreed endpoint yet — the in-memory fake with the fakes, else the events wait
    const kind =
      p === 'GETENERGY'
        ? (this.config.get('INTEGRATION_GETENERGY_TRANSPORT') ?? (this.config.useFakes ? 'fake' : 'none'))
        : this.config.get(`INTEGRATION_${p}_TRANSPORT`);
    let transport: IntegrationTransport | null = null;
    if (kind === 'webhook') {
      const url = this.config.get(`INTEGRATION_${p}_WEBHOOK_URL`);
      const keys = keysOf(this.config.get(`INTEGRATION_${p}_SIGNING_KEYS`));
      if (!url || keys.length === 0)
        throw new Error(
          `INTEGRATION_${p}_WEBHOOK_URL and INTEGRATION_${p}_SIGNING_KEYS are required for the webhook transport`,
        );
      transport = new WebhookIntegrationTransport({
        url,
        signingKeys: keys,
        source: 'getproperty',
        timeoutMs: this.config.get('INTEGRATION_WEBHOOK_TIMEOUT_MS'),
      });
    } else if (kind === 'sns' && p !== 'GETENERGY') {
      transport = new SnsIntegrationTransport(this.config.get(`INTEGRATION_${p}_SNS_TOPIC_ARN`));
    } else if (kind === 'fake') {
      transport = new FakeIntegrationTransport();
    }
    this.transports.set(platform, transport);
    return transport;
  }

  /** One sweep: due outbound events of every partner with a transport. Returns the number of acknowledged events. */
  async sweep(limit = 50): Promise<number> {
    const platforms = INTEGRATION_PLATFORMS.filter((p) => this.transportFor(p) !== null);
    if (!platforms.length) return 0;
    const now = this.clock.now();
    const claimed = await this.db.platform(
      (tx) => tx.$queryRaw<{ id: string }[]>`
        UPDATE bridge.integration_event e SET next_attempt_at = ${new Date(now.getTime() + CLAIM_MS)}
         WHERE e.id IN (
           SELECT id FROM bridge.integration_event
            WHERE direction = 'outbound' AND status IN ('pending', 'failed')
              AND platform::text = ANY (${platforms}::text[])
              AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
            ORDER BY occurred_at
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
        RETURNING e.id::text AS id`,
    );
    let acked = 0;
    for (const { id } of claimed) if (await this.deliver(id)) acked += 1;
    return acked;
  }

  private async deliver(id: string): Promise<boolean> {
    return RequestContext.run({ actor: systemActor('integration-delivery') }, async () => {
      const row = await this.db.platform((tx) => tx.integrationEvent.findUnique({ where: { id } }));
      if (!row || row.direction !== 'outbound' || !['pending', 'failed'].includes(row.status)) return false;
      const transport = this.transportFor(row.platform);
      if (!transport) return false;
      try {
        await transport.send({
          platform: row.platform,
          idempotencyKey: row.idempotencyKey,
          envelope: row.payload,
        });
      } catch (error) {
        await this.failed(row, error);
        return false;
      }
      const at = this.clock.now();
      await this.db.platform((tx) =>
        tx.integrationEvent.update({
          where: { id },
          data: {
            status: 'acked',
            sentAt: at,
            ackedAt: at,
            attempts: { increment: 1 },
            nextAttemptAt: null,
            lastError: null,
          },
        }),
      );
      return true;
    });
  }

  private async failed(row: IntegrationEvent, error: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    const retryable = !(error instanceof IntegrationTransportError) || error.retryable;
    const dead = !retryable || attempts >= MAX_DELIVERY_ATTEMPTS;
    const message = (error as Error).message.slice(0, 2000);
    await this.db.platform((tx) =>
      tx.integrationEvent.update({
        where: { id: row.id },
        data: {
          status: dead ? 'dead' : 'failed',
          attempts,
          lastError: message,
          nextAttemptAt: dead ? null : new Date(this.clock.now().getTime() + deliveryBackoffMs(attempts)),
        },
      }),
    );
    this.logger.warn({
      event: 'integration_delivery_failed',
      id: row.id,
      platform: row.platform,
      attempts,
      dead,
    });
  }
}

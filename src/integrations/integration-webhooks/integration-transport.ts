import { signIntegrationWebhook } from '@collective/asset-core/contracts';

/** An outbound integration event as the transport sends it (D-238). */
export interface OutboundIntegration {
  platform: string;
  idempotencyKey: string;
  /** The validated contract envelope (`bridge.integration_event.payload`). */
  envelope: unknown;
}

/** Why a delivery failed; `retryable = false` parks the event as `dead` (the partner refused it for good). */
export class IntegrationTransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IntegrationTransportError';
  }
}

export interface IntegrationTransport {
  readonly kind: 'webhook' | 'sns' | 'fake';
  /** Resolves once the partner stored the event (its 2xx is the acknowledgement); rejects otherwise. */
  send(event: OutboundIntegration): Promise<void>;
}

/** HTTP statuses that will not change by retrying the same request (contract / routing errors). */
const PERMANENT = new Set([400, 404, 405, 409, 410, 413, 415, 422]);

/**
 * Outbox → HTTP webhook between products on the same box (D-238, blueprint T-16): `POST <url>` over the docker network
 * with the envelope as JSON, signed by `@collective/asset-core`'s `signIntegrationWebhook` (`X-Collective-*` headers,
 * HMAC-SHA256 over timestamp + raw body; all signing keys during a rotation). A 2xx is the partner's acknowledgement;
 * 408 / 429 / 5xx / network errors are retried by the delivery job with backoff; other 4xx park the event.
 */
export class WebhookIntegrationTransport implements IntegrationTransport {
  readonly kind = 'webhook' as const;

  constructor(
    private readonly options: { url: string; signingKeys: string[]; source: string; timeoutMs: number },
  ) {}

  async send(event: OutboundIntegration): Promise<void> {
    const body = JSON.stringify(event.envelope);
    const headers = signIntegrationWebhook({
      keys: this.options.signingKeys,
      body,
      eventId: event.idempotencyKey,
      source: this.options.source,
    });
    let res: Response;
    try {
      res = await fetch(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': event.idempotencyKey, ...headers },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new IntegrationTransportError(`webhook ${event.platform}: ${(error as Error).message}`, true);
    }
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return;
    throw new IntegrationTransportError(
      `webhook ${event.platform}: HTTP ${res.status}`,
      !PERMANENT.has(res.status),
      res.status,
    );
  }
}

/**
 * SNS/SQS for a partner on another box (D-238) — a stub until such a partner exists: every product runs on the one box
 * per environment today. Selecting it keeps the events `failed` (retryable) with this reason, so switching the
 * transport later delivers them; the adapter is written when a product moves to its own box (blueprint A-16).
 */
export class SnsIntegrationTransport implements IntegrationTransport {
  readonly kind = 'sns' as const;

  constructor(private readonly topicArn: string | undefined) {}

  send(event: OutboundIntegration): Promise<void> {
    return Promise.reject(
      new IntegrationTransportError(
        `sns ${event.platform}: SNS/SQS transport not implemented (${this.topicArn ?? 'no topic'}); D-238 — only for a partner on another box`,
        true,
      ),
    );
  }
}

/**
 * In-memory partner for dev / tests / demos (G9: getenergy until O-028 names its endpoint): acknowledges every event,
 * keeps what it received (envelopes only — the same validated payload a real partner would get) and can be told to
 * refuse the next one. Never leaves the process.
 */
export class FakeIntegrationTransport implements IntegrationTransport {
  readonly kind = 'fake' as const;
  readonly received: OutboundIntegration[] = [];
  /** Tests: the next send fails with this error. */
  failNext: IntegrationTransportError | null = null;

  send(event: OutboundIntegration): Promise<void> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    this.received.push(structuredClone(event));
    return Promise.resolve();
  }
}

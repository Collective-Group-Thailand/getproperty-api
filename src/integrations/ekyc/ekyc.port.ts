import { createHmac, timingSafeEqual } from 'node:crypto';

export const EKYC = Symbol('EKYC');

export interface EkycSession {
  /** The provider's id of the verification session (unique per provider). */
  sessionId: string;
  /** Where the person verifies (ID card + selfie / NDID) — the provider's page, opened in the browser or LINE. */
  url: string;
}

export interface EkycOutcome {
  sessionId: string;
  outcome: 'approved' | 'rejected';
  /** Why a check failed, in words the person can act on (no ID data). */
  reason: string | null;
}

/** The webhook signature or body is not the provider's. */
export class EkycWebhookError extends Error {
  constructor(
    readonly kind: 'signature' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'EkycWebhookError';
  }
}

/**
 * Identity verification of a person at a licensed e-KYC provider (D-267; O-021 — the provider is not chosen yet).
 * `start` opens a session the person completes on the provider's page; the provider calls back
 * `POST /webhooks/ekyc/{provider}` with the outcome, signed (`X-Ekyc-Signature`: hex HMAC-SHA256 of the raw body).
 * Only the outcome is kept — never the ID number, the photos or the date of birth.
 */
export interface EkycPort {
  /** `off` = no provider configured (`ekyc.unavailable`), `fake` = tests and demos. */
  readonly mode: 'off' | 'fake';
  readonly provider: string;
  start(input: { reference: string; returnUrl: string; language: 'th' | 'en' }): Promise<EkycSession>;
  /** Verifies the signature and reads the outcome; throws `EkycWebhookError`. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): EkycOutcome;
}

/** The generic signed webhook body: `{ "sessionId": "…", "outcome": "approved" | "rejected", "reason": "…" }`. */
export function parseSignedOutcome(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): EkycOutcome {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature ?? '', 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new EkycWebhookError('signature', 'the e-KYC webhook signature does not match');
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new EkycWebhookError('malformed', 'the e-KYC webhook body is not JSON');
  }
  const b = body as { sessionId?: unknown; outcome?: unknown; reason?: unknown };
  if (
    typeof b.sessionId !== 'string' ||
    !b.sessionId ||
    (b.outcome !== 'approved' && b.outcome !== 'rejected')
  )
    throw new EkycWebhookError('malformed', 'sessionId and outcome (approved | rejected) are required');
  return {
    sessionId: b.sessionId.slice(0, 200),
    outcome: b.outcome,
    reason: typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null,
  };
}

export function signEkycBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** No provider configured (O-021): starting a verification answers `ekyc.unavailable`. */
export class EkycUnavailable implements EkycPort {
  readonly mode = 'off' as const;
  readonly provider = 'none';

  start(): Promise<EkycSession> {
    return Promise.reject(new Error('no e-KYC provider is configured (EKYC_MODE=off, O-021)'));
  }

  parseWebhook(): EkycOutcome {
    throw new EkycWebhookError('signature', 'no e-KYC provider is configured');
  }
}

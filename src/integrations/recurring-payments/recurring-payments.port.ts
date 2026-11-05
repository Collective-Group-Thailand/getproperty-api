import { createHmac, timingSafeEqual } from 'node:crypto';

export const RECURRING_PAYMENTS = Symbol('RECURRING_PAYMENTS');

export type RecurringMethod = 'direct_debit' | 'card_token';

export interface MandateSetup {
  /** The provider's reference of the authorisation (never the token or the account number). */
  mandateRef: string;
  /** Where the payer authorises it (bank / card page of the provider). */
  setupUrl: string;
}

export interface ChargeRequest {
  mandateRef: string;
  /** Decimal string, THB. */
  amount: string;
  /** What the payer sees on their statement (the invoice number). */
  reference: string;
  /** Repeated calls with the same key never charge twice (the provider's idempotency key). */
  idempotencyKey: string;
}

export interface ChargeAccepted {
  chargeRef: string;
  /** Usually `pending`: the outcome arrives on the signed webhook. */
  state: 'pending' | 'succeeded' | 'failed';
}

export type RecurringEventType =
  'mandate.activated' | 'mandate.failed' | 'mandate.revoked' | 'charge.succeeded' | 'charge.failed';
export const RECURRING_EVENT_TYPES: readonly RecurringEventType[] = [
  'mandate.activated',
  'mandate.failed',
  'mandate.revoked',
  'charge.succeeded',
  'charge.failed',
];

/** A provider callback after its signature was checked. */
export interface RecurringEvent {
  eventId: string;
  type: RecurringEventType;
  mandateRef: string;
  chargeRef: string | null;
  amount: string | null;
  occurredAt: Date;
  /** A masked hint of the account / card (e.g. `xxx-x-x1234-x`, `•••• 4242`). */
  masked: string | null;
  reason: string | null;
}

export class RecurringWebhookError extends Error {
  constructor(
    readonly kind: 'signature' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'RecurringWebhookError';
  }
}

/** No provider configured (O-020): every call answers `recurring.unavailable`. */
export class RecurringUnavailableError extends Error {
  constructor() {
    super('no recurring-payment provider is configured (RECURRING_PAYMENTS_MODE=off, O-020)');
    this.name = 'RecurringUnavailableError';
  }
}

/**
 * Recurring payments (D-308 = D-J07, D-325): direct debit / tokenised card through the gateway port. The provider holds
 * the token; getproperty keeps the mandate reference, asks for a charge per invoice and learns the outcome from a
 * signed webhook (`POST /webhooks/recurring/{provider}`). Fake until O-020 picks a provider.
 */
export interface RecurringPaymentsPort {
  readonly mode: 'fake' | 'off';
  readonly provider: string;
  createMandate(input: { reference: string; method: RecurringMethod }): Promise<MandateSetup>;
  revokeMandate(mandateRef: string): Promise<void>;
  charge(input: ChargeRequest): Promise<ChargeAccepted>;
  /** Checks the signature (`X-Recurring-Signature`) and reads the event; throws `RecurringWebhookError`. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): RecurringEvent;
}

/** Hex HMAC-SHA256 of the raw body (the shape of the fake provider; a real one may differ — UNVERIFIED). */
export function signRecurringBody(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function parseSignedRecurringEvent(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): RecurringEvent {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature ?? '', 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new RecurringWebhookError('signature', 'the recurring webhook signature does not match');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new RecurringWebhookError('malformed', 'the recurring webhook body is not JSON');
  }
  const str = (k: string, max = 200): string | null =>
    typeof body[k] === 'string' && body[k].trim() ? body[k].trim().slice(0, max) : null;
  const type = str('type') as RecurringEventType | null;
  const eventId = str('eventId');
  const mandateRef = str('mandateRef');
  if (!eventId || !mandateRef || !type || !RECURRING_EVENT_TYPES.includes(type))
    throw new RecurringWebhookError('malformed', 'eventId, type and mandateRef are required');
  const amount = str('amount', 20);
  if (amount !== null && !/^\d{1,12}(\.\d{1,2})?$/.test(amount))
    throw new RecurringWebhookError('malformed', 'amount must be a decimal string');
  const at = str('occurredAt', 40);
  const occurredAt = at ? new Date(at) : new Date();
  if (Number.isNaN(occurredAt.getTime()))
    throw new RecurringWebhookError('malformed', 'occurredAt must be an ISO date-time');
  const chargeRef = str('chargeRef');
  if (type.startsWith('charge.') && !chargeRef)
    throw new RecurringWebhookError('malformed', 'a charge event needs chargeRef');
  return {
    eventId,
    type,
    mandateRef,
    chargeRef,
    amount,
    occurredAt,
    masked: str('masked', 40),
    reason: str('reason', 500),
  };
}

/** `RECURRING_PAYMENTS_MODE=off` (O-020): nothing can be set up or charged. */
export class UnconfiguredRecurringPayments implements RecurringPaymentsPort {
  readonly mode = 'off' as const;
  readonly provider = 'none';
  createMandate(): Promise<MandateSetup> {
    return Promise.reject(new RecurringUnavailableError());
  }
  revokeMandate(): Promise<void> {
    return Promise.resolve();
  }
  charge(): Promise<ChargeAccepted> {
    return Promise.reject(new RecurringUnavailableError());
  }
  parseWebhook(): RecurringEvent {
    throw new RecurringWebhookError('signature', 'no recurring-payment provider is configured');
  }
}

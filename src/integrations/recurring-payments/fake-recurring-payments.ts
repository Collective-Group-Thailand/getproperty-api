import { randomUUID } from 'node:crypto';

import {
  type ChargeAccepted,
  type ChargeRequest,
  type MandateSetup,
  parseSignedRecurringEvent,
  type RecurringEvent,
  type RecurringEventType,
  type RecurringMethod,
  type RecurringPaymentsPort,
  signRecurringBody,
} from './recurring-payments.port';

/** The webhook secret of the fake when `RECURRING_WEBHOOK_SECRET` is not set (tests, demos). */
export const FAKE_RECURRING_SECRET = 'fake-recurring-webhook-secret';

/**
 * The recurring-payment stand-in (tests, demos, O-020): mandates and charges in memory, idempotent per charge key; the
 * outcome comes back on the generic signed webhook — a test builds it with `event()`.
 */
export class FakeRecurringPayments implements RecurringPaymentsPort {
  readonly mode = 'fake' as const;
  readonly provider = 'fake';
  readonly mandates = new Map<string, { reference: string; method: RecurringMethod; revoked: boolean }>();
  readonly charges = new Map<string, ChargeRequest & { chargeRef: string }>();
  /** The next `charge` throws (provider outage). */
  failNext = false;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly secret: string,
  ) {}

  createMandate(input: { reference: string; method: RecurringMethod }): Promise<MandateSetup> {
    const mandateRef = `fake-mandate-${randomUUID()}`;
    this.mandates.set(mandateRef, { ...input, revoked: false });
    return Promise.resolve({
      mandateRef,
      setupUrl: `${this.apiBaseUrl}/webhooks/recurring/fake/mandates/${mandateRef}`,
    });
  }

  revokeMandate(mandateRef: string): Promise<void> {
    const m = this.mandates.get(mandateRef);
    if (m) m.revoked = true;
    return Promise.resolve();
  }

  charge(input: ChargeRequest): Promise<ChargeAccepted> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fake recurring provider unavailable'));
    }
    const known = this.charges.get(input.idempotencyKey);
    if (known) return Promise.resolve({ chargeRef: known.chargeRef, state: 'pending' });
    const chargeRef = `fake-charge-${randomUUID()}`;
    this.charges.set(input.idempotencyKey, { ...input, chargeRef });
    return Promise.resolve({ chargeRef, state: 'pending' });
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): RecurringEvent {
    return parseSignedRecurringEvent(rawBody, signature, this.secret);
  }

  /** A signed callback body + header as the provider would send it. */
  event(input: {
    type: RecurringEventType;
    mandateRef: string;
    chargeRef?: string;
    amount?: string;
    eventId?: string;
    masked?: string;
    reason?: string;
    occurredAt?: Date;
  }): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify({
      eventId: input.eventId ?? `evt_${randomUUID()}`,
      type: input.type,
      mandateRef: input.mandateRef,
      chargeRef: input.chargeRef ?? null,
      amount: input.amount ?? null,
      masked: input.masked ?? null,
      reason: input.reason ?? null,
      occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    });
    return { body, headers: { 'x-recurring-signature': signRecurringBody(body, this.secret) } };
  }
}

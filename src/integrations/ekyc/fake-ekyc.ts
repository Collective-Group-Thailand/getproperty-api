import { type EkycOutcome, type EkycPort, type EkycSession, parseSignedOutcome } from './ekyc.port';

/** The webhook secret of the fake when `EKYC_WEBHOOK_SECRET` is not set (tests, demos). */
export const FAKE_EKYC_SECRET = 'fake-ekyc-webhook-secret';

/**
 * The e-KYC stand-in (tests, demos): a session id from the reference, a page on the API itself
 * (`/webhooks/ekyc/fake/sessions/{id}` — approve or reject, only while `EKYC_MODE=fake`), and the generic signed webhook.
 */
export class FakeEkyc implements EkycPort {
  readonly mode = 'fake' as const;
  readonly provider = 'fake';

  constructor(
    private readonly apiBaseUrl: string,
    private readonly secret: string,
  ) {}

  start(input: { reference: string }): Promise<EkycSession> {
    const sessionId = `fake-ekyc-${input.reference}`;
    return Promise.resolve({ sessionId, url: `${this.apiBaseUrl}/webhooks/ekyc/fake/sessions/${sessionId}` });
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): EkycOutcome {
    return parseSignedOutcome(rawBody, signature, this.secret);
  }
}

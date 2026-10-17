import { randomUUID } from 'node:crypto';

import { type SmsPort } from './sms.port';

/** In-memory SMS: tests read the last message (e.g. the OTP) instead of a phone. */
export class FakeSms implements SmsPort {
  readonly mode = 'fake' as const;
  readonly sent: { to: string; text: string; providerMessageId: string; at: Date }[] = [];
  failNext = false;

  send(to: string, text: string): Promise<{ providerMessageId: string }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fake sms failure'));
    }
    const providerMessageId = `fake-sms-${randomUUID()}`;
    this.sent.push({ to, text, providerMessageId, at: new Date() });
    return Promise.resolve({ providerMessageId });
  }

  lastTo(phone: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === phone)?.text;
  }

  /** The 6-digit code of the last SMS to `phone`. */
  lastCodeTo(phone: string): string | undefined {
    return /\b(\d{6})\b/.exec(this.lastTo(phone) ?? '')?.[1];
  }
}

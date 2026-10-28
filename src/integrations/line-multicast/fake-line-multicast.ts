import { type LineMessage } from '@collective/integrations/line';

import { type LineMulticastPort } from './line-multicast.port';

/** In-memory multicast (dev, tests): keeps every call; `failNext` makes the next call throw (retry path). */
export class FakeLineMulticast implements LineMulticastPort {
  readonly mode = 'fake' as const;
  readonly sent: { to: string[]; messages: LineMessage[]; retryKey: string }[] = [];
  failNext = false;

  multicast(to: string[], messages: LineMessage[], retryKey: string): Promise<{ requestId: string }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(Object.assign(new Error('fake multicast refused'), { status: 500 }));
    }
    // a retried call with the same key is accepted once (LINE answers 409 for an accepted retry key)
    if (!this.sent.some((s) => s.retryKey === retryKey)) this.sent.push({ to: [...to], messages, retryKey });
    return Promise.resolve({ requestId: `fake-multicast-${retryKey}` });
  }

  /** Every LINE user id that received something. */
  recipients(): string[] {
    return this.sent.flatMap((s) => s.to);
  }
}

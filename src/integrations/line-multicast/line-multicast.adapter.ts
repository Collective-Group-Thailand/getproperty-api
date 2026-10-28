import { type LineMessage } from '@collective/integrations/line';

import { type LineMulticastPort } from './line-multicast.port';

/**
 * LINE Messaging API multicast (`POST https://api.line.me/v2/bot/message/multicast`, Bearer channel access token of
 * getproperty's OA, `X-Line-Retry-Key`; a 409 with the key means LINE already accepted the request).
 * // UNVERIFIED against live provider: written from the Messaging API reference; not used until O-023 is answered.
 */
export class LineMulticastAdapter implements LineMulticastPort {
  readonly mode = 'real' as const;

  constructor(
    private readonly accessToken: string,
    private readonly baseUrl = 'https://api.line.me',
  ) {}

  async multicast(to: string[], messages: LineMessage[], retryKey: string): Promise<{ requestId: string }> {
    if (to.length < 1 || to.length > 500) throw new Error('multicast: 1–500 recipients');
    const response = await fetch(`${this.baseUrl}/v2/bot/message/multicast`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        'X-Line-Retry-Key': retryKey,
      },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 409)
      return { requestId: response.headers.get('x-line-accepted-request-id') ?? retryKey };
    if (!response.ok)
      throw Object.assign(new Error(`multicast ${response.status}`), { status: response.status });
    return { requestId: response.headers.get('x-line-request-id') ?? retryKey };
  }
}

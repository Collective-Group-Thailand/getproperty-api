import { ProviderError, providerFetch } from '../http/provider-http';
import { type LineMessage, type LineMessagingPort } from './line-messaging.port';

/**
 * LINE Messaging API push (`POST https://api.line.me/v2/bot/message/push`, Bearer channel access token,
 * `X-Line-Retry-Key` for idempotent retries — a 409 with that key means LINE already accepted the message).
 * // UNVERIFIED against live provider: written from the Messaging API reference.
 */
export class LineMessagingAdapter implements LineMessagingPort {
  readonly mode = 'real' as const;

  constructor(
    private readonly accessToken: string,
    private readonly baseUrl = 'https://api.line.me',
  ) {}

  async push(to: string, messages: LineMessage[], retryKey: string): Promise<{ providerMessageId: string }> {
    const response = await providerFetch({
      provider: 'line-messaging',
      url: `${this.baseUrl}/v2/bot/message/push`,
      init: {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
          'x-line-retry-key': retryKey,
        },
        body: JSON.stringify({ to, messages }),
      },
    });
    if (response.status === 409) return { providerMessageId: `retry:${retryKey}` };
    if (!response.ok)
      throw new ProviderError('line-messaging', `HTTP ${response.status}`, response.status, false);
    const json = (await response.json()) as { sentMessages?: { id?: string }[] };
    return { providerMessageId: json.sentMessages?.[0]?.id ?? `retry:${retryKey}` };
  }
}

import { type LineMessage } from '@collective/integrations/line';

import { type LineBotInfo, type LineChannelApiPort, LineChannelError } from './line-channel-api.port';

/**
 * LINE Messaging API with an operator's channel access token: `GET /v2/bot/info`, `POST /v2/bot/message/push`
 * (`X-Line-Retry-Key`; a 409 with the key means LINE already accepted it), `POST /v2/bot/message/reply`.
 * // UNVERIFIED against live provider: written from the Messaging API reference.
 */
export class LineChannelApiAdapter implements LineChannelApiPort {
  readonly mode = 'real' as const;

  constructor(private readonly baseUrl = 'https://api.line.me') {}

  private async call(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    return response;
  }

  async botInfo(accessToken: string): Promise<LineBotInfo> {
    const response = await this.call(accessToken, '/v2/bot/info');
    if (!response.ok) throw new LineChannelError(response.status, `bot info ${response.status}`);
    const body = (await response.json()) as { userId?: string; displayName?: string; pictureUrl?: string };
    if (!body.userId) throw new LineChannelError(502, 'bot info without userId');
    return { userId: body.userId, displayName: body.displayName ?? '', pictureUrl: body.pictureUrl };
  }

  async push(accessToken: string, to: string, messages: LineMessage[], retryKey: string) {
    const response = await this.call(accessToken, '/v2/bot/message/push', {
      method: 'POST',
      headers: { 'X-Line-Retry-Key': retryKey },
      body: JSON.stringify({ to, messages }),
    });
    if (response.status === 409)
      return { providerMessageId: response.headers.get('x-line-accepted-request-id') ?? retryKey };
    if (!response.ok) throw new LineChannelError(response.status, `push ${response.status}`);
    const body = (await response.json().catch(() => ({}))) as { sentMessages?: { id?: string }[] };
    return {
      providerMessageId: body.sentMessages?.[0]?.id ?? response.headers.get('x-line-request-id') ?? retryKey,
    };
  }

  async reply(accessToken: string, replyToken: string, messages: LineMessage[]) {
    const response = await this.call(accessToken, '/v2/bot/message/reply', {
      method: 'POST',
      body: JSON.stringify({ replyToken, messages }),
    });
    if (!response.ok) throw new LineChannelError(response.status, `reply ${response.status}`);
  }
}

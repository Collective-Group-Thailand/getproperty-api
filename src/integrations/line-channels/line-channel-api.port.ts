import { type LineMessage } from '@collective/integrations/line';

export const LINE_CHANNEL_API = Symbol('LINE_CHANNEL_API');

/** The bot of a Messaging API channel (`GET /v2/bot/info`). */
export interface LineBotInfo {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

/** LINE refused a call; `status` 401 = the token is wrong or revoked, 429 = quota or rate limit. */
export class LineChannelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LineChannelError';
  }
}

/**
 * The Messaging API of an operator's own LINE Official Account (D-254), called with that channel's access token —
 * the shared getproperty OA keeps `LINE_MESSAGING` (one env token). Push, reply (free at LINE: replies are not
 * counted) and the bot information used to verify a connection.
 */
export interface LineChannelApiPort {
  readonly mode: 'fake' | 'real';
  botInfo(accessToken: string): Promise<LineBotInfo>;
  push(
    accessToken: string,
    to: string,
    messages: LineMessage[],
    retryKey: string,
  ): Promise<{ providerMessageId: string }>;
  reply(accessToken: string, replyToken: string, messages: LineMessage[]): Promise<void>;
}

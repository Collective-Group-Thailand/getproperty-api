import { type LineMessage } from '@collective/integrations/line';

import { type LineBotInfo, type LineChannelApiPort, LineChannelError } from './line-channel-api.port';

/**
 * Fake own-OA channels for tests and `pnpm dev`: a token `fake-token-<name>` is a working channel whose bot is
 * `<name>`; `fake-token-revoked…` answers 401 and `fake-token-quota…` answers 429 on push. Pushes and replies are kept
 * per token for assertions.
 */
export class FakeLineChannelApi implements LineChannelApiPort {
  readonly mode = 'fake' as const;
  readonly pushed: { token: string; to: string; messages: LineMessage[]; retryKey: string }[] = [];
  readonly replied: { token: string; replyToken: string; messages: LineMessage[] }[] = [];

  private check(accessToken: string): string {
    if (!accessToken.startsWith('fake-token-') || accessToken.startsWith('fake-token-revoked'))
      throw new LineChannelError(401, 'invalid channel access token');
    return accessToken.slice('fake-token-'.length);
  }

  /** Settles on the next tick, like a network call; a refusal rejects with `LineChannelError`. */
  private settle<T>(work: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        resolve(work());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  botInfo(accessToken: string): Promise<LineBotInfo> {
    return this.settle(() => {
      const name = this.check(accessToken);
      const hex = Buffer.from(name).toString('hex').padEnd(32, '0').slice(0, 32);
      return { userId: `U${hex}`, displayName: name };
    });
  }

  push(accessToken: string, to: string, messages: LineMessage[], retryKey: string) {
    return this.settle(() => {
      this.check(accessToken);
      if (accessToken.startsWith('fake-token-quota'))
        throw new LineChannelError(429, 'monthly limit reached');
      this.pushed.push({ token: accessToken, to, messages, retryKey });
      return { providerMessageId: `fake-own-${this.pushed.length}` };
    });
  }

  reply(accessToken: string, replyToken: string, messages: LineMessage[]) {
    return this.settle(() => {
      this.check(accessToken);
      this.replied.push({ token: accessToken, replyToken, messages });
    });
  }
}

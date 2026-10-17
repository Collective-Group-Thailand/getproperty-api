import { type LineMessage, type LineMessagingPort } from './line-messaging.port';

export class FakeLineMessaging implements LineMessagingPort {
  readonly mode = 'fake' as const;
  readonly pushed: { to: string; messages: LineMessage[]; retryKey: string }[] = [];

  push(to: string, messages: LineMessage[], retryKey: string): Promise<{ providerMessageId: string }> {
    const existing = this.pushed.find((p) => p.retryKey === retryKey);
    if (!existing) this.pushed.push({ to, messages, retryKey });
    return Promise.resolve({ providerMessageId: `fake-line-${retryKey}` });
  }
}

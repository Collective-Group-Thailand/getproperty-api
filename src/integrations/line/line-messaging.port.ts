export const LINE_MESSAGING = Symbol('LINE_MESSAGING');

/** A LINE message object (text or Flex, Messaging API). */
export type LineMessage =
  { type: 'text'; text: string } | { type: 'flex'; altText: string; contents: Record<string, unknown> };

export interface LineMessagingPort {
  readonly mode: 'fake' | 'real';
  /** Push to one LINE user; `retryKey` (uuid) makes a retried push idempotent at LINE. */
  push(to: string, messages: LineMessage[], retryKey: string): Promise<{ providerMessageId: string }>;
}

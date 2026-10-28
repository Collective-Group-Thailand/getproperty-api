import { type LineMessage } from '@collective/integrations/line';

export const LINE_MULTICAST = Symbol('LINE_MULTICAST');

/**
 * Multicast through getproperty's own (shared) LINE OA (G6, D-300): one identical message to up to 500 LINE user ids
 * per call (Messaging API `POST /v2/bot/message/multicast`); `retryKey` (uuid) makes a retried call idempotent at
 * LINE. Used only for sponsored broadcasts to people who consented (`platform.recommendations`) and only while
 * `broadcast.sponsored.enabled` is on (O-023).
 */
export interface LineMulticastPort {
  readonly mode: 'fake' | 'real';
  multicast(to: string[], messages: LineMessage[], retryKey: string): Promise<{ requestId: string }>;
}

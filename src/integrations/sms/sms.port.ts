export const SMS = Symbol('SMS');

export interface SmsPort {
  readonly mode: 'fake' | 'real';
  /** Sends one SMS to an E.164 number; returns the provider's message id. */
  send(to: string, text: string): Promise<{ providerMessageId: string }>;
}

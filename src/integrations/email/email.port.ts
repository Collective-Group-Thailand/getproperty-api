import { type EmailMessage as SharedEmailMessage } from '@collective/integrations/email';

export const EMAIL = Symbol('EMAIL');

/** The shared message (D-275) with a plain-text part always present (getproperty sends both parts). */
export type EmailMessage = SharedEmailMessage & { text: string };
export type { EmailAttachment } from '@collective/integrations/email';

export interface EmailPort {
  readonly mode: 'fake' | 'real';
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

import { SesEmailSender } from '@collective/integrations/email';

import { type EmailMessage, type EmailPort } from './email.port';

/**
 * Amazon SES v2 — the production email path on the Collective platform (D-230), through the shared
 * `@collective/integrations/email` sender (D-275; raw MIME when a message carries attachments or copies).
 * This class only keeps getproperty's `EmailPort` shape (`mode`) for the call sites.
 * // UNVERIFIED against live provider: no SES account in the sandbox.
 */
export class SesEmailAdapter implements EmailPort {
  readonly mode = 'real' as const;
  private readonly sender: SesEmailSender;

  constructor(options: { region: string; endpoint?: string }, from: string) {
    this.sender = new SesEmailSender({ ...options, from });
  }

  send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    return this.sender.send(message);
  }
}

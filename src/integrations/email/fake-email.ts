import { randomUUID } from 'node:crypto';

import { type EmailMessage, type EmailPort } from './email.port';

export class FakeEmail implements EmailPort {
  readonly mode = 'fake' as const;
  readonly sent: (EmailMessage & { providerMessageId: string })[] = [];

  send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const providerMessageId = `fake-email-${randomUUID()}`;
    this.sent.push({ ...message, providerMessageId });
    return Promise.resolve({ providerMessageId });
  }
}

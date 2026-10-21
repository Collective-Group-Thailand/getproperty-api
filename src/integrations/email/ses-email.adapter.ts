import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

import { ProviderError } from '../http/provider-http';
import { type EmailMessage, type EmailPort } from './email.port';

/**
 * Amazon SES v2 — the production email path on the Collective platform (D-230; getpack's `SES_FROM_ADDRESS`).
 * // UNVERIFIED against live provider: no SES account in the sandbox; written from the SESv2 SendEmail reference.
 */
export class SesEmailAdapter implements EmailPort {
  readonly mode = 'real' as const;
  private readonly client: SESv2Client;

  constructor(
    options: { region: string; endpoint?: string },
    private readonly from: string,
  ) {
    this.client = new SESv2Client({ region: options.region, endpoint: options.endpoint, maxAttempts: 3 });
  }

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: message.html, Charset: 'UTF-8' },
                Text: { Data: message.text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
      return { providerMessageId: out.MessageId ?? 'ses-unknown' };
    } catch (error) {
      throw new ProviderError('email', (error as Error).message);
    }
  }
}

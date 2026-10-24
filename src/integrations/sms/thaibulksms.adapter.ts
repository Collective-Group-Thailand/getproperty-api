import { type ThaiBulkSmsConfig, ThaiBulkSmsSender } from '@collective/integrations/sms';

import { type SmsPort } from './sms.port';

export type ThaiBulkSmsOptions = Required<Pick<ThaiBulkSmsConfig, 'apiKey' | 'apiSecret' | 'sender'>> &
  Pick<ThaiBulkSmsConfig, 'creditType'>;

/**
 * ThaiBulkSMS v2 through the shared `@collective/integrations/sms` sender (D-275; getpack's adapter, which also sends
 * the credit type). This class only keeps getproperty's `SmsPort` shape (`send(to, text)`, `mode`) for the call sites.
 * // UNVERIFIED against live provider (see the shared package's README).
 */
export class ThaiBulkSmsAdapter implements SmsPort {
  readonly mode = 'real' as const;
  private readonly sender: ThaiBulkSmsSender;

  constructor(options: ThaiBulkSmsOptions, fetchImpl: typeof fetch = fetch) {
    this.sender = new ThaiBulkSmsSender(options, fetchImpl);
  }

  send(to: string, text: string): Promise<{ providerMessageId: string }> {
    return this.sender.send({ to, text });
  }
}

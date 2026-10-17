import { ProviderError, providerFetch } from '../http/provider-http';
import { type SmsPort } from './sms.port';

export interface ThaiBulkSmsOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  sender: string;
}

/**
 * ThaiBulkSMS-class REST adapter (master plan §4 "sms-otp").
 * // UNVERIFIED against live provider: written from the provider's public API v2 documentation
 * (`POST {baseUrl}/sms`, HTTP Basic auth with key/secret, form fields msisdn/message/sender, response
 * `phone_number_list[].message_id`). Phones are sent in the local 0XXXXXXXXX form the provider expects.
 */
export class ThaiBulkSmsAdapter implements SmsPort {
  readonly mode = 'real' as const;

  constructor(private readonly options: ThaiBulkSmsOptions) {}

  async send(to: string, text: string): Promise<{ providerMessageId: string }> {
    const msisdn = to.startsWith('+66') ? `0${to.slice(3)}` : to;
    const body = new URLSearchParams({ msisdn, message: text, sender: this.options.sender });
    const auth = Buffer.from(`${this.options.apiKey}:${this.options.apiSecret}`).toString('base64');
    const response = await providerFetch({
      provider: 'sms',
      url: `${this.options.baseUrl.replace(/\/$/, '')}/sms`,
      init: {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
    });
    if (!response.ok) throw new ProviderError('sms', `HTTP ${response.status}`, response.status, false);
    const json = (await response.json()) as { phone_number_list?: { message_id?: string }[] };
    const id = json.phone_number_list?.[0]?.message_id;
    if (!id) throw new ProviderError('sms', 'no message id in response', response.status, false);
    return { providerMessageId: id };
  }
}

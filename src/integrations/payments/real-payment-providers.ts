import { createHmac, timingSafeEqual } from 'node:crypto';

import { ProviderError, providerFetch } from '../http/provider-http';
import {
  type CreatedQr,
  type Merchant,
  type ParsedWebhook,
  parseSettlementCsv,
  type PaymentProviderRegistry,
  type ProviderPayment,
  type QrPaymentAdapter,
  type QrProvider,
  type SlipVerification,
  type SlipVerifierPort,
} from './payment-provider.port';
import { qrReference } from './thai-qr';

const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hmacHex = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');
const need = (m: Merchant, key: string): string => {
  const v = m.credentials[key];
  if (!v) throw new ProviderError(m.provider, `merchant credential ${key} missing`, undefined, false);
  return v;
};

/**
 * SCB Open API — Thai QR (Tag 30) for a biller (`POST /v1/payment/qrcode/create`, OAuth client credentials
 * `POST /v1/oauth/token`), payment confirmation callback to the merchant's URL, inquiry
 * `GET /v1/payment/billpayment/inquiry`. Credentials: `apiKey`, `apiSecret`, `billerId`, `webhookSecret`.
 * // UNVERIFIED against live provider: written from the public SCB developer documentation (O-001).
 */
export class ScbQrAdapter implements QrPaymentAdapter {
  readonly provider = 'scb' as const;
  readonly mode = 'real' as const;

  constructor(private readonly baseUrl: string) {}

  private async token(m: Merchant): Promise<string> {
    const res = await providerFetch({
      provider: 'scb',
      url: `${this.baseUrl}/v1/oauth/token`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          resourceOwnerId: need(m, 'apiKey'),
          requestUId: crypto.randomUUID(),
        },
        body: JSON.stringify({ applicationKey: need(m, 'apiKey'), applicationSecret: need(m, 'apiSecret') }),
      },
    });
    if (!res.ok) throw new ProviderError('scb', `token HTTP ${res.status}`, res.status, false);
    const json = (await res.json()) as { data?: { accessToken?: string } };
    if (!json.data?.accessToken) throw new ProviderError('scb', 'no access token', undefined, false);
    return json.data.accessToken;
  }

  async createQr(input: {
    merchant: Merchant;
    amount: string;
    reference: string;
    ref2?: string | null;
    expiresAt: Date;
  }): Promise<CreatedQr> {
    const token = await this.token(input.merchant);
    const res = await providerFetch({
      provider: 'scb',
      url: `${this.baseUrl}/v1/payment/qrcode/create`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          resourceOwnerId: need(input.merchant, 'apiKey'),
          requestUId: crypto.randomUUID(),
        },
        body: JSON.stringify({
          qrType: 'PP',
          ppType: 'BILLERID',
          ppId: need(input.merchant, 'billerId'),
          amount: input.amount,
          ref1: qrReference(input.reference),
          ref2: qrReference(input.ref2 ?? 'GETPROPERTY'),
          ref3: 'GPR',
        }),
      },
    });
    if (!res.ok) throw new ProviderError('scb', `qrcode HTTP ${res.status}`, res.status, false);
    const json = (await res.json()) as { data?: { qrRawData?: string } };
    if (!json.data?.qrRawData) throw new ProviderError('scb', 'no QR payload', undefined, false);
    return { payload: json.data.qrRawData, providerQrId: null, expiresAt: input.expiresAt };
  }

  async queryStatus(merchant: Merchant, reference: string): Promise<ProviderPayment | null> {
    const token = await this.token(merchant);
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const url = `${this.baseUrl}/v1/payment/billpayment/inquiry?billerId=${encodeURIComponent(need(merchant, 'billerId'))}&reference1=${encodeURIComponent(qrReference(reference))}&transactionDate=${today}&eventCode=00300100`;
    const res = await providerFetch({
      provider: 'scb',
      url,
      init: {
        headers: {
          authorization: `Bearer ${token}`,
          resourceOwnerId: need(merchant, 'apiKey'),
          requestUId: crypto.randomUUID(),
        },
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { transactionId: string; amount: string; transactionDateandTime: string }[];
    };
    const t = json.data?.[0];
    return t
      ? {
          providerRef: t.transactionId,
          reference,
          amount: Number(t.amount).toFixed(2),
          paidAt: new Date(t.transactionDateandTime),
          status: 'paid',
        }
      : null;
  }

  parseWebhook(_headers: Record<string, string | undefined>, rawBody: Buffer): ParsedWebhook {
    const j = JSON.parse(rawBody.toString('utf8')) as {
      transactionId?: string;
      billPaymentRef1?: string;
      amount?: string;
      transactionDateandTime?: string;
      payeeProxyId?: string;
    };
    if (!j.transactionId || !j.billPaymentRef1 || !j.amount || !j.payeeProxyId)
      throw new Error('malformed callback');
    return {
      eventId: j.transactionId,
      merchantRef: j.payeeProxyId,
      payments: [
        {
          providerRef: j.transactionId,
          reference: j.billPaymentRef1,
          amount: Number(j.amount).toFixed(2),
          paidAt: new Date(j.transactionDateandTime ?? Date.now()),
          status: 'paid',
        },
      ],
    };
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: Buffer, merchant: Merchant): boolean {
    // SCB does not sign callbacks by default; the merchant configures a shared secret on the callback URL
    const given = headers['x-scb-signature'] ?? '';
    return safeEqual(given, hmacHex(need(merchant, 'webhookSecret'), rawBody));
  }

  parseSettlementFile(content: Buffer): ProviderPayment[] {
    return parseSettlementCsv(content);
  }

  fetchSettlement(): Promise<ProviderPayment[]> {
    // SCB delivers statements by SFTP to the merchant: the owner uploads the file (POST /v1/owner/payment-settlements)
    return Promise.resolve([]);
  }
}

/**
 * KBank (K API) — QR payment (`POST /v1/qrpayment/request`, OAuth client credentials `POST /v2/oauth/token`),
 * callback signed by the merchant's shared secret, inquiry `POST /v1/qrpayment/v4/inquiry`. Credentials:
 * `consumerId`, `consumerSecret`, `partnerId`, `partnerSecret`, `merchantId`, `webhookSecret`.
 * // UNVERIFIED against live provider: written from the public KBank API documentation (O-001).
 */
export class KbankQrAdapter implements QrPaymentAdapter {
  readonly provider = 'kbank' as const;
  readonly mode = 'real' as const;

  constructor(private readonly baseUrl: string) {}

  private async token(m: Merchant): Promise<string> {
    const basic = Buffer.from(`${need(m, 'consumerId')}:${need(m, 'consumerSecret')}`).toString('base64');
    const res = await providerFetch({
      provider: 'kbank',
      url: `${this.baseUrl}/v2/oauth/token`,
      init: {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      },
    });
    if (!res.ok) throw new ProviderError('kbank', `token HTTP ${res.status}`, res.status, false);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new ProviderError('kbank', 'no access token', undefined, false);
    return json.access_token;
  }

  async createQr(input: {
    merchant: Merchant;
    amount: string;
    reference: string;
    expiresAt: Date;
  }): Promise<CreatedQr> {
    const token = await this.token(input.merchant);
    const res = await providerFetch({
      provider: 'kbank',
      url: `${this.baseUrl}/v1/qrpayment/request`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          partnerTxnUid: crypto.randomUUID().replace(/-/g, '').slice(0, 20),
          partnerId: need(input.merchant, 'partnerId'),
          partnerSecret: need(input.merchant, 'partnerSecret'),
          requestDt: new Date().toISOString(),
          merchantId: need(input.merchant, 'merchantId'),
          qrType: 3,
          txnAmount: input.amount,
          txnCurrencyCode: 'THB',
          reference1: qrReference(input.reference),
          reference2: 'GETPROPERTY',
        }),
      },
    });
    if (!res.ok) throw new ProviderError('kbank', `qr HTTP ${res.status}`, res.status, false);
    const json = (await res.json()) as { qrCode?: string; partnerTxnUid?: string };
    if (!json.qrCode) throw new ProviderError('kbank', 'no QR payload', undefined, false);
    return { payload: json.qrCode, providerQrId: json.partnerTxnUid ?? null, expiresAt: input.expiresAt };
  }

  queryStatus(): Promise<ProviderPayment | null> {
    // the inquiry needs the partner transaction id of the request; the daily settlement file is the fallback
    return Promise.resolve(null);
  }

  parseWebhook(_headers: Record<string, string | undefined>, rawBody: Buffer): ParsedWebhook {
    const j = JSON.parse(rawBody.toString('utf8')) as {
      partnerTxnUid?: string;
      txnNo?: string;
      merchantId?: string;
      reference1?: string;
      txnAmount?: string;
      txnDt?: string;
      txnStatus?: string;
    };
    if (!j.txnNo || !j.merchantId || !j.reference1 || !j.txnAmount) throw new Error('malformed callback');
    return {
      eventId: j.partnerTxnUid ?? j.txnNo,
      merchantRef: j.merchantId,
      payments: [
        {
          providerRef: j.txnNo,
          reference: j.reference1,
          amount: Number(j.txnAmount).toFixed(2),
          paidAt: new Date(j.txnDt ?? Date.now()),
          status: j.txnStatus === 'PAID' || !j.txnStatus ? 'paid' : 'failed',
        },
      ],
    };
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: Buffer, merchant: Merchant): boolean {
    const given = headers['x-kbank-signature'] ?? '';
    return safeEqual(given, hmacHex(need(merchant, 'webhookSecret'), rawBody));
  }

  parseSettlementFile(content: Buffer): ProviderPayment[] {
    return parseSettlementCsv(content);
  }

  fetchSettlement(): Promise<ProviderPayment[]> {
    return Promise.resolve([]);
  }
}

/**
 * Opn Payments (Omise) — PromptPay source + charge (`POST /charges` with `source[type]=promptpay`, Basic auth with
 * the secret key), `charge.complete` events signed in `Omise-Signature` (HMAC-SHA256 of `timestamp.body`).
 * Credentials: `secretKey`, `webhookSecret`. The scannable code is an image; its EMV payload is read from the
 * charge source when available. // UNVERIFIED against live provider: written from the public Opn documentation.
 */
export class OpnQrAdapter implements QrPaymentAdapter {
  readonly provider = 'opn' as const;
  readonly mode = 'real' as const;

  constructor(private readonly baseUrl: string) {}

  async createQr(input: {
    merchant: Merchant;
    amount: string;
    reference: string;
    expiresAt: Date;
  }): Promise<CreatedQr> {
    const satang = Math.round(Number(input.amount) * 100);
    const body = new URLSearchParams({
      amount: String(satang),
      currency: 'THB',
      'source[type]': 'promptpay',
      description: qrReference(input.reference),
      'metadata[reference]': qrReference(input.reference),
      expires_at: input.expiresAt.toISOString(),
    });
    const res = await providerFetch({
      provider: 'opn',
      url: `${this.baseUrl}/charges`,
      init: {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${need(input.merchant, 'secretKey')}:`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      },
    });
    if (!res.ok) throw new ProviderError('opn', `charge HTTP ${res.status}`, res.status, false);
    const json = (await res.json()) as { id?: string; source?: { scannable_code?: { raw_data?: string } } };
    const payload = json.source?.scannable_code?.raw_data;
    if (!json.id || !payload) throw new ProviderError('opn', 'no QR payload', undefined, false);
    return { payload, providerQrId: json.id, expiresAt: input.expiresAt };
  }

  queryStatus(): Promise<ProviderPayment | null> {
    return Promise.resolve(null);
  }

  parseWebhook(_headers: Record<string, string | undefined>, rawBody: Buffer): ParsedWebhook {
    const j = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      key?: string;
      data?: {
        id?: string;
        status?: string;
        amount?: number;
        paid_at?: string;
        metadata?: { reference?: string };
        account?: string;
      };
    };
    if (!j.id || !j.data?.id || !j.data.metadata?.reference) throw new Error('malformed callback');
    return {
      eventId: j.id,
      merchantRef: j.data.account ?? '',
      payments:
        j.key === 'charge.complete'
          ? [
              {
                providerRef: j.data.id,
                reference: j.data.metadata.reference,
                amount: ((j.data.amount ?? 0) / 100).toFixed(2),
                paidAt: new Date(j.data.paid_at ?? Date.now()),
                status: j.data.status === 'successful' ? 'paid' : 'failed',
              },
            ]
          : [],
    };
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: Buffer, merchant: Merchant): boolean {
    const ts = headers['omise-signature-timestamp'] ?? '';
    const given = (headers['omise-signature'] ?? '').split(',');
    const secret = Buffer.from(need(merchant, 'webhookSecret'), 'base64').toString('utf8');
    const expected = hmacHex(secret, `${ts}.${rawBody.toString('utf8')}`);
    return given.some((g) => safeEqual(g, expected));
  }

  parseSettlementFile(content: Buffer): ProviderPayment[] {
    return parseSettlementCsv(content);
  }

  fetchSettlement(): Promise<ProviderPayment[]> {
    return Promise.resolve([]);
  }
}

export class RealPaymentProviders implements PaymentProviderRegistry {
  readonly mode = 'real' as const;
  private readonly adapters: Record<QrProvider, QrPaymentAdapter>;

  constructor(urls: { kbank: string; scb: string; opn: string }) {
    this.adapters = {
      kbank: new KbankQrAdapter(urls.kbank),
      scb: new ScbQrAdapter(urls.scb),
      opn: new OpnQrAdapter(urls.opn),
    };
  }

  adapter(provider: QrProvider): QrPaymentAdapter {
    return this.adapters[provider];
  }
}

/**
 * EasySlip-class slip verification (`POST /api/v1/verify`, multipart `file`, Bearer key): returns the bank
 * reference, amount, date, sender and (masked) receiver. // UNVERIFIED against live provider: written from the
 * public EasySlip documentation.
 */
export class EasySlipVerifier implements SlipVerifierPort {
  readonly provider = 'easyslip';
  readonly mode = 'real' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async verify(image: Buffer, mimeType: string): Promise<SlipVerification> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image)], { type: mimeType }), 'slip');
    const res = await providerFetch({
      provider: 'easyslip',
      url: `${this.baseUrl}/api/v1/verify`,
      init: { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: form },
      retries: 1,
    });
    const json = (await res.json().catch(() => ({}))) as {
      status?: number;
      data?: {
        transRef?: string;
        date?: string;
        amount?: { amount?: number };
        sender?: { account?: { name?: { th?: string; en?: string } } };
        receiver?: {
          bank?: { id?: string };
          account?: { name?: { th?: string; en?: string }; bank?: { account?: string } };
        };
      };
    };
    const d = json.data;
    if (!res.ok || !d?.transRef)
      return {
        valid: false,
        transRef: null,
        amount: null,
        paidAt: null,
        receiverBankCode: null,
        receiverAccount: null,
        receiverName: null,
        senderName: null,
        raw: { status: res.status },
      };
    return {
      valid: true,
      transRef: d.transRef,
      amount: d.amount?.amount !== undefined ? d.amount.amount.toFixed(2) : null,
      paidAt: d.date ? new Date(d.date) : null,
      receiverBankCode: d.receiver?.bank?.id ?? null,
      receiverAccount: d.receiver?.account?.bank?.account ?? null,
      receiverName: d.receiver?.account?.name?.th ?? d.receiver?.account?.name?.en ?? null,
      senderName: d.sender?.account?.name?.th ?? d.sender?.account?.name?.en ?? null,
      raw: { status: res.status, transRef: d.transRef },
    };
  }
}

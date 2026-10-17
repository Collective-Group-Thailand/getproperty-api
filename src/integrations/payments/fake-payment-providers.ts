import { createHmac, timingSafeEqual } from 'node:crypto';

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
import { buildThaiQrBillPayment } from './thai-qr';

/** The webhook secret of a fake merchant (tests sign callbacks with it). */
export const fakeWebhookSecret = (provider: QrProvider, merchantRef: string) =>
  `fake-${provider}-webhook-${merchantRef}`;

export const signFakeWebhook = (body: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * The fake provider (tests, `pnpm dev`): builds a real Thai QR Tag 30 payload (biller id = the merchant ref padded
 * to 15 digits), signs callbacks with HMAC-SHA256 (`x-provider-signature`), keeps paid references in memory so
 * `queryStatus` / `fetchSettlement` answer like a provider would — including payments whose callback never came.
 */
export class FakeQrPaymentAdapter implements QrPaymentAdapter {
  readonly mode = 'fake' as const;
  readonly created: { merchantRef: string; reference: string; amount: string }[] = [];
  private readonly paid: (ProviderPayment & { merchantRef: string })[] = [];

  constructor(readonly provider: QrProvider) {}

  createQr(input: {
    merchant: Merchant;
    amount: string;
    reference: string;
    expiresAt: Date;
  }): Promise<CreatedQr> {
    this.created.push({
      merchantRef: input.merchant.merchantRef,
      reference: input.reference,
      amount: input.amount,
    });
    const billerId = input.merchant.merchantRef.replace(/\D/g, '').padStart(15, '0').slice(-15);
    return Promise.resolve({
      payload: buildThaiQrBillPayment({
        billerId,
        ref1: input.reference,
        amount: input.amount,
        merchantName: input.merchant.accountName,
      }),
      providerQrId: `fakeqr_${this.created.length}`,
      expiresAt: input.expiresAt,
    });
  }

  /** Test helper: the provider records a payment (the callback may or may not be delivered). */
  simulatePayment(p: {
    merchantRef: string;
    reference: string;
    amount: string;
    providerRef: string;
    paidAt: Date;
  }) {
    this.paid.push({ ...p, status: 'paid' });
    const body = JSON.stringify({
      eventId: `evt_${p.providerRef}`,
      merchantRef: p.merchantRef,
      payments: [
        {
          providerRef: p.providerRef,
          reference: p.reference,
          amount: p.amount,
          paidAt: p.paidAt.toISOString(),
          status: 'paid',
        },
      ],
    });
    return {
      body,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': signFakeWebhook(body, fakeWebhookSecret(this.provider, p.merchantRef)),
      },
    };
  }

  queryStatus(merchant: Merchant, reference: string): Promise<ProviderPayment | null> {
    const p = this.paid.find((x) => x.merchantRef === merchant.merchantRef && x.reference === reference);
    return Promise.resolve(p ? { ...p } : null);
  }

  parseWebhook(_headers: Record<string, string | undefined>, rawBody: Buffer): ParsedWebhook {
    const json = JSON.parse(rawBody.toString('utf8')) as {
      eventId?: string;
      merchantRef?: string;
      payments?: {
        providerRef: string;
        reference: string;
        amount: string;
        paidAt: string;
        status?: string;
      }[];
    };
    if (!json.eventId || !json.merchantRef || !Array.isArray(json.payments))
      throw new Error('malformed callback');
    return {
      eventId: json.eventId,
      merchantRef: json.merchantRef,
      payments: json.payments.map((p) => ({
        providerRef: p.providerRef,
        reference: p.reference,
        amount: Number(p.amount).toFixed(2),
        paidAt: new Date(p.paidAt),
        status: p.status === 'reversed' ? 'reversed' : p.status === 'failed' ? 'failed' : 'paid',
      })),
    };
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: Buffer, merchant: Merchant): boolean {
    const given = headers['x-provider-signature'] ?? '';
    const secret =
      merchant.credentials.webhookSecret ?? fakeWebhookSecret(this.provider, merchant.merchantRef);
    const expected = signFakeWebhook(rawBody.toString('utf8'), secret);
    return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  parseSettlementFile(content: Buffer): ProviderPayment[] {
    return parseSettlementCsv(content);
  }

  fetchSettlement(merchant: Merchant, statementDate: string): Promise<ProviderPayment[]> {
    return Promise.resolve(
      this.paid
        .filter((p) => p.merchantRef === merchant.merchantRef && bangkokDay(p.paidAt) === statementDate)
        .map(({ merchantRef: _m, ...p }) => p),
    );
  }
}

const bangkokDay = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export class FakePaymentProviders implements PaymentProviderRegistry {
  readonly mode = 'fake' as const;
  private readonly adapters = new Map<QrProvider, FakeQrPaymentAdapter>();

  adapter(provider: QrProvider): FakeQrPaymentAdapter {
    let a = this.adapters.get(provider);
    if (!a) {
      a = new FakeQrPaymentAdapter(provider);
      this.adapters.set(provider, a);
    }
    return a;
  }
}

/**
 * The fake slip verifier: a "slip image" carrying JSON (`{"transRef","amount","paidAt","receiverBankCode",
 * "receiverAccount","receiverName","senderName"}`, optionally after the bytes of a real image) is a valid slip;
 * anything else is not recognised.
 */
export class FakeSlipVerifier implements SlipVerifierPort {
  readonly provider = 'fake';
  readonly mode = 'fake' as const;

  verify(image: Buffer): Promise<SlipVerification> {
    const text = image.toString('utf8');
    const start = text.indexOf('{"transRef"');
    const none: SlipVerification = {
      valid: false,
      transRef: null,
      amount: null,
      paidAt: null,
      receiverBankCode: null,
      receiverAccount: null,
      receiverName: null,
      senderName: null,
      raw: { recognised: false },
    };
    if (start < 0) return Promise.resolve(none);
    try {
      const j = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as Record<string, string>;
      return Promise.resolve({
        valid: true,
        transRef: j.transRef ?? null,
        amount: j.amount ? Number(j.amount).toFixed(2) : null,
        paidAt: j.paidAt ? new Date(j.paidAt) : null,
        receiverBankCode: j.receiverBankCode ?? null,
        receiverAccount: j.receiverAccount ?? null,
        receiverName: j.receiverName ?? null,
        senderName: j.senderName ?? null,
        raw: { recognised: true, transRef: j.transRef ?? null },
      });
    } catch {
      return Promise.resolve(none);
    }
  }
}

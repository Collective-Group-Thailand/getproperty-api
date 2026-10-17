/**
 * Payment providers (B4.4, D-042, ADR-0008): a dynamic Thai QR per invoice through the tenant's own merchant account
 * at its bank or gateway (KBank, SCB, Opn — O-001); the money lands in the tenant's account, the platform never holds
 * funds. One adapter per provider; credentials per merchant come from the secret store, never from the database.
 */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
export const SLIP_VERIFIER = Symbol('SLIP_VERIFIER');

export type QrProvider = 'kbank' | 'scb' | 'opn';
export const QR_PROVIDERS: readonly QrProvider[] = ['kbank', 'scb', 'opn'];

/** A tenant's merchant at a provider (from `platform.tenant_bank_account` + the secret store). */
export interface Merchant {
  provider: QrProvider;
  /** Merchant / biller id at the provider (`provider_merchant_ref`). */
  merchantRef: string;
  accountName: string;
  /** Per-merchant secrets (`payments/<provider>/<merchantRef>`): API keys, webhook secret. */
  credentials: Record<string, string>;
}

export interface CreatedQr {
  /** EMVCo payload (Thai QR, Tag 30). */
  payload: string;
  providerQrId: string | null;
  expiresAt: Date | null;
}

export interface ProviderPayment {
  /** Provider transaction id: payments are idempotent on (provider, providerRef). */
  providerRef: string;
  /** The reference the QR carried (the invoice payment reference). */
  reference: string;
  amount: string;
  paidAt: Date;
  status: 'paid' | 'failed' | 'reversed';
}

export interface ParsedWebhook {
  /** Provider event id: the callback log is idempotent on it. */
  eventId: string;
  /** The merchant the callback is for (resolved to one tenant bank account). */
  merchantRef: string;
  payments: ProviderPayment[];
}

export interface QrPaymentAdapter {
  readonly provider: QrProvider;
  readonly mode: 'fake' | 'real';
  createQr(input: {
    merchant: Merchant;
    amount: string;
    reference: string;
    ref2?: string | null;
    expiresAt: Date;
  }): Promise<CreatedQr>;
  /** Status of a QR / reference at the provider (missed-callback checks). */
  queryStatus(merchant: Merchant, reference: string): Promise<ProviderPayment | null>;
  /** Reads a callback body (throws on a malformed one); the signature is checked separately. */
  parseWebhook(headers: Record<string, string | undefined>, rawBody: Buffer): ParsedWebhook;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: Buffer, merchant: Merchant): boolean;
  /** Rows of a settlement / statement file (uploaded by the owner or fetched by the daily reconcile). */
  parseSettlementFile(content: Buffer): ProviderPayment[];
  fetchSettlement(merchant: Merchant, statementDate: string): Promise<ProviderPayment[]>;
}

export interface PaymentProviderRegistry {
  readonly mode: 'fake' | 'real';
  adapter(provider: QrProvider): QrPaymentAdapter;
}

export interface SlipVerification {
  /** The provider recognised a real bank transfer slip. */
  valid: boolean;
  transRef: string | null;
  amount: string | null;
  paidAt: Date | null;
  receiverBankCode: string | null;
  /** As printed / returned (usually masked, e.g. xxx-x-x1234-x). */
  receiverAccount: string | null;
  receiverName: string | null;
  senderName: string | null;
  /** Redacted provider response (no full account numbers). */
  raw: Record<string, unknown>;
}

export interface SlipVerifierPort {
  readonly provider: string;
  readonly mode: 'fake' | 'real';
  verify(image: Buffer, mimeType: string): Promise<SlipVerification>;
}

/** Generic settlement CSV: `provider_ref,reference,amount,paid_at[,status]` with a header row. */
export function parseSettlementCsv(content: Buffer): ProviderPayment[] {
  const lines = content
    .toString('utf8')
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const [header, ...rows] = lines;
  if (!header?.toLowerCase().startsWith('provider_ref')) throw new Error('settlement file: unknown header');
  return rows.map((row, i) => {
    const [providerRef, reference, amount, paidAt, status] = row.split(',').map((c) => c.trim());
    if (
      !providerRef ||
      !reference ||
      !amount ||
      !/^\d+(\.\d{1,2})?$/.test(amount) ||
      !paidAt ||
      Number.isNaN(Date.parse(paidAt))
    )
      throw new Error(`settlement file: row ${i + 2} is malformed`);
    return {
      providerRef,
      reference,
      amount: Number(amount).toFixed(2),
      paidAt: new Date(paidAt),
      status: status === 'reversed' ? 'reversed' : status === 'failed' ? 'failed' : 'paid',
    };
  });
}

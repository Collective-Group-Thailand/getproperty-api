/**
 * e-Tax Invoice & e-Receipt service providers (B6.2, D-050, D-215): the platform never signs documents itself — a
 * Revenue-Department-approved service provider holds the tenant's certificate, signs the XML (ETDA ขมธอ. 3-2560
 * structure) and the PDF/A-3 and files them with the Revenue Department. One port, one adapter per provider, a fake
 * for dev/tests. Per-tenant provider credentials live in the secret store (`ETAX_SECRETS_PREFIX/<provider>/<tenantId>`),
 * never in the database.
 */
export const ETAX_PROVIDERS = Symbol('ETAX_PROVIDERS');

export type EtaxProviderKey = 'inet';
export const ETAX_PROVIDER_KEYS: readonly EtaxProviderKey[] = ['inet'];

/** ETDA document type codes (ขมธอ. 3-2560): T01 receipt, T03 receipt / tax invoice, 388 tax invoice, 80 debit, 81 credit. */
export type EtaxDocumentTypeCode = 'T01' | 'T03' | '388' | '80' | '81';

export interface EtaxAccount {
  provider: EtaxProviderKey;
  /** Secrets of the tenant's provider account (API keys, user code …). */
  credentials: Record<string, string>;
}

export interface EtaxParty {
  name: string;
  /** 13-digit tax id; null for a person without one (receipts to residents). */
  taxId: string | null;
  /** Branch code, `00000` = head office; null for persons. */
  branch: string | null;
  address: string | null;
  postcode: string | null;
  email: string | null;
}

export interface EtaxLine {
  name: string;
  quantity: string;
  unitPrice: string;
  /** Line amount before VAT (decimal string). */
  amount: string;
  /** `7.00` for VAT-able lines, `0.00` otherwise. */
  vatRatePct: string;
}

export interface EtaxDocumentInput {
  /** Our submission id — the idempotency key at the provider (a resubmission never creates a second document). */
  submissionRef: string;
  typeCode: EtaxDocumentTypeCode;
  number: string;
  issuedAt: Date;
  seller: EtaxParty & { taxId: string; branch: string };
  buyer: EtaxParty;
  lines: EtaxLine[];
  subtotal: string;
  vatAmount: string;
  total: string;
  currency: 'THB';
  /** The invoices / documents this one refers to (receipt of invoice numbers …). */
  references: { number: string; issuedOn: string; typeCode: string }[];
  /** Our rendered A4 PDF; the provider embeds the XML and signs it as PDF/A-3. */
  pdf: Buffer;
}

export type EtaxProviderStatus = 'submitted' | 'signed' | 'rejected';

export interface EtaxSubmitResult {
  providerDocId: string;
  status: EtaxProviderStatus;
  error: string | null;
  /** Provider data needed later (download links, transaction codes); stored as `provider_meta`. */
  meta: Record<string, unknown>;
}

export interface EtaxStatusResult {
  status: EtaxProviderStatus;
  error: string | null;
  meta: Record<string, unknown>;
}

export interface EtaxSignedArtefacts {
  xml: Buffer;
  pdf: Buffer;
}

export interface EtaxProviderAdapter {
  readonly provider: EtaxProviderKey;
  readonly mode: 'fake' | 'real';
  submit(account: EtaxAccount, doc: EtaxDocumentInput): Promise<EtaxSubmitResult>;
  status(
    account: EtaxAccount,
    providerDocId: string,
    meta: Record<string, unknown>,
  ): Promise<EtaxStatusResult>;
  fetchSigned(
    account: EtaxAccount,
    providerDocId: string,
    meta: Record<string, unknown>,
  ): Promise<EtaxSignedArtefacts>;
}

export interface EtaxProviderRegistry {
  readonly mode: 'fake' | 'real';
  adapter(provider: EtaxProviderKey): EtaxProviderAdapter;
}

/** The provider refused the call (a rejection of the document is a status, not an error). */
export class EtaxProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable = true,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'EtaxProviderError';
  }
}

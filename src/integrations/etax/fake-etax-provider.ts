import { createHash } from 'node:crypto';

import {
  type EtaxAccount,
  type EtaxDocumentInput,
  type EtaxProviderAdapter,
  EtaxProviderError,
  type EtaxProviderKey,
  type EtaxProviderRegistry,
  type EtaxSignedArtefacts,
  type EtaxStatusResult,
  type EtaxSubmitResult,
} from './etax-provider.port';

interface FakeDoc {
  input: EtaxDocumentInput;
  polls: number;
  rejected: string | null;
}

/**
 * In-memory e-Tax service provider: accepts a document (`submitted`), signs it on the next status poll, returns a
 * deterministic "signed" XML and a PDF carrying a signature marker. Tests can make a submission fail (`failing`) or be
 * rejected (`rejectNumbers`), and read what was submitted.
 */
export class FakeEtaxProvider implements EtaxProviderAdapter {
  readonly mode = 'fake' as const;
  readonly docs = new Map<string, FakeDoc>();
  private readonly byRef = new Map<string, string>();
  /** Submissions fail with a retryable error while true. */
  failing = false;
  /** Document numbers the provider rejects (validation error at the Revenue Department format check). */
  readonly rejectNumbers = new Set<string>();
  /** Every new document is rejected while true. */
  rejectAll = false;

  constructor(readonly provider: EtaxProviderKey) {}

  submit(_account: EtaxAccount, doc: EtaxDocumentInput): Promise<EtaxSubmitResult> {
    if (this.failing) return Promise.reject(new EtaxProviderError(this.provider, 'provider unavailable'));
    const existing = this.byRef.get(doc.submissionRef);
    // a resubmission after the owner fixed the data is judged again
    if (
      existing &&
      this.docs.get(existing)?.rejected &&
      !this.rejectAll &&
      !this.rejectNumbers.has(doc.number)
    )
      this.docs.get(existing)!.rejected = null;
    const id =
      existing ?? `fake-etax-${createHash('sha256').update(doc.submissionRef).digest('hex').slice(0, 16)}`;
    if (!existing) {
      this.byRef.set(doc.submissionRef, id);
      this.docs.set(id, {
        input: doc,
        polls: 0,
        rejected: this.rejectAll || this.rejectNumbers.has(doc.number) ? 'E101: buyer tax id format' : null,
      });
    }
    return Promise.resolve({ providerDocId: id, status: 'submitted', error: null, meta: { fake: true } });
  }

  status(_account: EtaxAccount, providerDocId: string): Promise<EtaxStatusResult> {
    const d = this.docs.get(providerDocId);
    if (!d) return Promise.reject(new EtaxProviderError(this.provider, 'unknown document', false));
    d.polls += 1;
    if (d.rejected) return Promise.resolve({ status: 'rejected', error: d.rejected, meta: {} });
    return Promise.resolve({ status: 'signed', error: null, meta: { signedAt: new Date().toISOString() } });
  }

  fetchSigned(_account: EtaxAccount, providerDocId: string): Promise<EtaxSignedArtefacts> {
    const d = this.docs.get(providerDocId);
    if (!d) return Promise.reject(new EtaxProviderError(this.provider, 'unknown document', false));
    const xml = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<rsm:TaxInvoice_CrossIndustryInvoice xmlns:rsm="urn:etda:uncefact:data:standard:TaxInvoice_CrossIndustryInvoice:2">`,
        `<ram:ID>${d.input.number}</ram:ID><ram:TypeCode>${d.input.typeCode}</ram:TypeCode>`,
        `<ram:GrandTotalAmount>${d.input.total}</ram:GrandTotalAmount>`,
        `<ds:Signature>FAKE-${providerDocId}</ds:Signature>`,
        '</rsm:TaxInvoice_CrossIndustryInvoice>',
      ].join(''),
    );
    const pdf = Buffer.concat([d.input.pdf, Buffer.from(`\n%FAKE-ETAX-SIGNATURE ${providerDocId}\n`)]);
    return Promise.resolve({ xml, pdf });
  }
}

export class FakeEtaxProviders implements EtaxProviderRegistry {
  readonly mode = 'fake' as const;
  readonly inet = new FakeEtaxProvider('inet');

  adapter(provider: EtaxProviderKey): EtaxProviderAdapter {
    if (provider !== 'inet') throw new EtaxProviderError(provider, 'unknown provider', false);
    return this.inet;
  }
}

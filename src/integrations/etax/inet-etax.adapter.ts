import { ProviderError, providerFetch } from '../http/provider-http';
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

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v ? v : fallback);

const need = (account: EtaxAccount, key: string): string => {
  const v = account.credentials[key];
  if (!v) throw new EtaxProviderError('inet', `credential ${key} missing`, false);
  return v;
};

/** One CSV field: quoted, inner quotes doubled, line breaks folded (the text format is line-oriented). */
const f = (v: string | null | undefined): string =>
  `"${(v ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, '""')}"`;

const ymd = (d: Date): string => {
  const b = new Date(d.getTime() + 7 * 3_600_000); // Asia/Bangkok
  return `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, '0')}-${String(b.getUTCDate()).padStart(2, '0')}T${String(b.getUTCHours()).padStart(2, '0')}:${String(b.getUTCMinutes()).padStart(2, '0')}:${String(b.getUTCSeconds()).padStart(2, '0')}`;
};

const NAMES: Record<string, string> = {
  T01: 'ใบรับ',
  T03: 'ใบเสร็จรับเงิน/ใบกำกับภาษี',
  '388': 'ใบกำกับภาษี',
  '80': 'ใบเพิ่มหนี้',
  '81': 'ใบลดหนี้',
};

/**
 * The provider's line-oriented text content (one record per line, quoted CSV fields): `C` control (seller tax id and
 * branch, file kind), `H` header (ETDA type code, its Thai name, number, issue time, the referenced documents), `B`
 * buyer, `L` lines, `F` footer (counts and totals), `T` trailer. Pure — unit tested (`inet-etax.adapter.spec.ts`).
 * // UNVERIFIED against live provider: layout written from INET's published "e-Tax Invoice & e-Receipt" service
 * description (text content + PDF, service code S06 = sign XML and PDF/A-3, send by e-mail off); the exact column
 * order must be checked against INET's current specification during onboarding.
 */
export function inetTextContent(doc: EtaxDocumentInput): string {
  const ref = doc.references[0];
  const lines: string[] = [
    ['C', f(doc.seller.taxId), f(doc.seller.branch), f('TXT'), f(doc.submissionRef)].join(','),
    [
      'H',
      f(doc.typeCode),
      f(NAMES[doc.typeCode] ?? doc.typeCode),
      f(doc.number),
      f(ymd(doc.issuedAt)),
      f(ref?.number ?? ''),
      f(ref?.issuedOn ?? ''),
      f(ref?.typeCode ?? ''),
      f(doc.currency),
    ].join(','),
    [
      'B',
      f(doc.buyer.taxId ? 'TXID' : 'OTHR'),
      f(doc.buyer.taxId ?? 'N/A'),
      f(doc.buyer.branch ?? ''),
      f(doc.buyer.name),
      f(doc.buyer.email ?? ''),
      f(doc.buyer.postcode ?? ''),
      f(doc.buyer.address ?? ''),
    ].join(','),
    ...doc.lines.map((l, i) =>
      [
        'L',
        f(String(i + 1)),
        f(l.name),
        f(l.unitPrice),
        f(l.quantity),
        f(l.vatRatePct === '0.00' ? 'FRE' : 'VAT'),
        f(l.vatRatePct),
        f(l.amount),
      ].join(','),
    ),
    ['F', f(String(doc.lines.length)), f(doc.subtotal), f(doc.vatAmount), f(doc.total), f(doc.currency)].join(
      ',',
    ),
    ['T', f('1')].join(','),
  ];
  return lines.join('\n');
}

interface InetResponse {
  status?: string;
  transactionCode?: string;
  errorCode?: string;
  errorMessage?: string;
  xmlURL?: string;
  pdfURL?: string;
}

/**
 * INET One e-Tax (`etaxdocumentws`, JSON over HTTPS): `POST /etaxsigndocument` with the tenant account
 * (`SellerTaxId`, `SellerBranchId`, `APIKey`, `UserCode`, `AccessKey`), `ServiceCode` S06, the text content and our
 * PDF (base64) → `status` `OK` (signed: `xmlURL`, `pdfURL`), `PC` (in progress: poll with the `transactionCode`) or
 * `ER` (`errorCode`, `errorMessage` = rejected). Secrets: `apiKey`, `userCode`, `accessKey`.
 * // UNVERIFIED against live provider: written from INET's published e-Tax web-service description (B6.2); endpoint
 * paths, field names and the status poll must be confirmed in the INET UAT before a tenant is switched on.
 */
export class InetEtaxAdapter implements EtaxProviderAdapter {
  readonly provider = 'inet' as const;
  readonly mode = 'real' as const;

  constructor(private readonly baseUrl: string) {}

  private auth(account: EtaxAccount, sellerTaxId: string, branch: string) {
    return {
      SellerTaxId: sellerTaxId,
      SellerBranchId: branch,
      APIKey: need(account, 'apiKey'),
      UserCode: need(account, 'userCode'),
      AccessKey: need(account, 'accessKey'),
    };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<InetResponse> {
    try {
      const res = await providerFetch({
        provider: 'etax-inet',
        url: `${this.baseUrl}${path}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs: 60_000,
      });
      const json = (await res.json().catch(() => ({}))) as InetResponse;
      if (!res.ok && !json.status)
        throw new EtaxProviderError('inet', `HTTP ${res.status}`, res.status >= 500);
      return json;
    } catch (error) {
      if (error instanceof ProviderError) throw new EtaxProviderError('inet', error.message, error.retryable);
      throw error;
    }
  }

  private static outcome(json: InetResponse): { status: EtaxSubmitResult['status']; error: string | null } {
    const s = (json.status ?? '').toUpperCase();
    if (s === 'OK') return { status: 'signed', error: null };
    if (s === 'ER')
      return { status: 'rejected', error: `${json.errorCode ?? 'ER'}: ${json.errorMessage ?? 'rejected'}` };
    return { status: 'submitted', error: null };
  }

  async submit(account: EtaxAccount, doc: EtaxDocumentInput): Promise<EtaxSubmitResult> {
    const json = await this.post('/etaxsigndocument', {
      ...this.auth(account, doc.seller.taxId, doc.seller.branch),
      ServiceCode: 'S06',
      TextContent: inetTextContent(doc),
      PDFContent: doc.pdf.toString('base64'),
    });
    const o = InetEtaxAdapter.outcome(json);
    if (!json.transactionCode && o.status !== 'rejected')
      throw new EtaxProviderError('inet', 'no transactionCode in the answer');
    return {
      providerDocId: json.transactionCode ?? `rejected:${doc.submissionRef}`,
      status: o.status,
      error: o.error,
      meta: {
        sellerTaxId: doc.seller.taxId,
        sellerBranch: doc.seller.branch,
        xmlUrl: json.xmlURL ?? null,
        pdfUrl: json.pdfURL ?? null,
      },
    };
  }

  async status(account: EtaxAccount, providerDocId: string, meta: Record<string, unknown>) {
    const json = await this.post('/etaxgetstatus', {
      ...this.auth(account, str(meta.sellerTaxId, ''), str(meta.sellerBranch, '00000')),
      TransactionCode: providerDocId,
    });
    const o = InetEtaxAdapter.outcome(json);
    return {
      status: o.status,
      error: o.error,
      meta: { xmlUrl: json.xmlURL ?? meta.xmlUrl ?? null, pdfUrl: json.pdfURL ?? meta.pdfUrl ?? null },
    } satisfies EtaxStatusResult;
  }

  async fetchSigned(
    _account: EtaxAccount,
    _providerDocId: string,
    meta: Record<string, unknown>,
  ): Promise<EtaxSignedArtefacts> {
    const get = async (url: unknown) => {
      if (typeof url !== 'string' || !/^https:\/\//.test(url))
        throw new EtaxProviderError('inet', 'no signed artefact URL yet');
      const res = await providerFetch({
        provider: 'etax-inet',
        url,
        init: { method: 'GET' },
        timeoutMs: 60_000,
      });
      if (!res.ok) throw new EtaxProviderError('inet', `artefact HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    };
    return { xml: await get(meta.xmlUrl), pdf: await get(meta.pdfUrl) };
  }
}

export class RealEtaxProviders implements EtaxProviderRegistry {
  readonly mode = 'real' as const;
  private readonly adapters: Record<EtaxProviderKey, EtaxProviderAdapter>;

  constructor(urls: Record<EtaxProviderKey, string>) {
    this.adapters = { inet: new InetEtaxAdapter(urls.inet) };
  }

  adapter(provider: EtaxProviderKey): EtaxProviderAdapter {
    const a = this.adapters[provider];
    if (!a) throw new EtaxProviderError(provider, 'unknown e-Tax provider', false);
    return a;
  }
}

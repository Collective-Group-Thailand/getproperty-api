import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { htmlToText } from '@common/text/html-text';
import { DEFAULT_PDF_BRAND, type PdfBrand, PlatformBrand } from '@core/brand/platform-brand.service';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { Inject, Injectable, Optional } from '@nestjs/common';
import Handlebars from 'handlebars';

/** What a contract template receives (contract-template.ts documents the clauses that use it). */
export interface ContractData {
  draft: boolean;
  contract: { number: string | null; madeAt: string; madeOn: string };
  lessor: { legalName: string; taxId: string | null; address: string };
  lessee: {
    displayName: string;
    idDocumentLabel: string;
    idNumber: string;
    nationality: string | null;
    address: string | null;
    phone: string | null;
  };
  coTenants: { displayName: string }[];
  premises: {
    unitNo: string;
    floorName: string;
    buildingName: string;
    propertyName: string;
    address: string;
    areaSqm: string | null;
    equipment: { name: string; location: string | null }[];
    keysCount: number;
    parkingSlots: number;
  };
  term: { months: number; startDate: string; endDate: string };
  rent: { amount: string; text: string; dueDay: string };
  rentIncreases: {
    effectiveFrom: string;
    amount: string;
    text: string;
    effectiveFromEn?: string;
    textEn?: string;
  }[];
  utilities: { metered: boolean; electricProvider: string; waterProvider: string };
  lines: { description: string; amount: string; recurrence: string; recurrenceEn?: string }[];
  deposit: { amount: string; text: string };
  advanceRent: { amount: string; text: string };
  depositCapMonths: string;
  invoiceLeadDays: number;
  refundDays: number;
  noticeDays: number;
  remedyDays: number;
  disturbanceDays: number;
  addendum: { title: string; text: string }[];
  signatures: {
    lessor: { signedAt: string; signedAtEn?: string; imageDataUrl: string } | null;
    lessee: { signedAt: string; signedAtEn?: string; imageDataUrl: string } | null;
  };
  template: { key: string; version: number; legalRef: string };
  /**
   * B7.5 (D-253): the same values spelled for the English landlord templates (dates in the Gregorian calendar,
   * amounts in English words, providers and labels in English). The Thai fields above stay the canonical ones.
   */
  en?: {
    madeOn: string;
    startDate: string;
    endDate: string;
    rentText: string;
    depositText: string;
    advanceText: string;
    idDocumentLabel: string;
    electricProvider: string;
    waterProvider: string;
  };
  /** B7.5: who stamps the lease (O-019 default: the lessor) and the duty in words; null before it is computed. */
  stampDuty?: {
    amount: string;
    text: string;
    textEn: string;
    payer: 'lessor' | 'lessee' | 'shared';
    payerTh: string;
    payerEn: string;
  } | null;
}

/** The language a template version is written in (`lease_template_version.language`). */
export type ContractLanguage = 'th' | 'en';

const STYLE = `
@page { size: A4; }
body { font-family: 'Sarabun', sans-serif; font-size: 13pt; line-height: 1.55; color: #111; }
h1 { font-size: 18pt; text-align: center; margin: 0 0 2mm; }
h2 { font-size: 13.5pt; margin: 4mm 0 1mm; }
p { margin: 0 0 2mm; text-align: justify; }
.sub { text-align: center; font-size: 11pt; }
.draft { text-align: center; color: #b00; font-weight: 700; letter-spacing: 1px; }
table.meta td { padding: 0 3mm 0 0; }
table.lines { border-collapse: collapse; margin: 0 0 2mm 6mm; }
table.lines td { padding: 0 4mm 0 0; }
td.num { text-align: right; }
ol.items { margin: 0 0 2mm 6mm; padding-left: 4mm; }
.termination { color: #c00000; font-weight: 700; text-decoration: underline; }
table.sign { width: 100%; margin-top: 10mm; }
table.sign td { width: 50%; text-align: center; vertical-align: bottom; }
img.sig { max-height: 18mm; max-width: 60mm; display: block; margin: 0 auto 1mm; }
.when { font-size: 10pt; color: #444; }
footer.notes { margin-top: 8mm; font-size: 9pt; color: #555; }
.page-break { break-before: page; page-break-before: always; }
footer.platform { margin-top: 8mm; padding-top: 2mm; border-top: 0.2mm solid #ddd; display: flex; align-items: center; gap: 2mm; font-size: 8.5pt; color: #555; }
img.platform-logo { height: 4.2mm; width: auto; }
`;

let fontCss: string | null = null;

/** Sarabun (OFL, Thai + Latin, regular and bold) embedded as data URLs: rendering never touches the network. */
export function fonts(): string {
  if (fontCss !== null) return fontCss;
  const dir = join(dirname(require.resolve('@fontsource/sarabun/package.json')), 'files');
  const face = (subset: string, weight: number, range: string) => {
    const data = readFileSync(join(dir, `sarabun-${subset}-${weight}-normal.woff2`)).toString('base64');
    return `@font-face { font-family: 'Sarabun'; font-style: normal; font-weight: ${weight}; font-display: block; src: url(data:font/woff2;base64,${data}) format('woff2'); unicode-range: ${range}; }`;
  };
  const THAI = 'U+0E01-0E5B, U+200C-200D, U+25CC';
  const LATIN =
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
  fontCss = [
    face('thai', 400, THAI),
    face('thai', 700, THAI),
    face('latin', 400, LATIN),
    face('latin', 700, LATIN),
  ].join('\n');
  return fontCss;
}

const compiled = new Map<string, Handlebars.TemplateDelegate<ContractData>>();
const hbs = Handlebars.create();

/**
 * The platform line after the document body (D-232): the getproperty logo + "issued via getproperty". Outside the
 * body on purpose — `text()` / `contentSha256` cover the agreement itself, so the brand never changes a signed
 * contract's hash.
 */
export function platformFooter(platform: PdfBrand, language: ContractLanguage = 'th'): string {
  const logo = platform.logoDataUrl
    ? `<img class="platform-logo" src="${platform.logoDataUrl}" alt="${hbs.Utils.escapeExpression(platform.altText)}">`
    : '';
  return `<footer class="platform">${logo}<span>${language === 'en' ? 'Issued via' : 'ออกเอกสารผ่านระบบ'} ${hbs.Utils.escapeExpression(platform.name)}</span></footer>`;
}

/**
 * Contract documents (B2.3, master plan §3): the template version's Handlebars body + `ContractData` → an HTML
 * document with embedded Thai fonts → PDF through the renderer port. `text()` is the canonical text of a contract
 * (what the golden test pins and what `contentSha256` hashes); the PDF footer carries the number and that hash.
 */
@Injectable()
export class ContractRenderer {
  constructor(
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Optional() private readonly brand?: PlatformBrand,
  ) {}

  body(templateBody: string, data: ContractData): string {
    let fn = compiled.get(templateBody);
    if (!fn) {
      fn = hbs.compile<ContractData>(templateBody, { strict: false, noEscape: false });
      compiled.set(templateBody, fn);
    }
    return fn(data);
  }

  /** The printable HTML: the body, then the platform line (D-232). */
  document(
    body: string,
    title: string,
    platform: PdfBrand = DEFAULT_PDF_BRAND,
    language: ContractLanguage = 'th',
  ): string {
    const esc = hbs.Utils.escapeExpression(title);
    return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>${esc}</title><style>${fonts()}\n${STYLE}</style></head><body>${body}\n${platformFooter(platform, language)}</body></html>`;
  }

  /** `document()` with the platform brand in force (logo embedded). */
  async brandedDocument(body: string, title: string, language: ContractLanguage = 'th'): Promise<string> {
    return this.document(body, title, (await this.brand?.pdf()) ?? DEFAULT_PDF_BRAND, language);
  }

  /** Canonical text of a rendered contract body (golden tests, content hash). */
  text(body: string): string {
    return htmlToText(body.replace(/<img\b[^>]*>/gi, ''));
  }

  contentSha256(body: string): string {
    return createHash('sha256').update(this.text(body), 'utf8').digest('hex');
  }

  async render(
    templateBody: string,
    data: ContractData,
    language: ContractLanguage = 'th',
  ): Promise<{ pdf: Buffer; sha256: Buffer; contentSha256: string; text: string }> {
    const body = this.body(templateBody, data);
    const contentSha256 = this.contentSha256(body);
    const hash = `${contentSha256.slice(0, 16)}…${contentSha256.slice(-8)}`;
    const title =
      language === 'en'
        ? `Lease ${data.contract.number ?? '(draft)'}`
        : `สัญญาเช่า ${data.contract.number ?? '(ร่าง)'}`;
    const footer =
      language === 'en'
        ? `Lease no. ${data.contract.number ?? 'draft'} · SHA-256 of the text ${hash}`
        : `สัญญาเลขที่ ${data.contract.number ?? 'ร่าง'} · SHA-256 ของข้อความ ${hash}`;
    const pdf = await this.pdf.render(await this.brandedDocument(body, title, language), { title, footer });
    return { pdf, sha256: createHash('sha256').update(pdf).digest(), contentSha256, text: this.text(body) };
  }
}

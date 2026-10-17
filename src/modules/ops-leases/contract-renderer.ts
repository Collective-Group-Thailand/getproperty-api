import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { htmlToText } from '@common/text/html-text';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { Inject, Injectable } from '@nestjs/common';
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
  rentIncreases: { effectiveFrom: string; amount: string; text: string }[];
  utilities: { metered: boolean; electricProvider: string; waterProvider: string };
  lines: { description: string; amount: string; recurrence: string }[];
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
    lessor: { signedAt: string; imageDataUrl: string } | null;
    lessee: { signedAt: string; imageDataUrl: string } | null;
  };
  template: { key: string; version: number; legalRef: string };
}

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
 * Contract documents (B2.3, master plan §3): the template version's Handlebars body + `ContractData` → an HTML
 * document with embedded Thai fonts → PDF through the renderer port. `text()` is the canonical text of a contract
 * (what the golden test pins and what `contentSha256` hashes); the PDF footer carries the number and that hash.
 */
@Injectable()
export class ContractRenderer {
  constructor(@Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort) {}

  body(templateBody: string, data: ContractData): string {
    let fn = compiled.get(templateBody);
    if (!fn) {
      fn = hbs.compile<ContractData>(templateBody, { strict: false, noEscape: false });
      compiled.set(templateBody, fn);
    }
    return fn(data);
  }

  document(body: string, title: string): string {
    const esc = hbs.Utils.escapeExpression(title);
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc}</title><style>${fonts()}\n${STYLE}</style></head><body>${body}</body></html>`;
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
  ): Promise<{ pdf: Buffer; sha256: Buffer; contentSha256: string; text: string }> {
    const body = this.body(templateBody, data);
    const contentSha256 = this.contentSha256(body);
    const title = `สัญญาเช่า ${data.contract.number ?? '(ร่าง)'}`;
    const pdf = await this.pdf.render(this.document(body, title), {
      title,
      footer: `สัญญาเลขที่ ${data.contract.number ?? 'ร่าง'} · SHA-256 ของข้อความ ${contentSha256.slice(0, 16)}…${contentSha256.slice(-8)}`,
    });
    return { pdf, sha256: createHash('sha256').update(pdf).digest(), contentSha256, text: this.text(body) };
  }
}

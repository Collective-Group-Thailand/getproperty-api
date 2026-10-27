import 'reflect-metadata';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { unzip, zip } from '@common/zip/zip';
import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';
import { PuppeteerPdfRenderer } from '@integrations/pdf/puppeteer-pdf-renderer';
import { BillingDocuments } from '@modules/ops-documents/billing-documents.service';
import { type Paper, TEMPLATES } from '@modules/ops-documents/billing-templates';
import { type InvoiceView, invoiceView, type ReceiptView } from '@modules/ops-documents/document-views';
import {
  depositStatementBubble,
  flexMessage,
  invoiceAltText,
  invoiceBubble,
  receiptBubble,
  reminderBubble,
} from '@modules/ops-documents/flex';
import { SAMPLE_KEYS, sampleInvoiceSnapshot, sampleView } from '@modules/ops-documents/sample-documents';

import { validateFlexMessage } from '../support/line-flex-schema';

const DIR = join(__dirname, '..', 'golden', 'documents');
const config = {
  get: (k: string) => (k === 'PUBLIC_RESIDENT_APP_URL' ? 'https://liff.example.invalid' : undefined),
};

function documents(renderer = new FakePdfRenderer()) {
  return new BillingDocuments(renderer, {} as never, {} as never, config as never, {} as never);
}

function golden(name: string, text: string): void {
  const file = join(DIR, `${name}.txt`);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, `${text}\n`);
  }
  expect(`${text}\n`).toBe(readFileSync(file, 'utf8'));
}

/**
 * B4.3 acceptance (documents): the text of every document type is pinned (`test/golden/documents/*.txt`,
 * UPDATE_GOLDEN=1 rewrites), the fake PDF carries exactly that text, the VAT block only for VAT-registered issuers,
 * the meter disclosure (D-022), the 80 mm variant; LINE Flex messages validate against the Flex schema; the ZIP
 * writer round-trips; a real Chromium renders Thai A4 and 80 mm PDFs where available.
 */
describe('billing documents (B4.3)', () => {
  const PAPERS: Partial<Record<string, Paper[]>> = {
    invoice: ['a4', 'thermal_80mm'],
    receipt: ['a4', 'thermal_80mm'],
    receipt_tax_invoice: ['a4', 'thermal_80mm'],
  };

  it.each(SAMPLE_KEYS)('%s: text snapshot per paper, the PDF carries the same text', async (key) => {
    const fake = new FakePdfRenderer();
    const docs = documents(fake);
    const view = sampleView(key);
    for (const paper of PAPERS[key] ?? (['a4'] as Paper[])) {
      const text = docs.text(view, paper);
      golden(`${key}-${paper}`, text);
      const pdf = await docs.pdf(view, paper);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(FakePdfRenderer.textOf(pdf)).toContain(text.split('\n')[0]!);
      expect(fake.rendered.at(-1)).toMatchObject({ paper });
      expect(pdf.toString('latin1')).toContain(
        paper === 'thermal_80mm' ? '/MediaBox [0 0 227 842]' : '/MediaBox [0 0 595 842]',
      );
    }
  });

  it('invoice: every metered line discloses registers, dates, reading source and the utility rate (D-022)', () => {
    const text = documents().text(sampleView('invoice'));
    expect(text).toContain('เลขครั้งก่อน 1114.500');
    expect(text).toContain('เลขครั้งนี้ 1234.500');
    expect(text).toContain('มิเตอร์อัจฉริยะ');
    expect(text).toContain('อัตราที่ผู้ให้บริการสาธารณูปโภคเรียกเก็บ 3.9900 บาท/หน่วย');
    expect(text).toContain('การไฟฟ้านครหลวง ประเภท 1.1.1');
    expect(text).toContain('อัตรานี้สูงกว่าอัตราที่การไฟฟ้า/การประปาเรียกเก็บ');
    expect(text).toContain('ประมาณการ — จะปรับตามเลขมิเตอร์จริงในรอบถัดไป');
    expect(text).toContain('ยอดค้างชำระยกมา');
    expect(text).toContain('หกพันเก้าร้อยสี่สิบแปดบาทถ้วน');
  });

  it('the VAT block appears only for a VAT-registered issuer (O-004)', () => {
    const docs = documents();
    const plain = docs.text(invoiceView(sampleInvoiceSnapshot(false), { link: 'https://x.invalid' }));
    const vat = docs.text(invoiceView(sampleInvoiceSnapshot(true), { link: 'https://x.invalid' }));
    expect(plain).not.toContain('ภาษีมูลค่าเพิ่ม 7%');
    expect(plain).toContain('ผู้ให้เช่าไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม');
    expect(vat).toContain('ภาษีมูลค่าเพิ่ม 7%');
    expect(vat).toContain('เลขประจำตัวผู้เสียภาษีอากร 0000000000042');
    expect(vat).toContain('สำนักงานใหญ่');
    expect(vat).not.toContain('ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม');
  });

  it('tax invoice carries the Revenue Code §86/4 fields; notes show original, corrected value and difference', () => {
    const docs = documents();
    const tax = docs.text(sampleView('tax_invoice'));
    for (const s of [
      'ใบกำกับภาษี',
      'RTI-2026-00001',
      'เลขประจำตัวผู้เสียภาษีอากร',
      'มูลค่าก่อนภาษี',
      'ภาษีมูลค่าเพิ่ม 7%',
    ])
      expect(tax).toContain(s);
    const credit = docs.text(sampleView('credit_note'));
    for (const s of [
      'ใบลดหนี้',
      'อ้างถึงใบแจ้งหนี้',
      'INV-2026-00042',
      'มูลค่าตามใบแจ้งหนี้เดิม',
      '5,748.00',
      '5,678.00',
      'ผลต่าง',
    ])
      expect(credit).toContain(s);
    expect(docs.text(sampleView('debit_note'))).toContain('5,818.00');
    expect(docs.text(sampleView('receipt_advance'))).toContain('ใบเสร็จรับเงิน (รับชำระล่วงหน้า)');
  });

  it('templates are versioned by key; 80 mm exists for invoices and receipts only', () => {
    expect(TEMPLATES.invoice_a4!.key).toBe('invoice_a4_th');
    expect(() => documents().text(sampleView('credit_note'), 'thermal_80mm')).toThrow(
      /no thermal_80mm template/,
    );
  });

  // ----------------------------------------------------------------------------------------- LINE Flex

  const invoice = sampleView('invoice') as InvoiceView;

  it('invoice Flex: bubble with lines, registers, amount due and the LIFF button validates', () => {
    const msg = flexMessage(invoiceAltText(invoice), [invoiceBubble(invoice)]);
    expect(validateFlexMessage(msg)).toEqual([]);
    expect(msg.altText).toBe(
      'ใบแจ้งหนี้ INV-2026-00042 ห้อง A-101 ยอด 6,948.00 บาท ครบกำหนด 5 พฤศจิกายน พ.ศ. 2569',
    );
    const json = JSON.stringify(msg);
    expect(json).toContain('1114.500 → 1234.500');
    expect(json).toContain('https://liff.example.invalid/invoices/sample');
  });

  it('receipt, reminder and deposit statement Flex validate; several units make a carousel (≤ 12)', () => {
    const receipt = receiptBubble(sampleView('receipt') as ReceiptView);
    const reminder = reminderBubble({
      number: 'INV-2026-00042',
      unitNo: 'A-101',
      issuerName: 'หอพักตัวอย่าง',
      balance: '6948.00',
      dueOn: '2026-11-05',
      daysOverdue: 3,
      link: 'https://liff.example.invalid/invoices/sample',
    });
    const statement = depositStatementBubble({
      number: 'DPS-2026-00001',
      unitNo: 'A-101',
      issuerName: 'หอพักตัวอย่าง',
      depositHeld: '4500.00',
      deductionsTotal: '800.00',
      utilitiesFinal: '0.00',
      advanceRentUnused: '2825.62',
      refund: '6525.62',
      deadlineOn: '2026-12-17',
      link: 'https://liff.example.invalid/deposits/sample',
    });
    for (const b of [receipt, reminder, statement])
      expect(validateFlexMessage(flexMessage('alt', [b]))).toEqual([]);
    const carousel = flexMessage('3 ห้อง', [
      invoiceBubble(invoice),
      invoiceBubble(invoice),
      invoiceBubble(invoice),
    ]);
    expect(carousel.contents.type).toBe('carousel');
    expect(validateFlexMessage(carousel)).toEqual([]);
    const many = flexMessage(
      'many',
      Array.from({ length: 15 }, () => reminder),
    );
    expect((many.contents as { contents: unknown[] }).contents).toHaveLength(12);
    expect(validateFlexMessage(many)).toEqual([]);
  });

  it('the validator refuses what LINE refuses (unknown property, bad colour, data: image, > 12 bubbles)', () => {
    const bad = flexMessage('x', [invoiceBubble(invoice)]) as unknown as {
      contents: { body: { contents: Record<string, unknown>[] }; header: Record<string, unknown> };
    };
    bad.contents.header.backgroundColor = 'green';
    bad.contents.body.contents.push({ type: 'image', url: 'data:image/png;base64,AAAA' });
    bad.contents.body.contents.push({ type: 'text', text: 'x', fontSize: 'big' });
    expect(validateFlexMessage(bad).length).toBeGreaterThan(0);
    const tooMany = {
      type: 'flex',
      altText: 'x',
      contents: { type: 'carousel', contents: Array.from({ length: 13 }, () => invoiceBubble(invoice)) },
    };
    expect(validateFlexMessage(tooMany).join(' ')).toMatch(/must NOT have more than 12 items/);
  });

  it('zip writer: entries round-trip (UTF-8 names, deflate)', () => {
    const entries = [
      { name: 'index.csv', data: Buffer.from('a,b\r\n1,2\r\n') },
      { name: 'invoices/ใบแจ้งหนี้ INV-2026-00001.pdf', data: Buffer.from('%PDF-1.4 '.repeat(200)) },
    ];
    const archive = zip(entries);
    expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(unzip(archive)).toEqual(entries);
    expect(zip(entries).equals(archive)).toBe(true);
  });

  // UNVERIFIED in CI: runs only where a Chromium binary is available (PDF_CHROMIUM_EXECUTABLE).
  const chromium = process.env.PDF_CHROMIUM_EXECUTABLE;
  (chromium ? it : it.skip)(
    'real Chromium: Thai A4 invoice and 80 mm roll with the Sarabun font embedded',
    async () => {
      const real = new PuppeteerPdfRenderer({ executablePath: chromium!, timeoutMs: 30_000 });
      try {
        const docs = documents(real as never);
        const a4 = await docs.pdf(invoice, 'a4');
        expect(a4.subarray(0, 5).toString()).toBe('%PDF-');
        expect(a4.toString('latin1')).toMatch(/Sarabun/);
        const roll = await docs.pdf(invoice, 'thermal_80mm');
        const box = /\/MediaBox \[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(roll.toString('latin1'));
        expect(Number(box![1])).toBeCloseTo(226.77, 0); // 80 mm
        expect(Number(box![2])).toBeGreaterThan(200);
      } finally {
        await real.close();
      }
    },
    90_000,
  );
});

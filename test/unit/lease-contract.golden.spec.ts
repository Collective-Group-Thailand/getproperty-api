import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';
import { PuppeteerPdfRenderer } from '@integrations/pdf/puppeteer-pdf-renderer';
import { type ContractData, ContractRenderer } from '@modules/ops-leases/contract-renderer';
import { STANDARD_TEMPLATE_BODY, STANDARD_TEMPLATE_LEGAL_REF } from '@modules/ops-leases/contract-template';
import { bahtText, formatThb, thaiDate } from '@modules/ops-leases/thai-text';

const GOLDEN = join(__dirname, '..', 'golden', 'lease-contract-ocpb-2568-th.txt');

/** A fixture lease (fake people and places, D-025): every optional section present. */
export const CONTRACT_FIXTURE: ContractData = {
  draft: false,
  contract: { number: 'CTR-2026-00001', madeAt: 'หอพักตัวอย่าง', madeOn: thaiDate('2026-10-17') },
  lessor: {
    legalName: 'บริษัท ตัวอย่าง จำกัด',
    taxId: '0000000000002',
    address: '99/9 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10110',
  },
  lessee: {
    displayName: 'ผู้เช่า ทดสอบ',
    idDocumentLabel: 'เลขประจำตัวประชาชน',
    idNumber: '0000000000002',
    nationality: 'TH',
    address: '1 ถนนทดสอบ อำเภอทดสอบ จังหวัดทดสอบ 10000',
    phone: '+66810001234',
  },
  coTenants: [{ displayName: 'ผู้เช่าร่วม ทดสอบ' }],
  premises: {
    unitNo: 'A-102',
    floorName: 'ชั้น 1',
    buildingName: 'อาคาร A',
    propertyName: 'หอพักตัวอย่าง',
    address: '99/9 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10110',
    areaSqm: '28.00',
    equipment: [
      { name: 'เครื่องปรับอากาศ', location: 'ห้องนอน' },
      { name: 'ตู้เย็น', location: null },
    ],
    keysCount: 2,
    parkingSlots: 1,
  },
  term: { months: 12, startDate: thaiDate('2026-11-01'), endDate: thaiDate('2027-10-31') },
  rent: { amount: formatThb('4500'), text: bahtText('4500'), dueDay: '5' },
  rentIncreases: [
    { effectiveFrom: thaiDate('2027-05-01'), amount: formatThb('4800'), text: bahtText('4800') },
  ],
  utilities: { metered: true, electricProvider: 'การไฟฟ้านครหลวง', waterProvider: 'การประปานครหลวง' },
  lines: [{ description: 'อินเทอร์เน็ตไฟเบอร์', amount: formatThb('300'), recurrence: 'ต่อเดือน' }],
  deposit: { amount: formatThb('4500'), text: bahtText('4500') },
  advanceRent: { amount: formatThb('4500'), text: bahtText('4500') },
  depositCapMonths: '3',
  invoiceLeadDays: 7,
  refundDays: 7,
  noticeDays: 30,
  remedyDays: 30,
  disturbanceDays: 7,
  addendum: [{ title: 'สัตว์เลี้ยง', text: 'อนุญาตแมวได้ 1 ตัว ผู้เช่ารับผิดชอบความสะอาด' }],
  signatures: { lessor: null, lessee: null },
  template: { key: 'ocpb_2568_residential_th', version: 1, legalRef: STANDARD_TEMPLATE_LEGAL_REF },
};

/**
 * Golden test of the standard contract (B2.3 quality bar): the canonical text rendered from the seeded template and
 * a fixture lease must equal `test/golden/lease-contract-ocpb-2568-th.txt`. A deliberate template change regenerates
 * it with `GOLDEN_UPDATE=1 pnpm test -- lease-contract` and the diff is reviewed against legal-reference.md.
 */
describe('standard lease contract (golden)', () => {
  const fake = new FakePdfRenderer();
  const renderer = new ContractRenderer(fake);

  it('renders the canonical text of the fixture lease', () => {
    const text = renderer.text(renderer.body(STANDARD_TEMPLATE_BODY, CONTRACT_FIXTURE));
    if (process.env.GOLDEN_UPDATE === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${text}\n`);
    expect(`${text}\n`).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('carries the clauses the announcement requires', () => {
    const text = renderer.text(renderer.body(STANDARD_TEMPLATE_BODY, CONTRACT_FIXTURE));
    for (const required of [
      'สี่พันห้าร้อยบาทถ้วน', // amounts in words (ข้อ 4)
      '30 วัน', // lessee notice (ข้อ 4 (11)) / remedy (ข้อ 4 (12))
      '7 วัน', // deposit refund (ข้อ 4 (6)) / disturbance warning
      'การไฟฟ้านครหลวง',
      'การประปานครหลวง',
      'อนุญาตแมวได้ 1 ตัว',
      'CTR-2026-00001',
    ])
      expect({ required, found: text.includes(required) }).toEqual({ required, found: true });
    expect(text).not.toContain('ร่างสัญญา');
  });

  it('marks a draft and keeps the text in the (fake) PDF with the content hash in the footer', async () => {
    const r = await renderer.render(STANDARD_TEMPLATE_BODY, {
      ...CONTRACT_FIXTURE,
      draft: true,
      contract: { ...CONTRACT_FIXTURE.contract, number: null },
    });
    expect(r.text).toContain('ร่างสัญญา');
    expect(r.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(FakePdfRenderer.textOf(r.pdf)).toContain('สี่พันห้าร้อยบาทถ้วน');
    expect(fake.rendered.at(-1)!.footer).toContain(r.contentSha256.slice(0, 16));
    const again = await renderer.render(STANDARD_TEMPLATE_BODY, {
      ...CONTRACT_FIXTURE,
      draft: true,
      contract: { ...CONTRACT_FIXTURE.contract, number: null },
    });
    expect(again.sha256.equals(r.sha256)).toBe(true);
  });

  // UNVERIFIED in CI: runs only where a Chromium binary is available (PDF_CHROMIUM_EXECUTABLE).
  const chromium = process.env.PDF_CHROMIUM_EXECUTABLE;
  (chromium ? it : it.skip)(
    'renders a real A4 PDF with headless Chromium (Thai fonts embedded)',
    async () => {
      const real = new PuppeteerPdfRenderer({ executablePath: chromium!, timeoutMs: 30_000 });
      try {
        const r = await new ContractRenderer(real).render(STANDARD_TEMPLATE_BODY, CONTRACT_FIXTURE);
        expect(r.pdf.subarray(0, 5).toString()).toBe('%PDF-');
        expect(r.pdf.length).toBeGreaterThan(20_000);
        expect(r.pdf.toString('latin1')).toMatch(/Sarabun/);
      } finally {
        await real.close();
      }
    },
    60_000,
  );
});

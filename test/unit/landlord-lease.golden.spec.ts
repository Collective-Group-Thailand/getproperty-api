import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';
import { type ContractData, ContractRenderer } from '@modules/ops-leases/contract-renderer';
import { bahtTextEn, englishDate } from '@modules/ops-leases/english-text';
import {
  LANDLORD_TEMPLATE_KINDS,
  LANDLORD_TEMPLATE_LEGAL_REF,
  landlordLegalRef,
  landlordTemplateBody,
  landlordTemplateKey,
  landlordTemplateKind,
  landlordTemplates,
} from '@modules/ops-leases/landlord-templates';
import { STAMP_DUTY_PAYER_EN, STAMP_DUTY_PAYER_TH } from '@modules/ops-leases/stamp-duty';
import { bahtText, formatThb, thaiDate } from '@modules/ops-leases/thai-text';

const GOLDEN = (kind: string, language: string) =>
  join(__dirname, '..', 'golden', 'landlord', `lease-${kind}-${language}.txt`);

/** A landlord's condo lease (fake people and places, D-025): an individual lessor, a foreign lessee. */
const FIXTURE: ContractData = {
  draft: false,
  contract: { number: 'CTR-2026-00001', madeAt: 'คอนโดตัวอย่าง', madeOn: thaiDate('2026-10-25') },
  lessor: {
    legalName: 'มาลี ตัวอย่าง',
    taxId: null,
    address: '9 ถนนตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10400',
  },
  lessee: {
    displayName: 'Alex Example',
    idDocumentLabel: 'หนังสือเดินทางเลขที่',
    idNumber: 'X0000000',
    nationality: 'GB',
    address: null,
    phone: '+66810009402',
  },
  coTenants: [],
  premises: {
    unitNo: '12/345',
    floorName: 'ชั้น 12',
    buildingName: 'อาคาร 1',
    propertyName: 'คอนโดตัวอย่าง',
    address: '9 ถนนตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10400',
    areaSqm: '28.50',
    equipment: [{ name: 'เครื่องปรับอากาศ', location: 'ห้องนอน' }],
    keysCount: 2,
    parkingSlots: 0,
  },
  term: { months: 12, startDate: thaiDate('2026-11-01'), endDate: thaiDate('2027-10-31') },
  rent: { amount: formatThb('15000'), text: bahtText('15000'), dueDay: '5' },
  rentIncreases: [],
  utilities: { metered: true, electricProvider: 'การไฟฟ้านครหลวง', waterProvider: 'การประปานครหลวง' },
  lines: [
    {
      description: 'อินเทอร์เน็ต',
      amount: formatThb('500'),
      recurrence: 'ต่อเดือน',
      recurrenceEn: 'per month',
    },
  ],
  deposit: { amount: formatThb('30000'), text: bahtText('30000') },
  advanceRent: { amount: formatThb('15000'), text: bahtText('15000') },
  depositCapMonths: '3',
  invoiceLeadDays: 7,
  refundDays: 7,
  noticeDays: 30,
  remedyDays: 30,
  disturbanceDays: 7,
  addendum: [{ title: 'สัตว์เลี้ยง', text: 'ไม่อนุญาตให้เลี้ยงสัตว์' }],
  signatures: { lessor: null, lessee: null },
  template: { key: 'landlord_condo_unit', version: 1, legalRef: LANDLORD_TEMPLATE_LEGAL_REF },
  en: {
    madeOn: englishDate('2026-10-25'),
    startDate: englishDate('2026-11-01'),
    endDate: englishDate('2027-10-31'),
    rentText: bahtTextEn('15000'),
    depositText: bahtTextEn('30000'),
    advanceText: bahtTextEn('15000'),
    idDocumentLabel: 'passport no.',
    electricProvider: 'the Metropolitan Electricity Authority',
    waterProvider: 'the Metropolitan Waterworks Authority',
  },
  stampDuty: {
    amount: formatThb('180'),
    text: bahtText('180'),
    textEn: bahtTextEn('180'),
    payer: 'shared',
    payerTh: STAMP_DUTY_PAYER_TH.shared,
    payerEn: STAMP_DUTY_PAYER_EN.shared,
  },
};

/**
 * Golden texts of the landlord leases (B7.5, D-253): 3 unit kinds × th / en rendered from the seeded bodies and one
 * fixture must equal `test/golden/landlord/lease-<kind>-<language>.txt`. A deliberate wording change (counsel, O-017)
 * is a new template version and regenerates them with `GOLDEN_UPDATE=1 pnpm test -- landlord-lease`.
 */
describe('landlord lease templates (golden)', () => {
  const renderer = new ContractRenderer(new FakePdfRenderer());

  it('seeds six published bodies: condo unit, house, room in Thai and English', () => {
    const all = landlordTemplates();
    expect(all.map((t) => `${t.key}:${t.language}`)).toEqual([
      'landlord_condo_unit:th',
      'landlord_condo_unit:en',
      'landlord_house:th',
      'landlord_house:en',
      'landlord_room:th',
      'landlord_room:en',
    ]);
  });

  it('maps unit kinds to templates (a townhouse is a house; anything else a room)', () => {
    expect(landlordTemplateKind('condo_unit', 'room')).toBe('condo_unit');
    expect(landlordTemplateKind('townhouse', 'house')).toBe('house');
    expect(landlordTemplateKind(null, 'house')).toBe('house');
    expect(landlordTemplateKind(null, 'condo_unit')).toBe('condo_unit');
    expect(landlordTemplateKind(null, 'studio')).toBe('room');
    expect(landlordTemplateKind('room', 'house')).toBe('room');
  });

  for (const kind of LANDLORD_TEMPLATE_KINDS)
    for (const language of ['th', 'en'] as const)
      it(`renders the ${kind} lease in ${language}`, () => {
        const data = {
          ...FIXTURE,
          template: {
            ...FIXTURE.template,
            key: landlordTemplateKey(kind),
            legalRef: landlordLegalRef(language),
          },
        };
        const body = renderer.body(landlordTemplateBody(kind, language), data);
        const text = renderer.text(body);
        const file = GOLDEN(kind, language);
        if (process.env.GOLDEN_UPDATE === '1' || !existsSync(file)) writeFileSync(file, `${text}\n`);
        expect(`${text}\n`).toBe(readFileSync(file, 'utf8'));
        expect(text).not.toMatch(/\{\{|\}\}/);
        const required =
          language === 'th'
            ? [
                'หนึ่งหมื่นห้าพันบาทถ้วน',
                '30 วัน',
                '7 วัน',
                'หนึ่งร้อยแปดสิบบาทถ้วน',
                'คนละครึ่ง',
                'CTR-2026-00001',
              ]
            : [
                'Fifteen thousand baht only',
                '30 days',
                '7 days',
                'One hundred eighty baht only',
                'equal shares',
                '1 November 2026',
                'CTR-2026-00001',
              ];
        for (const r of required) expect({ r, found: text.includes(r) }).toEqual({ r, found: true });
        if (language === 'en') expect(text).not.toMatch(/พ\.ศ\./);
      });

  it('renders an English PDF with an English title and footer', async () => {
    const fake = new FakePdfRenderer();
    const r = await new ContractRenderer(fake).render(landlordTemplateBody('house', 'en'), FIXTURE, 'en');
    expect(fake.rendered.at(-1)!.title).toBe('Lease CTR-2026-00001');
    expect(fake.rendered.at(-1)!.footer).toContain('Lease no. CTR-2026-00001');
    expect(fake.rendered.at(-1)!.text).toContain('Issued via');
    expect(r.text).toContain('House Lease Agreement');
  });
});

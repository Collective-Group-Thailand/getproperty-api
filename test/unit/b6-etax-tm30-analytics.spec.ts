import 'reflect-metadata';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type EtaxDocumentInput, inetTextContent } from '@collective/integrations/etax';
import {
  backoffMinutes,
  ETAX_MAX_ATTEMPTS,
  etaxTypeCode,
  monthRange,
  previousMonth,
  vatLines,
} from '@modules/ops-etax/etax-rules';
import { readXlsx } from '@modules/ops-receivables/exports/sheets';
import { isForeign } from '@modules/ops-tm30/tm30.service';
import {
  thaiDate,
  TM30_COLUMNS,
  tm30Missing,
  type Tm30Person,
  tm30Rows,
  tm30Workbook,
} from '@modules/ops-tm30/tm30-format';
import { FACT_KEYS, FACTS_BY_EVENT, factStatements } from '@modules/platform-analytics/analytics-facts';
import {
  BENCHMARK_MIN_K,
  bucketStats,
  districtKey,
  percentile,
  sizeBand,
} from '@modules/platform-analytics/benchmark-rules';
import Decimal from 'decimal.js';

const GOLDEN = join(__dirname, '..', 'golden');

function golden(rel: string, actual: string): void {
  const file = join(GOLDEN, rel);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

const PEOPLE: Tm30Person[] = [
  {
    passportNo: 'ab 1234567',
    nationality: 'gb',
    firstName: 'John',
    middleName: 'Paul',
    lastName: 'Smith',
    gender: 'm',
    dateOfBirth: '1990-04-12',
    arrivalDate: '2026-10-30',
    visaType: 'non-b',
    entryPort: 'สุวรรณภูมิ',
    checkInDate: '2026-11-01',
    unitNo: 'A-102',
  },
  {
    passportNo: 'E12345678',
    nationality: 'CN',
    firstName: 'Li',
    lastName: 'Wei',
    gender: 'F',
    dateOfBirth: '1998-12-31',
    arrivalDate: '2026-10-28',
    visaType: 'ED',
    entryPort: 'ดอนเมือง',
    checkInDate: '2026-11-01',
    unitNo: 'A-101',
  },
  {
    passportNo: 'MM9988776',
    nationality: 'MM',
    firstName: 'Aung',
    lastName: 'Kyaw',
    gender: 'M',
    dateOfBirth: '1985-01-05',
    arrivalDate: '2026-09-15',
    visaType: 'NON-LA',
    entryPort: 'แม่สอด',
    checkInDate: '2026-10-31',
    unitNo: 'B-201',
  },
];

describe('TM30 upload file (D-052, D-216; golden: test/golden/tm30, UPDATE_GOLDEN=1 rewrites)', () => {
  it('immigration_xlsx_v1: header in row 1, alpha-3 nationality, upper-case names, dates DD/MM/YYYY พ.ศ.', async () => {
    const body = await tm30Workbook(PEOPLE, new Date('2026-11-01T03:00:00Z'));
    const content = await readXlsx(body);
    golden('tm30/immigration_xlsx_v1.xlsx.json', `${JSON.stringify(content, null, 2)}\n`);
    expect(content.TM30![0]).toEqual(TM30_COLUMNS.map((c) => c.header));
    expect(content.TM30!.slice(1).map((r) => r[1])).toEqual(['MM9988776', 'E12345678', 'AB1234567']);
  });

  it('rows are ordered by check-in, unit, last name and numbered', () => {
    const rows = tm30Rows(PEOPLE);
    expect(rows.map((r) => [r.seq, r.unitNo, r.nationality])).toEqual([
      [1, 'B-201', 'MMR'],
      [2, 'A-101', 'CHN'],
      [3, 'A-102', 'GBR'],
    ]);
    expect(rows[2]).toMatchObject({
      dateOfBirth: '12/04/2533',
      arrivalDate: '30/10/2569',
      checkInDate: '01/11/2569',
    });
  });

  it('lists what the Immigration Bureau requires and is missing', () => {
    expect(tm30Missing(PEOPLE[0]!)).toEqual([]);
    expect(
      tm30Missing({ ...PEOPLE[0]!, passportNo: null, arrivalDate: '', nationality: 'XX', gender: 'X' }),
    ).toEqual(['passportNo', 'arrivalDate', 'nationality', 'gender']);
    expect(thaiDate('2026-01-02')).toBe('02/01/2569');
    expect(thaiDate(null)).toBe('');
  });

  it('a party is foreign by nationality, or by passport when the nationality is unknown', () => {
    expect(isForeign({ nationality: 'TH', idDocumentType: 'passport' })).toBe(false);
    expect(isForeign({ nationality: 'MM', idDocumentType: 'other' })).toBe(true);
    expect(isForeign({ nationality: null, idDocumentType: 'passport' })).toBe(true);
    expect(isForeign({ nationality: null, idDocumentType: 'thai_national_id' })).toBe(false);
  });
});

const DOC: EtaxDocumentInput = {
  submissionRef: '01990000-0000-7000-8000-00000000e7a1',
  typeCode: 'T03',
  number: 'RT2611-0001',
  issuedAt: new Date('2026-11-05T03:15:00Z'),
  seller: {
    name: 'บริษัท ตัวอย่าง จำกัด',
    taxId: '0105550000000',
    branch: '00000',
    address: '1 ถนนตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10110',
    postcode: '10110',
    email: null,
  },
  buyer: {
    name: 'บริษัท ผู้เช่า "ทดสอบ" จำกัด',
    taxId: '0105551111111',
    branch: '00000',
    address: '99 ถนนผู้เช่า',
    postcode: '10200',
    email: 'ap@example.invalid',
  },
  lines: vatLines(
    [
      { name: 'ชำระใบแจ้งหนี้ INV2611-0001', amount: '1070.00' },
      { name: 'ชำระใบแจ้งหนี้ INV2611-0002', amount: '535.00' },
    ],
    '1500.00',
    '1605.00',
    '7.00',
  ),
  subtotal: '1500.00',
  vatAmount: '105.00',
  total: '1605.00',
  currency: 'THB',
  references: [{ number: 'INV2611-0001', issuedOn: '2026-11-01', typeCode: '380' }],
  pdf: Buffer.from('%PDF-1.4'),
};

describe('e-Tax (D-050, D-215)', () => {
  it('INET text content (golden: test/golden/etax/inet-text-T03.txt)', () => {
    golden('etax/inet-text-T03.txt', `${inetTextContent(DOC)}\n`);
    const lines = inetTextContent(DOC).split('\n');
    expect(lines.map((l) => l[0])).toEqual(['C', 'H', 'B', 'L', 'L', 'F', 'T']);
    expect(lines[2]).toContain('"บริษัท ผู้เช่า ""ทดสอบ"" จำกัด"');
    expect(lines[1]).toContain('"2026-11-05T10:15:00"');
  });

  it('VAT lines add up to the subtotal exactly (the last line takes the rounding)', () => {
    const lines = vatLines(
      [
        { name: 'a', amount: '100.00' },
        { name: 'b', amount: '100.00' },
        { name: 'c', amount: '100.00' },
      ],
      '280.37',
      '300.00',
      '7.00',
    );
    expect(lines.map((l) => l.amount)).toEqual(['93.46', '93.46', '93.45']);
    expect(lines.reduce((s, l) => s.plus(l.amount), new Decimal(0)).toFixed(2)).toBe('280.37');
    expect(vatLines([], '10.00', '10.70', '7.00')).toHaveLength(1);
  });

  it('ETDA types, backoff, months', () => {
    expect(etaxTypeCode('receipt')).toBe('T01');
    expect(etaxTypeCode('tax_invoice', 'receipt_tax_invoice')).toBe('T03');
    expect(etaxTypeCode('tax_invoice', 'tax_invoice')).toBe('388');
    expect(etaxTypeCode('credit_note')).toBe('81');
    expect([1, 2, 3, 8, ETAX_MAX_ATTEMPTS].map(backoffMinutes)).toEqual([1, 5, 15, 360, 360]);
    expect(monthRange('2026-12')).toEqual({
      from: new Date('2026-11-30T17:00:00Z'),
      to: new Date('2026-12-31T17:00:00Z'),
    });
    expect(previousMonth('2027-01-01')).toBe('2026-12');
  });
});

describe('benchmarks (k-anonymity, D-217)', () => {
  it('a bucket of fewer than 5 tenants is never published', () => {
    expect(BENCHMARK_MIN_K).toBe(5);
    expect(bucketStats(['1', '2', '3', '4'])).toBeNull();
    expect(bucketStats(['10', '20', '30', '40', '50'])).toEqual({
      k: 5,
      p25: '20.0000',
      p50: '30.0000',
      p75: '40.0000',
    });
  });

  it('percentiles interpolate (R-7); bands and district keys', () => {
    const v = ['1', '2', '3', '4', '5', '6'].map((x) => new Decimal(x));
    expect(percentile(v, 0.25).toFixed(2)).toBe('2.25');
    expect(percentile(v, 0.5).toFixed(2)).toBe('3.50');
    expect([3, 20, 49, 50, 100].map(sizeBand)).toEqual(['lt20', '20-49', '20-49', '50-99', '100plus']);
    expect(districtKey({ province: 'กรุงเทพมหานคร', district: ' เขตบางรัก ' })).toBe(
      'district:กรุงเทพมหานคร/เขตบางรัก',
    );
    expect(districtKey({ province: 'x' })).toBeNull();
  });
});

describe('analytics facts (D-217)', () => {
  it('every fact has a statement; events map to known facts', () => {
    const s = factStatements({
      tenantId: null,
      from: new Date(0),
      to: new Date(1),
      now: new Date(1),
      reminderDays: 7,
    });
    expect(Object.keys(s).sort()).toEqual([...FACT_KEYS].sort());
    for (const facts of Object.values(FACTS_BY_EVENT)) for (const f of facts) expect(FACT_KEYS).toContain(f);
    expect(s['payment.on_time'].sql).toContain('ON CONFLICT (fact, subject_id, time) DO NOTHING');
    expect(s['compliance.score'].sql).toContain('DO UPDATE');
  });
});

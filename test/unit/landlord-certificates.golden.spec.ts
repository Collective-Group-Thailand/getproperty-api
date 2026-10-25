import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { htmlToText } from '@common/text/html-text';
import {
  certificateBody,
  type CertificateData,
  incomeSummaryBody,
  type IncomeSummaryData,
} from '@modules/ops-leases/certificate-templates';
import { bahtTextEn } from '@modules/ops-leases/english-text';
import { bahtText } from '@modules/ops-leases/thai-text';

const GOLDEN = (name: string) => join(__dirname, '..', 'golden', 'landlord', `${name}.txt`);

function check(name: string, html: string) {
  const text = htmlToText(html);
  const file = GOLDEN(name);
  if (process.env.GOLDEN_UPDATE === '1' || !existsSync(file)) writeFileSync(file, `${text}\n`);
  expect(`${text}\n`).toBe(readFileSync(file, 'utf8'));
  return text;
}

const lessor = { legalName: 'มาลี ตัวอย่าง', taxId: null, address: '9 ถนนตัวอย่าง กรุงเทพมหานคร 10400' };
const premises = {
  unitNo: '12/345',
  propertyName: 'คอนโดตัวอย่าง',
  address: '9 ถนนตัวอย่าง กรุงเทพมหานคร 10400',
};

const certificate = (en: boolean): CertificateData => ({
  number: 'RPC-2026-00001',
  issuedOn: en ? '26 October 2026' : '26 ตุลาคม พ.ศ. 2569',
  lessor,
  lessee: { displayName: 'Alex Example' },
  premises,
  lease: {
    number: 'CTR-2026-00001',
    startDate: en ? '1 November 2025' : '1 พฤศจิกายน พ.ศ. 2568',
    endDate: en ? '31 October 2026' : '31 ตุลาคม พ.ศ. 2569',
    rent: '15,000.00',
  },
  period: {
    from: en ? '1 October 2025' : '1 ตุลาคม พ.ศ. 2568',
    to: en ? '26 October 2026' : '26 ตุลาคม พ.ศ. 2569',
  },
  purpose: 'visa',
  payments: [
    { date: en ? '5 November 2025' : '5 พฤศจิกายน พ.ศ. 2568', number: 'RCP-2025-00011', amount: '15,000.00' },
    { date: en ? '5 December 2025' : '5 ธันวาคม พ.ศ. 2568', number: 'RCP-2025-00012', amount: '15,000.00' },
  ],
  total: '30,000.00',
  totalText: en ? bahtTextEn('30000') : bahtText('30000'),
  outstanding: null,
});

const summary = (en: boolean): IncomeSummaryData => ({
  number: 'ISM-2026-00001',
  issuedOn: en ? '2026-10-26' : '26 ต.ค. 2569',
  owner: lessor,
  premises,
  year: en ? '2026' : 'พ.ศ. 2569',
  months: Array.from({ length: 12 }, (_, i) => ({
    label: String(i + 1),
    amount: i < 10 ? '15,000.00' : '0.00',
  })),
  rent: '150,000.00',
  charges: '12,400.00',
  retained: '2,000.00',
  gross: '152,000.00',
  grossText: en ? bahtTextEn('152000') : bahtText('152000'),
  deductionPercent: '30',
  deduction: '45,600.00',
  net: '106,400.00',
  expenses: '3,500.00',
  expenseItems: [
    { label: en ? 'Plumbing' : 'ประปา', amount: '2,000.00' },
    { label: en ? 'Air conditioning' : 'เครื่องปรับอากาศ', amount: '1,500.00' },
  ],
  netActual: '148,500.00',
});

/** Golden texts of the rent certificate and the annual income summary (B7.5 part 3, D-253), th and en. */
describe('landlord certificates and summaries (golden)', () => {
  it.each([
    ['th', false],
    ['en', true],
  ] as const)('renders the rent certificate in %s', (lang, en) => {
    const text = check(`certificate-${lang}`, certificateBody(lang, certificate(en)));
    expect(text).toContain('RPC-2026-00001');
    expect(text).toContain(en ? 'nothing is overdue' : 'ไม่มียอดค้างชำระ');
  });

  it.each([
    ['th', false],
    ['en', true],
  ] as const)('renders the income summary in %s', (lang, en) => {
    const text = check(`income-summary-${lang}`, incomeSummaryBody(lang, summary(en)));
    expect(text).toContain('152,000.00');
    expect(text).toContain(en ? 'not a tax filing' : 'ไม่ใช่การยื่นภาษี');
  });

  it('says when something is overdue', () => {
    const text = htmlToText(certificateBody('th', { ...certificate(false), outstanding: '15,000.00' }));
    expect(text).toContain('มียอดค้างชำระ 15,000.00 บาท');
  });
});

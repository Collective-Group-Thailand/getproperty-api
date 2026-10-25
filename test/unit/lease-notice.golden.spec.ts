import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { htmlToText } from '@common/text/html-text';
import { bahtTextEn, englishDate } from '@modules/ops-leases/english-text';
import { LEASE_NOTICE_KINDS, noticeBody, type NoticeData } from '@modules/ops-leases/notice-templates';
import { bahtText, formatThb, thaiDate } from '@modules/ops-leases/thai-text';

const GOLDEN = (kind: string, language: string) =>
  join(__dirname, '..', 'golden', 'landlord', `notice-${kind}-${language}.txt`);

function fixture(language: 'th' | 'en'): NoticeData {
  const date = language === 'en' ? englishDate : thaiDate;
  const words = language === 'en' ? bahtTextEn : bahtText;
  return {
    number: 'NTC-2026-00001',
    issuedOn: date('2026-10-25'),
    lessor: { legalName: 'มาลี ตัวอย่าง', taxId: null, address: '9 ถนนตัวอย่าง กรุงเทพมหานคร 10400' },
    lessee: { displayName: 'Alex Example', address: null },
    premises: {
      unitNo: '12/345',
      propertyName: 'คอนโดตัวอย่าง',
      address: '9 ถนนตัวอย่าง กรุงเทพมหานคร 10400',
    },
    lease: {
      number: 'CTR-2026-00001',
      startDate: date('2026-11-01'),
      endDate: date('2027-10-31'),
      rent: formatThb('15000'),
      rentText: words('15000'),
    },
    effectiveDate: date('2027-11-01'),
    respondBy: date('2026-11-09'),
    noticeDays: 372,
    newRent: formatThb('15500'),
    newRentText: words('15500'),
    renewalMonths: 12,
    reasonCode: 'lessee_breach',
    amountDue: formatThb('15000'),
    amountDueText: words('15000'),
    items: [{ number: 'INV-2026-00077', dueDate: date('2026-09-05'), balance: formatThb('15000') }],
    refundDays: 7,
    message: language === 'en' ? 'Call me if anything is unclear.' : 'หากมีข้อสงสัยโทรหาได้ค่ะ',
  };
}

/**
 * Golden texts of the notice letters (B7.5, D-253): 5 kinds × th / en. A wording change (counsel, O-017) regenerates
 * them with `GOLDEN_UPDATE=1 pnpm test -- lease-notice` and the diff is reviewed.
 */
describe('lease notice letters (golden)', () => {
  for (const kind of LEASE_NOTICE_KINDS)
    for (const language of ['th', 'en'] as const)
      it(`renders the ${kind} letter in ${language}`, () => {
        const text = htmlToText(noticeBody(kind, language, fixture(language)));
        const file = GOLDEN(kind, language);
        if (process.env.GOLDEN_UPDATE === '1' || !existsSync(file)) writeFileSync(file, `${text}\n`);
        expect(`${text}\n`).toBe(readFileSync(file, 'utf8'));
        expect(text).toContain('NTC-2026-00001');
        if (kind === 'late_payment' || kind === 'termination')
          expect(text).toContain(language === 'en' ? 'will not cut off water or electricity' : 'จะไม่ตัดน้ำ');
      });

  it('escapes what people typed', () => {
    const d = { ...fixture('th'), message: '<script>alert(1)</script>' };
    expect(noticeBody('renewal_offer', 'th', d)).not.toContain('<script>');
  });
});

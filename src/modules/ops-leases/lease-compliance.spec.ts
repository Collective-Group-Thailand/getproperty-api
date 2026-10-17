import { COMPLIANCE_RULES } from '@core/compliance/rules';

import {
  checkLeaseTerms,
  checkLesseeNotice,
  checkLessorNotice,
  type LeaseRuleSettings,
  type LeaseTermsInput,
} from './lease-compliance';

const SETTINGS: LeaseRuleSettings = {
  depositMaxMonths: '3',
  lateFeeEnabled: false,
  waterMinimumCap: '100.00',
};
const BASE: LeaseTermsInput = {
  rent: '4500.00',
  depositAmount: '4500.00',
  advanceRentAmount: '4500.00',
  months: 12,
  startDate: '2026-11-01',
  endDate: '2027-10-31',
  utilityBillingMode: 'metered',
  lines: [{ kind: 'internet', description: 'อินเทอร์เน็ต', amount: '300.00' }],
  addendum: [{ type: 'pets', title: 'สัตว์เลี้ยง', text: 'อนุญาตแมวได้ 1 ตัว' }],
  rentIncreases: [],
  isRenewal: false,
};

const rule = (checks: ReturnType<typeof checkLeaseTerms>, id: string) => checks.find((c) => c.ruleId === id)!;

/** Every lease rule with its legal reference (legal-reference.md §1–§2, D-020, D-023). */
describe('lease compliance rules (สคบ. 2568)', () => {
  it.each([
    ['compliance.deposit_cap', 'ข้อ 5 (2)'],
    ['compliance.forbidden_clause', 'ข้อ 5 (1)–(12)'],
    ['compliance.no_renewal_fee', 'ข้อ 5 (11)'],
    ['compliance.bill_disclosure', 'ข้อ 4 (8)'],
    ['compliance.no_midterm_increase', 'ข้อ 5 (3)'],
    ['compliance.water_minimum', 'ข้อ 5 (6)'],
    ['compliance.late_fee_policy', 'ข้อ 4 (5)'],
    ['compliance.notice_period', 'ข้อ 4 (11)'],
    ['compliance.termination_notice', 'ข้อ 4 (12)'],
  ])('%s is registered with a legal reference (%s)', (id, clause) => {
    const def = COMPLIANCE_RULES.find((r) => r.id === id);
    expect(def).toBeDefined();
    expect(def!.legalRef).toContain('2568');
    expect(def!.legalRef).toContain(clause);
  });

  it('a lawful standard lease passes every check', () => {
    const checks = checkLeaseTerms(BASE, SETTINGS);
    expect(checks.filter((c) => c.violated)).toEqual([]);
    expect(checks.map((c) => c.ruleId)).toEqual(
      expect.arrayContaining([
        'compliance.deposit_cap',
        'compliance.forbidden_clause',
        'compliance.no_renewal_fee',
        'compliance.bill_disclosure',
        'compliance.no_midterm_increase',
        'compliance.late_fee_policy',
      ]),
    );
  });

  it('deposit_cap: deposit + advance above the configured months of rent', () => {
    expect(
      rule(
        checkLeaseTerms({ ...BASE, depositAmount: '9000.00', advanceRentAmount: '4500.00' }, SETTINGS),
        'compliance.deposit_cap',
      ).violated,
    ).toBe(false);
    const c = rule(
      checkLeaseTerms({ ...BASE, depositAmount: '9000.01', advanceRentAmount: '4500.00' }, SETTINGS),
      'compliance.deposit_cap',
    );
    expect(c.violated).toBe(true);
    expect(c.context).toMatchObject({ total: '13500.01', cap: '13500.00', capMonths: '3' });
    expect(c.errors![0]).toMatchObject({ path: 'depositAmount', code: 'depositCap' });
  });

  it('forbidden_clause: a forbidden type, an unknown type, and forbidden wording under an allowed type', () => {
    const typed = rule(
      checkLeaseTerms({ ...BASE, addendum: [{ type: 'renewal_fee', title: 'x', text: 'y' }] }, SETTINGS),
      'compliance.forbidden_clause',
    );
    expect(typed.violated).toBe(true);
    const unknown = rule(
      checkLeaseTerms({ ...BASE, addendum: [{ type: 'surprise', title: 'x', text: 'y' }] }, SETTINGS),
      'compliance.forbidden_clause',
    );
    expect(unknown.errors![0]!.code).toBe('unknownType');
    for (const text of [
      'หากค้างชำระ ผู้ให้เช่ามีสิทธิ์ตัดไฟได้ทันที',
      'ผู้ให้เช่าเข้าตรวจห้องได้ตลอดเวลา',
      'ผู้ให้เช่าขอสงวนสิทธิ์ปรับค่าเช่าระหว่างอายุสัญญา',
      'ผู้ให้เช่าริบเงินประกันทั้งหมด',
      'ผู้ให้เช่าไม่รับผิดชอบใด ๆ ทุกกรณี',
    ]) {
      const c = rule(
        checkLeaseTerms({ ...BASE, addendum: [{ type: 'house_rules', title: 'ระเบียบ', text }] }, SETTINGS),
        'compliance.forbidden_clause',
      );
      expect({ text, violated: c.violated }).toEqual({ text, violated: true });
    }
    const negated = rule(
      checkLeaseTerms(
        {
          ...BASE,
          addendum: [{ type: 'house_rules', title: 'ระเบียบ', text: 'ผู้ให้เช่าจะไม่ริบเงินประกัน' }],
        },
        SETTINGS,
      ),
      'compliance.forbidden_clause',
    );
    expect(negated.violated).toBe(false);
  });

  it('no_renewal_fee: a fixed line named as a renewal fee', () => {
    const c = rule(
      checkLeaseTerms(
        { ...BASE, lines: [{ kind: 'other_fixed', description: 'ค่าต่อสัญญา', amount: '500' }] },
        SETTINGS,
      ),
      'compliance.no_renewal_fee',
    );
    expect(c.violated).toBe(true);
  });

  it('bill_disclosure: utilities are never fixed lines (D-022)', () => {
    const c = rule(
      checkLeaseTerms(
        { ...BASE, lines: [{ kind: 'other_fixed', description: 'ค่าไฟเหมาจ่าย', amount: '800' }] },
        SETTINGS,
      ),
      'compliance.bill_disclosure',
    );
    expect(c.violated).toBe(true);
    expect(
      rule(
        checkLeaseTerms(
          { ...BASE, lines: [{ kind: 'other_fixed', description: 'water heater rental', amount: '100' }] },
          SETTINGS,
        ),
        'compliance.bill_disclosure',
      ).violated,
    ).toBe(false);
  });

  it('no_midterm_increase: recorded increases must fall inside the term', () => {
    expect(
      rule(
        checkLeaseTerms(
          { ...BASE, rentIncreases: [{ effectiveFrom: '2027-05-01', rent: '4800' }] },
          SETTINGS,
        ),
        'compliance.no_midterm_increase',
      ).violated,
    ).toBe(false);
    expect(
      rule(
        checkLeaseTerms(
          { ...BASE, rentIncreases: [{ effectiveFrom: '2027-12-01', rent: '4800' }] },
          SETTINGS,
        ),
        'compliance.no_midterm_increase',
      ).violated,
    ).toBe(true);
  });

  it('water_minimum: above the utility’s own minimum, or no published minimum', () => {
    const withLine = (amount: string) => ({
      ...BASE,
      lines: [{ kind: 'water_minimum', description: 'ค่าน้ำขั้นต่ำ', amount }],
    });
    expect(rule(checkLeaseTerms(withLine('100'), SETTINGS), 'compliance.water_minimum').violated).toBe(false);
    expect(rule(checkLeaseTerms(withLine('150'), SETTINGS), 'compliance.water_minimum').violated).toBe(true);
    expect(
      rule(
        checkLeaseTerms(withLine('50'), { ...SETTINGS, waterMinimumCap: null }),
        'compliance.water_minimum',
      ).violated,
    ).toBe(true);
    expect(checkLeaseTerms(BASE, SETTINGS).some((c) => c.ruleId === 'compliance.water_minimum')).toBe(false);
  });

  it('late_fee_policy: late-fee terms need late fees enabled (D-045)', () => {
    const t = {
      ...BASE,
      addendum: [{ type: 'other', title: 'ค่าปรับ', text: 'ค่าปรับชำระล่าช้าวันละ 50 บาท' }],
    };
    expect(rule(checkLeaseTerms(t, SETTINGS), 'compliance.late_fee_policy').violated).toBe(true);
    expect(
      rule(checkLeaseTerms(t, { ...SETTINGS, lateFeeEnabled: true }), 'compliance.late_fee_policy').violated,
    ).toBe(false);
  });

  it('notice_period: the lessee gives at least 30 days (ข้อ 4 (11))', () => {
    expect(checkLesseeNotice('2026-11-01', '2026-12-01').violated).toBe(false);
    const short = checkLesseeNotice('2026-11-01', '2026-11-30');
    expect(short.violated).toBe(true);
    expect(short.shown).toMatchObject({ days: 29, minimumDays: 30 });
  });

  it('termination_notice: ground, period and evidence of the lessor (ข้อ 4 (12))', () => {
    expect(checkLessorNotice('lessee_breach', '2026-11-01', '2026-12-01', 1, '2027-10-31').violated).toBe(
      false,
    );
    expect(checkLessorNotice('lessee_breach', '2026-11-01', '2026-11-20', 1, '2027-10-31').violated).toBe(
      true,
    );
    expect(
      checkLessorNotice('lessee_breach', '2026-11-01', '2026-12-01', 0, '2027-10-31').errors![0]!.code,
    ).toBe('evidenceRequired');
    expect(checkLessorNotice('disturbance', '2026-11-01', '2026-11-08', 1, '2027-10-31').violated).toBe(
      false,
    );
    expect(checkLessorNotice('end_of_term', '2027-09-01', '2027-10-31', 0, '2027-10-31').violated).toBe(
      false,
    );
    expect(checkLessorNotice('end_of_term', '2027-09-01', '2027-10-15', 0, '2027-10-31').violated).toBe(true);
  });
});

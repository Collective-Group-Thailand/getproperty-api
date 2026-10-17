import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { UTILITY_TARIFFS } from '../../../prisma/seed/data/utility-tariffs';
import { SETTINGS } from '../settings/catalogue';
import { type UtilityTariffStructure } from '../utility-tariffs/tariff-structure';
import { effectiveSeverity, outcomeOf } from './compliance-gate.service';
import { type RuleCheck } from './evaluators';
import { COMPLIANCE_RULES, type ComplianceRuleId, evaluateRule, type RuleContexts } from './rules';

function seeded(provider: string, code: string, effectiveFrom: string): UtilityTariffStructure {
  const v = UTILITY_TARIFFS.find((t) => t.provider === provider && t.tariffCode === code)?.versions.find(
    (x) => x.effectiveFrom === effectiveFrom,
  );
  if (!v) throw new Error(`no seeded version ${provider} ${code} ${effectiveFrom}`);
  return v.structure;
}

const PEA_112 = {
  id: '00000000-0000-7000-8000-000000000112',
  utility: 'electric' as const,
  provider: 'pea',
  tariffCode: '1.1.2',
  effectiveFrom: '2025-05-01',
  structure: seeded('pea', '1.1.2', '2025-05-01'),
};
const DEDUCTION = {
  kind: 'damage' as const,
  wearCategory: 'damage' as const,
  evidenceCount: 1,
  inspectionItem: { condition: 'damaged', photoCount: 1 },
};
const AT = new Date('2026-12-08T03:00:00Z');

/**
 * One passing and one breaking context per rule of the registry (ADR-0007): the evaluator decides `violated`, the
 * D-021a semantics turn a breach into a warning (severity `warn`) or a refusal (severity `block`, or a warning the
 * actor cannot acknowledge). Every rule is listed — a new rule without fixtures fails the "covers every rule" test.
 */
const FIXTURES: { [K in ComplianceRuleId]: { pass: RuleContexts[K]; breach: RuleContexts[K] } } = {
  'compliance.scope': {
    pass: { unitsRentedOut: 12, subjectSetting: true },
    breach: { unitsRentedOut: 12, subjectSetting: false },
  },
  'compliance.tariff_cap': {
    // PEA 1.1.2 at 150 kWh: effective average 3.6097 THB/kWh (tariff-math golden value)
    pass: { tenantRate: '3.6097', units: '150', tariff: PEA_112 },
    breach: { tenantRate: '7.0000', units: '150', tariff: PEA_112 },
  },
  'compliance.bill_disclosure': {
    pass: {
      meterLines: [
        {
          path: 'lines[1]',
          units: '166.422',
          unitPrice: '7.0000',
          segments: [{ registerFrom: '12345.678', registerTo: '12512.100' }],
          readingSource: 'iot',
          utilityTariffVersionId: PEA_112.id,
        },
      ],
      fixedLines: [{ path: 'lines[2]', kind: 'internet', description: 'อินเทอร์เน็ต' }],
    },
    breach: {
      meterLines: [
        {
          path: 'lines[1]',
          units: '166.422',
          unitPrice: '7.0000',
          segments: [{ registerFrom: null, registerTo: '12512.100' }],
          readingSource: 'iot',
          utilityTariffVersionId: PEA_112.id,
        },
      ],
      fixedLines: [{ path: 'lines[2]', kind: 'other_fixed', description: 'ค่าไฟเหมาจ่าย' }],
    },
  },
  'compliance.invoice_lead_time': {
    pass: { issuedOn: '2026-12-01', dueDate: '2026-12-05', minLeadDays: 3 },
    breach: { issuedOn: '2026-12-03', dueDate: '2026-12-05', minLeadDays: 3 },
  },
  'compliance.water_minimum': {
    pass: { minimumCharge: '50.00', utilityMinimum: '50.00' },
    breach: { minimumCharge: '100.00', utilityMinimum: '50.00' },
  },
  'compliance.deposit_cap': {
    pass: { rent: '4500.00', deposit: '9000.00', advanceRent: '4500.00', capMonths: '3' },
    breach: { rent: '4500.00', deposit: '9000.01', advanceRent: '4500.00', capMonths: '3' },
  },
  'compliance.deposit_deadline': {
    pass: {
      deadlineAt: new Date('2026-12-07T03:00:00Z'),
      refundedAt: new Date('2026-12-06T03:00:00Z'),
      at: AT,
    },
    breach: { deadlineAt: new Date('2026-12-07T03:00:00Z'), refundedAt: null, at: AT },
  },
  'compliance.deposit_evidence': {
    pass: DEDUCTION,
    breach: { ...DEDUCTION, evidenceCount: 0, inspectionItem: null },
  },
  'compliance.deposit_wear': {
    pass: DEDUCTION,
    breach: { ...DEDUCTION, wearCategory: 'normal_wear' },
  },
  'compliance.no_forfeiture': {
    pass: { owed: '3349.50', refund: '3349.50' },
    breach: { owed: '3349.50', refund: '3000.00' },
  },
  'compliance.notice_period': {
    pass: { noticeDate: '2026-11-01', effectiveDate: '2026-12-01' },
    breach: { noticeDate: '2026-11-01', effectiveDate: '2026-11-20' },
  },
  'compliance.termination_notice': {
    pass: {
      reason: 'lessee_breach',
      noticeDate: '2026-11-01',
      effectiveDate: '2026-12-01',
      evidenceCount: 1,
      endDate: '2027-10-31',
    },
    breach: {
      reason: 'lessee_breach',
      noticeDate: '2026-11-01',
      effectiveDate: '2026-11-10',
      evidenceCount: 0,
      endDate: '2027-10-31',
    },
  },
  'compliance.no_midterm_increase': {
    pass: {
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      recordedIncreases: [],
      change: { field: 'pricePerUnit', from: '7.0000', to: '6.5000', effectiveOn: '2027-01-01' },
    },
    breach: {
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      recordedIncreases: [],
      change: { field: 'pricePerUnit', from: '6.5000', to: '7.0000', effectiveOn: '2027-01-01' },
    },
  },
  'compliance.no_renewal_fee': {
    pass: { lines: [{ path: 'lines[0]', description: 'ค่าที่จอดรถ' }] },
    breach: { lines: [{ path: 'lines[0]', description: 'ค่าต่อสัญญา' }] },
  },
  'compliance.entry_notice': {
    pass: {
      emergency: false,
      noticeGivenAt: new Date('2026-12-01T03:00:00Z'),
      entryAt: new Date('2026-12-02T03:00:00Z'),
    },
    breach: { emergency: false, noticeGivenAt: null, entryAt: new Date('2026-12-02T03:00:00Z') },
  },
  'compliance.no_cutoff': {
    pass: { action: 'reminder', reason: 'arrears' },
    breach: { action: 'power_cutoff', reason: 'arrears' },
  },
  'compliance.forbidden_clause': {
    pass: {
      addendum: [{ type: 'pets', title: 'สัตว์เลี้ยง', text: 'อนุญาตแมวได้ 1 ตัว' }],
      allowedTypes: ['pets'],
      forbiddenTypes: ['renewal_fee'],
    },
    breach: {
      addendum: [{ type: 'pets', title: 'ระเบียบ', text: 'หากค้างชำระ ผู้ให้เช่ามีสิทธิ์ตัดไฟได้ทันที' }],
      allowedTypes: ['pets'],
      forbiddenTypes: ['renewal_fee'],
    },
  },
  'compliance.late_fee_policy': {
    pass: { lateFeeEnabled: true, contractStatesLateFee: true, amount: '100.00', agreedAmount: '100.00' },
    breach: { lateFeeEnabled: false, contractStatesLateFee: false, amount: '100.00', agreedAmount: null },
  },
};

const run = <K extends ComplianceRuleId>(id: K, ctx: RuleContexts[K]): RuleCheck => evaluateRule(id, ctx);

describe('compliance rule registry (ADR-0007, D-020, D-149)', () => {
  const legalReference = readFileSync(
    join(__dirname, '..', '..', '..', 'docs', 'compliance', 'legal-reference.md'),
    'utf8',
  );

  it('ids are unique and every rule of legal-reference §1 is registered', () => {
    const ids = COMPLIANCE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const referenced = [...legalReference.matchAll(/`(compliance\.[a-z_]+)`/g)].map((m) => m[1]);
    for (const id of new Set(referenced)) expect(ids).toContain(id);
  });

  it('every rule has a legal reference and only uses known settings', () => {
    const keys = new Set(SETTINGS.map((s) => s.key));
    for (const r of COMPLIANCE_RULES) {
      expect(r.legalRef).toMatch(/ข้อ \d/);
      for (const s of r.settingsUsed) expect([r.id, keys.has(s)]).toEqual([r.id, true]);
    }
  });

  it('the tariff cap warns by default (D-021a); no cut-off is a block (D-024)', () => {
    expect(COMPLIANCE_RULES.find((r) => r.id === 'compliance.tariff_cap')?.defaultSeverity).toBe('warn');
    expect(COMPLIANCE_RULES.find((r) => r.id === 'compliance.no_cutoff')?.defaultSeverity).toBe('block');
  });

  it('the fixtures cover every registered rule', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(COMPLIANCE_RULES.map((r) => r.id).sort());
  });

  describe.each(COMPLIANCE_RULES.map((r) => [r.id, r.legalRef] as const))('%s (%s)', (id, legalRef) => {
    const fixture = FIXTURES[id];

    it('passes a lawful subject', () => {
      const check = run(id, fixture.pass as never);
      expect(check.ruleId).toBe(id);
      expect(check.violated).toBe(false);
      expect(outcomeOf(check.violated, 'warn')).toBe('pass');
      expect(outcomeOf(check.violated, 'block')).toBe('pass');
    });

    it('warns under severity warn (Owner acknowledges, D-021a)', () => {
      const check = run(id, fixture.breach as never);
      expect(check.violated).toBe(true);
      expect(Object.keys(check.context).length).toBeGreaterThan(0);
      expect(outcomeOf(check.violated, 'warn')).toBe('warn');
    });

    it('refuses under severity block, and refuses a warning the actor cannot acknowledge', () => {
      const check = run(id, fixture.breach as never);
      expect(outcomeOf(check.violated, 'block')).toBe('block');
      expect(outcomeOf(check.violated, 'warn', { refuseWarnings: true })).toBe('block');
      expect(legalRef).toContain('2568');
    });
  });

  it('tariff_cap shows the cap and the rate compared (legal-reference §4 warning values)', () => {
    const check = run('compliance.tariff_cap', FIXTURES['compliance.tariff_cap'].breach);
    expect(check.shown).toMatchObject({
      capPerUnit: '3.6097',
      tenantRate: '7.0000',
      units: '150.000',
      tariffCode: '1.1.2',
      utilityTariffVersionId: PEA_112.id,
    });
  });

  it('water_minimum: an unknown utility minimum never allows a lease minimum (D-141)', () => {
    expect(run('compliance.water_minimum', { minimumCharge: '10.00', utilityMinimum: null }).violated).toBe(
      true,
    );
    expect(run('compliance.water_minimum', { minimumCharge: '0.00', utilityMinimum: null }).violated).toBe(
      false,
    );
  });

  it('no_cutoff: access ends with the lease or an owner action, never for arrears (D-071)', () => {
    expect(run('compliance.no_cutoff', { action: 'revoke_access', reason: 'lease_end' }).violated).toBe(
      false,
    );
    expect(run('compliance.no_cutoff', { action: 'revoke_access', reason: 'arrears' }).violated).toBe(true);
    expect(run('compliance.no_cutoff', { action: 'lock_out', reason: 'owner_request' }).violated).toBe(true);
  });

  it('late_fee_policy: never above the agreed amount', () => {
    expect(
      run('compliance.late_fee_policy', {
        lateFeeEnabled: true,
        contractStatesLateFee: true,
        amount: '150.00',
        agreedAmount: '100.00',
      }).errors?.[0]?.code,
    ).toBe('aboveAgreed');
  });

  it('severity: rule setting, then the admin overrides map, then the registry default (D-021a)', () => {
    expect(effectiveSeverity('compliance.tariff_cap', {})).toBe('warn');
    expect(effectiveSeverity('compliance.tariff_cap', { specific: 'block' })).toBe('block');
    expect(
      effectiveSeverity('compliance.tariff_cap', {
        specific: 'warn',
        overrides: { 'compliance.tariff_cap': 'block' },
      }),
    ).toBe('warn');
    expect(
      effectiveSeverity('compliance.notice_period', { overrides: { 'compliance.notice_period': 'block' } }),
    ).toBe('block');
    expect(
      effectiveSeverity('compliance.no_cutoff', { overrides: { 'compliance.no_cutoff': 'nonsense' } }),
    ).toBe('block');
  });
});

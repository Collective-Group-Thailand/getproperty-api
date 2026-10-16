import { SETTINGS } from './catalogue';

describe('setting catalogue (ADR-0004, D-144)', () => {
  it('keys are unique and dotted; every description cites a decision', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SETTINGS) {
      expect(s.key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
      expect(s.description).toMatch(/[DO]-\d{3}/);
      expect(s.scopeAllowed.length).toBeGreaterThan(0);
      expect(s.editableBy.length).toBeGreaterThan(0);
    }
  });

  it('carries the decided defaults', () => {
    const v = Object.fromEntries(SETTINGS.map((s) => [s.key, s.value]));
    expect(v['compliance.tariff_cap.severity']).toBe('warn'); // D-021a
    expect(v['tenant.subject_to_ocpb_2568']).toBe(true); // D-158
    expect(v['late_fee.enabled']).toBe(false); // D-045 ⚖
    expect(v['reminders.schedule']).toEqual([1, 3, 7]); // D-045
    expect(v['subscription.trial_days']).toBe(30); // D-082
  });

  it('the tariff-cap severity is a platform/tenant setting edited by the platform admin only (D-021a)', () => {
    const s = SETTINGS.find((x) => x.key === 'compliance.tariff_cap.severity')!;
    expect(s.scopeAllowed).toEqual(['platform', 'tenant']);
    expect(s.editableBy).toEqual(['admin.compliance.manage']);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SETTINGS } from '../settings/catalogue';
import { COMPLIANCE_RULES } from './rules';

describe('compliance rule registry (D-020, D-149)', () => {
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
});

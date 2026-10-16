import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERMISSIONS, renderRbacMarkdown, ROLE_PERMISSIONS, ROLES } from './catalogue';

describe('RBAC catalogue (D-090, D-091)', () => {
  it('docs/rbac.md is generated from the catalogue (pnpm rbac:build)', () => {
    const committed = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'rbac.md'), 'utf8');
    expect(committed).toBe(renderRbacMarkdown());
  });

  it('every granted permission exists; keys are unique resource.action', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_.]*\.[a-z_]+$/);
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      for (const k of granted) expect([role, keys.includes(k)]).toEqual([role, true]);
    }
    expect(ROLES.map((r) => r.key).sort()).toEqual(Object.keys(ROLE_PERMISSIONS).sort());
  });

  it('manager has everything but billing settings, bank account and subscription; staff handles no money', () => {
    expect(ROLE_PERMISSIONS.manager).not.toContain('tenant.bank_account.manage');
    expect(ROLE_PERMISSIONS.manager).not.toContain('tenant.billing_settings.update');
    expect(ROLE_PERMISSIONS.manager).not.toContain('tenant.subscription.manage');
    expect(ROLE_PERMISSIONS.manager).toContain('invoice.issue');
    for (const money of ['invoice.issue', 'payment.record', 'receipt.issue', 'rate_plan.manage']) {
      expect(ROLE_PERMISSIONS.staff).not.toContain(money);
    }
    expect(ROLE_PERMISSIONS.accountant).not.toContain('tenant.settings.update');
    expect(ROLE_PERMISSIONS.support.every((k) => k.startsWith('admin.'))).toBe(true);
  });
});

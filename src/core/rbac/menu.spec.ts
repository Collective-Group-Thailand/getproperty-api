import { PERMISSIONS, ROLE_PERMISSIONS } from './catalogue';
import { ADMIN_MENU, entitledMenu, OWNER_MENU, STAFF_MENU } from './menu';

describe('menu entitlements (/me)', () => {
  const set = (role: keyof typeof ROLE_PERMISSIONS) => new Set(ROLE_PERMISSIONS[role]);

  it('every menu entry is reachable through a catalogue permission', () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const m of [...OWNER_MENU, ...STAFF_MENU, ...ADMIN_MENU])
      expect(m.anyOf.some((p) => keys.has(p))).toBe(true);
  });

  it('the Owner sees everything Staff sees, and more', () => {
    const owner = entitledMenu(OWNER_MENU, set('owner'), 'apartment', {});
    const staff = entitledMenu(OWNER_MENU, set('staff'), 'apartment', {});
    expect(owner.length).toBeGreaterThan(staff.length);
    expect(owner).toEqual(expect.arrayContaining(staff));
  });

  it('feature-flagged modules appear only when the flag is on', () => {
    const flagged = OWNER_MENU.filter((m) => m.flag);
    for (const m of flagged) {
      expect(entitledMenu([m], new Set(m.anyOf), 'apartment', {})).toEqual([]);
      const types = m.tenantTypes ?? ['apartment'];
      expect(entitledMenu([m], new Set(m.anyOf), types[0]!, { [m.flag!]: true })).toEqual([m.key]);
    }
  });

  it('a landlord owner gets the portfolio-first menu (D-251), building operators never see it', () => {
    const landlord = entitledMenu(OWNER_MENU, set('owner'), 'landlord', {});
    expect(landlord).toEqual(
      expect.arrayContaining([
        'portfolio',
        'listings',
        'leads',
        'leases',
        'invoices',
        'payments',
        'settings',
      ]),
    );
    expect(landlord).not.toEqual(expect.arrayContaining(['dashboard']));
    for (const key of ['dashboard', 'buildings', 'units', 'devices', 'utility_loss'])
      expect(landlord).not.toContain(key);
    expect(entitledMenu(OWNER_MENU, set('owner'), 'apartment', {})).not.toContain('portfolio');
    expect(entitledMenu(OWNER_MENU, set('owner'), 'apartment', {})).not.toContain('listings');
  });

  it('an agency owner gets listings, mandated units, mandates, co-broke and deals — no building console (G2)', () => {
    const agency = entitledMenu(OWNER_MENU, set('owner'), 'agency', {});
    expect(agency).toEqual(
      expect.arrayContaining(['listings', 'leads', 'mandated_units', 'mandates', 'co_broke', 'deals']),
    );
    for (const key of ['portfolio', 'dashboard', 'buildings', 'units', 'devices'])
      expect(agency).not.toContain(key);
    const landlord = entitledMenu(OWNER_MENU, set('owner'), 'landlord', {});
    expect(landlord).toEqual(expect.arrayContaining(['mandates', 'deals']));
    expect(landlord).not.toContain('co_broke');
  });

  it('platform roles: support sees tenants, not outbox', () => {
    const support = entitledMenu(ADMIN_MENU, set('support'), null, {});
    expect(support).toContain('tenants');
    expect(support).not.toContain('outbox');
    expect(support).toContain('listings');
  });
});

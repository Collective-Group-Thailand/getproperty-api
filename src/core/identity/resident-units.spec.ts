import { type Tx } from '@database/prisma.service';

import {
  leasePartyUnitRole,
  occupancyUnitRole,
  occupiedUnitIds,
  residentUnitRoles,
  scopeUnitIds,
  type UnitRole,
  unitsHash,
} from './resident-units';

/** JR (D-309, D-322): unit roles from ownership + occupancy + leases. */
describe('resident unit roles', () => {
  const d = (s: string) => new Date(s);
  const tx = {
    partyUserLink: { findMany: () => Promise.resolve([{ partyId: 'p1' }, { partyId: 'p2' }]) },
    occupancy: {
      findMany: () =>
        Promise.resolve([
          {
            id: 'o1',
            unitId: 'u1',
            buildingId: 'b1',
            tenantId: 't1',
            partyId: 'p1',
            role: 'family',
            validFrom: d('2026-09-01'),
            validTo: null,
          },
        ]),
    },
    unitOwnership: {
      findMany: () =>
        Promise.resolve([
          {
            id: 'w1',
            unitId: 'u2',
            buildingId: 'b2',
            tenantId: 't2',
            partyId: 'p2',
            validFrom: d('2026-10-01'),
            validTo: d('2027-03-15'),
          },
        ]),
    },
    lease: {
      findMany: () =>
        Promise.resolve([
          {
            id: 'l1',
            unitId: 'u1',
            buildingId: 'b1',
            tenantId: 't1',
            startDate: d('2026-09-01'),
            endDate: d('2027-08-31'),
            payerPartyId: 'p1',
            parties: [{ partyId: 'p1', role: 'occupant' }],
          },
          {
            id: 'l2',
            unitId: 'u3',
            buildingId: 'b1',
            tenantId: 't1',
            startDate: d('2026-09-01'),
            endDate: d('2027-08-31'),
            payerPartyId: null,
            parties: [{ partyId: 'p2', role: 'guarantor' }],
          },
        ]),
    },
  } as unknown as Tx;

  it('derives co_owner / family / payer with their sources; a lease never adds a unit scope', async () => {
    const roles = await residentUnitRoles(tx, 'user-1', '2026-11-05');
    expect(roles.map((r) => `${r.unitId}:${r.role}:${r.source}`)).toEqual([
      'u1:family:occupancy',
      'u2:co_owner:ownership',
      'u1:family:lease',
      'u1:payer:lease',
    ]);
    expect(roles.find((r) => r.source === 'ownership')).toMatchObject({
      tenantId: 't2',
      from: '2026-10-01',
      to: '2027-03-15',
    });
    expect(scopeUnitIds(roles)).toEqual(['u1', 'u2']);
    expect(occupiedUnitIds(roles)).toEqual(['u1']);
  });

  it('maps occupancy and lease party roles', () => {
    expect(['tenant', 'co_tenant', 'owner_occupier', 'family', 'staff'].map(occupancyUnitRole)).toEqual([
      'tenant',
      'co_tenant',
      'co_owner',
      'family',
      'family',
    ]);
    expect(['lessee', 'co_tenant', 'occupant', 'guarantor'].map(leasePartyUnitRole)).toEqual([
      'tenant',
      'co_tenant',
      'family',
      null,
    ]);
  });

  it('hashes the role set independent of order and of source rows', () => {
    const r = (unitId: string, role: UnitRole['role'], sourceId: string): UnitRole => ({
      unitId,
      buildingId: 'b',
      tenantId: 't',
      partyId: 'p',
      role,
      source: 'ownership',
      sourceId,
      from: '2026-01-01',
      to: null,
    });
    const a = unitsHash([r('u1', 'co_owner', 'x'), r('u2', 'co_owner', 'y')]);
    expect(unitsHash([r('u2', 'co_owner', 'z'), r('u1', 'co_owner', 'x')])).toBe(a);
    expect(unitsHash([r('u1', 'co_owner', 'x')])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

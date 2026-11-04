import { createHash } from 'node:crypto';

import { type Tx } from '@database/prisma.service';

/**
 * JR (D-309 = D-J08, D-322): how a resident relates to a unit. A login reaches a unit through a current
 * `core.unit_ownership` (co-owner) or a current `core.occupancy` of one of its linked parties; a lease in force on the
 * unit adds context (tenant / co-tenant / family / payer) but never a unit on its own. `co_owner` and `payer` are
 * derived roles, not `core.occupancy_role` values (asset-core's enum stays stable).
 */
export type UnitRoleName = 'co_owner' | 'tenant' | 'co_tenant' | 'family' | 'payer';
export type UnitRoleSource = 'ownership' | 'occupancy' | 'lease';

export const UNIT_ROLE_NAMES: readonly UnitRoleName[] = [
  'co_owner',
  'tenant',
  'co_tenant',
  'family',
  'payer',
];
export const UNIT_ROLE_SOURCES: readonly UnitRoleSource[] = ['ownership', 'occupancy', 'lease'];

export interface UnitRole {
  unitId: string;
  buildingId: string;
  /** The tenant that keeps the record (ownership register, occupancy, lease). */
  tenantId: string;
  partyId: string;
  role: UnitRoleName;
  source: UnitRoleSource;
  /** Id of the ownership / occupancy / lease row. */
  sourceId: string;
  /** First day (Bangkok business date, `YYYY-MM-DD`). */
  from: string;
  /** Day the role ends (exclusive for ownership / occupancy; the planned last day of a lease); null = open. */
  to: string | null;
}

/** Lease statuses whose parties hold a unit role (in force; history stays reachable through `lease:` scopes). */
export const LEASE_IN_FORCE = ['active', 'notice_given', 'ending'] as const;

/** Occupancy role → unit role (`owner_occupier` lives there as an owner; household `staff` read like family). */
export function occupancyUnitRole(role: string): UnitRoleName {
  switch (role) {
    case 'tenant':
      return 'tenant';
    case 'co_tenant':
      return 'co_tenant';
    case 'owner_occupier':
      return 'co_owner';
    default:
      return 'family';
  }
}

/** Lease party role → unit role (`guarantor` has none: a guarantor does not live in or own the unit). */
export function leasePartyUnitRole(role: string): UnitRoleName | null {
  switch (role) {
    case 'lessee':
      return 'tenant';
    case 'co_tenant':
      return 'co_tenant';
    case 'occupant':
      return 'family';
    default:
      return null;
  }
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

/** Active links of a login → party ids (every tenant). */
export async function linkedPartyIds(tx: Tx, userId: string): Promise<string[]> {
  const links = await tx.partyUserLink.findMany({
    where: { userId, state: 'active' },
    select: { partyId: true },
  });
  return [...new Set(links.map((l) => l.partyId))];
}

/**
 * Every unit role of a login on `today` (Bangkok business date `YYYY-MM-DD`, review #15). Ownership and occupancy are
 * current when `valid_from ≤ today < valid_to`; a former owner loses the role on the ownership's end date (the
 * transfer date). Ordered: occupancy, ownership, lease (stable for hashing and for the token's scope order).
 */
export async function residentUnitRoles(tx: Tx, userId: string, today: string): Promise<UnitRole[]> {
  const partyIds = await linkedPartyIds(tx, userId);
  if (!partyIds.length) return [];
  const date = new Date(today);
  const current = {
    partyId: { in: partyIds },
    validFrom: { lte: date },
    OR: [{ validTo: null }, { validTo: { gt: date } }],
  };
  const occupancies = await tx.occupancy.findMany({
    where: current,
    select: {
      id: true,
      unitId: true,
      buildingId: true,
      tenantId: true,
      partyId: true,
      role: true,
      validFrom: true,
      validTo: true,
    },
    orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
  });
  const ownerships = await tx.unitOwnership.findMany({
    where: current,
    select: {
      id: true,
      unitId: true,
      buildingId: true,
      tenantId: true,
      partyId: true,
      validFrom: true,
      validTo: true,
    },
    orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
  });
  const leases = await tx.lease.findMany({
    where: {
      status: { in: [...LEASE_IN_FORCE] },
      startDate: { lte: date },
      OR: [{ parties: { some: { partyId: { in: partyIds } } } }, { payerPartyId: { in: partyIds } }],
    },
    select: {
      id: true,
      unitId: true,
      buildingId: true,
      tenantId: true,
      startDate: true,
      endDate: true,
      payerPartyId: true,
      parties: { where: { partyId: { in: partyIds } }, select: { partyId: true, role: true } },
    },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
  });
  const out: UnitRole[] = [];
  for (const o of occupancies ?? [])
    out.push({
      unitId: o.unitId,
      buildingId: o.buildingId,
      tenantId: o.tenantId,
      partyId: o.partyId,
      role: occupancyUnitRole(o.role),
      source: 'occupancy',
      sourceId: o.id,
      from: day(o.validFrom),
      to: o.validTo ? day(o.validTo) : null,
    });
  for (const o of ownerships ?? [])
    out.push({
      unitId: o.unitId,
      buildingId: o.buildingId,
      tenantId: o.tenantId,
      partyId: o.partyId,
      role: 'co_owner',
      source: 'ownership',
      sourceId: o.id,
      from: day(o.validFrom),
      to: o.validTo ? day(o.validTo) : null,
    });
  for (const l of leases ?? []) {
    const base = {
      unitId: l.unitId,
      buildingId: l.buildingId,
      tenantId: l.tenantId,
      source: 'lease' as const,
      sourceId: l.id,
      from: day(l.startDate),
      to: day(l.endDate),
    };
    for (const p of l.parties) {
      const role = leasePartyUnitRole(p.role);
      if (role) out.push({ ...base, partyId: p.partyId, role });
    }
    if (l.payerPartyId && partyIds.includes(l.payerPartyId))
      out.push({ ...base, partyId: l.payerPartyId, role: 'payer' });
  }
  return dedupe(out);
}

function dedupe(roles: UnitRole[]): UnitRole[] {
  const seen = new Set<string>();
  return roles.filter((r) => {
    const key = `${r.unitId}|${r.role}|${r.source}|${r.sourceId}|${r.partyId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Units of the `unit:` scopes: those with an occupancy or ownership role (occupancy first, then ownership, each in
 * order of appearance). A lease alone adds none — apartments keep exactly their B2 scopes.
 */
export function scopeUnitIds(roles: readonly UnitRole[]): string[] {
  const out: string[] = [];
  for (const source of ['occupancy', 'ownership'] as const)
    for (const r of roles) if (r.source === source && !out.includes(r.unitId)) out.push(r.unitId);
  return out;
}

/** Units where the login has a current occupancy (occupant-only features: usage, door codes, door log). */
export function occupiedUnitIds(roles: readonly UnitRole[]): string[] {
  return [...new Set(roles.filter((r) => r.source === 'occupancy').map((r) => r.unitId))];
}

/** sha256 (hex) of the sorted `unitId:role:source` set — changes whenever the resident's unit roles change. */
export function unitsHash(roles: readonly UnitRole[]): string {
  const items = [...new Set(roles.map((r) => `${r.unitId}:${r.role}:${r.source}`))].sort();
  return createHash('sha256').update(items.join('\n')).digest('hex');
}

import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { residentUnitRoles, type UnitRoleName } from '@core/identity/resident-units';
import { type Tx } from '@database/prisma.service';

export interface ResidentUnitAccess {
  ctx: TenantContext;
  userId: string;
  unitId: string;
  buildingId: string;
  tenantId: string;
  /** Parties of the login holding one of the asked roles on the unit (the billed / requesting parties). */
  partyIds: string[];
}

/** The signed-in resident's login id (`core.user_account`). */
export function residentUserId(): string {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return actor.publicId;
}

/**
 * J1.2a (D-309, D-322): a resident reaches `/v1/resident/units/{unitId}/…` of pack J only through a role on that unit
 * **today** (re-read from the register, occupancy and leases — never from a stale token): `co_owner` for debt
 * clearance, the billed roles (`co_owner`, `payer`, `tenant`) for plans and mandates. Anything else is a 404 (a unit
 * of another resident, another tenant, a former owner after the transfer date). Runs as gp_platform; the caller then
 * works in the unit's tenant with the returned context.
 */
export async function residentUnitAccess(
  tx: Tx,
  unitId: string,
  roles: readonly UnitRoleName[],
  now: Date,
): Promise<ResidentUnitAccess> {
  const userId = residentUserId();
  const mine = (await residentUnitRoles(tx, userId, bangkokDate(now))).filter(
    (r) => r.unitId === unitId && roles.includes(r.role),
  );
  if (!mine.length) throw new DomainException('http.not_found');
  const first = mine[0]!;
  return {
    ctx: { tenantId: first.tenantId, source: 'path' },
    userId,
    unitId,
    buildingId: first.buildingId,
    tenantId: first.tenantId,
    partyIds: [...new Set(mine.map((r) => r.partyId))],
  };
}

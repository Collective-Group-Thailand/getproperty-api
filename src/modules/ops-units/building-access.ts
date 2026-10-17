import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { type Building, type Unit } from '@generated/prisma/client';

/**
 * Building and unit lookups for the A1 services (contract §8, schema-design §4.5–§4.6). Reads rely on RLS
 * (own rows, owned/operated buildings, grants) plus the Staff building limit; a row that is missing or invisible is
 * a 404. Changes to the asset core need the current tenant to be the building's owner or operator: a grantee sees
 * the building or unit but gets 403 `asset.read_only`.
 */
export async function visibleBuilding(tx: Tx, ctx: TenantContext, buildingId: string): Promise<Building> {
  if (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)) throw new DomainException('http.not_found');
  const building = await tx.building.findFirst({ where: { id: buildingId, deletedAt: null } });
  if (!building) throw new DomainException('http.not_found');
  return building;
}

export function operates(ctx: TenantContext, building: Pick<Building, 'operatorTenantId' | 'ownerTenantId'>) {
  return building.operatorTenantId === ctx.tenantId || building.ownerTenantId === ctx.tenantId;
}

export async function operatedBuilding(tx: Tx, ctx: TenantContext, buildingId: string): Promise<Building> {
  const building = await visibleBuilding(tx, ctx, buildingId);
  if (!operates(ctx, building)) throw new DomainException('asset.read_only');
  return building;
}

export async function visibleUnit(tx: Tx, ctx: TenantContext, unitId: string): Promise<Unit> {
  const unit = await tx.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit || (ctx.buildingIds && !ctx.buildingIds.includes(unit.buildingId)))
    throw new DomainException('http.not_found');
  return unit;
}

/** A unit whose building the current tenant owns or operates (the building row is read for the check). */
export async function operatedUnit(
  tx: Tx,
  ctx: TenantContext,
  unitId: string,
): Promise<{ unit: Unit; building: Building }> {
  const unit = await visibleUnit(tx, ctx, unitId);
  const building = await tx.building.findFirst({ where: { id: unit.buildingId, deletedAt: null } });
  if (!building || !operates(ctx, building)) throw new DomainException('asset.read_only');
  return { unit, building };
}

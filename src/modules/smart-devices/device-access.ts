import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { type Building, type Device } from '@generated/prisma/client';

/**
 * Building access for device work done in a platform transaction (inventory rows are invisible to gp_app, D-152):
 * the caller's tenant must own or operate the building (and a Staff member limited to buildings must have it).
 * Mirrors `operatedBuilding` of the asset services, with 404 for anything the tenant cannot see.
 */
export async function operatedBuildingAsPlatform(
  tx: Tx,
  ctx: TenantContext,
  buildingId: string,
): Promise<Building> {
  if (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)) throw new DomainException('http.not_found');
  const building = await tx.building.findFirst({ where: { id: buildingId, deletedAt: null } });
  if (!building || (building.operatorTenantId !== ctx.tenantId && building.ownerTenantId !== ctx.tenantId))
    throw new DomainException('http.not_found');
  return building;
}

/** A gateway of the caller's tenant, in a building the caller may work on. */
export async function tenantGateway(tx: Tx, ctx: TenantContext, gatewayId: string): Promise<Device> {
  const device = await tx.device.findUnique({ where: { id: gatewayId } });
  if (!device || device.tenantId !== ctx.tenantId || !device.buildingId)
    throw new DomainException('http.not_found');
  if (ctx.buildingIds && !ctx.buildingIds.includes(device.buildingId))
    throw new DomainException('http.not_found');
  if (device.kind !== 'gateway') throw new DomainException('device.not_gateway');
  if (device.status === 'retired') throw new DomainException('device.invalid_state');
  return device;
}

export const meterKindOf = (utility: 'electric' | 'water') =>
  utility === 'electric' ? ('electric_meter' as const) : ('water_meter' as const);

export const unitOf = (utility: 'electric' | 'water') =>
  utility === 'electric' ? ('kwh' as const) : ('m3' as const);

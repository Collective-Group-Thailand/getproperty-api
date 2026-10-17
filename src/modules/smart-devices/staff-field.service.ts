import { type TenantContext } from '@common/context/tenant-context';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { visibleBuilding } from '@modules/ops-units/building-access';
import { METER_INCLUDE, type MeterRow } from '@modules/ops-units/meters-items.service';
import { Injectable } from '@nestjs/common';

export interface StaffBuilding {
  id: string;
  code: string;
  name: string;
  floorsCount: number | null;
  unitCount: number;
}

export interface MeterPointChannel {
  channelId: string;
  gatewayDeviceId: string;
  meterDeviceId: string | null;
  meterDeviceSerial: string | null;
  busId: string;
  busType: string;
  address: number | null;
  pin: number | null;
  driver: string;
}

export interface MeterPoint {
  meter: MeterRow;
  floorName: string | null;
  lastRegister: string | null;
  channel: MeterPointChannel | null;
}

/**
 * Field views of the staff PWA (web contract requests, D-203): the buildings of my scope with their unit counts (the
 * switcher), and the meter points of a building with the floor, the last accepted register and the open gateway
 * channel (binding wizard, swap, per-unit device list). Staff limited to buildings see only theirs (D-090); another
 * tenant's building is a 404 (RLS + scope).
 */
@Injectable()
export class StaffFieldService extends TenantScopedRepository {
  constructor(private readonly db: TenantTx) {
    super();
  }

  buildings(ctx: TenantContext): Promise<StaffBuilding[]> {
    return this.db.tenant(ctx, async (tx) => {
      const rows = await tx.building.findMany({
        where: {
          deletedAt: null,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
          ...(ctx.buildingIds ? { id: { in: [...ctx.buildingIds] } } : {}),
        },
        orderBy: [{ name: 'asc' }, { code: 'asc' }],
      });
      const counts = await tx.unit.groupBy({
        by: ['buildingId'],
        where: { buildingId: { in: rows.map((b) => b.id) }, deletedAt: null },
        _count: { _all: true },
      });
      const byBuilding = new Map(counts.map((c) => [c.buildingId, c._count._all]));
      return rows.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        floorsCount: b.floorsCount,
        unitCount: byBuilding.get(b.id) ?? 0,
      }));
    });
  }

  meterPoints(ctx: TenantContext, buildingId: string): Promise<MeterPoint[]> {
    return this.db.tenant(ctx, async (tx) => {
      await visibleBuilding(tx, ctx, buildingId);
      const meters = await tx.meterAssignment.findMany({
        where: { buildingId, validTo: null },
        include: {
          ...METER_INCLUDE,
          assetItem: { select: { ...METER_INCLUDE.assetItem.select, floorId: true } },
        },
        orderBy: [{ purpose: 'asc' }, { code: 'asc' }],
      });
      const unitIds = meters.map((m) => m.unitId).filter((u): u is string => Boolean(u));
      const units = new Map(
        (await tx.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, floorId: true } })).map(
          (u) => [u.id, u.floorId],
        ),
      );
      const floors = new Map(
        (await tx.floor.findMany({ where: { buildingId, deletedAt: null } })).map((f) => [f.id, f.name]),
      );
      const itemIds = meters.map((m) => m.assetItemId);
      const channels = await tx.meterChannel.findMany({
        where: { meterAssetItemId: { in: itemIds }, validTo: null },
        include: { meterDevice: { select: { serial: true } } },
      });
      const channelOf = new Map(channels.map((c) => [c.meterAssetItemId, c]));
      const last = await tx.meterReading.findMany({
        where: {
          meterAssignmentId: { in: meters.map((m) => m.id) },
          reviewState: 'accepted',
          supersededByReadingId: null,
          source: { not: 'estimated' },
        },
        orderBy: { readAt: 'desc' },
        distinct: ['meterAssignmentId'],
        select: { meterAssignmentId: true, register: true },
      });
      const lastOf = new Map(last.map((r) => [r.meterAssignmentId, r.register.toFixed(3)]));
      return meters.map((m) => {
        const floorId = (m.unitId ? units.get(m.unitId) : null) ?? m.assetItem.floorId ?? null;
        const c = channelOf.get(m.assetItemId);
        const { floorId: _f, ...assetItem } = m.assetItem;
        return {
          meter: { ...m, assetItem },
          floorName: floorId ? (floors.get(floorId) ?? null) : null,
          lastRegister: lastOf.get(m.id) ?? null,
          channel: c
            ? {
                channelId: c.id,
                gatewayDeviceId: c.gatewayDeviceId,
                meterDeviceId: c.meterDeviceId,
                meterDeviceSerial: c.meterDevice?.serial ?? null,
                busId: c.busId,
                busType: c.busType,
                address: c.address,
                pin: c.pin,
                driver: c.driver,
              }
            : null,
        };
      });
    });
  }
}

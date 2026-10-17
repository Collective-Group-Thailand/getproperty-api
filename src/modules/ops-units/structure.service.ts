import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { DomainEvents } from '@core/events/domain-events';
import { mapConflicts } from '@database/pg-errors';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type BuildingType, type Prisma } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { operatedBuilding, visibleBuilding } from './building-access';

const by = () => userIdOf(RequestContext.actor());
const duplicate = (what: string) => () => new DomainException('asset.duplicate', { params: { what } });

/**
 * Property → building → floor maintenance for the owner console (B2.1). Creation of the core rows reuses the asset
 * core primitives (`PropertyService`, `BuildingService`, `FloorService`); this service adds the updates, the floor
 * listing with unit counts and the duplicate-key mapping (409 `asset.duplicate`). Every change records its domain
 * event through the outbox in the same transaction.
 */
@Injectable()
export class StructureService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
  ) {
    super();
  }

  listProperties(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.property.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    );
  }

  getProperty(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.property.findFirst({ where: { id, deletedAt: null } })),
    );
  }

  createProperty(
    ctx: TenantContext,
    input: { code: string; name: string; address?: Prisma.InputJsonValue; provinceCode?: string | null },
  ) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const p = await tx.property.create({
            data: {
              tenantId: ctx.tenantId,
              code: input.code,
              name: input.name,
              address: input.address ?? {},
              provinceCode: input.provinceCode ?? null,
              createdBy: by(),
            },
          });
          await this.events.record(tx, {
            type: 'property.changed',
            aggregateType: 'property',
            aggregateId: p.id,
            tenantId: ctx.tenantId,
            payload: { propertyId: p.id, change: 'created' },
          });
          return p;
        }),
      duplicate('property code'),
    );
  }

  updateProperty(
    ctx: TenantContext,
    id: string,
    version: number,
    patch: {
      name?: string;
      address?: Prisma.InputJsonValue;
      provinceCode?: string | null;
      status?: 'active' | 'inactive';
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const current = this.found(
        await tx.property.findFirst({ where: this.own(ctx, { id, deletedAt: null }) }),
      );
      if (current.version !== version) throw new DomainException('concurrency.stale');
      const p = await tx.property.update({
        where: { id },
        data: { ...patch, updatedBy: by(), version: { increment: 1 } },
      });
      await this.events.record(tx, {
        type: 'property.changed',
        aggregateType: 'property',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { propertyId: id, change: 'updated', fields: Object.keys(patch) },
      });
      return p;
    });
  }

  createBuilding(
    ctx: TenantContext,
    input: {
      propertyId: string;
      code: string;
      name: string;
      type: BuildingType;
      floorsCount?: number;
      address?: Prisma.InputJsonValue | null;
    },
  ) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          this.found(
            await tx.property.findFirst({ where: this.own(ctx, { id: input.propertyId, deletedAt: null }) }),
          );
          // Apartment default (§4.6): the creating tenant is owner and operator.
          const b = await tx.building.create({
            data: {
              tenantId: ctx.tenantId,
              propertyId: input.propertyId,
              code: input.code,
              name: input.name,
              type: input.type,
              floorsCount: input.floorsCount ?? 1,
              address: input.address ?? undefined,
              ownerTenantId: ctx.tenantId,
              operatorTenantId: ctx.tenantId,
              createdBy: by(),
            },
          });
          await tx.buildingOperatorPeriod.create({
            data: {
              tenantId: ctx.tenantId,
              buildingId: b.id,
              ownerTenantId: ctx.tenantId,
              operatorTenantId: ctx.tenantId,
              validFrom: b.createdAt,
              reason: 'initial',
              createdBy: by(),
            },
          });
          await this.events.record(tx, {
            type: 'building.changed',
            aggregateType: 'building',
            aggregateId: b.id,
            tenantId: ctx.tenantId,
            buildingId: b.id,
            payload: { buildingId: b.id, change: 'created' },
          });
          return b;
        }),
      duplicate('building code'),
    );
  }

  updateBuilding(
    ctx: TenantContext,
    id: string,
    version: number,
    patch: {
      name?: string;
      type?: BuildingType;
      floorsCount?: number;
      address?: Prisma.InputJsonValue | null;
      status?: 'active' | 'inactive';
    },
  ) {
    return this.db.tenant(ctx, async (tx) => {
      const current = await operatedBuilding(tx, ctx, id);
      if (current.version !== version) throw new DomainException('concurrency.stale');
      const b = await tx.building.update({
        where: { id },
        data: {
          ...patch,
          address: patch.address === null ? undefined : patch.address,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.events.record(tx, {
        type: 'building.changed',
        aggregateType: 'building',
        aggregateId: id,
        tenantId: current.tenantId,
        buildingId: id,
        payload: { buildingId: id, change: 'updated', fields: Object.keys(patch) },
      });
      return b;
    });
  }

  getBuilding(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => visibleBuilding(tx, ctx, id));
  }

  async getBuildingWithCount(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const building = await visibleBuilding(tx, ctx, id);
      const unitCount = await tx.unit.count({ where: { buildingId: id, deletedAt: null } });
      return { building, unitCount };
    });
  }

  /** Visible buildings (own, owned/operated, granted) with unit counts; Staff limited to their buildings. */
  listBuildings(ctx: TenantContext, propertyId?: string) {
    return this.db.tenant(ctx, async (tx) => {
      const buildings = await tx.building.findMany({
        where: {
          deletedAt: null,
          ...(propertyId ? { propertyId } : {}),
          ...(ctx.buildingIds ? { id: { in: [...ctx.buildingIds] } } : {}),
        },
        orderBy: [{ createdAt: 'asc' }],
      });
      const counts = await tx.unit.groupBy({
        by: ['buildingId'],
        where: { buildingId: { in: buildings.map((b) => b.id) }, deletedAt: null },
        _count: { _all: true },
      });
      const byBuilding = new Map(counts.map((c) => [c.buildingId, c._count._all]));
      return buildings.map((b) => ({ building: b, unitCount: byBuilding.get(b.id) ?? 0 }));
    });
  }

  createFloor(
    ctx: TenantContext,
    buildingId: string,
    input: { level: number; name: string; sortOrder?: number },
  ) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const b = await operatedBuilding(tx, ctx, buildingId);
          const f = await tx.floor.create({
            data: {
              tenantId: b.tenantId,
              buildingId: b.id,
              level: input.level,
              name: input.name,
              sortOrder: input.sortOrder ?? input.level,
              createdBy: by(),
            },
          });
          await this.events.record(tx, {
            type: 'floor.changed',
            aggregateType: 'floor',
            aggregateId: f.id,
            tenantId: b.tenantId,
            buildingId: b.id,
            payload: { floorId: f.id, change: 'created' },
          });
          return f;
        }),
      duplicate('floor level'),
    );
  }

  updateFloor(
    ctx: TenantContext,
    buildingId: string,
    floorId: string,
    patch: { level?: number; name?: string; sortOrder?: number },
  ) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const b = await operatedBuilding(tx, ctx, buildingId);
          this.found(await tx.floor.findFirst({ where: { id: floorId, buildingId: b.id, deletedAt: null } }));
          const f = await tx.floor.update({ where: { id: floorId }, data: { ...patch, updatedBy: by() } });
          await this.events.record(tx, {
            type: 'floor.changed',
            aggregateType: 'floor',
            aggregateId: f.id,
            tenantId: b.tenantId,
            buildingId: b.id,
            payload: { floorId: f.id, change: 'updated', fields: Object.keys(patch) },
          });
          return f;
        }),
      duplicate('floor level'),
    );
  }

  /** Floors with their unit counts (grants never widen floors: they follow the building). */
  listFloors(ctx: TenantContext, buildingId: string) {
    return this.db.tenant(ctx, async (tx) => {
      const b = await visibleBuilding(tx, ctx, buildingId);
      const floors = await tx.floor.findMany({
        where: { buildingId: b.id, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { level: 'asc' }],
      });
      const counts = await tx.unit.groupBy({
        by: ['floorId'],
        where: { buildingId: b.id, deletedAt: null },
        _count: { _all: true },
      });
      const byFloor = new Map(counts.map((c) => [c.floorId, c._count._all]));
      return floors.map((f) => ({ floor: f, unitCount: byFloor.get(f.id) ?? 0 }));
    });
  }
}

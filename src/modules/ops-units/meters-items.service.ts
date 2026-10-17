import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { mapConflicts } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type AssetCategory,
  type Building,
  type MeterPurpose,
  type Prisma,
  type Unit,
  type Utility,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { operatedBuilding, operatedUnit, visibleBuilding, visibleUnit } from './building-access';

const by = () => userIdOf(RequestContext.actor());
const meterTaken = () => new DomainException('meter.already_assigned');

export interface MeterInput {
  utility: Utility;
  code?: string;
  name?: string;
  serial?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  initialReading?: string;
  multiplier?: string;
}

export const METER_INCLUDE = {
  assetItem: {
    select: { id: true, name: true, serial: true, manufacturer: true, model: true, status: true },
  },
  unit: { select: { id: true, unitNo: true } },
} as const satisfies Prisma.MeterAssignmentInclude;
export type MeterRow = Prisma.MeterAssignmentGetPayload<{ include: typeof METER_INCLUDE }>;

const CATEGORY: Record<Utility, AssetCategory> = { electric: 'meter_electric', water: 'meter_water' };
const LABEL_TH: Record<Utility, string> = { electric: 'มิเตอร์ไฟฟ้า', water: 'มิเตอร์น้ำ' };
const SUFFIX: Record<Utility, string> = { electric: 'E', water: 'W' };

/**
 * Meter positions (B2.1): one meter `asset_item` per unit and utility with its `meter_assignment` (initial reading,
 * multiplier) — manual meters for Lite buildings (D-012); IoT devices bind to the same asset items in B3.1. Common
 * area and main meters carry `purpose` and a label. Two active meters for one unit and utility are refused by the
 * exclusion constraint (409 `meter.already_assigned`).
 */
@Injectable()
export class MetersService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async insert(
    tx: Tx,
    building: Building,
    unit: Unit | null,
    purpose: MeterPurpose,
    input: MeterInput & { commonAreaLabel?: string | null },
  ): Promise<MeterRow> {
    const now = this.clock.now();
    const code = input.code ?? (unit ? `${unit.unitNo}-${SUFFIX[input.utility]}` : '');
    if (!code)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'code', code: 'required', message: 'a code is required for common-area and main meters' },
        ],
      });
    const item = await tx.assetItem.create({
      data: {
        tenantId: building.tenantId,
        buildingId: building.id,
        floorId: unit?.floorId ?? null,
        unitId: unit?.id ?? null,
        category: CATEGORY[input.utility],
        name: input.name ?? `${LABEL_TH[input.utility]} ${unit?.unitNo ?? input.commonAreaLabel ?? code}`,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        serial: input.serial ?? null,
        meta: { reading: 'manual' },
        createdBy: by(),
      },
    });
    const assignment = await tx.meterAssignment.create({
      data: {
        tenantId: building.tenantId,
        buildingId: building.id,
        assetItemId: item.id,
        unitId: unit?.id ?? null,
        purpose,
        utility: input.utility,
        code,
        commonAreaLabel: input.commonAreaLabel ?? null,
        validFrom: now,
        multiplier: input.multiplier ?? '1',
        initialReading: input.initialReading ?? '0',
        createdBy: by(),
      },
      include: METER_INCLUDE,
    });
    await this.events.record(tx, {
      type: 'meter_assignment.changed',
      aggregateType: 'meter_assignment',
      aggregateId: assignment.id,
      tenantId: building.tenantId,
      buildingId: building.id,
      payload: {
        meterAssignmentId: assignment.id,
        assetItemId: item.id,
        unitId: unit?.id ?? null,
        utility: input.utility,
        purpose,
        change: 'opened',
      },
    });
    return assignment;
  }

  createForUnit(ctx: TenantContext, unitId: string, input: MeterInput) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const { unit, building } = await operatedUnit(tx, ctx, unitId);
          return this.insert(tx, building, unit, 'unit', input);
        }),
      meterTaken,
    );
  }

  createCommon(
    ctx: TenantContext,
    buildingId: string,
    input: MeterInput & { purpose: 'common_area' | 'main'; code: string; commonAreaLabel?: string | null },
  ) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const building = await operatedBuilding(tx, ctx, buildingId);
          return this.insert(tx, building, null, input.purpose, input);
        }),
      meterTaken,
    );
  }

  /** One manual meter per unit and utility for every unit of the building that has none yet. */
  createMissing(
    ctx: TenantContext,
    buildingId: string,
    input: { utilities: Utility[]; initialReading?: string },
  ) {
    return mapConflicts(
      () =>
        this.db.tenant(
          ctx,
          async (tx) => {
            const building = await operatedBuilding(tx, ctx, buildingId);
            const units = await tx.unit.findMany({
              where: { buildingId: building.id, deletedAt: null },
              orderBy: { unitNo: 'asc' },
            });
            const active = await tx.meterAssignment.findMany({
              where: { buildingId: building.id, purpose: 'unit', validTo: null },
              select: { unitId: true, utility: true },
            });
            const has = new Set(active.map((a) => `${a.unitId}|${a.utility}`));
            const created: MeterRow[] = [];
            for (const unit of units)
              for (const utility of [...new Set(input.utilities)])
                if (!has.has(`${unit.id}|${utility}`))
                  created.push(
                    await this.insert(tx, building, unit, 'unit', {
                      utility,
                      initialReading: input.initialReading,
                    }),
                  );
            return created;
          },
          { timeout: 60_000 },
        ),
      meterTaken,
    );
  }

  /** Active meter assignments of a building (unit, common-area and main). */
  listForBuilding(ctx: TenantContext, buildingId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await visibleBuilding(tx, ctx, buildingId);
      return tx.meterAssignment.findMany({
        where: { buildingId, validTo: null },
        include: METER_INCLUDE,
        orderBy: [{ purpose: 'asc' }, { code: 'asc' }],
      });
    });
  }

  listForUnit(ctx: TenantContext, unitId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await visibleUnit(tx, ctx, unitId);
      return tx.meterAssignment.findMany({
        where: { unitId },
        include: METER_INCLUDE,
        orderBy: [{ utility: 'asc' }, { validFrom: 'desc' }],
      });
    });
  }
}

export const AMENITY_CATEGORIES = [
  'appliance',
  'furniture',
  'hvac',
  'other',
] as const satisfies readonly AssetCategory[];
export type AmenityCategory = (typeof AMENITY_CATEGORIES)[number];

export interface AmenityInput {
  category: AmenityCategory;
  name: string;
  manufacturer?: string | null;
  model?: string | null;
  serial?: string | null;
  location?: string | null;
  installDate?: string | null;
  warrantyUntil?: string | null;
}

/**
 * Appliances and furniture of a unit as `core.asset_item`s (v1 amenities, schema-design §7.4): listed on the
 * contract annex (ข้อ 4 (1) ทรัพย์สินและอุปกรณ์) and checked at move-in/move-out inspections (B2.4).
 */
@Injectable()
export class AmenitiesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  list(ctx: TenantContext, unitId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await visibleUnit(tx, ctx, unitId);
      return tx.assetItem.findMany({
        where: { unitId, deletedAt: null, category: { in: [...AMENITY_CATEGORIES] } },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });
    });
  }

  create(ctx: TenantContext, unitId: string, input: AmenityInput) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const { unit, building } = await operatedUnit(tx, ctx, unitId);
          const item = await tx.assetItem.create({
            data: {
              tenantId: building.tenantId,
              buildingId: building.id,
              floorId: unit.floorId,
              unitId: unit.id,
              category: input.category,
              name: input.name,
              manufacturer: input.manufacturer ?? null,
              model: input.model ?? null,
              serial: input.serial ?? null,
              location: input.location ?? null,
              installDate: input.installDate ? new Date(input.installDate) : null,
              warrantyUntil: input.warrantyUntil ? new Date(input.warrantyUntil) : null,
              createdBy: by(),
            },
          });
          await this.changed(tx, item.id, building.tenantId, building.id, 'created');
          return item;
        }),
      () => new DomainException('asset.duplicate', { params: { what: 'serial number' } }),
    );
  }

  update(ctx: TenantContext, id: string, patch: Partial<AmenityInput>) {
    return this.db.tenant(ctx, async (tx) => {
      const current = this.found(
        await tx.assetItem.findFirst({
          where: { id, deletedAt: null, category: { in: [...AMENITY_CATEGORIES] } },
        }),
      );
      if (!current.unitId) throw new DomainException('http.not_found');
      await operatedUnit(tx, ctx, current.unitId);
      const item = await tx.assetItem.update({
        where: { id },
        data: {
          ...(patch.category !== undefined ? { category: patch.category } : {}),
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.manufacturer !== undefined ? { manufacturer: patch.manufacturer } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.serial !== undefined ? { serial: patch.serial } : {}),
          ...(patch.location !== undefined ? { location: patch.location } : {}),
          ...(patch.installDate !== undefined
            ? { installDate: patch.installDate ? new Date(patch.installDate) : null }
            : {}),
          ...(patch.warrantyUntil !== undefined
            ? { warrantyUntil: patch.warrantyUntil ? new Date(patch.warrantyUntil) : null }
            : {}),
          updatedBy: by(),
        },
      });
      await this.changed(tx, id, current.tenantId, current.buildingId, 'updated');
      return item;
    });
  }

  /** Retires the item (kept for inspection history). */
  retire(ctx: TenantContext, id: string, reason: string) {
    return this.db.tenant(ctx, async (tx) => {
      const current = this.found(
        await tx.assetItem.findFirst({
          where: { id, deletedAt: null, category: { in: [...AMENITY_CATEGORIES] } },
        }),
      );
      if (!current.unitId) throw new DomainException('http.not_found');
      await operatedUnit(tx, ctx, current.unitId);
      const now = this.clock.now();
      await tx.assetItem.update({
        where: { id },
        data: { status: 'retired', retiredAt: now, retiredReason: reason, deletedAt: now, deletedBy: by() },
      });
      await this.changed(tx, id, current.tenantId, current.buildingId, 'retired');
    });
  }

  private changed(tx: Tx, id: string, tenantId: string, buildingId: string, change: string) {
    return this.events.record(tx, {
      type: 'asset_item.changed',
      aggregateType: 'asset_item',
      aggregateId: id,
      tenantId,
      buildingId,
      payload: { assetItemId: id, change },
    });
  }
}

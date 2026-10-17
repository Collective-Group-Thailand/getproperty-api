import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { mapConflicts } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Building,
  type OwnershipSource,
  type Prisma,
  type Unit,
  type UnitStatus,
  type UnitType,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { operatedBuilding, operatedUnit, visibleUnit } from './building-access';
import { BILLABLE_STATUSES, canSetStatusManually, expandUnitNo, patternProblems } from './unit-rules';

const by = () => userIdOf(RequestContext.actor());

export interface UnitInput {
  floorId?: string | null;
  unitNo: string;
  type?: UnitType;
  areaSqm?: string | null;
  baseRent?: string | null;
  unitProfileId?: string | null;
  notes?: string | null;
}

export interface UnitListQuery {
  buildingId?: string;
  floorId?: string;
  status?: UnitStatus;
  q?: string;
  skip: number;
  take: number;
  sort: 'unitNo' | 'createdAt' | 'status';
  order: 'asc' | 'desc';
}

export const UNIT_INCLUDE = {
  floor: { select: { id: true, level: true, name: true } },
  unitDetailUnit: { include: { profile: { select: { id: true, name: true } } } },
} as const satisfies Prisma.UnitInclude;

export type UnitRow = Prisma.UnitGetPayload<{ include: typeof UNIT_INCLUDE }>;

/**
 * Units of the owner console (B2.1): create one or many (floor × pattern), edit, list with filters, read, the
 * manual status override (`vacant ↔ inactive | maintenance` with a reason, audited) and the unit count used by
 * subscriptions (D-082, D-156). Every unit gets its `ops.unit_detail` row; in a building the tenant owns, the
 * tenant's own legal party becomes the owner of the unit (`core.unit_ownership`, 100 %) — the blueprint rule for
 * apartments. Leases (B2.3) and service work (B5) drive the other status changes.
 */
@Injectable()
export class UnitsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** Inserts a unit + its detail (+ ownership by the tenant's legal party) inside the caller's transaction. */
  async insertUnit(
    tx: Tx,
    ctx: TenantContext,
    building: Building,
    input: UnitInput,
    source: OwnershipSource = 'manual',
  ): Promise<Unit> {
    if (input.floorId)
      this.found(
        await tx.floor.findFirst({ where: { id: input.floorId, buildingId: building.id, deletedAt: null } }),
      );
    const profile = input.unitProfileId
      ? this.found(
          await tx.unitProfile.findFirst({
            where: { id: input.unitProfileId, buildingId: building.id, deletedAt: null },
          }),
        )
      : null;
    const now = this.clock.now();
    const unit = await tx.unit.create({
      data: {
        tenantId: building.tenantId,
        buildingId: building.id,
        propertyId: building.propertyId,
        floorId: input.floorId ?? null,
        unitNo: input.unitNo.trim(),
        type: input.type ?? 'room',
        areaSqm: input.areaSqm ?? profile?.areaSqm ?? null,
        baseRent: input.baseRent ?? profile?.defaultRent ?? null,
        statusChangedAt: now,
        createdBy: by(),
      },
    });
    await tx.unitDetail.create({
      data: {
        unitId: unit.id,
        tenantId: building.tenantId,
        buildingId: building.id,
        unitProfileId: profile?.id ?? null,
        notes: input.notes ?? null,
        createdBy: by(),
      },
    });
    if (building.ownerTenantId === ctx.tenantId) {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { legalPartyId: true },
      });
      if (tenant?.legalPartyId)
        await tx.unitOwnership.create({
          data: {
            tenantId: building.tenantId,
            buildingId: building.id,
            unitId: unit.id,
            partyId: tenant.legalPartyId,
            sharePct: '100',
            validFrom: new Date(bangkokDate(now)),
            source,
            createdBy: by(),
          },
        });
    }
    await this.events.record(tx, {
      type: 'unit.changed',
      aggregateType: 'unit',
      aggregateId: unit.id,
      tenantId: building.tenantId,
      buildingId: building.id,
      payload: { unitId: unit.id, change: 'created', unitNo: unit.unitNo },
    });
    return unit;
  }

  create(ctx: TenantContext, buildingId: string, input: UnitInput) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const building = await operatedBuilding(tx, ctx, buildingId);
          const unit = await this.insertUnit(tx, ctx, building, input);
          return this.load(tx, unit.id);
        }),
      () => new DomainException('asset.duplicate', { params: { what: 'unit number' } }),
    );
  }

  /**
   * Bulk creation: for each floor, `count` units numbered by `pattern` (`{building}-{floor}{nn}` → `A-201`),
   * starting at `start`. All or nothing; an existing number is a 409 naming the first clash.
   */
  bulkCreate(
    ctx: TenantContext,
    buildingId: string,
    input: {
      floorIds: string[];
      countPerFloor: number;
      pattern: string;
      start?: number;
      type?: UnitType;
      unitProfileId?: string | null;
      baseRent?: string | null;
      areaSqm?: string | null;
    },
  ) {
    const problems = patternProblems(input.pattern);
    if (problems.length)
      throw new DomainException('validation.failed', {
        errors: problems.map((message) => ({ path: 'pattern', code: 'unitNoPattern', message })),
      });
    return this.db.tenant(
      ctx,
      async (tx) => {
        const building = await operatedBuilding(tx, ctx, buildingId);
        const floors = await tx.floor.findMany({
          where: { id: { in: input.floorIds }, buildingId: building.id, deletedAt: null },
          orderBy: { level: 'asc' },
        });
        if (floors.length !== new Set(input.floorIds).size) throw new DomainException('http.not_found');
        const planned = floors.flatMap((floor) =>
          Array.from({ length: input.countPerFloor }, (_, i) => ({
            floorId: floor.id,
            unitNo: expandUnitNo(input.pattern, {
              building: building.code,
              floor: floor.level,
              seq: (input.start ?? 1) + i,
            }),
          })),
        );
        const numbers = planned.map((p) => p.unitNo);
        const dupInPlan = numbers.find((n, i) => numbers.indexOf(n) !== i);
        const existing = await tx.unit.findFirst({
          where: { buildingId: building.id, deletedAt: null, unitNo: { in: numbers } },
          select: { unitNo: true },
        });
        const clash = dupInPlan ?? existing?.unitNo;
        if (clash) throw new DomainException('asset.duplicate', { params: { what: `unit number ${clash}` } });
        const created: Unit[] = [];
        for (const p of planned)
          created.push(
            await this.insertUnit(tx, ctx, building, {
              floorId: p.floorId,
              unitNo: p.unitNo,
              type: input.type,
              unitProfileId: input.unitProfileId,
              baseRent: input.baseRent,
              areaSqm: input.areaSqm,
            }),
          );
        await this.audit.record(tx, {
          action: 'unit.bulk_created',
          tenantId: building.tenantId,
          buildingId: building.id,
          subjectType: 'core.building',
          subjectId: building.id,
          metadata: { count: created.length, pattern: input.pattern, floors: floors.map((f) => f.level) },
        });
        return tx.unit.findMany({
          where: { id: { in: created.map((u) => u.id) } },
          include: UNIT_INCLUDE,
          orderBy: { unitNo: 'asc' },
        });
      },
      { timeout: 60_000 },
    );
  }

  update(
    ctx: TenantContext,
    id: string,
    version: number,
    patch: Partial<Omit<UnitInput, 'unitNo'>> & { unitNo?: string },
  ) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const { unit, building } = await operatedUnit(tx, ctx, id);
          if (unit.version !== version) throw new DomainException('concurrency.stale');
          if (patch.floorId)
            this.found(
              await tx.floor.findFirst({
                where: { id: patch.floorId, buildingId: building.id, deletedAt: null },
              }),
            );
          if (patch.unitProfileId)
            this.found(
              await tx.unitProfile.findFirst({
                where: { id: patch.unitProfileId, buildingId: building.id, deletedAt: null },
              }),
            );
          await tx.unit.update({
            where: { id },
            data: {
              ...(patch.unitNo !== undefined ? { unitNo: patch.unitNo.trim() } : {}),
              ...(patch.floorId !== undefined ? { floorId: patch.floorId } : {}),
              ...(patch.type !== undefined ? { type: patch.type } : {}),
              ...(patch.areaSqm !== undefined ? { areaSqm: patch.areaSqm } : {}),
              ...(patch.baseRent !== undefined ? { baseRent: patch.baseRent } : {}),
              updatedBy: by(),
              version: { increment: 1 },
            },
          });
          if (patch.unitProfileId !== undefined || patch.notes !== undefined)
            await tx.unitDetail.update({
              where: { unitId: id },
              data: {
                ...(patch.unitProfileId !== undefined ? { unitProfileId: patch.unitProfileId } : {}),
                ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
                updatedBy: by(),
                version: { increment: 1 },
              },
            });
          await this.events.record(tx, {
            type: 'unit.changed',
            aggregateType: 'unit',
            aggregateId: id,
            tenantId: unit.tenantId,
            buildingId: unit.buildingId,
            payload: { unitId: id, change: 'updated', fields: Object.keys(patch) },
          });
          return this.load(tx, id);
        }),
      () => new DomainException('asset.duplicate', { params: { what: 'unit number' } }),
    );
  }

  /** Manual override (B2.1 §3): only `vacant ↔ inactive | maintenance`, with a reason; audited. */
  setStatus(ctx: TenantContext, id: string, input: { status: UnitStatus; reason: string; version?: number }) {
    return this.db.tenant(ctx, async (tx) => {
      const { unit } = await operatedUnit(tx, ctx, id);
      if (input.version !== undefined && unit.version !== input.version)
        throw new DomainException('concurrency.stale');
      if (!canSetStatusManually(unit.status, input.status))
        throw new DomainException('unit.invalid_status_transition', {
          params: { from: unit.status, to: input.status },
        });
      await tx.unit.update({
        where: { id },
        data: {
          status: input.status,
          statusChangedAt: this.clock.now(),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await tx.unitDetail.update({
        where: { unitId: id },
        data: { statusReason: input.reason, updatedBy: by(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'unit.status_changed',
        tenantId: unit.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'core.unit',
        subjectId: id,
        before: { status: unit.status },
        after: { status: input.status },
        metadata: { reason: input.reason, manual: true },
      });
      await this.events.record(tx, {
        type: 'unit.changed',
        aggregateType: 'unit',
        aggregateId: id,
        tenantId: unit.tenantId,
        buildingId: unit.buildingId,
        payload: { unitId: id, change: 'status', from: unit.status, status: input.status },
      });
      return this.load(tx, id);
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      await visibleUnit(tx, ctx, id);
      return this.load(tx, id);
    });
  }

  private async load(tx: Tx, id: string): Promise<UnitRow> {
    return this.found(await tx.unit.findFirst({ where: { id, deletedAt: null }, include: UNIT_INCLUDE }));
  }

  /** Units visible to the tenant (RLS: own, owned/operated buildings, building and unit grants). */
  list(ctx: TenantContext, query: UnitListQuery) {
    return this.db.tenant(ctx, async (tx) => {
      if (query.buildingId && ctx.buildingIds && !ctx.buildingIds.includes(query.buildingId))
        throw new DomainException('http.not_found');
      const where: Prisma.UnitWhereInput = {
        deletedAt: null,
        ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        ...(query.buildingId ? { buildingId: query.buildingId } : {}),
        ...(query.floorId ? { floorId: query.floorId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.q ? { unitNo: { contains: query.q, mode: 'insensitive' } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.unit.findMany({
          where,
          include: UNIT_INCLUDE,
          orderBy: [{ [query.sort]: query.order }, { id: 'asc' }],
          skip: query.skip,
          take: query.take,
        }),
        tx.unit.count({ where }),
      ]);
      return { rows, total };
    });
  }

  /**
   * Unit count for subscriptions (D-082, D-156): units of the tenant whose status is not `inactive` (soft-deleted
   * units excluded), by status. B6.1 snapshots it on the 1st of each month.
   */
  count(ctx: TenantContext) {
    return this.db.tenant(ctx, async (tx) => {
      const rows = await tx.unit.groupBy({
        by: ['status'],
        where: { tenantId: ctx.tenantId, deletedAt: null },
        _count: { _all: true },
      });
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Partial<
        Record<UnitStatus, number>
      >;
      const billable = BILLABLE_STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
      return { billable, inactive: byStatus.inactive ?? 0, byStatus, countedAt: this.clock.now() };
    });
  }
}

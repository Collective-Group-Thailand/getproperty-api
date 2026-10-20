import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type MaintenancePlan, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { ServiceCategoriesService } from './service-categories.service';
import { ACTIVE_WORK_ORDER_STATUSES, nextDueOn, planDue } from './service-rules';
import { WorkOrdersService } from './work-orders.service';

export interface MaintenancePlanInput {
  assetItemId: string;
  categoryId?: string | null;
  title: string;
  description?: string | null;
  intervalDays: number;
  leadDays?: number;
  nextDueOn: string;
  assigneeUserId?: string | null;
  assigneePartyId?: string | null;
}

export const MAINTENANCE_PLAN_INCLUDE = {
  assetItem: { select: { id: true, name: true, category: true, unitId: true } },
  lastWorkOrder: { select: { id: true, status: true, scheduledAt: true } },
} satisfies Prisma.MaintenancePlanInclude;
export type MaintenancePlanRow = Prisma.MaintenancePlanGetPayload<{
  include: typeof MAINTENANCE_PLAN_INCLUDE;
}>;

const by = () => userIdOf(RequestContext.actor());
/** Preventive visits are planned for 09:00 Asia/Bangkok of the due day. */
const VISIT_HOUR_MS = 9 * 3_600_000;

/**
 * Preventive maintenance (B5.1) of `core.asset_item`s — pumps, lifts, air conditioners, generators, locks: a plan
 * repeats every `interval_days`; the daily worker job opens a `preventive` work order `lead_days` before the due date
 * (assigned to the plan's staff member or technician when set) and moves the due date one interval on. A plan whose
 * previous work order is still open waits for it (no pile of duplicates).
 */
@Injectable()
export class MaintenancePlansService extends TenantScopedRepository {
  private readonly logger = new Logger(MaintenancePlansService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly workOrders: WorkOrdersService,
    private readonly categories: ServiceCategoriesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  list(ctx: TenantContext, f: { buildingId?: string; assetItemId?: string }): Promise<MaintenancePlanRow[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.maintenancePlan.findMany({
        where: this.own(ctx, {
          ...(f.buildingId ? { buildingId: f.buildingId } : {}),
          ...(f.assetItemId ? { assetItemId: f.assetItemId } : {}),
          ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}),
        }),
        include: MAINTENANCE_PLAN_INCLUDE,
        orderBy: [{ nextDueOn: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  async get(ctx: TenantContext, id: string): Promise<MaintenancePlanRow> {
    return this.found(
      await this.db.tenant(ctx, (tx) =>
        tx.maintenancePlan.findFirst({
          where: this.own(ctx, { id, ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}) }),
          include: MAINTENANCE_PLAN_INCLUDE,
        }),
      ),
    );
  }

  async create(ctx: TenantContext, input: MaintenancePlanInput): Promise<MaintenancePlanRow> {
    if (input.assigneeUserId && input.assigneePartyId)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'assigneeUserId', code: 'exactlyOne', message: 'one assignee at most' }],
      });
    const id = await this.db.tenant(ctx, async (tx) => {
      const item = this.found(
        await tx.assetItem.findFirst({ where: { id: input.assetItemId, deletedAt: null, retiredAt: null } }),
      );
      const building = await tx.building.findFirst({
        where: {
          id: item.buildingId,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        },
      });
      if (!building || (ctx.buildingIds && !ctx.buildingIds.includes(item.buildingId)))
        throw new DomainException('http.not_found');
      const category = input.categoryId
        ? await this.categories.resolve(tx, ctx.tenantId, input.categoryId)
        : null;
      const plan = await tx.maintenancePlan.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: item.buildingId,
          assetItemId: item.id,
          categoryId: category?.id ?? null,
          title: input.title.trim(),
          description: input.description ?? null,
          intervalDays: input.intervalDays,
          leadDays: input.leadDays ?? 7,
          nextDueOn: new Date(`${input.nextDueOn}T00:00:00Z`),
          assigneeUserId: input.assigneeUserId ?? null,
          assigneePartyId: input.assigneePartyId ?? null,
          createdBy: by(),
        },
      });
      return plan.id;
    });
    return this.get(ctx, id);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: Partial<Omit<MaintenancePlanInput, 'assetItemId'>> & { isActive?: boolean },
    ifMatchVersion?: number,
  ): Promise<MaintenancePlanRow> {
    await this.db.tenant(ctx, async (tx) => {
      const plan = this.found(await tx.maintenancePlan.findFirst({ where: this.own(ctx, { id }) }));
      if (ifMatchVersion !== undefined && plan.version !== ifMatchVersion)
        throw new DomainException('concurrency.stale');
      const category = input.categoryId
        ? await this.categories.resolve(tx, ctx.tenantId, input.categoryId)
        : null;
      await tx.maintenancePlan.update({
        where: { id: plan.id },
        data: {
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.intervalDays !== undefined ? { intervalDays: input.intervalDays } : {}),
          ...(input.leadDays !== undefined ? { leadDays: input.leadDays } : {}),
          ...(input.nextDueOn !== undefined ? { nextDueOn: new Date(`${input.nextDueOn}T00:00:00Z`) } : {}),
          ...(category ? { categoryId: category.id } : {}),
          ...(input.assigneeUserId !== undefined || input.assigneePartyId !== undefined
            ? { assigneeUserId: input.assigneeUserId ?? null, assigneePartyId: input.assigneePartyId ?? null }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
    });
    return this.get(ctx, id);
  }

  /** Daily worker job: opens the preventive work orders that are due (lead days before the due date). */
  async sweep(): Promise<{ opened: number }> {
    const today = bangkokDate(this.clock.now());
    const plans = await this.db.platform((tx) =>
      tx.maintenancePlan.findMany({
        where: { isActive: true, nextDueOn: { lte: new Date(`${addDays(today, 90)}T00:00:00Z`) } },
        orderBy: { nextDueOn: 'asc' },
        take: 500,
      }),
    );
    let opened = 0;
    for (const plan of plans) {
      const due = plan.nextDueOn.toISOString().slice(0, 10);
      if (!planDue(due, plan.leadDays, today)) continue;
      try {
        if (await this.openFor(plan, due)) opened += 1;
      } catch (error) {
        this.logger.warn({
          event: 'maintenance_plan_failed',
          planId: plan.id,
          error: (error as Error).message,
        });
      }
    }
    if (opened) this.logger.log({ event: 'maintenance_plans', opened }, 'preventive work orders opened');
    return { opened };
  }

  private openFor(plan: MaintenancePlan, due: string): Promise<boolean> {
    const ctx = systemTenantContext(plan.tenantId);
    return RequestContext.run({ actor: systemActor('maintenance-plans') }, () =>
      this.db.tenant(ctx, async (tx) => {
        const fresh = await tx.maintenancePlan.findUniqueOrThrow({ where: { id: plan.id } });
        if (fresh.version !== plan.version || !fresh.isActive) return false;
        const active = await tx.workOrder.count({
          where: { maintenancePlanId: plan.id, status: { in: [...ACTIVE_WORK_ORDER_STATUSES] } },
        });
        if (active) return false;
        const wo = await this.workOrders.createIn(tx, ctx, {
          kind: 'preventive',
          assetItemId: plan.assetItemId,
          maintenancePlanId: plan.id,
          title: plan.title,
          description: plan.description,
          scheduledAt: new Date(startOfBangkokDay(due).getTime() + VISIT_HOUR_MS),
          assigneeUserId: plan.assigneeUserId,
          assigneePartyId: plan.assigneePartyId,
        });
        await tx.maintenancePlan.update({
          where: { id: plan.id },
          data: {
            lastWorkOrderId: wo.id,
            nextDueOn: new Date(`${nextDueOn(due, plan.intervalDays)}T00:00:00Z`),
            version: { increment: 1 },
          },
        });
        return true;
      }),
    );
  }
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

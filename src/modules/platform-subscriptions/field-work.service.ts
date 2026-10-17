import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type InstallOrderKind, type InstallOrderState, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

/** One line of an install order (per unit; `deviceKind` is the device to place, `done` when the field engineer finished it). */
export interface InstallItem {
  unitId: string | null;
  assetItemId: string | null;
  /** `gateway`, `electric_meter` or `water_meter`. */
  deviceKind: string;
  deviceId: string | null;
  haasAssetId?: string | null;
  done: boolean;
}

export const INSTALL_ORDER_INCLUDE = {
  building: { select: { id: true, code: true, name: true } },
  tenant: { select: { id: true, displayName: true } },
} as const satisfies Prisma.InstallOrderInclude;
export type InstallOrderRow = Prisma.InstallOrderGetPayload<{ include: typeof INSTALL_ORDER_INCLUDE }>;

const by = () => userIdOf(RequestContext.actor());
const ORDER_NEXT: Record<InstallOrderState, InstallOrderState[]> = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

/**
 * Platform field work (B6.1, D-081, D-156): install / de-install / replace orders per building for Collective's field
 * engineers (items per unit: gateway, meter devices), and the site surveys an owner asks for when upgrading Starter →
 * Smart. A completed survey that recommends installation opens the install order of the building (one meter device
 * per unit and utility without a channel, one gateway). Tenant staff read the orders of their buildings
 * (`GET /v1/staff/install-orders`).
 */
@Injectable()
export class FieldWorkService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------- install orders

  listOrders(filter: {
    tenantId?: string;
    state?: InstallOrderState;
    kind?: InstallOrderKind;
    skip: number;
    take: number;
  }) {
    const where: Prisma.InstallOrderWhereInput = {
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.installOrder.findMany({
        where,
        include: INSTALL_ORDER_INCLUDE,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.installOrder.count({ where }),
    }));
  }

  /** Staff of the tenant: open and in-progress orders of my buildings (D-090 building limit), read-only. */
  forStaff(ctx: TenantContext) {
    return this.db.tenant(ctx, async (tx) => {
      const orders = await tx.installOrder.findMany({
        where: {
          tenantId: ctx.tenantId,
          state: { in: ['open', 'in_progress'] },
          ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        },
        include: INSTALL_ORDER_INCLUDE,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      });
      const unitIds = [
        ...new Set(
          orders.flatMap((o) => (o.items as unknown as InstallItem[]).map((i) => i.unitId).filter(Boolean)),
        ),
      ] as string[];
      const units = new Map(
        (await tx.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, unitNo: true } })).map(
          (u) => [u.id, u.unitNo],
        ),
      );
      return { orders, units };
    });
  }

  getOrder(id: string) {
    return this.db.platform(async (tx) => {
      const o = await tx.installOrder.findUnique({ where: { id }, include: INSTALL_ORDER_INCLUDE });
      if (!o) throw new DomainException('http.not_found');
      return o;
    });
  }

  createOrder(input: {
    tenantId: string;
    buildingId: string;
    kind: InstallOrderKind;
    items: InstallItem[];
    dueAt?: Date | null;
    notes?: string | null;
  }) {
    return this.db.platform(async (tx) => {
      const building = await tx.building.findFirst({
        where: {
          id: input.buildingId,
          deletedAt: null,
          OR: [{ ownerTenantId: input.tenantId }, { operatorTenantId: input.tenantId }],
        },
      });
      if (!building) throw new DomainException('http.not_found');
      const sub = await tx.subscription.findFirst({
        where: { tenantId: input.tenantId, state: { in: ['trial', 'active', 'past_due', 'suspended'] } },
      });
      return this.insertOrder(tx, {
        tenantId: input.tenantId,
        buildingId: input.buildingId,
        kind: input.kind,
        subscriptionId: sub?.id ?? null,
        items: input.items,
        dueAt: input.dueAt ?? null,
        notes: input.notes ?? null,
      });
    });
  }

  private async insertOrder(
    tx: Tx,
    input: {
      tenantId: string;
      buildingId: string;
      kind: InstallOrderKind;
      subscriptionId: string | null;
      siteSurveyRequestId?: string | null;
      items: InstallItem[];
      dueAt: Date | null;
      notes: string | null;
    },
  ) {
    const order = await tx.installOrder.create({
      data: {
        tenantId: input.tenantId,
        buildingId: input.buildingId,
        kind: input.kind,
        subscriptionId: input.subscriptionId,
        siteSurveyRequestId: input.siteSurveyRequestId ?? null,
        items: input.items as unknown as Prisma.InputJsonValue,
        dueAt: input.dueAt,
        notes: input.notes,
        createdBy: by(),
      },
    });
    await this.audit.record(tx, {
      action: 'install_order.created',
      tenantId: input.tenantId,
      buildingId: input.buildingId,
      subjectType: 'platform.install_order',
      subjectId: order.id,
      after: { kind: input.kind, items: input.items.length },
    });
    await this.events.record(tx, {
      type: 'install_order.created',
      aggregateType: 'install_order',
      aggregateId: order.id,
      tenantId: input.tenantId,
      buildingId: input.buildingId,
      payload: { installOrderId: order.id, kind: input.kind },
    });
    return tx.installOrder.findUniqueOrThrow({ where: { id: order.id }, include: INSTALL_ORDER_INCLUDE });
  }

  /** assign (a platform user with a field role), start, mark items done, complete, cancel. */
  updateOrder(
    id: string,
    action: 'assign' | 'start' | 'complete-items' | 'complete' | 'cancel',
    input: {
      assignedTo?: string | null;
      itemIndexes?: number[];
      deviceIds?: (string | null)[];
      note?: string | null;
    },
  ) {
    return this.db.platform(async (tx) => {
      await tx.$queryRaw`SELECT id FROM platform.install_order WHERE id = ${id}::uuid FOR UPDATE`;
      const o = await tx.installOrder.findUnique({ where: { id } });
      if (!o) throw new DomainException('http.not_found');
      const items = o.items as unknown as InstallItem[];
      const data: Prisma.InstallOrderUpdateInput = { updatedBy: by(), version: { increment: 1 } };
      const now = this.clock.now();
      const move = (to: InstallOrderState) => {
        if (!ORDER_NEXT[o.state].includes(to))
          throw new DomainException('install_order.invalid_transition', { params: { from: o.state, to } });
        data.state = to;
        if (to === 'done') data.completedAt = now;
      };
      switch (action) {
        case 'assign': {
          if (o.state === 'done' || o.state === 'cancelled')
            throw new DomainException('install_order.invalid_transition', {
              params: { from: o.state, to: o.state },
            });
          const user = input.assignedTo
            ? await tx.platformRoleAssignment.findFirst({
                where: {
                  userId: input.assignedTo,
                  revokedAt: null,
                  role: { key: { in: ['field_engineer', 'platform_admin'] } },
                },
              })
            : null;
          if (input.assignedTo && !user) throw new DomainException('install_order.assignee_invalid');
          data.assignee = input.assignedTo ? { connect: { id: input.assignedTo } } : { disconnect: true };
          break;
        }
        case 'start':
          move('in_progress');
          break;
        case 'complete-items': {
          for (const [n, index] of (input.itemIndexes ?? []).entries()) {
            const item = items[index];
            if (!item)
              throw new DomainException('validation.failed', {
                errors: [{ path: `itemIndexes.${n}`, code: 'range', message: 'no such item' }],
              });
            item.done = true;
            if (input.deviceIds?.[n]) item.deviceId = input.deviceIds[n] ?? item.deviceId;
          }
          data.items = items as unknown as Prisma.InputJsonValue;
          if (o.state === 'open') data.state = 'in_progress';
          break;
        }
        case 'complete':
          if (items.some((i) => !i.done)) throw new DomainException('install_order.items_open');
          move('done');
          break;
        case 'cancel':
          move('cancelled');
          break;
      }
      const updated = await tx.installOrder.update({ where: { id }, data, include: INSTALL_ORDER_INCLUDE });
      await this.audit.record(tx, {
        action: 'install_order.updated',
        tenantId: o.tenantId,
        buildingId: o.buildingId,
        subjectType: 'platform.install_order',
        subjectId: id,
        before: { state: o.state },
        after: { state: updated.state, action, note: input.note ?? null },
      });
      if (updated.state !== o.state)
        await this.events.record(tx, {
          type: 'install_order.changed',
          aggregateType: 'install_order',
          aggregateId: id,
          tenantId: o.tenantId,
          buildingId: o.buildingId,
          payload: { installOrderId: id, from: o.state, to: updated.state, kind: o.kind },
        });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------- site surveys

  /** Owner (D-156 upgrade Starter → Smart): one open survey per building. */
  requestSurvey(ctx: TenantContext, input: { buildingId: string; notes?: string | null }) {
    const userId = by();
    return this.db.tenant(ctx, async (tx) => {
      const building = await tx.building.findFirst({
        where: {
          id: input.buildingId,
          deletedAt: null,
          OR: [{ ownerTenantId: ctx.tenantId }, { operatorTenantId: ctx.tenantId }],
        },
      });
      if (!building) throw new DomainException('http.not_found');
      const sub = await tx.subscription.findFirst({
        where: { tenantId: ctx.tenantId, state: { in: ['trial', 'active', 'past_due'] } },
      });
      if (!sub) throw new DomainException('subscription.not_found');
      if (sub.planKey !== 'apartment_starter')
        throw new DomainException('subscription.invalid_state', { params: { state: sub.planKey } });
      const open = await tx.siteSurveyRequest.findFirst({
        where: {
          tenantId: ctx.tenantId,
          buildingId: input.buildingId,
          state: { in: ['requested', 'scheduled'] },
        },
      });
      if (open) return { survey: open, created: false };
      const survey = await tx.siteSurveyRequest.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: input.buildingId,
          requestedBy: userId,
          targetPlanKey: 'apartment_smart',
          notes: input.notes ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'site_survey.requested',
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        subjectType: 'platform.site_survey_request',
        subjectId: survey.id,
        after: { targetPlanKey: 'apartment_smart' },
      });
      await this.events.record(tx, {
        type: 'site_survey.requested',
        aggregateType: 'site_survey_request',
        aggregateId: survey.id,
        tenantId: ctx.tenantId,
        buildingId: input.buildingId,
        payload: { siteSurveyRequestId: survey.id, targetPlanKey: 'apartment_smart' },
      });
      return { survey, created: true };
    });
  }

  surveysOf(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.siteSurveyRequest.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  listSurveys(filter: { tenantId?: string; state?: string }) {
    return this.db.platform((tx) =>
      tx.siteSurveyRequest.findMany({
        where: {
          ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
          ...(filter.state ? { state: filter.state as never } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  /**
   * Field engineer: schedule (date + assignee), complete with findings (an installation recommended → the install
   * order of the building: one gateway + one meter device per unit and utility without an IoT channel), or cancel.
   */
  updateSurvey(
    id: string,
    action: 'schedule' | 'complete' | 'cancel',
    input: {
      scheduledFor?: Date | null;
      assignedTo?: string | null;
      findings?: Record<string, unknown>;
      install?: boolean;
      notes?: string | null;
    },
  ) {
    return this.db.platform(async (tx) => {
      await tx.$queryRaw`SELECT id FROM platform.site_survey_request WHERE id = ${id}::uuid FOR UPDATE`;
      const s = await tx.siteSurveyRequest.findUnique({ where: { id } });
      if (!s) throw new DomainException('http.not_found');
      const allowed: Record<string, string[]> = {
        schedule: ['requested', 'scheduled'],
        complete: ['requested', 'scheduled'],
        cancel: ['requested', 'scheduled'],
      };
      if (!allowed[action]!.includes(s.state))
        throw new DomainException('install_order.invalid_transition', {
          params: { from: s.state, to: action },
        });
      let installOrderId: string | null = null;
      if (action === 'complete' && input.install !== false) {
        const sub = await tx.subscription.findFirst({
          where: { tenantId: s.tenantId, state: { in: ['trial', 'active', 'past_due', 'suspended'] } },
        });
        const units = await tx.unit.findMany({
          where: { buildingId: s.buildingId, deletedAt: null, status: { not: 'inactive' } },
          orderBy: { unitNo: 'asc' },
          select: { id: true },
        });
        const meters = await tx.meterAssignment.findMany({
          where: { buildingId: s.buildingId, validTo: null, purpose: 'unit' },
          select: { unitId: true, utility: true, assetItemId: true },
        });
        const channelled = new Set(
          (
            await tx.meterChannel.findMany({
              where: { buildingId: s.buildingId, validTo: null },
              select: { meterAssetItemId: true },
            })
          ).map((c) => c.meterAssetItemId),
        );
        const items: InstallItem[] = [
          { unitId: null, assetItemId: null, deviceKind: 'gateway', deviceId: null, done: false },
        ];
        for (const u of units)
          for (const utility of ['electric', 'water'] as const) {
            const m = meters.find((x) => x.unitId === u.id && x.utility === utility);
            if (m && channelled.has(m.assetItemId)) continue;
            items.push({
              unitId: u.id,
              assetItemId: m?.assetItemId ?? null,
              deviceKind: utility === 'electric' ? 'electric_meter' : 'water_meter',
              deviceId: null,
              done: false,
            });
          }
        const order = await this.insertOrder(tx, {
          tenantId: s.tenantId,
          buildingId: s.buildingId,
          kind: 'install',
          subscriptionId: sub?.id ?? null,
          siteSurveyRequestId: s.id,
          items,
          dueAt: null,
          notes: input.notes ?? null,
        });
        installOrderId = order.id;
      }
      const updated = await tx.siteSurveyRequest.update({
        where: { id },
        data: {
          state: action === 'schedule' ? 'scheduled' : action === 'complete' ? 'done' : 'cancelled',
          scheduledFor: action === 'schedule' ? (input.scheduledFor ?? s.scheduledFor) : s.scheduledFor,
          assignedTo: input.assignedTo === undefined ? s.assignedTo : input.assignedTo,
          findings: (input.findings ?? s.findings ?? {}) as Prisma.InputJsonValue,
          notes: input.notes ?? s.notes,
          installOrderId: installOrderId ?? s.installOrderId,
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'site_survey.updated',
        tenantId: s.tenantId,
        buildingId: s.buildingId,
        subjectType: 'platform.site_survey_request',
        subjectId: id,
        before: { state: s.state },
        after: { state: updated.state, installOrderId },
      });
      return updated;
    });
  }
}

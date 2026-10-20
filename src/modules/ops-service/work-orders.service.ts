import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { MoneyDecimal } from '@common/money/money';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { AccessService } from '@core/tenancy/access.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Prisma,
  type ServicePriority,
  type WorkOrder,
  type WorkOrderCostKind,
  type WorkOrderKind,
  type WorkOrderStatus,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { MAX_PHOTOS, ServiceRequestsService, WORK_ORDER_SUBJECT } from './service-requests.service';
import { ACTIVE_WORK_ORDER_STATUSES, canWorkOrder, type WorkOrderAction } from './service-rules';

export const WORK_ORDER_INCLUDE = {
  unit: { select: { id: true, unitNo: true } },
  building: { select: { id: true, name: true } },
  assetItem: { select: { id: true, name: true, category: true } },
  assigneeParty: { select: { id: true, displayName: true, phoneE164: true } },
  assigneeUser: { select: { id: true, displayName: true } },
  serviceRequest: {
    select: { id: true, status: true, description: true, categoryId: true, inWarranty: true },
  },
  costLines: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.WorkOrderInclude;
export type WorkOrderRow = Prisma.WorkOrderGetPayload<{ include: typeof WORK_ORDER_INCLUDE }>;

export interface AssigneeInput {
  /** A member of the tenant who handles service requests (internal staff). */
  assigneeUserId?: string | null;
  /** An external technician (a party of the tenant with a LINE id or a linked login → technician LIFF). */
  assigneePartyId?: string | null;
  scheduledAt?: Date | null;
  scheduledUntil?: Date | null;
}

export interface WorkOrderCreateInput extends AssigneeInput {
  serviceRequestId?: string | null;
  assetItemId?: string | null;
  unitId?: string | null;
  buildingId?: string | null;
  maintenancePlanId?: string | null;
  kind: WorkOrderKind;
  title: string;
  description?: string | null;
  priority?: ServicePriority;
}

export interface CostLineInput {
  kind?: WorkOrderCostKind;
  description: string;
  quantity?: string;
  unitPrice: string;
  vendorPartyId?: string | null;
  receiptDocumentId?: string | null;
}

export interface WorkOrderFilters {
  buildingId?: string;
  status?: WorkOrderStatus;
  kind?: WorkOrderKind;
  serviceRequestId?: string;
  assigneeUserId?: string;
  assigneePartyId?: string;
  active?: boolean;
  skip: number;
  take: number;
}

const by = () => userIdOf(RequestContext.actor());

/** Photo roles of a work order. */
export type WorkOrderPhotoRole = 'before' | 'after';

/**
 * Work orders (B5.1, D-072): created by the owner/manager for a request, for an asset item (preventive maintenance)
 * or a unit; assigned to an internal staff login or an external technician party (`work_order.assigned` notifies
 * the assignee; the technician's LIFF token covers `work_order:<id>`); the assignee checks in, photographs before /
 * after, records parts and costs and completes it (an after photo is required); the owner verifies. The request
 * follows through its workflow (assigned → in progress → waiting for parts → done). Costs feed the B4.5 income &
 * expense export by completion month.
 */
@Injectable()
export class WorkOrdersService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly requests: ServiceRequestsService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  // ------------------------------------------------------------------------------------------------------ reads

  async list(ctx: TenantContext, f: WorkOrderFilters): Promise<{ rows: WorkOrderRow[]; total: number }> {
    const where: Prisma.WorkOrderWhereInput = this.own(ctx, {
      AND: [
        f.buildingId ? { buildingId: f.buildingId } : {},
        ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {},
        f.status ? { status: f.status } : f.active ? { status: { in: [...ACTIVE_WORK_ORDER_STATUSES] } } : {},
        f.kind ? { kind: f.kind } : {},
        f.serviceRequestId ? { serviceRequestId: f.serviceRequestId } : {},
        f.assigneeUserId ? { assigneeUserId: f.assigneeUserId } : {},
        f.assigneePartyId ? { assigneePartyId: f.assigneePartyId } : {},
      ],
    });
    return this.db.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.workOrder.findMany({
          where,
          include: WORK_ORDER_INCLUDE,
          orderBy: [{ scheduledAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
          skip: f.skip,
          take: f.take,
        }),
        tx.workOrder.count({ where }),
      ]);
      return { rows, total };
    });
  }

  get(ctx: TenantContext, id: string): Promise<WorkOrderRow> {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  async load(tx: Tx, ctx: TenantContext, id: string): Promise<WorkOrderRow> {
    return this.found(
      await tx.workOrder.findFirst({
        where: this.own(ctx, { id, ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}) }),
        include: WORK_ORDER_INCLUDE,
      }),
    );
  }

  /** True while the request of the work order waits for parts (UI: resume instead of wait-parts). */
  async waitingParts(tx: Tx, wo: Pick<WorkOrder, 'serviceRequestId'>): Promise<boolean> {
    if (!wo.serviceRequestId) return false;
    const sr = await tx.serviceRequest.findUnique({
      where: { id: wo.serviceRequestId },
      select: { status: true },
    });
    return sr?.status === 'waiting_parts';
  }

  // ----------------------------------------------------------------------------------------------- create, assign

  async create(ctx: TenantContext, input: WorkOrderCreateInput): Promise<WorkOrderRow> {
    const id = await this.db.tenant(ctx, async (tx) => (await this.createIn(tx, ctx, input)).id);
    return this.get(ctx, id);
  }

  async createIn(tx: Tx, ctx: TenantContext, input: WorkOrderCreateInput): Promise<WorkOrder> {
    let buildingId = input.buildingId ?? null;
    let unitId = input.unitId ?? null;
    let assetItemId = input.assetItemId ?? null;
    if (input.serviceRequestId) {
      const sr = await this.requests.load(tx, ctx, input.serviceRequestId);
      if (sr.inWarranty) throw new DomainException('service_request.in_warranty');
      if (!['new', 'triaged', 'assigned', 'in_progress', 'waiting_parts'].includes(sr.status))
        throw new DomainException('service_request.invalid_state', { params: { status: sr.status } });
      buildingId = sr.buildingId;
      unitId = unitId ?? sr.unitId;
      assetItemId = assetItemId ?? sr.assetItemId;
    }
    if (assetItemId) {
      const item = this.found(await tx.assetItem.findFirst({ where: { id: assetItemId, deletedAt: null } }));
      buildingId = buildingId ?? item.buildingId;
      unitId = unitId ?? item.unitId;
      if (item.buildingId !== buildingId) throw new DomainException('http.not_found');
    }
    if (unitId) {
      const unit = this.found(await tx.unit.findFirst({ where: { id: unitId, deletedAt: null } }));
      if (buildingId && unit.buildingId !== buildingId) throw new DomainException('http.not_found');
      buildingId = unit.buildingId;
    }
    if (!buildingId)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'buildingId', code: 'required', message: 'a request, asset item, unit or building' },
        ],
      });
    if (input.kind === 'preventive' && !assetItemId)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'assetItemId', code: 'required', message: 'preventive work needs an asset item' }],
      });
    const building = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
      select: { id: true },
    });
    if (!building || (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)))
      throw new DomainException('http.not_found');
    const wo = await tx.workOrder.create({
      data: {
        tenantId: ctx.tenantId,
        buildingId,
        unitId,
        assetItemId,
        serviceRequestId: input.serviceRequestId ?? null,
        maintenancePlanId: input.maintenancePlanId ?? null,
        kind: input.kind,
        title: input.title.trim(),
        description: input.description ?? null,
        priority: input.priority ?? 'normal',
        scheduledAt: input.scheduledAt ?? null,
        scheduledUntil: input.scheduledUntil ?? null,
        createdAt: this.clock.now(),
        createdBy: by(),
      },
    });
    await this.events.record(tx, {
      type: 'work_order.created',
      aggregateType: 'work_order',
      aggregateId: wo.id,
      tenantId: ctx.tenantId,
      buildingId,
      payload: {
        workOrderId: wo.id,
        serviceRequestId: wo.serviceRequestId,
        kind: wo.kind,
        unitId,
        assetItemId,
        maintenancePlanId: wo.maintenancePlanId,
      },
    });
    if (input.assigneeUserId || input.assigneePartyId) return this.assignIn(tx, ctx, wo, input);
    return wo;
  }

  async assign(ctx: TenantContext, id: string, input: AssigneeInput): Promise<WorkOrderRow> {
    await this.db.tenant(ctx, async (tx) => this.assignIn(tx, ctx, await this.load(tx, ctx, id), input));
    return this.get(ctx, id);
  }

  /** Validates the assignee and assigns (re-assigning while not started); the request follows (`assign`). */
  private async assignIn(
    tx: Tx,
    ctx: TenantContext,
    wo: WorkOrder,
    input: AssigneeInput,
  ): Promise<WorkOrder> {
    this.can(wo, 'assign');
    const userId = input.assigneeUserId ?? null;
    const partyId = input.assigneePartyId ?? null;
    if (!userId === !partyId)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'assigneeUserId', code: 'exactlyOne', message: 'a staff login or a technician party' },
        ],
      });
    if (userId) {
      const a = await this.access.operator(userId, ctx.tenantId);
      if (
        !a?.permissions.has('service_request.handle') ||
        (a.buildingIds && !a.buildingIds.includes(wo.buildingId))
      )
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'assigneeUserId',
              code: 'notStaff',
              message: 'a member who handles service requests in this building',
            },
          ],
        });
    }
    if (partyId) {
      const party = await tx.party.findFirst({
        where: { id: partyId, tenantId: ctx.tenantId, deletedAt: null, anonymisedAt: null },
        select: {
          id: true,
          lineUserId: true,
          phoneE164: true,
          userLinks: { where: { state: 'active' }, select: { id: true } },
        },
      });
      if (!party) throw new DomainException('http.not_found');
      if (!party.lineUserId && !party.phoneE164 && !party.userLinks.length)
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'assigneePartyId',
              code: 'noLine',
              message:
                'the technician needs a LINE id, a phone (SMS sign-in) or a linked login to open the technician app',
            },
          ],
        });
    }
    const scheduledAt = input.scheduledAt === undefined ? wo.scheduledAt : input.scheduledAt;
    const scheduledUntil = input.scheduledUntil === undefined ? wo.scheduledUntil : input.scheduledUntil;
    if (scheduledAt && scheduledUntil && scheduledUntil.getTime() <= scheduledAt.getTime())
      throw new DomainException('validation.failed', {
        errors: [{ path: 'scheduledUntil', code: 'after', message: 'the window must end after it starts' }],
      });
    const now = this.clock.now();
    const updated = await this.update(tx, wo, {
      status: 'assigned',
      assigneeUserId: userId,
      assigneePartyId: partyId,
      assignedAt: now,
      acceptedAt: null,
      scheduledAt,
      scheduledUntil,
    });
    await this.events.record(tx, {
      type: 'work_order.assigned',
      aggregateType: 'work_order',
      aggregateId: wo.id,
      tenantId: wo.tenantId,
      buildingId: wo.buildingId,
      payload: {
        workOrderId: wo.id,
        serviceRequestId: wo.serviceRequestId,
        kind: wo.kind,
        title: wo.title,
        unitId: wo.unitId,
        assigneeUserId: userId,
        assigneePartyId: partyId,
        previousAssigneeUserId: wo.assigneeUserId,
        previousAssigneePartyId: wo.assigneePartyId,
        scheduledAt: scheduledAt?.toISOString() ?? null,
        scheduledUntil: scheduledUntil?.toISOString() ?? null,
      },
    });
    if (wo.serviceRequestId) {
      const sr = await tx.serviceRequest.findUniqueOrThrow({ where: { id: wo.serviceRequestId } });
      if (['new', 'triaged'].includes(sr.status))
        await this.requests.follow(tx, sr.id, 'assign', sr.triagedAt ? {} : { triagedAt: now });
    }
    return updated;
  }

  // ---------------------------------------------------------------------------------------------- field steps

  /** The technician confirms the job (optional step before check-in). */
  acceptIn(tx: Tx, wo: WorkOrder): Promise<WorkOrder> {
    this.can(wo, 'accept');
    return this.change(tx, wo, { status: 'accepted', acceptedAt: this.clock.now() });
  }

  /** On site: the work starts (the request is in progress). */
  async checkInIn(tx: Tx, wo: WorkOrder): Promise<WorkOrder> {
    this.can(wo, 'check-in');
    const updated = await this.change(tx, wo, { status: 'in_progress', checkedInAt: this.clock.now() });
    if (wo.serviceRequestId) await this.requests.follow(tx, wo.serviceRequestId, 'start');
    return updated;
  }

  /** Waiting for parts: the request shows it (its SLA clock keeps running). */
  async waitPartsIn(tx: Tx, wo: WorkOrder, note?: string | null): Promise<WorkOrder> {
    this.can(wo, 'wait-parts');
    if (!wo.serviceRequestId)
      throw new DomainException('work_order.invalid_state', { params: { status: wo.status } });
    await this.requests.follow(tx, wo.serviceRequestId, 'wait_parts');
    return this.change(tx, wo, note ? { completionNote: note } : {}, 'waiting_parts');
  }

  async resumeIn(tx: Tx, wo: WorkOrder): Promise<WorkOrder> {
    this.can(wo, 'resume');
    if (wo.serviceRequestId) await this.requests.follow(tx, wo.serviceRequestId, 'start');
    return this.change(tx, wo, {}, 'resumed');
  }

  /**
   * Done (D-072 "done with photos"): at least one after photo; still-presigned photos are completed first by the
   * caller. When no other work order of the request is active the request is done and waits for the resident.
   */
  async completeIn(tx: Tx, wo: WorkOrder, note: string | null): Promise<WorkOrder> {
    this.can(wo, 'complete');
    const after = await tx.attachment.count({
      where: { subjectType: WORK_ORDER_SUBJECT, subjectId: wo.id, role: 'after' },
    });
    if (!after) throw new DomainException('work_order.photo_required');
    const now = this.clock.now();
    const updated = await this.change(tx, wo, {
      status: 'done',
      completedAt: now,
      checkedInAt: wo.checkedInAt ?? now,
      completionNote: note,
    });
    if (wo.serviceRequestId) {
      const others = await tx.workOrder.count({
        where: {
          serviceRequestId: wo.serviceRequestId,
          id: { not: wo.id },
          status: { in: [...ACTIVE_WORK_ORDER_STATUSES] },
        },
      });
      if (!others) {
        await this.requests.follow(tx, wo.serviceRequestId, 'complete', { doneAt: now });
      }
    }
    await this.events.record(tx, {
      type: 'work_order.completed',
      aggregateType: 'work_order',
      aggregateId: wo.id,
      tenantId: wo.tenantId,
      buildingId: wo.buildingId,
      payload: {
        workOrderId: wo.id,
        serviceRequestId: wo.serviceRequestId,
        maintenancePlanId: wo.maintenancePlanId,
        unitId: wo.unitId,
        costTotal: updated.costTotal.toFixed(2),
      },
    });
    return updated;
  }

  async verify(ctx: TenantContext, id: string): Promise<WorkOrderRow> {
    await this.db.tenant(ctx, async (tx) => {
      const wo = await this.load(tx, ctx, id);
      this.can(wo, 'verify');
      await this.change(tx, wo, { status: 'verified', verifiedAt: this.clock.now() });
      await this.audit.record(tx, {
        action: 'work_order.verified',
        tenantId: wo.tenantId,
        buildingId: wo.buildingId,
        subjectType: WORK_ORDER_SUBJECT,
        subjectId: wo.id,
        metadata: { costTotal: wo.costTotal.toFixed(2) },
      });
    });
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string, reason: string): Promise<WorkOrderRow> {
    await this.db.tenant(ctx, async (tx) => {
      const wo = await this.load(tx, ctx, id);
      this.can(wo, 'cancel');
      await this.change(tx, wo, { status: 'cancelled', cancelledAt: this.clock.now(), cancelReason: reason });
      if (wo.serviceRequestId) {
        const active = await tx.workOrder.count({
          where: {
            serviceRequestId: wo.serviceRequestId,
            id: { not: wo.id },
            status: { in: [...ACTIVE_WORK_ORDER_STATUSES] },
          },
        });
        if (!active) await this.requests.follow(tx, wo.serviceRequestId, 'unassign');
      }
    });
    return this.get(ctx, id);
  }

  /** Operator field steps (staff PWA / owner console) by action name. */
  async act(
    ctx: TenantContext,
    id: string,
    action: Exclude<WorkOrderAction, 'assign' | 'verify' | 'cancel'>,
    input: { note?: string | null } = {},
  ): Promise<WorkOrderRow> {
    await this.completePhotos(ctx, id);
    await this.db.tenant(ctx, async (tx) => this.field(tx, await this.load(tx, ctx, id), action, input));
    return this.get(ctx, id);
  }

  async field(
    tx: Tx,
    wo: WorkOrder,
    action: Exclude<WorkOrderAction, 'assign' | 'verify' | 'cancel'>,
    input: { note?: string | null },
  ): Promise<WorkOrder> {
    switch (action) {
      case 'accept':
        return this.acceptIn(tx, wo);
      case 'check-in':
        return this.checkInIn(tx, wo);
      case 'wait-parts':
        return this.waitPartsIn(tx, wo, input.note);
      case 'resume':
        return this.resumeIn(tx, wo);
      case 'complete':
        return this.completeIn(tx, wo, input.note ?? null);
    }
  }

  /** Completes photo uploads of the work order that are still presigned (uploaded before the action). */
  async completePhotos(ctx: TenantContext, workOrderId: string): Promise<void> {
    const docs = await this.db.tenant(ctx, async (tx) => {
      const ids = (
        await tx.attachment.findMany({
          where: { subjectType: WORK_ORDER_SUBJECT, subjectId: workOrderId },
          select: { documentId: true },
        })
      ).map((a) => a.documentId);
      return ids.length
        ? tx.document.findMany({ where: { id: { in: ids }, uploadState: 'presigned' }, select: { id: true } })
        : [];
    });
    for (const d of docs) {
      try {
        await this.documents.complete(ctx, d.id, {});
      } catch (error) {
        // a photo whose bytes never arrived is detached so it cannot count as evidence
        if (error instanceof DomainException && error.code === 'document.not_uploaded')
          await this.db.tenant(ctx, (tx) =>
            tx.attachment.deleteMany({
              where: { subjectType: WORK_ORDER_SUBJECT, subjectId: workOrderId, documentId: d.id },
            }),
          );
        else throw error;
      }
    }
  }

  // ------------------------------------------------------------------------------------------- photos, costs

  /** Attaches an uploaded `service_photo` (before / after) to the work order. */
  async attachPhoto(
    ctx: TenantContext,
    id: string,
    input: { documentId: string; role: WorkOrderPhotoRole },
  ): Promise<WorkOrderRow> {
    await this.db.tenant(ctx, async (tx) => {
      const wo = await this.load(tx, ctx, id);
      const doc = await tx.document.findFirst({
        where: { id: input.documentId, tenantId: ctx.tenantId, deletedAt: null, kind: 'service_photo' },
      });
      if (!doc)
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'documentId', code: 'unknown', message: 'an uploaded service_photo of this tenant' },
          ],
        });
      await this.attachIn(tx, wo, doc.id, input.role);
    });
    return this.get(ctx, id);
  }

  async attachIn(tx: Tx, wo: WorkOrder, documentId: string, role: WorkOrderPhotoRole): Promise<void> {
    if (['verified', 'cancelled'].includes(wo.status))
      throw new DomainException('work_order.invalid_state', { params: { status: wo.status } });
    const count = await tx.attachment.count({
      where: { subjectType: WORK_ORDER_SUBJECT, subjectId: wo.id, role },
    });
    if (count >= MAX_PHOTOS)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'role', code: 'max', message: `at most ${MAX_PHOTOS} ${role} photos` }],
      });
    await tx.attachment.upsert({
      where: {
        documentId_subjectType_subjectId_role: {
          documentId,
          subjectType: WORK_ORDER_SUBJECT,
          subjectId: wo.id,
          role,
        },
      },
      create: {
        tenantId: wo.tenantId,
        documentId,
        subjectType: WORK_ORDER_SUBJECT,
        subjectId: wo.id,
        buildingId: wo.buildingId,
        role,
        position: count,
        createdBy: by(),
      },
      update: {},
    });
  }

  async addCost(ctx: TenantContext, id: string, input: CostLineInput): Promise<WorkOrderRow> {
    await this.db.tenant(ctx, async (tx) => this.addCostIn(tx, await this.load(tx, ctx, id), input));
    return this.get(ctx, id);
  }

  async addCostIn(tx: Tx, wo: WorkOrder, input: CostLineInput): Promise<void> {
    if (['verified', 'cancelled'].includes(wo.status))
      throw new DomainException('work_order.invalid_state', { params: { status: wo.status } });
    const quantity = new MoneyDecimal(input.quantity ?? '1');
    const unitPrice = new MoneyDecimal(input.unitPrice);
    if (quantity.lte(0) || unitPrice.lt(0) || !unitPrice.equals(unitPrice.toDecimalPlaces(2)))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'unitPrice', code: 'money', message: 'a positive quantity and a price in satang' }],
      });
    if (input.vendorPartyId) {
      const vendor = await tx.party.findFirst({
        where: { id: input.vendorPartyId, tenantId: wo.tenantId, deletedAt: null },
      });
      if (!vendor) throw new DomainException('http.not_found');
    }
    if (input.receiptDocumentId) {
      const doc = await tx.document.findFirst({
        where: { id: input.receiptDocumentId, tenantId: wo.tenantId, deletedAt: null },
      });
      if (!doc) throw new DomainException('http.not_found');
    }
    const amount = quantity.mul(unitPrice).toDecimalPlaces(2);
    const line = await tx.workOrderCostLine.create({
      data: {
        tenantId: wo.tenantId,
        workOrderId: wo.id,
        kind: input.kind ?? 'part',
        description: input.description.trim(),
        quantity: quantity.toFixed(3),
        unitPrice: unitPrice.toFixed(2),
        amount: amount.toFixed(2),
        vendorPartyId: input.vendorPartyId ?? null,
        receiptDocumentId: input.receiptDocumentId ?? null,
        createdBy: by(),
      },
    });
    await this.recost(tx, wo, { added: line.id, amount: amount.toFixed(2) });
  }

  async removeCost(ctx: TenantContext, id: string, lineId: string): Promise<WorkOrderRow> {
    await this.db.tenant(ctx, async (tx) => {
      const wo = await this.load(tx, ctx, id);
      if (['verified', 'cancelled'].includes(wo.status))
        throw new DomainException('work_order.invalid_state', { params: { status: wo.status } });
      const line = this.found(
        await tx.workOrderCostLine.findFirst({ where: { id: lineId, workOrderId: wo.id } }),
      );
      await tx.workOrderCostLine.delete({ where: { id: line.id } });
      await this.recost(tx, wo, { removed: line.id, amount: line.amount.toFixed(2) });
    });
    return this.get(ctx, id);
  }

  /** cost_total = Σ lines (in the same transaction), audited (money) with `work_order.cost_changed`. */
  private async recost(tx: Tx, wo: WorkOrder, change: Record<string, string>): Promise<void> {
    const sum = await tx.workOrderCostLine.aggregate({
      where: { workOrderId: wo.id },
      _sum: { amount: true },
    });
    const total = new MoneyDecimal((sum._sum.amount ?? 0).toString()).toFixed(2);
    const fresh = await tx.workOrder.findUniqueOrThrow({ where: { id: wo.id } });
    await tx.workOrder.update({
      where: { id: wo.id },
      data: { costTotal: total, version: { increment: 1 }, updatedBy: by() },
    });
    await this.audit.record(tx, {
      action: 'work_order.cost_changed',
      tenantId: wo.tenantId,
      buildingId: wo.buildingId,
      subjectType: WORK_ORDER_SUBJECT,
      subjectId: wo.id,
      before: { costTotal: fresh.costTotal.toFixed(2) },
      after: { costTotal: total },
      metadata: change,
    });
    await this.events.record(tx, {
      type: 'work_order.cost_changed',
      aggregateType: 'work_order',
      aggregateId: wo.id,
      tenantId: wo.tenantId,
      buildingId: wo.buildingId,
      payload: { workOrderId: wo.id, costTotal: total, ...change },
    });
  }

  // ---------------------------------------------------------------------------------------------------- helpers

  private can(wo: WorkOrder, action: WorkOrderAction): void {
    if (!canWorkOrder(action, wo.status))
      throw new DomainException('work_order.invalid_state', { params: { status: wo.status } });
  }

  private async update(tx: Tx, wo: WorkOrder, data: Prisma.WorkOrderUncheckedUpdateManyInput) {
    const updated = await tx.workOrder.updateMany({
      where: { id: wo.id, version: wo.version },
      data: { ...data, version: { increment: 1 }, updatedBy: by() },
    });
    if (updated.count !== 1) throw new DomainException('concurrency.stale');
    return tx.workOrder.findUniqueOrThrow({ where: { id: wo.id } });
  }

  /** A status / field change with `work_order.changed` (`step` names a step that keeps the status). */
  private async change(
    tx: Tx,
    wo: WorkOrder,
    data: Prisma.WorkOrderUncheckedUpdateManyInput,
    step?: string,
  ): Promise<WorkOrder> {
    const updated = await this.update(tx, wo, data);
    await this.events.record(tx, {
      type: 'work_order.changed',
      aggregateType: 'work_order',
      aggregateId: wo.id,
      tenantId: wo.tenantId,
      buildingId: wo.buildingId,
      payload: {
        workOrderId: wo.id,
        serviceRequestId: wo.serviceRequestId,
        from: wo.status,
        to: updated.status,
        step: step ?? null,
        assigneePartyId: updated.assigneePartyId,
        assigneeUserId: updated.assigneeUserId,
        unitId: wo.unitId,
      },
    });
    return updated;
  }
}

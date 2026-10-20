import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { WorkflowService } from '@core/workflow/workflow.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Prisma,
  type ServicePriority,
  type ServiceReporterKind,
  type ServiceRequest,
  type ServiceRequestStatus,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { ServiceCategoriesService } from './service-categories.service';
import {
  ACTIVE_WORK_ORDER_STATUSES,
  inWarranty,
  OPEN_REQUEST_STATUSES,
  requestStatusOf,
} from './service-rules';

export const SERVICE_REQUEST_SUBJECT = 'ops.service_request';
export const WORK_ORDER_SUBJECT = 'ops.work_order';
/** At most this many photos per request / per work-order role. */
export const MAX_PHOTOS = 10;

export const SERVICE_REQUEST_INCLUDE = {
  category: { select: { id: true, key: true, nameTh: true, nameEn: true } },
  unit: { select: { id: true, unitNo: true } },
  building: { select: { id: true, name: true } },
  requester: { select: { id: true, displayName: true } },
  assetItem: { select: { id: true, name: true, category: true } },
  workflowInstance: { select: { id: true, state: true, slaDueAt: true, slaBreachedAt: true } },
  workOrders: {
    select: {
      id: true,
      kind: true,
      title: true,
      status: true,
      assigneePartyId: true,
      assigneeUserId: true,
      scheduledAt: true,
      completedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.ServiceRequestInclude;
export type ServiceRequestRow = Prisma.ServiceRequestGetPayload<{ include: typeof SERVICE_REQUEST_INCLUDE }>;

export interface OpenRequestInput {
  buildingId?: string | null;
  unitId?: string | null;
  assetItemId?: string | null;
  categoryId?: string;
  /** Automatic requests name the category by key. */
  categoryKey?: string;
  description: string;
  priority?: ServicePriority;
  requesterPartyId?: string | null;
  reporterKind: ServiceReporterKind;
  photoDocumentIds?: string[];
  autoReason?: string | null;
  sourceDeviceEventId?: string | null;
}

export interface RequestFilters {
  buildingId?: string;
  unitId?: string;
  status?: ServiceRequestStatus;
  categoryId?: string;
  inWarranty?: boolean;
  open?: boolean;
  skip: number;
  take: number;
}

const by = () => userIdOf(RequestContext.actor());

/**
 * Service requests (B5.1, D-072): reported by a resident in the LIFF (with photos), by staff or the owner, or by the
 * system (meter / gateway / lock health, D-034); triaged by the owner; worked through work orders; rated by the
 * resident. The lifecycle runs on the workflow engine (definition `service_request`, SLA hours of the category,
 * breach emitted once, D-159); `status` mirrors the workflow state. A request inside a getbuild warranty is referred
 * (`service_request.warranty_referred` → `bridge.integration_event` by the warranty subscriber) instead of being
 * assigned to the building's technician (D-153). Every change: one transaction, workflow event, domain event.
 */
@Injectable()
export class ServiceRequestsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly categories: ServiceCategoriesService,
    private readonly workflow: WorkflowService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  // ------------------------------------------------------------------------------------------------------ reads

  async list(ctx: TenantContext, f: RequestFilters): Promise<{ rows: ServiceRequestRow[]; total: number }> {
    const where: Prisma.ServiceRequestWhereInput = this.own(ctx, {
      ...(f.buildingId ? { buildingId: f.buildingId } : {}),
      ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}),
      ...(f.buildingId && ctx.buildingIds && !ctx.buildingIds.includes(f.buildingId)
        ? { id: { in: [] } }
        : {}),
      ...(f.unitId ? { unitId: f.unitId } : {}),
      ...(f.status ? { status: f.status } : f.open ? { status: { in: [...OPEN_REQUEST_STATUSES] } } : {}),
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
      ...(f.inWarranty !== undefined ? { inWarranty: f.inWarranty } : {}),
    });
    return this.db.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.serviceRequest.findMany({
          where,
          include: SERVICE_REQUEST_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: f.skip,
          take: f.take,
        }),
        tx.serviceRequest.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async get(ctx: TenantContext, id: string): Promise<ServiceRequestRow> {
    return this.db.tenant(ctx, (tx) => this.load(tx, ctx, id));
  }

  async load(tx: Tx, ctx: TenantContext, id: string): Promise<ServiceRequestRow> {
    return this.found(
      await tx.serviceRequest.findFirst({
        where: this.own(ctx, { id, ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}) }),
        include: SERVICE_REQUEST_INCLUDE,
      }),
    );
  }

  /** Photos (document ids per role) of requests / work orders. */
  async photos(tx: Tx, subjectType: string, ids: string[]): Promise<Map<string, Map<string, string[]>>> {
    const rows = ids.length
      ? await tx.attachment.findMany({
          where: { subjectType, subjectId: { in: ids } },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          select: { subjectId: true, role: true, documentId: true },
        })
      : [];
    const out = new Map<string, Map<string, string[]>>();
    for (const r of rows) {
      const roles = out.get(r.subjectId) ?? new Map<string, string[]>();
      roles.set(r.role, [...(roles.get(r.role) ?? []), r.documentId]);
      out.set(r.subjectId, roles);
    }
    return out;
  }

  /** Photos per subject and role, in their own tenant transaction (list views). */
  photosFor(ctx: TenantContext, subjectType: string, ids: string[]) {
    return this.db.tenant(ctx, (tx) => this.photos(tx, subjectType, ids));
  }

  /** Events allowed now by the workflow (UI next actions). */
  async allowedEvents(tx: Tx, row: Pick<ServiceRequest, 'workflowInstanceId'>): Promise<string[]> {
    if (!row.workflowInstanceId) return [];
    const instance = await tx.workflowInstance.findUnique({ where: { id: row.workflowInstanceId } });
    return instance ? this.workflow.allowedEvents(tx, instance) : [];
  }

  /** The request's timeline: its workflow events (state changes, SLA warnings and breaches). */
  async timeline(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const sr = await this.load(tx, ctx, id);
      if (!sr.workflowInstanceId) return [];
      return tx.workflowEvent.findMany({
        where: { instanceId: sr.workflowInstanceId },
        orderBy: { occurredAt: 'asc' },
      });
    });
  }

  // ------------------------------------------------------------------------------------------------------ writes

  /** Owner / staff report a request (unit or common area of a building). */
  async create(
    ctx: TenantContext,
    input: Omit<OpenRequestInput, 'reporterKind' | 'categoryKey' | 'autoReason' | 'sourceDeviceEventId'>,
  ): Promise<ServiceRequestRow> {
    const reporterKind: ServiceReporterKind = ctx.role === 'staff' ? 'staff' : 'owner';
    await this.completePhotos(ctx, input.photoDocumentIds ?? []);
    const id = await this.db.tenant(
      ctx,
      async (tx) => (await this.open(tx, ctx, { ...input, reporterKind })).id,
    );
    return this.get(ctx, id);
  }

  /** Completes photo uploads that are still presigned (the client uploaded, then sent the ids). */
  async completePhotos(ctx: TenantContext, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const docs = await this.db.tenant(ctx, (tx) =>
      tx.document.findMany({
        where: { id: { in: [...new Set(ids)] }, tenantId: ctx.tenantId, uploadState: 'presigned' },
      }),
    );
    for (const d of docs) await this.documents.complete(ctx, d.id, {});
  }

  /**
   * Opens a request inside the caller's transaction: validates the place and the photos, starts the workflow with
   * the category's SLA hours and refers it to the warranty when it falls inside one.
   */
  async open(
    tx: Tx,
    ctx: TenantContext,
    input: OpenRequestInput,
    photoOwner?: { userId: string },
  ): Promise<ServiceRequest> {
    const now = this.clock.now();
    const place = await this.place(tx, ctx, input);
    const category = input.categoryId
      ? await this.categories.resolve(tx, ctx.tenantId, input.categoryId)
      : await this.categories.byKey(tx, ctx.tenantId, input.categoryKey ?? 'other');
    const photos = await this.validPhotos(tx, ctx, input.photoDocumentIds ?? [], place, photoOwner);
    const created = await tx.serviceRequest.create({
      data: {
        tenantId: ctx.tenantId,
        buildingId: place.buildingId,
        unitId: place.unitId,
        assetItemId: place.assetItemId,
        requesterPartyId: input.requesterPartyId ?? null,
        reporterKind: input.reporterKind,
        reporterUserId: by(),
        categoryId: category.id,
        description: input.description.trim(),
        priority: input.priority ?? 'normal',
        slaHours: category.slaHours,
        autoReason: input.autoReason ?? null,
        sourceDeviceEventId: input.sourceDeviceEventId ?? null,
        createdAt: now,
        createdBy: by(),
      },
    });
    for (const [position, documentId] of photos.entries())
      await tx.attachment.create({
        data: {
          tenantId: ctx.tenantId,
          documentId,
          subjectType: SERVICE_REQUEST_SUBJECT,
          subjectId: created.id,
          buildingId: place.buildingId,
          role: 'report',
          position,
          createdBy: by(),
        },
      });
    const instance = await this.workflow.start(tx, {
      tenantId: ctx.tenantId,
      buildingId: place.buildingId,
      subjectType: 'service_request',
      subjectId: created.id,
      definitionKey: 'service_request',
      context: { slaHours: category.slaHours, categoryKey: category.key },
    });
    let row = await tx.serviceRequest.update({
      where: { id: created.id },
      data: { workflowInstanceId: instance.id },
    });
    await this.events.record(tx, {
      type: 'service_request.created',
      aggregateType: 'service_request',
      aggregateId: row.id,
      tenantId: ctx.tenantId,
      buildingId: row.buildingId,
      payload: {
        serviceRequestId: row.id,
        unitId: row.unitId,
        assetItemId: row.assetItemId,
        requesterPartyId: row.requesterPartyId,
        reporterKind: row.reporterKind,
        categoryKey: category.key,
        priority: row.priority,
        slaDueAt: instance.slaDueAt?.toISOString() ?? null,
        autoReason: row.autoReason,
      },
    });
    const warranty = await this.warrantyApplies(tx, row, now);
    if (warranty) {
      row = await this.transition(tx, row, 'refer_warranty', { inWarranty: true, triagedAt: now });
      await this.events.record(tx, {
        type: 'service_request.warranty_referred',
        aggregateType: 'service_request',
        aggregateId: row.id,
        tenantId: ctx.tenantId,
        buildingId: row.buildingId,
        payload: {
          serviceRequestId: row.id,
          unitId: row.unitId,
          assetItemId: row.assetItemId,
          categoryKey: category.key,
        },
      });
    }
    return row;
  }

  /** Where a request is: unit → its building; asset item → its unit/building; else the building (common area). */
  private async place(
    tx: Tx,
    ctx: TenantContext,
    input: Pick<OpenRequestInput, 'buildingId' | 'unitId' | 'assetItemId'>,
  ): Promise<{ buildingId: string; unitId: string | null; assetItemId: string | null }> {
    let buildingId = input.buildingId ?? null;
    let unitId = input.unitId ?? null;
    const assetItemId = input.assetItemId ?? null;
    if (assetItemId) {
      const item = this.found(await tx.assetItem.findFirst({ where: { id: assetItemId, deletedAt: null } }));
      if (unitId && item.unitId && item.unitId !== unitId) throw new DomainException('http.not_found');
      unitId = unitId ?? item.unitId;
      buildingId = buildingId ?? item.buildingId;
      if (item.buildingId !== buildingId) throw new DomainException('http.not_found');
    }
    if (unitId) {
      const unit = this.found(await tx.unit.findFirst({ where: { id: unitId, deletedAt: null } }));
      if (buildingId && unit.buildingId !== buildingId) throw new DomainException('http.not_found');
      buildingId = unit.buildingId;
    }
    if (!buildingId)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'buildingId', code: 'required', message: 'a unit, an asset item or a building' }],
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
    return { buildingId, unitId, assetItemId };
  }

  /** Photos of a request: uploaded `service_photo` files of the tenant (residents: their own, of that unit). */
  private async validPhotos(
    tx: Tx,
    ctx: TenantContext,
    ids: string[],
    place: { buildingId: string; unitId: string | null },
    owner?: { userId: string },
  ): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_PHOTOS)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'photoDocumentIds', code: 'max', message: `at most ${MAX_PHOTOS} photos` }],
      });
    if (!unique.length) return [];
    const docs = await tx.document.findMany({
      where: {
        id: { in: unique },
        tenantId: ctx.tenantId,
        deletedAt: null,
        kind: 'service_photo',
        uploadState: { not: 'presigned' },
        ...(owner
          ? {
              createdBy: owner.userId,
              OR: [
                { scopeType: 'unit', scopeId: place.unitId ?? undefined },
                { scopeType: 'building', scopeId: place.buildingId },
              ],
            }
          : {}),
      },
      select: { id: true },
    });
    if (docs.length !== unique.length)
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'photoDocumentIds',
            code: 'notUploaded',
            message: 'uploaded service photos of this tenant (kind service_photo)',
          },
        ],
      });
    return unique;
  }

  /** A getbuild warranty covers the request (blueprint A4.6, D-153) — see `inWarranty`. */
  private async warrantyApplies(tx: Tx, row: ServiceRequest, now: Date): Promise<boolean> {
    if (row.reporterKind === 'system') return false;
    const today = bangkokDate(now);
    const item = row.assetItemId
      ? await tx.assetItem.findUnique({
          where: { id: row.assetItemId },
          select: { sourceRef: true, warrantyUntil: true },
        })
      : null;
    const unit = row.unitId
      ? await tx.unit.findUnique({ where: { id: row.unitId }, select: { sourceRef: true } })
      : null;
    const grants =
      !item && unit?.sourceRef
        ? await tx.assetAccessGrant.count({
            where: {
              buildingId: row.buildingId,
              reason: 'warranty',
              revokedAt: null,
              validFrom: { lte: now },
              OR: [{ validTo: null }, { validTo: { gt: now } }],
              AND: [{ OR: [{ unitId: null }, { unitId: row.unitId }] }],
            },
          })
        : 0;
    return inWarranty({
      today,
      assetItem: item
        ? {
            sourceRef: item.sourceRef,
            warrantyUntil: item.warrantyUntil ? item.warrantyUntil.toISOString().slice(0, 10) : null,
          }
        : null,
      unit,
      warrantyGrantActive: grants > 0,
    });
  }

  /**
   * Applies a workflow event to a request and mirrors the state into `status` (+ the extra columns), bumping the
   * version, with `service_request.changed` (resident notified on each state change, quiet hours apply).
   */
  async transition(
    tx: Tx,
    row: ServiceRequest,
    event: string,
    extra: Prisma.ServiceRequestUncheckedUpdateInput = {},
    data: Record<string, unknown> = {},
  ): Promise<ServiceRequest> {
    if (!row.workflowInstanceId) throw new Error(`service request ${row.id} has no workflow instance`);
    const instance = await this.workflow.transition(tx, row.workflowInstanceId, event, data);
    const status = requestStatusOf(instance.state);
    const updated = await tx.serviceRequest.updateMany({
      where: { id: row.id, version: row.version },
      data: { ...extra, status, version: { increment: 1 }, updatedBy: by() },
    });
    if (updated.count !== 1) throw new DomainException('concurrency.stale');
    const fresh = await tx.serviceRequest.findUniqueOrThrow({ where: { id: row.id } });
    await this.events.record(tx, {
      type: 'service_request.changed',
      aggregateType: 'service_request',
      aggregateId: row.id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: {
        serviceRequestId: row.id,
        unitId: row.unitId,
        requesterPartyId: row.requesterPartyId,
        reporterKind: row.reporterKind,
        from: row.status,
        to: status,
        event,
        state: instance.state,
      },
    });
    return fresh;
  }

  /** Applies `event` only when the workflow allows it now (work-order driven moves are best effort). */
  async follow(
    tx: Tx,
    requestId: string,
    event: string,
    extra: Prisma.ServiceRequestUncheckedUpdateInput = {},
  ) {
    const row = await tx.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (!(await this.allowedEvents(tx, row)).includes(event)) return row;
    return this.transition(tx, row, event, extra);
  }

  async triage(
    ctx: TenantContext,
    id: string,
    input: { categoryId?: string; priority?: ServicePriority },
  ): Promise<ServiceRequestRow> {
    await this.db.tenant(ctx, async (tx) => {
      const row = await this.load(tx, ctx, id);
      const category = input.categoryId
        ? await this.categories.resolve(tx, ctx.tenantId, input.categoryId)
        : null;
      await this.must(tx, row, 'triage');
      await this.transition(tx, row, 'triage', {
        triagedAt: this.clock.now(),
        ...(category ? { categoryId: category.id } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      });
    });
    return this.get(ctx, id);
  }

  async close(ctx: TenantContext, id: string): Promise<ServiceRequestRow> {
    await this.db.tenant(ctx, async (tx) => {
      const row = await this.load(tx, ctx, id);
      await this.must(tx, row, 'close');
      await this.transition(tx, row, 'close', { closedAt: this.clock.now() });
    });
    return this.get(ctx, id);
  }

  async reopen(ctx: TenantContext, id: string, reason: string): Promise<ServiceRequestRow> {
    await this.db.tenant(ctx, async (tx) => {
      const row = await this.load(tx, ctx, id);
      await this.must(tx, row, 'reopen');
      await this.transition(tx, row, 'reopen', { doneAt: null }, { reason });
    });
    return this.get(ctx, id);
  }

  /** Cancels the request and its active work orders (reason kept). */
  async cancel(ctx: TenantContext, id: string, reason: string): Promise<ServiceRequestRow> {
    await this.db.tenant(ctx, (tx) => this.cancelIn(tx, ctx, id, reason));
    return this.get(ctx, id);
  }

  async cancelIn(tx: Tx, ctx: TenantContext, id: string, reason: string): Promise<ServiceRequest> {
    const row = await this.load(tx, ctx, id);
    await this.must(tx, row, 'cancel');
    const now = this.clock.now();
    const active = await tx.workOrder.findMany({
      where: { serviceRequestId: row.id, status: { in: [...ACTIVE_WORK_ORDER_STATUSES] } },
    });
    for (const wo of active) {
      await tx.workOrder.update({
        where: { id: wo.id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          cancelReason: reason,
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'work_order.changed',
        aggregateType: 'work_order',
        aggregateId: wo.id,
        tenantId: wo.tenantId,
        buildingId: wo.buildingId,
        payload: {
          workOrderId: wo.id,
          serviceRequestId: row.id,
          from: wo.status,
          to: 'cancelled',
          assigneePartyId: wo.assigneePartyId,
          assigneeUserId: wo.assigneeUserId,
          unitId: wo.unitId,
        },
      });
    }
    const fresh = await this.transition(
      tx,
      row,
      'cancel',
      { cancelledAt: now, cancelReason: reason },
      { reason },
    );
    await this.audit.record(tx, {
      action: 'service_request.cancelled',
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      subjectType: SERVICE_REQUEST_SUBJECT,
      subjectId: row.id,
      metadata: { reason, workOrdersCancelled: active.length },
    });
    return fresh;
  }

  /** The resident's rating closes a done request (D-072). */
  async rateIn(tx: Tx, row: ServiceRequest, rating: number, comment: string | null): Promise<ServiceRequest> {
    if (row.status !== 'done' || row.ratedAt)
      throw new DomainException('service_request.invalid_state', { params: { status: row.status } });
    const now = this.clock.now();
    const fresh = await this.transition(tx, row, 'close', {
      rating,
      ratingComment: comment,
      ratedAt: now,
      closedAt: now,
    });
    await this.events.record(tx, {
      type: 'service_request.rated',
      aggregateType: 'service_request',
      aggregateId: row.id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: { serviceRequestId: row.id, unitId: row.unitId, rating },
    });
    return fresh;
  }

  /** 409 `service_request.invalid_state` unless the workflow allows `event` now. */
  async must(tx: Tx, row: ServiceRequest, event: string): Promise<void> {
    if (!(await this.allowedEvents(tx, row)).includes(event))
      throw new DomainException('service_request.invalid_state', { params: { status: row.status } });
  }
}

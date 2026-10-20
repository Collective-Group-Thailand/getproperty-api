import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { DocumentsService } from '@core/documents/documents.service';
import { TenantTx } from '@database/tenant-tx';
import { type ServicePriority, type WorkOrder } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { ServiceCategoriesService } from './service-categories.service';
import {
  SERVICE_REQUEST_INCLUDE,
  type ServiceRequestRow,
  ServiceRequestsService,
} from './service-requests.service';
import { requestResidentActions, TECHNICIAN_VISIBLE_STATUSES } from './service-rules';
import {
  type CostLineInput,
  WORK_ORDER_INCLUDE,
  type WorkOrderPhotoRole,
  type WorkOrderRow,
  WorkOrdersService,
} from './work-orders.service';

const PHOTO_MAX_BYTES = 10_000_000;

function actorUser(): { userId: string; scopes: readonly string[] } {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return { userId: actor.publicId, scopes: actor.scopes };
}

/**
 * The technician LIFF (`/v1/technician/work-orders*`, D-154, B5.1): an external technician signs in with LINE; the
 * token carries `work_order:<id>` for every work order assigned to a party linked to the login (or carrying its LINE
 * id) that is not yet verified. Each call re-checks the assignment in the database (a re-assigned work order is a
 * 404 at once) and runs in the work order's tenant (RLS). The technician sees only that work order: the unit, the
 * request's description and photos — no lease, no party data of the resident.
 */
@Injectable()
export class TechnicianWorkOrdersService {
  constructor(
    private readonly db: TenantTx,
    private readonly workOrders: WorkOrdersService,
    private readonly requests: ServiceRequestsService,
    private readonly documents: DocumentsService,
  ) {}

  private async parties(userId: string): Promise<string[]> {
    return this.db.platform(async (tx) => {
      const user = await tx.userAccount.findUnique({ where: { id: userId }, select: { lineUserId: true } });
      const rows = await tx.party.findMany({
        where: {
          deletedAt: null,
          anonymisedAt: null,
          OR: [
            { userLinks: { some: { userId, state: 'active' } } },
            ...(user?.lineUserId ? [{ lineUserId: user.lineUserId }] : []),
          ],
        },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    });
  }

  /** The work order of a technician request (404 when not in the token, re-assigned, verified or cancelled). */
  async access(workOrderId: string): Promise<{ ctx: TenantContext; wo: WorkOrder }> {
    const { userId, scopes } = actorUser();
    if (!scopes.includes(`work_order:${workOrderId}`)) throw new DomainException('http.not_found');
    const parties = await this.parties(userId);
    const wo = await this.db.platform((tx) => tx.workOrder.findUnique({ where: { id: workOrderId } }));
    if (
      !wo?.assigneePartyId ||
      !parties.includes(wo.assigneePartyId) ||
      !TECHNICIAN_VISIBLE_STATUSES.includes(wo.status)
    )
      throw new DomainException('http.not_found');
    return { ctx: { tenantId: wo.tenantId, source: 'path' }, wo };
  }

  /** My work orders: those of my token still assigned to me. */
  async list(): Promise<WorkOrderRow[]> {
    const { scopes } = actorUser();
    const ids = scopes.filter((s) => s.startsWith('work_order:')).map((s) => s.slice('work_order:'.length));
    const out: WorkOrderRow[] = [];
    for (const id of ids) {
      try {
        out.push(await this.get(id));
      } catch (error) {
        if (!(error instanceof DomainException && error.code === 'http.not_found')) throw error;
      }
    }
    return out.sort(
      (a, b) =>
        (a.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (b.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
    );
  }

  async get(id: string): Promise<WorkOrderRow> {
    const { ctx } = await this.access(id);
    const row = await this.db.tenant(ctx, (tx) =>
      tx.workOrder.findFirst({ where: { id, tenantId: ctx.tenantId }, include: WORK_ORDER_INCLUDE }),
    );
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  /** The request behind a work order (description, report photos) as the technician sees it. */
  async request(id: string) {
    const { ctx, wo } = await this.access(id);
    if (!wo.serviceRequestId) return null;
    return this.db.tenant(ctx, async (tx) => {
      const sr = await tx.serviceRequest.findUniqueOrThrow({
        where: { id: wo.serviceRequestId! },
        include: { category: { select: { key: true, nameTh: true, nameEn: true } } },
      });
      const photos = await this.requests.photos(tx, 'ops.service_request', [sr.id]);
      return { sr, photoIds: photos.get(sr.id)?.get('report') ?? [] };
    });
  }

  async act(
    id: string,
    action: 'accept' | 'check-in' | 'wait-parts' | 'resume' | 'complete',
    input: { note?: string | null } = {},
  ): Promise<WorkOrderRow> {
    const { ctx } = await this.access(id);
    await this.workOrders.completePhotos(ctx, id);
    await this.db.tenant(ctx, async (tx) => {
      const wo = await tx.workOrder.findUniqueOrThrow({ where: { id } });
      await this.workOrders.field(tx, wo, action, input);
    });
    return this.get(id);
  }

  /** A 15-minute upload URL for a before / after photo, attached to the work order at once. */
  async presignPhoto(
    id: string,
    input: { role: WorkOrderPhotoRole; contentType: string; sizeBytes: number; sha256: string },
  ) {
    const { ctx, wo } = await this.access(id);
    if (input.sizeBytes > PHOTO_MAX_BYTES)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'sizeBytes', code: 'max', message: `at most ${PHOTO_MAX_BYTES} bytes` }],
      });
    const ext = input.contentType.split('/')[1] ?? 'jpg';
    const presigned = await this.documents.presign(ctx, {
      kind: 'service_photo',
      scopeType: wo.unitId ? 'unit' : 'building',
      scopeId: wo.unitId ?? wo.buildingId,
      fileName: `work-order-${input.role}.${ext}`,
      title: `ภาพ${input.role === 'before' ? 'ก่อน' : 'หลัง'}ซ่อม`,
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    });
    await this.db.tenant(ctx, (tx) => this.workOrders.attachIn(tx, wo, presigned.document.id, input.role));
    return presigned;
  }

  async addCost(id: string, input: CostLineInput): Promise<WorkOrderRow> {
    const { ctx } = await this.access(id);
    await this.db.tenant(ctx, async (tx) => {
      const wo = await tx.workOrder.findUniqueOrThrow({ where: { id } });
      await this.workOrders.addCostIn(tx, wo, { ...input, vendorPartyId: null, receiptDocumentId: null });
    });
    return this.get(id);
  }

  /** Photos of the work order (before / after). */
  async photos(id: string): Promise<Map<string, string[]>> {
    const { ctx } = await this.access(id);
    return this.db.tenant(
      ctx,
      async (tx) =>
        (await this.requests.photos(tx, 'ops.work_order', [id])).get(id) ?? new Map<string, string[]>(),
    );
  }
}

/**
 * The resident side of service requests (`/v1/resident/service-requests*`, LIFF, D-072): a resident reports a problem
 * of a unit they occupy (token scope `unit:<id>`) with photos they uploaded (`POST /v1/resident/uploads`, purpose
 * `service_request`), follows its progress, cancels it before work starts and rates it once it is done (the rating
 * closes it). They see requests they reported and the requests of their units — never other units.
 */
@Injectable()
export class ResidentServiceRequestsService {
  constructor(
    private readonly db: TenantTx,
    private readonly requests: ServiceRequestsService,
    private readonly categories: ServiceCategoriesService,
    private readonly documents: DocumentsService,
  ) {}

  private units(): string[] {
    return actorUser()
      .scopes.filter((s) => s.startsWith('unit:'))
      .map((s) => s.slice('unit:'.length));
  }

  /** The unit of a resident action → its tenant (404 outside my unit scopes). */
  async unit(unitId: string): Promise<{ ctx: TenantContext; unit: { id: string; buildingId: string } }> {
    if (!this.units().includes(unitId)) throw new DomainException('http.not_found');
    const unit = await this.db.platform((tx) =>
      tx.unit.findFirst({
        where: { id: unitId, deletedAt: null },
        select: { id: true, tenantId: true, buildingId: true },
      }),
    );
    if (!unit) throw new DomainException('http.not_found');
    return { ctx: { tenantId: unit.tenantId, source: 'path' }, unit };
  }

  /** My parties in a tenant (the requester of what I report). */
  private async myParty(ctx: TenantContext, unitId: string): Promise<string | null> {
    const { userId } = actorUser();
    return this.db.platform(async (tx) => {
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active', tenantId: ctx.tenantId },
        select: { partyId: true },
      });
      const ids = links.map((l) => l.partyId);
      if (!ids.length) return null;
      const occupant = await tx.occupancy.findFirst({
        where: { unitId, partyId: { in: ids } },
        orderBy: { validFrom: 'desc' },
        select: { partyId: true },
      });
      return occupant?.partyId ?? ids[0]!;
    });
  }

  async categoriesOf(unitId: string) {
    const { ctx } = await this.unit(unitId);
    return this.db.tenant(ctx, (tx) => this.categories.list(tx, ctx.tenantId));
  }

  /** Requests of my units (and the ones I reported), newest first, across tenants. */
  async list(q: {
    open?: boolean;
    skip: number;
    take: number;
  }): Promise<{ rows: ServiceRequestRow[]; total: number }> {
    const { userId } = actorUser();
    const units = this.units();
    return this.db.platform(async (tx) => {
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active' },
        select: { partyId: true },
      });
      const where = {
        AND: [
          {
            OR: [
              ...(units.length ? [{ unitId: { in: units } }] : []),
              ...(links.length ? [{ requesterPartyId: { in: links.map((l) => l.partyId) } }] : []),
            ],
          },
          q.open
            ? {
                status: {
                  in: ['new', 'triaged', 'assigned', 'in_progress', 'waiting_parts', 'done'] as const,
                },
              }
            : {},
        ],
      };
      if (!units.length && !links.length) return { rows: [], total: 0 };
      const [rows, total] = await Promise.all([
        tx.serviceRequest.findMany({
          where: where as never,
          include: SERVICE_REQUEST_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: q.skip,
          take: q.take,
        }),
        tx.serviceRequest.count({ where: where as never }),
      ]);
      return { rows, total };
    });
  }

  /** One request I may see (my unit, or I reported it). */
  async access(id: string): Promise<{ ctx: TenantContext; row: ServiceRequestRow }> {
    const { userId } = actorUser();
    const units = this.units();
    const row = await this.db.platform((tx) =>
      tx.serviceRequest.findUnique({ where: { id }, include: SERVICE_REQUEST_INCLUDE }),
    );
    if (!row) throw new DomainException('http.not_found');
    const mine =
      (row.unitId && units.includes(row.unitId)) ||
      (row.requesterPartyId &&
        (await this.db.platform((tx) =>
          tx.partyUserLink.count({ where: { userId, partyId: row.requesterPartyId!, state: 'active' } }),
        )) > 0);
    if (!mine) throw new DomainException('http.not_found');
    return { ctx: { tenantId: row.tenantId, source: 'path' }, row };
  }

  async get(id: string) {
    const { ctx, row } = await this.access(id);
    const photos = await this.db.tenant(ctx, (tx) =>
      this.requests.photos(tx, 'ops.service_request', [row.id]),
    );
    return {
      row,
      photoIds: photos.get(row.id)?.get('report') ?? [],
      nextActions: requestResidentActions(row.status, row.ratedAt !== null),
    };
  }

  async create(input: {
    unitId: string;
    categoryId: string;
    description: string;
    priority?: ServicePriority;
    photoDocumentIds?: string[];
  }) {
    const { ctx, unit } = await this.unit(input.unitId);
    const { userId } = actorUser();
    const requester = await this.myParty(ctx, unit.id);
    await this.requests.completePhotos(ctx, input.photoDocumentIds ?? []);
    const created = await this.db.tenant(ctx, (tx) =>
      this.requests.open(
        tx,
        ctx,
        {
          unitId: unit.id,
          categoryId: input.categoryId,
          description: input.description,
          priority: input.priority,
          requesterPartyId: requester,
          reporterKind: 'resident',
          photoDocumentIds: input.photoDocumentIds ?? [],
        },
        { userId },
      ),
    );
    return this.get(created.id);
  }

  async cancel(id: string, reason: string) {
    const { ctx, row } = await this.access(id);
    if (!['new', 'triaged'].includes(row.status) || row.inWarranty)
      throw new DomainException('service_request.invalid_state', { params: { status: row.status } });
    await this.db.tenant(ctx, (tx) => this.requests.cancelIn(tx, ctx, id, reason));
    return this.get(id);
  }

  async rate(id: string, rating: number, comment: string | null) {
    const { ctx, row } = await this.access(id);
    await this.db.tenant(ctx, async (tx) => {
      const fresh = await tx.serviceRequest.findUniqueOrThrow({ where: { id: row.id } });
      await this.requests.rateIn(tx, fresh, rating, comment);
    });
    return this.get(id);
  }

  /** `POST /v1/resident/uploads` (purpose `service_request`): a photo of my unit for a request I am about to send. */
  async presignPhoto(unitId: string, input: { contentType: string; sizeBytes: number; sha256: string }) {
    const { ctx, unit } = await this.unit(unitId);
    if (input.sizeBytes > PHOTO_MAX_BYTES)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'sizeBytes', code: 'max', message: `at most ${PHOTO_MAX_BYTES} bytes` }],
      });
    const ext = input.contentType.split('/')[1] ?? 'jpg';
    return this.documents.presign(ctx, {
      kind: 'service_photo',
      scopeType: 'unit',
      scopeId: unit.id,
      fileName: `service-request.${ext}`,
      title: 'ภาพประกอบการแจ้งซ่อม',
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    });
  }
}

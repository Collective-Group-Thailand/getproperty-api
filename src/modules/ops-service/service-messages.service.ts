import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Prisma,
  type ServiceMessage,
  type ServiceMessageAuthor,
  type ServiceRequestStatus,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { SERVICE_REQUEST_SUBJECT, WORK_ORDER_SUBJECT } from './service-requests.service';
import { ACTIVE_WORK_ORDER_STATUSES, MESSAGE_MAX_LENGTH } from './service-rules';

/** A message thread: a repair request's (resident, office, technicians) or a work order's without a request. */
export interface ServiceThread {
  tenantId: string;
  buildingId: string;
  serviceRequestId: string | null;
  workOrderId: string | null;
  unitId: string | null;
  requesterPartyId: string | null;
  requestStatus: ServiceRequestStatus | null;
}

export interface MessageAuthor {
  kind: ServiceMessageAuthor;
  userId: string | null;
  partyId: string | null;
  name: string;
}

/** A thread takes no new message once its request ended (closed / cancelled) or its work order was cancelled. */
const ENDED_REQUEST: readonly ServiceRequestStatus[] = ['closed', 'cancelled'];
const MAX_LISTED = 500;

/**
 * Message threads of repair requests and work orders (LIFF #23, D-072, D-218): the resident, the office and the
 * assigned technician talk inside the app — nobody sees another's phone number. A request has one thread; a
 * technician writing on the work order of a request writes into the request's thread (`work_order_id` kept); a work
 * order without a request (preventive, inspection) has its own office ↔ technician thread. Messages are append-only;
 * each post is audited and emits `service_request.message` (realtime to the unit, the requester's and the assignees'
 * logins; LINE to the resident and the technician who did not write it, quiet hours apply).
 */
@Injectable()
export class ServiceMessagesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** The thread of a request (inside its tenant transaction). */
  async requestThread(tx: Tx, requestId: string): Promise<ServiceThread> {
    const sr = this.found(await tx.serviceRequest.findUnique({ where: { id: requestId } }));
    return {
      tenantId: sr.tenantId,
      buildingId: sr.buildingId,
      serviceRequestId: sr.id,
      workOrderId: null,
      unitId: sr.unitId,
      requesterPartyId: sr.requesterPartyId,
      requestStatus: sr.status,
    };
  }

  /** The thread of a work order: its request's thread when it has one, else its own. */
  async workOrderThread(tx: Tx, workOrderId: string): Promise<ServiceThread> {
    const wo = this.found(await tx.workOrder.findUnique({ where: { id: workOrderId } }));
    if (wo.serviceRequestId)
      return { ...(await this.requestThread(tx, wo.serviceRequestId)), workOrderId: wo.id };
    return {
      tenantId: wo.tenantId,
      buildingId: wo.buildingId,
      serviceRequestId: null,
      workOrderId: wo.id,
      unitId: wo.unitId,
      requesterPartyId: null,
      requestStatus: null,
    };
  }

  private where(thread: ServiceThread): Prisma.ServiceMessageWhereInput {
    return thread.serviceRequestId
      ? { serviceRequestId: thread.serviceRequestId }
      : { workOrderId: thread.workOrderId, serviceRequestId: null };
  }

  /** The thread's messages, oldest first (at most the last 500). */
  async list(tx: Tx, thread: ServiceThread): Promise<ServiceMessage[]> {
    const rows = await tx.serviceMessage.findMany({
      where: { tenantId: thread.tenantId, ...this.where(thread) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_LISTED,
    });
    return rows.reverse();
  }

  /** Appends a message (trimmed, 1–2000 characters) with its audit row and `service_request.message`. */
  async post(tx: Tx, thread: ServiceThread, author: MessageAuthor, text: string): Promise<ServiceMessage> {
    const body = text.trim();
    if (!body || body.length > MESSAGE_MAX_LENGTH)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'body', code: 'length', message: `1–${MESSAGE_MAX_LENGTH} characters` }],
      });
    if (thread.requestStatus && ENDED_REQUEST.includes(thread.requestStatus))
      throw new DomainException('service_request.invalid_state', {
        params: { status: thread.requestStatus },
      });
    if (thread.workOrderId && !thread.serviceRequestId) {
      const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: thread.workOrderId } });
      if (wo.status === 'cancelled')
        throw new DomainException('work_order.invalid_state', { params: { status: wo.status } });
    }
    const message = await tx.serviceMessage.create({
      data: {
        tenantId: thread.tenantId,
        buildingId: thread.buildingId,
        serviceRequestId: thread.serviceRequestId,
        workOrderId: thread.workOrderId,
        authorKind: author.kind,
        authorUserId: author.userId,
        authorPartyId: author.partyId,
        authorName: (author.name.trim() || author.kind).slice(0, 200),
        body,
        createdAt: this.clock.now(),
        createdBy: userIdOf(RequestContext.actor()),
      },
    });
    const assignees = await tx.workOrder.findMany({
      where: thread.serviceRequestId
        ? { serviceRequestId: thread.serviceRequestId, status: { in: [...ACTIVE_WORK_ORDER_STATUSES] } }
        : { id: thread.workOrderId! },
      select: { id: true, assigneePartyId: true, assigneeUserId: true },
    });
    await this.audit.record(tx, {
      action: 'service_request.message_posted',
      tenantId: thread.tenantId,
      buildingId: thread.buildingId,
      subjectType: thread.serviceRequestId ? SERVICE_REQUEST_SUBJECT : WORK_ORDER_SUBJECT,
      subjectId: thread.serviceRequestId ?? thread.workOrderId!,
      metadata: { messageId: message.id, authorKind: author.kind, length: body.length },
    });
    await this.events.record(tx, {
      type: 'service_request.message',
      aggregateType: thread.serviceRequestId ? 'service_request' : 'work_order',
      aggregateId: thread.serviceRequestId ?? thread.workOrderId!,
      tenantId: thread.tenantId,
      buildingId: thread.buildingId,
      payload: {
        messageId: message.id,
        serviceRequestId: thread.serviceRequestId,
        workOrderId: thread.workOrderId,
        workOrderIds: assignees.map((w) => w.id),
        authorKind: author.kind,
        authorPartyId: author.partyId,
        authorUserId: author.userId,
        unitId: thread.serviceRequestId ? thread.unitId : null,
        requesterPartyId: thread.requesterPartyId,
        assigneePartyIds: [
          ...new Set(assignees.map((w) => w.assigneePartyId).filter((x): x is string => !!x)),
        ],
        assigneeUserIds: [...new Set(assignees.map((w) => w.assigneeUserId).filter((x): x is string => !!x))],
      },
    });
    return message;
  }

  // ------------------------------------------------------------------------------------------------- operators

  /** The thread of a request for the office (404 for another tenant's or outside my buildings). */
  private async operatorRequest(tx: Tx, ctx: TenantContext, requestId: string): Promise<ServiceThread> {
    this.found(
      await tx.serviceRequest.findFirst({
        where: this.own(ctx, {
          id: requestId,
          ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}),
        }),
        select: { id: true },
      }),
    );
    return this.requestThread(tx, requestId);
  }

  private async operatorWorkOrder(tx: Tx, ctx: TenantContext, workOrderId: string): Promise<ServiceThread> {
    this.found(
      await tx.workOrder.findFirst({
        where: this.own(ctx, {
          id: workOrderId,
          ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}),
        }),
        select: { id: true },
      }),
    );
    return this.workOrderThread(tx, workOrderId);
  }

  /** The office author: my login's display name (else the tenant's) — never a phone number. */
  private async officeAuthor(ctx: TenantContext): Promise<MessageAuthor> {
    const userId = userIdOf(RequestContext.actor());
    if (!userId) throw new DomainException('auth.unauthenticated');
    const [user, tenant] = await this.db.platform((tx) =>
      Promise.all([
        tx.userAccount.findUnique({ where: { id: userId }, select: { displayName: true } }),
        tx.tenant.findUnique({ where: { id: ctx.tenantId }, select: { displayName: true } }),
      ]),
    );
    return {
      kind: 'office',
      userId,
      partyId: null,
      name: user?.displayName || tenant?.displayName || 'office',
    };
  }

  listForRequest(ctx: TenantContext, requestId: string) {
    return this.db.tenant(ctx, async (tx) => this.list(tx, await this.operatorRequest(tx, ctx, requestId)));
  }

  async postToRequest(ctx: TenantContext, requestId: string, body: string) {
    const author = await this.officeAuthor(ctx);
    return this.db.tenant(ctx, async (tx) =>
      this.post(tx, await this.operatorRequest(tx, ctx, requestId), author, body),
    );
  }

  listForWorkOrder(ctx: TenantContext, workOrderId: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.list(tx, await this.operatorWorkOrder(tx, ctx, workOrderId)),
    );
  }

  async postToWorkOrder(ctx: TenantContext, workOrderId: string, body: string) {
    const author = await this.officeAuthor(ctx);
    return this.db.tenant(ctx, async (tx) =>
      this.post(tx, await this.operatorWorkOrder(tx, ctx, workOrderId), author, body),
    );
  }
}

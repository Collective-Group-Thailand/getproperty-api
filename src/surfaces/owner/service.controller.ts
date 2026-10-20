import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { workflowDefinition } from '@core/workflow/definitions';
import { allowedEvents } from '@core/workflow/engine';
import {
  ResidentServiceRequestsService,
  TechnicianWorkOrdersService,
} from '@modules/ops-service/field-access.service';
import { MaintenancePlansService } from '@modules/ops-service/maintenance-plans.service';
import { ServiceCategoriesService } from '@modules/ops-service/service-categories.service';
import { ServiceMessagesService } from '@modules/ops-service/service-messages.service';
import {
  SERVICE_REQUEST_SUBJECT,
  type ServiceRequestRow,
  ServiceRequestsService,
  WORK_ORDER_SUBJECT,
} from '@modules/ops-service/service-requests.service';
import { requestOperatorActions, workOrderActions } from '@modules/ops-service/service-rules';
import {
  type WorkOrderCreateInput,
  type WorkOrderRow,
  WorkOrdersService,
} from '@modules/ops-service/work-orders.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  type Type,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso } from '../shared/mappers';
import { ApiSurface, type Surface, SURFACES } from '../surfaces';
import { ifMatchVersion } from './assets.mappers';
import { ReasonDto } from './governance.dto';
import {
  CategoryListQuery,
  CostLineCreateDto,
  MaintenancePlanCreateDto,
  MaintenancePlanDto,
  MaintenancePlanQuery,
  MaintenancePlansDto,
  MaintenancePlanUpdateDto,
  ResidentCategoryQuery,
  ResidentRequestListQuery,
  ResidentServiceRequestCreateDto,
  ResidentServiceRequestDto,
  ServiceCategoriesDto,
  ServiceCategoryDto,
  ServiceCategoryPutDto,
  ServiceMessageCreateDto,
  ServiceMessageDto,
  ServiceMessagesDto,
  ServiceRatingDto,
  ServiceRequestCreateDto,
  ServiceRequestDto,
  ServiceRequestListQuery,
  ServiceTimelineDto,
  ServiceTriageDto,
  TechnicianPhotoPresignDto,
  TechnicianPhotoUploadDto,
  TechnicianWorkOrderDto,
  TechnicianWorkOrdersDto,
  windowOf,
  WorkOrderAssignDto,
  WorkOrderCreateDto,
  WorkOrderDto,
  WorkOrderListQuery,
  WorkOrderNoteDto,
  WorkOrderPhotoAttachDto,
} from './service.dto';
import {
  CATEGORY_EXAMPLE,
  categoryDto,
  MAINTENANCE_PLAN_EXAMPLE,
  maintenancePlanDto,
  MESSAGE_EXAMPLE,
  RESIDENT_REQUEST_EXAMPLE,
  residentServiceRequestDto,
  SERVICE_REQUEST_EXAMPLE,
  serviceMessageDto,
  serviceRequestDto,
  technicianWorkOrderDto,
  WORK_ORDER_EXAMPLE,
  workOrderDto,
} from './service.mappers';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const SR_STATE = ['service_request.invalid_state', 'workflow.invalid_transition'] as const;
const WO_STATE = ['work_order.invalid_state', 'concurrency.stale'] as const;
const SERVICE_DEF = workflowDefinition('service_request');
const TECH_EXAMPLE = {
  ...WORK_ORDER_EXAMPLE,
  nextActions: ['accept', 'check-in', 'complete'],
  requestDescription: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
  categoryKey: 'plumbing',
  requestPhotoIds: [FAKE.uuid],
  buildingName: 'อาคาร A',
  photos: [
    { id: FAKE.uuid, role: 'report', url: 'https://storage.example.com/service-photo?X-Amz-Signature=abc' },
  ],
  rating: null,
  ratingComment: null,
  preferredVisit: 'afternoon',
};
const MESSAGE_ERRORS = ['http.not_found', 'http.bad_request', 'validation.failed'] as const;
const me = (): string | null => userIdOf(RequestContext.actor());

/** Operator next actions of a request (static definition v1 + the instance state). */
function srActions(r: ServiceRequestRow): string[] {
  const state = r.workflowInstance?.state;
  return requestOperatorActions(r.status, state ? allowedEvents(SERVICE_DEF, state) : [], r.inWarranty);
}

/** Body of a work-order create → service input (dates parsed). */
function woInput(body: WorkOrderCreateDto): WorkOrderCreateInput {
  const { scheduledAt: _at, scheduledUntil: _until, ...rest } = body;
  return { ...rest, ...windowOf(body) };
}

function woActions(w: WorkOrderRow, audience: 'operator' | 'assignee'): string[] {
  return workOrderActions(w.status, audience, w.serviceRequest?.status === 'waiting_parts');
}

async function srDtos(requests: ServiceRequestsService, ctx: TenantContext, rows: ServiceRequestRow[]) {
  const photos = await requests.photosFor(
    ctx,
    SERVICE_REQUEST_SUBJECT,
    rows.map((r) => r.id),
  );
  return rows.map((r) => serviceRequestDto(r, photos.get(r.id)?.get('report') ?? [], srActions(r)));
}

async function woDtos(requests: ServiceRequestsService, ctx: TenantContext, rows: WorkOrderRow[]) {
  const photos = await requests.photosFor(
    ctx,
    WORK_ORDER_SUBJECT,
    rows.map((r) => r.id),
  );
  return rows.map((w) => workOrderDto(w, photos.get(w.id), woActions(w, 'operator')));
}

// ======================================================================================== owner / staff

/**
 * Service requests for operators (`/v1/{owner,staff}/service-requests`, B5.1, D-072): the queue of a building with
 * its SLA (D-159), triage, work orders, close / reopen / cancel. Staff limited to buildings see theirs only (D-090);
 * another tenant's request is a 404.
 */
export function serviceRequestsController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.serviceRequests`)
  @ApiSurface(SURFACES[surface])
  @Controller(`${surface}/service-requests`)
  class ServiceRequestsController {
    constructor(
      readonly requests: ServiceRequestsService,
      readonly workOrders: WorkOrdersService,
      readonly messages: ServiceMessagesService,
    ) {}

    @Get()
    @TenantScoped()
    @Can('service_request.read')
    @ApiEndpoint({
      id: `${surface}.serviceRequests.list`,
      summary: 'Repair requests',
      description:
        'Requests of my buildings, newest first, with category, SLA due time and breach (D-159), warranty referral (D-153), automatic reason (D-034), photos and work orders. Filters: building, unit, status, category, warranty, open.',
      implements: ['D-072', 'D-090', 'D-159'],
    })
    @ApiPaginated(ServiceRequestDto, { example: SERVICE_REQUEST_EXAMPLE })
    @ApiStandardErrors('validation.failed', ...T)
    async list(
      @CurrentTenant() ctx: TenantContext,
      @Query() q: ServiceRequestListQuery,
    ): Promise<Page<ServiceRequestDto>> {
      const { rows, total } = await this.requests.list(ctx, { ...q, ...toSkipTake(q) });
      return paginated(await srDtos(this.requests, ctx, rows), total, q);
    }

    @Post()
    @TenantScoped()
    @Can('service_request.handle')
    @Idempotent({ optional: true })
    @ApiEndpoint({
      id: `${surface}.serviceRequests.create`,
      summary: 'Report a repair request',
      description:
        'For a unit, an asset item or a common area of a building, with a category (its SLA hours start now, D-159) and up to 10 uploaded `service_photo` files. A request inside a getbuild warranty is referred to the developer at once (`inWarranty`, D-153).',
      implements: ['D-072', 'D-153', 'D-159'],
    })
    @ApiJsonBody(ServiceRequestCreateDto, {
      unitId: FAKE.uuid,
      categoryId: FAKE.uuid,
      description: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
      priority: 'normal',
      photoDocumentIds: [FAKE.uuid],
    })
    @ApiSuccess(201, {
      description: 'Reported',
      type: ServiceRequestDto,
      example: { ...SERVICE_REQUEST_EXAMPLE, reporterKind: surface === 'staff' ? 'staff' : 'owner' },
    })
    @ApiStandardErrors(...WRITE)
    async create(
      @CurrentTenant() ctx: TenantContext,
      @Body() body: ServiceRequestCreateDto,
    ): Promise<ServiceRequestDto> {
      const row = await this.requests.create(ctx, body);
      return (await srDtos(this.requests, ctx, [row]))[0]!;
    }

    @Get(':serviceRequestId')
    @TenantScoped()
    @Can('service_request.read')
    @UseEtag((r: ServiceRequestDto) => etagOf(r.id, r.version))
    @ApiEndpoint({
      id: `${surface}.serviceRequests.get`,
      summary: 'One repair request',
      description: 'With photos, work orders, SLA and the actions allowed now.',
      implements: ['D-072'],
    })
    @ApiSuccess(200, {
      description: 'The request',
      type: ServiceRequestDto,
      example: SERVICE_REQUEST_EXAMPLE,
    })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async get(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
    ): Promise<ServiceRequestDto> {
      return (await srDtos(this.requests, ctx, [await this.requests.get(ctx, id)]))[0]!;
    }

    @Get(':serviceRequestId/timeline')
    @TenantScoped()
    @Can('service_request.read')
    @ApiEndpoint({
      id: `${surface}.serviceRequests.timeline`,
      summary: 'Timeline of a request',
      description: 'Its workflow events: state changes, SLA warnings and the breach (D-159).',
      implements: ['D-072', 'D-159'],
    })
    @ApiSuccess(200, {
      description: 'Events',
      type: ServiceTimelineDto,
      example: { data: [{ from: null, to: 'new', event: 'start', at: FAKE.dateTime }] },
    })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async timeline(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
    ): Promise<ServiceTimelineDto> {
      const rows = await this.requests.timeline(ctx, id);
      return {
        data: rows.map((e) => ({ from: e.fromState, to: e.toState, event: e.event, at: iso(e.occurredAt) })),
      };
    }

    @Post(':serviceRequestId/actions/triage')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.serviceRequests.triage`,
      summary: 'Triage a request',
      description: 'Confirms the category and priority of a new request (its SLA clock keeps running).',
      implements: ['D-072', 'D-159'],
    })
    @ApiJsonBody(ServiceTriageDto, { priority: 'high' })
    @ApiSuccess(200, {
      description: 'Triaged',
      type: ServiceRequestDto,
      example: { ...SERVICE_REQUEST_EXAMPLE, status: 'triaged', priority: 'high' },
    })
    @ApiStandardErrors(...WRITE, ...SR_STATE)
    async triage(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
      @Body() body: ServiceTriageDto,
    ): Promise<ServiceRequestDto> {
      return (await srDtos(this.requests, ctx, [await this.requests.triage(ctx, id, body)]))[0]!;
    }

    @Post(':serviceRequestId/actions/close')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.serviceRequests.close`,
      summary: 'Close a done request',
      description: 'Closes a request whose work is done without waiting for the resident’s rating.',
      implements: ['D-072'],
    })
    @ApiSuccess(200, {
      description: 'Closed',
      type: ServiceRequestDto,
      example: { ...SERVICE_REQUEST_EXAMPLE, status: 'closed', nextActions: [] },
    })
    @ApiStandardErrors(...WRITE, ...SR_STATE)
    async close(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
    ): Promise<ServiceRequestDto> {
      return (await srDtos(this.requests, ctx, [await this.requests.close(ctx, id)]))[0]!;
    }

    @Post(':serviceRequestId/actions/reopen')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.serviceRequests.reopen`,
      summary: 'Reopen a done request',
      description: 'The work did not fix it: back to triage with a reason (a new work order follows).',
      implements: ['D-072'],
    })
    @ApiJsonBody(ReasonDto, { reason: 'ยังรั่วอยู่' })
    @ApiSuccess(200, {
      description: 'Reopened',
      type: ServiceRequestDto,
      example: { ...SERVICE_REQUEST_EXAMPLE, status: 'triaged' },
    })
    @ApiStandardErrors(...WRITE, ...SR_STATE)
    async reopen(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
      @Body() body: ReasonDto,
    ): Promise<ServiceRequestDto> {
      return (await srDtos(this.requests, ctx, [await this.requests.reopen(ctx, id, body.reason)]))[0]!;
    }

    @Post(':serviceRequestId/actions/cancel')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.serviceRequests.cancel`,
      summary: 'Cancel a request',
      description: 'With a reason; its active work orders are cancelled too (audited).',
      implements: ['D-072'],
    })
    @ApiJsonBody(ReasonDto, { reason: 'แจ้งซ้ำ' })
    @ApiSuccess(200, {
      description: 'Cancelled',
      type: ServiceRequestDto,
      example: { ...SERVICE_REQUEST_EXAMPLE, status: 'cancelled', nextActions: [] },
    })
    @ApiStandardErrors(...WRITE, ...SR_STATE)
    async cancel(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
      @Body() body: ReasonDto,
    ): Promise<ServiceRequestDto> {
      return (await srDtos(this.requests, ctx, [await this.requests.cancel(ctx, id, body.reason)]))[0]!;
    }

    @Post(':serviceRequestId/work-orders')
    @TenantScoped()
    @Can('service_request.handle')
    @Idempotent({ optional: true })
    @ApiEndpoint({
      id: `${surface}.serviceRequests.createWorkOrder`,
      summary: 'Open a work order for a request',
      description:
        'A repair (or inspection) on the request’s unit / asset item, optionally assigned at once to a staff member or an external technician with a visit window. 409 `service_request.in_warranty` for a request referred to the developer (D-153).',
      implements: ['D-072', 'D-153'],
    })
    @ApiJsonBody(WorkOrderCreateDto, {
      kind: 'repair',
      title: 'เปลี่ยนก๊อกน้ำ',
      assigneePartyId: FAKE.uuid,
      scheduledAt: FAKE.dateTime,
      scheduledUntil: '2026-11-01T12:00:00+07:00',
    })
    @ApiSuccess(201, { description: 'Opened', type: WorkOrderDto, example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors(...WRITE, ...SR_STATE, 'service_request.in_warranty', 'work_order.invalid_state')
    async createWorkOrder(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
      @Body() body: WorkOrderCreateDto,
    ): Promise<WorkOrderDto> {
      const row = await this.workOrders.create(ctx, { ...woInput(body), serviceRequestId: id });
      return (await woDtos(this.requests, ctx, [row]))[0]!;
    }

    @Get(':serviceRequestId/messages')
    @TenantScoped()
    @Can('service_request.read')
    @ApiEndpoint({
      id: `${surface}.serviceRequests.messages`,
      summary: 'Message thread of a request',
      description:
        'The resident, the office and the assigned technician talk inside the apps — no phone numbers are exchanged (D-072, D-218). Oldest first.',
      implements: ['D-072', 'D-218'],
    })
    @ApiSuccess(200, {
      description: 'Messages',
      type: ServiceMessagesDto,
      example: { data: [MESSAGE_EXAMPLE] },
    })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async listMessages(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
    ): Promise<ServiceMessagesDto> {
      return { data: (await this.messages.listForRequest(ctx, id)).map((m) => serviceMessageDto(m, me())) };
    }

    @Post(':serviceRequestId/messages')
    @TenantScoped()
    @Can('service_request.handle')
    @Idempotent({ optional: true })
    @ApiEndpoint({
      id: `${surface}.serviceRequests.postMessage`,
      summary: 'Write to the resident and the technician',
      description:
        'As the office (my display name). The resident and the assigned technician are told on LINE (quiet hours apply) and in realtime (`service_request.message`); 409 once the request is closed or cancelled.',
      implements: ['D-072', 'D-218'],
    })
    @ApiJsonBody(ServiceMessageCreateDto, { body: 'ช่างจะเข้าไปพรุ่งนี้ 10 โมงนะคะ' })
    @ApiSuccess(201, {
      description: 'Posted',
      type: ServiceMessageDto,
      example: { ...MESSAGE_EXAMPLE, mine: true },
    })
    @ApiStandardErrors(...WRITE, 'service_request.invalid_state')
    async postMessage(
      @CurrentTenant() ctx: TenantContext,
      @Param('serviceRequestId', ParseUUIDPipe) id: string,
      @Body() body: ServiceMessageCreateDto,
    ): Promise<ServiceMessageDto> {
      return serviceMessageDto(await this.messages.postToRequest(ctx, id, body.body), me());
    }
  }
  return ServiceRequestsController;
}

/**
 * Work orders for operators (`/v1/{owner,staff}/work-orders`, B5.1): list (mine for the staff PWA), open, assign to
 * staff or an external technician, the field steps with before / after photos and parts / costs, and — owner — verify
 * or cancel.
 */
export function workOrdersController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.workOrders`)
  @ApiSurface(SURFACES[surface])
  @Controller(`${surface}/work-orders`)
  class WorkOrdersController {
    constructor(
      readonly workOrders: WorkOrdersService,
      readonly requests: ServiceRequestsService,
      readonly messages: ServiceMessagesService,
    ) {}

    @Get(':workOrderId/messages')
    @TenantScoped()
    @Can('service_request.read')
    @ApiEndpoint({
      id: `${surface}.workOrders.messages`,
      summary: 'Message thread of a work order',
      description:
        'The thread of its request (resident, office, technician) or, for a work order without a request, the office ↔ technician thread (D-072, D-218). Oldest first.',
      implements: ['D-072', 'D-218'],
    })
    @ApiSuccess(200, {
      description: 'Messages',
      type: ServiceMessagesDto,
      example: { data: [MESSAGE_EXAMPLE] },
    })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async listMessages(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
    ): Promise<ServiceMessagesDto> {
      return { data: (await this.messages.listForWorkOrder(ctx, id)).map((m) => serviceMessageDto(m, me())) };
    }

    @Post(':workOrderId/messages')
    @TenantScoped()
    @Can('service_request.handle')
    @Idempotent({ optional: true })
    @ApiEndpoint({
      id: `${surface}.workOrders.postMessage`,
      summary: 'Write into a work order’s thread',
      description:
        'As the office. 409 once the request ended or the work order was cancelled. The technician (and the resident, for a request) are told.',
      implements: ['D-072', 'D-218'],
    })
    @ApiJsonBody(ServiceMessageCreateDto, { body: 'กุญแจห้องอยู่ที่สำนักงานนะคะ' })
    @ApiSuccess(201, {
      description: 'Posted',
      type: ServiceMessageDto,
      example: { ...MESSAGE_EXAMPLE, mine: true },
    })
    @ApiStandardErrors(...WRITE, 'service_request.invalid_state', 'work_order.invalid_state')
    async postMessage(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
      @Body() body: ServiceMessageCreateDto,
    ): Promise<ServiceMessageDto> {
      return serviceMessageDto(await this.messages.postToWorkOrder(ctx, id, body.body), me());
    }

    private async one(ctx: TenantContext, row: WorkOrderRow): Promise<WorkOrderDto> {
      return (await woDtos(this.requests, ctx, [row]))[0]!;
    }

    @Get()
    @TenantScoped()
    @Can('service_request.read')
    @ApiEndpoint({
      id: `${surface}.workOrders.list`,
      summary: 'Work orders',
      description:
        'Work orders of my buildings by visit time; `mine=true` = assigned to me (staff PWA). Filters: building, status, kind, request, active.',
      implements: ['D-072', 'D-090'],
    })
    @ApiPaginated(WorkOrderDto, { example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors('validation.failed', ...T)
    async list(
      @CurrentTenant() ctx: TenantContext,
      @Query() q: WorkOrderListQuery,
    ): Promise<Page<WorkOrderDto>> {
      const { rows, total } = await this.workOrders.list(ctx, {
        ...q,
        assigneeUserId: q.mine ? (userIdOf(RequestContext.actor()) ?? undefined) : undefined,
        ...toSkipTake(q),
      });
      return paginated(await woDtos(this.requests, ctx, rows), total, q);
    }

    @Post()
    @TenantScoped()
    @Can('service_request.handle')
    @Idempotent({ optional: true })
    @ApiEndpoint({
      id: `${surface}.workOrders.create`,
      summary: 'Open a work order',
      description:
        'For a request, an asset item (preventive: required), a unit or a common area; optionally assigned with a visit window.',
      implements: ['D-072'],
    })
    @ApiJsonBody(WorkOrderCreateDto, {
      kind: 'inspection',
      title: 'ตรวจสภาพปั๊มน้ำ',
      buildingId: FAKE.buildingId,
      assigneeUserId: FAKE.uuid,
    })
    @ApiSuccess(201, { description: 'Opened', type: WorkOrderDto, example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors(...WRITE, ...SR_STATE, 'service_request.in_warranty', 'work_order.invalid_state')
    async create(
      @CurrentTenant() ctx: TenantContext,
      @Body() body: WorkOrderCreateDto,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.create(ctx, woInput(body)));
    }

    @Get(':workOrderId')
    @TenantScoped()
    @Can('service_request.read')
    @UseEtag((w: WorkOrderDto) => etagOf(w.id, w.version))
    @ApiEndpoint({
      id: `${surface}.workOrders.get`,
      summary: 'One work order',
      description: 'With assignee, visit window, photos, cost lines and the actions allowed now.',
      implements: ['D-072'],
    })
    @ApiSuccess(200, { description: 'The work order', type: WorkOrderDto, example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async get(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.get(ctx, id));
    }

    @Post(':workOrderId/actions/assign')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.assign`,
      summary: 'Assign (or re-assign) a work order',
      description:
        'To a member who handles service requests in the building (staff PWA) or an external technician party with a LINE id (technician app, scope `work_order:<id>`), with an optional visit window; the assignee is notified and the request moves to assigned. Re-assigning before check-in is allowed.',
      implements: ['D-072', 'D-154'],
    })
    @ApiJsonBody(WorkOrderAssignDto, { assigneePartyId: FAKE.uuid, scheduledAt: FAKE.dateTime })
    @ApiSuccess(200, { description: 'Assigned', type: WorkOrderDto, example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors(...WRITE, ...WO_STATE, 'workflow.invalid_transition')
    async assign(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
      @Body() body: WorkOrderAssignDto,
    ): Promise<WorkOrderDto> {
      return this.one(
        ctx,
        await this.workOrders.assign(ctx, id, {
          assigneeUserId: body.assigneeUserId ?? null,
          assigneePartyId: body.assigneePartyId ?? null,
          ...windowOf(body),
        }),
      );
    }

    @Post(':workOrderId/actions/check-in')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.checkIn`,
      summary: 'Check in on site',
      description: 'The work starts; the request is in progress.',
      implements: ['D-072'],
    })
    @ApiSuccess(200, {
      description: 'In progress',
      type: WorkOrderDto,
      example: { ...WORK_ORDER_EXAMPLE, status: 'in_progress', checkedInAt: FAKE.dateTime },
    })
    @ApiStandardErrors(...WRITE, ...WO_STATE)
    async checkIn(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.act(ctx, id, 'check-in'));
    }

    @Post(':workOrderId/actions/wait-parts')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.waitParts`,
      summary: 'Waiting for parts',
      description:
        'The request shows it is waiting for parts (its SLA keeps running); `resume` when they arrive.',
      implements: ['D-072', 'D-159'],
    })
    @ApiJsonBody(WorkOrderNoteDto, { note: 'รอก๊อกรุ่นเดิม 2 วัน' })
    @ApiSuccess(200, { description: 'Waiting', type: WorkOrderDto, example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors(...WRITE, ...WO_STATE)
    async waitParts(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
      @Body() body: WorkOrderNoteDto,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.act(ctx, id, 'wait-parts', body));
    }

    @Post(':workOrderId/actions/resume')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.resume`,
      summary: 'Parts arrived',
      description: 'The request is in progress again.',
      implements: ['D-072'],
    })
    @ApiSuccess(200, { description: 'Resumed', type: WorkOrderDto, example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors(...WRITE, ...WO_STATE)
    async resume(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.act(ctx, id, 'resume'));
    }

    @Post(':workOrderId/actions/complete')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.complete`,
      summary: 'Complete a work order',
      description:
        'Done with at least one after photo (422 `work_order.photo_required`, D-072); when no other work order of the request is open the request is done and the resident is asked to rate it.',
      implements: ['D-072'],
    })
    @ApiJsonBody(WorkOrderNoteDto, { note: 'เปลี่ยนก๊อกใหม่แล้ว ทดสอบไม่รั่ว' })
    @ApiSuccess(200, {
      description: 'Done',
      type: WorkOrderDto,
      example: {
        ...WORK_ORDER_EXAMPLE,
        status: 'done',
        completedAt: FAKE.dateTime,
        afterPhotoIds: [FAKE.uuid],
      },
    })
    @ApiStandardErrors(...WRITE, ...WO_STATE, 'work_order.photo_required')
    async complete(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
      @Body() body: WorkOrderNoteDto,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.act(ctx, id, 'complete', body));
    }

    @Post(':workOrderId/photos')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.attachPhoto`,
      summary: 'Attach a before / after photo',
      description: 'An uploaded file of kind `service_photo` (`…/files/presign`), at most 10 per role.',
      implements: ['D-072'],
    })
    @ApiJsonBody(WorkOrderPhotoAttachDto, { documentId: FAKE.uuid, role: 'after' })
    @ApiSuccess(200, { description: 'Attached', type: WorkOrderDto, example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors(...WRITE, ...WO_STATE)
    async attachPhoto(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
      @Body() body: WorkOrderPhotoAttachDto,
    ): Promise<WorkOrderDto> {
      return this.one(
        ctx,
        await this.workOrders.attachPhoto(ctx, id, {
          documentId: body.documentId,
          role: body.role,
        }),
      );
    }

    @Post(':workOrderId/cost-lines')
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.addCost`,
      summary: 'Add a part / labour / travel cost',
      description:
        'THB as decimal strings (amount = quantity × unit price, rounded to satang); the work order’s total follows, audited; the costs reach the income & expense export by completion month (B4.5).',
      implements: ['D-072', 'D-046'],
    })
    @ApiJsonBody(CostLineCreateDto, {
      kind: 'part',
      description: 'ก๊อกน้ำ',
      quantity: '1',
      unitPrice: '350.00',
    })
    @ApiSuccess(201, { description: 'Added', type: WorkOrderDto, example: WORK_ORDER_EXAMPLE })
    @ApiStandardErrors(...WRITE, ...WO_STATE)
    async addCost(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
      @Body() body: CostLineCreateDto,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.addCost(ctx, id, body));
    }

    @Delete(':workOrderId/cost-lines/:costLineId')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.removeCost`,
      summary: 'Remove a cost line',
      description: 'Before the work order is verified; audited.',
      implements: ['D-072'],
    })
    @ApiSuccess(200, {
      description: 'Removed',
      type: WorkOrderDto,
      example: { ...WORK_ORDER_EXAMPLE, costLines: [] },
    })
    @ApiStandardErrors(...WRITE, ...WO_STATE)
    async removeCost(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
      @Param('costLineId', ParseUUIDPipe) lineId: string,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.removeCost(ctx, id, lineId));
    }

    @Post(':workOrderId/actions/cancel')
    @HttpCode(200)
    @TenantScoped()
    @Can('service_request.handle')
    @ApiEndpoint({
      id: `${surface}.workOrders.cancel`,
      summary: 'Cancel a work order',
      description: 'With a reason; a request left without active work goes back to triage.',
      implements: ['D-072'],
    })
    @ApiJsonBody(ReasonDto, { reason: 'ช่างติดงาน เปลี่ยนผู้รับงาน' })
    @ApiSuccess(200, {
      description: 'Cancelled',
      type: WorkOrderDto,
      example: { ...WORK_ORDER_EXAMPLE, status: 'cancelled', nextActions: [] },
    })
    @ApiStandardErrors(...WRITE, ...WO_STATE)
    async cancel(
      @CurrentTenant() ctx: TenantContext,
      @Param('workOrderId', ParseUUIDPipe) id: string,
      @Body() body: ReasonDto,
    ): Promise<WorkOrderDto> {
      return this.one(ctx, await this.workOrders.cancel(ctx, id, body.reason));
    }
  }
  return WorkOrdersController;
}

/** Owner-only step of a work order: verification of the done work (`/v1/owner/work-orders/{id}/actions/verify`). */
@ApiTags('owner.workOrders')
@ApiSurface(SURFACES.owner)
@Controller('owner/work-orders')
export class OwnerWorkOrderVerifyController {
  constructor(
    readonly workOrders: WorkOrdersService,
    readonly requests: ServiceRequestsService,
  ) {}

  @Post(':workOrderId/actions/verify')
  @HttpCode(200)
  @TenantScoped()
  @Can('service_request.handle')
  @ApiEndpoint({
    id: 'owner.workOrders.verify',
    summary: 'Verify a done work order',
    description: 'Checks the photos and costs; the costs are final (audited) and the technician scope ends.',
    implements: ['D-072'],
  })
  @ApiSuccess(200, {
    description: 'Verified',
    type: WorkOrderDto,
    example: { ...WORK_ORDER_EXAMPLE, status: 'verified', nextActions: [] },
  })
  @ApiStandardErrors(...WRITE, ...WO_STATE)
  async verify(
    @CurrentTenant() ctx: TenantContext,
    @Param('workOrderId', ParseUUIDPipe) id: string,
  ): Promise<WorkOrderDto> {
    return (await woDtos(this.requests, ctx, [await this.workOrders.verify(ctx, id)]))[0]!;
  }
}

/** Repair categories of the tenant (`/v1/owner/service-categories`, D-072). */
@ApiTags('owner.serviceCategories')
@ApiSurface(SURFACES.owner)
@Controller('owner/service-categories')
export class OwnerServiceCategoriesController {
  constructor(private readonly categories: ServiceCategoriesService) {}

  @Get()
  @TenantScoped()
  @Can('service_request.read')
  @ApiEndpoint({
    id: 'owner.serviceCategories.list',
    summary: 'Repair categories',
    description:
      'Platform defaults (electrical, plumbing, aircon, appliance, structure, pest, cleaning, other) with their SLA hours, replaced per key by the tenant’s own version.',
    implements: ['D-072'],
  })
  @ApiSuccess(200, {
    description: 'Categories',
    type: ServiceCategoriesDto,
    example: { data: [CATEGORY_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: CategoryListQuery,
  ): Promise<ServiceCategoriesDto> {
    return { data: (await this.categories.listFor(ctx, q.includeInactive === true)).map(categoryDto) };
  }

  @Put(':key')
  @TenantScoped()
  @Can('service_category.manage')
  @ApiEndpoint({
    id: 'owner.serviceCategories.put',
    summary: 'Set the tenant’s version of a category',
    description:
      'Overrides a platform key (SLA hours, names, hidden) or adds a category of the tenant (names required). New requests use it; open requests keep the SLA they started with.',
    implements: ['D-072'],
  })
  @ApiJsonBody(ServiceCategoryPutDto, { slaHours: 12 })
  @ApiSuccess(200, {
    description: 'Saved',
    type: ServiceCategoryDto,
    example: { ...CATEGORY_EXAMPLE, slaHours: 12, source: 'tenant' },
  })
  @ApiStandardErrors(...WRITE)
  async put(
    @CurrentTenant() ctx: TenantContext,
    @Param('key') key: string,
    @Body() body: ServiceCategoryPutDto,
  ): Promise<ServiceCategoryDto> {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(key))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'key', code: 'pattern', message: 'snake_case, 2–41 characters' }],
      });
    return categoryDto(await this.categories.put(ctx, key, body));
  }

  @Delete(':key')
  @HttpCode(204)
  @TenantScoped()
  @Can('service_category.manage')
  @ApiEndpoint({
    id: 'owner.serviceCategories.remove',
    summary: 'Remove the tenant’s version of a category',
    description:
      'The platform default applies again (or the tenant’s own category disappears from new requests).',
    implements: ['D-072'],
  })
  @ApiSuccess(204, { description: 'Removed' })
  @ApiStandardErrors(...WRITE)
  async remove(@CurrentTenant() ctx: TenantContext, @Param('key') key: string): Promise<void> {
    await this.categories.remove(ctx, key);
  }
}

/** Preventive maintenance plans (`/v1/owner/maintenance-plans`, B5.1). */
@ApiTags('owner.maintenancePlans')
@ApiSurface(SURFACES.owner)
@Controller('owner/maintenance-plans')
export class OwnerMaintenancePlansController {
  constructor(private readonly plans: MaintenancePlansService) {}

  @Get()
  @TenantScoped()
  @Can('service_request.read')
  @ApiEndpoint({
    id: 'owner.maintenancePlans.list',
    summary: 'Preventive maintenance plans',
    description: 'Plans of my buildings by next due date (filter by building or asset item).',
    implements: ['D-072'],
  })
  @ApiSuccess(200, {
    description: 'Plans',
    type: MaintenancePlansDto,
    example: { data: [MAINTENANCE_PLAN_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: MaintenancePlanQuery,
  ): Promise<MaintenancePlansDto> {
    return { data: (await this.plans.list(ctx, q)).map(maintenancePlanDto) };
  }

  @Post()
  @TenantScoped()
  @Can('maintenance_plan.manage')
  @ApiEndpoint({
    id: 'owner.maintenancePlans.create',
    summary: 'Plan preventive maintenance of equipment',
    description:
      'Every `intervalDays` from `nextDueOn`: the worker opens a preventive work order `leadDays` before (assigned to the plan’s staff member or technician when set).',
    implements: ['D-072'],
  })
  @ApiJsonBody(MaintenancePlanCreateDto, {
    assetItemId: FAKE.uuid,
    title: 'ล้างและตรวจปั๊มน้ำ',
    intervalDays: 90,
    nextDueOn: FAKE.date,
  })
  @ApiSuccess(201, { description: 'Planned', type: MaintenancePlanDto, example: MAINTENANCE_PLAN_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: MaintenancePlanCreateDto,
  ): Promise<MaintenancePlanDto> {
    return maintenancePlanDto(await this.plans.create(ctx, body));
  }

  @Get(':maintenancePlanId')
  @TenantScoped()
  @Can('service_request.read')
  @UseEtag((p: MaintenancePlanDto) => etagOf(p.id, p.version))
  @ApiEndpoint({
    id: 'owner.maintenancePlans.get',
    summary: 'One maintenance plan',
    description: 'With its last work order.',
    implements: ['D-072'],
  })
  @ApiSuccess(200, { description: 'The plan', type: MaintenancePlanDto, example: MAINTENANCE_PLAN_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('maintenancePlanId', ParseUUIDPipe) id: string,
  ): Promise<MaintenancePlanDto> {
    return maintenancePlanDto(await this.plans.get(ctx, id));
  }

  @Patch(':maintenancePlanId')
  @TenantScoped()
  @Can('maintenance_plan.manage')
  @UseEtag((p: MaintenancePlanDto) => etagOf(p.id, p.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.maintenancePlans.update',
    summary: 'Change a maintenance plan',
    description: 'Interval, lead days, next due date, assignee; `isActive=false` pauses it.',
    implements: ['D-072'],
  })
  @ApiJsonBody(MaintenancePlanUpdateDto, { intervalDays: 60, isActive: true })
  @ApiSuccess(200, { description: 'Changed', type: MaintenancePlanDto, example: MAINTENANCE_PLAN_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('maintenancePlanId', ParseUUIDPipe) id: string,
    @Body() body: MaintenancePlanUpdateDto,
    @IfMatch() ifMatch?: string,
  ): Promise<MaintenancePlanDto> {
    const current = await this.plans.get(ctx, id);
    return maintenancePlanDto(await this.plans.update(ctx, id, body, ifMatchVersion(ifMatch, current)));
  }
}

// ============================================================================================= resident

/** The resident's repair requests in the LIFF (`/v1/resident/service-requests`, D-072). */
@ApiTags('resident.serviceRequests')
@ApiSurface(SURFACES.resident)
@Controller('resident')
export class ResidentServiceRequestsController {
  constructor(private readonly requests: ResidentServiceRequestsService) {}

  @Get('service-categories')
  @ApiEndpoint({
    id: 'resident.serviceRequests.categories',
    summary: 'Repair categories of my unit',
    description:
      'The categories a request of this unit can have (its landlord’s version), with the SLA hours.',
    implements: ['D-072'],
  })
  @ApiSuccess(200, {
    description: 'Categories',
    type: ServiceCategoriesDto,
    example: { data: [CATEGORY_EXAMPLE] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async categories(@Query() q: ResidentCategoryQuery): Promise<ServiceCategoriesDto> {
    return { data: (await this.requests.categoriesOf(q.unitId)).map(categoryDto) };
  }

  @Get('service-requests')
  @ApiEndpoint({
    id: 'resident.serviceRequests.list',
    summary: 'My repair requests',
    description:
      'Requests of the units I occupy reported since my current occupancy began (never a former occupant’s, D-224) and the ones I reported, newest first. The detail and actions follow the same rule (404 otherwise).',
    implements: ['D-072', 'D-224'],
  })
  @ApiPaginated(ResidentServiceRequestDto, { example: RESIDENT_REQUEST_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: ResidentRequestListQuery): Promise<Page<ResidentServiceRequestDto>> {
    const { rows, total } = await this.requests.list({ open: q.open, ...toSkipTake(q) });
    const out: ResidentServiceRequestDto[] = [];
    for (const r of rows) {
      const one = await this.requests.get(r.id);
      out.push(residentServiceRequestDto(one.row, one.photoIds, one.nextActions, one.detail));
    }
    return paginated(out, total, q);
  }

  @Post('service-requests')
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.serviceRequests.create',
    summary: 'Report a problem',
    description:
      'For a unit I occupy, with a category and up to 10 photos I uploaded (`POST /v1/resident/uploads`, purpose `service_request`). The landlord’s team is notified; I am told of every state change on LINE (quiet hours apply).',
    implements: ['D-072', 'D-025'],
  })
  @ApiJsonBody(ResidentServiceRequestCreateDto, {
    unitId: FAKE.uuid,
    categoryId: FAKE.uuid,
    description: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
    photoDocumentIds: [FAKE.uuid],
    preferredVisit: 'afternoon',
  })
  @ApiSuccess(201, {
    description: 'Reported',
    type: ResidentServiceRequestDto,
    example: RESIDENT_REQUEST_EXAMPLE,
  })
  @ApiStandardErrors('http.not_found', 'http.bad_request', 'validation.failed')
  async create(@Body() body: ResidentServiceRequestCreateDto): Promise<ResidentServiceRequestDto> {
    const r = await this.requests.create(body);
    return residentServiceRequestDto(r.row, r.photoIds, r.nextActions, r.detail);
  }

  @Get('service-requests/:serviceRequestId')
  @ApiEndpoint({
    id: 'resident.serviceRequests.get',
    summary: 'One of my repair requests',
    description:
      'Status, planned visit (and whether I confirmed it), my photos and the technician’s before / after photos (5-minute links), the status history and the SLA (D-159); 404 when it is not of my unit nor reported by me.',
    implements: ['D-072'],
  })
  @ApiSuccess(200, {
    description: 'The request',
    type: ResidentServiceRequestDto,
    example: RESIDENT_REQUEST_EXAMPLE,
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('serviceRequestId', ParseUUIDPipe) id: string): Promise<ResidentServiceRequestDto> {
    const r = await this.requests.get(id);
    return residentServiceRequestDto(r.row, r.photoIds, r.nextActions, r.detail);
  }

  @Post('service-requests/:serviceRequestId/actions/cancel')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.serviceRequests.cancel',
    summary: 'Cancel my request',
    description: 'Before the work is assigned (new or triaged).',
    implements: ['D-072'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'ซ่อมเองแล้ว' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: ResidentServiceRequestDto,
    example: { ...RESIDENT_REQUEST_EXAMPLE, status: 'cancelled', nextActions: [] },
  })
  @ApiStandardErrors('http.not_found', 'http.bad_request', 'validation.failed', ...SR_STATE)
  async cancel(
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<ResidentServiceRequestDto> {
    const r = await this.requests.cancel(id, body.reason);
    return residentServiceRequestDto(r.row, r.photoIds, r.nextActions, r.detail);
  }

  @Post('service-requests/:serviceRequestId/actions/rate')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.serviceRequests.rate',
    summary: 'Rate the repair',
    description: '1–5 with an optional comment once the work is done; the rating closes the request (D-072).',
    implements: ['D-072'],
  })
  @ApiJsonBody(ServiceRatingDto, { rating: 5, comment: 'ช่างมาตรงเวลา' })
  @ApiSuccess(200, {
    description: 'Rated and closed',
    type: ResidentServiceRequestDto,
    example: { ...RESIDENT_REQUEST_EXAMPLE, status: 'closed', rating: 5, nextActions: [] },
  })
  @ApiStandardErrors('http.not_found', 'http.bad_request', 'validation.failed', ...SR_STATE)
  async rate(
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
    @Body() body: ServiceRatingDto,
  ): Promise<ResidentServiceRequestDto> {
    const r = await this.requests.rate(id, body.rating, body.comment ?? null);
    return residentServiceRequestDto(r.row, r.photoIds, r.nextActions, r.detail);
  }

  @Post('service-requests/:serviceRequestId/actions/confirm-visit')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.serviceRequests.confirmVisit',
    summary: 'Confirm the planned visit',
    description:
      'Offered in `nextActions` while the scheduled visit (`visitAt`) waits for me and the technician has not started; a moved visit asks again. The technician and the office are told (D-072, D-218).',
    implements: ['D-072', 'D-218'],
  })
  @ApiSuccess(200, {
    description: 'Confirmed',
    type: ResidentServiceRequestDto,
    example: {
      ...RESIDENT_REQUEST_EXAMPLE,
      status: 'assigned',
      nextActions: [],
      visitAt: FAKE.dateTime,
      visitConfirmedAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...SR_STATE, 'concurrency.stale')
  async confirmVisit(
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
  ): Promise<ResidentServiceRequestDto> {
    const r = await this.requests.confirmVisit(id);
    return residentServiceRequestDto(r.row, r.photoIds, r.nextActions, r.detail);
  }

  @Get('service-requests/:serviceRequestId/messages')
  @ApiEndpoint({
    id: 'resident.serviceRequests.messages',
    summary: 'Messages with the office and the technician',
    description:
      'The thread of my request, oldest first — nobody’s phone number is shown (D-072, D-218); 404 when the request is not mine.',
    implements: ['D-072', 'D-218'],
  })
  @ApiSuccess(200, {
    description: 'Messages',
    type: ServiceMessagesDto,
    example: { data: [MESSAGE_EXAMPLE] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async messages(@Param('serviceRequestId', ParseUUIDPipe) id: string): Promise<ServiceMessagesDto> {
    return { data: (await this.requests.messages(id)).map((m) => serviceMessageDto(m, me())) };
  }

  @Post('service-requests/:serviceRequestId/messages')
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.serviceRequests.postMessage',
    summary: 'Write to the office',
    description:
      'At most 2000 characters; the office sees it at once and the assigned technician is told (`service_request.message` on `user:` / `unit:`). 409 once the request is closed or cancelled.',
    implements: ['D-072', 'D-218'],
  })
  @ApiJsonBody(ServiceMessageCreateDto, { body: 'สะดวกช่วงบ่ายค่ะ' })
  @ApiSuccess(201, {
    description: 'Posted',
    type: ServiceMessageDto,
    example: { ...MESSAGE_EXAMPLE, author: 'resident', authorName: FAKE.nameTh, mine: true },
  })
  @ApiStandardErrors(...MESSAGE_ERRORS, 'service_request.invalid_state')
  async postMessage(
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
    @Body() body: ServiceMessageCreateDto,
  ): Promise<ServiceMessageDto> {
    return serviceMessageDto(await this.requests.postMessage(id, body.body), me());
  }
}

// =========================================================================================== technician

/**
 * The technician LIFF (`/v1/technician/work-orders`, D-154, B5.1): only the work orders of my token
 * (`work_order:<id>`), re-checked against the current assignment.
 */
@ApiTags('technician.workOrders')
@ApiSurface(SURFACES.technician)
@Controller('technician/work-orders')
export class TechnicianWorkOrdersController {
  constructor(private readonly work: TechnicianWorkOrdersService) {}

  private async one(id: string): Promise<TechnicianWorkOrderDto> {
    const [row, photos, request, extras] = await Promise.all([
      this.work.get(id),
      this.work.photos(id),
      this.work.request(id),
      this.work.detail(id),
    ]);
    return technicianWorkOrderDto(
      row,
      photos,
      workOrderActions(row.status, 'assignee', row.serviceRequest?.status === 'waiting_parts'),
      request
        ? {
            description: request.sr.description,
            categoryKey: request.sr.category.key,
            photoIds: request.photoIds,
          }
        : null,
      extras,
    );
  }

  @Get()
  @ApiEndpoint({
    id: 'technician.workOrders.list',
    summary: 'My work orders',
    description:
      'The work orders assigned to me and not yet verified, by visit time. A work order assigned after I signed in appears after the next token refresh.',
    implements: ['D-072', 'D-154'],
  })
  @ApiSuccess(200, {
    description: 'Work orders',
    type: TechnicianWorkOrdersDto,
    example: { data: [TECH_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<TechnicianWorkOrdersDto> {
    const rows = await this.work.list();
    return { data: await Promise.all(rows.map((r) => this.one(r.id))) };
  }

  @Get(':workOrderId')
  @ApiEndpoint({
    id: 'technician.workOrders.get',
    summary: 'One of my work orders',
    description:
      'The place, the problem with its photos, the visit window and the resident’s preferred time, my photos and costs, all photos with 5-minute links, and the resident’s rating once the request is closed; 404 when not mine.',
    implements: ['D-072', 'D-154'],
  })
  @ApiSuccess(200, {
    description: 'The work order',
    type: TechnicianWorkOrderDto,
    example: { ...TECH_EXAMPLE, nextActions: WORK_ORDER_EXAMPLE.nextActions },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  get(@Param('workOrderId', ParseUUIDPipe) id: string): Promise<TechnicianWorkOrderDto> {
    return this.one(id);
  }

  @Post(':workOrderId/actions/accept')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'technician.workOrders.accept',
    summary: 'Accept the job',
    description: 'Confirms I take the work order (optional before check-in).',
    implements: ['D-072'],
  })
  @ApiSuccess(200, { description: 'Accepted', type: TechnicianWorkOrderDto, example: TECH_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...WO_STATE)
  async accept(@Param('workOrderId', ParseUUIDPipe) id: string): Promise<TechnicianWorkOrderDto> {
    await this.work.act(id, 'accept');
    return this.one(id);
  }

  @Post(':workOrderId/actions/check-in')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'technician.workOrders.checkIn',
    summary: 'Check in on site',
    description: 'The work starts; the resident sees “in progress”.',
    implements: ['D-072'],
  })
  @ApiSuccess(200, { description: 'In progress', type: TechnicianWorkOrderDto, example: TECH_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...WO_STATE)
  async checkIn(@Param('workOrderId', ParseUUIDPipe) id: string): Promise<TechnicianWorkOrderDto> {
    await this.work.act(id, 'check-in');
    return this.one(id);
  }

  @Post(':workOrderId/actions/wait-parts')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'technician.workOrders.waitParts',
    summary: 'Waiting for parts',
    description: 'The resident sees “waiting for parts”; resume when they arrive.',
    implements: ['D-072'],
  })
  @ApiJsonBody(WorkOrderNoteDto, { note: 'รอก๊อกรุ่นเดิม 2 วัน' })
  @ApiSuccess(200, { description: 'Waiting', type: TechnicianWorkOrderDto, example: TECH_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'http.bad_request', 'validation.failed', ...WO_STATE)
  async waitParts(
    @Param('workOrderId', ParseUUIDPipe) id: string,
    @Body() body: WorkOrderNoteDto,
  ): Promise<TechnicianWorkOrderDto> {
    await this.work.act(id, 'wait-parts', body);
    return this.one(id);
  }

  @Post(':workOrderId/actions/resume')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'technician.workOrders.resume',
    summary: 'Parts arrived',
    description: 'Back to work.',
    implements: ['D-072'],
  })
  @ApiSuccess(200, { description: 'Resumed', type: TechnicianWorkOrderDto, example: TECH_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...WO_STATE)
  async resume(@Param('workOrderId', ParseUUIDPipe) id: string): Promise<TechnicianWorkOrderDto> {
    await this.work.act(id, 'resume');
    return this.one(id);
  }

  @Post(':workOrderId/actions/complete')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'technician.workOrders.complete',
    summary: 'Complete the job',
    description:
      'With at least one after photo uploaded (`POST …/photos`, role `after`; 422 `work_order.photo_required`) and an optional note.',
    implements: ['D-072'],
  })
  @ApiJsonBody(WorkOrderNoteDto, { note: 'เปลี่ยนก๊อกใหม่แล้ว ทดสอบไม่รั่ว' })
  @ApiSuccess(200, {
    description: 'Done',
    type: TechnicianWorkOrderDto,
    example: { ...TECH_EXAMPLE, status: 'done', nextActions: [] },
  })
  @ApiStandardErrors(
    'http.not_found',
    'http.bad_request',
    'validation.failed',
    ...WO_STATE,
    'work_order.photo_required',
  )
  async complete(
    @Param('workOrderId', ParseUUIDPipe) id: string,
    @Body() body: WorkOrderNoteDto,
  ): Promise<TechnicianWorkOrderDto> {
    await this.work.act(id, 'complete', body);
    return this.one(id);
  }

  @Post(':workOrderId/photos')
  @ApiEndpoint({
    id: 'technician.workOrders.uploadPhoto',
    summary: 'Upload a before / after photo',
    description:
      'Answers a 15-minute PUT URL for a JPEG / PNG / WebP ≤ 10 MB (with its SHA-256); the photo is attached to the work order at once and counts once the bytes are uploaded (scanned like every upload).',
    implements: ['D-072'],
  })
  @ApiJsonBody(TechnicianPhotoPresignDto, {
    role: 'before',
    contentType: 'image/jpeg',
    sizeBytes: 2345678,
    sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  })
  @ApiSuccess(201, {
    description: 'Upload URL',
    type: TechnicianPhotoUploadDto,
    example: {
      fileId: FAKE.uuid,
      role: 'before',
      uploadUrl: 'https://storage.example.com/upload?X-Amz-Signature=abc',
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      expiresAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'http.bad_request',
    'validation.failed',
    'document.type_not_allowed',
    ...WO_STATE,
  )
  async photo(
    @Param('workOrderId', ParseUUIDPipe) id: string,
    @Body() body: TechnicianPhotoPresignDto,
  ): Promise<TechnicianPhotoUploadDto> {
    const r = await this.work.presignPhoto(id, { ...body, role: body.role });
    return {
      fileId: r.document.id,
      role: body.role,
      uploadUrl: r.uploadUrl ?? '',
      method: 'PUT',
      headers: r.headers,
      expiresAt: iso(r.expiresAt),
    };
  }

  @Post(':workOrderId/cost-lines')
  @ApiEndpoint({
    id: 'technician.workOrders.addCost',
    summary: 'Record parts / labour',
    description: 'THB decimal strings; the owner verifies them with the work order.',
    implements: ['D-072', 'D-046'],
  })
  @ApiJsonBody(CostLineCreateDto, {
    kind: 'part',
    description: 'ก๊อกน้ำ',
    quantity: '1',
    unitPrice: '350.00',
  })
  @ApiSuccess(201, { description: 'Added', type: TechnicianWorkOrderDto, example: TECH_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'http.bad_request', 'validation.failed', ...WO_STATE)
  async addCost(
    @Param('workOrderId', ParseUUIDPipe) id: string,
    @Body() body: CostLineCreateDto,
  ): Promise<TechnicianWorkOrderDto> {
    await this.work.addCost(id, body);
    return this.one(id);
  }

  @Get(':workOrderId/messages')
  @ApiEndpoint({
    id: 'technician.workOrders.messages',
    summary: 'Messages with the office and the resident',
    description:
      'The thread of the work order’s request (or, without a request, with the office), oldest first — no phone numbers are exchanged (D-072, D-218); 404 when not mine.',
    implements: ['D-072', 'D-154', 'D-218'],
  })
  @ApiSuccess(200, {
    description: 'Messages',
    type: ServiceMessagesDto,
    example: { data: [MESSAGE_EXAMPLE] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async messages(@Param('workOrderId', ParseUUIDPipe) id: string): Promise<ServiceMessagesDto> {
    return { data: (await this.work.messages(id)).map((m) => serviceMessageDto(m, me())) };
  }

  @Post(':workOrderId/messages')
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'technician.workOrders.postMessage',
    summary: 'Write to the office and the resident',
    description:
      'As the technician (my name, never my phone); the resident is told on LINE and the office sees it at once. 409 once the request ended or the work order was cancelled.',
    implements: ['D-072', 'D-154', 'D-218'],
  })
  @ApiJsonBody(ServiceMessageCreateDto, { body: 'ถึงหน้าห้องแล้วครับ' })
  @ApiSuccess(201, {
    description: 'Posted',
    type: ServiceMessageDto,
    example: { ...MESSAGE_EXAMPLE, author: 'technician', authorName: 'ช่างประปา', mine: true },
  })
  @ApiStandardErrors(...MESSAGE_ERRORS, 'service_request.invalid_state', 'work_order.invalid_state')
  async postMessage(
    @Param('workOrderId', ParseUUIDPipe) id: string,
    @Body() body: ServiceMessageCreateDto,
  ): Promise<ServiceMessageDto> {
    return serviceMessageDto(await this.work.postMessage(id, body.body), me());
  }
}

import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { type CostsView, ServiceCostsService } from '@modules/ops-service/service-costs.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { decisionStateDto } from './service.mappers';
import {
  type ServiceCostBearerName,
  ServiceCostCreateDto,
  type ServiceCostKindName,
  type ServiceCostPayerName,
  ServiceCostsDto,
  ServiceCostVoidDto,
  ServiceDecisionCreateDto,
  type ServiceHandlerName,
} from './service-costs.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const LANDLORD = ['service_request.decision_unavailable'] as const;

const COSTS_EXAMPLE: ServiceCostsDto = {
  serviceRequestId: FAKE.uuid,
  decision: {
    handledBy: 'owner_technician' as ServiceHandlerName,
    costBearer: 'shared' as ServiceCostBearerName,
    tenantSharePercent: '50.00',
    decidedAt: FAKE.dateTime,
  },
  decisions: [
    {
      id: FAKE.uuid,
      handledBy: 'owner_technician' as ServiceHandlerName,
      costBearer: 'shared' as ServiceCostBearerName,
      tenantSharePercent: '50.00',
      note: 'ผู้เช่าทำท่อแตกเอง ตกลงแบ่งกันคนละครึ่ง',
      decidedAt: FAKE.dateTime,
    },
  ],
  costs: [
    {
      id: FAKE.uuid,
      kind: 'receipt' as ServiceCostKindName,
      description: 'เปลี่ยนท่อน้ำทิ้งใต้ซิงก์',
      amount: '1800.00',
      paidBy: 'owner' as ServiceCostPayerName,
      vendorName: 'ช่างสมศักดิ์ ประปา',
      issuedOn: '2026-11-03',
      documentId: null,
      url: null,
      voidedAt: null,
      voidReason: null,
    },
  ],
  settlements: [],
  settlement: {
    receiptsTotal: '1800.00',
    ownerShare: '900.00',
    tenantShare: '900.00',
    paidByOwner: '1800.00',
    paidByTenant: '0.00',
    tenantOwes: '900.00',
    settled: '0.00',
    due: '900.00',
  },
  nextActions: ['decide', 'add-cost', 'settle'],
};

function costsDto(v: CostsView): ServiceCostsDto {
  const open = v.request.status !== 'cancelled';
  const due = v.settlement.due !== '0.00';
  return {
    serviceRequestId: v.request.id,
    decision: decisionStateDto(v.request),
    decisions: v.decisions.map((d) => ({
      id: d.id,
      handledBy: d.handledBy as ServiceHandlerName,
      costBearer: d.costBearer as ServiceCostBearerName,
      tenantSharePercent: d.tenantSharePercent?.toFixed(2) ?? null,
      note: d.note,
      decidedAt: iso(d.decidedAt),
    })),
    costs: v.costs.map((c) => ({
      id: c.id,
      kind: c.kind as ServiceCostKindName,
      description: c.description,
      amount: c.amount.toFixed(2),
      paidBy: c.paidBy as ServiceCostPayerName | null,
      vendorName: c.vendorName,
      issuedOn: dateOnly(c.issuedOn)!,
      documentId: c.documentId,
      url: c.url,
      voidedAt: isoOrNull(c.voidedAt),
      voidReason: c.voidReason,
    })),
    settlements: v.settlements.map((s) => ({
      id: s.id,
      amount: s.amount.toFixed(2),
      invoiceChargeId: s.invoiceChargeId,
      settledAt: iso(s.settledAt),
    })),
    settlement: v.settlement,
    nextActions: [
      ...(open ? ['decide', 'add-cost'] : []),
      ...(v.request.costBearer && due && v.request.unitId ? ['settle'] : []),
    ],
  };
}

/**
 * Who fixes, who pays (B7 deliverable 7.8, D-263): a landlord's decision on a service request, its quotations and
 * receipts, and the settlement of the tenant's share on the next invoice. Buildings keep the technician queue (D-210):
 * `service_request.decision_unavailable` for any tenant type but `landlord`.
 */
@ApiTags('owner.serviceCosts')
@ApiSurface(SURFACES.owner)
@Controller('owner/service-requests/:serviceRequestId')
export class OwnerServiceCostsController {
  constructor(private readonly costs: ServiceCostsService) {}

  @Get('costs')
  @TenantScoped()
  @Can('service_request.read')
  @ApiEndpoint({
    id: 'owner.serviceCosts.get',
    summary: 'Who fixes, who pays, and the costs',
    description:
      'The current decision and its history, the quotations and receipts (amounts, who paid, a 5-minute link to each file) and what is still to settle with the tenant (D-263).',
    implements: ['D-263'],
  })
  @ApiSuccess(200, { description: 'Costs', type: ServiceCostsDto, example: COSTS_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...LANDLORD, ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
  ): Promise<ServiceCostsDto> {
    return costsDto(await this.costs.costs(ctx, id));
  }

  @Post('actions/decide')
  @HttpCode(200)
  @TenantScoped()
  @Can('service_request.handle')
  @ApiEndpoint({
    id: 'owner.serviceCosts.decide',
    summary: 'Decide who fixes and who pays',
    description:
      'The owner’s technician, the tenant or a partner fixes it; the owner, the tenant or both pay (`shared` with the tenant’s percent). Changeable at any time — each decision is kept — and the resident is told in LINE (D-263).',
    implements: ['D-263'],
  })
  @ApiJsonBody(ServiceDecisionCreateDto, {
    handledBy: 'owner_technician',
    costBearer: 'shared',
    tenantSharePercent: '50',
  })
  @ApiSuccess(200, { description: 'Decided', type: ServiceCostsDto, example: COSTS_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'service_request.invalid_state',
    ...LANDLORD,
    ...T,
  )
  async decide(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
    @Body() body: ServiceDecisionCreateDto,
  ): Promise<ServiceCostsDto> {
    return costsDto(await this.costs.decide(ctx, id, body));
  }

  @Post('costs')
  @TenantScoped()
  @Can('service_request.handle')
  @ApiEndpoint({
    id: 'owner.serviceCosts.add',
    summary: 'Attach a quotation or a receipt',
    description:
      'Its amount, date, vendor and file; a receipt says who paid the vendor (the owner, or the tenant who arranged the repair). Receipts decide the settlement and, for the owner’s share, the repair expenses of the annual income summary (D-263, D-253).',
    implements: ['D-263', 'D-253'],
  })
  @ApiJsonBody(ServiceCostCreateDto, {
    kind: 'receipt',
    description: 'เปลี่ยนท่อน้ำทิ้งใต้ซิงก์',
    amount: '1800.00',
    paidBy: 'owner',
    vendorName: 'ช่างสมศักดิ์ ประปา',
    issuedOn: '2026-11-03',
  })
  @ApiSuccess(201, { description: 'Attached', type: ServiceCostsDto, example: COSTS_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'service_request.invalid_state',
    ...LANDLORD,
    ...T,
  )
  async add(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
    @Body() body: ServiceCostCreateDto,
  ): Promise<ServiceCostsDto> {
    return costsDto(await this.costs.addCost(ctx, id, body));
  }

  @Post('costs/:costId/actions/void')
  @HttpCode(200)
  @TenantScoped()
  @Can('service_request.handle')
  @ApiEndpoint({
    id: 'owner.serviceCosts.void',
    summary: 'Void a quotation or a receipt',
    description:
      'With a reason; it stays listed, voided. A receipt already settled is corrected by the next settlement (D-263).',
    implements: ['D-263'],
  })
  @ApiJsonBody(ServiceCostVoidDto, { reason: 'บันทึกยอดผิด' })
  @ApiSuccess(200, { description: 'Voided', type: ServiceCostsDto, example: COSTS_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'service_cost.voided',
    ...LANDLORD,
    ...T,
  )
  async void(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
    @Param('costId', ParseUUIDPipe) costId: string,
    @Body() body: ServiceCostVoidDto,
  ): Promise<ServiceCostsDto> {
    return costsDto(await this.costs.voidCost(ctx, id, costId, body.reason));
  }

  @Post('actions/settle')
  @HttpCode(200)
  @TenantScoped()
  @Can('service_request.handle')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.serviceCosts.settle',
    summary: 'Settle the repair with the tenant',
    description:
      'Puts what is due on the tenant’s next invoice as a pending charge: their share of the receipts the owner paid (`service_charge_work`), or a credit of the owner’s share of what they paid (`discount`, negative). Only when the owner confirms; repeatable as receipts change; the resident is told in LINE (D-263).',
    implements: ['D-263', 'D-041'],
  })
  @ApiSuccess(200, {
    description: 'Settled',
    type: ServiceCostsDto,
    example: {
      ...COSTS_EXAMPLE,
      settlements: [
        { id: FAKE.uuid, amount: '900.00', invoiceChargeId: FAKE.uuid, settledAt: FAKE.dateTime },
      ],
      settlement: { ...COSTS_EXAMPLE.settlement, settled: '900.00', due: '0.00' },
      nextActions: ['decide', 'add-cost'],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'service_request.not_decided',
    'service_request.nothing_to_settle',
    ...LANDLORD,
    ...T,
  )
  async settle(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceRequestId', ParseUUIDPipe) id: string,
  ): Promise<ServiceCostsDto> {
    return costsDto(await this.costs.settle(ctx, id));
  }
}

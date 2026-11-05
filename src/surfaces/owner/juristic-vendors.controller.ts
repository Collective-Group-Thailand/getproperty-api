import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { bangkokDate, toBangkokIso } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { SettingsService } from '@core/settings/settings.service';
import { permissionsOf } from '@core/tenancy/access.service';
import { type VendorEvaluation } from '@generated/prisma/client';
import { QuotationsService, type RoundRow } from '@modules/ops-juristic/vendors/quotations.service';
import { VendorEvaluationsService } from '@modules/ops-juristic/vendors/vendor-evaluations.service';
import {
  evaluationTrend,
  type InstalmentPlan,
  MIN_QUOTATIONS,
  type SlaBreach,
  type SlaTerm,
} from '@modules/ops-juristic/vendors/vendor-rules';
import {
  type ContractDetailRow,
  type ContractRow,
  type VendorRow,
  VendorsService,
} from '@modules/ops-juristic/vendors/vendors.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Decimal from 'decimal.js';

import { isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type ApproverRoleName,
  type ExpenseDecisionName,
  type ExpenseStateName,
} from './juristic-accounting.dto';
import { CaseReasonDto, StepDecisionDto } from './juristic-receivables.dto';
import {
  type AwardBasisName,
  type AwardOutcomeName,
  ContractDocumentAttachDto,
  type ContractDocumentKindName,
  type ContractInstalmentStateName,
  type EvaluationTrendName,
  type InstalmentFrequencyName,
  QuotationAwardDto,
  QuotationCreateDto,
  QuotationRoundCreateDto,
  QuotationRoundDto,
  QuotationRoundListQuery,
  type QuotationRoundStateName,
  SlaBreachDto,
  type SlaBreachKindName,
  SlaMonthDto,
  SlaMonthQuery,
  type VendorCategoryName,
  VendorContractCreateDto,
  VendorContractDetailDto,
  VendorContractDto,
  VendorContractListQuery,
  VendorContractRenewDto,
  type VendorContractStateName,
  VendorContractTerminateDto,
  VendorContractUpdateDto,
  VendorCreateDto,
  VendorDto,
  VendorEvaluationCreateDto,
  VendorEvaluationDto,
  VendorEvaluationListDto,
  VendorListQuery,
  type VendorStateName,
  VendorUpdateDto,
} from './juristic-vendors.dto';
import { type PartyTypeName } from './parties.dto';
import { type ServicePriorityName, type WorkOrderStatusName } from './service.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const READ = ['validation.failed', 'http.not_found', ...T] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);
const permsOf = (ctx: TenantContext): ReadonlySet<string> => permissionsOf(ctx.role ? [ctx.role] : []);
const me = () => userIdOf(RequestContext.actor());
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);

// ------------------------------------------------------------------------------------------- mappers

export const vendorDto = (v: VendorRow): VendorDto => ({
  id: v.id,
  partyId: v.partyId,
  partyType: v.party.type as PartyTypeName,
  name: v.name,
  taxIdHint: v.party.taxId ? v.party.taxId.slice(-4) : null,
  categories: v.categories as VendorCategoryName[],
  contactName: v.contactName,
  contactPhone: v.contactPhone,
  contactEmail: v.contactEmail,
  bankName: v.bankName,
  bankAccountName: v.bankAccountName,
  bankAccountLast4: v.bankAccountLast4,
  state: v.state as VendorStateName,
  blockedReason: v.blockedReason,
  note: v.note,
  activeContracts: v._count.contracts,
  createdAt: toBangkokIso(v.createdAt),
  version: v.version,
});

function contractSummary(c: ContractRow, today: string): VendorContractDto {
  return {
    id: c.id,
    buildingId: c.buildingId,
    buildingName: c.building.name,
    vendorId: c.vendorId,
    vendorName: c.vendor.name,
    title: c.title,
    category: c.category as VendorCategoryName | null,
    startsOn: day(c.startsOn),
    endsOn: day(c.endsOn),
    renewalNoticeDays: c.renewalNoticeDays,
    noticeBy: addDays(day(c.endsOn), -c.renewalNoticeDays),
    daysLeft: daysBetween(today, day(c.endsOn)),
    value: c.value.toFixed(2),
    state: c.state as VendorContractStateName,
    renewsContractId: c.renewsContractId,
    renewalId: c.renewedBy[0]?.id ?? null,
    createdAt: toBangkokIso(c.createdAt),
    version: c.version,
  };
}

export const evaluationDto = (e: VendorEvaluation): VendorEvaluationDto => ({
  id: e.id,
  contractId: e.contractId,
  vendorId: e.vendorId,
  month: day(e.month).slice(0, 7),
  scores: e.scores as unknown as VendorEvaluationDto['scores'],
  score: e.score.toFixed(2),
  incidents: e.incidents,
  incidentNote: e.incidentNote,
  slaBreaches: e.slaBreaches,
  slaItems: (e.slaItems as unknown as SlaBreach[]).map(slaBreachDto),
  workOrders: e.workOrders,
  note: e.note,
  evaluatedBy: e.evaluatedBy,
  createdAt: toBangkokIso(e.createdAt),
});

const slaBreachDto = (b: SlaBreach): SlaBreachDto => ({
  kind: b.kind as SlaBreachKindName,
  workOrderId: b.workOrderId,
  serviceRequestId: b.serviceRequestId,
  title: b.title,
  priority: b.priority as ServicePriorityName,
  allowedHours: b.allowedHours,
  actualHours: b.actualHours,
});

function contractActions(ctx: TenantContext, c: ContractDetailRow): string[] {
  const perms = permsOf(ctx);
  const out: string[] = [];
  const manage = perms.has('juristic.vendor.manage');
  if (c.state === 'draft' && manage) out.push('edit', 'activate');
  if ((c.state === 'active' || c.state === 'expired') && manage && !c.renewedBy.length) out.push('renew');
  if (c.state === 'active' && manage) out.push('terminate');
  if (manage) out.push('attach');
  if (c.state !== 'draft' && perms.has('juristic.vendor.evaluate')) out.push('evaluate');
  return out;
}

export function contractDetailDto(
  ctx: TenantContext,
  c: ContractDetailRow,
  today: string,
): VendorContractDetailDto {
  const plan = c.instalmentPlan as unknown as InstalmentPlan | null;
  return {
    ...contractSummary(c, today),
    scope: c.scope,
    slaTerms: (c.slaTerms as unknown as SlaTerm[]).map((t) => ({
      priority: t.priority as ServicePriorityName,
      responseHours: t.responseHours,
      resolveHours: t.resolveHours,
    })),
    expenseAccountId: c.expenseAccountId,
    expenseAccountCode: c.expenseAccount?.code ?? null,
    whtKey: c.whtKey,
    instalmentPlan: plan
      ? {
          frequency: plan.frequency as InstalmentFrequencyName,
          dueDay: plan.dueDay,
          amount: new Decimal(plan.amount).toFixed(2),
          vatAmount: new Decimal(plan.vatAmount ?? '0').toFixed(2),
          firstDueOn: plan.firstDueOn ?? null,
        }
      : null,
    penaltyClauses: c.penaltyClauses,
    quotationRoundId: c.quotationRoundId,
    resolutionId: c.resolutionId,
    activatedAt: isoOrNull(c.activatedAt),
    terminatedOn: c.terminatedOn ? day(c.terminatedOn) : null,
    terminationReason: c.terminationReason,
    expiredAt: isoOrNull(c.expiredAt),
    note: c.note,
    instalments: c.instalments.map((i) => ({
      seq: i.seq,
      dueOn: day(i.dueOn),
      amount: i.amount.toFixed(2),
      vatAmount: i.vatAmount.toFixed(2),
      description: i.description,
      state: i.state as ContractInstalmentStateName,
      expenseRequestId: i.expenseRequestId,
      expenseRequestNumber: i.expenseRequest?.number ?? null,
      expenseRequestState: (i.expenseRequest?.state as ExpenseStateName | undefined) ?? null,
      requestedAt: isoOrNull(i.requestedAt),
      cancelledAt: isoOrNull(i.cancelledAt),
    })),
    instalmentsTotal: c.instalments
      .filter((i) => i.state !== 'cancelled')
      .reduce((s, i) => s.plus(i.amount.toString()), new Decimal(0))
      .toFixed(2),
    documents: c.documents.map((d) => ({
      documentId: d.documentId,
      kind: d.kind as ContractDocumentKindName,
      createdAt: toBangkokIso(d.createdAt),
    })),
    evaluations: c.evaluations.map(evaluationDto),
    evaluationSummary: (() => {
      const t = evaluationTrend(
        c.evaluations.map((e) => ({
          month: day(e.month),
          score: e.score.toFixed(2),
          slaBreaches: e.slaBreaches,
        })),
      );
      return { ...t, trend: t.trend as EvaluationTrendName | null };
    })(),
    maintenancePlans: c.maintenancePlans.map((p) => ({
      id: p.id,
      title: p.title,
      assetItemId: p.assetItemId,
      assetItemName: p.assetItem.name,
      intervalDays: p.intervalDays,
      nextDueOn: day(p.nextDueOn),
      isActive: p.isActive,
      lastWorkOrderId: p.lastWorkOrderId,
      lastWorkOrderStatus: (p.lastWorkOrder?.status as WorkOrderStatusName | undefined) ?? null,
    })),
    expenseRequests: c.expenseRequests.map((r) => ({
      id: r.id,
      number: r.number,
      state: r.state as ExpenseStateName,
      amount: r.amount.toFixed(2),
    })),
    alerts: c.alerts.map((a) => ({
      daysBefore: a.daysBefore,
      endsOn: day(a.endsOn),
      sentAt: toBangkokIso(a.sentAt),
    })),
    nextActions: contractActions(ctx, c),
  };
}

function roundActions(ctx: TenantContext, r: RoundRow, approvalsGiven: number): string[] {
  const perms = permsOf(ctx);
  const out: string[] = [];
  const manage = perms.has('juristic.vendor.manage');
  if (r.state === 'open' && manage) out.push('add_quotation', ...(r.quotations.length ? ['award'] : []));
  if (
    r.state === 'awaiting_approval' &&
    r.basis === 'approval' &&
    perms.has('juristic.expense.approve') &&
    r.awardRequestedBy !== me() &&
    ctx.role &&
    r.approverRoles.includes(ctx.role) &&
    !r.approvals.some(
      (a) => a.approverUserId === me() && a.awardRequestedAt.getTime() === r.awardRequestedAt?.getTime(),
    )
  )
    out.push('approve', 'reject');
  if ((r.state === 'open' || r.state === 'awaiting_approval') && manage) out.push('cancel');
  void approvalsGiven;
  return out;
}

export function roundDto(ctx: TenantContext, r: RoundRow, threshold: string): QuotationRoundDto {
  const current = r.approvals.filter((a) => a.awardRequestedAt.getTime() === r.awardRequestedAt?.getTime());
  const approvalsGiven = r.state === 'open' ? 0 : current.filter((a) => a.decision === 'approved').length;
  return {
    id: r.id,
    buildingId: r.buildingId,
    buildingName: r.building.name,
    title: r.title,
    description: r.description,
    category: r.category as VendorCategoryName | null,
    estimatedAmount: r.estimatedAmount ? r.estimatedAmount.toFixed(2) : null,
    state: r.state as QuotationRoundStateName,
    quotations: r.quotations.map((q) => ({
      id: q.id,
      vendorId: q.vendorId,
      vendorName: q.vendor.name,
      amount: q.amount.toFixed(2),
      vatAmount: q.vatAmount.toFixed(2),
      validUntil: day(q.validUntil),
      documentId: q.documentId,
      receivedOn: day(q.receivedOn),
      note: q.note,
    })),
    threshold: r.threshold ? r.threshold.toFixed(2) : new Decimal(threshold).toFixed(2),
    minimumQuotations: MIN_QUOTATIONS,
    awardedQuotationId: r.awardedQuotationId,
    outcome: r.outcome as AwardOutcomeName | null,
    basis: r.basis as AwardBasisName | null,
    resolutionId: r.resolutionId,
    aboveThreshold: r.aboveThreshold,
    fewerQuotationsReason: r.fewerQuotationsReason,
    approvalsRequired: r.state === 'open' ? null : r.approvalsRequired,
    approverRoles: (r.state === 'open' ? [] : r.approverRoles) as ApproverRoleName[],
    approvalsGiven,
    approvals: r.approvals.map((a) => ({
      approverUserId: a.approverUserId,
      role: a.role as ApproverRoleName,
      decision: a.decision as ExpenseDecisionName,
      reason: a.reason,
      createdAt: toBangkokIso(a.createdAt),
    })),
    awardRequestedBy: r.state === 'open' ? null : r.awardRequestedBy,
    awardRequestedAt: r.state === 'open' ? null : isoOrNull(r.awardRequestedAt),
    awardedAt: isoOrNull(r.awardedAt),
    outcomeContractId: r.outcomeContractId,
    outcomeExpenseRequestId: r.outcomeExpenseRequestId,
    cancelledAt: isoOrNull(r.cancelledAt),
    cancelReason: r.cancelReason,
    nextActions: roundActions(ctx, r, approvalsGiven),
    createdAt: toBangkokIso(r.createdAt),
    version: r.version,
  };
}

// ------------------------------------------------------------------------------------------- examples

const VENDOR_EXAMPLE: VendorDto = {
  id: FAKE.uuid,
  partyId: FAKE.uuid,
  partyType: 'company' as PartyTypeName,
  name: 'บริษัท ลิฟต์ไทย เซอร์วิส จำกัด',
  taxIdHint: '0002',
  categories: ['lift'] as VendorCategoryName[],
  contactName: FAKE.name,
  contactPhone: '+66810001234',
  contactEmail: FAKE.email,
  bankName: 'กสิกรไทย',
  bankAccountName: 'บจก. ลิฟต์ไทย เซอร์วิส',
  bankAccountLast4: '8812',
  state: 'active' as VendorStateName,
  blockedReason: null,
  note: null,
  activeContracts: 1,
  createdAt: FAKE.dateTime,
  version: 1,
};

const CONTRACT_EXAMPLE: VendorContractDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  vendorId: FAKE.uuid,
  vendorName: 'บริษัท ลิฟต์ไทย เซอร์วิส จำกัด',
  title: 'สัญญาบำรุงรักษาลิฟต์ 2570',
  category: 'lift' as VendorCategoryName,
  startsOn: '2027-01-01',
  endsOn: '2027-12-31',
  renewalNoticeDays: 60,
  noticeBy: '2027-11-01',
  daysLeft: 120,
  value: '192600.00',
  state: 'active' as VendorContractStateName,
  renewsContractId: null,
  renewalId: null,
  createdAt: FAKE.dateTime,
  version: 2,
};

const EVALUATION_EXAMPLE: VendorEvaluationDto = {
  id: FAKE.uuid,
  contractId: FAKE.uuid,
  vendorId: FAKE.uuid,
  month: '2027-03',
  scores: [
    { criterion: 'quality', labelTh: 'คุณภาพงาน', labelEn: 'Quality of work', score: 4 },
    { criterion: 'timeliness', labelTh: 'ความตรงต่อเวลา', labelEn: 'Timeliness', score: 3 },
  ],
  score: '3.50',
  incidents: 0,
  incidentNote: null,
  slaBreaches: 1,
  slaItems: [
    {
      kind: 'response' as SlaBreachKindName,
      workOrderId: FAKE.uuid,
      serviceRequestId: FAKE.uuid,
      title: 'ลิฟต์ L2 ค้าง',
      priority: 'urgent' as ServicePriorityName,
      allowedHours: 2,
      actualHours: 5.5,
    },
  ],
  workOrders: 6,
  note: null,
  evaluatedBy: FAKE.uuid,
  createdAt: FAKE.dateTime,
};

const CONTRACT_DETAIL_EXAMPLE: VendorContractDetailDto = {
  ...CONTRACT_EXAMPLE,
  scope: 'ตรวจเช็กลิฟต์ 4 ตัว เดือนละครั้ง เปลี่ยนอะไหล่สิ้นเปลือง',
  slaTerms: [
    { priority: 'urgent' as ServicePriorityName, responseHours: 2, resolveHours: 24 },
    { priority: 'normal' as ServicePriorityName, responseHours: 24, resolveHours: 72 },
  ],
  expenseAccountId: FAKE.uuid,
  expenseAccountCode: '5300',
  whtKey: 'service',
  instalmentPlan: {
    frequency: 'monthly' as InstalmentFrequencyName,
    dueDay: 5,
    amount: '16050.00',
    vatAmount: '1050.00',
    firstDueOn: null,
  },
  penaltyClauses: 'ปรับวันละ 500 บาท หากไม่เข้าซ่อมภายในเวลาที่กำหนด',
  quotationRoundId: FAKE.uuid,
  resolutionId: null,
  activatedAt: FAKE.dateTime,
  terminatedOn: null,
  terminationReason: null,
  expiredAt: null,
  note: null,
  instalments: [
    {
      seq: 1,
      dueOn: '2027-01-05',
      amount: '16050.00',
      vatAmount: '1050.00',
      description: 'สัญญาบำรุงรักษาลิฟต์ 2570 งวดที่ 1/12',
      state: 'requested' as ContractInstalmentStateName,
      expenseRequestId: FAKE.uuid,
      expenseRequestNumber: 'EXP-2027-00001',
      expenseRequestState: 'submitted' as ExpenseStateName,
      requestedAt: FAKE.dateTime,
      cancelledAt: null,
    },
  ],
  instalmentsTotal: '192600.00',
  documents: [
    { documentId: FAKE.uuid, kind: 'contract' as ContractDocumentKindName, createdAt: FAKE.dateTime },
  ],
  evaluations: [EVALUATION_EXAMPLE],
  evaluationSummary: {
    count: 1,
    averageScore: '3.50',
    lastScore: '3.50',
    trend: null,
    slaBreaches: 1,
  },
  maintenancePlans: [
    {
      id: FAKE.uuid,
      title: 'ตรวจเช็กลิฟต์ประจำเดือน',
      assetItemId: FAKE.uuid,
      assetItemName: 'ลิฟต์โดยสาร L1',
      intervalDays: 30,
      nextDueOn: '2027-02-01',
      isActive: true,
      lastWorkOrderId: null,
      lastWorkOrderStatus: null,
    },
  ],
  expenseRequests: [
    { id: FAKE.uuid, number: 'EXP-2027-00001', state: 'submitted' as ExpenseStateName, amount: '16050.00' },
  ],
  alerts: [],
  nextActions: ['renew', 'terminate', 'attach', 'evaluate'],
};

const ROUND_EXAMPLE: QuotationRoundDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  title: 'จ้างบำรุงรักษาลิฟต์ 2570',
  description: null,
  category: 'lift' as VendorCategoryName,
  estimatedAmount: '200000.00',
  state: 'awaiting_approval' as QuotationRoundStateName,
  quotations: [
    {
      id: FAKE.uuid,
      vendorId: FAKE.uuid,
      vendorName: 'บริษัท ลิฟต์ไทย เซอร์วิส จำกัด',
      amount: '192600.00',
      vatAmount: '12600.00',
      validUntil: '2027-02-28',
      documentId: FAKE.uuid,
      receivedOn: '2026-12-10',
      note: null,
    },
  ],
  threshold: '50000.00',
  minimumQuotations: 3,
  awardedQuotationId: FAKE.uuid,
  outcome: 'contract' as AwardOutcomeName,
  basis: 'approval' as AwardBasisName,
  resolutionId: null,
  aboveThreshold: true,
  fewerQuotationsReason: 'มีผู้ให้บริการลิฟต์ยี่ห้อนี้ในพื้นที่เพียงรายเดียว',
  approvalsRequired: 3,
  approverRoles: ['owner', 'committee'] as ApproverRoleName[],
  approvalsGiven: 1,
  approvals: [
    {
      approverUserId: FAKE.uuid,
      role: 'committee' as ApproverRoleName,
      decision: 'approved' as ExpenseDecisionName,
      reason: null,
      createdAt: FAKE.dateTime,
    },
  ],
  awardRequestedBy: FAKE.uuid,
  awardRequestedAt: FAKE.dateTime,
  awardedAt: null,
  outcomeContractId: null,
  outcomeExpenseRequestId: null,
  cancelledAt: null,
  cancelReason: null,
  nextActions: ['approve', 'reject', 'cancel'],
  createdAt: FAKE.dateTime,
  version: 3,
};

// ------------------------------------------------------------------------------------------- vendors

@ApiTags('owner.juristicVendors')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/vendors')
export class OwnerVendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.vendor.read')
  @ApiEndpoint({
    id: 'owner.juristicVendors.list',
    summary: 'Vendors',
    description:
      'The juristic tenant’s vendors by name; filters state, category and part of the name. Tax id and bank account are shown masked (last 4) (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiPaginated(VendorDto, { example: VENDOR_EXAMPLE })
  @ApiStandardErrors(...READ)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: VendorListQuery): Promise<Page<VendorDto>> {
    const { rows, total } = await this.vendors.listVendors(ctx, {
      state: q.state,
      category: q.category,
      q: q.q,
      ...toSkipTake(q),
    });
    return paginated(rows.map(vendorDto), total, q);
  }

  @Post()
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicVendors.create',
    summary: 'Register a vendor',
    description:
      'A vendor is a party of the tenant: an existing one (`partyId`) or one created from the name, type and contact. The 13-digit tax id (check digit verified) is kept on the party — the 50 ทวิ of the vendor’s payments prints it (D-329). Only the last 4 digits of the bank account are stored. A party registered twice is 409 `vendor.exists`. Audited (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(VendorCreateDto, {
    type: 'company',
    name: 'บริษัท ลิฟต์ไทย เซอร์วิส จำกัด',
    taxId: FAKE.taxId,
    categories: ['lift'],
    contactName: FAKE.name,
    contactPhone: FAKE.phone,
    bankName: 'กสิกรไทย',
    bankAccountLast4: '8812',
  })
  @ApiSuccess(201, { description: 'Registered', type: VendorDto, example: VENDOR_EXAMPLE })
  @ApiStandardErrors('vendor.exists', ...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: VendorCreateDto): Promise<VendorDto> {
    return vendorDto(await this.vendors.createVendor(ctx, body));
  }

  @Get(':vendorId')
  @TenantScoped()
  @Can('juristic.vendor.read')
  @ApiEndpoint({
    id: 'owner.juristicVendors.get',
    summary: 'A vendor',
    description: 'Another tenant’s vendor is 404 (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiSuccess(200, { description: 'Vendor', type: VendorDto, example: VENDOR_EXAMPLE })
  @ApiStandardErrors(...READ)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('vendorId', ParseUUIDPipe) id: string,
  ): Promise<VendorDto> {
    return vendorDto(await this.vendors.getVendor(ctx, id));
  }

  @Patch(':vendorId')
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicVendors.update',
    summary: 'Edit or block a vendor',
    description:
      'Name, tax id (on the party), categories, contact, masked bank account; `state: blocked` with a reason stops new contracts, quotations and expense requests (existing contracts run on). `version` → 412 when changed meanwhile. Audited (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(VendorUpdateDto, { state: 'blocked', blockedReason: 'ส่งงานล่าช้าซ้ำหลายครั้ง', version: 1 })
  @ApiSuccess(200, { description: 'Vendor', type: VendorDto, example: VENDOR_EXAMPLE })
  @ApiStandardErrors('concurrency.stale', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('vendorId', ParseUUIDPipe) id: string,
    @Body() body: VendorUpdateDto,
  ): Promise<VendorDto> {
    return vendorDto(await this.vendors.updateVendor(ctx, id, body));
  }
}

// ------------------------------------------------------------------------------------------- contracts

const CONTRACT_ERRORS = ['vendor_contract.invalid_state', 'idempotency.key_required', ...WRITE] as const;

@ApiTags('owner.juristicVendorContracts')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/vendor-contracts')
export class OwnerVendorContractsController {
  constructor(
    private readonly vendors: VendorsService,
    private readonly evaluations: VendorEvaluationsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  @Get()
  @TenantScoped()
  @Can('juristic.vendor.read')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.list',
    summary: 'Vendor contracts',
    description:
      'By end date; filters vendor, building, state and `endingWithinDays` (active contracts ending within N days — the renewal queue) (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiPaginated(VendorContractDto, { example: CONTRACT_EXAMPLE })
  @ApiStandardErrors(...READ)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: VendorContractListQuery,
  ): Promise<Page<VendorContractDto>> {
    const { rows, total } = await this.vendors.listContracts(ctx, {
      vendorId: q.vendorId,
      buildingId: q.buildingId,
      state: q.state,
      endingWithinDays: q.endingWithinDays,
      ...toSkipTake(q),
    });
    const today = this.today();
    return paginated(
      rows.map((r) => contractSummary(r, today)),
      total,
      q,
    );
  }

  @Post()
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.create',
    summary: 'Draft a vendor contract',
    description:
      'Scope, SLA terms (response / resolve hours per priority), term, renewal notice days, value, the expense account and WHT key of the instalment requests, the instalment plan (frequency, due day, amount, VAT), penalty clauses, the quotation round awarded to the vendor and / or a resolution. A blocked vendor is 422 `vendor.blocked`. Audited (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(VendorContractCreateDto, {
    buildingId: FAKE.buildingId,
    vendorId: FAKE.uuid,
    title: 'สัญญาบำรุงรักษาลิฟต์ 2570',
    category: 'lift',
    slaTerms: [{ priority: 'urgent', responseHours: 2, resolveHours: 24 }],
    startsOn: '2027-01-01',
    endsOn: '2027-12-31',
    renewalNoticeDays: 60,
    value: '192600.00',
    expenseAccountId: FAKE.uuid,
    whtKey: 'service',
    instalmentPlan: { frequency: 'monthly', dueDay: 5, amount: '16050.00', vatAmount: '1050.00' },
    quotationRoundId: FAKE.uuid,
  })
  @ApiSuccess(201, {
    description: 'Draft',
    type: VendorContractDetailDto,
    example: {
      ...CONTRACT_DETAIL_EXAMPLE,
      state: 'draft',
      activatedAt: null,
      instalments: [],
      instalmentsTotal: '0.00',
      evaluations: [],
      evaluationSummary: { count: 0, averageScore: null, lastScore: null, trend: null, slaBreaches: 0 },
      expenseRequests: [],
      nextActions: ['edit', 'activate', 'attach'],
      version: 1,
    },
  })
  @ApiStandardErrors('vendor.blocked', 'fund.resolution_invalid', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: VendorContractCreateDto,
  ): Promise<VendorContractDetailDto> {
    return contractDetailDto(ctx, await this.vendors.createContract(ctx, body), this.today());
  }

  @Get(':contractId')
  @TenantScoped()
  @Can('juristic.vendor.read')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.get',
    summary: 'A vendor contract',
    description:
      'Terms, instalments with their expense requests, documents, monthly evaluations with the trend of the last 6 (for the renewal decision), preventive plans run under it, expiry alerts sent and the caller’s next actions (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiSuccess(200, {
    description: 'Contract',
    type: VendorContractDetailDto,
    example: CONTRACT_DETAIL_EXAMPLE,
  })
  @ApiStandardErrors(...READ)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<VendorContractDetailDto> {
    return contractDetailDto(ctx, await this.vendors.getContract(ctx, id), this.today());
  }

  @Patch(':contractId')
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.update',
    summary: 'Edit a draft contract',
    description:
      'Drafts only (409 `vendor_contract.invalid_state`); `version` → 412 when changed meanwhile. Audited (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(VendorContractUpdateDto, { renewalNoticeDays: 90, version: 1 })
  @ApiSuccess(200, {
    description: 'Draft',
    type: VendorContractDetailDto,
    example: { ...CONTRACT_DETAIL_EXAMPLE, state: 'draft', instalments: [] },
  })
  @ApiStandardErrors('vendor_contract.invalid_state', 'concurrency.stale', 'vendor.blocked', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: VendorContractUpdateDto,
  ): Promise<VendorContractDetailDto> {
    return contractDetailDto(ctx, await this.vendors.updateContract(ctx, id, body), this.today());
  }

  @Post(':contractId/documents')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.attach',
    summary: 'Attach a contract document',
    description:
      'The signed contract, an amendment, insurance, a guarantee or another uploaded document (`POST /v1/owner/files/presign` first); attaching the same document again changes nothing. Audited (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(ContractDocumentAttachDto, { documentId: FAKE.uuid, kind: 'contract' })
  @ApiSuccess(200, {
    description: 'Contract',
    type: VendorContractDetailDto,
    example: CONTRACT_DETAIL_EXAMPLE,
  })
  @ApiStandardErrors(...WRITE)
  async attach(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ContractDocumentAttachDto,
  ): Promise<VendorContractDetailDto> {
    return contractDetailDto(ctx, await this.vendors.attachDocument(ctx, id, body), this.today());
  }

  @Post(':contractId/actions/activate')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.activate',
    summary: 'Bring the contract into force',
    description:
      'Draft → active. Above `juristic.quotation_threshold` the contract must come from a quotation round awarded to the vendor — or, for a renewal, carry an adopted resolution (422 `vendor_contract.quotations_required`, D-310). The instalment plan is scheduled inside the term (Σ ≤ value, else 422 `vendor_contract.schedule_invalid`); the hourly job `vendor-contracts` submits each instalment as an expense request `juristic.contract_instalment_lead_days` before it is due (the activating user is its requester — maker-checker). Audited. Requires `Idempotency-Key` (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiSuccess(200, { description: 'Active', type: VendorContractDetailDto, example: CONTRACT_DETAIL_EXAMPLE })
  @ApiStandardErrors(
    'vendor_contract.quotations_required',
    'vendor_contract.schedule_invalid',
    'vendor.blocked',
    ...CONTRACT_ERRORS,
  )
  async activate(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<VendorContractDetailDto> {
    return contractDetailDto(ctx, await this.vendors.activate(ctx, id), this.today());
  }

  @Post(':contractId/actions/renew')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.renew',
    summary: 'Draft the renewal',
    description:
      'An active or expired contract gets one successor draft with the same terms for the new period (from the day after its end unless given; value and plan optional; `resolutionId` lets a renewal above the threshold activate without a new round). Returns the renewal draft; 409 `vendor_contract.already_renewed` for a second one. Audited. Requires `Idempotency-Key` (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(VendorContractRenewDto, { endsOn: '2028-12-31', value: '198000.00', resolutionId: FAKE.uuid })
  @ApiSuccess(200, {
    description: 'Renewal draft',
    type: VendorContractDetailDto,
    example: {
      ...CONTRACT_DETAIL_EXAMPLE,
      state: 'draft',
      startsOn: '2028-01-01',
      endsOn: '2028-12-31',
      renewsContractId: FAKE.uuid,
      instalments: [],
      evaluations: [],
      nextActions: ['edit', 'activate', 'attach'],
      version: 1,
    },
  })
  @ApiStandardErrors(
    'vendor_contract.already_renewed',
    'vendor.blocked',
    'fund.resolution_invalid',
    ...CONTRACT_ERRORS,
  )
  async renew(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: VendorContractRenewDto,
  ): Promise<VendorContractDetailDto> {
    return contractDetailDto(ctx, await this.vendors.renew(ctx, id, body), this.today());
  }

  @Post(':contractId/actions/terminate')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.terminate',
    summary: 'Terminate the contract',
    description:
      'Active → terminated with a reason, effective today or a later day up to the end: instalments due on / after it are cancelled (requests already made stay — cancel them separately), preventive plans run under it stop. Audited. Requires `Idempotency-Key` (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(VendorContractTerminateDto, { reason: 'ผู้รับจ้างผิดสัญญา ไม่เข้าซ่อมตามเวลาที่กำหนด' })
  @ApiSuccess(200, {
    description: 'Terminated',
    type: VendorContractDetailDto,
    example: {
      ...CONTRACT_DETAIL_EXAMPLE,
      state: 'terminated',
      terminatedOn: FAKE.date,
      terminationReason: 'ผู้รับจ้างผิดสัญญา ไม่เข้าซ่อมตามเวลาที่กำหนด',
      nextActions: ['attach', 'evaluate'],
    },
  })
  @ApiStandardErrors(...CONTRACT_ERRORS)
  async terminate(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: VendorContractTerminateDto,
  ): Promise<VendorContractDetailDto> {
    return contractDetailDto(ctx, await this.vendors.terminate(ctx, id, body), this.today());
  }

  @Get(':contractId/sla-breaches')
  @TenantScoped()
  @Can('juristic.vendor.read')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.slaBreaches',
    summary: 'SLA breaches of a month',
    description:
      'What an evaluation of the month pulls: the month’s work orders of the building assigned to the vendor’s party or opened by a preventive plan of the contract — response (accepted / checked in − assigned) and resolve (completed − the request’s creation) above the contract’s hours for the priority, unfinished ones counted until now, plus the linked service requests whose own SLA breached (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiSuccess(200, {
    description: 'Breaches',
    type: SlaMonthDto,
    example: { month: '2027-03', workOrders: 6, breaches: EVALUATION_EXAMPLE.slaItems },
  })
  @ApiStandardErrors(...READ)
  async sla(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Query() q: SlaMonthQuery,
  ): Promise<SlaMonthDto> {
    const m = await this.evaluations.sla(ctx, id, q.month);
    return { month: m.month, workOrders: m.workOrders, breaches: m.breaches.map(slaBreachDto) };
  }

  @Get(':contractId/evaluations')
  @TenantScoped()
  @Can('juristic.vendor.read')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.evaluations',
    summary: 'Evaluations of a contract',
    description: 'Monthly evaluations, oldest first (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiSuccess(200, {
    description: 'Evaluations',
    type: VendorEvaluationListDto,
    example: { data: [EVALUATION_EXAMPLE] },
  })
  @ApiStandardErrors(...READ)
  async evaluationsOf(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<VendorEvaluationListDto> {
    return { data: (await this.evaluations.list(ctx, id)).map(evaluationDto) };
  }

  @Post(':contractId/evaluations')
  @Idempotent()
  @TenantScoped()
  @Can('juristic.vendor.evaluate')
  @ApiEndpoint({
    id: 'owner.juristicVendorContracts.evaluate',
    summary: 'Evaluate a month',
    description:
      'One evaluation per contract and month (a month of the term, not in the future; 409 `vendor_evaluation.exists`): a 1–5 score for every criterion of `juristic.vendor_evaluation_criteria`, incidents, notes; the SLA breaches of the month are pulled from the vendor’s work orders and service requests and snapshotted; the score is the average. Immutable. Audited. Requires `Idempotency-Key` (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(VendorEvaluationCreateDto, {
    month: '2027-03',
    scores: [
      { criterion: 'quality', score: 4 },
      { criterion: 'timeliness', score: 3 },
      { criterion: 'communication', score: 4 },
      { criterion: 'safety', score: 4 },
    ],
    incidents: 0,
  })
  @ApiSuccess(201, { description: 'Recorded', type: VendorEvaluationDto, example: EVALUATION_EXAMPLE })
  @ApiStandardErrors('vendor_evaluation.exists', ...CONTRACT_ERRORS)
  async evaluate(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: VendorEvaluationCreateDto,
  ): Promise<VendorEvaluationDto> {
    return evaluationDto(await this.evaluations.create(ctx, id, body));
  }
}

// ------------------------------------------------------------------------------------------- quotation rounds

const ROUND_ERRORS = ['quotation_round.invalid_state', 'idempotency.key_required', ...WRITE] as const;

@ApiTags('owner.juristicQuotations')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/quotation-rounds')
export class OwnerQuotationRoundsController {
  constructor(
    private readonly rounds: QuotationsService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async threshold(ctx: TenantContext): Promise<string> {
    return (
      (await this.settings.valueAt<string>('juristic.quotation_threshold', this.clock.now(), {
        tenantId: ctx.tenantId,
      })) ?? '0'
    );
  }

  private async dto(ctx: TenantContext, r: RoundRow): Promise<QuotationRoundDto> {
    return roundDto(ctx, r, await this.threshold(ctx));
  }

  @Get()
  @TenantScoped()
  @Can('juristic.vendor.read')
  @ApiEndpoint({
    id: 'owner.juristicQuotations.list',
    summary: 'Quotation rounds',
    description:
      'Newest first; filters state, building and `awaitingMe` (awards my role may approve that I did not ask for) (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiPaginated(QuotationRoundDto, { example: ROUND_EXAMPLE })
  @ApiStandardErrors(...READ)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: QuotationRoundListQuery,
  ): Promise<Page<QuotationRoundDto>> {
    const { rows, total } = await this.rounds.list(ctx, {
      state: q.state,
      buildingId: q.buildingId,
      awaitingMe: q.awaitingMe === true,
      ...toSkipTake(q),
    });
    const threshold = await this.threshold(ctx);
    return paginated(
      rows.map((r) => roundDto(ctx, r, threshold)),
      total,
      q,
    );
  }

  @Post()
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicQuotations.create',
    summary: 'Open a quotation round',
    description:
      'A purchase or a service to compare quotations for, in a building of the tenant. Above `juristic.quotation_threshold` the award needs 3 quotations or a recorded reason (D-310). Audited (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(QuotationRoundCreateDto, {
    buildingId: FAKE.buildingId,
    title: 'จ้างบำรุงรักษาลิฟต์ 2570',
    category: 'lift',
    estimatedAmount: '200000.00',
  })
  @ApiSuccess(201, {
    description: 'Open',
    type: QuotationRoundDto,
    example: {
      ...ROUND_EXAMPLE,
      state: 'open',
      quotations: [],
      awardedQuotationId: null,
      outcome: null,
      basis: null,
      aboveThreshold: null,
      fewerQuotationsReason: null,
      approvalsRequired: null,
      approverRoles: [],
      approvalsGiven: 0,
      approvals: [],
      awardRequestedBy: null,
      awardRequestedAt: null,
      nextActions: ['add_quotation', 'cancel'],
      version: 1,
    },
  })
  @ApiStandardErrors(...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: QuotationRoundCreateDto,
  ): Promise<QuotationRoundDto> {
    return this.dto(ctx, await this.rounds.create(ctx, body));
  }

  @Get(':roundId')
  @TenantScoped()
  @Can('juristic.vendor.read')
  @ApiEndpoint({
    id: 'owner.juristicQuotations.get',
    summary: 'A quotation round',
    description: 'Quotations (cheapest first), the award, its approvals and outcome (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiSuccess(200, { description: 'Round', type: QuotationRoundDto, example: ROUND_EXAMPLE })
  @ApiStandardErrors(...READ)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('roundId', ParseUUIDPipe) id: string,
  ): Promise<QuotationRoundDto> {
    return this.dto(ctx, await this.rounds.get(ctx, id));
  }

  @Post(':roundId/quotations')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicQuotations.addQuotation',
    summary: 'Record a quotation',
    description:
      'One per vendor and round (409 `quotation.exists`), only while open; the quotation document is required; a blocked vendor is 422 `vendor.blocked`. Append-only. Audited (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(QuotationCreateDto, {
    vendorId: FAKE.uuid,
    amount: '192600.00',
    vatAmount: '12600.00',
    validUntil: '2027-02-28',
    documentId: FAKE.uuid,
  })
  @ApiSuccess(200, {
    description: 'Round',
    type: QuotationRoundDto,
    example: { ...ROUND_EXAMPLE, state: 'open', nextActions: ['add_quotation', 'award', 'cancel'] },
  })
  @ApiStandardErrors('quotation_round.invalid_state', 'quotation.exists', 'vendor.blocked', ...WRITE)
  async addQuotation(
    @CurrentTenant() ctx: TenantContext,
    @Param('roundId', ParseUUIDPipe) id: string,
    @Body() body: QuotationCreateDto,
  ): Promise<QuotationRoundDto> {
    return this.dto(ctx, await this.rounds.addQuotation(ctx, id, body));
  }

  @Post(':roundId/actions/award')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicQuotations.award',
    summary: 'Select the winning quotation',
    description:
      'A valid quotation of the round (422 `quotation.expired`), the outcome (`contract`: a contract draft for the vendor at the quoted amount over `startsOn`–`endsOn`; `expense`: an expense request draft on `accountId` with the quotation attached) and the basis: `resolution` (an adopted resolution of the building — awarded at once) or `approval` (the band of `juristic.approval_bands` for the amount; band-role users other than the requester approve — maker-checker). Above `juristic.quotation_threshold` with fewer than 3 quotations `fewerQuotationsReason` is required (422 `quotation.minimum_not_met`, D-310). Audited. Requires `Idempotency-Key` (D-091, D-310, D-331).',
    implements: ['D-091', 'D-310', 'D-331'],
  })
  @ApiJsonBody(QuotationAwardDto, {
    quotationId: FAKE.uuid,
    outcome: 'contract',
    basis: 'approval',
    fewerQuotationsReason: 'มีผู้ให้บริการลิฟต์ยี่ห้อนี้ในพื้นที่เพียงรายเดียว',
    startsOn: '2027-01-01',
    endsOn: '2027-12-31',
  })
  @ApiSuccess(200, {
    description: 'Awaiting approval (or awarded)',
    type: QuotationRoundDto,
    example: ROUND_EXAMPLE,
  })
  @ApiStandardErrors(
    'quotation.minimum_not_met',
    'quotation.expired',
    'vendor.blocked',
    'fund.resolution_required',
    'fund.resolution_invalid',
    ...ROUND_ERRORS,
  )
  async award(
    @CurrentTenant() ctx: TenantContext,
    @Param('roundId', ParseUUIDPipe) id: string,
    @Body() body: QuotationAwardDto,
  ): Promise<QuotationRoundDto> {
    return this.dto(ctx, await this.rounds.award(ctx, id, body));
  }

  @Post(':roundId/actions/approve')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.expense.approve')
  @ApiEndpoint({
    id: 'owner.juristicQuotations.approve',
    summary: 'Approve the award',
    description:
      'One approval by a user whose role is in the award’s band (403 `quotation.not_in_band`), never the one who asked for the award (403 `quotation.maker_checker`; the database refuses it too), once per user and award request (409 `quotation.already_decided`); enough approvals → `awarded` and the contract / expense request draft is created. Audited. Requires `Idempotency-Key` (D-091, D-310, D-331).',
    implements: ['D-091', 'D-310', 'D-331'],
  })
  @ApiJsonBody(StepDecisionDto, { reason: 'ที่ประชุมกรรมการเห็นชอบ ครั้งที่ 1/2570' })
  @ApiSuccess(200, {
    description: 'Approval recorded',
    type: QuotationRoundDto,
    example: {
      ...ROUND_EXAMPLE,
      state: 'awarded',
      approvalsGiven: 3,
      awardedAt: FAKE.dateTime,
      outcomeContractId: FAKE.uuid,
      nextActions: [],
    },
  })
  @ApiStandardErrors(
    'quotation.maker_checker',
    'quotation.not_in_band',
    'quotation.already_decided',
    ...ROUND_ERRORS,
  )
  async approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('roundId', ParseUUIDPipe) id: string,
    @Body() body: StepDecisionDto,
  ): Promise<QuotationRoundDto> {
    return this.dto(ctx, await this.rounds.decide(ctx, id, 'approved', body.reason ?? null));
  }

  @Post(':roundId/actions/reject')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.expense.approve')
  @ApiEndpoint({
    id: 'owner.juristicQuotations.reject',
    summary: 'Reject the award',
    description:
      'A band approver (not the requester) rejects with a reason: the round reopens for another selection (a new award request needs fresh approvals). Audited. Requires `Idempotency-Key` (D-091, D-310, D-331).',
    implements: ['D-091', 'D-310', 'D-331'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ขอให้เปรียบเทียบราคาเพิ่มอีกหนึ่งราย' })
  @ApiSuccess(200, {
    description: 'Reopened',
    type: QuotationRoundDto,
    example: { ...ROUND_EXAMPLE, state: 'open', nextActions: ['add_quotation', 'award', 'cancel'] },
  })
  @ApiStandardErrors(
    'quotation.maker_checker',
    'quotation.not_in_band',
    'quotation.already_decided',
    ...ROUND_ERRORS,
  )
  async reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('roundId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<QuotationRoundDto> {
    return this.dto(ctx, await this.rounds.decide(ctx, id, 'rejected', body.reason));
  }

  @Post(':roundId/actions/cancel')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.vendor.manage')
  @ApiEndpoint({
    id: 'owner.juristicQuotations.cancel',
    summary: 'Cancel the round',
    description:
      'An open round or one awaiting approval is cancelled with a reason. Audited. Requires `Idempotency-Key` (D-310, D-331).',
    implements: ['D-310', 'D-331'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ยกเลิกโครงการตามมติกรรมการ' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: QuotationRoundDto,
    example: { ...ROUND_EXAMPLE, state: 'cancelled', cancelledAt: FAKE.dateTime, nextActions: [] },
  })
  @ApiStandardErrors(...ROUND_ERRORS)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('roundId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<QuotationRoundDto> {
    return this.dto(ctx, await this.rounds.cancel(ctx, id, body.reason));
  }
}

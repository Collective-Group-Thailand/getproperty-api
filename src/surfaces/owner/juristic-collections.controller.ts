import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { toBangkokIso } from '@common/time/bangkok';
import { permissionsOf } from '@core/tenancy/access.service';
import {
  type DebtClearanceRow,
  DebtClearancesService,
  type IssuedClearance,
} from '@modules/ops-juristic/debt-clearances.service';
import { type PaymentPlanRow, PaymentPlansService } from '@modules/ops-juristic/payment-plans.service';
import { type MandateRow, RecurringPaymentsService } from '@modules/ops-payments/recurring-payments.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { DocumentDownloadDto } from './deposits.dto';
import { ReasonDto } from './governance.dto';
import {
  DebtClearanceCreateDto,
  DebtClearanceDto,
  DebtClearanceListQuery,
  type DebtClearanceStateName,
  type InstalmentStateName,
  PaymentMandateDto,
  PaymentMandateListQuery,
  type PaymentMandateMethodName,
  type PaymentMandateScopeName,
  type PaymentMandateStateName,
  PaymentPlanCreateDto,
  PaymentPlanDto,
  PaymentPlanListQuery,
  type PaymentPlanStateName,
  type PlanProposerName,
  type RequestChannelName,
} from './juristic-collections.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);
const permsOf = (ctx: TenantContext): ReadonlySet<string> => permissionsOf(ctx.role ? [ctx.role] : []);

// ------------------------------------------------------------------------------------------- mappers

export function paymentPlanDto(p: PaymentPlanRow, actions: string[] = []): PaymentPlanDto {
  return {
    id: p.id,
    unitId: p.unitId,
    unitNo: p.unit.unitNo,
    partyId: p.partyId,
    partyName: p.party.displayName,
    state: p.state as PaymentPlanStateName,
    proposedBy: p.proposedByKind as PlanProposerName,
    instalmentCount: p.instalmentCount,
    firstDueOn: day(p.firstDueOn),
    proposedPrincipal: p.proposedPrincipal.toFixed(2),
    principal: p.principal?.toFixed(2) ?? null,
    invoiceIds: p.invoiceIds,
    creditNoteIds: p.creditNoteIds,
    defaultAfterDays: p.defaultAfterDays,
    note: p.note,
    decidedReason: p.decidedReason,
    approvedAt: p.approvedAt ? toBangkokIso(p.approvedAt) : null,
    endedAt: p.endedAt ? toBangkokIso(p.endedAt) : null,
    acceleratedChargeId: p.acceleratedChargeId,
    instalments: p.instalments.map((i) => ({
      seq: i.seq,
      dueOn: day(i.dueOn),
      amount: i.amount.toFixed(2),
      state: i.state as InstalmentStateName,
      invoiceChargeId: i.invoiceChargeId,
      paidAt: isoOrNull(i.paidAt),
    })),
    nextActions: actions,
    createdAt: toBangkokIso(p.createdAt),
    version: p.version,
  };
}

function planActions(ctx: TenantContext, p: PaymentPlanRow): string[] {
  const perms = permsOf(ctx);
  const out: string[] = [];
  if (p.state === 'proposed' && perms.has('juristic.payment_plan.approve')) out.push('approve');
  if (p.state === 'proposed' && perms.has('juristic.collections.manage')) out.push('reject');
  if ((p.state === 'proposed' || p.state === 'active') && perms.has('juristic.collections.manage'))
    out.push('cancel');
  return out;
}

export function debtClearanceDto(
  r: DebtClearanceRow,
  verifyCode: string | null = null,
  actions: string[] = [],
): DebtClearanceDto {
  return {
    id: r.id,
    unitId: r.unitId,
    unitNo: r.unit.unitNo,
    partyId: r.partyId,
    partyName: r.party.displayName,
    requestedVia: r.requestedVia as RequestChannelName,
    asOf: day(r.asOf),
    language: r.language,
    state: r.state as DebtClearanceStateName,
    fee: r.fee.toFixed(2),
    number: r.number,
    documentId: r.documentId,
    validUntil: r.validUntil ? day(r.validUntil) : null,
    verifyCode,
    verifyCodeHint: r.verifyCodeHint,
    issuedAt: r.issuedAt ? toBangkokIso(r.issuedAt) : null,
    refuseReason: r.refuseReason,
    nextActions: actions,
    createdAt: toBangkokIso(r.createdAt),
  };
}

const clearanceActions = (ctx: TenantContext, r: DebtClearanceRow): string[] =>
  r.state === 'requested' && permsOf(ctx).has('juristic.collections.manage') ? ['issue', 'refuse'] : [];

export function mandateDto(m: MandateRow): PaymentMandateDto {
  return {
    id: m.id,
    unitId: m.unitId,
    unitNo: m.unit.unitNo,
    partyId: m.partyId,
    provider: m.provider,
    method: m.method as PaymentMandateMethodName,
    scope: m.scope as PaymentMandateScopeName,
    state: m.state as PaymentMandateStateName,
    masked: m.masked,
    activatedAt: isoOrNull(m.activatedAt),
    endedAt: isoOrNull(m.endedAt),
    endReason: m.endReason,
    createdAt: toBangkokIso(m.createdAt),
  };
}

// ------------------------------------------------------------------------------------------- examples

export const PLAN_EXAMPLE: PaymentPlanDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  partyId: FAKE.uuid,
  partyName: FAKE.nameTh,
  state: 'active' as PaymentPlanStateName,
  proposedBy: 'resident' as PlanProposerName,
  instalmentCount: 3,
  firstDueOn: '2027-02-01',
  proposedPrincipal: '10000.00',
  principal: '10000.00',
  invoiceIds: [FAKE.uuid],
  creditNoteIds: [FAKE.uuid],
  defaultAfterDays: 30,
  note: 'ขอผ่อน 3 งวด',
  decidedReason: null,
  approvedAt: FAKE.dateTime,
  endedAt: null,
  acceleratedChargeId: null,
  instalments: [
    {
      seq: 1,
      dueOn: '2027-02-01',
      amount: '3333.33',
      state: 'billed' as InstalmentStateName,
      invoiceChargeId: FAKE.uuid,
      paidAt: null,
    },
    {
      seq: 2,
      dueOn: '2027-03-01',
      amount: '3333.33',
      state: 'scheduled' as InstalmentStateName,
      invoiceChargeId: null,
      paidAt: null,
    },
    {
      seq: 3,
      dueOn: '2027-04-01',
      amount: '3333.34',
      state: 'scheduled' as InstalmentStateName,
      invoiceChargeId: null,
      paidAt: null,
    },
  ],
  nextActions: ['cancel'],
  createdAt: FAKE.dateTime,
  version: 2,
};

export const CLEARANCE_EXAMPLE: DebtClearanceDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  partyId: FAKE.uuid,
  partyName: FAKE.nameTh,
  requestedVia: 'liff' as RequestChannelName,
  asOf: '2027-03-15',
  language: 'th',
  state: 'issued' as DebtClearanceStateName,
  fee: '0.00',
  number: 'DCL-2027-00001',
  documentId: FAKE.uuid,
  validUntil: '2027-04-14',
  verifyCode: 'H4N8R2K7QX',
  verifyCodeHint: 'R7QX',
  issuedAt: FAKE.dateTime,
  refuseReason: null,
  nextActions: [],
  createdAt: FAKE.dateTime,
};

export const MANDATE_EXAMPLE: PaymentMandateDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  partyId: FAKE.uuid,
  provider: 'fake',
  method: 'direct_debit' as PaymentMandateMethodName,
  scope: 'advance_invoices' as PaymentMandateScopeName,
  state: 'active' as PaymentMandateStateName,
  masked: 'xxx-x-x1234-x',
  activatedAt: FAKE.dateTime,
  endedAt: null,
  endReason: null,
  createdAt: FAKE.dateTime,
};

export const DCL_DOWNLOAD: DocumentDownloadDto = {
  documentId: FAKE.uuid,
  number: 'DCL-2027-00001',
  url: 'https://storage.example.com/debt-clearance.pdf?X-Amz-Signature=abc',
  expiresAt: '2027-03-15T10:05:00+07:00',
};

// ------------------------------------------------------------------------------------------- payment plans

@ApiTags('owner.juristicPaymentPlans')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/payment-plans')
export class OwnerPaymentPlansController {
  constructor(private readonly plans: PaymentPlansService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicPaymentPlans.list',
    summary: 'Payment plans',
    description:
      'Payment plans of the tenant, newest first, with their instalments; filters `state`, `unitId`, `partyId` (D-308, D-325).',
    implements: ['D-308', 'D-325'],
  })
  @ApiPaginated(PaymentPlanDto, { example: PLAN_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: PaymentPlanListQuery,
  ): Promise<Page<PaymentPlanDto>> {
    const { rows, total } = await this.plans.list(ctx, {
      state: q.state,
      unitId: q.unitId,
      partyId: q.partyId,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((p) => paymentPlanDto(p, planActions(ctx, p))),
      total,
      q,
    );
  }

  @Get(':planId')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicPaymentPlans.get',
    summary: 'A payment plan',
    description: 'The plan with its instalments, covered invoices and credit notes (D-325).',
    implements: ['D-325'],
  })
  @ApiSuccess(200, { description: 'Plan', type: PaymentPlanDto, example: PLAN_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) id: string,
  ): Promise<PaymentPlanDto> {
    const p = await this.plans.get(ctx, id);
    return paymentPlanDto(p, planActions(ctx, p));
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicPaymentPlans.propose',
    summary: 'Propose a payment plan',
    description:
      'Staff proposes a plan of the party’s open invoices of the unit: 2 … `juristic.plan_max_instalments` monthly instalments from `firstDueOn` (default the 1st of next month). One open plan per party × unit (409 `payment_plan.open_exists`); nothing open → 409 `payment_plan.nothing_due`. Waits for approval (`…/actions/approve`). Audited, `juristic.payment_plan.proposed`. Requires `Idempotency-Key` (D-308, D-325).',
    implements: ['D-308', 'D-325'],
  })
  @ApiJsonBody(PaymentPlanCreateDto, {
    unitId: FAKE.uuid,
    partyId: FAKE.uuid,
    instalments: 3,
    firstDueOn: '2027-02-01',
  })
  @ApiSuccess(201, {
    description: 'Proposed',
    type: PaymentPlanDto,
    example: { ...PLAN_EXAMPLE, state: 'proposed' as PaymentPlanStateName, principal: null, instalments: [] },
  })
  @ApiStandardErrors(
    'payment_plan.open_exists',
    'payment_plan.nothing_due',
    'idempotency.key_required',
    ...WRITE,
  )
  async propose(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: PaymentPlanCreateDto,
  ): Promise<PaymentPlanDto> {
    const p = await this.plans.propose(ctx, body);
    return paymentPlanDto(p, planActions(ctx, p));
  }

  @Post(':planId/actions/approve')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.payment_plan.approve')
  @ApiEndpoint({
    id: 'owner.juristicPaymentPlans.approve',
    summary: 'Approve a payment plan',
    description:
      'Owner, manager or committee (D-320): the party’s balances open **now** become the principal — each covered invoice gets a credit note for its balance (reason `payment_plan`) and the principal is split into the monthly instalments (half-up, the remainder on the last: Σ exact). `default_after_days` is snapshotted from `juristic.plan_default_days`. The job `payment-plans` queues each instalment on its due month for the next monthly cycle; an instalment still unpaid `default_after_days` after its invoice’s due date defaults the plan (future instalments cancelled, the rest billed at once). The resident is told (`juristic.payment_plan.approved`). Requires `Idempotency-Key`.',
    implements: ['D-308', 'D-320', 'D-325'],
  })
  @ApiSuccess(200, { description: 'Approved', type: PaymentPlanDto, example: PLAN_EXAMPLE })
  @ApiStandardErrors(
    'payment_plan.invalid_state',
    'payment_plan.nothing_due',
    'invoice.credit_exceeds',
    'idempotency.key_required',
    ...WRITE,
  )
  async approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) id: string,
  ): Promise<PaymentPlanDto> {
    const p = await this.plans.approve(ctx, id);
    return paymentPlanDto(p, planActions(ctx, p));
  }

  @Post(':planId/actions/reject')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicPaymentPlans.reject',
    summary: 'Reject a proposed plan',
    description:
      'A proposed plan is rejected with a reason (audited, `juristic.payment_plan.rejected`, D-325).',
    implements: ['D-325'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'ยอดค้างเกินกว่าที่ผ่อนได้' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: PaymentPlanDto,
    example: { ...PLAN_EXAMPLE, state: 'rejected' as PaymentPlanStateName, nextActions: [] },
  })
  @ApiStandardErrors('payment_plan.invalid_state', ...WRITE)
  async reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<PaymentPlanDto> {
    return paymentPlanDto(await this.plans.reject(ctx, id, body.reason));
  }

  @Post(':planId/actions/cancel')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicPaymentPlans.cancel',
    summary: 'Cancel a payment plan',
    description:
      'A proposed plan is withdrawn; an **active** plan ends — its scheduled instalments are cancelled and their sum is queued as one charge for the next monthly cycle (the original debt, never forgiven or increased). Audited, `juristic.payment_plan.cancelled`. Requires `Idempotency-Key` (D-325).',
    implements: ['D-325'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'ผู้ชำระขอยกเลิก' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: PaymentPlanDto,
    example: {
      ...PLAN_EXAMPLE,
      state: 'cancelled' as PaymentPlanStateName,
      acceleratedChargeId: FAKE.uuid,
      nextActions: [],
    },
  })
  @ApiStandardErrors('payment_plan.invalid_state', 'idempotency.key_required', ...WRITE)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<PaymentPlanDto> {
    return paymentPlanDto(await this.plans.cancel(ctx, id, body.reason));
  }
}

// ------------------------------------------------------------------------------------------- debt clearance

@ApiTags('owner.juristicDebtClearances')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/debt-clearances')
export class OwnerDebtClearancesController {
  constructor(private readonly clearances: DebtClearancesService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicDebtClearances.list',
    summary: 'Debt clearance certificates',
    description: 'Requests and certificates, newest first; filters `state`, `unitId` (D-306, D-325).',
    implements: ['D-306', 'D-325'],
  })
  @ApiPaginated(DebtClearanceDto, { example: { ...CLEARANCE_EXAMPLE, verifyCode: null } })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: DebtClearanceListQuery,
  ): Promise<Page<DebtClearanceDto>> {
    const { rows, total } = await this.clearances.list(ctx, {
      state: q.state,
      unitId: q.unitId,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((r) => debtClearanceDto(r, null, clearanceActions(ctx, r))),
      total,
      q,
    );
  }

  @Get(':debtClearanceId')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicDebtClearances.get',
    summary: 'A debt clearance certificate',
    description: 'One request / certificate (D-306).',
    implements: ['D-306'],
  })
  @ApiSuccess(200, {
    description: 'Certificate',
    type: DebtClearanceDto,
    example: { ...CLEARANCE_EXAMPLE, verifyCode: null },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('debtClearanceId', ParseUUIDPipe) id: string,
  ): Promise<DebtClearanceDto> {
    const r = await this.clearances.get(ctx, id);
    return debtClearanceDto(r, null, clearanceActions(ctx, r));
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicDebtClearances.create',
    summary: 'Issue a debt clearance certificate',
    description:
      'For a co-owner of the unit today (422 otherwise), as of `asOf` (today … +60 days). Issued **only when nothing is outstanding**: open invoices billed to the owner or the owner’s bill-to payers, pending one-off charges / surcharges / instalments and drafts whose period has started by `asOf`, less the owner’s credit — else 409 `debt_clearance.outstanding` with the amount in `outstanding` (nothing stored). Fee 0 (`juristic.debt_clearance.fee`, default) → issued at once: gapless number `DCL-YYYY-NNNNN`, PDF with a verification QR (`<web>/verify/<code>`), valid `juristic.debt_clearance.validity_days`; the code is returned once in `verifyCode`. A fee → `requested` with the fee charged; issue it once paid. Audited; `juristic.debt_clearance.issued` tells the owner. Requires `Idempotency-Key` (D-306, D-325).',
    implements: ['D-306', 'D-325'],
  })
  @ApiJsonBody(DebtClearanceCreateDto, { unitId: FAKE.uuid, partyId: FAKE.uuid, asOf: '2027-03-15' })
  @ApiSuccess(201, {
    description: 'Issued (or requested with a fee)',
    type: DebtClearanceDto,
    example: CLEARANCE_EXAMPLE,
  })
  @ApiStandardErrors('debt_clearance.outstanding', 'idempotency.key_required', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: DebtClearanceCreateDto,
  ): Promise<DebtClearanceDto> {
    const r: IssuedClearance = await this.clearances.create(ctx, body);
    return debtClearanceDto(r.row, r.verifyCode, clearanceActions(ctx, r.row));
  }

  @Post(':debtClearanceId/actions/issue')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicDebtClearances.issue',
    summary: 'Issue a waiting certificate',
    description:
      'A requested certificate (its fee paid) is issued — re-checked: 409 `debt_clearance.outstanding` while anything is due. Requires `Idempotency-Key` (D-306, D-325).',
    implements: ['D-306', 'D-325'],
  })
  @ApiSuccess(200, { description: 'Issued', type: DebtClearanceDto, example: CLEARANCE_EXAMPLE })
  @ApiStandardErrors(
    'debt_clearance.outstanding',
    'debt_clearance.invalid_state',
    'idempotency.key_required',
    ...WRITE,
  )
  async issue(
    @CurrentTenant() ctx: TenantContext,
    @Param('debtClearanceId', ParseUUIDPipe) id: string,
  ): Promise<DebtClearanceDto> {
    const r = await this.clearances.issue(ctx, id);
    return debtClearanceDto(r.row, r.verifyCode, clearanceActions(ctx, r.row));
  }

  @Post(':debtClearanceId/actions/refuse')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicDebtClearances.refuse',
    summary: 'Refuse a waiting request',
    description:
      'A requested certificate is refused with a reason (its unpaid fee charge cancelled); the co-owner is told (`juristic.debt_clearance.refused`, D-306).',
    implements: ['D-306', 'D-325'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'ยังไม่ได้ชำระค่าธรรมเนียม' })
  @ApiSuccess(200, {
    description: 'Refused',
    type: DebtClearanceDto,
    example: {
      ...CLEARANCE_EXAMPLE,
      state: 'refused' as DebtClearanceStateName,
      number: null,
      documentId: null,
      validUntil: null,
      verifyCode: null,
      verifyCodeHint: null,
      issuedAt: null,
      refuseReason: 'ยังไม่ได้ชำระค่าธรรมเนียม',
    },
  })
  @ApiStandardErrors('debt_clearance.invalid_state', ...WRITE)
  async refuse(
    @CurrentTenant() ctx: TenantContext,
    @Param('debtClearanceId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<DebtClearanceDto> {
    return debtClearanceDto(await this.clearances.refuse(ctx, id, body.reason));
  }

  @Get(':debtClearanceId/document')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicDebtClearances.document',
    summary: 'Open the certificate PDF',
    description: 'A 5-minute signed URL of the issued certificate (D-306).',
    implements: ['D-306'],
  })
  @ApiSuccess(200, { description: 'Download', type: DocumentDownloadDto, example: DCL_DOWNLOAD })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async document(
    @CurrentTenant() ctx: TenantContext,
    @Param('debtClearanceId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.clearances.document(ctx, id);
    return {
      documentId: r.row.documentId!,
      number: r.row.number!,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }
}

// ------------------------------------------------------------------------------------------- mandates

@ApiTags('owner.paymentMandates')
@ApiSurface(SURFACES.owner)
@Controller('owner/payment-mandates')
export class OwnerPaymentMandatesController {
  constructor(private readonly recurring: RecurringPaymentsService) {}

  @Get()
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.paymentMandates.list',
    summary: 'Automatic payment mandates',
    description:
      'Direct-debit / card mandates residents set up (channel `recurring`, fake until O-020); filters `state`, `unitId`. Only a masked account / card is shown (D-308, D-325).',
    implements: ['D-308', 'D-325'],
  })
  @ApiPaginated(PaymentMandateDto, { example: MANDATE_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: PaymentMandateListQuery,
  ): Promise<Page<PaymentMandateDto>> {
    const { rows, total } = await this.recurring.list(ctx, {
      state: q.state,
      unitId: q.unitId,
      ...toSkipTake(q),
    });
    return paginated(rows.map(mandateDto), total, q);
  }

  @Post(':mandateId/actions/revoke')
  @HttpCode(200)
  @TenantScoped()
  @Can('payment.record')
  @ApiEndpoint({
    id: 'owner.paymentMandates.revoke',
    summary: 'Revoke a mandate',
    description:
      'Stops a pending or active mandate with a reason (the provider is told; nothing more is charged). Audited (D-325).',
    implements: ['D-325'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'ผู้ชำระแจ้งยกเลิกที่สำนักงาน' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: PaymentMandateDto,
    example: { ...MANDATE_EXAMPLE, state: 'revoked' as PaymentMandateStateName, endedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('payment_mandate.invalid_state', ...WRITE)
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('mandateId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<PaymentMandateDto> {
    return mandateDto(await this.recurring.revoke(ctx, id, body.reason));
  }
}

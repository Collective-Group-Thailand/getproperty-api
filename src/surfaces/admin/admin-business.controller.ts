import { Can } from '@common/auth/can.decorator';
import { DomainException } from '@common/errors/domain.exception';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { bangkokDate } from '@common/time/bangkok';
import { AiUsageService } from '@core/ai-usage/ai-usage.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';
import { TenantService } from '@core/tenancy/tenant.service';
import { PilotKpisService } from '@modules/platform-analytics/pilot-kpis.service';
import { FieldWorkService } from '@modules/platform-subscriptions/field-work.service';
import { HaasService } from '@modules/platform-subscriptions/haas.service';
import { PilotsService } from '@modules/platform-subscriptions/pilots.service';
import { PlatformBillingService } from '@modules/platform-subscriptions/platform-billing.service';
import { PricePlansService } from '@modules/platform-subscriptions/price-plans.service';
import { SubscriptionsService } from '@modules/platform-subscriptions/subscriptions.service';
import { TenantHealthService } from '@modules/platform-subscriptions/tenant-health.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import Decimal from 'decimal.js';

import { DocumentDownloadDto } from '../owner/deposits.dto';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type AiFeatureName,
  AiUsageDto,
  HaasActionName,
  HaasAssetCreateDto,
  HaasAssetDto,
  HaasListQuery,
  HaasStateName,
  HaasTransitionDto,
  InstallOrderActionDto,
  InstallOrderActionName,
  InstallOrderCreateDto,
  InstallOrderDto,
  InstallOrderListQuery,
  KpiQuery,
  KpiWindowName,
  ManualPlatformPaymentMethodName,
  PilotAgreementDto,
  PilotAgreementUpsertDto,
  PilotKpisDto,
  PlatformCreditNoteDto,
  PlatformCreditNoteRequestDto,
  PlatformInvoiceDto,
  PlatformInvoiceListQuery,
  PlatformPaymentCreateDto,
  PricePlanDto,
  PricePlanVersionCreateDto,
  PricePlanVersionDto,
  SiteSurveyActionDto,
  SiteSurveyActionName,
  SiteSurveyDto,
  SiteSurveyListQuery,
  SubscriptionCancelDto,
  SubscriptionChangePlanDto,
  SubscriptionCreateDto,
  SubscriptionDto,
  SubscriptionEventDto,
  SubscriptionListQuery,
  type SubscriptionStatusName,
  SubscriptionSuspendDto,
  TenantFeatureFlagsDto,
  TenantHealthDto,
  type TenantHealthSignalName,
} from './platform-business.dto';
import {
  creditNoteDto,
  haasDto,
  installOrderDto,
  pilotDto,
  planVersionDto,
  PLATFORM_INVOICE_EXAMPLE,
  platformInvoiceDto,
  pricePlanDto,
  siteSurveyDto,
  SUBSCRIPTION_EXAMPLE,
  subscriptionDto,
} from './platform-business.mappers';

const PLAN_VERSION_EXAMPLE: PricePlanVersionDto = {
  id: FAKE.uuid,
  version: 1,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  billingUnit: 'per_unit' as never,
  unitPrice: '25.0000',
  priceRange: null,
  tiers: [],
  minUnits: 20,
  minMonthly: null,
  annualDiscountPct: '15.0000',
  termMonths: null,
  setupFee: '0.00',
  includedAllowances: { ocrPhotosPerMonth: 500, ocrOveragePerPhoto: '0.50' },
  vatRate: '0.0700',
  terms: { status: 'proposed', decision: 'D-156' },
  state: 'published' as never,
  publishedAt: FAKE.dateTime,
  nextActions: [],
};
const CREDIT_NOTE_EXAMPLE: PlatformCreditNoteDto = {
  id: FAKE.uuid,
  invoiceId: FAKE.uuid,
  state: 'requested' as never,
  number: null,
  amount: '100.00',
  reason: 'คิดหน่วยเกินจากห้องที่ปิดปรับปรุง',
  requestedBy: FAKE.uuid,
  approvedBy: null,
  issuedAt: null,
  nextActions: ['approve', 'reject'],
};
const HAAS_EXAMPLE: HaasAssetDto = {
  id: FAKE.uuid,
  deviceId: FAKE.gatewayId,
  serial: 'GP-GW-000123',
  kind: 'gateway',
  tenantId: FAKE.tenantId,
  buildingId: FAKE.buildingId,
  state: HaasStateName.InService,
  installedOn: '2027-02-01',
  termMonths: 36,
  termEnd: '2030-01-31',
  monthlyValue: '60.00',
  acquisitionCost: '1800.00',
  bookValue: '1750.00',
  replacedByAssetId: null,
  deinstallOrderId: null,
  events: [{ type: 'installed', occurredAt: FAKE.dateTime, data: { from: 'allocated' } }],
  nextActions: ['replace', 'deinstall', 'write-off'],
};
const INSTALL_ORDER_EXAMPLE: InstallOrderDto = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  kind: 'install' as never,
  state: 'open' as never,
  assignedTo: null,
  dueAt: null,
  items: [
    { unitId: null, assetItemId: null, deviceKind: 'gateway', deviceId: null, done: false },
    {
      unitId: FAKE.uuid,
      assetItemId: FAKE.meterId,
      deviceKind: 'electric_meter',
      deviceId: null,
      done: false,
    },
  ],
  notes: null,
  completedAt: null,
  nextActions: ['assign', 'start', 'complete-items', 'complete', 'cancel'],
};
const SURVEY_EXAMPLE: SiteSurveyDto = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  buildingId: FAKE.buildingId,
  targetPlanKey: 'apartment_smart',
  state: 'requested' as never,
  scheduledFor: null,
  assignedTo: null,
  findings: {},
  notes: 'สะดวกวันเสาร์',
  installOrderId: null,
  createdAt: FAKE.dateTime,
};
export const PILOT_EXAMPLE: PilotAgreementDto = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  signedOn: '2027-02-01',
  discountPct: '30.0000',
  termMonths: 6,
  referenceSiteRights: true,
  anonymisedDataUse: true,
  feedbackCadence: 'biweekly',
  kpiReviewOn: '2027-05-02',
  kpiTargets: { autoReconciledPctMin: '90' },
  baseline: { timeToBillHours: '72' },
  agreementDocumentId: null,
  notes: null,
};
export const pilotKpisDto = (r: Awaited<ReturnType<PilotKpisService['compute']>>): PilotKpisDto => ({
  tenantId: r.tenantId,
  window: r.window as KpiWindowName,
  from: r.from.toISOString(),
  to: r.to.toISOString(),
  kpiReviewOn: r.pilot ? r.pilot.kpiReviewAt.toISOString().slice(0, 10) : null,
  kpis: r.kpis,
  current: r.current,
  acceptance: r.acceptance,
});

export const KPIS_EXAMPLE: PilotKpisDto = {
  tenantId: FAKE.tenantId,
  window: KpiWindowName.D90,
  from: '2026-07-19T10:00:00+07:00',
  to: FAKE.dateTime,
  kpiReviewOn: '2027-05-02',
  kpis: [{ kpi: 'auto_reconciled', baseline: '0', current: '95.00', target: '>=90%', met: true }],
  current: {
    timeToBillHours: '0.25',
    invoiceCorrectionRatePct: '0.00',
    onTimePaymentPct: '81.25',
    autoReconciledPct: '95.00',
    lossIdentified: true,
    latestLossPct: '2.2706',
    meterUptimePct: null,
    csat: null,
  },
  acceptance: {
    firstFullCycleWithin1h: true,
    paidByQrPct: '72.00',
    serviceRequestsViaLinePct: null,
    buildingsBillingAutomatically: 1,
  },
};
const PDF_EXAMPLE: DocumentDownloadDto = {
  documentId: FAKE.uuid,
  number: 'PIV-2026-00001',
  url: 'https://storage.example.com/piv.pdf?X-Amz-Signature=abc',
  expiresAt: '2026-11-01T00:20:00+07:00',
};

const linkDto = (l: {
  documentId: string;
  number: string;
  url: string;
  expiresAt: Date;
}): DocumentDownloadDto => ({
  documentId: l.documentId,
  number: l.number,
  url: l.url,
  expiresAt: l.expiresAt.toISOString(),
});

// --------------------------------------------------------------------------------------------- price plans

@ApiTags('admin.pricePlans')
@ApiSurface(SURFACES.admin)
@Controller('admin/price-plans')
export class AdminPricePlansController {
  constructor(private readonly plans: PricePlansService) {}

  @Get()
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.pricePlans.list',
    summary: 'Price plans and their versions',
    description:
      'Every plan of the platform (software plans, add-ons, hardware rental, services) with its effective-dated versions — D-156 values, Proposed until validated in the pilot (draft plans are not sold).',
    implements: ['D-156', 'ADR-0004'],
  })
  @ApiSuccess(200, {
    description: 'Plans',
    type: [PricePlanDto],
    example: [
      {
        id: FAKE.uuid,
        key: 'apartment_starter',
        tenantType: 'apartment',
        nameTh: 'Apartment Starter',
        nameEn: 'Apartment Starter',
        kind: 'software',
        isActive: true,
        versions: [PLAN_VERSION_EXAMPLE],
      },
    ],
  })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<PricePlanDto[]> {
    return (await this.plans.list()).map(pricePlanDto);
  }

  @Post(':planId/versions')
  @Idempotent()
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.pricePlans.addVersion',
    summary: 'Draft a new price version',
    description:
      'A draft effective-dated version of a plan (price per billing unit or tiers, minimum, annual discount, VAT, allowances). Nothing changes until it is published (ADR-0004).',
    implements: ['D-156', 'ADR-0004'],
  })
  @ApiJsonBody(PricePlanVersionCreateDto, {
    effectiveFrom: '2027-03-01',
    billingUnit: 'per_unit',
    unitPrice: '29',
    minUnits: 20,
    includedAllowances: { ocrPhotosPerMonth: 500, ocrOveragePerPhoto: '0.50' },
  })
  @ApiSuccess(201, {
    description: 'Drafted',
    type: PricePlanVersionDto,
    example: {
      ...PLAN_VERSION_EXAMPLE,
      version: 2,
      state: 'draft',
      publishedAt: null,
      nextActions: ['publish'],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async addVersion(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: PricePlanVersionCreateDto,
  ): Promise<PricePlanVersionDto> {
    return planVersionDto(await this.plans.addVersion(planId, body));
  }

  @Post('versions/:versionId/actions/publish')
  @HttpCode(200)
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.pricePlans.publish',
    summary: 'Publish a price version',
    description:
      'Publishes a draft from its effective date (never backdated, 422 `settings.backdated`); the version in force ends the day before (published versions never overlap). Invoices from that date use it; issued invoices keep their snapshot. Audited and evented (`price_plan.published`).',
    implements: ['D-156', 'ADR-0004'],
  })
  @ApiSuccess(200, { description: 'Published', type: PricePlanVersionDto, example: PLAN_VERSION_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'price_plan.invalid_state',
    'settings.backdated',
  )
  async publish(@Param('versionId', ParseUUIDPipe) versionId: string): Promise<PricePlanVersionDto> {
    return planVersionDto(await this.plans.publish(versionId));
  }
}

// --------------------------------------------------------------------------------------------- subscriptions

@ApiTags('admin.subscriptions')
@ApiSurface(SURFACES.admin)
@Controller('admin/subscriptions')
export class AdminSubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly tenants: TenantService,
  ) {}

  private async dto(id: string): Promise<SubscriptionDto> {
    const s = await this.subscriptions.get(id);
    return subscriptionDto(s, await this.subscriptions.addonRefs(s));
  }

  @Get()
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.subscriptions.list',
    summary: 'Subscriptions',
    description: 'Subscriptions of every tenant, filtered by tenant or state (D-082).',
    implements: ['D-082', 'D-156'],
  })
  @ApiPaginated(SubscriptionDto, { example: SUBSCRIPTION_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: SubscriptionListQuery): Promise<Page<SubscriptionDto>> {
    const { rows, total } = await this.subscriptions.list({
      tenantId: query.tenantId,
      state: query.state,
      ...toSkipTake(query),
    });
    const data = await Promise.all(
      rows.map(async (s) => subscriptionDto(s, await this.subscriptions.addonRefs(s))),
    );
    return paginated(data, total, query);
  }

  @Post()
  @Idempotent()
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.subscriptions.create',
    summary: 'Subscribe a tenant to a plan',
    description:
      'Starts the trial (`subscription.trial_days`) on the version of the plan in force today, with add-ons (meter rental for Smart) and the pilot discount if a pilot agreement exists (D-083). The plan must be sold (active, published) and for the tenant’s type. One open subscription per tenant (409 `subscription.exists`).',
    implements: ['D-082', 'D-083', 'D-156'],
  })
  @ApiJsonBody(SubscriptionCreateDto, { tenantId: FAKE.tenantId, planKey: 'apartment_starter' })
  @ApiSuccess(201, { description: 'Subscribed', type: SubscriptionDto, example: SUBSCRIPTION_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'subscription.exists',
    'subscription.plan_mismatch',
    'price_plan.not_found',
    'price_plan.not_sold',
  )
  async create(@Body() body: SubscriptionCreateDto): Promise<SubscriptionDto> {
    return this.dto((await this.subscriptions.create(body)).id);
  }

  @Get(':subscriptionId')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.subscriptions.get',
    summary: 'One subscription',
    description: 'A subscription with its plan, add-ons, discount and lifecycle dates (D-082).',
    implements: ['D-082'],
  })
  @ApiSuccess(200, { description: 'The subscription', type: SubscriptionDto, example: SUBSCRIPTION_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  get(@Param('subscriptionId', ParseUUIDPipe) id: string): Promise<SubscriptionDto> {
    return this.dto(id);
  }

  @Get(':subscriptionId/events')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.subscriptions.events',
    summary: 'History of a subscription',
    description:
      'Append-only history: created, plan changes, state moves with their reason, cancellation requests (D-082).',
    implements: ['D-082'],
  })
  @ApiSuccess(200, {
    description: 'History',
    type: [SubscriptionEventDto],
    example: [
      {
        id: FAKE.uuid,
        type: 'state.active',
        occurredAt: FAKE.dateTime,
        data: { from: 'trial', to: 'active', reason: 'first_payment' },
      },
    ],
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async events(@Param('subscriptionId', ParseUUIDPipe) id: string): Promise<SubscriptionEventDto[]> {
    await this.subscriptions.get(id);
    return (await this.subscriptions.eventsOf(id)).map((e) => ({
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      data: (e.data ?? {}) as Record<string, unknown>,
    }));
  }

  @Post(':subscriptionId/actions/change-plan')
  @Idempotent()
  @HttpCode(200)
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.subscriptions.changePlan',
    summary: 'Change the plan',
    description:
      'Moves the subscription to another sold plan of the tenant’s type (e.g. Starter → Smart with meter rental after the install). The next monthly invoice prices the new plan; issued invoices keep theirs (D-082, D-156).',
    implements: ['D-082', 'D-156'],
  })
  @ApiJsonBody(SubscriptionChangePlanDto, { planKey: 'apartment_smart', addonKeys: ['meter_rental'] })
  @ApiSuccess(200, { description: 'Changed', type: SubscriptionDto, example: SUBSCRIPTION_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'subscription.invalid_state',
    'subscription.plan_mismatch',
    'price_plan.not_found',
    'price_plan.not_sold',
  )
  async changePlan(
    @Param('subscriptionId', ParseUUIDPipe) id: string,
    @Body() body: SubscriptionChangePlanDto,
  ): Promise<SubscriptionDto> {
    await this.subscriptions.changePlan(id, body);
    return this.dto(id);
  }

  @Post(':subscriptionId/actions/cancel')
  @Idempotent()
  @HttpCode(200)
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.subscriptions.cancel',
    summary: 'Cancel at the end of the month',
    description:
      'Cancellation takes effect at the end of the current month (or a later date); then the tenant becomes read-only (data kept, exportable) and a de-install order is opened for the platform hardware (D-081, D-082).',
    implements: ['D-081', 'D-082'],
  })
  @ApiJsonBody(SubscriptionCancelDto, { reason: 'ลูกค้าขายกิจการ' })
  @ApiSuccess(200, {
    description: 'Cancellation scheduled',
    type: SubscriptionDto,
    example: {
      ...SUBSCRIPTION_EXAMPLE,
      cancelEffectiveDate: '2026-10-31',
      cancelReason: 'ลูกค้าขายกิจการ',
      nextActions: ['change-plan', 'suspend'],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'subscription.invalid_state')
  async cancel(
    @Param('subscriptionId', ParseUUIDPipe) id: string,
    @Body() body: SubscriptionCancelDto,
  ): Promise<SubscriptionDto> {
    await this.subscriptions.cancel(id, body);
    return this.dto(id);
  }

  @Post(':subscriptionId/actions/suspend')
  @Idempotent()
  @HttpCode(200)
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.subscriptions.suspend',
    summary: 'Suspend now (read-only)',
    description:
      'Typed confirmation (the tenant slug). The tenant becomes read-only at once: owner and staff writes are refused with 403 `tenant.read_only`; reads, exports and resident payments keep working; nothing is deleted (D-082). Audited.',
    implements: ['D-082'],
  })
  @ApiJsonBody(SubscriptionSuspendDto, {
    reason: 'ค้างชำระเกินกำหนดและติดต่อไม่ได้',
    confirm: 'sample-dormitory',
  })
  @ApiSuccess(200, {
    description: 'Suspended',
    type: SubscriptionDto,
    example: {
      ...SUBSCRIPTION_EXAMPLE,
      state: 'suspended',
      readOnly: true,
      nextActions: ['change-plan', 'cancel', 'reinstate'],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'subscription.invalid_state',
    'subscription.confirmation_mismatch',
  )
  async suspend(
    @Param('subscriptionId', ParseUUIDPipe) id: string,
    @Body() body: SubscriptionSuspendDto,
  ): Promise<SubscriptionDto> {
    const s = await this.subscriptions.get(id);
    const tenant = await this.tenants.getAny(s.tenantId);
    if (tenant.slug !== body.confirm) throw new DomainException('subscription.confirmation_mismatch');
    await this.subscriptions.setSuspended(id, true, body.reason);
    return this.dto(id);
  }

  @Post(':subscriptionId/actions/reinstate')
  @Idempotent()
  @HttpCode(200)
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.subscriptions.reinstate',
    summary: 'Reinstate',
    description:
      'Lifts a suspension (back to active, or trial when never activated); the tenant can write again (D-082). Audited.',
    implements: ['D-082'],
  })
  @ApiJsonBody(SubscriptionCancelDto, { reason: 'ชำระแล้วผ่านการโอน' })
  @ApiSuccess(200, { description: 'Reinstated', type: SubscriptionDto, example: SUBSCRIPTION_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'subscription.invalid_state')
  async reinstate(
    @Param('subscriptionId', ParseUUIDPipe) id: string,
    @Body() body: SubscriptionCancelDto,
  ): Promise<SubscriptionDto> {
    await this.subscriptions.setSuspended(id, false, body.reason);
    return this.dto(id);
  }
}

// --------------------------------------------------------------------------------------------- platform invoices

@ApiTags('admin.platformInvoices')
@ApiSurface(SURFACES.admin)
@Controller('admin/platform-invoices')
export class AdminPlatformInvoicesController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Get()
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.platformInvoices.list',
    summary: 'Platform invoices',
    description: 'Invoices of Collective Group (Thailand) to its tenants (D-146, D-156), newest first.',
    implements: ['D-146', 'D-156'],
  })
  @ApiPaginated(PlatformInvoiceDto, { example: PLATFORM_INVOICE_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: PlatformInvoiceListQuery): Promise<Page<PlatformInvoiceDto>> {
    const { rows, total } = await this.billing.list({
      tenantId: query.tenantId,
      state: query.state,
      ...toSkipTake(query),
    });
    return paginated(
      rows.map((r) => platformInvoiceDto(r)),
      total,
      query,
    );
  }

  @Get(':invoiceId')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.platformInvoices.get',
    summary: 'One platform invoice',
    description: 'Lines, payments with receipts, credit notes and the Thai QR (D-156).',
    implements: ['D-156'],
  })
  @ApiSuccess(200, {
    description: 'The invoice',
    type: PlatformInvoiceDto,
    example: PLATFORM_INVOICE_EXAMPLE,
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async get(@Param('invoiceId', ParseUUIDPipe) id: string): Promise<PlatformInvoiceDto> {
    return platformInvoiceDto(await this.billing.get(id));
  }

  @Get(':invoiceId/pdf')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.platformInvoices.pdf',
    summary: 'PDF of a platform invoice',
    description:
      'A short-lived signed URL of the invoice PDF (rendered after issue). 409 while it is still being rendered.',
    implements: ['D-146'],
  })
  @ApiSuccess(200, { description: 'Link', type: DocumentDownloadDto, example: PDF_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'platform_invoice.invalid_state',
  )
  async pdf(@Param('invoiceId', ParseUUIDPipe) id: string): Promise<DocumentDownloadDto> {
    return linkDto(await this.billing.pdfLink(id));
  }

  @Post(':invoiceId/payments')
  @Idempotent()
  @Can('admin.platform_invoice.issue')
  @ApiEndpoint({
    id: 'admin.platformInvoices.recordPayment',
    summary: 'Record a bank transfer',
    description:
      'Finance records money received outside the QR (bank transfer, card) with the bank reference (unique). Never more than the open amount; a numbered platform receipt is issued; a subscription past due or suspended with nothing overdue left is reinstated (D-082). Audited.',
    implements: ['D-082', 'D-091', 'D-146'],
  })
  @ApiJsonBody(PlatformPaymentCreateDto, {
    amount: '535.00',
    method: ManualPlatformPaymentMethodName.BankTransfer,
    paidAt: FAKE.dateTime,
    reference: 'KTB-20261105-778899',
  })
  @ApiSuccess(201, {
    description: 'Recorded',
    type: PlatformInvoiceDto,
    example: {
      ...PLATFORM_INVOICE_EXAMPLE,
      state: 'paid',
      paidTotal: '535.00',
      openAmount: '0.00',
      qr: null,
      nextActions: ['request-credit-note'],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'platform_invoice.invalid_state',
    'platform_invoice.amount_exceeds_open',
  )
  async recordPayment(
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Body() body: PlatformPaymentCreateDto,
  ): Promise<PlatformInvoiceDto> {
    await this.billing.recordManual(id, {
      amount: body.amount,
      method: body.method,
      provider: 'manual',
      providerRef: body.reference,
      paidAt: new Date(body.paidAt),
    });
    return platformInvoiceDto(await this.billing.get(id));
  }

  @Post(':invoiceId/credit-notes')
  @Idempotent()
  @Can('admin.platform_invoice.issue')
  @ApiEndpoint({
    id: 'admin.platformInvoices.requestCreditNote',
    summary: 'Request a credit note (maker)',
    description:
      'Asks for a credit note on an invoice (≤ what is not yet credited or requested). Another platform user approves it (D-091).',
    implements: ['D-091', 'D-146'],
  })
  @ApiJsonBody(PlatformCreditNoteRequestDto, {
    amount: '100.00',
    reason: 'คิดหน่วยเกินจากห้องที่ปิดปรับปรุง',
  })
  @ApiSuccess(201, { description: 'Requested', type: PlatformCreditNoteDto, example: CREDIT_NOTE_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'platform_invoice.invalid_state',
    'platform_invoice.amount_exceeds_open',
  )
  async requestCreditNote(
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Body() body: PlatformCreditNoteRequestDto,
  ): Promise<PlatformCreditNoteDto> {
    return creditNoteDto(await this.billing.requestCreditNote(id, body));
  }

  @Post('credit-notes/:creditNoteId/actions/approve')
  @Idempotent()
  @HttpCode(200)
  @Can('admin.platform_credit_note.approve')
  @ApiEndpoint({
    id: 'admin.platformInvoices.approveCreditNote',
    summary: 'Approve a credit note (checker)',
    description:
      'Another platform user than the requester (409 `platform_credit_note.same_approver`): the note is numbered, the invoice credited, its PDF rendered; a subscription with nothing overdue left is reinstated (D-082, D-091).',
    implements: ['D-082', 'D-091'],
  })
  @ApiSuccess(200, {
    description: 'Issued',
    type: PlatformCreditNoteDto,
    example: {
      ...CREDIT_NOTE_EXAMPLE,
      state: 'issued',
      number: 'PCN-2026-00001',
      approvedBy: FAKE.uuid,
      issuedAt: FAKE.dateTime,
      nextActions: [],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'platform_invoice.invalid_state',
    'platform_invoice.amount_exceeds_open',
    'platform_credit_note.same_approver',
  )
  async approve(@Param('creditNoteId', ParseUUIDPipe) id: string): Promise<PlatformCreditNoteDto> {
    return creditNoteDto(await this.billing.decideCreditNote(id, true));
  }

  @Post('credit-notes/:creditNoteId/actions/reject')
  @HttpCode(200)
  @Can('admin.platform_credit_note.approve')
  @ApiEndpoint({
    id: 'admin.platformInvoices.rejectCreditNote',
    summary: 'Reject a credit note (checker)',
    description: 'Another platform user than the requester rejects the request (D-091).',
    implements: ['D-091'],
  })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: PlatformCreditNoteDto,
    example: { ...CREDIT_NOTE_EXAMPLE, state: 'rejected', nextActions: [] },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'platform_invoice.invalid_state',
    'platform_credit_note.same_approver',
  )
  async reject(@Param('creditNoteId', ParseUUIDPipe) id: string): Promise<PlatformCreditNoteDto> {
    return creditNoteDto(await this.billing.decideCreditNote(id, false));
  }
}

// --------------------------------------------------------------------------------------------- pilots, KPIs, AI usage

@ApiTags('admin.tenants')
@ApiSurface(SURFACES.admin)
@Controller('admin/tenants/:tenantId')
export class AdminTenantBusinessController {
  constructor(
    private readonly pilots: PilotsService,
    private readonly kpis: PilotKpisService,
    private readonly ai: AiUsageService,
    private readonly subscriptions: SubscriptionsService,
    private readonly health: TenantHealthService,
    private readonly flags: FeatureFlagsService,
    private readonly tenants: TenantService,
  ) {}

  @Get('health')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.tenants.health',
    summary: 'Health of a tenant',
    description:
      'Company-level signals for the platform console — subscription and platform receivables, units counted today, the last billing cycle, gateway connectivity — and `signals` naming what needs attention. No tenant business data (that needs a support grant, D-090).',
    implements: ['D-082', 'D-090', 'D-161'],
  })
  @ApiSuccess(200, {
    description: 'Health',
    type: TenantHealthDto,
    example: {
      tenantId: FAKE.tenantId,
      status: 'active',
      subscriptionState: 'trial',
      planKey: 'apartment_starter',
      trialEndsAt: '2026-11-16T10:00:00+07:00',
      units: 12,
      buildings: 1,
      openPlatformInvoices: 0,
      overduePlatformAmount: '0.00',
      lastBillingCycle: { periodKey: '2026-10', status: 'issued', createdAt: FAKE.dateTime },
      gateways: { total: 1, online: 1 },
      signals: ['trial_ending'],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async tenantHealth(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<TenantHealthDto> {
    const h = await this.health.health(tenantId);
    return {
      ...h,
      subscriptionState: h.subscriptionState as SubscriptionStatusName | null,
      trialEndsAt: h.trialEndsAt ? h.trialEndsAt.toISOString() : null,
      lastBillingCycle: h.lastBillingCycle
        ? { ...h.lastBillingCycle, createdAt: h.lastBillingCycle.createdAt.toISOString() }
        : null,
      signals: h.signals as TenantHealthSignalName[],
    };
  }

  @Get('feature-flags')
  @Can('admin.feature_flag.manage')
  @ApiEndpoint({
    id: 'admin.tenants.featureFlags',
    summary: 'Feature flags of a tenant',
    description:
      'Every flag as it resolves for this tenant; change one with `admin.featureFlags.update` and `tenantId` (D-161).',
    implements: ['D-161'],
  })
  @ApiSuccess(200, {
    description: 'Flags',
    type: TenantFeatureFlagsDto,
    example: { tenantId: FAKE.tenantId, flags: { 'payments.provider.kbank': false } },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async tenantFlags(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<TenantFeatureFlagsDto> {
    await this.tenants.getAny(tenantId);
    return { tenantId, flags: await this.flags.forTenant(tenantId) };
  }

  @Get('pilot-agreement')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.pilots.get',
    summary: 'Pilot agreement of a tenant',
    description: 'Paid pilot terms, KPI targets and baseline (D-083). 404 when the tenant has none.',
    implements: ['D-083'],
  })
  @ApiSuccess(200, { description: 'The agreement', type: PilotAgreementDto, example: PILOT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async getPilot(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<PilotAgreementDto> {
    return pilotDto(await this.pilots.get(tenantId));
  }

  @Put('pilot-agreement')
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.pilots.upsert',
    summary: 'Record the pilot agreement',
    description:
      'Paid pilot at a discount (never 100 %), reference-site rights, anonymised data use, feedback cadence, the 90-day KPI review with its targets and the owner’s baseline (D-083). The discount applies to the open subscription. Audited.',
    implements: ['D-083'],
  })
  @ApiJsonBody(PilotAgreementUpsertDto, {
    signedOn: '2027-02-01',
    discountPct: '30',
    termMonths: 6,
    baseline: { timeToBillHours: '72', onTimePaymentPct: '62', autoReconciledPct: '0' },
  })
  @ApiSuccess(200, { description: 'Saved', type: PilotAgreementDto, example: PILOT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async upsertPilot(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: PilotAgreementUpsertDto,
  ): Promise<PilotAgreementDto> {
    const { signedOn, kpiReviewOn, ...rest } = body;
    return pilotDto(
      await this.pilots.upsert(tenantId, { ...rest, signedAt: signedOn, kpiReviewAt: kpiReviewOn ?? null }),
    );
  }

  @Get('pilot-kpis')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.pilots.kpis',
    summary: 'Pilot KPIs of a tenant',
    description:
      'The seven D-083 KPIs computed from the tenant’s data over the window (default 90 days): time to bill, invoice correction rate, on-time payment, auto-reconciled payments, utility loss identified, meter uptime, CSAT — read from the analytics rollups (B6.3, D-217) against the baseline and targets of the pilot agreement, plus the Phase 1 acceptance measures. The result is also stored as a snapshot.',
    implements: ['D-083', 'D-217'],
  })
  @ApiSuccess(200, { description: 'KPIs', type: PilotKpisDto, example: KPIS_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async pilotKpis(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: KpiQuery,
  ): Promise<PilotKpisDto> {
    return pilotKpisDto(await this.kpis.compute(tenantId, query.window ?? KpiWindowName.D90));
  }

  @Get('ai-usage')
  @Can('admin.ai_usage.read')
  @ApiEndpoint({
    id: 'admin.aiUsage.get',
    summary: 'AI usage of a tenant',
    description:
      'Monthly AI calls, units and cost per feature (meter photo OCR, utility-invoice OCR, …) of the last six months, with the plan’s included OCR allowance and the overage billed (D-161).',
    implements: ['D-161'],
  })
  @ApiSuccess(200, {
    description: 'Usage',
    type: AiUsageDto,
    example: {
      tenantId: FAKE.tenantId,
      months: [
        {
          month: '2026-11-01',
          feature: 'meter_ocr',
          calls: 120,
          units: 120,
          costThb: '0.00',
          allowance: 500,
          overage: 0,
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async aiUsage(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<AiUsageDto> {
    const allowance = await this.subscriptions.ocrAllowance(tenantId);
    const months = await this.ai.monthly(tenantId);
    return {
      tenantId,
      months: months.map((m) => {
        const a = m.feature === 'meter_ocr' ? allowance : null;
        return {
          month: m.month,
          feature: m.feature as AiFeatureName,
          calls: m.calls,
          units: m.units,
          costThb: new Decimal(m.costThb).toFixed(2),
          allowance: a,
          overage: a == null ? 0 : Math.max(0, m.units - a),
        };
      }),
    };
  }
}

// --------------------------------------------------------------------------------------------- HaaS register

@ApiTags('admin.haas')
@ApiSurface(SURFACES.admin)
@Controller('admin/haas-assets')
export class AdminHaasController {
  constructor(
    private readonly haas: HaasService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private today() {
    return bangkokDate(this.clock.now());
  }

  @Get()
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.haas.list',
    summary: 'HaaS asset register',
    description:
      'Platform-owned devices placed at tenants with term, monthly value and straight-line book value (D-081).',
    implements: ['D-081'],
  })
  @ApiPaginated(HaasAssetDto, { example: HAAS_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: HaasListQuery): Promise<Page<HaasAssetDto>> {
    const { rows, total } = await this.haas.list({
      tenantId: query.tenantId,
      state: query.state,
      ...toSkipTake(query),
    });
    const today = this.today();
    return paginated(
      rows.map((r) => haasDto(r, today)),
      total,
      query,
    );
  }

  @Post()
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.haas.register',
    summary: 'Register a platform device at a tenant',
    description:
      'A device owned by the platform (`ownership = platform_haas`) allocated to a tenant with its term, monthly value and acquisition cost (D-081). Audited.',
    implements: ['D-081'],
  })
  @ApiJsonBody(HaasAssetCreateDto, {
    deviceId: FAKE.gatewayId,
    tenantId: FAKE.tenantId,
    buildingId: FAKE.buildingId,
    termMonths: 36,
    monthlyValue: '60.00',
    acquisitionCost: '1800.00',
  })
  @ApiSuccess(201, {
    description: 'Registered',
    type: HaasAssetDto,
    example: {
      ...HAAS_EXAMPLE,
      state: HaasStateName.Allocated,
      installedOn: null,
      termEnd: null,
      bookValue: '1800.00',
      nextActions: ['install', 'write-off'],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'http.conflict',
    'haas.not_platform_owned',
    'haas.tenant_mismatch',
  )
  async register(@Body() body: HaasAssetCreateDto): Promise<HaasAssetDto> {
    return haasDto(await this.haas.register(body), this.today());
  }

  @Get(':assetId')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.haas.get',
    summary: 'One HaaS asset',
    description: 'With its state history and replacement chain (D-081).',
    implements: ['D-081'],
  })
  @ApiSuccess(200, { description: 'The asset', type: HaasAssetDto, example: HAAS_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async get(@Param('assetId', ParseUUIDPipe) id: string): Promise<HaasAssetDto> {
    return haasDto(await this.haas.get(id), this.today());
  }

  @Post(':assetId/actions/:action')
  @HttpCode(200)
  @Can('admin.device.manage')
  @ApiParam({ name: 'action', enum: HaasActionName, enumName: 'HaasAction' })
  @ApiEndpoint({
    id: 'admin.haas.transition',
    summary: 'Move a HaaS asset',
    description:
      'install (date; the term starts), in-service, replace (with the replacing platform device), deinstall (with the order that removed it), write-off (D-081). Audited and evented.',
    implements: ['D-081'],
  })
  @ApiJsonBody(HaasTransitionDto, { date: '2027-02-01' })
  @ApiSuccess(200, { description: 'Moved', type: HaasAssetDto, example: HAAS_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'haas.invalid_transition',
    'haas.not_platform_owned',
  )
  async transition(
    @Param('assetId', ParseUUIDPipe) id: string,
    @Param('action') action: string,
    @Body() body: HaasTransitionDto,
  ): Promise<HaasAssetDto> {
    const to = (
      {
        install: 'installed',
        'in-service': 'in_service',
        replace: 'replaced',
        deinstall: 'deinstalled',
        'write-off': 'written_off',
      } as const
    )[action as 'install'];
    if (!to) throw new DomainException('http.not_found');
    return haasDto(await this.haas.transition(id, to, body), this.today());
  }
}

// --------------------------------------------------------------------------------------------- field work

@ApiTags('admin.fieldWork')
@ApiSurface(SURFACES.admin)
@Controller('admin')
export class AdminFieldWorkController {
  constructor(private readonly field: FieldWorkService) {}

  @Get('install-orders')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.installOrders.list',
    summary: 'Install orders',
    description:
      'Install, de-install and replace orders of the platform’s field engineers (D-081), due first.',
    implements: ['D-081'],
  })
  @ApiPaginated(InstallOrderDto, { example: INSTALL_ORDER_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async listOrders(@Query() query: InstallOrderListQuery): Promise<Page<InstallOrderDto>> {
    const { rows, total } = await this.field.listOrders({
      tenantId: query.tenantId,
      state: query.state,
      kind: query.kind,
      ...toSkipTake(query),
    });
    return paginated(rows.map(installOrderDto), total, query);
  }

  @Post('install-orders')
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.installOrders.create',
    summary: 'Open an install order',
    description:
      'An order for one building of the tenant with its items (gateway, meter devices per unit) (D-081). Audited and evented.',
    implements: ['D-081'],
  })
  @ApiJsonBody(InstallOrderCreateDto, {
    tenantId: FAKE.tenantId,
    buildingId: FAKE.buildingId,
    kind: 'install',
    items: [{ unitId: null, assetItemId: null, deviceKind: 'gateway', deviceId: null, done: false }],
  })
  @ApiSuccess(201, { description: 'Opened', type: InstallOrderDto, example: INSTALL_ORDER_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async createOrder(@Body() body: InstallOrderCreateDto): Promise<InstallOrderDto> {
    return installOrderDto(
      await this.field.createOrder({ ...body, dueAt: body.dueAt ? new Date(body.dueAt) : null }),
    );
  }

  @Get('install-orders/:orderId')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.installOrders.get',
    summary: 'One install order',
    description: 'An install order with its items (D-081).',
    implements: ['D-081'],
  })
  @ApiSuccess(200, { description: 'The order', type: InstallOrderDto, example: INSTALL_ORDER_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async getOrder(@Param('orderId', ParseUUIDPipe) id: string): Promise<InstallOrderDto> {
    return installOrderDto(await this.field.getOrder(id));
  }

  @Post('install-orders/:orderId/actions/:action')
  @HttpCode(200)
  @Can('admin.device.manage')
  @ApiParam({ name: 'action', enum: InstallOrderActionName, enumName: 'InstallOrderAction' })
  @ApiEndpoint({
    id: 'admin.installOrders.act',
    summary: 'Work an install order',
    description:
      'assign (a field engineer), start, complete-items (item positions with the device placed), complete (every item done), cancel (D-081). Audited; state changes are evented.',
    implements: ['D-081'],
  })
  @ApiJsonBody(InstallOrderActionDto, { itemIndexes: [0], deviceIds: [FAKE.gatewayId] })
  @ApiSuccess(200, { description: 'Updated', type: InstallOrderDto, example: INSTALL_ORDER_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'install_order.invalid_transition',
    'install_order.items_open',
    'install_order.assignee_invalid',
  )
  async act(
    @Param('orderId', ParseUUIDPipe) id: string,
    @Param('action') action: string,
    @Body() body: InstallOrderActionDto,
  ): Promise<InstallOrderDto> {
    if (!['assign', 'start', 'complete-items', 'complete', 'cancel'].includes(action))
      throw new DomainException('http.not_found');
    return installOrderDto(await this.field.updateOrder(id, action as 'assign', body));
  }

  @Get('site-surveys')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.siteSurveys.list',
    summary: 'Site surveys',
    description:
      'Surveys owners asked for to upgrade Starter → Smart (D-156), newest first; `state` filters by `SiteSurveyState` (D-214).',
    implements: ['D-156'],
  })
  @ApiSuccess(200, { description: 'Surveys', type: [SiteSurveyDto], example: [SURVEY_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async listSurveys(@Query() query: SiteSurveyListQuery): Promise<SiteSurveyDto[]> {
    return (await this.field.listSurveys({ tenantId: query.tenantId, state: query.state })).map(
      siteSurveyDto,
    );
  }

  @Post('site-surveys/:surveyId/actions/:action')
  @HttpCode(200)
  @Can('admin.device.manage')
  @ApiParam({ name: 'action', enum: SiteSurveyActionName, enumName: 'SiteSurveyAction' })
  @ApiEndpoint({
    id: 'admin.siteSurveys.act',
    summary: 'Work a site survey',
    description:
      'schedule (date, engineer), complete with findings — opening the building’s install order (gateway + a meter device per unit and utility not yet read by IoT) unless `install: false` — or cancel (D-081, D-156).',
    implements: ['D-081', 'D-156'],
  })
  @ApiJsonBody(SiteSurveyActionDto, { findings: { rs485: 'ok', cabinet: 'ชั้น 1' }, install: true })
  @ApiSuccess(200, {
    description: 'Updated',
    type: SiteSurveyDto,
    example: { ...SURVEY_EXAMPLE, state: 'done', installOrderId: FAKE.uuid },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'install_order.invalid_transition',
  )
  async actSurvey(
    @Param('surveyId', ParseUUIDPipe) id: string,
    @Param('action') action: string,
    @Body() body: SiteSurveyActionDto,
  ): Promise<SiteSurveyDto> {
    if (!['schedule', 'complete', 'cancel'].includes(action)) throw new DomainException('http.not_found');
    return siteSurveyDto(
      await this.field.updateSurvey(id, action as 'schedule', {
        ...body,
        scheduledFor: body.scheduledFor
          ? new Date(body.scheduledFor)
          : body.scheduledFor === null
            ? null
            : undefined,
      }),
    );
  }
}

export const ADMIN_BUSINESS_CONTROLLERS = [
  AdminPricePlansController,
  AdminSubscriptionsController,
  AdminPlatformInvoicesController,
  AdminTenantBusinessController,
  AdminHaasController,
  AdminFieldWorkController,
];

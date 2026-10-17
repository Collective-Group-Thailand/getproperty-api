import { CurrentTenant, Public, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type RawBodyRequest } from '@common/http/json-body-parser';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { FieldWorkService } from '@modules/platform-subscriptions/field-work.service';
import { HaasService } from '@modules/platform-subscriptions/haas.service';
import { PlatformBillingService } from '@modules/platform-subscriptions/platform-billing.service';
import { SubscriptionsService } from '@modules/platform-subscriptions/subscriptions.service';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';

import {
  HaasAssetDto,
  OwnerSubscriptionDto,
  PlatformCallbackResultDto,
  PlatformInvoiceDto,
  SiteSurveyDto,
  StaffInstallOrdersDto,
  SubscriptionUsageDto,
  UpgradeRequestDto,
} from '../admin/platform-business.dto';
import {
  chargesDto,
  haasDto,
  PLATFORM_INVOICE_EXAMPLE,
  platformInvoiceDto,
  siteSurveyDto,
  staffInstallOrders,
  SUBSCRIPTION_EXAMPLE,
  subscriptionDto,
  usageDto,
} from '../admin/platform-business.mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { DocumentDownloadDto } from './deposits.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

/**
 * The owner's own subscription (B6.1, D-082, D-156): plan, state, what is counted today and what a month would cost,
 * the monthly usage snapshots, the platform invoices with their Thai QR and PDF, the platform hardware placed at the
 * tenant, and the Starter → Smart upgrade (a site survey request). Reads keep working while the tenant is
 * read-only, so a suspended owner can still see and pay what is owed.
 */
@ApiTags('owner.subscription')
@ApiSurface(SURFACES.owner)
@Controller('owner/subscription')
export class OwnerSubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly billing: PlatformBillingService,
    private readonly field: FieldWorkService,
    private readonly haas: HaasService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.subscription.get',
    summary: 'My plan',
    description:
      'The subscription (plan, add-ons, state, trial end, pilot discount, read-only flag), what is counted today (units not inactive, rented meter points, buildings, OCR photos) and the estimate of a month at today’s usage (D-082, D-156, D-161). `subscription: null` before the platform subscribed the tenant.',
    implements: ['D-082', 'D-156', 'D-161'],
  })
  @ApiSuccess(200, {
    description: 'My plan',
    type: OwnerSubscriptionDto,
    example: {
      subscription: { ...SUBSCRIPTION_EXAMPLE, nextActions: [] },
      usageToday: { units: 12, meterPoints: 0, buildings: 1, ocrImages: 0 },
      estimate: {
        lines: [
          {
            kind: 'subscription',
            description: 'Apartment Starter — 20 ห้อง (ขั้นต่ำ 20)',
            quantity: '20.000',
            unitPrice: '25.0000',
            amount: '500.00',
          },
        ],
        subtotal: '500.00',
        discount: '0.00',
        vatAmount: '35.00',
        total: '535.00',
      },
      openInvoices: 0,
      nextActions: ['upgrade'],
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async get(@CurrentTenant() ctx: TenantContext): Promise<OwnerSubscriptionDto> {
    const sub = await this.subscriptions.current(ctx);
    if (!sub)
      return { subscription: null, usageToday: null, estimate: null, openInvoices: 0, nextActions: [] };
    const est = await this.subscriptions.estimate(ctx);
    const invoices = await this.billing.listForTenant(ctx);
    const open = invoices.filter((i) => ['issued', 'partially_paid', 'overdue'].includes(i.state)).length;
    const dto = subscriptionDto(sub, await this.subscriptions.addonRefs(sub));
    return {
      subscription: { ...dto, nextActions: [] },
      usageToday: est
        ? {
            units: est.usage.units,
            meterPoints: est.usage.meterPoints,
            buildings: est.usage.buildings,
            ocrImages: est.usage.ocrImages,
          }
        : null,
      estimate: est?.charges ? chargesDto(est.charges) : null,
      openInvoices: open,
      nextActions:
        sub.planKey === 'apartment_starter' && ['trial', 'active', 'past_due'].includes(sub.state)
          ? ['upgrade']
          : [],
    };
  }

  @Get('usage')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.subscription.usage',
    summary: 'Monthly usage counted',
    description:
      'The usage snapshot of each billed month (units counted per building, meter points, OCR photos, amount) — the last 12 months (D-082, D-156).',
    implements: ['D-082', 'D-156'],
  })
  @ApiSuccess(200, {
    description: 'Usage',
    type: [SubscriptionUsageDto],
    example: [
      {
        month: '2026-11-01',
        unitsCounted: 12,
        meterPointsCounted: 0,
        ocrImages: 0,
        unitsByBuilding: { [FAKE.buildingId]: 12 },
        amountComputed: '535.00',
        lines: PLATFORM_INVOICE_EXAMPLE.lines.map(({ lineNo: _n, ...l }) => l),
      },
    ],
  })
  @ApiStandardErrors('validation.failed', ...T)
  async usage(@CurrentTenant() ctx: TenantContext): Promise<SubscriptionUsageDto[]> {
    return (await this.subscriptions.usages(ctx)).map(usageDto);
  }

  @Get('invoices')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.subscription.invoices',
    summary: 'Invoices from getproperty',
    description:
      'Invoices of Collective Group (Thailand) to this tenant, newest first, with the Thai QR while open (D-146, D-156).',
    implements: ['D-146', 'D-156'],
  })
  @ApiSuccess(200, {
    description: 'Invoices',
    type: [PlatformInvoiceDto],
    example: [{ ...PLATFORM_INVOICE_EXAMPLE, nextActions: ['pay-qr'] }],
  })
  @ApiStandardErrors('validation.failed', ...T)
  async invoices(@CurrentTenant() ctx: TenantContext): Promise<PlatformInvoiceDto[]> {
    return (await this.billing.listForTenant(ctx)).map((i) => platformInvoiceDto(i, 'owner'));
  }

  @Get('invoices/:invoiceId')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.subscription.invoice',
    summary: 'One invoice from getproperty',
    description: 'Lines, payments with receipts and the Thai QR (D-156). Another tenant’s invoice is a 404.',
    implements: ['D-156'],
  })
  @ApiSuccess(200, {
    description: 'The invoice',
    type: PlatformInvoiceDto,
    example: { ...PLATFORM_INVOICE_EXAMPLE, nextActions: ['pay-qr'] },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async invoice(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<PlatformInvoiceDto> {
    return platformInvoiceDto(await this.billing.getForTenant(ctx, id), 'owner');
  }

  @Get('invoices/:invoiceId/pdf')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.subscription.invoicePdf',
    summary: 'PDF of an invoice from getproperty',
    description: 'A short-lived signed URL of the invoice PDF; 409 while it is being rendered (D-146).',
    implements: ['D-146'],
  })
  @ApiSuccess(200, {
    description: 'Link',
    type: DocumentDownloadDto,
    example: {
      documentId: FAKE.uuid,
      number: 'PIV-2026-00001',
      url: 'https://storage.example.com/piv.pdf?X-Amz-Signature=abc',
      expiresAt: '2026-11-01T00:20:00+07:00',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'platform_invoice.invalid_state', ...T)
  async invoicePdf(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const l = await this.billing.pdfLink(id, ctx.tenantId);
    return { documentId: l.documentId, number: l.number, url: l.url, expiresAt: l.expiresAt.toISOString() };
  }

  @Get('hardware')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.subscription.hardware',
    summary: 'Platform hardware at my buildings',
    description:
      'Gateways and rented meters the platform owns and placed here (HaaS, D-081), with term and state.',
    implements: ['D-081'],
  })
  @ApiSuccess(200, { description: 'Hardware', type: [HaasAssetDto], example: [] })
  @ApiStandardErrors('validation.failed', ...T)
  async hardware(@CurrentTenant() ctx: TenantContext): Promise<HaasAssetDto[]> {
    const today = bangkokDate(this.clock.now());
    return (await this.haas.mine(ctx)).map((a) => haasDto(a, today));
  }

  @Get('site-surveys')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.subscription.siteSurveys',
    summary: 'My upgrade surveys',
    description: 'Site surveys asked for to upgrade to Smart (D-156).',
    implements: ['D-156'],
  })
  @ApiSuccess(200, { description: 'Surveys', type: [SiteSurveyDto], example: [] })
  @ApiStandardErrors('validation.failed', ...T)
  async surveys(@CurrentTenant() ctx: TenantContext): Promise<SiteSurveyDto[]> {
    return (await this.field.surveysOf(ctx)).map(siteSurveyDto);
  }

  @Post('upgrade')
  @Idempotent()
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.subscription.upgrade',
    summary: 'Ask to upgrade to Smart',
    description:
      'Starter → Smart (D-156): asks the platform for a site survey of a building (one open survey per building — the open one is returned). After the survey the platform installs the gateway and meters and changes the plan; nothing is billed until then.',
    implements: ['D-156'],
  })
  @ApiJsonBody(UpgradeRequestDto, { buildingId: FAKE.buildingId, notes: 'สะดวกวันเสาร์' })
  @ApiSuccess(201, {
    description: 'Survey requested',
    type: SiteSurveyDto,
    example: {
      id: FAKE.uuid,
      tenantId: FAKE.tenantId,
      buildingId: FAKE.buildingId,
      targetPlanKey: 'apartment_smart',
      state: 'requested',
      scheduledFor: null,
      assignedTo: null,
      findings: {},
      notes: 'สะดวกวันเสาร์',
      installOrderId: null,
      createdAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'subscription.not_found',
    'subscription.invalid_state',
    'tenant.read_only',
    ...T,
  )
  async upgrade(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: UpgradeRequestDto,
  ): Promise<SiteSurveyDto> {
    return siteSurveyDto((await this.field.requestSurvey(ctx, body)).survey);
  }
}

/** Install orders of my buildings for tenant staff (web contract request, B6.1) — read-only. */
@ApiTags('staff.field')
@ApiSurface(SURFACES.staff)
@Controller('staff/install-orders')
export class StaffInstallOrdersController {
  constructor(private readonly field: FieldWorkService) {}

  @Get()
  @TenantScoped()
  @Can('device.read')
  @ApiEndpoint({
    id: 'staff.field.installOrders',
    summary: 'Install orders of my buildings',
    description:
      'Open and in-progress platform install / de-install orders of the buildings I may work in (D-090), items grouped by unit (gateway, meter devices with their meter and the device placed) — read-only; Collective’s field engineers work them (D-081).',
    implements: ['D-081', 'D-090', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'Orders',
    type: StaffInstallOrdersDto,
    example: {
      data: [
        {
          id: FAKE.uuid,
          kind: 'install',
          state: 'open',
          buildingId: FAKE.buildingId,
          dueAt: null,
          units: [
            {
              unitId: null,
              unitNo: null,
              items: [
                { kind: 'gateway', deviceKind: 'gateway', assetItemId: null, deviceId: null, state: 'open' },
              ],
            },
            {
              unitId: FAKE.uuid,
              unitNo: FAKE.unitCode,
              items: [
                {
                  kind: 'meter_device',
                  deviceKind: 'electric_meter',
                  assetItemId: FAKE.meterId,
                  deviceId: null,
                  state: 'open',
                },
              ],
            },
          ],
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<StaffInstallOrdersDto> {
    return { data: staffInstallOrders(await this.field.forStaff(ctx)) };
  }
}

/** `/webhooks/platform-payments/{provider}`: the platform merchant's own signed QR callbacks (B6.1). */
@ApiTags('webhooks.payments')
@ApiSurface(SURFACES.webhooks)
@Controller({ path: 'webhooks/platform-payments', version: VERSION_NEUTRAL })
export class PlatformPaymentWebhooksController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Post(':provider')
  @HttpCode(200)
  @Public()
  @ApiHeader({
    name: 'X-Provider-Signature',
    required: false,
    description:
      'Signature over the raw body with the platform merchant’s webhook secret (as `webhooks.payments.callback`).',
  })
  @ApiEndpoint({
    id: 'webhooks.platformPayments.callback',
    summary: 'Platform payment callback',
    description:
      'The provider of Collective Group’s own merchant account (setting `platform.payments.merchant`, ⚖ O-008) posts a signed confirmation; each paid reference of a platform invoice is recorded once (idempotent on the provider reference) with its receipt, and a subscription with nothing overdue left is reinstated (D-082). 401 `webhook.signature_invalid` otherwise.',
    implements: ['D-082', 'D-146'],
  })
  @ApiBody({
    required: true,
    description: 'The provider’s JSON event (fake provider shape shown).',
    schema: { type: 'object', additionalProperties: true },
    examples: {
      paid: {
        summary: 'One paid reference',
        value: {
          eventId: 'evt_KB202611050001',
          merchantRef: 'GP-PLATFORM',
          payments: [
            {
              providerRef: 'KB202611050001',
              reference: 'PIV202600001',
              amount: '535.00',
              paidAt: '2026-11-05T02:15:00.000Z',
              status: 'paid',
            },
          ],
        },
      },
    },
  })
  @ApiSuccess(200, {
    description: 'Applied',
    type: PlatformCallbackResultDto,
    example: { eventId: 'evt_KB202611050001', results: [{ reference: 'PIV202600001', outcome: 'applied' }] },
  })
  @ApiStandardErrors(
    'webhook.signature_invalid',
    'webhook.malformed',
    'http.not_found',
    'http.malformed_json',
  )
  async callback(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | undefined>,
    @Req() req: RawBodyRequest,
  ): Promise<PlatformCallbackResultDto> {
    if (!req.rawBody) throw new DomainException('webhook.malformed');
    return this.billing.handleCallback(provider, headers, req.rawBody);
  }
}

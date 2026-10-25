import { Can } from '@common/auth/can.decorator';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiAsync,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { BuildingService } from '@core/asset/asset.services';
import { DeviceRegistryService } from '@core/devices/device-registry.service';
import { OutboxAdminService } from '@core/events/outbox-admin.service';
import { NotificationTemplatesService } from '@core/notifications/notification-templates.service';
import { type UtilityTariffStructure } from '@core/utility-tariffs/tariff-structure';
import { UtilityTariffsService } from '@core/utility-tariffs/utility-tariffs.service';
import {
  type Device,
  type NotificationTemplate,
  type NotificationTemplateVersion,
  type UtilityTariffVersion,
} from '@generated/prisma/client';
import { PortfolioService } from '@modules/ops-units/portfolio.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { type NotificationAudienceName } from '../owner/governance.dto';
import {
  TariffChargeDto,
  type TariffVersionStateName,
  type UtilityName,
  type UtilityProviderName,
} from '../owner/money-settings.dto';
import { type NotificationChannelName } from '../shared/common.dto';
import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import { tariffVersionActions } from '../shared/next-actions';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  AcceptedDto,
  ConsumptionListQuery,
  type ConsumptionStateName,
  DeviceCreateDto,
  DeviceDto,
  type DeviceKindName,
  type DeviceOwnershipName,
  type DeviceStatusName,
  EventConsumptionDto,
  NotificationTemplateDto,
  OperatorChangedDto,
  OperatorChangeDto,
  OutboxListQuery,
  OutboxMessageDto,
  type OutboxStateName,
  ProvisioningCodeDto,
  RenderedMessageDto,
  StubClaimDto,
  TariffEnterDto,
  TariffSampleQuery,
  TariffVerifyDto,
  TariffVersionDto,
  type TemplateFormatName,
  TemplatePreviewDto,
  TemplateVersionCreateDto,
  TemplateVersionDto,
  type TemplateVersionStateName,
  TestSendDto,
  UtilityTariffDto,
} from './admin.dto';

const tariffVersionDto = (v: UtilityTariffVersion): TariffVersionDto => ({
  nextActions: tariffVersionActions(v.state, v.enteredBy),
  id: v.id,
  effectiveFrom: dateOnly(v.effectiveFrom)!,
  effectiveTo: dateOnly(v.effectiveTo),
  state: v.state as TariffVersionStateName,
  ceilingPerUnit: v.ceilingPerUnit.toFixed(4),
  needsCheck: v.needsCheck,
  sourceUrl: v.sourceUrl,
  sourceDocumentId: v.sourceDocumentId,
  structure: v.structure as Record<string, unknown>,
  enteredBy: v.enteredBy,
  verifiedBy: v.verifiedBy,
  publishedAt: isoOrNull(v.publishedAt),
  notes: v.notes,
});

const TARIFF_VERSION_EXAMPLE = {
  nextActions: ['verify'],
  id: FAKE.uuid,
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
  state: 'entered',
  ceilingPerUnit: '4.6189',
  needsCheck: true,
  sourceUrl: 'https://www.mea.or.th/',
  sourceDocumentId: null,
  structure: { kind: 'tiered', unit: 'kwh', currency: 'THB' },
  enteredBy: FAKE.uuid,
  verifiedBy: null,
  publishedAt: null,
  notes: null,
};

@ApiTags('admin.utilityTariffs')
@ApiSurface(SURFACES.admin)
@Controller('admin/utility-tariffs')
export class AdminUtilityTariffsController {
  constructor(private readonly tariffs: UtilityTariffsService) {}

  @Get()
  @Can('admin.utility_tariff.enter')
  @ApiEndpoint({
    id: 'admin.utilityTariffs.list',
    summary: 'Utility tariffs and their versions',
    description:
      'MEA/PEA/MWA/PWA tariffs with every version (entered, verified, published, superseded) — the สคบ. 2568 cap reference (D-021a, D-140).',
    implements: ['D-021', 'D-140'],
  })
  @ApiSuccess(200, {
    description: 'Tariffs',
    type: [UtilityTariffDto],
    example: [
      {
        id: FAKE.uuid,
        utility: 'electric',
        provider: 'mea',
        tariffCode: '1.1',
        nameTh: 'ประเภท 1.1 บ้านอยู่อาศัย',
        versions: [TARIFF_VERSION_EXAMPLE],
      },
    ],
  })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<UtilityTariffDto[]> {
    return (await this.tariffs.list()).map((t) => ({
      id: t.id,
      utility: t.utility as UtilityName,
      provider: t.provider as UtilityProviderName,
      tariffCode: t.tariffCode,
      nameTh: t.nameTh,
      versions: t.versions.map(tariffVersionDto),
    }));
  }

  @Post(':tariffId/versions')
  @Idempotent()
  @Can('admin.utility_tariff.enter')
  @ApiEndpoint({
    id: 'admin.utilityTariffs.enter',
    summary: 'Enter a tariff version (maker)',
    description:
      'A new effective-dated version in state `entered` with its source; the structure is validated and every value is flagged for checking. A different platform user verifies it, then it is published (D-021a, ADR-0004).',
    implements: ['D-021', 'D-140', 'ADR-0004'],
  })
  @ApiJsonBody(TariffEnterDto, {
    effectiveFrom: '2026-09-01',
    structure: {
      kind: 'tiered',
      unit: 'kwh',
      currency: 'THB',
      ceilingPerUnit: '4.6189',
      tiers: [
        { upTo: '150', pricePerUnit: '3.2484' },
        { upTo: null, pricePerUnit: '4.2218' },
      ],
    },
    sourceUrl: 'https://www.mea.or.th/',
    sourcePublishedOn: '2026-08-20',
  })
  @ApiSuccess(201, { description: 'Entered', type: TariffVersionDto, example: TARIFF_VERSION_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'http.conflict',
    'tariff.invalid_structure',
  )
  async enter(
    @Param('tariffId', ParseUUIDPipe) tariffId: string,
    @Body() body: TariffEnterDto,
  ): Promise<TariffVersionDto> {
    return tariffVersionDto(
      await this.tariffs.enter(tariffId, {
        effectiveFrom: body.effectiveFrom,
        structure: body.structure as unknown as UtilityTariffStructure,
        sourceUrl: body.sourceUrl,
        sourcePublishedAt: body.sourcePublishedOn ?? null,
        sourceDocumentId: body.sourceDocumentId ?? null,
        notes: body.notes ?? null,
      }),
    );
  }

  @Get('versions/:versionId/charge')
  @Can('admin.utility_tariff.enter')
  @ApiEndpoint({
    id: 'admin.utilityTariffs.sampleCharge',
    summary: 'Sample bill of a tariff version',
    description:
      'The bill for `units` under one version in any state (entered, verified, published, superseded) — what the checker compares with the notice before verifying and publishing (web F5, D-214). Same tariff math as `owner.utilityTariffs.current` (D-140); a time-of-use structure is 422.',
    implements: ['D-021', 'D-140', 'D-214'],
  })
  @ApiSuccess(200, {
    description: 'Sample bill',
    type: TariffChargeDto,
    example: {
      units: '150',
      totalExVat: '523.35',
      effectiveAverageRate: '3.4890',
      minimumApplied: false,
      lines: [{ label: '0–150', units: '150', pricePerUnit: '3.2484', amount: '487.26' }],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async sampleCharge(
    @Param('versionId', ParseUUIDPipe) id: string,
    @Query() query: TariffSampleQuery,
  ): Promise<TariffChargeDto> {
    const c = await this.tariffs.sampleCharge(id, query.units);
    return {
      units: c.units,
      totalExVat: c.totalExVat,
      effectiveAverageRate: c.effectiveAverageRate,
      minimumApplied: c.minimumApplied,
      lines: c.lines,
    };
  }

  @Post('versions/:versionId/actions/verify')
  @HttpCode(200)
  @Can('admin.utility_tariff.verify')
  @ApiEndpoint({
    id: 'admin.utilityTariffs.verify',
    summary: 'Verify a tariff version (checker)',
    description:
      'A platform user other than the one who entered it confirms every value against the source (`409 tariff.same_verifier` otherwise, D-021a).',
    implements: ['D-021', 'D-091'],
  })
  @ApiJsonBody(TariffVerifyDto, { notes: 'ตรวจทุกค่ากับประกาศแล้ว' })
  @ApiSuccess(200, {
    description: 'Verified',
    type: TariffVersionDto,
    example: { ...TARIFF_VERSION_EXAMPLE, state: 'verified', needsCheck: false, verifiedBy: FAKE.uuid },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'tariff.invalid_state',
    'tariff.same_verifier',
  )
  async verify(
    @Param('versionId', ParseUUIDPipe) id: string,
    @Body() body: TariffVerifyDto,
  ): Promise<TariffVersionDto> {
    return tariffVersionDto(await this.tariffs.verify(id, body.notes ?? null));
  }

  @Post('versions/:versionId/actions/publish')
  @HttpCode(200)
  @Can('admin.utility_tariff.verify')
  @ApiEndpoint({
    id: 'admin.utilityTariffs.publish',
    summary: 'Publish a verified tariff version',
    description:
      'Becomes the cap reference from its effective date; the version it supersedes is closed. Audited, `utility_tariff.published` (D-021a).',
    implements: ['D-021', 'ADR-0004'],
  })
  @ApiSuccess(200, {
    description: 'Published',
    type: TariffVersionDto,
    example: {
      ...TARIFF_VERSION_EXAMPLE,
      state: 'published',
      needsCheck: false,
      verifiedBy: FAKE.uuid,
      publishedAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'tariff.invalid_state')
  async publish(@Param('versionId', ParseUUIDPipe) id: string): Promise<TariffVersionDto> {
    return tariffVersionDto(await this.tariffs.publish(id));
  }
}

const OUTBOX_EXAMPLE = {
  id: FAKE.uuid,
  eventId: FAKE.uuid,
  eventType: 'tenant.bank_account.changed',
  tenantId: FAKE.tenantId,
  topic: 'tenant',
  state: 'dead',
  attempts: 10,
  lastError: 'queue unavailable',
  createdAt: FAKE.dateTime,
};
const CONSUMPTION_EXAMPLE = {
  id: FAKE.uuid,
  eventId: FAKE.uuid,
  eventType: 'workflow.sla_breached',
  subscriber: 'notifications',
  state: 'dead',
  attempts: 8,
  lastError: 'provider unavailable',
  replayedAt: null,
};

@ApiTags('admin.outbox')
@ApiSurface(SURFACES.admin)
@Controller('admin/outbox')
export class AdminOutboxController {
  constructor(private readonly outbox: OutboxAdminService) {}

  @Get('messages')
  @Can('admin.outbox.manage')
  @ApiEndpoint({
    id: 'admin.outbox.messages',
    summary: 'Outbox messages that failed to relay',
    description:
      'Failed and dead outbox messages (or any state) — the dead-letter view of the event relay (B1.3).',
    implements: ['D-159'],
  })
  @ApiSuccess(200, { description: 'Messages', type: [OutboxMessageDto], example: [OUTBOX_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async messages(@Query() query: OutboxListQuery): Promise<OutboxMessageDto[]> {
    return (await this.outbox.listMessages(query.state, 200)).map((m) => ({
      id: m.id,
      eventId: m.eventId,
      eventType: m.event.type,
      tenantId: m.event.tenantId,
      topic: m.topic,
      state: m.state as OutboxStateName,
      attempts: m.attempts,
      lastError: m.lastError,
      createdAt: iso(m.createdAt),
    }));
  }

  @Post('messages/:messageId/actions/replay')
  @HttpCode(200)
  @Can('admin.outbox.manage')
  @ApiEndpoint({
    id: 'admin.outbox.replayMessage',
    summary: 'Replay a dead outbox message',
    description:
      'Puts it back to `pending`; subscribers are idempotent, so nothing is delivered twice. Audited.',
    implements: ['D-159'],
  })
  @ApiSuccess(200, {
    description: 'Re-queued',
    type: OutboxMessageDto,
    example: { ...OUTBOX_EXAMPLE, state: 'pending', attempts: 0, lastError: null },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'outbox.not_replayable')
  async replayMessage(@Param('messageId', ParseUUIDPipe) id: string): Promise<OutboxMessageDto> {
    await this.outbox.replayMessage(id);
    const [m] = (await this.outbox.listMessages('pending', 500)).filter((x) => x.id === id);
    return {
      ...OUTBOX_EXAMPLE,
      id,
      eventId: m?.eventId ?? id,
      eventType: m?.event.type ?? '',
      tenantId: m?.event.tenantId ?? null,
      topic: m?.topic ?? '',
      state: 'pending' as OutboxStateName,
      attempts: 0,
      lastError: null,
      createdAt: m ? iso(m.createdAt) : OUTBOX_EXAMPLE.createdAt,
    };
  }

  @Get('dead-letters')
  @Can('admin.outbox.manage')
  @ApiEndpoint({
    id: 'admin.outbox.deadLetters',
    summary: 'Subscriber deliveries that failed',
    description:
      'Per (event, subscriber) failures after retries — notifications, cache invalidation, scans, workflow timers (B1.3).',
    implements: ['D-159'],
  })
  @ApiSuccess(200, {
    description: 'Dead letters',
    type: [EventConsumptionDto],
    example: [CONSUMPTION_EXAMPLE],
  })
  @ApiStandardErrors('validation.failed')
  async deadLetters(@Query() query: ConsumptionListQuery): Promise<EventConsumptionDto[]> {
    return (await this.outbox.listConsumptions(query.state, 200)).map((c) => ({
      id: c.id,
      eventId: c.eventId,
      eventType: c.event.type,
      subscriber: c.subscriber,
      state: c.state as ConsumptionStateName,
      attempts: c.attempts,
      lastError: c.lastError,
      replayedAt: isoOrNull(c.replayedAt),
    }));
  }

  @Post('dead-letters/:deadLetterId/actions/replay')
  @HttpCode(200)
  @Can('admin.outbox.manage')
  @ApiEndpoint({
    id: 'admin.outbox.replayDeadLetter',
    summary: 'Replay a failed subscriber delivery',
    description:
      'Re-queues the (event, subscriber) job; the subscriber inbox makes it exactly-once. Audited.',
    implements: ['D-159'],
  })
  @ApiSuccess(200, {
    description: 'Re-queued',
    type: EventConsumptionDto,
    example: { ...CONSUMPTION_EXAMPLE, replayedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'outbox.not_replayable')
  async replayDeadLetter(@Param('deadLetterId', ParseUUIDPipe) id: string): Promise<EventConsumptionDto> {
    const c = await this.outbox.replayConsumption(id);
    return {
      id: c.id,
      eventId: c.eventId,
      eventType: '',
      subscriber: c.subscriber,
      state: c.state as ConsumptionStateName,
      attempts: c.attempts,
      lastError: c.lastError,
      replayedAt: isoOrNull(c.replayedAt),
    };
  }
}

const versionDto = (v: NotificationTemplateVersion): TemplateVersionDto => ({
  id: v.id,
  version: v.version,
  language: v.language,
  format: v.format as TemplateFormatName,
  subject: v.subject,
  body: v.body,
  state: v.state as TemplateVersionStateName,
  sampleData: v.sampleData as Record<string, unknown>,
  publishedAt: isoOrNull(v.publishedAt),
});
const templateDto = (
  t: NotificationTemplate,
  versions: NotificationTemplateVersion[],
): NotificationTemplateDto => ({
  id: t.id,
  key: t.key,
  channel: t.channel as NotificationChannelName,
  audience: t.audience as NotificationAudienceName,
  description: t.description,
  versions: versions.map(versionDto),
});
const TEMPLATE_VERSION_EXAMPLE = {
  id: FAKE.uuid,
  version: 2,
  language: 'th',
  format: 'handlebars_text',
  subject: 'บัญชีรับเงินถูกเปลี่ยน',
  body: 'บัญชีรับเงินของ {{tenant.name}} ถูกเปลี่ยนเป็น {{account.masked}}',
  state: 'draft',
  sampleData: { tenant: { name: FAKE.propertyName }, account: { masked: 'xxxxxx1234' } },
  publishedAt: null,
};
const TEMPLATE_EXAMPLE = {
  id: FAKE.uuid,
  key: 'tenant.bank_account.changed',
  channel: 'in_app',
  audience: 'owner',
  description: 'Owner: receiving bank account changed.',
  versions: [TEMPLATE_VERSION_EXAMPLE],
};

@ApiTags('admin.notificationTemplates')
@ApiSurface(SURFACES.admin)
@Controller('admin/notification-templates')
export class AdminNotificationTemplatesController {
  constructor(private readonly templates: NotificationTemplatesService) {}

  @Get()
  @Can('admin.notification_template.manage')
  @ApiEndpoint({
    id: 'admin.notificationTemplates.list',
    summary: 'Notification templates',
    description:
      'Templates per event key × channel × audience with their th/en versions (B1.3 notifications).',
    implements: ['D-063'],
  })
  @ApiSuccess(200, { description: 'Templates', type: [NotificationTemplateDto], example: [TEMPLATE_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<NotificationTemplateDto[]> {
    return (await this.templates.list()).map((t) => templateDto(t, t.versions));
  }

  @Post('versions')
  @Can('admin.notification_template.manage')
  @ApiEndpoint({
    id: 'admin.notificationTemplates.createVersion',
    summary: 'Add a template version (draft)',
    description:
      'Handlebars text (SMS, LINE, in-app, web push), LINE Flex JSON, or MJML (email); rendered against its sample data before it is stored — a template that does not render is refused (`422 notification.template_invalid`).',
    implements: ['D-063'],
  })
  @ApiJsonBody(TemplateVersionCreateDto, {
    key: 'tenant.bank_account.changed',
    channel: 'in_app',
    audience: 'owner',
    language: 'th',
    format: 'handlebars_text',
    subject: 'บัญชีรับเงินถูกเปลี่ยน',
    body: 'บัญชีรับเงินของ {{tenant.name}} ถูกเปลี่ยนเป็น {{account.masked}}',
    sampleData: { tenant: { name: FAKE.propertyName }, account: { masked: 'xxxxxx1234' } },
  })
  @ApiSuccess(201, { description: 'Draft', type: NotificationTemplateDto, example: TEMPLATE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'notification.template_invalid')
  async createVersion(@Body() body: TemplateVersionCreateDto): Promise<NotificationTemplateDto> {
    const r = await this.templates.createVersion(body);
    return templateDto(r.template, [r.version]);
  }

  @Post('versions/:versionId/actions/preview')
  @HttpCode(200)
  @Can('admin.notification_template.manage')
  @ApiEndpoint({
    id: 'admin.notificationTemplates.preview',
    summary: 'Render a template version',
    description: 'Renders with the given data or the version’s sample data; nothing is sent.',
    implements: ['D-063'],
  })
  @ApiJsonBody(TemplatePreviewDto, {
    data: { tenant: { name: FAKE.propertyName }, account: { masked: 'xxxxxx1234' } },
  })
  @ApiSuccess(200, {
    description: 'Rendered',
    type: RenderedMessageDto,
    example: {
      format: 'handlebars_text',
      subject: 'บัญชีรับเงินถูกเปลี่ยน',
      text: 'บัญชีรับเงินของ หอพักตัวอย่าง ถูกเปลี่ยนเป็น xxxxxx1234',
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'notification.template_invalid',
  )
  async preview(
    @Param('versionId', ParseUUIDPipe) id: string,
    @Body() body: TemplatePreviewDto,
  ): Promise<RenderedMessageDto> {
    const r = await this.templates.preview(id, body.data);
    return {
      format: r.format as TemplateFormatName,
      subject: r.subject,
      text: r.text,
      html: r.html,
      flex: r.flex,
    };
  }

  @Post('versions/:versionId/actions/publish')
  @HttpCode(200)
  @Can('admin.notification_template.manage')
  @ApiEndpoint({
    id: 'admin.notificationTemplates.publish',
    summary: 'Publish a template version',
    description: 'Replaces the published version of that language (the previous one is retired). Audited.',
    implements: ['D-063'],
  })
  @ApiSuccess(200, {
    description: 'Published',
    type: NotificationTemplateDto,
    example: {
      ...TEMPLATE_EXAMPLE,
      versions: [{ ...TEMPLATE_VERSION_EXAMPLE, state: 'published', publishedAt: FAKE.dateTime }],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'http.conflict')
  async publish(@Param('versionId', ParseUUIDPipe) id: string): Promise<NotificationTemplateDto> {
    const r = await this.templates.publish(id);
    return templateDto(r.template, [r.version]);
  }

  @Post(':templateId/actions/test-send')
  @HttpCode(202)
  @ApiAsync({ poll: null })
  @Can('admin.notification_template.manage')
  @ApiEndpoint({
    id: 'admin.notificationTemplates.testSend',
    summary: 'Send a test notification',
    description:
      'Queues the published version to a platform user (default: me) through the normal pipeline (event → notifications subscriber → channel adapter); the result appears in the delivery log. Nothing to poll.',
    implements: ['D-063'],
  })
  @ApiJsonBody(TestSendDto, { data: { tenant: { name: FAKE.propertyName } } })
  @ApiSuccess(202, { description: 'Queued', type: AcceptedDto, example: { eventId: FAKE.uuid } })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async testSend(
    @Param('templateId', ParseUUIDPipe) id: string,
    @Body() body: TestSendDto,
  ): Promise<AcceptedDto> {
    return this.templates.testSend(id, body);
  }
}

const deviceDto = (d: Device): DeviceDto => ({
  id: d.id,
  serial: d.serial,
  kind: d.kind as DeviceKindName,
  model: d.model,
  ownership: d.ownership as DeviceOwnershipName,
  status: d.status as DeviceStatusName,
  tenantId: d.tenantId,
  buildingId: d.buildingId,
});

@ApiTags('admin.devices')
@ApiSurface(SURFACES.admin)
@Controller('admin/devices')
export class AdminDevicesController {
  constructor(private readonly devices: DeviceRegistryService) {}

  @Post()
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.create',
    summary: 'Register a device',
    description:
      'Adds a gateway or meter to the fleet (inventory, or assigned to a tenant’s building). Audited (D-130).',
    implements: ['D-130'],
  })
  @ApiJsonBody(DeviceCreateDto, {
    serial: 'GP-GW-000123',
    kind: 'gateway',
    model: 'rpi-cm4',
    vendor: 'Collective',
    ownership: 'platform_haas',
    tenantId: FAKE.tenantId,
    buildingId: FAKE.buildingId,
  })
  @ApiSuccess(201, {
    description: 'Registered',
    type: DeviceDto,
    example: {
      id: FAKE.gatewayId,
      serial: 'GP-GW-000123',
      kind: 'gateway',
      model: 'rpi-cm4',
      ownership: 'platform_haas',
      status: 'assigned',
      tenantId: FAKE.tenantId,
      buildingId: FAKE.buildingId,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'http.conflict')
  async create(@Body() body: DeviceCreateDto): Promise<DeviceDto> {
    return deviceDto(await this.devices.register(body));
  }

  @Post(':deviceId/provisioning-codes')
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.issueProvisioningCode',
    summary: 'Issue a gateway provisioning code',
    description:
      'A single-use code valid 72 hours, shown once, entered on the gateway for `POST /v1/device/bootstrap` (CSR → certificate + device JWT). Issuing a new code invalidates the unused one. Audited (D-130).',
    implements: ['D-130'],
  })
  @ApiSuccess(201, {
    description: 'Code',
    type: ProvisioningCodeDto,
    example: { deviceId: FAKE.gatewayId, code: 'K7QX-2M9P-H4TD', expiresAt: '2026-11-04T00:15:00+07:00' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'device.invalid_state')
  async issueCode(@Param('deviceId', ParseUUIDPipe) id: string): Promise<ProvisioningCodeDto> {
    const r = await this.devices.issueProvisioningCode(id);
    return { deviceId: r.deviceId, code: r.code, expiresAt: iso(r.expiresAt) };
  }
}

@ApiTags('admin.buildings')
@ApiSurface(SURFACES.admin)
@Controller('admin/buildings')
export class AdminBuildingsController {
  constructor(
    private readonly buildings: BuildingService,
    private readonly portfolio: PortfolioService,
  ) {}

  @Post(':buildingId/actions/change-operator')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.building.manage')
  @ApiEndpoint({
    id: 'admin.buildings.changeOperator',
    summary: 'Change the operator of a building',
    description:
      'Closes the current operator period, opens the next and re-points the building to the new operator tenant (and owner when given); the previous operator’s grants are revoked — no data is copied, RLS visibility follows at once (D-152, schema-design §4.6). Audited and evented.',
    implements: ['D-152', 'D-153'],
  })
  @ApiJsonBody(OperatorChangeDto, {
    operatorTenantId: FAKE.uuid,
    reason: 'pm_contract_start',
    sourceRef: 'PM-2026-001',
  })
  @ApiSuccess(200, {
    description: 'Changed',
    type: OperatorChangedDto,
    example: { buildingId: FAKE.buildingId, ownerTenantId: FAKE.tenantId, operatorTenantId: FAKE.uuid },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'http.conflict')
  async changeOperator(
    @Param('buildingId', ParseUUIDPipe) id: string,
    @Body() body: OperatorChangeDto,
  ): Promise<OperatorChangedDto> {
    const b = await this.buildings.changeOperator(id, body);
    return { buildingId: b.id, ownerTenantId: b.ownerTenantId, operatorTenantId: b.operatorTenantId! };
  }

  @Post(':buildingId/actions/claim-stub')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.building.manage')
  @ApiEndpoint({
    id: 'admin.buildings.claimStub',
    summary: 'Hand a condo stub over to its juristic person',
    description:
      'A condo whose landlords added units before its juristic person joined lives in a stub building (status `external`, D-251). When the juristic tenant signs up, the platform hands the stub over: owner = the condo juristic tenant, operator = itself or its PM company, status `active`, an operator period `juristic_formed` opens. The landlords keep their units, leases and invoices — nothing is copied or moved (D-280). Audited and evented (`building.operator_changed`).',
    implements: ['D-251', 'D-280'],
  })
  @ApiJsonBody(StubClaimDto, { ownerTenantId: FAKE.tenantId })
  @ApiSuccess(200, {
    description: 'Handed over',
    type: OperatorChangedDto,
    example: { buildingId: FAKE.buildingId, ownerTenantId: FAKE.tenantId, operatorTenantId: FAKE.tenantId },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'http.conflict',
    'portfolio.not_a_stub',
    'portfolio.claimant_invalid',
  )
  async claimStub(
    @Param('buildingId', ParseUUIDPipe) id: string,
    @Body() body: StubClaimDto,
  ): Promise<OperatorChangedDto> {
    const b = await this.portfolio.claim(id, body);
    return { buildingId: b.id, ownerTenantId: b.ownerTenantId, operatorTenantId: b.operatorTenantId! };
  }
}

import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiAsync,
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
import { DeviceCommandsService } from '@modules/smart-devices/commands.service';
import { DeviceFleetService } from '@modules/smart-devices/fleet.service';
import { DeviceInstallsService } from '@modules/smart-devices/installs.service';
import { UtilityLossService } from '@modules/smart-health/utility-loss.service';
import { type Bucket, SeriesService } from '@modules/smart-ingest/series.service';
import { MeterReadingsService } from '@modules/smart-readings/meter-readings.service';
import { ReadingRoundsService } from '@modules/smart-readings/reading-rounds.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  type Type,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ProvisioningCodeDto } from '../admin/admin.dto';
import { iso } from '../shared/mappers';
import {
  DeviceCommandDto,
  DeviceDetailDto,
  DeviceInstallDto,
  DeviceInstalledDto,
  DeviceListQuery,
  DeviceUnbindDto,
  DeviceUnboundDto,
  ExportQuery,
  FleetDeviceDto,
  LossQuery,
  LossRecomputeDto,
  LossSummaryRowDto,
  LossViewDto,
  type MeterHealthName,
  type MeterPurposeName,
  MeterReadingCreateDto,
  MeterReadingDto,
  MeterReadingListQuery,
  MeterSeriesDto,
  MeterSwapDto,
  MeterSwappedDto,
  type MeterUnitName,
  OperatorCommandCreateDto,
  ProvisionGatewayDto,
  ReadingReviewDto,
  type ReadingSourceName,
  ResidentUsageDto,
  ReviewDecisionDto,
  ReviewDecisionName,
  ReviewListQuery,
  RoundBuildingDto,
  RoundsQuery,
  SeriesBucketName,
  SeriesQuery,
  UnitMeterHistoryDto,
  UsageQuery,
  UtilityFilterQuery,
  UtilityInvoiceCreateDto,
  UtilityInvoiceDto,
  UtilityInvoiceImportDto,
  UtilityInvoicePrefillDto,
  UtilityInvoicePrefillRequestDto,
  UtilityInvoiceUpdateDto,
} from '../shared/smart.dto';
import {
  channelDto,
  commandDto,
  configVersionDto,
  deviceEventDto,
  fleetDeviceDto,
  lossReportDto,
  readingDto,
  reviewDto,
  utilityInvoiceDto,
} from '../shared/smart.mappers';
import { ApiSurface, type Surface, SURFACES } from '../surfaces';
import { ifMatchVersion } from './assets.mappers';
import { type UtilityName } from './money-settings.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;

// --------------------------------------------------------------------------------------------- examples

const DEVICE_EXAMPLE: FleetDeviceDto = {
  id: FAKE.gatewayId,
  serial: 'GP-GW-000123',
  kind: 'gateway' as FleetDeviceDto['kind'],
  model: 'rpi-cm4',
  vendor: 'Raspberry Pi',
  driver: null,
  ownership: 'platform_haas' as FleetDeviceDto['ownership'],
  status: 'online' as FleetDeviceDto['status'],
  tenantId: FAKE.tenantId,
  buildingId: FAKE.buildingId,
  assetItemId: null,
  gatewayDeviceId: null,
  firmwareVersion: '0.3.0',
  arch: 'arm64',
  otaRing: 'all' as FleetDeviceDto['otaRing'],
  lastSeenAt: FAKE.dateTime,
  configAppliedVersion: 2,
  meters: 2,
  health: {
    lastHeartbeatAt: FAKE.dateTime,
    agentVersion: '0.3.0',
    configVersion: 2,
    bufferedReadings: 0,
    link: 'ethernet',
    rssi: null,
    missedHeartbeats: 0,
    ingestLagMs: 850,
  },
  nextActions: ['read-now', 'restart', 'identify', 'upload-logs'],
  version: 4,
};

const COMMAND_EXAMPLE: DeviceCommandDto = {
  id: FAKE.uuid,
  gatewayDeviceId: FAKE.gatewayId,
  type: 'read_now' as DeviceCommandDto['type'],
  args: {},
  status: 'queued' as DeviceCommandDto['status'],
  issuedAt: FAKE.dateTime,
  expiresAt: '2026-11-01T00:20:00+07:00',
  attempts: 0,
  finishedAt: null,
  result: null,
  error: null,
};

const READING_EXAMPLE: MeterReadingDto = {
  id: FAKE.uuid,
  assetItemId: FAKE.meterId,
  meterAssignmentId: FAKE.uuid,
  meterCode: 'E-A-201',
  utility: 'electric' as MeterReadingDto['utility'],
  unitId: FAKE.uuid,
  register: '12345.678',
  unit: 'kwh' as MeterReadingDto['unit'],
  readAt: FAKE.dateTime,
  source: 'ocr' as MeterReadingDto['source'],
  via: 'staff_pwa' as MeterReadingDto['via'],
  confidence: '0.900',
  reviewState: 'accepted' as MeterReadingDto['reviewState'],
  consumption: '142.120',
  isRollover: false,
  isInstall: false,
  isFinal: false,
  evidenceDocumentId: FAKE.uuid,
  ocrRawValue: '12345.678',
  ocrConfidence: '0.950',
  typedValue: null,
  reviewId: null,
  supersededByReadingId: null,
  readingBatchId: FAKE.uuid,
  note: null,
};

const REVIEW_EXAMPLE: ReadingReviewDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  reason: 'out_of_band' as ReadingReviewDto['reason'],
  bandLow: '0.000',
  bandHigh: '210.000',
  trailingAvg: '5.200',
  status: 'open' as ReadingReviewDto['status'],
  reading: {
    ...READING_EXAMPLE,
    reviewState: 'pending_review' as MeterReadingDto['reviewState'],
    reviewId: FAKE.uuid,
  },
  decidedAt: null,
  decisionNote: null,
  correctedRegister: null,
  correctedReadingId: null,
  createdAt: FAKE.dateTime,
  nextActions: ['accept', 'correct', 'reject'],
};

const INVOICE_EXAMPLE: UtilityInvoiceDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  utility: 'electric' as UtilityInvoiceDto['utility'],
  provider: 'mea' as UtilityInvoiceDto['provider'],
  utilityAccountId: null,
  periodStart: '2026-09-26',
  periodEnd: '2026-10-25',
  invoiceNo: '0123456789',
  units: '5230.000',
  amount: '24518.32',
  ft: '0.3972',
  serviceCharge: '38.22',
  vat: '1604.00',
  previousRegister: '81200.000',
  currentRegister: '86430.000',
  source: 'manual' as UtilityInvoiceDto['source'],
  invoiceDocumentId: FAKE.uuid,
  version: 1,
};

const LOSS_EXAMPLE: LossViewDto = {
  report: {
    id: FAKE.uuid,
    buildingId: FAKE.buildingId,
    utility: 'electric' as LossViewDto['report']['utility'],
    periodKey: '2026-10',
    periodStart: '2026-09-25',
    periodEnd: '2026-10-25',
    invoiceUnits: '5230.000',
    unitBilledUnits: '4801.250',
    commonAreaUnits: '310.000',
    lossUnits: '118.750',
    lossPct: '2.2706',
    lossThb: '548.68',
    priceBasis: 'utility_tariff' as LossViewDto['report']['priceBasis'],
    billedUnitsSource: 'meter_readings_stub' as LossViewDto['report']['billedUnitsSource'],
    computedAt: FAKE.dateTime,
    suspects: [
      {
        id: FAKE.uuid,
        kind: 'usage_while_vacant' as LossViewDto['report']['suspects'][number]['kind'],
        unitId: FAKE.uuid,
        assetItemId: FAKE.meterId,
        score: '62.50',
        detail: { unitNo: 'A-305', units: '45.000' },
      },
    ],
  },
  trend: [{ periodEnd: '2026-10-25', lossUnits: '118.750', lossPct: '2.2706', lossThb: '548.68' }],
};

const ROUND_EXAMPLE: RoundBuildingDto = {
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  periodKey: '2026-10',
  cutoffAt: '2026-10-25T00:00:00+07:00',
  windowStart: '2026-10-18T00:00:00+07:00',
  batchId: null,
  remaining: 1,
  total: 2,
  read: 1,
  floors: [
    {
      floorId: FAKE.uuid,
      floorName: 'ชั้น 2',
      level: 2,
      items: [
        {
          assetItemId: FAKE.meterId,
          meterAssignmentId: FAKE.uuid,
          code: 'W-A-201',
          utility: 'water' as RoundBuildingDto['floors'][number]['items'][number]['utility'],
          purpose: 'unit' as MeterPurposeName,
          unitId: FAKE.uuid,
          unitNo: FAKE.unitCode,
          iot: false,
          health: 'no_device' as MeterHealthName,
          lastReading: {
            id: FAKE.uuid,
            register: '812.400',
            readAt: '2026-09-24T09:10:00+07:00',
            source: 'ocr' as ReadingSourceName,
            photoDocumentId: FAKE.uuid,
          },
          assignee: { userId: FAKE.uuid, displayName: 'สมศรี ใจดี' },
          requested: true,
        },
      ],
    },
  ],
};

const SERIES_EXAMPLE: MeterSeriesDto = {
  assetItemId: FAKE.meterId,
  unit: 'kwh' as MeterUnitName,
  bucket: SeriesBucketName.H1,
  points: [
    {
      bucket: '2026-10-01T00:00:00+07:00',
      usage: '0.412',
      lastRegister: '12345.678',
      points: 4,
      avgPowerW: '410.5',
      avgFlowLpm: null,
    },
  ],
};

const CSV_EXAMPLE =
  'read_at,unit_no,meter_code,utility,purpose,register,unit,consumption,source,confidence,review_state,is_install,is_final,superseded_by,reading_id\n2026-10-24T09:10:00+07:00,A-201,E-A-201,electric,unit,12345.678,kwh,142.120,ocr,0.900,accepted,false,false,,3b241101-e2bb-4255-8caf-4136c566a962\n';

// --------------------------------------------------------------------------------------------- devices

export function devicesController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.devices`)
  @ApiSurface(SURFACES[surface])
  @Controller(`${surface}/devices`)
  class DevicesController {
    constructor(
      readonly fleet: DeviceFleetService,
      readonly commands: DeviceCommandsService,
    ) {}

    @Get()
    @TenantScoped()
    @Can('device.read')
    @ApiEndpoint({
      id: `${surface}.devices.list`,
      summary: 'Devices of my buildings',
      description:
        'Gateways and meter devices of the buildings I own or operate (RLS; Staff: their buildings) with status, last seen and gateway health (D-033, D-034).',
      implements: ['D-033', 'D-034'],
    })
    @ApiPaginated(FleetDeviceDto, { example: DEVICE_EXAMPLE })
    @ApiStandardErrors('validation.failed', ...T)
    async list(
      @CurrentTenant() ctx: TenantContext,
      @Query() q: DeviceListQuery,
    ): Promise<Page<FleetDeviceDto>> {
      const { rows, total } = await this.fleet.listForTenant(ctx, {
        buildingId: q.buildingId,
        kind: q.kind,
        status: q.status,
        q: q.q,
        ...toSkipTake(q),
      });
      return paginated(
        rows.map((d) => fleetDeviceDto(d)),
        total,
        q,
      );
    }

    @Get(':deviceId')
    @TenantScoped()
    @Can('device.read')
    @ApiEndpoint({
      id: `${surface}.devices.get`,
      summary: 'One device with channels, configs and events',
      description:
        'The device, its meter channels (open first, then history), the last 5 gateway config versions (applied / rejected / drift) and the last 20 operational events (D-033, D-034, D-131).',
      implements: ['D-033', 'D-034', 'D-131'],
    })
    @ApiSuccess(200, {
      description: 'The device',
      type: DeviceDetailDto,
      example: { device: DEVICE_EXAMPLE, channels: [], configs: [], events: [] },
    })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async get(
      @CurrentTenant() ctx: TenantContext,
      @Param('deviceId', ParseUUIDPipe) id: string,
    ): Promise<DeviceDetailDto> {
      const d = await this.fleet.detailForTenant(ctx, id);
      return {
        device: fleetDeviceDto(d.device),
        channels: d.channels.map(channelDto),
        configs: d.configs.map(configVersionDto),
        events: d.events.map(deviceEventDto),
      };
    }

    @Get(':deviceId/commands')
    @TenantScoped()
    @Can('device.read')
    @ApiEndpoint({
      id: `${surface}.devices.listCommands`,
      summary: 'Commands sent to a gateway',
      description: 'The last 50 commands with their acknowledgement state (device protocol §2, D-131).',
      implements: ['D-131'],
    })
    @ApiSuccess(200, { description: 'Commands', type: [DeviceCommandDto], example: [COMMAND_EXAMPLE] })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async listCommands(
      @CurrentTenant() ctx: TenantContext,
      @Param('deviceId', ParseUUIDPipe) id: string,
    ): Promise<DeviceCommandDto[]> {
      await this.fleet.getForTenant(ctx, id);
      return (await this.commands.list(ctx, id)).map(commandDto);
    }

    @Post(':deviceId/commands')
    @HttpCode(202)
    @TenantScoped()
    @Can('device.command')
    @ApiAsync({ poll: `${surface}.devices.listCommands` })
    @ApiEndpoint({
      id: `${surface}.devices.sendCommand`,
      summary: 'Send a command to a gateway',
      description:
        '`read_now`, `restart`, `identify` or `upload_logs` (D-131): recorded, published on `gp/v1/{gatewayId}/cmd` after commit, re-sent up to 3 times until acknowledged, expired after its TTL. There is no command that cuts power or locks a unit (D-024). Audited.',
      implements: ['D-131', 'D-024'],
    })
    @ApiJsonBody(OperatorCommandCreateDto, { type: 'read_now', args: { meterIds: [FAKE.meterId] } })
    @ApiSuccess(202, { description: 'Queued', type: DeviceCommandDto, example: COMMAND_EXAMPLE })
    @ApiStandardErrors('command.not_allowed', 'device.not_gateway', 'device.invalid_state', ...WRITE)
    async sendCommand(
      @CurrentTenant() ctx: TenantContext,
      @Param('deviceId', ParseUUIDPipe) id: string,
      @Body() body: OperatorCommandCreateDto,
    ): Promise<DeviceCommandDto> {
      return commandDto(await this.commands.issueForTenant(ctx, id, body.type, body.args));
    }
  }
  return DevicesController;
}

export function deviceInstallsController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.deviceInstalls`)
  @ApiSurface(SURFACES[surface])
  @Controller(surface)
  class DeviceInstallsController {
    constructor(
      readonly installs: DeviceInstallsService,
      readonly fleet: DeviceFleetService,
    ) {}

    @Post('devices/actions/provision')
    @Idempotent()
    @HttpCode(200)
    @TenantScoped()
    @Can('device.install')
    @ApiEndpoint({
      id: `${surface}.deviceInstalls.provision`,
      summary: 'Provision a gateway from its QR',
      description:
        'On site, the installer scans the gateway QR (serial) of a gateway assigned to this building: a fresh single-use provisioning code (72 h) for `POST /v1/device/bootstrap`; a new code invalidates the unused one (D-033, D-130). Audited.',
      implements: ['D-033', 'D-130'],
    })
    @ApiJsonBody(ProvisionGatewayDto, { serial: 'GP-GW-000123', buildingId: FAKE.buildingId })
    @ApiSuccess(200, {
      description: 'Code',
      type: ProvisioningCodeDto,
      example: { deviceId: FAKE.gatewayId, code: 'K7QX-2M9P-H4TD', expiresAt: '2026-11-04T00:15:00+07:00' },
    })
    @ApiStandardErrors('device.not_gateway', 'device.invalid_state', 'asset.read_only', ...WRITE)
    async provision(
      @CurrentTenant() ctx: TenantContext,
      @Body() body: ProvisionGatewayDto,
    ): Promise<ProvisioningCodeDto> {
      const r = await this.installs.provision(ctx, body);
      return { deviceId: r.deviceId, code: r.code, expiresAt: iso(r.expiresAt) };
    }

    @Post('devices/actions/install')
    @Idempotent()
    @TenantScoped()
    @Can('device.install')
    @ApiEndpoint({
      id: `${surface}.deviceInstalls.install`,
      summary: 'Install a meter device on a meter',
      description:
        'Binds a meter device (claimed from inventory or registered by serial) to the meter through a gateway channel (bus, address/pin, driver, register map) and records the physical register at install with its photo as the first reading of the channel (`manual`, `is_install`, D-033). The gateway config is recompiled and published retained (D-131). One open channel per meter and per bus address.',
      implements: ['D-033', 'D-131'],
    })
    @ApiJsonBody(DeviceInstallDto, {
      meterAssetItemId: FAKE.meterId,
      gatewayDeviceId: FAKE.gatewayId,
      meterDevice: { serial: 'SDM120-0042', model: 'SDM120', vendor: 'Eastron', driver: 'sdm120' },
      wiring: { busId: 'bus1', busType: 'modbus_rtu', address: 12 },
      installRegister: '12345.678',
      photoDocumentId: FAKE.uuid,
    })
    @ApiSuccess(201, {
      description: 'Installed',
      type: DeviceInstalledDto,
      example: {
        device: { ...DEVICE_EXAMPLE, kind: 'electric_meter' },
        channelId: FAKE.uuid,
        readingId: FAKE.uuid,
      },
    })
    @ApiStandardErrors(
      'meter.channel_exists',
      'device.unavailable',
      'device.not_gateway',
      'device.invalid_state',
      'reading.photo_required',
      'reading.no_assignment',
      'reading.non_monotonic',
      'asset.read_only',
      ...WRITE,
    )
    async install(
      @CurrentTenant() ctx: TenantContext,
      @Body() body: DeviceInstallDto,
    ): Promise<DeviceInstalledDto> {
      const r = await this.installs.install(ctx, body);
      return {
        device: fleetDeviceDto(await this.fleet.getForTenant(ctx, r.device.id)),
        channelId: r.channel.id,
        readingId: r.reading.id,
      };
    }

    @Post('devices/actions/remove')
    @HttpCode(200)
    @Idempotent()
    @TenantScoped()
    @Can('device.install')
    @ApiEndpoint({
      id: `${surface}.deviceInstalls.remove`,
      summary: 'Remove the meter device from a meter',
      description:
        'Closes the channel with a reason and a final photo reading; the meter reads manually again (D-012, D-033) and the device returns to the building stock. The gateway config is recompiled.',
      implements: ['D-033', 'D-012'],
    })
    @ApiJsonBody(DeviceUnbindDto, {
      meterAssetItemId: FAKE.meterId,
      register: '12399.100',
      photoDocumentId: FAKE.uuid,
      reason: 'meter device faulty',
    })
    @ApiSuccess(200, {
      description: 'Removed',
      type: DeviceUnboundDto,
      example: { channelId: FAKE.uuid, readingId: FAKE.uuid },
    })
    @ApiStandardErrors(
      'meter.no_channel',
      'reading.photo_required',
      'reading.no_assignment',
      'reading.non_monotonic',
      'asset.read_only',
      ...WRITE,
    )
    async remove(
      @CurrentTenant() ctx: TenantContext,
      @Body() body: DeviceUnbindDto,
    ): Promise<DeviceUnboundDto> {
      const r = await this.installs.unbind(ctx, body);
      return { channelId: r.channelId, readingId: r.reading.id };
    }

    @Post('devices/actions/swap')
    @HttpCode(200)
    @Idempotent()
    @TenantScoped()
    @Can('device.install')
    @ApiEndpoint({
      id: `${surface}.deviceInstalls.swap`,
      summary: 'Swap a meter',
      description:
        'Meter replacement (D-033): the old assignment closes with its final register (photo) and the new meter opens at the same instant with its initial register (photo) — no gap, no overlap; consumption never spans the two meters. The old meter asset item is retired; with a device the channel moves to the new meter and the gateway config is recompiled.',
      implements: ['D-033', 'D-030'],
    })
    @ApiJsonBody(MeterSwapDto, {
      meterAssetItemId: FAKE.meterId,
      oldFinalRegister: '23456.700',
      oldPhotoDocumentId: FAKE.uuid,
      newMeter: { serial: 'SN-889911', manufacturer: 'Eastron', model: 'SDM120' },
      newMeterDevice: { serial: 'SDM120-0099', model: 'SDM120', vendor: 'Eastron', driver: 'sdm120' },
      newInitialRegister: '0.000',
      newPhotoDocumentId: FAKE.uuid,
      reason: 'meter display broken',
    })
    @ApiSuccess(200, {
      description: 'Swapped',
      type: MeterSwappedDto,
      example: {
        swapId: FAKE.uuid,
        oldAssignmentId: FAKE.uuid,
        newAssignmentId: FAKE.uuid,
        newAssetItemId: FAKE.meterId,
        newDeviceId: null,
        finalReadingId: FAKE.uuid,
        firstReadingId: FAKE.uuid,
      },
    })
    @ApiStandardErrors(
      'meter.already_assigned',
      'device.unavailable',
      'reading.photo_required',
      'reading.no_assignment',
      'reading.non_monotonic',
      'asset.read_only',
      ...WRITE,
    )
    async swap(@CurrentTenant() ctx: TenantContext, @Body() body: MeterSwapDto): Promise<MeterSwappedDto> {
      return this.installs.swap(ctx, body);
    }
  }
  return DeviceInstallsController;
}

// --------------------------------------------------------------------------------------------- readings

export function meterReadingsController(surface: Extract<Surface, 'owner' | 'staff'>): Type<unknown> {
  @ApiTags(`${surface}.meterReadings`)
  @ApiSurface(SURFACES[surface])
  @Controller(surface)
  class MeterReadingsController {
    constructor(
      readonly readings: MeterReadingsService,
      readonly rounds: ReadingRoundsService,
      readonly series: SeriesService,
    ) {}

    @Post('meter-readings')
    @Idempotent()
    @TenantScoped()
    @Can('reading.capture')
    @ApiEndpoint({
      id: `${surface}.meterReadings.create`,
      summary: 'Record a meter reading with its photo',
      description:
        'The photo (`meter_photo`) is read by OCR (vision model behind the AI gateway); a typed value is checked against it, without one the OCR value is used (source `ocr`). The reading is accepted, or goes to the owner review queue when outside the plausibility band, decreasing without a swap, or OCR is doubtful (D-035); an accepted decrease is impossible (D-030). Staff readings join the reading round of the billing period.',
      implements: ['D-035', 'D-012', 'D-030', 'D-031'],
    })
    @ApiJsonBody(MeterReadingCreateDto, {
      assetItemId: FAKE.meterId,
      photoDocumentId: FAKE.uuid,
      typedValue: '12345.678',
      readAt: FAKE.dateTime,
    })
    @ApiSuccess(201, { description: 'Recorded', type: MeterReadingDto, example: READING_EXAMPLE })
    @ApiStandardErrors(
      'reading.photo_required',
      'reading.unreadable',
      'reading.duplicate',
      'reading.no_assignment',
      'reading.non_monotonic',
      'document.type_not_allowed',
      'document.not_uploaded',
      ...WRITE,
    )
    async create(
      @CurrentTenant() ctx: TenantContext,
      @Body() body: MeterReadingCreateDto,
    ): Promise<MeterReadingDto> {
      return readingDto(
        await this.readings.submit(ctx, body, surface === 'staff' ? 'staff_pwa' : 'owner_web'),
      );
    }

    @Get('meters/:assetItemId/readings')
    @TenantScoped()
    @Can('reading.read')
    @ApiEndpoint({
      id: `${surface}.meterReadings.listForMeter`,
      summary: 'Readings of a meter',
      description:
        'Every reading of the meter, newest first, with its source badge (`iot` / `ocr` / `manual` / `estimated`), confidence, evidence and review state; superseded readings point at their correction (D-012, D-142).',
      implements: ['D-012', 'D-142'],
    })
    @ApiPaginated(MeterReadingDto, { example: READING_EXAMPLE })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async listForMeter(
      @CurrentTenant() ctx: TenantContext,
      @Param('assetItemId', ParseUUIDPipe) assetItemId: string,
      @Query() q: MeterReadingListQuery,
    ): Promise<Page<MeterReadingDto>> {
      const { rows, total } = await this.readings.listForMeter(ctx, assetItemId, {
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        ...toSkipTake(q),
      });
      return paginated(rows.map(readingDto), total, q);
    }

    @Get('meters/:assetItemId/series')
    @TenantScoped()
    @Can('reading.read')
    @ApiEndpoint({
      id: `${surface}.meterReadings.series`,
      summary: 'Usage series of a meter',
      description:
        'Consumption per 15-minute, hourly or daily bucket from the telemetry rollups (D-162; never raw telemetry, never billing data — D-030). At most 3,000 buckets per request.',
      implements: ['D-162', 'D-030'],
    })
    @ApiSuccess(200, { description: 'Series', type: MeterSeriesDto, example: SERIES_EXAMPLE })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async meterSeries(
      @CurrentTenant() ctx: TenantContext,
      @Param('assetItemId', ParseUUIDPipe) assetItemId: string,
      @Query() q: SeriesQuery,
    ): Promise<MeterSeriesDto> {
      const bucket = (q.bucket ?? SeriesBucketName.H1) as Bucket;
      const s = await this.series.meterSeries(ctx, assetItemId, new Date(q.from), new Date(q.to), bucket);
      return {
        assetItemId,
        unit: s.unit as MeterUnitName,
        bucket: bucket as SeriesBucketName,
        points: s.points.map((p) => ({
          bucket: iso(p.bucket),
          usage: p.usage?.toFixed(3) ?? null,
          lastRegister: p.lastRegister?.toFixed(3) ?? null,
          points: p.points,
          avgPowerW: p.avgPowerW?.toFixed(1) ?? null,
          avgFlowLpm: p.avgFlowLpm?.toFixed(2) ?? null,
        })),
      };
    }

    @Get('reading-rounds/current')
    @TenantScoped()
    @Can('reading.capture')
    @ApiEndpoint({
      id: `${surface}.meterReadings.currentRound`,
      summary: 'Meters still to read before the cut-off',
      description:
        'Per building, grouped by floor: meters read manually (no gateway) and IoT meters whose health is stale/silent, without a reading in the last `readings.round_window_days` before the billing cut-off, with their last reading and photo (D-031, D-035).',
      implements: ['D-031', 'D-035', 'D-034'],
    })
    @ApiSuccess(200, { description: 'Rounds', type: [RoundBuildingDto], example: [ROUND_EXAMPLE] })
    @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
    async currentRound(
      @CurrentTenant() ctx: TenantContext,
      @Query() q: RoundsQuery,
    ): Promise<RoundBuildingDto[]> {
      return (await this.rounds.current(ctx, q.buildingId)).map((b) => ({
        buildingId: b.buildingId,
        buildingName: b.buildingName,
        periodKey: b.periodKey,
        cutoffAt: iso(b.cutoffAt),
        windowStart: iso(b.windowStart),
        batchId: b.batchId,
        remaining: b.remaining,
        total: b.total,
        read: b.read,
        floors: b.floors.map((f) => ({
          floorId: f.floorId,
          floorName: f.floorName,
          level: f.level,
          items: f.items.map((i) => ({
            assetItemId: i.assetItemId,
            meterAssignmentId: i.meterAssignmentId,
            code: i.code,
            utility: i.utility as UtilityName,
            purpose: i.purpose as MeterPurposeName,
            unitId: i.unitId,
            unitNo: i.unitNo,
            iot: i.iot,
            health: i.health as MeterHealthName | null,
            lastReading: i.lastReading
              ? {
                  id: i.lastReading.id,
                  register: i.lastReading.register,
                  readAt: iso(i.lastReading.readAt),
                  source: i.lastReading.source as ReadingSourceName,
                  photoDocumentId: i.lastReading.photoDocumentId,
                }
              : null,
            assignee: i.assignee,
            requested: i.requested,
          })),
        })),
      }));
    }
  }
  return MeterReadingsController;
}

// --------------------------------------------------------------------------------------------- owner only

@ApiTags('owner.readingReviews')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerReadingReviewsController {
  constructor(private readonly readings: MeterReadingsService) {}

  @Get('meter-readings/reviews')
  @TenantScoped()
  @Can('reading.review')
  @ApiEndpoint({
    id: 'owner.readingReviews.list',
    summary: 'Reading review queue',
    description:
      'Readings waiting for a decision (default `open`), oldest first, with the reason (out of band, decreasing without swap, OCR doubtful…), the band and the trailing average (D-035).',
    implements: ['D-035'],
  })
  @ApiPaginated(ReadingReviewDto, { example: REVIEW_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ReviewListQuery,
  ): Promise<Page<ReadingReviewDto>> {
    const { rows, total } = await this.readings.listReviews(ctx, {
      status: q.status,
      buildingId: q.buildingId,
      ...toSkipTake(q),
    });
    return paginated(rows.map(reviewDto), total, q);
  }

  @Get('meter-readings/reviews/:reviewId')
  @TenantScoped()
  @Can('reading.review')
  @ApiEndpoint({
    id: 'owner.readingReviews.get',
    summary: 'One reading under review',
    description:
      'The reading with its photo id, OCR raw value and confidence, and the decision once taken (D-035).',
    implements: ['D-035'],
  })
  @ApiSuccess(200, { description: 'Review', type: ReadingReviewDto, example: REVIEW_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('reviewId', ParseUUIDPipe) id: string,
  ): Promise<ReadingReviewDto> {
    return reviewDto(await this.readings.getReview(ctx, id));
  }

  @Post('meter-readings/reviews/:reviewId/actions/decide')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('reading.review')
  @ApiEndpoint({
    id: 'owner.readingReviews.decide',
    summary: 'Accept, correct or reject a reading',
    description:
      '`accept` makes the reading billable (refused if it would decrease the accepted series); `correct` keeps the original as `corrected` and inserts a superseding `manual` reading with the register given (D-142); `reject` drops it. A note is required to correct or reject. Audited.',
    implements: ['D-035', 'D-142', 'D-030'],
  })
  @ApiJsonBody(ReviewDecisionDto, { action: 'correct', register: '12350.000', note: 'OCR read 1 as 7' })
  @ApiSuccess(200, {
    description: 'Decided',
    type: ReadingReviewDto,
    example: { ...REVIEW_EXAMPLE, status: 'corrected', correctedRegister: '12350.000', nextActions: [] },
  })
  @ApiStandardErrors('reading.review_closed', 'reading.non_monotonic', ...WRITE)
  async decide(
    @CurrentTenant() ctx: TenantContext,
    @Param('reviewId', ParseUUIDPipe) id: string,
    @Body() body: ReviewDecisionDto,
  ): Promise<ReadingReviewDto> {
    const missing = (path: string, message: string) =>
      new DomainException('validation.failed', { errors: [{ path, code: 'required', message }] });
    if (body.action === ReviewDecisionName.Correct) {
      if (!body.register) throw missing('register', 'register is required to correct');
      if (!body.note) throw missing('note', 'note is required to correct');
      return reviewDto(
        await this.readings.decide(ctx, id, { action: 'correct', register: body.register, note: body.note }),
      );
    }
    if (body.action === ReviewDecisionName.Reject) {
      if (!body.note) throw missing('note', 'note is required to reject');
      return reviewDto(await this.readings.decide(ctx, id, { action: 'reject', note: body.note }));
    }
    return reviewDto(await this.readings.decide(ctx, id, { action: 'accept' }));
  }

  @Get('units/:unitId/meter-history')
  @TenantScoped()
  @Can('reading.read')
  @ApiEndpoint({
    id: 'owner.readingReviews.unitHistory',
    summary: 'Meter history of a unit',
    description:
      'Every meter assignment of the unit (oldest first, per utility) with its readings and the swaps between them — continuous across replacements (D-033, D-030).',
    implements: ['D-033', 'D-030'],
  })
  @ApiSuccess(200, {
    description: 'History',
    type: UnitMeterHistoryDto,
    example: {
      unitId: FAKE.uuid,
      unitNo: FAKE.unitCode,
      assignments: [
        {
          id: FAKE.uuid,
          assetItemId: FAKE.meterId,
          meterName: 'มิเตอร์ไฟ A-201',
          meterSerial: 'SN-1',
          utility: 'electric',
          code: 'E-A-201',
          validFrom: FAKE.dateTime,
          validTo: null,
          initialReading: '0.000',
          finalReading: null,
          readings: [READING_EXAMPLE],
        },
      ],
      swaps: [],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async unitHistory(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Query() q: UtilityFilterQuery,
  ): Promise<UnitMeterHistoryDto> {
    const h = await this.readings.historyForUnit(ctx, unitId, q.utility);
    return {
      unitId: h.unit.id,
      unitNo: h.unit.unitNo,
      assignments: h.assignments.map((a) => ({
        id: a.id,
        assetItemId: a.assetItemId,
        meterName: a.assetItem.name,
        meterSerial: a.assetItem.serial,
        utility: a.utility as UtilityName,
        code: a.code,
        validFrom: iso(a.validFrom),
        validTo: a.validTo ? iso(a.validTo) : null,
        initialReading: a.initialReading.toFixed(3),
        finalReading: a.finalReading?.toFixed(3) ?? null,
        readings: h.readings.filter((r) => r.meterAssignmentId === a.id).map(readingDto),
      })),
      swaps: h.swaps.map((s) => ({
        id: s.id,
        oldAssignmentId: s.oldAssignmentId,
        newAssignmentId: s.newAssignmentId,
        oldLastRegister: s.oldLastRegister.toFixed(3),
        newFirstRegister: s.newFirstRegister.toFixed(3),
        swappedAt: iso(s.swappedAt),
        reason: s.reason,
      })),
    };
  }

  @Get('buildings/:buildingId/meter-readings/export')
  @TenantScoped()
  @Can('reading.read')
  @ApiEndpoint({
    id: 'owner.readingReviews.export',
    summary: 'Export the readings of a building (CSV)',
    description:
      'Readings read in `[from, to)` with unit, meter code, register, consumption, source, confidence and review state (UTF-8 with BOM for Excel). Audited (D-012).',
    implements: ['D-012'],
  })
  @ApiResponse({
    status: 200,
    description: 'CSV',
    content: { 'text/csv': { schema: { type: 'string' }, example: CSV_EXAMPLE } },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async export(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Query() q: ExportQuery,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.readings.exportCsv(ctx, buildingId, new Date(q.from), new Date(q.to));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meter-readings-${buildingId}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(csv);
  }
}

@ApiTags('owner.utilityInvoices')
@ApiSurface(SURFACES.owner)
@Controller('owner/buildings/:buildingId/utility-invoices')
export class OwnerUtilityInvoicesController {
  constructor(private readonly loss: UtilityLossService) {}

  @Get()
  @TenantScoped()
  @Can('utility_invoice.manage')
  @ApiEndpoint({
    id: 'owner.utilityInvoices.list',
    summary: 'Utility invoices of a building',
    description: 'The MEA/PEA/MWA/PWA invoices entered for the building, newest period first (D-032).',
    implements: ['D-032'],
  })
  @ApiSuccess(200, { description: 'Invoices', type: [UtilityInvoiceDto], example: [INVOICE_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Query() q: UtilityFilterQuery,
  ): Promise<UtilityInvoiceDto[]> {
    return (await this.loss.listInvoices(ctx, buildingId, q.utility)).map(utilityInvoiceDto);
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('utility_invoice.manage')
  @ApiEndpoint({
    id: 'owner.utilityInvoices.create',
    summary: 'Enter a utility invoice',
    description:
      'Units, amount, Ft, service charge, VAT and registers of the building’s main-meter invoice for a period, with the invoice photo/PDF (`utility_invoice` document); one per utility, provider account and period. A computed loss report of the period is recomputed (D-032). Audited.',
    implements: ['D-032'],
  })
  @ApiJsonBody(UtilityInvoiceCreateDto, {
    utility: 'electric',
    provider: 'mea',
    periodStart: '2026-09-26',
    periodEnd: '2026-10-25',
    invoiceNo: '0123456789',
    units: '5230.000',
    amount: '24518.32',
    ft: '0.3972',
    vat: '1604.00',
  })
  @ApiSuccess(201, { description: 'Entered', type: UtilityInvoiceDto, example: INVOICE_EXAMPLE })
  @ApiStandardErrors('utility_invoice.duplicate', 'asset.read_only', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: UtilityInvoiceCreateDto,
  ): Promise<UtilityInvoiceDto> {
    return utilityInvoiceDto(await this.loss.createInvoice(ctx, buildingId, body));
  }

  @Post('actions/prefill')
  @HttpCode(200)
  @TenantScoped()
  @Can('utility_invoice.manage')
  @ApiEndpoint({
    id: 'owner.utilityInvoices.prefill',
    summary: 'Read an invoice photo or PDF',
    description:
      'OCR of an uploaded `utility_invoice` document (vision model behind the AI gateway) to prefill the entry form; nothing is stored (D-032, D-035).',
    implements: ['D-032'],
  })
  @ApiJsonBody(UtilityInvoicePrefillRequestDto, { documentId: FAKE.uuid, utility: 'electric' })
  @ApiSuccess(200, {
    description: 'Fields read',
    type: UtilityInvoicePrefillDto,
    example: {
      fields: {
        invoiceNo: '0123456789',
        periodStart: '2026-09-26',
        periodEnd: '2026-10-25',
        units: '5230.000',
        amount: '24518.32',
        ft: '0.3972',
        serviceCharge: '38.22',
        vat: '1604.00',
        previousRegister: '81200.000',
        currentRegister: '86430.000',
      },
      confidence: 0.92,
      model: 'fake-ocr',
    },
  })
  @ApiStandardErrors('provider.unavailable', 'document.type_not_allowed', 'document.not_uploaded', ...WRITE)
  async prefill(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: UtilityInvoicePrefillRequestDto,
  ): Promise<UtilityInvoicePrefillDto> {
    return this.loss.prefill(ctx, buildingId, body.documentId, body.utility);
  }

  @Post('actions/import-ebill')
  @Idempotent()
  @TenantScoped()
  @Can('utility_invoice.manage')
  @ApiEndpoint({
    id: 'owner.utilityInvoices.importEbill',
    summary: 'Import a utility e-bill',
    description:
      'Reads the e-bill PDF of the utility and stores the invoice (`source = ebill_import`); refused with `utility_invoice.unreadable` when the period, units or amount cannot be read (D-032).',
    implements: ['D-032'],
  })
  @ApiJsonBody(UtilityInvoiceImportDto, { documentId: FAKE.uuid, utility: 'electric', provider: 'mea' })
  @ApiSuccess(201, {
    description: 'Imported',
    type: UtilityInvoiceDto,
    example: { ...INVOICE_EXAMPLE, source: 'ebill_import' },
  })
  @ApiStandardErrors(
    'utility_invoice.unreadable',
    'utility_invoice.duplicate',
    'provider.unavailable',
    'document.type_not_allowed',
    'document.not_uploaded',
    'asset.read_only',
    ...WRITE,
  )
  async importEbill(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: UtilityInvoiceImportDto,
  ): Promise<UtilityInvoiceDto> {
    return utilityInvoiceDto(await this.loss.importEbill(ctx, buildingId, body));
  }

  @Get(':invoiceId')
  @TenantScoped()
  @Can('utility_invoice.manage')
  @UseEtag((i: UtilityInvoiceDto) => etagOf(i.id, i.version))
  @ApiEndpoint({
    id: 'owner.utilityInvoices.get',
    summary: 'One utility invoice',
    description: 'The invoice with its document id (D-032).',
    implements: ['D-032'],
  })
  @ApiSuccess(200, { description: 'Invoice', type: UtilityInvoiceDto, example: INVOICE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<UtilityInvoiceDto> {
    return utilityInvoiceDto(await this.loss.getInvoice(ctx, buildingId, id));
  }

  @Patch(':invoiceId')
  @TenantScoped()
  @Can('utility_invoice.manage')
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.utilityInvoices.update',
    summary: 'Correct a utility invoice',
    description: 'If-Match; the loss report of the period is recomputed (D-032). Audited with before/after.',
    implements: ['D-032'],
  })
  @ApiJsonBody(UtilityInvoiceUpdateDto, { units: '5231.000', amount: '24522.10' })
  @ApiSuccess(200, {
    description: 'Updated',
    type: UtilityInvoiceDto,
    example: { ...INVOICE_EXAMPLE, version: 2 },
  })
  @ApiStandardErrors('utility_invoice.duplicate', 'concurrency.stale', 'asset.read_only', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: UtilityInvoiceUpdateDto,
  ): Promise<UtilityInvoiceDto> {
    const version = ifMatchVersion(ifMatch, await this.loss.getInvoice(ctx, buildingId, id));
    return utilityInvoiceDto(await this.loss.updateInvoice(ctx, buildingId, id, version, body));
  }
}

@ApiTags('owner.loss')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerLossController {
  constructor(private readonly loss: UtilityLossService) {}

  @Get('buildings/:buildingId/loss')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.loss.get',
    summary: 'Utility loss of a billing period',
    description:
      'Loss = invoice units − Σ units billed to units − Σ common-area units, in units, % and THB at the published utility tariff (or the invoice’s average price), with ranked suspects (zero use while occupied, use while vacant, estimated readings, night water flow, stale meters, anomalies) and a 12-period trend (D-032). Computed on first request; billed units come from accepted readings until B4 invoices exist (`billedUnitsSource`).',
    implements: ['D-032'],
  })
  @ApiSuccess(200, { description: 'Loss', type: LossViewDto, example: LOSS_EXAMPLE })
  @ApiStandardErrors('loss.no_invoice', 'http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Query() q: LossQuery,
  ): Promise<LossViewDto> {
    const v = await this.loss.report(ctx, buildingId, q.utility, q.cycle);
    return view(v.report, v.trend);
  }

  @Post('buildings/:buildingId/loss/actions/recompute')
  @HttpCode(200)
  @TenantScoped()
  @Can('utility_invoice.manage')
  @ApiEndpoint({
    id: 'owner.loss.recompute',
    summary: 'Recompute the loss of a period',
    description:
      'After late readings or corrections; replaces the stored report and its suspects (D-032). Audited.',
    implements: ['D-032'],
  })
  @ApiJsonBody(LossRecomputeDto, { utility: 'electric', cycle: '2026-10' })
  @ApiSuccess(200, { description: 'Recomputed', type: LossViewDto, example: LOSS_EXAMPLE })
  @ApiStandardErrors('loss.no_invoice', ...WRITE)
  async recompute(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: LossRecomputeDto,
  ): Promise<LossViewDto> {
    await this.loss.compute(ctx, buildingId, body.utility, body.cycle);
    const v = await this.loss.report(ctx, buildingId, body.utility, body.cycle);
    return view(v.report, v.trend);
  }

  @Get('loss/summary')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.loss.summary',
    summary: 'Latest loss per building and utility',
    description:
      'The dashboard widget: the latest computed report of each building × utility with its suspect count (D-032).',
    implements: ['D-032'],
  })
  @ApiSuccess(200, {
    description: 'Summary',
    type: [LossSummaryRowDto],
    example: [
      {
        buildingId: FAKE.buildingId,
        buildingName: 'อาคาร A',
        utility: 'water',
        periodEnd: '2026-10-25',
        lossUnits: '12.400',
        lossPct: '8.1000',
        lossThb: '210.80',
        suspects: 2,
      },
    ],
  })
  @ApiStandardErrors(...T)
  async summary(@CurrentTenant() ctx: TenantContext): Promise<LossSummaryRowDto[]> {
    return (await this.loss.summary(ctx)).map((r) => ({
      buildingId: r.buildingId,
      buildingName: r.building.name,
      utility: r.utility as UtilityName,
      periodEnd: r.periodEnd.toISOString().slice(0, 10),
      lossUnits: r.lossUnits.toFixed(3),
      lossPct: r.lossPct?.toFixed(4) ?? null,
      lossThb: r.lossThb.toFixed(2),
      suspects: r._count.suspects,
    }));
  }
}

function view(
  report: Parameters<typeof lossReportDto>[0],
  trend: {
    periodEnd: Date;
    lossUnits: { toFixed(n: number): string };
    lossPct: { toFixed(n: number): string } | null;
    lossThb: { toFixed(n: number): string };
  }[],
): LossViewDto {
  return {
    report: lossReportDto(report),
    trend: trend.map((t) => ({
      periodEnd: t.periodEnd.toISOString().slice(0, 10),
      lossUnits: t.lossUnits.toFixed(3),
      lossPct: t.lossPct?.toFixed(4) ?? null,
      lossThb: t.lossThb.toFixed(2),
    })),
  };
}

// --------------------------------------------------------------------------------------------- resident

@ApiTags('resident.usage')
@ApiSurface(SURFACES.resident)
@Controller('resident/leases/:leaseId/usage')
export class ResidentUsageController {
  constructor(private readonly series: SeriesService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.usage.get',
    summary: 'My usage',
    description:
      'Daily (or hourly) electricity and water use of the unit of my lease, summed over the meters that served it during the lease (swaps included), from the telemetry rollups; empty for meters read manually (D-063, D-162). `summary` carries the totals computed here — the window, the previous window and the current billing period so far (estimated from telemetry, never the bill) (D-203).',
    implements: ['D-063', 'D-162', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'Usage',
    type: ResidentUsageDto,
    example: {
      leaseId: FAKE.uuid,
      unitId: FAKE.uuid,
      from: '2026-10-01T00:00:00+07:00',
      to: '2026-10-31T00:00:00+07:00',
      bucket: '1d',
      series: [
        {
          utility: 'electric',
          unit: 'kwh',
          points: [{ bucket: '2026-10-01T00:00:00+07:00', usage: '6.250' }],
        },
      ],
      summary: [
        {
          utility: 'electric',
          unit: 'kwh',
          total: '187.500',
          previousTotal: '172.000',
          cycleToDate: { from: '2026-10-01T00:00:00+07:00', usage: '84.250', estimated: true },
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Query() q: UsageQuery,
  ): Promise<ResidentUsageDto> {
    const bucket = (q.bucket ?? SeriesBucketName.D1) as Bucket;
    const u = await this.series.residentUsage(
      leaseId,
      bucket,
      q.from ? new Date(q.from) : undefined,
      q.to ? new Date(q.to) : undefined,
    );
    return {
      leaseId: u.leaseId,
      unitId: u.unitId,
      from: iso(u.from),
      to: iso(u.to),
      bucket: bucket as SeriesBucketName,
      series: u.series.map((s) => ({
        utility: s.utility as UtilityName,
        unit: s.unit as MeterUnitName,
        points: s.points.map((p) => ({ bucket: iso(p.bucket), usage: p.usage.toFixed(3) })),
      })),
      summary: u.summary.map((s) => ({
        utility: s.utility as UtilityName,
        unit: s.unit as MeterUnitName,
        total: s.total.toFixed(3),
        previousTotal: s.previousTotal?.toFixed(3) ?? null,
        cycleToDate: s.cycleToDate
          ? {
              from: iso(s.cycleToDate.from),
              usage: s.cycleToDate.usage.toFixed(3),
              estimated: s.cycleToDate.estimated,
            }
          : null,
      })),
    };
  }
}

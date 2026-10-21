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
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { DeviceCommandsService } from '@modules/smart-devices/commands.service';
import { DeviceFleetService } from '@modules/smart-devices/fleet.service';
import { OtaService } from '@modules/smart-devices/ota.service';
import { TelemetryMaintenanceService } from '@modules/smart-ingest/telemetry-maintenance.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  AdminCommandCreateDto,
  AdminDeviceListQuery,
  DeadLetterDto,
  DeadLetterListQuery,
  DeadLetterReplayDto,
  DeviceAssignDto,
  DeviceCommandDto,
  DeviceDetailDto,
  DeviceImportDto,
  DeviceImportResultDto,
  type DeviceKindName,
  DeviceMqttTransportDto,
  DeviceReasonDto,
  DeviceRingDto,
  type DeviceStatusName,
  FleetDeviceDto,
  FleetSummaryDto,
  OtaReleaseCreateDto,
  OtaReleaseDto,
  OtaRolloutCreateDto,
  OtaRolloutDto,
} from '../shared/smart.dto';
import {
  channelDto,
  commandDto,
  configVersionDto,
  deadLetterDto,
  deviceEventDto,
  fleetDeviceDto,
  releaseDto,
  rolloutDto,
} from '../shared/smart.mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const DEVICE_EXAMPLE = {
  id: FAKE.gatewayId,
  serial: 'GP-GW-000123',
  kind: 'gateway',
  model: 'rpi-cm4',
  vendor: 'Raspberry Pi',
  driver: null,
  ownership: 'platform_haas',
  status: 'assigned',
  tenantId: FAKE.tenantId,
  buildingId: FAKE.buildingId,
  assetItemId: null,
  gatewayDeviceId: null,
  firmwareVersion: null,
  arch: 'arm64',
  otaRing: 'canary',
  mqttWsFallback: false,
  lastSeenAt: null,
  configAppliedVersion: null,
  meters: 0,
  health: null,
  nextActions: ['assign', 'set-ring', 'set-mqtt-transport', 'revoke-certificates', 'retire'],
  version: 2,
};

const COMMAND_EXAMPLE = {
  id: FAKE.uuid,
  gatewayDeviceId: FAKE.gatewayId,
  type: 'set_log_level',
  args: { level: 'debug' },
  status: 'queued',
  issuedAt: FAKE.dateTime,
  expiresAt: '2026-11-01T00:20:00+07:00',
  attempts: 0,
  finishedAt: null,
  result: null,
  error: null,
};

const MANIFEST_EXAMPLE = {
  schema: 1,
  version: '0.4.0',
  channel: 'stable',
  arch: 'arm64',
  artifact: {
    url: 'https://device.getproperty.co/v1/device/ota/artifacts/0.4.0/getproperty-edge-0.4.0-linux-arm64',
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    size: 48211234,
  },
  minAgentVersion: '0.3.0',
  releasedAt: '2026-10-15T09:00:00Z',
  signature: { alg: 'ed25519', keyId: 'gp-ota-2026', value: 'bWFkZS11cC1zaWduYXR1cmU=' },
};

const RELEASE_EXAMPLE = {
  id: FAKE.uuid,
  version: '0.4.0',
  arch: 'arm64',
  channel: 'stable',
  artifactUrl:
    'https://device.getproperty.co/v1/device/ota/artifacts/0.4.0/getproperty-edge-0.4.0-linux-arm64',
  sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  keyId: 'gp-ota-2026',
  releasedAt: FAKE.dateTime,
  deprecatedAt: null,
  notes: 'Modbus timeouts fixed',
};

const ROLLOUT_EXAMPLE = {
  id: FAKE.uuid,
  release: RELEASE_EXAMPLE,
  ring: 'canary',
  status: 'running',
  maxFailuresPct: '10.00',
  startedAt: FAKE.dateTime,
  finishedAt: null,
  counts: { commanded: 1, applied: 1 },
  devices: [
    {
      deviceId: FAKE.gatewayId,
      status: 'applied',
      fromVersion: '0.3.0',
      error: null,
      updatedAt: FAKE.dateTime,
    },
  ],
  nextActions: ['pause', 'abort'],
};

const DEAD_LETTER_EXAMPLE = {
  id: FAKE.uuid,
  receivedAt: FAKE.dateTime,
  topic: `gp/v1/${FAKE.gatewayId}/telemetry`,
  channel: 'mqtt',
  gatewayDeviceId: FAKE.gatewayId,
  reason: 'invalid_payload',
  detail: 'readings[0].register must be a decimal string',
  payloadBytes: 1840,
  payloadPreview: '{"gatewayId":"2f6c1d7e-9a3b-4c5d-8e7f-0a1b2c3d4e5f"',
  replayedAt: null,
  replayOutcome: null,
};

const withTicket = (b: DeviceReasonDto) => (b.incidentRef ? `${b.reason} [${b.incidentRef}]` : b.reason);

// --------------------------------------------------------------------------------------------- fleet

@ApiTags('admin.devices')
@ApiSurface(SURFACES.admin)
@Controller('admin/devices')
export class AdminFleetController {
  constructor(
    private readonly fleet: DeviceFleetService,
    private readonly commands: DeviceCommandsService,
  ) {}

  @Get('fleet')
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.fleet',
    summary: 'Fleet counts',
    description:
      'Devices per tenant, building, kind and status, plus the unassigned platform inventory per kind (D-033).',
    implements: ['D-033'],
  })
  @ApiSuccess(200, {
    description: 'Counts',
    type: FleetSummaryDto,
    example: {
      byBuilding: [
        {
          tenantId: FAKE.tenantId,
          tenantName: FAKE.companyName,
          buildingId: FAKE.buildingId,
          buildingName: 'อาคาร A',
          kind: 'gateway',
          status: 'online',
          count: 1,
        },
      ],
      inventory: [{ kind: 'electric_meter', count: 40 }],
    },
  })
  @ApiStandardErrors('validation.failed')
  async summary(): Promise<FleetSummaryDto> {
    const f = await this.fleet.fleet();
    const buildings = new Map(f.buildings.map((b) => [b.id, b]));
    return {
      byBuilding: f.byBuilding.map((r) => ({
        tenantId: r.tenantId,
        tenantName: buildings.get(r.buildingId!)?.tenant?.displayName ?? null,
        buildingId: r.buildingId!,
        buildingName: buildings.get(r.buildingId!)?.name ?? '',
        kind: r.kind as DeviceKindName,
        status: r.status as DeviceStatusName,
        count: r._count._all,
      })),
      inventory: f.inventory.map((r) => ({ kind: r.kind as DeviceKindName, count: r._count._all })),
    };
  }

  @Get()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.list',
    summary: 'Every device',
    description: 'All tenants and the inventory; filter by tenant, building, kind, status, serial (D-033).',
    implements: ['D-033'],
  })
  @ApiPaginated(FleetDeviceDto, { example: DEVICE_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: AdminDeviceListQuery): Promise<Page<FleetDeviceDto>> {
    const { rows, total } = await this.fleet.list({
      tenantId: q.tenantId,
      inventoryOnly: q.inventory,
      buildingId: q.buildingId,
      kind: q.kind,
      status: q.status,
      q: q.q,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((d) => fleetDeviceDto(d, 'admin')),
      total,
      q,
    );
  }

  @Get(':deviceId')
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.get',
    summary: 'One device',
    description: 'The device with its health and next actions (D-033).',
    implements: ['D-033'],
  })
  @ApiSuccess(200, {
    description: 'Device',
    type: DeviceDetailDto,
    example: { device: DEVICE_EXAMPLE, channels: [], configs: [], events: [] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('deviceId', ParseUUIDPipe) id: string): Promise<DeviceDetailDto> {
    const device = await this.fleet.get(id);
    const detail = device.tenantId
      ? await this.fleet.detailForTenant({ tenantId: device.tenantId, source: 'system' }, id)
      : { device, channels: [], configs: [], events: [] };
    return {
      device: fleetDeviceDto(device, 'admin'),
      channels: detail.channels.map(channelDto),
      configs: detail.configs.map(configVersionDto),
      events: detail.events.map(deviceEventDto),
    };
  }

  @Post('actions/import')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.import',
    summary: 'Import devices into the inventory (CSV)',
    description:
      'New serials are created in the platform inventory, known serials skipped; any invalid row refuses the whole file (D-033). Audited.',
    implements: ['D-033'],
  })
  @ApiJsonBody(DeviceImportDto, {
    csv: 'serial,kind,model,vendor,driver,ownership,arch\nGW-0001,gateway,rpi-cm4,Raspberry Pi,,platform_haas,arm64',
  })
  @ApiSuccess(200, {
    description: 'Result',
    type: DeviceImportResultDto,
    example: { created: 1, skipped: [], errors: [] },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request')
  async import(@Body() body: DeviceImportDto): Promise<DeviceImportResultDto> {
    return this.fleet.importInventory(body.csv);
  }

  @Post(':deviceId/actions/assign')
  @HttpCode(200)
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.assign',
    summary: 'Assign a device to a tenant’s building',
    description:
      'Inventory → a building owned or operated by the tenant (`assigned`); a bootstrapped gateway cannot move buildings, an installed meter device cannot move (D-033). Audited.',
    implements: ['D-033'],
  })
  @ApiJsonBody(DeviceAssignDto, { tenantId: FAKE.tenantId, buildingId: FAKE.buildingId, otaRing: 'canary' })
  @ApiSuccess(200, { description: 'Assigned', type: FleetDeviceDto, example: DEVICE_EXAMPLE })
  @ApiStandardErrors('device.invalid_state', 'http.not_found', 'validation.failed', 'http.bad_request')
  async assign(
    @Param('deviceId', ParseUUIDPipe) id: string,
    @Body() body: DeviceAssignDto,
  ): Promise<FleetDeviceDto> {
    return fleetDeviceDto(await this.fleet.assign(id, { ...body, otaRing: body.otaRing }), 'admin');
  }

  @Post(':deviceId/actions/set-ring')
  @HttpCode(200)
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.setRing',
    summary: 'Set the OTA ring of a gateway',
    description: '`canary` → `pilot` → `all` (D-131). Audited.',
    implements: ['D-131'],
  })
  @ApiJsonBody(DeviceRingDto, { otaRing: 'canary' })
  @ApiSuccess(200, { description: 'Updated', type: FleetDeviceDto, example: DEVICE_EXAMPLE })
  @ApiStandardErrors('device.not_gateway', 'http.not_found', 'validation.failed', 'http.bad_request')
  async setRing(
    @Param('deviceId', ParseUUIDPipe) id: string,
    @Body() body: DeviceRingDto,
  ): Promise<FleetDeviceDto> {
    return fleetDeviceDto(await this.fleet.setRing(id, body.otaRing), 'admin');
  }

  @Post(':deviceId/actions/set-mqtt-transport')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.setMqttTransport',
    summary: 'Switch a gateway’s MQTT WebSocket fallback',
    description:
      'For a building whose network blocks outbound 8883 (D-239, O-012 resolved): `wsFallback: true` lets the gateway connect over EMQX ws 8083 behind Caddy authenticated by its device JWT **alone** — no client certificate on that path, so a stolen JWT (≤ 1 h, issued only over mTLS to a non-retired gateway) is enough to connect for its lifetime. Off by default; the bootstrap answer and every `POST /v1/device/token` answer carry `mqtt.wsUrl` only for such a gateway, so a provisioned gateway picks the change up at its next token refresh (≤ 1 h, edge CR-015, D-249) — no new provisioning code. Only gateways, never retired ones; audited with the reason; the next WebSocket connect is decided by the new value.',
    implements: ['D-235', 'D-239', 'D-249'],
  })
  @ApiJsonBody(DeviceMqttTransportDto, {
    wsFallback: true,
    reason: 'building firewall blocks outbound 8883 (ticket INC-2026-021)',
  })
  @ApiSuccess(200, {
    description: 'Updated',
    type: FleetDeviceDto,
    example: { ...DEVICE_EXAMPLE, mqttWsFallback: true },
  })
  @ApiStandardErrors(
    'device.not_gateway',
    'device.invalid_state',
    'http.not_found',
    'validation.failed',
    'http.bad_request',
  )
  async setMqttTransport(
    @Param('deviceId', ParseUUIDPipe) id: string,
    @Body() body: DeviceMqttTransportDto,
  ): Promise<FleetDeviceDto> {
    return fleetDeviceDto(await this.fleet.setMqttTransport(id, body.wsFallback, body.reason), 'admin');
  }

  @Post(':deviceId/actions/revoke-certificates')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.revokeCertificates',
    summary: 'Revoke a gateway’s certificates',
    description:
      'Certificates, broker ACL and device sessions are revoked at once; the gateway must bootstrap again with a new provisioning code (D-130). Audited.',
    implements: ['D-130'],
  })
  @ApiJsonBody(DeviceReasonDto, { reason: 'gateway stolen from the meter room' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: FleetDeviceDto,
    example: { ...DEVICE_EXAMPLE, status: 'assigned' },
  })
  @ApiStandardErrors('device.not_gateway', 'http.not_found', 'validation.failed')
  async revoke(
    @Param('deviceId', ParseUUIDPipe) id: string,
    @Body() body: DeviceReasonDto,
  ): Promise<FleetDeviceDto> {
    return fleetDeviceDto(await this.fleet.revokeCertificates(id, withTicket(body)), 'admin');
  }

  @Post(':deviceId/actions/retire')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.retire',
    summary: 'Retire a device',
    description:
      'For good: certificates, ACL and sessions revoked; a device still bound to a meter must be removed first (`device.in_use`, D-033). Audited.',
    implements: ['D-033', 'D-130'],
  })
  @ApiJsonBody(DeviceReasonDto, { reason: 'water damage' })
  @ApiSuccess(200, {
    description: 'Retired',
    type: FleetDeviceDto,
    example: { ...DEVICE_EXAMPLE, status: 'retired', nextActions: ['set-ring'] },
  })
  @ApiStandardErrors('device.in_use', 'device.invalid_state', 'http.not_found', 'validation.failed')
  async retire(
    @Param('deviceId', ParseUUIDPipe) id: string,
    @Body() body: DeviceReasonDto,
  ): Promise<FleetDeviceDto> {
    return fleetDeviceDto(await this.fleet.retire(id, withTicket(body)), 'admin');
  }

  @Get(':deviceId/commands')
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.devices.listCommands',
    summary: 'Commands of a gateway',
    description: 'The last 50 commands with their acknowledgement state (D-131).',
    implements: ['D-131'],
  })
  @ApiSuccess(200, { description: 'Commands', type: [DeviceCommandDto], example: [COMMAND_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async listCommands(@Param('deviceId', ParseUUIDPipe) id: string): Promise<DeviceCommandDto[]> {
    await this.fleet.get(id);
    return (await this.commands.list(null, id)).map(commandDto);
  }

  @Post(':deviceId/commands')
  @HttpCode(202)
  @Can('admin.device.manage')
  @ApiAsync({ poll: 'admin.devices.listCommands' })
  @ApiEndpoint({
    id: 'admin.devices.sendCommand',
    summary: 'Send a command to a gateway',
    description:
      'Operator commands plus `set_log_level` and `ota_apply` (rollouts normally send it), published after commit and re-sent until acknowledged (D-131). Audited.',
    implements: ['D-131'],
  })
  @ApiJsonBody(AdminCommandCreateDto, { type: 'set_log_level', args: { level: 'debug' } })
  @ApiSuccess(202, { description: 'Queued', type: DeviceCommandDto, example: COMMAND_EXAMPLE })
  @ApiStandardErrors(
    'command.not_allowed',
    'device.not_gateway',
    'device.invalid_state',
    'http.not_found',
    'validation.failed',
    'http.bad_request',
  )
  async sendCommand(
    @Param('deviceId', ParseUUIDPipe) id: string,
    @Body() body: AdminCommandCreateDto,
  ): Promise<DeviceCommandDto> {
    return commandDto(await this.commands.issueAsPlatform(id, body.type, body.args));
  }
}

// --------------------------------------------------------------------------------------------- OTA

@ApiTags('admin.ota')
@ApiSurface(SURFACES.admin)
@Controller('admin/ota')
export class AdminOtaController {
  constructor(private readonly ota: OtaService) {}

  @Get('releases')
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.listReleases',
    summary: 'OTA releases',
    description: 'Signed agent releases per version and architecture, newest first (D-131).',
    implements: ['D-131'],
  })
  @ApiSuccess(200, { description: 'Releases', type: [OtaReleaseDto], example: [RELEASE_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async listReleases(): Promise<OtaReleaseDto[]> {
    return (await this.ota.listReleases()).map(releaseDto);
  }

  @Post('releases')
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.createRelease',
    summary: 'Register a signed release',
    description:
      'The manifest produced by `getproperty-edge` (`pnpm image`); its ed25519 signature must verify against a trusted key (`OTA_SIGNING_PUBLIC_KEYS`) — the agent verifies it again before applying (D-131, edge CR-011). One release per version × architecture. An artefact URL on the device surface (`…/v1/device/ota/artifacts/<version>/<file>`, D-231) must carry the manifest version and its object `releases/edge/<version>/<file>` must already be in the product bucket with the signed size (`ota.artifact_missing`). Audited.',
    implements: ['D-131'],
  })
  @ApiJsonBody(OtaReleaseCreateDto, { manifest: MANIFEST_EXAMPLE, notes: 'Modbus timeouts fixed' })
  @ApiSuccess(201, { description: 'Registered', type: OtaReleaseDto, example: RELEASE_EXAMPLE })
  @ApiStandardErrors(
    'ota.signature_invalid',
    'ota.release_exists',
    'ota.artifact_missing',
    'validation.failed',
    'http.bad_request',
  )
  async createRelease(@Body() body: OtaReleaseCreateDto): Promise<OtaReleaseDto> {
    return releaseDto(await this.ota.createRelease(body.manifest, body.notes ?? null));
  }

  @Get('rollouts')
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.listRollouts',
    summary: 'OTA rollouts',
    description: 'Rollouts with per-gateway progress and next actions (D-131).',
    implements: ['D-131'],
  })
  @ApiSuccess(200, { description: 'Rollouts', type: [OtaRolloutDto], example: [ROLLOUT_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async listRollouts(): Promise<OtaRolloutDto[]> {
    return (await this.ota.listRollouts()).map(rolloutDto);
  }

  @Post('releases/:releaseId/rollouts')
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.createRollout',
    summary: 'Plan a rollout to a ring',
    description:
      'Ring by ring: `pilot` needs a completed `canary` rollout of the release, `all` a completed `pilot` (`ota.ring_order`). The rollout pauses itself when failures exceed `maxFailuresPct` (D-131). Audited.',
    implements: ['D-131'],
  })
  @ApiJsonBody(OtaRolloutCreateDto, { ring: 'canary', maxFailuresPct: '10' })
  @ApiSuccess(201, {
    description: 'Planned',
    type: OtaRolloutDto,
    example: {
      ...ROLLOUT_EXAMPLE,
      status: 'planned',
      startedAt: null,
      counts: {},
      devices: [],
      nextActions: ['start', 'abort'],
    },
  })
  @ApiStandardErrors('ota.ring_order', 'ota.invalid_transition', 'http.not_found', 'validation.failed')
  async createRollout(
    @Param('releaseId', ParseUUIDPipe) releaseId: string,
    @Body() body: OtaRolloutCreateDto,
  ): Promise<OtaRolloutDto> {
    return rolloutDto(
      await this.ota.createRollout(releaseId, {
        ring: body.ring,
        maxFailuresPct: body.maxFailuresPct,
        notes: body.notes ?? null,
      }),
    );
  }

  @Get('rollouts/:rolloutId')
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.getRollout',
    summary: 'One rollout',
    description:
      'Per-gateway status (queued → commanded → started → applied / failed / rolled back) (D-131).',
    implements: ['D-131'],
  })
  @ApiSuccess(200, { description: 'Rollout', type: OtaRolloutDto, example: ROLLOUT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async getRollout(@Param('rolloutId', ParseUUIDPipe) id: string): Promise<OtaRolloutDto> {
    return rolloutDto(await this.ota.getRollout(id));
  }

  @Post('rollouts/:rolloutId/actions/start')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.startRollout',
    summary: 'Start a rollout',
    description:
      'Targets the gateways of the ring (and the rings before it) with the release’s architecture that do not run it yet and sends each an `ota_apply` command whose manifest URL is `GET /v1/device/ota/manifest?releaseId=` (D-131). Audited.',
    implements: ['D-131'],
  })
  @ApiSuccess(200, { description: 'Running', type: OtaRolloutDto, example: ROLLOUT_EXAMPLE })
  @ApiStandardErrors('ota.invalid_transition', 'http.not_found', 'validation.failed')
  async start(@Param('rolloutId', ParseUUIDPipe) id: string): Promise<OtaRolloutDto> {
    return rolloutDto(await this.ota.transition(id, 'start'));
  }

  @Post('rollouts/:rolloutId/actions/pause')
  @HttpCode(200)
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.pauseRollout',
    summary: 'Pause a rollout',
    description: 'No further `ota_apply` commands; gateways already updating finish (D-131). Audited.',
    implements: ['D-131'],
  })
  @ApiSuccess(200, {
    description: 'Paused',
    type: OtaRolloutDto,
    example: { ...ROLLOUT_EXAMPLE, status: 'paused', nextActions: ['resume', 'abort'] },
  })
  @ApiStandardErrors('ota.invalid_transition', 'http.not_found', 'validation.failed')
  async pause(@Param('rolloutId', ParseUUIDPipe) id: string): Promise<OtaRolloutDto> {
    return rolloutDto(await this.ota.transition(id, 'pause'));
  }

  @Post('rollouts/:rolloutId/actions/resume')
  @HttpCode(200)
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.resumeRollout',
    summary: 'Resume a rollout',
    description: 'Sends `ota_apply` to the gateways still queued (D-131). Audited.',
    implements: ['D-131'],
  })
  @ApiSuccess(200, { description: 'Running', type: OtaRolloutDto, example: ROLLOUT_EXAMPLE })
  @ApiStandardErrors('ota.invalid_transition', 'http.not_found', 'validation.failed')
  async resume(@Param('rolloutId', ParseUUIDPipe) id: string): Promise<OtaRolloutDto> {
    return rolloutDto(await this.ota.transition(id, 'resume'));
  }

  @Post('rollouts/:rolloutId/actions/abort')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ota.abortRollout',
    summary: 'Abort a rollout',
    description:
      'Stops the rollout for good; gateways keep the version they run (the agent rolls back failed updates itself, D-131). Audited.',
    implements: ['D-131'],
  })
  @ApiSuccess(200, {
    description: 'Aborted',
    type: OtaRolloutDto,
    example: { ...ROLLOUT_EXAMPLE, status: 'aborted', nextActions: [] },
  })
  @ApiStandardErrors('ota.invalid_transition', 'http.not_found', 'validation.failed')
  async abort(@Param('rolloutId', ParseUUIDPipe) id: string): Promise<OtaRolloutDto> {
    return rolloutDto(await this.ota.transition(id, 'abort'));
  }
}

// --------------------------------------------------------------------------------------------- ingest

@ApiTags('admin.ingest')
@ApiSurface(SURFACES.admin)
@Controller('admin/ingest/dead-letters')
export class AdminIngestController {
  constructor(private readonly telemetry: TelemetryMaintenanceService) {}

  @Get()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ingest.listDeadLetters',
    summary: 'Refused ingest payloads',
    description:
      'MQTT and HTTPS-batch payloads the pipeline refused (unknown topic, malformed JSON, invalid payload, unknown gateway, gateway mismatch, batch too large) or could not store after retries (`processing_error`), newest first (D-162). Readings for unbound meters are not dead letters: they are audited and recorded as `unbound_meter` device events.',
    implements: ['D-162', 'D-143'],
  })
  @ApiPaginated(DeadLetterDto, { example: DEAD_LETTER_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: DeadLetterListQuery): Promise<Page<DeadLetterDto>> {
    const { rows, total } = await this.telemetry.listDeadLetters({
      reason: q.reason,
      gatewayDeviceId: q.gatewayDeviceId,
      replayed: q.replayed,
      ...toSkipTake(q),
    });
    return paginated(rows.map(deadLetterDto), total, q);
  }

  @Post(':deadLetterId/actions/replay')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.device.manage')
  @ApiEndpoint({
    id: 'admin.ingest.replay',
    summary: 'Replay a refused payload',
    description:
      'Feeds the payload through the pipeline again (after a fix or a meter binding); duplicates stay harmless (D-143). The outcome is recorded and audited.',
    implements: ['D-162', 'D-143'],
  })
  @ApiSuccess(200, {
    description: 'Replayed',
    type: DeadLetterReplayDto,
    example: {
      deadLetter: { ...DEAD_LETTER_EXAMPLE, replayedAt: FAKE.dateTime, replayOutcome: 'accepted' },
      outcome: 'telemetry',
    },
  })
  @ApiStandardErrors('ingest.not_replayable', 'http.not_found', 'validation.failed')
  async replay(@Param('deadLetterId', ParseUUIDPipe) id: string): Promise<DeadLetterReplayDto> {
    const r = await this.telemetry.replayDeadLetter(id);
    return { deadLetter: deadLetterDto(r.deadLetter), outcome: r.outcome.status };
  }
}

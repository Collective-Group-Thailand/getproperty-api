import { DomainException } from '@common/errors/domain.exception';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { DeviceIdentityService } from '@core/devices/device-identity.service';
import { GatewayConfigService } from '@modules/smart-devices/gateway-config.service';
import { OtaService } from '@modules/smart-devices/ota.service';
import { IngestPipeline } from '@modules/smart-ingest/ingest-pipeline.service';
import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import {
  OtaManifestDto,
  OtaManifestQuery,
  ReadingsBatchDto,
  ReadingsBatchResultDto,
} from '../shared/smart.dto';
import { ApiSurface, SURFACES } from '../surfaces';

const CONFIG_EXAMPLE = {
  buses: [{ baud: 9600, device: '/dev/ttyUSB0', id: 'rs485-1', parity: 'none', type: 'modbus_rtu' }],
  heartbeatS: 60,
  meters: [
    {
      address: 12,
      bus: 'rs485-1',
      driver: 'sdm120',
      meterId: FAKE.meterId,
      registerMap: 'driver_default',
      roomCode: FAKE.unitCode,
      scale: '1',
      unit: 'kwh',
    },
  ],
  pollIntervalS: 900,
  version: 2,
};

@ApiTags('device.config')
@ApiSurface(SURFACES.device)
@Controller('device/config')
export class DeviceConfigController {
  constructor(
    private readonly identity: DeviceIdentityService,
    private readonly configs: GatewayConfigService,
  ) {}

  @Get()
  @ApiEndpoint({
    id: 'device.config.get',
    summary: 'My compiled configuration',
    description:
      'The latest compiled `GatewayConfig` of the calling gateway (device JWT, mTLS certificate of the same gateway when presented) — the same document published retained on `gp/v1/{gatewayId}/config`, for a cold start without MQTT. Shape: `GatewayConfig` of `contract/device-protocol.json` (D-131).',
    implements: ['D-131', 'D-130'],
  })
  @ApiResponse({
    status: 200,
    description: 'The protocol `GatewayConfig` document',
    content: {
      'application/json': { schema: { type: 'object', additionalProperties: true }, example: CONFIG_EXAMPLE },
    },
  })
  @ApiStandardErrors('device.certificate_invalid', 'http.not_found')
  async get(@Req() req: Request): Promise<Record<string, unknown>> {
    const device = await this.identity.currentDevice();
    await this.identity.assertCertificateOf(req, device.id);
    if (device.kind !== 'gateway') throw new DomainException('device.not_gateway');
    const config = await this.configs.current(device.id);
    if (!config) throw new DomainException('http.not_found');
    return config.document as Record<string, unknown>;
  }
}

@ApiTags('device.ota')
@ApiSurface(SURFACES.device)
@Controller('device/ota')
export class DeviceOtaController {
  constructor(
    private readonly identity: DeviceIdentityService,
    private readonly ota: OtaService,
  ) {}

  @Get('manifest')
  @ApiEndpoint({
    id: 'device.ota.manifest',
    summary: 'The signed OTA manifest',
    description:
      'The manifest of `releaseId` (the `ota_apply` URL) or of the latest rollout targeting the calling gateway, for its architecture only; the agent verifies the ed25519 signature with its baked-in keys before downloading (edge CR-011, D-131).',
    implements: ['D-131'],
  })
  @ApiSuccess(200, {
    description: 'Manifest',
    type: OtaManifestDto,
    example: {
      schema: 1,
      version: '0.4.0',
      channel: 'stable',
      arch: 'arm64',
      artifact: {
        url: 'https://releases.getproperty.co/edge/0.4.0/arm64.tar.zst',
        sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        size: 48211234,
      },
      minAgentVersion: '0.3.0',
      releasedAt: '2026-10-15T09:00:00Z',
      signature: { alg: 'ed25519', keyId: 'gp-ota-2026', value: 'bWFkZS11cC1zaWduYXR1cmU=' },
    },
  })
  @ApiStandardErrors('device.certificate_invalid', 'http.not_found', 'validation.failed')
  async manifest(@Req() req: Request, @Query() q: OtaManifestQuery): Promise<OtaManifestDto> {
    const device = await this.identity.currentDevice();
    await this.identity.assertCertificateOf(req, device.id);
    return (await this.ota.manifestFor(device.id, q.releaseId)) as unknown as OtaManifestDto;
  }
}

@ApiTags('device.readings')
@ApiSurface(SURFACES.device)
@Controller('device/readings')
export class DeviceReadingsController {
  constructor(
    private readonly identity: DeviceIdentityService,
    private readonly pipeline: IngestPipeline,
  ) {}

  @Post('batch')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'device.readings.batch',
    summary: 'Upload buffered readings over HTTPS',
    description:
      'Fallback when MQTT is unavailable (api-conventions §7): the body is a protocol `TelemetryBatch` of the calling gateway and goes through the same pipeline as MQTT — authorisation per meter channel, dedup on `(meterId, seq)` (D-143), monthly partitions (D-162). Replays are harmless; an `Idempotency-Key` header is accepted and ignored (edge CR-009). Any 2xx means the readings are durable.',
    implements: ['D-143', 'D-162', 'D-030'],
  })
  @ApiJsonBody(ReadingsBatchDto, {
    gatewayId: FAKE.gatewayId,
    configVersion: 2,
    sentAt: '2026-11-01T00:15:03+07:00',
    readings: [
      {
        meterId: FAKE.meterId,
        seq: 1042,
        readAt: FAKE.dateTime,
        register: '12345.678',
        unit: 'kwh',
        quality: 'good',
      },
    ],
  })
  @ApiSuccess(200, {
    description: 'Stored',
    type: ReadingsBatchResultDto,
    example: { accepted: 1, duplicates: 0, rejected: [] },
  })
  @ApiStandardErrors(
    'device.invalid_payload',
    'device.certificate_invalid',
    'validation.failed',
    'http.bad_request',
    'http.payload_too_large',
  )
  async batch(@Req() req: Request, @Body() body: ReadingsBatchDto): Promise<ReadingsBatchResultDto> {
    const device = await this.identity.currentDevice();
    await this.identity.assertCertificateOf(req, device.id);
    const outcome = await this.pipeline.handle(
      `gp/v1/${body.gatewayId}/telemetry`,
      JSON.stringify(body),
      'https_batch',
      device.id,
    );
    if (outcome.status !== 'telemetry')
      throw new DomainException('device.invalid_payload', {
        params: { reason: outcome.status === 'dead_letter' ? outcome.reason : outcome.status },
      });
    return {
      accepted: outcome.result.accepted,
      duplicates: outcome.result.duplicates,
      rejected: outcome.result.rejected.map((r) => ({ meterId: r.meterId, seq: r.seq, reason: r.reason })),
    };
  }
}

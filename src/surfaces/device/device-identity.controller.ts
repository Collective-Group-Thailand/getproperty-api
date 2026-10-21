import { Public } from '@common/auth/auth.decorators';
import { systemTenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { DeviceIdentityService } from '@core/devices/device-identity.service';
import { DocumentsService } from '@core/documents/documents.service';
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import { type Request } from 'express';

import { AUTH_RATE_LIMIT, iso } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  DeviceCertificateDto,
  DeviceCertificateRenewDto,
  DeviceLogPresignDto,
  DeviceLogUploadDto,
  DeviceTokenDto,
} from './device.dto';

const PEM_EXAMPLE = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----';

@ApiTags('device.identity')
@ApiSurface(SURFACES.device)
@Controller('device')
export class DeviceIdentityController {
  constructor(private readonly identity: DeviceIdentityService) {}

  @Post('token')
  @HttpCode(200)
  @Public()
  @Throttle({ default: { limit: AUTH_RATE_LIMIT, ttl: seconds(60) } })
  @ApiEndpoint({
    id: 'device.token.create',
    summary: 'Mint a device JWT from the mTLS client certificate',
    description:
      'Authenticated by the gateway’s client certificate alone (mTLS, no bearer): a certificate issued by the platform device CA, not revoked, within its validity, of a gateway that is not retired → a short-lived JWT (`aud=device`, `DEVICE_ACCESS_TOKEN_TTL_SECONDS`) in the gateway’s current session family. The agent refreshes one minute before `expiresAt` and never stores the token (CR-002, D-130, D-165). The answer also carries the gateway’s **current** MQTT endpoints (`mqtt { url, wsUrl? }`, edge CR-015, D-249): `wsUrl` is present only while the platform admin has this gateway’s WebSocket fallback on (D-239) and the platform publishes one — so switching the fallback on or off reaches an already-provisioned gateway at its next refresh, without a new provisioning code or a site visit. Additive within device protocol 1.2.',
    implements: ['D-130', 'D-165', 'D-239', 'D-249'],
  })
  @ApiSuccess(200, {
    description: 'Token and current MQTT endpoints',
    type: DeviceTokenDto,
    example: {
      accessToken: 'eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJkZXZpY2UifQ.c2lnbmF0dXJl',
      expiresAt: '2026-11-01T01:15:00+07:00',
      mqtt: { url: 'mqtts://mqtt.getproperty.invalid:8883' },
    },
  })
  @ApiStandardErrors('device.certificate_invalid', 'http.bad_request')
  async token(@Req() req: Request): Promise<DeviceTokenDto> {
    const t = await this.identity.token(req);
    return { accessToken: t.accessToken, expiresAt: iso(t.expiresAt), mqtt: t.mqtt };
  }

  @Post('certificate/renew')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'device.certificate.renew',
    summary: 'Renew the gateway certificate',
    description:
      'mTLS + device bearer: signs a CSR for a **new** key (`CN=gw-<gatewayId>`) with the platform CA; the old certificate stays valid until it expires and the agent reconnects MQTT with the new one. Due 11 months after `notBefore` or 30 days before `notAfter` (device protocol §1, CR-003). A certificate presented on the call must belong to the same gateway.',
    implements: ['D-130', 'D-165'],
  })
  @ApiJsonBody(DeviceCertificateRenewDto, {
    csrPem:
      '-----BEGIN CERTIFICATE REQUEST-----\nMIIBCzCBsgIBADAuMSwwKgYDVQQDDCNndy0zYjI0MTEwMS1lMmJiLTQyNTUtOGNhZi00MTM2YzU2NmE5NjI=\n-----END CERTIFICATE REQUEST-----',
  })
  @ApiSuccess(200, {
    description: 'New certificate',
    type: DeviceCertificateDto,
    example: { certificatePem: PEM_EXAMPLE, caChainPem: PEM_EXAMPLE, notAfter: '2027-11-01T00:15:00+07:00' },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'device.csr_invalid',
    'device.certificate_invalid',
  )
  async renew(@Req() req: Request, @Body() body: DeviceCertificateRenewDto): Promise<DeviceCertificateDto> {
    const r = await this.identity.renew(req, body.csrPem);
    return { certificatePem: r.certificatePem, caChainPem: r.caChainPem, notAfter: iso(r.notAfter) };
  }
}

@ApiTags('device.logs')
@ApiSurface(SURFACES.device)
@Controller('device/logs')
export class DeviceLogsController {
  constructor(
    private readonly identity: DeviceIdentityService,
    private readonly documents: DocumentsService,
  ) {}

  @Post('presign')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'device.logs.presign',
    summary: 'Presign a log bundle upload',
    description:
      'For the `upload_logs` command (device protocol §2): the gateway declares a gzip bundle (journal of the last hours + in-memory log ring, never secrets) with its size and SHA-256 and receives a short-lived PUT URL; the bundle becomes a `core.document` (kind `log_bundle`) of the gateway’s building, scanned like every upload. The agent then acks the command with `{ bytes, sha256 }` (CR-004, D-131).',
    implements: ['D-131', 'D-130'],
  })
  @ApiJsonBody(DeviceLogPresignDto, {
    contentType: 'application/gzip',
    sizeBytes: 18234,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  })
  @ApiSuccess(200, {
    description: 'Upload URL',
    type: DeviceLogUploadDto,
    example: {
      fileId: FAKE.uuid,
      uploadUrl: 'https://storage.example.com/getproperty/t/x/log_bundle/2026/11/y?X-Amz-Signature=abc',
      method: 'PUT',
      headers: { 'Content-Type': 'application/gzip' },
      expiresAt: '2026-11-01T00:30:00+07:00',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'device.certificate_invalid')
  async presign(@Req() req: Request, @Body() body: DeviceLogPresignDto): Promise<DeviceLogUploadDto> {
    const device = await this.identity.currentDevice();
    await this.identity.assertCertificateOf(req, device.id);
    const r = await this.documents.presign(systemTenantContext(device.tenantId), {
      kind: 'log_bundle',
      scopeType: 'building',
      scopeId: device.buildingId,
      fileName: `logs-${device.serial}.tar.gz`,
      mimeType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      title: `Gateway logs ${device.serial}`,
    });
    return {
      fileId: r.document.id,
      uploadUrl: r.uploadUrl ?? '',
      method: 'PUT',
      headers: r.headers,
      expiresAt: iso(r.expiresAt),
    };
  }
}

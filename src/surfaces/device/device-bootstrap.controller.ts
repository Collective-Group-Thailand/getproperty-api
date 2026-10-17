import { Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { DeviceBootstrapService } from '@core/devices/device-bootstrap.service';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';

import { SubjectType, TOKEN_PAIR_EXAMPLE, TokenAudience } from '../shared/auth.dto';
import { AUTH_RATE_LIMIT, iso } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { DeviceBootstrapDto, DeviceBootstrapRequestDto, MqttAclAction } from './device.dto';

@ApiTags('device.bootstrap')
@ApiSurface(SURFACES.device)
@Controller('device')
export class DeviceBootstrapController {
  constructor(private readonly bootstrap: DeviceBootstrapService) {}

  @Post('bootstrap')
  @HttpCode(201)
  @Public()
  @Throttle({ default: { limit: AUTH_RATE_LIMIT, ttl: seconds(60) } })
  @ApiEndpoint({
    id: 'device.bootstrap.create',
    summary: 'Bootstrap a gateway: certificate, device JWT and broker ACL',
    description:
      'The gateway sends the one-time provisioning code from its QR (the serial is optional), a CSR (`CN=gw-provisioning` — the CA sets `CN=gw-<gatewayId>`), its agent version and hardware; the platform CA signs a client certificate (12 months, clientAuth), the EMQX ACL rows are written (publish `gp/v1/<id>/+` and `…/cmd/ack`, subscribe `…/config` and `…/cmd`), and a device session starts (JWT `aud=device` + refresh token, also as `deviceToken`). A second bootstrap of the same gateway revokes the previous certificate, ACL and sessions. Not idempotent by key: the code is single-use (second use → 401 `device.provisioning_code_invalid`); a lost response needs a new code (D-130, D-165, device protocol §1).',
    implements: ['D-033', 'D-130', 'ADR-0003'],
  })
  @ApiJsonBody(DeviceBootstrapRequestDto, {
    provisioningCode: 'ABCD-EFGH-JKLM-NPQR',
    agentVersion: '0.1.0',
    hardware: { arch: 'arm64', hostname: 'gw-pilot-01', serial: '10000000abcdef01' },
    csrPem:
      '-----BEGIN CERTIFICATE REQUEST-----\nMIIBCzCBsgIBADAuMSwwKgYDVQQDDCNndy0zYjI0MTEwMS1lMmJiLTQyNTUtOGNhZi00MTM2YzU2NmE5NjI=\n-----END CERTIFICATE REQUEST-----',
  })
  @ApiSuccess(201, {
    description: 'Provisioned',
    type: DeviceBootstrapDto,
    example: {
      ...TOKEN_PAIR_EXAMPLE,
      subject: {
        id: FAKE.gatewayId,
        type: SubjectType.Device,
        audience: TokenAudience.Device,
        roles: [],
        permissions: [],
        scopes: [`device:${FAKE.gatewayId}`, `tenant:${FAKE.tenantId}`, `building:${FAKE.buildingId}`],
      },
      deviceId: FAKE.gatewayId,
      gatewayId: FAKE.gatewayId,
      tenantId: FAKE.tenantId,
      buildingId: FAKE.buildingId,
      caChainPem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
      deviceToken: {
        accessToken: TOKEN_PAIR_EXAMPLE.accessToken,
        expiresAt: TOKEN_PAIR_EXAMPLE.accessTokenExpiresAt,
      },
      certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
      caCertificatePem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
      certificateSerial: '01a1b2c3d4e5f60718293a4b5c6d7e8f',
      certificateNotAfter: '2027-11-01T00:15:00+07:00',
      mqtt: {
        url: 'mqtts://mqtt.getproperty.invalid:8883',
        wsUrl: 'wss://mqtt.getproperty.invalid/mqtt',
        clientId: `gw-${FAKE.gatewayId}`,
        username: `gw-${FAKE.gatewayId}`,
        acl: [
          { action: MqttAclAction.Publish, topic: `gp/v1/${FAKE.gatewayId}/+` },
          { action: MqttAclAction.Publish, topic: `gp/v1/${FAKE.gatewayId}/cmd/ack` },
          { action: MqttAclAction.Subscribe, topic: `gp/v1/${FAKE.gatewayId}/config` },
          { action: MqttAclAction.Subscribe, topic: `gp/v1/${FAKE.gatewayId}/cmd` },
        ],
      },
    } satisfies DeviceBootstrapDto,
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'device.provisioning_code_invalid',
    'device.csr_invalid',
  )
  async create(@Body() body: DeviceBootstrapRequestDto): Promise<DeviceBootstrapDto> {
    const r = await this.bootstrap.bootstrap(body);
    return {
      accessToken: r.accessToken,
      accessTokenExpiresAt: iso(r.accessTokenExpiresAt),
      refreshToken: r.refreshToken,
      refreshTokenExpiresAt: iso(r.refreshTokenExpiresAt),
      subject: {
        id: r.subject.id,
        type: SubjectType.Device,
        audience: TokenAudience.Device,
        roles: [],
        permissions: [],
        scopes: r.subject.scopes,
      },
      deviceId: r.deviceId,
      gatewayId: r.deviceId,
      tenantId: r.tenantId,
      buildingId: r.buildingId,
      caChainPem: r.caChainPem,
      deviceToken: { accessToken: r.accessToken, expiresAt: iso(r.accessTokenExpiresAt) },
      certificatePem: r.certificatePem,
      caCertificatePem: r.caCertificatePem,
      certificateSerial: r.certificateSerial,
      certificateNotAfter: iso(r.certificateNotAfter),
      mqtt: {
        ...r.mqtt,
        acl: r.mqtt.acl.map((a) => ({ action: a.action as MqttAclAction, topic: a.topic })),
      },
    };
  }
}

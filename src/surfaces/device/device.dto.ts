import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { TokenPairDto } from '../shared/auth.dto';

export enum MqttAclAction {
  Publish = 'publish',
  Subscribe = 'subscribe',
}

export class DeviceHardwareDto {
  @ApiPropertyOptional({
    example: 'arm64',
    description: 'CPU architecture of the agent build (OTA manifests).',
  })
  @IsOptional()
  @IsIn(['arm64', 'x64', 'armv7'])
  arch?: string;

  @ApiPropertyOptional({ example: 'gw-pilot-01' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  hostname?: string;

  @ApiPropertyOptional({ example: '10000000abcdef01', description: 'Board serial (e.g. the CM4 serial).' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  serial?: string;
}

export class DeviceBootstrapRequestDto {
  @ApiPropertyOptional({
    example: 'GW-TEST-000001',
    description:
      'Gateway serial printed on the device label. Optional (CR-001): the single-use code identifies the gateway; when sent it must match.',
  })
  @IsOptional()
  @IsString()
  @Length(3, 64)
  serial?: string;

  @ApiProperty({
    example: 'ABCD-EFGH-JKLM-NPQR',
    description: 'One-time provisioning code from the gateway QR (D-033): groups of 4 characters.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){2,4}$/)
  provisioningCode!: string;

  @ApiProperty({
    example:
      '-----BEGIN CERTIFICATE REQUEST-----\nMIIBCzCBsgIBADAuMSwwKgYDVQQDDCNndy0zYjI0MTEwMS1lMmJiLTQyNTUtOGNhZi00MTM2YzU2NmE5NjI=\n-----END CERTIFICATE REQUEST-----',
    description:
      'PEM PKCS#10 request, subject `CN=gw-provisioning` (the CA sets `CN=gw-<gatewayId>`) or already `CN=gw-<gatewayId>`; EC P-256/P-384 or RSA ≥ 2048 key generated on the gateway.',
  })
  @IsString()
  @Length(100, 16000)
  csrPem!: string;

  @ApiPropertyOptional({
    example: '0.1.0',
    description: 'Agent version (semver), stored as the gateway firmware.',
  })
  @IsOptional()
  @Matches(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  agentVersion?: string;

  @ApiPropertyOptional({ type: () => DeviceHardwareDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceHardwareDto)
  hardware?: DeviceHardwareDto;
}

export class MqttAclEntryDto {
  @ApiProperty({ enum: MqttAclAction, enumName: 'MqttAclAction', example: MqttAclAction.Publish })
  action!: MqttAclAction;

  @ApiProperty({ example: `gp/v1/${FAKE.gatewayId}/telemetry` })
  topic!: string;
}

/** What the gateway sends as the MQTT password (device protocol 1.2, D-235). */
export enum MqttPasswordMode {
  DeviceJwt = 'device_jwt',
}

export class MqttConnectionDto {
  @ApiProperty({ example: 'mqtts://mqtt.getproperty.invalid:8883' })
  url!: string;

  @ApiPropertyOptional({
    example: 'wss://mqtt.getproperty.invalid/mqtt',
    description:
      'WebSocket fallback for buildings whose network blocks 8883 (device protocol §1, D-239 — O-012 resolved): EMQX ws 8083 behind Caddy, authenticated by the device JWT **alone** (no client certificate on that path). **Omitted** unless the platform admin enabled the fallback for this gateway (`POST /v1/admin/devices/{deviceId}/actions/set-mqtt-transport`) and the platform publishes it (`MQTT_PUBLIC_WS_URL`); off by default (D-231, edge CR-013).',
  })
  wsUrl?: string;

  @ApiProperty({ example: `gw-${FAKE.gatewayId}` })
  clientId!: string;

  @ApiProperty({
    example: `gw-${FAKE.gatewayId}`,
    description: 'Broker username = client id = certificate CN (`gw-<gatewayId>`).',
  })
  username!: string;

  @ApiProperty({
    enum: MqttPasswordMode,
    enumName: 'MqttPasswordMode',
    example: MqttPasswordMode.DeviceJwt,
    description:
      'Device protocol 1.2 (D-235): the MQTT password is a fresh device JWT (`POST /v1/device/token`, ≤ 1 h) fetched before every (re)connect. Required on the WebSocket fallback; on 8883 required while the platform setting `mqtt.authn.require_device_jwt` is on (default), otherwise the certificate alone is accepted.',
  })
  password!: MqttPasswordMode;

  @ApiProperty({ type: () => [MqttAclEntryDto] })
  acl!: MqttAclEntryDto[];
}

export class DeviceAccessTokenDto {
  @ApiProperty({
    example: 'eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJkZXZpY2UifQ.c2lnbmF0dXJl',
    description: 'Device JWT (`aud=device`).',
  })
  accessToken!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T01:15:00+07:00' })
  expiresAt!: string;
}

export class DeviceBootstrapDto extends TokenPairDto {
  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  deviceId!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.gatewayId,
    description: 'Same as `deviceId` (edge naming, CR-001).',
  })
  gatewayId!: string;

  @ApiProperty({
    example: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
    description: 'Trust chain of the device CA — also the anchor of the broker certificate.',
  })
  caChainPem!: string;

  @ApiProperty({
    type: () => DeviceAccessTokenDto,
    description: 'The access token again, in the agent’s shape.',
  })
  deviceToken!: DeviceAccessTokenDto;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----' })
  certificatePem!: string;

  @ApiProperty({
    example: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
    description: 'Platform device CA.',
  })
  caCertificatePem!: string;

  @ApiProperty({ example: '01a1b2c3d4e5f60718293a4b5c6d7e8f' })
  certificateSerial!: string;

  @ApiProperty({ format: 'date-time', example: '2027-11-01T00:15:00+07:00' })
  certificateNotAfter!: string;

  @ApiProperty({ type: () => MqttConnectionDto })
  mqtt!: MqttConnectionDto;
}

export class DeviceCertificateRenewDto {
  @ApiProperty({
    example:
      '-----BEGIN CERTIFICATE REQUEST-----\nMIIBCzCBsgIBADAuMSwwKgYDVQQDDCNndy0zYjI0MTEwMS1lMmJiLTQyNTUtOGNhZi00MTM2YzU2NmE5NjI=\n-----END CERTIFICATE REQUEST-----',
    description: 'PEM PKCS#10 request for a **new** key, `CN=gw-<gatewayId>`.',
  })
  @IsString()
  @Length(100, 16000)
  csrPem!: string;
}

export class DeviceCertificateDto {
  @ApiProperty({ example: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----' })
  certificatePem!: string;

  @ApiProperty({ example: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----' })
  caChainPem!: string;

  @ApiProperty({ format: 'date-time', example: '2027-11-01T00:15:00+07:00' })
  notAfter!: string;
}

export class DeviceLogPresignDto {
  @ApiProperty({ example: 'application/gzip', description: 'Log bundles are gzip archives.' })
  @IsIn(['application/gzip'])
  contentType!: string;

  @ApiProperty({ example: 18234, description: 'Bytes, at most 50 MB.' })
  @IsInt()
  @Min(1)
  @Max(50_000_000)
  sizeBytes!: number;

  @ApiProperty({ example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' })
  @Matches(/^[0-9a-f]{64}$/i)
  sha256!: string;
}

export class DeviceLogUploadDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The `core.document` the bundle becomes.' })
  fileId!: string;

  @ApiProperty({ example: 'https://storage.example.com/getproperty/t/…/log_bundle/…?X-Amz-Signature=abc' })
  uploadUrl!: string;

  @ApiProperty({ example: 'PUT' })
  method!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'Content-Type': 'application/gzip' },
    description: 'Headers the PUT must carry exactly.',
  })
  headers!: Record<string, string>;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:30:00+07:00' })
  expiresAt!: string;
}

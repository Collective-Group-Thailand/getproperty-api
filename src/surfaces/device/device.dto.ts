import { FAKE } from '@common/openapi/examples';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

import { TokenPairDto } from '../shared/auth.dto';

export enum MqttAclAction {
  Publish = 'publish',
  Subscribe = 'subscribe',
}

export class DeviceBootstrapRequestDto {
  @ApiProperty({ example: 'GW-TEST-000001', description: 'Gateway serial printed on the device label.' })
  @IsString()
  @Length(3, 64)
  serial!: string;

  @ApiProperty({
    example: 'ABCD-EFGH-JKLM-NPQR',
    description: 'One-time provisioning code from the gateway QR (D-033).',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/)
  provisioningCode!: string;

  @ApiProperty({
    example:
      '-----BEGIN CERTIFICATE REQUEST-----\nMIIBCzCBsgIBADAuMSwwKgYDVQQDDCNndy0zYjI0MTEwMS1lMmJiLTQyNTUtOGNhZi00MTM2YzU2NmE5NjI=\n-----END CERTIFICATE REQUEST-----',
    description:
      'PEM PKCS#10 request with `CN=gw-<deviceId>`; EC P-256/P-384 or RSA ≥ 2048 key generated on the gateway.',
  })
  @IsString()
  @Length(100, 16000)
  csrPem!: string;
}

export class MqttAclEntryDto {
  @ApiProperty({ enum: MqttAclAction, enumName: 'MqttAclAction', example: MqttAclAction.Publish })
  action!: MqttAclAction;

  @ApiProperty({ example: `gp/v1/${FAKE.gatewayId}/+` })
  topic!: string;
}

export class MqttConnectionDto {
  @ApiProperty({ example: 'mqtts://mqtt.getproperty.invalid:8883' })
  url!: string;

  @ApiProperty({ example: `gw-${FAKE.gatewayId}` })
  clientId!: string;

  @ApiProperty({
    example: `gw-${FAKE.gatewayId}`,
    description: 'Broker username = certificate CN (EMQX ACL key).',
  })
  username!: string;

  @ApiProperty({ type: () => [MqttAclEntryDto] })
  acl!: MqttAclEntryDto[];
}

export class DeviceBootstrapDto extends TokenPairDto {
  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  deviceId!: string;

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

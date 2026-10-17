import { FAKE } from '@common/openapi/examples';
import { ApiProperty } from '@nestjs/swagger';

import { MeterDto, UtilityName } from '../owner/assets.dto';
import { BusTypeName } from '../shared/smart.dto';

export class StaffBuildingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  id!: string;

  @ApiProperty({ example: 'A' })
  code!: string;

  @ApiProperty({ example: 'อาคาร A' })
  name!: string;

  @ApiProperty({ type: 'integer', nullable: true, example: 6 })
  floorsCount!: number | null;

  @ApiProperty({ type: 'integer', example: 60 })
  unitCount!: number;
}

export class StaffBuildingsDto {
  @ApiProperty({ type: () => [StaffBuildingDto] })
  data!: StaffBuildingDto[];
}

export class MeterPointChannelDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'smart.meter_channel id (open binding).' })
  channelId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  gatewayDeviceId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  meterDeviceId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'SDM120-0042' })
  meterDeviceSerial!: string | null;

  @ApiProperty({ example: 'rs485-1' })
  busId!: string;

  @ApiProperty({ enum: BusTypeName, enumName: 'BusType', example: BusTypeName.ModbusRtu })
  busType!: BusTypeName;

  @ApiProperty({ type: 'integer', nullable: true, example: 11, description: 'Modbus slave address.' })
  address!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: null, description: 'GPIO pin (pulse meters).' })
  pin!: number | null;

  @ApiProperty({ example: 'eastron_sdm120', description: 'Edge driver key.' })
  driver!: string;
}

export class StaffMeterPointDto extends MeterDto {
  @ApiProperty({ type: String, nullable: true, example: 'ชั้น 2' })
  floorName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '12345.678',
    description: 'Last accepted register (kWh / m³), estimates excluded; decimal string.',
  })
  lastRegister!: string | null;

  @ApiProperty({
    type: () => MeterPointChannelDto,
    nullable: true,
    description: 'The open gateway channel when the meter is read by IoT; null for a manual (Lite) meter.',
  })
  channel!: MeterPointChannelDto | null;
}

export class StaffMeterPointsDto {
  @ApiProperty({ type: () => [StaffMeterPointDto] })
  data!: StaffMeterPointDto[];
}

export class MeterDriverDto {
  @ApiProperty({ example: 'eastron_sdm120', description: 'Edge driver key (`MeterConfig.driver`).' })
  key!: string;

  @ApiProperty({ enum: BusTypeName, enumName: 'BusType', example: BusTypeName.ModbusRtu })
  busType!: BusTypeName;

  @ApiProperty({ example: 'Eastron' })
  vendor!: string;

  @ApiProperty({ type: [String], example: ['SDM120-Modbus'] })
  models!: string[];

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;
}

export class MeterDriversDto {
  @ApiProperty({ type: () => [MeterDriverDto] })
  data!: MeterDriverDto[];
}

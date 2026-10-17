import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

import {
  BusParity,
  BusType,
  MeterUnit,
  ModbusFunction,
  RegisterDataType,
  RegisterMap,
  WordOrder,
} from './enums';
import {
  BUS_ID_PATTERN,
  BUS_ID_PATTERN_SOURCE,
  DRIVER_PATTERN,
  DRIVER_PATTERN_SOURCE,
  REGISTER_PATTERN,
  REGISTER_PATTERN_SOURCE,
  SCALE_PATTERN,
  SCALE_PATTERN_SOURCE,
} from './formats';

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;

/** A physical bus of the gateway: an RS485 port (Modbus RTU), the GPIO header (pulse) or a LoRaWAN radio. */
@JSONSchema({
  description: 'One bus of the gateway. `device`, `baud` and `parity` apply to modbus_rtu only.',
})
export class BusConfig {
  @JSONSchema({
    description: 'Bus id referenced by meters, e.g. `rs485-1`, `gpio`',
    pattern: BUS_ID_PATTERN_SOURCE,
  })
  @Matches(BUS_ID_PATTERN)
  id!: string;

  @IsEnum(BusType)
  type!: BusType;

  @JSONSchema({ description: 'Serial device path for modbus_rtu', examples: ['/dev/ttyUSB0'] })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  device?: string;

  @JSONSchema({ description: 'Baud rate for modbus_rtu', enum: [...BAUD_RATES] })
  @IsOptional()
  @IsIn([...BAUD_RATES])
  baud?: number;

  @IsOptional()
  @IsEnum(BusParity)
  parity?: BusParity;
}

/** One Modbus register of a custom register map (CR-005). */
@JSONSchema({ description: 'A Modbus register: address, function, data type, word order and decimal scale.' })
export class RegisterDef {
  @JSONSchema({ description: 'Register address (0-based protocol address)' })
  @IsInt()
  @Min(0)
  @Max(65_535)
  address!: number;

  @IsEnum(ModbusFunction)
  function!: ModbusFunction;

  @IsEnum(RegisterDataType)
  dataType!: RegisterDataType;

  @IsEnum(WordOrder)
  wordOrder!: WordOrder;

  @JSONSchema({
    description: 'Decimal factor applied to the raw value',
    examples: ['0.01'],
    pattern: SCALE_PATTERN_SOURCE,
  })
  @Matches(SCALE_PATTERN)
  scale!: string;
}

/**
 * Register map of a meter model without a built-in driver map (`registerMap = custom`, CR-005). Only `energy` (the
 * cumulative register, D-030) is required; the instant values feed `extra` and are never billed.
 */
@JSONSchema({
  description:
    'Custom Modbus register map (CR-005): `energy` = the cumulative register in kWh after scale; the others are optional instant values for `extra`.',
})
export class CustomRegisterMap {
  @ValidateNested()
  @Type(() => RegisterDef)
  energy!: RegisterDef;

  @IsOptional()
  @ValidateNested()
  @Type(() => RegisterDef)
  voltage?: RegisterDef;

  @IsOptional()
  @ValidateNested()
  @Type(() => RegisterDef)
  current?: RegisterDef;

  @IsOptional()
  @ValidateNested()
  @Type(() => RegisterDef)
  power?: RegisterDef;
}

/** The binding of one meter to a bus and a driver (D-013, D-033, D-131). */
@JSONSchema({
  description:
    'One meter binding. Modbus meters use `address` on an RS485 bus; pulse meters use `pin`, `litresPerPulse` and the ' +
    '`initialRegister` confirmed by staff at install (D-033). No secrets ever appear here (§5).',
})
export class MeterConfig {
  @IsUUID()
  meterId!: string;

  @JSONSchema({
    description: 'Room code the meter serves (display only; the binding is by meterId)',
    examples: ['A-201'],
  })
  @IsString()
  @MaxLength(32)
  roomCode!: string;

  @JSONSchema({
    description: 'Driver name owned by getproperty-edge (D-013)',
    examples: ['eastron_sdm120', 'pulse_counter'],
    pattern: DRIVER_PATTERN_SOURCE,
  })
  @Matches(DRIVER_PATTERN)
  driver!: string;

  @JSONSchema({ description: 'Bus id from `buses`', pattern: BUS_ID_PATTERN_SOURCE })
  @Matches(BUS_ID_PATTERN)
  bus!: string;

  @JSONSchema({ description: 'Modbus slave address (1–247)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(247)
  address?: number;

  @JSONSchema({ description: 'GPIO pin for pulse meters' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(255)
  pin?: number;

  @IsEnum(MeterUnit)
  unit!: MeterUnit;

  @IsOptional()
  @IsEnum(RegisterMap)
  registerMap?: RegisterMap;

  @JSONSchema({ description: 'Present exactly when `registerMap` is `custom` (CR-005)' })
  @ValidateIf((o: MeterConfig) => o.registerMap === RegisterMap.Custom || o.customRegisterMap !== undefined)
  @ValidateNested()
  @Type(() => CustomRegisterMap)
  customRegisterMap?: CustomRegisterMap;

  @JSONSchema({
    description: 'Decimal scale applied to the raw register value',
    examples: ['1'],
    pattern: SCALE_PATTERN_SOURCE,
  })
  @IsOptional()
  @Matches(SCALE_PATTERN)
  scale?: string;

  @JSONSchema({ description: 'Litres per pulse for pulse water meters' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  litresPerPulse?: number;

  @JSONSchema({
    description: 'Register value at install, confirmed by a staff photo reading (D-033)',
    examples: ['1532.040'],
    pattern: REGISTER_PATTERN_SOURCE,
  })
  @IsOptional()
  @Matches(REGISTER_PATTERN)
  initialRegister?: string;
}

/** `gp/v1/<gatewayId>/config`, QoS 1, **retained** (cloud → gateway; device-protocol.md §2, D-131). */
@JSONSchema({
  description:
    'Full gateway configuration pushed by the cloud (retained). Applied atomically; the gateway publishes ' +
    'config_applied with the version, or config_rejected and keeps the previous version.',
})
export class GatewayConfig {
  @JSONSchema({ description: 'Monotonic version; health reports the applied one' })
  @IsInt()
  @Min(1)
  version!: number;

  @JSONSchema({ description: 'Polling interval in seconds (default 900 = 15 min, D-131)' })
  @IsInt()
  @Min(60)
  @Max(86_400)
  pollIntervalS!: number;

  @JSONSchema({ description: 'Heartbeat interval in seconds (default 60, D-034)' })
  @IsInt()
  @Min(10)
  @Max(3_600)
  heartbeatS!: number;

  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => BusConfig)
  buses!: BusConfig[];

  @IsArray()
  @ArrayMaxSize(400)
  @ValidateNested({ each: true })
  @Type(() => MeterConfig)
  meters!: MeterConfig[];
}

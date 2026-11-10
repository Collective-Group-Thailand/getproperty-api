import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

import { GateBarrierState, GateHardwareKind, GateOpenReason } from './enums';

/** Edge channel ids (`relay-1`, `cam:entry`). */
export const GATE_CHANNEL_PATTERN = /^[A-Za-z0-9_.:-]{1,32}$/;
export const GATE_CHANNEL_PATTERN_SOURCE = '^[A-Za-z0-9_.:-]{1,32}$';
/** Seconds a `gate.open` stays valid after `issuedAt` (protocol 1.3, D-328). */
export const GATE_OPEN_TTL_S = 30;

/** `Command.args` of `gate.open` (protocol 1.3, cloud → edge on `gp/v1/<gatewayId>/cmd`, D-328). */
@JSONSchema({
  description:
    'Arguments of the `gate.open` command (1.3): pulse the relay of barrier `deviceId` for `pulseMs`. Idempotent by ' +
    '`commandId` (= `cmdId`; a redelivery never pulses twice); refused after `expiresAt` (ack `failed`, error ' +
    '`expired`). The cloud sends it once and never re-sends it.',
})
export class GateOpenArgs {
  @JSONSchema({ description: 'Same as `Command.cmdId`' })
  @IsUUID()
  commandId!: string;

  @IsUUID()
  gateId!: string;

  @JSONSchema({ description: 'The barrier (`smart.gate_device` id, `GatewayConfig.gateDevices[].deviceId`)' })
  @IsUUID()
  deviceId!: string;

  @IsEnum(GateOpenReason)
  reason!: GateOpenReason;

  @JSONSchema({ description: 'The visit the barrier opens for, when there is one' })
  @IsOptional()
  @IsUUID()
  visitId?: string;

  @JSONSchema({ description: 'Relay pulse length in milliseconds' })
  @IsInt()
  @Min(200)
  @Max(10_000)
  pulseMs!: number;

  @JSONSchema({
    description: '`issuedAt` + 30 s: the edge does not open after this instant',
    examples: ['2026-11-05T18:00:30+07:00'],
  })
  @IsISO8601({ strict: true })
  expiresAt!: string;
}

/** `DeviceEvent.data` of `gate.state` (protocol 1.3, edge → cloud on `gp/v1/<gatewayId>/events`, D-328). */
@JSONSchema({ description: 'Data of a `gate.state` event (1.3): the position a barrier reports.' })
export class GateStateData {
  @IsUUID()
  gateId!: string;

  @JSONSchema({
    description: 'The barrier; required when the gateway drives more than one barrier of the gate',
  })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsEnum(GateBarrierState)
  state!: GateBarrierState;

  @JSONSchema({ description: 'Gateway clock', examples: ['2026-11-05T18:00:02+07:00'] })
  @IsISO8601({ strict: true })
  at!: string;

  @JSONSchema({ description: 'The `gate.open` command this change answers, if any' })
  @IsOptional()
  @IsUUID()
  commandId?: string;
}

/** A plate as read by a camera (protocol 1.3). */
@JSONSchema({
  description:
    'A Thai plate as read: category (1–4 Thai consonants / digits, spaces allowed), number (1–4 digits, Thai or Arabic ' +
    'numerals), province when the camera reads it.',
})
export class PlateReading {
  @IsString()
  @Length(1, 12)
  category!: string;

  @IsString()
  @Length(1, 12)
  number!: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  province?: string;
}

/** `DeviceEvent.data` of `plate.detected` (protocol 1.3, edge → cloud, D-328). */
@JSONSchema({
  description:
    'Data of a `plate.detected` event (1.3). `DeviceEvent.eventId` deduplicates; the same plate at the same gate within ' +
    'gate.lpr.repeat_seconds is ignored. The image stays on the edge (`imageRef` is an opaque reference).',
})
export class PlateDetectedData {
  @IsUUID()
  gateId!: string;

  @JSONSchema({ description: 'The camera; required when the gateway reads more than one camera of the gate' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ValidateNested()
  @Type(() => PlateReading)
  plate!: PlateReading;

  @JSONSchema({ description: 'Recognition confidence 0–1' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(1)
  confidence!: number;

  @JSONSchema({
    description:
      'Read time (gateway clock). Send the camera read time, also for reads queued offline: a read that reaches the ' +
      'cloud more than gate.lpr.max_event_age_seconds (20) after it is kept as a past read only — never an automatic ' +
      'entry or barrier open (D-330, CR-017); so is a read time more than gate.lpr.max_clock_skew_seconds (60) ahead ' +
      'of the cloud clock (gateway clock suspect, D-336) — keep the gateway clock on NTP.',
    examples: ['2026-11-05T18:00:00+07:00'],
  })
  @IsISO8601({ strict: true })
  at!: string;

  @JSONSchema({
    description: 'Opaque edge reference of the snapshot (never a URL with credentials)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  imageRef?: string;
}

/** `GatewayConfig.gateDevices[]` (protocol 1.3, D-328): gate hardware this gateway drives. */
@JSONSchema({ description: 'A barrier relay or LPR camera of a gate driven by this gateway (1.3).' })
export class GateDeviceConfig {
  @IsUUID()
  deviceId!: string;

  @IsUUID()
  gateId!: string;

  @IsEnum(GateHardwareKind)
  kind!: GateHardwareKind;

  @JSONSchema({ description: 'Relay output / camera id on the edge', pattern: GATE_CHANNEL_PATTERN_SOURCE })
  @Matches(GATE_CHANNEL_PATTERN)
  channel!: string;

  @JSONSchema({ description: 'Default pulse (barrier only); `gate.open` carries its own' })
  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(10_000)
  pulseMs?: number;
}

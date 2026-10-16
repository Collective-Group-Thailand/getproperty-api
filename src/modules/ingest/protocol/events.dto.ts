import { IsEnum, IsISO8601, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

import { DeviceEventSeverity, DeviceEventType } from './enums';

/** `gp/v1/<gatewayId>/events`, QoS 1 (device-protocol.md §2). */
@JSONSchema({
  description:
    'Operational event from a gateway on `gp/v1/<gatewayId>/events`: meter_offline, pulse_overflow, config_applied / ' +
    'config_rejected (with the version), ota_*, tamper, power_loss, restart, seq_gap. `eventId` deduplicates redeliveries.',
})
export class DeviceEvent {
  @JSONSchema({ description: 'Gateway-generated uuid; redelivered events carry the same id' })
  @IsUUID()
  eventId!: string;

  @IsUUID()
  gatewayId!: string;

  @IsEnum(DeviceEventType)
  type!: DeviceEventType;

  @IsEnum(DeviceEventSeverity)
  severity!: DeviceEventSeverity;

  @JSONSchema({
    description: 'Gateway clock when the event occurred',
    examples: ['2026-11-01T00:15:00+07:00'],
  })
  @IsISO8601({ strict: true })
  occurredAt!: string;

  @JSONSchema({ description: 'The meter concerned, for meter_offline / pulse_overflow / seq_gap' })
  @IsOptional()
  @IsUUID()
  meterId?: string;

  @JSONSchema({ description: 'Config version for config_applied / config_rejected' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  configVersion?: string;

  @JSONSchema({ description: 'Short human-readable detail (never secrets)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @JSONSchema({
    description: 'Event-specific details (e.g. `{ "fromSeq": 48210, "toSeq": 48213 }` for seq_gap)',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

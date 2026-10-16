import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

import { LinkType, MeterHealthStatus } from './enums';
import { SEMVER_PATTERN, SEMVER_PATTERN_SOURCE } from './formats';

/** Health of one configured meter as seen by the gateway (stale/silent rules run in the cloud, D-034). */
@JSONSchema({
  description: 'Per-meter status inside a Health message: last successful read and the bus result.',
})
export class MeterHealth {
  @IsUUID()
  meterId!: string;

  @JSONSchema({
    description: 'Last successful read, ISO 8601 with offset; null when the meter has never answered',
    type: ['string', 'null'],
    format: 'date-time',
  })
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  lastReadAt!: string | null;

  @IsEnum(MeterHealthStatus)
  status!: MeterHealthStatus;
}

/** `gp/v1/<gatewayId>/health` every 60 s, QoS 1 (device-protocol.md §2; offline after 5 missed, D-034). */
@JSONSchema({
  description:
    'Gateway heartbeat on `gp/v1/<gatewayId>/health` every 60 s. The broker LWT on the same topic is the fixed ' +
    'document `{ "status": "offline_lwt" }`, which is not a Health message and is recognised before validation.',
})
export class Health {
  @IsUUID()
  gatewayId!: string;

  @JSONSchema({ description: 'Agent version (semver)', examples: ['1.4.2'], pattern: SEMVER_PATTERN_SOURCE })
  @Matches(SEMVER_PATTERN)
  agentVersion!: string;

  @JSONSchema({ description: 'Applied GatewayConfig version, so the cloud can detect drift (D-131)' })
  @IsInt()
  @Min(0)
  configVersion!: number;

  @IsInt()
  @Min(0)
  uptimeS!: number;

  @JSONSchema({ description: 'Readings waiting in the on-disk store-and-forward queue' })
  @IsInt()
  @Min(0)
  bufferedReadings!: number;

  @IsInt()
  @Min(0)
  diskFreeMb!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  cpuPct!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  memPct!: number;

  @IsEnum(LinkType)
  link!: LinkType;

  @JSONSchema({
    description: 'Signal strength in dBm for wifi / lte; null on ethernet',
    type: ['integer', 'null'],
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(-150)
  @Max(0)
  rssi!: number | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MeterHealth)
  meters!: MeterHealth[];
}

/** The broker's last-will document on the health topic. */
export const LWT_PAYLOAD = { status: 'offline_lwt' } as const;

export function isLwtPayload(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    (value as { status?: unknown }).status === LWT_PAYLOAD.status
  );
}

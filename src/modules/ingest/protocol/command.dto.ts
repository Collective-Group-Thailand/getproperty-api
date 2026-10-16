import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

import { CommandAckStatus, CommandType } from './enums';

/** `gp/v1/<gatewayId>/cmd`, QoS 1 (cloud → gateway; device-protocol.md §2, §4). */
@JSONSchema({
  description:
    'Command from the cloud: read_now, restart, ota_apply (signed manifest URL in args), upload_logs, set_log_level, ' +
    'identify. Expires after `ttlS` (default 300 s); the gateway acks `accepted` at once and `done`/`failed` on completion.',
})
export class Command {
  @IsUUID()
  cmdId!: string;

  @IsEnum(CommandType)
  type!: CommandType;

  @JSONSchema({
    description:
      'Command arguments, e.g. `{ "meterIds": ["…"] }` for read_now, `{ "manifestUrl": "…" }` for ota_apply',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;

  @JSONSchema({
    description: 'Cloud clock when the command was issued',
    examples: ['2026-11-01T00:15:00+07:00'],
  })
  @IsISO8601({ strict: true })
  issuedAt!: string;

  @JSONSchema({ description: 'Seconds after `issuedAt` the command expires (default 300)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  ttlS?: number;
}

/** `gp/v1/<gatewayId>/cmd/ack`, QoS 1 (gateway → cloud). */
@JSONSchema({ description: 'Acknowledgement of a Command: `accepted` immediately, then `done` or `failed`.' })
export class CommandAck {
  @IsUUID()
  cmdId!: string;

  @IsEnum(CommandAckStatus)
  status!: CommandAckStatus;

  @JSONSchema({ description: 'Command-specific result for `done`', additionalProperties: true })
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;

  @JSONSchema({
    description: 'Error text for `failed`; null otherwise (always present)',
    type: ['string', 'null'],
    maxLength: 500,
  })
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  error!: string | null;

  @JSONSchema({
    description: 'Gateway clock when the command finished (done / failed)',
    examples: ['2026-11-01T00:15:04+07:00'],
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  finishedAt?: string;
}

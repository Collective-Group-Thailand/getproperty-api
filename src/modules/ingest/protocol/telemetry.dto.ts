import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  registerDecorator,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

import { MeterUnit, ReadingQuality } from './enums';
import { MAX_READINGS_PER_BATCH, REGISTER_PATTERN, REGISTER_PATTERN_SOURCE } from './formats';

/** Duplicate `(meterId, seq)` pairs inside one batch are a gateway defect; the batch is refused. */
export function UniqueReadingSeq(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'uniqueReadingSeq',
      target: object.constructor,
      propertyName,
      options: { message: 'readings must not repeat a (meterId, seq) pair', ...options },
      validator: {
        validate(value: unknown): boolean {
          if (!Array.isArray(value)) return true;
          const seen = new Set<string>();
          for (const reading of value as { meterId?: unknown; seq?: unknown }[]) {
            const key = `${String(reading?.meterId)}|${String(reading?.seq)}`;
            if (seen.has(key)) return false;
            seen.add(key);
          }
          return true;
        },
      },
    });
}

/** One cumulative register reading (D-030): the billing source of truth, never interval telemetry. */
@JSONSchema({
  description:
    'One cumulative register reading of a meter (D-030). `seq` is per meter, monotonic and persisted on the gateway; ' +
    'the cloud deduplicates on (meterId, seq). `extra` is driver-specific instant data and is never used for billing.',
})
export class Reading {
  @JSONSchema({ description: 'Meter id from the gateway config (bound by the cloud, D-033)' })
  @IsUUID()
  meterId!: string;

  @JSONSchema({
    description:
      'Per-meter monotonic sequence number, persisted on the gateway; gaps are allowed and reported as `seq_gap`',
  })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  seq!: number;

  @JSONSchema({
    description:
      'Gateway clock at the read, ISO 8601 with offset; > 10 min ahead of receipt → `clock_suspect`',
    examples: ['2026-11-01T00:15:00+07:00'],
  })
  @IsISO8601({ strict: true })
  readAt!: string;

  @JSONSchema({
    description: 'Cumulative register value as a decimal string (numeric(12,3)): kWh or m³, up to 3 decimals',
    examples: ['12345.678'],
    pattern: REGISTER_PATTERN_SOURCE,
  })
  @Matches(REGISTER_PATTERN)
  register!: string;

  @IsEnum(MeterUnit)
  unit!: MeterUnit;

  @IsEnum(ReadingQuality)
  quality!: ReadingQuality;

  @JSONSchema({
    description:
      'Optional driver-specific instant values (voltage, current, powerW, flowLpm…); numbers only; never billed',
    additionalProperties: { type: 'number' },
    examples: [{ voltage: 228.1, current: 3.2, powerW: 710 }],
  })
  @IsOptional()
  @IsObject()
  extra?: Record<string, number>;
}

/** `gp/v1/<gatewayId>/telemetry`, QoS 1, not retained (device-protocol.md §2). */
@JSONSchema({
  description:
    'Batch of cumulative register readings published by a gateway on `gp/v1/<gatewayId>/telemetry` (QoS 1). ' +
    'At most 200 readings; the gateway deletes buffered readings only on PUBACK (store-and-forward, §4).',
})
export class TelemetryBatch {
  @JSONSchema({ description: 'The publishing gateway; must equal the topic segment and the certificate CN' })
  @IsUUID()
  gatewayId!: string;

  @JSONSchema({ description: 'Version of the GatewayConfig the readings were taken with' })
  @IsInt()
  @Min(0)
  configVersion!: number;

  @JSONSchema({
    description: 'Gateway clock when the batch was published',
    examples: ['2026-11-01T00:15:03+07:00'],
  })
  @IsISO8601({ strict: true })
  sentAt!: string;

  @JSONSchema({ description: `1–${MAX_READINGS_PER_BATCH} readings; no repeated (meterId, seq) pair` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_READINGS_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => Reading)
  @UniqueReadingSeq()
  readings!: Reading[];
}

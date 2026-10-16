import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { FAKE } from '../openapi/examples';

/** Aggregation bucket of a telemetry series (contract §3; TimescaleDB continuous aggregates, D-030). */
export enum SeriesBucket {
  FifteenMinutes = '15m',
  Hour = '1h',
  Day = '1d',
}

export const SERIES_BUCKET_SECONDS: Record<SeriesBucket, number> = {
  [SeriesBucket.FifteenMinutes]: 15 * 60,
  [SeriesBucket.Hour]: 60 * 60,
  [SeriesBucket.Day]: 24 * 60 * 60,
};

/** Longest range per bucket, so one request never scans more than ~750 points. */
export const SERIES_MAX_RANGE_DAYS: Record<SeriesBucket, number> = {
  [SeriesBucket.FifteenMinutes]: 7,
  [SeriesBucket.Hour]: 31,
  [SeriesBucket.Day]: 750,
};

@ValidatorConstraint({ name: 'seriesRange' })
class SeriesRange implements ValidatorConstraintInterface {
  validate(_value: unknown, args?: ValidationArguments): boolean {
    const query = (args?.object ?? {}) as Partial<SeriesQuery>;
    const from = Date.parse(query.from ?? '');
    const to = Date.parse(query.to ?? '');
    const bucket = query.bucket ?? SeriesBucket.Hour;
    if (Number.isNaN(from) || Number.isNaN(to) || !(bucket in SERIES_MAX_RANGE_DAYS)) return true; // reported by the other rules
    const days = (to - from) / 86_400_000;
    return from < to && days <= SERIES_MAX_RANGE_DAYS[bucket];
  }

  defaultMessage(): string {
    return 'to must be after from and within the maximum range of the bucket (15m: 7 days, 1h: 31 days, 1d: 750 days)';
  }
}

/** `?from=&to=&bucket=15m|1h|1d` for telemetry and usage series (contract §3 "Lists"). */
export class SeriesQuery {
  @ApiProperty({
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'Start of the series (inclusive), ISO 8601 with offset',
  })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-02T00:00:00+07:00',
    description: 'End of the series (exclusive)',
  })
  @IsISO8601({ strict: true })
  @Validate(SeriesRange)
  to!: string;

  @ApiPropertyOptional({ enum: SeriesBucket, enumName: 'SeriesBucket', default: SeriesBucket.Hour })
  @IsOptional()
  @IsEnum(SeriesBucket)
  bucket: SeriesBucket = SeriesBucket.Hour;
}

/** One point of a series; `value` is a decimal string (kWh, m³) with up to 3 decimals. */
export class SeriesPoint {
  @ApiProperty({ format: 'date-time', example: FAKE.dateTime, description: 'Start of the bucket' })
  at!: string;

  @ApiProperty({
    example: '12.345',
    description: 'Decimal string, up to 3 decimals; unit given by the series',
  })
  value!: string;
}

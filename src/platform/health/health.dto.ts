import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';

export enum HealthStatus {
  Ok = 'ok',
  Error = 'error',
  ShuttingDown = 'shutting_down',
}

export enum HealthIndicatorStatus {
  Up = 'up',
  Down = 'down',
  Degraded = 'degraded',
}

export enum DataStoreMode {
  Fake = 'fake',
  Real = 'real',
}

export class HealthIndicatorState {
  @ApiProperty({
    enum: HealthIndicatorStatus,
    enumName: 'HealthIndicatorStatus',
    example: HealthIndicatorStatus.Up,
  })
  status!: HealthIndicatorStatus;

  @ApiPropertyOptional({
    enum: DataStoreMode,
    enumName: 'DataStoreMode',
    example: DataStoreMode.Real,
    description: '`fake` when the dependency is an in-memory stand-in (DATA_STORES_MODE / INTEGRATIONS_MODE)',
  })
  mode?: DataStoreMode;

  @ApiPropertyOptional({ type: 'integer', example: 3, description: 'Milliseconds the probe took' })
  responseTime?: number;
}

const INDICATOR_EXAMPLE = {
  database: { status: 'up', mode: 'real', responseTime: 3 },
  redis: { status: 'up', mode: 'real', responseTime: 1 },
  storage: { status: 'up', mode: 'real', responseTime: 12 },
  mqtt: { status: 'up', mode: 'real' },
};

const indicatorMap = (description: string) =>
  ({
    type: 'object',
    description,
    additionalProperties: { $ref: getSchemaPath(HealthIndicatorState) },
    example: INDICATOR_EXAMPLE,
  }) as const;

export class HealthResponse {
  @ApiProperty({ enum: HealthStatus, enumName: 'HealthStatus', example: HealthStatus.Ok })
  status!: HealthStatus;

  @ApiPropertyOptional(indicatorMap('Dependencies that are up, by name'))
  info?: Record<string, HealthIndicatorState>;

  @ApiPropertyOptional({ ...indicatorMap('Dependencies that are down, by name'), example: {} })
  error?: Record<string, HealthIndicatorState>;

  @ApiProperty(indicatorMap('Every dependency, by name'))
  details!: Record<string, HealthIndicatorState>;
}

export const HEALTH_EXAMPLE = {
  status: 'ok',
  info: INDICATOR_EXAMPLE,
  error: {},
  details: INDICATOR_EXAMPLE,
};

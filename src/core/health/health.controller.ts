import {
  ApiEndpoint,
  ApiPublic,
  ApiStandardErrors,
  ApiSuccess,
  ApiUnthrottled,
} from '@common/openapi/decorators';
import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExtraModels, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { HEALTH_EXAMPLE, HealthIndicatorState, HealthResponse } from './health.dto';
import { DependencyHealthIndicators } from './health.indicators';

/** Liveness/readiness for load balancers and ops (contract §2). Returns 503 when a dependency is down. */
@ApiTags('ops.health')
@ApiPublic()
@SkipThrottle()
@ApiUnthrottled()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: DependencyHealthIndicators,
  ) {}

  @Get()
  @HealthCheck({ swaggerDocumentation: false })
  @ApiEndpoint({
    id: 'ops.health.check',
    summary: 'Check the API and its dependencies',
    description:
      'Probes PostgreSQL/TimescaleDB (`SELECT 1`), Redis (`PING`), object storage (S3 `HeadBucket`) and the MQTT ' +
      'broker connection, 2 s timeout each. 200 when all are up; 503 `service.unavailable` when any is down. ' +
      'A dependency running as an in-memory fake reports `mode: fake`. Unauthenticated and not rate limited.',
    implements: ['ADR-0001', 'ADR-0002'],
  })
  @ApiExtraModels(HealthIndicatorState)
  @ApiSuccess(200, { description: 'All dependencies are up', type: HealthResponse, example: HEALTH_EXAMPLE })
  @ApiStandardErrors('service.unavailable')
  check() {
    return this.health.check([
      () => this.indicators.database_(),
      () => this.indicators.redisPing(),
      () => this.indicators.objectStorage(),
      () => this.indicators.mqttBroker(),
    ]);
  }
}

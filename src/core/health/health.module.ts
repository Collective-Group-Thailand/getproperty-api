import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { DependencyHealthIndicators } from './health.indicators';

@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
  controllers: [HealthController],
  providers: [DependencyHealthIndicators],
})
export class HealthModule {}

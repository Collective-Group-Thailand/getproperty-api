import { buildLoggerParams } from '@common/logging/logger.options';
import { AppConfig } from '@config/app-config';
import { AppConfigModule } from '@config/app-config.module';
import { CoreModule } from '@core/core.module';
import { DatabaseModule } from '@database/database.module';
import { RedisModule } from '@database/redis.module';
import { IntegrationsModule } from '@integrations/integrations.module';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { WorkerRunner } from './worker.runner';

/**
 * Worker process (`src/worker.ts`): outbox relay, event subscribers, workflow timers, notification deliveries and
 * repeatable maintenance jobs on BullMQ (`WorkerRunner`); later deliverables add billing cycles, reminders,
 * documents, health rules and rollups as queues/subscribers.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        buildLoggerParams({
          level: config.get('LOG_LEVEL'),
          pretty: config.get('LOG_PRETTY'),
          service: `${config.get('OTEL_SERVICE_NAME')}-worker`,
        }),
    }),
    RedisModule,
    DatabaseModule,
    IntegrationsModule,
    CoreModule,
  ],
  providers: [WorkerRunner],
})
export class WorkerModule {}

import { buildLoggerParams } from '@common/logging/logger.options';
import { AppConfig } from '@config/app-config';
import { AppConfigModule } from '@config/app-config.module';
import { DatabaseModule } from '@database/database.module';
import { RedisModule } from '@database/redis.module';
import { IntegrationsModule } from '@integrations/integrations.module';
import { Module } from '@nestjs/common';
import { PlatformCoreModule } from '@platform/platform-core.module';
import { LoggerModule } from 'nestjs-pino';

import { WorkerLifecycle } from './worker.lifecycle';

/**
 * Worker process (`src/worker.ts`): outbox relay, BullMQ consumers and repeatable jobs (billing
 * cycles, reminders, documents, health rules, rollups). B1.1 is the shell: it connects to Redis in
 * real mode and idles; `BullModule.forRootAsync({ connection: BULLMQ_REDIS })` and the first queues
 * arrive with the outbox in B1.3 (BullMQ cannot be registered against a fake connection).
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
    PlatformCoreModule,
  ],
  providers: [WorkerLifecycle],
})
export class WorkerModule {}

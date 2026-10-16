import { buildLoggerParams } from '@common/logging/logger.options';
import { AppConfig } from '@config/app-config';
import { AppConfigModule } from '@config/app-config.module';
import { DatabaseModule } from '@database/database.module';
import { RedisModule } from '@database/redis.module';
import { IntegrationsModule } from '@integrations/integrations.module';
import { IngestModule } from '@modules/ingest/ingest.module';
import { Module } from '@nestjs/common';
import { PlatformCoreModule } from '@platform/platform-core.module';
import { LoggerModule } from 'nestjs-pino';

/**
 * Ingest process (`src/ingest.ts`): EMQX shared subscription → validate → (B3.2: dedup → readings +
 * telemetry hypertables → events). Horizontally scalable through `$share/<group>/…` (master plan §2).
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
          service: `${config.get('OTEL_SERVICE_NAME')}-ingest`,
        }),
    }),
    RedisModule,
    DatabaseModule,
    IntegrationsModule,
    PlatformCoreModule,
    IngestModule,
  ],
})
export class IngestProcessModule {}

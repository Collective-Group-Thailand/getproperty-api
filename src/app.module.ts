import { join } from 'node:path';

import { OrgContextMiddleware } from '@common/context/org-context.middleware';
import { RequestContextMiddleware } from '@common/context/request-context.middleware';
import { DeprecationInterceptor } from '@common/deprecation/deprecation';
import { ProblemDetailsFilter } from '@common/errors/problem-details.filter';
import { EtagInterceptor } from '@common/etag/etag.interceptor';
import { DEFAULT_LANGUAGE } from '@common/i18n/language';
import { IdempotencyModule } from '@common/idempotency/idempotency.module';
import { buildLoggerParams } from '@common/logging/logger.options';
import { AppConfig } from '@config/app-config';
import { AppConfigModule } from '@config/app-config.module';
import { DatabaseModule } from '@database/database.module';
import { RedisModule } from '@database/redis.module';
import { IntegrationsModule } from '@integrations/integrations.module';
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { seconds, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthModule } from '@platform/health/health.module';
import { PlatformCoreModule } from '@platform/platform-core.module';
import { SentryModule } from '@sentry/nestjs/setup';
import { AcceptLanguageResolver, I18nModule } from 'nestjs-i18n';
import { LoggerModule } from 'nestjs-pino';

import { SURFACE_PREFIX } from './surfaces/surfaces';
import { SurfacesModule } from './surfaces/surfaces.module';

/** HTTP process (`src/main.ts`). */
@Module({
  imports: [
    SentryModule.forRoot(),
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        buildLoggerParams({
          level: config.get('LOG_LEVEL'),
          pretty: config.get('LOG_PRETTY'),
          service: config.get('OTEL_SERVICE_NAME'),
        }),
    }),
    I18nModule.forRoot({
      fallbackLanguage: DEFAULT_LANGUAGE,
      fallbacks: { 'th-*': 'th', 'en-*': 'en' },
      loaderOptions: { path: join(__dirname, 'i18n'), watch: false },
      resolvers: [AcceptLanguageResolver],
    }),
    ThrottlerModule.forRootAsync({
      imports: [],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => [
        { ttl: seconds(config.get('THROTTLE_TTL_SECONDS')), limit: config.get('THROTTLE_LIMIT') },
      ],
    }),
    DatabaseModule,
    RedisModule,
    IntegrationsModule,
    IdempotencyModule,
    PlatformCoreModule,
    HealthModule,
    SurfacesModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
    { provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
    // Org context on the two org-scoped surfaces (contract §8). Express 5 path syntax.
    consumer
      .apply(OrgContextMiddleware)
      .forRoutes(
        `${SURFACE_PREFIX.owner}*path`,
        `${SURFACE_PREFIX.staff}*path`,
        SURFACE_PREFIX.owner.slice(0, -1),
        SURFACE_PREFIX.staff.slice(0, -1),
      );
  }
}

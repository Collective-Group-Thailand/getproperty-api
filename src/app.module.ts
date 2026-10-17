import { join } from 'node:path';

import { AuthGuard } from '@common/auth/auth.guard';
import { PermissionGuard } from '@common/auth/permission.guard';
import { SupportGrantGuard } from '@common/auth/support-grant.guard';
import { RequestContextMiddleware } from '@common/context/request-context.middleware';
import { DeprecationInterceptor } from '@common/deprecation/deprecation';
import { ProblemDetailsFilter } from '@common/errors/problem-details.filter';
import { EtagInterceptor } from '@common/etag/etag.interceptor';
import { DEFAULT_LANGUAGE } from '@common/i18n/language';
import { IdempotencyModule } from '@common/idempotency/idempotency.module';
import { buildLoggerParams } from '@common/logging/logger.options';
import { AppConfig } from '@config/app-config';
import { AppConfigModule } from '@config/app-config.module';
import { CoreModule } from '@core/core.module';
import { HealthModule } from '@core/health/health.module';
import { DatabaseModule } from '@database/database.module';
import { RedisModule } from '@database/redis.module';
import { IntegrationsModule } from '@integrations/integrations.module';
import { OpsModule } from '@modules/ops.module';
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { seconds, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { SentryModule } from '@sentry/nestjs/setup';
import { AcceptLanguageResolver, I18nModule } from 'nestjs-i18n';
import { LoggerModule } from 'nestjs-pino';

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
    CoreModule,
    OpsModule,
    HealthModule,
    SurfacesModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Order matters: authentication + tenant context, then permissions, then support grants (D-090, D-091).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: SupportGrantGuard },
    { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
    { provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // The request context (actor, tenant, permissions, correlation id) for every route; the AuthGuard fills it.
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}

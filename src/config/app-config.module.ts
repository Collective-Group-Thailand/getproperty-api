import { Global, Module } from '@nestjs/common';

import { AppConfig } from './app-config';
import { validateEnv } from './validate-env';

/**
 * Validates `process.env` when the provider is instantiated (inside `NestFactory.create`), not when
 * the module is imported, so variables loaded from Secrets Manager are validated too.
 * `.env` is loaded by `src/instrument.ts` for local development.
 */
@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => new AppConfig(validateEnv(process.env)) }],
  exports: [AppConfig],
})
export class AppConfigModule {}

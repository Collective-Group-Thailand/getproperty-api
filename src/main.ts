import './instrument';

import { trustProxy } from '@common/http/trust-proxy';
import { AppConfig } from '@config/app-config';
import { loadSecretsIntoEnv } from '@config/secrets.loader';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp, setupDocs } from './bootstrap';

async function bootstrap(): Promise<void> {
  const secrets = await loadSecretsIntoEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  const config = app.get(AppConfig);
  // Client IP behind load balancers and our BFFs (rate limiting, docs allow-list, e-sign evidence) — D-229.
  app.set('trust proxy', trustProxy(config.get('TRUST_PROXY'), config.get('TRUSTED_PROXY_CIDRS')));
  configureApp(app);
  setupDocs(app);

  if (secrets.loadedKeys.length > 0)
    logger.log(`Loaded ${secrets.loadedKeys.length} variables from Secrets Manager`);
  if (config.useFakeDataStores)
    logger.warn('DATA_STORES_MODE=fake: PostgreSQL, Redis and MQTT are in-memory stand-ins');

  const port = config.get('PORT');
  await app.listen(port);
  logger.log(`getproperty-api listening on :${port}`);
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- the logger may not exist yet (e.g. invalid environment)
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

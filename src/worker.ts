import './instrument';

import { loadSecretsIntoEnv } from '@config/secrets.loader';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  await loadSecretsIntoEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.init();
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- the logger may not exist yet (e.g. invalid environment)
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import './instrument';

import { ProcessMetrics, processServiceName, startOpsServer } from '@common/observability/metrics';
import { processChecks } from '@common/observability/process-checks';
import { AppConfig } from '@config/app-config';
import { setProcessRole } from '@config/process-role';
import { loadSecretsIntoEnv } from '@config/secrets.loader';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  setProcessRole('worker');
  await loadSecretsIntoEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.init();
  // `/health` + `/metrics` on WORKER_HEALTH_PORT (the Collective platform's image contract, D-230).
  const config = app.get(AppConfig);
  const server = await startOpsServer({
    port: config.get('WORKER_HEALTH_PORT'),
    metrics: new ProcessMetrics(processServiceName(config.get('OTEL_SERVICE_NAME'), 'worker')),
    checks: processChecks(app, { mqtt: false }),
  });
  process.once('SIGTERM', () => server.close());
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- the logger may not exist yet (e.g. invalid environment)
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

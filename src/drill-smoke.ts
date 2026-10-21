/* eslint-disable no-console -- a one-shot command: `SMOKE <check> ok|fail|skip <detail>` lines for the drill log */
// `node dist/src/drill-smoke.js` — getproperty's smoke test inside the Collective platform's monthly restore drill
// (collective-infra platform/products/getproperty/hooks/drill-smoke.sh; blueprint T-15; RUNBOOK §9). Environment:
// DATABASE_URL (the restored drill instance), DATABASE_APP_ROLE / DATABASE_PLATFORM_ROLE, DRILL_SMOKE=1,
// DRILL_SAME_ENV=true|false, DRILL_SOURCE_ENV, and — same environment only — the product env file (keys). Nothing but
// the drill database is reachable, so the in-process API runs with in-memory Valkey / MQTT / S3 / providers.
// Exit 0 = no check failed. Local: `pnpm build && DATABASE_URL=… DRILL_SAME_ENV=true pnpm drill:smoke`.
import { SMS } from '@integrations/sms/sms.port';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { runDrillSmoke } from './drill/drill-smoke';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (the restored drill database)');
  const sameEnv = process.env.DRILL_SAME_ENV === 'true';
  const lines = await runDrillSmoke({
    databaseUrl: url,
    sameEnv,
    appRole: process.env.DATABASE_APP_ROLE || 'gp_app',
    log: (line) => console.log(line),
    bootApp: async () => {
      // the drill network has no Valkey, EMQX, S3 or providers: everything but PostgreSQL in memory, read-mostly smoke
      Object.assign(process.env, {
        NODE_ENV: 'development',
        DATA_STORES_MODE: 'real',
        REDIS_MODE: 'fake',
        MQTT_MODE: 'fake',
        INTEGRATIONS_MODE: 'fake',
        OBJECT_STORAGE_MODE: 'fake',
        PDF_RENDERER_MODE: 'fake',
        AWS_SECRETS_ID: '',
        LOG_LEVEL: process.env.DRILL_LOG_LEVEL ?? 'error',
        THROTTLE_LIMIT: '100000',
        DOCS_ENABLED: 'false',
      });
      const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
      configureApp(app);
      await app.listen(0, '127.0.0.1');
      const sms = app.get<{ lastCodeTo(phone: string): string | undefined }>(SMS);
      return { app, lastOtp: (phone) => sms.lastCodeTo(phone) };
    },
  });
  console.log(`DRILL_SOURCE_ENV ${process.env.DRILL_SOURCE_ENV ?? 'n/a'} SAME_ENV ${String(sameEnv)}`);
  const failed = lines.filter((l) => l.outcome === 'fail');
  console.log(
    failed.length ? `SMOKE_RESULT fail (${failed.map((f) => f.check).join(', ')})` : 'SMOKE_RESULT ok',
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(`SMOKE_RESULT fail (${error instanceof Error ? error.message : String(error)})`);
  process.exit(1);
});

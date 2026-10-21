/* eslint-disable no-console -- a one-shot command: plain lines on stdout/stderr for the operator */
// `node dist/src/credentials-import.js` (`pnpm credentials:import` after `pnpm build`) — D-240 migration: copies the
// per-merchant provider credentials still held under the former Secrets Manager paths
// (`PAYMENTS_SECRETS_PREFIX`, `LOCKS_SECRETS_PREFIX`, `ETAX_SECRETS_PREFIX`) into `platform.provider_credential`,
// sealed with each tenant's data key. Idempotent (a credential with a live row is skipped). Run once per environment
// with the image's normal env plus the three prefixes (RUNBOOK §13), then drop the prefixes and the sub-path secrets.
import { setProcessRole } from '@config/process-role';
import { loadSecretsIntoEnv } from '@config/secrets.loader';
import { ProviderCredentialsService } from '@core/credentials/provider-credentials.service';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function main(): Promise<void> {
  setProcessRole('worker');
  await loadSecretsIntoEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(ProviderCredentialsService).importLegacy();
    console.log(
      `provider credentials: imported ${result.imported}, already in the database ${result.skipped}, not found ${result.missing.length}`,
    );
    for (const m of result.missing) console.log(`  missing: ${m}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

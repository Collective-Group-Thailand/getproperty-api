/* eslint-disable no-console -- a one-shot command: plain lines on stdout/stderr for the deploy log */
// `node dist/src/migrate.js` — the platform's one-shot `migrate` service (D-230, docs/deployment.md): asset-core
// migrations, then prisma/migrations, then the optional TimescaleDB step, then the idempotent reference seed (roles,
// permissions, settings catalogue, compliance rules, tariffs… — `SEED_REFERENCE=false` skips it). Runs as the
// database owner login (`DATABASE_URL`, the product role of the shared PostgreSQL); needs no Prisma CLI.
import { config } from 'dotenv';
import { Client } from 'pg';

import { runSeed } from '../prisma/seed/run';
import { runDeployMigrations, type TimescaleMode } from './database/migrations/deploy-migrations';

config({ quiet: true });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const mode = (process.env.TIMESCALEDB_MIGRATION ?? 'auto') as TimescaleMode;
  if (!['auto', 'on', 'off'].includes(mode)) throw new Error('TIMESCALEDB_MIGRATION must be auto, on or off');
  const db = new Client({ connectionString: url, application_name: 'getproperty-migrate' });
  await db.connect();
  try {
    const result = await runDeployMigrations(db, { timescale: mode, log: (line) => console.log(line) });
    console.log(
      `migrate ok: core +${result.core.length}, app +${result.app.length}, timescale ${result.timescale}`,
    );
    if (process.env.SEED_REFERENCE !== 'false') {
      // Same seed as `pnpm db:seed`: every insert is ON CONFLICT on a natural key, so a deploy changes nothing twice.
      await runSeed(db, 'reference', (line) => console.log(line));
      console.log('seed: reference done');
    }
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// `pnpm test:int` — integration tests against a real PostgreSQL 18.
//   EMBEDDED_PG=1 pnpm test:int          the suite starts an embedded cluster itself (no Docker needed)
//   INT_DATABASE_URL=postgres://… pnpm test:int   use an existing server (superuser URL; CI service container)
// Without either, the script explains and exits 0 so plain local runs stay green.
import { spawnSync } from 'node:child_process';

if (process.env.EMBEDDED_PG !== '1' && !process.env.INT_DATABASE_URL) {
  console.log(
    'test:int skipped: set EMBEDDED_PG=1 (embedded PostgreSQL 18, no Docker) or INT_DATABASE_URL=<superuser URL> ' +
      'to run the integration suite (migrations, seeds, RLS, drift).',
  );
  process.exit(0);
}

const run = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config',
    'jest.config.ts',
    '--selectProjects',
    'integration',
    '--runInBand',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } },
);
process.exit(run.status ?? 1);

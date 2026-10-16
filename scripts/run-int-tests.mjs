// `pnpm test:int` — integration tests need real stores (Testcontainers). They run only with
// DATA_STORES_MODE=real; otherwise the script explains and exits 0 so local runs without Docker stay green.
import { spawnSync } from 'node:child_process';

if (process.env.DATA_STORES_MODE !== 'real') {
  console.log(
    'test:int skipped: DATA_STORES_MODE is not "real". Integration tests run against Testcontainers ' +
      '(TimescaleDB, Redis, EMQX); start Docker and run `DATA_STORES_MODE=real pnpm test:int`.',
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
    '--passWithNoTests',
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } },
);
process.exit(run.status ?? 1);

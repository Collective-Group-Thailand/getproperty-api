#!/usr/bin/env node
// `pnpm prisma:generate` (also postinstall) — generates the Prisma client into src/generated/prisma.
//
// Prisma 7 generates the client with WebAssembly; the native schema engine is not used by `generate`, but the
// CLI still resolves (and, if missing, downloads) it from binaries.prisma.sh at start-up. Where that host is
// unreachable (offline laptops, locked-down sandboxes) the first attempt fails with a download error; the script
// then retries with PRISMA_SCHEMA_ENGINE_BINARY pointing at a stub that is never executed by `generate`, and says
// so. Migrations (`prisma migrate deploy|diff`) always need the real engine and are not affected by this script.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const cli = require.resolve('prisma/build/index.js');

function generate(env) {
  return spawnSync(process.execPath, [cli, 'generate'], {
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', ...env },
    encoding: 'utf8',
  });
}

let run = generate({});
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
if (
  run.status !== 0 &&
  /binaries\.prisma\.sh|Failed to fetch/i.test(output) &&
  !process.env.PRISMA_SCHEMA_ENGINE_BINARY
) {
  const dir = join(process.cwd(), 'node_modules', '.cache', 'getproperty');
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, 'schema-engine-unavailable');
  writeFileSync(
    stub,
    '#!/bin/sh\necho "schema engine unavailable (download blocked); use a networked machine for migrations" >&2\nexit 1\n',
  );
  chmodSync(stub, 0o755);
  console.warn(
    'prisma:generate — schema-engine download blocked; generating with WebAssembly only (no engine needed).',
  );
  run = generate({ PRISMA_SCHEMA_ENGINE_BINARY: stub });
}
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
process.exit(run.status ?? 1);

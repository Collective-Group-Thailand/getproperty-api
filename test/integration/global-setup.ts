import { execFileSync } from 'node:child_process';
import { chownSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assetCoreMigrate } from '@collective/asset-core';
import { Client } from 'pg';

import { runSeed } from '../../prisma/seed/run';
import { applyPrismaMigrations } from '../support/prisma-migrations';

const TEMPLATE_DB = 'gp_int_template';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Integration suite setup (`pnpm test:int`):
 *   EMBEDDED_PG=1        starts an embedded PostgreSQL 18 cluster (embedded-postgres; as OS user `postgres` when
 *                        running as root) for the run;
 *   INT_DATABASE_URL=…   uses an existing server instead (a superuser URL, e.g. the CI service container).
 * Then builds the template database: @collective/asset-core migrations → this repo's migrations → dev seed. Each
 * test file clones it (CREATE DATABASE … TEMPLATE) or starts from an empty database.
 */
export default async function globalSetup(): Promise<void> {
  let admin = process.env.INT_DATABASE_URL;
  if (process.env.EMBEDDED_PG === '1') {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const osUser = isRoot ? (process.env.EMBEDDED_PG_OS_USER ?? 'postgres') : undefined;
    const parent = mkdtempSync(join(tmpdir(), 'getproperty-int-pg-'));
    if (osUser) {
      chownSync(
        parent,
        Number(execFileSync('id', ['-u', osUser]).toString().trim()),
        Number(execFileSync('id', ['-g', osUser]).toString().trim()),
      );
    }
    const port = await freePort();
    const pg = new EmbeddedPostgres({
      databaseDir: join(parent, 'data'),
      user: 'gp',
      password: 'gp',
      port,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      onLog: () => undefined,
      ...(osUser ? { postgresUser: osUser } : {}),
    });
    await pg.initialise();
    await pg.start();
    (globalThis as { __EMBEDDED_PG__?: { stop(): Promise<void> } }).__EMBEDDED_PG__ = pg;
    admin = `postgresql://gp:gp@127.0.0.1:${port}/postgres`;
  }
  if (!admin) throw new Error('integration tests need EMBEDDED_PG=1 or INT_DATABASE_URL');
  process.env.INT_ADMIN_URL = admin;

  const server = new Client({ connectionString: admin });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await server.end();
  const url = admin.replace(/\/[^/?]*(\?|$)/, `/${TEMPLATE_DB}$1`);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await assetCoreMigrate({ client: db });
    await applyPrismaMigrations(db);
    await runSeed(db, 'dev');
  } finally {
    await db.end();
  }
}

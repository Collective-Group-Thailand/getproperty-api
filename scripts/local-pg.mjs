#!/usr/bin/env node
// `pnpm db:local [start|stop|status]` — a local PostgreSQL 18 cluster for developers without Docker
// (embedded-postgres). A development convenience only: docker-compose (timescale/timescaledb-ha:pg18) stays
// the primary path and the only one with TimescaleDB — the embedded build ships pgcrypto, pg_trgm, citext and
// btree_gist but NOT timescaledb, so hypertables (B3.2+) need compose. Migrations create the extension
// conditionally (0001_extensions) so the B1 schema applies here unchanged.
//
//   pnpm db:local start      initialises (first run) and starts the cluster in the foreground; Ctrl-C stops it.
//   pnpm db:local stop       stops a cluster left running by a crashed shell (uses the data dir's pid file).
//   pnpm db:local status     prints the connection URLs.
//
// Environment (all optional):
//   LOCAL_PG_DIR   data directory            default .local/pg/data   (gitignored)
//   LOCAL_PG_PORT  TCP port                  default 55432
//   LOCAL_PG_USER / LOCAL_PG_PASSWORD        default gp / gp
//   LOCAL_PG_OS_USER  OS account that runs postgres when this script runs as root (postgres refuses root);
//                     default `postgres`. The data dir's parent must be owned by that account.
//
// Databases `getproperty` and `getproperty_shadow` are created on start when missing. Resulting URLs:
//   DATABASE_URL=postgresql://gp:gp@127.0.0.1:55432/getproperty
//   SHADOW_DATABASE_URL=postgresql://gp:gp@127.0.0.1:55432/getproperty_shadow
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';

const command = process.argv[2] ?? 'start';
const dataDir = resolve(process.env.LOCAL_PG_DIR ?? '.local/pg/data');
const port = Number(process.env.LOCAL_PG_PORT ?? 55432);
const user = process.env.LOCAL_PG_USER ?? 'gp';
const password = process.env.LOCAL_PG_PASSWORD ?? 'gp';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const osUser = isRoot ? (process.env.LOCAL_PG_OS_USER ?? 'postgres') : undefined;
const databases = ['getproperty', 'getproperty_shadow'];

const url = (db) => `postgresql://${user}:${password}@127.0.0.1:${port}/${db}`;

function printUrls() {
  console.log(`DATABASE_URL=${url(databases[0])}`);
  console.log(`SHADOW_DATABASE_URL=${url(databases[1])}`);
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  ...(osUser ? { postgresUser: osUser } : {}),
});

async function start() {
  const initialised = existsSync(resolve(dataDir, 'PG_VERSION'));
  if (!initialised) {
    console.log(
      `db:local — initialising a new cluster in ${dataDir}${osUser ? ` (as OS user ${osUser})` : ''}`,
    );
    await pg.initialise();
  }
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  try {
    const { rows } = await client.query('SELECT datname FROM pg_database');
    const existing = new Set(rows.map((r) => r.datname));
    for (const db of databases) {
      if (!existing.has(db)) {
        await client.query(`CREATE DATABASE "${db}"`);
        console.log(`db:local — created database ${db}`);
      }
    }
    const { rows: ext } = await client.query(
      `SELECT name FROM pg_available_extensions WHERE name IN ('timescaledb','pgcrypto','pg_trgm','citext','btree_gist') ORDER BY 1`,
    );
    const names = ext.map((r) => r.name);
    console.log(
      `db:local — PostgreSQL ready on 127.0.0.1:${port}; extensions available: ${names.join(', ')}`,
    );
    if (!names.includes('timescaledb')) {
      console.log(
        'db:local — timescaledb is NOT available in the embedded build: hypertables need docker compose.',
      );
    }
  } finally {
    await client.end();
  }
  printUrls();
  console.log('db:local — running in the foreground; Ctrl-C stops the cluster.');
  const stop = async () => {
    console.log('\ndb:local — stopping');
    await pg.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  // Keep the event loop alive.
  setInterval(() => undefined, 1 << 30);
}

async function stop() {
  const pidFile = resolve(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) {
    console.log(`db:local — no postmaster.pid in ${dataDir}; nothing to stop.`);
    return;
  }
  const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`db:local — sent SIGTERM to postgres pid ${pid}`);
  } catch (error) {
    console.log(`db:local — could not signal pid ${pid}: ${error.message}`);
  }
}

switch (command) {
  case 'start':
    await start();
    break;
  case 'stop':
    await stop();
    break;
  case 'status':
    console.log(
      existsSync(resolve(dataDir, 'postmaster.pid'))
        ? 'db:local — a cluster appears to be running'
        : 'db:local — not running',
    );
    printUrls();
    break;
  default:
    console.error(`db:local — unknown command "${command}" (start | stop | status)`);
    process.exit(64);
}

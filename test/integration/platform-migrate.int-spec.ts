import { randomBytes } from 'node:crypto';

import { listMigrations } from '@database/migrations/app-migrations';
import { runDeployMigrations } from '@database/migrations/deploy-migrations';
import { Client } from 'pg';

import { runSeed } from '../../prisma/seed/run';
import { adminUrl, urlFor } from '../support/int-db';

/**
 * D-230: on the Collective platform the migrate service runs as the product login — owner of its database but
 * NOCREATEROLE, with the asset-core group roles granted by the platform's postgres init script
 * (collective-infra platform/postgres/init/20-getproperty.sh). CI and the other suites migrate as a superuser, so
 * this suite is the proof that the image's `node dist/src/migrate.js` works there.
 */
describe('migrate + reference seed as the platform product login (D-230)', () => {
  const suffix = randomBytes(4).toString('hex');
  const login = `gp_int_product_${suffix}`;
  const database = `gp_int_platform_${suffix}`;
  const password = randomBytes(12).toString('hex');
  let server: Client;
  let db: Client;

  beforeAll(async () => {
    server = new Client({ connectionString: adminUrl() });
    await server.connect();
    await server.query(
      `CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
    );
    await server.query(`CREATE DATABASE ${database} OWNER ${login}`);
    // what 20-getproperty.sh does (the roles exist cluster-wide once any database ran the migrations)
    for (const [role, attrs] of [
      ['gp_owner', 'NOLOGIN'],
      ['gp_app', 'NOLOGIN NOBYPASSRLS'],
      ['gp_platform', 'NOLOGIN BYPASSRLS'],
      ['gp_reporting', 'NOLOGIN NOBYPASSRLS'],
      ['gp_mqtt', 'NOLOGIN NOBYPASSRLS'],
    ])
      await server.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} ${attrs}; END IF; END $$`,
      );
    await server.query(`GRANT gp_owner, gp_app, gp_platform, gp_reporting, gp_mqtt TO ${login}`);
    const url = new URL(urlFor(database));
    url.username = login;
    url.password = password;
    db = new Client({ connectionString: url.toString() });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await server.query(`REASSIGN OWNED BY ${login} TO CURRENT_USER`).catch(() => undefined);
    await server.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
    await server.end();
  });

  it('applies core + app migrations, skips TimescaleDB without it, seeds the reference data; idempotent', async () => {
    const first = await runDeployMigrations(db, { timescale: 'auto' });
    expect(first.core).toHaveLength(13);
    expect(first.app).toEqual(listMigrations().map((m) => m.name));
    expect(first.timescale).toBe('skipped_unavailable');

    const who = await db.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(who.rows[0]?.rolsuper).toBe(false);
    // the temporary CREATE grant on core (asset-core 0007 hands its definer helpers to gp_platform) is revoked again
    const create = await db.query<{ can: boolean }>(
      `SELECT has_schema_privilege('gp_platform', 'core', 'CREATE') AS can`,
    );
    expect(create.rows[0]?.can).toBe(false);
    const owner = await db.query<{ owner: string }>(
      `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'core.tenant_dek(smallint)'::regprocedure`,
    );
    expect(owner.rows[0]?.owner).toBe('gp_platform');

    const counts = await runSeed(db, 'reference');
    expect(counts['platform.permission']).toBeGreaterThan(0);
    await db.query('RESET ROLE');

    const again = await runDeployMigrations(db, { timescale: 'auto' });
    expect(again).toEqual({ core: [], app: [], timescale: 'skipped_unavailable' });
  });
});

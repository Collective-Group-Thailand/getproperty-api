import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ClientBase } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

/** The table `prisma migrate deploy` keeps (same DDL), so a database prepared here is "already migrated" for Prisma. */
const PRISMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS public."_prisma_migrations" (
  "id"                  VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum"            VARCHAR(64) NOT NULL,
  "finished_at"         TIMESTAMPTZ,
  "migration_name"      VARCHAR(255) NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      TIMESTAMPTZ,
  "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

export function listMigrations(): { name: string; sql: string; checksum: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Applies prisma/migrations/* in order, each in one transaction, recording them in `_prisma_migrations` like
 * `prisma migrate deploy` does (name + sha256 checksum). Used by the integration suite so it runs where Prisma's
 * native schema engine cannot be downloaded; CI additionally runs the real `prisma migrate deploy` and
 * `prisma migrate diff` (ADR-0011). Returns the names applied (empty when up to date).
 */
export async function applyPrismaMigrations(db: ClientBase): Promise<string[]> {
  await db.query(PRISMA_MIGRATIONS_DDL);
  const { rows } = await db.query<{ migration_name: string; checksum: string }>(
    `SELECT migration_name, checksum FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  const applied = new Map(rows.map((r) => [r.migration_name, r.checksum]));
  const done: string[] = [];
  for (const m of listMigrations()) {
    const previous = applied.get(m.name);
    if (previous) {
      if (previous !== m.checksum) throw new Error(`migration ${m.name} was modified after it was applied`);
      continue;
    }
    await db.query('BEGIN');
    try {
      const started = new Date();
      await db.query(m.sql);
      await db.query(
        `INSERT INTO public."_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
         VALUES ($1, $2, now(), $3, $4, 1)`,
        [randomUUID(), m.checksum, m.name, started],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw new Error(`migration ${m.name} failed: ${(error as Error).message}`, { cause: error });
    }
    done.push(m.name);
  }
  return done;
}

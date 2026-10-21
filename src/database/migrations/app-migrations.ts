import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A `pg` client or anything with the same `query` method. */
export interface MigrationClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * `prisma/` of this repository: three levels up from `src/database/migrations` (ts-jest, ts-node) or four from
 * `dist/src/database/migrations` (the image, which ships `prisma/migrations` and `prisma/optional`). `PRISMA_DIR`
 * overrides.
 */
export function prismaDir(): string {
  if (process.env.PRISMA_DIR) return resolve(process.env.PRISMA_DIR);
  const candidates = [
    join(__dirname, '..', '..', '..', 'prisma'),
    join(__dirname, '..', '..', '..', '..', 'prisma'),
  ];
  return candidates.find((d) => existsSync(join(d, 'migrations'))) ?? candidates[0]!;
}

export const MIGRATIONS_DIR = join(prismaDir(), 'migrations');

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

export function listMigrations(dir = MIGRATIONS_DIR): { name: string; sql: string; checksum: string }[] {
  return readdirSync(dir)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Applies prisma/migrations/* in order, each in one transaction, recording them in `_prisma_migrations` like
 * `prisma migrate deploy` does (name + sha256 checksum), so either tool can follow the other. Used by the image's
 * migrate command (`dist/src/migrate.js`, D-230: the image carries no Prisma CLI or schema engine) and by the
 * integration suite; CI additionally runs the real `prisma migrate deploy` and `prisma migrate diff` (ADR-0011).
 * Returns the names applied (empty when up to date). A recorded migration whose file changed is an error.
 */
export async function applyPrismaMigrations(db: MigrationClient, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(PRISMA_MIGRATIONS_DDL);
  const { rows } = await db.query(
    `SELECT migration_name, checksum FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  const applied = new Map(rows.map((r) => [String(r.migration_name), String(r.checksum)]));
  const done: string[] = [];
  for (const m of listMigrations(dir)) {
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

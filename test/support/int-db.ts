import { randomBytes } from 'node:crypto';

import { configurePgTypes } from '@collective/asset-core';
import { type AppConfig } from '@config/app-config';
import { PrismaService } from '@database/prisma.service';
import { Client, types } from 'pg';

configurePgTypes(types);

export const TEMPLATE_DB = 'gp_int_template';

export function adminUrl(): string {
  const url = process.env.INT_ADMIN_URL;
  if (!url)
    throw new Error(
      'INT_ADMIN_URL is not set: run the suite with `pnpm test:int` (EMBEDDED_PG=1 or INT_DATABASE_URL)',
    );
  return url;
}

export function urlFor(db: string): string {
  return adminUrl().replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
}

export interface IntDatabase {
  name: string;
  url: string;
  /** Superuser connection (bypasses RLS) for setup and assertions. */
  admin: Client;
  /** PrismaService on this database; tenant transactions switch to gp_app (DATABASE_APP_ROLE). */
  prisma(): PrismaService;
  drop(): Promise<void>;
}

/** Creates a database: a clone of the migrated + seeded template (default) or an empty one. */
export async function createIntDatabase(
  options: { empty?: boolean; prefix?: string } = {},
): Promise<IntDatabase> {
  const name = `${options.prefix ?? 'gp_int'}_${randomBytes(5).toString('hex')}`;
  const server = new Client({ connectionString: adminUrl() });
  await server.connect();
  await server.query(
    options.empty ? `CREATE DATABASE ${name}` : `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`,
  );
  await server.end();
  const url = urlFor(name);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  let prisma: PrismaService | undefined;
  return {
    name,
    url,
    admin,
    prisma() {
      prisma ??= new PrismaService(intConfig(url));
      return prisma;
    },
    async drop() {
      await prisma?.$disconnect();
      await admin.end().catch(() => undefined);
      const s = new Client({ connectionString: adminUrl() });
      await s.connect();
      await s.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await s.end();
    },
  };
}

/** The slice of AppConfig PrismaService reads. */
export function intConfig(url: string): AppConfig {
  const values: Record<string, unknown> = {
    DATABASE_URL: url,
    DATABASE_APP_ROLE: 'gp_app',
    OTEL_SERVICE_NAME: 'getproperty-int',
  };
  return { useFakeDataStores: false, get: (key: string) => values[key] } as unknown as AppConfig;
}

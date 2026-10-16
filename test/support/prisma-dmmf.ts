import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type DmmfDatamodel } from '@collective/asset-core/testing';

export const SCHEMA_DIR = join(__dirname, '..', '..', 'prisma', 'schema');

export function schemaFiles(): [string, string][] {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.prisma'))
    .sort()
    .map((f) => [f, readFileSync(join(SCHEMA_DIR, f), 'utf8')]);
}

/** DMMF of prisma/schema via @prisma/prisma-schema-wasm (the same WebAssembly the Prisma CLI uses). */
export function loadDmmf(): DmmfDatamodel {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wasm = require('@prisma/prisma-schema-wasm') as { get_dmmf(params: string): string };
  return (
    JSON.parse(wasm.get_dmmf(JSON.stringify({ prismaSchema: schemaFiles() }))) as { datamodel: DmmfDatamodel }
  ).datamodel;
}

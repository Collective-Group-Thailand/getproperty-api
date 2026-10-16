/**
 * `pnpm contract:build` — boots the HTTP app with fakes (no listening, no database, Redis or broker
 * connection: `DATA_STORES_MODE=fake`) and writes deterministic `contract/openapi.json` and
 * `contract/device-protocol.json`. Fails when the document breaks a contract rule (unnamed enum, tag
 * without surface prefix, two DTO classes published under one component name).
 */
// Must stay the first import: it records DTO classes as their modules load.
import '../src/common/openapi/schema-classes.track';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { APP_VERSION, configureApp } from '../src/bootstrap';
import { buildOpenApiDocument, contractViolations } from '../src/common/openapi/openapi.document';
import { duplicateSchemaClasses } from '../src/common/openapi/schema-classes';
import { buildDeviceProtocolSchema } from '../src/modules/ingest/protocol/device-protocol-schema';

export const CONTRACT_ENV = {
  NODE_ENV: 'test',
  INTEGRATIONS_MODE: 'fake',
  DATA_STORES_MODE: 'fake',
  LOG_LEVEL: 'silent',
  DOCS_ENABLED: 'false',
};

async function main(): Promise<void> {
  Object.assign(process.env, CONTRACT_ENV);
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  configureApp(app);
  const document = buildOpenApiDocument(app, APP_VERSION);
  await app.close();

  const problems = [...contractViolations(document), ...duplicateSchemaClasses(document)];
  if (problems.length > 0) {
    console.error(`Contract violations:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }

  const protocol = buildDeviceProtocolSchema(APP_VERSION);

  const outDir = join(__dirname, '..', '..', 'contract');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(outDir, 'device-protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`);
  console.log(`contract/openapi.json written (${Object.keys(document.paths).length} paths)`);
  console.log(
    `contract/device-protocol.json written (${Object.keys(protocol.$defs as object).length} definitions)`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

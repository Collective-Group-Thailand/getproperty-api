import { type INestApplication, type Type } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { configureApp, setupDocs } from '../../src/bootstrap';

export interface E2eApp {
  app: INestApplication;
  /** The document served at `/docs-json` (undefined when docs are off). */
  openapi: OpenAPIObject | undefined;
}

/**
 * Boots the HTTP app exactly as `main.ts` does (same `configureApp`, same docs), against the
 * environment prepared by `test/e2e/global-setup.ts`. `extraModules` mounts suite-only probes.
 */
export async function createE2eApp(extraModules: Type<unknown>[] = []): Promise<E2eApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, ...extraModules] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, abortOnError: false });
  configureApp(app);
  const openapi = setupDocs(app);
  await app.init();
  return { app, openapi };
}

import { jsonBodyParser } from '@common/http/json-body-parser';
import { setupDocs as setupDocsRoutes } from '@common/openapi/docs';
import { createValidationPipe } from '@common/validation/validation';
import { type INestApplication, VersioningType } from '@nestjs/common';
import { type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';

import { version } from '../package.json';

export const APP_VERSION: string = version;

/**
 * Everything that shapes the HTTP surface, shared by `main.ts`, the contract build and e2e tests,
 * so all three see exactly the same routes.
 */
export function configureApp(app: INestApplication): void {
  app.use(helmet());
  app.use(jsonBodyParser());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
}

/** `/docs` (Scalar), `/docs/swagger`, `/docs-json`, `/docs.yaml` — gated per contract §5. */
export function setupDocs(app: INestApplication): OpenAPIObject | undefined {
  return setupDocsRoutes(app, APP_VERSION);
}

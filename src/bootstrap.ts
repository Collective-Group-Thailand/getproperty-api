import { jsonBodyParser } from '@common/http/json-body-parser';
import { setupDocs as setupDocsRoutes } from '@common/openapi/docs';
import { createValidationPipe } from '@common/validation/validation';
import { brandAssetsDir } from '@core/brand/brand-setting';
import { type INestApplication, VersioningType } from '@nestjs/common';
import { type OpenAPIObject } from '@nestjs/swagger';
import express from 'express';
import helmet from 'helmet';

import { version } from '../package.json';

export const APP_VERSION: string = version;

/**
 * Everything that shapes the HTTP surface, shared by `main.ts`, the contract build and e2e tests,
 * so all three see exactly the same routes.
 */
export function configureApp(app: INestApplication): void {
  // Express matches routes case-insensitively by default, while the audience guard reads the lower-case surface
  // prefix: `/V1/ADMIN/…` would reach an admin handler without the admin audience checks (review #7). Nest's adapter
  // already created the router (its constructor mounts a middleware), so the flag is set on the router too; routes
  // are added at `init()`, after this.
  const http = app.getHttpAdapter().getInstance() as {
    set?: (key: string, value: unknown) => void;
    router?: { caseSensitive?: boolean };
  };
  http.set?.('case sensitive routing', true);
  if (http.router) http.router.caseSensitive = true;
  app.use(helmet());
  // The platform brand files (D-232): logos linked by emails and LINE messages. Static files outside the versioned
  // API (no OpenAPI operation, no auth): images any client may load, so the cross-origin resource policy is opened
  // for this path only. Unknown names fall through to the 404 problem response.
  app.use(
    '/brand',
    express.static(brandAssetsDir(), {
      index: false,
      dotfiles: 'ignore',
      fallthrough: true,
      maxAge: '1d',
      setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );
  app.use(jsonBodyParser());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
}

/** `/docs` (Scalar), `/docs/swagger`, `/docs-json`, `/docs.yaml` — gated per contract §5. */
export function setupDocs(app: INestApplication): OpenAPIObject | undefined {
  return setupDocsRoutes(app, APP_VERSION);
}

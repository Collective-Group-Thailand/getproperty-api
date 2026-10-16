import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { AppConfig } from '@config/app-config';
import { type INestApplication } from '@nestjs/common';
import { type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import { DomainException } from '../errors/domain.exception';
import { ipAllowed, parseCidrList } from '../http/cidr';
import { buildOpenApiDocument } from './openapi.document';
import { scalarOptions } from './scalar-options';

export const DOCS_PATHS = {
  scalar: '/docs',
  scalarBundle: '/docs/assets/scalar.js',
  swagger: 'docs/swagger',
  json: '/docs-json',
  yaml: '/docs.yaml',
} as const;

// Self-hosted Scalar bundle (pinned by the lockfile): no third-party CDN at runtime.
const SCALAR_BUNDLE = join(dirname(require.resolve('@scalar/api-reference')), 'browser', 'standalone.js');

/**
 * Serves the API documentation (contract §5): Scalar at `/docs`, Swagger UI at `/docs/swagger`,
 * the raw document at `/docs-json` and `/docs.yaml`. Nothing is registered when docs are off, so
 * those paths are plain 404 problems. Returns the document it serves (the e2e suite compares it
 * with `contract/openapi.json`).
 *
 * TODO(B1.3): outside the CIDR allow-list, accept a platform token with `settings.read`.
 */
export function setupDocs(app: INestApplication, version: string): OpenAPIObject | undefined {
  const config = app.get(AppConfig);
  const access = config.docsAccess;
  if (access === 'off') return undefined;

  const gated = [DOCS_PATHS.scalar, DOCS_PATHS.json, DOCS_PATHS.yaml];
  if (access === 'allow-list') {
    const allowList = parseCidrList(config.get('DOCS_ALLOWED_CIDRS'));
    // Allow-listed networks only; everyone else gets exactly the answer of a missing route.
    app.use(gated, (req: Request, _res: Response, next: NextFunction) => {
      if (ipAllowed(allowList, req.ip)) return next();
      next(new DomainException('http.not_found'));
    });
  }
  app.use(gated, docsSecurityHeaders());

  const document = buildOpenApiDocument(app, version);
  SwaggerModule.setup(DOCS_PATHS.swagger, app, document, {
    jsonDocumentUrl: DOCS_PATHS.json.slice(1),
    yamlDocumentUrl: DOCS_PATHS.yaml.slice(1),
    customSiteTitle: 'getproperty API — Swagger UI',
  });

  const http = app.getHttpAdapter();
  http.get(DOCS_PATHS.scalarBundle, (_req: Request, res: Response) => {
    res.type('application/javascript').setHeader('Cache-Control', 'public, max-age=86400');
    // pnpm keeps packages under node_modules/.pnpm; `send` ignores dot-directories unless allowed.
    res.sendFile(SCALAR_BUNDLE, { dotfiles: 'allow' });
  });
  const scalar = scalarOptions(!config.isProduction);
  http.get(DOCS_PATHS.scalar, (req: Request, res: Response) => {
    const render = apiReference({
      // Scalar's option types are zod-inferred unions too large to check here; the values are pinned by
      // scalar-options.spec.ts.
      ...(scalar as object),
      url: DOCS_PATHS.json,
      cdn: DOCS_PATHS.scalarBundle,
      pageTitle: 'getproperty API reference',
      nonce: String(res.locals.cspNonce),
    });
    render(req, res);
  });
  return document;
}

/** Docs-only CSP: scripts from this origin plus one per-request nonce (Scalar's inline config). */
function docsSecurityHeaders() {
  const csp = helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (_req, res) => `'nonce-${String((res as Response).locals.cspNonce)}'`],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      frameAncestors: ["'none'"],
    },
  });
  return (req: Request, res: Response, next: NextFunction) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    csp(req, res, next);
  };
}

import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';

import { RequestContext } from './request-context';
import { resolveTenantContext, TENANT_ID_HEADER } from './tenant-context';

/**
 * Resolves `X-Tenant-Id` into the request's `TenantContext` on `/v1/owner/*` and `/v1/staff/*`
 * (the `operator` audience, contract §8). Problems are passed to the global filter as problem+json.
 *
 * TODO(B1.3): pass the verified token's scopes (`RequestContext.actor()?.scopes`) so the header is
 * checked against them and a single-tenant token needs no header at all.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    try {
      RequestContext.setTenant(resolveTenantContext(req.headers[TENANT_ID_HEADER]));
      next();
    } catch (error) {
      next(error);
    }
  }
}

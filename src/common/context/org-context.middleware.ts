import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';

import { ORG_ID_HEADER, resolveOrgContext } from './org-context';
import { RequestContext } from './request-context';

/**
 * Resolves `X-Org-Id` into the request's `OrgContext` on `/v1/owner/*` and `/v1/staff/*`
 * (contract §8). Problems are passed to the global filter as problem+json.
 *
 * TODO(B1.3): pass the verified token's scopes (`RequestContext.actor()?.scopes`) so the header is
 * checked against them and a single-org token needs no header at all.
 */
@Injectable()
export class OrgContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    try {
      RequestContext.setOrg(resolveOrgContext(req.headers[ORG_ID_HEADER]));
      next();
    } catch (error) {
      next(error);
    }
  }
}

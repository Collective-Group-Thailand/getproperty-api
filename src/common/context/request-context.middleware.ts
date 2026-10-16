import { requestIdOf } from '@common/request-id/request-id';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';

import { RequestContext } from './request-context';

/**
 * Opens the request context for everything downstream (guards, services, repositories). Runs after
 * pino-http so `req.id` (the request id) is already assigned.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const requestId = requestIdOf(req);
    RequestContext.run(
      {
        requestId,
        correlationId: RequestContext.correlationIdFor(requestId),
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 512),
      },
      next,
    );
  }
}

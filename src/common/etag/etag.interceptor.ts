import {
  applyDecorators,
  type CallHandler,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request, type Response } from 'express';
import { map, type Observable } from 'rxjs';

import { ApiEtag } from '../openapi/decorators';

const ETAG_METADATA = 'getproperty:etag';

type EtagExtractor = (body: unknown) => string | undefined;

/**
 * Sets the `ETag` response header from the handler result, e.g.
 * `@UseEtag((lease: LeaseDto) => etagOf(lease.id, lease.version))`, and documents it. Updates also use
 * `@ApiConcurrency()` (If-Match, 412/428).
 */
export function UseEtag<T>(extract: (body: T) => string | undefined) {
  return applyDecorators(SetMetadata(ETAG_METADATA, extract), ApiEtag());
}

/** Injects the raw `If-Match` header; pass it to `assertIfMatch` inside the transaction. */
export const IfMatch = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  const header = ctx.switchToHttp().getRequest<Request>().headers['if-match'];
  return Array.isArray(header) ? header.join(',') : header;
});

@Injectable()
export class EtagInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const extract = this.reflector.get<EtagExtractor | undefined>(ETAG_METADATA, context.getHandler());
    if (!extract || context.getType() !== 'http') return next.handle();

    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        const etag = extract(body);
        if (etag && !res.headersSent) res.setHeader('ETag', etag);
        return body;
      }),
    );
  }
}

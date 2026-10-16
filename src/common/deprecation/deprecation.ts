import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Response } from 'express';
import { type Observable } from 'rxjs';

export const DEPRECATION_METADATA = 'getproperty:deprecation';

/** When an operation (or a field) was deprecated and, once decided, when it goes away. */
export interface DeprecationInfo {
  /** `YYYY-MM-DD` (Bangkok) of the release that deprecated it. */
  since: string;
  /** `YYYY-MM-DD` after which it may be removed; omitted until decided. */
  sunset?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const logger = new Logger('Deprecation');

export function assertDeprecationInfo(owner: string, info: DeprecationInfo): void {
  if (!DATE.test(info.since) || (info.sunset !== undefined && !DATE.test(info.sunset))) {
    throw new Error(`${owner}: deprecation dates must be YYYY-MM-DD`);
  }
}

/** RFC 9745 `Deprecation` (`@<epoch seconds>`) and RFC 8594 `Sunset` (HTTP date) header values. */
export function deprecationHeaders(info: DeprecationInfo): Record<string, string> {
  const at = (date: string) => new Date(`${date}T00:00:00+07:00`);
  return {
    Deprecation: `@${Math.floor(at(info.since).getTime() / 1000)}`,
    ...(info.sunset && { Sunset: at(info.sunset).toUTCString() }),
  };
}

/**
 * The deprecated-usage counter: one structured log line per call of a deprecated operation or use
 * of a deprecated request field. A deprecated route is removed only after these lines stay at zero
 * for 7 days in the integration environment.
 */
export function logDeprecatedUse(operationId: string, field?: string): void {
  logger.warn({ event: 'deprecated_operation_called', operationId, ...(field && { field }) });
}

/** Sends the deprecation headers and counts every call of a deprecated operation. */
@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const found = this.reflector.get<(DeprecationInfo & { operationId: string }) | undefined>(
      DEPRECATION_METADATA,
      context.getHandler(),
    );
    if (found && context.getType() === 'http') {
      const res = context.switchToHttp().getResponse<Response>();
      for (const [name, value] of Object.entries(deprecationHeaders(found))) res.setHeader(name, value);
      logDeprecatedUse(found.operationId);
    }
    return next.handle();
  }
}

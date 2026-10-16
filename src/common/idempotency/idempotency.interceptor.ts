import { createHash } from 'node:crypto';

import { actorKey } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
  RequestMethod,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { type Request, type Response } from 'express';
import { catchError, from, mergeMap, type Observable, of, throwError } from 'rxjs';

import { DomainException } from '../errors/domain.exception';
import {
  IDEMPOTENCY_LOCK_SECONDS,
  IDEMPOTENCY_STORE,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency.store';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_METADATA, type IdempotentMode } from './idempotent.decorator';

/** Any RFC 4122 / 9562 textual uuid (every version and variant, nil and max included) — the key is opaque. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Response headers worth replaying; everything else is recomputed per request. */
const REPLAYED_HEADERS = ['location', 'etag'];
export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replayed';

/** Canonical JSON (sorted keys) so the same payload always hashes the same. */
export function fingerprintOf(body: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(body ?? null)))
    .digest('hex');
}

/**
 * Enforces `@Idempotent()` (contract §3):
 * - missing/invalid key → 400; same key + different body → 422; same key still running → 409;
 * - same key + same body after success → the stored response, with `Idempotent-Replayed: true`.
 * Failed attempts release the key, so the client may retry with the same key.
 * Keys are scoped per actor, method and path.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const mode = this.reflector.get<IdempotentMode | undefined>(IDEMPOTENT_METADATA, context.getHandler());
    if (!mode || context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const header = req.headers[IDEMPOTENCY_KEY_HEADER];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    if (!idempotencyKey) {
      if (mode === 'optional') return next.handle();
      throw new DomainException('idempotency.key_required');
    }
    if (!UUID.test(idempotencyKey)) throw new DomainException('idempotency.key_invalid');

    const storeKey = [actorKeyOf(req), req.method, req.path, idempotencyKey.toLowerCase()].join('|');
    const fingerprint = fingerprintOf(req.body);
    const status = this.successStatus(context);

    return from(this.store.begin(storeKey, fingerprint, IDEMPOTENCY_LOCK_SECONDS)).pipe(
      mergeMap((claim) => {
        if (!claim.acquired) {
          const existing = claim.existing;
          if (existing.fingerprint !== fingerprint) throw new DomainException('idempotency.key_reused');
          if (existing.state === 'in_progress') throw new DomainException('idempotency.in_progress');
          for (const [name, value] of Object.entries(existing.response.headers)) res.setHeader(name, value);
          res.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
          return of(existing.response.body);
        }

        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            const response: StoredResponse = { status, body: body ?? null, headers: replayableHeaders(res) };
            await this.store.complete(storeKey, fingerprint, response, IDEMPOTENCY_TTL_SECONDS);
            return body;
          }),
          catchError((error: unknown) =>
            from(this.store.release(storeKey)).pipe(mergeMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  /** The status Nest will send: `@HttpCode()` or the method default (201 for POST, else 200). */
  private successStatus(context: ExecutionContext): number {
    const explicit = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    if (explicit) return explicit;
    const method = this.reflector.get<RequestMethod | undefined>(METHOD_METADATA, context.getHandler());
    return method === RequestMethod.POST ? HttpStatus.CREATED : HttpStatus.OK;
  }
}

function replayableHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of REPLAYED_HEADERS) {
    const value = res.getHeader(name);
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

/** Keys are scoped to the authenticated principal; anonymous callers share one scope. */
function actorKeyOf(_req: Request): string {
  return actorKey(RequestContext.actor());
}

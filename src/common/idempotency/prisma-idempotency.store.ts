import { PrismaService } from '@database/prisma.service';
import { Injectable } from '@nestjs/common';

import {
  type BeginResult,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency.store';

interface Row {
  status: 'in_progress' | 'completed';
  fingerprint: string;
  response_status: number | null;
  response_headers: Record<string, string> | null;
  response_body: unknown;
}

/** Store keys are `actor|METHOD|path|<uuid>` (IdempotencyInterceptor); the table keys them as (scope, key). */
export function splitStoreKey(storeKey: string): { scope: string; key: string } {
  const at = storeKey.lastIndexOf('|');
  if (at <= 0) throw new Error('idempotency store key must be "<scope>|<uuid>"');
  return { scope: storeKey.slice(0, at), key: storeKey.slice(at + 1) };
}

/**
 * Durable idempotency store on `platform.idempotency_key` (contract §3, schema-design §3.2.5): the source of
 * truth behind the Redis fast path in DATA_STORES_MODE=real. Fingerprints are sha256 hex, stored as bytea.
 * Reference: getpack-api's store, adapted to the v2 table name.
 */
@Injectable()
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly prisma: PrismaService) {}

  async begin(storeKey: string, fingerprint: string, lockSeconds: number): Promise<BeginResult> {
    const { scope, key } = splitStoreKey(storeKey);
    // Claims a new key, or takes over one whose lock or retention has run out (crashed attempt).
    const claimed = await this.prisma.$queryRaw<{ claimed: number }[]>`
      INSERT INTO platform.idempotency_key (scope, key, request_sha256, status, locked_until, expires_at)
      VALUES (${scope}, ${key}::uuid, decode(${fingerprint}, 'hex'), 'in_progress',
              now() + make_interval(secs => ${lockSeconds}), now() + make_interval(secs => ${lockSeconds}))
      ON CONFLICT (scope, key) DO UPDATE
         SET request_sha256 = EXCLUDED.request_sha256, status = 'in_progress',
             response_status = NULL, response_headers = NULL, response_body = NULL,
             locked_until = EXCLUDED.locked_until, expires_at = EXCLUDED.expires_at,
             created_at = now(), updated_at = now()
       WHERE platform.idempotency_key.expires_at <= now()
      RETURNING 1 AS claimed`;
    if (claimed.length > 0) return { acquired: true };

    const [row] = await this.prisma.$queryRaw<Row[]>`
      SELECT status::text AS status, encode(request_sha256, 'hex') AS fingerprint,
             response_status, response_headers, response_body
        FROM platform.idempotency_key WHERE scope = ${scope} AND key = ${key}::uuid`;
    // Deleted between the two statements (purge): claim again.
    if (!row) return this.begin(storeKey, fingerprint, lockSeconds);
    return { acquired: false, existing: toRecord(row) };
  }

  async complete(
    storeKey: string,
    fingerprint: string,
    response: StoredResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const { scope, key } = splitStoreKey(storeKey);
    await this.prisma.$executeRaw`
      INSERT INTO platform.idempotency_key (scope, key, request_sha256, status, response_status, response_headers,
                                            response_body, expires_at)
      VALUES (${scope}, ${key}::uuid, decode(${fingerprint}, 'hex'), 'completed', ${response.status},
              ${JSON.stringify(response.headers)}::jsonb, ${JSON.stringify(response.body ?? null)}::jsonb,
              now() + make_interval(secs => ${ttlSeconds}))
      ON CONFLICT (scope, key) DO UPDATE
         SET request_sha256 = EXCLUDED.request_sha256, status = 'completed',
             response_status = EXCLUDED.response_status, response_headers = EXCLUDED.response_headers,
             response_body = EXCLUDED.response_body, locked_until = NULL,
             expires_at = EXCLUDED.expires_at, updated_at = now()`;
  }

  async release(storeKey: string): Promise<void> {
    const { scope, key } = splitStoreKey(storeKey);
    await this.prisma.$executeRaw`
      DELETE FROM platform.idempotency_key WHERE scope = ${scope} AND key = ${key}::uuid AND status = 'in_progress'`;
  }

  /** Deletes keys past their retention; the worker schedules it (B1.3). Returns the number deleted. */
  purgeExpired(): Promise<number> {
    return this.prisma.$executeRaw`DELETE FROM platform.idempotency_key WHERE expires_at <= now()`;
  }
}

function toRecord(row: Row): IdempotencyRecord {
  if (row.status === 'in_progress') return { state: 'in_progress', fingerprint: row.fingerprint };
  return {
    state: 'completed',
    fingerprint: row.fingerprint,
    response: {
      status: row.response_status ?? 200,
      body: row.response_body,
      headers: row.response_headers ?? {},
    },
  };
}

import { createHmac, timingSafeEqual } from 'node:crypto';

import { DEV_FIELD_HASH_KEY } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';

const key = () =>
  createHmac('sha256', process.env.FIELD_HASH_KEY ?? DEV_FIELD_HASH_KEY)
    .update('cursor')
    .digest();

/**
 * Opaque, signed feed cursors (schema-design §4.5: cursors are HMAC-signed with the tenant id). The binding (tenant
 * id, or user id for per-user feeds) is part of the MAC: a cursor minted for another tenant does not verify and is
 * answered with 404 (contract §8 — a cross-tenant cursor is a 404 like any other id); a damaged cursor is 400.
 */
export function encodeCursor(binding: string, position: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify(position)).toString('base64url');
  const mac = createHmac('sha256', key()).update(`${binding}|${body}`).digest('base64url').slice(0, 22);
  return `${body}.${mac}`;
}

export function decodeCursor(binding: string, cursor: string | undefined): Record<string, string> | null {
  if (!cursor) return null;
  const [body, mac] = cursor.split('.');
  if (!body || !mac) throw new DomainException('pagination.cursor_invalid');
  let position: Record<string, string>;
  try {
    position = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, string>;
  } catch {
    throw new DomainException('pagination.cursor_invalid');
  }
  const expected = createHmac('sha256', key()).update(`${binding}|${body}`).digest('base64url').slice(0, 22);
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainException('http.not_found');
  return position;
}

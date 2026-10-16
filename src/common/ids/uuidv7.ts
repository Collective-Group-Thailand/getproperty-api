import { createHash, randomBytes } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 9562 UUID version 7 (48-bit Unix ms timestamp + random), the same format as PostgreSQL 18's
 * `uuidv7()`. Used where the id must be known before the insert (domain event envelopes).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** getproperty namespace for name-based ids (random, fixed forever). */
const GETPROPERTY_NAMESPACE = Buffer.from('3c9b7d2e5a1f4e8ab6c0d4e2f7a9b1c3', 'hex');

/**
 * RFC 9562 UUID version 5 (SHA-1, name-based) in the getproperty namespace: a stable uuid for rows that
 * have a natural key but no public id (e.g. `feature_flags.key` or a tariff version key as a domain-event aggregate id).
 */
export function nameUuid(name: string): string {
  const hash = createHash('sha1').update(GETPROPERTY_NAMESPACE).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

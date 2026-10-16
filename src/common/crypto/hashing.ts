import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Prisma maps `bytea` to `Uint8Array<ArrayBuffer>`; Node's `Buffer` must be copied into one. */
export function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buffer.length));
  out.set(buffer);
  return out;
}

export const sha256 = (value: string | Buffer): Uint8Array<ArrayBuffer> =>
  bytes(createHash('sha256').update(value).digest());

export const hmacSha256 = (key: string, value: string): Uint8Array<ArrayBuffer> =>
  bytes(createHmac('sha256', key).update(value, 'utf8').digest());

/** Constant-time comparison of two digests. */
export function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

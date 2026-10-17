import { createHash, randomBytes, randomInt } from 'node:crypto';

import { bytes } from '@common/crypto/hashing';

/** A numeric one-time code (SMS OTP: 6 digits, contract §4) from a CSPRNG. */
export function numericCode(digits = 6): string {
  return randomInt(0, 10 ** digits)
    .toString()
    .padStart(digits, '0');
}

/** An opaque bearer secret (refresh tokens, invitation and enrollment codes): 32 random bytes, base64url. */
export function opaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Human-typable provisioning / invitation code: 4 groups of 4 from an unambiguous alphabet. */
export function readableCode(groups = 4): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = Array.from({ length: groups * 4 }, () => alphabet[randomInt(0, alphabet.length)]!);
  return Array.from({ length: groups }, (_, i) => chars.slice(i * 4, i * 4 + 4).join('')).join('-');
}

/** sha256 of an opaque token, as stored (`refresh_token_hash`). Tokens are high-entropy: no key needed. */
export const tokenHash = (token: string): Uint8Array<ArrayBuffer> =>
  bytes(createHash('sha256').update(token, 'utf8').digest());

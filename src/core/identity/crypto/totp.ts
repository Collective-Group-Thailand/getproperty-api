import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s steps, 6 digits) — the second factor of platform staff (mandatory) and of
 * operators who opt in (contract §4). Secrets are 20 random bytes, shown once as base32 / otpauth URI and stored
 * encrypted with the platform key (`platform.user_credential.totp_secret_enc`).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, '0');
}

export function totpAt(secretBase32: string, at: Date): string {
  return hotp(base32Decode(secretBase32), Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS));
}

/**
 * Checks a code against the current step ± `window` steps. Returns the matched step (callers store the last
 * accepted step to refuse replays within the window) or null.
 */
export function verifyTotp(secretBase32: string, code: string, at: Date, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = Buffer.from(hotp(secret, step + delta));
    if (timingSafeEqual(expected, Buffer.from(code))) return step + delta;
  }
  return null;
}

export function otpauthUri(secretBase32: string, account: string, issuer = 'getproperty'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

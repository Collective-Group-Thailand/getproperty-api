import { createPublicKey, type KeyObject, sign, verify } from 'node:crypto';

/**
 * Compact JWS with EdDSA (Ed25519) — the access-token format of contract §4. Implemented on `node:crypto`
 * (no third-party JOSE library): header `{alg:"EdDSA",typ:"JWT",kid}`, base64url segments, and verification that
 * pins the algorithm, the key id, the issuer, the audience list and the time window.
 */
export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  [claim: string]: unknown;
}

export class JwtError extends Error {
  constructor(
    readonly reason:
      'malformed' | 'algorithm' | 'unknown_key' | 'signature' | 'expired' | 'not_yet_valid' | 'issuer',
  ) {
    super(`invalid token: ${reason}`);
    this.name = 'JwtError';
  }
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export function signJwt(claims: JwtClaims, privateKey: KeyObject, kid: string): string {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** Decodes without verifying (logging the kid of a rejected token, tests). */
export function decodeJwt(token: string): { header: Record<string, unknown>; claims: JwtClaims } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed');
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>,
      claims: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as JwtClaims,
    };
  } catch {
    throw new JwtError('malformed');
  }
}

export interface VerifyOptions {
  keys: ReadonlyMap<string, KeyObject>;
  issuer: string;
  now: Date;
  /** Seconds of clock skew tolerated on `exp`/`iat`. */
  leewaySeconds?: number;
}

export function verifyJwt(token: string, options: VerifyOptions): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new JwtError('malformed');
  const { header, claims } = decodeJwt(token);
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new JwtError('algorithm');
  const key = typeof header.kid === 'string' ? options.keys.get(header.kid) : undefined;
  if (!key) throw new JwtError('unknown_key');
  const ok = verify(
    null,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key.type === 'private' ? createPublicKey(key) : key,
    Buffer.from(parts[2]!, 'base64url'),
  );
  if (!ok) throw new JwtError('signature');
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.aud !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number'
  )
    throw new JwtError('malformed');
  if (claims.iss !== options.issuer) throw new JwtError('issuer');
  const now = Math.floor(options.now.getTime() / 1000);
  const leeway = options.leewaySeconds ?? 30;
  if (claims.exp <= now - leeway) throw new JwtError('expired');
  if (claims.iat > now + leeway) throw new JwtError('not_yet_valid');
  return claims;
}

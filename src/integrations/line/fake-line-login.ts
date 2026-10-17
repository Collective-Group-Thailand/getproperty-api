import { type LineIdTokenClaims, type LineLoginPort } from './line-login.port';

const PREFIX = 'fake-line.';

/** Builds an id token the fake accepts (tests, `pnpm dev`): `fake-line.<base64url(claims)>`. */
export function fakeLineIdToken(claims: Partial<LineIdTokenClaims> & { sub: string }): string {
  const full: LineIdTokenClaims = {
    aud: 'fake-channel',
    exp: Math.floor(Date.now() / 1000) + 600,
    name: 'LINE Test',
    ...claims,
  };
  return PREFIX + Buffer.from(JSON.stringify(full)).toString('base64url');
}

/** Accepts tokens built by `fakeLineIdToken` that have not expired; everything else is invalid. */
export class FakeLineLogin implements LineLoginPort {
  readonly mode = 'fake' as const;

  verifyIdToken(idToken: string): Promise<LineIdTokenClaims | null> {
    if (!idToken.startsWith(PREFIX)) return Promise.resolve(null);
    try {
      const claims = JSON.parse(
        Buffer.from(idToken.slice(PREFIX.length), 'base64url').toString('utf8'),
      ) as LineIdTokenClaims;
      if (typeof claims.sub !== 'string' || claims.exp * 1000 <= Date.now()) return Promise.resolve(null);
      return Promise.resolve(claims);
    } catch {
      return Promise.resolve(null);
    }
  }
}

export const LINE_LOGIN = Symbol('LINE_LOGIN');

/** Verified claims of a LINE Login / LIFF id token (OpenID Connect). */
export interface LineIdTokenClaims {
  /** LINE user id (per provider) — `core.user_identity.provider_subject`. */
  sub: string;
  /** Channel id the token was issued for. */
  aud: string;
  name?: string;
  picture?: string;
  email?: string;
  exp: number;
}

export interface LineLoginPort {
  readonly mode: 'fake' | 'real';
  /** Verifies the id token with LINE; null when it is invalid, expired or for another channel. */
  verifyIdToken(idToken: string): Promise<LineIdTokenClaims | null>;
}

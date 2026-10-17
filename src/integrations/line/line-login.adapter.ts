import { providerFetch } from '../http/provider-http';
import { type LineIdTokenClaims, type LineLoginPort } from './line-login.port';

/**
 * LINE Login id-token verification through LINE's verify endpoint (`POST https://api.line.me/oauth2/v2.1/verify`,
 * form `id_token` + `client_id`); the channel id is read from the token's `aud` and must be one of the configured
 * LIFF channels (resident, technician).
 * // UNVERIFIED against live provider: written from the LINE Login v2.1 API reference.
 */
export class LineLoginAdapter implements LineLoginPort {
  readonly mode = 'real' as const;

  constructor(
    private readonly channelIds: readonly string[],
    private readonly baseUrl = 'https://api.line.me',
  ) {}

  async verifyIdToken(idToken: string): Promise<LineIdTokenClaims | null> {
    const aud = this.unverifiedAudience(idToken);
    if (!aud || !this.channelIds.includes(aud)) return null;
    const response = await providerFetch({
      provider: 'line-login',
      url: `${this.baseUrl}/oauth2/v2.1/verify`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: aud }),
      },
      retries: 1,
    });
    if (response.status === 400) return null;
    if (!response.ok) return null;
    const claims = (await response.json()) as LineIdTokenClaims & { iss?: string };
    if (claims.iss !== 'https://access.line.me' || claims.aud !== aud || typeof claims.sub !== 'string')
      return null;
    return claims;
  }

  private unverifiedAudience(idToken: string): string | null {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
        aud?: unknown;
      };
      return typeof payload.aud === 'string' ? payload.aud : null;
    } catch {
      return null;
    }
  }
}

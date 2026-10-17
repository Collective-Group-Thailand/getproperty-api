import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { REDIS, type RedisClient } from '@database/redis.module';
import { Inject, Injectable } from '@nestjs/common';

import { type Audience } from '../../surfaces/surfaces';
import { CLOCK, type Clock } from '../clock/clock';
import { type JwtClaims, JwtError, signJwt, verifyJwt } from './crypto/jwt';
import { SigningKeys } from './signing-keys';

export interface AccessClaims extends JwtClaims {
  aud: Audience;
  /** Session family id (stable for one sign-in; rotation keeps it). */
  sid: string;
  /** Scopes (contract §4). */
  scp: string[];
  /** Authentication methods. */
  amr?: string[];
  /** Device tokens: tenant and building of the gateway. */
  tid?: string;
  bid?: string;
}

export interface IssuedAccess {
  token: string;
  expiresAt: Date;
}

const revokedKey = (familyId: string) => `auth:revoked-family:${familyId}`;

/**
 * Access tokens (contract §4): EdDSA JWTs with `sub`, `aud`, `sid`, `scp`, 10–15 min (`ACCESS_TOKEN_TTL_SECONDS`;
 * devices `DEVICE_ACCESS_TOKEN_TTL_SECONDS`). A logout or reuse detection marks the family revoked in Redis for one
 * token lifetime, so already-issued access tokens stop working at once.
 */
@Injectable()
export class TokenService {
  readonly issuer: string;

  constructor(
    private readonly keys: SigningKeys,
    private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.issuer = `${config.get('PUBLIC_API_BASE_URL')}/v1/auth`;
  }

  ttlSeconds(audience: Audience): number {
    return audience === 'device'
      ? this.config.get('DEVICE_ACCESS_TOKEN_TTL_SECONDS')
      : this.config.get('ACCESS_TOKEN_TTL_SECONDS');
  }

  issue(input: {
    sub: string;
    aud: Audience;
    sid: string;
    scopes: string[];
    amr?: string[];
    tid?: string;
    bid?: string;
  }): IssuedAccess {
    const now = this.clock.now();
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + this.ttlSeconds(input.aud);
    const claims: AccessClaims = {
      iss: this.issuer,
      sub: input.sub,
      aud: input.aud,
      sid: input.sid,
      scp: input.scopes,
      iat,
      exp,
      jti: uuidv7(now.getTime()),
      ...(input.amr ? { amr: input.amr } : {}),
      ...(input.tid ? { tid: input.tid } : {}),
      ...(input.bid ? { bid: input.bid } : {}),
    };
    return { token: signJwt(claims, this.keys.privateKey, this.keys.kid), expiresAt: new Date(exp * 1000) };
  }

  /** Verifies signature, issuer and lifetime; 401 `auth.unauthenticated` otherwise. */
  async verify(token: string): Promise<AccessClaims> {
    let claims: AccessClaims;
    try {
      claims = verifyJwt(token, {
        keys: this.keys.verificationKeys,
        issuer: this.issuer,
        now: this.clock.now(),
      }) as AccessClaims;
    } catch (error) {
      if (error instanceof JwtError) throw new DomainException('auth.unauthenticated');
      throw error;
    }
    if (typeof claims.sid !== 'string' || !Array.isArray(claims.scp))
      throw new DomainException('auth.unauthenticated');
    if (await this.redis.get(revokedKey(claims.sid))) throw new DomainException('auth.unauthenticated');
    return claims;
  }

  /** Marks a session family revoked for the lifetime of any access token it may still have. */
  async markFamilyRevoked(familyId: string): Promise<void> {
    const ttl = Math.max(
      this.config.get('ACCESS_TOKEN_TTL_SECONDS'),
      this.config.get('DEVICE_ACCESS_TOKEN_TTL_SECONDS'),
    );
    await this.redis.set(revokedKey(familyId), '1', 'EX', ttl + 60);
  }
}

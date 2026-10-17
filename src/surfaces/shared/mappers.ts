import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { toBangkokIso } from '@common/time/bangkok';

import { type TokenPair } from '../../core/identity/auth.service';
import { type OtpRequestResult } from '../../core/identity/otp.service';
import { type OtpChallengeDto, SubjectType, TokenAudience, type TokenPairDto } from './auth.dto';

export const iso = (d: Date): string => toBangkokIso(d);
export const isoOrNull = (d: Date | null | undefined): string | null => (d ? toBangkokIso(d) : null);
export const dateOnly = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

export function tokenPairDto(pair: TokenPair): TokenPairDto {
  return {
    accessToken: pair.accessToken,
    accessTokenExpiresAt: iso(pair.accessTokenExpiresAt),
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAt: iso(pair.refreshTokenExpiresAt),
    subject: {
      id: pair.subject.id,
      type: pair.subject.type as SubjectType,
      audience: pair.subject.audience as TokenAudience,
      roles: pair.subject.roles,
      permissions: pair.subject.permissions,
      scopes: pair.subject.scopes,
    },
  };
}

export function otpChallengeDto(r: OtpRequestResult): OtpChallengeDto {
  return {
    challengeId: r.challengeId,
    expiresAt: iso(r.expiresAt),
    resendAvailableAt: iso(r.resendAvailableAt),
  };
}

/** Per-route limits on credential endpoints (per client IP); overridable for test runs. */
export const AUTH_RATE_LIMIT = () => Number(process.env.AUTH_THROTTLE_LIMIT ?? 10);

/** Id of the signed-in user (401 otherwise). */
export function currentUserId(): string {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return actor.publicId;
}

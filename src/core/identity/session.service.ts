import { RequestContext } from '@common/context/request-context';
import { sameDigest } from '@common/crypto/hashing';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AppConfig } from '@config/app-config';
import { type Tx } from '@database/prisma.service';
import { type Audience, type AuthSession, type SessionRevokeReason } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { opaqueToken, tokenHash } from './crypto/secrets';

export interface NewSession {
  session: AuthSession;
  refreshToken: string;
}

export type ClaimResult =
  | { kind: 'ok'; session: AuthSession }
  | { kind: 'reused'; familyId: string; userId: string | null; deviceId: string | null }
  | { kind: 'invalid' };

/**
 * Refresh tokens (contract §4): opaque 256-bit secrets, stored as sha256 in `platform.auth_session` (gp_platform
 * only). One row per token; the family (`family_id` = the access token's `sid`) is one sign-in. Rotation is
 * single-use: a token is claimed by `rotated_at IS NULL` under a row lock; presenting an already rotated token is
 * **reuse** and revokes the whole family. The family keeps the absolute expiry of the sign-in.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  familyTtlMs(audience: Audience): number {
    if (audience === 'platform') return this.config.get('PLATFORM_REFRESH_TOKEN_TTL_HOURS') * 3_600_000;
    if (audience === 'device') return this.config.get('DEVICE_REFRESH_TOKEN_TTL_DAYS') * 86_400_000;
    return this.config.get('REFRESH_TOKEN_TTL_DAYS') * 86_400_000;
  }

  /** Starts a new family (a sign-in). `tx` must be a platform transaction. */
  async start(
    tx: Tx,
    input: { audience: Audience; userId?: string; deviceId?: string; scopes: string[] },
  ): Promise<NewSession> {
    const now = this.clock.now();
    return this.insert(tx, {
      audience: input.audience,
      userId: input.userId ?? null,
      deviceId: input.deviceId ?? null,
      familyId: uuidv7(now.getTime()),
      parentTokenHash: null,
      expiresAt: new Date(now.getTime() + this.familyTtlMs(input.audience)),
      scopes: input.scopes,
    });
  }

  /** Claims `refreshToken` for rotation (FOR UPDATE). Reuse is reported, not thrown, so the caller can revoke and commit. */
  async claim(tx: Tx, refreshToken: string): Promise<ClaimResult> {
    const hash = tokenHash(refreshToken);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM platform.auth_session WHERE refresh_token_hash = ${Buffer.from(hash)} FOR UPDATE`;
    if (rows.length === 0) return { kind: 'invalid' };
    const session = await tx.authSession.findUniqueOrThrow({ where: { id: rows[0]!.id } });
    if (!sameDigest(session.refreshTokenHash, hash)) return { kind: 'invalid' };
    const now = this.clock.now();
    if (session.rotatedAt)
      return {
        kind: 'reused',
        familyId: session.familyId,
        userId: session.userId,
        deviceId: session.deviceId,
      };
    if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) return { kind: 'invalid' };
    return { kind: 'ok', session };
  }

  /** Rotates a claimed token: marks it used and issues the next token of the family with fresh scopes. */
  async rotate(tx: Tx, previous: AuthSession, scopes: string[]): Promise<NewSession> {
    const now = this.clock.now();
    const updated = await tx.authSession.updateMany({
      where: { id: previous.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: now, lastUsedAt: now },
    });
    if (updated.count !== 1) throw new DomainException('auth.refresh_invalid');
    return this.insert(tx, {
      audience: previous.audience,
      userId: previous.userId,
      deviceId: previous.deviceId,
      familyId: previous.familyId,
      parentTokenHash: previous.refreshTokenHash,
      expiresAt: previous.expiresAt,
      scopes,
    });
  }

  async revokeFamily(tx: Tx, familyId: string, reason: SessionRevokeReason): Promise<number> {
    const now = this.clock.now();
    const result = await tx.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason },
    });
    return result.count;
  }

  /** Every open family of a user (password change, account disabled, admin action). */
  async revokeUser(
    tx: Tx,
    userId: string,
    reason: SessionRevokeReason,
    keepFamily?: string,
  ): Promise<string[]> {
    const where = { userId, revokedAt: null, ...(keepFamily ? { familyId: { not: keepFamily } } : {}) };
    const families = await tx.authSession.findMany({
      where,
      distinct: ['familyId'],
      select: { familyId: true },
    });
    await tx.authSession.updateMany({ where, data: { revokedAt: this.clock.now(), revokeReason: reason } });
    return families.map((f) => f.familyId);
  }

  private async insert(
    tx: Tx,
    data: {
      audience: Audience;
      userId: string | null;
      deviceId: string | null;
      familyId: string;
      parentTokenHash: Uint8Array<ArrayBuffer> | null;
      expiresAt: Date;
      scopes: string[];
    },
  ): Promise<NewSession> {
    const refreshToken = opaqueToken();
    const ctx = RequestContext.current();
    const session = await tx.authSession.create({
      data: {
        ...data,
        refreshTokenHash: tokenHash(refreshToken),
        issuedAt: this.clock.now(),
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      },
    });
    return { session, refreshToken };
  }
}

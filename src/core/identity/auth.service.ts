import { LINE_LOGIN, type LineLoginPort } from '@collective/integrations/line';
import { RequestContext } from '@common/context/request-context';
import { FieldEncryption } from '@common/crypto/field-encryption';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { type Tx } from '@database/prisma.service';
import { REDIS, type RedisClient } from '@database/redis.module';
import { TenantTx } from '@database/tenant-tx';
import { type UserAccount } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { InvitationService } from '../tenancy/invitation.service';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from './crypto/password';
import { opaqueToken, tokenHash } from './crypto/secrets';
import { generateTotpSecret, otpauthUri, verifyTotp } from './crypto/totp';
import { type OtpRequestResult, OtpService } from './otp.service';
import { maskPhone } from './phone';
import { SessionService } from './session.service';
import { type Subject, SubjectService } from './subjects.service';
import { TokenService } from './token.service';

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  subject: Subject;
}

const ENROLL_TTL_SECONDS = 600;
const enrollKey = (token: string) => `auth:totp-enroll:${Buffer.from(tokenHash(token)).toString('hex')}`;
const totpUsedKey = (userId: string, step: number) => `auth:totp-used:${userId}:${step}`;

/**
 * Sign-in for every audience (contract §4, ADR-0003): operators by SMS OTP (primary) or email + password (+ TOTP when
 * enrolled); residents and technicians by LINE id token (primary) or SMS OTP magic link; platform staff by email +
 * password + mandatory TOTP; refresh with rotation and reuse detection; logout. Identity lookups run as gp_platform.
 * Every outcome is audited (`auth.login`, `auth.login_failed`, `auth.refresh_reuse_detected`, `auth.logout`).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: TenantTx,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly subjects: SubjectService,
    private readonly otp: OtpService,
    private readonly invitations: InvitationService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly hasher: LookupHasher,
    private readonly platformKey: FieldEncryption,
    private readonly config: AppConfig,
    @Inject(LINE_LOGIN) private readonly line: LineLoginPort,
    @Inject(REDIS) private readonly redis: RedisClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // -------------------------------------------------------------------------------------------------- helpers

  private userByPhone(tx: Tx, phone: string) {
    return tx.userAccount.findUnique({ where: { phoneHash: this.hasher.phone(phone) } });
  }

  private async issue(tx: Tx, subject: Subject, amr: string[], user?: UserAccount): Promise<TokenPair> {
    const { session, refreshToken } = await this.sessions.start(tx, {
      audience: subject.audience,
      ...(subject.type === 'device' ? { deviceId: subject.id } : { userId: subject.id }),
      scopes: subject.scopes,
    });
    const access = this.tokens.issue({
      sub: subject.id,
      aud: subject.audience,
      sid: session.familyId,
      scopes: subject.scopes,
      amr,
      ...(subject.tenantId ? { tid: subject.tenantId } : {}),
      ...(subject.buildingId ? { bid: subject.buildingId } : {}),
    });
    if (user)
      await tx.userAccount.update({ where: { id: user.id }, data: { lastLoginAt: this.clock.now() } });
    RequestContext.setActor(
      subject.type === 'device'
        ? {
            type: 'device',
            publicId: subject.id,
            audience: 'device',
            tenantId: subject.tenantId!,
            buildingId: subject.buildingId!,
            scopes: subject.scopes,
          }
        : {
            type: 'user',
            publicId: subject.id,
            audience: subject.audience as Exclude<Subject['audience'], 'device'>,
            sessionId: session.familyId,
            scopes: subject.scopes,
            amr,
          },
    );
    await this.audit.record(tx, {
      action: subject.type === 'device' ? 'auth.device_bootstrapped' : 'auth.login',
      tenantId: null,
      subjectType: subject.type === 'device' ? 'smart.device' : 'core.user_account',
      subjectId: subject.id,
      metadata: { audience: subject.audience, amr, sessionId: session.familyId },
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      subject,
    };
  }

  private async loginFailed(reason: string, metadata: Record<string, string | null> = {}): Promise<void> {
    await this.audit.recordAlone({
      action: 'auth.login_failed',
      outcome: 'denied',
      metadata: { reason, ...metadata },
    });
  }

  /**
   * Operator tokens for a user who just became a member (landlord self-signup, B7.1): the same subject, scopes and
   * audit as an operator sign-in with `amr` naming the identity used.
   */
  async issueOperator(tx: Tx, user: UserAccount, amr: string[]): Promise<TokenPair> {
    const subject = await this.subjects.operator(tx, user.id);
    if (subject.tenantIds.length === 0) throw new DomainException('auth.no_access');
    const { tenantIds: _t, ...rest } = subject;
    return this.issue(tx, rest, amr, user);
  }

  /** `POST /v1/public/signup/landlord/otp`: a sign-up code for any phone (D-251: no account or invitation needed). */
  landlordOtpRequest(phone: string, language?: string): Promise<OtpRequestResult> {
    return this.otp.request({ purpose: 'landlord_signup', phone, send: true, language });
  }

  // ------------------------------------------------------------------------------------------- operators

  /** `POST /v1/auth/operator/otp/request`: sends a code when the phone belongs to an operator or has an invitation. */
  async operatorOtpRequest(phone: string, language?: string): Promise<OtpRequestResult> {
    const eligible = await this.db.platform(async (tx) => {
      const user = await this.userByPhone(tx, phone);
      if (user && user.status === 'active') {
        const n = await tx.membership.count({
          where: { userId: user.id, status: 'active', deletedAt: null },
        });
        if (n > 0) return true;
      }
      return false;
    });
    const invited = eligible || (await this.invitations.pendingForPhone(phone));
    return this.otp.request({ purpose: 'operator_login', phone, send: invited, language });
  }

  async operatorOtpVerify(challengeId: string, code: string, invitationCode?: string): Promise<TokenPair> {
    const challenge = await this.otp.verify({ challengeId, code, purpose: 'operator_login' });
    return this.db.platform(async (tx) => {
      const now = this.clock.now();
      let user = await this.userByPhone(tx, challenge.phoneE164);
      if (!user && invitationCode) {
        user = await tx.userAccount.create({
          data: {
            displayName: maskPhone(challenge.phoneE164),
            phoneE164: challenge.phoneE164,
            phoneHash: this.hasher.phone(challenge.phoneE164),
            phoneVerifiedAt: now,
          },
        });
      }
      if (!user) throw new DomainException('auth.no_access');
      if (user.status !== 'active') throw new DomainException('auth.account_disabled');
      if (!user.phoneVerifiedAt)
        user = await tx.userAccount.update({ where: { id: user.id }, data: { phoneVerifiedAt: now } });
      if (invitationCode) await this.invitations.accept(tx, invitationCode, user);
      const subject = await this.subjects.operator(tx, user.id);
      if (subject.tenantIds.length === 0) throw new DomainException('auth.no_access');
      const { tenantIds: _t, ...rest } = subject;
      return this.issue(tx, rest, ['otp'], user);
    });
  }

  /** `POST /v1/auth/operator/login`: email + password (+ TOTP when the operator enrolled one). */
  async operatorPasswordLogin(email: string, password: string, totpCode?: string): Promise<TokenPair> {
    const user = await this.checkPassword(email, password, totpCode, false);
    return this.db.platform(async (tx) => {
      const subject = await this.subjects.operator(tx, user.account.id);
      if (subject.tenantIds.length === 0) throw new DomainException('auth.no_access');
      const { tenantIds: _t, ...rest } = subject;
      return this.issue(tx, rest, user.totpEnabled ? ['pwd', 'totp'] : ['pwd'], user.account);
    });
  }

  // -------------------------------------------------------------------------------------------- platform

  /** `POST /v1/auth/platform/login`: email + password + TOTP (mandatory; 403 with an enrolment token when missing). */
  async platformLogin(email: string, password: string, totpCode?: string): Promise<TokenPair> {
    const user = await this.checkPassword(email, password, totpCode, true);
    return this.db.platform(async (tx) => {
      const subject = await this.subjects.platform(tx, user.account.id);
      if (subject.roles.length === 0) throw new DomainException('auth.no_access');
      return this.issue(tx, subject, ['pwd', 'totp'], user.account);
    });
  }

  /** `POST /v1/auth/platform/totp/enroll`: a new secret for the user behind the enrolment token. */
  async platformTotpEnroll(enrollmentToken: string): Promise<{ secret: string; otpauthUri: string }> {
    const userId = await this.redis.get(enrollKey(enrollmentToken));
    if (!userId) throw new DomainException('auth.unauthenticated');
    const secret = generateTotpSecret();
    const account = await this.db.platform(async (tx) => {
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      await tx.userCredential.update({
        where: { userId },
        data: { totpSecretEnc: this.platformKey.encrypt(secret, `totp:${userId}`), totpEnabledAt: null },
      });
      return user;
    });
    return { secret, otpauthUri: otpauthUri(secret, account.email ?? account.id) };
  }

  /** `POST /v1/auth/platform/totp/activate`: confirms the first code, enables TOTP and signs in. */
  async platformTotpActivate(enrollmentToken: string, code: string): Promise<TokenPair> {
    const userId = await this.redis.get(enrollKey(enrollmentToken));
    if (!userId) throw new DomainException('auth.unauthenticated');
    return this.db.platform(async (tx) => {
      const credential = await tx.userCredential.findUnique({ where: { userId } });
      if (!credential?.totpSecretEnc) throw new DomainException('auth.totp_invalid');
      const secret = this.platformKey.decrypt(credential.totpSecretEnc, `totp:${userId}`);
      if (verifyTotp(secret, code, this.clock.now()) === null) throw new DomainException('auth.totp_invalid');
      await tx.userCredential.update({ where: { userId }, data: { totpEnabledAt: this.clock.now() } });
      await this.redis.del(enrollKey(enrollmentToken));
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      await this.audit.record(tx, {
        action: 'auth.totp_enabled',
        subjectType: 'core.user_account',
        subjectId: userId,
      });
      const subject = await this.subjects.platform(tx, userId);
      if (subject.roles.length === 0) throw new DomainException('auth.no_access');
      return this.issue(tx, subject, ['pwd', 'totp'], user);
    });
  }

  /** Password + TOTP checks with lockout (LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES). */
  private async checkPassword(
    email: string,
    password: string,
    totpCode: string | undefined,
    totpMandatory: boolean,
  ): Promise<{ account: UserAccount; totpEnabled: boolean }> {
    const now = this.clock.now();
    const found = await this.db.platform(async (tx) => {
      const account = await tx.userAccount.findUnique({ where: { email } });
      const credential = account
        ? await tx.userCredential.findUnique({ where: { userId: account.id } })
        : null;
      return { account, credential };
    });
    const { account, credential } = found;
    if (!account || !credential?.passwordHash) {
      await verifyPassword(
        password,
        '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
      await this.loginFailed('unknown_or_no_password');
      throw new DomainException('auth.invalid_credentials');
    }
    if (account.status !== 'active') throw new DomainException('auth.account_disabled');
    if (credential.lockedUntil && credential.lockedUntil.getTime() > now.getTime()) {
      const wait = Math.ceil((credential.lockedUntil.getTime() - now.getTime()) / 1000);
      throw new DomainException('auth.account_locked', { headers: { 'Retry-After': String(wait) } });
    }
    const ok = await verifyPassword(password, credential.passwordHash);
    if (!ok) {
      await this.failedAttempt(account.id, credential.failedLoginCount + 1, now);
      throw new DomainException('auth.invalid_credentials');
    }
    const totpEnabled = Boolean(credential.totpEnabledAt && credential.totpSecretEnc);
    if (totpMandatory && !totpEnabled) {
      const enrollmentToken = opaqueToken(24);
      await this.redis.set(enrollKey(enrollmentToken), account.id, 'EX', ENROLL_TTL_SECONDS);
      throw new DomainException('auth.totp_enrollment_required', { extensions: { enrollmentToken } });
    }
    if (totpEnabled) {
      if (!totpCode) throw new DomainException('auth.totp_required');
      const secret = this.platformKey.decrypt(credential.totpSecretEnc!, `totp:${account.id}`);
      const step = verifyTotp(secret, totpCode, now);
      const replay =
        step !== null && (await this.redis.set(totpUsedKey(account.id, step), '1', 'EX', 120, 'NX')) === null;
      if (step === null || replay) {
        await this.failedAttempt(account.id, credential.failedLoginCount + 1, now);
        throw new DomainException('auth.totp_invalid');
      }
    }
    const rehash = needsRehash(credential.passwordHash) ? await hashPassword(password) : undefined;
    await this.db.platform((tx) =>
      tx.userCredential.update({
        where: { userId: account.id },
        data: { failedLoginCount: 0, lockedUntil: null, ...(rehash ? { passwordHash: rehash } : {}) },
      }),
    );
    return { account, totpEnabled };
  }

  private async failedAttempt(userId: string, count: number, now: Date): Promise<void> {
    const lock = count >= this.config.get('LOGIN_MAX_FAILURES');
    await this.db.platform((tx) =>
      tx.userCredential.update({
        where: { userId },
        data: {
          failedLoginCount: lock ? 0 : count,
          ...(lock
            ? { lockedUntil: new Date(now.getTime() + this.config.get('LOGIN_LOCK_MINUTES') * 60_000) }
            : {}),
        },
      }),
    );
    await this.loginFailed(lock ? 'locked' : 'bad_password_or_totp', { userId });
  }

  /**
   * `PUT /v1/owner/me/password`: an operator opts into email + password sign-in (contract §4). The email must not
   * belong to another account; every other sign-in of the user ends.
   */
  async operatorSetPassword(
    userId: string,
    keepFamily: string | undefined,
    input: { email?: string; password: string },
  ) {
    const revoked = await this.db.platform(async (tx) => {
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      if (input.email && input.email.toLowerCase() !== (user.email ?? '').toLowerCase()) {
        const other = await tx.userAccount.findUnique({ where: { email: input.email } });
        if (other && other.id !== userId) throw new DomainException('http.conflict');
        await tx.userAccount.update({
          where: { id: userId },
          data: { email: input.email, emailVerifiedAt: null },
        });
      } else if (!user.email && !input.email) {
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'email', code: 'required', message: 'an email is required to sign in with a password' },
          ],
        });
      }
      return this.setPassword(tx, userId, input.password, keepFamily);
    });
    for (const f of revoked) await this.tokens.markFamilyRevoked(f);
  }

  /** `POST /v1/owner/me/totp/setup`: a new secret, stored disabled until `operatorTotpEnable` confirms a code. */
  async operatorTotpSetup(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const secret = generateTotpSecret();
    const user = await this.db.platform(async (tx) => {
      const credential = await tx.userCredential.findUnique({ where: { userId } });
      if (!credential?.passwordHash) throw new DomainException('auth.invalid_credentials');
      await tx.userCredential.update({
        where: { userId },
        data: { totpSecretEnc: this.platformKey.encrypt(secret, `totp:${userId}`), totpEnabledAt: null },
      });
      return tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
    });
    return { secret, otpauthUri: otpauthUri(secret, user.email ?? user.id) };
  }

  async operatorTotpEnable(userId: string, code: string): Promise<void> {
    await this.db.platform(async (tx) => {
      const credential = await tx.userCredential.findUnique({ where: { userId } });
      if (!credential?.totpSecretEnc) throw new DomainException('auth.totp_invalid');
      const secret = this.platformKey.decrypt(credential.totpSecretEnc, `totp:${userId}`);
      if (verifyTotp(secret, code, this.clock.now()) === null) throw new DomainException('auth.totp_invalid');
      await tx.userCredential.update({ where: { userId }, data: { totpEnabledAt: this.clock.now() } });
      await this.audit.record(tx, {
        action: 'auth.totp_enabled',
        subjectType: 'core.user_account',
        subjectId: userId,
      });
    });
  }

  /** Sets a password (operators who opt in; platform users at creation). Revokes the user's other sessions. */
  async setPassword(tx: Tx, userId: string, password: string, keepFamily?: string): Promise<string[]> {
    const problems = passwordProblems(password);
    if (problems.length) throw new DomainException('auth.weak_password');
    const passwordHash = await hashPassword(password);
    const now = this.clock.now();
    await tx.userCredential.upsert({
      where: { userId },
      create: { userId, passwordHash, passwordChangedAt: now },
      update: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    await this.audit.record(tx, {
      action: 'auth.password_changed',
      subjectType: 'core.user_account',
      subjectId: userId,
    });
    return this.sessions.revokeUser(tx, userId, 'password_change', keepFamily);
  }

  // ------------------------------------------------------------------------------ residents & technicians

  /** LINE id token → user (created on first sign-in) → parties carrying that LINE id are linked (`line_match`). */
  async lineLogin(idToken: string, audience: 'resident' | 'technician'): Promise<TokenPair> {
    const claims = await this.line.verifyIdToken(idToken).catch(() => null);
    if (!claims) {
      await this.loginFailed('line_token_invalid', { audience });
      throw new DomainException('auth.line_token_invalid');
    }
    return this.db.platform(async (tx) => {
      const now = this.clock.now();
      const identity = await tx.userIdentity.findUnique({
        where: { provider_providerSubject: { provider: 'line', providerSubject: claims.sub } },
      });
      let user = identity
        ? await tx.userAccount.findUniqueOrThrow({ where: { id: identity.userId } })
        : await tx.userAccount.findUnique({ where: { lineUserId: claims.sub } });
      if (!user) {
        user = await tx.userAccount.create({
          data: { displayName: claims.name?.slice(0, 200) || 'LINE', lineUserId: claims.sub, language: 'th' },
        });
      }
      if (user.status !== 'active') throw new DomainException('auth.account_disabled');
      if (identity) {
        await tx.userIdentity.update({
          where: { id: identity.id },
          data: { lastSeenAt: now, displayName: claims.name ?? null, pictureUrl: claims.picture ?? null },
        });
      } else {
        await tx.userIdentity.create({
          data: {
            userId: user.id,
            provider: 'line',
            providerSubject: claims.sub,
            displayName: claims.name ?? null,
            pictureUrl: claims.picture ?? null,
            linkedAt: now,
            lastSeenAt: now,
            rawClaims: { aud: claims.aud },
          },
        });
      }
      if (!user.lineUserId)
        user = await tx.userAccount.update({ where: { id: user.id }, data: { lineUserId: claims.sub } });
      // parties carrying this LINE id (a lessee, or a technician the owner entered) are linked to the login
      await this.linkParties(tx, user, { lineUserId: claims.sub });
      const subject =
        audience === 'resident'
          ? await this.subjects.resident(tx, user.id)
          : await this.subjects.technician(tx, user.id);
      return this.issue(tx, subject, ['line'], user);
    });
  }

  /** Resident OTP: a code is sent when the phone is known (an account, or a party an operator entered). */
  async residentOtpRequest(phone: string, language?: string): Promise<OtpRequestResult> {
    const eligible = await this.db.platform(async (tx) => {
      if (await this.userByPhone(tx, phone)) return true;
      return (await tx.party.count({ where: { phoneE164: phone, deletedAt: null, anonymisedAt: null } })) > 0;
    });
    const residentUrl = this.config.get('PUBLIC_RESIDENT_APP_URL');
    return this.otp.request({
      purpose: 'resident_login',
      phone,
      send: eligible,
      language,
      // The challenge id lets the link complete the sign-in in another browser; the code stays in the SMS text.
      vars: { link: `${residentUrl}/auth/otp?c={challengeId}` },
    });
  }

  /**
   * Technician OTP (B5.1): a code is sent when the phone belongs to an account or to a party an operator entered
   * (the external technician of a work order); the same answer otherwise (no enumeration).
   */
  async technicianOtpRequest(phone: string, language?: string): Promise<OtpRequestResult> {
    const eligible = await this.db.platform(async (tx) => {
      if (await this.userByPhone(tx, phone)) return true;
      return (await tx.party.count({ where: { phoneE164: phone, deletedAt: null, anonymisedAt: null } })) > 0;
    });
    return this.otp.request({ purpose: 'technician_login', phone, send: eligible, language });
  }

  /** Technician OTP verify: the verified phone links the parties carrying it; `technician` tokens with work orders. */
  async technicianOtpVerify(challengeId: string, code: string): Promise<TokenPair> {
    const challenge = await this.otp.verify({ challengeId, code, purpose: 'technician_login' });
    return this.db.platform(async (tx) => {
      const user = await this.phoneUser(tx, challenge.phoneE164);
      await this.requestPhoneLinks(tx, user, challenge.phoneE164);
      return this.issue(tx, await this.subjects.technician(tx, user.id), ['otp'], user);
    });
  }

  /** The account of a verified phone (created on first use from the party an operator entered). */
  private async phoneUser(tx: Tx, phone: string): Promise<UserAccount> {
    const now = this.clock.now();
    let user = await this.userByPhone(tx, phone);
    if (!user) {
      const party = await tx.party.findFirst({
        where: { phoneE164: phone, deletedAt: null, anonymisedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      user = await tx.userAccount.create({
        data: {
          displayName: party?.displayName ?? maskPhone(phone),
          phoneE164: phone,
          phoneHash: this.hasher.phone(phone),
          phoneVerifiedAt: now,
          language: party?.language ?? 'th',
        },
      });
    } else if (!user.phoneVerifiedAt) {
      user = await tx.userAccount.update({ where: { id: user.id }, data: { phoneVerifiedAt: now } });
    }
    if (user.status !== 'active') throw new DomainException('auth.account_disabled');
    return user;
  }

  async residentOtpVerify(challengeId: string, code: string): Promise<TokenPair> {
    const challenge = await this.otp.verify({ challengeId, code, purpose: 'resident_login' });
    return this.db.platform(async (tx) => {
      const now = this.clock.now();
      let user = await this.userByPhone(tx, challenge.phoneE164);
      if (!user) {
        const party = await tx.party.findFirst({
          where: { phoneE164: challenge.phoneE164, deletedAt: null, anonymisedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        user = await tx.userAccount.create({
          data: {
            displayName: party?.displayName ?? maskPhone(challenge.phoneE164),
            phoneE164: challenge.phoneE164,
            phoneHash: this.hasher.phone(challenge.phoneE164),
            phoneVerifiedAt: now,
            language: party?.language ?? 'th',
          },
        });
      } else if (!user.phoneVerifiedAt) {
        user = await tx.userAccount.update({ where: { id: user.id }, data: { phoneVerifiedAt: now } });
      }
      if (user.status !== 'active') throw new DomainException('auth.account_disabled');
      await this.requestPhoneLinks(tx, user, challenge.phoneE164);
      return this.issue(tx, await this.subjects.resident(tx, user.id), ['otp'], user);
    });
  }

  /**
   * Links the parties (in any tenant) that carry this LINE id and are not linked yet (D-061): a party gets a LINE id
   * from an accepted invitation (D-175) or from the owner entering a technician's LINE — never by typing a phone.
   */
  private async linkParties(tx: Tx, user: UserAccount, by: { lineUserId: string }): Promise<void> {
    const parties = await tx.party.findMany({
      where: {
        deletedAt: null,
        anonymisedAt: null,
        lineUserId: by.lineUserId,
        userLinks: { none: { userId: user.id, state: 'active' } },
      },
      select: { id: true, tenantId: true },
    });
    for (const p of parties) {
      await tx.partyUserLink.create({
        data: {
          tenantId: p.tenantId,
          partyId: p.id,
          userId: user.id,
          linkedAt: this.clock.now(),
          linkedVia: 'line_match',
        },
      });
    }
  }

  /**
   * Review #6 (D-226): a verified phone that matches parties an operator typed is not proof that this person is that
   * party (typos, recycled Thai numbers). Each match becomes a pending link request the tenant's Owner confirms —
   * nothing of the party (bills, bank account, door codes) is reachable until then. Audited
   * `party.link_requested`; the Owner is told (`party.link_requested`).
   */
  private async requestPhoneLinks(tx: Tx, user: UserAccount, phone: string): Promise<void> {
    const parties = await tx.party.findMany({
      where: {
        deletedAt: null,
        anonymisedAt: null,
        phoneE164: phone,
        userLinks: { none: { userId: user.id, state: 'active' } },
        partyLinkRequestParty: { none: { userId: user.id, state: 'pending' } },
      },
      select: { id: true, tenantId: true },
    });
    for (const p of parties) {
      const request = await tx.partyLinkRequest.create({
        data: { tenantId: p.tenantId, partyId: p.id, userId: user.id, requestedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        action: 'party.link_requested',
        tenantId: p.tenantId,
        subjectType: 'ops.party_link_request',
        subjectId: request.id,
        metadata: { partyId: p.id, userId: user.id, via: 'phone_match' },
      });
      await this.events.record(tx, {
        type: 'party.link_requested',
        aggregateType: 'party',
        aggregateId: p.id,
        tenantId: p.tenantId,
        payload: { partyId: p.id, requestId: request.id, userId: user.id },
      });
    }
  }

  // ---------------------------------------------------------------------------------------- refresh, logout

  /**
   * `POST /v1/auth/refresh`: single-use rotation; reuse revokes the family (401 `auth.refresh_reused`), except the
   * immediately previous token again within the grace window (D-229), which answers the same successor.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const outcome = await this.db.platform(async (tx) => {
      const claim = await this.sessions.claim(tx, refreshToken);
      if (claim.kind === 'invalid') return { error: 'auth.refresh_invalid' as const };
      if (claim.kind === 'reused') {
        await this.sessions.revokeFamily(tx, claim.familyId, 'reuse_detected');
        await this.audit.record(tx, {
          action: 'auth.refresh_reuse_detected',
          outcome: 'denied',
          subjectType: claim.deviceId ? 'smart.device' : 'core.user_account',
          subjectId: claim.deviceId ?? claim.userId,
          metadata: { sessionId: claim.familyId },
        });
        return { error: 'auth.refresh_reused' as const, familyId: claim.familyId };
      }
      const previous = claim.session;
      const subject = await this.subjects.forSession(tx, previous);
      if (!subject) {
        await this.sessions.revokeFamily(tx, previous.familyId, 'admin');
        return { error: 'auth.refresh_invalid' as const, familyId: previous.familyId };
      }
      // D-229: a concurrent refresh with the same token inside the grace window gets the same successor (already
      // issued, scopes as rotated); a fresh access token of the family goes with it. Nothing is rotated again.
      const next =
        claim.kind === 'grace'
          ? { session: claim.session, refreshToken: claim.refreshToken }
          : await this.sessions.rotate(tx, previous, subject.scopes, refreshToken);
      const scopes = claim.kind === 'grace' ? claim.session.scopes : subject.scopes;
      if (claim.kind === 'grace') {
        await tx.authSession.update({
          where: { id: claim.session.id },
          data: { lastUsedAt: this.clock.now() },
        });
        await this.audit.record(tx, {
          action: 'auth.refresh_grace_reused',
          subjectType: previous.deviceId ? 'smart.device' : 'core.user_account',
          subjectId: previous.deviceId ?? previous.userId,
          metadata: { sessionId: previous.familyId },
        });
      }
      const access = this.tokens.issue({
        sub: subject.id,
        aud: subject.audience,
        sid: previous.familyId,
        scopes,
        ...(subject.tenantId ? { tid: subject.tenantId } : {}),
        ...(subject.buildingId ? { bid: subject.buildingId } : {}),
      });
      const { tenantIds: _t, ...clean } = subject as Subject & { tenantIds?: string[] };
      return {
        pair: {
          accessToken: access.token,
          accessTokenExpiresAt: access.expiresAt,
          refreshToken: next.refreshToken,
          refreshTokenExpiresAt: next.session.expiresAt,
          subject: clean,
        } satisfies TokenPair,
      };
    });
    if ('pair' in outcome && outcome.pair) return outcome.pair;
    const failure = outcome as { error: 'auth.refresh_invalid' | 'auth.refresh_reused'; familyId?: string };
    if (failure.familyId) await this.tokens.markFamilyRevoked(failure.familyId);
    throw new DomainException(failure.error);
  }

  /** `POST /v1/auth/logout`: ends the sign-in (family) of the refresh token; idempotent. */
  async logout(refreshToken: string): Promise<void> {
    const familyId = await this.db.platform(async (tx) => {
      const session = await tx.authSession.findUnique({
        where: { refreshTokenHash: tokenHash(refreshToken) },
      });
      if (!session) return null;
      await this.sessions.revokeFamily(tx, session.familyId, 'logout');
      await this.audit.record(tx, {
        action: 'auth.logout',
        subjectType: session.deviceId ? 'smart.device' : 'core.user_account',
        subjectId: session.deviceId ?? session.userId,
        metadata: { sessionId: session.familyId },
      });
      return session.familyId;
    });
    if (familyId) await this.tokens.markFamilyRevoked(familyId);
  }

  /** Device sign-in after bootstrap (called by the device bootstrap service inside its transaction). */
  issueDevice(tx: Tx, device: { id: string; tenantId: string; buildingId: string }): Promise<TokenPair> {
    return this.issue(tx, this.subjects.device(device), ['csr']);
  }
}

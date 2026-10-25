import { FIREBASE_VERIFIER, type FirebaseVerifier } from '@collective/integrations/identity';
import { LINE_LOGIN, type LineLoginPort } from '@collective/integrations/line';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type IdentityProvider, type UserAccount, type UserIdentity } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { AuthService, type TokenPair } from './auth.service';
import { OtpService } from './otp.service';
import { maskPhone } from './phone';

/** An identity token from Google / Apple (Firebase Authentication) or LINE Login / LIFF (D-255). */
export interface TokenIdentity {
  provider: 'line' | 'firebase_google' | 'firebase_apple';
  idToken: string;
}

/** Every way to prove who you are (D-255): the token providers, and an SMS code of a given flow. */
export type AnyIdentity = TokenIdentity | { provider: 'phone_otp'; challengeId: string; code: string };

/** What a provider vouched for. */
export interface VerifiedIdentity {
  provider: IdentityProvider;
  subject: string;
  phone?: string;
  displayName?: string;
  pictureUrl?: string;
  email?: string;
  emailVerified?: boolean;
}

export type SignInAudience = 'operator' | 'resident' | 'prospect';

/** One sign-in method of an account, as the profile lists it. */
export interface AccountIdentity {
  id: string;
  provider: IdentityProvider;
  displayName: string | null;
  email: string | null;
  linkedAt: Date;
  lastSeenAt: Date | null;
  /** Google and Apple may be removed here; LINE and the phone carry notifications and party links (D-061). */
  removable: boolean;
}

export interface AccountIdentities {
  phoneMasked: string | null;
  hasPassword: boolean;
  identities: AccountIdentity[];
}

const REMOVABLE: readonly IdentityProvider[] = ['firebase_google', 'firebase_apple'];

/**
 * Sign-in with Google, Apple and LINE on every audience (D-255, D-283) and the identities of an account.
 *
 * - **Operators** and **residents** sign in only with an identity already linked to their account (linked on the
 *   profile, or created by the landlord sign-up / LINE sign-in): a token never creates an operator, and an identity
 *   is never merged into an account by e-mail — no takeover through an address someone else controls.
 * - **Prospects** (and landlords signing up, B7.1) get an account on first use; a Google / Apple account needs a
 *   verified e-mail no other account holds (the login needs a contact).
 * - In production the verifiers check real tokens (Firebase project, LINE channel ids); with fakes
 *   (`INTEGRATIONS_MODE=fake`) they accept the readable fake tokens — the whole flow runs before the OAuth clients exist.
 */
@Injectable()
export class IdentitySignInService {
  constructor(
    private readonly db: TenantTx,
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    private readonly hasher: LookupHasher,
    private readonly audit: AuditService,
    @Inject(LINE_LOGIN) private readonly line: LineLoginPort,
    @Inject(FIREBASE_VERIFIER) private readonly firebase: FirebaseVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Checks the token (or the SMS code of `otpPurpose`) with its provider; audited and refused when invalid. */
  async verify(
    identity: AnyIdentity,
    flow: string,
    otpPurpose?: 'landlord_signup',
  ): Promise<VerifiedIdentity> {
    switch (identity.provider) {
      case 'phone_otp': {
        if (!otpPurpose) throw new DomainException('validation.failed');
        const challenge = await this.otp.verify({
          challengeId: identity.challengeId,
          code: identity.code,
          purpose: otpPurpose,
        });
        return { provider: 'phone_otp', subject: challenge.phoneE164, phone: challenge.phoneE164 };
      }
      case 'line': {
        const claims = await this.line.verifyIdToken(identity.idToken).catch(() => null);
        if (!claims) return this.fail('auth.line_token_invalid', identity.provider, flow);
        return {
          provider: 'line',
          subject: claims.sub,
          displayName: claims.name,
          pictureUrl: claims.picture,
        };
      }
      default: {
        const verified = await this.firebase.verifyIdToken(identity.idToken).catch((error: unknown) => {
          if ((error as { name?: string }).name === 'ProviderUnavailableError') throw error;
          return null;
        });
        if (!verified || verified.provider !== identity.provider)
          return this.fail('auth.identity_token_invalid', identity.provider, flow);
        return {
          provider: verified.provider as IdentityProvider,
          subject: verified.subject,
          displayName: verified.displayName,
          pictureUrl: verified.pictureUrl,
          email: verified.email,
          emailVerified: verified.emailVerified,
        };
      }
    }
  }

  private async fail(
    code: 'auth.line_token_invalid' | 'auth.identity_token_invalid' | 'auth.identity_not_linked',
    provider: string,
    flow: string,
  ): Promise<never> {
    await this.audit.recordAlone({
      action: 'auth.login_failed',
      outcome: 'denied',
      metadata: { reason: code, provider, flow },
    });
    throw new DomainException(code);
  }

  /** The identity row of a verified identity, if any. */
  private identityRow(tx: Tx, v: VerifiedIdentity): Promise<UserIdentity | null> {
    return tx.userIdentity.findUnique({
      where: { provider_providerSubject: { provider: v.provider, providerSubject: v.subject } },
    });
  }

  /** The account an identity already belongs to: by its identity row, then by the phone or LINE id it carries. */
  private async existing(tx: Tx, v: VerifiedIdentity, row: UserIdentity | null): Promise<UserAccount | null> {
    if (row) return tx.userAccount.findUnique({ where: { id: row.userId } });
    if (v.phone) {
      const user = await tx.userAccount.findUnique({ where: { phoneHash: this.hasher.phone(v.phone) } });
      if (user) return user;
    }
    if (v.provider === 'line') return tx.userAccount.findUnique({ where: { lineUserId: v.subject } });
    return null;
  }

  /** Records the identity on the account (first use) or refreshes it. */
  private async remember(
    tx: Tx,
    user: UserAccount,
    v: VerifiedIdentity,
    row: UserIdentity | null,
  ): Promise<void> {
    const now = this.clock.now();
    if (row) {
      await tx.userIdentity.update({
        where: { id: row.id },
        data: {
          lastSeenAt: now,
          ...(v.displayName ? { displayName: v.displayName } : {}),
          ...(v.pictureUrl ? { pictureUrl: v.pictureUrl } : {}),
        },
      });
      return;
    }
    await tx.userIdentity.create({
      data: {
        userId: user.id,
        provider: v.provider,
        providerSubject: v.subject,
        displayName: v.displayName ?? null,
        pictureUrl: v.pictureUrl ?? null,
        linkedAt: now,
        lastSeenAt: now,
        rawClaims: v.email ? { email: v.email, emailVerified: v.emailVerified ?? false } : {},
      },
    });
    if (v.provider === 'line' && !user.lineUserId)
      await tx.userAccount.update({ where: { id: user.id }, data: { lineUserId: v.subject } });
  }

  /**
   * The account of a verified identity, created when `create` (landlord sign-up, prospects). A new Google / Apple
   * account takes the verified e-mail only when no other account holds it.
   */
  async accountFor(
    tx: Tx,
    v: VerifiedIdentity,
    options: { create: boolean; language?: string },
  ): Promise<UserAccount | null> {
    const now = this.clock.now();
    const row = await this.identityRow(tx, v);
    let user = await this.existing(tx, v, row);
    if (!user) {
      if (!options.create) return null;
      let email: string | undefined;
      if (!v.phone && v.provider !== 'line') {
        if (!v.email || !v.emailVerified) throw new DomainException('auth.identity_contact_required');
        if (await tx.userAccount.findUnique({ where: { email: v.email } }))
          throw new DomainException('auth.identity_email_in_use');
        email = v.email;
      }
      user = await tx.userAccount.create({
        data: {
          displayName: (v.displayName ?? (v.phone ? maskPhone(v.phone) : 'getproperty')).slice(0, 200),
          language: options.language ?? 'th',
          ...(v.phone
            ? { phoneE164: v.phone, phoneHash: this.hasher.phone(v.phone), phoneVerifiedAt: now }
            : {}),
          ...(v.provider === 'line' ? { lineUserId: v.subject } : {}),
          ...(email ? { email, emailVerifiedAt: now } : {}),
        },
      });
    }
    if (user.status !== 'active') throw new DomainException('auth.account_disabled');
    if (v.phone && !user.phoneVerifiedAt)
      user = await tx.userAccount.update({ where: { id: user.id }, data: { phoneVerifiedAt: now } });
    await this.remember(tx, user, v, row);
    return user;
  }

  /**
   * `POST /v1/auth/{operator|resident|prospect}/identity`: tokens of the audience for a Google / Apple / LINE
   * identity. Operators and residents need the identity linked already (`auth.identity_not_linked`, audited);
   * prospects get an account on first use.
   */
  async signIn(audience: SignInAudience, identity: TokenIdentity): Promise<TokenPair> {
    const flow = `${audience}_sign_in`;
    const v = await this.verify(identity, flow);
    const found = await this.db.platform(async (tx) => {
      const user = await this.accountFor(tx, v, { create: audience === 'prospect' });
      if (!user) return null;
      return this.auth.issueAs(tx, user, audience, [v.provider]);
    });
    return found ?? this.fail('auth.identity_not_linked', v.provider, flow);
  }

  // ------------------------------------------------------------------------------------------ profile

  async list(userId: string): Promise<AccountIdentities> {
    return this.db.platform(async (tx) => {
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      const [rows, credential] = await Promise.all([
        tx.userIdentity.findMany({ where: { userId }, orderBy: { linkedAt: 'asc' } }),
        tx.userCredential.findUnique({ where: { userId } }),
      ]);
      return {
        phoneMasked: user.phoneE164 && user.phoneVerifiedAt ? maskPhone(user.phoneE164) : null,
        hasPassword: Boolean(credential?.passwordHash),
        identities: rows
          .filter((row) => row.provider !== 'phone_otp')
          .map((row) => {
            const claims = (row.rawClaims ?? {}) as { email?: unknown };
            return {
              id: row.id,
              provider: row.provider,
              displayName: row.displayName,
              email: typeof claims.email === 'string' ? claims.email : null,
              linkedAt: row.linkedAt,
              lastSeenAt: row.lastSeenAt,
              removable: REMOVABLE.includes(row.provider),
            };
          }),
      };
    });
  }

  /**
   * Links a Google / Apple / LINE identity to the signed-in account (`auth.identity_in_use` when another account
   * holds it — never moved). Idempotent for an identity already on this account.
   */
  async link(userId: string, identity: TokenIdentity): Promise<AccountIdentities> {
    const v = await this.verify(identity, 'identity_link');
    await this.db.platform(async (tx) => {
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      const row = await this.identityRow(tx, v);
      const holder = await this.existing(tx, v, row);
      if (holder && holder.id !== user.id) throw new DomainException('auth.identity_in_use');
      await this.remember(tx, user, v, row);
      if (!row) {
        await this.audit.record(tx, {
          action: 'auth.identity_linked',
          tenantId: null,
          subjectType: 'core.user_account',
          subjectId: user.id,
          after: { provider: v.provider },
        });
      }
    });
    return this.list(userId);
  }

  /**
   * Removes a Google / Apple identity (`auth.identity_locked` for LINE and the phone, which carry notifications and
   * party links). Another way to sign in must remain: a verified phone, a password, or another identity
   * (`auth.identity_last`).
   */
  async unlink(userId: string, identityId: string): Promise<AccountIdentities> {
    await this.db.platform(async (tx) => {
      const row = await tx.userIdentity.findFirst({ where: { id: identityId, userId } });
      if (!row) throw new DomainException('http.not_found');
      if (!REMOVABLE.includes(row.provider)) throw new DomainException('auth.identity_locked');
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      const [others, credential] = await Promise.all([
        tx.userIdentity.count({ where: { userId, id: { not: row.id }, provider: { not: 'phone_otp' } } }),
        tx.userCredential.findUnique({ where: { userId } }),
      ]);
      const remaining =
        others +
        (user.phoneVerifiedAt ? 1 : 0) +
        (credential?.passwordHash ? 1 : 0) +
        (user.lineUserId ? 1 : 0);
      if (remaining === 0) throw new DomainException('auth.identity_last');
      await tx.userIdentity.delete({ where: { id: row.id } });
      await this.audit.record(tx, {
        action: 'auth.identity_unlinked',
        tenantId: null,
        subjectType: 'core.user_account',
        subjectId: userId,
        before: { provider: row.provider },
      });
    });
    return this.list(userId);
  }
}

import { FIREBASE_VERIFIER, type FirebaseVerifier } from '@collective/integrations/identity';
import { LINE_LOGIN, type LineLoginPort } from '@collective/integrations/line';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type IdentityProvider, type Tenant, type UserAccount } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { AuthService, type TokenPair } from '../identity/auth.service';
import { OtpService } from '../identity/otp.service';
import { maskPhone } from '../identity/phone';
import { TenantDataKeys } from './data-keys.service';

/** The identity a landlord signs up with (D-255: the providers of getpack). */
export type SignupIdentity =
  | { provider: 'phone_otp'; challengeId: string; code: string }
  | { provider: 'line'; idToken: string }
  | { provider: 'firebase_google' | 'firebase_apple'; idToken: string };

export interface LandlordSignupInput {
  identity: SignupIdentity;
  /** The landlord's name as residents will see it (a person by default; company data later in settings). */
  displayName: string;
  language?: 'th' | 'en';
}

export interface LandlordSignupResult {
  created: boolean;
  tenant: Tenant;
  tokens: TokenPair;
}

interface Verified {
  provider: IdentityProvider;
  subject: string;
  phone?: string;
  displayName?: string;
  pictureUrl?: string;
  email?: string;
  emailVerified?: boolean;
}

/**
 * Self-serve landlord sign-up (B7.1, D-251, D-255): an owner of a house or condo unit signs up by phone OTP, LINE,
 * Google or Apple — no platform admin, no invitation — and gets a tenant of type `landlord` (free, D-250) with its own
 * data key, the person as its legal party and an active Owner membership, then operator tokens. Idempotent per
 * identity: a second sign-up with the same identity returns the landlord tenant it already owns. An identity is never
 * merged into another account by e-mail (no takeover through an unverified address).
 */
@Injectable()
export class LandlordSignupService {
  constructor(
    private readonly db: TenantTx,
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    private readonly keys: TenantDataKeys,
    private readonly hasher: LookupHasher,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(LINE_LOGIN) private readonly line: LineLoginPort,
    @Inject(FIREBASE_VERIFIER) private readonly firebase: FirebaseVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async verify(identity: SignupIdentity): Promise<Verified> {
    switch (identity.provider) {
      case 'phone_otp': {
        const challenge = await this.otp.verify({
          challengeId: identity.challengeId,
          code: identity.code,
          purpose: 'landlord_signup',
        });
        return { provider: 'phone_otp', subject: challenge.phoneE164, phone: challenge.phoneE164 };
      }
      case 'line': {
        const claims = await this.line.verifyIdToken(identity.idToken).catch(() => null);
        if (!claims) await this.fail('auth.line_token_invalid', identity.provider);
        return {
          provider: 'line',
          subject: claims!.sub,
          displayName: claims!.name,
          pictureUrl: claims!.picture,
        };
      }
      default: {
        const verified = await this.firebase.verifyIdToken(identity.idToken).catch((error: unknown) => {
          if ((error as { name?: string }).name === 'ProviderUnavailableError') throw error;
          return null;
        });
        if (!verified || verified.provider !== identity.provider)
          await this.fail('auth.identity_token_invalid', identity.provider);
        return {
          provider: verified!.provider as IdentityProvider,
          subject: verified!.subject,
          displayName: verified!.displayName,
          pictureUrl: verified!.pictureUrl,
          email: verified!.email,
          emailVerified: verified!.emailVerified,
        };
      }
    }
  }

  private async fail(code: 'auth.line_token_invalid' | 'auth.identity_token_invalid', provider: string) {
    await this.audit.recordAlone({
      action: 'auth.login_failed',
      outcome: 'denied',
      metadata: { reason: code, provider, flow: 'landlord_signup' },
    });
    throw new DomainException(code);
  }

  /** The account of an identity: by the identity row, then by the phone or LINE id it already carries, else new. */
  private async account(tx: Tx, v: Verified, language: string): Promise<UserAccount> {
    const now = this.clock.now();
    const identity = await tx.userIdentity.findUnique({
      where: { provider_providerSubject: { provider: v.provider, providerSubject: v.subject } },
    });
    let user = identity ? await tx.userAccount.findUnique({ where: { id: identity.userId } }) : null;
    if (!user && v.phone)
      user = await tx.userAccount.findUnique({ where: { phoneHash: this.hasher.phone(v.phone) } });
    if (!user && v.provider === 'line')
      user = await tx.userAccount.findUnique({ where: { lineUserId: v.subject } });
    let email: string | undefined;
    if (!user && !v.phone && v.provider !== 'line') {
      // A Google / Apple account needs a contact on the login (user_account_contact_check). Its verified e-mail is
      // used only when no other account holds it — an identity is never merged into an account by e-mail.
      if (!v.email || !v.emailVerified) throw new DomainException('auth.identity_contact_required');
      if (await tx.userAccount.findUnique({ where: { email: v.email } }))
        throw new DomainException('auth.identity_email_in_use');
      email = v.email;
    }
    if (!user) {
      user = await tx.userAccount.create({
        data: {
          displayName: (v.displayName ?? (v.phone ? maskPhone(v.phone) : 'getproperty')).slice(0, 200),
          language,
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
    if (identity) {
      await tx.userIdentity.update({ where: { id: identity.id }, data: { lastSeenAt: now } });
    } else {
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
    }
    return user;
  }

  async signup(input: LandlordSignupInput): Promise<LandlordSignupResult> {
    const v = await this.verify(input.identity);
    const language = input.language ?? 'th';
    return this.db.platform(async (tx) => {
      const user = await this.account(tx, v, language);
      const owned = await tx.membership.findFirst({
        where: {
          userId: user.id,
          role: 'owner',
          status: 'active',
          deletedAt: null,
          tenant: { type: 'landlord', deletedAt: null, status: { not: 'deactivated' } },
        },
        include: { tenant: true },
        orderBy: { createdAt: 'asc' },
      });
      if (owned) {
        return {
          created: false,
          tenant: owned.tenant,
          tokens: await this.auth.issueOperator(tx, user, [v.provider]),
        };
      }
      const now = this.clock.now();
      const id = uuidv7(now.getTime());
      const legalPartyId = uuidv7(now.getTime());
      const name = input.displayName.trim().slice(0, 200);
      await tx.tenant.create({
        data: {
          id,
          type: 'landlord',
          slug: `landlord-${id.replace(/-/g, '').slice(-10)}`,
          displayName: name,
          legalName: name,
          legalForm: 'person',
          defaultLanguage: language,
          createdBy: user.id,
        },
      });
      await this.keys.createFirst(tx, id);
      await tx.party.create({ data: { id: legalPartyId, tenantId: id, type: 'person', displayName: name } });
      const tenant = await tx.tenant.update({ where: { id }, data: { legalPartyId } });
      const membership = await tx.membership.create({
        data: {
          tenantId: id,
          userId: user.id,
          role: 'owner',
          status: 'active',
          joinedAt: now,
          createdBy: user.id,
        },
      });
      await this.audit.record(tx, {
        action: 'tenant.created',
        tenantId: id,
        subjectType: 'core.tenant',
        subjectId: id,
        after: {
          type: 'landlord',
          slug: tenant.slug,
          legalForm: 'person',
          source: 'self_signup',
          provider: v.provider,
        },
      });
      await this.audit.record(tx, {
        action: 'tenant.member.joined',
        tenantId: id,
        subjectType: 'core.membership',
        subjectId: membership.id,
        after: { role: 'owner', userId: user.id, via: 'self_signup' },
      });
      await this.events.record(tx, {
        type: 'tenant.created',
        aggregateType: 'tenant',
        aggregateId: id,
        tenantId: id,
        payload: { tenantId: id, type: 'landlord', plan: null, source: 'self_signup' },
      });
      return { created: true, tenant, tokens: await this.auth.issueOperator(tx, user, [v.provider]) };
    });
  }
}

import { uuidv7 } from '@common/ids/uuidv7';
import { TenantTx } from '@database/tenant-tx';
import { type Tenant } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { AuthService, type TokenPair } from '../identity/auth.service';
import { IdentitySignInService } from '../identity/identity-sign-in.service';
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
  /** G2 (D-284): estate agencies sign up the same way and get a tenant of type `agency`. */
  type?: 'landlord' | 'agency';
}

export interface LandlordSignupResult {
  created: boolean;
  tenant: Tenant;
  tokens: TokenPair;
}

/**
 * Self-serve landlord sign-up (B7.1, D-251, D-255): an owner of a house or condo unit signs up by phone OTP, LINE,
 * Google or Apple — no platform admin, no invitation — and gets a tenant of type `landlord` (free, D-250) with its own
 * data key, the person as its legal party and an active Owner membership, then operator tokens. Idempotent per
 * identity: a second sign-up with the same identity returns the landlord tenant it already owns. An identity is never
 * merged into another account by e-mail (no takeover through an unverified address).
 * G2 (D-284): an estate agency signs up the same way (`type: 'agency'`) — free, unlimited users, units and listings.
 */
@Injectable()
export class LandlordSignupService {
  constructor(
    private readonly db: TenantTx,
    private readonly auth: AuthService,
    private readonly identities: IdentitySignInService,
    private readonly keys: TenantDataKeys,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async signup(input: LandlordSignupInput): Promise<LandlordSignupResult> {
    const v = await this.identities.verify(input.identity, 'landlord_signup', 'landlord_signup');
    const language = input.language ?? 'th';
    const type = input.type ?? 'landlord';
    return this.db.platform(async (tx) => {
      const user = (await this.identities.accountFor(tx, v, { create: true, language }))!;
      const owned = await tx.membership.findFirst({
        where: {
          userId: user.id,
          role: 'owner',
          status: 'active',
          deletedAt: null,
          tenant: { type, deletedAt: null, status: { not: 'deactivated' } },
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
          type,
          slug: `${type}-${id.replace(/-/g, '').slice(-10)}`,
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
          type,
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
        payload: { tenantId: id, type, plan: null, source: 'self_signup' },
      });
      return { created: true, tenant, tokens: await this.auth.issueOperator(tx, user, [v.provider]) };
    });
  }
}

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { sameDigest } from '@common/crypto/hashing';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Invitation, type InvitationChannel } from '@generated/prisma/client';
import { SMS, type SmsPort } from '@integrations/sms/sms.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { readableCode } from '../identity/crypto/secrets';
import { maskPhone } from '../identity/phone';
import { SettingsService } from '../settings/settings.service';
import { AccessService } from './access.service';

export const TENANT_ROLES = ['owner', 'manager', 'staff', 'accountant'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export interface CreatedInvitation {
  invitation: Invitation;
  /** Shown once (QR / link channels); never stored in clear. */
  code: string;
  inviteUrl: string;
}

/**
 * Tenant-member invitations (D-145 one table with `kind`; D-061 onboarding by SMS link or QR). The code is a
 * 16-character one-time secret stored as an HMAC; it travels in the SMS (sent inline — it is a credential) or is
 * returned once to the inviting Owner for a QR/link. Accepting it after phone OTP sign-in creates or reactivates the
 * membership with the invited role and building limits. Lease-resident invitations arrive with leases (B2.3).
 */
@Injectable()
export class InvitationService extends TenantScopedRepository {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly hasher: LookupHasher,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly access: AccessService,
    private readonly config: AppConfig,
    @Inject(SMS) private readonly sms: SmsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private codeHash(code: string) {
    return this.hasher.secret('invitation', code.trim().toUpperCase());
  }

  /**
   * Inserts a member invitation inside the caller's transaction (tenant transaction from the owner console, platform
   * transaction at onboarding). Returns the one-time code and link; `sendSms` delivers it after the commit.
   */
  async insert(
    tx: Tx,
    tenantId: string,
    input: {
      role: TenantRole;
      buildingIds?: string[] | null;
      phone?: string | null;
      email?: string | null;
      channel: InvitationChannel;
    },
  ): Promise<CreatedInvitation> {
    const now = this.clock.now();
    const days = await this.settings.valueAt<number>('invitation.expiry_days', now);
    const code = readableCode(4);
    // Staff join the staff PWA (STAFF_HOST); every other role the owner console.
    const origin = this.config.get(input.role === 'staff' ? 'PUBLIC_STAFF_APP_URL' : 'PUBLIC_WEB_APP_URL');
    const inviteUrl = `${origin}/join?code=${encodeURIComponent(code)}`;
    const buildingIds = input.buildingIds?.length ? [...new Set(input.buildingIds)] : [];
    if (buildingIds.length) {
      const owned = await tx.building.count({
        where: {
          id: { in: buildingIds },
          deletedAt: null,
          OR: [{ operatorTenantId: tenantId }, { ownerTenantId: tenantId }],
        },
      });
      if (owned !== buildingIds.length) throw new DomainException('http.not_found');
    }
    if (input.phone) {
      const existing = await tx.membership.findFirst({
        where: { tenantId, deletedAt: null, status: 'active', user: { phoneE164: input.phone } },
      });
      if (existing) throw new DomainException('membership.already_member');
    }
    const actor = userIdOf(RequestContext.actor());
    const invitation = await tx.invitation.create({
      data: {
        tenantId,
        kind: 'tenant_member',
        role: input.role,
        buildingIds,
        phoneE164: input.phone ?? null,
        email: input.email ?? null,
        codeHash: this.codeHash(code),
        channel: input.channel,
        expiresAt: new Date(now.getTime() + days * 86_400_000),
        invitedBy: actor,
        createdBy: actor,
      },
    });
    await this.audit.record(tx, {
      action: 'tenant.member.invited',
      tenantId,
      subjectType: 'platform.invitation',
      subjectId: invitation.id,
      after: {
        role: input.role,
        buildingIds,
        channel: input.channel,
        phone: input.phone ? maskPhone(input.phone) : null,
      },
    });
    await this.events.record(tx, {
      type: 'tenant.member.invited',
      aggregateType: 'invitation',
      aggregateId: invitation.id,
      tenantId,
      payload: {
        invitationId: invitation.id,
        role: input.role,
        channel: input.channel,
        expiresAt: invitation.expiresAt.toISOString(),
      },
    });
    return { invitation, code, inviteUrl };
  }

  /** The SMS carrying an invitation link (a credential: sent inline, never through the event payload). */
  async sendSms(phone: string, tenantName: string, inviteUrl: string, language?: string): Promise<void> {
    const text =
      language === 'en'
        ? `You are invited to join ${tenantName} on getproperty: ${inviteUrl}`
        : `คุณได้รับคำเชิญเข้าร่วม ${tenantName} บน getproperty: ${inviteUrl}`;
    await this.sms.send(phone, text).catch((error: unknown) => {
      this.logger.error(`invitation SMS to ${maskPhone(phone)} failed: ${(error as Error).message}`);
      throw new DomainException('provider.unavailable');
    });
  }

  /** Owner console (`POST /v1/owner/invitations`); only an Owner may invite another Owner. */
  async create(
    ctx: TenantContext,
    input: {
      role: TenantRole;
      buildingIds?: string[] | null;
      phone?: string | null;
      email?: string | null;
      channel: InvitationChannel;
      language?: string;
    },
  ): Promise<CreatedInvitation> {
    if (input.role === 'owner' && ctx.role !== 'owner') throw new DomainException('auth.forbidden');
    if (input.channel === 'sms' && !input.phone)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'phone', code: 'required', message: 'phone is required for the sms channel' }],
      });
    let tenantName = '';
    const created = await this.db.tenant(ctx, async (tx) => {
      tenantName = (await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } })).displayName;
      return this.insert(tx, ctx.tenantId, input);
    });
    if (input.channel === 'sms' && input.phone)
      await this.sendSms(input.phone, tenantName, created.inviteUrl, input.language);
    return created;
  }

  /** A pending, unexpired member invitation for this phone (operator OTP eligibility). */
  async pendingForPhone(phone: string): Promise<boolean> {
    const now = this.clock.now();
    const n = await this.db.platform((tx) =>
      tx.invitation.count({
        where: { kind: 'tenant_member', state: 'pending', phoneE164: phone, expiresAt: { gt: now } },
      }),
    );
    return n > 0;
  }

  /**
   * Accepts a member invitation for `user` (platform transaction of the sign-in). The invitation's phone, when set,
   * must be the phone the user just verified.
   */
  async accept(tx: Tx, code: string, user: { id: string; phoneE164: string | null }): Promise<string> {
    const now = this.clock.now();
    const hash = this.codeHash(code);
    const invitation = await tx.invitation.findUnique({ where: { codeHash: hash } });
    if (!invitation || !sameDigest(invitation.codeHash, hash) || invitation.kind !== 'tenant_member')
      throw new DomainException('invitation.not_found');
    if (invitation.state !== 'pending' || invitation.expiresAt.getTime() <= now.getTime())
      throw new DomainException('invitation.not_pending');
    if (invitation.phoneE164 && invitation.phoneE164 !== user.phoneE164)
      throw new DomainException('invitation.not_found');
    const moduleScopes = invitation.buildingIds.length ? { buildingIds: invitation.buildingIds } : {};
    const existing = await tx.membership.findFirst({
      where: { tenantId: invitation.tenantId, userId: user.id, deletedAt: null },
    });
    const membership = existing
      ? await tx.membership.update({
          where: { id: existing.id },
          data: {
            role: invitation.role!,
            status: 'active',
            moduleScopes,
            joinedAt: now,
            removedAt: null,
            removedReason: null,
          },
        })
      : await tx.membership.create({
          data: {
            tenantId: invitation.tenantId,
            userId: user.id,
            role: invitation.role!,
            status: 'active',
            moduleScopes,
            joinedAt: now,
            createdBy: invitation.invitedBy,
          },
        });
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { state: 'accepted', acceptedAt: now, acceptedByUserId: user.id },
    });
    await this.audit.record(tx, {
      action: 'tenant.member.joined',
      tenantId: invitation.tenantId,
      subjectType: 'core.membership',
      subjectId: membership.id,
      after: { role: membership.role, invitationId: invitation.id },
    });
    await this.events.record(tx, {
      type: 'tenant.member.joined',
      aggregateType: 'membership',
      aggregateId: membership.id,
      tenantId: invitation.tenantId,
      payload: {
        membershipId: membership.id,
        userId: user.id,
        role: membership.role,
        invitationId: invitation.id,
      },
    });
    this.access.forget(user.id);
    return invitation.tenantId;
  }

  list(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.invitation.findMany({
        where: this.own(ctx, { kind: 'tenant_member' }),
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async revoke(ctx: TenantContext, invitationId: string): Promise<Invitation> {
    return this.db.tenant(ctx, async (tx) => {
      const invitation = this.found(
        await tx.invitation.findFirst({ where: this.own(ctx, { id: invitationId }) }),
      );
      if (invitation.state !== 'pending') throw new DomainException('invitation.not_pending');
      const row = await tx.invitation.update({ where: { id: invitation.id }, data: { state: 'revoked' } });
      await this.audit.record(tx, {
        action: 'tenant.invitation.revoked',
        tenantId: ctx.tenantId,
        subjectType: 'platform.invitation',
        subjectId: row.id,
      });
      return row;
    });
  }
}

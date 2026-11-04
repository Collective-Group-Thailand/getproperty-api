import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { sameDigest } from '@common/crypto/hashing';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { readableCode } from '@core/identity/crypto/secrets';
import { OtpService } from '@core/identity/otp.service';
import { maskPhone } from '@core/identity/phone';
import { ConsentService } from '@core/privacy/consent.service';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type Invitation, type InvitationChannel } from '@generated/prisma/client';
import { SMS, type SmsPort } from '@integrations/sms/sms.port';
import { Inject, Injectable, Logger } from '@nestjs/common';
import QRCode from 'qrcode';

const masked = (name: string): string =>
  name.length > 2 ? `${name.slice(0, 2)}${'•'.repeat(Math.min(6, name.length - 2))}` : name;

function userIdOf(): string {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return actor.publicId;
}

/**
 * JR (D-309 = D-J08, D-322): co-owner onboarding. The operator of a unit's register (a juristic person, or the
 * owner tenant) issues a single-use code for a **current co-owner** of the unit (`POST
 * /v1/owner/units/{unitId}/resident-invites`, `juristic.resident_invite_days`, 14 days): shown as a QR (printed
 * letters too), sent by SMS or copied as a link. The co-owner opens the resident app, gives the PDPA consents, asks for
 * an OTP that goes to **the phone of the ownership party** (never a number they type) and redeems the code with it —
 * their login is linked to the party, so the unit joins their `unit:` scopes at the next refresh. One login can hold
 * units in several tenants. A new code for the same unit and party revokes the pending one.
 */
@Injectable()
export class UnitResidentInvitationsService {
  private readonly logger = new Logger(UnitResidentInvitationsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly consents: ConsentService,
    private readonly settings: SettingsService,
    private readonly hasher: LookupHasher,
    private readonly config: AppConfig,
    @Inject(SMS) private readonly sms: SmsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private codeHash(code: string) {
    return this.hasher.secret('unit_invitation', code.trim().toUpperCase());
  }

  /** The LIFF deep link of a unit invitation (the LIFF asks for the OTP before redeeming). */
  private url(code: string): string {
    return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/link/unit?code=${encodeURIComponent(code)}`;
  }

  // ------------------------------------------------------------------------------------------------ operator

  async invite(
    ctx: TenantContext,
    unitId: string,
    input: { partyId?: string; channel: InvitationChannel; language?: string },
  ) {
    const now = this.clock.now();
    const days = await this.settings.valueAt<number>('juristic.resident_invite_days', now, {
      tenantId: ctx.tenantId,
    });
    const code = readableCode(4);
    const userId = userIdOf();
    const created = await this.db.tenant(ctx, async (tx) => {
      const unit = await tx.unit.findFirst({
        where: {
          id: unitId,
          deletedAt: null,
          ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        },
        select: { id: true, unitNo: true, buildingId: true },
      });
      if (!unit) throw new DomainException('http.not_found');
      const today = new Date(bangkokDate(now));
      const owners = await tx.unitOwnership.findMany({
        where: {
          unitId,
          tenantId: ctx.tenantId,
          validFrom: { lte: today },
          OR: [{ validTo: null }, { validTo: { gt: today } }],
        },
        select: { partyId: true },
      });
      const ownerIds = [...new Set(owners.map((o) => o.partyId))];
      const partyId = input.partyId ?? (ownerIds.length === 1 ? ownerIds[0] : undefined);
      if (!partyId)
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'partyId',
              code: ownerIds.length ? 'required' : 'notOwner',
              message: ownerIds.length
                ? 'the unit has several co-owners: choose the party to invite'
                : 'the unit has no current co-owner in the register',
            },
          ],
        });
      const party = await tx.party.findFirst({
        where: { id: partyId, tenantId: ctx.tenantId, deletedAt: null, anonymisedAt: null },
      });
      if (!party) throw new DomainException('http.not_found');
      if (!ownerIds.includes(party.id))
        throw new DomainException('validation.failed', {
          errors: [
            { path: 'partyId', code: 'notOwner', message: 'the party is not a current co-owner of the unit' },
          ],
        });
      // the redemption OTP goes to the phone of the ownership party: no phone, no invitation
      if (!party.phoneE164) throw new DomainException('invitation.phone_missing');
      await tx.invitation.updateMany({
        where: { tenantId: ctx.tenantId, kind: 'unit_resident', unitId, partyId, state: 'pending' },
        data: { state: 'revoked', updatedBy: userId, updatedAt: now },
      });
      const invitation = await tx.invitation.create({
        data: {
          tenantId: ctx.tenantId,
          kind: 'unit_resident',
          unitId,
          partyId,
          phoneE164: party.phoneE164,
          codeHash: this.codeHash(code),
          channel: input.channel,
          expiresAt: new Date(now.getTime() + days * 86_400_000),
          invitedBy: userId,
          createdAt: now,
          createdBy: userId,
          updatedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'unit.resident_invited',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'platform.invitation',
        subjectId: invitation.id,
        metadata: { unitId, partyId, channel: input.channel },
      });
      await this.events.record(tx, {
        type: 'unit.resident_invited',
        aggregateType: 'unit',
        aggregateId: unitId,
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        payload: {
          unitId,
          partyId,
          invitationId: invitation.id,
          channel: input.channel,
          expiresAt: invitation.expiresAt.toISOString(),
        },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { displayName: true },
      });
      return { invitation, party, unit, tenantName: tenant.displayName };
    });
    const url = this.url(code);
    const qrPng = await QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
    });
    if (input.channel === 'sms') {
      // the code is a credential: sent inline like the lease invitation, never through the outbox (D-061)
      const text =
        input.language === 'en'
          ? `${created.tenantName} invites you to link unit ${created.unit.unitNo} on getproperty (LINE): ${url}`
          : `${created.tenantName} เชิญคุณเชื่อมห้อง ${created.unit.unitNo} บน getproperty (LINE): ${url}`;
      await this.sms.send(created.party.phoneE164!, text).catch((error: unknown) => {
        this.logger.error(
          `unit invitation SMS to ${maskPhone(created.party.phoneE164!)} failed: ${(error as Error).message}`,
        );
        throw new DomainException('provider.unavailable');
      });
    }
    return {
      invitation: created.invitation,
      unitNo: created.unit.unitNo,
      code,
      url,
      qrPayload: url,
      qrPngDataUrl: `data:image/png;base64,${qrPng.toString('base64')}`,
    };
  }

  list(ctx: TenantContext, unitId: string): Promise<Invitation[]> {
    return this.db.tenant(ctx, async (tx) => {
      const unit = await tx.unit.findFirst({
        where: {
          id: unitId,
          deletedAt: null,
          ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
        },
        select: { id: true },
      });
      if (!unit) throw new DomainException('http.not_found');
      return tx.invitation.findMany({
        where: { tenantId: ctx.tenantId, kind: 'unit_resident', unitId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    });
  }

  // ------------------------------------------------------------------------------------------------ resident

  private async find(tx: Tx, code: string): Promise<Invitation> {
    const hash = this.codeHash(code);
    const inv = await tx.invitation.findUnique({ where: { codeHash: hash } });
    if (
      !inv ||
      !sameDigest(inv.codeHash, hash) ||
      inv.kind !== 'unit_resident' ||
      !inv.unitId ||
      !inv.partyId
    )
      throw new DomainException('invitation.not_found');
    return inv;
  }

  private pending(inv: Invitation, now: Date): void {
    if (inv.state !== 'pending' || inv.expiresAt.getTime() <= now.getTime())
      throw new DomainException('invitation.not_pending');
  }

  /** What the LIFF shows before redeeming: tenant, building, unit, a masked name and the masked phone of the OTP. */
  async preview(code: string) {
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const inv = await this.find(tx, code);
      this.pending(inv, now);
      const unit = await tx.unit.findUniqueOrThrow({
        where: { id: inv.unitId! },
        select: { unitNo: true, building: { select: { name: true } } },
      });
      const party = await tx.party.findUniqueOrThrow({
        where: { id: inv.partyId! },
        select: { displayName: true, phoneE164: true },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: inv.tenantId },
        select: { displayName: true },
      });
      return {
        tenantName: tenant.displayName,
        buildingName: unit.building.name,
        unitNo: unit.unitNo,
        partyDisplayName: masked(party.displayName),
        phoneMasked: party.phoneE164 ? maskPhone(party.phoneE164) : null,
        expiresAt: inv.expiresAt,
      };
    });
  }

  /** Sends the OTP to the phone of the ownership party (rate limits of the OTP service apply). */
  async requestOtp(code: string, language: string) {
    const now = this.clock.now();
    const target = await this.db.platform(async (tx) => {
      const inv = await this.find(tx, code);
      this.pending(inv, now);
      const party = await tx.party.findUniqueOrThrow({
        where: { id: inv.partyId! },
        select: { phoneE164: true, deletedAt: true, anonymisedAt: true },
      });
      if (!party.phoneE164 || party.deletedAt || party.anonymisedAt)
        throw new DomainException('invitation.phone_missing');
      const unit = await tx.unit.findUniqueOrThrow({ where: { id: inv.unitId! }, select: { unitNo: true } });
      return { inv, phone: party.phoneE164, unitNo: unit.unitNo };
    });
    const challenge = await this.otp.request({
      purpose: 'unit_invitation',
      phone: target.phone,
      send: true,
      subjectType: 'platform.invitation',
      subjectId: target.inv.id,
      language,
      vars: { unitNo: target.unitNo },
    });
    return { ...challenge, phoneMasked: maskPhone(target.phone) };
  }

  /**
   * Redeem (D-025, D-061, D-322): the required consents first (409 `consent.required`), a pending code (409
   * `invitation.not_pending` once used, revoked or expired), then the OTP of this invitation (401 `auth.otp_invalid` …).
   * The login is linked to the ownership party (`linked_via invitation`), the code is spent, the consents bind this
   * tenant as controller; the unit arrives with the next token refresh (`refreshRequired`).
   */
  async accept(code: string, otp: { challengeId: string; code: string }, language: string) {
    const userId = userIdOf();
    const purposes = await this.consents.purposes(['resident'], language, { type: 'user', id: userId }, null);
    const required = purposes.filter((p) => p.required);
    if (required.some((p) => p.granted !== true)) throw new DomainException('consent.required');
    const before = await this.db.platform((tx) => this.find(tx, code));
    this.pending(before, this.clock.now());
    const challenge = await this.otp.verify({ ...otp, purpose: 'unit_invitation' });
    if (challenge.subjectType !== 'platform.invitation' || challenge.subjectId !== before.id)
      throw new DomainException('auth.otp_invalid');
    const now = this.clock.now();
    const accepted = await this.db.platform(async (tx) => {
      const inv = await this.find(tx, code);
      this.pending(inv, now);
      const spent = await tx.invitation.updateMany({
        where: { id: inv.id, state: 'pending' },
        data: {
          state: 'accepted',
          acceptedAt: now,
          acceptedByUserId: userId,
          updatedBy: userId,
          updatedAt: now,
        },
      });
      if (spent.count !== 1) throw new DomainException('invitation.not_pending');
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      const party = await tx.party.findUniqueOrThrow({ where: { id: inv.partyId! } });
      if (party.lineUserId && user.lineUserId && party.lineUserId !== user.lineUserId)
        throw new DomainException('invitation.party_mismatch');
      const existing = await tx.partyUserLink.findFirst({
        where: { partyId: party.id, userId, state: 'active' },
      });
      if (!existing)
        await tx.partyUserLink.create({
          data: {
            tenantId: party.tenantId,
            partyId: party.id,
            userId,
            linkedAt: now,
            linkedVia: 'invitation',
            createdBy: userId,
          },
        });
      if (!party.lineUserId && user.lineUserId)
        await tx.party.update({
          where: { id: party.id },
          data: { lineUserId: user.lineUserId, version: { increment: 1 } },
        });
      const unit = await tx.unit.findUniqueOrThrow({
        where: { id: inv.unitId! },
        select: { id: true, buildingId: true },
      });
      await this.audit.record(tx, {
        action: 'unit.resident_linked',
        tenantId: inv.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'platform.invitation',
        subjectId: inv.id,
        metadata: { unitId: unit.id, partyId: party.id, userId, otpChallengeId: challenge.id },
      });
      await this.events.record(tx, {
        type: 'unit.resident_linked',
        aggregateType: 'unit',
        aggregateId: unit.id,
        tenantId: inv.tenantId,
        buildingId: unit.buildingId,
        payload: { unitId: unit.id, partyId: party.id, userId, invitationId: inv.id },
      });
      return { tenantId: inv.tenantId, unitId: unit.id, partyId: party.id };
    });
    // the resident's consents now also bind this tenant as controller (D-025)
    await this.consents.record(
      { type: 'user', id: userId },
      required.map((p) => ({ purposeKey: p.key, version: p.version, granted: true })),
      { channel: 'liff', language, tenantIds: [accepted.tenantId] },
    );
    return { ...accepted, refreshRequired: true, acceptedOn: bangkokDate(now) };
  }
}

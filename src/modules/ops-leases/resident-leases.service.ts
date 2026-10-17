import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { sameDigest } from '@common/crypto/hashing';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { readableCode } from '@core/identity/crypto/secrets';
import { OtpService } from '@core/identity/otp.service';
import { maskPhone } from '@core/identity/phone';
import { ConsentService } from '@core/privacy/consent.service';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type InvitationChannel, type LeaseStatus } from '@generated/prisma/client';
import { SMS, type SmsPort } from '@integrations/sms/sms.port';
import { Inject, Injectable, Logger } from '@nestjs/common';
import QRCode from 'qrcode';

import { hasRuleClauses, RULE_CLAUSE_TYPES, RULES_ACK_STATES } from './lease-rules';
import { LEASE_INCLUDE, type LeaseRow, LeasesService } from './leases.service';

/** Leases a resident may open: everything after the draft (history included), never drafts or cancelled leases. */
export const RESIDENT_VISIBLE: LeaseStatus[] = [
  'pending_signature',
  'active',
  'notice_given',
  'ending',
  'ended',
  'terminated',
];
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_SIGNATURE_BYTES = 200_000;

export interface ResidentLeaseAccess {
  ctx: TenantContext;
  lease: LeaseRow;
  /** The resident's parties on this lease (lessee / co-tenant / occupant). */
  partyIds: string[];
}

/**
 * The resident side of leases (`/v1/resident/*`, D-061, D-062, D-154): access is the token's `lease:<id>` scope
 * (contract §8) plus an active link between the resident's login and a party of the lease; the request then runs in
 * the lease's tenant (`app.tenant_id` from the path). Covers the lease views and the signed contract, e-signature
 * (phone OTP to the lessee's phone + LINE user id + the sha256 of the PDF viewed), the 30-day notice, and lease
 * invitations (create on the owner side; preview and accept on the resident side, consent first).
 */
@Injectable()
export class ResidentLeasesService {
  private readonly logger = new Logger(ResidentLeasesService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly leases: LeasesService,
    private readonly documents: DocumentsService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
    private readonly consents: ConsentService,
    private readonly settings: SettingsService,
    private readonly hasher: LookupHasher,
    private readonly config: AppConfig,
    @Inject(SMS) private readonly sms: SmsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private userId(): string {
    const actor = RequestContext.actor();
    if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
    return actor.publicId;
  }

  /** The signed-in resident's login (`core.user_account` id). */
  currentUserId(): string {
    return this.userId();
  }

  private scopes(): readonly string[] {
    const actor = RequestContext.actor();
    return actor && 'scopes' in actor ? actor.scopes : [];
  }

  /** Resolves the lease of a resident request (404 when out of scope, not linked or not visible to residents). */
  async access(leaseId: string): Promise<ResidentLeaseAccess> {
    const userId = this.userId();
    if (!this.scopes().includes(`lease:${leaseId}`)) throw new DomainException('http.not_found');
    const found = await this.db.platform(async (tx) => {
      const lease = await tx.lease.findUnique({
        where: { id: leaseId },
        select: { id: true, tenantId: true, status: true },
      });
      if (!lease || !RESIDENT_VISIBLE.includes(lease.status)) return null;
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active', tenantId: lease.tenantId },
        select: { partyId: true },
      });
      const onLease = await tx.leaseParty.findMany({
        where: { leaseId, partyId: { in: links.map((l) => l.partyId) } },
        select: { partyId: true },
      });
      return onLease.length ? { tenantId: lease.tenantId, partyIds: onLease.map((p) => p.partyId) } : null;
    });
    if (!found) throw new DomainException('http.not_found');
    const ctx: TenantContext = { tenantId: found.tenantId, source: 'path' };
    // read through gp_platform once access is proven: the resident sees the lease's building and parties even when
    // the lessor is a unit grantee that cannot read the building row (D-152)
    const lease = await this.db.platform((tx) => this.leases.load(tx, leaseId));
    return { ctx, lease, partyIds: found.partyIds };
  }

  /** Every lease of the resident's linked parties, across tenants (D-061: one LINE account, several leases). */
  async listWithParties() {
    const userId = this.userId();
    return this.db.platform(async (tx) => {
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active' },
        select: { partyId: true },
      });
      const partyIds = links.map((l) => l.partyId);
      if (!partyIds.length) return { rows: [], partyIds };
      const rows = await tx.lease.findMany({
        where: { status: { in: RESIDENT_VISIBLE }, parties: { some: { partyId: { in: partyIds } } } },
        include: { ...LEASE_INCLUDE, tenant: { select: { id: true, displayName: true } } },
        orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
      });
      return { rows, partyIds };
    });
  }

  /** Display data of the lease's tenant (the lessor) for resident views. */
  tenantOf(tenantId: string) {
    return this.db.platform((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, displayName: true } }),
    );
  }

  /** The contract to read before signing (unsigned) or the signed one; a signed URL + the sha256 to sign. */
  async contract(leaseId: string) {
    const { ctx, lease } = await this.access(leaseId);
    const documentId = lease.signedDocumentId ?? lease.contractDocumentId;
    if (!documentId) throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
    return this.db.tenant(ctx, async (tx) => {
      const doc = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
      await this.audit.record(tx, {
        action: 'document.downloaded',
        tenantId: ctx.tenantId,
        buildingId: doc.buildingId,
        subjectType: 'core.document',
        subjectId: doc.id,
        metadata: { kind: doc.kind, purpose: 'resident_contract', leaseId },
      });
      const { url, expiresAt } = await this.documents.signedUrl(doc);
      return {
        lease,
        document: doc,
        url,
        expiresAt,
        sha256: LeasesService.hex(lease.contractSha256)!,
        signed: Boolean(lease.signedDocumentId),
      };
    });
  }

  private signer(access: ResidentLeaseAccess) {
    const signers = access.lease.parties.filter((p) => p.isSigner && access.partyIds.includes(p.partyId));
    const signed = new Set(access.lease.signatures.map((s) => s.partyId));
    const next = signers.find((s) => !signed.has(s.partyId));
    if (!signers.length) throw new DomainException('lease.not_signer');
    if (!next) throw new DomainException('lease.already_signed');
    return next;
  }

  /** Step 1 of the e-signature (D-062): an SMS OTP to the signer's phone recorded by the office. */
  async requestSignatureOtp(leaseId: string, language?: string) {
    const access = await this.access(leaseId);
    if (access.lease.status !== 'pending_signature')
      throw new DomainException('lease.invalid_state', { params: { status: access.lease.status } });
    const signer = this.signer(access);
    const party = await this.db.tenant(access.ctx, (tx) =>
      tx.party.findUniqueOrThrow({ where: { id: signer.partyId } }),
    );
    if (!party.phoneE164) throw new DomainException('lease.lessee_identity_missing');
    const challenge = await this.otp.request({
      purpose: 'lease_signature',
      phone: party.phoneE164,
      send: true,
      subjectType: 'ops.lease',
      subjectId: leaseId,
      language,
    });
    return { challenge, phoneMasked: maskPhone(party.phoneE164) };
  }

  /**
   * Step 2: sign. The OTP must be for this lease, the sha256 must be the one of the contract PDF the resident opened
   * (409 `lease.contract_changed` otherwise), the drawn signature a PNG ≤ 200 KB. Stores the signature image
   * (`core.document` kind `signature`) and the evidence row (OTP challenge, LINE user id, PDF sha256, time, IP, UA).
   */
  async sign(
    leaseId: string,
    input: { challengeId: string; code: string; contractSha256: string; signaturePng: Buffer },
  ) {
    if (!input.signaturePng.subarray(0, 8).equals(PNG) || input.signaturePng.length > MAX_SIGNATURE_BYTES)
      throw new DomainException('lease.signature_invalid');
    const access = await this.access(leaseId);
    if (access.lease.status !== 'pending_signature')
      throw new DomainException('lease.invalid_state', { params: { status: access.lease.status } });
    const signer = this.signer(access);
    const expected = LeasesService.hex(access.lease.contractSha256);
    if (!expected || expected !== input.contractSha256.toLowerCase())
      throw new DomainException('lease.contract_changed');
    const challenge = await this.otp.verify({
      challengeId: input.challengeId,
      code: input.code,
      purpose: 'lease_signature',
    });
    if (challenge.subjectId !== leaseId) throw new DomainException('auth.otp_invalid');
    const userId = this.userId();
    const user = await this.db.platform((tx) =>
      tx.userAccount.findUniqueOrThrow({ where: { id: userId }, select: { lineUserId: true } }),
    );
    const request = RequestContext.current();
    const now = this.clock.now();
    return this.db.tenant(access.ctx, async (tx) => {
      const lease = await this.leases.load(tx, leaseId);
      if (lease.status !== 'pending_signature')
        throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
      if (LeasesService.hex(lease.contractSha256) !== expected)
        throw new DomainException('lease.contract_changed');
      const image = await this.documents.storeGenerated(tx, {
        tenantId: lease.tenantId,
        kind: 'signature',
        scopeType: 'party',
        scopeId: signer.partyId,
        buildingId: null,
        title: `ลายมือชื่อผู้เช่า ${lease.number}.png`,
        mimeType: 'image/png',
        body: input.signaturePng,
        retentionClass: 'contract',
      });
      const signature = await tx.leaseSignature.create({
        data: {
          tenantId: lease.tenantId,
          leaseId,
          signerRole: signer.role === 'co_tenant' ? 'co_tenant' : 'lessee',
          partyId: signer.partyId,
          userId,
          method: 'draw_liff',
          otpChallengeId: challenge.id,
          lineUserId: user.lineUserId,
          signatureImageDocumentId: image.id,
          pdfSha256: new Uint8Array(lease.contractSha256!),
          signedAt: now,
          ip: request?.ip ?? null,
          userAgent: request?.userAgent ?? null,
          createdBy: userId,
        },
      });
      await this.audit.record(tx, {
        action: 'lease.signed',
        tenantId: lease.tenantId,
        buildingId: lease.buildingId,
        subjectType: 'ops.lease_signature',
        subjectId: signature.id,
        metadata: {
          leaseId,
          partyId: signer.partyId,
          sha256: expected,
          otpChallengeId: challenge.id,
          lineLinked: Boolean(user.lineUserId),
        },
      });
      await this.leases.history(
        tx,
        lease,
        'signed',
        { signerRole: signature.signerRole, partyId: signer.partyId, sha256: expected },
        'lease.signed',
      );
      return { lease: await this.leases.load(tx, leaseId), signature };
    });
  }

  /** The Bangkok date of now (resident views compute nothing on the client, LIFF #7). */
  today(): string {
    return bangkokDate(this.clock.now());
  }

  /**
   * LIFF #8 (D-203): I confirm that I read the building rules of the lease's addendum (`house_rules`, `pets`, …).
   * Recorded on my lease-party rows (who and when), audited and evented; repeating it changes nothing. Ended,
   * cancelled or rule-less leases answer 409 `lease.invalid_state`.
   */
  async acknowledgeRules(leaseId: string) {
    const access = await this.access(leaseId);
    const { lease, partyIds } = access;
    if (!(RULES_ACK_STATES as readonly string[]).includes(lease.status) || !hasRuleClauses(lease))
      throw new DomainException('lease.invalid_state', {
        params: { status: hasRuleClauses(lease) ? lease.status : 'no_rules' },
      });
    const userId = this.userId();
    const pending = lease.parties.filter((p) => partyIds.includes(p.partyId) && !p.rulesAcknowledgedAt);
    if (pending.length) {
      const now = this.clock.now();
      // the lessor may be a unit grantee (D-152): the rows are written in the lease's own tenant
      await this.db.tenant(access.ctx, async (tx) => {
        await tx.leaseParty.updateMany({
          where: { leaseId, partyId: { in: pending.map((p) => p.partyId) }, rulesAcknowledgedAt: null },
          data: { rulesAcknowledgedAt: now, rulesAcknowledgedBy: userId, updatedBy: userId },
        });
        const clauses = ((Array.isArray(lease.addendum) ? lease.addendum : []) as { type?: string }[])
          .map((c) => c.type ?? '')
          .filter((t) => (RULE_CLAUSE_TYPES as readonly string[]).includes(t));
        await this.audit.record(tx, {
          action: 'lease.rules_acknowledged',
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          subjectType: 'ops.lease',
          subjectId: lease.id,
          after: { partyIds: pending.map((p) => p.partyId), clauses },
        });
        await this.leases.history(
          tx,
          lease,
          'rules_acknowledged',
          { partyIds: pending.map((p) => p.partyId), clauses },
          'lease.rules_acknowledged',
        );
      });
    }
    return (await this.access(leaseId)).lease;
  }

  /** The lessee's 30-day notice from the LIFF (D-063, legal-reference ข้อ 4 (11)); shorter is refused (no acknowledgement). */
  async notice(leaseId: string, input: { effectiveDate: string; reason?: string | null }) {
    const access = await this.access(leaseId);
    const isLessee = access.lease.parties.some(
      (p) => p.role === 'lessee' && access.partyIds.includes(p.partyId),
    );
    if (!isLessee) throw new DomainException('lease.not_signer');
    await this.leases.recordNotice(
      access.ctx,
      leaseId,
      {
        by: 'lessee',
        effectiveDate: input.effectiveDate,
        reasonCode: 'lessee_notice',
        note: input.reason ?? null,
      },
      { refuseWarnings: true },
    );
    return (await this.access(leaseId)).lease;
  }

  // ------------------------------------------------------------------------------------------- invitations

  private codeHash(code: string) {
    return this.hasher.secret('lease_invitation', code.trim().toUpperCase());
  }

  /**
   * `POST /v1/owner/leases/{id}/invitations` (D-061): a one-time code for a party **of this lease** (the lessee by
   * default), valid `invitation.expiry_days`; the LIFF link as a QR image (LINE QR channel) or by SMS (sent inline, it
   * is a credential). A party of another tenant is a 404 (RLS + the lease's own parties).
   */
  async invite(
    ctx: TenantContext,
    leaseId: string,
    input: { partyId?: string; channel: InvitationChannel; language?: string },
  ) {
    const now = this.clock.now();
    const days = await this.settings.valueAt<number>('invitation.expiry_days', now);
    const code = readableCode(4);
    const created = await this.db.tenant(ctx, async (tx) => {
      const lease = await this.leases.load(tx, leaseId);
      if (lease.tenantId !== ctx.tenantId) throw new DomainException('asset.read_only');
      if (!['pending_signature', 'active', 'notice_given'].includes(lease.status) && lease.status !== 'draft')
        throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
      const partyId = input.partyId ?? lease.lesseePartyId;
      if (!lease.parties.some((p) => p.partyId === partyId)) throw new DomainException('http.not_found');
      const party = await tx.party.findFirst({
        where: { id: partyId, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!party) throw new DomainException('http.not_found');
      if (input.channel === 'sms' && !party.phoneE164)
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'channel',
              code: 'phoneMissing',
              message: 'the party has no phone for an SMS invitation',
            },
          ],
        });
      const invitation = await tx.invitation.create({
        data: {
          tenantId: ctx.tenantId,
          kind: 'lease_resident',
          leaseId,
          partyId,
          phoneE164: party.phoneE164,
          codeHash: this.codeHash(code),
          channel: input.channel,
          expiresAt: new Date(now.getTime() + days * 86_400_000),
          invitedBy:
            RequestContext.actor()?.type === 'user'
              ? (RequestContext.actor() as { publicId: string }).publicId
              : null,
          createdBy:
            RequestContext.actor()?.type === 'user'
              ? (RequestContext.actor() as { publicId: string }).publicId
              : null,
        },
      });
      await this.audit.record(tx, {
        action: 'lease.invitation_created',
        tenantId: ctx.tenantId,
        buildingId: lease.buildingId,
        subjectType: 'platform.invitation',
        subjectId: invitation.id,
        metadata: { leaseId, partyId, channel: input.channel },
      });
      await this.leases.history(
        tx,
        lease,
        'invitation_created',
        { invitationId: invitation.id, partyId, channel: input.channel },
        'lease.invitation_created',
      );
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { displayName: true },
      });
      return { invitation, party, tenantName: tenant.displayName };
    });
    const url = `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/link?code=${encodeURIComponent(code)}`;
    const qrPng = await QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
    });
    if (input.channel === 'sms' && created.party.phoneE164) {
      const text =
        input.language === 'en'
          ? `${created.tenantName} invites you to your lease on getproperty (LINE): ${url}`
          : `${created.tenantName} เชิญคุณเข้าดูสัญญาเช่าบน getproperty (LINE): ${url}`;
      await this.sms.send(created.party.phoneE164, text).catch((error: unknown) => {
        this.logger.error(
          `lease invitation SMS to ${maskPhone(created.party.phoneE164!)} failed: ${(error as Error).message}`,
        );
        throw new DomainException('provider.unavailable');
      });
    }
    return {
      invitation: created.invitation,
      code,
      url,
      qrPngDataUrl: `data:image/png;base64,${qrPng.toString('base64')}`,
    };
  }

  listInvitations(ctx: TenantContext, leaseId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await this.leases.load(tx, leaseId);
      return tx.invitation.findMany({
        where: { tenantId: ctx.tenantId, leaseId },
        orderBy: { createdAt: 'desc' },
      });
    });
  }

  private async findInvitation(tx: Tx, code: string) {
    const hash = this.codeHash(code);
    const invitation = await tx.invitation.findUnique({ where: { codeHash: hash } });
    if (
      !invitation ||
      !sameDigest(invitation.codeHash, hash) ||
      invitation.kind !== 'lease_resident' ||
      !invitation.leaseId
    )
      throw new DomainException('invitation.not_found');
    return invitation;
  }

  /** What the LIFF shows before the resident accepts (no personal data beyond a masked name). */
  async previewInvitation(code: string) {
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const inv = await this.findInvitation(tx, code);
      if (inv.state !== 'pending' || inv.expiresAt.getTime() <= now.getTime())
        throw new DomainException('invitation.not_pending');
      const lease = await tx.lease.findUniqueOrThrow({
        where: { id: inv.leaseId! },
        include: {
          unit: { select: { unitNo: true } },
          building: { select: { name: true } },
          tenant: { select: { displayName: true } },
        },
      });
      const party = await tx.party.findUniqueOrThrow({
        where: { id: inv.partyId! },
        select: { displayName: true },
      });
      const name = party.displayName;
      return {
        tenantName: lease.tenant.displayName,
        buildingName: lease.building.name,
        unitNo: lease.unit.unitNo,
        partyDisplayName:
          name.length > 2 ? `${name.slice(0, 2)}${'•'.repeat(Math.min(6, name.length - 2))}` : name,
        leaseStatus: lease.status,
        startDate: lease.startDate,
        expiresAt: inv.expiresAt,
      };
    });
  }

  /**
   * Accept (D-061, D-025): the resident must have granted the required consent purposes first (409
   * `consent.required`); the login is linked to the invited party (`linked_via invitation`), the party gets the
   * LINE user id when it has none, the consents are recorded for this tenant as controller, the invitation is
   * accepted. The new `lease:` scope arrives with the next token refresh (`refreshRequired`).
   */
  async acceptInvitation(code: string, language: string) {
    const userId = this.userId();
    const purposes = await this.consents.purposes(['resident'], language, { type: 'user', id: userId }, null);
    const required = purposes.filter((p) => p.required);
    if (required.some((p) => p.granted !== true)) throw new DomainException('consent.required');
    const now = this.clock.now();
    const accepted = await this.db.platform(async (tx) => {
      const inv = await this.findInvitation(tx, code);
      if (inv.state !== 'pending' || inv.expiresAt.getTime() <= now.getTime())
        throw new DomainException('invitation.not_pending');
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
            tenantId: inv.tenantId,
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
      await tx.invitation.update({
        where: { id: inv.id },
        data: { state: 'accepted', acceptedAt: now, acceptedByUserId: userId },
      });
      await this.audit.record(tx, {
        action: 'lease.invitation_accepted',
        tenantId: inv.tenantId,
        subjectType: 'platform.invitation',
        subjectId: inv.id,
        metadata: { leaseId: inv.leaseId, partyId: party.id, userId },
      });
      const lease = await tx.lease.findUniqueOrThrow({ where: { id: inv.leaseId! } });
      await this.leases.history(
        tx,
        lease,
        'invitation_accepted',
        { invitationId: inv.id, partyId: party.id, userId },
        'lease.invitation_accepted',
      );
      return { tenantId: inv.tenantId, leaseId: inv.leaseId!, partyId: party.id };
    });
    // The resident's consents now also bind this tenant as controller (D-025).
    await this.consents.record(
      { type: 'user', id: userId },
      required.map((p) => ({ purposeKey: p.key, version: p.version, granted: true })),
      { channel: 'liff', language, tenantIds: [accepted.tenantId] },
    );
    return { ...accepted, refreshRequired: true, acceptedOn: bangkokDate(now) };
  }
}

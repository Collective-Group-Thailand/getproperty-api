import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { type Audience, type IdentityVerification } from '@generated/prisma/client';
import { EKYC, type EkycPort, EkycWebhookError } from '@integrations/ekyc/ekyc.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

export interface IdentityStatus {
  /** Approved once: the person is identity-verified (D-267). */
  verified: boolean;
  verifiedAt: Date | null;
  /** The latest attempt, if any. */
  latest: IdentityVerification | null;
  /** Whether a provider is configured (O-021). */
  available: boolean;
}

/**
 * Verified people (B7.10 part 2, D-267): a person — owner, resident or prospect — verifies their identity once at a
 * licensed e-KYC provider (O-021). Starting answers the provider's page; the provider's signed webhook decides. Only
 * the outcome is kept. The badge is shown on listings and the owner page (owners) and on enquiries (prospects).
 */
@Injectable()
export class IdentityVerificationService {
  private readonly logger = new Logger(IdentityVerificationService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly settings: SettingsService,
    @Inject(EKYC) private readonly ekyc: EkycPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private live(row: IdentityVerification): IdentityVerification {
    return row.state === 'pending' && row.expiresAt <= this.clock.now() ? { ...row, state: 'expired' } : row;
  }

  async status(userId: string): Promise<IdentityStatus> {
    const rows = await this.db.platform((tx) =>
      tx.identityVerification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    );
    const approved = rows.find((r) => r.state === 'approved') ?? null;
    return {
      verified: Boolean(approved),
      verifiedAt: approved?.decidedAt ?? null,
      latest: rows[0] ? this.live(rows[0]) : null,
      available: this.ekyc.mode !== 'off',
    };
  }

  /** Users among `userIds` whose identity is verified. */
  async verifiedUsers(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const rows = await this.db.platform((tx) =>
      tx.identityVerification.findMany({
        where: { userId: { in: userIds }, state: 'approved' },
        select: { userId: true },
        distinct: ['userId'],
      }),
    );
    return new Set(rows.map((r) => r.userId));
  }

  /** Tenants among `tenantIds` with an identity-verified owner (a member with the owner role). */
  async verifiedOwnerTenants(tenantIds: string[]): Promise<Set<string>> {
    if (!tenantIds.length) return new Set();
    const rows = await this.db.platform(
      (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT m.tenant_id
          FROM core.membership m
          JOIN platform.identity_verification v ON v.user_id = m.user_id AND v.state = 'approved'
         WHERE m.tenant_id = ANY (${tenantIds}::uuid[]) AND m.role = 'owner' AND m.status = 'active'`,
    );
    return new Set(rows.map((r) => r.tenant_id));
  }

  /** Starts (or resumes) a verification; a verified person is told so (`identity.already_verified`). */
  async start(userId: string, audience: Audience, input: { returnUrl: string; language: 'th' | 'en' }) {
    const current = await this.status(userId);
    if (current.verified) throw new DomainException('identity.already_verified');
    if (this.ekyc.mode === 'off') throw new DomainException('ekyc.unavailable');
    if (current.latest?.state === 'pending') return current.latest;
    const minutes = Number(
      (await this.settings.valueAt<number>('identity.verification.session_minutes', this.clock.now(), {})) ??
        60,
    );
    const id = uuidv7(this.clock.now().getTime());
    const session = await this.ekyc.start({
      reference: id,
      returnUrl: input.returnUrl,
      language: input.language,
    });
    return this.db.platform(async (tx) => {
      // an attempt left pending past its time makes way for the new one
      await tx.identityVerification.updateMany({
        where: { userId, state: 'pending', expiresAt: { lte: this.clock.now() } },
        data: { state: 'expired' },
      });
      const row = await tx.identityVerification.create({
        data: {
          id,
          userId,
          audience,
          provider: this.ekyc.provider,
          providerSessionId: session.sessionId,
          verificationUrl: session.url,
          expiresAt: new Date(this.clock.now().getTime() + minutes * 60_000),
        },
      });
      await this.audit.record(tx, {
        action: 'identity.verification_started',
        tenantId: null,
        subjectType: 'platform.identity_verification',
        subjectId: id,
        metadata: { audience, provider: this.ekyc.provider },
      });
      return row;
    });
  }

  /** The provider's signed outcome (`POST /webhooks/ekyc/{provider}`); repeated deliveries are answered once. */
  async receive(provider: string, rawBody: Buffer | undefined, signature: string | undefined) {
    if (provider !== this.ekyc.provider || this.ekyc.mode === 'off')
      throw new DomainException('http.not_found');
    if (!rawBody?.length) throw new DomainException('webhook.malformed');
    let outcome;
    try {
      outcome = this.ekyc.parseWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof EkycWebhookError)
        throw new DomainException(
          error.kind === 'signature' ? 'webhook.signature_invalid' : 'webhook.malformed',
        );
      throw error;
    }
    return this.decide(provider, outcome.sessionId, outcome.outcome, outcome.reason);
  }

  async decide(provider: string, sessionId: string, outcome: 'approved' | 'rejected', reason: string | null) {
    return this.db.platform(async (tx) => {
      const row = await tx.identityVerification.findUnique({
        where: { provider_providerSessionId: { provider, providerSessionId: sessionId } },
      });
      if (!row) throw new DomainException('http.not_found');
      if (row.state !== 'pending') return { handled: false, state: row.state };
      const now = this.clock.now();
      await tx.identityVerification.update({
        where: { id: row.id },
        data: { state: outcome, decidedAt: now, failureReason: outcome === 'rejected' ? reason : null },
      });
      await this.audit.record(tx, {
        action: outcome === 'approved' ? 'identity.verified' : 'identity.verification_rejected',
        tenantId: null,
        subjectType: 'platform.identity_verification',
        subjectId: row.id,
        metadata: { audience: row.audience, provider },
      });
      await this.events.record(tx, {
        type: outcome === 'approved' ? 'identity.verified' : 'identity.verification_rejected',
        aggregateType: 'identity_verification',
        aggregateId: row.id,
        tenantId: null,
        payload: { verificationId: row.id, userId: row.userId, audience: row.audience },
      });
      this.logger.log(`identity verification ${row.id} ${outcome}`);
      return { handled: true, state: outcome };
    });
  }
}

import { actorEnvelope, actorIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type AuditOutcome, type Prisma } from '@generated/prisma/client';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Audited actions (B1.3 prompt "Audit"): security, money and PDPA. The string is stored in
 * `platform.audit_log.action`; keep names `<area>.<event>` and never rename (reports and alerts filter on them).
 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.refresh_reuse_detected',
  'auth.permission_denied',
  'auth.password_changed',
  'auth.totp_enabled',
  'auth.otp_requested',
  'auth.device_bootstrapped',
  'tenant.created',
  'tenant.updated',
  'tenant.member.invited',
  'tenant.member.joined',
  'tenant.member.role_changed',
  'tenant.member.removed',
  'tenant.invitation.revoked',
  'tenant.bank_account.requested',
  'tenant.bank_account.changed',
  'platform.user.created',
  'platform.role.granted',
  'platform.role.revoked',
  'support_grant.requested',
  'support_grant.approved',
  'support_grant.denied',
  'support_grant.revoked',
  'support_grant.used',
  'support_grant.bypassed',
  'setting.changed',
  'feature_flag.changed',
  'utility_tariff.entered',
  'utility_tariff.verified',
  'utility_tariff.published',
  'compliance.acknowledged',
  'grant.created',
  'grant.revoked',
  'building.operator_changed',
  'pii.decrypted',
  'document.downloaded',
  'export.created',
  'consent.changed',
  'dsr.received',
  'dsr.transitioned',
  'dsr.fulfilled',
  'outbox.replayed',
  'notification.template_created',
  'notification.template_published',
  'notification.route_changed',
  'notification.test_sent',
  'device.registered',
  'device.provisioning_code_issued',
  'retention.executed',
  'unit.status_changed',
  'unit.bulk_created',
  'unit.imported',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  action: AuditAction;
  tenantId?: string | null;
  buildingId?: string | null;
  subjectType?: string;
  subjectId?: string | null;
  outcome?: AuditOutcome;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
  supportGrantId?: string | null;
}

/**
 * `platform.audit_log` ⟲ writer. `record(tx, …)` writes inside the caller's transaction (the audited change and its
 * row commit together); `recordAlone(…)` writes in its own platform transaction for events with no business
 * transaction (denied permission, failed login). Actor, request id, IP and user agent come from the request
 * context; values must already be redacted (no secrets, OTPs, full bank or id numbers — D-025).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: TenantTx) {}

  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const ctx = RequestContext.current();
    const actor = ctx?.actor;
    const supportGrantId =
      entry.supportGrantId ?? (actor?.type === 'user' ? (actor.supportGrantId ?? null) : null);
    await tx.auditLog.create({
      data: {
        action: entry.action,
        tenantId: entry.tenantId ?? null,
        buildingId: entry.buildingId ?? null,
        actor: actorEnvelope(actor),
        actorId: actorIdOf(actor),
        subjectType: entry.subjectType ?? null,
        subjectId: entry.subjectId ?? null,
        outcome: entry.outcome ?? 'success',
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        supportGrantId,
        before: entry.before,
        after: entry.after,
        metadata: entry.metadata ?? {},
      },
    });
  }

  /** Own transaction (platform role). Never throws: a failed audit write is logged, not surfaced. */
  async recordAlone(entry: AuditEntry): Promise<void> {
    try {
      await this.db.platform((tx) => this.record(tx, entry));
    } catch (error) {
      this.logger.error(`audit write failed for ${entry.action}: ${(error as Error).message}`);
    }
  }
}

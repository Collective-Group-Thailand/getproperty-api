import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type SupportGrant } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { SettingsService } from '../settings/settings.service';

/**
 * Support grants (D-090, contract §8): Collective Support reads into a tenant only with an active, time-boxed
 * grant — requested by Support, approved by the tenant's Owner in the app (or by a platform admin for an incident),
 * valid at most `support.grant_max_hours`, revocable at any time. Every read under a grant is audited
 * (`support_grant.used`, by `SupportGrantGuard`); platform admins bypass the grant but are audited the same way.
 */
@Injectable()
export class SupportGrantService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /** Support asks (platform transaction; the tenant must exist). */
  async request(
    tenantId: string,
    input: { reason: string; ticketRef?: string | null },
  ): Promise<SupportGrant> {
    const actorId = userIdOf(RequestContext.actor());
    if (!actorId) throw new DomainException('auth.unauthenticated');
    return this.db.platform(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
      if (!tenant) throw new DomainException('http.not_found');
      const grant = await tx.supportGrant.create({
        data: {
          tenantId,
          requestedBy: actorId,
          reason: input.reason,
          ticketRef: input.ticketRef ?? null,
          createdBy: actorId,
        },
      });
      await this.audit.record(tx, {
        action: 'support_grant.requested',
        tenantId,
        subjectType: 'platform.support_grant',
        subjectId: grant.id,
        after: { reason: input.reason, ticketRef: input.ticketRef ?? null },
      });
      await this.events.record(tx, {
        type: 'support_grant.requested',
        aggregateType: 'support_grant',
        aggregateId: grant.id,
        tenantId,
        payload: { supportGrantId: grant.id, reason: input.reason },
      });
      return grant;
    });
  }

  private async window(hours: number | undefined): Promise<{ from: Date; to: Date }> {
    const now = this.clock.now();
    const max = await this.settings.valueAt<number>('support.grant_max_hours', now);
    const h = Math.min(hours ?? max, max);
    return { from: now, to: new Date(now.getTime() + h * 3_600_000) };
  }

  private async change(
    tx: Tx,
    grant: SupportGrant,
    data: Partial<SupportGrant>,
    action: 'support_grant.approved' | 'support_grant.denied' | 'support_grant.revoked',
  ): Promise<SupportGrant> {
    const updated = await tx.supportGrant.update({ where: { id: grant.id }, data });
    await this.audit.record(tx, {
      action,
      tenantId: grant.tenantId,
      subjectType: 'platform.support_grant',
      subjectId: grant.id,
      before: { state: grant.state },
      after: {
        state: updated.state,
        validTo: updated.validTo?.toISOString() ?? null,
        approvedVia: updated.approvedVia,
      },
    });
    await this.events.record(tx, {
      type: 'support_grant.changed',
      aggregateType: 'support_grant',
      aggregateId: grant.id,
      tenantId: grant.tenantId,
      payload: {
        supportGrantId: grant.id,
        state: updated.state,
        validTo: updated.validTo?.toISOString() ?? null,
      },
    });
    return updated;
  }

  list(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) =>
      tx.supportGrant.findMany({ where: this.own(ctx, {}), orderBy: { createdAt: 'desc' } }),
    );
  }

  listAll(state?: SupportGrant['state']) {
    return this.db.platform((tx) =>
      tx.supportGrant.findMany({ where: state ? { state } : {}, orderBy: { createdAt: 'desc' }, take: 200 }),
    );
  }

  /** The Owner approves in the app (D-090). */
  async approve(ctx: TenantContext, grantId: string, hours?: number): Promise<SupportGrant> {
    const window = await this.window(hours);
    return this.db.tenant(ctx, async (tx) => {
      const grant = this.found(await tx.supportGrant.findFirst({ where: this.own(ctx, { id: grantId }) }));
      if (grant.state !== 'requested') throw new DomainException('support.invalid_transition');
      return this.change(
        tx,
        grant,
        {
          state: 'active',
          approvedBy: userIdOf(RequestContext.actor()),
          approvedVia: 'in_app',
          approvedAt: window.from,
          validFrom: window.from,
          validTo: window.to,
        },
        'support_grant.approved',
      );
    });
  }

  async deny(ctx: TenantContext, grantId: string): Promise<SupportGrant> {
    return this.db.tenant(ctx, async (tx) => {
      const grant = this.found(await tx.supportGrant.findFirst({ where: this.own(ctx, { id: grantId }) }));
      if (grant.state !== 'requested') throw new DomainException('support.invalid_transition');
      return this.change(tx, grant, { state: 'denied' }, 'support_grant.denied');
    });
  }

  /** The Owner (tenant transaction), the requesting support user (`requestedBy`) or a platform admin ends a grant early. */
  async revoke(ctx: TenantContext | null, grantId: string, requestedBy?: string): Promise<SupportGrant> {
    const run = async (tx: Tx) => {
      const grant = this.found(
        await tx.supportGrant.findFirst({
          where: ctx
            ? this.own(ctx, { id: grantId })
            : { id: grantId, ...(requestedBy ? { requestedBy } : {}) },
        }),
      );
      if (grant.state !== 'requested' && grant.state !== 'active' && grant.state !== 'approved')
        throw new DomainException('support.invalid_transition');
      return this.change(
        tx,
        grant,
        { state: 'revoked', revokedAt: this.clock.now(), revokedBy: userIdOf(RequestContext.actor()) },
        'support_grant.revoked',
      );
    };
    return ctx ? this.db.tenant(ctx, run) : this.db.platform(run);
  }

  /** A platform admin activates a grant for an incident without the Owner (audited as such). */
  async approveIncident(grantId: string, hours?: number): Promise<SupportGrant> {
    const window = await this.window(hours);
    return this.db.platform(async (tx) => {
      const grant = this.found(await tx.supportGrant.findUnique({ where: { id: grantId } }));
      if (grant.state !== 'requested') throw new DomainException('support.invalid_transition');
      return this.change(
        tx,
        grant,
        {
          state: 'active',
          approvedBy: userIdOf(RequestContext.actor()),
          approvedVia: 'platform_admin_incident',
          approvedAt: window.from,
          validFrom: window.from,
          validTo: window.to,
        },
        'support_grant.approved',
      );
    });
  }

  /** The grant that lets `userId` read into `tenantId` now, if any. */
  async activeFor(userId: string, tenantId: string): Promise<SupportGrant | null> {
    const now = this.clock.now();
    return this.db.platform((tx) =>
      tx.supportGrant.findFirst({
        where: {
          requestedBy: userId,
          tenantId,
          state: 'active',
          revokedAt: null,
          validFrom: { lte: now },
          validTo: { gt: now },
        },
        orderBy: { validTo: 'desc' },
      }),
    );
  }

  /** Maintenance: active grants past `valid_to` become `expired`. */
  async expireDue(): Promise<number> {
    const now = this.clock.now();
    const r = await this.db.platform((tx) =>
      tx.supportGrant.updateMany({
        where: { state: 'active', validTo: { lte: now } },
        data: { state: 'expired' },
      }),
    );
    return r.count;
  }
}

import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { AccessService } from './access.service';
import { type TenantRole } from './invitation.service';

/**
 * Memberships of a tenant (operator audience, D-090): list, change role / building limits, suspend, remove. A
 * tenant always keeps one active Owner (409 `membership.last_owner`); only an Owner grants or removes the Owner
 * role. Every change is audited, emits `tenant.member.changed` and drops the member's cached access at once.
 */
@Injectable()
export class MembershipService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly access: AccessService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  /**
   * Members with their account names. Under RLS a user reads only its own `core.user_account` row, so the accounts
   * of the tenant's members are looked up as gp_platform (identity lookup) for the membership rows the tenant
   * transaction returned — never for other users.
   */
  async list(ctx: TenantContext) {
    const rows = await this.db.tenant(ctx, (tx) =>
      tx.membership.findMany({ where: this.own(ctx, { deletedAt: null }), orderBy: { createdAt: 'asc' } }),
    );
    const users = await this.db.platform((tx) =>
      tx.userAccount.findMany({
        where: { id: { in: rows.map((m) => m.userId) } },
        select: { id: true, displayName: true, phoneE164: true, email: true },
      }),
    );
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((m) => ({
      ...m,
      user: byId.get(m.userId) ?? { id: m.userId, displayName: '', phoneE164: null, email: null },
    }));
  }

  private async otherActiveOwners(tx: Tx, ctx: TenantContext, exceptId: string): Promise<number> {
    return tx.membership.count({
      where: this.own(ctx, { role: 'owner', status: 'active', deletedAt: null, id: { not: exceptId } }),
    });
  }

  async update(
    ctx: TenantContext,
    membershipId: string,
    input: { role?: TenantRole; buildingIds?: string[] | null; status?: 'active' | 'suspended' },
  ) {
    const result = await this.db.tenant(ctx, async (tx) => {
      const m = this.found(
        await tx.membership.findFirst({ where: this.own(ctx, { id: membershipId, deletedAt: null }) }),
      );
      const touchesOwner = m.role === 'owner' || input.role === 'owner';
      if (touchesOwner && ctx.role !== 'owner') throw new DomainException('auth.forbidden');
      const losesOwner =
        m.role === 'owner' && ((input.role && input.role !== 'owner') || input.status === 'suspended');
      if (losesOwner && (await this.otherActiveOwners(tx, ctx, m.id)) === 0)
        throw new DomainException('membership.last_owner');
      if (input.buildingIds?.length) {
        const n = await tx.building.count({
          where: {
            id: { in: input.buildingIds },
            deletedAt: null,
            OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
          },
        });
        if (n !== new Set(input.buildingIds).size) throw new DomainException('http.not_found');
      }
      const moduleScopes =
        input.buildingIds === undefined
          ? (m.moduleScopes ?? {})
          : input.buildingIds === null || input.buildingIds.length === 0
            ? {}
            : { buildingIds: [...new Set(input.buildingIds)] };
      const updated = await tx.membership.update({
        where: { id: m.id },
        data: { role: input.role ?? m.role, status: input.status ?? m.status, moduleScopes },
      });
      await this.audit.record(tx, {
        action: 'tenant.member.role_changed',
        tenantId: ctx.tenantId,
        subjectType: 'core.membership',
        subjectId: m.id,
        before: { role: m.role, status: m.status, moduleScopes: m.moduleScopes ?? {} },
        after: { role: updated.role, status: updated.status, moduleScopes: updated.moduleScopes ?? {} },
      });
      await this.events.record(tx, {
        type: 'tenant.member.changed',
        aggregateType: 'membership',
        aggregateId: m.id,
        tenantId: ctx.tenantId,
        payload: { membershipId: m.id, userId: m.userId, role: updated.role, status: updated.status },
      });
      return updated;
    });
    await this.access.changed(result.userId);
    return result;
  }

  async remove(ctx: TenantContext, membershipId: string, reason: string | null) {
    const result = await this.db.tenant(ctx, async (tx) => {
      const m = this.found(
        await tx.membership.findFirst({ where: this.own(ctx, { id: membershipId, deletedAt: null }) }),
      );
      if (m.role === 'owner' && ctx.role !== 'owner') throw new DomainException('auth.forbidden');
      if (m.role === 'owner' && (await this.otherActiveOwners(tx, ctx, m.id)) === 0)
        throw new DomainException('membership.last_owner');
      const now = this.clock.now();
      const removed = await tx.membership.update({
        where: { id: m.id },
        data: { status: 'removed', removedAt: now, removedReason: reason, deletedAt: now },
      });
      await this.audit.record(tx, {
        action: 'tenant.member.removed',
        tenantId: ctx.tenantId,
        subjectType: 'core.membership',
        subjectId: m.id,
        before: { role: m.role, status: m.status },
        metadata: { reason },
      });
      await this.events.record(tx, {
        type: 'tenant.member.changed',
        aggregateType: 'membership',
        aggregateId: m.id,
        tenantId: ctx.tenantId,
        payload: { membershipId: m.id, userId: m.userId, role: m.role, status: 'removed' },
      });
      return removed;
    });
    await this.access.changed(result.userId);
    return result;
  }
}

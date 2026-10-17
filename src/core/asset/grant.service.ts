import { GRANT_MODULES } from '@collective/asset-core';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type AssetAccessGrant, type GrantAccess, type GrantReason } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';

export interface GrantInput {
  granteeTenantId: string;
  buildingId: string;
  unitId?: string | null;
  modules: string[];
  access: GrantAccess;
  reason: GrantReason;
  validFrom?: Date;
  validTo?: Date | null;
}

/**
 * `core.asset_access_grant` (D-152, contract §8): the only way a tenant sees another tenant's building or unit, for
 * named modules only, read or write, within a validity window. Created and revoked by the building's owner or
 * operator tenant (RLS checks `core.owns_or_operates`, the service checks first for a clean 403), audited, and
 * evented. `check()` answers whether the current tenant may use a module on a building now.
 */
@Injectable()
export class GrantService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  async create(ctx: TenantContext, input: GrantInput): Promise<AssetAccessGrant> {
    const modules = [...new Set(input.modules)];
    const unknown = modules.filter((m) => !(GRANT_MODULES as readonly string[]).includes(m));
    if (unknown.length || modules.length === 0)
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'modules',
            code: 'isIn',
            message: `unknown module keys: ${unknown.join(', ') || '(none)'}`,
          },
        ],
      });
    if (input.granteeTenantId === ctx.tenantId)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'granteeTenantId', code: 'notSelf', message: 'a tenant cannot grant itself' }],
      });
    // Other tenants are invisible under RLS: the grantee's existence is checked as gp_platform.
    const grantee = await this.db.platform((tx) =>
      tx.tenant.findFirst({
        where: { id: input.granteeTenantId, deletedAt: null, status: { not: 'deactivated' } },
      }),
    );
    if (!grantee) throw new DomainException('http.not_found');
    return this.db.tenant(ctx, async (tx) => {
      const building = this.found(
        await tx.building.findFirst({ where: { id: input.buildingId, deletedAt: null } }),
      );
      if (building.ownerTenantId !== ctx.tenantId && building.operatorTenantId !== ctx.tenantId)
        throw new DomainException('grant.not_allowed');
      if (input.unitId)
        this.found(
          await tx.unit.findFirst({ where: { id: input.unitId, buildingId: building.id, deletedAt: null } }),
        );
      const grant = await tx.assetAccessGrant.create({
        data: {
          tenantId: ctx.tenantId,
          granteeTenantId: input.granteeTenantId,
          buildingId: building.id,
          unitId: input.unitId ?? null,
          scope: input.unitId ? 'unit' : 'building',
          modules,
          access: input.access,
          reason: input.reason,
          // database time when omitted: RLS (`core.accessible_building_ids`) compares validity with now()
          validFrom: input.validFrom,
          validTo: input.validTo ?? null,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.audit.record(tx, {
        action: 'grant.created',
        tenantId: ctx.tenantId,
        buildingId: building.id,
        subjectType: 'core.asset_access_grant',
        subjectId: grant.id,
        after: {
          granteeTenantId: grant.granteeTenantId,
          scope: grant.scope,
          unitId: grant.unitId,
          modules,
          access: grant.access,
          reason: grant.reason,
          validTo: grant.validTo?.toISOString() ?? null,
        },
      });
      await this.events.record(tx, {
        type: 'grant.changed',
        aggregateType: 'asset_access_grant',
        aggregateId: grant.id,
        tenantId: ctx.tenantId,
        buildingId: building.id,
        payload: { grantId: grant.id, change: 'created', granteeTenantId: grant.granteeTenantId, modules },
      });
      return grant;
    });
  }

  async revoke(ctx: TenantContext, grantId: string, reason: string): Promise<AssetAccessGrant> {
    return this.db.tenant(ctx, async (tx) => {
      const grant = this.found(
        await tx.assetAccessGrant.findFirst({ where: this.own(ctx, { id: grantId }) }),
      );
      if (grant.revokedAt) return grant;
      const revoked = await tx.assetAccessGrant.update({
        where: { id: grant.id },
        data: {
          revokedAt: this.clock.now(),
          revokedBy: userIdOf(RequestContext.actor()),
          revokeReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'grant.revoked',
        tenantId: ctx.tenantId,
        buildingId: grant.buildingId,
        subjectType: 'core.asset_access_grant',
        subjectId: grant.id,
        metadata: { reason },
      });
      await this.events.record(tx, {
        type: 'grant.changed',
        aggregateType: 'asset_access_grant',
        aggregateId: grant.id,
        tenantId: ctx.tenantId,
        buildingId: grant.buildingId,
        payload: { grantId: grant.id, change: 'revoked', granteeTenantId: grant.granteeTenantId },
      });
      return revoked;
    });
  }

  /** Grants the tenant gave or received (RLS shows both). */
  list(ctx: TenantContext) {
    return this.db.tenant(ctx, (tx) => tx.assetAccessGrant.findMany({ orderBy: { createdAt: 'desc' } }));
  }

  get(ctx: TenantContext, grantId: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.assetAccessGrant.findFirst({ where: { id: grantId } })),
    );
  }

  /** May the current tenant use `module` on `buildingId` now (owner/operator or an active grant)? */
  async check(
    ctx: TenantContext,
    buildingId: string,
    module: string,
    access: 'read' | 'write' = 'read',
  ): Promise<boolean> {
    const rows = await this.db.tenant(
      ctx,
      (tx) =>
        tx.$queryRaw<{ ok: boolean }[]>`
        SELECT ${buildingId}::uuid = ANY (core.accessible_building_ids(${module}, ${access})) AS ok`,
    );
    return rows[0]?.ok === true;
  }
}

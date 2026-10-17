import { InvalidationBus } from '@common/cache/invalidation-bus';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { ROLE_PERMISSIONS, type RoleKey } from '../rbac/catalogue';
import { type TenantTypeKey } from '../rbac/menu';

export interface OperatorAccess {
  tenantId: string;
  membershipId: string;
  role: RoleKey;
  permissions: ReadonlySet<string>;
  /** null = every building; list = Staff limited to buildings (D-090). */
  buildingIds: string[] | null;
  tenantType: TenantTypeKey;
  tenantStatus: 'active' | 'read_only' | 'deactivated';
}

export interface PlatformAccess {
  roles: RoleKey[];
  permissions: ReadonlySet<string>;
}

const TTL_MS = 30_000;
export const ACCESS_TOPIC = 'access';

/** Permission keys of a tenant or platform role (D-090/D-091). */
export function permissionsOf(roles: readonly string[]): Set<string> {
  return new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r as RoleKey] ?? []));
}

/**
 * What an authenticated user may do *now* (the token's scopes are only the starting point): an operator's active
 * membership in the request's tenant — role, building limits, tenant type and status — and a platform user's active
 * role assignments. Cached 30 s per user; membership and role changes invalidate at once (`ACCESS_TOPIC`).
 * Lookups run as gp_platform (identity, schema-design §7.4 Q7).
 */
@Injectable()
export class AccessService implements OnModuleInit {
  private readonly operatorCache = new Map<string, { at: number; value: OperatorAccess | null }>();
  private readonly platformCache = new Map<string, { at: number; value: PlatformAccess }>();

  constructor(
    private readonly db: TenantTx,
    private readonly bus: InvalidationBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.bus.on(ACCESS_TOPIC, (userId) => this.forget(userId));
  }

  forget(userId: string): void {
    if (userId === '*') {
      this.operatorCache.clear();
      this.platformCache.clear();
      return;
    }
    for (const k of [...this.operatorCache.keys()])
      if (k.startsWith(`${userId}|`)) this.operatorCache.delete(k);
    this.platformCache.delete(userId);
  }

  async changed(userId: string): Promise<void> {
    await this.bus.publish(ACCESS_TOPIC, userId);
  }

  async operator(userId: string, tenantId: string): Promise<OperatorAccess | null> {
    const key = `${userId}|${tenantId}`;
    const hit = this.operatorCache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const membership = await this.db.platform((tx) =>
      tx.membership.findFirst({
        where: { userId, tenantId, status: 'active', deletedAt: null, user: { status: 'active' } },
        include: { tenant: { select: { type: true, status: true, deletedAt: true } } },
      }),
    );
    let value: OperatorAccess | null = null;
    if (membership && membership.tenant.status !== 'deactivated' && !membership.tenant.deletedAt) {
      const scopes = (membership.moduleScopes ?? {}) as { buildingIds?: string[] | null };
      value = {
        tenantId,
        membershipId: membership.id,
        role: membership.role as RoleKey,
        permissions: permissionsOf([membership.role]),
        buildingIds: Array.isArray(scopes.buildingIds) ? scopes.buildingIds : null,
        tenantType: membership.tenant.type,
        tenantStatus: membership.tenant.status,
      };
    }
    this.operatorCache.set(key, { at: Date.now(), value });
    return value;
  }

  async platform(userId: string): Promise<PlatformAccess> {
    const hit = this.platformCache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const now = this.clock.now();
    const rows = await this.db.platform((tx) =>
      tx.platformRoleAssignment.findMany({
        where: {
          userId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          user: { status: 'active' },
        },
        include: { role: { select: { key: true } } },
      }),
    );
    const roles = rows.map((r) => r.role.key as RoleKey);
    const value = { roles, permissions: permissionsOf(roles) };
    this.platformCache.set(userId, { at: Date.now(), value });
    return value;
  }
}

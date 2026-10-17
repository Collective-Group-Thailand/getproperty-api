import { type Tx } from '@database/prisma.service';
import { type Audience } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { type RoleKey } from '../rbac/catalogue';
import { permissionsOf } from '../tenancy/access.service';

/** What a token says about its subject (contract §4 login response `subject`). */
export interface Subject {
  id: string;
  type: 'user' | 'device';
  audience: Audience;
  roles: string[];
  permissions: string[];
  scopes: string[];
  /** Device tokens only. */
  tenantId?: string;
  buildingId?: string;
}

/**
 * Scopes, roles and permissions per audience, computed from the database at sign-in and at every refresh
 * (memberships and occupancies may have changed). All queries run in a platform transaction (identity lookups).
 * - operator: `tenant:<id>` per active membership, `building:<id>` for Staff limited to buildings; roles and
 *   permissions are listed when the operator has exactly one tenant (otherwise per tenant via `/me`);
 * - resident: `unit:<id>` for each current occupancy of a linked party (`lease:<id>` scopes arrive with leases, B2.3);
 * - technician: `work_order:<id>` (none until B5);
 * - platform: role keys and their permissions;
 * - device: `device:<id>`, `tenant:<id>`, `building:<id>`.
 */
@Injectable()
export class SubjectService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async operator(tx: Tx, userId: string): Promise<Subject & { tenantIds: string[] }> {
    const memberships = await tx.membership.findMany({
      where: {
        userId,
        status: 'active',
        deletedAt: null,
        tenant: { status: { not: 'deactivated' }, deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
    });
    const scopes: string[] = [];
    for (const m of memberships) {
      scopes.push(`tenant:${m.tenantId}`);
      const buildingIds = (m.moduleScopes as { buildingIds?: string[] | null } | null)?.buildingIds;
      if (Array.isArray(buildingIds)) scopes.push(...buildingIds.map((b) => `building:${b}`));
    }
    const single = memberships.length === 1 ? memberships[0]! : null;
    return {
      id: userId,
      type: 'user',
      audience: 'operator',
      roles: single ? [single.role] : [],
      permissions: single ? [...permissionsOf([single.role])].sort() : [],
      scopes,
      tenantIds: memberships.map((m) => m.tenantId),
    };
  }

  async resident(tx: Tx, userId: string): Promise<Subject> {
    const today = this.clock.now().toISOString().slice(0, 10);
    const links = await tx.partyUserLink.findMany({
      where: { userId, state: 'active' },
      select: { partyId: true },
    });
    const occupancies = links.length
      ? await tx.occupancy.findMany({
          where: {
            partyId: { in: links.map((l) => l.partyId) },
            validFrom: { lte: new Date(today) },
            OR: [{ validTo: null }, { validTo: { gt: new Date(today) } }],
          },
          select: { unitId: true },
        })
      : [];
    const units = [...new Set(occupancies.map((o) => o.unitId))];
    return {
      id: userId,
      type: 'user',
      audience: 'resident',
      roles: [],
      permissions: [],
      scopes: units.map((u) => `unit:${u}`),
    };
  }

  technician(userId: string): Subject {
    return { id: userId, type: 'user', audience: 'technician', roles: [], permissions: [], scopes: [] };
  }

  async platform(tx: Tx, userId: string): Promise<Subject> {
    const now = this.clock.now();
    const rows = await tx.platformRoleAssignment.findMany({
      where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      include: { role: { select: { key: true } } },
    });
    const roles = rows.map((r) => r.role.key as RoleKey).sort();
    return {
      id: userId,
      type: 'user',
      audience: 'platform',
      roles,
      permissions: [...permissionsOf(roles)].sort(),
      scopes: ['platform'],
    };
  }

  device(device: { id: string; tenantId: string; buildingId: string }): Subject {
    return {
      id: device.id,
      type: 'device',
      audience: 'device',
      roles: [],
      permissions: [],
      scopes: [`device:${device.id}`, `tenant:${device.tenantId}`, `building:${device.buildingId}`],
      tenantId: device.tenantId,
      buildingId: device.buildingId,
    };
  }

  /** Recomputes the subject of an existing session (refresh). */
  async forSession(
    tx: Tx,
    session: { audience: Audience; userId: string | null; deviceId: string | null },
  ): Promise<Subject | null> {
    if (session.audience === 'device') {
      const device = session.deviceId
        ? await tx.device.findUnique({ where: { id: session.deviceId } })
        : null;
      if (!device?.tenantId || !device.buildingId || device.status === 'retired') return null;
      return this.device({ id: device.id, tenantId: device.tenantId, buildingId: device.buildingId });
    }
    const user = session.userId ? await tx.userAccount.findUnique({ where: { id: session.userId } }) : null;
    if (!user || user.status !== 'active') return null;
    switch (session.audience) {
      case 'operator': {
        const s = await this.operator(tx, user.id);
        return s.tenantIds.length ? s : null;
      }
      case 'resident':
        return this.resident(tx, user.id);
      case 'technician':
        return this.technician(user.id);
      case 'platform': {
        const s = await this.platform(tx, user.id);
        return s.roles.length ? s : null;
      }
    }
  }
}

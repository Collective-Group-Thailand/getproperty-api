import { bangkokDate } from '@common/time/bangkok';
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
 * - resident: `lease:<id>` for each lease of a linked party (after the draft), `unit:<id>` for each current occupancy;
 * - technician: `work_order:<id>` of the work orders assigned to a party linked to the login (B5.1);
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
    // occupancy dates are Bangkok business dates (review #15)
    const today = bangkokDate(this.clock.now());
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
    // B2.3: leases of the linked parties a resident may open (not drafts, not cancelled) — contract §8 lease scopes.
    const leases = links.length
      ? await tx.leaseParty.findMany({
          where: {
            partyId: { in: links.map((l) => l.partyId) },
            lease: {
              status: {
                in: ['pending_signature', 'active', 'notice_given', 'ending', 'ended', 'terminated'],
              },
            },
          },
          select: { leaseId: true },
        })
      : [];
    return {
      id: userId,
      type: 'user',
      audience: 'resident',
      roles: [],
      permissions: [],
      scopes: [
        ...[...new Set(leases.map((l) => l.leaseId))].map((l) => `lease:${l}`),
        ...units.map((u) => `unit:${u}`),
      ],
    };
  }

  /**
   * B5.1: `work_order:<id>` for every work order assigned to a party linked to the login, or carrying its LINE id
   * (the owner entered the technician with their LINE), that is assigned, accepted, in progress or done (not yet
   * verified or cancelled). Recomputed at every refresh, so a re-assigned work order drops out.
   */
  async technician(tx: Tx, userId: string): Promise<Subject> {
    const user = await tx.userAccount.findUnique({ where: { id: userId }, select: { lineUserId: true } });
    const orders = await tx.workOrder.findMany({
      where: {
        status: { in: ['assigned', 'accepted', 'in_progress', 'done'] },
        assigneeParty: {
          deletedAt: null,
          anonymisedAt: null,
          OR: [
            { userLinks: { some: { userId, state: 'active' } } },
            ...(user?.lineUserId ? [{ lineUserId: user.lineUserId }] : []),
          ],
        },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      id: userId,
      type: 'user',
      audience: 'technician',
      roles: [],
      permissions: [],
      scopes: orders.map((o) => `work_order:${o.id}`),
    };
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
        return this.technician(tx, user.id);
      case 'platform': {
        const s = await this.platform(tx, user.id);
        return s.roles.length ? s : null;
      }
    }
  }
}

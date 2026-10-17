import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';
import { ConsentService } from '@core/privacy/consent.service';
import { ADMIN_MENU, entitledMenu, type MenuEntry, OWNER_MENU, STAFF_MENU } from '@core/rbac/menu';
import { AccessService } from '@core/tenancy/access.service';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { dateOnly } from './mappers';
import {
  type AdminMeDto,
  type MeUserDto,
  type OperatorMeDto,
  type ResidentMeDto,
  type TechnicianMeDto,
  type TenantRoleName,
  type TenantStatusName,
  type TenantTypeName,
} from './me.dto';

/** `GET /v1/{surface}/me` for every audience (contract §4): who I am, what I may do, what the app should show. */
@Injectable()
export class MeService {
  constructor(
    private readonly db: TenantTx,
    private readonly access: AccessService,
    private readonly flags: FeatureFlagsService,
    private readonly consents: ConsentService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private userId(): string {
    const actor = RequestContext.actor();
    if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
    return actor.publicId;
  }

  private async user(userId: string) {
    return this.db.platform(async (tx) => {
      const user = await tx.userAccount.findUnique({ where: { id: userId } });
      if (!user) throw new DomainException('auth.unauthenticated');
      const credential = await tx.userCredential.findUnique({ where: { userId } });
      const dto: MeUserDto = {
        id: user.id,
        displayName: user.displayName,
        phone: user.phoneE164,
        email: user.email,
        language: user.language,
        lineLinked: Boolean(user.lineUserId),
      };
      return {
        dto,
        hasPassword: Boolean(credential?.passwordHash),
        totpEnabled: Boolean(credential?.totpEnabledAt),
      };
    });
  }

  async operator(menu: 'owner' | 'staff'): Promise<OperatorMeDto> {
    const userId = this.userId();
    const { dto, hasPassword, totpEnabled } = await this.user(userId);
    const memberships = await this.db.platform((tx) =>
      tx.membership.findMany({
        where: {
          userId,
          status: 'active',
          deletedAt: null,
          tenant: { deletedAt: null, status: { not: 'deactivated' } },
        },
        include: { tenant: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const tenant = RequestContext.tenant();
    const current = tenant ? await this.access.operator(userId, tenant.tenantId) : null;
    const flags = await this.flags.forTenant(current?.tenantId ?? null);
    const permissions = current ? [...current.permissions].sort() : [];
    const entries: readonly MenuEntry[] = menu === 'owner' ? OWNER_MENU : STAFF_MENU;
    const currentTenant = current
      ? memberships.find((m) => m.tenantId === current.tenantId)?.tenant
      : undefined;
    const actor = RequestContext.actor();
    return {
      user: dto,
      hasPassword,
      totpEnabled,
      tenants: memberships.map((m) => ({
        id: m.tenantId,
        displayName: m.tenant.displayName,
        type: m.tenant.type as TenantTypeName,
        status: m.tenant.status as TenantStatusName,
        role: m.role as TenantRoleName,
      })),
      currentTenant:
        current && currentTenant
          ? {
              id: current.tenantId,
              displayName: currentTenant.displayName,
              type: current.tenantType as TenantTypeName,
              status: current.tenantStatus as TenantStatusName,
              role: current.role as TenantRoleName,
              buildingIds: current.buildingIds,
            }
          : null,
      roles: current ? [current.role] : [],
      permissions,
      menu: current ? entitledMenu(entries, current.permissions, current.tenantType, flags) : [],
      featureFlags: flags,
      subscription: currentTenant
        ? { plan: currentTenant.plan, state: null, readOnly: currentTenant.status === 'read_only' }
        : null,
      scopes: actor && 'scopes' in actor ? [...actor.scopes] : [],
    };
  }

  async resident(): Promise<ResidentMeDto> {
    const userId = this.userId();
    const { dto } = await this.user(userId);
    const today = new Date(this.clock.now().toISOString().slice(0, 10));
    const units = await this.db.platform(async (tx) => {
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active' },
        select: { partyId: true },
      });
      if (!links.length) return [];
      return tx.occupancy.findMany({
        where: {
          partyId: { in: links.map((l) => l.partyId) },
          validFrom: { lte: today },
          OR: [{ validTo: null }, { validTo: { gt: today } }],
        },
        include: { unit: { include: { building: true } }, tenant: true },
        orderBy: { validFrom: 'asc' },
      });
    });
    const tenants = [...new Set(units.map((u) => u.tenantId))];
    const purposes = await this.consents.purposes(
      ['resident'],
      dto.language,
      { type: 'user', id: userId },
      tenants[0] ?? null,
    );
    const actor = RequestContext.actor();
    return {
      user: dto,
      units: units.map((o) => ({
        unitId: o.unitId,
        unitNo: o.unit.unitNo,
        buildingId: o.buildingId,
        buildingName: o.unit.building.name,
        tenantId: o.tenantId,
        tenantName: o.tenant.displayName,
        role: o.role,
        validFrom: dateOnly(o.validFrom)!,
      })),
      leaseIds: [],
      consents: purposes.map((p) => ({
        purposeKey: p.key,
        required: p.required,
        version: p.version,
        granted: p.granted,
      })),
      consentComplete: purposes.filter((p) => p.required).every((p) => p.granted === true),
      scopes: actor && 'scopes' in actor ? [...actor.scopes] : [],
    };
  }

  async technician(): Promise<TechnicianMeDto> {
    const { dto } = await this.user(this.userId());
    const actor = RequestContext.actor();
    const scopes = actor && 'scopes' in actor ? [...actor.scopes] : [];
    return {
      user: dto,
      workOrderIds: scopes
        .filter((s) => s.startsWith('work_order:'))
        .map((s) => s.slice('work_order:'.length)),
      scopes,
    };
  }

  async admin(): Promise<AdminMeDto> {
    const userId = this.userId();
    const { dto, totpEnabled } = await this.user(userId);
    const access = await this.access.platform(userId);
    return {
      user: dto,
      roles: access.roles,
      permissions: [...access.permissions].sort(),
      menu: entitledMenu(ADMIN_MENU, access.permissions, null, {}),
      featureFlags: await this.flags.forTenant(null),
      totpEnabled,
    };
  }
}

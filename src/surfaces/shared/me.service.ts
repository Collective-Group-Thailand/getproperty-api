import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';
import {
  occupiedUnitIds,
  residentUnitRoles,
  scopeUnitIds,
  type UnitRole,
  unitsHash,
} from '@core/identity/resident-units';
import { ConsentService } from '@core/privacy/consent.service';
import { ADMIN_MENU, entitledMenu, type MenuEntry, OWNER_MENU, STAFF_MENU } from '@core/rbac/menu';
import { AccessService } from '@core/tenancy/access.service';
import { TenantTx } from '@database/tenant-tx';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import { Inject, Injectable } from '@nestjs/common';

import {
  ResidentUnitCapability,
  type ResidentUnitRoleName,
  type ResidentUnitRoleRefDto,
  type ResidentUnitRoleSourceName,
} from '../resident/resident-unit-roles.dto';
import { type ResidentMeUnitsDto } from '../resident/resident-units.dto';
import { dateOnly } from './mappers';
import {
  type AdminMeDto,
  type MeUserDto,
  type OperatorMeDto,
  type ProspectMeDto,
  type ResidentLinkedDto,
  type ResidentMeDto,
  type SubscriptionStateName,
  type TechnicianMeDto,
  type TenantRoleName,
  type TenantStatusName,
  type TenantTypeName,
  type UserLanguageName,
} from './me.dto';
import {
  type AdminMenuKey,
  type LeasePartyRoleName,
  type LeaseStatusName,
  type OccupancyRoleName,
  type OwnerMenuKey,
  type PlatformRoleName,
  ResidentEntitlement,
} from './status.enums';

/** `GET /v1/{surface}/me` for every audience (contract §4): who I am, what I may do, what the app should show. */
@Injectable()
export class MeService {
  constructor(
    private readonly db: TenantTx,
    private readonly access: AccessService,
    private readonly flags: FeatureFlagsService,
    private readonly consents: ConsentService,
    private readonly residentLeases: ResidentLeasesService,
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
        language: user.language as UserLanguageName,
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
    // the tenant's latest subscription (B6.1, D-082)
    const subscription = current
      ? await this.db.platform((tx) =>
          tx.subscription.findFirst({
            where: { tenantId: current.tenantId },
            orderBy: { startedAt: 'desc' },
            select: { state: true, planKey: true },
          }),
        )
      : null;
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
      roles: current ? [current.role as TenantRoleName] : [],
      permissions,
      menu: current
        ? (entitledMenu(entries, current.permissions, current.tenantType, flags) as OwnerMenuKey[])
        : [],
      featureFlags: flags,
      subscription: currentTenant
        ? {
            plan: subscription?.planKey ?? currentTenant.plan,
            state: (subscription?.state as SubscriptionStateName | undefined) ?? null,
            readOnly: currentTenant.status === 'read_only',
          }
        : null,
      scopes: actor && 'scopes' in actor ? [...actor.scopes] : [],
    };
  }

  async resident(): Promise<ResidentMeDto> {
    const userId = this.userId();
    const { dto } = await this.user(userId);
    // occupancy dates are Bangkok business dates (review #15)
    const today = new Date(bangkokDate(this.clock.now()));
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
    const leases = await this.db.platform(async (tx) => {
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active' },
        select: { partyId: true },
      });
      if (!links.length) return [];
      return tx.leaseParty.findMany({
        where: {
          partyId: { in: links.map((l) => l.partyId) },
          lease: {
            status: { in: ['pending_signature', 'active', 'notice_given', 'ending', 'ended', 'terminated'] },
          },
        },
        include: {
          lease: {
            include: {
              unit: { select: { unitNo: true } },
              building: { select: { name: true } },
              tenant: { select: { displayName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    });
    // JR (D-322): units I own without living there (co-owners) — scopes, entitlements and `unitRoles`
    const view = await this.unitView(userId);
    const occupied = new Set(units.map((u) => u.unitId));
    const owned = view.units
      .filter((u) => !occupied.has(u.id))
      .map((u) => ({ unitId: u.id, tenantId: view.tenantOf(u.id) }));
    const tenants = [
      ...new Set([
        ...units.map((u) => u.tenantId),
        ...leases.map((l) => l.tenantId),
        ...owned.map((u) => u.tenantId),
      ]),
    ];
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
        role: o.role as OccupancyRoleName,
        validFrom: dateOnly(o.validFrom)!,
      })),
      leaseIds: [...new Set(leases.map((l) => l.leaseId))],
      leases: leases.map((l) => ({
        leaseId: l.leaseId,
        number: l.lease.number,
        status: l.lease.status as LeaseStatusName,
        tenantId: l.tenantId,
        tenantName: l.lease.tenant.displayName,
        unitNo: l.lease.unit.unitNo,
        buildingName: l.lease.building.name,
        role: l.role as LeasePartyRoleName,
        startDate: dateOnly(l.lease.startDate)!,
        endDate: dateOnly(l.lease.endDate),
      })),
      consents: purposes.map((p) => ({
        purposeKey: p.key,
        required: p.required,
        version: p.version,
        granted: p.granted,
      })),
      consentComplete: purposes.filter((p) => p.required).every((p) => p.granted === true),
      unitRoles: view.refs,
      entitlements: await this.entitlements(
        units.map((u) => ({ unitId: u.unitId, tenantId: u.tenantId })),
        leases.length > 0,
        tenants,
        owned,
      ),
      scopes: actor && 'scopes' in actor ? [...actor.scopes] : [],
      linkRequestsPending: await this.linkRequestsPending(userId),
    };
  }

  /**
   * JR (D-309, D-322): my unit roles today (ownership, occupancy, leases in force) and the units of my `unit:` scopes
   * with their building, property and the tenant that runs them for me.
   */
  private async unitView(userId: string) {
    const today = bangkokDate(this.clock.now());
    const { roles, units, tenants } = await this.db.platform(async (tx) => {
      const roles = await residentUnitRoles(tx, userId, today);
      const ids = scopeUnitIds(roles);
      const units = ids.length
        ? await tx.unit.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              unitNo: true,
              buildingId: true,
              building: { select: { name: true, propertyId: true } },
            },
          })
        : [];
      const tenantIds = [...new Set(roles.map((r) => r.tenantId))];
      const tenants = tenantIds.length
        ? await tx.tenant.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, displayName: true },
          })
        : [];
      return { roles, units: ids.map((id) => units.find((u) => u.id === id)!).filter(Boolean), tenants };
    });
    const rolesOf = (unitId: string) => roles.filter((r) => r.unitId === unitId);
    // the tenant that runs the unit for me: my occupancy's, else the ownership register's
    const tenantOf = (unitId: string): string =>
      (rolesOf(unitId).find((r) => r.source === 'occupancy') ?? rolesOf(unitId)[0]!).tenantId;
    const refs: ResidentUnitRoleRefDto[] = units.flatMap((u) =>
      rolesOf(u.id).map((r) => ({
        unitId: u.id,
        buildingId: u.buildingId,
        propertyId: u.building.propertyId,
        tenantId: r.tenantId,
        role: r.role as ResidentUnitRoleName,
        source: r.source as ResidentUnitRoleSourceName,
        from: r.from,
        to: r.to,
      })),
    );
    return { roles, units, tenants, rolesOf, tenantOf, refs };
  }

  /** `GET /v1/resident/me/units` (JR, D-322): my units with roles, navigation capabilities and the roles' hash. */
  async residentUnits(): Promise<ResidentMeUnitsDto> {
    const userId = this.userId();
    const view = await this.unitView(userId);
    const actor = RequestContext.actor();
    const tokenUnits = new Set(
      (actor && 'scopes' in actor ? actor.scopes : [])
        .filter((x) => x.startsWith('unit:'))
        .map((x) => x.slice('unit:'.length)),
    );
    const current = new Set(view.units.map((u) => u.id));
    const refreshRequired = tokenUnits.size !== current.size || [...current].some((u) => !tokenUnits.has(u));
    return {
      units: view.units.map((u) => {
        const roles = view.rolesOf(u.id);
        const tenantId = view.tenantOf(u.id);
        return {
          unitId: u.id,
          unitNo: u.unitNo,
          buildingId: u.buildingId,
          buildingName: u.building.name,
          propertyId: u.building.propertyId,
          tenantId,
          tenantName: view.tenants.find((t) => t.id === tenantId)?.displayName ?? '',
          roles: roles.map((r) => ({
            role: r.role as ResidentUnitRoleName,
            source: r.source as ResidentUnitRoleSourceName,
            partyId: r.partyId,
            leaseId: r.source === 'lease' ? r.sourceId : null,
            from: r.from,
            to: r.to,
          })),
          capabilities: unitCapabilities(roles),
          leaseIds: [...new Set(roles.filter((r) => r.source === 'lease').map((r) => r.sourceId))],
        };
      }),
      unitsHash: unitsHash(view.roles.filter((r) => current.has(r.unitId))),
      refreshRequired,
    };
  }

  /** D-226: my phone-match link requests still waiting for a landlord (any tenant; a count only, no party data). */
  private linkRequestsPending(userId: string): Promise<number> {
    return this.db.platform((tx) => tx.partyLinkRequest.count({ where: { userId, state: 'pending' } }));
  }

  /**
   * Resident app entitlements (D-063): bills and lease with any lease or occupancy, usage where an installed IoT
   * meter serves one of my units now, the R2 modules where one of my tenants has the feature flag on — facilities
   * and access also need a bookable facility / an active unit lock of mine (LIFF #27, D-218).
   */
  private async entitlements(
    units: { unitId: string; tenantId: string }[],
    hasLease: boolean,
    tenantIds: string[],
    /** JR (D-322): units I own without living there — bills and the tenant's modules, never lease / usage / access. */
    owned: { unitId: string; tenantId: string }[] = [],
  ): Promise<ResidentEntitlement[]> {
    const out = new Set<ResidentEntitlement>();
    if (hasLease || units.length) {
      out.add(ResidentEntitlement.Bills);
      out.add(ResidentEntitlement.Lease);
    }
    if (owned.length) out.add(ResidentEntitlement.Bills);
    if (units.length) {
      const iot = await this.db.platform((tx) =>
        tx.meterAssignment.count({
          where: {
            unitId: { in: units.map((u) => u.unitId) },
            validTo: null,
            assetItem: { deviceAssetItem: { status: { notIn: ['retired', 'inventory'] } } },
          },
        }),
      );
      if (iot > 0) out.add(ResidentEntitlement.Usage);
    }
    for (const tenantId of tenantIds) {
      const flags = await this.flags.forTenant(tenantId);
      if (flags['module.service_requests']) out.add(ResidentEntitlement.ServiceRequests);
      if (flags['module.community']) {
        out.add(ResidentEntitlement.Announcements);
        out.add(ResidentEntitlement.Parcels);
      }
      // LIFF #27 (D-218): the B5 menus get their own entitlements — facilities when one of my buildings of this
      // tenant has a bookable facility, access when one of my units of this tenant has an active door lock
      const mine = units.filter((u) => u.tenantId === tenantId).map((u) => u.unitId);
      const mineOrOwned = [...mine, ...owned.filter((u) => u.tenantId === tenantId).map((u) => u.unitId)];
      if (!mineOrOwned.length) continue;
      if (flags['module.community'] && !out.has(ResidentEntitlement.Facilities)) {
        const facilities = await this.db.platform((tx) =>
          tx.facility.count({
            where: {
              tenantId,
              isActive: true,
              deletedAt: null,
              building: { units: { some: { id: { in: mineOrOwned } } } },
            },
          }),
        );
        if (facilities > 0) out.add(ResidentEntitlement.Facilities);
      }
      if (mine.length && flags['module.smart_access'] && !out.has(ResidentEntitlement.Access)) {
        const locks = await this.db.platform((tx) =>
          tx.lock.count({ where: { tenantId, unitId: { in: mine }, scope: 'unit', isActive: true } }),
        );
        if (locks > 0) out.add(ResidentEntitlement.Access);
      }
    }
    const order = Object.values(ResidentEntitlement);
    return [...out].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  /** `PATCH /v1/resident/me`: the resident's language (D-064), audited through the account row's updated_at. */
  async setResidentLanguage(language: UserLanguageName): Promise<void> {
    const userId = this.userId();
    await this.db.platform((tx) =>
      tx.userAccount.update({ where: { id: userId }, data: { language, updatedBy: userId } }),
    );
  }

  /** `POST /v1/resident/link`: accepts the invitation and answers with the units I now occupy. */
  async residentLink(code: string, language: string): Promise<ResidentLinkedDto> {
    const accepted = await this.residentLeases.acceptInvitation(code, language);
    const me = await this.resident();
    return {
      tenantId: accepted.tenantId,
      leaseId: accepted.leaseId,
      partyId: accepted.partyId,
      units: me.units.filter((u) => u.tenantId === accepted.tenantId),
      refreshRequired: accepted.refreshRequired,
    };
  }

  async technician(): Promise<TechnicianMeDto> {
    const userId = this.userId();
    const { dto } = await this.user(userId);
    const actor = RequestContext.actor();
    const scopes = actor && 'scopes' in actor ? [...actor.scopes] : [];
    return {
      user: dto,
      workOrderIds: scopes
        .filter((s) => s.startsWith('work_order:'))
        .map((s) => s.slice('work_order:'.length)),
      scopes,
      linkRequestsPending: await this.linkRequestsPending(userId),
    };
  }

  async prospect(): Promise<ProspectMeDto> {
    const userId = this.userId();
    const { dto } = await this.user(userId);
    const now = this.clock.now();
    const [openEnquiries, upcomingViewings] = await this.db.platform(async (tx) => [
      await tx.listingLead.count({ where: { userId, state: { notIn: ['won', 'lost'] } } }),
      await tx.listingViewing.count({
        where: { lead: { userId }, state: { in: ['requested', 'confirmed'] }, startsAt: { gt: now } },
      }),
    ]);
    return { user: dto, openEnquiries, upcomingViewings };
  }

  async admin(): Promise<AdminMeDto> {
    const userId = this.userId();
    const { dto, totpEnabled } = await this.user(userId);
    const access = await this.access.platform(userId);
    return {
      user: dto,
      roles: access.roles as PlatformRoleName[],
      permissions: [...access.permissions].sort(),
      menu: entitledMenu(ADMIN_MENU, access.permissions, null, {}) as AdminMenuKey[],
      featureFlags: await this.flags.forTenant(null),
      totpEnabled,
    };
  }
}

/** JR (D-322): what the resident app may show for a unit, from my roles on it (`ResidentMeUnitDto.capabilities`). */
export function unitCapabilities(roles: readonly UnitRole[]): ResidentUnitCapability[] {
  const out = new Set<ResidentUnitCapability>([
    ResidentUnitCapability.Notices,
    ResidentUnitCapability.Parcels,
    ResidentUnitCapability.Facilities,
    ResidentUnitCapability.Rules,
    ResidentUnitCapability.Contacts,
    ResidentUnitCapability.ServiceRequests,
  ]);
  if (roles.some((r) => r.role !== 'family')) out.add(ResidentUnitCapability.Invoices);
  if (occupiedUnitIds(roles).length) {
    out.add(ResidentUnitCapability.Usage);
    out.add(ResidentUnitCapability.Access);
  }
  if (roles.some((r) => r.source === 'lease' && r.role !== 'payer')) out.add(ResidentUnitCapability.Lease);
  const order = Object.values(ResidentUnitCapability);
  return [...out].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

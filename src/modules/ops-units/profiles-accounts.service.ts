import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { mapConflicts } from '@database/pg-errors';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Prisma, type Utility, type UtilityProvider } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { operatedBuilding, visibleBuilding } from './building-access';

const by = () => userIdOf(RequestContext.actor());

/** Fixed monthly items a unit profile proposes for new leases (D-041); kinds = `ops.lease_line_kind`. */
export const LEASE_LINE_KINDS = [
  'internet',
  'parking',
  'cleaning',
  'furniture',
  'common_fee',
  'water_minimum',
  'other_fixed',
] as const;
export type LeaseLineKindKey = (typeof LEASE_LINE_KINDS)[number];

export interface DefaultLeaseLine {
  kind: LeaseLineKindKey;
  description: string;
  amount: string;
}

export interface UnitProfileInput {
  name: string;
  areaSqm?: string | null;
  defaultRent: string;
  defaultDepositMonths?: string;
  defaultAdvanceRentMonths?: string;
  defaultLeaseLines?: DefaultLeaseLine[];
}

/** Unit profiles = the v1 room types of a building (B2.1). Soft-deleted; units keep their reference. */
@Injectable()
export class UnitProfilesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  list(ctx: TenantContext, buildingId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await visibleBuilding(tx, ctx, buildingId);
      return tx.unitProfile.findMany({ where: { buildingId, deletedAt: null }, orderBy: { name: 'asc' } });
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const p = this.found(await tx.unitProfile.findFirst({ where: { id, deletedAt: null } }));
      await visibleBuilding(tx, ctx, p.buildingId);
      return p;
    });
  }

  create(ctx: TenantContext, buildingId: string, input: UnitProfileInput) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const b = await operatedBuilding(tx, ctx, buildingId);
          const p = await tx.unitProfile.create({
            data: {
              tenantId: b.tenantId,
              buildingId: b.id,
              name: input.name.trim(),
              areaSqm: input.areaSqm ?? null,
              defaultRent: input.defaultRent,
              defaultDepositMonths: input.defaultDepositMonths ?? '1',
              defaultAdvanceRentMonths: input.defaultAdvanceRentMonths ?? '1',
              defaultLeaseLines: (input.defaultLeaseLines ?? []) as unknown as Prisma.InputJsonValue,
              createdBy: by(),
            },
          });
          await this.events.record(tx, {
            type: 'unit_profile.changed',
            aggregateType: 'unit_profile',
            aggregateId: p.id,
            tenantId: b.tenantId,
            buildingId: b.id,
            payload: { unitProfileId: p.id, change: 'created' },
          });
          return p;
        }),
      () => new DomainException('asset.duplicate', { params: { what: 'unit profile name' } }),
    );
  }

  update(ctx: TenantContext, id: string, version: number, patch: Partial<UnitProfileInput>) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const current = this.found(await tx.unitProfile.findFirst({ where: { id, deletedAt: null } }));
          await operatedBuilding(tx, ctx, current.buildingId);
          if (current.version !== version) throw new DomainException('concurrency.stale');
          const p = await tx.unitProfile.update({
            where: { id },
            data: {
              ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
              ...(patch.areaSqm !== undefined ? { areaSqm: patch.areaSqm } : {}),
              ...(patch.defaultRent !== undefined ? { defaultRent: patch.defaultRent } : {}),
              ...(patch.defaultDepositMonths !== undefined
                ? { defaultDepositMonths: patch.defaultDepositMonths }
                : {}),
              ...(patch.defaultAdvanceRentMonths !== undefined
                ? { defaultAdvanceRentMonths: patch.defaultAdvanceRentMonths }
                : {}),
              ...(patch.defaultLeaseLines !== undefined
                ? { defaultLeaseLines: patch.defaultLeaseLines as unknown as Prisma.InputJsonValue }
                : {}),
              updatedBy: by(),
              version: { increment: 1 },
            },
          });
          await this.events.record(tx, {
            type: 'unit_profile.changed',
            aggregateType: 'unit_profile',
            aggregateId: id,
            tenantId: current.tenantId,
            buildingId: current.buildingId,
            payload: { unitProfileId: id, change: 'updated', fields: Object.keys(patch) },
          });
          return p;
        }),
      () => new DomainException('asset.duplicate', { params: { what: 'unit profile name' } }),
    );
  }

  remove(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const current = this.found(await tx.unitProfile.findFirst({ where: { id, deletedAt: null } }));
      await operatedBuilding(tx, ctx, current.buildingId);
      await tx.unitProfile.update({
        where: { id },
        data: { deletedAt: this.clock.now(), deletedBy: by(), version: { increment: 1 } },
      });
      await this.events.record(tx, {
        type: 'unit_profile.changed',
        aggregateType: 'unit_profile',
        aggregateId: id,
        tenantId: current.tenantId,
        buildingId: current.buildingId,
        payload: { unitProfileId: id, change: 'deleted' },
      });
    });
  }
}

export interface UtilityAccountInput {
  utility: Utility;
  provider: UtilityProvider;
  customerNo: string;
  meterNo?: string | null;
  label: string;
}

const PROVIDERS: Record<Utility, UtilityProvider[]> = { electric: ['mea', 'pea'], water: ['mwa', 'pwa'] };

/** The building's MEA/PEA/MWA/PWA customer accounts (D-032; utility invoices attach to them in B3.4). */
@Injectable()
export class UtilityAccountsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
  ) {
    super();
  }

  private check(input: Pick<UtilityAccountInput, 'utility' | 'provider'>) {
    if (!PROVIDERS[input.utility].includes(input.provider))
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'provider',
            code: 'utilityProvider',
            message: `${input.provider} does not supply ${input.utility} (${PROVIDERS[input.utility].join('/')})`,
          },
        ],
      });
  }

  list(ctx: TenantContext, buildingId: string) {
    return this.db.tenant(ctx, async (tx) => {
      await visibleBuilding(tx, ctx, buildingId);
      return tx.utilityAccount.findMany({
        where: { buildingId },
        orderBy: [{ utility: 'asc' }, { label: 'asc' }],
      });
    });
  }

  create(ctx: TenantContext, buildingId: string, input: UtilityAccountInput) {
    this.check(input);
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const b = await operatedBuilding(tx, ctx, buildingId);
          const a = await tx.utilityAccount.create({
            data: {
              tenantId: b.tenantId,
              buildingId: b.id,
              utility: input.utility,
              provider: input.provider,
              customerNo: input.customerNo,
              meterNo: input.meterNo ?? null,
              label: input.label,
              createdBy: by(),
            },
          });
          await this.events.record(tx, {
            type: 'utility_account.changed',
            aggregateType: 'utility_account',
            aggregateId: a.id,
            tenantId: b.tenantId,
            buildingId: b.id,
            payload: { utilityAccountId: a.id, change: 'created', utility: a.utility, provider: a.provider },
          });
          return a;
        }),
      () => new DomainException('asset.duplicate', { params: { what: 'utility account' } }),
    );
  }

  update(ctx: TenantContext, id: string, patch: Partial<UtilityAccountInput>) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const current = this.found(await tx.utilityAccount.findFirst({ where: { id } }));
          await operatedBuilding(tx, ctx, current.buildingId);
          this.check({
            utility: patch.utility ?? current.utility,
            provider: patch.provider ?? current.provider,
          });
          const a = await tx.utilityAccount.update({ where: { id }, data: { ...patch, updatedBy: by() } });
          await this.events.record(tx, {
            type: 'utility_account.changed',
            aggregateType: 'utility_account',
            aggregateId: id,
            tenantId: current.tenantId,
            buildingId: current.buildingId,
            payload: { utilityAccountId: id, change: 'updated', fields: Object.keys(patch) },
          });
          return a;
        }),
      () => new DomainException('asset.duplicate', { params: { what: 'utility account' } }),
    );
  }

  remove(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const current = this.found(await tx.utilityAccount.findFirst({ where: { id } }));
      await operatedBuilding(tx, ctx, current.buildingId);
      await tx.utilityAccount.delete({ where: { id } });
      await this.events.record(tx, {
        type: 'utility_account.changed',
        aggregateType: 'utility_account',
        aggregateId: id,
        tenantId: current.tenantId,
        buildingId: current.buildingId,
        payload: { utilityAccountId: id, change: 'deleted' },
      });
    });
  }
}

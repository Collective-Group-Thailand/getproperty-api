import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { AccessService } from '@core/tenancy/access.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type AccessEvent,
  type Lock,
  type LockScope,
  type LockVendor,
  type Prisma,
} from '@generated/prisma/client';
import { LOCK_VENDORS, type LockVendorRegistry } from '@integrations/locks/lock-vendor.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AccessCredentialsService,
  CREDENTIAL_INCLUDE,
  type CredentialRow,
} from './access-credentials.service';
import { LIVE_STATUSES, validWindow } from './access-rules';

export const LOCK_INCLUDE = {
  unit: { select: { id: true, unitNo: true } },
  device: { select: { id: true, serial: true, model: true, status: true } },
} satisfies Prisma.LockInclude;
export type LockRow = Prisma.LockGetPayload<{ include: typeof LOCK_INCLUDE }>;

export interface LockRegisterInput {
  scope: LockScope;
  unitId?: string | null;
  buildingId?: string | null;
  vendor: LockVendor;
  vendorLockId: string;
  serial: string;
  name: string;
  model?: string | null;
}

const by = () => userIdOf(RequestContext.actor());
/** How far back the first unlock-log sync of a lock reads. */
const FIRST_SYNC_MS = 7 * 86_400_000;

/**
 * Locks (B5.2, D-070): a lock of a unit, a building door or a common area is registered as a `core.asset_item`
 * (category `lock`) + `smart.device` (kind `lock`, tenant-owned) + `smart.lock` (vendor id, place). Registering a
 * unit lock while the unit is leased issues the residents' credentials at once (the lease decides, D-071). The
 * worker refreshes battery levels (low battery → automatic repair request, D-034) and reads the unlock log into
 * `smart.access_event` (monthly partitions, D-162).
 */
@Injectable()
export class LocksService extends TenantScopedRepository {
  private readonly logger = new Logger(LocksService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly credentials: AccessCredentialsService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly access: AccessService,
    @Inject(LOCK_VENDORS) private readonly vendors: LockVendorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  list(ctx: TenantContext, f: { buildingId?: string; unitId?: string }): Promise<LockRow[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.lock.findMany({
        where: this.own(ctx, {
          ...(f.buildingId ? { buildingId: f.buildingId } : {}),
          ...(f.unitId ? { unitId: f.unitId } : {}),
          ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}),
        }),
        include: LOCK_INCLUDE,
        orderBy: [{ scope: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  get(ctx: TenantContext, id: string): Promise<LockRow> {
    return this.db.tenant(ctx, async (tx) => this.load(tx, ctx, id));
  }

  async load(tx: Tx, ctx: TenantContext, id: string): Promise<LockRow> {
    return this.found(
      await tx.lock.findFirst({
        where: this.own(ctx, { id, ...(ctx.buildingIds ? { buildingId: this.buildingScope(ctx) } : {}) }),
        include: LOCK_INCLUDE,
      }),
    );
  }

  async register(ctx: TenantContext, input: LockRegisterInput): Promise<LockRow> {
    const id = await this.db.tenant(ctx, async (tx) => {
      let buildingId = input.buildingId ?? null;
      if (input.scope === 'unit') {
        if (!input.unitId)
          throw new DomainException('validation.failed', {
            errors: [{ path: 'unitId', code: 'required', message: 'a unit lock needs its unit' }],
          });
        const unit = this.found(await tx.unit.findFirst({ where: { id: input.unitId, deletedAt: null } }));
        buildingId = unit.buildingId;
      }
      if (!buildingId)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'buildingId', code: 'required', message: 'the building of the door' }],
        });
      const building = await tx.building.findFirst({
        where: {
          id: buildingId,
          deletedAt: null,
          OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
        },
      });
      if (!building || (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)))
        throw new DomainException('http.not_found');
      const taken = await this.db.platform((p) =>
        p.lock.count({ where: { vendor: input.vendor, vendorLockId: input.vendorLockId } }),
      );
      const serialTaken = await this.db.platform((p) => p.device.count({ where: { serial: input.serial } }));
      if (taken || serialTaken) throw new DomainException('lock.exists');
      const unitId = input.scope === 'unit' ? input.unitId! : null;
      const item = await tx.assetItem.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId,
          unitId,
          category: 'lock',
          name: input.name,
          manufacturer: input.vendor,
          model: input.model ?? null,
          serial: input.serial,
          createdBy: by(),
        },
      });
      const device = await tx.device.create({
        data: {
          serial: input.serial,
          kind: 'lock',
          model: input.model ?? input.vendor,
          vendor: input.vendor,
          ownership: 'tenant_owned',
          tenantId: ctx.tenantId,
          buildingId,
          assetItemId: item.id,
          status: 'provisioned',
          createdBy: by(),
        },
      });
      const lock = await tx.lock.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId,
          unitId,
          deviceId: device.id,
          assetItemId: item.id,
          scope: input.scope,
          vendor: input.vendor,
          vendorLockId: input.vendorLockId,
          name: input.name,
          createdBy: by(),
        },
      });
      await this.events.record(tx, {
        type: 'lock.registered',
        aggregateType: 'lock',
        aggregateId: lock.id,
        tenantId: ctx.tenantId,
        buildingId,
        payload: { lockId: lock.id, unitId, scope: lock.scope, vendor: lock.vendor, assetItemId: item.id },
      });
      return lock.id;
    });
    return this.get(ctx, id);
  }

  async setActive(ctx: TenantContext, id: string, isActive: boolean): Promise<LockRow> {
    await this.db.tenant(ctx, async (tx) => {
      const lock = await this.load(tx, ctx, id);
      await tx.lock.update({
        where: { id: lock.id },
        data: { isActive, version: { increment: 1 }, updatedBy: by() },
      });
    });
    return this.get(ctx, id);
  }

  /**
   * A time-boxed code issued by the owner (D-070): a visitor by name, or a staff member of the tenant (outside a work
   * order). The clear PIN is answered once to the issuer.
   */
  async issueCode(
    ctx: TenantContext,
    lockId: string,
    input: {
      kind: 'visitor' | 'staff';
      name?: string | null;
      userId?: string | null;
      validFrom: Date;
      validTo: Date;
    },
  ): Promise<CredentialRow & { pin: string }> {
    const problem = validWindow(input.validFrom, input.validTo, this.clock.now());
    if (problem)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'validTo', code: 'window', message: problem }],
      });
    let holderName = input.name?.trim() ?? '';
    if (input.kind === 'staff') {
      const member = input.userId ? await this.access.operator(input.userId, ctx.tenantId) : null;
      if (!member)
        throw new DomainException('validation.failed', {
          errors: [{ path: 'userId', code: 'notMember', message: 'a member of the tenant' }],
        });
      holderName =
        (await this.db.platform((tx) => tx.userAccount.findUnique({ where: { id: input.userId! } })))
          ?.displayName ?? 'staff';
    }
    if (!holderName)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'visitorName', code: 'required', message: 'the visitor’s name' }],
      });
    const issued = await this.db.tenant(ctx, async (tx) => {
      const lock = await this.load(tx, ctx, lockId);
      if (!lock.isActive)
        throw new DomainException('access.invalid_state', { params: { status: 'inactive' } });
      return this.credentials.issueIn(tx, {
        lock,
        holderKind: input.kind,
        holderUserId: input.kind === 'staff' ? input.userId : null,
        holderName,
        validFrom: input.validFrom,
        validTo: input.validTo,
      });
    });
    return { ...(await this.credentials.get(ctx, issued.id)), pin: issued.pin };
  }

  credentialsOf(ctx: TenantContext, lockId: string, live: boolean): Promise<CredentialRow[]> {
    return this.db.tenant(ctx, async (tx) => {
      const lock = await this.load(tx, ctx, lockId);
      return tx.accessCredential.findMany({
        where: { lockId: lock.id, ...(live ? { status: { in: [...LIVE_STATUSES] } } : {}) },
        include: CREDENTIAL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }],
        take: 500,
      });
    });
  }

  /** Unlock events of a lock for the owner (audited read of personal data, D-025). */
  async eventsOf(
    ctx: TenantContext,
    lockId: string,
    range: { from: Date; to: Date; take: number },
  ): Promise<AccessEvent[]> {
    return this.db.tenant(ctx, async (tx) => {
      const lock = await this.load(tx, ctx, lockId);
      await this.audit.record(tx, {
        action: 'access.log_read',
        tenantId: lock.tenantId,
        buildingId: lock.buildingId,
        subjectType: 'smart.lock',
        subjectId: lock.id,
        metadata: { from: range.from.toISOString(), to: range.to.toISOString() },
      });
      return tx.accessEvent.findMany({
        where: { lockId: lock.id, time: { gte: range.from, lt: range.to } },
        orderBy: { time: 'desc' },
        take: range.take,
      });
    });
  }

  // ------------------------------------------------------------------------------------------- worker jobs

  /** Battery and online state of a lock; a low battery opens an automatic repair request once (D-034). */
  async refreshStatus(lockId: string): Promise<Lock | null> {
    return RequestContext.run({ actor: systemActor('lock-status') }, async () => {
      const lock = await this.db.platform((tx) => tx.lock.findUnique({ where: { id: lockId } }));
      if (!lock?.isActive) return lock;
      const resolved = await this.credentials.lockRef(lock);
      if ('error' in resolved) return lock;
      let status;
      try {
        status = await this.vendors.adapter(resolved.ref.vendor).status(resolved.ref);
      } catch (error) {
        this.logger.warn({ event: 'lock_status_failed', lockId, error: (error as Error).message });
        return lock;
      }
      const now = this.clock.now();
      const threshold = await this.settings.valueAt<number>('access.battery_low_pct', now, {
        tenantId: lock.tenantId,
      });
      const low = status.batteryPct !== null && status.batteryPct <= (threshold ?? 20);
      return this.db.platform(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${lock.tenantId}, true)`;
        const updated = await tx.lock.update({
          where: { id: lock.id },
          data: {
            batteryPct: status.batteryPct,
            batteryCheckedAt: now,
            online: status.online,
            batteryLowSince: low ? (lock.batteryLowSince ?? now) : null,
          },
        });
        if (low && !lock.batteryLowSince)
          await this.events.record(tx, {
            type: 'service.auto_request_requested',
            aggregateType: 'asset_item',
            aggregateId: lock.assetItemId,
            tenantId: lock.tenantId,
            buildingId: lock.buildingId,
            payload: {
              assetItemId: lock.assetItemId,
              unitId: lock.unitId,
              reason: 'lock_battery_low',
              code: lock.name,
              batteryPct: status.batteryPct,
            },
          });
        return updated;
      });
    });
  }

  /** Reads the vendor's unlock log since the last sync into `smart.access_event` (deduplicated per vendor event). */
  async syncLog(lockId: string): Promise<number> {
    return RequestContext.run({ actor: systemActor('lock-log') }, async () => {
      const lock = await this.db.platform((tx) => tx.lock.findUnique({ where: { id: lockId } }));
      if (!lock?.isActive) return 0;
      const resolved = await this.credentials.lockRef(lock);
      if ('error' in resolved) return 0;
      const now = this.clock.now();
      const since = lock.lastLogSyncAt ?? new Date(now.getTime() - FIRST_SYNC_MS);
      let events;
      try {
        events = await this.vendors.adapter(resolved.ref.vendor).unlockLog(resolved.ref, since, now);
      } catch (error) {
        this.logger.warn({ event: 'lock_log_failed', lockId, error: (error as Error).message });
        return 0;
      }
      return this.db.platform(async (tx) => {
        const refs = [...new Set(events.map((e) => e.vendorCredentialRef).filter((r): r is string => !!r))];
        const creds = refs.length
          ? await tx.accessCredential.findMany({
              where: { lockId: lock.id, vendorCredentialRef: { in: refs } },
              select: { id: true, vendorCredentialRef: true, holderPartyId: true },
            })
          : [];
        let inserted = 0;
        const months = new Set<string>();
        for (const e of events) {
          const month = e.at.toISOString().slice(0, 7);
          if (!months.has(month)) {
            await tx.$executeRaw`SELECT smart.ensure_month_partition('smart.access_event'::regclass, ${e.at})`;
            months.add(month);
          }
          const cred = creds.find((c) => c.vendorCredentialRef === e.vendorCredentialRef);
          const result = await tx.$executeRaw`
            INSERT INTO smart.access_event (time, tenant_id, building_id, unit_id, lock_id, device_id, credential_id,
                                            holder_party_id, result, source, vendor_event_id, detail)
            VALUES (${e.at}, ${lock.tenantId}::uuid, ${lock.buildingId}::uuid, ${lock.unitId}::uuid, ${lock.id}::uuid,
                    ${lock.deviceId}::uuid, ${cred?.id ?? null}::uuid, ${cred?.holderPartyId ?? null}::uuid,
                    ${e.result}::smart.access_result, ${e.source}::smart.access_source, ${e.vendorEventId},
                    ${JSON.stringify(e.detail ?? {})}::jsonb)
            ON CONFLICT (device_id, vendor_event_id, time) DO NOTHING`;
          inserted += result;
        }
        await tx.lock.update({ where: { id: lock.id }, data: { lastLogSyncAt: now } });
        return inserted;
      });
    });
  }

  /** Worker job: status + log of every active lock with an adapter; partitions of the next months. */
  async sweep(): Promise<{ locks: number; events: number }> {
    const now = this.clock.now();
    await this.db.platform(async (tx) => {
      for (let m = 0; m <= 2; m += 1) {
        const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 15));
        await tx.$executeRaw`SELECT smart.ensure_month_partition('smart.access_event'::regclass, ${at})`;
      }
    });
    const locks = await this.db.platform((tx) =>
      tx.lock.findMany({ where: { isActive: true }, select: { id: true }, take: 2000 }),
    );
    let events = 0;
    for (const l of locks) {
      await this.refreshStatus(l.id);
      events += await this.syncLog(l.id);
    }
    return { locks: locks.length, events };
  }
}

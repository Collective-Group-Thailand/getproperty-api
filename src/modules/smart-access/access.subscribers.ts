import { startOfBangkokDay } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import {
  billedParty,
  type Recipient,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { registerRealtimeChannels } from '@core/subscribers/subscribers';
import { type Tx } from '@database/prisma.service';
import { type Lock } from '@generated/prisma/client';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { AccessCredentialsService } from './access-credentials.service';
import { LEASE_END_EVENTS, LIVE_STATUSES, workOrderWindow } from './access-rules';

/** Locks a holder of a unit gets: the unit's own locks and the doors of its building. */
async function locksFor(
  tx: Tx,
  tenantId: string,
  buildingId: string,
  unitId: string | null,
): Promise<Lock[]> {
  return tx.lock.findMany({
    where: {
      tenantId,
      isActive: true,
      OR: [{ scope: 'building_door', buildingId }, ...(unitId ? [{ scope: 'unit' as const, unitId }] : [])],
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * The access lifecycle (B5.2, D-070, D-071) — driven **only** by leases and work orders:
 * - `lease.activated` → a credential per lessee / co-tenant on the unit's locks and the building doors, valid from
 *   the lease start (also when a lock is registered on a leased unit: `lock.registered`);
 * - `lease.ended`, `lease.terminated` → those credentials are revoked;
 * - `work_order.assigned` → a time-boxed code for the assignee (staff login or technician party) for the visit
 *   window (or `access.work_order_window_hours`), the previous assignee's codes revoked;
 * - the work order done / verified / cancelled → its codes revoked.
 * Invoices, payments, reminders and receivables never reach this subscriber (D-024, D-157).
 */
@Injectable()
export class AccessLifecycle implements EventSubscriber, OnModuleInit {
  readonly name = 'access-lifecycle';
  readonly eventTypes = [
    'lease.activated',
    ...LEASE_END_EVENTS,
    'lock.registered',
    'work_order.assigned',
    'work_order.changed',
    'work_order.completed',
  ] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly credentials: AccessCredentialsService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    switch (event.type) {
      case 'lease.activated':
        return this.leaseActivated(tx, event.payload.leaseId as string);
      case 'lease.ended':
      case 'lease.terminated':
        return this.leaseEnded(tx, event.payload.leaseId as string, event.type);
      case 'lock.registered':
        return this.lockRegistered(tx, event.payload.lockId as string);
      case 'work_order.assigned':
        return this.workOrderAssigned(tx, event.payload.workOrderId as string);
      case 'work_order.completed':
        return this.workOrderClosed(tx, event.payload.workOrderId as string, 'work order completed');
      case 'work_order.changed': {
        const to = event.payload.to as string;
        if (['done', 'verified', 'cancelled'].includes(to))
          return this.workOrderClosed(tx, event.payload.workOrderId as string, `work order ${to}`);
        return;
      }
    }
  }

  private async residentsOf(tx: Tx, leaseId: string) {
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      include: {
        parties: {
          where: { role: { in: ['lessee', 'co_tenant'] } },
          include: { party: { select: { id: true, displayName: true } } },
        },
      },
    });
    return lease;
  }

  private async issueResidents(tx: Tx, leaseId: string, onlyLocks?: Lock[]): Promise<void> {
    const lease = await this.residentsOf(tx, leaseId);
    if (!lease || !['active', 'notice_given', 'ending'].includes(lease.status)) return;
    const locks = onlyLocks ?? (await locksFor(tx, lease.tenantId, lease.buildingId, lease.unitId));
    const now = this.clock.now();
    const start = startOfBangkokDay(lease.startDate.toISOString().slice(0, 10));
    for (const lock of locks)
      for (const p of lease.parties) {
        const existing = await tx.accessCredential.count({
          where: {
            leaseId: lease.id,
            lockId: lock.id,
            holderPartyId: p.partyId,
            status: { in: [...LIVE_STATUSES] },
          },
        });
        if (existing) continue;
        await this.credentials.issueIn(tx, {
          lock,
          holderKind: 'resident',
          holderPartyId: p.partyId,
          holderName: p.party.displayName,
          leaseId: lease.id,
          validFrom: start.getTime() > now.getTime() ? start : now,
          validTo: null,
        });
      }
  }

  private leaseActivated(tx: Tx, leaseId: string): Promise<void> {
    return this.issueResidents(tx, leaseId);
  }

  private async leaseEnded(tx: Tx, leaseId: string, type: string): Promise<void> {
    const live = await tx.accessCredential.findMany({
      where: { leaseId, status: { in: [...LIVE_STATUSES] } },
    });
    for (const c of live)
      await this.credentials.revokeIn(
        tx,
        c,
        type === 'lease.ended' ? 'lease ended' : 'lease terminated',
        'lease_end',
      );
  }

  /** A lock registered on a leased unit (or a building door) gives the current residents their credentials. */
  private async lockRegistered(tx: Tx, lockId: string): Promise<void> {
    const lock = await tx.lock.findUnique({ where: { id: lockId } });
    if (!lock) return;
    const leases = await tx.lease.findMany({
      where: {
        tenantId: lock.tenantId,
        status: { in: ['active', 'notice_given', 'ending'] },
        ...(lock.scope === 'unit' ? { unitId: lock.unitId! } : { buildingId: lock.buildingId }),
      },
      select: { id: true },
    });
    if (lock.scope === 'common_area') return;
    for (const l of leases) await this.issueResidents(tx, l.id, [lock]);
  }

  private async workOrderAssigned(tx: Tx, workOrderId: string): Promise<void> {
    const wo = await tx.workOrder.findUnique({
      where: { id: workOrderId },
      include: {
        assigneeParty: { select: { id: true, displayName: true } },
        assigneeUser: { select: { id: true, displayName: true } },
      },
    });
    if (!wo || !['assigned', 'accepted', 'in_progress'].includes(wo.status)) return;
    const live = await tx.accessCredential.findMany({
      where: { workOrderId: wo.id, status: { in: [...LIVE_STATUSES] } },
    });
    // the previous assignee's codes end with the re-assignment
    for (const c of live)
      if (c.holderPartyId !== wo.assigneePartyId || c.holderUserId !== wo.assigneeUserId)
        await this.credentials.revokeIn(tx, c, 'work order re-assigned', 'work_order');
    if (!wo.unitId) return;
    const locks = await tx.lock.findMany({
      where: { tenantId: wo.tenantId, isActive: true, scope: 'unit', unitId: wo.unitId },
    });
    if (!locks.length) return;
    const doors = await locksFor(tx, wo.tenantId, wo.buildingId, null);
    const now = this.clock.now();
    const hours = await this.settings.valueAt<number>('access.work_order_window_hours', now, {
      tenantId: wo.tenantId,
    });
    const window = workOrderWindow(wo, now, hours ?? 4);
    for (const lock of [...locks, ...doors]) {
      const has = live.some(
        (c) =>
          c.lockId === lock.id &&
          c.holderPartyId === wo.assigneePartyId &&
          c.holderUserId === wo.assigneeUserId,
      );
      if (has) continue;
      await this.credentials.issueIn(tx, {
        lock,
        holderKind: wo.assigneePartyId ? 'technician' : 'staff',
        holderPartyId: wo.assigneePartyId,
        holderUserId: wo.assigneeUserId,
        holderName: wo.assigneeParty?.displayName ?? wo.assigneeUser?.displayName ?? 'technician',
        workOrderId: wo.id,
        validFrom: window.validFrom,
        validTo: window.validTo,
      });
    }
  }

  private async workOrderClosed(tx: Tx, workOrderId: string, reason: string): Promise<void> {
    const live = await tx.accessCredential.findMany({
      where: { workOrderId, status: { in: [...LIVE_STATUSES] } },
    });
    for (const c of live) await this.credentials.revokeIn(tx, c, reason, 'work_order');
  }
}

/** Vendor calls after the commit of an issue / revoke (`AccessCredentialsService.sync`). */
@Injectable()
export class AccessVendorSync implements EventSubscriber, OnModuleInit {
  readonly name = 'access-vendor-sync';
  readonly eventTypes = ['access.credential_issued', 'access.credential_revoked'] as const;

  constructor(
    private readonly registry: EventSubscriberRegistry,
    private readonly credentials: AccessCredentialsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(): Promise<void> {
    return Promise.resolve();
  }

  async afterCommit(event: DomainEventEnvelope): Promise<void> {
    await this.credentials.sync(event.aggregateId);
  }
}

/**
 * Notifications of access (D-070, D-071): a resident is told on LINE when their door code is ready (no PIN in the
 * message — it is shown in the app) and when an owner revoked it, with the reason; a technician when the code of
 * their work order is ready. Realtime: the holder's logins and the unit.
 */
@Injectable()
export class AccessNotifications implements OnModuleInit {
  onModuleInit(): void {
    const holder = async (tx: Tx, e: DomainEventEnvelope): Promise<Recipient[]> => {
      const partyId = e.payload.holderPartyId as string | null;
      if (!partyId) return [];
      const kind = e.payload.holderKind as string;
      const recipients = await billedParty(tx, partyId);
      return kind === 'technician'
        ? recipients.map((r) => ({ ...r, audience: 'technician' as const }))
        : recipients;
    };
    const lockData = async (tx: Tx, e: DomainEventEnvelope) => {
      const lock = await tx.lock.findUnique({
        where: { id: e.payload.lockId as string },
        include: { unit: { select: { unitNo: true } } },
      });
      return { name: lock?.name ?? '', unitNo: lock?.unit?.unitNo ?? '' };
    };
    registerNotifiable('access.credential_issued', async (tx, e) => {
      const kind = e.payload.holderKind as string;
      if (!e.tenantId || !['resident', 'technician'].includes(kind)) return null;
      return {
        recipients: await holder(tx, e),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          lock: await lockData(tx, e),
          credential: { validTo: e.payload.validTo ?? '-' },
        },
        consentPurpose: 'resident.service',
      };
    });
    registerNotifiable('access.credential_revoked', async (tx, e) => {
      if (!e.tenantId || e.payload.origin !== 'owner' || e.payload.holderKind !== 'resident') return null;
      return {
        recipients: await holder(tx, e),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          lock: await lockData(tx, e),
          credential: { reason: e.payload.reason },
        },
        consentPurpose: 'resident.service',
        urgent: true,
      };
    });
    registerRealtimeChannels(['access.credential_issued', 'access.credential_revoked'], async (tx, e) => {
      const channels: string[] = [];
      if (typeof e.payload.unitId === 'string') channels.push(`unit:${e.payload.unitId}`);
      if (typeof e.payload.holderUserId === 'string') channels.push(`user:${e.payload.holderUserId}`);
      if (typeof e.payload.holderPartyId === 'string') {
        const links = await tx.partyUserLink.findMany({
          where: { partyId: e.payload.holderPartyId, state: 'active' },
          select: { userId: true },
        });
        channels.push(...links.map((l) => `user:${l.userId}`));
      }
      return channels;
    });
  }
}

import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { OPEN_INVOICE_STATES, OPEN_SUBSCRIPTION_STATES } from './platform-billing.service';

export interface TenantHealth {
  tenantId: string;
  status: string;
  subscriptionState: string | null;
  planKey: string | null;
  trialEndsAt: Date | null;
  units: number;
  buildings: number;
  openPlatformInvoices: number;
  overduePlatformAmount: string;
  lastBillingCycle: { periodKey: string; status: string; createdAt: Date } | null;
  gateways: { total: number; online: number };
  signals: string[];
}

/** A gateway is online when it reported in the last 15 minutes (B3 health). */
const ONLINE_MS = 15 * 60_000;

/**
 * Tenant health for the platform console (B6.1, D-161): company-level signals only — subscription and platform
 * receivables, counted units, the last billing cycle, gateway connectivity — no tenant business data (that needs a
 * support grant, D-090). `signals` names what needs attention: `past_due`, `suspended`, `trial_ending`,
 * `no_cycle_this_month`, `gateways_offline`.
 */
@Injectable()
export class TenantHealthService {
  constructor(
    private readonly db: TenantTx,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async health(tenantId: string): Promise<TenantHealth> {
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
      if (!tenant) throw new DomainException('http.not_found');
      const sub = await tx.subscription.findFirst({
        where: { tenantId, state: { in: [...OPEN_SUBSCRIPTION_STATES] } },
        orderBy: { startedAt: 'desc' },
      });
      const units = await tx.unit.count({
        where: { tenantId, deletedAt: null, status: { not: 'inactive' } },
      });
      const buildings = await tx.building.count({
        where: { deletedAt: null, OR: [{ ownerTenantId: tenantId }, { operatorTenantId: tenantId }] },
      });
      const open = await tx.platformInvoice.findMany({
        where: { tenantId, state: { in: [...OPEN_INVOICE_STATES] } },
        select: { state: true, total: true, paidTotal: true, creditedTotal: true },
      });
      const overdue = open
        .filter((i) => i.state === 'overdue')
        .reduce(
          (s, i) =>
            s.plus(i.total.toString()).minus(i.paidTotal.toString()).minus(i.creditedTotal.toString()),
          new Decimal(0),
        );
      const cycle = await tx.billingCycle.findFirst({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        select: { periodKey: true, status: true, createdAt: true },
      });
      const gateways = await tx.device.findMany({
        where: {
          tenantId,
          kind: 'gateway',
          status: { in: ['provisioned', 'online', 'degraded', 'offline'] },
        },
        select: { lastSeenAt: true },
      });
      const online = gateways.filter(
        (g) => g.lastSeenAt && now.getTime() - g.lastSeenAt.getTime() <= ONLINE_MS,
      ).length;
      const signals: string[] = [];
      if (sub?.state === 'past_due') signals.push('past_due');
      if (sub?.state === 'suspended') signals.push('suspended');
      if (sub?.state === 'trial' && sub.trialEndsAt.getTime() - now.getTime() < 7 * 86_400_000)
        signals.push('trial_ending');
      const month = bangkokDate(now).slice(0, 7);
      if (
        units > 0 &&
        Number(bangkokDate(now).slice(8, 10)) > 7 &&
        !(cycle && bangkokDate(cycle.createdAt).slice(0, 7) === month)
      )
        signals.push('no_cycle_this_month');
      if (gateways.length > online) signals.push('gateways_offline');
      return {
        tenantId,
        status: tenant.status,
        subscriptionState: sub?.state ?? null,
        planKey: sub?.planKey ?? null,
        trialEndsAt: sub?.state === 'trial' ? sub.trialEndsAt : null,
        units,
        buildings,
        openPlatformInvoices: open.length,
        overduePlatformAmount: overdue.toFixed(2),
        lastBillingCycle: cycle,
        gateways: { total: gateways.length, online },
        signals,
      };
    });
  }
}

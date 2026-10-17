import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext } from '@common/context/tenant-context';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type ComplianceScore, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { complianceScore, type ScoreInputs } from './compliance-score';

/** Counts of one month a module contributes (B4.2 invoices register theirs). */
export type ScoreSource = (
  tx: Tx,
  tenantId: string,
  window: { start: Date; end: Date },
) => Promise<Partial<ScoreInputs>>;

/** `YYYY-MM` → the Bangkok month window [start, end). */
export function monthWindow(month: string): { start: Date; end: Date; firstDay: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError(`not a month: ${month}`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return {
    start: startOfBangkokDay(`${month}-01`),
    end: startOfBangkokDay(`${next}-01`),
    firstDay: `${month}-01`,
  };
}

/**
 * Tenant compliance score per month (B4.1.3, ADR-0007, `platform.compliance_score`): leases on the สคบ. standard
 * template and deposits refunded by their deadline (B2), invoices within the utility rate and above-cap lines
 * acknowledged (sources registered by B4.2). Computed on demand by the owner endpoint and every night for the current
 * and the previous month by the worker (`compliance-score` job), upserted per (tenant, month).
 */
@Injectable()
export class ComplianceScoreService {
  private readonly logger = new Logger(ComplianceScoreService.name);
  private readonly sources: ScoreSource[] = [];

  constructor(
    private readonly db: TenantTx,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.sources.push((tx, tenantId, w) => this.leasesAndDeposits(tx, tenantId, w));
  }

  /** Modules add their counts (invoices, B4.2). */
  registerSource(source: ScoreSource): void {
    this.sources.push(source);
  }

  currentMonth(): string {
    return bangkokDate(this.clock.now()).slice(0, 7);
  }

  private async leasesAndDeposits(
    tx: Tx,
    tenantId: string,
    w: { start: Date; end: Date },
  ): Promise<Partial<ScoreInputs>> {
    const inForce: Prisma.LeaseWhereInput = {
      tenantId,
      activatedAt: { not: null, lt: w.end },
      startDate: { lt: w.end },
      OR: [
        { endedAt: null, terminatedAt: null },
        { endedAt: { gte: w.start } },
        { terminatedAt: { gte: w.start } },
      ],
    };
    const [leasesTotal, leasesOnStandardTemplate, depositsDue, depositsRefundedOnTime] = await Promise.all([
      tx.lease.count({ where: inForce }),
      tx.lease.count({ where: { ...inForce, templateVersion: { template: { tenantId: null } } } }),
      tx.depositSettlement.count({ where: { tenantId, deadlineAt: { gte: w.start, lt: w.end } } }),
      tx.depositSettlement.count({
        where: {
          tenantId,
          deadlineAt: { gte: w.start, lt: w.end },
          refundedAt: { not: null },
          isLate: false,
        },
      }),
    ]);
    return { leasesTotal, leasesOnStandardTemplate, depositsDue, depositsRefundedOnTime };
  }

  /** Computes and stores the score of `month` (`YYYY-MM`) for one tenant. */
  async compute(tenantId: string, month: string): Promise<ComplianceScore> {
    const w = monthWindow(month);
    return this.db.tenant(systemTenantContext(tenantId), async (tx) => {
      const inputs: ScoreInputs = {
        invoicesTotal: 0,
        invoicesWithinRate: 0,
        linesAboveCap: 0,
        linesAboveCapAcknowledged: 0,
        depositsDue: 0,
        depositsRefundedOnTime: 0,
        leasesTotal: 0,
        leasesOnStandardTemplate: 0,
      };
      for (const source of this.sources) Object.assign(inputs, await source(tx, tenantId, w));
      const result = complianceScore(inputs);
      const data = {
        score: result.score,
        ...inputs,
        details: { components: result.components, month } as unknown as Prisma.InputJsonValue,
        computedAt: this.clock.now(),
      };
      return tx.complianceScore.upsert({
        where: { tenantId_month: { tenantId, month: new Date(`${w.firstDay}T00:00:00Z`) } },
        create: { tenantId, month: new Date(`${w.firstDay}T00:00:00Z`), ...data },
        update: data,
      });
    });
  }

  /** Stored scores of a tenant, newest month first. */
  history(tenantId: string, take = 12) {
    return this.db.tenant(systemTenantContext(tenantId), (tx) =>
      tx.complianceScore.findMany({ where: { tenantId }, orderBy: { month: 'desc' }, take }),
    );
  }

  /** Worker job: the current and the previous month of every active tenant. */
  async runAll(): Promise<number> {
    const tenants = await RequestContext.run({ actor: systemActor('compliance-score') }, () =>
      this.db.platform((tx) => tx.tenant.findMany({ where: { deletedAt: null }, select: { id: true } })),
    );
    const current = this.currentMonth();
    const [y, m] = current.split('-').map(Number) as [number, number];
    const previous = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    let n = 0;
    for (const t of tenants)
      for (const month of [previous, current]) {
        try {
          await RequestContext.run({ actor: systemActor('compliance-score') }, () =>
            this.compute(t.id, month),
          );
          n += 1;
        } catch (error) {
          this.logger.error(`compliance score ${t.id} ${month}: ${(error as Error).message}`);
        }
      }
    return n;
  }
}

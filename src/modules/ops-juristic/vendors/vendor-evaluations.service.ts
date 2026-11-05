import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type EvaluationCriterion } from '@core/settings/juristic-accounting-settings';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Prisma, type VendorEvaluation } from '@generated/prisma/client';
import { LedgerService } from '@modules/ops-juristic/accounting/ledger.service';
import { Inject, Injectable } from '@nestjs/common';

import { averageScore, type SlaBreach, slaBreaches, type SlaTerm } from './vendor-rules';

const by = () => userIdOf(RequestContext.actor());
const day = (d: Date) => d.toISOString().slice(0, 10);
const invalid = (path: string, code: string, message: string) =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

export interface SlaMonth {
  month: string;
  workOrders: number;
  breaches: SlaBreach[];
}

/** First day of the next month of `YYYY-MM`. */
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

/**
 * Monthly vendor evaluations (D-310, D-331): the SLA breaches of a contract's month are **pulled** from the work
 * orders of the contract's building assigned to the vendor's party or opened by a preventive plan of the contract
 * (response / resolve against the contract's SLA terms per priority, plus the linked service requests whose own SLA
 * breached); an evaluation scores every criterion of `juristic.vendor_evaluation_criteria` 1–5, records incidents and
 * snapshots the breaches. One per contract and month, immutable.
 */
@Injectable()
export class VendorEvaluationsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private async contract(tx: Tx, ctx: TenantContext, id: string) {
    const c = this.found(
      await tx.vendorContract.findFirst({
        where: this.own(ctx, { id }),
        include: { vendor: { select: { id: true, partyId: true, name: true } } },
      }),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(c.buildingId))
      throw new DomainException('http.not_found');
    return c;
  }

  private checkMonth(month: string, c: { startsOn: Date; endsOn: Date }): void {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw invalid('month', 'month', 'YYYY-MM');
    const current = bangkokDate(this.clock.now()).slice(0, 7);
    if (month > current) throw invalid('month', 'future', 'this month or earlier');
    if (month < day(c.startsOn).slice(0, 7) || month > day(c.endsOn).slice(0, 7))
      throw invalid('month', 'term', 'a month of the contract term');
  }

  private async slaIn(
    tx: Tx,
    c: { id: string; buildingId: string; slaTerms: Prisma.JsonValue; vendor: { partyId: string } },
    month: string,
  ): Promise<SlaMonth> {
    const from = startOfBangkokDay(`${month}-01`);
    const to = startOfBangkokDay(`${nextMonth(month)}-01`);
    const orders = await tx.workOrder.findMany({
      where: {
        buildingId: c.buildingId,
        createdAt: { gte: from, lt: to },
        OR: [{ assigneePartyId: c.vendor.partyId }, { maintenancePlan: { vendorContractId: c.id } }],
      },
      include: {
        serviceRequest: {
          select: { id: true, createdAt: true, workflowInstance: { select: { slaBreachedAt: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const breaches = slaBreaches(
      orders.map((o) => ({
        id: o.id,
        title: o.title,
        priority: o.priority,
        status: o.status,
        createdAt: o.createdAt,
        assignedAt: o.assignedAt,
        acceptedAt: o.acceptedAt,
        checkedInAt: o.checkedInAt,
        completedAt: o.completedAt,
        serviceRequest: o.serviceRequest
          ? {
              id: o.serviceRequest.id,
              createdAt: o.serviceRequest.createdAt,
              slaBreachedAt: o.serviceRequest.workflowInstance?.slaBreachedAt ?? null,
            }
          : null,
      })),
      (c.slaTerms ?? []) as unknown as SlaTerm[],
      this.clock.now(),
    );
    return { month, workOrders: orders.filter((o) => o.status !== 'cancelled').length, breaches };
  }

  /** `GET …/vendor-contracts/{id}/sla-breaches?month=` — what an evaluation of that month would pull. */
  sla(ctx: TenantContext, contractId: string, month: string): Promise<SlaMonth> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const c = await this.contract(tx, ctx, contractId);
      this.checkMonth(month, c);
      return this.slaIn(tx, c, month);
    });
  }

  list(ctx: TenantContext, contractId: string): Promise<VendorEvaluation[]> {
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      await this.contract(tx, ctx, contractId);
      return tx.vendorEvaluation.findMany({ where: { contractId }, orderBy: { month: 'asc' } });
    });
  }

  async create(
    ctx: TenantContext,
    contractId: string,
    input: {
      month: string;
      scores: { criterion: string; score: number }[];
      incidents?: number;
      incidentNote?: string | null;
      note?: string | null;
    },
  ): Promise<VendorEvaluation> {
    const me = by();
    if (!me) throw new DomainException('auth.unauthenticated');
    return this.db.tenant(ctx, async (tx) => {
      await this.ledger.assertJuristic(tx, ctx.tenantId);
      const c = await this.contract(tx, ctx, contractId);
      if (c.state === 'draft')
        throw new DomainException('vendor_contract.invalid_state', { params: { state: c.state } });
      this.checkMonth(input.month, c);
      const criteria =
        (await this.settings.valueAt<EvaluationCriterion[]>(
          'juristic.vendor_evaluation_criteria',
          this.clock.now(),
          {
            tenantId: ctx.tenantId,
          },
        )) ?? [];
      const given = new Map(input.scores.map((s) => [s.criterion, s.score]));
      if (given.size !== input.scores.length) throw invalid('scores', 'duplicate', 'one score per criterion');
      for (const k of given.keys())
        if (!criteria.some((x) => x.key === k))
          throw invalid('scores', 'unknown', `a criterion of the setting: ${k}`);
      const scores = criteria.map((x) => {
        const v = given.get(x.key);
        if (v === undefined) throw invalid('scores', 'required', `a score for ${x.key}`);
        if (!Number.isInteger(v) || v < 1 || v > 5) throw invalid('scores', 'score', '1–5');
        return { criterion: x.key, labelTh: x.labelTh, labelEn: x.labelEn, score: v };
      });
      const monthDate = new Date(`${input.month}-01T00:00:00Z`);
      if (await tx.vendorEvaluation.findFirst({ where: { contractId, month: monthDate } }))
        throw new DomainException('vendor_evaluation.exists', { params: { month: input.month } });
      const sla = await this.slaIn(tx, c, input.month);
      const row = await tx.vendorEvaluation.create({
        data: {
          tenantId: ctx.tenantId,
          contractId,
          vendorId: c.vendorId,
          month: monthDate,
          scores: scores,
          score: averageScore(scores.map((s) => s.score)),
          incidents: input.incidents ?? 0,
          incidentNote: input.incidentNote ?? null,
          slaBreaches: sla.breaches.length,
          slaItems: sla.breaches as unknown as Prisma.InputJsonValue,
          workOrders: sla.workOrders,
          note: input.note ?? null,
          evaluatedBy: me,
        },
      });
      await this.audit.record(tx, {
        action: 'juristic.vendor_evaluated',
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        subjectType: 'juristic.vendor_contract',
        subjectId: contractId,
        metadata: {
          month: input.month,
          score: row.score.toFixed(2),
          slaBreaches: row.slaBreaches,
          incidents: row.incidents,
        },
      });
      await this.events.record(tx, {
        type: 'juristic.vendor_evaluation.recorded',
        aggregateType: 'vendor_contract',
        aggregateId: contractId,
        tenantId: ctx.tenantId,
        buildingId: c.buildingId,
        payload: {
          vendorContractId: contractId,
          vendorEvaluationId: row.id,
          month: input.month,
          score: row.score.toFixed(2),
          slaBreaches: row.slaBreaches,
        },
      });
      return row;
    });
  }
}

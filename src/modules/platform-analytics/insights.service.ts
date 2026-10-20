import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { AnalyticsService, type SeriesPoint } from './analytics.service';
import { type KpiValues, PilotKpisService } from './pilot-kpis.service';

/** The month series of the owner insights: metric → how a month's value is formed from the rollups. */
export const INSIGHT_METRICS = [
  { metric: 'time_to_bill_hours', fact: 'cycle.time_to_issue_s', kind: 'average', divisor: 3600 },
  { metric: 'invoice_correction_rate_pct', fact: 'invoice.corrected', kind: 'rate', over: 'invoice.issued' },
  { metric: 'on_time_payment_pct', fact: 'payment.on_time', kind: 'share' },
  { metric: 'auto_reconciled_pct', fact: 'payment.auto_reconciled', kind: 'share' },
  { metric: 'paid_by_qr_pct', fact: 'payment.by_qr', kind: 'share' },
  { metric: 'reminder_effectiveness_pct', fact: 'reminder.effective', kind: 'share' },
  { metric: 'loss_pct', fact: 'loss.pct', kind: 'average' },
  { metric: 'meter_uptime_pct', fact: 'meter.uptime_pct', kind: 'average' },
  { metric: 'csat', fact: 'csat.rating', kind: 'average' },
  { metric: 'compliance_score', fact: 'compliance.score', kind: 'average' },
  { metric: 'above_cap_acknowledged_pct', fact: 'compliance.above_cap_acknowledged_pct', kind: 'average' },
  { metric: 'service_requests_via_line_pct', fact: 'service_request.via_line', kind: 'share' },
] as const;
export type InsightMetric = (typeof INSIGHT_METRICS)[number]['metric'];

export interface InsightSeries {
  metric: InsightMetric;
  points: { month: string; value: string | null; count: number }[];
}

/**
 * Owner insights (B6.3, D-083, D-217; `/v1/owner/insights`): the 90-day KPIs of the tenant (the same rollups as the
 * pilot KPIs), the month series of every operating metric over the last months (oldest first, every month present,
 * null where nothing was measured), and the anonymised benchmarks when the tenant itself opted in.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly db: TenantTx,
    private readonly analytics: AnalyticsService,
    private readonly kpis: PilotKpisService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async insights(ctx: TenantContext, months: number, buildingId: string | null) {
    const now = this.clock.now();
    const firstMonth = this.analytics.monthsBack(months - 1);
    const from90 = new Date(now.getTime() - 90 * 86_400_000);
    return this.db.platform(async (tx) => {
      if (
        buildingId &&
        !(await tx.building.findFirst({
          where: {
            id: buildingId,
            deletedAt: null,
            OR: [{ ownerTenantId: ctx.tenantId }, { operatorTenantId: ctx.tenantId }],
          },
        }))
      )
        throw new DomainException('http.not_found');
      const start = this.analytics.monthStart(firstMonth);
      await this.analytics.refresh(tx, ctx.tenantId, start < from90 ? start : from90, now);
      const current: KpiValues = await this.kpis.values(tx, ctx.tenantId, from90, now);
      const facts = [...new Set(INSIGHT_METRICS.flatMap((m) => ('over' in m ? [m.fact, m.over] : [m.fact])))];
      const raw = await this.analytics.series(tx, ctx.tenantId, facts, firstMonth, buildingId);
      const monthsList: string[] = [];
      for (let i = months - 1; i >= 0; i -= 1) monthsList.push(this.analytics.monthsBack(i));
      const at = (points: SeriesPoint[] | undefined, month: string) =>
        points?.find((p) => p.bucketStart === month);
      const series: InsightSeries[] = INSIGHT_METRICS.map((m) => ({
        metric: m.metric,
        points: monthsList.map((month) => {
          const p = at(raw.get(m.fact), month);
          if (m.kind === 'rate') {
            const over = at(raw.get(m.over), month);
            const n = over?.count ?? 0;
            return {
              month,
              value:
                n > 0 ? new Decimal(p?.count ?? 0).times(100).div(n).toDecimalPlaces(2).toFixed(2) : null,
              count: n,
            };
          }
          if (!p || p.count === 0) return { month, value: null, count: 0 };
          const v = new Decimal(p.value).div(p.count);
          return {
            month,
            value: (m.kind === 'share' ? v.times(100) : v.div('divisor' in m ? m.divisor : 1))
              .toDecimalPlaces(2)
              .toFixed(2),
            count: p.count,
          };
        }),
      }));
      return {
        tenantId: ctx.tenantId,
        asOf: bangkokDate(now),
        buildingId,
        current,
        series,
        benchmarks: await this.analytics.benchmarksFor(tx, ctx.tenantId),
      };
    });
  }
}

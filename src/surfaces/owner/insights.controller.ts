import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { BENCHMARK_METRICS } from '@modules/platform-analytics/benchmark-rules';
import { INSIGHT_METRICS, InsightsService } from '@modules/platform-analytics/insights.service';
import { PilotKpisService } from '@modules/platform-analytics/pilot-kpis.service';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { KPIS_EXAMPLE, pilotKpisDto } from '../admin/admin-business.controller';
import { KpiQuery, KpiWindowName, PilotKpisDto } from '../admin/platform-business.dto';
import { ApiSurface, SURFACES } from '../surfaces';
import { BenchmarkMetricName, InsightMetricName, InsightsDto, InsightsQuery } from './insights.dto';

// the DTO enums mirror the module's lists (checked at load)
if (
  JSON.stringify(Object.values(InsightMetricName)) !== JSON.stringify(INSIGHT_METRICS.map((m) => m.metric)) ||
  JSON.stringify(Object.values(BenchmarkMetricName)) !== JSON.stringify(BENCHMARK_METRICS)
)
  throw new Error('insight / benchmark enums out of sync');

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

/** The owner's own pilot KPIs and insights (D-083, B6.3; web F2 2.6 reports). */
@ApiTags('owner.insights')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerInsightsController {
  constructor(
    private readonly kpis: PilotKpisService,
    private readonly insightsService: InsightsService,
  ) {}

  @Get('pilot-kpis')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.insights.pilotKpis',
    summary: 'My pilot KPIs',
    description:
      'The seven D-083 KPIs of my tenant over the window (default 90 days) against the baseline and targets of my pilot agreement, plus the Phase 1 acceptance measures — the same figures the platform admin reads at `admin.pilots.kpis` (web F2, D-214). 404 when my tenant has no pilot agreement.',
    implements: ['D-083', 'D-214'],
  })
  @ApiSuccess(200, { description: 'KPIs', type: PilotKpisDto, example: KPIS_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async pilotKpis(@CurrentTenant() ctx: TenantContext, @Query() query: KpiQuery): Promise<PilotKpisDto> {
    return pilotKpisDto(
      await this.kpis.compute(ctx.tenantId, query.window ?? KpiWindowName.D90, { requirePilot: true }),
    );
  }

  @Get('insights')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.insights.get',
    summary: 'Operating insights',
    description:
      'From the analytics rollups (B6.3, D-217): the seven D-083 KPIs over the last 90 days, the month series of time to bill, correction rate, on-time payment, auto-reconciled and QR payments, reminder effectiveness, loss %, meter uptime, resident CSAT (repair ratings + the LIFF survey), compliance score, above-cap lines acknowledged and requests via LINE (null = nothing measured that month), and anonymised benchmarks (k ≥ 5 tenants per bucket) when an Owner of my tenant opted in.',
    implements: ['D-083', 'D-217', 'D-021', 'D-045'],
  })
  @ApiSuccess(200, {
    description: 'Insights',
    type: InsightsDto,
    example: {
      tenantId: FAKE.tenantId,
      asOf: FAKE.date,
      buildingId: null,
      current: KPIS_EXAMPLE.current,
      series: [
        { metric: 'on_time_payment_pct', points: [{ month: '2026-11-01', value: '86.50', count: 40 }] },
      ],
      benchmarks: {
        optedIn: true,
        items: [
          {
            metric: 'on_time_payment_pct',
            bucketKey: 'type:apartment|size:20-49',
            k: 7,
            p25: '78.0000',
            p50: '86.5000',
            p75: '93.1000',
            asOf: FAKE.date,
            mine: '91.2000',
          },
        ],
      },
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async insights(@CurrentTenant() ctx: TenantContext, @Query() q: InsightsQuery): Promise<InsightsDto> {
    const r = await this.insightsService.insights(ctx, q.months ?? 12, q.building ?? null);
    return {
      ...r,
      series: r.series.map((x) => ({ metric: x.metric as InsightMetricName, points: x.points })),
      benchmarks: {
        optedIn: r.benchmarks.optedIn,
        items: r.benchmarks.items.map((b) => ({ ...b, metric: b.metric as BenchmarkMetricName })),
      },
    };
  }
}

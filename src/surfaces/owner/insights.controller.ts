import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { PilotKpisService } from '@modules/platform-analytics/pilot-kpis.service';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { KPIS_EXAMPLE, pilotKpisDto } from '../admin/admin-business.controller';
import { KpiQuery, KpiWindowName, PilotKpisDto } from '../admin/platform-business.dto';
import { ApiSurface, SURFACES } from '../surfaces';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

/** The owner's own pilot KPIs and insights (D-083, B6.3; web F2 2.6 reports). */
@ApiTags('owner.insights')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerInsightsController {
  constructor(private readonly kpis: PilotKpisService) {}

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
}

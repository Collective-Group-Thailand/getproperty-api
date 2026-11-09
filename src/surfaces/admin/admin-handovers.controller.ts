import { Can } from '@common/auth/can.decorator';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { type Handover } from '@generated/prisma/client';
import { HandoversService } from '@modules/ops-juristic/handovers/handovers.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { HANDOVER_EXAMPLE, handoverDto } from '../owner/juristic-handovers.controller';
import {
  AdminHandoverAssignDto,
  AdminHandoverDto,
  JuristicHandoverListQuery,
} from '../owner/juristic-handovers.dto';
import { ApiSurface, SURFACES } from '../surfaces';

const adminDto = (h: Handover): AdminHandoverDto => ({
  ...handoverDto(h),
  tenantId: h.tenantId,
  integrationEventId: h.integrationEventId,
  rejectionAttempts: h.rejectionAttempts,
  lastDeliveryError: h.lastDeliveryError,
});

const EXAMPLE: AdminHandoverDto = {
  ...HANDOVER_EXAMPLE,
  state: 'received' as AdminHandoverDto['state'],
  nextActions: [],
  tenantId: null,
  integrationEventId: FAKE.uuid,
  rejectionAttempts: 0,
  lastDeliveryError: null,
};

@ApiTags('admin.juristicHandovers')
@ApiSurface(SURFACES.admin)
@Controller('admin/juristic-handovers')
export class AdminJuristicHandoversController {
  constructor(private readonly handovers: HandoversService) {}

  @Get()
  @Can('admin.integration_event.read')
  @ApiEndpoint({
    id: 'admin.juristicHandovers.list',
    summary: 'Developer handovers received from getbuild',
    description:
      'Every `building.handover.requested` stored by the integration receiver, newest first (`received` = waiting for a juristic tenant), with the rejection delivery state (D-314, D-333).',
    implements: ['D-314', 'D-333'],
  })
  @ApiPaginated(AdminHandoverDto, { example: EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: JuristicHandoverListQuery): Promise<Page<AdminHandoverDto>> {
    const { rows, total } = await this.handovers.adminList({ state: q.state, ...toSkipTake(q) });
    return paginated(rows.map(adminDto), total, q);
  }

  @Post(':handoverId/actions/assign')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.tenant.manage')
  @ApiEndpoint({
    id: 'admin.juristicHandovers.assign',
    summary: 'Send a handover to a juristic tenant',
    description:
      'Received or pending handovers: the juristic tenant (created by the platform first, D-324) gets it in its inbox; optionally the developer’s `pm_company` tenant, which then operates the building until the juristic person is formed (D-150 D1). Audited; requires `Idempotency-Key` (D-333).',
    implements: ['D-150', 'D-333'],
  })
  @ApiJsonBody(AdminHandoverAssignDto, { juristicTenantId: FAKE.tenantId, developerTenantId: null })
  @ApiSuccess(200, {
    description: 'Assigned',
    type: AdminHandoverDto,
    example: { ...EXAMPLE, state: 'pending_review' as AdminHandoverDto['state'], tenantId: FAKE.tenantId },
  })
  @ApiStandardErrors(
    'handover.invalid_state',
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'idempotency.key_required',
  )
  async assign(
    @Param('handoverId', ParseUUIDPipe) id: string,
    @Body() body: AdminHandoverAssignDto,
  ): Promise<AdminHandoverDto> {
    return adminDto(await this.handovers.assign(id, body));
  }
}

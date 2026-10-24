import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { toBangkokIso } from '@common/time/bangkok';
import { StorageMeteringService } from '@core/storage/storage-metering.service';
import { TenantTx } from '@database/tenant-tx';
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import { OwnerStorageDto } from './storage.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

/**
 * The owner's storage (D-276): the usage bar of the console — files at their size plus records at the counted size of
 * their type, the free allowance of the tenant type and the price above it (settings), and the daily snapshots of
 * the last 30 days. Nothing here deletes or locks data.
 */
@ApiTags('owner.storage')
@ApiSurface(SURFACES.owner)
@Controller('owner/storage')
export class OwnerStorageController {
  constructor(
    private readonly db: TenantTx,
    private readonly metering: StorageMeteringService,
  ) {}

  @Get()
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.storage.get',
    summary: 'My storage',
    description:
      'What the tenant stores (files + records at their counted size), the allowance and its level (ok / warning / full / over), the price per GB-month above it and the last 30 daily snapshots (D-276). `metered: false` while the platform has not set a free allowance for the tenant type.',
    implements: ['D-276'],
  })
  @ApiSuccess(200, {
    description: 'My storage',
    type: OwnerStorageDto,
    example: {
      asOf: '2026-10-25T09:00:00+07:00',
      metered: true,
      usedBytes: '734003200',
      fileBytes: '650000000',
      records: {
        invoice: 1203,
        receipt: 1150,
        payment: 1150,
        lease: 40,
        meter_reading: 8800,
        service_request: 35,
      },
      allowanceBytes: '5368709120',
      usedPercent: 13,
      level: 'ok',
      freeGb: '5',
      pricePerGbMonth: null,
      history: [{ day: '2026-10-24', countedBytes: '731906048' }],
    },
  })
  @ApiStandardErrors(...T)
  async get(@CurrentTenant() ctx: TenantContext): Promise<OwnerStorageDto> {
    return this.db.tenant(ctx, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { type: true },
      });
      const s = await this.metering.status(tx, ctx.tenantId, tenant.type);
      const history = await tx.storageUsageDaily.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { day: 'desc' },
        take: 30,
        select: { day: true, countedBytes: true },
      });
      return {
        asOf: toBangkokIso(new Date(s.asOf)),
        metered: s.state !== null,
        usedBytes: s.usedBytes.toString(),
        fileBytes: s.usage.fileBytes.toString(),
        records: s.usage.records,
        allowanceBytes: s.state ? s.state.allowanceBytes.toString() : null,
        usedPercent: s.state ? Math.floor(s.state.usedBasisPoints / 100) : null,
        level: s.state?.level ?? null,
        freeGb: s.freeGb,
        pricePerGbMonth: s.pricePerGbMonth,
        history: history
          .map((h) => ({ day: h.day.toISOString().slice(0, 10), countedBytes: h.countedBytes.toString() }))
          .reverse(),
      };
    });
  }
}

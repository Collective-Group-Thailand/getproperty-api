import { Can } from '@common/auth/can.decorator';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { storageOverview } from '@core/storage/storage-metering.service';
import { TenantTx } from '@database/tenant-tx';
import { Controller, Get } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';

export class AdminStorageTenantDto {
  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'หอพักตัวอย่าง' })
  displayName!: string;

  @ApiProperty({ example: 'apartment', description: 'Tenant type (core.tenant_type).' })
  type!: string;

  @ApiProperty({ format: 'date', example: '2026-10-25', description: 'Day of the latest snapshot.' })
  day!: string;

  @ApiProperty({ example: '734003200', description: 'Counted bytes (files + records), decimal string.' })
  usedBytes!: string;

  @ApiProperty({ example: '650000000' })
  fileBytes!: string;

  @ApiProperty({ type: String, nullable: true, example: '5368709120', description: 'null = not metered.' })
  allowanceBytes!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 13 })
  usedPercent!: number | null;

  @ApiProperty({
    enum: ['ok', 'warning', 'full', 'over'],
    enumName: 'StorageLevel',
    nullable: true,
    example: 'ok',
  })
  level!: 'ok' | 'warning' | 'full' | 'over' | null;
}

export class AdminStorageTotalsDto {
  @ApiProperty({ type: 'integer', example: 12 })
  tenants!: number;

  @ApiProperty({ example: '8808038400' })
  usedBytes!: string;

  @ApiProperty({ type: 'integer', example: 1, description: 'Tenants at or above 80 % of their allowance.' })
  nearOrOver!: number;
}

export class AdminStorageOverviewDto {
  @ApiProperty({ type: [AdminStorageTenantDto] })
  data!: AdminStorageTenantDto[];

  @ApiProperty({ type: AdminStorageTotalsDto })
  totals!: AdminStorageTotalsDto;
}

const pct = (used: bigint, allowance: bigint | null) =>
  allowance === null ? null : allowance === 0n ? (used > 0n ? 10_000 : 0) : Number((used * 100n) / allowance);

/**
 * Storage of every tenant (D-279): the latest daily snapshot per tenant, most used first, for the founder's pricing
 * decision and support. Read-only; the amounts themselves are the `storage.*` settings.
 */
@ApiTags('admin.storage')
@ApiSurface(SURFACES.admin)
@Controller('admin/storage')
export class AdminStorageController {
  constructor(private readonly db: TenantTx) {}

  @Get('tenants')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.storage.tenants',
    summary: 'Storage of every tenant',
    description:
      'The latest daily storage snapshot of each tenant (counted bytes, files, allowance, percent, level) and totals (D-276, D-279). Tenants without a snapshot yet are not listed.',
    implements: ['D-276', 'D-279'],
  })
  @ApiSuccess(200, {
    description: 'Storage per tenant',
    type: AdminStorageOverviewDto,
    example: {
      data: [
        {
          tenantId: '0199f2a0-0000-7000-8000-000000000001',
          displayName: 'หอพักตัวอย่าง',
          type: 'apartment',
          day: '2026-10-25',
          usedBytes: '734003200',
          fileBytes: '650000000',
          allowanceBytes: '5368709120',
          usedPercent: 13,
          level: 'ok',
        },
      ],
      totals: { tenants: 1, usedBytes: '734003200', nearOrOver: 0 },
    },
  })
  @ApiStandardErrors('validation.failed')
  async tenants(): Promise<AdminStorageOverviewDto> {
    const rows = await this.db.platform((tx) => storageOverview(tx));
    const data = rows.map((r) => {
      const usedPercent = pct(r.usedBytes, r.allowanceBytes);
      const level: AdminStorageTenantDto['level'] =
        usedPercent === null
          ? null
          : usedPercent > 100
            ? 'over'
            : usedPercent === 100
              ? 'full'
              : usedPercent >= 80
                ? 'warning'
                : 'ok';
      return {
        tenantId: r.tenantId,
        displayName: r.displayName,
        type: r.type,
        day: r.day,
        usedBytes: r.usedBytes.toString(),
        fileBytes: r.fileBytes.toString(),
        allowanceBytes: r.allowanceBytes?.toString() ?? null,
        usedPercent,
        level,
      };
    });
    return {
      data,
      totals: {
        tenants: data.length,
        usedBytes: rows.reduce((sum, r) => sum + r.usedBytes, 0n).toString(),
        nearOrOver: data.filter((r) => r.level && r.level !== 'ok').length,
      },
    };
  }
}

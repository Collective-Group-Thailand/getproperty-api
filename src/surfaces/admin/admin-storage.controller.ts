import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { PageMeta, PageQuery } from '@common/pagination/pagination.dto';
import { toBangkokIso } from '@common/time/bangkok';
import { SettingsService } from '@core/settings/settings.service';
import { storageOverview } from '@core/storage/storage-metering.service';
import { StorageReconciliationService } from '@core/storage/storage-reconciliation.service';
import { TenantService } from '@core/tenancy/tenant.service';
import { TenantTx } from '@database/tenant-tx';
import { type StorageReconciliation } from '@generated/prisma/client';
import {
  type PackageDefinitionView,
  StoragePackagesService,
} from '@modules/platform-subscriptions/storage-packages.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

import { StoragePackagePeriodName, StoragePackageVisibilityName } from '../owner/storage.dto';
import { TenantTypeName } from '../shared/me.dto';
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

// ------------------------------------------------------------------------------------------- G1 (D-285, D-286)

const DECIMAL = /^\d{1,6}(\.\d{1,4})?$/;

export class StoragePackageDefinitionDto {
  @ApiProperty({ format: 'uuid', example: '0199f2a0-0000-7000-8000-0000000000bb' })
  id!: string;

  @ApiProperty({ example: 'storage_plus_20', description: 'Price-plan key (kind addon).' })
  key!: string;

  @ApiProperty({ example: 'พื้นที่เพิ่ม 20 GB' })
  nameTh!: string;

  @ApiProperty({ example: 'Extra 20 GB' })
  nameEn!: string;

  @ApiProperty({ enum: TenantTypeName, enumName: 'TenantType', nullable: true, example: null })
  tenantType!: TenantTypeName | null;

  @ApiProperty({ example: true, description: 'false = not offered (active window off).' })
  isActive!: boolean;

  @ApiProperty({ example: '21474836480' })
  sizeBytes!: string;

  @ApiProperty({ enum: StoragePackagePeriodName, enumName: 'StoragePackagePeriod', example: 'month' })
  period!: StoragePackagePeriodName;

  @ApiProperty({
    enum: StoragePackageVisibilityName,
    enumName: 'StoragePackageVisibility',
    example: 'public',
  })
  visibility!: StoragePackageVisibilityName;

  @ApiProperty({ example: false, description: 'A published version with a price is in force today (O-022).' })
  onSale!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: '0199f2a0-0000-7000-8000-0000000000ee',
  })
  versionId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'draft',
    description: 'TemplateVersionState of that version.',
  })
  versionState!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Price per period before VAT; null = no price.',
  })
  unitPrice!: string | null;

  @ApiProperty({ example: '0.0700' })
  vatRate!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-11-01' })
  effectiveFrom!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  effectiveTo!: string | null;
}

export class StoragePackageDefinitionsDto {
  @ApiProperty({ type: [StoragePackageDefinitionDto] })
  data!: StoragePackageDefinitionDto[];
}

export class CreateStoragePackageDto {
  @ApiProperty({
    example: 'storage_plus_20',
    description: 'Unique price-plan key (`^[a-z][a-z0-9_]{1,40}$`).',
  })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,40}$/)
  key!: string;

  @ApiProperty({ example: 'พื้นที่เพิ่ม 20 GB' })
  @IsString()
  @Length(1, 120)
  nameTh!: string;

  @ApiProperty({ example: 'Extra 20 GB' })
  @IsString()
  @Length(1, 120)
  nameEn!: string;

  @ApiProperty({ example: '20', description: 'Size in GiB (decimal string).' })
  @Matches(DECIMAL)
  sizeGb!: string;

  @ApiProperty({ enum: StoragePackagePeriodName, enumName: 'StoragePackagePeriod', example: 'month' })
  @IsEnum(StoragePackagePeriodName)
  period!: StoragePackagePeriodName;

  @ApiProperty({
    enum: StoragePackageVisibilityName,
    enumName: 'StoragePackageVisibility',
    example: 'public',
  })
  @IsEnum(StoragePackageVisibilityName)
  visibility!: StoragePackageVisibilityName;

  @ApiPropertyOptional({
    enum: TenantTypeName,
    enumName: 'TenantType',
    nullable: true,
    description: 'null = every type',
  })
  @IsOptional()
  @IsEnum(TenantTypeName)
  tenantType?: TenantTypeName | null;

  @ApiProperty({ format: 'date', example: '2026-11-01', description: 'Today or later (never backdated).' })
  @IsDateString({ strict: true })
  effectiveFrom!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: null,
    description: 'Price per period before VAT; leave empty until the founder sets it (O-022).',
  })
  @IsOptional()
  @Matches(DECIMAL)
  unitPrice?: string | null;

  @ApiPropertyOptional({ example: '0.07' })
  @IsOptional()
  @Matches(/^0(\.\d{1,4})?$/)
  vatRate?: string;
}

export class UpdateStoragePackageDto {
  @ApiPropertyOptional({ example: 'พื้นที่เพิ่ม 20 GB' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  nameTh?: string;

  @ApiPropertyOptional({ example: 'Extra 20 GB' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  nameEn?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'false = no longer offered (bought packages keep running).',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class StorageQuotaOverrideDto {
  @ApiProperty({ example: '20', description: 'Free allowance of this tenant in GB (decimal string, D-285).' })
  @Matches(DECIMAL)
  freeGb!: string;

  @ApiProperty({ example: 'ลูกค้าพิเศษ: พื้นที่ฟรี 20 GB ตามสัญญา' })
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-12-01T00:00:00+07:00',
    description: 'Now or future.',
  })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class StorageQuotaDto {
  @ApiProperty({ format: 'uuid', example: '0199f2a0-0000-7000-8000-000000000001' })
  tenantId!: string;

  @ApiProperty({ example: '20' })
  freeGb!: string;

  @ApiProperty({
    format: 'uuid',
    example: '0199f2a0-0000-7000-8000-0000000000ff',
    description: 'Setting version.',
  })
  versionId!: string;

  @ApiProperty({ format: 'date-time', example: '2026-12-01T00:00:00+07:00' })
  effectiveFrom!: string;
}

export class StorageReconciliationQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}

export class StorageReconciliationDto {
  @ApiProperty({ format: 'uuid', example: '0199f2a0-0000-7000-8000-000000000101' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: '0199f2a0-0000-7000-8000-000000000001' })
  tenantId!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-02T02:00:00+07:00' })
  ranAt!: string;

  @ApiProperty({ example: '650100000', description: 'Bytes object storage holds under the tenant prefix.' })
  s3Bytes!: string;

  @ApiProperty({ example: '1201' })
  s3Objects!: string;

  @ApiProperty({ example: '650000000', description: 'Counters before the run.' })
  dbBytes!: string;

  @ApiProperty({ example: '1200' })
  dbObjects!: string;

  @ApiProperty({ example: '100000', description: 's3Bytes − dbBytes.' })
  driftBytes!: string;

  @ApiProperty({ example: true })
  corrected!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      orphans: [],
      orphanCount: 0,
      missing: [],
      missingCount: 0,
      resizedDocuments: 1,
      countedAfter: '650100000',
    },
    description: 'Orphan and missing keys (at most 100 each) and how many documents were resized.',
  })
  details!: Record<string, unknown>;
}

export class StorageReconciliationPageDto {
  @ApiProperty({ type: [StorageReconciliationDto] })
  data!: StorageReconciliationDto[];

  @ApiProperty({ type: PageMeta })
  meta!: PageMeta;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function definitionDto(v: PackageDefinitionView): StoragePackageDefinitionDto {
  return {
    id: v.plan.id,
    key: v.plan.key,
    nameTh: v.plan.nameTh,
    nameEn: v.plan.nameEn,
    tenantType: v.plan.tenantType as TenantTypeName | null,
    isActive: v.plan.isActive,
    sizeBytes: v.terms?.sizeBytes ?? '0',
    period: (v.terms?.period ?? 'month') as StoragePackagePeriodName,
    visibility: (v.terms?.visibility ?? 'hidden') as StoragePackageVisibilityName,
    onSale: v.onSale,
    versionId: v.version?.id ?? null,
    versionState: v.version?.state ?? null,
    unitPrice: v.version?.unitPrice ? v.version.unitPrice.toFixed(2) : null,
    vatRate: v.version ? v.version.vatRate.toFixed(4) : '0.0700',
    effectiveFrom: day(v.version?.effectiveFrom ?? null),
    effectiveTo: day(v.version?.effectiveTo ?? null),
  };
}

const reconciliationDto = (r: StorageReconciliation): StorageReconciliationDto => ({
  id: r.id,
  tenantId: r.tenantId,
  ranAt: toBangkokIso(r.ranAt),
  s3Bytes: r.s3Bytes.toString(),
  s3Objects: r.s3Objects.toString(),
  dbBytes: r.dbBytes.toString(),
  dbObjects: r.dbObjects.toString(),
  driftBytes: r.driftBytes.toString(),
  corrected: r.corrected,
  details: (r.details ?? {}) as Record<string, unknown>,
});

const DEFINITION_EXAMPLE: StoragePackageDefinitionDto = {
  id: '0199f2a0-0000-7000-8000-0000000000bb',
  key: 'storage_plus_20',
  nameTh: 'พื้นที่เพิ่ม 20 GB',
  nameEn: 'Extra 20 GB',
  tenantType: null,
  isActive: true,
  sizeBytes: '21474836480',
  period: StoragePackagePeriodName.Month,
  visibility: StoragePackageVisibilityName.Public,
  onSale: false,
  versionId: '0199f2a0-0000-7000-8000-0000000000ee',
  versionState: 'draft',
  unitPrice: null,
  vatRate: '0.0700',
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
};

const RECONCILIATION_EXAMPLE: StorageReconciliationDto = {
  id: '0199f2a0-0000-7000-8000-000000000101',
  tenantId: '0199f2a0-0000-7000-8000-000000000001',
  ranAt: '2026-11-02T02:00:00+07:00',
  s3Bytes: '650100000',
  s3Objects: '1201',
  dbBytes: '650000000',
  dbObjects: '1200',
  driftBytes: '100000',
  corrected: true,
  details: {
    orphans: [],
    orphanCount: 0,
    missing: [],
    missingCount: 0,
    resizedDocuments: 1,
    countedAfter: '650100000',
  },
};

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
  constructor(
    private readonly db: TenantTx,
    private readonly packages: StoragePackagesService,
    private readonly reconciliation: StorageReconciliationService,
    private readonly tenantsService: TenantService,
  ) {}

  @Get('packages')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.storage.packages',
    summary: 'Storage package definitions',
    description:
      'Every storage package definition (D-285): a price-plan add-on with size, period and visibility; `onSale` once a published version with a price is in force (prices O-022). Prices change only through new price-plan versions (`POST /v1/admin/price-plans/{planId}/versions`, then publish — never backdated, D-204 / D-291).',
    implements: ['D-285', 'D-291'],
  })
  @ApiSuccess(200, {
    description: 'Definitions',
    type: StoragePackageDefinitionsDto,
    example: { data: [DEFINITION_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed')
  async listPackages(): Promise<StoragePackageDefinitionsDto> {
    return { data: (await this.packages.definitions()).map(definitionDto) };
  }

  @Post('packages')
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.storage.createPackage',
    summary: 'Define a storage package',
    description:
      'Creates a storage package definition (D-285) as an add-on price plan (billing unit `per_package`) with a draft version from `effectiveFrom` (today or later). Leave `unitPrice` empty until the founder sets it (O-022): the package is shown to owners as not on sale. Publish the version with the price-plan publish action.',
    implements: ['D-285', 'D-291'],
  })
  @ApiJsonBody(CreateStoragePackageDto, {
    key: 'storage_plus_20',
    nameTh: 'พื้นที่เพิ่ม 20 GB',
    nameEn: 'Extra 20 GB',
    sizeGb: '20',
    period: 'month',
    visibility: 'public',
    effectiveFrom: '2026-11-01',
    unitPrice: null,
  })
  @ApiSuccess(201, { description: 'Defined', type: StoragePackageDefinitionDto, example: DEFINITION_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'settings.backdated')
  async createPackage(@Body() body: CreateStoragePackageDto): Promise<StoragePackageDefinitionDto> {
    return definitionDto(await this.packages.createDefinition(body));
  }

  @Patch('packages/:packageId')
  @Can('admin.subscription.manage')
  @ApiEndpoint({
    id: 'admin.storage.updatePackage',
    summary: 'Rename or switch off a storage package',
    description:
      'Names and the active switch of a definition (D-285); switching off stops new purchases, bought packages keep running to their end. Size, period and price change through a new price-plan version.',
    implements: ['D-285'],
  })
  @ApiJsonBody(UpdateStoragePackageDto, { isActive: false })
  @ApiSuccess(200, {
    description: 'Updated',
    type: StoragePackageDefinitionDto,
    example: { ...DEFINITION_EXAMPLE, isActive: false },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async updatePackage(
    @Param('packageId', ParseUUIDPipe) id: string,
    @Body() body: UpdateStoragePackageDto,
  ): Promise<StoragePackageDefinitionDto> {
    return definitionDto(await this.packages.updateDefinition(id, body));
  }

  @Get('reconciliations')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.storage.reconciliations',
    summary: 'Storage reconciliation reports',
    description:
      "The nightly comparison of each tenant's object-storage prefix with its counters (D-286): bytes and objects on both sides, the drift, whether the counters were corrected (`storage.reconciliation.auto_correct`), orphan and missing keys. Newest first; filter by tenant.",
    implements: ['D-286'],
  })
  @ApiSuccess(200, {
    description: 'Reports',
    type: StorageReconciliationPageDto,
    example: { data: [RECONCILIATION_EXAMPLE], meta: { page: 1, perPage: 25, total: 1 } },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request')
  async reconciliations(@Query() q: StorageReconciliationQuery): Promise<StorageReconciliationPageDto> {
    const where = q.tenantId ? { tenantId: q.tenantId } : {};
    return this.db.platform(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.storageReconciliation.findMany({
          where,
          orderBy: { ranAt: 'desc' },
          skip: (q.page - 1) * q.perPage,
          take: q.perPage,
        }),
        tx.storageReconciliation.count({ where }),
      ]);
      return { data: rows.map(reconciliationDto), meta: { page: q.page, perPage: q.perPage, total } };
    });
  }

  @Post('tenants/:tenantId/actions/reconcile')
  @HttpCode(200)
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.storage.reconcile',
    summary: "Reconcile one tenant's storage now",
    description:
      'Runs the nightly reconciliation for one tenant at once (support, D-286) and returns its report; idempotent (each run appends a report).',
    implements: ['D-286'],
  })
  @ApiSuccess(200, { description: 'Report', type: StorageReconciliationDto, example: RECONCILIATION_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async reconcileNow(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<StorageReconciliationDto> {
    await this.tenantsService.getAny(tenantId);
    const { reportId } = await this.reconciliation.reconcile(tenantId);
    const row = await this.db.platform((tx) =>
      tx.storageReconciliation.findUniqueOrThrow({ where: { id: reportId } }),
    );
    return reconciliationDto(row);
  }

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

/** The per-tenant storage quota override (D-285): a tenant version of `storage.free_gb`, audited by the settings. */
@ApiTags('admin.storage')
@ApiSurface(SURFACES.admin)
@Controller('admin/tenants/:tenantId/storage-quota')
export class AdminTenantStorageQuotaController {
  constructor(
    private readonly tenants: TenantService,
    private readonly settings: SettingsService,
  ) {}

  @Put()
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.storage.setQuota',
    summary: "Set a tenant's free storage",
    description:
      "Overrides the free storage allowance of one tenant (custom deal, D-285 / D-279): an effective-dated tenant version of `storage.free_gb` for the tenant's type, audited and never backdated. The effective quota stays free (this value) + active storage packages.",
    implements: ['D-285', 'D-279', 'D-291'],
  })
  @ApiJsonBody(StorageQuotaOverrideDto, { freeGb: '20', reason: 'ลูกค้าพิเศษ: พื้นที่ฟรี 20 GB ตามสัญญา' })
  @ApiSuccess(200, {
    description: 'Override set',
    type: StorageQuotaDto,
    example: {
      tenantId: '0199f2a0-0000-7000-8000-000000000001',
      freeGb: '20',
      versionId: '0199f2a0-0000-7000-8000-0000000000ff',
      effectiveFrom: '2026-12-01T00:00:00+07:00',
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'settings.invalid_value',
    'settings.backdated',
  )
  async set(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: StorageQuotaOverrideDto,
  ): Promise<StorageQuotaDto> {
    const tenant = await this.tenants.getAny(tenantId);
    const ctx: TenantContext = { tenantId, source: 'path' };
    const row = await this.settings.setTenant(
      ctx,
      'storage.free_gb',
      { [tenant.type]: body.freeGb },
      body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      body.reason,
      true,
    );
    return {
      tenantId,
      freeGb: body.freeGb,
      versionId: row.id,
      effectiveFrom: toBangkokIso(row.effectiveFrom),
    };
  }
}

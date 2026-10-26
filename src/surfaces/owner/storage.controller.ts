import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { bangkokDate, toBangkokIso } from '@common/time/bangkok';
import { StorageLedger } from '@core/storage/storage-ledger';
import { StorageMeteringService } from '@core/storage/storage-metering.service';
import { StorageReclaimService } from '@core/storage/storage-reclaim.service';
import { TenantTx } from '@database/tenant-tx';
import { type StorageCategory } from '@generated/prisma/client';
import { StoragePackagesService } from '@modules/platform-subscriptions/storage-packages.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  OwnerStorageDto,
  OwnerStoragePackageDto,
  OwnerStoragePackagesDto,
  StorageAutoRenewDto,
  type StorageCategoryName,
  StorageFilesActionDto,
  StoragePurchaseDto,
  StoredFileListQuery,
  StoredFilePageDto,
  StoredFilesResultDto,
} from './storage.dto';
import {
  OFFER_EXAMPLE,
  offerDto,
  OWNER_PACKAGE_EXAMPLE,
  ownerPackageDto,
  STORED_FILE_EXAMPLE,
  storedFileDto,
} from './storage.mappers';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

/**
 * The owner's storage (D-276, D-285, D-286): the usage bar of the console — files (with thumbnails / renditions) plus
 * records at the counted size of their type, the quota (free allowance or the tenant's override + active packages),
 * where the space goes (categories, legal holds), the largest files to reclaim space (soft delete, restore, purge
 * after the window) and the storage packages to buy. Nothing here locks data; legal documents are always issued.
 */
@ApiTags('owner.storage')
@ApiSurface(SURFACES.owner)
@Controller('owner/storage')
export class OwnerStorageController {
  constructor(
    private readonly db: TenantTx,
    private readonly metering: StorageMeteringService,
    private readonly ledger: StorageLedger,
    private readonly reclaim: StorageReclaimService,
    private readonly packages: StoragePackagesService,
  ) {}

  @Get()
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.storage.get',
    summary: 'My storage',
    description:
      'What the tenant stores (files incl. thumbnails / renditions + records at their counted size), the quota = free allowance (tenant override first) + active storage packages, its level (ok / warning / full / over), the price per GB-month above it, where the space goes (categories), the bytes under legal hold (counted, never deletable — D-286), the bytes deleted for reclaim that count until their purge, and the last 30 daily snapshots (D-276, D-285). `metered: false` while the platform has not set a free allowance for the tenant type.',
    implements: ['D-276', 'D-285', 'D-286'],
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
      freeBytes: '5368709120',
      packageBytes: '0',
      categories: [
        { category: 'listing_media', bytes: '420000000', objects: 900 },
        { category: 'attachment', bytes: '150000000', objects: 300 },
        { category: 'system_legal', bytes: '70000000', objects: 2300 },
        { category: 'system_other', bytes: '10000000', objects: 40 },
      ],
      legalHoldBytes: '70000000',
      pendingPurgeBytes: '0',
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
      const totals = await this.ledger.totals(tx, ctx.tenantId);
      const today = bangkokDate(new Date(s.asOf));
      const extra = await tx.$queryRaw<{ held: bigint | null; pending: bigint | null }[]>`
        SELECT
          (SELECT sum(st.bytes) FROM platform.document_storage st JOIN platform.document_legal_hold h ON h.document_id = st.document_id
            WHERE st.tenant_id = ${ctx.tenantId}::uuid AND st.counted AND h.released_at IS NULL
              AND (h.retain_until IS NULL OR h.retain_until > ${today}::date))::bigint AS held,
          (SELECT sum(st.bytes) FROM platform.document_storage st JOIN core.document d ON d.id = st.document_id
            WHERE st.tenant_id = ${ctx.tenantId}::uuid AND st.counted AND d.deleted_at IS NOT NULL)::bigint AS pending`;
      const freeBytes = s.state ? s.state.allowanceBytes - s.packageBytes : null;
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
        freeBytes: freeBytes?.toString() ?? null,
        packageBytes: s.packageBytes.toString(),
        categories: (Object.entries(totals) as [StorageCategory, { bytes: bigint; objects: number }][]).map(
          ([category, t]) => ({
            category: category as StorageCategoryName,
            bytes: t.bytes.toString(),
            objects: t.objects,
          }),
        ),
        legalHoldBytes: (extra[0]?.held ?? 0n).toString(),
        pendingPurgeBytes: (extra[0]?.pending ?? 0n).toString(),
      };
    });
  }

  @Get('files')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.storage.files',
    summary: 'Stored files, largest first',
    description:
      "The tenant's stored files with what each occupies (file + thumbnails / renditions), its category, whether it is under a legal hold (D-286) and whether the owner may delete it to reclaim space (D-285) — with the reason when not. `sort=size` (default) or `createdAt`; `state=deleted` lists files deleted for reclaim that can still be restored until `purgeAfter`.",
    implements: ['D-285', 'D-286'],
  })
  @ApiSuccess(200, {
    description: 'Files',
    type: StoredFilePageDto,
    example: { data: [STORED_FILE_EXAMPLE], meta: { page: 1, perPage: 25, total: 1 } },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', ...T)
  async files(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: StoredFileListQuery,
  ): Promise<StoredFilePageDto> {
    if (q.sort && !['size', 'createdAt'].includes(q.sort))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'sort', code: 'isIn', message: 'size or createdAt' }],
      });
    const { rows, total } = await this.reclaim.list(ctx, {
      category: q.category,
      state: q.state,
      sort: q.sort === 'createdAt' ? 'created' : 'size',
      page: q.page,
      perPage: q.perPage,
    });
    return { data: rows.map(storedFileDto), meta: { page: q.page, perPage: q.perPage, total } };
  }

  @Post('files/actions/delete')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.storage.deleteFiles',
    summary: 'Delete files to reclaim space',
    description:
      'Soft-deletes optional files the owner no longer needs (listing photos of closed listings, attachments) — all or nothing (D-285). They still count and can be restored until `storage.reclaim.purge_after_days` (7) have passed; then their objects are removed and the quota drops. A document under a legal hold is refused with `storage.legal_hold` and its id in `heldDocumentIds` (D-286); evidence, identity and system files and photos of a live listing with `storage.not_deletable`.',
    implements: ['D-285', 'D-286'],
  })
  @ApiJsonBody(StorageFilesActionDto, { documentIds: ['0199f2a0-0000-7000-8000-0000000000aa'] })
  @ApiSuccess(200, {
    description: 'Deleted (restorable until purgeAfter)',
    type: StoredFilesResultDto,
    example: {
      data: [
        {
          ...STORED_FILE_EXAMPLE,
          deletedAt: '2026-11-01T10:00:00+07:00',
          purgeAfter: '2026-11-08T10:00:00+07:00',
          deletable: false,
        },
      ],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'storage.legal_hold',
    'storage.not_deletable',
    'tenant.read_only',
    ...T,
  )
  async deleteFiles(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: StorageFilesActionDto,
  ): Promise<StoredFilesResultDto> {
    return { data: (await this.reclaim.delete(ctx, body.documentIds)).map(storedFileDto) };
  }

  @Post('files/actions/restore')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.storage.restoreFiles',
    summary: 'Restore files deleted to reclaim space',
    description:
      'Restores files deleted for reclaim that are not purged yet (D-285); files that are not deleted are left as they are. Files deleted otherwise (retention, erasure) or already purged: `storage.not_restorable`.',
    implements: ['D-285'],
  })
  @ApiJsonBody(StorageFilesActionDto, { documentIds: ['0199f2a0-0000-7000-8000-0000000000aa'] })
  @ApiSuccess(200, {
    description: 'Restored',
    type: StoredFilesResultDto,
    example: { data: [STORED_FILE_EXAMPLE] },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'storage.not_restorable',
    'tenant.read_only',
    ...T,
  )
  async restoreFiles(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: StorageFilesActionDto,
  ): Promise<StoredFilesResultDto> {
    return { data: (await this.reclaim.restore(ctx, body.documentIds)).map(storedFileDto) };
  }

  @Get('packages')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.storage.packages',
    summary: 'Storage packages',
    description:
      'The storage packages the platform offers to this tenant type (size, period, price before and incl. VAT; `onSale: false` = no price yet, shown "ยังไม่เปิดขาย" — O-022) and the tenant\'s own packages with their purchase invoice (D-285).',
    implements: ['D-285'],
  })
  @ApiSuccess(200, {
    description: 'Offers and my packages',
    type: OwnerStoragePackagesDto,
    example: { offers: [OFFER_EXAMPLE], packages: [OWNER_PACKAGE_EXAMPLE] },
  })
  @ApiStandardErrors(...T)
  async listPackages(@CurrentTenant() ctx: TenantContext): Promise<OwnerStoragePackagesDto> {
    const { offers, mine } = await this.packages.catalogue(ctx);
    return { offers: offers.map(offerDto), packages: mine.map(ownerPackageDto) };
  }

  @Post('packages')
  @Idempotent()
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.storage.purchasePackage',
    summary: 'Buy a storage package',
    description:
      'Orders a storage package (D-285): a pending package and a `purchase` platform invoice issued by Collective (O-008; Thai QR once the platform merchant exists, else bank transfer recorded by Finance). The package becomes active on the day its invoice is paid and raises the quota until it ends; an unpaid purchase is simply not activated — nothing is suspended. Not on sale: `storage.package_not_on_sale`; the same package already waiting for payment: `storage.package_pending`.',
    implements: ['D-285', 'D-250'],
  })
  @ApiJsonBody(StoragePurchaseDto, { packageId: '0199f2a0-0000-7000-8000-0000000000bb', autoRenew: false })
  @ApiSuccess(201, { description: 'Ordered', type: OwnerStoragePackageDto, example: OWNER_PACKAGE_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'storage.package_not_on_sale',
    'storage.package_pending',
    ...T,
  )
  async purchase(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: StoragePurchaseDto,
  ): Promise<OwnerStoragePackageDto> {
    return ownerPackageDto(await this.packages.purchase(ctx, body));
  }

  @Get('packages/:storagePackageId')
  @TenantScoped()
  @Can('tenant.subscription.read')
  @ApiEndpoint({
    id: 'owner.storage.package',
    summary: 'One of my storage packages',
    description:
      "A storage package of the tenant with its state and purchase invoice (D-285). Another tenant's: 404.",
    implements: ['D-285'],
  })
  @ApiSuccess(200, { description: 'Package', type: OwnerStoragePackageDto, example: OWNER_PACKAGE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async getPackage(
    @CurrentTenant() ctx: TenantContext,
    @Param('storagePackageId', ParseUUIDPipe) id: string,
  ): Promise<OwnerStoragePackageDto> {
    return ownerPackageDto(await this.packages.getOwn(ctx, id));
  }

  @Post('packages/:storagePackageId/actions/auto-renew')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.storage.setAutoRenew',
    summary: 'Switch auto-renew of a storage package',
    description:
      'With auto-renew the next period is invoiced `storage.package.renew_days_before` days before the package ends (D-285); without it the package ends and nothing is deleted (uploads over the quota are then held, D-286).',
    implements: ['D-285'],
  })
  @ApiJsonBody(StorageAutoRenewDto, { autoRenew: true })
  @ApiSuccess(200, {
    description: 'Package',
    type: OwnerStoragePackageDto,
    example: { ...OWNER_PACKAGE_EXAMPLE, autoRenew: true },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...T)
  async setAutoRenew(
    @CurrentTenant() ctx: TenantContext,
    @Param('storagePackageId', ParseUUIDPipe) id: string,
    @Body() body: StorageAutoRenewDto,
  ): Promise<OwnerStoragePackageDto> {
    return ownerPackageDto(await this.packages.setAutoRenew(ctx, id, body.autoRenew));
  }
}

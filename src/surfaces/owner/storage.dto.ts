import { PageMeta, PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { DocumentKindName } from '../shared/status.enums';

export class StorageDayDto {
  @ApiProperty({ format: 'date', example: '2026-10-24' })
  day!: string;

  @ApiProperty({ example: '734003200', description: 'Counted bytes that day (decimal string).' })
  countedBytes!: string;
}

// ------------------------------------------------------------------------------------------- G1 (D-285, D-286)

export enum StorageCategoryName {
  ListingMedia = 'listing_media',
  Attachment = 'attachment',
  SystemLegal = 'system_legal',
  SystemOther = 'system_other',
}

export enum ReclaimRefusalName {
  LegalHold = 'legal_hold',
  SystemFile = 'system_file',
  Evidence = 'evidence',
  ListingInUse = 'listing_in_use',
}

export enum StoragePackagePeriodName {
  Month = 'month',
  Year = 'year',
}

export enum StoragePackageStateName {
  PendingPayment = 'pending_payment',
  Active = 'active',
  Expired = 'expired',
  Cancelled = 'cancelled',
}

export enum StoragePackageVisibilityName {
  Public = 'public',
  Hidden = 'hidden',
}

export enum StoredFileStateName {
  Active = 'active',
  Deleted = 'deleted',
}

export class StorageCategoryUsageDto {
  @ApiProperty({
    enum: StorageCategoryName,
    enumName: 'StorageCategory',
    example: StorageCategoryName.SystemLegal,
  })
  category!: StorageCategoryName;

  @ApiProperty({
    example: '52428800',
    description: 'Bytes stored (files + thumbnails / renditions), decimal string.',
  })
  bytes!: string;

  @ApiProperty({ type: 'integer', example: 310, description: 'Objects in object storage.' })
  objects!: number;
}

export class StoredFileListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: StorageCategoryName, enumName: 'StorageCategory' })
  @IsOptional()
  @IsEnum(StorageCategoryName)
  category?: StorageCategoryName;

  @ApiPropertyOptional({
    enum: StoredFileStateName,
    enumName: 'StoredFileState',
    default: StoredFileStateName.Active,
    description: '`active` = stored files; `deleted` = deleted to reclaim space, restorable until the purge.',
  })
  @IsOptional()
  @IsEnum(StoredFileStateName)
  state?: StoredFileStateName;
}

export class StoredFileDto {
  @ApiProperty({ format: 'uuid', example: '0199f2a0-0000-7000-8000-0000000000aa' })
  id!: string;

  @ApiProperty({ enum: DocumentKindName, enumName: 'DocumentKind', example: DocumentKindName.ListingPhoto })
  kind!: DocumentKindName;

  @ApiProperty({ type: String, nullable: true, example: 'ห้อง 301 มุมนั่งเล่น.jpg' })
  title!: string | null;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType!: string;

  @ApiProperty({
    enum: StorageCategoryName,
    enumName: 'StorageCategory',
    example: StorageCategoryName.ListingMedia,
  })
  category!: StorageCategoryName;

  @ApiProperty({ example: '1843200', description: 'Bytes incl. thumbnails / renditions (decimal string).' })
  bytes!: string;

  @ApiProperty({ type: 'integer', example: 5 })
  objects!: number;

  @ApiProperty({ format: 'date-time', example: '2026-10-01T10:00:00+07:00' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  deletedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'When a deleted file is removed for good (restorable until then).',
  })
  purgeAfter!: string | null;

  @ApiProperty({
    example: false,
    description: 'Under a legal hold (D-286): counted, never deletable before its date.',
  })
  held!: boolean;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: null,
    description: 'End of the legal hold; null with `held` = until its basis event (e.g. lease end).',
  })
  retainUntil!: string | null;

  @ApiProperty({ example: true })
  deletable!: boolean;

  @ApiProperty({
    enum: ReclaimRefusalName,
    enumName: 'ReclaimRefusal',
    nullable: true,
    example: null,
    description: 'Why the file cannot be deleted here (null when deletable or already deleted).',
  })
  notDeletableReason!: ReclaimRefusalName | null;
}

export class StoredFilePageDto {
  @ApiProperty({ type: [StoredFileDto] })
  data!: StoredFileDto[];

  @ApiProperty({ type: PageMeta })
  meta!: PageMeta;
}

export class StorageFilesActionDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: 100,
    example: ['0199f2a0-0000-7000-8000-0000000000aa'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  documentIds!: string[];
}

export class StoredFilesResultDto {
  @ApiProperty({ type: [StoredFileDto] })
  data!: StoredFileDto[];
}

export class StoragePackageOfferDto {
  @ApiProperty({
    format: 'uuid',
    example: '0199f2a0-0000-7000-8000-0000000000bb',
    description: 'Package id.',
  })
  id!: string;

  @ApiProperty({ example: 'storage_plus_20' })
  key!: string;

  @ApiProperty({ example: 'พื้นที่เพิ่ม 20 GB' })
  nameTh!: string;

  @ApiProperty({ example: 'Extra 20 GB' })
  nameEn!: string;

  @ApiProperty({ example: '21474836480' })
  sizeBytes!: string;

  @ApiProperty({ enum: StoragePackagePeriodName, enumName: 'StoragePackagePeriod', example: 'month' })
  period!: StoragePackagePeriodName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Price per period before VAT; null = not on sale yet (O-022).',
  })
  price!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Price incl. VAT (what the invoice asks).',
  })
  total!: string | null;

  @ApiProperty({ example: '0.0700' })
  vatRate!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({
    example: false,
    description: 'false = shown as "ยังไม่เปิดขาย" (no published price yet, D-285).',
  })
  onSale!: boolean;
}

export class StoragePackageInvoiceDto {
  @ApiProperty({ format: 'uuid', example: '0199f2a0-0000-7000-8000-0000000000cc' })
  id!: string;

  @ApiProperty({ example: 'PIV-2026-00012' })
  number!: string;

  @ApiProperty({ example: '107.00' })
  total!: string;

  @ApiProperty({ example: 'issued', description: 'Platform invoice status (PlatformInvoiceStatus values).' })
  state!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-08T10:00:00+07:00' })
  dueAt!: string;

  @ApiProperty({
    example: false,
    description: 'A Thai QR exists (the platform merchant is configured, O-008).',
  })
  qrAvailable!: boolean;
}

export class OwnerStoragePackageDto {
  @ApiProperty({ format: 'uuid', example: '0199f2a0-0000-7000-8000-0000000000dd' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: '0199f2a0-0000-7000-8000-0000000000bb' })
  packageId!: string;

  @ApiProperty({ example: 'พื้นที่เพิ่ม 20 GB' })
  name!: string;

  @ApiProperty({ example: '21474836480' })
  sizeBytes!: string;

  @ApiProperty({ example: '107.00', description: 'Price paid per period incl. VAT (snapshot).' })
  price!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ enum: StoragePackagePeriodName, enumName: 'StoragePackagePeriod', example: 'month' })
  period!: StoragePackagePeriodName;

  @ApiProperty({ enum: StoragePackageStateName, enumName: 'StoragePackageState', example: 'pending_payment' })
  state!: StoragePackageStateName;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  startsOn!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  endsOn!: string | null;

  @ApiProperty({ example: false })
  autoRenew!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  renewalOfId!: string | null;

  @ApiProperty({ type: StoragePackageInvoiceDto, nullable: true })
  invoice!: StoragePackageInvoiceDto | null;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T10:00:00+07:00' })
  createdAt!: string;
}

export class OwnerStoragePackagesDto {
  @ApiProperty({ type: [StoragePackageOfferDto] })
  offers!: StoragePackageOfferDto[];

  @ApiProperty({ type: [OwnerStoragePackageDto] })
  packages!: OwnerStoragePackageDto[];
}

export class StoragePurchaseDto {
  @ApiProperty({
    format: 'uuid',
    example: '0199f2a0-0000-7000-8000-0000000000bb',
    description: 'Package id (offer).',
  })
  @IsUUID()
  packageId!: string;

  @ApiPropertyOptional({ default: false, description: 'Invoice the next period before this one ends.' })
  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;
}

export class StorageAutoRenewDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  autoRenew!: boolean;
}

/** The owner's storage position (D-276): what is stored, the allowance and the last 30 daily snapshots. */
export class OwnerStorageDto {
  @ApiProperty({ format: 'date-time', example: '2026-10-25T09:00:00+07:00' })
  asOf!: string;

  @ApiProperty({
    example: false,
    description:
      'False while the platform has not set a free allowance for this tenant type: usage is shown, nothing is held.',
  })
  metered!: boolean;

  @ApiProperty({
    example: '734003200',
    description: 'Counted bytes: files + records × counted size (decimal string).',
  })
  usedBytes!: string;

  @ApiProperty({ example: '650000000', description: 'Bytes of the stored files (decimal string).' })
  fileBytes!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { invoice: 1203, receipt: 1150, meter_reading: 8800 },
    description: 'Stored records per counted type.',
  })
  records!: Record<string, number>;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '5368709120',
    description: 'Free allowance + packs (bytes).',
  })
  allowanceBytes!: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 13,
    description: 'Used / allowance, whole percent (floor).',
  })
  usedPercent!: number | null;

  @ApiProperty({
    enum: ['ok', 'warning', 'full', 'over'],
    enumName: 'StorageLevel',
    nullable: true,
    example: 'ok',
  })
  level!: 'ok' | 'warning' | 'full' | 'over' | null;

  @ApiProperty({ type: String, nullable: true, example: '5', description: 'Free allowance in GB (setting).' })
  freeGb!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'THB per GB-month above the allowance (setting); null = overage not sold.',
  })
  pricePerGbMonth!: string | null;

  @ApiProperty({ type: [StorageDayDto] })
  history!: StorageDayDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '5368709120',
    description: 'Free allowance in bytes (tenant override first, D-285); null = not metered.',
  })
  freeBytes!: string | null;

  @ApiProperty({ example: '0', description: 'Bytes added by active storage packages (D-285).' })
  packageBytes!: string;

  @ApiProperty({ type: [StorageCategoryUsageDto], description: 'Where the space goes (G1 counters).' })
  categories!: StorageCategoryUsageDto[];

  @ApiProperty({
    example: '52428800',
    description:
      'Bytes of documents under a legal hold — counted, never deletable before their date (D-286).',
  })
  legalHoldBytes!: string;

  @ApiProperty({
    example: '0',
    description: 'Bytes of files deleted to reclaim space that still count until their purge (D-285).',
  })
  pendingPurgeBytes!: string;
}

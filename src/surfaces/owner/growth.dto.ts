import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { MoneyOutput } from '../shared/fields';
import { StoragePackageInvoiceDto, StoragePackageStateName } from './storage.dto';

// G5 (D-287, D-297): boosts and verified photo / 360° orders on the owner console.

export enum BoostTargetName {
  Listing = 'listing',
  Building = 'building',
}
/** A boost has the lifecycle of a G1 storage package (pending_payment → active → expired | cancelled). */
export { StoragePackageStateName as BoostStateName };
export enum MediaServiceKindName {
  VerifiedPhoto = 'verified_photo',
  Tour360 = 'tour_360',
}
export enum MediaServiceStateName {
  PendingPayment = 'pending_payment',
  Requested = 'requested',
  Scheduled = 'scheduled',
  Delivered = 'delivered',
  Cancelled = 'cancelled',
}

/** A purchase invoice of a growth product (the G1 shape). */
export { StoragePackageInvoiceDto as GrowthInvoiceDto } from './storage.dto';

export class BoostProductDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'Product id (price plan) to buy.' })
  id!: string;

  @ApiProperty({ example: 'boost_listing_7d' })
  key!: string;

  @ApiProperty({ example: 'โปรโมตประกาศ 7 วัน' })
  nameTh!: string;

  @ApiProperty({ example: 'Listing boost, 7 days' })
  nameEn!: string;

  @ApiProperty({ enum: BoostTargetName, enumName: 'BoostTarget', example: BoostTargetName.Listing })
  target!: BoostTargetName;

  @ApiProperty({ type: 'integer', nullable: true, example: 7, description: 'Length in days (or `months`).' })
  days!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: null, description: 'Length in calendar months.' })
  months!: number | null;

  @MoneyOutput({
    example: null,
    nullable: true,
    description: 'Price before VAT; null = not on sale (O-027).',
  })
  price!: string | null;

  @MoneyOutput({ example: null, nullable: true, description: 'Price incl. VAT; null = not on sale.' })
  total!: string | null;

  @ApiProperty({ example: '0.0700' })
  vatRate!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ example: false, description: 'Can be bought now (priced, or free for this tenant).' })
  onSale!: boolean;

  @ApiProperty({
    example: false,
    description: 'A building boost that is free for this tenant (`boost.building.free`, D-297).',
  })
  free!: boolean;
}

export class BoostProductsDto {
  @ApiProperty({ type: [BoostProductDto] })
  products!: BoostProductDto[];
}

export class BoostPurchaseDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'Boost product id (`GET /v1/owner/boost-products`).',
  })
  @IsUUID()
  productId!: string;
}

export class BoostListQuery {
  @ApiPropertyOptional({ enum: StoragePackageStateName, enumName: 'StoragePackageState' })
  @IsOptional()
  @IsEnum(StoragePackageStateName)
  state?: StoragePackageStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  listingId?: string;
}

export class BoostDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The product (price plan).' })
  productId!: string;

  @ApiProperty({ example: 'boost_listing_7d' })
  productKey!: string;

  @ApiProperty({ example: 'โปรโมตประกาศ 7 วัน' })
  name!: string;

  @ApiProperty({ enum: BoostTargetName, enumName: 'BoostTarget', example: BoostTargetName.Listing })
  target!: BoostTargetName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  listingId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'condo-1br-ari-8f3k2' })
  listingSlug!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', description: 'Listing title or building name.' })
  targetName!: string;

  @ApiProperty({ type: 'integer', nullable: true, example: 7 })
  days!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: null })
  months!: number | null;

  @MoneyOutput({ example: '535.00', description: 'Price paid incl. VAT (snapshot; 0.00 when free).' })
  price!: string;

  @ApiProperty({ example: false })
  free!: boolean;

  @ApiProperty({
    enum: StoragePackageStateName,
    enumName: 'StoragePackageState',
    example: StoragePackageStateName.PendingPayment,
  })
  state!: StoragePackageStateName;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'Set when paid; later than now when queued after an earlier boost of the same target.',
  })
  startsAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  endsAt!: string | null;

  @ApiProperty({
    type: StoragePackageInvoiceDto,
    nullable: true,
    description: 'The purchase invoice (null when free).',
  })
  invoice!: StoragePackageInvoiceDto | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class BoostsDto {
  @ApiProperty({ type: [BoostDto] })
  data!: BoostDto[];
}

export class MediaServiceProductDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'media_verified_photo' })
  key!: string;

  @ApiProperty({ example: 'บริการถ่ายภาพยืนยันห้องจริง' })
  nameTh!: string;

  @ApiProperty({ example: 'Verified photo service' })
  nameEn!: string;

  @ApiProperty({
    enum: MediaServiceKindName,
    enumName: 'MediaServiceKind',
    example: MediaServiceKindName.VerifiedPhoto,
  })
  service!: MediaServiceKindName;

  @MoneyOutput({
    example: null,
    nullable: true,
    description: 'Price before VAT; null = not on sale (O-027).',
  })
  price!: string | null;

  @MoneyOutput({ example: null, nullable: true, description: 'Price incl. VAT; null = not on sale.' })
  total!: string | null;

  @ApiProperty({ example: '0.0700' })
  vatRate!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ example: false })
  onSale!: boolean;
}

export class MediaServiceProductsDto {
  @ApiProperty({ type: [MediaServiceProductDto] })
  products!: MediaServiceProductDto[];
}

export class MediaServiceOrderCreateDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'One of my listings (its unit is photographed).',
  })
  @IsUUID()
  listingId!: string;

  @ApiProperty({
    enum: MediaServiceKindName,
    enumName: 'MediaServiceKind',
    example: MediaServiceKindName.VerifiedPhoto,
  })
  @IsEnum(MediaServiceKindName)
  service!: MediaServiceKindName;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000, example: 'สะดวกช่วงบ่ายวันธรรมดา' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class MediaServiceOrderDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: MediaServiceKindName,
    enumName: 'MediaServiceKind',
    example: MediaServiceKindName.VerifiedPhoto,
  })
  service!: MediaServiceKindName;

  @ApiProperty({ example: 'บริการถ่ายภาพยืนยันห้องจริง' })
  name!: string;

  @ApiProperty({
    enum: MediaServiceStateName,
    enumName: 'MediaServiceState',
    example: MediaServiceStateName.PendingPayment,
  })
  state!: MediaServiceStateName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  listingId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  listingTitle!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @MoneyOutput({ example: '1605.00', description: 'Price incl. VAT (snapshot).' })
  price!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  scheduledFor!: string | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: [],
    description:
      'Delivered files: documents of this tenant in the unit’s scope (listing media, counted to the quota).',
  })
  deliverableDocumentIds!: string[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  requestedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  deliveredAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancelReason!: string | null;

  @ApiProperty({ type: StoragePackageInvoiceDto, nullable: true })
  invoice!: StoragePackageInvoiceDto | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class MediaServiceOrdersDto {
  @ApiProperty({ type: [MediaServiceOrderDto] })
  data!: MediaServiceOrderDto[];
}

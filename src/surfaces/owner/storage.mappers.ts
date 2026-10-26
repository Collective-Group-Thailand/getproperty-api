import { toBangkokIso } from '@common/time/bangkok';
import { type StoredFileRow } from '@core/storage/storage-reclaim.service';
import {
  type PlatformInvoice,
  type PricePlan,
  type PricePlanVersion,
  type StoragePackage,
} from '@generated/prisma/client';
import { type PackageDefinitionView } from '@modules/platform-subscriptions/storage-packages.service';
import Decimal from 'decimal.js';

import { type DocumentKindName } from '../shared/status.enums';
import {
  type OwnerStoragePackageDto,
  type ReclaimRefusalName,
  type StorageCategoryName,
  type StoragePackageOfferDto,
  type StoragePackagePeriodName,
  type StoragePackageStateName,
  type StoredFileDto,
} from './storage.dto';

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function storedFileDto(r: StoredFileRow): StoredFileDto {
  return {
    id: r.id,
    kind: r.kind as unknown as DocumentKindName,
    title: r.title,
    mimeType: r.mimeType,
    category: r.category as StorageCategoryName,
    bytes: r.bytes.toString(),
    objects: r.objects,
    createdAt: toBangkokIso(r.createdAt),
    deletedAt: r.deletedAt ? toBangkokIso(r.deletedAt) : null,
    purgeAfter: r.purgeAfter ? toBangkokIso(r.purgeAfter) : null,
    held: r.held,
    retainUntil: r.retainUntil,
    deletable: r.deletable,
    notDeletableReason: r.notDeletableReason as ReclaimRefusalName | null,
  };
}

export function offerDto(v: PackageDefinitionView): StoragePackageOfferDto {
  const price = v.onSale && v.version?.unitPrice ? new Decimal(v.version.unitPrice.toString()) : null;
  const vatRate = new Decimal(v.version?.vatRate.toString() ?? '0.07');
  const net = price?.toDecimalPlaces(2, Decimal.ROUND_HALF_UP) ?? null;
  return {
    id: v.plan.id,
    key: v.plan.key,
    nameTh: v.plan.nameTh,
    nameEn: v.plan.nameEn,
    sizeBytes: v.terms?.sizeBytes ?? '0',
    period: (v.terms?.period ?? 'month') as StoragePackagePeriodName,
    price: net?.toFixed(2) ?? null,
    total: net ? net.plus(net.times(vatRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)).toFixed(2) : null,
    vatRate: vatRate.toFixed(4),
    currency: 'THB',
    onSale: v.onSale,
  };
}

export function ownerPackageDto(
  p: StoragePackage & {
    platformInvoice: PlatformInvoice | null;
    pricePlanVersion: PricePlanVersion & { plan: PricePlan };
  },
): OwnerStoragePackageDto {
  const inv = p.platformInvoice;
  return {
    id: p.id,
    packageId: p.pricePlanVersion.planId,
    name: p.pricePlanVersion.plan.nameTh,
    sizeBytes: p.sizeBytes.toString(),
    price: p.price.toFixed(2),
    currency: 'THB',
    period: p.period as StoragePackagePeriodName,
    state: p.state as StoragePackageStateName,
    startsOn: day(p.startsOn),
    endsOn: day(p.endsOn),
    autoRenew: p.autoRenew,
    renewalOfId: p.renewalOfId,
    invoice: inv
      ? {
          id: inv.id,
          number: inv.number,
          total: inv.total.toFixed(2),
          state: inv.state,
          dueAt: toBangkokIso(inv.dueAt),
          qrAvailable: inv.qrPayload !== null,
        }
      : null,
    createdAt: toBangkokIso(p.createdAt),
  };
}

export const STORED_FILE_EXAMPLE: StoredFileDto = {
  id: '0199f2a0-0000-7000-8000-0000000000aa',
  kind: 'listing_photo' as DocumentKindName,
  title: 'ห้อง 301 มุมนั่งเล่น.jpg',
  mimeType: 'image/jpeg',
  category: 'listing_media' as StorageCategoryName,
  bytes: '1843200',
  objects: 5,
  createdAt: '2026-10-01T10:00:00+07:00',
  deletedAt: null,
  purgeAfter: null,
  held: false,
  retainUntil: null,
  deletable: true,
  notDeletableReason: null,
};

export const OFFER_EXAMPLE: StoragePackageOfferDto = {
  id: '0199f2a0-0000-7000-8000-0000000000bb',
  key: 'storage_plus_20',
  nameTh: 'พื้นที่เพิ่ม 20 GB',
  nameEn: 'Extra 20 GB',
  sizeBytes: '21474836480',
  period: 'month' as StoragePackagePeriodName,
  price: null,
  total: null,
  vatRate: '0.0700',
  currency: 'THB',
  onSale: false,
};

export const OWNER_PACKAGE_EXAMPLE: OwnerStoragePackageDto = {
  id: '0199f2a0-0000-7000-8000-0000000000dd',
  packageId: '0199f2a0-0000-7000-8000-0000000000bb',
  name: 'พื้นที่เพิ่ม 20 GB',
  sizeBytes: '21474836480',
  price: '107.00',
  currency: 'THB',
  period: 'month' as StoragePackagePeriodName,
  state: 'pending_payment' as StoragePackageStateName,
  startsOn: null,
  endsOn: null,
  autoRenew: false,
  renewalOfId: null,
  invoice: {
    id: '0199f2a0-0000-7000-8000-0000000000cc',
    number: 'PIV-2026-00012',
    total: '107.00',
    state: 'issued',
    dueAt: '2026-11-08T10:00:00+07:00',
    qrAvailable: false,
  },
  createdAt: '2026-11-01T10:00:00+07:00',
};

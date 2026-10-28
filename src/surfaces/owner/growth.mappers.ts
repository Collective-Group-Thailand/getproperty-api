import { toBangkokIso } from '@common/time/bangkok';
import { type PlatformInvoice, type PricePlanVersion } from '@generated/prisma/client';
import { type BoostProduct, type BoostRow } from '@modules/platform-subscriptions/boosts.service';
import { boostTermsOf } from '@modules/platform-subscriptions/growth-products';
import {
  type MediaOrderRow,
  type MediaProduct,
} from '@modules/platform-subscriptions/media-services.service';
import Decimal from 'decimal.js';

import {
  type BoostDto,
  type BoostProductDto,
  type BoostStateName,
  type BoostTargetName,
  type GrowthInvoiceDto,
  type MediaServiceKindName,
  type MediaServiceOrderDto,
  type MediaServiceProductDto,
  type MediaServiceStateName,
} from './growth.dto';

const isoOrNull = (d: Date | null) => (d ? toBangkokIso(d) : null);

function prices(version: PricePlanVersion, onSale: boolean, free = false) {
  const vatRate = new Decimal(version.vatRate.toString());
  if (free) return { price: '0.00', total: '0.00', vatRate: vatRate.toFixed(4) };
  if (!onSale || version.unitPrice === null) return { price: null, total: null, vatRate: vatRate.toFixed(4) };
  const net = new Decimal(version.unitPrice.toString()).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const vat = net.times(vatRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { price: net.toFixed(2), total: net.plus(vat).toFixed(2), vatRate: vatRate.toFixed(4) };
}

export function growthInvoiceDto(inv: PlatformInvoice | null): GrowthInvoiceDto | null {
  return inv
    ? {
        id: inv.id,
        number: inv.number,
        total: inv.total.toFixed(2),
        state: inv.state,
        dueAt: toBangkokIso(inv.dueAt),
        qrAvailable: inv.qrPayload !== null,
      }
    : null;
}

export function boostProductDto(p: BoostProduct): BoostProductDto {
  return {
    id: p.plan.id,
    key: p.plan.key,
    nameTh: p.plan.nameTh,
    nameEn: p.plan.nameEn,
    target: p.terms.target as BoostTargetName,
    days: p.terms.days,
    months: p.terms.months,
    ...prices(p.version, p.onSale, p.free),
    currency: p.version.currency,
    onSale: p.onSale,
    free: p.free,
  };
}

export function boostDto(b: BoostRow): BoostDto {
  const terms = boostTermsOf(b.pricePlanVersion.terms);
  return {
    id: b.id,
    productId: b.pricePlanVersion.planId,
    productKey: b.productKey,
    name: b.pricePlanVersion.plan.nameTh,
    target: (b.listingId ? 'listing' : (terms?.target ?? 'building')) as BoostTargetName,
    listingId: b.listingId,
    listingSlug: b.listing?.slug ?? null,
    buildingId: b.buildingId,
    targetName: b.listing?.titleTh ?? b.building?.name ?? '',
    days: b.days,
    months: b.months,
    price: b.price.toFixed(2),
    free: b.free,
    state: b.state as BoostStateName,
    startsAt: isoOrNull(b.startsAt),
    endsAt: isoOrNull(b.endsAt),
    invoice: growthInvoiceDto(b.platformInvoice),
    createdAt: toBangkokIso(b.createdAt),
  };
}

export function mediaProductDto(p: MediaProduct): MediaServiceProductDto {
  return {
    id: p.plan.id,
    key: p.plan.key,
    nameTh: p.plan.nameTh,
    nameEn: p.plan.nameEn,
    service: p.service as MediaServiceKindName,
    ...prices(p.version, p.onSale),
    currency: p.version.currency,
    onSale: p.onSale,
  };
}

export function mediaOrderDto(o: MediaOrderRow): MediaServiceOrderDto {
  return {
    id: o.id,
    service: o.service as MediaServiceKindName,
    name: o.pricePlanVersion.plan.nameTh,
    state: o.state as MediaServiceStateName,
    listingId: o.listingId,
    listingTitle: o.listing?.titleTh ?? null,
    unitId: o.unitId,
    unitNo: o.unit.unitNo,
    price: o.price.toFixed(2),
    note: o.note,
    scheduledFor: isoOrNull(o.scheduledFor),
    deliverableDocumentIds: o.deliverableDocumentIds,
    requestedAt: isoOrNull(o.requestedAt),
    deliveredAt: isoOrNull(o.deliveredAt),
    cancelledAt: isoOrNull(o.cancelledAt),
    cancelReason: o.cancelReason,
    invoice: growthInvoiceDto(o.platformInvoice),
    createdAt: toBangkokIso(o.createdAt),
  };
}

export const BOOST_PRODUCT_EXAMPLE: BoostProductDto = {
  id: '0199f2a0-0000-7000-8000-0000000000e1',
  key: 'boost_listing_7d',
  nameTh: 'โปรโมตประกาศ 7 วัน',
  nameEn: 'Listing boost, 7 days',
  target: 'listing' as BoostTargetName,
  days: 7,
  months: null,
  price: null,
  total: null,
  vatRate: '0.0700',
  currency: 'THB',
  onSale: false,
  free: false,
};

export const BOOST_EXAMPLE: BoostDto = {
  id: '0199f2a0-0000-7000-8000-0000000000e2',
  productId: '0199f2a0-0000-7000-8000-0000000000e1',
  productKey: 'boost_listing_7d',
  name: 'โปรโมตประกาศ 7 วัน',
  target: 'listing' as BoostTargetName,
  listingId: '0199f2a0-0000-7000-8000-0000000000e3',
  listingSlug: 'condo-1br-ari-8f3k2',
  buildingId: null,
  targetName: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
  days: 7,
  months: null,
  price: '535.00',
  free: false,
  state: 'pending_payment' as BoostStateName,
  startsAt: null,
  endsAt: null,
  invoice: {
    id: '0199f2a0-0000-7000-8000-0000000000cc',
    number: 'PIV-2026-00031',
    total: '535.00',
    state: 'issued',
    dueAt: '2026-11-08T10:00:00+07:00',
    qrAvailable: false,
  },
  createdAt: '2026-11-01T10:00:00+07:00',
};

export const MEDIA_PRODUCT_EXAMPLE: MediaServiceProductDto = {
  id: '0199f2a0-0000-7000-8000-0000000000e4',
  key: 'media_verified_photo',
  nameTh: 'บริการถ่ายภาพยืนยันห้องจริง',
  nameEn: 'Verified photo service',
  service: 'verified_photo' as MediaServiceKindName,
  price: null,
  total: null,
  vatRate: '0.0700',
  currency: 'THB',
  onSale: false,
};

export const MEDIA_ORDER_EXAMPLE: MediaServiceOrderDto = {
  id: '0199f2a0-0000-7000-8000-0000000000e5',
  service: 'verified_photo' as MediaServiceKindName,
  name: 'บริการถ่ายภาพยืนยันห้องจริง',
  state: 'pending_payment' as MediaServiceStateName,
  listingId: '0199f2a0-0000-7000-8000-0000000000e3',
  listingTitle: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
  unitId: '0199f2a0-0000-7000-8000-0000000000e6',
  unitNo: 'A-201',
  price: '1605.00',
  note: null,
  scheduledFor: null,
  deliverableDocumentIds: [],
  requestedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  cancelReason: null,
  invoice: {
    id: '0199f2a0-0000-7000-8000-0000000000cd',
    number: 'PIV-2026-00032',
    total: '1605.00',
    state: 'issued',
    dueAt: '2026-11-08T10:00:00+07:00',
    qrAvailable: false,
  },
  createdAt: '2026-11-01T10:00:00+07:00',
};

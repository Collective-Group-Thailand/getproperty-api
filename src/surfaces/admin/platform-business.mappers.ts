import { FAKE } from '@common/openapi/examples';
import { bangkokDate } from '@common/time/bangkok';
import {
  type PilotAgreement,
  type PlatformCreditNote,
  type PricePlanVersion,
  type SiteSurveyRequest,
  type SubscriptionUsage,
} from '@generated/prisma/client';
import {
  type FieldWorkService,
  type InstallItem,
  type InstallOrderRow,
} from '@modules/platform-subscriptions/field-work.service';
import { bookValue, type HaasRow } from '@modules/platform-subscriptions/haas.service';
import { type PlatformInvoiceRow } from '@modules/platform-subscriptions/platform-billing.service';
import { type PlanRow } from '@modules/platform-subscriptions/price-plans.service';
import { type Charges } from '@modules/platform-subscriptions/pricing';
import { type SubscriptionRow } from '@modules/platform-subscriptions/subscriptions.service';
import Decimal from 'decimal.js';

import { iso, isoOrNull } from '../shared/mappers';
import { type TenantTypeName } from '../shared/me.dto';
import {
  type BillingPeriodName,
  type ChargesDto,
  type HaasAssetDto,
  type HaasStateName,
  InstallItemKindName,
  InstallItemStateName,
  type InstallOrderDto,
  type InstallOrderKindName,
  type InstallOrderStateName,
  type PilotAgreementDto,
  type PlanBillingUnitName,
  type PlanKindName,
  type PlanVersionStateName,
  type PlatformCreditNoteDto,
  type PlatformCreditNoteStateName,
  type PlatformInvoiceDto,
  type PlatformInvoiceKindName,
  type PlatformInvoiceStatusName,
  type PlatformLineKindName,
  type PlatformPaymentMethodName,
  type PricePlanDto,
  type PricePlanVersionDto,
  type SiteSurveyDto,
  type SiteSurveyStateName,
  type StaffInstallOrderDto,
  type SubscriptionDto,
  type SubscriptionStatusName,
  type SubscriptionUsageDto,
  type UsageLineDto,
} from './platform-business.dto';

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const money = (v: { toString(): string } | null | undefined) =>
  v == null ? null : new Decimal(v.toString()).toFixed(2);
const dec4 = (v: { toString(): string }) => new Decimal(v.toString()).toFixed(4);
const OPEN = new Set(['trial', 'active', 'past_due', 'suspended']);

export function planVersionDto(v: PricePlanVersion): PricePlanVersionDto {
  return {
    id: v.id,
    version: v.version,
    effectiveFrom: day(v.effectiveFrom)!,
    effectiveTo: day(v.effectiveTo),
    billingUnit: v.billingUnit as PlanBillingUnitName,
    unitPrice: v.unitPrice == null ? null : dec4(v.unitPrice),
    priceRange: (v.priceRange as { from: string; to: string } | null) ?? null,
    tiers: (Array.isArray(v.tiers) ? v.tiers : []) as Record<string, unknown>[],
    minUnits: v.minUnits,
    minMonthly: money(v.minMonthly),
    annualDiscountPct: dec4(v.annualDiscountPct),
    termMonths: v.termMonths,
    setupFee: money(v.setupFee)!,
    includedAllowances: (v.includedAllowances ?? {}) as Record<string, unknown>,
    vatRate: dec4(v.vatRate),
    terms: (v.terms ?? {}) as Record<string, unknown>,
    state: v.state as PlanVersionStateName,
    publishedAt: isoOrNull(v.publishedAt),
    nextActions: v.state === 'draft' ? ['publish'] : [],
  };
}

export function pricePlanDto(p: PlanRow): PricePlanDto {
  return {
    id: p.id,
    key: p.key,
    tenantType: (p.tenantType as TenantTypeName | null) ?? null,
    nameTh: p.nameTh,
    nameEn: p.nameEn,
    kind: p.kind as PlanKindName,
    isActive: p.isActive,
    versions: p.versions.map(planVersionDto),
  };
}

export function subscriptionDto(
  s: SubscriptionRow,
  addons: { key: string; nameTh: string; versionId: string; version: number }[] = [],
): SubscriptionDto {
  const open = OPEN.has(s.state);
  return {
    id: s.id,
    tenantId: s.tenantId,
    tenantName: s.tenant.displayName,
    plan: {
      key: s.planVersion.plan.key,
      nameTh: s.planVersion.plan.nameTh,
      versionId: s.planVersion.id,
      version: s.planVersion.version,
    },
    addons,
    state: s.state as SubscriptionStatusName,
    trialEndsAt: iso(s.trialEndsAt),
    startedAt: iso(s.startedAt),
    activatedAt: isoOrNull(s.activatedAt),
    billingPeriod: s.billingPeriod as BillingPeriodName,
    discountPct: dec4(s.discountPct),
    discountReason: s.discountReason,
    pilotAgreementId: s.pilotAgreementId,
    pastDueSince: isoOrNull(s.pastDueSince),
    suspendedAt: isoOrNull(s.suspendedAt),
    cancelledAt: isoOrNull(s.cancelledAt),
    cancelEffectiveDate: day(s.cancelEffectiveDate),
    cancelReason: s.cancelReason,
    readOnly: s.state === 'suspended' || s.state === 'cancelled',
    nextActions: !open
      ? []
      : [
          'change-plan',
          ...(s.cancelEffectiveDate ? [] : ['cancel']),
          s.state === 'suspended' ? 'reinstate' : 'suspend',
        ],
  };
}

export const SUBSCRIPTION_EXAMPLE: SubscriptionDto = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  tenantName: FAKE.propertyName,
  plan: { key: 'apartment_starter', nameTh: 'Apartment Starter', versionId: FAKE.uuid, version: 1 },
  addons: [],
  state: 'trial' as SubscriptionStatusName,
  trialEndsAt: '2026-11-16T10:00:00+07:00',
  startedAt: FAKE.dateTime,
  activatedAt: null,
  billingPeriod: 'monthly' as BillingPeriodName,
  discountPct: '0.0000',
  discountReason: null,
  pilotAgreementId: null,
  pastDueSince: null,
  suspendedAt: null,
  cancelledAt: null,
  cancelEffectiveDate: null,
  cancelReason: null,
  readOnly: false,
  nextActions: ['change-plan', 'cancel', 'suspend'],
};

const lineDto = (l: {
  kind: string;
  description: string;
  quantity: { toString(): string } | string;
  unitPrice: { toString(): string } | string;
  amount: { toString(): string } | string;
}): UsageLineDto => ({
  kind: l.kind as PlatformLineKindName,
  description: l.description,
  quantity: new Decimal(l.quantity.toString()).toFixed(3),
  unitPrice: dec4(l.unitPrice),
  amount: money(l.amount)!,
});

export function chargesDto(c: Charges): ChargesDto {
  return {
    lines: c.lines.map(lineDto),
    subtotal: money(c.subtotal)!,
    discount: money(c.discount)!,
    vatAmount: money(c.vatAmount)!,
    total: money(c.total)!,
  };
}

export function usageDto(u: SubscriptionUsage): SubscriptionUsageDto {
  return {
    month: day(u.month)!,
    unitsCounted: u.unitsCounted,
    meterPointsCounted: u.meterPointsCounted,
    ocrImages: u.ocrImages,
    unitsByBuilding: (u.unitsByBuilding ?? {}) as Record<string, number>,
    amountComputed: money(u.amountComputed)!,
    lines: ((u.lines ?? []) as unknown as Parameters<typeof lineDto>[0][]).map(lineDto),
  };
}

export function creditNoteDto(n: PlatformCreditNote): PlatformCreditNoteDto {
  return {
    id: n.id,
    invoiceId: n.invoiceId,
    state: n.state as PlatformCreditNoteStateName,
    number: n.number,
    amount: money(n.amount)!,
    reason: n.reason,
    requestedBy: n.requestedBy,
    approvedBy: n.approvedBy,
    issuedAt: isoOrNull(n.issuedAt),
    nextActions: n.state === 'requested' ? ['approve', 'reject'] : [],
  };
}

export function platformInvoiceDto(
  i: PlatformInvoiceRow,
  surface: 'admin' | 'owner' = 'admin',
): PlatformInvoiceDto {
  const open = new Decimal(i.total.toString())
    .minus(i.paidTotal.toString())
    .minus(i.creditedTotal.toString());
  const receipts = new Map(i.receipts.map((r) => [r.paymentId, r]));
  const isOpen = ['issued', 'partially_paid', 'overdue'].includes(i.state);
  return {
    id: i.id,
    tenantId: i.tenantId,
    tenantName: i.tenant.displayName,
    subscriptionId: i.subscriptionId,
    number: i.number,
    kind: i.kind as PlatformInvoiceKindName,
    periodStart: day(i.periodStart)!,
    periodEnd: day(i.periodEnd)!,
    issuedAt: iso(i.issuedAt),
    dueAt: iso(i.dueAt),
    subtotal: money(i.subtotal)!,
    discount: money(i.discount)!,
    vatAmount: money(i.vatAmount)!,
    total: money(i.total)!,
    paidTotal: money(i.paidTotal)!,
    creditedTotal: money(i.creditedTotal)!,
    openAmount: Decimal.max(open, 0).toFixed(2),
    state: i.state as PlatformInvoiceStatusName,
    overdueSince: isoOrNull(i.overdueSince),
    qr:
      i.qrPayload && isOpen
        ? { payload: i.qrPayload, reference: i.qrReference ?? i.number, expiresAt: isoOrNull(i.qrExpiresAt) }
        : null,
    documentId: i.documentId,
    lines: i.lines.map((l) => ({ ...lineDto(l), lineNo: l.lineNo })),
    payments: i.payments.map((p) => {
      const r = receipts.get(p.id);
      return {
        id: p.id,
        amount: money(p.amount)!,
        method: p.method as PlatformPaymentMethodName,
        provider: p.provider,
        providerRef: p.providerRef,
        paidAt: iso(p.paidAt),
        receiptNumber: r?.number ?? null,
        receiptDocumentId: r?.documentId ?? null,
      };
    }),
    creditNotes: i.creditNotes.map(creditNoteDto),
    nextActions:
      surface === 'owner'
        ? isOpen && i.qrPayload
          ? ['pay-qr']
          : []
        : [
            ...(isOpen ? ['record-payment'] : []),
            ...(['void', 'credited'].includes(i.state) ? [] : ['request-credit-note']),
          ],
  };
}

export const PLATFORM_INVOICE_EXAMPLE: PlatformInvoiceDto = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  tenantName: FAKE.propertyName,
  subscriptionId: FAKE.uuid,
  number: 'PIV-2026-00001',
  kind: 'monthly' as PlatformInvoiceKindName,
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  issuedAt: '2026-11-01T00:05:00+07:00',
  dueAt: '2026-11-16T00:05:00+07:00',
  subtotal: '500.00',
  discount: '0.00',
  vatAmount: '35.00',
  total: '535.00',
  paidTotal: '0.00',
  creditedTotal: '0.00',
  openAmount: '535.00',
  state: 'issued' as PlatformInvoiceStatusName,
  overdueSince: null,
  qr: {
    payload: '00020101021230570016A000000677010112...6304ABCD',
    reference: 'PIV202600001',
    expiresAt: null,
  },
  documentId: FAKE.uuid,
  lines: [
    {
      lineNo: 1,
      kind: 'subscription' as PlatformLineKindName,
      description: 'Apartment Starter — 20 ห้อง (ขั้นต่ำ 20)',
      quantity: '20.000',
      unitPrice: '25.0000',
      amount: '500.00',
    },
  ],
  payments: [],
  creditNotes: [],
  nextActions: ['record-payment', 'request-credit-note'],
};

export function pilotDto(p: PilotAgreement): PilotAgreementDto {
  return {
    id: p.id,
    tenantId: p.tenantId,
    signedOn: day(p.signedAt)!,
    discountPct: dec4(p.discountPct),
    termMonths: p.termMonths,
    referenceSiteRights: p.referenceSiteRights,
    anonymisedDataUse: p.anonymisedDataUse,
    feedbackCadence: p.feedbackCadence,
    kpiReviewOn: day(p.kpiReviewAt)!,
    kpiTargets: (p.kpiTargets ?? {}) as Record<string, unknown>,
    baseline: (p.baseline ?? {}) as Record<string, unknown>,
    agreementDocumentId: p.agreementDocumentId,
    notes: p.notes,
  };
}

const HAAS_NEXT: Record<string, string[]> = {
  allocated: ['install', 'write-off'],
  installed: ['in-service', 'replace', 'deinstall', 'write-off'],
  in_service: ['replace', 'deinstall', 'write-off'],
};

export function haasDto(a: HaasRow, today: string): HaasAssetDto {
  return {
    id: a.id,
    deviceId: a.deviceId,
    serial: a.device.serial,
    kind: a.kind,
    tenantId: a.tenantId,
    buildingId: a.buildingId,
    state: a.state as HaasStateName,
    installedOn: day(a.installedAt),
    termMonths: a.termMonths,
    termEnd: day(a.termEnd),
    monthlyValue: money(a.monthlyValue)!,
    acquisitionCost: money(a.acquisitionCost)!,
    bookValue: bookValue(a, today),
    replacedByAssetId: a.replacedByAssetId,
    deinstallOrderId: a.deinstallOrderId,
    events: a.events.map((e) => ({
      type: e.type,
      occurredAt: iso(e.occurredAt),
      data: (e.data ?? {}) as Record<string, unknown>,
    })),
    nextActions: HAAS_NEXT[a.state] ?? [],
  };
}

const ORDER_ACTIONS: Record<string, string[]> = {
  open: ['assign', 'start', 'complete-items', 'complete', 'cancel'],
  in_progress: ['assign', 'complete-items', 'complete', 'cancel'],
};

export function installOrderDto(o: InstallOrderRow): InstallOrderDto {
  return {
    id: o.id,
    tenantId: o.tenantId,
    buildingId: o.buildingId,
    buildingName: o.building.name,
    kind: o.kind as InstallOrderKindName,
    state: o.state as InstallOrderStateName,
    assignedTo: o.assignedTo,
    dueAt: isoOrNull(o.dueAt),
    items: (o.items as unknown as InstallItem[]).map((i) => ({
      unitId: i.unitId,
      assetItemId: i.assetItemId,
      deviceKind: i.deviceKind,
      deviceId: i.deviceId,
      done: i.done,
    })),
    notes: o.notes,
    completedAt: isoOrNull(o.completedAt),
    nextActions: ORDER_ACTIONS[o.state] ?? [],
  };
}

export function staffInstallOrders(
  r: Awaited<ReturnType<FieldWorkService['forStaff']>>,
): StaffInstallOrderDto[] {
  return r.orders.map((o) => {
    const groups = new Map<string | null, InstallItem[]>();
    for (const i of o.items as unknown as InstallItem[])
      groups.set(i.unitId, [...(groups.get(i.unitId) ?? []), i]);
    return {
      id: o.id,
      kind: o.kind as InstallOrderKindName,
      state: o.state as InstallOrderStateName,
      buildingId: o.buildingId,
      dueAt: isoOrNull(o.dueAt),
      units: [...groups.entries()].map(([unitId, items]) => ({
        unitId,
        unitNo: unitId ? (r.units.get(unitId) ?? null) : null,
        items: items.map((i) => ({
          kind: i.deviceKind === 'gateway' ? InstallItemKindName.Gateway : InstallItemKindName.MeterDevice,
          deviceKind: i.deviceKind,
          assetItemId: i.assetItemId,
          deviceId: i.deviceId,
          state: i.done ? InstallItemStateName.Done : InstallItemStateName.Open,
        })),
      })),
    };
  });
}

export function siteSurveyDto(s: SiteSurveyRequest): SiteSurveyDto {
  return {
    id: s.id,
    tenantId: s.tenantId,
    buildingId: s.buildingId,
    targetPlanKey: s.targetPlanKey,
    state: s.state as SiteSurveyStateName,
    scheduledFor: isoOrNull(s.scheduledFor),
    assignedTo: s.assignedTo,
    findings: (s.findings ?? {}) as Record<string, unknown>,
    notes: s.notes,
    installOrderId: s.installOrderId,
    createdAt: iso(s.createdAt),
  };
}

export const todayOf = (now: Date) => bangkokDate(now);

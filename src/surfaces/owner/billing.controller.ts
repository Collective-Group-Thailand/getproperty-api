import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiCompliance,
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { bangkokDate, toBangkokIso } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import {
  BillingCyclesService,
  cycleNextActions,
  type CycleRow,
} from '@modules/ops-billing/billing-cycles.service';
import { type MeterSegment, type SegmentReading, segmentUnits } from '@modules/ops-billing/engine/readings';
import { type InvoiceRow, InvoicesService } from '@modules/ops-billing/invoices.service';
import { type RatePlanRow, RatePlansService } from '@modules/ops-billing/rate-plans.service';
import { ResidentInvoicesService } from '@modules/ops-billing/resident-invoices.service';
import { ReadingRequestsService } from '@modules/smart-readings/reading-requests.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import {
  type BillingCycleStatusName,
  type EstimatePolicyName,
  type InvoiceChargeStatusName,
  type InvoiceLineKindName,
  type InvoiceLineSourceTypeName,
  type InvoiceStatusName,
  type NoteReasonName,
  type RateBasisName,
  type RatePlanKindName,
} from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';
import { ifMatchVersion } from './assets.mappers';
import {
  BillingCycleDetailDto,
  BillingCycleDto,
  BillingCycleIssueResultDto,
  BillingCycleListQuery,
  BillingCycleOpenDto,
  InvoiceChargeCancelDto,
  InvoiceChargeCreateDto,
  InvoiceChargeDto,
  InvoiceChargeListQuery,
  InvoiceDto,
  type InvoiceLineDto,
  InvoiceListQuery,
  InvoiceSummaryDto,
  InvoiceVoidDto,
  InvoiceVoidResultDto,
  IssueDto,
  type MeterSegmentDto,
  NoteCreateDto,
  type NoteDto,
  RatePlanCreateDto,
  RatePlanDto,
  RatePlanListQuery,
  RatePlanUpdateDto,
  RatePlanVersionCreateDto,
  ReadingRequestCreateDto,
  ReadingRequestsDto,
  type ReadingRequestStatusName,
  ResidentInvoiceDto,
  ResidentInvoiceListQuery,
} from './billing.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', 'asset.read_only', ...T] as const;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const m2 = (d: { toFixed(n: number): string }) => d.toFixed(2);

// ------------------------------------------------------------------------------------------- mappers

export function ratePlanDto(p: RatePlanRow, today: string): RatePlanDto {
  return {
    id: p.id,
    buildingId: p.buildingId,
    kind: p.kind as RatePlanKindName,
    name: p.name,
    isDefault: p.isDefault,
    versions: p.versions.map((v) => ({
      id: v.id,
      effectiveFrom: day(v.effectiveFrom)!,
      effectiveTo: day(v.effectiveTo),
      basis: v.basis as RateBasisName,
      tiers: v.tiers as Record<string, unknown>,
      minimumCharge: v.minimumCharge ? m2(v.minimumCharge) : null,
      aboveCap: v.aboveCap,
      capCheck: (v.capCheck as Record<string, unknown> | null) ?? null,
      complianceAcknowledgementId: v.complianceAcknowledgementId,
      note: v.note,
      inForce: day(v.effectiveFrom)! <= today && (!v.effectiveTo || day(v.effectiveTo)! >= today),
    })),
    version: p.version,
  };
}

type InvoiceLike = Omit<InvoiceRow, 'lines' | 'creditNotes' | 'debitNotes'> &
  Partial<Pick<InvoiceRow, 'lines' | 'creditNotes' | 'debitNotes'>>;

export function invoiceSummaryDto(i: InvoiceLike): InvoiceSummaryDto {
  return {
    id: i.id,
    number: i.number,
    status: i.status as InvoiceStatusName,
    buildingId: i.buildingId,
    unitId: i.unitId,
    unitNo: i.unit?.unitNo ?? null,
    billedPartyId: i.billedPartyId,
    billedPartyName: i.billedParty.displayName,
    leaseId: i.leaseId,
    leaseNumber: i.lease?.number ?? null,
    billingCycleId: i.billingCycleId,
    isFinal: i.isFinal,
    periodStart: day(i.periodStart)!,
    periodEnd: day(i.periodEnd)!,
    issuedAt: isoOrNull(i.issuedAt),
    dueDate: day(i.dueDate),
    subtotal: m2(i.subtotal),
    vatAmount: m2(i.vatAmount),
    total: m2(i.total),
    priorBalance: m2(i.priorBalanceCarried),
    amountDue: i.total.plus(i.priorBalanceCarried).toFixed(2),
    paidTotal: m2(i.paidTotal),
    creditedTotal: m2(i.creditedTotal),
    debitedTotal: m2(i.debitedTotal),
    balance: m2(i.balance),
    hasEstimate: i.hasEstimate,
    hasAboveCapLine: i.hasAboveCapLine,
    reviewFlags: i.reviewFlags,
    complianceFlags: i.complianceFlags,
    version: i.version,
  };
}

/** What the owner may do next with an invoice (D-040: void before any payment, notes after issue). */
export function invoiceNextActions(i: Pick<InvoiceRow, 'status' | 'reviewFlags' | 'paidTotal'>): string[] {
  switch (i.status) {
    case 'draft':
      // an above-cap line waiting for the acknowledgement does not stop the issue (the issue asks for it)
      return i.reviewFlags.some((f) => !f.startsWith('acknowledgement_required'))
        ? ['recompute']
        : ['issue', 'recompute'];
    case 'void':
      return [];
    default:
      return [...(i.paidTotal.isZero() ? ['void'] : []), 'credit_note', 'debit_note'];
  }
}

function lineDto(l: InvoiceRow['lines'][number]): InvoiceLineDto {
  return {
    id: l.id,
    lineNo: l.lineNo,
    sourceType: l.sourceType as InvoiceLineSourceTypeName,
    lineKind: l.lineKind as InvoiceLineKindName,
    description: l.description,
    quantity: l.quantity.toFixed(3),
    unit: l.unit,
    unitPrice: l.unitPrice?.toFixed(4) ?? null,
    amount: m2(l.amount),
    periodFrom: day(l.periodFrom),
    periodTo: day(l.periodTo),
    registerFrom: l.registerFrom?.toFixed(3) ?? null,
    registerTo: l.registerTo?.toFixed(3) ?? null,
    units: l.units?.toFixed(3) ?? null,
    readingSource: l.readingSource,
    isEstimated: l.isEstimated,
    meterSegments: ((l.meterSegments ?? []) as unknown as MeterSegment[]).map((s): MeterSegmentDto => ({
      meterAssignmentId: s.assignmentId,
      code: s.code,
      from: segmentEnd(s.from),
      to: s.to ? segmentEnd(s.to) : null,
      units: segmentUnits(s)?.toFixed(3) ?? null,
    })),
    capPerUnit: l.capPerUnit?.toFixed(4) ?? null,
    aboveCap: l.aboveCap,
    complianceAcknowledgementId: l.complianceAcknowledgementId,
    ratePlanVersionId: l.ratePlanVersionId,
    utilityTariffVersionId: l.utilityTariffVersionId,
    proRata: (l.proRata as Record<string, unknown> | null) ?? null,
    tierBreakdown: (l.tierBreakdown as Record<string, unknown>[] | null) ?? null,
    vatApplicable: l.vatApplicable,
  };
}

function segmentEnd(r: SegmentReading) {
  return {
    readingId: r.readingId,
    register: r.register,
    readAt: segmentAt(r.readAt),
    source: r.source,
    photoDocumentId: r.evidenceDocumentId ?? null,
  };
}

/** Segment instants are stored as ISO strings; the wire shows them in Asia/Bangkok (contract §3). */
function segmentAt(v: string | Date): string {
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? String(v) : toBangkokIso(d);
}

function noteDto(n: InvoiceRow['creditNotes'][number] | InvoiceRow['debitNotes'][number]): NoteDto {
  return {
    id: n.id,
    number: n.number,
    reason: n.reason as NoteReasonName,
    reasonText: n.reasonText,
    subtotal: m2(n.subtotal),
    vatAmount: m2(n.vatAmount),
    total: m2(n.total),
    issuedAt: iso(n.issuedAt),
    lines: n.lines.map((l) => ({
      lineNo: l.lineNo,
      lineKind: l.lineKind as InvoiceLineKindName,
      description: l.description,
      amount: m2(l.amount),
      refInvoiceLineId: l.refInvoiceLineId,
    })),
  };
}

export function invoiceDto(i: InvoiceRow, extras: { qrPayload?: string | null } = {}): InvoiceDto {
  return {
    ...invoiceSummaryDto(i),
    lines: i.lines.map(lineDto),
    creditNotes: i.creditNotes.map(noteDto),
    debitNotes: i.debitNotes.map(noteDto),
    voidedAt: isoOrNull(i.voidedAt),
    voidReason: i.voidReason,
    replacesInvoiceId: i.replacesInvoiceId,
    replacedByInvoiceId: i.replacedByInvoiceId,
    promptpayRef: i.promptpayRef,
    qrPayload: extras.qrPayload ?? null,
    snapshotSha256: i.snapshotSha256 ? Buffer.from(i.snapshotSha256).toString('hex') : null,
    nextActions: invoiceNextActions(i),
  };
}

function cycleDto(c: Omit<CycleRow, 'invoices'>): BillingCycleDto {
  return {
    id: c.id,
    propertyId: c.propertyId,
    propertyName: c.property.name,
    periodKey: c.periodKey,
    periodStart: day(c.periodStart)!,
    periodEnd: day(c.periodEnd)!,
    cutOffAt: iso(c.cutOffAt),
    status: c.status as BillingCycleStatusName,
    readingsWindowMinutes: c.readingsWindowMinutes,
    graceDeadlineAt: iso(c.graceDeadlineAt),
    estimatePolicy: c.estimatePolicy as EstimatePolicyName,
    readingsRequestedAt: isoOrNull(c.readingsRequestedAt),
    computedAt: isoOrNull(c.computedAt),
    issuedAt: isoOrNull(c.issuedAt),
    closedAt: isoOrNull(c.closedAt),
    autoIssueAt: isoOrNull(c.autoIssueAt),
    stats: (c.stats as Record<string, unknown>) ?? {},
    nextActions: cycleNextActions(c),
    version: c.version,
  };
}

function cycleDetailDto(c: CycleRow): BillingCycleDetailDto {
  return { ...cycleDto(c), invoices: c.invoices.map(invoiceSummaryDto) };
}

function chargeDto(c: {
  id: string;
  unitId: string;
  partyId: string;
  leaseId: string | null;
  lineKind: string;
  description: string;
  quantity: { toFixed(n: number): string };
  unitPrice: { toFixed(n: number): string };
  amount: { toFixed(n: number): string };
  status: string;
  appliedInvoiceLineId: string | null;
  createdAt: Date;
}): InvoiceChargeDto {
  return {
    id: c.id,
    unitId: c.unitId,
    partyId: c.partyId,
    leaseId: c.leaseId,
    lineKind: c.lineKind as InvoiceLineKindName,
    description: c.description,
    quantity: c.quantity.toFixed(3),
    unitPrice: c.unitPrice.toFixed(4),
    amount: c.amount.toFixed(2),
    status: c.status as InvoiceChargeStatusName,
    appliedInvoiceLineId: c.appliedInvoiceLineId,
    createdAt: iso(c.createdAt),
  };
}

/** What the resident view adds to the row (LIFF #15, #19): signed photo links and the receipts of the invoice. */
export interface ResidentInvoiceExtras {
  /** evidence document id → 5-minute link */
  photoUrls: ReadonlyMap<string, string>;
  receipts: { id: string; number: string }[];
}

/** The closing reading of a meter line: its time and evidence photo (the last segment's closing end). */
export function closingReadingOf(l: Pick<InvoiceRow['lines'][number], 'meterSegments'>) {
  const segments = (l.meterSegments ?? []) as unknown as MeterSegment[];
  const last = [...segments].reverse().find((s) => s.to);
  return last?.to ? { readAt: last.to.readAt, evidenceDocumentId: last.to.evidenceDocumentId ?? null } : null;
}

/** The resident view of an issued invoice, from its issue snapshot (§4.2.3) plus the live balance and status. */
export function residentInvoiceDto(
  i: InvoiceRow,
  extras: ResidentInvoiceExtras = { photoUrls: new Map(), receipts: [] },
): ResidentInvoiceDto {
  const snap = (i.snapshot ?? {}) as {
    tenant?: { displayName?: string; legalName?: string };
    unit?: { unitNo?: string } | null;
    priorBalance?: { amount?: string };
    totals?: { total?: string; amountDue?: string };
    lines?: {
      lineNo: number;
      lineKind: string;
      description: string;
      quantity: string;
      unit: string | null;
      unitPrice: string | null;
      amount: string;
      periodFrom: string | null;
      periodTo: string | null;
    }[];
  };
  const live = new Map(i.lines.map((l) => [l.lineNo, l]));
  return {
    id: i.id,
    number: i.number!,
    status: i.status as InvoiceStatusName,
    issuerName: snap.tenant?.displayName ?? snap.tenant?.legalName ?? '',
    unitNo: snap.unit?.unitNo ?? i.unit?.unitNo ?? null,
    unitId: i.unitId,
    periodStart: day(i.periodStart)!,
    periodEnd: day(i.periodEnd)!,
    issuedAt: iso(i.issuedAt!),
    dueDate: day(i.dueDate)!,
    isFinal: i.isFinal,
    receipts: extras.receipts,
    lines: (snap.lines ?? []).map((l) => {
      const m = live.get(l.lineNo);
      const closing = m ? closingReadingOf(m) : null;
      return {
        lineNo: l.lineNo,
        lineKind: l.lineKind as InvoiceLineKindName,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        amount: l.amount,
        periodFrom: l.periodFrom,
        periodTo: l.periodTo,
        registerFrom: m?.registerFrom?.toFixed(3) ?? null,
        registerTo: m?.registerTo?.toFixed(3) ?? null,
        readingSource: m?.readingSource ?? null,
        isEstimated: m?.isEstimated ?? false,
        sourceType: (m?.sourceType ?? 'adjustment') as InvoiceLineSourceTypeName,
        readAt: closing ? segmentAt(closing.readAt) : null,
        readingPhotoUrl: closing?.evidenceDocumentId
          ? (extras.photoUrls.get(closing.evidenceDocumentId) ?? null)
          : null,
        units: m?.units?.toFixed(3) ?? null,
        aboveCap: m?.aboveCap ?? false,
      };
    }),
    total: snap.totals?.total ?? m2(i.total),
    priorBalance: snap.priorBalance?.amount ?? m2(i.priorBalanceCarried),
    amountDue: snap.totals?.amountDue ?? i.total.plus(i.priorBalanceCarried).toFixed(2),
    balance: m2(i.balance),
    hasEstimate: i.hasEstimate,
  };
}

// ------------------------------------------------------------------------------------------- examples

const VERSION_EXAMPLE = {
  id: FAKE.uuid,
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  basis: 'per_unit' as RateBasisName,
  tiers: { kind: 'flat', unit: 'kwh', pricePerUnit: '7.0000' },
  minimumCharge: null,
  aboveCap: true,
  capCheck: {
    utilityTariffVersionId: FAKE.uuid,
    provider: 'mea',
    tariffCode: '1.1.1',
    representativeUnits: '150.000',
    effectiveAverageRate: '3.2169',
    tenantRate: '7.0000',
    aboveCap: true,
  },
  complianceAcknowledgementId: FAKE.uuid,
  note: null,
  inForce: true,
};
const RATE_PLAN_EXAMPLE: RatePlanDto = {
  id: FAKE.uuid,
  buildingId: FAKE.uuid,
  kind: 'power' as RatePlanKindName,
  name: 'ค่าไฟห้องพัก',
  isDefault: true,
  versions: [VERSION_EXAMPLE],
  version: 1,
};

const SUMMARY_EXAMPLE: InvoiceSummaryDto = {
  id: FAKE.uuid,
  number: 'INV-2026-00042',
  status: 'issued' as InvoiceStatusName,
  buildingId: FAKE.uuid,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  billedPartyId: FAKE.uuid,
  billedPartyName: FAKE.nameTh,
  leaseId: FAKE.uuid,
  leaseNumber: 'CTR-2026-00001',
  billingCycleId: FAKE.uuid,
  isFinal: false,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  issuedAt: '2026-11-01T09:00:00+07:00',
  dueDate: '2026-11-05',
  subtotal: '5344.00',
  vatAmount: '0.00',
  total: '5344.00',
  priorBalance: '0.00',
  amountDue: '5344.00',
  paidTotal: '0.00',
  creditedTotal: '0.00',
  debitedTotal: '0.00',
  balance: '5344.00',
  hasEstimate: false,
  hasAboveCapLine: true,
  reviewFlags: [],
  complianceFlags: ['tariff_cap_acknowledged'],
  version: 2,
};
const LINE_EXAMPLE: InvoiceLineDto = {
  id: FAKE.uuid,
  lineNo: 2,
  sourceType: 'meter' as InvoiceLineSourceTypeName,
  lineKind: 'electricity' as InvoiceLineKindName,
  description: 'ค่าไฟฟ้า 120 หน่วย × 7.0000',
  quantity: '120.000',
  unit: 'kwh',
  unitPrice: '7.0000',
  amount: '840.00',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  registerFrom: '1114.500',
  registerTo: '1234.500',
  units: '120.000',
  readingSource: 'iot',
  isEstimated: false,
  meterSegments: [
    {
      meterAssignmentId: FAKE.uuid,
      code: 'A-101-E',
      from: {
        readingId: FAKE.uuid,
        register: '1114.500',
        readAt: '2026-09-30T23:59:00+07:00',
        source: 'iot',
        photoDocumentId: null,
      },
      to: {
        readingId: FAKE.uuid,
        register: '1234.500',
        readAt: '2026-10-31T23:59:00+07:00',
        source: 'ocr',
        photoDocumentId: FAKE.uuid,
      },
      units: '120.000',
    },
  ],
  capPerUnit: '3.9900',
  aboveCap: true,
  complianceAcknowledgementId: FAKE.uuid,
  ratePlanVersionId: FAKE.uuid,
  utilityTariffVersionId: FAKE.uuid,
  proRata: null,
  tierBreakdown: null,
  vatApplicable: false,
};
const INVOICE_EXAMPLE: InvoiceDto = {
  ...SUMMARY_EXAMPLE,
  lines: [LINE_EXAMPLE],
  creditNotes: [],
  debitNotes: [],
  voidedAt: null,
  voidReason: null,
  replacesInvoiceId: null,
  replacedByInvoiceId: null,
  promptpayRef: 'INV202600042',
  qrPayload: '00020101021230...6304ABCD',
  snapshotSha256: 'a3f1c2…',
  nextActions: ['void', 'credit_note', 'debit_note'],
};
const DRAFT_EXAMPLE: InvoiceDto = {
  ...INVOICE_EXAMPLE,
  number: null,
  status: 'draft' as InvoiceStatusName,
  issuedAt: null,
  dueDate: null,
  promptpayRef: null,
  qrPayload: null,
  snapshotSha256: null,
  nextActions: ['issue', 'recompute'],
};
const CYCLE_EXAMPLE: BillingCycleDto = {
  id: FAKE.uuid,
  propertyId: FAKE.uuid,
  propertyName: 'อาคารสุขใจ',
  periodKey: '2026-10',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  cutOffAt: '2026-10-31T23:59:00+07:00',
  status: 'computed' as BillingCycleStatusName,
  readingsWindowMinutes: 60,
  graceDeadlineAt: '2026-11-01T23:59:00+07:00',
  estimatePolicy: 'block' as EstimatePolicyName,
  readingsRequestedAt: null,
  computedAt: '2026-11-01T00:15:00+07:00',
  issuedAt: null,
  closedAt: null,
  autoIssueAt: null,
  stats: { billables: 11, drafts: 11, needsReview: 0, issued: 0, total: '58784.00', flags: {} },
  nextActions: ['compute', 'issue'],
  version: 3,
};
const CYCLE_DETAIL_EXAMPLE: BillingCycleDetailDto = {
  ...CYCLE_EXAMPLE,
  invoices: [{ ...SUMMARY_EXAMPLE, number: null, status: 'draft' as InvoiceStatusName, issuedAt: null }],
};
const CHARGE_EXAMPLE: InvoiceChargeDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  partyId: FAKE.uuid,
  leaseId: FAKE.uuid,
  lineKind: 'one_off' as InvoiceLineKindName,
  description: 'ค่าทำกุญแจสำรอง',
  quantity: '1.000',
  unitPrice: '150.0000',
  amount: '150.00',
  status: 'pending' as InvoiceChargeStatusName,
  appliedInvoiceLineId: null,
  createdAt: FAKE.dateTime,
};
const RESIDENT_INVOICE_EXAMPLE: ResidentInvoiceDto = {
  id: FAKE.uuid,
  number: 'INV-2026-00042',
  status: 'issued' as InvoiceStatusName,
  issuerName: 'หอพักสุขใจ',
  unitNo: FAKE.unitCode,
  unitId: FAKE.uuid,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  issuedAt: '2026-11-01T09:00:00+07:00',
  dueDate: '2026-11-05',
  isFinal: false,
  receipts: [],
  lines: [
    {
      lineNo: 1,
      lineKind: 'rent' as InvoiceLineKindName,
      description: 'ค่าเช่าห้อง ต.ค. 2569',
      quantity: '1.000',
      unit: null,
      unitPrice: '4500.0000',
      amount: '4500.00',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-31',
      registerFrom: null,
      registerTo: null,
      readingSource: null,
      isEstimated: false,
      sourceType: 'rent' as InvoiceLineSourceTypeName,
      readAt: null,
      readingPhotoUrl: null,
      units: null,
      aboveCap: false,
    },
    {
      lineNo: 2,
      lineKind: 'electricity' as InvoiceLineKindName,
      description: 'ค่าไฟฟ้า 120 หน่วย × 7.0000',
      quantity: '120.000',
      unit: 'kwh',
      unitPrice: '7.0000',
      amount: '840.00',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-31',
      registerFrom: '1114.500',
      registerTo: '1234.500',
      readingSource: 'ocr',
      isEstimated: false,
      sourceType: 'meter' as InvoiceLineSourceTypeName,
      readAt: '2026-10-31T18:05:00+07:00',
      readingPhotoUrl: 'https://storage.example.com/meter-photo?X-Amz-Signature=abc',
      units: '120.000',
      aboveCap: false,
    },
  ],
  total: '5344.00',
  priorBalance: '0.00',
  amountDue: '5344.00',
  balance: '5344.00',
  hasEstimate: false,
};

// ------------------------------------------------------------------------------------------- rate plans

@ApiTags('owner.billing')
@ApiSurface(SURFACES.owner)
@Controller('owner/rate-plans')
export class OwnerRatePlansController {
  constructor(
    private readonly plans: RatePlansService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private today(): string {
    return bangkokDate(this.clock.now());
  }

  @Get()
  @TenantScoped()
  @Can('rate_plan.read')
  @ApiEndpoint({
    id: 'owner.ratePlans.list',
    summary: 'Rate plans',
    description:
      'My tariffs per kind (power, water, common fee, fund, rent, service) with their effective-dated versions and the cap check of each (D-021a, D-151).',
    implements: ['D-021a', 'D-151'],
  })
  @ApiSuccess(200, { description: 'Plans', type: [RatePlanDto], example: [RATE_PLAN_EXAMPLE] })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: RatePlanListQuery): Promise<RatePlanDto[]> {
    const rows = await this.plans.list(ctx, { kind: q.kind, buildingId: q.buildingId });
    return rows.map((p) => ratePlanDto(p, this.today()));
  }

  @Post()
  @TenantScoped()
  @Can('rate_plan.manage')
  @ApiEndpoint({
    id: 'owner.ratePlans.create',
    summary: 'Create a rate plan',
    description:
      'A plan for a building (or tenant-wide) and kind; `isDefault` makes it the plan leases without their own use (D-151). Add a version to give it prices.',
    implements: ['D-151'],
  })
  @ApiJsonBody(RatePlanCreateDto, {
    buildingId: FAKE.uuid,
    kind: 'power',
    name: 'ค่าไฟห้องพัก',
    isDefault: true,
  })
  @ApiSuccess(201, {
    description: 'Created',
    type: RatePlanDto,
    example: { ...RATE_PLAN_EXAMPLE, versions: [] },
  })
  @ApiStandardErrors(...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: RatePlanCreateDto): Promise<RatePlanDto> {
    return ratePlanDto(
      await this.plans.create(ctx, {
        buildingId: body.buildingId ?? null,
        kind: body.kind,
        name: body.name,
        isDefault: body.isDefault ?? false,
      }),
      this.today(),
    );
  }

  @Get(':ratePlanId')
  @TenantScoped()
  @Can('rate_plan.read')
  @UseEtag((p: RatePlanDto) => etagOf(p.id, p.version))
  @ApiEndpoint({
    id: 'owner.ratePlans.get',
    summary: 'One rate plan',
    description: 'The plan with every version and its cap check (D-021a).',
    implements: ['D-021a'],
  })
  @ApiSuccess(200, { description: 'The plan', type: RatePlanDto, example: RATE_PLAN_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('ratePlanId', ParseUUIDPipe) id: string,
  ): Promise<RatePlanDto> {
    return ratePlanDto(await this.plans.get(ctx, id), this.today());
  }

  @Patch(':ratePlanId')
  @TenantScoped()
  @Can('rate_plan.manage')
  @UseEtag((p: RatePlanDto) => etagOf(p.id, p.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.ratePlans.update',
    summary: 'Rename a plan or make it the default',
    description: 'Prices change only through a new version (D-021a). Requires `If-Match`.',
    implements: ['D-021a', 'D-151'],
  })
  @ApiJsonBody(RatePlanUpdateDto, { name: 'ค่าไฟห้องพัก (ใหม่)' })
  @ApiSuccess(200, { description: 'Updated', type: RatePlanDto, example: RATE_PLAN_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('ratePlanId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: RatePlanUpdateDto,
  ): Promise<RatePlanDto> {
    const version = ifMatchVersion(ifMatch, await this.plans.get(ctx, id));
    return ratePlanDto(await this.plans.update(ctx, id, version, body), this.today());
  }

  @Delete(':ratePlanId')
  @HttpCode(204)
  @TenantScoped()
  @Can('rate_plan.manage')
  @ApiEndpoint({
    id: 'owner.ratePlans.remove',
    summary: 'Delete an unused rate plan',
    description: 'Refused while a lease or an invoice uses it (`rate_plan.in_use`); soft delete, audited.',
    implements: ['D-151'],
  })
  @ApiSuccess(204, { description: 'Removed' })
  @ApiStandardErrors('rate_plan.in_use', ...WRITE)
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('ratePlanId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.plans.remove(ctx, id);
  }

  @Post(':ratePlanId/versions')
  @TenantScoped()
  @Can('rate_plan.manage')
  @ApiEndpoint({
    id: 'owner.ratePlans.saveVersion',
    summary: 'Set prices from a date',
    description:
      'A new version effective today or later (never backdated: `rate_plan.backdated`; a version already in force is immutable: `rate_plan.version_in_force`); a future version with the same date is replaced. Power/water prices are compared with the utility’s effective average rate at the representative consumption (`compliance.tariff_cap.representative_units`): above → 409 `compliance.acknowledgement_required` → acknowledge → repeat with `acknowledgementIds` (D-021a), refused where the platform admin set `block`. A water minimum above the utility minimum is refused (`compliance.water_minimum`, D-141). Leases keep the price agreed at signing when a later version charges more (`compliance.no_midterm_increase`).',
    implements: ['D-021a', 'D-141', 'D-022'],
  })
  @ApiCompliance('compliance.tariff_cap', 'compliance.water_minimum')
  @ApiJsonBody(RatePlanVersionCreateDto, {
    effectiveFrom: '2026-11-01',
    basis: 'per_unit',
    tiers: { kind: 'flat', unit: 'kwh', pricePerUnit: '7.0000' },
    acknowledgementIds: [FAKE.uuid],
  })
  @ApiSuccess(201, { description: 'Saved', type: RatePlanDto, example: RATE_PLAN_EXAMPLE })
  @ApiStandardErrors(
    'compliance.acknowledgement_required',
    'rate_plan.backdated',
    'rate_plan.version_in_force',
    ...WRITE,
  )
  async saveVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('ratePlanId', ParseUUIDPipe) id: string,
    @Body() body: RatePlanVersionCreateDto,
  ): Promise<RatePlanDto> {
    return ratePlanDto(
      await this.plans.saveVersion(
        ctx,
        id,
        {
          effectiveFrom: body.effectiveFrom,
          basis: body.basis,
          tiers: body.tiers,
          minimumCharge: body.minimumCharge ?? null,
          note: body.note ?? null,
        },
        body.acknowledgementIds ?? [],
      ),
      this.today(),
    );
  }
}

// ------------------------------------------------------------------------------------------- billing cycles

@ApiTags('owner.billing')
@ApiSurface(SURFACES.owner)
@Controller('owner/billing-cycles')
export class OwnerBillingCyclesController {
  constructor(
    private readonly cycles: BillingCyclesService,
    private readonly requests: ReadingRequestsService,
  ) {}

  @Get()
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.billingCycles.list',
    summary: 'Billing cycles',
    description: 'One cycle per property and period (D-031), newest first, with its status and counters.',
    implements: ['D-031', 'D-011'],
  })
  @ApiPaginated(BillingCycleDto, { example: CYCLE_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: BillingCycleListQuery,
  ): Promise<Page<BillingCycleDto>> {
    const { rows, total } = await this.cycles.list(ctx, {
      propertyId: q.propertyId,
      status: q.status,
      ...toSkipTake(q),
    });
    return paginated(rows.map(cycleDto), total, q);
  }

  @Post()
  @HttpCode(200)
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.billingCycles.open',
    summary: 'Open (or get) the cycle of a period',
    description:
      'The worker opens cycles at the cut-off by itself (`billing.cutoff`, D-031); this opens one ahead of time or for a past period. Returns the existing cycle when there is one.',
    implements: ['D-031'],
  })
  @ApiJsonBody(BillingCycleOpenDto, { propertyId: FAKE.uuid, periodKey: '2026-10' })
  @ApiSuccess(200, { description: 'The cycle', type: BillingCycleDetailDto, example: CYCLE_DETAIL_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async open(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: BillingCycleOpenDto,
  ): Promise<BillingCycleDetailDto> {
    return cycleDetailDto(await this.cycles.open(ctx, body));
  }

  @Get(':billingCycleId')
  @TenantScoped()
  @Can('invoice.read')
  @UseEtag((c: BillingCycleDetailDto) => etagOf(c.id, c.version))
  @ApiEndpoint({
    id: 'owner.billingCycles.get',
    summary: 'One cycle with its per-unit table',
    description:
      'The invoices of the cycle (drafts and issued), one per billed party × unit, with review flags (missing readings, missing rate plan, no cap reference) and above-cap markers to review before issuing (D-011, D-021a).',
    implements: ['D-011', 'D-031', 'D-021a'],
  })
  @ApiSuccess(200, { description: 'The cycle', type: BillingCycleDetailDto, example: CYCLE_DETAIL_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('billingCycleId', ParseUUIDPipe) id: string,
  ): Promise<BillingCycleDetailDto> {
    return cycleDetailDto(await this.cycles.get(ctx, id));
  }

  @Post(':billingCycleId/actions/compute')
  @HttpCode(200)
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.billingCycles.compute',
    summary: 'Compute (or recompute) the drafts',
    description:
      'Every billed party × unit gets a draft from the engine: rent pro-rata (D-041), lease lines, meter lines from the readings closing the period (highest confidence in the window; staff readings until the grace deadline; estimates only where `billing.estimate_policy` allows, D-031), the rate version in force (the agreed one when a later one charges more), the utility cap (D-021a), queued one-offs and estimate settlements. Missing readings keep the cycle `readings_pending` and ask staff for a round.',
    implements: ['D-011', 'D-030', 'D-031', 'D-041', 'D-021a'],
  })
  @ApiSuccess(200, { description: 'Computed', type: BillingCycleDetailDto, example: CYCLE_DETAIL_EXAMPLE })
  @ApiStandardErrors('billing_cycle.invalid_state', ...WRITE)
  async compute(
    @CurrentTenant() ctx: TenantContext,
    @Param('billingCycleId', ParseUUIDPipe) id: string,
  ): Promise<BillingCycleDetailDto> {
    return cycleDetailDto(await this.cycles.compute(ctx, id));
  }

  @Post(':billingCycleId/actions/request-readings')
  @HttpCode(200)
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.billingCycles.requestReadings',
    summary: 'Ask staff to read meters of the cycle',
    description:
      'Turns missing readings into staff tasks (web F2 2.3): every meter of the cycle’s buildings still missing in the reading round, or the meter assignments given, get an open reading request — optionally assigned to one staff login (who must capture readings on that building) — due at the grace deadline. Repeating re-assigns the open requests. The next accepted or pending reading fulfils a request; the round shows `assignee` and the staff get `reading.requested` (D-031, D-035, D-208).',
    implements: ['D-031', 'D-035', 'D-208'],
  })
  @ApiJsonBody(ReadingRequestCreateDto, { meterAssignmentIds: [FAKE.uuid], assigneeUserId: FAKE.uuid })
  @ApiSuccess(200, {
    description: 'Open requests',
    type: ReadingRequestsDto,
    example: {
      billingCycleId: FAKE.uuid,
      requests: [
        {
          id: FAKE.uuid,
          meterAssignmentId: FAKE.uuid,
          assetItemId: FAKE.meterId,
          code: 'A-305-E',
          assigneeUserId: FAKE.uuid,
          status: 'open',
          dueAt: FAKE.dateTime,
        },
      ],
    },
  })
  @ApiStandardErrors('billing_cycle.invalid_state', ...WRITE)
  async requestReadings(
    @CurrentTenant() ctx: TenantContext,
    @Param('billingCycleId', ParseUUIDPipe) id: string,
    @Body() body: ReadingRequestCreateDto,
  ): Promise<ReadingRequestsDto> {
    const r = await this.requests.request(ctx, id, body);
    return {
      billingCycleId: r.cycle.id,
      requests: r.requests.map((q) => ({
        id: q.id,
        meterAssignmentId: q.meterAssignmentId,
        assetItemId: q.assetItemId,
        code: q.code,
        assigneeUserId: q.assigneeUserId,
        status: q.status as ReadingRequestStatusName,
        dueAt: isoOrNull(q.dueAt),
      })),
    };
  }

  @Post(':billingCycleId/actions/issue')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.billingCycles.issue',
    summary: 'Issue the ready drafts',
    description:
      'Issues every draft without review flags: gapless number, due date, snapshot, then immutable (D-040). Above-cap lines without an acknowledgement need one for the cycle (409 `compliance.acknowledgement_required` → acknowledge → repeat with `acknowledgementIds`, D-021a) or are refused under `block`. Drafts that cannot be issued are listed in `skipped`. Repeatable: issues what became ready since.',
    implements: ['D-011', 'D-021a', 'D-040', 'D-050'],
  })
  @ApiCompliance(
    'compliance.tariff_cap',
    'compliance.bill_disclosure',
    'compliance.invoice_lead_time',
    'compliance.no_renewal_fee',
  )
  @ApiJsonBody(IssueDto, { acknowledgementIds: [FAKE.uuid] })
  @ApiSuccess(200, {
    description: 'Issued',
    type: BillingCycleIssueResultDto,
    example: { ...CYCLE_DETAIL_EXAMPLE, status: 'issued', skipped: [] },
  })
  @ApiStandardErrors('compliance.acknowledgement_required', 'billing_cycle.invalid_state', ...WRITE)
  async issue(
    @CurrentTenant() ctx: TenantContext,
    @Param('billingCycleId', ParseUUIDPipe) id: string,
    @Body() body: IssueDto,
  ): Promise<BillingCycleIssueResultDto> {
    const c = await this.cycles.issue(ctx, id, body.acknowledgementIds ?? []);
    const last = (c.stats as { lastIssue?: { skipped?: Record<string, unknown>[] } }).lastIssue;
    return { ...cycleDetailDto(c), skipped: last?.skipped ?? [] };
  }

  @Post(':billingCycleId/actions/close')
  @HttpCode(200)
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.billingCycles.close',
    summary: 'Close an issued cycle',
    description: 'Marks the period done (D-031); corrections then go through credit/debit notes (D-040).',
    implements: ['D-031', 'D-040'],
  })
  @ApiSuccess(200, {
    description: 'Closed',
    type: BillingCycleDetailDto,
    example: { ...CYCLE_DETAIL_EXAMPLE, status: 'closed', nextActions: [] },
  })
  @ApiStandardErrors('billing_cycle.invalid_state', ...WRITE)
  async close(
    @CurrentTenant() ctx: TenantContext,
    @Param('billingCycleId', ParseUUIDPipe) id: string,
  ): Promise<BillingCycleDetailDto> {
    return cycleDetailDto(await this.cycles.close(ctx, id));
  }
}

// ------------------------------------------------------------------------------------------- invoices

@ApiTags('owner.billing')
@ApiSurface(SURFACES.owner)
@Controller('owner/invoices')
export class OwnerInvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly cycles: BillingCyclesService,
  ) {}

  /** The invoice with what the row does not carry: the EMVCo payload of its active Thai QR (web F2). */
  private async full(ctx: TenantContext, row: InvoiceRow): Promise<InvoiceDto> {
    return invoiceDto(row, { qrPayload: await this.invoices.activeQrPayload(ctx, row.id) });
  }

  @Get()
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.invoices.list',
    summary: 'Invoices',
    description:
      'Invoices of my buildings (Staff: their buildings) — filter by status, building, unit, lease, billed party, cycle, period or a search on number / unit / name (D-011).',
    implements: ['D-011', 'D-152'],
  })
  @ApiPaginated(InvoiceSummaryDto, { example: SUMMARY_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: InvoiceListQuery,
  ): Promise<Page<InvoiceSummaryDto>> {
    const { rows, total } = await this.invoices.list(ctx, {
      status: q.status,
      buildingId: q.buildingId,
      unitId: q.unitId,
      leaseId: q.leaseId,
      partyId: q.partyId,
      billingCycleId: q.billingCycleId,
      period: q.period,
      q: q.q,
      ...toSkipTake(q),
    });
    return paginated(rows.map(invoiceSummaryDto), total, q);
  }

  @Get(':invoiceId')
  @TenantScoped()
  @Can('invoice.read')
  @UseEtag((i: InvoiceDto) => etagOf(i.id, i.version))
  @ApiEndpoint({
    id: 'owner.invoices.get',
    summary: 'One invoice',
    description:
      'Lines with registers, reading sources, meter segments, rate and utility cap, pro-rata and tiers (D-022), credit/debit notes, prior balance and next actions.',
    implements: ['D-022', 'D-040', 'D-041'],
  })
  @ApiSuccess(200, { description: 'The invoice', type: InvoiceDto, example: INVOICE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDto> {
    return this.full(ctx, await this.invoices.get(ctx, id));
  }

  @Post(':invoiceId/actions/issue')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.invoices.issue',
    summary: 'Issue one draft',
    description:
      'A final invoice (move-out, D-177), a replacement or one draft of a cycle: the same checks as the cycle issue (tariff cap acknowledgement or block, disclosure, lead time, renewal fees, late-fee policy), gapless number, snapshot, then immutable (D-040).',
    implements: ['D-040', 'D-021a', 'D-022', 'D-050'],
  })
  @ApiCompliance(
    'compliance.tariff_cap',
    'compliance.bill_disclosure',
    'compliance.invoice_lead_time',
    'compliance.no_renewal_fee',
    'compliance.late_fee_policy',
  )
  @ApiJsonBody(IssueDto, { acknowledgementIds: [FAKE.uuid] })
  @ApiSuccess(200, { description: 'Issued', type: InvoiceDto, example: INVOICE_EXAMPLE })
  @ApiStandardErrors(
    'compliance.acknowledgement_required',
    'invoice.invalid_state',
    'invoice.not_ready',
    ...WRITE,
  )
  async issue(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Body() body: IssueDto,
  ): Promise<InvoiceDto> {
    return this.full(
      ctx,
      await this.invoices.issue(ctx, id, { acknowledgementIds: body.acknowledgementIds ?? [] }),
    );
  }

  @Post(':invoiceId/actions/recompute')
  @HttpCode(200)
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.invoices.recompute',
    summary: 'Recompute a draft',
    description:
      'A cycle draft is recomputed with its cycle; a final draft from the lease and the move-out registers (D-177). The response is the fresh draft (its id may change).',
    implements: ['D-011', 'D-177'],
  })
  @ApiSuccess(200, { description: 'Recomputed', type: InvoiceDto, example: DRAFT_EXAMPLE })
  @ApiStandardErrors('invoice.invalid_state', 'billing_cycle.invalid_state', ...WRITE)
  async recompute(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDto> {
    return this.full(ctx, await this.cycles.recomputeDraft(ctx, id));
  }

  @Post(':invoiceId/actions/void')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('invoice.void')
  @ApiEndpoint({
    id: 'owner.invoices.void',
    summary: 'Void an issued invoice (and reissue)',
    description:
      'Only before any payment (`invoice.has_payments` → use a credit note); the number stays used, the void is audited, and `reissue: true` recomputes a replacement draft for the same period linked both ways (D-040).',
    implements: ['D-040'],
  })
  @ApiJsonBody(InvoiceVoidDto, { reason: 'คำนวณจากเลขมิเตอร์ที่อ่านผิด', reissue: true })
  @ApiSuccess(200, {
    description: 'Voided',
    type: InvoiceVoidResultDto,
    example: { voided: { ...INVOICE_EXAMPLE, status: 'void', nextActions: [] }, replacement: DRAFT_EXAMPLE },
  })
  @ApiStandardErrors('invoice.invalid_state', 'invoice.has_payments', ...WRITE)
  async void(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Body() body: InvoiceVoidDto,
  ): Promise<InvoiceVoidResultDto> {
    const r = await this.cycles.voidAndReissue(ctx, id, {
      reason: body.reason,
      reissue: body.reissue ?? false,
    });
    const voided = await this.invoices.get(ctx, id);
    const replacementId = voided.replacedByInvoiceId ?? r.replacement?.id ?? null;
    return {
      voided: await this.full(ctx, voided),
      replacement: replacementId ? await this.full(ctx, await this.invoices.get(ctx, replacementId)) : null,
    };
  }

  @Post(':invoiceId/credit-notes')
  @Idempotent()
  @TenantScoped()
  @Can('invoice.void')
  @ApiEndpoint({
    id: 'owner.invoices.creditNote',
    summary: 'Issue a credit note',
    description:
      'Corrects an issued invoice down (D-040): numbered (`credit_note` series), each line ≤ the invoice line it corrects, the total ≤ the invoice total less earlier credits; the balance is reduced.',
    implements: ['D-040', 'D-050'],
  })
  @ApiJsonBody(NoteCreateDto, {
    reason: 'reading_correction',
    reasonText: 'อ่านมิเตอร์ผิด 10 หน่วย',
    lines: [{ refInvoiceLineId: FAKE.uuid, description: 'แก้ไขค่าไฟ 10 หน่วย', amount: '70.00' }],
  })
  @ApiSuccess(201, { description: 'Credited', type: InvoiceDto, example: INVOICE_EXAMPLE })
  @ApiStandardErrors('invoice.invalid_state', 'invoice.credit_exceeds', ...WRITE)
  async creditNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Body() body: NoteCreateDto,
  ): Promise<InvoiceDto> {
    return this.full(ctx, await this.invoices.note(ctx, 'credit', id, body));
  }

  @Post(':invoiceId/debit-notes')
  @Idempotent()
  @TenantScoped()
  @Can('invoice.void')
  @ApiEndpoint({
    id: 'owner.invoices.debitNote',
    summary: 'Issue a debit note',
    description:
      'Corrects an issued invoice up (D-040): numbered (`debit_note` series); the balance grows. Never a renewal fee (`compliance.no_renewal_fee`).',
    implements: ['D-040', 'D-050'],
  })
  @ApiCompliance('compliance.no_renewal_fee')
  @ApiJsonBody(NoteCreateDto, {
    reason: 'reading_correction',
    reasonText: 'อ่านมิเตอร์ขาด 10 หน่วย',
    lines: [{ refInvoiceLineId: FAKE.uuid, description: 'ค่าไฟเพิ่ม 10 หน่วย', amount: '70.00' }],
  })
  @ApiSuccess(201, { description: 'Debited', type: InvoiceDto, example: INVOICE_EXAMPLE })
  @ApiStandardErrors('invoice.invalid_state', ...WRITE)
  async debitNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Body() body: NoteCreateDto,
  ): Promise<InvoiceDto> {
    return this.full(ctx, await this.invoices.note(ctx, 'debit', id, body));
  }
}

// ------------------------------------------------------------------------------------------- one-off charges

@ApiTags('owner.billing')
@ApiSurface(SURFACES.owner)
@Controller('owner/invoice-charges')
export class OwnerInvoiceChargesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.invoiceCharges.list',
    summary: 'Queued one-off charges',
    description: 'One-offs and discounts waiting for (or applied to) the next invoice of a unit (D-041).',
    implements: ['D-041'],
  })
  @ApiSuccess(200, { description: 'Charges', type: [InvoiceChargeDto], example: [CHARGE_EXAMPLE] })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: InvoiceChargeListQuery,
  ): Promise<InvoiceChargeDto[]> {
    return (await this.invoices.listCharges(ctx, q)).map(chargeDto);
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.invoiceCharges.create',
    summary: 'Queue a one-off for the next invoice',
    description:
      'Billed to the unit’s lessee (or the party given) on the next invoice; a discount is a negative line. Never a renewal fee (`compliance.no_renewal_fee`, D-020).',
    implements: ['D-041', 'D-020'],
  })
  @ApiCompliance('compliance.no_renewal_fee')
  @ApiJsonBody(InvoiceChargeCreateDto, {
    unitId: FAKE.uuid,
    lineKind: 'one_off',
    description: 'ค่าทำกุญแจสำรอง',
    unitPrice: '150.00',
  })
  @ApiSuccess(201, { description: 'Queued', type: InvoiceChargeDto, example: CHARGE_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: InvoiceChargeCreateDto,
  ): Promise<InvoiceChargeDto> {
    return chargeDto(await this.invoices.queueCharge(ctx, body));
  }

  @Post(':chargeId/actions/cancel')
  @HttpCode(200)
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.invoiceCharges.cancel',
    summary: 'Cancel a pending charge',
    description: 'Only while pending; audited with the reason.',
    implements: ['D-041'],
  })
  @ApiJsonBody(InvoiceChargeCancelDto, { reason: 'ซ้ำกับรายการเดิม' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: InvoiceChargeDto,
    example: { ...CHARGE_EXAMPLE, status: 'cancelled' as InvoiceChargeStatusName },
  })
  @ApiStandardErrors('invoice.invalid_state', ...WRITE)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('chargeId', ParseUUIDPipe) id: string,
    @Body() body: InvoiceChargeCancelDto,
  ): Promise<InvoiceChargeDto> {
    return chargeDto(await this.invoices.cancelCharge(ctx, id, body.reason));
  }
}

// ------------------------------------------------------------------------------------------- resident

@ApiTags('resident.invoices')
@ApiSurface(SURFACES.resident)
@Controller('resident/invoices')
export class ResidentInvoicesController {
  constructor(private readonly invoices: ResidentInvoicesService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.invoices.list',
    summary: 'My invoices',
    description:
      'Issued invoices billed to me (or of a lease I am a party of), across buildings, newest first; `unpaid=true` for what is still due (D-011, D-061).',
    implements: ['D-011', 'D-061', 'D-154'],
  })
  @ApiPaginated(ResidentInvoiceDto, { example: RESIDENT_INVOICE_EXAMPLE })
  @ApiStandardErrors('auth.unauthenticated', 'validation.failed')
  async list(@Query() q: ResidentInvoiceListQuery): Promise<Page<ResidentInvoiceDto>> {
    const { rows, total } = await this.invoices.list({
      status: q.status,
      unpaid: q.unpaid,
      ...toSkipTake(q),
    });
    const extras = await this.invoices.extras(rows);
    return paginated(
      rows.map((r) => residentInvoiceDto(r, extras.get(r.id))),
      total,
      q,
    );
  }

  @Get('by-number/:number')
  @ApiEndpoint({
    id: 'resident.invoices.byNumber',
    summary: 'An invoice by its number',
    description: 'For links in LINE messages and printed QR slips (D-011); 404 when it is not mine.',
    implements: ['D-011', 'D-154'],
  })
  @ApiSuccess(200, {
    description: 'The invoice',
    type: ResidentInvoiceDto,
    example: RESIDENT_INVOICE_EXAMPLE,
  })
  @ApiStandardErrors('auth.unauthenticated', 'http.not_found')
  async byNumber(@Param('number') number: string): Promise<ResidentInvoiceDto> {
    const row = await this.invoices.get({ number });
    return residentInvoiceDto(row, (await this.invoices.extras([row])).get(row.id));
  }

  @Get(':invoiceId')
  @ApiEndpoint({
    id: 'resident.invoices.get',
    summary: 'One of my invoices',
    description:
      'As issued (from its snapshot): lines with opening/closing registers and reading sources (D-022), prior balance, amount due and the live balance.',
    implements: ['D-022', 'D-011', 'D-154'],
  })
  @ApiSuccess(200, {
    description: 'The invoice',
    type: ResidentInvoiceDto,
    example: RESIDENT_INVOICE_EXAMPLE,
  })
  @ApiStandardErrors('auth.unauthenticated', 'http.not_found', 'validation.failed')
  async get(@Param('invoiceId', ParseUUIDPipe) id: string): Promise<ResidentInvoiceDto> {
    const row = await this.invoices.get({ id });
    return residentInvoiceDto(row, (await this.invoices.extras([row])).get(row.id));
  }
}

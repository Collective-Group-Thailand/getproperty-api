import { utilityCharge } from '@core/utility-tariffs/tariff-math';
import { type UtilityTariffStructure } from '@core/utility-tariffs/tariff-structure';
import Decimal from 'decimal.js';

import { LEASE_LINE_KIND, type LineKind, type SourceType, sourceTypeOf } from './line-kinds';
import { type ProRata, proRata, proRataAmount, rentSegments } from './periods';
import { chargeFor, type RateVersionLike, type TierPart } from './rate-tiers';
import { type MeterSegment, segmentUnits } from './readings';

/**
 * The billing engine (B4.2, D-011 "the heart of the product"): one pure function from everything a draft invoice
 * needs — the period, the billed party × unit, the lease (rent, lines, utility mode, advance rent), the meter
 * segments with their readings, the rate plan versions in force, the utility tariff versions that cap them, queued
 * one-offs and estimate settlements, the tenant's VAT setting — to its lines and totals. Rounding: each line half-up
 * to satang, totals are sums of rounded lines (D-046); meter lines carry the effective tenant price and the
 * utility's effective average rate for the same consumption (D-140) so `above_cap` is decided here (D-021a); the
 * service enforces the acknowledgement / refusal through the compliance gate and persists the result. Golden tests:
 * `invoice-draft.golden.spec.ts`.
 */

export interface CapCandidate {
  id: string;
  provider: string;
  tariffCode: string;
  effectiveFrom: string;
  structure: UtilityTariffStructure;
}

export interface CapReference {
  utilityTariffVersionId: string;
  provider: string;
  tariffCode: string;
  effectiveFrom: string;
  capPerUnit: string;
}

/**
 * The cap compared with a tenant price (D-021a, D-140, D-191): the utility's effective average rate for this
 * consumption, from the published residential tariffs of the building's provider in force — the **lowest** of them
 * when several apply (conservative: never under-warn). TOU tariffs need a peak split and are not candidates.
 */
export function capFor(candidates: CapCandidate[], units: Decimal.Value): CapReference | null {
  const reference = new Decimal(units).gt(0) ? new Decimal(units) : new Decimal(1);
  let best: CapReference | null = null;
  for (const c of candidates) {
    if (c.structure.kind === 'tou') continue;
    const avg = utilityCharge(c.structure, { units: reference }).effectiveAverageRate;
    if (avg === null) continue;
    if (!best || new Decimal(avg).lt(best.capPerUnit))
      best = {
        utilityTariffVersionId: c.id,
        provider: c.provider,
        tariffCode: c.tariffCode,
        effectiveFrom: c.effectiveFrom,
        capPerUnit: new Decimal(avg).toFixed(4),
      };
  }
  return best;
}

export interface LeaseInput {
  id: string;
  number: string | null;
  startDate: string;
  endDate: string;
  rent: string;
  rentChanges: { effectiveFrom: string; rent: string }[];
  utilityBillingMode: 'metered' | 'included';
  lines: {
    id: string;
    kind: string;
    description: string;
    amount: string;
    recurrence: 'monthly' | 'once';
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
}

export interface MeterInput {
  utility: 'electric' | 'water';
  segments: MeterSegment[];
  ratePlanVersion: RateVersionLike | null;
  /** Why the version is the lease's agreed one rather than the one in force (compliance.no_midterm_increase). */
  rateFrozenByLease?: boolean;
  capCandidates: CapCandidate[];
  /** The acknowledgement that covers an above-cap price for this line (D-021a), if the Owner gave one. */
  acknowledgementId?: string | null;
}

export interface EstimateSettlementInput {
  id: string;
  utility: 'electric' | 'water';
  estimatedUnits: string;
  /** Actual units of the estimated period (from its start register to the actual closing reading). */
  actualUnits: string;
  unitPrice: string;
  capPerUnit: string;
  utilityTariffVersionId: string;
  ratePlanVersionId: string;
  acknowledgementId: string | null;
  meterAssignmentId: string;
  assetItemId: string;
  actualReadingId: string;
}

export interface ChargeLineInput {
  id: string;
  sourceType: SourceType;
  lineKind: LineKind;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface UnitRatePlanInput {
  kind: 'common_fee' | 'fund' | 'service';
  version: RateVersionLike;
  name: string;
}

export interface DraftInput {
  /** The billing period (the cycle's calendar period): pro-rata divides by its days (D-041). */
  period: { start: string; end: string };
  /** `final` = the move-out invoice (D-177): occupancy ends on the move-out date. */
  mode: 'cycle' | 'final';
  unit: { id: string; unitNo: string; type: string; areaSqm: string | null; ownershipRatio: string | null };
  /** Bangkok dates the billed party occupies the unit within the period (lease start … move-out / end). */
  occupancy: { from: string; to: string };
  lease: LeaseInput | null;
  meters: MeterInput[];
  unitRatePlans: UnitRatePlanInput[];
  charges: ChargeLineInput[];
  estimateSettlements: EstimateSettlementInput[];
  /** Received advance rent applied to a final invoice (D-177). */
  advanceRent: string | null;
  vat: { registered: boolean; rate: string; applicableKinds: string[] };
}

export interface DraftLine {
  lineNo: number;
  sourceType: SourceType;
  lineKind: LineKind;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string | null;
  amount: string;
  periodFrom: string | null;
  periodTo: string | null;
  sourceId: string | null;
  leaseLineId: string | null;
  chargeId: string | null;
  estimateSettlementId: string | null;
  meter: null | {
    utility: 'electric' | 'water';
    assetItemId: string;
    meterAssignmentId: string;
    readingFromId: string | null;
    readingToId: string | null;
    registerFrom: string | null;
    registerTo: string | null;
    units: string;
    multiplier: string;
    readingSource: string | null;
    isEstimated: boolean;
    segments: MeterSegment[];
  };
  ratePlanVersionId: string | null;
  utilityTariffVersionId: string | null;
  capPerUnit: string | null;
  aboveCap: boolean;
  acknowledgementId: string | null;
  tierBreakdown: TierPart[] | null;
  proRata: ProRata | null;
  vatApplicable: boolean;
  complianceRuleIds: string[];
}

export interface DraftResult {
  lines: DraftLine[];
  subtotal: string;
  vatAmount: string;
  total: string;
  hasEstimate: boolean;
  hasAboveCapLine: boolean;
  /** What blocks issuing until resolved (missing readings, rate plans, cap references, acknowledgements). */
  reviewFlags: string[];
  complianceFlags: string[];
  advanceRent: { received: string; applied: string; unused: string } | null;
}

const UTILITY_KIND: Record<'electric' | 'water', LineKind> = { electric: 'electricity', water: 'water' };
const UTILITY_TH: Record<'electric' | 'water', string> = { electric: 'ค่าไฟฟ้า', water: 'ค่าน้ำประปา' };
const UNIT_OF: Record<'electric' | 'water', string> = { electric: 'kwh', water: 'm3' };
const q3 = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3);
const m2 = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export class BillingEngineError extends Error {
  override name = 'BillingEngineError';
}

function base(
  partial: Partial<DraftLine> & Pick<DraftLine, 'lineKind' | 'description' | 'amount'>,
): DraftLine {
  return {
    lineNo: 0,
    sourceType: sourceTypeOf(partial.lineKind),
    quantity: '1.000',
    unit: null,
    unitPrice: null,
    periodFrom: null,
    periodTo: null,
    sourceId: null,
    leaseLineId: null,
    chargeId: null,
    estimateSettlementId: null,
    meter: null,
    ratePlanVersionId: null,
    utilityTariffVersionId: null,
    capPerUnit: null,
    aboveCap: false,
    acknowledgementId: null,
    tierBreakdown: null,
    proRata: null,
    vatApplicable: false,
    complianceRuleIds: [],
    ...partial,
  };
}

/** Computes the draft invoice (lines + totals + review flags). Pure and deterministic for the same input. */
export function computeInvoiceDraft(input: DraftInput): DraftResult {
  const lines: DraftLine[] = [];
  const reviewFlags: string[] = [];
  const complianceFlags = new Set<string>();
  const period = input.period;
  const pr = proRata(period, input.occupancy);

  // 1. rent (pro-rata by calendar days; a recorded change inside the period splits it) — D-041, D-176
  if (input.lease && pr) {
    for (const seg of rentSegments(input.lease.rent, input.lease.rentChanges, pr.from, pr.to)) {
      const segPr = proRata(period, { from: seg.from, to: seg.to })!;
      lines.push(
        base({
          lineKind: 'rent',
          description:
            segPr.days === segPr.daysInPeriod
              ? `ค่าเช่า ${input.unit.unitNo}`
              : `ค่าเช่า ${input.unit.unitNo} (${segPr.days}/${segPr.daysInPeriod} วัน)`,
          quantity: q3(segPr.factor),
          unit: 'month',
          unitPrice: new Decimal(seg.rent).toFixed(4),
          amount: proRataAmount(seg.rent, segPr),
          periodFrom: seg.from,
          periodTo: seg.to,
          sourceId: input.lease.id,
          proRata: segPr,
          complianceRuleIds: ['compliance.no_midterm_increase'],
        }),
      );
    }
  }

  // 2. lease lines: monthly lines pro-rata, once-lines on the invoice whose period contains their start
  const minimums: { amount: string; leaseLineId: string; description: string }[] = [];
  if (input.lease && pr) {
    for (const l of input.lease.lines) {
      const kind = LEASE_LINE_KIND[l.kind];
      if (!kind) throw new BillingEngineError(`unknown lease line kind ${l.kind}`);
      if (kind === 'water_minimum') {
        minimums.push({ amount: l.amount, leaseLineId: l.id, description: l.description });
        continue;
      }
      if (l.recurrence === 'once') {
        if (l.effectiveFrom < period.start || l.effectiveFrom > period.end) continue;
        lines.push(
          base({
            lineKind: kind,
            description: l.description,
            unitPrice: new Decimal(l.amount).toFixed(4),
            amount: m2(l.amount),
            periodFrom: l.effectiveFrom,
            periodTo: l.effectiveFrom,
            leaseLineId: l.id,
            sourceId: l.id,
            complianceRuleIds: ['compliance.bill_disclosure'],
          }),
        );
        continue;
      }
      const linePr = proRata(period, {
        from: l.effectiveFrom > pr.from ? l.effectiveFrom : pr.from,
        to: l.effectiveTo && l.effectiveTo < pr.to ? l.effectiveTo : pr.to,
      });
      if (!linePr) continue;
      lines.push(
        base({
          lineKind: kind,
          description:
            linePr.days === linePr.daysInPeriod
              ? l.description
              : `${l.description} (${linePr.days}/${linePr.daysInPeriod} วัน)`,
          quantity: q3(linePr.factor),
          unit: 'month',
          unitPrice: new Decimal(l.amount).toFixed(4),
          amount: proRataAmount(l.amount, linePr),
          periodFrom: linePr.from,
          periodTo: linePr.to,
          leaseLineId: l.id,
          sourceId: l.id,
          proRata: linePr,
          complianceRuleIds: ['compliance.bill_disclosure'],
        }),
      );
    }
  }

  // 3. meters (D-022, D-030, D-021a): one line per utility, units summed over the assignments of the period
  const metered = !input.lease || input.lease.utilityBillingMode === 'metered';
  for (const m of metered ? input.meters : []) {
    if (!m.segments.length) continue;
    const missing = m.segments.filter((s) => s.to === null);
    if (missing.length) {
      reviewFlags.push(`missing_reading:${m.utility}`);
      continue;
    }
    let units = new Decimal(0);
    let faulty = false;
    for (const s of m.segments) {
      const u = segmentUnits(s);
      if (u === null) faulty = true;
      else units = units.plus(u);
    }
    if (faulty) {
      reviewFlags.push(`register_decrease:${m.utility}`);
      continue;
    }
    if (!m.ratePlanVersion) {
      reviewFlags.push(`missing_rate_plan:${m.utility}`);
      continue;
    }
    const cap = capFor(m.capCandidates, units);
    if (!cap) {
      reviewFlags.push(`no_cap_reference:${m.utility}`);
      continue;
    }
    const charge = chargeFor(m.ratePlanVersion, { units });
    const aboveCap = new Decimal(charge.unitPrice).gt(cap.capPerUnit);
    if (aboveCap) {
      complianceFlags.add(`above_cap:${m.utility}`);
      if (!m.acknowledgementId) reviewFlags.push(`acknowledgement_required:${m.utility}`);
    }
    if (m.rateFrozenByLease) complianceFlags.add(`rate_frozen_by_lease:${m.utility}`);
    const first = m.segments[0]!;
    const last = m.segments[m.segments.length - 1]!;
    const estimated = m.segments.some((s) => s.to!.isEstimated);
    lines.push(
      base({
        lineKind: UTILITY_KIND[m.utility],
        description: `${UTILITY_TH[m.utility]} ${units.toFixed(3)} หน่วย${estimated ? ' (ประมาณการ)' : ''}`,
        quantity: units.toFixed(3),
        unit: UNIT_OF[m.utility],
        unitPrice: charge.unitPrice,
        amount: charge.amount,
        periodFrom: period.start,
        periodTo: period.end,
        meter: {
          utility: m.utility,
          assetItemId: last.assetItemId,
          meterAssignmentId: last.assignmentId,
          readingFromId: first.from.readingId,
          readingToId: last.to!.readingId,
          registerFrom: m.segments.length === 1 ? first.from.register : null,
          registerTo: m.segments.length === 1 ? last.to!.register : null,
          units: units.toFixed(3),
          multiplier: m.segments.length === 1 ? first.multiplier : '1',
          readingSource: last.to!.source === 'assignment' ? null : last.to!.source,
          isEstimated: estimated,
          segments: m.segments,
        },
        ratePlanVersionId: m.ratePlanVersion.id,
        utilityTariffVersionId: cap.utilityTariffVersionId,
        capPerUnit: cap.capPerUnit,
        aboveCap,
        acknowledgementId: aboveCap ? (m.acknowledgementId ?? null) : null,
        tierBreakdown: charge.tierBreakdown,
        complianceRuleIds: ['compliance.tariff_cap', 'compliance.bill_disclosure'],
      }),
    );
    // water minimum (D-141): a top-up line to the lease minimum, or to the version's own minimum
    if (m.utility === 'water') {
      const leaseMin = minimums[0];
      const minimum = leaseMin
        ? new Decimal(leaseMin.amount)
        : m.ratePlanVersion.minimumCharge
          ? new Decimal(m.ratePlanVersion.minimumCharge)
          : null;
      const topUp = minimum && minimum.gt(charge.amount) ? minimum.minus(charge.amount) : null;
      if (topUp)
        lines.push(
          base({
            lineKind: 'water_minimum',
            description: `ค่าน้ำขั้นต่ำ (ขั้นต่ำ ${minimum!.toFixed(2)} บาท)`,
            unitPrice: topUp.toFixed(4),
            amount: m2(topUp),
            periodFrom: period.start,
            periodTo: period.end,
            leaseLineId: leaseMin?.leaseLineId ?? null,
            sourceId: leaseMin?.leaseLineId ?? m.ratePlanVersion.id,
            ratePlanVersionId: leaseMin ? null : m.ratePlanVersion.id,
            complianceRuleIds: ['compliance.water_minimum'],
          }),
        );
    }
  }

  // 4. estimate settlements of the previous period (D-012, D-031): Δ units × the estimated line's price
  for (const s of input.estimateSettlements) {
    const delta = new Decimal(s.actualUnits).minus(s.estimatedUnits);
    if (delta.isZero()) continue;
    const aboveCap = new Decimal(s.unitPrice).gt(s.capPerUnit);
    lines.push(
      base({
        lineKind: 'estimate_settlement',
        description: `ปรับ${UTILITY_TH[s.utility]}จากการประมาณการ ${delta.toFixed(3)} หน่วย`,
        quantity: delta.toFixed(3),
        unit: UNIT_OF[s.utility],
        unitPrice: s.unitPrice,
        amount: m2(delta.times(s.unitPrice)),
        estimateSettlementId: s.id,
        sourceId: s.id,
        meter: {
          utility: s.utility,
          assetItemId: s.assetItemId,
          meterAssignmentId: s.meterAssignmentId,
          readingFromId: null,
          readingToId: s.actualReadingId,
          registerFrom: null,
          registerTo: null,
          units: delta.toFixed(3),
          multiplier: '1',
          readingSource: null,
          isEstimated: false,
          segments: [],
        },
        ratePlanVersionId: s.ratePlanVersionId,
        utilityTariffVersionId: s.utilityTariffVersionId,
        capPerUnit: s.capPerUnit,
        aboveCap,
        acknowledgementId: aboveCap ? s.acknowledgementId : null,
        complianceRuleIds: ['compliance.tariff_cap'],
      }),
    );
    if (aboveCap && !s.acknowledgementId) reviewFlags.push(`acknowledgement_required:${s.utility}`);
  }

  // 5. unit rate plans (common fee / fund by m² or ownership ratio — condos, D-151), pro-rata
  for (const p of input.unitRatePlans) {
    if (!pr) continue;
    const charge = chargeFor(p.version, {
      areaSqm: input.unit.areaSqm,
      ownershipRatio: input.unit.ownershipRatio,
      unitType: input.unit.type,
    });
    const kind: LineKind =
      p.kind === 'fund' ? 'fund' : p.kind === 'common_fee' ? 'common_fee' : 'other_fixed';
    lines.push(
      base({
        lineKind: kind,
        description: pr.days === pr.daysInPeriod ? p.name : `${p.name} (${pr.days}/${pr.daysInPeriod} วัน)`,
        quantity: charge.quantity,
        unit: charge.unit,
        unitPrice: charge.unitPrice,
        amount: proRataAmount(charge.amount, pr),
        periodFrom: pr.from,
        periodTo: pr.to,
        sourceId: p.version.id,
        ratePlanVersionId: p.version.id,
        tierBreakdown: charge.tierBreakdown,
        proRata: pr,
        complianceRuleIds: ['compliance.bill_disclosure'],
      }),
    );
  }

  // 6. queued one-offs (and late fees from 4.5)
  for (const c of input.charges)
    lines.push(
      base({
        lineKind: c.lineKind,
        description: c.description,
        quantity: new Decimal(c.quantity).toFixed(3),
        unitPrice: new Decimal(c.unitPrice).toFixed(4),
        amount: m2(c.amount),
        chargeId: c.id,
        sourceId: c.id,
        complianceRuleIds:
          c.lineKind === 'late_fee' ? ['compliance.late_fee_policy'] : ['compliance.no_renewal_fee'],
      }),
    );

  // 7. advance rent applied to the final invoice (D-177): never more than what the invoice charges
  let advance: DraftResult['advanceRent'] = null;
  if (input.mode === 'final' && input.advanceRent && new Decimal(input.advanceRent).gt(0)) {
    const charges = lines.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
    const applied = Decimal.max(0, Decimal.min(new Decimal(input.advanceRent), charges));
    if (applied.gt(0))
      lines.push(
        base({
          lineKind: 'deposit_offset',
          description: 'หักค่าเช่าล่วงหน้าที่ชำระไว้',
          unitPrice: applied.negated().toFixed(4),
          amount: applied.negated().toFixed(2),
          complianceRuleIds: ['compliance.no_forfeiture'],
        }),
      );
    advance = {
      received: new Decimal(input.advanceRent).toFixed(2),
      applied: applied.toFixed(2),
      unused: new Decimal(input.advanceRent).minus(applied).toFixed(2),
    };
  }

  // totals (D-046): Σ rounded lines; VAT only for VAT-registered tenants on the kinds their setting lists (O-004)
  lines.forEach((l, i) => {
    l.lineNo = i + 1;
    l.vatApplicable = input.vat.registered && input.vat.applicableKinds.includes(l.lineKind);
  });
  const subtotal = lines.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
  if (subtotal.isNeg()) reviewFlags.push('negative_total');
  const vatBase = lines.filter((l) => l.vatApplicable).reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
  const vat = input.vat.registered ? Decimal.max(0, vatBase.times(input.vat.rate)) : new Decimal(0);
  const vatAmount = m2(vat);
  return {
    lines,
    subtotal: subtotal.toFixed(2),
    vatAmount,
    total: subtotal.plus(vatAmount).toFixed(2),
    hasEstimate: lines.some((l) => l.meter?.isEstimated),
    hasAboveCapLine: lines.some((l) => l.aboveCap),
    reviewFlags: [...new Set(reviewFlags)],
    complianceFlags: [...complianceFlags],
    advanceRent: advance,
  };
}

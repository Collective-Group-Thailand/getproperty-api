import { type UtilityTariffStructure } from '@core/utility-tariffs/tariff-structure';
import { type Tx } from '@database/prisma.service';
import {
  type MeterAssignment,
  type MeterReading,
  type RatePlan,
  type RatePlanKind,
  type RatePlanVersion,
} from '@generated/prisma/client';
import { consumption } from '@modules/smart-readings/reading-rules';
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type CapCandidate, type EstimateSettlementInput } from './engine/invoice-draft';
import { chargesMore, type RateTiers, type RateVersionLike } from './engine/rate-tiers';
import {
  type CandidateReading,
  type MeterSegment,
  type SegmentReading,
  selectClosingReading,
  type SelectionWindows,
} from './engine/readings';

const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);

export const toVersionLike = (v: RatePlanVersion): RateVersionLike => ({
  id: v.id,
  effectiveFrom: day(v.effectiveFrom),
  tiers: v.tiers as unknown as RateTiers,
  basis: v.basis,
  minimumCharge: v.minimumCharge ? v.minimumCharge.toFixed(2) : null,
});

export const candidateOf = (r: MeterReading): CandidateReading => ({
  id: r.id,
  register: r.register.toFixed(3),
  readAt: r.readAt,
  source: r.source,
  confidence: r.confidence.toFixed(3),
  isFinal: r.isFinal,
  isInstall: r.isInstall,
  evidenceDocumentId: r.evidenceDocumentId,
  quality: r.quality,
});

export const segmentReadingOf = (r: MeterReading | CandidateReading): SegmentReading => {
  const c = 'tenantId' in r ? candidateOf(r) : r;
  return {
    readingId: c.id,
    register: c.register,
    readAt: c.readAt.toISOString(),
    source: c.source,
    confidence: c.confidence,
    isEstimated: c.source === 'estimated',
    evidenceDocumentId: c.evidenceDocumentId ?? null,
  };
};

const fromAssignment = (register: Decimal, at: Date): SegmentReading => ({
  readingId: null,
  register: register.toFixed(3),
  readAt: at.toISOString(),
  source: 'assignment',
  confidence: null,
  isEstimated: false,
  evidenceDocumentId: null,
});

export interface SegmentPlan {
  segments: MeterSegment[];
  /** Estimate settlements whose actual reading has arrived (the next segment starts from it). */
  settlements: EstimateSettlementInput[];
  /** Assignment → the history of accepted actual readings (for estimates). */
  history: Map<string, CandidateReading[]>;
}

/**
 * Database side of the billing engine (B4.2): everything `computeInvoiceDraft` needs is read here — the cap
 * reference (published residential tariffs of the building's providers, D-140/D-191), the rate plan in force for a
 * lease (lease plan → building default → tenant default; the version agreed at signing wins over a higher later
 * version, compliance.no_midterm_increase), the meter segments of a unit with the readings that open and close them
 * (chain from the last billed reading, the selection rule of D-031 at the cut-off, install/final registers at swaps)
 * and the estimate settlements whose actual reading arrived (D-012). Reads only `smart.meter_reading` (D-030).
 */
@Injectable()
export class BillingInputs {
  /** Published residential tariffs in force on `onDay` for the providers of the building(s) (tenant-wide = all). */
  async capCandidates(
    tx: Tx,
    tenantId: string,
    buildingId: string | null,
    utility: 'electric' | 'water',
    onDay: string,
  ): Promise<CapCandidate[]> {
    const accounts = await tx.utilityAccount.findMany({
      where: buildingId ? { buildingId, utility } : { tenantId, utility },
      select: { provider: true },
    });
    const providers = [...new Set(accounts.map((a) => a.provider))];
    if (!providers.length) return [];
    const d = asDate(onDay);
    const versions = await tx.utilityTariffVersion.findMany({
      where: {
        state: { in: ['published', 'superseded'] },
        effectiveFrom: { lte: d },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: d } }],
        utilityTariff: {
          utility,
          provider: { in: providers },
          ...(utility === 'electric' ? { tariffCode: { startsWith: '1.1' } } : { tariffCode: 'residential' }),
        },
      },
      include: { utilityTariff: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    const latest = new Map<string, (typeof versions)[number]>();
    for (const v of versions) if (!latest.has(v.utilityTariffId)) latest.set(v.utilityTariffId, v);
    return [...latest.values()].map((v) => ({
      id: v.id,
      provider: v.utilityTariff.provider,
      tariffCode: v.utilityTariff.tariffCode,
      effectiveFrom: day(v.effectiveFrom),
      structure: v.structure as unknown as UtilityTariffStructure,
    }));
  }

  /** Lease plan → the building's default plan of the kind → the tenant-wide default. */
  async planFor(
    tx: Tx,
    tenantId: string,
    buildingId: string,
    kind: RatePlanKind,
    explicitId: string | null,
  ): Promise<(RatePlan & { versions: RatePlanVersion[] }) | null> {
    const include = { versions: { orderBy: { effectiveFrom: 'desc' as const } } };
    if (explicitId) {
      const p = await tx.ratePlan.findFirst({
        where: { id: explicitId, tenantId, deletedAt: null },
        include,
      });
      if (p) return p;
    }
    return (
      (await tx.ratePlan.findFirst({
        where: { tenantId, buildingId, kind, isDefault: true, deletedAt: null },
        include,
      })) ??
      (await tx.ratePlan.findFirst({
        where: { tenantId, buildingId: null, kind, isDefault: true, deletedAt: null },
        include,
      }))
    );
  }

  static versionAt(versions: RatePlanVersion[], onDay: string): RatePlanVersion | null {
    return (
      versions.find(
        (v) => day(v.effectiveFrom) <= onDay && (v.effectiveTo === null || day(v.effectiveTo) > onDay),
      ) ?? null
    );
  }

  /**
   * The version that prices a lease's consumption on `onDay` (ข้อ 5 (3), D-194): the version in force, unless a
   * version in force when the lease was agreed charges less for the same units — then the agreed one (frozen).
   */
  static versionForLease(
    versions: RatePlanVersion[],
    onDay: string,
    agreedDay: string | null,
    units: Decimal.Value,
  ): { version: RatePlanVersion | null; frozen: boolean } {
    const current = BillingInputs.versionAt(versions, onDay);
    if (!current || !agreedDay || day(current.effectiveFrom) <= agreedDay)
      return { version: current, frozen: false };
    const agreed = BillingInputs.versionAt(versions, agreedDay);
    if (!agreed) return { version: current, frozen: false };
    return chargesMore(toVersionLike(current), toVersionLike(agreed), { units })
      ? { version: agreed, frozen: true }
      : { version: current, frozen: false };
  }

  /** Accepted, live readings of the assignments in `[from, to]` (estimates included, flagged by their source). */
  private readings(tx: Tx, assignmentIds: string[], from: Date, to: Date) {
    return tx.meterReading.findMany({
      where: {
        meterAssignmentId: { in: assignmentIds },
        reviewState: 'accepted',
        supersededByReadingId: null,
        readAt: { gte: from, lte: to },
      },
      orderBy: { readAt: 'asc' },
    });
  }

  /** The last billed closing reading of an assignment (issued, not void, invoices only). */
  private async lastBilled(tx: Tx, assignmentId: string, before: Date): Promise<MeterReading | null> {
    const lines = await tx.invoiceLine.findMany({
      where: {
        invoice: { status: { notIn: ['draft', 'void'] } },
        sourceType: 'meter',
        lineKind: { in: ['electricity', 'water'] },
        OR: [{ meterAssignmentId: assignmentId }, { meterSegments: { array_contains: [{ assignmentId }] } }],
      },
      select: { meterSegments: true, readingToId: true, meterAssignmentId: true },
      orderBy: [{ periodTo: 'desc' }, { createdAt: 'desc' }],
      take: 1,
    });
    const line = lines[0];
    if (!line) return null;
    const segments = (line.meterSegments ?? []) as unknown as MeterSegment[];
    const seg = segments.find((s) => s.assignmentId === assignmentId);
    const id = seg?.to?.readingId ?? (line.meterAssignmentId === assignmentId ? line.readingToId : null);
    if (!id) return null;
    const r = await tx.meterReading.findUnique({ where: { id } });
    return r && r.readAt.getTime() <= before.getTime() ? r : null;
  }

  /**
   * The segments of a unit's meters of one utility for a billing window `[start, end]` (instants: the previous
   * cut-off + 1 ms or the move-in, and the cut-off or the move-out). Each assignment active in the window is one
   * segment: it opens at the last billed reading (chain), else the reading at the window start, else the assignment's
   * opening register; it closes at the assignment's final register when it closed inside the window (swap), else at
   * the reading selected for `end` (D-031). Estimated chains whose actual reading has arrived become settlements.
   */
  async segmentsFor(
    tx: Tx,
    input: {
      unitId: string;
      utility: 'electric' | 'water';
      start: Date;
      end: Date;
      windows: SelectionWindows;
      preferFinal: boolean;
      now: Date;
    },
  ): Promise<SegmentPlan & { assignments: MeterAssignment[] }> {
    const assignments = await tx.meterAssignment.findMany({
      where: {
        unitId: input.unitId,
        utility: input.utility,
        purpose: 'unit',
        validFrom: { lte: input.end },
        OR: [{ validTo: null }, { validTo: { gt: input.start } }],
      },
      orderBy: { validFrom: 'asc' },
    });
    const segments: MeterSegment[] = [];
    const settlements: EstimateSettlementInput[] = [];
    const history = new Map<string, CandidateReading[]>();
    const lookback = new Date(input.start.getTime() - 120 * 86_400_000);
    const lookahead = new Date(
      Math.max(input.end.getTime(), input.windows.graceUntil.getTime(), input.now.getTime()),
    );
    const all = await this.readings(
      tx,
      assignments.map((a) => a.id),
      lookback,
      lookahead,
    );
    for (const a of assignments) {
      const own = all.filter((r) => r.meterAssignmentId === a.id).map(candidateOf);
      history.set(
        a.id,
        own.filter((r) => r.source !== 'estimated' && r.readAt.getTime() <= input.end.getTime()),
      );
      const segStart = a.validFrom.getTime() > input.start.getTime() ? a.validFrom : input.start;
      // ---- opening reading
      let from: SegmentReading | null;
      const billed = await this.lastBilled(tx, a.id, input.end);
      if (billed) {
        from = segmentReadingOf(billed);
        if (billed.source === 'estimated') {
          const settlement = await this.settle(tx, a, billed, own, input.end);
          if (settlement) {
            settlements.push(settlement.input);
            from = segmentReadingOf(settlement.actual);
          }
        }
      } else if (a.validFrom.getTime() >= input.start.getTime()) {
        const install = own.find(
          (r) => r.isInstall && Math.abs(r.readAt.getTime() - a.validFrom.getTime()) < 60_000,
        );
        from = install ? segmentReadingOf(install) : fromAssignment(a.initialReading, a.validFrom);
      } else {
        // the reading that opens the window (move-in / previous cut-off): same selection rule, staff readings up to
        // `readings.round_window_days` on either side (a move-in inspection is often recorded the next day)
        const opening =
          selectClosingReading(own, segStart, {
            ...input.windows,
            graceUntil: new Date(segStart.getTime() + input.windows.manualDaysBefore * 86_400_000),
          }) ??
          [...own]
            .reverse()
            .find((r) => r.source !== 'estimated' && r.readAt.getTime() <= segStart.getTime()) ??
          null;
        from = opening ? segmentReadingOf(opening) : fromAssignment(a.initialReading, a.validFrom);
      }
      // ---- closing reading
      let to: SegmentReading | null;
      const closesInside = a.validTo !== null && a.validTo.getTime() <= input.end.getTime();
      if (closesInside) {
        const final = own.find(
          (r) => r.isFinal && Math.abs(r.readAt.getTime() - a.validTo!.getTime()) <= 60_000,
        );
        to = final
          ? segmentReadingOf(final)
          : a.finalReading !== null
            ? fromAssignment(a.finalReading, a.validTo!)
            : null;
      } else {
        const closing = selectClosingReading(own, input.end, input.windows, input.preferFinal);
        to = closing ? segmentReadingOf(closing) : null;
        if (!to) {
          const estimate = own.find(
            (r) => r.source === 'estimated' && Math.abs(r.readAt.getTime() - input.end.getTime()) < 60_000,
          );
          if (estimate) to = segmentReadingOf(estimate);
        }
      }
      if (to && from && from.readingId && to.readingId === from.readingId) continue;
      segments.push({
        assignmentId: a.id,
        assetItemId: a.assetItemId,
        code: a.code,
        multiplier: a.multiplier.toString(),
        rolloverAt: a.rolloverAt.toString(),
        from: from,
        to,
      });
    }
    return { segments, settlements, history, assignments };
  }

  /**
   * A pending estimate settlement of an assignment whose actual reading arrived (D-012, D-031): the reading closest
   * to the estimated cut-off inside the windows, else the first actual reading after it (up to `until`).
   */
  private async settle(
    tx: Tx,
    a: MeterAssignment,
    estimated: MeterReading,
    own: CandidateReading[],
    until: Date,
  ): Promise<{ input: EstimateSettlementInput; actual: CandidateReading } | null> {
    const pending = await tx.estimateSettlement.findFirst({
      where: { estimatedReadingId: estimated.id, status: 'pending' },
      include: { estimatedLine: true },
    });
    if (!pending) return null;
    const actual =
      own.find(
        (r) =>
          r.source !== 'estimated' &&
          Math.abs(r.readAt.getTime() - estimated.readAt.getTime()) <= 2 * 3_600_000,
      ) ??
      own.find(
        (r) =>
          r.source !== 'estimated' &&
          r.readAt.getTime() > estimated.readAt.getTime() &&
          r.readAt.getTime() <= until.getTime(),
      ) ??
      null;
    if (!actual) return null;
    const line = pending.estimatedLine;
    const segments = (line.meterSegments ?? []) as unknown as MeterSegment[];
    const startRegister =
      segments.find((s) => s.assignmentId === a.id)?.from.register ?? line.registerFrom?.toFixed(3) ?? null;
    if (startRegister === null) return null;
    const units = consumption(
      startRegister,
      actual.register,
      a.rolloverAt.toString(),
      a.multiplier.toString(),
    );
    if (units === null) return null;
    return {
      actual,
      input: {
        id: pending.id,
        utility: a.utility,
        estimatedUnits: pending.estimatedUnits.toFixed(3),
        actualUnits: units.toFixed(3),
        unitPrice: line.unitPrice!.toFixed(4),
        capPerUnit: line.capPerUnit!.toFixed(4),
        utilityTariffVersionId: pending.utilityTariffVersionId,
        ratePlanVersionId: pending.ratePlanVersionId,
        acknowledgementId: line.complianceAcknowledgementId,
        meterAssignmentId: a.id,
        assetItemId: a.assetItemId,
        actualReadingId: actual.id,
      },
    };
  }
}

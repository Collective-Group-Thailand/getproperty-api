import { type Tx } from '@database/prisma.service';
import { positionConsumption } from '@modules/smart-readings/reading-rules';
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

export interface PositionUnits {
  meterAssignmentIds: string[];
  assetItemIds: string[];
  unitId: string | null;
  code: string;
  purpose: 'unit' | 'common_area' | 'main';
  /** Billed units (invoices) — or, for the readings provider, the consumption the readings prove. */
  units: Decimal;
  /** What the meters measured in the period (readings), when `units` are billed units (B4.2). */
  meteredUnits?: Decimal;
  estimated: boolean;
}

/** The units billed to each position of a building in a period (D-032 loss = invoice − billed − common area). */
export interface BilledUnitsProvider {
  readonly source: 'invoices' | 'meter_readings_stub';
  positions(
    tx: Tx,
    buildingId: string,
    utility: 'electric' | 'water',
    from: Date,
    to: Date,
  ): Promise<PositionUnits[]>;
}

export const BILLED_UNITS = Symbol('BILLED_UNITS');

/**
 * The readings-based provider (the B3.4 stub, superseded by `InvoiceBilledUnits` in B4.2, which still uses it for
 * metered units and common-area / main positions): "billed" units are the consumption the accepted `smart.meter_reading`s prove for
 * each position in the window (per unit and utility, or per common-area / main meter code), summed over every
 * assignment of the position (swaps), rollover-aware — the same numbers the billing engine will invoice from (D-030).
 * B4.2 replaces it with Σ of issued `invoice_line` units (`source = 'invoices'`).
 */
@Injectable()
export class MeterReadingsBilledUnits implements BilledUnitsProvider {
  readonly source = 'meter_readings_stub' as const;

  async positions(
    tx: Tx,
    buildingId: string,
    utility: 'electric' | 'water',
    from: Date,
    to: Date,
  ): Promise<PositionUnits[]> {
    const assignments = await tx.meterAssignment.findMany({
      where: {
        buildingId,
        utility,
        validFrom: { lt: to },
        OR: [{ validTo: null }, { validTo: { gt: from } }],
      },
      orderBy: { validFrom: 'asc' },
    });
    const readings = await tx.meterReading.findMany({
      where: {
        meterAssignmentId: { in: assignments.map((a) => a.id) },
        reviewState: 'accepted',
        supersededByReadingId: null,
        readAt: { lte: to },
      },
      select: { meterAssignmentId: true, register: true, readAt: true, source: true },
      orderBy: { readAt: 'asc' },
    });
    const groups = new Map<string, typeof assignments>();
    for (const a of assignments) {
      const key = a.purpose === 'unit' ? `unit|${a.unitId}` : `${a.purpose}|${a.code}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    const out: PositionUnits[] = [];
    for (const group of groups.values()) {
      const ids = new Set(group.map((a) => a.id));
      const own = readings.filter((r) => ids.has(r.meterAssignmentId));
      const units = positionConsumption(
        group.map((a) => ({
          id: a.id,
          validFrom: a.validFrom,
          validTo: a.validTo,
          initialReading: a.initialReading.toString(),
          finalReading: a.finalReading?.toString() ?? null,
          rolloverAt: a.rolloverAt.toString(),
          multiplier: a.multiplier.toString(),
        })),
        own.map((r) => ({
          assignmentId: r.meterAssignmentId,
          register: r.register.toString(),
          readAt: r.readAt,
        })),
        from,
        to,
      );
      const first = group[0]!;
      out.push({
        meterAssignmentIds: group.map((a) => a.id),
        assetItemIds: group.map((a) => a.assetItemId),
        unitId: first.unitId,
        code: first.code,
        purpose: first.purpose,
        units,
        estimated: own.some((r) => r.source === 'estimated' && r.readAt.getTime() >= from.getTime()),
      });
    }
    return out;
  }
}

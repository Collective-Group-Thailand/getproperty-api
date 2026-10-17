import { bangkokDate } from '@common/time/bangkok';
import { type Tx } from '@database/prisma.service';
import {
  type BilledUnitsProvider,
  MeterReadingsBilledUnits,
  type PositionUnits,
} from '@modules/smart-health/billed-units.provider';
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

/**
 * Billed units for the utility loss report from **issued invoices** (B4.2 replaces the B3.4 stub, D-032): a unit's
 * billed units are the units of its issued (not void) electricity/water lines — and estimate settlements — whose
 * period ends inside the loss period; what the meters measured (accepted readings) stays available as
 * `meteredUnits` for the suspects (usage while vacant, anomalies). Common-area and main meters are never invoiced:
 * their positions keep the readings' consumption.
 */
@Injectable()
export class InvoiceBilledUnits implements BilledUnitsProvider {
  readonly source = 'invoices' as const;
  private readonly readings = new MeterReadingsBilledUnits();

  async positions(
    tx: Tx,
    buildingId: string,
    utility: 'electric' | 'water',
    from: Date,
    to: Date,
  ): Promise<PositionUnits[]> {
    const metered = await this.readings.positions(tx, buildingId, utility, from, to);
    const startDay = new Date(`${bangkokDate(new Date(from.getTime() + 59_999))}T00:00:00Z`);
    const endDay = new Date(`${bangkokDate(to)}T00:00:00Z`);
    const lines = await tx.invoiceLine.findMany({
      where: {
        invoice: { buildingId, status: { notIn: ['draft', 'void'] }, unitId: { not: null } },
        lineKind: {
          in:
            utility === 'electric'
              ? ['electricity', 'estimate_settlement']
              : ['water', 'estimate_settlement'],
        },
        unit: utility === 'electric' ? 'kwh' : 'm3',
        periodTo: { gte: startDay, lte: endDay },
      },
      select: { units: true, isEstimated: true, invoice: { select: { unitId: true } } },
    });
    const billed = new Map<string, { units: Decimal; estimated: boolean }>();
    for (const l of lines) {
      const unitId = l.invoice.unitId!;
      const cur = billed.get(unitId) ?? { units: new Decimal(0), estimated: false };
      billed.set(unitId, {
        units: cur.units.plus(l.units?.toString() ?? '0'),
        estimated: cur.estimated || l.isEstimated,
      });
    }
    return metered.map((p) => {
      if (p.purpose !== 'unit' || !p.unitId) return p;
      const b = billed.get(p.unitId);
      return {
        ...p,
        meteredUnits: p.units,
        units: (b?.units ?? new Decimal(0)).toDecimalPlaces(3),
        estimated: p.estimated || (b?.estimated ?? false),
      };
    });
  }
}

import Decimal from 'decimal.js';

/** `loss.suspect_rules` (D-032, Proposed). */
export interface SuspectRules {
  nightFrom: string;
  nightTo: string;
  nightFlowM3Per15m: string;
  anomalySigma: string;
  trailingPeriods: number;
}

export interface PositionInput {
  key: string;
  unitId: string | null;
  unitNo: string | null;
  assetItemIds: string[];
  purpose: 'unit' | 'common_area' | 'main';
  /** What the meters measured in the period (suspects). */
  units: Decimal;
  /** What was billed (issued invoices, B4.2) — the loss uses it; defaults to `units`. */
  billedUnits?: Decimal;
  occupied: boolean | null;
  estimated: boolean;
  stale: boolean;
  /** Nights (Bangkok) with at least one 15-minute bucket of night flow above the threshold. */
  nightFlowNights: number;
  /** Consumption of the same position in the previous periods (newest last). */
  history: Decimal[];
}

export interface SuspectOut {
  kind:
    | 'zero_consumption_occupied'
    | 'usage_while_vacant'
    | 'estimated_reading'
    | 'night_water_flow'
    | 'stale_meter'
    | 'consumption_anomaly';
  key: string;
  unitId: string | null;
  assetItemId: string | null;
  score: Decimal;
  detail: Record<string, string | number | null>;
}

export interface LossNumbers {
  invoiceUnits: Decimal;
  unitBilledUnits: Decimal;
  commonAreaUnits: Decimal;
  lossUnits: Decimal;
  lossPct: Decimal | null;
  lossThb: Decimal;
}

/** D-032: loss = invoice units − Σ unit-billed units − Σ common-area units, in units and THB at `pricePerUnit`. */
export function lossNumbers(
  invoiceUnits: Decimal,
  positions: PositionInput[],
  pricePerUnit: Decimal,
): LossNumbers {
  const billed = positions
    .filter((p) => p.purpose === 'unit')
    .reduce((s, p) => s.plus(p.billedUnits ?? p.units), new Decimal(0));
  const common = positions
    .filter((p) => p.purpose === 'common_area')
    .reduce((s, p) => s.plus(p.units), new Decimal(0));
  const loss = invoiceUnits.minus(billed).minus(common).toDecimalPlaces(3);
  return {
    invoiceUnits: invoiceUnits.toDecimalPlaces(3),
    unitBilledUnits: billed.toDecimalPlaces(3),
    commonAreaUnits: common.toDecimalPlaces(3),
    lossUnits: loss,
    lossPct: invoiceUnits.gt(0) ? loss.div(invoiceUnits).mul(100).toDecimalPlaces(4) : null,
    lossThb: loss.mul(pricePerUnit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
  };
}

const mean = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0)).div(xs.length);
function stddev(xs: Decimal[]): Decimal {
  const m = mean(xs);
  return xs
    .reduce((s, x) => s.plus(x.minus(m).pow(2)), new Decimal(0))
    .div(xs.length)
    .sqrt();
}

/**
 * The suspects of a loss report (D-032): occupied units with zero consumption, consumption in vacant units, positions
 * billed on estimates, night-time water flow, stale or silent meters, and consumption more than `anomalySigma` standard
 * deviations away from the position's trailing periods. Scores 0–100 rank them for the owner (bigger = look first).
 */
export function lossSuspects(
  utility: 'electric' | 'water',
  positions: PositionInput[],
  rules: SuspectRules,
): SuspectOut[] {
  const out: SuspectOut[] = [];
  const sigma = new Decimal(rules.anomalySigma);
  const total = positions.reduce((s, p) => s.plus(p.units), new Decimal(0));
  for (const p of positions) {
    const base = {
      key: p.key,
      unitId: p.unitId,
      assetItemId: p.assetItemIds[p.assetItemIds.length - 1] ?? null,
    };
    const units = p.units.toFixed(3);
    if (p.purpose === 'unit' && p.occupied === true && p.units.eq(0))
      out.push({
        ...base,
        kind: 'zero_consumption_occupied',
        score: new Decimal(60),
        detail: { unitNo: p.unitNo, units },
      });
    if (p.purpose === 'unit' && p.occupied === false && p.units.gt(0)) {
      const share = total.gt(0) ? p.units.div(total).mul(100) : new Decimal(0);
      out.push({
        ...base,
        kind: 'usage_while_vacant',
        score: Decimal.min(100, share.mul(5).plus(40)).toDecimalPlaces(2),
        detail: { unitNo: p.unitNo, units },
      });
    }
    if (p.estimated)
      out.push({
        ...base,
        kind: 'estimated_reading',
        score: new Decimal(50),
        detail: { unitNo: p.unitNo, units },
      });
    if (utility === 'water' && p.nightFlowNights >= 3)
      out.push({
        ...base,
        kind: 'night_water_flow',
        score: Decimal.min(100, new Decimal(p.nightFlowNights).mul(5).plus(50)),
        detail: { unitNo: p.unitNo, nights: p.nightFlowNights, units },
      });
    if (p.stale)
      out.push({ ...base, kind: 'stale_meter', score: new Decimal(40), detail: { unitNo: p.unitNo, units } });
    if (p.history.length >= 3) {
      const m = mean(p.history);
      const sd = stddev(p.history);
      if (sd.gt(0) && p.units.minus(m).abs().gt(sd.mul(sigma)))
        out.push({
          ...base,
          kind: 'consumption_anomaly',
          score: Decimal.min(100, p.units.minus(m).abs().div(sd).mul(15)).toDecimalPlaces(2),
          detail: { unitNo: p.unitNo, units, mean: m.toFixed(3), stddev: sd.toFixed(3) },
        });
    }
  }
  return out.sort(
    (a, b) => b.score.comparedTo(a.score) || a.key.localeCompare(b.key) || a.kind.localeCompare(b.kind),
  );
}

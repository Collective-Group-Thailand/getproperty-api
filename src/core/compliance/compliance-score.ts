import Decimal from 'decimal.js';

/**
 * The tenant compliance score of one month (B4.1.3, ADR-0007) — pure. Four components, each a ratio of lawful
 * outcomes to the outcomes that could have gone wrong in the month:
 *
 * | component            | numerator                                   | denominator                         |
 * |----------------------|---------------------------------------------|-------------------------------------|
 * | invoices_within_rate | issued invoices without a line above the cap | invoices issued in the month         |
 * | above_cap_acknowledged | above-cap lines with the Owner's acknowledgement | invoice lines above the cap (D-021a) |
 * | deposits_on_time     | settlements refunded by their deadline       | settlements due in the month (D-023)  |
 * | standard_contracts   | leases on the สคบ. standard template          | leases in force in the month (D-020)  |
 *
 * The score is the unweighted mean of the components that have a denominator, × 100, rounded half-up to 2 decimals;
 * a month with nothing to judge scores 100. Equal weights are a recorded assumption (D-190) until the B6 analytics
 * review.
 */
export interface ScoreInputs {
  invoicesTotal: number;
  invoicesWithinRate: number;
  linesAboveCap: number;
  linesAboveCapAcknowledged: number;
  depositsDue: number;
  depositsRefundedOnTime: number;
  leasesTotal: number;
  leasesOnStandardTemplate: number;
}

export type ScoreComponentKey =
  'invoices_within_rate' | 'above_cap_acknowledged' | 'deposits_on_time' | 'standard_contracts';

export interface ScoreComponent {
  key: ScoreComponentKey;
  numerator: number;
  denominator: number;
  /** 4 decimals, null when there was nothing to judge (left out of the mean). */
  ratio: string | null;
}

export interface ScoreResult {
  score: string;
  components: ScoreComponent[];
}

export function complianceScore(i: ScoreInputs): ScoreResult {
  const pairs: [ScoreComponentKey, number, number][] = [
    ['invoices_within_rate', i.invoicesWithinRate, i.invoicesTotal],
    ['above_cap_acknowledged', i.linesAboveCapAcknowledged, i.linesAboveCap],
    ['deposits_on_time', i.depositsRefundedOnTime, i.depositsDue],
    ['standard_contracts', i.leasesOnStandardTemplate, i.leasesTotal],
  ];
  for (const [key, n, d] of pairs)
    if (!Number.isInteger(n) || !Number.isInteger(d) || n < 0 || d < 0 || n > d)
      throw new RangeError(`compliance score component ${key}: ${n}/${d}`);
  const components = pairs.map(([key, numerator, denominator]) => ({
    key,
    numerator,
    denominator,
    ratio: denominator === 0 ? null : new Decimal(numerator).div(denominator).toDecimalPlaces(4).toFixed(4),
  }));
  const judged = components.filter((c) => c.denominator > 0);
  const score = judged.length
    ? judged
        .reduce((sum, c) => sum.plus(new Decimal(c.numerator).div(c.denominator)), new Decimal(0))
        .div(judged.length)
        .times(100)
    : new Decimal(100);
  return { score: score.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2), components };
}

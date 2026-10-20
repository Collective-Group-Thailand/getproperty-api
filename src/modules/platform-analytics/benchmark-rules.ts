import Decimal from 'decimal.js';

/** The smallest number of tenants a benchmark bucket may describe (k-anonymity, D-217; the table CHECKs it too). */
export const BENCHMARK_MIN_K = 5;

export const BENCHMARK_METRICS = ['loss_pct', 'on_time_payment_pct', 'rent_per_m2'] as const;
export type BenchmarkMetric = (typeof BENCHMARK_METRICS)[number];

/** Size band of a tenant by the units it bills (the D-156 unit count). */
export function sizeBand(units: number): string {
  if (units < 20) return 'lt20';
  if (units < 50) return '20-49';
  if (units < 100) return '50-99';
  return '100plus';
}

/** Normalised `province/district` key of a building address (Thai names kept, spaces collapsed). */
export function districtKey(address: unknown): string | null {
  if (!address || typeof address !== 'object') return null;
  const a = address as Record<string, unknown>;
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : '');
  const district = norm(a.district);
  if (!district) return null;
  return `district:${norm(a.province) || '-'}/${district}`;
}

/** Linear-interpolated percentile (the "R-7" definition) of sorted values. */
export function percentile(sorted: readonly Decimal[], p: number): Decimal {
  if (!sorted.length) throw new Error('percentile of nothing');
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo]!.plus(sorted[hi]!.minus(sorted[lo]!).times(h - lo));
}

export interface BucketStats {
  k: number;
  p25: string;
  p50: string;
  p75: string;
}

/**
 * Percentiles of one value per tenant, or null when fewer than `BENCHMARK_MIN_K` tenants contribute — a bucket that
 * small could point at a tenant, so it is never published (k-anonymity).
 */
export function bucketStats(values: readonly Decimal.Value[]): BucketStats | null {
  if (values.length < BENCHMARK_MIN_K) return null;
  const sorted = values.map((v) => new Decimal(v)).sort((a, b) => a.comparedTo(b));
  const f = (d: Decimal) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
  return {
    k: sorted.length,
    p25: f(percentile(sorted, 0.25)),
    p50: f(percentile(sorted, 0.5)),
    p75: f(percentile(sorted, 0.75)),
  };
}

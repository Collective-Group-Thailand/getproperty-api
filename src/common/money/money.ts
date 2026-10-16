import Decimal from 'decimal.js';

/**
 * Money in code is `Decimal`, in JSON a string with exactly 2 decimals, in the database
 * `numeric(14,2)` (CLAUDE.md hard rules, contract §3). The frontend never does price arithmetic.
 */
export const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type MoneyValue = InstanceType<typeof MoneyDecimal>;

const MONEY_STRING = /^-?\d{1,12}(\.\d{1,2})?$/;
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/** Parses a money string (≤ 12 integer digits, ≤ 2 decimals — `numeric(14,2)`). */
export function parseMoney(value: string): MoneyValue {
  if (!MONEY_STRING.test(value)) throw new RangeError(`Not a money amount: ${value}`);
  return new MoneyDecimal(value);
}

/** Parses any plain decimal string (percentages, unit rates). */
export function parseDecimal(value: string | number): MoneyValue {
  const text = typeof value === 'number' ? String(value) : value;
  if (!DECIMAL_STRING.test(text)) throw new RangeError(`Not a decimal: ${text}`);
  return new MoneyDecimal(text);
}

/**
 * Formats to the 2-decimal wire format. Rounding is half-up to satang per line, then the bill total
 * (D-046); the billing engine (B4) passes the mode explicitly where a decision says otherwise.
 */
export function formatMoney(
  value: Decimal.Value,
  rounding: Decimal.Rounding = Decimal.ROUND_HALF_UP,
): string {
  return new MoneyDecimal(value).toDecimalPlaces(2, rounding).toFixed(2);
}

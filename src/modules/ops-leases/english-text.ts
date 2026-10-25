import Decimal from 'decimal.js';

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: [bigint, string][] = [
  [1_000_000_000n, 'billion'],
  [1_000_000n, 'million'],
  [1_000n, 'thousand'],
];
const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function belowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest >= 20)
    parts.push(rest % 10 ? `${TENS[Math.floor(rest / 10)]}-${ONES[rest % 10]}` : TENS[rest / 10]!);
  else if (rest) parts.push(ONES[rest]!);
  return parts.join(' ');
}

function integerWords(n: bigint): string {
  if (n === 0n) return ONES[0]!;
  const parts: string[] = [];
  let rest = n;
  for (const [size, name] of SCALES) {
    if (rest >= size) {
      parts.push(`${integerWords(rest / size)} ${name}`);
      rest %= size;
    }
  }
  if (rest > 0n) parts.push(belowThousand(Number(rest)));
  return parts.join(' ');
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Baht in English words for the English and bilingual documents (D-253): `15000` → `Fifteen thousand baht only`,
 * `1250.50` → `One thousand two hundred fifty baht and fifty satang`. Rounded half-up to satang like `bahtText`.
 */
export function bahtTextEn(amount: string | number | Decimal): string {
  const value = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (value.isNegative()) return `Minus ${bahtTextEn(value.negated()).toLowerCase()}`;
  const [whole = '0', fraction = '00'] = value.toFixed(2).split('.');
  const baht = BigInt(whole);
  const satang = Number(fraction);
  if (baht === 0n && satang === 0) return 'Zero baht only';
  if (baht === 0n) return capitalise(`${belowThousand(satang)} satang`);
  const head = `${integerWords(baht)} baht`;
  return capitalise(satang === 0 ? `${head} only` : `${head} and ${belowThousand(satang)} satang`);
}

/** `2026-11-01` → `1 November 2026` (Gregorian, the form used in English leases). */
export function englishDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`not a date: ${isoDate}`);
  return `${Number(m[3])} ${MONTHS_EN[Number(m[2]) - 1]} ${m[1]}`;
}

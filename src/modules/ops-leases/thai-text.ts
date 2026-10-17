import Decimal from 'decimal.js';

const DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
const MONTHS_TH = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

/** Reads 0 < n < 1,000,000 in Thai (เอ็ด for a trailing one, ยี่ for twenty). */
function belowMillion(n: number): string {
  const digits = String(n).split('').map(Number);
  let out = '';
  digits.forEach((d, i) => {
    const place = digits.length - 1 - i;
    if (d === 0) return;
    if (place === 0 && d === 1 && digits.length > 1) out += 'เอ็ด';
    else if (place === 1 && d === 2) out += 'ยี่สิบ';
    else if (place === 1 && d === 1) out += 'สิบ';
    else out += DIGITS[d]! + PLACES[place]!;
  });
  return out;
}

function integerText(n: bigint): string {
  if (n === 0n) return DIGITS[0]!;
  const million = 1_000_000n;
  if (n < million) return belowMillion(Number(n));
  const high = n / million;
  const low = n % million;
  return `${integerText(high)}ล้าน${low === 0n ? '' : belowMillion(Number(low))}`;
}

/**
 * Baht in Thai words, the way contracts and receipts spell amounts: `4500.00` → `สี่พันห้าร้อยบาทถ้วน`,
 * `1250.50` → `หนึ่งพันสองร้อยห้าสิบบาทห้าสิบสตางค์`. Amounts are rounded half-up to satang (D-046).
 */
export function bahtText(amount: string | number | Decimal): string {
  const value = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (value.isNegative()) return `ลบ${bahtText(value.negated())}`;
  const [whole = '0', fraction = '00'] = value.toFixed(2).split('.');
  const satang = Number(fraction);
  const baht = BigInt(whole);
  if (baht === 0n && satang === 0) return 'ศูนย์บาทถ้วน';
  const head = baht === 0n ? '' : `${integerText(baht)}บาท`;
  return satang === 0 ? `${head}ถ้วน` : `${head}${belowMillion(satang)}สตางค์`;
}

/** `4,500.00` — money with thousands separators for documents (the API itself sends `4500.00`). */
export function formatThb(amount: string | number | Decimal): string {
  const [whole = '0', fraction = '00'] = new Decimal(amount)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2)
    .split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** `2026-11-01` → `1 พฤศจิกายน พ.ศ. 2569` (Buddhist era, the form used in Thai contracts). */
export function thaiDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`not a date: ${isoDate}`);
  return `${Number(m[3])} ${MONTHS_TH[Number(m[2]) - 1]} พ.ศ. ${Number(m[1]) + 543}`;
}

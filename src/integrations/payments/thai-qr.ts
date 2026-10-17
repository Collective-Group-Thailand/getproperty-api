/**
 * EMVCo merchant-presented QR for Thai QR Payment (Bank of Thailand / Thai Bankers' Association "Thai QR Code
 * Payment" standard): **Tag 30 — bill payment** with the biller id (tax id + 2-digit suffix, 15 digits) and the
 * references; amount (Tag 54) in THB (currency 764); CRC-16/CCITT-FALSE (Tag 63). Pure; used by the fake provider
 * and by tests to read back what a provider returned.
 */
const AID_BILL_PAYMENT = 'A000000677010112';

const tlv = (tag: string, value: string): string => {
  if (value.length > 99) throw new RangeError(`EMV value of tag ${tag} longer than 99`);
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
};

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), upper-case hex, over the payload including "6304". */
export function crc16(data: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(data, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** References: upper-case alphanumerics only, ≤ 20 characters (Tag 30 sub-tags 02 / 03). */
export const qrReference = (s: string): string =>
  s
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 20);

export function buildThaiQrBillPayment(input: {
  billerId: string;
  ref1: string;
  ref2?: string | null;
  amount: string;
  merchantName?: string | null;
}): string {
  if (!/^\d{15}$/.test(input.billerId)) throw new RangeError('biller id must be 15 digits');
  if (!/^\d{1,10}\.\d{2}$/.test(input.amount)) throw new RangeError('amount must be a decimal with 2 places');
  const merchant =
    tlv('00', AID_BILL_PAYMENT) +
    tlv('01', input.billerId) +
    tlv('02', qrReference(input.ref1)) +
    (input.ref2 ? tlv('03', qrReference(input.ref2)) : '');
  const body =
    tlv('00', '01') + // payload format indicator
    tlv('01', '12') + // dynamic (one-time) QR
    tlv('30', merchant) +
    tlv('53', '764') +
    tlv('54', input.amount) +
    tlv('58', 'TH') +
    (input.merchantName
      ? tlv('59', input.merchantName.replace(/[^\x20-\x7E]/g, '').slice(0, 25) || 'MERCHANT')
      : '') +
    '6304';
  return body + crc16(body);
}

export interface ParsedThaiQr {
  dynamic: boolean;
  billerId: string | null;
  ref1: string | null;
  ref2: string | null;
  amount: string | null;
  currency: string | null;
  crcValid: boolean;
}

function readTlv(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    out.set(tag, s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

export function parseThaiQr(payload: string): ParsedThaiQr {
  const top = readTlv(payload);
  const bill = top.has('30') ? readTlv(top.get('30')!) : new Map<string, string>();
  const crc = top.get('63') ?? '';
  return {
    dynamic: top.get('01') === '12',
    billerId: bill.get('01') ?? null,
    ref1: bill.get('02') ?? null,
    ref2: bill.get('03') ?? null,
    amount: top.get('54') ?? null,
    currency: top.get('53') ?? null,
    crcValid: crc16(payload.slice(0, payload.length - 4)) === crc,
  };
}

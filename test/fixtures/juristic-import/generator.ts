import Decimal from 'decimal.js';

/**
 * Synthetic legacy-system export of a condominium for the J3.1 import tests (D-332): `units` units on floors of 20,
 * every 10th unit (index ≡ 5) with two co-owners 60 / 40, every 100th (index ≡ 7) billed to an agency, `arrears` units
 * in arrears (1–3 months of common fee, a surcharge on the oldest month of 2–3 month debts, a fund half-year on every
 * 8th unit), four payments per unit in the last months, an operating and a fund bank balance, and the legacy bills of
 * the parallel cycle (one unit deliberately 50.00 off). Deterministic — no randomness.
 */

export interface GeneratedImport {
  register: string;
  openingBalance: string;
  paymentHistory: string;
  bankBalance: string;
  legacyBills: (periodKey: string) => string;
  expected: {
    units: number;
    owners: number;
    ownerships: number;
    billTos: number;
    unitsInArrears: number;
    principal: string;
    surcharge: string;
    receivables: string;
    historyCount: number;
    historyAmount: string;
    bankOperating: string;
    bankFund: string;
  };
  unitNos: string[];
  feeOf: (unitNo: string) => string;
  differentUnit: string;
}

export const RATE_PER_SQM = '30.00';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (header: readonly string[], rows: readonly (readonly string[])[]) =>
  `\uFEFF${[header, ...rows].map((r) => r.map(field).join(',')).join('\r\n')}\r\n`;

export function generateImport(opts: {
  units: number;
  arrears: number;
  asOf: string;
  operatingLast4: string;
  /** Extra register rows appended as-is (e.g. a pre-existing unit). */
  extraRegister?: string[][];
}): GeneratedImport {
  const unitNos: string[] = [];
  const area = new Map<string, string>();
  const reg: string[][] = [];
  let owners = 0;
  let billTos = 0;
  for (let i = 0; i < opts.units; i += 1) {
    const floor = Math.floor(i / 20) + 1;
    const unitNo = `A-${pad(floor)}${pad((i % 20) + 1)}`;
    unitNos.push(unitNo);
    const a = new Decimal(28).plus(new Decimal(3.25).times(i % 9)).toFixed(2);
    area.set(unitNo, a);
    const phone = `08${pad(10_000_000 + i, 8)}`;
    const two = i % 10 === 5;
    const bill = i % 100 === 7;
    if (bill) billTos += 1;
    const base = [
      'อาคาร A',
      String(floor),
      unitNo,
      'condo_unit',
      '',
      '',
      a,
      '',
      `OW-${pad(i + 1, 4)}`,
      `เจ้าของ ${i + 1}`,
      'person',
      'thai_national_id',
      String(1000 + (i % 9000)),
      phone,
      i % 3 === 0 ? `owner${i + 1}@example.com` : '',
      '',
      two ? '60' : '',
      '2020-01-15',
      bill ? `บริษัท ตัวแทน ${i}` : '',
      bill ? 'agency' : '',
      bill ? `02${pad(1_000_000 + i, 7)}` : '',
      '',
    ];
    reg.push(base);
    owners += 1;
    if (two) {
      reg.push([
        'อาคาร A',
        String(floor),
        unitNo,
        'condo_unit',
        '',
        '',
        a,
        '',
        `OW-B${pad(i + 1, 4)}`,
        `เจ้าของร่วม ${i + 1}`,
        'person',
        'passport',
        `P${pad(i % 1000, 3)}`,
        `09${pad(10_000_000 + i, 8)}`,
        '',
        '',
        '40',
        '2021-03-01',
        '',
        '',
        '',
        '',
      ]);
      owners += 1;
    }
  }
  for (const r of opts.extraRegister ?? []) reg.push(r);
  const register = csv(
    [
      'อาคาร (building)',
      'ชั้น / ซอย (floor)',
      'เลขที่ห้อง / แปลง (unit_no) *',
      'ประเภท (unit_type)',
      'เลขที่แปลง (plot_no)',
      'เนื้อที่ดิน (ตร.ว.) (land_area_sqwa)',
      'พื้นที่ (ตร.ม.) (area_sqm)',
      'อัตราส่วนกรรมสิทธิ์ (ownership_ratio)',
      'รหัสเจ้าของ (ระบบเดิม) (owner_code)',
      'ชื่อเจ้าของ (owner_name) *',
      'ประเภทเจ้าของ (owner_type)',
      'ประเภทบัตร (id_type)',
      'เลขบัตร 4 หลักท้าย (id_last4)',
      'โทรศัพท์ (phone)',
      'อีเมล (email)',
      'LINE ID (line_id)',
      'สัดส่วนการถือครอง (%) (share_pct)',
      'เป็นเจ้าของตั้งแต่ (owned_since)',
      'ผู้รับใบแจ้งหนี้แทน (bill_to_name)',
      'ประเภทผู้รับใบแจ้งหนี้ (bill_to_kind)',
      'โทรศัพท์ผู้รับใบแจ้งหนี้ (bill_to_phone)',
      'อีเมลผู้รับใบแจ้งหนี้ (bill_to_email)',
    ],
    reg,
  );

  const fee = (unitNo: string) => new Decimal(area.get(unitNo)!).times(RATE_PER_SQM).toDecimalPlaces(2);
  const [y, m] = opts.asOf.split('-').map(Number) as [number, number];
  const monthBack = (k: number) => {
    const d = new Date(Date.UTC(y, m - 1 - k, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  };
  const ob: string[][] = [];
  let principal = new Decimal(0);
  let surcharge = new Decimal(0);
  let inArrears = 0;
  for (let i = 0; i < opts.units && inArrears < opts.arrears; i += 4) {
    const unitNo = unitNos[i]!;
    inArrears += 1;
    const months = 1 + (i % 3);
    for (let k = months - 1; k >= 0; k -= 1) {
      const p = fee(unitNo);
      const s = months >= 2 && k === months - 1 ? new Decimal('25.00') : new Decimal(0);
      ob.push([
        unitNo,
        `OW-${pad(i + 1, 4)}`,
        '',
        'ค่าส่วนกลาง',
        monthBack(k),
        p.toFixed(2),
        s.gt(0) ? s.toFixed(2) : '',
        '',
      ]);
      principal = principal.plus(p);
      surcharge = surcharge.plus(s);
    }
    if (i % 8 === 0) {
      ob.push([unitNo, `OW-${pad(i + 1, 4)}`, '', 'fund', `${y}-H1`, '1200.00', '', opts.asOf]);
      principal = principal.plus('1200.00');
    }
  }
  const openingBalance = csv(
    ['unit_no', 'owner_code', 'owner_name', 'charge', 'period', 'principal', 'surcharge', 'as_of'],
    ob,
  );

  const hist: string[][] = [];
  let historyAmount = new Decimal(0);
  for (let i = 0; i < opts.units; i += 1) {
    const unitNo = unitNos[i]!;
    for (let k = 5; k >= 2; k -= 1) {
      const [py, pm] = monthBack(k).split('-');
      const amount = fee(unitNo);
      hist.push([
        unitNo,
        `OW-${pad(i + 1, 4)}`,
        '',
        `05/${pm}/${Number(py) + 543}`,
        amount.toFixed(2),
        'โอน',
        `RC${i}-${pm}`,
      ]);
      historyAmount = historyAmount.plus(amount);
    }
  }
  const paymentHistory = csv(
    [
      'Unit no. (unit_no)',
      'Owner code (legacy) (owner_code)',
      'Owner name (owner_name)',
      'Paid on (paid_on)',
      'Amount (amount)',
      'Method (method)',
      'Reference (reference)',
    ],
    hist,
  );

  const bankBalance = csv(
    ['account_type', 'bank_account_last4', 'fund_name', 'balance', 'as_of'],
    [
      ['operating', opts.operatingLast4, '', '152,300.55', opts.asOf],
      ['fund', '', '', '880000.00', opts.asOf],
    ],
  );

  const differentUnit = unitNos[3]!;
  const legacyBills = (periodKey: string) =>
    csv(
      ['unit_no', 'amount', 'period'],
      unitNos.map((u) => [u, (u === differentUnit ? fee(u).plus(50) : fee(u)).toFixed(2), periodKey]),
    );

  return {
    register,
    openingBalance,
    paymentHistory,
    bankBalance,
    legacyBills,
    expected: {
      units: opts.units,
      owners,
      ownerships: owners,
      billTos,
      unitsInArrears: inArrears,
      principal: principal.toFixed(2),
      surcharge: surcharge.toFixed(2),
      receivables: principal.plus(surcharge).toFixed(2),
      historyCount: hist.length,
      historyAmount: historyAmount.toFixed(2),
      bankOperating: '152300.55',
      bankFund: '880000.00',
    },
    unitNos,
    feeOf: (u) => fee(u).toFixed(2),
    differentUnit,
  };
}

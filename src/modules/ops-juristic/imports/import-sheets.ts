import { normalisePhone } from '@core/identity/phone';
import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';

/**
 * Sheets of the legacy-system import (D-313, D-332): the column specs the templates, the parser, the validation and
 * the bad-rows file share. Pure — no database. A header cell may be the column key, its Thai or English label, or
 * `label (key)` (what the templates write); a row whose first cell starts with `#` is an example and is skipped.
 */

export type SheetKey = 'register' | 'opening_balance' | 'payment_history' | 'bank_balance' | 'legacy_bills';
export const SHEET_KEYS: readonly SheetKey[] = [
  'register',
  'opening_balance',
  'payment_history',
  'bank_balance',
  'legacy_bills',
];
/** The sheets a job commits (legacy bills belong to the parallel cycle, after the commit). */
export const COMMIT_SHEETS: readonly SheetKey[] = [
  'register',
  'opening_balance',
  'payment_history',
  'bank_balance',
];
export const REQUIRED_SHEETS: readonly SheetKey[] = ['register', 'opening_balance'];

export type Language = 'th' | 'en';
export type CellType =
  | 'text'
  | 'floor'
  | 'money'
  | 'area'
  | 'ratio'
  | 'share'
  | 'date'
  | 'period'
  | 'enum'
  | 'phone'
  | 'email'
  | 'id_last4';

export interface ColumnSpec {
  key: CellKey;
  th: string;
  en: string;
  type: CellType;
  required?: boolean;
  values?: readonly string[];
  /** Thai / English words accepted for an enum value. */
  aliases?: Readonly<Record<string, string>>;
  max?: number;
  noteTh: string;
  noteEn: string;
  examples: readonly [string, string];
}

export interface SheetSpec {
  key: SheetKey;
  th: string;
  en: string;
  columns: readonly ColumnSpec[];
}

const METHOD_ALIASES = {
  เงินสด: 'cash',
  โอน: 'transfer',
  โอนเงิน: 'transfer',
  เช็ค: 'cheque',
  พร้อมเพย์: 'promptpay',
  บัตร: 'card',
  อื่นๆ: 'other',
  check: 'cheque',
} as const;

export const SHEETS: Readonly<Record<SheetKey, SheetSpec>> = {
  register: {
    key: 'register',
    th: 'ทะเบียนเจ้าของร่วม',
    en: 'Co-owner register',
    columns: [
      {
        key: 'building',
        th: 'อาคาร',
        en: 'Building',
        type: 'text',
        max: 200,
        noteTh: 'ไม่บังคับ — ถ้าใส่ต้องตรงกับชื่อหรือรหัสอาคารของงานนำเข้านี้',
        noteEn: 'Optional — when given it must be the name or code of this import’s building',
        examples: ['อาคาร A', 'อาคาร A'],
      },
      {
        key: 'floor',
        th: 'ชั้น / ซอย',
        en: 'Floor / soi',
        type: 'floor',
        max: 100,
        noteTh: 'เลขชั้น (เช่น 12) หรือชื่อซอย / โซน (เช่น ซอย 3) — ที่ยังไม่มีจะสร้างให้',
        noteEn: 'A floor level (e.g. 12) or a soi / zone name (e.g. Soi 3) — missing ones are created',
        examples: ['12', '12'],
      },
      {
        key: 'unit_no',
        th: 'เลขที่ห้อง / แปลง',
        en: 'Unit no.',
        type: 'text',
        required: true,
        max: 50,
        noteTh: 'บังคับ — หนึ่งแถวต่อเจ้าของหนึ่งคน ห้องที่มีเจ้าของร่วมหลายคนใส่หลายแถว',
        noteEn: 'Required — one row per owner; a unit with several co-owners takes several rows',
        examples: ['A-1201', 'A-1201'],
      },
      {
        key: 'unit_type',
        th: 'ประเภท',
        en: 'Unit type',
        type: 'enum',
        values: ['condo_unit', 'house', 'plot', 'shop', 'parking'],
        aliases: { ห้องชุด: 'condo_unit', บ้าน: 'house', แปลง: 'plot', ร้านค้า: 'shop', ที่จอดรถ: 'parking' },
        noteTh: 'condo_unit · house · plot · shop · parking (ว่าง = ตามประเภทอาคาร)',
        noteEn: 'condo_unit · house · plot · shop · parking (blank = by building type)',
        examples: ['condo_unit', 'condo_unit'],
      },
      {
        key: 'plot_no',
        th: 'เลขที่แปลง',
        en: 'Plot no.',
        type: 'text',
        max: 50,
        noteTh: 'ไม่บังคับ (หมู่บ้านจัดสรร)',
        noteEn: 'Optional (housing estates)',
        examples: ['', ''],
      },
      {
        key: 'land_area_sqwa',
        th: 'เนื้อที่ดิน (ตร.ว.)',
        en: 'Land area (sq. wah)',
        type: 'area',
        noteTh: 'ไม่บังคับ — ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง',
        noteEn: 'Optional — a number with up to 2 decimals',
        examples: ['', ''],
      },
      {
        key: 'area_sqm',
        th: 'พื้นที่ (ตร.ม.)',
        en: 'Area (sq. m)',
        type: 'area',
        noteTh: 'ไม่บังคับ — ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง',
        noteEn: 'Optional — a number with up to 2 decimals',
        examples: ['34.77', '34.77'],
      },
      {
        key: 'ownership_ratio',
        th: 'อัตราส่วนกรรมสิทธิ์',
        en: 'Ownership ratio',
        type: 'ratio',
        noteTh: 'ไม่บังคับ — 0 ถึง 1 ทศนิยมไม่เกิน 6 ตำแหน่ง (เช่น 0.012345)',
        noteEn: 'Optional — 0 to 1 with up to 6 decimals (e.g. 0.012345)',
        examples: ['0.012345', '0.012345'],
      },
      {
        key: 'owner_code',
        th: 'รหัสเจ้าของ (ระบบเดิม)',
        en: 'Owner code (legacy)',
        type: 'text',
        max: 50,
        noteTh: 'ไม่บังคับ — ใช้อ้างถึงเจ้าของในไฟล์ยอดยกมาและประวัติการชำระ',
        noteEn: 'Optional — how the balances and payment history files refer to the owner',
        examples: ['OW-0001', 'OW-0002'],
      },
      {
        key: 'owner_name',
        th: 'ชื่อเจ้าของ',
        en: 'Owner name',
        type: 'text',
        required: true,
        max: 200,
        noteTh: 'บังคับ — ชื่อ-นามสกุล หรือชื่อนิติบุคคล',
        noteEn: 'Required — full name or company name',
        examples: ['สมชาย ใจดี', 'สมศรี ใจดี'],
      },
      {
        key: 'owner_type',
        th: 'ประเภทเจ้าของ',
        en: 'Owner type',
        type: 'enum',
        values: ['person', 'company'],
        aliases: { บุคคล: 'person', บุคคลธรรมดา: 'person', นิติบุคคล: 'company', บริษัท: 'company' },
        noteTh: 'person · company (ว่าง = person)',
        noteEn: 'person · company (blank = person)',
        examples: ['person', 'person'],
      },
      {
        key: 'id_type',
        th: 'ประเภทบัตร',
        en: 'ID type',
        type: 'enum',
        values: ['thai_national_id', 'passport', 'other'],
        aliases: {
          บัตรประชาชน: 'thai_national_id',
          พาสปอร์ต: 'passport',
          หนังสือเดินทาง: 'passport',
          อื่นๆ: 'other',
        },
        noteTh: 'ไม่บังคับ — thai_national_id · passport · other',
        noteEn: 'Optional — thai_national_id · passport · other',
        examples: ['thai_national_id', 'thai_national_id'],
      },
      {
        key: 'id_last4',
        th: 'เลขบัตร 4 หลักท้าย',
        en: 'ID last 4',
        type: 'id_last4',
        noteTh:
          'ไม่บังคับ — เฉพาะ 4 หลักท้ายเท่านั้น (หรือแบบปิดบัง เช่น XXXXXXXXX1234) ระบบไม่รับเลขบัตรเต็ม',
        noteEn:
          'Optional — the last 4 characters only (or masked, e.g. XXXXXXXXX1234); full ID numbers are refused',
        examples: ['1234', '5678'],
      },
      {
        key: 'phone',
        th: 'โทรศัพท์',
        en: 'Phone',
        type: 'phone',
        noteTh: 'ไม่บังคับ — เช่น 081-234-5678 (ใช้ส่ง OTP เชิญเจ้าของร่วมเข้า LINE)',
        noteEn: 'Optional — e.g. 081-234-5678 (the co-owner’s LINE invitation OTP goes there)',
        examples: ['081-234-5678', '089-765-4321'],
      },
      {
        key: 'email',
        th: 'อีเมล',
        en: 'E-mail',
        type: 'email',
        noteTh: 'ไม่บังคับ',
        noteEn: 'Optional',
        examples: ['somchai@example.com', ''],
      },
      {
        key: 'line_id',
        th: 'LINE ID',
        en: 'LINE ID',
        type: 'text',
        max: 100,
        noteTh: 'ไม่บังคับ — เก็บไว้ในแถวนำเข้าเท่านั้น การเชื่อม LINE ทำโดยเจ้าของผ่านคำเชิญ',
        noteEn: 'Optional — kept on the import row only; LINE is linked by the owner through the invitation',
        examples: ['', ''],
      },
      {
        key: 'share_pct',
        th: 'สัดส่วนการถือครอง (%)',
        en: 'Share (%)',
        type: 'share',
        noteTh: 'ไม่บังคับ — ว่าง = 100 หารด้วยจำนวนเจ้าของของห้อง รวมต่อห้องไม่เกิน 100',
        noteEn: 'Optional — blank = 100 ÷ the unit’s owners; at most 100 per unit',
        examples: ['60', '40'],
      },
      {
        key: 'owned_since',
        th: 'เป็นเจ้าของตั้งแต่',
        en: 'Owned since',
        type: 'date',
        noteTh: 'ไม่บังคับ — YYYY-MM-DD หรือ วว/ดด/ปปปป (พ.ศ. ได้) ว่าง = วันที่ยอดยกมา',
        noteEn: 'Optional — YYYY-MM-DD or DD/MM/YYYY (Buddhist year accepted); blank = the as-of date',
        examples: ['2020-05-01', '2020-05-01'],
      },
      {
        key: 'bill_to_name',
        th: 'ผู้รับใบแจ้งหนี้แทน',
        en: 'Bill-to name',
        type: 'text',
        max: 200,
        noteTh: 'ไม่บังคับ — ผู้ชำระแทนเจ้าของ (ต้องแนบเอกสารยินยอมของเจ้าของตอนนำเข้า)',
        noteEn: 'Optional — who pays for the owner (the owners’ signed consents are attached at commit)',
        examples: ['', ''],
      },
      {
        key: 'bill_to_kind',
        th: 'ประเภทผู้รับใบแจ้งหนี้',
        en: 'Bill-to kind',
        type: 'enum',
        values: ['named_party', 'agency'],
        aliases: { บุคคล: 'named_party', ตัวแทน: 'agency', เอเจนซี่: 'agency' },
        noteTh: 'named_party · agency (ว่าง = named_party)',
        noteEn: 'named_party · agency (blank = named_party)',
        examples: ['', ''],
      },
      {
        key: 'bill_to_phone',
        th: 'โทรศัพท์ผู้รับใบแจ้งหนี้',
        en: 'Bill-to phone',
        type: 'phone',
        noteTh: 'ไม่บังคับ',
        noteEn: 'Optional',
        examples: ['', ''],
      },
      {
        key: 'bill_to_email',
        th: 'อีเมลผู้รับใบแจ้งหนี้',
        en: 'Bill-to e-mail',
        type: 'email',
        noteTh: 'ไม่บังคับ',
        noteEn: 'Optional',
        examples: ['', ''],
      },
    ],
  },
  opening_balance: {
    key: 'opening_balance',
    th: 'ยอดค้างชำระยกมา',
    en: 'Opening balances',
    columns: [
      {
        key: 'unit_no',
        th: 'เลขที่ห้อง / แปลง',
        en: 'Unit no.',
        type: 'text',
        required: true,
        max: 50,
        noteTh: 'บังคับ — ต้องอยู่ในไฟล์ทะเบียน',
        noteEn: 'Required — must be in the register file',
        examples: ['A-1201', 'A-1201'],
      },
      {
        key: 'owner_code',
        th: 'รหัสเจ้าของ (ระบบเดิม)',
        en: 'Owner code (legacy)',
        type: 'text',
        max: 50,
        noteTh: 'รหัสเจ้าของในไฟล์ทะเบียน (หรือใส่ชื่อเจ้าของ) ว่างได้ถ้าห้องมีเจ้าของคนเดียว',
        noteEn: 'The owner code of the register (or the owner name); blank when the unit has one owner',
        examples: ['OW-0001', 'OW-0001'],
      },
      {
        key: 'owner_name',
        th: 'ชื่อเจ้าของ',
        en: 'Owner name',
        type: 'text',
        max: 200,
        noteTh: 'ใช้เมื่อไม่มีรหัสเจ้าของ',
        noteEn: 'Used when there is no owner code',
        examples: ['', ''],
      },
      {
        key: 'charge',
        th: 'ประเภทค่าใช้จ่าย',
        en: 'Charge',
        type: 'enum',
        values: ['common_fee', 'fund'],
        aliases: { ค่าส่วนกลาง: 'common_fee', กองทุน: 'fund', เงินกองทุน: 'fund' },
        noteTh: 'common_fee · fund (ว่าง = common_fee)',
        noteEn: 'common_fee · fund (blank = common_fee)',
        examples: ['common_fee', 'fund'],
      },
      {
        key: 'period',
        th: 'งวด',
        en: 'Period',
        type: 'period',
        required: true,
        noteTh: 'บังคับ — YYYY-MM · YYYY-Qn · YYYY-Hn · YYYY (พ.ศ. ได้) และต้องสิ้นสุดไม่เกินวันที่ยอดยกมา',
        noteEn:
          'Required — YYYY-MM · YYYY-Qn · YYYY-Hn · YYYY (Buddhist year accepted); must end by the as-of date',
        examples: ['2026-07', '2026-H2'],
      },
      {
        key: 'principal',
        th: 'เงินต้นค้างชำระ',
        en: 'Principal',
        type: 'money',
        noteTh: 'จำนวนเงิน เช่น 1043.10',
        noteEn: 'An amount, e.g. 1043.10',
        examples: ['1043.10', '1500.00'],
      },
      {
        key: 'surcharge',
        th: 'เงินเพิ่ม',
        en: 'Surcharge',
        type: 'money',
        noteTh: 'ไม่บังคับ — เงินเพิ่มที่ระบบเดิมคิดไว้แล้ว',
        noteEn: 'Optional — the surcharge the legacy system already charged',
        examples: ['25.00', ''],
      },
      {
        key: 'as_of',
        th: 'ณ วันที่',
        en: 'As of',
        type: 'date',
        noteTh: 'ไม่บังคับ — ถ้าใส่ต้องตรงกับวันที่ยอดยกมาของงานนำเข้า',
        noteEn: 'Optional — when given it must be the import’s as-of date',
        examples: ['', ''],
      },
    ],
  },
  payment_history: {
    key: 'payment_history',
    th: 'ประวัติการชำระ 12 เดือน',
    en: 'Payment history (12 months)',
    columns: [
      {
        key: 'unit_no',
        th: 'เลขที่ห้อง / แปลง',
        en: 'Unit no.',
        type: 'text',
        required: true,
        max: 50,
        noteTh: 'บังคับ — ต้องอยู่ในไฟล์ทะเบียน',
        noteEn: 'Required — must be in the register file',
        examples: ['A-1201', 'A-1201'],
      },
      {
        key: 'owner_code',
        th: 'รหัสเจ้าของ (ระบบเดิม)',
        en: 'Owner code (legacy)',
        type: 'text',
        max: 50,
        noteTh: 'ไม่บังคับ',
        noteEn: 'Optional',
        examples: ['OW-0001', 'OW-0002'],
      },
      {
        key: 'owner_name',
        th: 'ชื่อเจ้าของ',
        en: 'Owner name',
        type: 'text',
        max: 200,
        noteTh: 'ไม่บังคับ',
        noteEn: 'Optional',
        examples: ['', ''],
      },
      {
        key: 'paid_on',
        th: 'วันที่ชำระ',
        en: 'Paid on',
        type: 'date',
        required: true,
        noteTh: 'บังคับ — ไม่เกินวันที่ยอดยกมา และไม่เก่ากว่า 12 เดือน',
        noteEn: 'Required — by the as-of date and within the 12 months before it',
        examples: ['2026-06-05', '2026-06-07'],
      },
      {
        key: 'amount',
        th: 'จำนวนเงิน',
        en: 'Amount',
        type: 'money',
        required: true,
        noteTh: 'บังคับ — มากกว่า 0',
        noteEn: 'Required — more than 0',
        examples: ['1043.10', '1500.00'],
      },
      {
        key: 'method',
        th: 'วิธีชำระ',
        en: 'Method',
        type: 'enum',
        values: ['cash', 'transfer', 'cheque', 'promptpay', 'card', 'other'],
        aliases: METHOD_ALIASES,
        noteTh: 'cash · transfer · cheque · promptpay · card · other (ว่าง = transfer)',
        noteEn: 'cash · transfer · cheque · promptpay · card · other (blank = transfer)',
        examples: ['transfer', 'cash'],
      },
      {
        key: 'reference',
        th: 'เลขอ้างอิง',
        en: 'Reference',
        type: 'text',
        max: 100,
        noteTh: 'ไม่บังคับ — เลขที่ใบเสร็จระบบเดิมหรือเลขอ้างอิงธนาคาร',
        noteEn: 'Optional — the legacy receipt number or the bank reference',
        examples: ['RC2569-0601', ''],
      },
    ],
  },
  bank_balance: {
    key: 'bank_balance',
    th: 'ยอดเงินในบัญชีธนาคารยกมา',
    en: 'Bank opening balances',
    columns: [
      {
        key: 'account_type',
        th: 'ประเภทบัญชี',
        en: 'Account type',
        type: 'enum',
        required: true,
        values: ['operating', 'fund'],
        aliases: { บัญชีดำเนินงาน: 'operating', ดำเนินงาน: 'operating', กองทุน: 'fund' },
        noteTh: 'บังคับ — operating (บัญชีดำเนินงาน) · fund (บัญชีกองทุน)',
        noteEn: 'Required — operating · fund',
        examples: ['operating', 'fund'],
      },
      {
        key: 'bank_account_last4',
        th: 'เลขบัญชี 4 หลักท้าย',
        en: 'Account no. last 4',
        type: 'id_last4',
        noteTh: 'บัญชีธนาคารที่ตั้งไว้ในระบบ (ตั้งค่า > บัญชีธนาคาร) ว่างได้สำหรับบัญชีกองทุน',
        noteEn: 'A bank account set up in getproperty (Settings > Bank accounts); may be blank for a fund',
        examples: ['1234', ''],
      },
      {
        key: 'fund_name',
        th: 'ชื่อกองทุน',
        en: 'Fund name',
        type: 'text',
        max: 200,
        noteTh: 'เฉพาะบัญชีกองทุน — ว่าง = กองทุนหลักของอาคาร',
        noteEn: 'Fund accounts only — blank = the building’s main fund',
        examples: ['', ''],
      },
      {
        key: 'balance',
        th: 'ยอดคงเหลือ',
        en: 'Balance',
        type: 'money',
        required: true,
        noteTh: 'บังคับ — ยอดคงเหลือ ณ วันที่ยอดยกมา',
        noteEn: 'Required — the balance on the as-of date',
        examples: ['152300.55', '880000.00'],
      },
      {
        key: 'as_of',
        th: 'ณ วันที่',
        en: 'As of',
        type: 'date',
        noteTh: 'ไม่บังคับ — ถ้าใส่ต้องตรงกับวันที่ยอดยกมาของงานนำเข้า',
        noteEn: 'Optional — when given it must be the import’s as-of date',
        examples: ['', ''],
      },
    ],
  },
  legacy_bills: {
    key: 'legacy_bills',
    th: 'ใบแจ้งหนี้จากระบบเดิม (รอบคู่ขนาน)',
    en: 'Legacy bills (parallel cycle)',
    columns: [
      {
        key: 'unit_no',
        th: 'เลขที่ห้อง / แปลง',
        en: 'Unit no.',
        type: 'text',
        required: true,
        max: 50,
        noteTh: 'บังคับ',
        noteEn: 'Required',
        examples: ['A-1201', 'A-1202'],
      },
      {
        key: 'amount',
        th: 'ยอดที่ระบบเดิมเรียกเก็บ',
        en: 'Amount billed',
        type: 'money',
        required: true,
        noteTh: 'บังคับ — ยอดรวมของห้องในรอบที่เปรียบเทียบ (หลายแถวต่อห้องจะถูกรวมกัน)',
        noteEn: 'Required — the unit’s total for the compared cycle (several rows of a unit are added up)',
        examples: ['1043.10', '1365.00'],
      },
    ],
  },
};

// ------------------------------------------------------------------------------------------- messages

/** Field / row messages in Thai and English; `{name}` placeholders take the issue's params. */
export const ISSUE_MESSAGES: Readonly<Record<string, { th: string; en: string }>> = {
  required: { th: 'ต้องกรอก', en: 'is required' },
  too_long: { th: 'ยาวเกิน {max} ตัวอักษร', en: 'is longer than {max} characters' },
  money: { th: 'ต้องเป็นจำนวนเงิน เช่น 1500 หรือ 1500.00', en: 'must be an amount, e.g. 1500 or 1500.00' },
  area: {
    th: 'ต้องเป็นตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง',
    en: 'must be a number above 0 with up to 2 decimals',
  },
  ratio: {
    th: 'ต้องอยู่ระหว่าง 0 ถึง 1 ทศนิยมไม่เกิน 6 ตำแหน่ง',
    en: 'must be between 0 and 1 with up to 6 decimals',
  },
  share: { th: 'ต้องมากกว่า 0 และไม่เกิน 100', en: 'must be above 0 and at most 100' },
  date: { th: 'ต้องเป็นวันที่ YYYY-MM-DD หรือ วว/ดด/ปปปป', en: 'must be a date YYYY-MM-DD or DD/MM/YYYY' },
  period: {
    th: 'ต้องเป็นงวด YYYY-MM, YYYY-Qn, YYYY-Hn หรือ YYYY',
    en: 'must be a period YYYY-MM, YYYY-Qn, YYYY-Hn or YYYY',
  },
  enum: { th: 'ต้องเป็นหนึ่งใน {values}', en: 'must be one of {values}' },
  phone: { th: 'เบอร์โทรไม่ถูกต้อง', en: 'is not a valid phone number' },
  email: { th: 'อีเมลไม่ถูกต้อง', en: 'is not a valid e-mail address' },
  floor: {
    th: 'ชั้นต้องเป็น -5 ถึง 200 หรือชื่อซอย / โซน',
    en: 'must be a level -5 to 200 or a soi / zone name',
  },
  id_full_refused: {
    th: 'ไม่รับเลขบัตรเต็ม (PDPA) — ใส่เฉพาะ 4 หลักท้าย ข้อมูลนี้ไม่ถูกบันทึก',
    en: 'full ID numbers are refused (PDPA) — give the last 4 only; the value was not stored',
  },
  id_format: {
    th: 'ต้องเป็น 4 หลักท้าย (ตัวเลขหรือตัวอักษร)',
    en: 'must be the last 4 characters (letters or digits)',
  },
  unit_no_format: {
    th: 'ไม่เกิน 20 ตัว ใช้ได้เฉพาะตัวอักษร ตัวเลข ช่องว่าง และ - _ . /',
    en: 'at most 20 characters: letters, digits, spaces and - _ . / only',
  },
  building_mismatch: {
    th: 'ไม่ตรงกับอาคาร {building} ของงานนำเข้านี้',
    en: 'is not this import’s building {building}',
  },
  duplicate: { th: 'ซ้ำกับแถว {row}', en: 'repeats row {row}' },
  unit_values_conflict: {
    th: 'ไม่ตรงกับแถว {row} ของห้องเดียวกัน',
    en: 'differs from row {row} of the same unit',
  },
  shares_exceeded: {
    th: 'สัดส่วนรวมของห้อง {unit} เกิน 100% ({sum}%)',
    en: 'the shares of unit {unit} exceed 100% ({sum}%)',
  },
  shares_incomplete: {
    th: 'สัดส่วนรวมของห้อง {unit} เพียง {sum}% — เจ้าของจะถูกเรียกเก็บเฉพาะส่วนของตน',
    en: 'the shares of unit {unit} sum to {sum}% only — owners are billed their own share',
  },
  unit_has_owners: {
    th: 'ห้อง {unit} มีเจ้าของในทะเบียนอยู่แล้ว — โอนหรือปิดทะเบียนเดิมก่อน',
    en: 'unit {unit} already has owners in the register — transfer or end them first',
  },
  unit_attribute_differs: {
    th: 'ห้อง {unit} มีอยู่แล้ว ค่าเดิม {current} จะไม่ถูกเปลี่ยน',
    en: 'unit {unit} exists; its current value {current} is kept',
  },
  unit_not_in_register: {
    th: 'ไม่มีห้อง {unit} ในไฟล์ทะเบียน',
    en: 'unit {unit} is not in the register file',
  },
  owner_not_in_register: {
    th: 'ไม่พบเจ้าของ "{owner}" ของห้อง {unit} ในไฟล์ทะเบียน',
    en: 'owner "{owner}" of unit {unit} is not in the register file',
  },
  owner_ambiguous: {
    th: 'ห้อง {unit} มีเจ้าของหลายคน — ระบุรหัสหรือชื่อเจ้าของ',
    en: 'unit {unit} has several owners — give the owner code or name',
  },
  owner_code_conflict: {
    th: 'รหัสเจ้าของ {code} ใช้กับชื่อ "{other}" ในแถว {row}',
    en: 'owner code {code} names "{other}" on row {row}',
  },
  period_after_as_of: {
    th: 'งวดสิ้นสุดหลังวันที่ยอดยกมา {asOf}',
    en: 'the period ends after the as-of date {asOf}',
  },
  as_of_mismatch: { th: 'ต้องเป็นวันที่ยอดยกมา {asOf}', en: 'must be the as-of date {asOf}' },
  amount_zero: { th: 'เงินต้นหรือเงินเพิ่มต้องมากกว่า 0', en: 'principal or surcharge must be above 0' },
  amount_positive: { th: 'ต้องมากกว่า 0', en: 'must be above 0' },
  after_as_of: { th: 'หลังวันที่ยอดยกมา {asOf}', en: 'is after the as-of date {asOf}' },
  duplicate_payment: { th: 'อาจซ้ำกับแถว {row}', en: 'may repeat row {row}' },
  paid_on_too_old: {
    th: 'เก่ากว่า 12 เดือนก่อนวันที่ยอดยกมา',
    en: 'is more than 12 months before the as-of date',
  },
  bank_account_not_found: {
    th: 'ไม่พบบัญชีธนาคารที่ลงท้าย {last4} ในระบบ — เพิ่มบัญชีในตั้งค่าก่อน',
    en: 'no bank account ending {last4} is set up — add it in Settings first',
  },
  bank_account_ambiguous: {
    th: 'มีหลายบัญชีที่ลงท้าย {last4}',
    en: 'several bank accounts end with {last4}',
  },
  bank_account_required: {
    th: 'บัญชีดำเนินงานต้องระบุเลขบัญชี 4 หลักท้าย',
    en: 'an operating account needs its last 4 digits',
  },
  fund_not_found: { th: 'ไม่พบกองทุน "{fund}" ของอาคารนี้', en: 'the building has no fund "{fund}"' },
  unit_type_invalid: { th: 'ห้องเดิมเป็นประเภท {current}', en: 'the existing unit is a {current}' },
  bill_to_same_as_owner: { th: 'ผู้รับใบแจ้งหนี้เป็นเจ้าของเอง', en: 'the bill-to is the owner' },
  bill_to_conflict: {
    th: 'ผู้รับใบแจ้งหนี้ต่างจากแถว {row} ของเจ้าของคนเดียวกัน',
    en: 'differs from row {row} of the same owner',
  },
  party_attached: {
    th: 'ใช้ข้อมูลบุคคลที่มีอยู่แล้วในระบบ ({name})',
    en: 'uses the person already on file ({name})',
  },
};

export interface Issue {
  column: string;
  code: string;
  params?: Record<string, string | number>;
}

export function issueMessage(issue: Issue, lang: Language): string {
  const m = ISSUE_MESSAGES[issue.code];
  const text = m ? m[lang] : issue.code;
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(issue.params?.[k] ?? ''));
}

export function columnLabel(sheet: SheetKey, key: string, lang: Language): string {
  if (key === 'row') return lang === 'th' ? 'แถว' : 'row';
  const c = SHEETS[sheet].columns.find((x) => x.key === key);
  return c ? c[lang] : key;
}

/** One line per issue: `column: message`. */
export function issuesText(sheet: SheetKey, issues: readonly Issue[], lang: Language): string {
  return issues.map((i) => `${columnLabel(sheet, i.column, lang)}: ${issueMessage(i, lang)}`).join('; ');
}

// ------------------------------------------------------------------------------------------- reading files

export class ImportFileError extends Error {}

export interface RawTable {
  format: 'csv' | 'xlsx';
  header: string[];
  rows: { rowNo: number; cells: string[] }[];
}

export const MAX_ROWS = 5_000;
export const MAX_FILE_BYTES = 5_000_000;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv';

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v)
      return v.richText
        .map((r) => r.text)
        .join('')
        .trim();
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return String(v.text).trim();
    return '';
  }
  return String(v).trim();
};

/** RFC 4180 records of a whole CSV text (quoted fields may hold the delimiter and line breaks). */
export function csvRecords(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cur);
      out.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out.map((r) => r.map((c) => c.trim()));
}

export const isXlsx = (body: Buffer) => body.length > 4 && body[0] === 0x50 && body[1] === 0x4b;

/** Reads a CSV (UTF-8, optional BOM, `,` `;` or tab) or an XLSX (first data sheet) into header + rows. */
export async function readTable(body: Buffer, sheet: SheetKey): Promise<RawTable> {
  if (!body.length || body.length > MAX_FILE_BYTES)
    throw new ImportFileError(`the file must hold 1 byte to ${MAX_FILE_BYTES} bytes`);
  let records: { rowNo: number; cells: string[] }[];
  let format: RawTable['format'];
  if (isXlsx(body)) {
    format = 'xlsx';
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(body as unknown as ArrayBuffer);
    } catch {
      throw new ImportFileError('not a readable xlsx workbook');
    }
    const ws =
      wb.getWorksheet(sheet) ??
      wb.worksheets.find((w) => !/คำอธิบาย|instructions/i.test(w.name)) ??
      wb.worksheets[0];
    if (!ws) throw new ImportFileError('the workbook has no worksheet');
    records = [];
    for (let r = 1; r <= ws.rowCount; r += 1) {
      const values = (ws.getRow(r).values as ExcelJS.CellValue[]).slice(1);
      records.push({ rowNo: r, cells: Array.from(values, (v) => cellText(v)) });
    }
  } else {
    format = 'csv';
    let text = body.toString('utf8');
    if (text.includes('�')) throw new ImportFileError('the CSV is not UTF-8 text');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const first = text.split(/\r?\n/, 1)[0] ?? '';
    const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const);
    const delimiter = counts.sort((a, b) => b[1] - a[1])[0]![0];
    records = csvRecords(text, delimiter).map((cells, i) => ({ rowNo: i + 1, cells }));
  }
  const headerAt = records.findIndex((r) => r.cells.some((c) => c !== ''));
  if (headerAt < 0) throw new ImportFileError('the file is empty');
  const header = records[headerAt]!.cells;
  const rows = records
    .slice(headerAt + 1)
    .filter((r) => r.cells.some((c) => c !== '') && !(r.cells[0] ?? '').startsWith('#'));
  if (rows.length > MAX_ROWS) throw new ImportFileError(`more than ${MAX_ROWS} rows`);
  return { format, header, rows };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Column key → cell index of a header row (key, Thai label, English label or `label (key)`). */
export function resolveHeader(sheet: SheetKey, header: readonly string[]): Map<string, number> {
  const spec = SHEETS[sheet];
  const out = new Map<string, number>();
  header.forEach((raw, i) => {
    const h = norm(raw);
    const inParens = /\(([a-z0-9_]+)\)\s*\*?$/.exec(h)?.[1];
    const plain = h.replace(/\s*\*$/, '');
    const col = spec.columns.find(
      (c) => c.key === inParens || c.key === plain || norm(c.th) === plain || norm(c.en) === plain,
    );
    if (col && !out.has(col.key)) out.set(col.key, i);
  });
  const missing = spec.columns.filter((c) => c.required && !out.has(c.key)).map((c) => c.key);
  if (missing.length) throw new ImportFileError(`the header row has no ${missing.join(', ')} column`);
  return out;
}

// ------------------------------------------------------------------------------------------- cells

/** Same rule as a unit created in the console (`UNIT_NO_PATTERN`). */
export const UNIT_NO = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ./_-]{0,19}$/u;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const year = (y: number) => (y > 2400 ? y - 543 : y);
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parseDate(raw: string): string | null {
  const s = raw.trim().split(/[ T]/)[0]!;
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  y = year(y);
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > lastDay(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** `YYYY-MM` · `YYYY-Qn` · `YYYY-Hn` · `YYYY` (Buddhist years accepted) → its key and calendar span. */
export function parsePeriod(raw: string): { key: string; from: string; to: string } | null {
  const s = raw.trim().toUpperCase();
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  const span = (y: number, m1: number, m2: number, key: string) =>
    y < 1900 || y > 2200
      ? null
      : { key, from: `${y}-${pad(m1)}-01`, to: `${y}-${pad(m2)}-${pad(lastDay(y, m2))}` };
  if (m) {
    const y = year(Number(m[1]));
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? span(y, mo, mo, `${y}-${pad(mo)}`) : null;
  }
  m = /^(\d{4})-Q([1-4])$/.exec(s);
  if (m) {
    const y = year(Number(m[1]));
    const q = Number(m[2]);
    return span(y, q * 3 - 2, q * 3, `${y}-Q${q}`);
  }
  m = /^(\d{4})-H([12])$/.exec(s);
  if (m) {
    const y = year(Number(m[1]));
    const h = Number(m[2]);
    return span(y, h * 6 - 5, h * 6, `${y}-H${h}`);
  }
  m = /^(\d{4})$/.exec(s);
  if (m) {
    const y = year(Number(m[1]));
    return span(y, 1, 12, `${y}`);
  }
  return null;
}

export function parseMoney(raw: string): string | null {
  const s = raw.replace(/[,\s฿]/g, '').replace(/^THB/i, '');
  if (!MONEY.test(s)) return null;
  return new Decimal(s).toFixed(2);
}

const MASK = /^[xX*•#\-\s]*$/;

/** The last 4 of an ID or account number: exactly 4 characters, or a masked value ending with 4 (PDPA). */
export function parseLast4(raw: string): { value: string } | { error: 'id_full_refused' | 'id_format' } {
  const s = raw.trim();
  const alnum = s.replace(/[^0-9A-Za-z]/g, '');
  if (/^[0-9A-Za-z]{4}$/.test(s)) return { value: s.toUpperCase() };
  const tail = s.slice(-4);
  if (s.length > 4 && /^[0-9A-Za-z]{4}$/.test(tail) && MASK.test(s.slice(0, -4)))
    return { value: tail.toUpperCase() };
  return alnum.length > 4 ? { error: 'id_full_refused' } : { error: 'id_format' };
}

/** Every column key of every sheet (a row's data has each key of its sheet, null when blank or invalid). */
export type CellKey =
  | 'building'
  | 'floor'
  | 'unit_no'
  | 'unit_type'
  | 'plot_no'
  | 'land_area_sqwa'
  | 'area_sqm'
  | 'ownership_ratio'
  | 'owner_code'
  | 'owner_name'
  | 'owner_type'
  | 'id_type'
  | 'id_last4'
  | 'phone'
  | 'email'
  | 'line_id'
  | 'share_pct'
  | 'owned_since'
  | 'bill_to_name'
  | 'bill_to_kind'
  | 'bill_to_phone'
  | 'bill_to_email'
  | 'charge'
  | 'period'
  | 'principal'
  | 'surcharge'
  | 'as_of'
  | 'paid_on'
  | 'amount'
  | 'method'
  | 'reference'
  | 'account_type'
  | 'bank_account_last4'
  | 'fund_name'
  | 'balance';
export type RowData = Record<CellKey, string | null>;

export interface ParsedRow {
  rowNo: number;
  data: RowData;
  /** The original text of cells that failed (never of ID cells: a refused number is not kept anywhere). */
  raw: Record<string, string>;
  errors: Issue[];
  warnings: Issue[];
}

/** Field validation of one row: every cell normalised, an issue per bad cell (raw ID numbers never kept). */
export function parseRow(
  sheet: SheetKey,
  index: ReadonlyMap<string, number>,
  raw: { rowNo: number; cells: readonly string[] },
): ParsedRow {
  const data = {} as RowData;
  const rawOf: Record<string, string> = {};
  const errors: Issue[] = [];
  for (const c of SHEETS[sheet].columns) {
    const at = index.get(c.key);
    const cell = at === undefined ? '' : (raw.cells[at] ?? '').trim();
    data[c.key] = null;
    if (!cell) {
      if (c.required) errors.push({ column: c.key, code: 'required' });
      continue;
    }
    const bad = (code: string, params?: Issue['params']) => {
      errors.push({ column: c.key, code, ...(params ? { params } : {}) });
      if (c.type !== 'id_last4') rawOf[c.key] = cell.slice(0, 300);
    };
    switch (c.type) {
      case 'text':
        if (cell.length > (c.max ?? 200)) bad('too_long', { max: c.max ?? 200 });
        else if (c.key === 'unit_no' && !UNIT_NO.test(cell)) bad('unit_no_format');
        else data[c.key] = cell;
        break;
      case 'floor':
        if (/^-?\d+$/.test(cell)) {
          const n = Number(cell);
          if (n < -5 || n > 200) bad('floor');
          else data[c.key] = String(n);
        } else if (cell.length > (c.max ?? 100)) bad('too_long', { max: c.max ?? 100 });
        else data[c.key] = cell;
        break;
      case 'money': {
        const v = parseMoney(cell);
        if (v === null) bad('money');
        else data[c.key] = v;
        break;
      }
      case 'area': {
        const s = cell.replace(/,/g, '');
        if (!/^\d{1,7}(\.\d{1,2})?$/.test(s) || Number(s) <= 0) bad('area');
        else data[c.key] = new Decimal(s).toFixed(2);
        break;
      }
      case 'ratio': {
        if (!/^0?(\.\d{1,6})?$|^1(\.0{1,6})?$/.test(cell) || Number(cell) <= 0) bad('ratio');
        else data[c.key] = new Decimal(cell).toFixed(6);
        break;
      }
      case 'share': {
        const s = cell.replace(/%$/, '').trim();
        if (!/^\d{1,3}(\.\d{1,4})?$/.test(s) || Number(s) <= 0 || Number(s) > 100) bad('share');
        else data[c.key] = new Decimal(s).toFixed(4);
        break;
      }
      case 'date': {
        const v = parseDate(cell);
        if (!v) bad('date');
        else data[c.key] = v;
        break;
      }
      case 'period': {
        const v = parsePeriod(cell);
        if (!v) bad('period');
        else data[c.key] = v.key;
        break;
      }
      case 'enum': {
        const lower = cell.toLowerCase();
        const v = c.values!.includes(lower) ? lower : (c.aliases?.[cell] ?? c.aliases?.[lower]);
        if (!v) bad('enum', { values: c.values!.join(' · ') });
        else data[c.key] = v;
        break;
      }
      case 'phone': {
        const v = normalisePhone(cell);
        if (!v) bad('phone');
        else data[c.key] = v;
        break;
      }
      case 'email':
        if (!EMAIL.test(cell) || cell.length > 254) bad('email');
        else data[c.key] = cell.toLowerCase();
        break;
      case 'id_last4': {
        const v = parseLast4(cell);
        if ('error' in v) bad(v.error);
        else data[c.key] = v.value;
        break;
      }
    }
  }
  return { rowNo: raw.rowNo, data, raw: rawOf, errors, warnings: [] };
}

/** Reads and field-validates a file of a sheet. */
export async function parseSheet(body: Buffer, sheet: SheetKey) {
  const table = await readTable(body, sheet);
  const index = resolveHeader(sheet, table.header);
  return { format: table.format, rows: table.rows.map((r) => parseRow(sheet, index, r)) };
}

// ------------------------------------------------------------------------------------------- templates & bad rows

const headerOf = (c: ColumnSpec, lang: Language) => `${c[lang]} (${c.key})${c.required ? ' *' : ''}`;

/** The template of a sheet: XLSX (data sheet with two example rows marked `#` + instructions) or CSV. */
export async function template(
  sheet: SheetKey,
  format: 'xlsx' | 'csv',
  lang: Language,
): Promise<{ fileName: string; mimeType: string; body: Buffer }> {
  const spec = SHEETS[sheet];
  const header = spec.columns.map((c) => headerOf(c, lang));
  const examples = [0, 1].map((i) =>
    spec.columns.map((c, j): string => (j === 0 ? `#${c.examples[i]!}` : c.examples[i]!)),
  );
  const fileName = `getproperty-import-${sheet.replace(/_/g, '-')}-${lang}.${format}`;
  if (format === 'csv') {
    const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [header, ...examples].map((r) => r.map(field).join(','));
    return { fileName, mimeType: CSV_MIME, body: Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8') };
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'getproperty';
  wb.created = new Date(0);
  wb.modified = new Date(0);
  const ws = wb.addWorksheet(sheet);
  ws.addRow(header).font = { bold: true };
  for (const e of examples) ws.addRow(e).font = { italic: true, color: { argb: 'FF7A7A7A' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  spec.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = Math.min(40, Math.max(14, headerOf(c, lang).length + 2));
    ws.getColumn(i + 1).numFmt = '@';
  });
  const help = wb.addWorksheet(lang === 'th' ? 'คำอธิบาย' : 'Instructions');
  help.columns = [
    { header: lang === 'th' ? 'คอลัมน์' : 'Column', key: 'k', width: 34 },
    { header: lang === 'th' ? 'บังคับ' : 'Required', key: 'r', width: 10 },
    { header: lang === 'th' ? 'คำอธิบาย' : 'Meaning and format', key: 'v', width: 90 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of spec.columns)
    help.addRow({
      k: headerOf(c, lang),
      r: c.required ? (lang === 'th' ? 'ใช่' : 'yes') : '',
      v: lang === 'th' ? c.noteTh : c.noteEn,
    });
  help.addRow({});
  const notes =
    lang === 'th'
      ? [
          `แผ่นงาน: ${spec.th}`,
          'แถวที่ขึ้นต้นด้วย # เป็นตัวอย่าง ระบบจะข้าม — ลบหรือเขียนทับได้',
          'ใช้ชื่อคอลัมน์ตามแม่แบบ (ภาษาไทย อังกฤษ หรือรหัสในวงเล็บ) ลำดับคอลัมน์สลับได้',
          'บันทึกเป็น .xlsx หรือ .csv (UTF-8) ขนาดไม่เกิน 5 MB และไม่เกิน 5,000 แถว',
          'ห้ามใส่เลขบัตรประชาชนหรือหนังสือเดินทางเต็ม (PDPA) — ใส่เฉพาะ 4 หลักท้าย',
        ]
      : [
          `Sheet: ${spec.en}`,
          'Rows starting with # are examples and are skipped — delete or overwrite them',
          'Use the template’s column names (Thai, English or the key in brackets); the column order is free',
          'Save as .xlsx or .csv (UTF-8), at most 5 MB and 5,000 rows',
          'Never enter full national ID or passport numbers (PDPA) — the last 4 characters only',
        ];
  for (const n of notes) help.addRow({ k: n });
  return { fileName, mimeType: XLSX_MIME, body: Buffer.from(await wb.xlsx.writeBuffer()) };
}

/** The rows of a sheet that have errors, with an `errors` column, as CSV or XLSX (fix and upload again). */
export async function badRowsFile(
  sheet: SheetKey,
  rows: readonly ParsedRow[],
  format: 'xlsx' | 'csv',
  lang: Language,
): Promise<{ fileName: string; mimeType: string; body: Buffer }> {
  const spec = SHEETS[sheet];
  const errLabel = lang === 'th' ? 'ข้อผิดพลาด (errors)' : 'Errors (errors)';
  const rowLabel = lang === 'th' ? 'แถวในไฟล์ (row)' : 'File row (row)';
  const header = [rowLabel, ...spec.columns.map((c) => headerOf(c, lang)), errLabel];
  const bad = rows.filter((r) => r.errors.length);
  const values = bad.map((r) => [
    String(r.rowNo),
    ...spec.columns.map((c): string => r.data[c.key] ?? r.raw[c.key] ?? ''),
    issuesText(sheet, r.errors, lang),
  ]);
  const fileName = `getproperty-import-${sheet.replace(/_/g, '-')}-errors.${format}`;
  if (format === 'csv') {
    const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [header, ...values].map((r) => r.map(field).join(','));
    return { fileName, mimeType: CSV_MIME, body: Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8') };
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'getproperty';
  wb.created = new Date(0);
  wb.modified = new Date(0);
  const ws = wb.addWorksheet(sheet);
  ws.addRow(header).font = { bold: true };
  for (const v of values) ws.addRow(v);
  ws.getColumn(header.length).width = 80;
  return { fileName, mimeType: XLSX_MIME, body: Buffer.from(await wb.xlsx.writeBuffer()) };
}

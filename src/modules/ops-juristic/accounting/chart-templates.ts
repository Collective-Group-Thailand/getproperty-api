/**
 * Juristic chart of accounts templates (D-312 = D-J11, D-329; ⚖ O-043 — an accountant confirms names and the fund
 * treatment). Data, like the collections ladder templates: one template per `core.building_legal_form`; a tenant's
 * chart (`juristic.account`) is copied from the template of the legal form of its oldest juristic building on first use
 * and is the tenant's own from then on. Every system account carries a **role** — the key the posting rules use;
 * names are free to change, roles are not. `condo_act` (นิติบุคคลอาคารชุด) and `land_allocation_act`
 * (นิติบุคคลหมู่บ้านจัดสรร) share one structure and differ in wording; `voluntary` / `lease_contract` reuse `condo_act`.
 * Fund (`fund_bank`, `fund_equity`) and petty cash accounts are created per fund / float (codes `1160-NN`,
 * `3110-NN`, `1120-NN`).
 */

export type AccountTypeName = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type LegalFormName = 'condo_act' | 'land_allocation_act' | 'voluntary' | 'lease_contract';

export interface ChartAccountTemplate {
  code: string;
  role: AccountRole;
  type: AccountTypeName;
  nameTh: string;
  nameEn: string;
}

/** Roles the posting rules use (the system accounts of every chart). */
export const ACCOUNT_ROLES = [
  'cash',
  'petty_cash',
  'bank',
  'receivable',
  'wht_prepaid',
  'payable',
  'wht_payable',
  'unearned',
  'deposits',
  'output_vat',
  'accumulated_surplus',
  'income_common_fee',
  'income_fund',
  'income_surcharge',
  'income_other',
  'exp_personnel',
  'exp_utilities',
  'exp_repairs',
  'exp_services',
  'exp_admin',
  'exp_insurance',
  'exp_taxes',
  'exp_other',
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
/** Roles of the accounts created with each fund (`juristic.account.fund_id`). */
export type FundAccountRole = 'fund_bank' | 'fund_equity';

const CONDO: ChartAccountTemplate[] = [
  { code: '1110', role: 'cash', type: 'asset', nameTh: 'เงินสด', nameEn: 'Cash on hand' },
  { code: '1120', role: 'petty_cash', type: 'asset', nameTh: 'เงินสดย่อย', nameEn: 'Petty cash' },
  {
    code: '1130',
    role: 'bank',
    type: 'asset',
    nameTh: 'เงินฝากธนาคาร – บัญชีดำเนินงาน',
    nameEn: 'Bank — operating account',
  },
  {
    code: '1140',
    role: 'receivable',
    type: 'asset',
    nameTh: 'ลูกหนี้ค่าส่วนกลางและเงินกองทุน – เจ้าของร่วม',
    nameEn: 'Receivables — co-owners (common fees and fund)',
  },
  {
    code: '1150',
    role: 'wht_prepaid',
    type: 'asset',
    nameTh: 'ภาษีเงินได้ถูกหัก ณ ที่จ่าย',
    nameEn: 'Withholding tax deducted by payers',
  },
  { code: '2110', role: 'payable', type: 'liability', nameTh: 'เจ้าหนี้', nameEn: 'Accounts payable' },
  {
    code: '2120',
    role: 'wht_payable',
    type: 'liability',
    nameTh: 'ภาษีหัก ณ ที่จ่ายค้างนำส่ง',
    nameEn: 'Withholding tax payable',
  },
  {
    code: '2130',
    role: 'unearned',
    type: 'liability',
    nameTh: 'รายได้รับล่วงหน้า',
    nameEn: 'Unearned revenue (billed in advance)',
  },
  {
    code: '2140',
    role: 'deposits',
    type: 'liability',
    nameTh: 'เงินประกันและเงินมัดจำรับ',
    nameEn: 'Deposits held',
  },
  { code: '2150', role: 'output_vat', type: 'liability', nameTh: 'ภาษีขาย', nameEn: 'Output VAT' },
  {
    code: '3200',
    role: 'accumulated_surplus',
    type: 'equity',
    nameTh: 'รายรับสูง (ต่ำ) กว่ารายจ่ายสะสม',
    nameEn: 'Accumulated surplus (deficit)',
  },
  {
    code: '4110',
    role: 'income_common_fee',
    type: 'income',
    nameTh: 'รายได้ค่าส่วนกลาง',
    nameEn: 'Common fee income',
  },
  {
    code: '4120',
    role: 'income_fund',
    type: 'income',
    nameTh: 'รายได้เงินสมทบกองทุน',
    nameEn: 'Fund contribution income',
  },
  {
    code: '4130',
    role: 'income_surcharge',
    type: 'income',
    nameTh: 'รายได้เงินเพิ่ม (ชำระล่าช้า)',
    nameEn: 'Late payment surcharge income',
  },
  { code: '4190', role: 'income_other', type: 'income', nameTh: 'รายได้อื่น', nameEn: 'Other income' },
  {
    code: '5110',
    role: 'exp_personnel',
    type: 'expense',
    nameTh: 'เงินเดือนและค่าตอบแทนบุคลากร',
    nameEn: 'Personnel',
  },
  {
    code: '5120',
    role: 'exp_utilities',
    type: 'expense',
    nameTh: 'ค่าไฟฟ้าและค่าน้ำประปาส่วนกลาง',
    nameEn: 'Utilities (common areas)',
  },
  {
    code: '5130',
    role: 'exp_repairs',
    type: 'expense',
    nameTh: 'ค่าซ่อมแซมและบำรุงรักษา',
    nameEn: 'Repairs and maintenance',
  },
  {
    code: '5140',
    role: 'exp_services',
    type: 'expense',
    nameTh: 'ค่าจ้างบริการ (รักษาความปลอดภัย ทำความสะอาด ฯลฯ)',
    nameEn: 'Services and vendors (security, cleaning …)',
  },
  {
    code: '5150',
    role: 'exp_admin',
    type: 'expense',
    nameTh: 'ค่าใช้จ่ายสำนักงานและการบริหาร',
    nameEn: 'Administration and office',
  },
  { code: '5160', role: 'exp_insurance', type: 'expense', nameTh: 'ค่าเบี้ยประกันภัย', nameEn: 'Insurance' },
  {
    code: '5170',
    role: 'exp_taxes',
    type: 'expense',
    nameTh: 'ภาษีและค่าธรรมเนียม',
    nameEn: 'Taxes and fees',
  },
  {
    code: '5190',
    role: 'exp_other',
    type: 'expense',
    nameTh: 'ค่าใช้จ่ายอื่น (รวมเงินสดย่อยขาด / เกิน)',
    nameEn: 'Other expenses (incl. petty cash differences)',
  },
];

/** หมู่บ้านจัดสรร wording (พ.ร.บ.การจัดสรรที่ดิน 2543): members, public utilities maintenance fees. */
const VILLAGE_NAMES: Partial<Record<AccountRole, { nameTh: string; nameEn: string }>> = {
  receivable: {
    nameTh: 'ลูกหนี้ค่าบำรุงรักษาและจัดการสาธารณูปโภค – สมาชิก',
    nameEn: 'Receivables — members (utility maintenance fees and fund)',
  },
  income_common_fee: {
    nameTh: 'รายได้ค่าบำรุงรักษาและจัดการสาธารณูปโภค',
    nameEn: 'Public utility maintenance fee income',
  },
};

const withNames = (base: readonly ChartAccountTemplate[], names: typeof VILLAGE_NAMES) =>
  base.map((a) => ({ ...a, ...(names[a.role] ?? {}) }));

export const CHART_TEMPLATES: Readonly<Record<LegalFormName, readonly ChartAccountTemplate[]>> = {
  condo_act: CONDO,
  land_allocation_act: withNames(CONDO, VILLAGE_NAMES),
  voluntary: CONDO,
  lease_contract: CONDO,
};

export function chartTemplate(legalForm: string | null | undefined): {
  key: string;
  accounts: readonly ChartAccountTemplate[];
} {
  const form = (legalForm && legalForm in CHART_TEMPLATES ? legalForm : 'condo_act') as LegalFormName;
  return { key: `juristic_chart.${form}.v1`, accounts: CHART_TEMPLATES[form] };
}

/** Default name of a building's first sinking fund, by legal form. */
export function defaultFundName(legalForm: string | null | undefined): string {
  return legalForm === 'land_allocation_act' ? 'เงินกองทุนหมู่บ้าน' : 'เงินกองทุนอาคารชุด';
}

/** Normal balance side of an account type: assets and expenses are debit accounts. */
export const debitNormal = (type: AccountTypeName): boolean => type === 'asset' || type === 'expense';

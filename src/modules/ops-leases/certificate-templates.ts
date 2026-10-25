import { type ContractLanguage } from './contract-renderer';

export type RentCertificatePurpose = 'visa' | 'bank' | 'employer' | 'other';

const esc = (value: string | number | null | undefined): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

interface Party {
  legalName: string;
  taxId: string | null;
  address: string;
}

/** What a rent payment certificate shows; values already formatted for its language. */
export interface CertificateData {
  number: string;
  issuedOn: string;
  lessor: Party;
  lessee: { displayName: string };
  premises: { unitNo: string; propertyName: string; address: string };
  lease: { number: string | null; startDate: string; endDate: string; rent: string };
  period: { from: string; to: string };
  purpose: RentCertificatePurpose;
  payments: { date: string; number: string; amount: string }[];
  total: string;
  totalText: string;
  outstanding: string | null;
}

/** What an annual rental income summary shows (40(5)); values already formatted. */
export interface IncomeSummaryData {
  number: string;
  issuedOn: string;
  owner: Party;
  premises: { unitNo: string; propertyName: string; address: string };
  year: string;
  months: { label: string; amount: string }[];
  rent: string;
  charges: string;
  retained: string;
  gross: string;
  grossText: string;
  deductionPercent: string;
  deduction: string;
  net: string;
  /** Owner-borne repair costs recorded on service requests (D-263), by category; empty = none recorded. */
  expenses: string;
  expenseItems: { label: string; amount: string }[];
  /** Gross minus the recorded expenses (the actual-expense alternative, an estimate). */
  netActual: string;
}

const PURPOSE: Record<ContractLanguage, Record<RentCertificatePurpose, string>> = {
  th: {
    visa: 'ประกอบการขอหรือต่อวีซ่า',
    bank: 'ประกอบการทำธุรกรรมกับธนาคาร',
    employer: 'ยื่นต่อนายจ้าง',
    other: 'ใช้เป็นหลักฐาน',
  },
  en: {
    visa: 'a visa application or extension',
    bank: 'a bank application',
    employer: 'the lessee’s employer',
    other: 'any purpose the lessee needs',
  },
};

export const certificateTitle = (language: ContractLanguage) =>
  language === 'en' ? 'Certificate of rent payment' : 'หนังสือรับรองการชำระค่าเช่า';
export const incomeSummaryTitle = (language: ContractLanguage) =>
  language === 'en' ? 'Annual rental income summary' : 'สรุปรายได้ค่าเช่ารายปี';

const meta = (rows: [string, string][]) =>
  `<table class="meta">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;

const signature = (name: string, th: boolean, date: string) =>
  `<section class="signatures"><table class="sign"><tr><td></td><td><div>${th ? 'ลงชื่อ' : 'Signed'} ........................................ ${th ? 'ผู้ให้เช่า' : 'Lessor'}</div><div>(${esc(name)})</div><div class="when">${th ? 'ออกทางอิเล็กทรอนิกส์เมื่อ' : 'Issued electronically on'} ${esc(date)}</div></td></tr></table></section>`;

/** The rent payment certificate (B7.5, D-253): who rents what since when, and the payments received in the period. */
export function certificateBody(language: ContractLanguage, d: CertificateData): string {
  const th = language === 'th';
  const head = `<header><h1>${esc(certificateTitle(language))}</h1>${meta([
    [th ? 'เลขที่' : 'No.', d.number],
    [th ? 'วันที่' : 'Date', d.issuedOn],
  ])}</header>`;
  const rows = d.payments.length
    ? d.payments
        .map(
          (p) =>
            `<tr><td>${esc(p.date)}</td><td>${esc(p.number)}</td><td class="num">${esc(p.amount)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="3">${th ? '— ไม่มีรายการชำระในช่วงนี้ —' : '— no payment in this period —'}</td></tr>`;
  const table = `<table class="lines"><tr><th>${th ? 'วันที่รับชำระ' : 'Received on'}</th><th>${th ? 'ใบเสร็จเลขที่' : 'Receipt no.'}</th><th class="num">${th ? 'จำนวนเงิน (บาท)' : 'Amount (THB)'}</th></tr>${rows}<tr><td colspan="2"><b>${th ? 'รวม' : 'Total'}</b></td><td class="num"><b>${esc(d.total)}</b></td></tr></table>`;
  const body = th
    ? `<p>ข้าพเจ้า <b>${esc(d.lessor.legalName)}</b>${d.lessor.taxId ? ` เลขประจำตัวผู้เสียภาษี ${esc(d.lessor.taxId)}` : ''} ที่อยู่ ${esc(d.lessor.address)} ในฐานะผู้ให้เช่า ขอรับรองว่า <b>${esc(d.lessee.displayName)}</b> เป็นผู้เช่าทรัพย์สินเลขที่ ${esc(d.premises.unitNo)} ${esc(d.premises.propertyName)} ${esc(d.premises.address)} ตามสัญญาเช่า${d.lease.number ? `เลขที่ ${esc(d.lease.number)}` : ''} ระยะเวลาเช่า ${esc(d.lease.startDate)} ถึง ${esc(d.lease.endDate)} ค่าเช่าเดือนละ ${esc(d.lease.rent)} บาท</p>
<p>ในช่วงวันที่ ${esc(d.period.from)} ถึง ${esc(d.period.to)} ผู้ให้เช่าได้รับชำระค่าเช่าและค่าใช้จ่ายตามสัญญาจากผู้เช่า ดังนี้</p>${table}
<p>รวมเป็นเงิน <b>${esc(d.total)} บาท</b> (${esc(d.totalText)}) ${d.outstanding ? `ณ วันที่ออกหนังสือนี้ ผู้เช่ามียอดค้างชำระ ${esc(d.outstanding)} บาท` : 'ณ วันที่ออกหนังสือนี้ ผู้เช่าไม่มียอดค้างชำระ'}</p>
<p>หนังสือนี้ออกให้เพื่อ${esc(PURPOSE.th[d.purpose])} ตามคำขอของผู้เช่า</p>`
    : `<p>I, <b>${esc(d.lessor.legalName)}</b>${d.lessor.taxId ? `, tax identification no. ${esc(d.lessor.taxId)}` : ''}, of ${esc(d.lessor.address)}, as the lessor, certify that <b>${esc(d.lessee.displayName)}</b> rents the premises no. ${esc(d.premises.unitNo)}, ${esc(d.premises.propertyName)}, ${esc(d.premises.address)}, under the lease${d.lease.number ? ` no. ${esc(d.lease.number)}` : ''} from ${esc(d.lease.startDate)} to ${esc(d.lease.endDate)} at a rent of THB ${esc(d.lease.rent)} per month.</p>
<p>From ${esc(d.period.from)} to ${esc(d.period.to)} the lessor received the following payments of rent and charges under the lease:</p>${table}
<p>Total <b>THB ${esc(d.total)}</b> (${esc(d.totalText)}). ${d.outstanding ? `On the date of this certificate THB ${esc(d.outstanding)} is overdue.` : 'On the date of this certificate nothing is overdue.'}</p>
<p>This certificate is issued at the lessee’s request for ${esc(PURPOSE.en[d.purpose])}.</p>`;
  return `<article class="certificate">${head}<section>${body}</section>${signature(d.lessor.legalName, th, d.issuedOn)}</article>`;
}

/**
 * The annual rental income summary of one unit (B7.5, D-253): rent and charges received month by month, deposits
 * retained, the gross income of section 40(5) and the flat-rate deduction as an estimate. ⚖ O-017: a summary to help
 * the owner's PND 90 / 94, never a tax filing.
 */
export function incomeSummaryBody(language: ContractLanguage, d: IncomeSummaryData): string {
  const th = language === 'th';
  const head = `<header><h1>${esc(incomeSummaryTitle(language))}</h1>${meta([
    [th ? 'เลขที่' : 'No.', d.number],
    [th ? 'ปีภาษี' : 'Tax year', d.year],
    [th ? 'วันที่' : 'Date', d.issuedOn],
    [th ? 'ผู้มีเงินได้' : 'Owner', `${d.owner.legalName}${d.owner.taxId ? ` (${d.owner.taxId})` : ''}`],
    [th ? 'ทรัพย์สิน' : 'Premises', `${d.premises.unitNo} ${d.premises.propertyName} ${d.premises.address}`],
  ])}</header>`;
  const months = `<table class="lines"><tr><th>${th ? 'เดือน' : 'Month'}</th><th class="num">${th ? 'ค่าเช่าที่ได้รับ (บาท)' : 'Rent received (THB)'}</th></tr>${d.months
    .map((m) => `<tr><td>${esc(m.label)}</td><td class="num">${esc(m.amount)}</td></tr>`)
    .join('')}</table>`;
  const totals = `<table class="lines">
<tr><td>${th ? 'ค่าเช่าที่ได้รับชำระ' : 'Rent received'}</td><td class="num">${esc(d.rent)}</td></tr>
<tr><td>${th ? 'เงินประกันที่หักไว้ (ค่าเสียหาย)' : 'Deposits retained (damage)'}</td><td class="num">${esc(d.retained)}</td></tr>
<tr><td><b>${th ? 'เงินได้พึงประเมินตามมาตรา 40(5)' : 'Assessable income, section 40(5)'}</b></td><td class="num"><b>${esc(d.gross)}</b></td></tr>
<tr><td>${th ? `หักค่าใช้จ่ายแบบเหมาร้อยละ ${esc(d.deductionPercent)} (ประมาณการ)` : `Flat-rate deduction ${esc(d.deductionPercent)}% (estimate)`}</td><td class="num">${esc(d.deduction)}</td></tr>
<tr><td>${th ? 'เงินได้หลังหักค่าใช้จ่าย (ประมาณการ)' : 'Income after the deduction (estimate)'}</td><td class="num">${esc(d.net)}</td></tr>
<tr><td>${th ? 'ค่าน้ำ ค่าไฟ และค่าบริการที่เรียกเก็บตามจริง (แสดงแยก ไม่รวมในเงินได้ข้างต้น)' : 'Utilities and service charges passed on (shown apart, not in the income above)'}</td><td class="num">${esc(d.charges)}</td></tr>
</table>`;
  const expenses = d.expenseItems.length
    ? `<table class="lines"><tr><th>${th ? 'ค่าซ่อมแซมที่เจ้าของรับภาระ (บันทึกในระบบ)' : 'Repairs borne by the owner (recorded on the platform)'}</th><th class="num">${th ? 'บาท' : 'THB'}</th></tr>${d.expenseItems
        .map((e) => `<tr><td>${esc(e.label)}</td><td class="num">${esc(e.amount)}</td></tr>`)
        .join('')}
<tr><td><b>${th ? 'รวมค่าซ่อมแซม' : 'Total repairs'}</b></td><td class="num"><b>${esc(d.expenses)}</b></td></tr>
<tr><td>${th ? 'เงินได้หลังหักค่าใช้จ่ายตามจริงที่บันทึก (ประมาณการ)' : 'Income after the recorded actual expenses (estimate)'}</td><td class="num">${esc(d.netActual)}</td></tr>
</table>`
    : '';
  const note = th
    ? `<p>เงินได้พึงประเมินรวม ${esc(d.gross)} บาท (${esc(d.grossText)})</p><p class="sub">เอกสารนี้สรุปจากใบเสร็จที่ออกผ่านระบบในปีภาษี เพื่อประกอบการยื่นแบบ ภ.ง.ด. 90 / 94 ของผู้มีเงินได้ที่เป็นบุคคลธรรมดา ไม่ใช่การยื่นภาษี และไม่รวมรายได้หรือค่าใช้จ่ายที่ไม่ได้บันทึกในระบบ กรณีเลือกหักค่าใช้จ่ายตามความจำเป็นและสมควร ต้องใช้หลักฐานค่าใช้จ่ายจริง</p>`
    : `<p>Total assessable income THB ${esc(d.gross)} (${esc(d.grossText)}).</p><p class="sub">Summarised from the receipts issued through the platform in the tax year, to help an individual owner file PND 90 / 94. This is not a tax filing and leaves out income or expenses not recorded on the platform; deducting actual expenses instead of the flat rate needs the actual evidence.</p>`;
  return `<article class="summary">${head}<section>${months}${totals}${expenses}${note}</section></article>`;
}

export const purposeText = (purpose: RentCertificatePurpose, language: ContractLanguage) =>
  PURPOSE[language][purpose];

import { formatThb, thaiDate } from '@modules/ops-leases/thai-text';
import Handlebars from 'handlebars';

import { type BillingDocType } from './document-views';

/**
 * Handlebars templates of the billing documents (B4.3, D-022, D-050): Thai, A4, and the 80 mm thermal variant of
 * invoices and receipts. Versioned by key (`documentTemplate` in the invoice snapshot names the key + version the
 * invoice was issued with). The VAT block appears only for VAT-registered issuers (O-004); invoices carry the
 * disclosure of every meter line (registers, dates, reading source, the utility's rate, D-022).
 */
export const hbs = Handlebars.create();
hbs.registerHelper('thb', (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' ? (v === '' ? '' : formatThb(String(v))) : '',
);
hbs.registerHelper('date', (v: unknown) => (typeof v === 'string' && v ? thaiDate(v.slice(0, 10)) : ''));
hbs.registerHelper('period', (v: unknown) => {
  if (typeof v !== 'string' || !v.includes('|')) return '';
  const [from, to] = v.split('|') as [string, string];
  return `${thaiDate(from)} – ${thaiDate(to)}`;
});
const UNIT_TH: Record<string, string> = {
  kwh: 'หน่วย',
  m3: 'ลบ.ม.',
  sqm: 'ตร.ม.',
  month: 'เดือน',
  day: 'วัน',
  item: 'รายการ',
};
hbs.registerHelper('unitTh', (v: unknown) => (typeof v === 'string' ? (UNIT_TH[v] ?? v) : ''));

export type Paper = 'a4' | 'thermal_80mm';

export interface TemplateDef {
  key: string;
  version: number;
  source: string;
}

const ISSUER = `<header class="issuer">
{{#if issuer.logoDataUrl}}<img class="logo" src="{{issuer.logoDataUrl}}" alt="">{{/if}}
<div><b>{{issuer.name}}</b>{{#if issuer.branch}} ({{issuer.branch}}){{/if}}<br>{{issuer.address}}{{#if issuer.taxId}}<br>เลขประจำตัวผู้เสียภาษีอากร {{issuer.taxId}}{{/if}}</div>
</header>`;

const VAT_ROWS = `{{#if vat}}<tr><td>ภาษีมูลค่าเพิ่ม {{vat.ratePct}}%</td><td class="num">{{thb vat.amount}}</td></tr>{{/if}}`;

const INVOICE_A4 = `${ISSUER}
<h1>{{title}}</h1>
<table class="meta">
<tr><td>เลขที่</td><td><b>{{number}}</b></td><td>วันที่ออก</td><td>{{date issuedOn}}</td></tr>
<tr><td>ผู้เช่า/ผู้ชำระ</td><td>{{customer.name}}</td><td>ครบกำหนดชำระ</td><td><b>{{date dueOn}}</b></td></tr>
<tr><td>ห้อง</td><td>{{unitNo}} · {{buildingName}}</td><td>รอบบิล</td><td>{{date period.start}} – {{date period.end}}</td></tr>
{{#if leaseNumber}}<tr><td>สัญญาเช่า</td><td>{{leaseNumber}}</td><td></td><td></td></tr>{{/if}}
</table>
<table class="items">
<tr class="head"><td>#</td><td>รายการ</td><td class="num">จำนวน</td><td class="num">ราคาต่อหน่วย</td><td class="num">จำนวนเงิน (บาท)</td></tr>
{{#each lines}}
<tr><td>{{no}}</td><td>{{description}}{{#if period}}<div class="sub">{{period period}}</div>{{/if}}</td><td class="num">{{quantity}} {{unitTh unit}}</td><td class="num">{{unitPrice}}</td><td class="num">{{thb amount}}</td></tr>
{{#if meter}}<tr class="meter"><td></td><td colspan="4">
{{#each meter.segments}}มิเตอร์ {{code}}: เลขครั้งก่อน {{from}}{{#if fromAt}} ({{date fromAt}} · {{fromSource}}){{/if}} → เลขครั้งนี้ {{to}}{{#if toAt}} ({{date toAt}} · {{toSource}}){{/if}}<br>{{/each}}
ใช้ไป {{meter.units}} {{unitTh unit}}{{#if meter.capPerUnit}} · อัตราที่ผู้ให้บริการสาธารณูปโภคเรียกเก็บ {{meter.capPerUnit}} บาท/หน่วย{{#if meter.utilityReference}} ({{meter.utilityReference}}){{/if}}{{/if}}
{{#if meter.aboveCap}}<div class="warn">อัตรานี้สูงกว่าอัตราที่การไฟฟ้า/การประปาเรียกเก็บ (ผู้ให้เช่ารับทราบแล้ว)</div>{{/if}}
{{#if meter.estimated}}<div class="warn">ประมาณการ — จะปรับตามเลขมิเตอร์จริงในรอบถัดไป</div>{{/if}}
</td></tr>{{/if}}
{{/each}}
</table>
<table class="totals">
<tr><td>รวม</td><td class="num">{{thb subtotal}}</td></tr>
${VAT_ROWS}
<tr class="grand"><td>รวมทั้งสิ้น</td><td class="num">{{thb total}}</td></tr>
<tr><td colspan="2" class="text">({{totalText}})</td></tr>
{{#if hasPrior}}<tr><td>ยอดค้างชำระยกมา</td><td class="num">{{thb priorBalance}}</td></tr>
<tr class="grand"><td>ยอดที่ต้องชำระ</td><td class="num">{{thb amountDue}}</td></tr>
<tr><td colspan="2" class="text">({{amountDueText}})</td></tr>{{/if}}
</table>
<section class="pay">
<h2>การชำระเงิน</h2>
{{#if payment.qrDataUrl}}<img class="qr" src="{{payment.qrDataUrl}}" alt="Thai QR"><p>สแกน Thai QR ยอด {{thb amountDue}} บาท{{#if payment.reference}} อ้างอิง {{payment.reference}}{{/if}}</p>{{/if}}
{{#if payment.bankName}}<p>โอนเข้าบัญชี {{payment.bankName}} ชื่อบัญชี {{payment.accountName}} เลขที่ {{payment.accountMasked}}</p>{{/if}}
<p>เงินเข้าบัญชีของผู้ให้เช่าโดยตรง ระบบไม่ได้ถือเงินแทน</p>
</section>
<footer class="notes">
<p>ค่าไฟฟ้าและค่าน้ำประปาคำนวณจากเลขมิเตอร์ตามรายการข้างต้น แสดงเลขครั้งก่อน เลขครั้งนี้ วันที่อ่าน และแหล่งที่มาของเลขมิเตอร์ (ประกาศคณะกรรมการว่าด้วยสัญญา พ.ศ. 2568 ข้อ 4 (8))</p>
{{#unless issuer.vatRegistered}}<p>ผู้ให้เช่าไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม เอกสารนี้ไม่ใช่ใบกำกับภาษี</p>{{/unless}}
</footer>`;

const INVOICE_80MM = `<div class="c"><b>{{issuer.displayName}}</b>{{#if issuer.taxId}}<br>เลขผู้เสียภาษี {{issuer.taxId}}{{/if}}</div>
<h1>{{title}}</h1>
<p>เลขที่ {{number}}<br>วันที่ {{date issuedOn}} · ครบกำหนด {{date dueOn}}<br>ห้อง {{unitNo}} · {{customer.name}}<br>รอบ {{date period.start}} – {{date period.end}}</p>
<table class="items">
{{#each lines}}<tr><td>{{description}}{{#if meter}}<div class="sub">{{#each meter.segments}}{{from}}→{{to}} ({{toSource}}) {{/each}}= {{meter.units}} × {{unitPrice}}{{#if meter.estimated}} · ประมาณการ{{/if}}</div>{{/if}}</td><td class="num">{{thb amount}}</td></tr>{{/each}}
</table>
<table class="totals">
${VAT_ROWS}
<tr class="grand"><td>รวม</td><td class="num">{{thb total}}</td></tr>
{{#if hasPrior}}<tr><td>ค้างยกมา</td><td class="num">{{thb priorBalance}}</td></tr><tr class="grand"><td>ต้องชำระ</td><td class="num">{{thb amountDue}}</td></tr>{{/if}}
</table>
{{#if payment.qrDataUrl}}<div class="c"><img class="qr" src="{{payment.qrDataUrl}}" alt="Thai QR"><br>อ้างอิง {{payment.reference}}</div>{{/if}}
{{#if payment.bankName}}<p class="c">{{payment.bankName}} {{payment.accountMasked}}</p>{{/if}}`;

const NOTE_A4 = `${ISSUER}
<h1>{{title}}</h1>
<table class="meta">
<tr><td>เลขที่</td><td><b>{{number}}</b></td><td>วันที่</td><td>{{date issuedOn}}</td></tr>
<tr><td>ลูกค้า</td><td>{{customer.name}}{{#if unitNo}} · ห้อง {{unitNo}}{{/if}}</td><td>อ้างถึงใบแจ้งหนี้</td><td>{{invoice.number}} ลงวันที่ {{date invoice.issuedOn}}</td></tr>
<tr><td>เหตุผล</td><td colspan="3">{{reason}} — {{reasonText}}</td></tr>
</table>
<table class="items">
<tr class="head"><td>#</td><td>รายการ</td><td class="num">จำนวนเงิน (บาท)</td></tr>
{{#each lines}}<tr><td>{{no}}</td><td>{{description}}</td><td class="num">{{thb amount}}</td></tr>{{/each}}
</table>
<table class="totals">
<tr><td>มูลค่าตามใบแจ้งหนี้เดิม</td><td class="num">{{thb originalValue}}</td></tr>
<tr><td>มูลค่าที่ถูกต้อง</td><td class="num">{{thb correctedValue}}</td></tr>
<tr><td>ผลต่าง</td><td class="num">{{thb subtotal}}</td></tr>
${VAT_ROWS}
<tr class="grand"><td>รวมทั้งสิ้น</td><td class="num">{{thb total}}</td></tr>
<tr><td colspan="2" class="text">({{totalText}})</td></tr>
</table>`;

const RECEIPT_A4 = `${ISSUER}
<h1>{{title}}</h1>
<table class="meta">
<tr><td>เลขที่</td><td><b>{{number}}</b></td><td>วันที่</td><td>{{date issuedOn}}</td></tr>
<tr><td>ได้รับเงินจาก</td><td colspan="3">{{customer.name}}{{#if unitNo}} · ห้อง {{unitNo}}{{/if}}{{#if customer.address}}<br>{{customer.address}}{{/if}}{{#if customer.taxId}}<br>เลขประจำตัวผู้เสียภาษีอากร {{customer.taxId}}{{/if}}</td></tr>
</table>
<table class="items">
<tr class="head"><td>รายการ</td><td>อ้างอิง</td><td class="num">จำนวนเงิน (บาท)</td></tr>
{{#each items}}<tr><td>{{description}}</td><td>{{reference}}</td><td class="num">{{thb amount}}</td></tr>{{/each}}
</table>
<table class="totals">
{{#if vat}}<tr><td>มูลค่าก่อนภาษี</td><td class="num">{{thb subtotal}}</td></tr>{{/if}}
${VAT_ROWS}
<tr class="grand"><td>รวมทั้งสิ้น</td><td class="num">{{thb total}}</td></tr>
<tr><td colspan="2" class="text">({{totalText}})</td></tr>
</table>
<p>ชำระโดย {{method}}{{#if paymentReference}} อ้างอิง {{paymentReference}}{{/if}}</p>`;

const RECEIPT_80MM = `<div class="c"><b>{{issuer.displayName}}</b>{{#if issuer.taxId}}<br>เลขผู้เสียภาษี {{issuer.taxId}}{{/if}}</div>
<h1>{{title}}</h1>
<p>เลขที่ {{number}}<br>วันที่ {{date issuedOn}}<br>{{customer.name}}{{#if unitNo}} · ห้อง {{unitNo}}{{/if}}</p>
<table class="items">{{#each items}}<tr><td>{{description}}{{#if reference}}<div class="sub">{{reference}}</div>{{/if}}</td><td class="num">{{thb amount}}</td></tr>{{/each}}</table>
<table class="totals">${VAT_ROWS}<tr class="grand"><td>รวม</td><td class="num">{{thb total}}</td></tr></table>
<p class="c">ชำระโดย {{method}}</p>`;

export const TEMPLATES: Record<string, TemplateDef> = {
  invoice_a4: { key: 'invoice_a4_th', version: 1, source: INVOICE_A4 },
  invoice_thermal_80mm: { key: 'invoice_80mm_th', version: 1, source: INVOICE_80MM },
  credit_note_a4: { key: 'credit_note_a4_th', version: 1, source: NOTE_A4 },
  debit_note_a4: { key: 'debit_note_a4_th', version: 1, source: NOTE_A4 },
  receipt_a4: { key: 'receipt_a4_th', version: 1, source: RECEIPT_A4 },
  receipt_thermal_80mm: { key: 'receipt_80mm_th', version: 1, source: RECEIPT_80MM },
  tax_invoice_a4: { key: 'tax_invoice_a4_th', version: 1, source: RECEIPT_A4 },
  receipt_tax_invoice_a4: { key: 'receipt_tax_invoice_a4_th', version: 1, source: RECEIPT_A4 },
  receipt_tax_invoice_thermal_80mm: { key: 'receipt_tax_invoice_80mm_th', version: 1, source: RECEIPT_80MM },
};

/** The template of a document type and paper (thermal exists for invoices and receipts only). */
export function templateFor(docType: BillingDocType, paper: Paper): TemplateDef {
  const t = TEMPLATES[`${docType}_${paper}`];
  if (!t) throw new RangeError(`no ${paper} template for ${docType}`);
  return t;
}

export const STYLE_A4 = `
@page { size: A4; }
body { font-family: 'Sarabun', sans-serif; font-size: 11.5pt; line-height: 1.45; color: #111; }
header.issuer { display: flex; gap: 4mm; align-items: flex-start; margin-bottom: 3mm; }
img.logo { max-height: 18mm; max-width: 40mm; }
h1 { font-size: 17pt; text-align: center; margin: 1mm 0 3mm; }
h2 { font-size: 12.5pt; margin: 4mm 0 1mm; }
p { margin: 0 0 1.5mm; }
table { border-collapse: collapse; width: 100%; }
table.meta td { padding: 0.5mm 2mm 0.5mm 0; vertical-align: top; }
table.items { margin-top: 3mm; }
table.items td { padding: 1mm 1.5mm; border-bottom: 0.2mm solid #ccc; vertical-align: top; }
table.items tr.head td { font-weight: 700; border-bottom: 0.4mm solid #333; }
table.items tr.meter td { font-size: 9.5pt; color: #333; border-bottom: 0.2mm solid #ccc; }
table.totals { width: 60%; margin: 3mm 0 0 auto; }
table.totals td { padding: 0.5mm 1.5mm; }
table.totals tr.grand td { font-weight: 700; border-top: 0.3mm solid #333; }
td.num { text-align: right; white-space: nowrap; }
td.text { text-align: right; font-size: 10pt; }
.sub { font-size: 9pt; color: #555; }
.warn { color: #b00000; font-weight: 700; }
img.qr { width: 38mm; height: 38mm; }
footer.notes { margin-top: 6mm; font-size: 8.5pt; color: #555; }
`;

export const STYLE_80MM = `
body { font-family: 'Sarabun', sans-serif; font-size: 9pt; line-height: 1.35; color: #000; margin: 0; }
h1 { font-size: 12pt; text-align: center; margin: 1mm 0; }
p { margin: 0 0 1mm; }
.c { text-align: center; }
table { border-collapse: collapse; width: 100%; }
td { padding: 0.4mm 0; vertical-align: top; }
td.num { text-align: right; white-space: nowrap; padding-left: 2mm; }
tr.grand td { font-weight: 700; border-top: 0.3mm dashed #000; }
.sub { font-size: 7.5pt; }
img.qr { width: 40mm; height: 40mm; }
`;

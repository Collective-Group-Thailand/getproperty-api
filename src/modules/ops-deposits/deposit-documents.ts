import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { ContractRenderer } from '@modules/ops-leases/contract-renderer';
import { bahtText, formatThb, thaiDate } from '@modules/ops-leases/thai-text';
import { Inject, Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';

const hbs = Handlebars.create();
const esc = (s: string | number | null | undefined) => hbs.Utils.escapeExpression(String(s ?? ''));

export interface StatementData {
  number: string;
  tenantName: string;
  lessee: string;
  unit: string;
  contractNumber: string | null;
  moveOutOn: string;
  deadlineOn: string;
  depositHeld: string;
  items: { description: string; amount: string }[];
  deductionsTotal: string;
  utilitiesFinal: string;
  /** Advance rent the final invoice did not use, paid back with the deposit (D-177). */
  advanceRentUnused?: string;
  refundAmount: string;
  refundMethod: string;
  refundReference: string | null;
  refundedOn: string;
  late: boolean;
}

export interface ReceiptData {
  number: string;
  tenantName: string;
  lessee: string;
  unit: string;
  contractNumber: string | null;
  receivedOn: string;
  security: string;
  advanceRent: string;
  reference: string | null;
}

export interface InspectionReportData {
  number: string;
  tenantName: string;
  unit: string;
  type: string;
  completedOn: string;
  items: {
    label: string;
    condition: string;
    notes: string | null;
    photos: number;
    meterRegister: string | null;
  }[];
  notes: string | null;
}

const CONDITION_TH: Record<string, string> = {
  good: 'ดี',
  fair: 'พอใช้',
  damaged: 'ชำรุด',
  missing: 'สูญหาย',
  not_applicable: 'ไม่มี',
};
const TYPE_TH: Record<string, string> = {
  move_in: 'ตรวจรับห้อง (เข้าอยู่)',
  move_out: 'ตรวจคืนห้อง (ย้ายออก)',
  periodic: 'ตรวจตามรอบ',
};
const METHOD_TH: Record<string, string> = {
  bank_transfer: 'โอนเงินเข้าบัญชี',
  cash: 'เงินสด',
  offset: 'หักกลบหนี้',
};

/**
 * The deposit documents (D-023, D-050): deposit receipt, settlement statement (itemised deductions, refund, the
 * 7-day deadline) and the inspection report — Thai A4 PDFs through the PDF renderer port with the contract fonts.
 */
@Injectable()
export class DepositDocuments {
  constructor(
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    private readonly contracts: ContractRenderer,
  ) {}

  private async render(title: string, number: string, body: string): Promise<Buffer> {
    return this.pdf.render(await this.contracts.brandedDocument(body, title), {
      title,
      footer: `${title} เลขที่ ${number}`,
    });
  }

  receipt(d: ReceiptData): Promise<Buffer> {
    const total = (Number(d.security) + Number(d.advanceRent)).toFixed(2);
    const body = `<h1>ใบรับเงินประกันและค่าเช่าล่วงหน้า</h1>
<p>เลขที่ ${esc(d.number)} · วันที่ ${esc(thaiDate(d.receivedOn))}</p>
<p>${esc(d.tenantName)} ได้รับเงินจาก ${esc(d.lessee)} ห้อง ${esc(d.unit)}${d.contractNumber ? ` ตามสัญญาเช่าเลขที่ ${esc(d.contractNumber)}` : ''}</p>
<table class="lines"><tr><td>เงินประกันการเช่า</td><td class="num">${esc(formatThb(d.security))} บาท</td></tr>
<tr><td>ค่าเช่าล่วงหน้า</td><td class="num">${esc(formatThb(d.advanceRent))} บาท</td></tr>
<tr><td><b>รวม</b></td><td class="num"><b>${esc(formatThb(total))} บาท</b> (${esc(bahtText(total))})</td></tr></table>
${d.reference ? `<p>อ้างอิงการชำระ: ${esc(d.reference)}</p>` : ''}
<p>เงินประกันจะคืนภายใน 7 วันนับแต่วันส่งมอบห้องคืน หักได้เฉพาะความเสียหายที่มีหลักฐาน ไม่หักค่าเสื่อมสภาพตามปกติ</p>`;
    return this.render('ใบรับเงินประกัน', d.number, body);
  }

  statement(d: StatementData): Promise<Buffer> {
    const rows = d.items
      .map(
        (i) => `<tr><td>${esc(i.description)}</td><td class="num">${esc(formatThb(i.amount))} บาท</td></tr>`,
      )
      .join('');
    const body = `<h1>ใบแจ้งรายการคืนเงินประกัน</h1>
<p>เลขที่ ${esc(d.number)} · ${esc(d.tenantName)}</p>
<p>ผู้เช่า ${esc(d.lessee)} ห้อง ${esc(d.unit)}${d.contractNumber ? ` สัญญาเลขที่ ${esc(d.contractNumber)}` : ''}</p>
<p>ส่งมอบห้องคืนวันที่ ${esc(thaiDate(d.moveOutOn))} · กำหนดคืนเงินภายในวันที่ ${esc(thaiDate(d.deadlineOn))}</p>
<table class="lines"><tr><td>เงินประกันที่ได้รับไว้</td><td class="num">${esc(formatThb(d.depositHeld))} บาท</td></tr>
${rows || '<tr><td>ไม่มีรายการหัก</td><td></td></tr>'}
<tr><td>รวมรายการหัก</td><td class="num">${esc(formatThb(d.deductionsTotal))} บาท</td></tr>
<tr><td>ค่าสาธารณูปโภคงวดสุดท้าย</td><td class="num">${esc(formatThb(d.utilitiesFinal))} บาท</td></tr>
${d.advanceRentUnused && Number(d.advanceRentUnused) > 0 ? `<tr><td>คืนค่าเช่าล่วงหน้าส่วนที่ไม่ได้ใช้</td><td class="num">${esc(formatThb(d.advanceRentUnused))} บาท</td></tr>` : ''}
<tr><td><b>คืนเงิน</b></td><td class="num"><b>${esc(formatThb(d.refundAmount))} บาท</b> (${esc(bahtText(d.refundAmount))})</td></tr></table>
<p>คืนเงินวันที่ ${esc(thaiDate(d.refundedOn))} โดย${esc(METHOD_TH[d.refundMethod] ?? d.refundMethod)}${d.refundReference ? ` อ้างอิง ${esc(d.refundReference)}` : ''}${d.late ? ' <span class="termination">(คืนเกินกำหนด)</span>' : ''}</p>
<p>รายการหักทุกรายการมีหลักฐานภาพถ่ายจากการตรวจคืนห้อง ไม่มีการหักค่าเสื่อมสภาพจากการใช้งานตามปกติ</p>`;
    return this.render('ใบแจ้งรายการคืนเงินประกัน', d.number, body);
  }

  inspectionReport(d: InspectionReportData): Promise<Buffer> {
    const rows = d.items
      .map(
        (i) =>
          `<tr><td>${esc(i.label)}</td><td>${esc(CONDITION_TH[i.condition] ?? i.condition)}</td><td>${esc(i.meterRegister ?? '')}</td><td>${esc(i.notes ?? '')}</td><td class="num">${i.photos}</td></tr>`,
      )
      .join('');
    const body = `<h1>บันทึกการตรวจสภาพห้อง</h1>
<p>เลขที่ ${esc(d.number)} · ${esc(TYPE_TH[d.type] ?? d.type)} · ${esc(d.tenantName)} ห้อง ${esc(d.unit)} · วันที่ ${esc(thaiDate(d.completedOn))}</p>
<table class="lines"><tr><td><b>รายการ</b></td><td><b>สภาพ</b></td><td><b>เลขมิเตอร์</b></td><td><b>หมายเหตุ</b></td><td><b>ภาพ</b></td></tr>${rows}</table>
${d.notes ? `<p>${esc(d.notes)}</p>` : ''}`;
    return this.render('บันทึกการตรวจสภาพห้อง', d.number, body);
  }
}

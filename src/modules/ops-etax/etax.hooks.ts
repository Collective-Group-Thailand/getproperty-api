import { toBangkokIso } from '@common/time/bangkok';
import {
  billedParty,
  operators,
  registerNotifiable,
  tenantName,
} from '@core/notifications/notifiable-events';
import { type Tx } from '@database/prisma.service';
import { type ExportJob } from '@generated/prisma/client';
import { BillingDocuments } from '@modules/ops-documents/billing-documents.service';
import { type ExportFile, ExportsService } from '@modules/ops-documents/exports.service';
import { formatThb } from '@modules/ops-leases/thai-text';
import { type Column, xlsxOf } from '@modules/ops-receivables/exports/sheets';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { monthRange } from './etax-rules';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STATUS_TH: Record<string, string> = {
  queued: 'รอส่ง',
  submitted: 'ส่งแล้ว รอลงนาม',
  signed: 'ลงนามแล้ว',
  rejected: 'ถูกปฏิเสธ',
  failed: 'ส่งไม่สำเร็จ',
};

export const ETAX_MONTHLY_COLUMNS: readonly Column[] = [
  { key: 'number', header: 'เลขที่เอกสาร' },
  { key: 'typeCode', header: 'ประเภท (ETDA)', width: 12 },
  { key: 'issuedOn', header: 'วันที่ออก', type: 'date' },
  { key: 'buyer', header: 'ผู้ซื้อ / ผู้ชำระ', width: 28 },
  { key: 'subtotal', header: 'มูลค่าก่อนภาษี', type: 'money' },
  { key: 'vatAmount', header: 'ภาษีมูลค่าเพิ่ม', type: 'money' },
  { key: 'total', header: 'รวม', type: 'money' },
  { key: 'status', header: 'สถานะ e-Tax' },
  { key: 'providerDocId', header: 'เลขอ้างอิงผู้ให้บริการ', width: 24 },
  { key: 'signedAt', header: 'ลงนามเมื่อ', width: 22 },
  { key: 'error', header: 'ข้อผิดพลาด', width: 30 },
];

/**
 * e-Tax hooks (B6.2, D-215): the signed PDF goes to the payer by LINE, a rejection (or the last failed retry) to the
 * owner and accountant, the monthly figures to the owner and accountant; `etax_monthly_xlsx` is the accountant's
 * register of the month (one row per document, signed totals at the bottom).
 */
@Injectable()
export class EtaxHooks implements OnModuleInit {
  constructor(
    private readonly exports: ExportsService,
    private readonly billing: BillingDocuments,
  ) {}

  onModuleInit(): void {
    registerNotifiable('etax.signed', async (tx, e) => {
      const payer = e.payload.payerPartyId as string | undefined;
      if (!payer || !e.tenantId) return null;
      return {
        recipients: await billedParty(tx, payer),
        data: {
          tenant: { name: await tenantName(tx, e.tenantId) },
          document: { number: e.payload.number },
          link:
            e.payload.subjectType === 'receipt'
              ? this.billing.receiptLink(e.payload.subjectId as string)
              : this.billing
                  .receiptLink(e.payload.subjectId as string)
                  .replace(/\/receipts\/.*$/, '/documents'),
        },
        consentPurpose: 'resident.service',
      };
    });
    registerNotifiable('etax.rejected', async (tx, e) =>
      e.tenantId
        ? {
            recipients: await operators(tx, e.tenantId, ['owner', 'accountant'], 'owner'),
            data: { tenant: { name: await tenantName(tx, e.tenantId) }, etax: e.payload },
          }
        : null,
    );
    registerNotifiable('etax.monthly_summary', async (tx, e) =>
      e.tenantId
        ? {
            recipients: await operators(tx, e.tenantId, ['owner', 'accountant'], 'owner'),
            data: {
              tenant: { name: await tenantName(tx, e.tenantId) },
              summary: {
                month: e.payload.month,
                signed: (e.payload.signed as { documents: number }).documents,
                vat: formatThb((e.payload.signed as { vatAmount: string }).vatAmount),
                problems:
                  ((e.payload.counts as Record<string, number>).rejected ?? 0) +
                  ((e.payload.counts as Record<string, number>).failed ?? 0),
              },
            },
          }
        : null,
    );
    this.exports.register({
      kind: 'etax_monthly_xlsx',
      validate: (p) =>
        typeof p.period === 'string' && MONTH.test(p.period)
          ? []
          : [{ path: 'period', message: 'a month YYYY-MM' }],
      build: (tx, job) => this.monthlyXlsx(tx, job),
    });
  }

  async monthlyXlsx(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const period = (job.params as { period: string }).period;
    const { from, to } = monthRange(period);
    const rows = await tx.etaxSubmission.findMany({
      where: { tenantId: job.tenantId, issuedAt: { gte: from, lt: to } },
      orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
    });
    const parties = new Map<string, string>();
    for (const r of rows) {
      const subject =
        r.subjectType === 'receipt'
          ? await tx.receipt.findUnique({ where: { id: r.subjectId }, include: { payer: true } })
          : await tx.taxInvoice.findUnique({ where: { id: r.subjectId }, include: { buyer: true } });
      const party = subject && ('payer' in subject ? subject.payer : subject.buyer);
      parties.set(r.id, party?.displayName ?? '');
    }
    const signed = rows.filter((r) => r.status === 'signed');
    const sum = (k: 'subtotal' | 'vatAmount' | 'total') =>
      signed.reduce((s, r) => s + Math.round(Number(r[k].toString()) * 100), 0) / 100;
    const body = await xlsxOf(
      [
        {
          name: `e-Tax ${period}`,
          preamble: [
            `ทะเบียนเอกสาร e-Tax Invoice & e-Receipt งวด ${period}`,
            `สร้างเมื่อ ${toBangkokIso(job.createdAt)}`,
          ],
          columns: ETAX_MONTHLY_COLUMNS,
          rows: rows.map((r) => ({
            number: r.number,
            typeCode: r.documentTypeCode,
            issuedOn: toBangkokIso(r.issuedAt).slice(0, 10),
            buyer: parties.get(r.id) ?? '',
            subtotal: r.subtotal.toFixed(2),
            vatAmount: r.vatAmount.toFixed(2),
            total: r.total.toFixed(2),
            status: STATUS_TH[r.status] ?? r.status,
            providerDocId: r.providerDocId,
            signedAt: r.signedAt ? toBangkokIso(r.signedAt) : null,
            error: r.error,
          })),
          totals: {
            number: 'รวมที่ลงนามแล้ว',
            subtotal: sum('subtotal').toFixed(2),
            vatAmount: sum('vatAmount').toFixed(2),
            total: sum('total').toFixed(2),
          },
        },
      ],
      { creator: 'getproperty', createdAt: job.createdAt },
    );
    return { fileName: `etax-${period}.xlsx`, mimeType: XLSX, body, rowCount: rows.length };
  }
}

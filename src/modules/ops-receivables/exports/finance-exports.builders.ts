import { bangkokDate, startOfBangkokDay, toBangkokIso } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { type ExportJob, type ExportKind } from '@generated/prisma/client';
import { type ExportBuilder, type ExportFile, ExportsService } from '@modules/ops-documents/exports.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type AgingBuckets, daysPastDue } from '../aging';
import {
  type ArrearsExport,
  arrearsWorkbook,
  type ExportMeta,
  flowAccountCsv,
  type IncomeExpenseExport,
  incomeExpenseWorkbook,
  type InvoiceExport,
  invoicesWorkbook,
  type OpenInvoiceExport,
  PAYMENT_METHOD_TH,
  type PaymentExport,
  paymentsWorkbook,
  peakCsv,
  type ReceiptExport,
  type VatDocExport,
  vatPp30Workbook,
} from './finance-formats';
import { sumMoney, xlsxOf } from './sheets';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const m2 = (v: { toString(): string }) => new Decimal(v.toString()).toFixed(2);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function monthRange(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return {
    from: startOfBangkokDay(`${period}-01`),
    to: startOfBangkokDay(next),
    firstDay: `${period}-01`,
    nextDay: next,
  };
}

const realDay = (v: string) =>
  DAY.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function periodProblems(params: Record<string, unknown>, key: 'period' | 'asOf' = 'period') {
  const problems: { path: string; message: string }[] = [];
  if (key === 'period' && (typeof params.period !== 'string' || !MONTH.test(params.period)))
    problems.push({ path: 'period', message: 'a month YYYY-MM' });
  if (
    key === 'asOf' &&
    params.asOf !== undefined &&
    (typeof params.asOf !== 'string' || !realDay(params.asOf))
  )
    problems.push({ path: 'asOf', message: 'a date YYYY-MM-DD' });
  if (
    params.buildingId !== undefined &&
    (typeof params.buildingId !== 'string' || !UUID.test(params.buildingId))
  )
    problems.push({ path: 'buildingId', message: 'a building id' });
  return problems;
}

/**
 * Finance exports (B4.5, D-051): Excel reports of invoices, payments and arrears; FlowAccount and PEAK import files;
 * the VAT output figures of a month (ภ.พ.30, VAT-registered tenants); income/expense per building. Each kind is a
 * builder of the export-job registry (B4.3); rows come from the database, the files from the pure formats.
 */
@Injectable()
export class FinanceExports implements OnModuleInit {
  constructor(
    private readonly exports: ExportsService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    const builder = (
      kind: ExportKind,
      validate: (p: Record<string, unknown>) => { path: string; message: string }[],
      build: (tx: Tx, job: ExportJob) => Promise<ExportFile>,
    ): ExportBuilder => ({ kind, validate, build });
    this.exports.register(
      builder(
        'invoices_xlsx',
        (p) => periodProblems(p),
        (tx, j) => this.invoicesXlsx(tx, j),
      ),
    );
    this.exports.register(
      builder(
        'payments_xlsx',
        (p) => periodProblems(p),
        (tx, j) => this.paymentsXlsx(tx, j),
      ),
    );
    this.exports.register(
      builder(
        'arrears_xlsx',
        (p) => periodProblems(p, 'asOf'),
        (tx, j) => this.arrearsXlsx(tx, j),
      ),
    );
    this.exports.register(
      builder(
        'flowaccount_csv',
        (p) => periodProblems(p),
        (tx, j) => this.accounting(tx, j, 'flowaccount'),
      ),
    );
    this.exports.register(
      builder(
        'peak_csv',
        (p) => periodProblems(p),
        (tx, j) => this.accounting(tx, j, 'peak'),
      ),
    );
    this.exports.register(
      builder(
        'vat_pp30',
        (p) => periodProblems(p),
        (tx, j) => this.vatPp30(tx, j),
      ),
    );
    this.exports.register(
      builder(
        'income_expense',
        (p) => periodProblems(p),
        (tx, j) => this.incomeExpense(tx, j),
      ),
    );
  }

  private scope(job: ExportJob) {
    return { tenantId: job.tenantId, ...(job.buildingId ? { buildingId: job.buildingId } : {}) };
  }

  private async meta(
    tx: Tx,
    job: ExportJob,
    period: string,
  ): Promise<ExportMeta & { taxId: string | null; vatRegistered: boolean }> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: job.tenantId } });
    return {
      issuer: tenant.legalName,
      period,
      generatedAt: toBangkokIso(job.createdAt).slice(0, 16).replace('T', ' '),
      taxId: tenant.taxId,
      vatRegistered: tenant.vatRegistered,
    };
  }

  private async xlsx(
    job: ExportJob,
    fileName: string,
    sheets: Parameters<typeof xlsxOf>[0],
    rowCount: number,
  ) {
    return {
      fileName,
      mimeType: XLSX,
      body: await xlsxOf(sheets, { creator: 'getproperty', createdAt: job.createdAt }),
      rowCount,
    };
  }

  // ------------------------------------------------------------------------------------------- rows

  async invoiceRows(tx: Tx, job: ExportJob, period: string): Promise<InvoiceExport[]> {
    const { from, to } = monthRange(period);
    const rows = await tx.invoice.findMany({
      where: { ...this.scope(job), issuedAt: { gte: from, lt: to } },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        building: { select: { name: true } },
        unit: { select: { unitNo: true } },
        billedParty: { select: { displayName: true, taxId: true, type: true } },
      },
      orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
    });
    return rows.map((i) => {
      const snap = (i.snapshot ?? {}) as { customer?: { address?: string | null; branch?: string | null } };
      return {
        number: i.number ?? '',
        issuedOn: bangkokDate(i.issuedAt!),
        periodStart: dayOf(i.periodStart)!,
        periodEnd: dayOf(i.periodEnd)!,
        dueOn: dayOf(i.dueDate),
        building: i.building.name,
        unitNo: i.unit?.unitNo ?? null,
        payer: i.billedParty.displayName,
        payerTaxId: i.billedParty.taxId,
        payerBranch: snap.customer?.branch ?? null,
        payerAddress: snap.customer?.address ?? null,
        status: i.status,
        subtotal: m2(i.subtotal),
        vat: m2(i.vatAmount),
        total: m2(i.total),
        paid: m2(i.paidTotal),
        credited: m2(i.creditedTotal),
        debited: m2(i.debitedTotal),
        balance: m2(i.balance),
        lines: i.lines.map((l) => ({
          lineNo: l.lineNo,
          kind: l.lineKind,
          description: l.description,
          quantity: new Decimal(l.quantity.toString()).toFixed(3).replace(/\.?0+$/, ''),
          unit: l.unit,
          unitPrice: l.unitPrice
            ? new Decimal(l.unitPrice.toString()).toFixed(4).replace(/(\.\d\d)0+$/, '$1')
            : '',
          amount: m2(l.amount),
          vat: l.vatApplicable,
        })),
      };
    });
  }

  async receiptRows(tx: Tx, job: ExportJob, period: string): Promise<ReceiptExport[]> {
    const { from, to } = monthRange(period);
    const [receipts, taxInvoices] = await Promise.all([
      tx.receipt.findMany({
        where: { ...this.scope(job), issuedAt: { gte: from, lt: to } },
        include: {
          payer: { select: { displayName: true, taxId: true } },
          unit: { select: { unitNo: true } },
          payment: { include: { allocations: { include: { invoice: { select: { number: true } } } } } },
        },
        orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
      }),
      tx.taxInvoice.findMany({
        where: { ...this.scope(job), issuedAt: { gte: from, lt: to }, kind: 'receipt_tax_invoice' },
        include: {
          buyer: { select: { displayName: true, taxId: true } },
          unit: { select: { unitNo: true } },
          payment: { include: { allocations: { include: { invoice: { select: { number: true } } } } } },
        },
        orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
      }),
    ]);
    const refs = (p: { allocations: { invoice: { number: string | null } }[] } | null) =>
      (p?.allocations ?? [])
        .map((a) => a.invoice.number)
        .filter(Boolean)
        .join(' ');
    const method = (p: { method: string } | null) => (p ? (PAYMENT_METHOD_TH[p.method] ?? p.method) : '');
    return [
      ...receipts.map((r): ReceiptExport => ({
        number: r.number,
        kind: 'receipt',
        issuedOn: bangkokDate(r.issuedAt),
        payer: r.payer.displayName,
        payerTaxId: r.payer.taxId,
        payerBranch: null,
        unitNo: r.unit?.unitNo ?? null,
        references: refs(r.payment),
        method: method(r.payment),
        subtotal: m2(r.amount),
        vat: '0.00',
        total: m2(r.amount),
        voided: r.voidedAt !== null,
      })),
      ...taxInvoices.map((t): ReceiptExport => ({
        number: t.number,
        kind: 'receipt_tax_invoice',
        issuedOn: bangkokDate(t.issuedAt),
        payer: t.buyer.displayName,
        payerTaxId: t.buyer.taxId,
        payerBranch: null,
        unitNo: t.unit?.unitNo ?? null,
        references: refs(t.payment),
        method: method(t.payment),
        subtotal: m2(t.subtotal),
        vat: m2(t.vatAmount),
        total: m2(t.total),
        voided: t.voidedAt !== null,
      })),
    ].sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.number.localeCompare(b.number));
  }

  // ------------------------------------------------------------------------------------------- builders

  private async invoicesXlsx(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const period = (job.params as { period: string }).period;
    const rows = await this.invoiceRows(tx, job, period);
    return this.xlsx(
      job,
      `invoices-${period}.xlsx`,
      invoicesWorkbook(await this.meta(tx, job, period), rows),
      rows.length,
    );
  }

  private async paymentsXlsx(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const period = (job.params as { period: string }).period;
    const { from, to } = monthRange(period);
    const pays = await tx.payment.findMany({
      where: { ...this.scope(job), paidAt: { gte: from, lt: to }, status: { in: ['confirmed', 'reversed'] } },
      include: {
        payer: { select: { displayName: true } },
        unit: { select: { unitNo: true } },
        building: { select: { name: true } },
        allocations: { include: { invoice: { select: { number: true } } } },
        receipts: { select: { number: true } },
        taxInvoices: { select: { number: true } },
      },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
    const rows: PaymentExport[] = pays.map((p) => ({
      paidOn: bangkokDate(p.paidAt),
      method: p.method,
      via: p.confirmedVia,
      payer: p.payer?.displayName ?? '',
      unitNo: p.unit?.unitNo ?? null,
      building: p.building.name,
      invoices: p.allocations
        .map((a) => a.invoice.number)
        .filter(Boolean)
        .join(' '),
      amount: m2(p.amount),
      wht: m2(p.whtAmount),
      allocated: m2(p.allocatedTotal),
      credited: m2(p.creditedAmount),
      receipt: [...p.receipts, ...p.taxInvoices].map((r) => r.number).join(' ') || null,
      status: p.status,
      providerRef: p.providerRef,
    }));
    return this.xlsx(
      job,
      `payments-${period}.xlsx`,
      paymentsWorkbook(await this.meta(tx, job, period), rows),
      rows.length,
    );
  }

  private async arrearsXlsx(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const asOf = (job.params as { asOf?: string }).asOf ?? bangkokDate(this.clock.now());
    const balances = await tx.receivableBalance.findMany({
      where: { ...this.scope(job), OR: [{ balance: { not: 0 } }, { openInvoicesCount: { gt: 0 } }] },
      include: {
        party: { select: { displayName: true } },
        unit: { select: { unitNo: true } },
        building: { select: { name: true } },
      },
      orderBy: [{ balance: 'desc' }, { id: 'asc' }],
    });
    const rows: ArrearsExport[] = balances.map((b) => ({
      payer: b.party.displayName,
      unitNo: b.unit?.unitNo ?? null,
      building: b.building.name,
      balance: m2(b.balance),
      credit: m2(b.creditBalance),
      openInvoices: b.openInvoicesCount,
      oldestDueOn: dayOf(b.oldestDueDate),
      daysOverdue: b.daysOverdue,
      aging: b.aging as unknown as AgingBuckets,
    }));
    const open = await tx.invoice.findMany({
      where: {
        ...this.scope(job),
        status: { in: ['issued', 'partially_paid', 'overdue'] },
        balance: { gt: 0 },
      },
      include: { billedParty: { select: { displayName: true } }, unit: { select: { unitNo: true } } },
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    });
    const openRows: OpenInvoiceExport[] = open.map((i) => ({
      number: i.number ?? '',
      payer: i.billedParty.displayName,
      unitNo: i.unit?.unitNo ?? null,
      dueOn: dayOf(i.dueDate),
      daysOverdue: i.dueDate ? Math.max(0, daysPastDue(dayOf(i.dueDate)!, asOf)) : 0,
      total: m2(i.total),
      balance: m2(i.balance),
    }));
    return this.xlsx(
      job,
      `arrears-${asOf}.xlsx`,
      arrearsWorkbook(await this.meta(tx, job, asOf), rows, openRows),
      rows.length,
    );
  }

  private async vatRate(tenantId: string): Promise<string> {
    const v = await this.settings.valueAt<{ rate?: string }>('tax.vat', this.clock.now(), { tenantId });
    return v?.rate ?? '0.07';
  }

  private async accounting(tx: Tx, job: ExportJob, target: 'flowaccount' | 'peak'): Promise<ExportFile> {
    const period = (job.params as { period: string }).period;
    const [invoices, receipts, rate] = await Promise.all([
      this.invoiceRows(tx, job, period),
      this.receiptRows(tx, job, period),
      this.vatRate(job.tenantId),
    ]);
    const text =
      target === 'flowaccount' ? flowAccountCsv(invoices, receipts, rate) : peakCsv(invoices, receipts, rate);
    return {
      fileName: `${target}-${period}.csv`,
      mimeType: 'text/csv',
      body: Buffer.from(text, 'utf8'),
      rowCount: invoices.length + receipts.length,
    };
  }

  private async vatPp30(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const period = (job.params as { period: string }).period;
    const meta = await this.meta(tx, job, period);
    // ภ.พ.30 figures exist only for a VAT-registered tenant (O-004); the job fails with this reason otherwise
    if (!meta.vatRegistered)
      throw new Error('the tenant is not VAT-registered (tenant.vat_registered = false)');
    const { from, to, firstDay, nextDay } = monthRange(period);
    const docs = await tx.taxInvoice.findMany({
      where: { ...this.scope(job), issuedAt: { gte: from, lt: to } },
      include: { buyer: { select: { displayName: true, taxId: true } } },
      orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
    });
    const rows: VatDocExport[] = docs.map((d) => ({
      issuedOn: bangkokDate(d.issuedAt),
      number: d.number,
      kind: d.kind,
      buyer: d.buyer.displayName,
      buyerTaxId: d.buyer.taxId,
      buyerBranch: d.buyer.taxId ? '00000' : null,
      subtotal: m2(d.subtotal),
      vat: m2(d.vatAmount),
      total: m2(d.total),
      voided: d.voidedAt !== null,
    }));
    const utility = await tx.utilityInvoice.findMany({
      where: {
        ...this.scope(job),
        periodEnd: { gte: new Date(`${firstDay}T00:00:00Z`), lt: new Date(`${nextDay}T00:00:00Z`) },
      },
      select: { vat: true },
    });
    const purchase = sumMoney(utility.map((u) => (u.vat ? m2(u.vat) : null)));
    return this.xlsx(
      job,
      `vat-pp30-${period}.xlsx`,
      vatPp30Workbook({ ...meta, branch: '00000' }, rows, purchase),
      rows.length,
    );
  }

  private async incomeExpense(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const period = (job.params as { period: string }).period;
    const { from, to, firstDay, nextDay } = monthRange(period);
    const buildings = await tx.building.findMany({
      where: {
        deletedAt: null,
        ...(job.buildingId ? { id: job.buildingId } : {}),
        OR: [{ ownerTenantId: job.tenantId }, { operatorTenantId: job.tenantId }],
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const rows: IncomeExpenseExport[] = [];
    for (const b of buildings) {
      const scope = { tenantId: job.tenantId, buildingId: b.id };
      const [billed, received, utility] = await Promise.all([
        tx.invoice.aggregate({
          where: { ...scope, issuedAt: { gte: from, lt: to }, status: { not: 'void' } },
          _sum: { total: true },
        }),
        tx.payment.aggregate({
          where: { ...scope, paidAt: { gte: from, lt: to }, status: 'confirmed', method: { not: 'offset' } },
          _sum: { amount: true },
        }),
        tx.utilityInvoice.groupBy({
          by: ['utility'],
          where: {
            ...scope,
            periodEnd: { gte: new Date(`${firstDay}T00:00:00Z`), lt: new Date(`${nextDay}T00:00:00Z`) },
          },
          _sum: { amount: true },
        }),
      ]);
      const util = (k: 'electric' | 'water') => m2(utility.find((u) => u.utility === k)?._sum.amount ?? 0);
      rows.push({
        building: b.name,
        billed: m2(billed._sum.total ?? 0),
        received: m2(received._sum.amount ?? 0),
        electricity: util('electric'),
        water: util('water'),
        // work-order costs arrive with B5 (service requests & work orders)
        workOrders: '0.00',
      });
    }
    return this.xlsx(
      job,
      `income-expense-${period}.xlsx`,
      incomeExpenseWorkbook(await this.meta(tx, job, period), rows),
      rows.length,
    );
  }
}

import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DocumentNumbering } from '@core/documents/numbering.service';
import { SettingsService } from '@core/settings/settings.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Document } from '@generated/prisma/client';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { incomeSummaryBody, incomeSummaryTitle } from './certificate-templates';
import { type ContractLanguage, ContractRenderer } from './contract-renderer';
import { bahtTextEn, englishDate } from './english-text';
import { addressText } from './leases.service';
import { bahtText, formatThb, thaiDate } from './thai-text';

export interface UnitIncome {
  unitId: string;
  unitNo: string;
  buildingId: string;
  /** Rent received each Bangkok month of the year, January first (section 40(5) income). */
  months: string[];
  /** Utilities and service charges received each month (shown apart, not counted as 40(5) income). */
  chargeMonths: string[];
  rent: string;
  charges: string;
  retained: string;
  gross: string;
}

export interface IncomeYear {
  year: number;
  deductionPercent: string;
  units: UnitIncome[];
  totals: { rent: string; charges: string; retained: string; gross: string; deduction: string; net: string };
}

/** Invoice line kinds that are rent of property (section 40(5)); everything else is a utility or a service (D-282). */
export const RENT_LINE_KINDS: readonly string[] = ['rent', 'furniture'];

type Allocation = {
  amount: { toString(): string };
  invoice: { lines: { lineKind: string; amount: { toString(): string } }[] };
};

/**
 * Splits what a receipt received into rent and charges (D-282): each invoice it paid, pro rata of that invoice's
 * rent lines; anything not allocated to an invoice (advance rent, credit) is rent.
 */
export function splitReceipt(
  amount: Decimal.Value,
  allocations: readonly Allocation[],
): { rent: Decimal; charges: Decimal } {
  let rent = new Decimal(0);
  let charges = new Decimal(0);
  let allocated = new Decimal(0);
  for (const a of allocations) {
    const paid = new Decimal(a.amount.toString());
    allocated = allocated.plus(paid);
    const total = a.invoice.lines.reduce((sum, l) => sum.plus(l.amount.toString()), new Decimal(0));
    const rentLines = a.invoice.lines
      .filter((l) => RENT_LINE_KINDS.includes(l.lineKind))
      .reduce((sum, l) => sum.plus(l.amount.toString()), new Decimal(0));
    const share = total.gt(0)
      ? Decimal.min(Decimal.max(paid.times(rentLines).dividedBy(total), 0), paid).toDecimalPlaces(
          2,
          Decimal.ROUND_HALF_UP,
        )
      : paid;
    rent = rent.plus(share);
    charges = charges.plus(paid.minus(share));
  }
  const rest = new Decimal(amount).minus(allocated);
  if (rest.gt(0)) rent = rent.plus(rest);
  return { rent, charges };
}

const MONTHS_TH = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Annual rental income summaries (B7.5, D-253, section 40(5)): per unit and Bangkok calendar year, the rent and
 * charges received (receipts and receipt-tax invoices issued through the platform, not voided, deposits excluded),
 * the deposit deductions kept at settlement, the gross assessable income and the flat-rate deduction
 * (`tax.income_40_5.flat_deduction_percent`) as an estimate. The PDF (`pdf_summary`, series `income_summary`) is a
 * summary for the owner's PND 90 / 94, never a filing (⚖ O-017 wording). Owner expenses join with B7.6.
 */
@Injectable()
export class IncomeSummariesService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly numbering: DocumentNumbering,
    private readonly documents: DocumentsService,
    private readonly renderer: ContractRenderer,
    private readonly audit: AuditService,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private assertYear(year: number) {
    const current = Number(bangkokDate(this.clock.now()).slice(0, 4));
    if (!Number.isInteger(year) || year < 2020 || year > current)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'year', code: 'range', message: `a year between 2020 and ${current}` }],
      });
  }

  async year(ctx: TenantContext, year: number, unitId?: string): Promise<IncomeYear> {
    this.assertYear(year);
    const from = startOfBangkokDay(`${year}-01-01`);
    const to = startOfBangkokDay(`${year + 1}-01-01`);
    const percent = String(
      await this.settings.valueAt<string>('tax.income_40_5.flat_deduction_percent', this.clock.now(), {
        tenantId: ctx.tenantId,
      }),
    );
    const scope = {
      tenantId: ctx.tenantId,
      ...(unitId ? { unitId } : {}),
      ...(ctx.buildingIds ? { buildingId: { in: [...ctx.buildingIds] } } : {}),
    };
    const paidVia = {
      payment: {
        select: {
          allocations: {
            where: { reversedAt: null },
            select: {
              amount: true,
              invoice: { select: { lines: { select: { lineKind: true, amount: true } } } },
            },
          },
        },
      },
    } as const;
    const [receipts, taxReceipts, settlements] = await this.db.tenant(ctx, (tx) =>
      Promise.all([
        tx.receipt.findMany({
          where: {
            ...scope,
            unitId: unitId ?? { not: null },
            kind: { in: ['payment', 'advance'] },
            voidedAt: null,
            issuedAt: { gte: from, lt: to },
          },
          select: { unitId: true, buildingId: true, issuedAt: true, amount: true, ...paidVia },
        }),
        tx.taxInvoice.findMany({
          where: {
            ...scope,
            unitId: unitId ?? { not: null },
            kind: 'receipt_tax_invoice',
            voidedAt: null,
            issuedAt: { gte: from, lt: to },
          },
          select: { unitId: true, buildingId: true, issuedAt: true, total: true, ...paidVia },
        }),
        tx.depositSettlement.findMany({
          where: { ...scope, refundedAt: { gte: from, lt: to }, deductionsTotal: { gt: 0 } },
          select: { unitId: true, buildingId: true, deductionsTotal: true },
        }),
      ]),
    );
    const zeros = () => Array.from({ length: 12 }, () => new Decimal(0));
    const byUnit = new Map<
      string,
      { buildingId: string; rent: Decimal[]; charges: Decimal[]; retained: Decimal }
    >();
    const slot = (id: string, buildingId: string) => {
      let s = byUnit.get(id);
      if (!s) {
        s = { buildingId, rent: zeros(), charges: zeros(), retained: new Decimal(0) };
        byUnit.set(id, s);
      }
      return s;
    };
    const add = (
      unit: string,
      buildingId: string,
      at: Date,
      amount: Decimal.Value,
      payment: { allocations: Allocation[] } | null,
    ) => {
      const m = Number(bangkokDate(at).slice(5, 7)) - 1;
      const s = slot(unit, buildingId);
      const split = splitReceipt(amount, payment?.allocations ?? []);
      s.rent[m] = s.rent[m]!.plus(split.rent);
      s.charges[m] = s.charges[m]!.plus(split.charges);
    };
    for (const r of receipts) add(r.unitId!, r.buildingId, r.issuedAt, r.amount.toString(), r.payment);
    for (const r of taxReceipts) add(r.unitId!, r.buildingId, r.issuedAt, r.total.toString(), r.payment);
    for (const d of settlements) {
      const s = slot(d.unitId, d.buildingId);
      s.retained = s.retained.plus(d.deductionsTotal.toString());
    }
    const unitRows = byUnit.size
      ? await this.db.platform((tx) =>
          tx.unit.findMany({ where: { id: { in: [...byUnit.keys()] } }, select: { id: true, unitNo: true } }),
        )
      : [];
    const unitNo = new Map(unitRows.map((u) => [u.id, u.unitNo]));
    const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.plus(b), new Decimal(0));
    let rent = new Decimal(0);
    let charges = new Decimal(0);
    let retained = new Decimal(0);
    const units: UnitIncome[] = [...byUnit.entries()]
      .map(([id, s]) => {
        const r = sum(s.rent);
        const c = sum(s.charges);
        rent = rent.plus(r);
        charges = charges.plus(c);
        retained = retained.plus(s.retained);
        return {
          unitId: id,
          unitNo: unitNo.get(id) ?? '—',
          buildingId: s.buildingId,
          months: s.rent.map((m) => m.toFixed(2)),
          chargeMonths: s.charges.map((m) => m.toFixed(2)),
          rent: r.toFixed(2),
          charges: c.toFixed(2),
          retained: s.retained.toFixed(2),
          gross: r.plus(s.retained).toFixed(2),
        };
      })
      .sort((a, b) => a.unitNo.localeCompare(b.unitNo, 'th'));
    const gross = rent.plus(retained);
    const deduction = gross.times(percent).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return {
      year,
      deductionPercent: percent,
      units,
      totals: {
        rent: rent.toFixed(2),
        charges: charges.toFixed(2),
        retained: retained.toFixed(2),
        gross: gross.toFixed(2),
        deduction: deduction.toFixed(2),
        net: gross.minus(deduction).toFixed(2),
      },
    };
  }

  /** The PDF summary of one unit and year (a new numbered document each time it is generated). */
  async generate(
    ctx: TenantContext,
    input: { year: number; unitId: string; language?: ContractLanguage },
  ): Promise<{ document: Document; number: string; summary: IncomeYear }> {
    const unit = this.found(
      await this.db.tenant(ctx, (tx) =>
        tx.unit.findFirst({ where: { id: input.unitId, deletedAt: null }, select: { id: true } }),
      ),
    );
    const summary = await this.year(ctx, input.year, unit.id);
    const language = input.language ?? 'th';
    const en = language === 'en';
    const [tenant, place] = await Promise.all([
      this.db.platform((tx) => tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } })),
      this.db.platform((tx) =>
        tx.unit.findUniqueOrThrow({
          where: { id: unit.id },
          include: { building: { include: { property: true } } },
        }),
      ),
    ]);
    const row = summary.units[0];
    const months = row?.months ?? Array.from({ length: 12 }, () => '0.00');
    const address = addressText(place.building.address) || addressText(place.building.property.address);
    const now = this.clock.now();
    const today = bangkokDate(now);
    return this.db.tenant(
      ctx,
      async (tx) => {
        const number = await this.numbering.next(tx, ctx.tenantId, 'income_summary', now);
        const title = incomeSummaryTitle(language);
        const body = incomeSummaryBody(language, {
          number,
          issuedOn: en ? englishDate(today) : thaiDate(today),
          owner: {
            legalName: tenant.legalName,
            taxId: tenant.taxId,
            address: addressText(tenant.address) || address,
          },
          premises: { unitNo: place.unitNo, propertyName: place.building.property.name, address },
          year: en ? String(input.year) : `พ.ศ. ${input.year + 543}`,
          months: months.map((amount, i) => ({
            label: en ? MONTHS_EN[i]! : MONTHS_TH[i]!,
            amount: formatThb(amount),
          })),
          rent: formatThb(row?.rent ?? '0'),
          charges: formatThb(row?.charges ?? '0'),
          retained: formatThb(row?.retained ?? '0'),
          gross: formatThb(summary.totals.gross),
          grossText: en ? bahtTextEn(summary.totals.gross) : bahtText(summary.totals.gross),
          deductionPercent: summary.deductionPercent,
          deduction: formatThb(summary.totals.deduction),
          net: formatThb(summary.totals.net),
        });
        const html = await this.renderer.brandedDocument(body, title, language);
        const pdf = await this.pdf.render(html, {
          title: `${title} ${number}`,
          footer: `${title} ${number}`,
        });
        const document = await this.documents.storeGenerated(tx, {
          tenantId: ctx.tenantId,
          kind: 'pdf_summary',
          scopeType: 'unit',
          scopeId: unit.id,
          buildingId: place.buildingId,
          title: `${title} ${place.unitNo} ${en ? input.year : input.year + 543} ${number}.pdf`,
          mimeType: 'application/pdf',
          body: pdf,
          sourceRef: `income-summary:${unit.id}:${input.year}`,
        });
        await this.audit.record(tx, {
          action: 'income_summary.generated',
          tenantId: ctx.tenantId,
          buildingId: place.buildingId,
          subjectType: 'core.unit',
          subjectId: unit.id,
          metadata: { year: input.year, number, gross: summary.totals.gross, documentId: document.id },
        });
        return { document, number, summary };
      },
      { timeout: 60_000 },
    );
  }
}

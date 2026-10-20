import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AiUsageService } from '@core/ai-usage/ai-usage.service';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { UtilityTariffsService } from '@core/utility-tariffs/utility-tariffs.service';
import { mapConflicts } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type Building,
  type Prisma,
  type UtilityInvoice,
  type UtilityProvider,
} from '@generated/prisma/client';
import { OCR, type OcrPort, type UtilityInvoiceFields } from '@integrations/ocr/ocr.port';
import { operatedBuilding, visibleBuilding } from '@modules/ops-units/building-access';
import { type CutoffSetting, periodBounds, periodOf } from '@modules/smart-readings/cutoff';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { BILLED_UNITS, type BilledUnitsProvider } from './billed-units.provider';
import { lossNumbers, lossSuspects, type PositionInput, type SuspectRules } from './loss-rules';

const by = () => userIdOf(RequestContext.actor());

export interface UtilityInvoiceInput {
  utility: 'electric' | 'water';
  provider: UtilityProvider;
  utilityAccountId?: string | null;
  periodStart: string;
  periodEnd: string;
  invoiceNo?: string | null;
  units: string;
  amount: string;
  ft?: string | null;
  serviceCharge?: string | null;
  vat?: string | null;
  previousRegister?: string | null;
  currentRegister?: string | null;
  invoiceDocumentId?: string | null;
}

export const LOSS_INCLUDE = {
  suspects: { orderBy: [{ score: 'desc' }, { createdAt: 'asc' }] },
  utilityInvoice: true,
} as const satisfies Prisma.LossReportInclude;
export type LossRow = Prisma.LossReportGetPayload<{ include: typeof LOSS_INCLUDE }>;

const INVOICE_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/**
 * Utility invoices and loss (D-032, B3.4): the owner enters the building's MEA/PEA/MWA/PWA invoice per period (or an
 * OCR prefill / e-bill import of its photo or PDF); the loss report of a building × utility × billing period is
 * invoice units − Σ unit-billed units − Σ common-area units, in THB at the published utility tariff (effective average
 * rate of the invoice units, D-140) or, without one, at the invoice's own average price, with the suspects of
 * `loss-rules.ts`. Billed units come from the `BilledUnitsProvider` — a meter-reading STUB until B4.2.
 */
@Injectable()
export class UtilityLossService extends TenantScopedRepository {
  private readonly logger = new Logger(UtilityLossService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly tariffs: UtilityTariffsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(BILLED_UNITS) private readonly billed: BilledUnitsProvider,
    @Inject(OCR) private readonly ocr: OcrPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly aiUsage: AiUsageService,
  ) {
    super();
  }

  // ------------------------------------------------------------------------------------------- utility invoices

  listInvoices(ctx: TenantContext, buildingId: string, utility?: 'electric' | 'water') {
    return this.db.tenant(ctx, async (tx) => {
      await visibleBuilding(tx, ctx, buildingId);
      return tx.utilityInvoice.findMany({
        where: { buildingId, ...(utility ? { utility } : {}) },
        orderBy: [{ periodEnd: 'desc' }, { utility: 'asc' }],
        take: 120,
      });
    });
  }

  getInvoice(ctx: TenantContext, buildingId: string, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      await visibleBuilding(tx, ctx, buildingId);
      return this.found(await tx.utilityInvoice.findFirst({ where: { id, buildingId } }));
    });
  }

  private async checkInput(tx: Tx, ctx: TenantContext, building: Building, input: UtilityInvoiceInput) {
    if (startOfBangkokDay(input.periodEnd).getTime() < startOfBangkokDay(input.periodStart).getTime())
      throw new DomainException('validation.failed', {
        errors: [{ path: 'periodEnd', code: 'after', message: 'periodEnd must not be before periodStart' }],
      });
    if (input.utilityAccountId) {
      const account = await tx.utilityAccount.findFirst({
        where: { id: input.utilityAccountId, buildingId: building.id },
      });
      if (!account) throw new DomainException('http.not_found');
      if (account.utility !== input.utility || account.provider !== input.provider)
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'utilityAccountId',
              code: 'utility',
              message: 'the account is for another utility or provider',
            },
          ],
        });
    }
    if (input.invoiceDocumentId) {
      const doc = await tx.document.findFirst({
        where: {
          id: input.invoiceDocumentId,
          tenantId: ctx.tenantId,
          deletedAt: null,
          kind: 'utility_invoice',
        },
      });
      if (!doc) throw new DomainException('http.not_found');
    }
  }

  private data(input: UtilityInvoiceInput) {
    const dec = (v: string | null | undefined, places: number) =>
      v === null || v === undefined ? null : new Decimal(v).toFixed(places);
    return {
      utility: input.utility,
      provider: input.provider,
      utilityAccountId: input.utilityAccountId ?? null,
      periodStart: new Date(`${input.periodStart}T00:00:00.000Z`),
      periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
      invoiceNo: input.invoiceNo ?? null,
      units: new Decimal(input.units).toFixed(3),
      amount: new Decimal(input.amount).toFixed(2),
      ft: dec(input.ft, 4),
      serviceCharge: dec(input.serviceCharge, 2),
      vat: dec(input.vat, 2),
      previousRegister: dec(input.previousRegister, 3),
      currentRegister: dec(input.currentRegister, 3),
      invoiceDocumentId: input.invoiceDocumentId ?? null,
    };
  }

  createInvoice(
    ctx: TenantContext,
    buildingId: string,
    input: UtilityInvoiceInput,
    source: 'manual' | 'ocr' | 'ebill_import' = 'manual',
    ocrRaw: Record<string, unknown> | null = null,
  ): Promise<UtilityInvoice> {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const building = await operatedBuilding(tx, ctx, buildingId);
          await this.checkInput(tx, ctx, building, input);
          const invoice = await tx.utilityInvoice.create({
            data: {
              tenantId: building.tenantId,
              buildingId,
              ...this.data(input),
              source,
              ocrRaw: (ocrRaw ?? undefined) as Prisma.InputJsonValue | undefined,
              enteredBy: by(),
              createdBy: by(),
            },
          });
          await this.changed(tx, invoice, 'created');
          return invoice;
        }),
      () => new DomainException('utility_invoice.duplicate'),
    );
  }

  updateInvoice(
    ctx: TenantContext,
    buildingId: string,
    id: string,
    version: number,
    patch: Partial<UtilityInvoiceInput>,
  ) {
    return mapConflicts(
      () =>
        this.db.tenant(ctx, async (tx) => {
          const building = await operatedBuilding(tx, ctx, buildingId);
          const current = this.found(await tx.utilityInvoice.findFirst({ where: { id, buildingId } }));
          if (current.version !== version) throw new DomainException('concurrency.stale');
          const merged: UtilityInvoiceInput = {
            utility: patch.utility ?? current.utility,
            provider: patch.provider ?? current.provider,
            utilityAccountId:
              patch.utilityAccountId !== undefined ? patch.utilityAccountId : current.utilityAccountId,
            periodStart: patch.periodStart ?? current.periodStart.toISOString().slice(0, 10),
            periodEnd: patch.periodEnd ?? current.periodEnd.toISOString().slice(0, 10),
            invoiceNo: patch.invoiceNo !== undefined ? patch.invoiceNo : current.invoiceNo,
            units: patch.units ?? current.units.toString(),
            amount: patch.amount ?? current.amount.toString(),
            ft: patch.ft !== undefined ? patch.ft : (current.ft?.toString() ?? null),
            serviceCharge:
              patch.serviceCharge !== undefined
                ? patch.serviceCharge
                : (current.serviceCharge?.toString() ?? null),
            vat: patch.vat !== undefined ? patch.vat : (current.vat?.toString() ?? null),
            previousRegister:
              patch.previousRegister !== undefined
                ? patch.previousRegister
                : (current.previousRegister?.toString() ?? null),
            currentRegister:
              patch.currentRegister !== undefined
                ? patch.currentRegister
                : (current.currentRegister?.toString() ?? null),
            invoiceDocumentId:
              patch.invoiceDocumentId !== undefined ? patch.invoiceDocumentId : current.invoiceDocumentId,
          };
          await this.checkInput(tx, ctx, building, merged);
          const invoice = await tx.utilityInvoice.update({
            where: { id },
            data: { ...this.data(merged), updatedBy: by(), version: { increment: 1 } },
          });
          await this.changed(tx, invoice, 'updated', current);
          return invoice;
        }),
      () => new DomainException('utility_invoice.duplicate'),
    );
  }

  private async changed(
    tx: Tx,
    invoice: UtilityInvoice,
    change: 'created' | 'updated',
    before?: UtilityInvoice,
  ) {
    await this.audit.record(tx, {
      action: change === 'created' ? 'utility_invoice.created' : 'utility_invoice.updated',
      tenantId: invoice.tenantId,
      buildingId: invoice.buildingId,
      subjectType: 'ops.utility_invoice',
      subjectId: invoice.id,
      ...(before ? { before: { units: before.units.toFixed(3), amount: before.amount.toFixed(2) } } : {}),
      after: { units: invoice.units.toFixed(3), amount: invoice.amount.toFixed(2), source: invoice.source },
    });
    await this.events.record(tx, {
      type: 'utility_invoice.changed',
      aggregateType: 'utility_invoice',
      aggregateId: invoice.id,
      tenantId: invoice.tenantId,
      buildingId: invoice.buildingId,
      payload: {
        utilityInvoiceId: invoice.id,
        buildingId: invoice.buildingId,
        utility: invoice.utility,
        periodEnd: invoice.periodEnd.toISOString().slice(0, 10),
        change,
      },
    });
  }

  /** OCR of an invoice photo / PDF for the entry form (nothing stored). */
  async prefill(ctx: TenantContext, buildingId: string, documentId: string, utility: 'electric' | 'water') {
    await this.db.tenant(ctx, (tx) => visibleBuilding(tx, ctx, buildingId));
    const file = await this.documents.readBytes(ctx, documentId, {
      kinds: ['utility_invoice'],
      mimeTypes: INVOICE_MIME,
      maxBytes: 15_000_000,
    });
    const usage = (model: string, outcome: 'ok' | 'error') =>
      this.aiUsage.record({
        tenantId: ctx.tenantId,
        buildingId,
        feature: 'invoice_ocr',
        provider: this.ocr.mode === 'fake' ? 'fake' : 'ai_gateway',
        model,
        inputUnits: 1,
        unitKind: 'images',
        outcome,
        subjectType: 'core.document',
        subjectId: documentId,
      });
    try {
      const r = await this.ocr.readUtilityInvoice({
        file: file.body,
        mimeType: file.document.mimeType,
        utility,
        tenantId: ctx.tenantId,
      });
      await usage(r.model, 'ok');
      return r;
    } catch (error) {
      this.logger.warn(`utility invoice OCR unavailable: ${(error as Error).message}`);
      await usage('unknown', 'error');
      throw new DomainException('provider.unavailable');
    }
  }

  /** Import of the utility's e-bill (PDF): OCR fields → a `ebill_import` invoice; refused when a field is missing. */
  async importEbill(
    ctx: TenantContext,
    buildingId: string,
    input: {
      documentId: string;
      utility: 'electric' | 'water';
      provider: UtilityProvider;
      utilityAccountId?: string | null;
    },
  ) {
    const read = await this.prefill(ctx, buildingId, input.documentId, input.utility);
    const f: UtilityInvoiceFields = read.fields;
    const missing = (['periodStart', 'periodEnd', 'units', 'amount'] as const).filter((k) => !f[k]);
    if (missing.length)
      throw new DomainException('utility_invoice.unreadable', {
        errors: missing.map((k) => ({
          path: k,
          code: 'unreadable',
          message: `${k} was not found in the e-bill`,
        })),
      });
    return this.createInvoice(
      ctx,
      buildingId,
      {
        utility: input.utility,
        provider: input.provider,
        utilityAccountId: input.utilityAccountId ?? null,
        periodStart: f.periodStart!,
        periodEnd: f.periodEnd!,
        invoiceNo: f.invoiceNo,
        units: f.units!,
        amount: f.amount!,
        ft: f.ft,
        serviceCharge: f.serviceCharge,
        vat: f.vat,
        previousRegister: f.previousRegister,
        currentRegister: f.currentRegister,
        invoiceDocumentId: input.documentId,
      },
      'ebill_import',
      { ...f, confidence: read.confidence, model: read.model },
    );
  }

  // ------------------------------------------------------------------------------------------- loss

  /** The loss report of a building × utility × billing period (`YYYY-MM`), computed when missing. */
  async report(ctx: TenantContext, buildingId: string, utility: 'electric' | 'water', periodKey?: string) {
    const key = periodKey ?? (await this.currentPeriodKey(ctx, buildingId));
    const existing = await this.db.tenant(ctx, async (tx) => {
      const building = await visibleBuilding(tx, ctx, buildingId);
      const { start, end } = await this.bounds(building, key);
      return tx.lossReport.findFirst({
        where: { buildingId, utility, periodStart: dateOf(start), periodEnd: dateOf(end) },
        include: LOSS_INCLUDE,
      });
    });
    const report = existing ?? (await this.compute(ctx, buildingId, utility, key));
    return { report, trend: await this.trend(ctx, buildingId, utility) };
  }

  private async currentPeriodKey(ctx: TenantContext, buildingId: string): Promise<string> {
    const building = await this.db.tenant(ctx, (tx) => visibleBuilding(tx, ctx, buildingId));
    const cutoff = await this.settings.valueAt<CutoffSetting>('billing.cutoff', this.clock.now(), {
      tenantId: building.tenantId,
      propertyId: building.propertyId,
    });
    // the last completed period (the loss needs the utility invoice of a closed period)
    const current = periodOf(cutoff, this.clock.now());
    return periodOf(cutoff, new Date(current.start.getTime() - 1)).key;
  }

  private async bounds(building: Building, key: string) {
    const cutoff = await this.settings.valueAt<CutoffSetting>('billing.cutoff', this.clock.now(), {
      tenantId: building.tenantId,
      propertyId: building.propertyId,
    });
    return periodBounds(cutoff, key);
  }

  private async trend(ctx: TenantContext, buildingId: string, utility: 'electric' | 'water') {
    return this.db.tenant(ctx, async (tx) =>
      (
        await tx.lossReport.findMany({
          where: { buildingId, utility },
          orderBy: { periodEnd: 'desc' },
          take: 12,
          select: { periodStart: true, periodEnd: true, lossUnits: true, lossPct: true, lossThb: true },
        })
      ).reverse(),
    );
  }

  /** Computes (or recomputes) and stores the report; the latest computation replaces the previous one. */
  async compute(
    ctx: TenantContext,
    buildingId: string,
    utility: 'electric' | 'water',
    periodKey: string,
  ): Promise<LossRow> {
    const now = this.clock.now();
    return this.db.tenant(
      ctx,
      async (tx) => {
        const building = await visibleBuilding(tx, ctx, buildingId);
        const { start, end } = await this.bounds(building, periodKey);
        const periodStart = dateOf(start);
        const periodEnd = dateOf(end);
        const invoices = await tx.utilityInvoice.findMany({
          where: { buildingId, utility, periodEnd: { gte: periodStart, lte: periodEnd } },
          orderBy: { periodEnd: 'asc' },
        });
        if (!invoices.length) throw new DomainException('loss.no_invoice', { params: { period: periodKey } });
        const invoiceUnits = invoices.reduce((s, i) => s.plus(i.units.toString()), new Decimal(0));
        const invoiceAmount = invoices.reduce((s, i) => s.plus(i.amount.toString()), new Decimal(0));
        const rules = await this.settings.valueAt<SuspectRules>('loss.suspect_rules', now, {
          tenantId: building.tenantId,
          propertyId: building.propertyId,
        });

        const positions = await this.billed.positions(tx, buildingId, utility, start, end);
        const units = await tx.unit.findMany({
          where: { buildingId, deletedAt: null },
          select: { id: true, unitNo: true },
        });
        const unitNo = new Map(units.map((u) => [u.id, u.unitNo]));
        const occupancies = await tx.occupancy.findMany({
          where: {
            unitId: { in: units.map((u) => u.id) },
            validFrom: { lte: periodEnd },
            OR: [{ validTo: null }, { validTo: { gt: periodStart } }],
          },
          select: { unitId: true },
        });
        const occupied = new Set(occupancies.map((o) => o.unitId));
        const statuses = new Map(
          (await tx.meterStatus.findMany({ where: { buildingId } })).map((s) => [s.assetItemId, s.health]),
        );
        const previous = await tx.lossReport.findMany({
          where: { buildingId, utility, periodEnd: { lt: periodStart } },
          orderBy: { periodEnd: 'desc' },
          take: rules.trailingPeriods,
          select: { inputsSnapshot: true },
        });
        const nightFlow =
          utility === 'water'
            ? await this.nightFlow(tx, buildingId, start, end, rules)
            : new Map<string, number>();

        const inputs: PositionInput[] = positions
          .filter((p) => p.purpose !== 'main')
          .map((p) => {
            const key =
              p.purpose === 'unit' ? `unit:${unitNo.get(p.unitId!) ?? p.unitId}` : `${p.purpose}:${p.code}`;
            const history = previous
              .map((r) =>
                (r.inputsSnapshot as { positions?: { key: string; units: string }[] }).positions?.find(
                  (x) => x.key === key,
                ),
              )
              .filter((x): x is { key: string; units: string } => Boolean(x))
              .map((x) => new Decimal(x.units))
              .reverse();
            return {
              key,
              unitId: p.unitId,
              unitNo: p.unitId ? (unitNo.get(p.unitId) ?? null) : null,
              assetItemIds: p.assetItemIds,
              purpose: p.purpose,
              units: p.meteredUnits ?? p.units,
              billedUnits: p.units,
              occupied: p.purpose === 'unit' ? occupied.has(p.unitId!) : null,
              estimated: p.estimated,
              stale: p.assetItemIds.some((id) => ['stale', 'silent'].includes(statuses.get(id) ?? '')),
              nightFlowNights: Math.max(0, ...p.assetItemIds.map((id) => nightFlow.get(id) ?? 0)),
              history,
            };
          });

        const lastInvoice = invoices[invoices.length - 1]!;
        const tariff = await this.tariffPrice(lastInvoice.provider, lastInvoice.periodEnd, invoiceUnits);
        const price =
          tariff?.price ?? (invoiceUnits.gt(0) ? invoiceAmount.div(invoiceUnits) : new Decimal(0));
        const numbers = lossNumbers(invoiceUnits, inputs, price);
        const suspects = lossSuspects(utility, inputs, rules);
        const snapshot = {
          periodKey,
          start: start.toISOString(),
          end: end.toISOString(),
          invoices: invoices.map((i) => ({
            id: i.id,
            units: i.units.toFixed(3),
            amount: i.amount.toFixed(2),
            provider: i.provider,
          })),
          positions: inputs.map((p) => ({
            key: p.key,
            purpose: p.purpose,
            units: p.units.toFixed(3),
            billedUnits: (p.billedUnits ?? p.units).toFixed(3),
            occupied: p.occupied,
          })),
          price: {
            basis: tariff ? 'utility_tariff' : 'invoice_average',
            perUnit: price.toFixed(4),
            tariffVersionId: tariff?.versionId ?? null,
          },
          billedUnitsSource: this.billed.source,
          rules,
        };
        const data = {
          tenantId: building.tenantId,
          buildingId,
          utility,
          periodStart,
          periodEnd,
          utilityInvoiceId: invoices.length === 1 ? lastInvoice.id : null,
          invoiceUnits: numbers.invoiceUnits.toFixed(3),
          unitBilledUnits: numbers.unitBilledUnits.toFixed(3),
          commonAreaUnits: numbers.commonAreaUnits.toFixed(3),
          lossUnits: numbers.lossUnits.toFixed(3),
          lossPct: numbers.lossPct?.toFixed(4) ?? null,
          lossThb: numbers.lossThb.toFixed(2),
          priceBasis: tariff ? 'utility_tariff' : 'invoice_average',
          utilityTariffVersionId: tariff?.versionId ?? null,
          billedUnitsSource: this.billed.source,
          computedAt: now,
          inputsSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        };
        const existing = await tx.lossReport.findFirst({
          where: { buildingId, utility, periodStart, periodEnd },
        });
        const report = existing
          ? await tx.lossReport.update({ where: { id: existing.id }, data: { ...data, updatedBy: by() } })
          : await tx.lossReport.create({ data: { ...data, createdBy: by() } });
        await tx.lossSuspect.deleteMany({ where: { lossReportId: report.id } });
        if (suspects.length)
          await tx.lossSuspect.createMany({
            data: suspects.map((s) => ({
              tenantId: building.tenantId,
              lossReportId: report.id,
              assetItemId: s.assetItemId,
              unitId: s.unitId,
              kind: s.kind,
              score: s.score.toFixed(2),
              detail: s.detail,
            })),
          });
        await this.audit.record(tx, {
          action: 'loss_report.computed',
          tenantId: building.tenantId,
          buildingId,
          subjectType: 'ops.loss_report',
          subjectId: report.id,
          after: { periodKey, lossUnits: data.lossUnits, lossThb: data.lossThb, suspects: suspects.length },
        });
        await this.events.record(tx, {
          type: 'loss_report.computed',
          aggregateType: 'loss_report',
          aggregateId: report.id,
          tenantId: building.tenantId,
          buildingId,
          payload: {
            lossReportId: report.id,
            utility,
            periodKey,
            lossUnits: data.lossUnits,
            lossPct: data.lossPct,
          },
        });
        return tx.lossReport.findUniqueOrThrow({ where: { id: report.id }, include: LOSS_INCLUDE });
      },
      { timeout: 60_000 },
    );
  }

  /** Published tariff in force on the invoice's last day: the effective average rate of the invoice units (D-140). */
  private async tariffPrice(provider: UtilityProvider, day: Date, units: Decimal) {
    const utility = provider === 'mea' || provider === 'pea' ? 'electric' : 'water';
    try {
      const rows = await this.tariffs.current({ utility, provider, date: day, units: units.toFixed(3) });
      const pick = rows.find((r) => r.tariff.tariffCode.startsWith('1.1')) ?? rows[0];
      if (!pick?.charge?.effectiveAverageRate) return null;
      return { price: new Decimal(pick.charge.effectiveAverageRate), versionId: pick.version.id };
    } catch (error) {
      if (error instanceof DomainException && error.code === 'tariff.not_found') return null;
      throw error;
    }
  }

  /** Nights (Bangkok) per water meter with a 15-minute usage above the threshold inside the night window. */
  private async nightFlow(
    tx: Tx,
    buildingId: string,
    start: Date,
    end: Date,
    rules: SuspectRules,
  ): Promise<Map<string, number>> {
    const rows = await tx.$queryRaw<{ asset_item_id: string; nights: number }[]>`
      SELECT asset_item_id::text, count(DISTINCT date_trunc('day', bucket AT TIME ZONE 'Asia/Bangkok'))::int AS nights
        FROM smart.telemetry_15m
       WHERE building_id = ${buildingId}::uuid AND unit = 'm3' AND bucket >= ${start} AND bucket < ${end}
         AND usage >= ${rules.nightFlowM3Per15m}::numeric
         AND (bucket AT TIME ZONE 'Asia/Bangkok')::time >= ${rules.nightFrom}::time
         AND (bucket AT TIME ZONE 'Asia/Bangkok')::time < ${rules.nightTo}::time
       GROUP BY asset_item_id`;
    return new Map(rows.map((r) => [r.asset_item_id, r.nights]));
  }

  /** Dashboard widget (B6 reads it): the latest report per building and utility of my tenant. */
  summary(ctx: TenantContext) {
    return this.db.tenant(ctx, async (tx) => {
      const scope = this.buildingScope(ctx);
      const rows = await tx.lossReport.findMany({
        where: { tenantId: ctx.tenantId, ...(scope ? { buildingId: scope } : {}) },
        orderBy: { periodEnd: 'desc' },
        include: { building: { select: { id: true, name: true } }, _count: { select: { suspects: true } } },
        take: 200,
      });
      const latest = new Map<string, (typeof rows)[number]>();
      for (const r of rows)
        if (!latest.has(`${r.buildingId}|${r.utility}`)) latest.set(`${r.buildingId}|${r.utility}`, r);
      return [...latest.values()];
    });
  }

  /** Subscriber: a changed utility invoice recomputes the reports of the period it closes in (if one exists). */
  /**
   * Review #11 (D-225): the safety net of the after-commit recompute — a stored report older than a utility invoice of
   * its building, utility and period (both `updated_at`, database time) is computed again. Hourly maintenance job.
   */
  async recomputeStale(): Promise<number> {
    const stale = await this.db.platform(
      (tx) =>
        tx.$queryRaw<
          { tenant_id: string; building_id: string; utility: 'electric' | 'water'; key: string | null }[]
        >`
        SELECT DISTINCT r.tenant_id::text, r.building_id::text, r.utility::text AS utility,
               r.inputs_snapshot->>'periodKey' AS key
          FROM ops.loss_report r
          JOIN ops.utility_invoice i ON i.building_id = r.building_id AND i.utility = r.utility
                                    AND i.period_end BETWEEN r.period_start AND r.period_end
         WHERE i.updated_at > r.updated_at
         LIMIT 200`,
    );
    let done = 0;
    for (const r of stale) {
      if (!r.key) continue;
      await this.compute(systemTenantContext(r.tenant_id), r.building_id, r.utility, r.key).then(
        () => (done += 1),
        (error: unknown) =>
          this.logger.warn(`stale loss report ${r.building_id}: ${(error as Error).message}`),
      );
    }
    return done;
  }

  async recomputeFor(invoiceId: string): Promise<void> {
    const reports = await this.db.platform(async (tx) => {
      const invoice = await tx.utilityInvoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) return [];
      return tx.lossReport.findMany({
        where: {
          buildingId: invoice.buildingId,
          utility: invoice.utility,
          periodStart: { lte: invoice.periodEnd },
          periodEnd: { gte: invoice.periodEnd },
        },
      });
    });
    for (const r of reports) {
      const key = (r.inputsSnapshot as { periodKey?: string }).periodKey;
      if (key)
        await this.compute(systemTenantContext(r.tenantId), r.buildingId, r.utility, key).catch(
          (error: unknown) => this.logger.warn(`loss recompute ${r.id} failed: ${(error as Error).message}`),
        );
    }
  }
}

/** The Bangkok calendar date of an instant as a `date` column value (UTC midnight). */
function dateOf(instant: Date): Date {
  return new Date(`${bangkokDate(instant)}T00:00:00.000Z`);
}

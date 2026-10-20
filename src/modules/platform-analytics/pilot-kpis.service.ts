import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type Prisma } from '@generated/prisma/client';
import { DEFAULT_KPI_TARGETS, type PilotBaseline } from '@modules/platform-subscriptions/pilots.service';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { AnalyticsService } from './analytics.service';

/** Windows the KPI endpoint accepts (`?window=`). */
export const KPI_WINDOWS = { '30d': 30, '90d': 90 } as const;
export type KpiWindow = keyof typeof KPI_WINDOWS;

export interface KpiValues {
  /** Average hours from the billing cut-off to the issue of the cycle (D-011, D-031). */
  timeToBillHours: string | null;
  /** Voided invoices + credit notes ÷ invoices issued, % (bill errors). */
  invoiceCorrectionRatePct: string | null;
  /** Invoices due in the window paid by their due date, %. */
  onTimePaymentPct: string | null;
  /** Payments confirmed without a person (bank callback, settlement file, verified slip) ÷ payments, % (D-042, D-043). */
  autoReconciledPct: string | null;
  /** A utility loss report was computed in the window (D-032), with the latest loss %. */
  lossIdentified: boolean;
  latestLossPct: string | null;
  /** Hours with telemetry ÷ hours a meter was bound to a gateway, % (D-034). */
  meterUptimePct: string | null;
  /** Resident satisfaction 1–5: repair ratings (B5.1) and the LIFF survey (B6.3); null without any. */
  csat: string | null;
}

export interface Phase1Acceptance {
  /** The first issued cycle went out within 1 hour of its cut-off (blueprint Phase 1 acceptance). */
  firstFullCycleWithin1h: boolean | null;
  /** Payments by Thai QR ÷ payments, % (target ≥ 60 %). */
  paidByQrPct: string | null;
  /** Requests reported by residents through the LINE app ÷ requests reported by people, %. */
  serviceRequestsViaLinePct: string | null;
  /** Buildings whose issued invoices carried IoT meter lines in the window (target ≥ 1). */
  buildingsBillingAutomatically: number;
}

export interface KpiResult {
  kpi: string;
  baseline: string | boolean | null;
  current: string | boolean | null;
  target: string | boolean;
  met: boolean | null;
}

const pct = (n: number, d: number) =>
  d === 0 ? null : new Decimal(n).times(100).div(d).toDecimalPlaces(2).toFixed(2);

/**
 * Pilot KPIs (D-083, B6.3 endpoint in R1): the seven KPIs of the 90-day review computed from the tenant's own data in
 * the window (`30d` / `90d` ending today, Asia/Bangkok), compared with the baseline captured in the pilot agreement
 * and its targets, plus the Phase 1 acceptance metrics of the blueprint. Each computation is stored once per day in
 * `platform.kpi_snapshot` (re-computed on the same day replaces it). Since B6.3 the values come from the analytics
 * rollups (D-217); a KPI without data is null rather than invented.
 */
@Injectable()
export class PilotKpisService {
  constructor(
    private readonly db: TenantTx,
    private readonly analytics: AnalyticsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async compute(tenantId: string, window: KpiWindow = '90d', options: { requirePilot?: boolean } = {}) {
    const days = KPI_WINDOWS[window];
    if (!days)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'window', code: 'isIn', message: '30d or 90d' }],
      });
    const now = this.clock.now();
    const from = new Date(now.getTime() - days * 86_400_000);
    return this.db.platform(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
      if (!tenant) throw new DomainException('http.not_found');
      const pilot = await tx.pilotAgreement.findUnique({ where: { tenantId } });
      // the owner's own view (`/v1/owner/pilot-kpis`) exists only for a pilot (web F2, D-214)
      if (!pilot && options.requirePilot) throw new DomainException('http.not_found');
      const current = await this.values(tx, tenantId, from, now);
      const acceptance = await this.acceptance(tx, tenantId, from, now);
      const baseline = (pilot?.baseline ?? {}) as PilotBaseline;
      const targets = {
        ...DEFAULT_KPI_TARGETS,
        ...((pilot?.kpiTargets ?? {}) as Record<string, unknown>),
      } as typeof DEFAULT_KPI_TARGETS;
      const kpis = this.compare(baseline, current, targets);
      const asOf = bangkokDate(now);
      const snapshot = await tx.kpiSnapshot.upsert({
        where: { tenantId_window_asOf: { tenantId, window, asOf: new Date(`${asOf}T00:00:00Z`) } },
        create: {
          tenantId,
          window,
          asOf: new Date(`${asOf}T00:00:00Z`),
          baseline: baseline as Prisma.InputJsonValue,
          current: { ...current, acceptance } as unknown as Prisma.InputJsonValue,
          computedAt: now,
        },
        update: {
          baseline: baseline as Prisma.InputJsonValue,
          current: { ...current, acceptance } as unknown as Prisma.InputJsonValue,
          computedAt: now,
        },
      });
      return {
        tenantId,
        window,
        from,
        to: now,
        asOf,
        pilot: pilot
          ? {
              signedAt: pilot.signedAt,
              kpiReviewAt: pilot.kpiReviewAt,
              discountPct: pilot.discountPct.toString(),
            }
          : null,
        kpis,
        current,
        acceptance,
        snapshotId: snapshot.id,
      };
    });
  }

  private compare(b: PilotBaseline, c: KpiValues, t: typeof DEFAULT_KPI_TARGETS): KpiResult[] {
    const dec = (v: string | null | undefined) => (v === null || v === undefined ? null : new Decimal(v));
    const tb = dec(b.timeToBillHours);
    const tc = dec(c.timeToBillHours);
    const onB = dec(b.onTimePaymentPct);
    const onC = dec(c.onTimePaymentPct);
    return [
      {
        kpi: 'time_to_bill',
        baseline: b.timeToBillHours ?? null,
        current: c.timeToBillHours,
        target: `-${t.timeToBillReductionPct}%`,
        met: tb && tc && tb.gt(0) ? tb.minus(tc).div(tb).times(100).gte(t.timeToBillReductionPct) : null,
      },
      {
        kpi: 'invoice_correction_rate',
        baseline: b.invoiceCorrectionRatePct ?? null,
        current: c.invoiceCorrectionRatePct,
        target: `<${t.invoiceCorrectionRatePctMax}%`,
        met:
          c.invoiceCorrectionRatePct === null
            ? null
            : new Decimal(c.invoiceCorrectionRatePct).lt(t.invoiceCorrectionRatePctMax),
      },
      {
        kpi: 'on_time_payment',
        baseline: b.onTimePaymentPct ?? null,
        current: c.onTimePaymentPct,
        target: `+${t.onTimePaymentGainPts}pts`,
        met: onB && onC ? onC.minus(onB).gte(t.onTimePaymentGainPts) : null,
      },
      {
        kpi: 'auto_reconciled',
        baseline: b.autoReconciledPct ?? null,
        current: c.autoReconciledPct,
        target: `>=${t.autoReconciledPctMin}%`,
        met:
          c.autoReconciledPct === null ? null : new Decimal(c.autoReconciledPct).gte(t.autoReconciledPctMin),
      },
      {
        kpi: 'loss_identified',
        baseline: b.lossPct ?? null,
        current: c.lossIdentified,
        target: true,
        met: c.lossIdentified,
      },
      {
        kpi: 'meter_uptime',
        baseline: b.meterUptimePct ?? null,
        current: c.meterUptimePct,
        target: `>=${t.meterUptimePctMin}%`,
        met: c.meterUptimePct === null ? null : new Decimal(c.meterUptimePct).gte(t.meterUptimePctMin),
      },
      {
        kpi: 'csat',
        baseline: b.csat ?? null,
        current: c.csat,
        target: `>=${t.csatMin}`,
        met: c.csat === null ? null : new Decimal(c.csat).gte(t.csatMin),
      },
    ];
  }

  /**
   * The seven KPIs over [from, to) from the analytics rollups (B6.3, D-217): the tenant's facts and rollups of the
   * window are refreshed first (idempotent), then read from the day buckets — time to bill = average cut-off → issue,
   * correction rate = corrections ÷ invoices issued, on-time = invoices due paid by their due date, auto-reconciled,
   * loss identified (+ the latest loss %), meter uptime = average building-day uptime, CSAT = average rating.
   */
  async values(tx: Tx, tenantId: string, from: Date, to: Date): Promise<KpiValues> {
    await this.analytics.refresh(tx, tenantId, from, to);
    const t = await this.analytics.totals(tx, tenantId, from, to);
    const avg = (fact: string, scale = 1, divisor = 1) => {
      const x = t.get(fact);
      return x && x.count > 0
        ? x.value.times(scale).div(x.count).div(divisor).toDecimalPlaces(2).toFixed(2)
        : null;
    };
    const issued = t.get('invoice.issued')?.count ?? 0;
    const corrected = t.get('invoice.corrected')?.count ?? 0;
    const loss = t.get('loss.pct');
    return {
      timeToBillHours: avg('cycle.time_to_issue_s', 1, 3600),
      invoiceCorrectionRatePct: pct(corrected, issued),
      onTimePaymentPct: avg('payment.on_time', 100),
      autoReconciledPct: avg('payment.auto_reconciled', 100),
      lossIdentified: Boolean(loss && loss.count > 0),
      latestLossPct: await this.analytics.latest(tx, tenantId, 'loss.pct', from, to),
      meterUptimePct: avg('meter.uptime_pct'),
      csat: avg('csat.rating'),
    };
  }

  private async acceptance(tx: Tx, tenantId: string, from: Date, to: Date): Promise<Phase1Acceptance> {
    const first = await tx.billingCycle.findFirst({
      where: { tenantId, issuedAt: { not: null } },
      orderBy: { issuedAt: 'asc' },
    });
    const t = await this.analytics.totals(tx, tenantId, from, to);
    const share = (fact: string) => {
      const x = t.get(fact);
      return x && x.count > 0 ? x.value.times(100).div(x.count).toDecimalPlaces(2).toFixed(2) : null;
    };
    const auto = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT i.building_id)::int AS n FROM ops.invoice i JOIN ops.invoice_line l ON l.invoice_id = i.id
       WHERE i.tenant_id = ${tenantId}::uuid AND i.issued_at >= ${from} AND i.issued_at < ${to} AND l.reading_source = 'iot'`;
    return {
      firstFullCycleWithin1h: first?.issuedAt
        ? first.issuedAt.getTime() - first.cutOffAt.getTime() <= 3_600_000
        : null,
      paidByQrPct: share('payment.by_qr'),
      serviceRequestsViaLinePct: share('service_request.via_line'),
      buildingsBillingAutomatically: auto[0]?.n ?? 0,
    };
  }
}

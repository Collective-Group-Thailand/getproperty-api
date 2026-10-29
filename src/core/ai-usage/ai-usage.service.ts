import { addCalendarDays, startOfBangkokDay } from '@common/time/bangkok';
import { TenantTx } from '@database/tenant-tx';
import { type AiFeature, type AiUnitKind } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { CLOCK, type Clock } from '../clock/clock';
import { SettingsService } from '../settings/settings.service';

/** `ai.unit_costs` (D-161, ⚖ O-009): THB per unit of each AI feature, to track the cost per tenant. */
export type AiUnitCosts = Partial<Record<AiFeature, { unitKind: AiUnitKind; costPerUnitThb: string }>>;

export interface AiUsageInput {
  tenantId: string;
  buildingId?: string | null;
  feature: AiFeature;
  provider: string;
  model: string;
  promptVersion?: string | null;
  inputUnits: number;
  outputUnits?: number;
  unitKind: AiUnitKind;
  requestRef?: string | null;
  outcome?: 'ok' | 'error';
  subjectType?: string | null;
  subjectId?: string | null;
  /** The reservation of this call (`reserve`), removed in the same transaction as the record. */
  reservationId?: string | null;
}

/** How long a reservation counts when its call never gets recorded (a crashed process). */
const RESERVATION_TTL_MS = 5 * 60_000;

export interface AiUsageMonth {
  month: string;
  feature: AiFeature;
  calls: number;
  units: number;
  costThb: string;
}

/**
 * AI usage cost per tenant (D-161, B6.4): every AI adapter call writes one `platform.ai_usage_record` — the meter
 * photo OCR of B3.3 and the utility-invoice OCR of B3.4 are the first consumers — in its own transaction (the call
 * happened even when the business transaction rolls back). Cost = units × `ai.unit_costs` (0 until the provider
 * prices are entered, O-009). Monthly totals feed the plan's OCR allowance on the platform invoice
 * (500 photos included, THB 0.50 per extra — plan-version data, Proposed). A metering failure never fails the call.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(input: AiUsageInput): Promise<void> {
    try {
      const now = this.clock.now();
      const costs = await this.settings.valueAt<AiUnitCosts>('ai.unit_costs', now);
      const unitCost = costs[input.feature]?.costPerUnitThb ?? '0';
      await this.db.platform(async (tx) => {
        if (input.reservationId)
          await tx.aiUsageReservation.deleteMany({ where: { id: input.reservationId } });
        await tx.aiUsageRecord.create({
          data: {
            tenantId: input.tenantId,
            buildingId: input.buildingId ?? null,
            feature: input.feature,
            provider: input.provider,
            model: input.model,
            promptVersion: input.promptVersion ?? null,
            inputUnits: input.inputUnits,
            outputUnits: input.outputUnits ?? 0,
            unitKind: input.unitKind,
            costThb: new Decimal(unitCost).times(input.inputUnits).toDecimalPlaces(4).toFixed(4),
            requestRef: input.requestRef ?? null,
            outcome: input.outcome ?? 'ok',
            subjectType: input.subjectType ?? null,
            subjectId: input.subjectId ?? null,
            occurredAt: now,
          },
        });
      });
    } catch (error) {
      this.logger.error(`AI usage not recorded for ${input.feature}: ${(error as Error).message}`);
    }
  }

  /**
   * Takes one place in a monthly limit before an AI call (G review #6, D-301 (6), O-009): under a lock per tenant and
   * feature, the month's `ok` records plus the live reservations must stay below `limit`. Returns the reservation id
   * (hand it to `record`, or `release` it), or null when the limit is reached. Concurrent calls therefore never
   * exceed the limit; a reservation whose call is never recorded stops counting after a few minutes.
   */
  async reserve(input: {
    tenantId: string;
    feature: AiFeature;
    limit: number;
    since: Date;
    requestRef?: string | null;
  }): Promise<string | null> {
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-quota:${input.tenantId}:${input.feature}`}))`;
      const used = await tx.aiUsageRecord.count({
        where: {
          tenantId: input.tenantId,
          feature: input.feature,
          outcome: 'ok',
          occurredAt: { gte: input.since },
        },
      });
      const reserved = await tx.aiUsageReservation.count({
        where: { tenantId: input.tenantId, feature: input.feature, expiresAt: { gt: now } },
      });
      if (used + reserved >= input.limit) return null;
      const row = await tx.aiUsageReservation.create({
        data: {
          tenantId: input.tenantId,
          feature: input.feature,
          requestRef: input.requestRef ?? null,
          reservedAt: now,
          expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
        },
        select: { id: true },
      });
      return row.id;
    });
  }

  /** Gives a reservation back without a record (the call was not made). */
  async release(reservationId: string): Promise<void> {
    await this.db
      .platform((tx) => tx.aiUsageReservation.deleteMany({ where: { id: reservationId } }))
      .catch((error: Error) => this.logger.error(`AI reservation not released: ${error.message}`));
  }

  /** Monthly totals per feature of a tenant (Bangkok months), newest first. */
  async monthly(tenantId: string, months = 6): Promise<AiUsageMonth[]> {
    const now = this.clock.now();
    const thisMonth = `${new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 8)}01`;
    let start = thisMonth;
    for (let i = 1; i < months; i += 1) start = `${addCalendarDays(start, -1).slice(0, 8)}01`;
    const rows = await this.db.platform(
      (tx) =>
        tx.$queryRaw<{ month: string; feature: AiFeature; calls: number; units: number; cost: string }[]>`
        SELECT to_char(date_trunc('month', occurred_at AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD') AS month, feature,
               count(*)::int AS calls, coalesce(sum(input_units), 0)::int AS units, coalesce(sum(cost_thb), 0)::numeric(14,2)::text AS cost
          FROM platform.ai_usage_record
         WHERE tenant_id = ${tenantId}::uuid AND occurred_at >= ${startOfBangkokDay(start)}
         GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
    );
    return rows.map((r) => ({
      month: r.month,
      feature: r.feature,
      calls: r.calls,
      units: r.units,
      costThb: r.cost,
    }));
  }
}

import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { MoneyDecimal } from '@common/money/money';
import { bangkokDate } from '@common/time/bangkok';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type MessagingRate } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';

/** Shares of the allowance at which the owner is told once a month (D-254: 80 % and 100 %). */
const THRESHOLDS = [
  { pct: 80, kind: 'allowance_80' as const },
  { pct: 100, kind: 'allowance_100' as const },
];

export interface UsageSummary {
  month: string;
  shared: {
    counted: number;
    allowance: number | null;
    left: number | null;
    usedPercent: number | null;
    chargeable: number;
    pricePerMessage: string | null;
    vatPercent: string | null;
    estimatedCharge: string | null;
    estimatedVat: string | null;
  };
  own: { counted: number; replies: number };
  quotaFallbacks: number;
}

export interface RateInput {
  effectiveFrom: string;
  freePerTenant: number;
  freePerUnit: number;
  pricePerMessage: string;
  vatPercent: string;
  notes: string | null;
}

/** `YYYY-MM-01` of the Bangkok month an instant falls in. */
export function bangkokMonth(at: Date): string {
  return `${bangkokDate(at).slice(0, 7)}-01`;
}

const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);

/**
 * Message metering and the shared OA's charge (B7.7 part 2, D-254). Every LINE message sent for a tenant's residents
 * is a `platform.message_usage` row: through the shared getproperty OA (counted against the free messages of the
 * published `platform.messaging_rate`, beyond them priced per message + VAT) or through the operator's own OA (LINE
 * bills the operator; shown, never charged). Replies are never counted (LINE does not count them). The owner is told
 * once a month at 80 % and 100 % of the free messages, and when LINE refused a message for quota and it went by SMS.
 */
@Injectable()
export class MessagingUsageService {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The published rate in force on a day, or null (messaging not charged). */
  rateAt(tx: Tx, day: string): Promise<MessagingRate | null> {
    return tx.messagingRate.findFirst({
      where: { state: 'published', effectiveFrom: { lte: dateOf(day) } },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  /** Free messages of a tenant for a month under a rate: per tenant + per active unit. */
  async allowance(tx: Tx, tenantId: string, rate: MessagingRate | null): Promise<number | null> {
    if (!rate) return null;
    if (!rate.freePerUnit) return rate.freePerTenant;
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM core.unit
       WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND status <> 'inactive'`;
    return rate.freePerTenant + rate.freePerUnit * (rows[0]?.n ?? 0);
  }

  private async sharedCounted(tx: Tx, tenantId: string, month: string): Promise<number> {
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT coalesce(sum(counted), 0)::int AS n FROM platform.message_usage
       WHERE tenant_id = ${tenantId}::uuid AND month = ${month}::date AND oa = 'shared'`;
    return rows[0]?.n ?? 0;
  }

  /**
   * One message sent (inside the delivery transaction, as gp_platform): kept once per notification; a counted message
   * of the shared OA may cross the 80 % / 100 % notices of the month.
   */
  async record(
    tx: Tx,
    input: {
      tenantId: string;
      buildingId: string | null;
      channelId: string | null;
      notificationId: string | null;
      kind: 'push' | 'reply';
    },
  ): Promise<void> {
    const now = this.clock.now();
    const month = bangkokMonth(now);
    const counted = input.kind === 'push' ? 1 : 0;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO platform.message_usage (tenant_id, building_id, channel_id, notification_id, oa, kind, counted, month, occurred_at)
      VALUES (${input.tenantId}::uuid, ${input.buildingId}::uuid, ${input.channelId}::uuid, ${input.notificationId}::uuid,
              ${input.channelId ? 'own' : 'shared'}::platform.messaging_oa, ${input.kind}::platform.message_kind,
              ${counted}, ${month}::date, ${now.toISOString()}::timestamptz)
      ON CONFLICT (notification_id) DO NOTHING
      RETURNING id`;
    if (!rows.length || input.channelId || !counted) return;
    await this.thresholds(tx, input.tenantId, month, now);
  }

  private async thresholds(tx: Tx, tenantId: string, month: string, now: Date): Promise<void> {
    const allowance = await this.allowance(tx, tenantId, await this.rateAt(tx, bangkokDate(now)));
    if (allowance === null || allowance <= 0) return;
    const counted = await this.sharedCounted(tx, tenantId, month);
    let top: (typeof THRESHOLDS)[number] | null = null;
    for (const threshold of THRESHOLDS) {
      if (counted * 100 < allowance * threshold.pct) continue;
      const created = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO platform.messaging_notice (tenant_id, month, kind, counted, allowance, sent_at)
        VALUES (${tenantId}::uuid, ${month}::date, ${threshold.kind}::platform.messaging_notice_kind, ${counted},
                ${allowance}, ${now.toISOString()}::timestamptz)
        ON CONFLICT (tenant_id, month, kind) DO NOTHING RETURNING id`;
      if (created.length) top = threshold;
    }
    // 80 % and 100 % crossed by the same message → the 100 % message only
    if (top)
      await this.events.record(tx, {
        type: 'messaging.allowance_threshold',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        tenantId,
        payload: { thresholdPct: top.pct, counted, allowance, month: month.slice(0, 7) },
      });
  }

  /**
   * LINE refused a message for quota (D-254): it went by SMS (or could not), and the owner is told once a month.
   */
  async quotaRefused(
    tx: Tx,
    input: { tenantId: string; channelId: string | null; fallback: 'sms' | 'email' | 'none' },
  ): Promise<void> {
    const now = this.clock.now();
    const month = bangkokMonth(now);
    const counted = await this.sharedCounted(tx, input.tenantId, month);
    const created = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO platform.messaging_notice (tenant_id, month, kind, counted, allowance, sent_at)
      VALUES (${input.tenantId}::uuid, ${month}::date, 'quota'::platform.messaging_notice_kind, ${counted}, NULL,
              ${now.toISOString()}::timestamptz)
      ON CONFLICT (tenant_id, month, kind) DO NOTHING RETURNING id`;
    if (!created.length) return;
    await this.events.record(tx, {
      type: 'messaging.quota_fallback',
      aggregateType: 'tenant',
      aggregateId: input.tenantId,
      tenantId: input.tenantId,
      payload: {
        oa: input.channelId ? 'own' : 'shared',
        channelId: input.channelId,
        fallback: input.fallback,
        month: month.slice(0, 7),
      },
    });
  }

  /** `GET /v1/owner/messaging/usage`: a month's messages, the free messages left and the estimated charge. */
  async summary(ctx: TenantContext, monthParam?: string): Promise<UsageSummary> {
    const now = this.clock.now();
    const month = monthParam ? `${monthParam}-01` : bangkokMonth(now);
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)) throw new DomainException('validation.failed');
    return this.db.tenant(ctx, async (tx) => {
      const rows = await tx.$queryRaw<{ oa: string; kind: string; n: number; messages: number }[]>`
        SELECT oa::text, kind::text, coalesce(sum(counted), 0)::int AS n, count(*)::int AS messages
          FROM platform.message_usage WHERE tenant_id = ${ctx.tenantId}::uuid AND month = ${month}::date
         GROUP BY oa, kind`;
      const counted = rows.filter((r) => r.oa === 'shared').reduce((sum, r) => sum + r.n, 0);
      const ownCounted = rows.filter((r) => r.oa === 'own').reduce((sum, r) => sum + r.n, 0);
      const ownReplies = rows
        .filter((r) => r.oa === 'own' && r.kind === 'reply')
        .reduce((s, r) => s + r.messages, 0);
      // The rate of the month: in force on its last day (or today for the current month).
      const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
      const day = month === bangkokMonth(now) ? bangkokDate(now) : end.toISOString().slice(0, 10);
      const rate = await this.rateAt(tx, day);
      const allowance = await this.allowance(tx, ctx.tenantId, rate);
      const chargeable = allowance === null ? 0 : Math.max(0, counted - allowance);
      const charge = rate ? new MoneyDecimal(rate.pricePerMessage.toString()).times(chargeable) : null;
      const vat = rate && charge ? charge.times(rate.vatPercent.toString()).div(100) : null;
      const fallbacks = await tx.notification.count({
        where: {
          tenantId: ctx.tenantId,
          channel: 'line',
          failedReason: { startsWith: 'line_quota' },
          createdAt: { gte: dateOf(month), lt: new Date(end.getTime() + 86_400_000) },
        },
      });
      return {
        month: month.slice(0, 7),
        shared: {
          counted,
          allowance,
          left: allowance === null ? null : Math.max(0, allowance - counted),
          usedPercent: allowance ? Math.floor((counted * 100) / allowance) : null,
          chargeable,
          pricePerMessage: rate ? rate.pricePerMessage.toFixed(4) : null,
          vatPercent: rate ? rate.vatPercent.toFixed(2) : null,
          estimatedCharge: charge ? charge.toDecimalPlaces(2).toFixed(2) : null,
          estimatedVat: vat ? vat.toDecimalPlaces(2).toFixed(2) : null,
        },
        own: { counted: ownCounted, replies: ownReplies },
        quotaFallbacks: fallbacks,
      };
    });
  }

  // ---------------------------------------------------------------------------------------- rates (platform)

  /** The published rate in force today and the next published one (public pricing). */
  pricing(): Promise<{ current: MessagingRate | null; next: MessagingRate | null }> {
    const today = bangkokDate(this.clock.now());
    return this.db.platform(async (tx) => ({
      current: await this.rateAt(tx, today),
      next: await tx.messagingRate.findFirst({
        where: { state: 'published', effectiveFrom: { gt: dateOf(today) } },
        orderBy: { effectiveFrom: 'asc' },
      }),
    }));
  }

  listRates(): Promise<MessagingRate[]> {
    return this.db.platform((tx) =>
      tx.messagingRate.findMany({ orderBy: [{ effectiveFrom: 'desc' }, { enteredAt: 'desc' }] }),
    );
  }

  /** The maker: a new version in state `entered`, effective from today or later. */
  async enterRate(userId: string, input: RateInput): Promise<MessagingRate> {
    if (input.effectiveFrom < bangkokDate(this.clock.now()))
      throw new DomainException('messaging_rate.in_the_past');
    return this.db.platform(async (tx) => {
      const rate = await tx.messagingRate.create({
        data: {
          effectiveFrom: dateOf(input.effectiveFrom),
          freePerTenant: input.freePerTenant,
          freePerUnit: input.freePerUnit,
          pricePerMessage: input.pricePerMessage,
          vatPercent: input.vatPercent,
          notes: input.notes,
          enteredBy: userId,
          enteredAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        action: 'messaging.rate_entered',
        tenantId: null,
        subjectType: 'platform.messaging_rate',
        subjectId: rate.id,
        after: { ...input },
      });
      return rate;
    });
  }

  /** The checker (another platform user): publishes; a published version of the same day is withdrawn. */
  async publishRate(userId: string, id: string): Promise<MessagingRate> {
    return this.db.platform(async (tx) => {
      const rate = await tx.messagingRate.findUnique({ where: { id } });
      if (!rate) throw new DomainException('http.not_found');
      if (rate.state !== 'entered') throw new DomainException('messaging_rate.invalid_state');
      if (rate.enteredBy === userId) throw new DomainException('messaging_rate.same_checker');
      if (rate.effectiveFrom.toISOString().slice(0, 10) < bangkokDate(this.clock.now()))
        throw new DomainException('messaging_rate.in_the_past');
      const now = this.clock.now();
      await tx.messagingRate.updateMany({
        where: { state: 'published', effectiveFrom: rate.effectiveFrom },
        data: { state: 'withdrawn', withdrawnAt: now },
      });
      const published = await tx.messagingRate.update({
        where: { id },
        data: { state: 'published', publishedBy: userId, publishedAt: now },
      });
      await this.audit.record(tx, {
        action: 'messaging.rate_published',
        tenantId: null,
        subjectType: 'platform.messaging_rate',
        subjectId: id,
        after: { effectiveFrom: bangkokDate(rate.effectiveFrom) },
      });
      return published;
    });
  }
}

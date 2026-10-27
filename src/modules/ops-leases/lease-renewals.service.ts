import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { operators, registerNotifiable } from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type LeaseRenewalOffer,
  Prisma,
  type RenewalOfferState,
  type RenewalRentSource,
} from '@generated/prisma/client';
import { districtKey } from '@modules/platform-analytics/benchmark-rules';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type ContractLanguage } from './contract-renderer';
import { LeaseNoticesService } from './lease-notices.service';
import { LeasesService } from './leases.service';
import { ResidentLeasesService } from './resident-leases.service';

export interface RentSuggestion {
  source: RenewalRentSource;
  rent: string;
  basis: string;
}

export interface RenewalSuggestion {
  currentRent: string;
  suggested: RentSuggestion;
  candidates: RentSuggestion[];
}

export type OfferRow = LeaseRenewalOffer;

const by = () => userIdOf(RequestContext.actor());
const day = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const txt = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/**
 * Renewal offers (G3, D-294) on top of the B7.5 `renewal_offer` letter and the `renew` action: the owner offers rent
 * and term with a suggestion (k ≥ 5 benchmark when the tenant shares anonymised analytics, else the comparables of
 * the unit's listing, else the current rent); the resident accepts in LIFF (a renewal draft is created and sent for
 * signature; the old lease closes at its end once the renewal is active) or declines (a lessee notice to the end date
 * when ≥ 30 days remain → move-out, D-219). Hourly job `lease-renewals`: offers past `respond_by` expire and owners
 * are reminded at `lease.renewal.remind_days` before a lease ends.
 */
@Injectable()
export class LeaseRenewalsService extends TenantScopedRepository implements OnModuleInit {
  private readonly logger = new Logger(LeaseRenewalsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly leases: LeasesService,
    private readonly notices: LeaseNoticesService,
    private readonly residents: ResidentLeasesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    const toOwner = async (tx: Tx, e: { tenantId: string | null; payload: Record<string, unknown> }) => {
      if (!e.tenantId) return null;
      const unit =
        typeof e.payload.unitId === 'string'
          ? await tx.unit.findUnique({ where: { id: e.payload.unitId }, select: { unitNo: true } })
          : null;
      const recipients = await operators(tx, e.tenantId, ['owner', 'manager'], 'owner');
      if (!recipients.length) return null;
      return {
        recipients,
        data: {
          unit: { unitNo: unit?.unitNo ?? '' },
          lease: { endDate: txt(e.payload.endDate), daysLeft: txt(e.payload.daysLeft) },
          offer: { rent: txt(e.payload.offeredRent) },
          link: `${this.config.get('PUBLIC_WEB_APP_URL')}/leases/${String(e.payload.leaseId)}`,
        },
      };
    };
    registerNotifiable('lease.renewal_due', toOwner);
    registerNotifiable('lease.renewal_accepted', toOwner);
    registerNotifiable('lease.renewal_declined', toOwner);
  }

  today(): string {
    return bangkokDate(this.clock.now());
  }

  // ------------------------------------------------------------------------------------------- suggestion

  private async optedIn(tx: Tx, tenantId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM core.membership m
        JOIN platform.v_consent_state c ON c.subject_type = 'user' AND c.subject_id = m.user_id
       WHERE m.tenant_id = ${tenantId}::uuid AND m.role = 'owner' AND m.status = 'active' AND m.deleted_at IS NULL
         AND c.purpose_key = 'analytics.anonymised' AND c.granted`;
    return (rows[0]?.n ?? 0) > 0;
  }

  /**
   * Rent suggestions for a renewal (D-294): the k ≥ 5 `rent_per_m2` median of the building's district × unit area
   * (only for a tenant that shares anonymised analytics — give to get, D-217), the median of the comparables of the
   * unit's latest listing (D-269, at least `listing.comparables.min`), and the current rent; the first available wins.
   */
  async suggestion(ctx: TenantContext, leaseId: string): Promise<RenewalSuggestion> {
    const lease = await this.leases.get(ctx, leaseId);
    const current = lease.rent.toFixed(2);
    const candidates: RentSuggestion[] = [];
    await this.db.platform(async (tx) => {
      const unit = await tx.unit.findUniqueOrThrow({
        where: { id: lease.unitId },
        include: { building: { select: { address: true } } },
      });
      const key = districtKey(unit.building.address);
      if (key && unit.areaSqm && unit.areaSqm.gt(0) && (await this.optedIn(tx, ctx.tenantId))) {
        const b = await tx.benchmarkBucket.findFirst({
          where: { metric: 'rent_per_m2', bucketKey: key },
          orderBy: { asOf: 'desc' },
        });
        if (b)
          candidates.push({
            source: 'benchmark',
            rent: new Decimal(b.p50.toString()).times(unit.areaSqm.toString()).toDecimalPlaces(0).toFixed(2),
            basis: `rent_per_m2 p50 ${b.p50.toFixed(2)} × ${unit.areaSqm.toFixed(2)} m² (k = ${b.k}, ${day(b.asOf)})`,
          });
      }
      const listing = await tx.listing.findFirst({
        where: { unitId: lease.unitId, tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, unitKind: true, bedrooms: true, sizeSqm: true, province: true, district: true },
      });
      if (listing?.province && listing.district) {
        const min = Number(
          (await this.settings.valueAt<number>('listing.comparables.min', this.clock.now(), {})) ?? 8,
        );
        const size = listing.sizeSqm ? new Prisma.Decimal(listing.sizeSqm) : null;
        const rows = await tx.$queryRaw<{ n: number; p50: Prisma.Decimal | null }[]>`
          SELECT count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY l.rent)::numeric AS p50
            FROM ops.listing l JOIN core.tenant t ON t.id = l.tenant_id
           WHERE l.id <> ${listing.id}::uuid AND t.status = 'active' AND t.deleted_at IS NULL
             AND l.unit_kind IS NOT DISTINCT FROM ${listing.unitKind}::ops.portfolio_unit_kind
             AND l.bedrooms IS NOT DISTINCT FROM ${listing.bedrooms}::smallint
             AND (${size === null} OR l.size_sqm BETWEEN ${size?.times(0.8) ?? 0}::numeric AND ${size?.times(1.2) ?? 0}::numeric)
             AND l.province = ${listing.province} AND l.district = ${listing.district}
             AND (l.state = 'published' OR (l.state = 'closed' AND l.closed_reason = 'leased'
                  AND l.closed_at >= now() - interval '12 months'))`;
        const r = rows[0];
        if (r && r.n >= min && r.p50)
          candidates.push({
            source: 'comparables',
            rent: new Decimal(r.p50.toString()).toDecimalPlaces(0).toFixed(2),
            basis: `median of ${r.n} comparable listings`,
          });
      }
    });
    candidates.push({ source: 'current_rent', rent: current, basis: 'the current rent' });
    return { currentRent: current, suggested: candidates[0]!, candidates };
  }

  // ------------------------------------------------------------------------------------------- owner

  /** 404 unless the lease is visible to the operator (contract §8). */
  async assertLease(ctx: TenantContext, leaseId: string): Promise<void> {
    await this.leases.get(ctx, leaseId);
  }

  list(ctx: TenantContext, filter: { leaseId?: string; state?: RenewalOfferState }) {
    return this.db.tenant(ctx, (tx) =>
      tx.leaseRenewalOffer.findMany({
        where: this.own(ctx, {
          leaseId: filter.leaseId,
          state: filter.state,
          buildingId: this.buildingScope(ctx),
        }),
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async get(ctx: TenantContext, id: string): Promise<OfferRow> {
    const row = this.found(
      await this.db.tenant(ctx, (tx) => tx.leaseRenewalOffer.findFirst({ where: this.own(ctx, { id }) })),
    );
    if (ctx.buildingIds && !ctx.buildingIds.includes(row.buildingId))
      throw new DomainException('http.not_found');
    return row;
  }

  /** Offers a renewal: one open offer per lease; the B7.5 renewal letter is issued in the same transaction. */
  async offer(
    ctx: TenantContext,
    leaseId: string,
    input: { rent?: string; months?: number; language?: ContractLanguage; message?: string | null },
  ): Promise<OfferRow> {
    const lease = await this.leases.get(ctx, leaseId);
    if (!['active', 'notice_given'].includes(lease.status))
      throw new DomainException('lease.invalid_state', { params: { status: lease.status } });
    if (input.rent !== undefined && (!MONEY.test(input.rent) || new Decimal(input.rent).lte(0)))
      throw new DomainException('validation.failed', {
        errors: [{ path: 'rent', code: 'money', message: 'an amount like 15000.00' }],
      });
    const open = await this.db.tenant(ctx, (tx) =>
      tx.leaseRenewalOffer.count({ where: { tenantId: ctx.tenantId, leaseId, state: 'offered' } }),
    );
    if (open) throw new DomainException('renewal.offer_exists');
    const suggestion = await this.suggestion(ctx, leaseId);
    const rent = input.rent ? new Decimal(input.rent).toFixed(2) : suggestion.suggested.rent;
    const months = input.months ?? lease.months;
    let created: OfferRow | null = null;
    try {
      await this.notices.issue(
        ctx,
        leaseId,
        {
          kind: 'renewal_offer',
          newRent: rent,
          renewalMonths: months,
          language: input.language,
          message: input.message,
        },
        {
          within: async (tx, notice) => {
            created = await tx.leaseRenewalOffer.create({
              data: {
                tenantId: lease.tenantId,
                leaseId,
                buildingId: lease.buildingId,
                unitId: lease.unitId,
                noticeId: notice.id,
                currentRent: lease.rent,
                suggestedRent: suggestion.suggested.rent,
                suggestionSource: suggestion.suggested.source,
                offeredRent: rent,
                months,
                startDate: notice.effectiveDate!,
                respondBy: notice.respondBy!,
                message: input.message?.trim() || null,
                createdBy: by(),
              },
            });
            await this.record(tx, created, 'lease.renewal_offered', {
              noticeId: notice.id,
              offeredRent: rent,
              suggestedRent: suggestion.suggested.rent,
              suggestionSource: suggestion.suggested.source,
              months,
              respondBy: day(notice.respondBy!),
              lesseePartyId: lease.lesseePartyId,
            });
          },
        },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new DomainException('renewal.offer_exists');
      throw error;
    }
    return created!;
  }

  async withdraw(ctx: TenantContext, id: string): Promise<OfferRow> {
    const offer = await this.get(ctx, id);
    return this.db.tenant(ctx, async (tx) => {
      const n = await tx.leaseRenewalOffer.updateMany({
        where: { id, tenantId: ctx.tenantId, state: 'offered' },
        data: {
          state: 'withdrawn',
          withdrawnAt: this.clock.now(),
          updatedBy: by(),
          version: { increment: 1 },
        },
      });
      if (!n.count) throw new DomainException('renewal.invalid_state');
      const row = await tx.leaseRenewalOffer.findUniqueOrThrow({ where: { id } });
      await this.record(tx, row, 'lease.renewal_withdrawn', { before: offer.state });
      return row;
    });
  }

  // ------------------------------------------------------------------------------------------- resident

  /** Offers on the leases of my token where I am the lessee (or a co-tenant), newest first. */
  async residentList(leaseIds: string[]): Promise<OfferRow[]> {
    const out: OfferRow[] = [];
    for (const leaseId of leaseIds) {
      try {
        const { ctx } = await this.residents.access(leaseId);
        out.push(
          ...(await this.db.tenant(ctx, (tx) =>
            tx.leaseRenewalOffer.findMany({ where: { leaseId }, orderBy: { createdAt: 'desc' } }),
          )),
        );
      } catch (error) {
        if (!(error instanceof DomainException)) throw error;
      }
    }
    return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** One offer on a lease of mine (404 otherwise); `lessee` = I may answer it. */
  async residentAccess(offerId: string) {
    const row = await this.db.platform((tx) => tx.leaseRenewalOffer.findUnique({ where: { id: offerId } }));
    if (!row) throw new DomainException('http.not_found');
    const access = await this.residents.access(row.leaseId);
    const lessee = access.lease.parties.some(
      (p) => p.isSigner && ['lessee', 'co_tenant'].includes(p.role) && access.partyIds.includes(p.partyId),
    );
    return { row, access, lessee };
  }

  private async answerable(offerId: string) {
    const a = await this.residentAccess(offerId);
    if (!a.lessee) throw new DomainException('lease.not_signer');
    if (a.row.state !== 'offered') throw new DomainException('renewal.invalid_state');
    if (day(a.row.respondBy) < this.today()) {
      await this.expire([a.row.id]);
      throw new DomainException('renewal.invalid_state');
    }
    return a;
  }

  /**
   * I accept: the offer is accepted, a renewal draft (same parties, the offered rent and term, deposit carried) is
   * created and sent for my signature. If the draft cannot be made the offer stays open (nothing half-done).
   */
  async accept(offerId: string) {
    const { row, access } = await this.answerable(offerId);
    const userId = this.residents.currentUserId();
    const partyId = access.partyIds[0] ?? null;
    const ctx = access.ctx;
    const moved = await this.db.tenant(ctx, (tx) =>
      tx.leaseRenewalOffer.updateMany({
        where: { id: offerId, state: 'offered' },
        data: {
          state: 'accepted',
          decidedAt: this.clock.now(),
          decidedByPartyId: partyId,
          decidedByUserId: userId,
          version: { increment: 1 },
        },
      }),
    );
    if (!moved.count) throw new DomainException('renewal.invalid_state');
    let draftId: string;
    try {
      const draft = await this.leases.renew(ctx, row.leaseId, {
        months: row.months,
        rent: row.offeredRent.toFixed(2),
      });
      draftId = draft.id;
    } catch (error) {
      await this.db.tenant(ctx, (tx) =>
        tx.leaseRenewalOffer.update({
          where: { id: offerId },
          data: { state: 'offered', decidedAt: null, decidedByPartyId: null, decidedByUserId: null },
        }),
      );
      throw error;
    }
    let sent = true;
    try {
      await this.leases.sendForSignature(ctx, draftId);
    } catch (error) {
      // e.g. the lessee's identity is not on file: the owner completes and sends the draft
      sent = false;
      this.logger.warn(`renewal draft ${draftId} not sent for signature: ${(error as Error).message}`);
    }
    await this.db.tenant(ctx, async (tx) => {
      const updated = await tx.leaseRenewalOffer.update({
        where: { id: offerId },
        data: { newLeaseId: draftId },
      });
      await this.record(tx, updated, 'lease.renewal_accepted', {
        newLeaseId: draftId,
        sentForSignature: sent,
        offeredRent: updated.offeredRent.toFixed(2),
        endDate: day(access.lease.endDate),
      });
    });
    return this.db.platform((tx) => tx.leaseRenewalOffer.findUniqueOrThrow({ where: { id: offerId } }));
  }

  /**
   * I decline: with ≥ 30 days left my notice to the end date is recorded (the D-219 move-out follows); with fewer
   * days the lease simply ends on its end date. The owner is told (re-list).
   */
  async decline(offerId: string, reason: string | null) {
    const { row, access } = await this.answerable(offerId);
    const userId = this.residents.currentUserId();
    const end = day(access.lease.endDate);
    const today = this.today();
    let noticeRecorded = false;
    if (access.lease.status === 'active' && daysBetween(today, end) >= 30) {
      await this.leases.recordNotice(
        access.ctx,
        row.leaseId,
        { by: 'lessee', effectiveDate: end, reasonCode: 'renewal_declined', note: reason },
        { refuseWarnings: true },
      );
      noticeRecorded = true;
    }
    return this.db.tenant(access.ctx, async (tx) => {
      const n = await tx.leaseRenewalOffer.updateMany({
        where: { id: offerId, state: 'offered' },
        data: {
          state: 'declined',
          decidedAt: this.clock.now(),
          decidedByPartyId: access.partyIds[0] ?? null,
          decidedByUserId: userId,
          declineReason: reason?.trim().slice(0, 500) || null,
          version: { increment: 1 },
        },
      });
      if (!n.count) throw new DomainException('renewal.invalid_state');
      const updated = await tx.leaseRenewalOffer.findUniqueOrThrow({ where: { id: offerId } });
      await this.record(tx, updated, 'lease.renewal_declined', { noticeRecorded, endDate: end });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------- job

  private async expire(ids: string[]): Promise<void> {
    await this.db.platform(async (tx) => {
      for (const id of ids) {
        const n = await tx.leaseRenewalOffer.updateMany({
          where: { id, state: 'offered' },
          data: { state: 'expired', version: { increment: 1 } },
        });
        if (n.count) {
          const row = await tx.leaseRenewalOffer.findUniqueOrThrow({ where: { id } });
          await this.record(tx, row, 'lease.renewal_expired', { respondBy: day(row.respondBy) });
        }
      }
    });
  }

  /**
   * Job `lease-renewals` (hourly, all tenants as gp_platform): expires offers past `respond_by`; reminds owners once
   * per threshold of `lease.renewal.remind_days` (tenant override) for leases in force without an open / accepted
   * offer — a landlord's lease already reminded by B7.11 is not reminded again at or above that lead time.
   */
  async maintain(): Promise<{ expired: number; reminded: number }> {
    const today = this.today();
    const due = await this.db.platform((tx) =>
      tx.leaseRenewalOffer.findMany({
        where: { state: 'offered', respondBy: { lt: new Date(today) } },
        select: { id: true },
      }),
    );
    await this.expire(due.map((d) => d.id));
    const now = this.clock.now();
    const b7 = Number((await this.settings.valueAt<number>('lease.end.remind_days_before', now, {})) ?? 0);
    const leases = await this.db.platform((tx) =>
      tx.lease.findMany({
        where: {
          status: 'active',
          endDate: { gte: new Date(today), lte: new Date(addCalendarDays(today, 366)) },
          renewalOffers: { none: { state: { in: ['offered', 'accepted'] } } },
          renewals: { none: { status: { notIn: ['cancelled'] } } },
        },
        include: { tenant: { select: { type: true } } },
      }),
    );
    let reminded = 0;
    for (const l of leases) {
      const raw = await this.settings.valueAt<number[]>('lease.renewal.remind_days', now, {
        tenantId: l.tenantId,
      });
      const thresholds = (Array.isArray(raw) ? raw : [])
        .filter((d) => Number.isInteger(d))
        .sort((a, b) => b - a);
      const left = daysBetween(today, day(l.endDate));
      const hit = thresholds.filter(
        (d) => left <= d && (l.renewalRemindedDays === null || d < l.renewalRemindedDays),
      );
      if (!hit.length) continue;
      const threshold = hit[hit.length - 1]!;
      const skip =
        l.tenant.type === 'landlord' && l.endRemindedAt !== null && b7 > 0 && threshold >= Math.min(b7, left);
      await this.db.platform(async (tx) => {
        await tx.lease.update({ where: { id: l.id }, data: { renewalRemindedDays: threshold } });
        if (skip) return;
        await this.events.record(tx, {
          type: 'lease.renewal_due',
          aggregateType: 'lease',
          aggregateId: l.id,
          tenantId: l.tenantId,
          buildingId: l.buildingId,
          payload: { leaseId: l.id, unitId: l.unitId, endDate: day(l.endDate), daysLeft: left, threshold },
        });
      });
      if (!skip) reminded += 1;
    }
    return { expired: due.length, reminded };
  }

  private async record(
    tx: Tx,
    row: OfferRow,
    type: Exclude<Extract<DomainEventType, `lease.renewal_${string}`>, 'lease.renewal_due'>,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.record(tx, {
      action: type,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      subjectType: 'ops.lease_renewal_offer',
      subjectId: row.id,
      metadata: { leaseId: row.leaseId, ...metadata },
    });
    await this.events.record(tx, {
      type,
      aggregateType: 'lease_renewal_offer',
      aggregateId: row.id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: { offerId: row.id, leaseId: row.leaseId, unitId: row.unitId, ...metadata },
    });
  }
}

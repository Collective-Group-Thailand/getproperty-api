import { randomInt, randomUUID } from 'node:crypto';

import { type LineMessage } from '@collective/integrations/line';
import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type QuietHours } from '@core/notifications/quiet-hours';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type PlatformInvoice,
  type PricePlanVersion,
  Prisma,
  type SponsoredCampaign,
  type SponsoredCampaignState,
} from '@generated/prisma/client';
import { LINE_MULTICAST, type LineMulticastPort } from '@integrations/line-multicast/line-multicast.port';
import { PublicListingsService } from '@modules/ops-listings/public-listings.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

import { PlatformBillingService } from '../platform-subscriptions/platform-billing.service';
import { type PlanWithVersions, versionInForce } from '../platform-subscriptions/storage-packages.service';
import { AudienceService, hhmmOf } from './audience.service';
import {
  capWindowStart,
  costPreview,
  inQuietHours,
  isSponsoredProduct,
  matchesSegment,
  messageLanguage,
  minimumOf,
  MULTICAST_LIMIT,
  type OfferedListing,
  parseSegment,
  type PreferenceFacts,
  RECOMMENDATIONS_PURPOSE,
  type Segment,
  shownEstimate,
  SPONSORED_PRODUCT,
  sponsoredCharges,
  sponsoredMessage,
} from './audience-rules';

const SUBJECT = 'platform.sponsored_campaign';
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const MAX_ATTEMPTS = 5;
/** Candidates read per send pass (each pass also stops at the remaining quota). */
const PASS_LIMIT = 5000;

export interface SponsoredProduct {
  plan: PlanWithVersions | null;
  /** The priced version in force, else the newest version (terms only). */
  version: PricePlanVersion | null;
  onSale: boolean;
  enabled: boolean;
  pricePerRecipient: string | null;
  vatRate: string;
  currency: string;
  minimumRecipients: number;
  maxListings: number;
  maxPerWeek: number;
}

export interface CampaignInput {
  name: string;
  listingIds: string[];
  segment: unknown;
  maxRecipients: number;
}

export type CampaignRow = SponsoredCampaign & {
  platformInvoice: PlatformInvoice | null;
  tenant: { displayName: string };
};

const INCLUDE = {
  platformInvoice: true,
  tenant: { select: { displayName: true } },
} as const satisfies Prisma.SponsoredCampaignInclude;

interface Candidate extends PreferenceFacts {
  userId: string;
  lineUserId: string;
  quietStart: string | null;
  quietEnd: string | null;
}

interface CandidateRow {
  user_id: string;
  line_user_id: string | null;
  area_slugs: string[];
  budget_min: string | null;
  budget_max: string | null;
  unit_kinds: string[];
  move_in_from: string | null;
  move_in_to: string | null;
  language: string;
  quiet_start: Date | null;
  quiet_end: Date | null;
}

const by = () => userIdOf(RequestContext.actor());

/**
 * Sponsored broadcast (G6, D-287, D-291, D-300; gate O-023, prices O-027): a buyer tenant sends its own published
 * listings through **getproperty's** LINE OA to people who opted in to `platform.recommendations` and whose own
 * preferences fit the campaign's segment (a closed whitelist — no special-category data). The buyer sees aggregates
 * only (estimate withheld below the minimum, sent, clicks per campaign link, attributed leads) and never a person;
 * a person reaches the buyer only by enquiring. Consent, the weekly cap and quiet hours are checked **when sending**,
 * and consent once more right before the provider call. A completed campaign is billed per delivered recipient on a
 * `purchase` platform invoice (Collective issues it, O-008; no gateway, O-020). Nothing is scheduled or sent while
 * `broadcast.sponsored.enabled` is off.
 */
@Injectable()
export class SponsoredCampaignsService {
  private readonly logger = new Logger('SponsoredCampaigns');

  constructor(
    private readonly db: TenantTx,
    private readonly audience: AudienceService,
    private readonly billing: PlatformBillingService,
    private readonly settings: SettingsService,
    private readonly publicListings: PublicListingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(LINE_MULTICAST) private readonly line: LineMulticastPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------------- product

  private async productIn(tx: Tx): Promise<SponsoredProduct> {
    const now = this.clock.now();
    const plans = await tx.pricePlan.findMany({
      where: { kind: 'addon', isActive: true, key: SPONSORED_PRODUCT },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    const plan = plans[0] ?? null;
    const inForce = plan ? versionInForce(plan, bangkokDate(now)) : null;
    const priced =
      inForce && inForce.unitPrice !== null && isSponsoredProduct(inForce.terms) ? inForce : null;
    const version = priced ?? plan?.versions.find((v) => isSponsoredProduct(v.terms)) ?? null;
    return {
      plan,
      version,
      onSale: priced !== null,
      enabled: (await this.settings.valueAt<boolean>('broadcast.sponsored.enabled', now)) === true,
      pricePerRecipient: priced ? new Decimal(priced.unitPrice!.toString()).toFixed(4) : null,
      vatRate: new Decimal(version?.vatRate.toString() ?? '0.07').toFixed(4),
      currency: version?.currency ?? 'THB',
      minimumRecipients: minimumOf(version?.terms),
      maxListings: await this.settings.valueAt<number>('broadcast.sponsored.max_listings', now),
      maxPerWeek: await this.settings.valueAt<number>('broadcast.sponsored.max_per_week', now),
    };
  }

  /** `GET /v1/owner/sponsored-campaigns/product`: the switch, the price per recipient and the minimum. */
  product(): Promise<SponsoredProduct> {
    return this.db.platform((tx) => this.productIn(tx));
  }

  // ------------------------------------------------------------------------------------------------- matching

  /** The buyer's own listings among `ids`, each still public; refuses foreign ids (404) and unpublished (409). */
  private async ownPublicListings(tx: Tx, tenantId: string, ids: string[], maxListings: number) {
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length > maxListings)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'listingIds', code: 'size', message: `1–${maxListings} listings` }],
      });
    const rows = await tx.listing.findMany({
      where: { id: { in: unique }, tenantId },
      select: {
        id: true,
        slug: true,
        titleTh: true,
        titleEn: true,
        rent: true,
        unitKind: true,
        state: true,
        hiddenAt: true,
        district: true,
        province: true,
      },
    });
    if (rows.length !== unique.length) throw new DomainException('http.not_found');
    const closed = rows.find((r) => r.state !== 'published' || r.hiddenAt);
    if (closed)
      throw new DomainException('broadcast.listing_not_public', { params: { state: closed.state } });
    return unique.map((id) => rows.find((r) => r.id === id)!);
  }

  private segmentOf(raw: unknown): Segment {
    const { segment, problems } = parseSegment(raw);
    if (problems.length)
      throw new DomainException('validation.failed', {
        errors: problems.map((p) => ({ path: p.path, code: 'segment', message: p.message })),
      });
    return segment;
  }

  /**
   * People who may get a campaign **now**: consent `platform.recommendations` granted at the current version, an
   * active login with a LINE id, preferences not withdrawn; with `forCampaign`, also not yet sent this campaign and
   * under the rolling weekly cap. Matching (segment + listings) and quiet hours are applied by the caller.
   */
  private async candidates(
    tx: Tx,
    segment: Segment,
    forCampaign: { id: string; cap: number; now: Date } | null,
  ): Promise<Candidate[]> {
    const current = await this.audience.currentVersion(tx);
    if (current === null) return [];
    const areas = segment.areas;
    const rows = await tx.$queryRaw<CandidateRow[]>`
      SELECT p.user_id::text, u.line_user_id, p.area_slugs, p.budget_min::text, p.budget_max::text,
             p.unit_kinds::text[] AS unit_kinds, p.move_in_from::text, p.move_in_to::text, p.language,
             p.quiet_start, p.quiet_end
        FROM platform.audience_preference p
        JOIN core.user_account u ON u.id = p.user_id AND u.status = 'active'
        JOIN platform.v_consent_state c
          ON c.subject_type = 'user'::platform.consent_subject AND c.subject_id = p.user_id
         AND c.purpose_key = ${RECOMMENDATIONS_PURPOSE} AND c.granted AND c.purpose_version >= ${current}
       WHERE p.withdrawn_at IS NULL
         AND (cardinality(p.area_slugs) = 0 OR cardinality(${areas}::text[]) = 0 OR p.area_slugs && ${areas}::text[])
         ${forCampaign ? this.campaignFilter(forCampaign.id, forCampaign.cap, capWindowStart(forCampaign.now)) : Prisma.empty}
       ORDER BY md5(p.user_id::text || ${forCampaign?.id ?? 'estimate'})
       LIMIT ${PASS_LIMIT}`;
    return rows.map((r) => ({
      userId: r.user_id,
      lineUserId: r.line_user_id ?? '',
      areaSlugs: r.area_slugs,
      budgetMin: r.budget_min,
      budgetMax: r.budget_max,
      unitKinds: r.unit_kinds,
      moveInFrom: r.move_in_from,
      moveInTo: r.move_in_to,
      language: r.language,
      quietStart: hhmmOf(r.quiet_start),
      quietEnd: hhmmOf(r.quiet_end),
    }));
  }

  /** Not yet in this campaign and under the rolling weekly cap over every campaign (pending + sent). */
  private campaignFilter(campaignId: string, cap: number, since: Date) {
    return Prisma.sql`AND u.line_user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM platform.sponsored_delivery x
                          WHERE x.campaign_id = ${campaignId}::uuid AND x.user_id = p.user_id)
         AND (SELECT count(*) FROM platform.sponsored_delivery w
               WHERE w.user_id = p.user_id AND w.state IN ('pending', 'sent') AND w.created_at > ${since}) < ${cap}`;
  }

  private offered(listings: { rent: Prisma.Decimal; unitKind: string | null }[]): OfferedListing[] {
    return listings.map((l) => ({ rent: l.rent.toFixed(2), unitKind: l.unitKind }));
  }

  /**
   * `POST /v1/owner/sponsored-campaigns/estimate` (and the draft's `estimated`): how many consenting people fit —
   * shown only at or above the minimum (aggregate only, no person, D-300), with the price preview.
   */
  async estimate(ctx: TenantContext, input: Omit<CampaignInput, 'name'>) {
    return this.db.platform(
      async (tx) => {
        const product = await this.productIn(tx);
        const listings = await this.ownPublicListings(
          tx,
          ctx.tenantId,
          input.listingIds,
          product.maxListings,
        );
        const segment = this.segmentOf(input.segment);
        const count = await this.count(tx, segment, this.offered(listings));
        const shown = shownEstimate(count, product.minimumRecipients, input.maxRecipients);
        return {
          ...shown,
          minimumRecipients: product.minimumRecipients,
          product,
          cost:
            shown.estimated === null
              ? null
              : costPreview(shown.estimated, product.pricePerRecipient, product.vatRate),
        };
      },
      { tenantId: ctx.tenantId },
    );
  }

  private async count(tx: Tx, segment: Segment, listings: OfferedListing[]): Promise<number> {
    return (await this.candidates(tx, segment, null)).filter(
      (c) => c.lineUserId && matchesSegment(c, segment, listings),
    ).length;
  }

  // ------------------------------------------------------------------------------------------------- owner

  /** A draft campaign (Idempotency-Key on the route); its estimate is stored for the list. */
  async create(ctx: TenantContext, input: CampaignInput): Promise<CampaignRow> {
    const name = input.name.trim();
    const id = await this.db.platform(
      async (tx) => {
        const product = await this.productIn(tx);
        const listings = await this.ownPublicListings(
          tx,
          ctx.tenantId,
          input.listingIds,
          product.maxListings,
        );
        const segment = this.segmentOf(input.segment);
        const count = await this.count(tx, segment, this.offered(listings));
        const shown = shownEstimate(count, product.minimumRecipients, input.maxRecipients);
        const row = await tx.sponsoredCampaign.create({
          data: {
            tenantId: ctx.tenantId,
            name,
            listingIds: listings.map((l) => l.id),
            segment: segment as unknown as Prisma.InputJsonValue,
            maxRecipients: input.maxRecipients,
            estimated: shown.estimated,
            createdBy: by(),
          },
        });
        await this.audit.record(tx, {
          action: 'sponsored_campaign.created',
          tenantId: ctx.tenantId,
          subjectType: SUBJECT,
          subjectId: row.id,
          after: { listings: row.listingIds.length, maxRecipients: row.maxRecipients },
        });
        await this.events.record(tx, {
          type: 'sponsored_campaign.created',
          aggregateType: 'sponsored_campaign',
          aggregateId: row.id,
          tenantId: ctx.tenantId,
          payload: { campaignId: row.id },
        });
        return row.id;
      },
      { tenantId: ctx.tenantId },
    );
    return this.get(ctx, id);
  }

  async get(ctx: TenantContext, id: string): Promise<CampaignRow> {
    const row = await this.db.platform(
      (tx) => tx.sponsoredCampaign.findFirst({ where: { id, tenantId: ctx.tenantId }, include: INCLUDE }),
      { tenantId: ctx.tenantId },
    );
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  async list(ctx: TenantContext, input: { state?: SponsoredCampaignState; skip: number; take: number }) {
    const where = { tenantId: ctx.tenantId, ...(input.state ? { state: input.state } : {}) };
    return this.db.platform(
      async (tx) => ({
        rows: await tx.sponsoredCampaign.findMany({
          where,
          include: INCLUDE,
          orderBy: { createdAt: 'desc' },
          skip: input.skip,
          take: input.take,
        }),
        total: await tx.sponsoredCampaign.count({ where }),
      }),
      { tenantId: ctx.tenantId },
    );
  }

  /** Listings of campaigns for the DTO (title, slug, still public). */
  async listingsOf(ids: string[]) {
    if (!ids.length) return new Map<string, { id: string; slug: string; title: string; public: boolean }>();
    const rows = await this.db.platform((tx) =>
      tx.listing.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, slug: true, titleTh: true, state: true, hiddenAt: true },
      }),
    );
    return new Map(
      rows.map((r) => [
        r.id,
        { id: r.id, slug: r.slug, title: r.titleTh, public: r.state === 'published' && !r.hiddenAt },
      ]),
    );
  }

  private async newCode(tx: Tx): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      let code = '';
      for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const clash =
        (await tx.listingShareLink.findUnique({ where: { code } })) ??
        (await tx.sponsoredCampaignLink.findUnique({ where: { code } }));
      if (!clash) return code;
    }
    throw new Error('sponsored link: no free code');
  }

  /**
   * Schedules a draft (Idempotency-Key): the switch must be on (O-023), the product priced (O-027), the listings still
   * public and the estimate at or above the minimum. The price per recipient, VAT rate and minimum are snapshotted;
   * one short link per listing is made for the click count.
   */
  async schedule(
    ctx: TenantContext,
    id: string,
    input: { scheduledAt?: string | null },
  ): Promise<CampaignRow> {
    await this.db.platform(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM platform.sponsored_campaign WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
        if (!locked.length) throw new DomainException('http.not_found');
        const c = await tx.sponsoredCampaign.findUniqueOrThrow({ where: { id } });
        if (c.state !== 'draft')
          throw new DomainException('broadcast.invalid_state', { params: { state: c.state } });
        const product = await this.productIn(tx);
        if (!product.enabled) throw new DomainException('broadcast.sponsored_disabled');
        if (!product.onSale || !product.version || product.pricePerRecipient === null)
          throw new DomainException('broadcast.not_on_sale');
        const now = this.clock.now();
        const at = input.scheduledAt ? new Date(input.scheduledAt) : now;
        if (
          Number.isNaN(at.getTime()) ||
          at.getTime() < now.getTime() - 60_000 ||
          at.getTime() > now.getTime() + 90 * 86_400_000
        )
          throw new DomainException('validation.failed', {
            errors: [{ path: 'scheduledAt', code: 'range', message: 'from now up to 90 days ahead' }],
          });
        const listings = await this.ownPublicListings(tx, ctx.tenantId, c.listingIds, product.maxListings);
        const segment = this.segmentOf(c.segment);
        const count = await this.count(tx, segment, this.offered(listings));
        const shown = shownEstimate(count, product.minimumRecipients, c.maxRecipients);
        if (shown.belowMinimum || c.maxRecipients < product.minimumRecipients)
          throw new DomainException('broadcast.below_minimum', {
            params: { minimum: product.minimumRecipients },
          });
        for (const l of listings)
          await tx.sponsoredCampaignLink.create({
            data: { tenantId: ctx.tenantId, campaignId: id, listingId: l.id, code: await this.newCode(tx) },
          });
        await tx.sponsoredCampaign.update({
          where: { id },
          data: {
            state: 'scheduled',
            scheduledAt: at,
            estimated: shown.estimated,
            pricePlanVersionId: product.version.id,
            pricePerRecipient: product.pricePerRecipient,
            vatRate: product.vatRate,
            minimumRecipients: product.minimumRecipients,
            version: { increment: 1 },
            updatedBy: by(),
          },
        });
        await this.audit.record(tx, {
          action: 'sponsored_campaign.scheduled',
          tenantId: ctx.tenantId,
          subjectType: SUBJECT,
          subjectId: id,
          after: {
            scheduledAt: at.toISOString(),
            pricePerRecipient: product.pricePerRecipient,
            plan: { versionId: product.version.id, version: product.version.version },
            minimum: product.minimumRecipients,
          },
        });
        await this.events.record(tx, {
          type: 'sponsored_campaign.scheduled',
          aggregateType: 'sponsored_campaign',
          aggregateId: id,
          tenantId: ctx.tenantId,
          payload: { campaignId: id, scheduledAt: at.toISOString() },
        });
      },
      { tenantId: ctx.tenantId },
    );
    return this.get(ctx, id);
  }

  /** Cancels a draft or a scheduled campaign (nothing was sent, nothing is billed). */
  async cancel(ctx: TenantContext, id: string): Promise<CampaignRow> {
    await this.db.platform(
      async (tx) => {
        const c = await tx.sponsoredCampaign.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!c) throw new DomainException('http.not_found');
        if (c.state !== 'draft' && c.state !== 'scheduled')
          throw new DomainException('broadcast.invalid_state', { params: { state: c.state } });
        await tx.sponsoredCampaign.update({
          where: { id },
          data: {
            state: 'cancelled',
            cancelledAt: this.clock.now(),
            version: { increment: 1 },
            updatedBy: by(),
          },
        });
        await this.audit.record(tx, {
          action: 'sponsored_campaign.cancelled',
          tenantId: ctx.tenantId,
          subjectType: SUBJECT,
          subjectId: id,
          before: { state: c.state },
        });
        await this.events.record(tx, {
          type: 'sponsored_campaign.cancelled',
          aggregateType: 'sponsored_campaign',
          aggregateId: id,
          tenantId: ctx.tenantId,
          payload: { campaignId: id },
        });
      },
      { tenantId: ctx.tenantId },
    );
    return this.get(ctx, id);
  }

  /**
   * The buyer's report — **aggregates only** (D-300): sent, opened (null: LINE gives no per-message opens for a
   * multicast), clicks on the campaign links, leads (enquiries on the campaign's listings by people who got it, within
   * `broadcast.sponsored.attribution_days`). Never a person, a LINE id or a delivery row.
   */
  async report(ctx: TenantContext, id: string) {
    const campaign = await this.get(ctx, id);
    const days = await this.settings.valueAt<number>(
      'broadcast.sponsored.attribution_days',
      this.clock.now(),
    );
    const leads = await this.db.platform(async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT l.id)::int AS n
          FROM platform.sponsored_delivery d
          JOIN ops.listing_lead l ON l.user_id = d.user_id AND l.listing_id = ANY (${campaign.listingIds}::uuid[])
         WHERE d.campaign_id = ${id}::uuid AND d.state = 'sent'
           AND l.created_at >= d.created_at AND l.created_at < d.created_at + make_interval(days => ${days}::int)`;
      return rows[0]?.n ?? 0;
    });
    return { campaign, leads, attributionDays: days };
  }

  // ------------------------------------------------------------------------------------------------- admin

  async adminList(input: { state?: SponsoredCampaignState; skip: number; take: number }) {
    const where = input.state ? { state: input.state } : {};
    return this.db.platform(async (tx) => ({
      rows: await tx.sponsoredCampaign.findMany({
        where,
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: input.skip,
        take: input.take,
      }),
      total: await tx.sponsoredCampaign.count({ where }),
    }));
  }

  /** The platform rejects a scheduled / sending campaign (content, policy): pending deliveries stop; not billed. */
  async reject(id: string, reason: string): Promise<CampaignRow> {
    const row = await this.db.platform(async (tx) => {
      const c = await tx.sponsoredCampaign.findUnique({ where: { id } });
      if (!c) throw new DomainException('http.not_found');
      if (!['draft', 'scheduled', 'sending'].includes(c.state))
        throw new DomainException('broadcast.invalid_state', { params: { state: c.state } });
      await tx.sponsoredDelivery.updateMany({
        where: { campaignId: id, state: 'pending' },
        data: { state: 'cancelled', failedReason: 'campaign rejected' },
      });
      await tx.sponsoredCampaign.update({
        where: { id },
        data: {
          state: 'rejected',
          rejectedAt: this.clock.now(),
          rejectReason: reason.trim(),
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'sponsored_campaign.rejected',
        tenantId: c.tenantId,
        subjectType: SUBJECT,
        subjectId: id,
        before: { state: c.state },
        metadata: { reason: reason.trim() },
      });
      await this.events.record(tx, {
        type: 'sponsored_campaign.rejected',
        aggregateType: 'sponsored_campaign',
        aggregateId: id,
        tenantId: c.tenantId,
        payload: { campaignId: id, delivered: c.delivered },
      });
      return tx.sponsoredCampaign.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    });
    return row;
  }

  // ------------------------------------------------------------------------------------------------- job

  /**
   * Worker job `sponsored-broadcasts` (every minute): while the switch is on, due scheduled campaigns start and every
   * sending campaign does one pass; always: withdrawn preferences and old delivery rows are purged.
   */
  async run(): Promise<{ started: number; sent: number; completed: number }> {
    return RequestContext.run({ actor: systemActor('sponsored-broadcasts') }, async () => {
      const now = this.clock.now();
      const out = { started: 0, sent: 0, completed: 0 };
      await this.audience.purgeWithdrawn();
      await this.purgeDeliveries();
      if ((await this.settings.valueAt<boolean>('broadcast.sponsored.enabled', now)) !== true) return out;
      out.started = await this.startDue();
      const sending = await this.db.platform((tx) =>
        tx.sponsoredCampaign.findMany({ where: { state: 'sending' }, select: { id: true }, take: 50 }),
      );
      for (const { id } of sending) {
        try {
          const r = await this.pass(id);
          out.sent += r.sent;
          if (r.completed) out.completed += 1;
        } catch (error) {
          this.logger.warn(`campaign ${id}: ${(error as Error).message}`);
        }
      }
      return out;
    });
  }

  private async startDue(): Promise<number> {
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const due = await tx.sponsoredCampaign.findMany({
        where: { state: 'scheduled', scheduledAt: { lte: now } },
        select: { id: true, tenantId: true },
        take: 50,
      });
      for (const c of due) {
        await tx.sponsoredCampaign.update({
          where: { id: c.id },
          data: { state: 'sending', sendingStartedAt: now, version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          action: 'sponsored_campaign.sending',
          tenantId: c.tenantId,
          subjectType: SUBJECT,
          subjectId: c.id,
        });
        await this.events.record(tx, {
          type: 'sponsored_campaign.sending',
          aggregateType: 'sponsored_campaign',
          aggregateId: c.id,
          tenantId: c.tenantId,
          payload: { campaignId: c.id },
        });
      }
      return due.length;
    });
  }

  /** The message per language of a campaign's listings still public (null when none is). */
  private async messages(tx: Tx, c: SponsoredCampaign): Promise<Record<'th' | 'en', LineMessage[]> | null> {
    const listings = await tx.listing.findMany({
      where: { id: { in: c.listingIds }, state: 'published', hiddenAt: null },
      include: { sponsoredCampaignLinks: { where: { campaignId: c.id } } },
    });
    const ordered = c.listingIds.flatMap((id) => listings.filter((l) => l.id === id));
    if (!ordered.length) return null;
    const web = this.config.get('PUBLIC_WEB_APP_URL');
    const settingsUrl = `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/recommendations`;
    const build = (lang: 'th' | 'en') =>
      sponsoredMessage(
        lang,
        ordered.map((l) => ({
          title: lang === 'en' && l.titleEn ? l.titleEn : l.titleTh,
          rent: l.rent.toFixed(2),
          place: [l.district, l.province].filter(Boolean).join(', ') || null,
          imageUrl: this.publicListings.ogImageUrl(l.slug),
          url: l.sponsoredCampaignLinks[0]
            ? `${web}/s/${l.sponsoredCampaignLinks[0].code}`
            : this.publicListings.pageUrl(l.slug),
        })),
        settingsUrl,
      ) as unknown as LineMessage[];
    return { th: build('th'), en: build('en') };
  }

  /**
   * One pass of a sending campaign: pending batches are sent first; otherwise new people are selected (consent,
   * match, cap, not in quiet hours, up to the remaining quota) as pending batches and sent; the campaign completes
   * when the quota is reached, nobody is left, or the send window passed.
   */
  private async pass(id: string): Promise<{ sent: number; completed: boolean }> {
    const now = this.clock.now();
    const window = await this.settings.valueAt<number>('broadcast.sponsored.send_window_hours', now);
    const cap = await this.settings.valueAt<number>('broadcast.sponsored.max_per_week', now);
    const fallbackQuiet = await this.settings.valueAt<QuietHours>('broadcast.sponsored.quiet_hours', now);
    const plan = await this.db.platform(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM platform.sponsored_campaign WHERE id = ${id}::uuid AND state = 'sending' FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return null;
      const c = await tx.sponsoredCampaign.findUniqueOrThrow({ where: { id } });
      const messages = await this.messages(tx, c);
      const pending = await tx.sponsoredDelivery.count({ where: { campaignId: id, state: 'pending' } });
      const used = await tx.sponsoredDelivery.count({
        where: { campaignId: id, state: { in: ['pending', 'sent'] } },
      });
      const windowOver = c.sendingStartedAt
        ? now.getTime() >= c.sendingStartedAt.getTime() + window * 3_600_000
        : false;
      let deferred = 0;
      let selected = 0;
      let allTaken = false;
      if (messages && !pending && !windowOver && used < c.maxRecipients && cap > 0) {
        const segment = parseSegment(c.segment).segment;
        const listings = await tx.listing.findMany({
          where: { id: { in: c.listingIds }, state: 'published', hiddenAt: null },
          select: { rent: true, unitKind: true },
        });
        const fit = (await this.candidates(tx, segment, { id, cap, now })).filter(
          (p) => p.lineUserId && matchesSegment(p, segment, this.offered(listings)),
        );
        const awake = fit.filter((p) => {
          const own = p.quietStart && p.quietEnd ? { start: p.quietStart, end: p.quietEnd } : null;
          const quiet = inQuietHours(now, own, fallbackQuiet);
          if (quiet) deferred += 1;
          return !quiet;
        });
        const take = awake.slice(0, c.maxRecipients - used);
        // everyone who fits now is taken (nobody deferred, nothing left beyond this read)
        allTaken = deferred === 0 && fit.length < PASS_LIMIT && take.length === awake.length;
        const byLang = new Map<'th' | 'en', Candidate[]>();
        for (const p of take) {
          const lang = messageLanguage(p.language);
          byLang.set(lang, [...(byLang.get(lang) ?? []), p]);
        }
        for (const [lang, people] of byLang)
          for (let i = 0; i < people.length; i += MULTICAST_LIMIT) {
            const batchId = randomUUID();
            await tx.sponsoredDelivery.createMany({
              data: people.slice(i, i + MULTICAST_LIMIT).map((p) => ({
                campaignId: id,
                userId: p.userId,
                batchId,
                language: lang,
              })),
              skipDuplicates: true,
            });
          }
        selected = take.length;
      }
      return { c, messages, windowOver, deferred, selected, allTaken, hadPending: pending > 0 };
    });
    if (!plan) return { sent: 0, completed: false };
    let sent = 0;
    if (plan.messages) {
      const batches = await this.db.platform((tx) =>
        tx.sponsoredDelivery.findMany({
          where: { campaignId: id, state: 'pending' },
          distinct: ['batchId'],
          select: { batchId: true, language: true },
        }),
      );
      for (const b of batches)
        sent += await this.sendBatch(plan.c, b.batchId, plan.messages[b.language === 'th' ? 'th' : 'en']);
    } else {
      // no listing of the campaign is public any more: nothing more is sent
      await this.db.platform((tx) =>
        tx.sponsoredDelivery.updateMany({
          where: { campaignId: id, state: 'pending' },
          data: { state: 'cancelled', failedReason: 'no public listing left' },
        }),
      );
    }
    // complete when nothing waits and nothing more can be sent
    const done = await this.db.platform(async (tx) => {
      const c = await tx.sponsoredCampaign.findUniqueOrThrow({ where: { id } });
      if (c.state !== 'sending') return false;
      const pending = await tx.sponsoredDelivery.count({ where: { campaignId: id, state: 'pending' } });
      if (pending) return false;
      const full = c.delivered >= c.maxRecipients;
      // nobody left: this pass took everyone who fits (or found nobody) and nothing waits for quiet hours
      const exhausted = !plan.hadPending && plan.allTaken;
      if (!(full || exhausted || plan.windowOver || !plan.messages || cap <= 0)) return false;
      await this.complete(tx, c);
      return true;
    });
    return { sent, completed: done };
  }

  /**
   * Sends one batch: consent is checked once more for each person right before the provider call (withdrawn meanwhile
   * → cancelled); the batch id is LINE's retry key, so a retried batch is not delivered twice.
   */
  private async sendBatch(c: SponsoredCampaign, batchId: string, messages: LineMessage[]): Promise<number> {
    const ready = await this.db.platform(async (tx) => {
      const rows = await tx.sponsoredDelivery.findMany({
        where: { batchId, state: 'pending' },
        include: { user: { select: { lineUserId: true, status: true } } },
      });
      const ok: { id: string; line: string }[] = [];
      for (const r of rows) {
        const consented = await this.audience.grantedConsent(tx, r.userId);
        const pref = await tx.audiencePreference.findUnique({
          where: { userId: r.userId },
          select: { withdrawnAt: true },
        });
        if (!consented || !pref || pref.withdrawnAt || r.user.status !== 'active' || !r.user.lineUserId) {
          await tx.sponsoredDelivery.update({
            where: { id: r.id },
            data: { state: 'cancelled', failedReason: 'consent withdrawn or no LINE before sending' },
          });
          continue;
        }
        ok.push({ id: r.id, line: r.user.lineUserId });
      }
      return ok;
    });
    if (!ready.length) return 0;
    try {
      await this.line.multicast(
        ready.map((r) => r.line),
        messages,
        batchId,
      );
    } catch (error) {
      await this.db.platform(async (tx) => {
        for (const r of ready) {
          const row = await tx.sponsoredDelivery.update({
            where: { id: r.id },
            data: {
              attempts: { increment: 1 },
              failedReason: String((error as Error).message).slice(0, 500),
            },
          });
          if (row.attempts >= MAX_ATTEMPTS)
            await tx.sponsoredDelivery.update({ where: { id: r.id }, data: { state: 'failed' } });
        }
      });
      return 0;
    }
    const now = this.clock.now();
    await this.db.platform(async (tx) => {
      const updated = await tx.sponsoredDelivery.updateMany({
        where: { id: { in: ready.map((r) => r.id) }, state: 'pending' },
        data: { state: 'sent', sentAt: now, attempts: { increment: 1 }, failedReason: null },
      });
      await tx.sponsoredCampaign.update({
        where: { id: c.id },
        data: { delivered: { increment: updated.count } },
      });
    });
    return ready.length;
  }

  /** `sent` + the purchase platform invoice of the delivered recipients (none when nothing was delivered or free). */
  private async complete(tx: Tx, c: SponsoredCampaign): Promise<void> {
    const now = this.clock.now();
    const price = c.pricePerRecipient ? c.pricePerRecipient.toString() : '0';
    const charges =
      c.delivered > 0 && new Decimal(price).gt(0)
        ? sponsoredCharges(
            `ส่งห้องแนะนำแบบโฆษณาผ่าน LINE getproperty — ${c.name} (${c.delivered} ผู้รับ)`,
            c.delivered,
            price,
            c.vatRate?.toString() ?? '0',
          )
        : null;
    const invoice =
      charges && new Decimal(charges.total).gt(0)
        ? await this.billing.issue(tx, null, {
            tenantId: c.tenantId,
            kind: 'purchase',
            periodStart: bangkokDate(c.sendingStartedAt ?? now),
            periodEnd: bangkokDate(now),
            charges,
            snapshot: {
              product: SPONSORED_PRODUCT,
              campaignId: c.id,
              delivered: c.delivered,
              pricePerRecipient: price,
              plan: { versionId: c.pricePlanVersionId, vatRate: c.vatRate?.toString() ?? null },
              decision: 'D-300',
            },
          })
        : null;
    await tx.sponsoredCampaign.update({
      where: { id: c.id },
      data: {
        state: 'sent',
        completedAt: now,
        platformInvoiceId: invoice?.id ?? null,
        version: { increment: 1 },
      },
    });
    await this.audit.record(tx, {
      action: 'sponsored_campaign.sent',
      tenantId: c.tenantId,
      subjectType: SUBJECT,
      subjectId: c.id,
      after: { delivered: c.delivered, invoice: invoice?.number ?? null, total: charges?.total ?? '0.00' },
    });
    await this.events.record(tx, {
      type: 'sponsored_campaign.sent',
      aggregateType: 'sponsored_campaign',
      aggregateId: c.id,
      tenantId: c.tenantId,
      payload: { campaignId: c.id, delivered: c.delivered, platformInvoiceId: invoice?.id ?? null },
    });
  }

  /** Delivery rows older than `broadcast.sponsored.delivery_keep_months` are deleted (aggregates stay). */
  private async purgeDeliveries(): Promise<number> {
    const now = this.clock.now();
    const months = await this.settings.valueAt<number>('broadcast.sponsored.delivery_keep_months', now);
    const before = new Date(now.getTime() - months * 30 * 86_400_000);
    return this.db.platform(async (tx) => {
      const r = await tx.sponsoredDelivery.deleteMany({
        where: { createdAt: { lt: before }, state: { not: 'pending' } },
      });
      return r.count;
    });
  }
}

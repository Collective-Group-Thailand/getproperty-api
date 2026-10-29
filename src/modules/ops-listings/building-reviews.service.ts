import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventEnvelope } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { ConsentService } from '@core/privacy/consent.service';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type BuildingReview, type BuildingReviewState, type Prisma } from '@generated/prisma/client';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  cleanText,
  type Eligibility,
  personalDataIn,
  type RatingSummary,
  reviewEligibility,
  summarise,
} from './review-rules';

export const REVIEW_PURPOSE = 'review.publish';
const SUBJECT = 'ops.building_review';
/** Lease parties who lived there (not a guarantor). */
const LIVED_ROLES = ['lessee', 'co_tenant', 'occupant'];
const LANGUAGES = ['th', 'en', 'my', 'km', 'lo', 'zh'] as const;
/** What the owner sees: the public reviews and the ones the platform hid (with the reason). */
const OWNER_VISIBLE: BuildingReviewState[] = ['published', 'hidden'];

export interface ReviewInput {
  rating: number;
  body: string;
  language?: string | null;
  /** The `review.publish` version the resident read and accepted (never assumed, D-025). */
  consentVersion: number;
}

export interface ConsentText {
  key: string;
  version: number;
  title: string;
  bodyMarkdown: string;
}

export interface ResidentReviewView {
  eligibility: Eligibility;
  review: BuildingReview | null;
  consent: ConsentText | null;
}

export const REVIEW_INCLUDE = {
  building: { select: { id: true, name: true } },
} as const satisfies Prisma.BuildingReviewInclude;
export type ReviewRow = Prisma.BuildingReviewGetPayload<{ include: typeof REVIEW_INCLUDE }>;

/**
 * Verified building reviews (G9, E13, D-301). A party who lived under a lease (lessee, co-tenant, occupant — never a
 * guarantor) reviews the lease's building once, **after move-out or after `review.min_tenure_months`** of tenure,
 * with the explicit consent `review.publish` (Collective is the controller of the public review). Text with contact /
 * account / ID data is refused. Reviews wait for a platform moderator while `review.moderation.premoderate` is on
 * (O-035); the owner replies publicly and may report a review to the moderators, **never hide or delete it** (no
 * delete path; the database refuses DELETE). The reviewer may withdraw (the text is erased). Publicly a review shows
 * rating, text, tenure months and "verified tenant" — never the name, unit or exact dates.
 */
@Injectable()
export class BuildingReviewsService implements EventSubscriber, OnModuleInit {
  readonly name = 'building-reviews';
  readonly eventTypes = ['consent.changed'] as const;

  constructor(
    private readonly db: TenantTx,
    private readonly residents: ResidentLeasesService,
    private readonly consents: ConsentService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * `consent.changed` (G review #1, D-301 (1), D-025): a withdrawal of `review.publish` — from the consent screen or
   * any other channel — withdraws every review the person submitted under an earlier grant (text erased), like their
   * own withdrawal. A review submitted after the withdrawal carries its own, newer grant and stays.
   */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const p = event.payload;
    if (p.purposeKey !== REVIEW_PURPOSE || p.subjectType !== 'user' || p.granted !== false) return;
    const consent = await tx.consent.findUnique({
      where: { id: event.aggregateId },
      select: { capturedAt: true },
    });
    if (!consent) return;
    const rows = await tx.buildingReview.findMany({
      where: {
        authorUserId: String(p.subjectId),
        state: { not: 'withdrawn' },
        submittedAt: { lte: consent.capturedAt },
      },
    });
    for (const row of rows) await this.withdrawIn(tx, row, 'consent');
  }

  private userId(): string {
    const id = userIdOf(RequestContext.actor());
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  private async rules() {
    const now = this.clock.now();
    return {
      minTenureMonths: await this.settings.valueAt<number>('review.min_tenure_months', now),
      windowAfterEndDays: await this.settings.valueAt<number>('review.window_after_end_days', now),
    };
  }

  private async consentText(tx: Tx, language: string): Promise<ConsentText | null> {
    const versions = await tx.consentPurposeVersion.findMany({
      where: { purpose: { key: REVIEW_PURPOSE }, effectiveFrom: { lte: this.clock.now() } },
      orderBy: { version: 'desc' },
    });
    const top = versions[0]?.version;
    const current =
      versions.find((v) => v.version === top && v.language === language) ??
      versions.find((v) => v.version === top && v.language === 'th');
    return current
      ? {
          key: REVIEW_PURPOSE,
          version: current.version,
          title: current.title,
          bodyMarkdown: current.bodyMarkdown,
        }
      : null;
  }

  // ------------------------------------------------------------------------------------------- resident

  /** The resident's view of one of their leases: eligibility, their review and the consent text to accept. */
  async residentView(leaseId: string, language: string): Promise<ResidentReviewView> {
    const { lease, partyIds } = await this.residents.access(leaseId);
    const lived = lease.parties.some((p) => partyIds.includes(p.partyId) && LIVED_ROLES.includes(p.role));
    const today = bangkokDate(this.clock.now());
    const eligibility: Eligibility = lived
      ? reviewEligibility(lease, today, await this.rules())
      : { eligible: false, reason: 'not_started', eligibleFrom: null, tenure: null };
    return this.db.platform(async (tx) => ({
      eligibility,
      review: await tx.buildingReview.findUnique({ where: { leaseId } }),
      consent: await this.consentText(tx, language),
    }));
  }

  /** Submits the one review of a lease (Idempotency-Key on the route). */
  async submit(leaseId: string, input: ReviewInput): Promise<BuildingReview> {
    const userId = this.userId();
    const { lease, partyIds } = await this.residents.access(leaseId);
    const author = lease.parties.find((p) => partyIds.includes(p.partyId) && LIVED_ROLES.includes(p.role));
    const now = this.clock.now();
    const eligibility: Eligibility = author
      ? reviewEligibility(lease, bangkokDate(now), await this.rules())
      : { eligible: false, reason: 'not_started', eligibleFrom: null, tenure: null };
    if (!eligibility.eligible)
      throw new DomainException('review.not_eligible', {
        params: {
          months: (await this.rules()).minTenureMonths,
          eligibleFrom: eligibility.eligibleFrom ?? '—',
        },
        extensions: { reviewEligibleFrom: eligibility.eligibleFrom },
      });
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
      throw invalid('rating', 'range', 'a whole number from 1 to 5');
    const body = cleanText(input.body);
    if (!body || body.length < 10) throw invalid('body', 'minLength', 'at least 10 characters');
    if (body.length > 2000) throw invalid('body', 'maxLength', 'at most 2000 characters');
    const found = personalDataIn(body);
    if (found.length)
      throw new DomainException('review.personal_data', {
        errors: found.map((k) => ({ path: 'body', code: k, message: `contains ${k.replace('_', ' ')}` })),
      });
    const language = (LANGUAGES as readonly string[]).includes(input.language ?? '') ? input.language! : 'th';
    const premoderate = await this.settings.valueAt<boolean>('review.moderation.premoderate', now);
    return this.db.platform(async (tx) => {
      const existing = await tx.buildingReview.findUnique({ where: { leaseId } });
      if (existing) throw new DomainException('review.already_submitted');
      const current = await this.consents.currentVersion(tx, REVIEW_PURPOSE);
      if (current === null || input.consentVersion !== current)
        throw new DomainException('review.consent_required');
      const consent = await this.consents.recordIn(
        tx,
        { type: 'user', id: userId },
        { purposeKey: REVIEW_PURPOSE, version: current, granted: true },
        { channel: 'liff', language: language === 'en' ? 'en' : 'th', tenantId: null },
      );
      const tenure = eligibility.tenure;
      const row = await tx.buildingReview.create({
        data: {
          tenantId: lease.tenantId,
          buildingId: lease.buildingId,
          unitId: lease.unitId,
          leaseId,
          authorPartyId: author!.partyId,
          authorUserId: userId,
          consentId: consent.id,
          rating: input.rating,
          body,
          language,
          tenureFrom: new Date(tenure.from),
          tenureTo: tenure.to ? new Date(tenure.to) : null,
          state: premoderate ? 'pending_moderation' : 'published',
          submittedAt: now,
          publishedAt: premoderate ? null : now,
          createdBy: userId,
        },
      });
      await this.audit.record(tx, {
        action: 'building_review.submitted',
        tenantId: row.tenantId,
        buildingId: row.buildingId,
        subjectType: SUBJECT,
        subjectId: row.id,
        // never the text or the author in the audit metadata — the row is the record
        metadata: { leaseId, rating: row.rating, state: row.state },
      });
      await this.emit(tx, row, 'building_review.submitted');
      if (row.state === 'published') await this.emit(tx, row, 'building_review.published');
      return row;
    });
  }

  /**
   * The reviewer withdraws their review: the text is erased at once; the row stays (one per lease). Authorised by the
   * review's author alone (G review #1, D-301 (5)): the author keeps this right after the owner unlinked their login
   * from the lease party or the lease left their token — anyone else gets 404.
   */
  async withdraw(leaseId: string): Promise<BuildingReview> {
    const userId = this.userId();
    return this.db.platform(async (tx) => {
      const row = await tx.buildingReview.findUnique({ where: { leaseId } });
      if (!row || row.authorUserId !== userId) throw new DomainException('http.not_found');
      if (row.state === 'withdrawn') return row;
      return this.withdrawIn(tx, row, 'author');
    });
  }

  private async withdrawIn(
    tx: Tx,
    row: BuildingReview,
    by: 'author' | 'consent' | 'dsr',
  ): Promise<BuildingReview> {
    const updated = await tx.buildingReview.update({
      where: { id: row.id },
      data: {
        state: 'withdrawn',
        body: null,
        withdrawnAt: this.clock.now(),
        version: { increment: 1 },
        updatedBy: userIdOf(RequestContext.actor()),
      },
    });
    await this.audit.record(tx, {
      action: 'building_review.withdrawn',
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: { by, previousState: row.state },
    });
    await this.emit(tx, updated, 'building_review.withdrawn');
    return updated;
  }

  // ------------------------------------------------------------------------------------------- owner

  async ownerList(
    ctx: TenantContext,
    filter: { buildingId?: string; state?: BuildingReviewState; skip: number; take: number },
  ): Promise<{ rows: ReviewRow[]; total: number }> {
    const where: Prisma.BuildingReviewWhereInput = {
      tenantId: ctx.tenantId,
      state: filter.state && OWNER_VISIBLE.includes(filter.state) ? filter.state : { in: OWNER_VISIBLE },
      ...(filter.buildingId
        ? { buildingId: filter.buildingId }
        : ctx.buildingIds
          ? { buildingId: { in: [...ctx.buildingIds] } }
          : {}),
    };
    if (filter.buildingId && ctx.buildingIds && !ctx.buildingIds.includes(filter.buildingId))
      return { rows: [], total: 0 };
    return this.db.tenant(ctx, async (tx) => ({
      rows: await tx.buildingReview.findMany({
        where,
        include: REVIEW_INCLUDE,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.buildingReview.count({ where }),
    }));
  }

  private async ownReview(tx: Tx, ctx: TenantContext, id: string): Promise<ReviewRow> {
    const row = await tx.buildingReview.findFirst({
      where: { id, tenantId: ctx.tenantId, state: { in: OWNER_VISIBLE } },
      include: REVIEW_INCLUDE,
    });
    if (!row || (ctx.buildingIds && !ctx.buildingIds.includes(row.buildingId)))
      throw new DomainException('http.not_found');
    return row;
  }

  async ownerGet(ctx: TenantContext, id: string): Promise<ReviewRow> {
    return this.db.tenant(ctx, (tx) => this.ownReview(tx, ctx, id));
  }

  /** The owner's public reply (right of reply): one per review, may be edited; screened like the review. */
  async reply(ctx: TenantContext, id: string, text: string): Promise<ReviewRow> {
    const reply = cleanText(text);
    if (!reply) throw invalid('reply', 'minLength', 'must not be empty');
    if (reply.length > 1000) throw invalid('reply', 'maxLength', 'at most 1000 characters');
    const found = personalDataIn(reply);
    if (found.length)
      throw new DomainException('review.personal_data', {
        errors: found.map((k) => ({ path: 'reply', code: k, message: `contains ${k.replace('_', ' ')}` })),
      });
    return this.db.tenant(ctx, async (tx) => {
      const row = await this.ownReview(tx, ctx, id);
      if (row.state !== 'published') throw new DomainException('review.invalid_state');
      const userId = userIdOf(RequestContext.actor());
      await tx.buildingReview.update({
        where: { id },
        data: {
          ownerReply: reply,
          ownerRepliedAt: this.clock.now(),
          ownerRepliedBy: userId,
          version: { increment: 1 },
          updatedBy: userId,
        },
      });
      await this.audit.record(tx, {
        action: 'building_review.replied',
        tenantId: row.tenantId,
        buildingId: row.buildingId,
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { edited: row.ownerReply !== null },
      });
      const updated = await this.ownReview(tx, ctx, id);
      await this.emit(tx, updated, 'building_review.replied');
      return updated;
    });
  }

  /** The owner reports a review to the platform moderators — it stays public until a moderator decides. */
  async report(ctx: TenantContext, id: string, reason: string): Promise<ReviewRow> {
    const why = cleanText(reason);
    if (!why) throw invalid('reason', 'minLength', 'must not be empty');
    if (why.length > 1000) throw invalid('reason', 'maxLength', 'at most 1000 characters');
    return this.db.tenant(ctx, async (tx) => {
      const row = await this.ownReview(tx, ctx, id);
      if (row.state !== 'published') throw new DomainException('review.invalid_state');
      await tx.buildingReview.update({
        where: { id },
        data: {
          reportedAt: this.clock.now(),
          reportReason: why,
          version: { increment: 1 },
          updatedBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.audit.record(tx, {
        action: 'building_review.reported',
        tenantId: row.tenantId,
        buildingId: row.buildingId,
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { reason: why },
      });
      const updated = await this.ownReview(tx, ctx, id);
      await this.emit(tx, updated, 'building_review.reported');
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------- platform moderation

  async adminList(filter: {
    state?: BuildingReviewState;
    reported?: boolean;
    skip: number;
    take: number;
  }): Promise<{ rows: ReviewRow[]; total: number }> {
    const where: Prisma.BuildingReviewWhereInput = {
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.reported === true ? { reportedAt: { not: null } } : {}),
      ...(filter.reported === false ? { reportedAt: null } : {}),
    };
    return this.db.platform(async (tx) => ({
      rows: await tx.buildingReview.findMany({
        where,
        include: REVIEW_INCLUDE,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      total: await tx.buildingReview.count({ where }),
    }));
  }

  async adminGet(id: string): Promise<ReviewRow> {
    const row = await this.db.platform((tx) =>
      tx.buildingReview.findUnique({ where: { id }, include: REVIEW_INCLUDE }),
    );
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  /** approve: pending → published · reject: pending → rejected · hide: published → hidden · restore: hidden → published. */
  async moderate(
    id: string,
    action: 'approve' | 'reject' | 'hide' | 'restore',
    reason?: string | null,
  ): Promise<ReviewRow> {
    const from: Record<typeof action, BuildingReviewState> = {
      approve: 'pending_moderation',
      reject: 'pending_moderation',
      hide: 'published',
      restore: 'hidden',
    };
    const to: Record<typeof action, BuildingReviewState> = {
      approve: 'published',
      reject: 'rejected',
      hide: 'hidden',
      restore: 'published',
    };
    const why = cleanText(reason);
    if ((action === 'reject' || action === 'hide') && !why)
      throw invalid('reason', 'required', 'a reason is required');
    if (why && why.length > 1000) throw invalid('reason', 'maxLength', 'at most 1000 characters');
    return this.db.platform(async (tx) => {
      const row = await tx.buildingReview.findUnique({ where: { id } });
      if (!row) throw new DomainException('http.not_found');
      if (row.state !== from[action]) throw new DomainException('review.invalid_state');
      const now = this.clock.now();
      const userId = userIdOf(RequestContext.actor());
      const updated = await tx.buildingReview.update({
        where: { id },
        data: {
          state: to[action],
          moderatedAt: now,
          moderatedBy: userId,
          moderationReason: action === 'restore' || action === 'approve' ? null : why,
          ...(action === 'approve' ? { publishedAt: now } : {}),
          // a decision on a reported review closes the report
          ...(action === 'hide' || action === 'restore' ? { reportedAt: null, reportReason: null } : {}),
          version: { increment: 1 },
          updatedBy: userId,
        },
      });
      const type = {
        approve: 'building_review.published',
        reject: 'building_review.rejected',
        hide: 'building_review.hidden',
        restore: 'building_review.restored',
      } as const;
      await this.audit.record(tx, {
        action: type[action],
        tenantId: row.tenantId,
        buildingId: row.buildingId,
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { from: row.state, to: updated.state, ...(why ? { reason: why } : {}) },
      });
      await this.emit(tx, updated, type[action]);
      return tx.buildingReview.findUniqueOrThrow({ where: { id }, include: REVIEW_INCLUDE });
    });
  }

  /** Keeps a published review public and closes the owner's report (the moderator found nothing wrong). */
  async dismissReport(id: string): Promise<ReviewRow> {
    return this.db.platform(async (tx) => {
      const row = await tx.buildingReview.findUnique({ where: { id } });
      if (!row) throw new DomainException('http.not_found');
      if (!row.reportedAt) throw new DomainException('review.invalid_state');
      await tx.buildingReview.update({
        where: { id },
        data: {
          reportedAt: null,
          reportReason: null,
          moderatedAt: this.clock.now(),
          moderatedBy: userIdOf(RequestContext.actor()),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'building_review.report_dismissed',
        tenantId: row.tenantId,
        buildingId: row.buildingId,
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { reason: row.reportReason },
      });
      return tx.buildingReview.findUniqueOrThrow({ where: { id }, include: REVIEW_INCLUDE });
    });
  }

  // ------------------------------------------------------------------------------------------- public

  /** Published reviews of the building of a public listing, newest first, with the rating summary. */
  async forListing(
    slug: string,
    page: { skip: number; take: number },
  ): Promise<{ summary: RatingSummary; rows: BuildingReview[]; total: number }> {
    return this.db.platform(async (tx) => {
      const listing = await tx.listing.findFirst({
        where: { slug, state: 'published', hiddenAt: null },
        select: { buildingId: true },
      });
      if (!listing) throw new DomainException('http.not_found');
      // defence in depth (G review #1): a review whose author withdrew `review.publish` is never served, even before
      // the `consent.changed` subscriber withdrew it
      const authors = await tx.buildingReview.findMany({
        where: { buildingId: listing.buildingId, state: 'published', authorUserId: { not: null } },
        distinct: ['authorUserId'],
        select: { authorUserId: true },
      });
      const withdrawn = authors.length
        ? (
            await tx.$queryRaw<{ subject_id: string }[]>`
              SELECT subject_id::text FROM platform.v_consent_state
               WHERE subject_type = 'user' AND purpose_key = ${REVIEW_PURPOSE} AND NOT granted
                 AND subject_id = ANY(${authors.map((a) => a.authorUserId!)}::uuid[])`
          ).map((r) => r.subject_id)
        : [];
      const where: Prisma.BuildingReviewWhereInput = {
        buildingId: listing.buildingId,
        state: 'published',
        ...(withdrawn.length ? { OR: [{ authorUserId: null }, { authorUserId: { notIn: withdrawn } }] } : {}),
      };
      const ratings = await tx.buildingReview.findMany({ where, select: { rating: true } });
      return {
        summary: summarise(ratings.map((r) => r.rating)),
        rows: await tx.buildingReview.findMany({
          where,
          orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        total: ratings.length,
      };
    });
  }

  // ------------------------------------------------------------------------------------------- DSR

  /** The person's reviews for a DSR export (D-025). */
  async exportFor(tx: Tx, userId: string) {
    const rows = await tx.buildingReview.findMany({
      where: { authorUserId: userId },
      include: REVIEW_INCLUDE,
      orderBy: { submittedAt: 'asc' },
    });
    return rows.map((r) => ({
      building: r.building.name,
      rating: r.rating,
      text: r.body,
      state: r.state,
      tenureFrom: r.tenureFrom,
      tenureTo: r.tenureTo,
      submittedAt: r.submittedAt,
      ownerReply: r.ownerReply,
    }));
  }

  /** DSR erasure: every review of the person is withdrawn (text erased); the rows stay one per lease. */
  async eraseFor(tx: Tx, userId: string): Promise<number> {
    const rows = await tx.buildingReview.findMany({
      where: { authorUserId: userId, state: { not: 'withdrawn' } },
    });
    for (const row of rows) await this.withdrawIn(tx, row, 'dsr');
    return rows.length;
  }

  private async emit(tx: Tx, row: BuildingReview, type: DomainEventType): Promise<void> {
    await this.events.record(tx, {
      type,
      aggregateType: 'building_review',
      aggregateId: row.id,
      tenantId: row.tenantId,
      payload: {
        reviewId: row.id,
        buildingId: row.buildingId,
        leaseId: row.leaseId,
        rating: row.rating,
        state: row.state,
      },
    });
  }
}

function invalid(path: string, code: string, message: string): DomainException {
  return new DomainException('validation.failed', { errors: [{ path, code, message }] });
}

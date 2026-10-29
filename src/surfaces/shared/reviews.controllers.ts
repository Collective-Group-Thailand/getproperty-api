import { CurrentTenant, Public, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page, PageQuery } from '@common/pagination/pagination.dto';
import { type BuildingReview } from '@generated/prisma/client';
import { BuildingReviewsService, type ReviewRow } from '@modules/ops-listings/building-reviews.service';
import { tenureMonths } from '@modules/ops-listings/review-rules';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { ModerationReasonDto } from '../admin/admin-listings.controller';
import { ApiSurface, SURFACES } from '../surfaces';
import { dateOnly, iso, isoOrNull } from './mappers';
import {
  AdminReviewDto,
  AdminReviewListQuery,
  type BuildingReviewStateName,
  MyReviewDto,
  OwnerReviewDto,
  OwnerReviewListQuery,
  PublicReviewDto,
  PublicReviewsDto,
  ResidentReviewDto,
  type ReviewIneligibleReasonName,
  ReviewReplyDto,
  ReviewSubmitDto,
} from './reviews.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const W = [...T, 'tenant.read_only'] as const;
const lang = (header: string | undefined): string => {
  const l = header?.toLowerCase().slice(0, 2);
  return l && ['th', 'en', 'my', 'km', 'lo', 'zh'].includes(l) ? l : 'th';
};

const tenure = (r: Pick<BuildingReview, 'tenureFrom' | 'tenureTo'>) =>
  tenureMonths({ from: dateOnly(r.tenureFrom)!, to: dateOnly(r.tenureTo) });

export function myReviewDto(r: BuildingReview): MyReviewDto {
  return {
    id: r.id,
    state: r.state as BuildingReviewStateName,
    rating: r.rating,
    body: r.body,
    language: r.language,
    tenure: tenure(r),
    submittedAt: iso(r.submittedAt),
    publishedAt: isoOrNull(r.publishedAt),
    moderationReason: r.state === 'rejected' ? r.moderationReason : null,
    ownerReply: r.ownerReply,
    ownerRepliedAt: isoOrNull(r.ownerRepliedAt),
  };
}

export function publicReviewDto(r: BuildingReview): PublicReviewDto {
  return {
    id: r.id,
    rating: r.rating,
    body: r.body ?? '',
    language: r.language,
    tenure: tenure(r),
    verifiedTenant: true,
    publishedAt: iso(r.publishedAt!),
    ownerReply: r.ownerReply,
    ownerRepliedAt: isoOrNull(r.ownerRepliedAt),
  };
}

export function ownerReviewDto(r: ReviewRow): OwnerReviewDto {
  return {
    id: r.id,
    buildingId: r.buildingId,
    buildingName: r.building.name,
    state: r.state as BuildingReviewStateName,
    rating: r.rating,
    body: r.body,
    language: r.language,
    tenure: tenure(r),
    publishedAt: isoOrNull(r.publishedAt),
    moderationReason: r.moderationReason,
    ownerReply: r.ownerReply,
    ownerRepliedAt: isoOrNull(r.ownerRepliedAt),
    reportedAt: isoOrNull(r.reportedAt),
    reportReason: r.reportReason,
  };
}

const adminReviewDto = (r: ReviewRow): AdminReviewDto => ({
  ...ownerReviewDto(r),
  tenantId: r.tenantId,
  submittedAt: iso(r.submittedAt),
  moderatedAt: isoOrNull(r.moderatedAt),
});

const TENURE = { from: '2025-01', to: '2026-03' };
const MY_EXAMPLE: MyReviewDto = {
  id: FAKE.uuid,
  state: 'pending_moderation' as BuildingReviewStateName,
  rating: 4,
  body: 'ตึกสะอาด ลิฟต์เร็ว นิติฯ ตอบไว แต่ที่จอดรถน้อย',
  language: 'th',
  tenure: TENURE,
  submittedAt: FAKE.dateTime,
  publishedAt: null,
  moderationReason: null,
  ownerReply: null,
  ownerRepliedAt: null,
};
const RESIDENT_EXAMPLE: ResidentReviewDto = {
  eligibility: { eligible: true, reason: null, eligibleFrom: null, tenure: TENURE },
  review: null,
  consent: {
    purposeKey: 'review.publish',
    version: 1,
    title: 'เผยแพร่รีวิวอาคารของฉัน',
    bodyMarkdown: 'ร่าง ⚖ — เลือกได้ ไม่มีผลต่อการเช่าหรือบริการอื่น …',
  },
};
const PUBLIC_EXAMPLE: PublicReviewDto = {
  id: FAKE.uuid,
  rating: 4,
  body: 'ตึกสะอาด ลิฟต์เร็ว นิติฯ ตอบไว แต่ที่จอดรถน้อย',
  language: 'th',
  tenure: TENURE,
  verifiedTenant: true,
  publishedAt: FAKE.dateTime,
  ownerReply: 'ขอบคุณสำหรับรีวิวครับ เดือนหน้าเราจะเพิ่มที่จอดรถอีก 10 คัน',
  ownerRepliedAt: FAKE.dateTime,
};
const OWNER_EXAMPLE: OwnerReviewDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  buildingName: 'ไอดีโอ โมบิ อารีย์',
  state: 'published' as BuildingReviewStateName,
  rating: 4,
  body: PUBLIC_EXAMPLE.body,
  language: 'th',
  tenure: TENURE,
  publishedAt: FAKE.dateTime,
  moderationReason: null,
  ownerReply: null,
  ownerRepliedAt: null,
  reportedAt: null,
  reportReason: null,
};
const ADMIN_EXAMPLE: AdminReviewDto = {
  ...OWNER_EXAMPLE,
  state: 'pending_moderation' as BuildingReviewStateName,
  publishedAt: null,
  tenantId: FAKE.tenantId,
  submittedAt: FAKE.dateTime,
  moderatedAt: null,
};
const LEASE_PARAM = { name: 'leaseId', format: 'uuid', example: FAKE.uuid };
const REVIEW_PARAM = { name: 'reviewId', format: 'uuid', example: FAKE.uuid };

// ------------------------------------------------------------------------------------------- resident

/**
 * Verified building review of one of my leases (G9, D-301): after I moved out, or after `review.min_tenure_months` of
 * living there; one per lease; consent `review.publish`; my name, unit and exact dates are never shown.
 */
@ApiTags('resident.reviews')
@ApiSurface(SURFACES.resident)
@Controller('resident/leases')
export class ResidentReviewsController {
  constructor(private readonly reviews: BuildingReviewsService) {}

  @Get(':leaseId/review')
  @ApiParam(LEASE_PARAM)
  @ApiEndpoint({
    id: 'resident.reviews.get',
    summary: 'Can I review this building?',
    description:
      'Whether I may review the building of this lease now (verified tenure: moved out within `review.window_after_end_days`, or `review.min_tenure_months` of living there — `eligibleFrom` says when), my review if I wrote one, and the `review.publish` consent text to accept with it. Not my lease: 404 (D-301).',
    implements: ['D-301', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Eligibility and my review',
    type: ResidentReviewDto,
    example: RESIDENT_EXAMPLE,
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Req() req: Request,
  ): Promise<ResidentReviewDto> {
    const v = await this.reviews.residentView(leaseId, lang(req.headers['accept-language']));
    return {
      eligibility: {
        eligible: v.eligibility.eligible,
        reason: v.eligibility.eligible ? null : (v.eligibility.reason as ReviewIneligibleReasonName),
        eligibleFrom: v.eligibility.eligible ? null : v.eligibility.eligibleFrom,
        tenure: v.eligibility.tenure ? tenureMonths(v.eligibility.tenure) : null,
      },
      review: v.review ? myReviewDto(v.review) : null,
      consent: v.consent
        ? {
            purposeKey: v.consent.key,
            version: v.consent.version,
            title: v.consent.title,
            bodyMarkdown: v.consent.bodyMarkdown,
          }
        : null,
    };
  }

  @Post(':leaseId/review')
  @Idempotent()
  @ApiParam(LEASE_PARAM)
  @ApiEndpoint({
    id: 'resident.reviews.submit',
    summary: 'Review the building of my lease',
    description:
      'One review per lease (`review.already_submitted`), only with verified tenure (`review.not_eligible` + `reviewEligibleFrom`), with my explicit consent to the current `review.publish` version (`review.consent_required`). Text with phone numbers, e-mail, LINE ids, links, bank accounts or ID numbers is refused (`review.personal_data`). It waits for the platform moderators while `review.moderation.premoderate` is on (O-035). Not my lease: 404 (D-301).',
    implements: ['D-301', 'D-025'],
  })
  @ApiJsonBody(ReviewSubmitDto, {
    rating: 4,
    body: 'ตึกสะอาด ลิฟต์เร็ว นิติฯ ตอบไว แต่ที่จอดรถน้อย',
    language: 'th',
    consentVersion: 1,
  })
  @ApiSuccess(201, { description: 'Submitted', type: MyReviewDto, example: MY_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'idempotency.key_required',
    'review.not_eligible',
    'review.consent_required',
    'review.already_submitted',
    'review.personal_data',
  )
  async submit(
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Body() body: ReviewSubmitDto,
  ): Promise<MyReviewDto> {
    return myReviewDto(await this.reviews.submit(leaseId, body));
  }

  @Post(':leaseId/review/actions/withdraw')
  @HttpCode(200)
  @ApiParam(LEASE_PARAM)
  @ApiEndpoint({
    id: 'resident.reviews.withdraw',
    summary: 'Withdraw my review',
    description:
      'Takes my review down for good: its text is erased at once and it leaves the building’s rating (the lease cannot be reviewed again). Repeating it answers the same. No review of mine: 404 (D-301, D-025).',
    implements: ['D-301', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Withdrawn',
    type: MyReviewDto,
    example: { ...MY_EXAMPLE, state: 'withdrawn' as BuildingReviewStateName, body: null },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async withdraw(@Param('leaseId', ParseUUIDPipe) leaseId: string): Promise<MyReviewDto> {
    return myReviewDto(await this.reviews.withdraw(leaseId));
  }
}

// ------------------------------------------------------------------------------------------- public

/** Published verified reviews of the building of a public listing (G9, D-301). */
@ApiTags('public.listings')
@ApiSurface(SURFACES.public)
@Controller('public/listings')
export class PublicListingReviewsController {
  constructor(private readonly reviews: BuildingReviewsService) {}

  @Get(':slug/reviews')
  @Public()
  @ApiParam({ name: 'slug', example: 'condo-1br-0f3a9c2b1d' })
  @ApiEndpoint({
    id: 'public.listings.reviews',
    summary: 'Verified reviews of the building',
    description:
      'Published reviews of the listing’s building by people who lived there under a lease on getproperty (label "verified tenant"), newest first, with the owner’s reply and the rating summary. Tenure as months only — never the reviewer’s name, unit or exact dates. Unknown or unpublished listing: 404 (D-301).',
    implements: ['D-301', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Reviews',
    type: PublicReviewsDto,
    example: {
      summary: { count: 1, average: '4.0', distribution: [0, 0, 0, 1, 0] },
      data: [PUBLIC_EXAMPLE],
      meta: { page: 1, perPage: 25, total: 1 },
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async list(@Param('slug') slug: string, @Query() q: PageQuery): Promise<PublicReviewsDto> {
    const r = await this.reviews.forListing(slug, toSkipTake(q));
    const page = paginated(r.rows.map(publicReviewDto), r.total, q);
    return {
      summary: { ...r.summary, distribution: [...r.summary.distribution] },
      data: page.data,
      meta: page.meta,
    };
  }
}

// ------------------------------------------------------------------------------------------- owner

/**
 * Reviews of this tenant's buildings (G9, D-301): read, reply publicly (right of reply) and report abuse to the
 * platform moderators. **There is no way to hide or delete a review** — only the moderators decide.
 */
@ApiTags('owner.reviews')
@ApiSurface(SURFACES.owner)
@Controller('owner/reviews')
export class OwnerReviewsController {
  constructor(private readonly reviews: BuildingReviewsService) {}

  @Get()
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.reviews.list',
    summary: 'Reviews of my buildings',
    description:
      'Published and hidden reviews of leases of this tenant, newest first (no reviewer identity). Filter by building and state (D-301).',
    implements: ['D-301'],
  })
  @ApiPaginated(OwnerReviewDto, { example: OWNER_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: OwnerReviewListQuery,
  ): Promise<Page<OwnerReviewDto>> {
    const { rows, total } = await this.reviews.ownerList(ctx, {
      buildingId: q.buildingId,
      state: q.state,
      ...toSkipTake(q),
    });
    return paginated(rows.map(ownerReviewDto), total, q);
  }

  @Get(':reviewId')
  @TenantScoped()
  @Can('listing.read')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'owner.reviews.get',
    summary: 'A review of my building',
    description: 'One published or hidden review of this tenant’s leases; another tenant’s: 404 (D-301).',
    implements: ['D-301'],
  })
  @ApiSuccess(200, { description: 'Review', type: OwnerReviewDto, example: OWNER_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('reviewId', ParseUUIDPipe) id: string,
  ): Promise<OwnerReviewDto> {
    return ownerReviewDto(await this.reviews.ownerGet(ctx, id));
  }

  @Put(':reviewId/reply')
  @TenantScoped()
  @Can('listing.manage')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'owner.reviews.reply',
    summary: 'Reply publicly to a review',
    description:
      'Sets or edits this tenant’s one public reply under a published review (right of reply); no contact or account data (`review.personal_data`). Not published: `review.invalid_state`; another tenant’s: 404 (D-301).',
    implements: ['D-301'],
  })
  @ApiJsonBody(ReviewReplyDto, { reply: 'ขอบคุณสำหรับรีวิวครับ เดือนหน้าเราจะเพิ่มที่จอดรถอีก 10 คัน' })
  @ApiSuccess(200, {
    description: 'Replied',
    type: OwnerReviewDto,
    example: { ...OWNER_EXAMPLE, ownerReply: PUBLIC_EXAMPLE.ownerReply, ownerRepliedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'review.invalid_state',
    'review.personal_data',
    ...W,
  )
  async reply(
    @CurrentTenant() ctx: TenantContext,
    @Param('reviewId', ParseUUIDPipe) id: string,
    @Body() body: ReviewReplyDto,
  ): Promise<OwnerReviewDto> {
    return ownerReviewDto(await this.reviews.reply(ctx, id, body.reply));
  }

  @Post(':reviewId/actions/report')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'owner.reviews.report',
    summary: 'Report a review to the moderators',
    description:
      'Asks the platform moderators to look at a published review (abuse, false facts, personal data). The review stays public until a moderator hides it — the owner can never hide or delete a review. Another tenant’s: 404 (D-301, O-035).',
    implements: ['D-301'],
  })
  @ApiJsonBody(ModerationReasonDto, { reason: 'รีวิวกล่าวหาว่าตึกไม่มีใบอนุญาต ซึ่งไม่เป็นความจริง' })
  @ApiSuccess(200, {
    description: 'Reported',
    type: OwnerReviewDto,
    example: {
      ...OWNER_EXAMPLE,
      reportedAt: FAKE.dateTime,
      reportReason: 'ข้อความกล่าวหาที่ไม่เป็นความจริง',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'review.invalid_state', ...W)
  async report(
    @CurrentTenant() ctx: TenantContext,
    @Param('reviewId', ParseUUIDPipe) id: string,
    @Body() body: ModerationReasonDto,
  ): Promise<OwnerReviewDto> {
    return ownerReviewDto(await this.reviews.report(ctx, id, body.reason));
  }
}

// ------------------------------------------------------------------------------------------- admin

const ERR = ['validation.failed', 'http.bad_request', 'http.not_found'] as const;

/** Moderation of verified building reviews by the platform team (G9, D-301, O-035). */
@ApiTags('admin.reviews')
@ApiSurface(SURFACES.admin)
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly reviews: BuildingReviewsService) {}

  @Get()
  @Can('admin.listing.moderate')
  @ApiEndpoint({
    id: 'admin.reviews.list',
    summary: 'Reviews to moderate',
    description:
      'Every building review, oldest first; `state=pending_moderation` is the queue, `reported=true` the owner reports (D-301).',
    implements: ['D-301'],
  })
  @ApiPaginated(AdminReviewDto, { example: ADMIN_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: AdminReviewListQuery): Promise<Page<AdminReviewDto>> {
    const { rows, total } = await this.reviews.adminList({
      state: q.state,
      reported: q.reported,
      ...toSkipTake(q),
    });
    return paginated(rows.map(adminReviewDto), total, q);
  }

  @Get(':reviewId')
  @Can('admin.listing.moderate')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'admin.reviews.get',
    summary: 'A building review',
    description: 'One review with its moderation state (D-301).',
    implements: ['D-301'],
  })
  @ApiSuccess(200, { description: 'Review', type: AdminReviewDto, example: ADMIN_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('reviewId', ParseUUIDPipe) id: string): Promise<AdminReviewDto> {
    return adminReviewDto(await this.reviews.adminGet(id));
  }

  @Post(':reviewId/actions/approve')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.moderate')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'admin.reviews.approve',
    summary: 'Publish a review',
    description:
      'A review waiting for moderation becomes public. Other states: `review.invalid_state` (D-301).',
    implements: ['D-301'],
  })
  @ApiSuccess(200, {
    description: 'Published',
    type: AdminReviewDto,
    example: { ...ADMIN_EXAMPLE, state: 'published' as BuildingReviewStateName, publishedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(...ERR, 'idempotency.key_required', 'review.invalid_state')
  async approve(@Param('reviewId', ParseUUIDPipe) id: string): Promise<AdminReviewDto> {
    return adminReviewDto(await this.reviews.moderate(id, 'approve'));
  }

  @Post(':reviewId/actions/reject')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.moderate')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'admin.reviews.reject',
    summary: 'Reject a review',
    description:
      'A review waiting for moderation is not published; the reviewer reads the reason. Other states: `review.invalid_state` (D-301, O-035).',
    implements: ['D-301'],
  })
  @ApiJsonBody(ModerationReasonDto, { reason: 'มีถ้อยคำหยาบคายและกล่าวหาบุคคล' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: AdminReviewDto,
    example: {
      ...ADMIN_EXAMPLE,
      state: 'rejected' as BuildingReviewStateName,
      moderationReason: 'ถ้อยคำหยาบคาย',
    },
  })
  @ApiStandardErrors(...ERR, 'idempotency.key_required', 'review.invalid_state')
  async reject(
    @Param('reviewId', ParseUUIDPipe) id: string,
    @Body() body: ModerationReasonDto,
  ): Promise<AdminReviewDto> {
    return adminReviewDto(await this.reviews.moderate(id, 'reject', body.reason));
  }

  @Post(':reviewId/actions/hide')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.moderate')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'admin.reviews.hide',
    summary: 'Hide a published review',
    description:
      'Takes a published review off the public pages for abuse (reason kept and shown to the owner); closes an open owner report. Not published: `review.invalid_state` (D-301, O-035).',
    implements: ['D-301'],
  })
  @ApiJsonBody(ModerationReasonDto, { reason: 'เปิดเผยข้อมูลส่วนบุคคลของผู้อื่น' })
  @ApiSuccess(200, {
    description: 'Hidden',
    type: AdminReviewDto,
    example: { ...ADMIN_EXAMPLE, state: 'hidden' as BuildingReviewStateName, publishedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(...ERR, 'idempotency.key_required', 'review.invalid_state')
  async hide(
    @Param('reviewId', ParseUUIDPipe) id: string,
    @Body() body: ModerationReasonDto,
  ): Promise<AdminReviewDto> {
    return adminReviewDto(await this.reviews.moderate(id, 'hide', body.reason));
  }

  @Post(':reviewId/actions/restore')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.moderate')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'admin.reviews.restore',
    summary: 'Restore a hidden review',
    description: 'A hidden review is public again. Not hidden: `review.invalid_state` (D-301).',
    implements: ['D-301'],
  })
  @ApiSuccess(200, {
    description: 'Restored',
    type: AdminReviewDto,
    example: { ...ADMIN_EXAMPLE, state: 'published' as BuildingReviewStateName, publishedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(...ERR, 'idempotency.key_required', 'review.invalid_state')
  async restore(@Param('reviewId', ParseUUIDPipe) id: string): Promise<AdminReviewDto> {
    return adminReviewDto(await this.reviews.moderate(id, 'restore'));
  }

  @Post(':reviewId/actions/dismiss-report')
  @HttpCode(200)
  @Can('admin.listing.moderate')
  @ApiParam(REVIEW_PARAM)
  @ApiEndpoint({
    id: 'admin.reviews.dismissReport',
    summary: 'Dismiss an owner report',
    description:
      'The moderator found nothing wrong: the review stays public and the owner’s report is closed. No open report: `review.invalid_state` (D-301).',
    implements: ['D-301'],
  })
  @ApiSuccess(200, {
    description: 'Report dismissed',
    type: AdminReviewDto,
    example: { ...ADMIN_EXAMPLE, state: 'published' as BuildingReviewStateName, publishedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(...ERR, 'review.invalid_state')
  async dismissReport(@Param('reviewId', ParseUUIDPipe) id: string): Promise<AdminReviewDto> {
    return adminReviewDto(await this.reviews.dismissReport(id));
  }
}

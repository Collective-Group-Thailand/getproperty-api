import { Can } from '@common/auth/can.decorator';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { type Listing } from '@generated/prisma/client';
import { ListingModerationService } from '@modules/ops-listings/listing-moderation.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, MaxLength } from 'class-validator';

import {
  type ListingReviewReasonName,
  ListingStateName,
  ListingVerificationStateName,
  OwnershipEvidenceName,
} from '../owner/listings.dto';
import { ListingReportReasonName } from '../public/listings.controller';
import { MoneyOutput } from '../shared/fields';
import { ApiSurface, SURFACES } from '../surfaces';

export enum ModerationQueueName {
  PendingReview = 'pending_review',
  Hidden = 'hidden',
  Reported = 'reported',
}

export class ModerationReasonDto {
  @ApiProperty({
    example: 'ขอให้โอนเงินก่อนดูห้อง ซึ่งขัดกับกฎของแพลตฟอร์ม',
    description: 'Shown to the owner.',
    minLength: 3,
    maxLength: 1000,
  })
  @IsString()
  @Length(3, 1000)
  reason!: string;
}

export class VerificationDecisionDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Required when rejecting: the owner reads it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

export class AdminListingReportDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ListingReportReasonName, enumName: 'ListingReportReason' })
  reason!: ListingReportReasonName;

  @ApiProperty({ type: String, nullable: true })
  details!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class AdminListingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'มาลี มีสุข' })
  tenantName!: string;

  @ApiProperty({ example: 'condo-1br-0a1b2c3d4e' })
  slug!: string;

  @ApiProperty({ enum: ListingStateName, enumName: 'ListingState' })
  state!: ListingStateName;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  titleTh!: string;

  @ApiProperty()
  descriptionTh!: string;

  @MoneyOutput({ example: '15000.00', description: 'Monthly rent.' })
  rent!: string;

  @ApiProperty({ type: String, nullable: true })
  district!: string | null;

  @ApiProperty({ type: String, nullable: true })
  province!: string | null;

  @ApiProperty({
    enum: ['first_listing', 'price_outlier', 'flagged_words'],
    enumName: 'ListingReviewReason',
    isArray: true,
  })
  reviewReasons!: ListingReviewReasonName[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  hiddenAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  hiddenReason!: string | null;

  @ApiProperty({ type: [AdminListingReportDto], description: 'Open reports (no reporter identity).' })
  reports!: AdminListingReportDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class AdminVerificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty()
  tenantName!: string;

  @ApiProperty({ format: 'uuid' })
  unitId!: string;

  @ApiProperty({ example: '12/345' })
  unitNo!: string;

  @ApiProperty({ example: 'ไอดีโอ โมบิ อารีย์' })
  buildingName!: string;

  @ApiProperty({ enum: ListingVerificationStateName, enumName: 'ListingVerificationState' })
  state!: ListingVerificationStateName;

  @ApiProperty({ enum: OwnershipEvidenceName, enumName: 'OwnershipEvidence' })
  evidenceKind!: OwnershipEvidenceName;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The first approver (maker-checker).',
  })
  reviewedBy!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  decisionNote!: string | null;
}

export class AdminEvidenceLinkDto {
  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty({ description: 'Signed for 5 minutes; every download is audited.' })
  url!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;
}

export class AdminVerificationDetailDto extends AdminVerificationDto {
  @ApiProperty({ type: [AdminEvidenceLinkDto], description: 'Empty after the evidence retention (O-018).' })
  evidence!: AdminEvidenceLinkDto[];
}

type QueueRow = Listing & {
  tenant: { id: string; displayName: string };
  reports: { id: string; reason: string; details: string | null; createdAt: Date }[];
};

function listingDto(
  l: QueueRow | (Listing & { tenant?: { id: string; displayName: string }; reports?: QueueRow['reports'] }),
): AdminListingDto {
  return {
    id: l.id,
    tenantId: l.tenantId,
    tenantName: l.tenant?.displayName ?? '',
    slug: l.slug,
    state: l.state as ListingStateName,
    titleTh: l.titleTh,
    descriptionTh: l.descriptionTh,
    rent: l.rent.toFixed(2),
    district: l.district,
    province: l.province,
    reviewReasons: l.reviewReasons as ListingReviewReasonName[],
    hiddenAt: l.hiddenAt?.toISOString() ?? null,
    hiddenReason: l.hiddenReason,
    reports: (l.reports ?? []).map((r) => ({
      id: r.id,
      reason: r.reason as ListingReportReasonName,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    })),
    updatedAt: l.updatedAt.toISOString(),
  };
}

type VerificationRow = Awaited<ReturnType<ListingModerationService['verifications']>>[number];
function verificationDto(v: VerificationRow): AdminVerificationDto {
  return {
    id: v.id,
    tenantId: v.tenantId,
    tenantName: v.tenant.displayName,
    unitId: v.unitId,
    unitNo: v.unit.unitNo,
    buildingName: v.unit.building.name,
    state: v.state as ListingVerificationStateName,
    evidenceKind: v.evidenceKind as OwnershipEvidenceName,
    note: v.note,
    reviewedBy: v.reviewedBy,
    submittedAt: v.submittedAt.toISOString(),
    decidedAt: v.decidedAt?.toISOString() ?? null,
    decisionNote: v.decisionNote,
  };
}

const LISTING_EXAMPLE = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  tenantName: 'มาลี มีสุข',
  slug: 'condo-1br-0a1b2c3d4e',
  state: 'pending_review',
  titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
  descriptionTh: 'ห้องมุม แสงดี',
  rent: '15000.00',
  district: 'พญาไท',
  province: 'กรุงเทพมหานคร',
  reviewReasons: ['first_listing'],
  hiddenAt: null,
  hiddenReason: null,
  reports: [],
  updatedAt: FAKE.dateTime,
};
const VERIFICATION_EXAMPLE = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  tenantName: 'มาลี มีสุข',
  unitId: FAKE.uuid,
  unitNo: '12/345',
  buildingName: 'ไอดีโอ โมบิ อารีย์',
  state: 'pending',
  evidenceKind: 'condo_title',
  note: null,
  reviewedBy: null,
  submittedAt: FAKE.dateTime,
  decidedAt: null,
  decisionNote: null,
};
const ERR = ['validation.failed', 'http.bad_request', 'http.not_found'] as const;

/** Listing moderation and owner verification for platform Support (B7.2, D-252). */
@ApiTags('admin.listings')
@ApiSurface(SURFACES.admin)
@Controller('admin')
export class AdminListingsController {
  constructor(private readonly moderation: ListingModerationService) {}

  @Get('listings/queue')
  @Can('admin.listing.moderate')
  @ApiEndpoint({
    id: 'admin.listings.queue',
    summary: 'Moderation queue',
    description: 'Listings waiting for review, hidden, or with open reports — oldest first (D-252).',
    implements: ['D-252'],
  })
  @ApiQuery({ name: 'kind', required: false, enum: ModerationQueueName, enumName: 'ModerationQueue' })
  @ApiSuccess(200, { description: 'Queue', type: [AdminListingDto], example: [LISTING_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async queue(@Query('kind') kind?: ModerationQueueName): Promise<AdminListingDto[]> {
    return (await this.moderation.queue(kind)).map((l) => listingDto(l as QueueRow));
  }

  @Post('listings/:listingId/actions/approve')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.moderate')
  @ApiEndpoint({
    id: 'admin.listings.approve',
    summary: 'Approve a listing',
    description: 'Publishes a listing waiting for review (D-252). Evented `listing.published`.',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'Published',
    type: AdminListingDto,
    example: { ...LISTING_EXAMPLE, state: 'published', reviewReasons: [] },
  })
  @ApiStandardErrors(...ERR, 'listing.invalid_state')
  async approve(@Param('listingId', ParseUUIDPipe) id: string): Promise<AdminListingDto> {
    return listingDto(await this.moderation.approve(id));
  }

  @Post('listings/:listingId/actions/reject')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.moderate')
  @ApiEndpoint({
    id: 'admin.listings.reject',
    summary: 'Reject a listing',
    description:
      'Takes the listing off review or the public pages with a reason the owner reads; open reports are upheld (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(ModerationReasonDto, { reason: 'ขอให้โอนเงินก่อนดูห้อง' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: AdminListingDto,
    example: { ...LISTING_EXAMPLE, state: 'rejected' },
  })
  @ApiStandardErrors(...ERR, 'listing.invalid_state')
  async reject(
    @Param('listingId', ParseUUIDPipe) id: string,
    @Body() body: ModerationReasonDto,
  ): Promise<AdminListingDto> {
    return listingDto(await this.moderation.reject(id, body.reason.trim()));
  }

  @Post('listings/:listingId/actions/hide')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.moderate')
  @ApiEndpoint({
    id: 'admin.listings.hide',
    summary: 'Hide a listing',
    description: 'Removes a published listing from the public pages pending a decision (D-252).',
    implements: ['D-252'],
  })
  @ApiJsonBody(ModerationReasonDto, { reason: 'กำลังตรวจสอบรายงานจากผู้ชม' })
  @ApiSuccess(200, {
    description: 'Hidden',
    type: AdminListingDto,
    example: { ...LISTING_EXAMPLE, state: 'published', hiddenAt: FAKE.dateTime },
  })
  @ApiStandardErrors(...ERR, 'listing.invalid_state')
  async hide(
    @Param('listingId', ParseUUIDPipe) id: string,
    @Body() body: ModerationReasonDto,
  ): Promise<AdminListingDto> {
    return listingDto(await this.moderation.hide(id, body.reason.trim()));
  }

  @Post('listings/:listingId/actions/restore')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.moderate')
  @ApiEndpoint({
    id: 'admin.listings.restore',
    summary: 'Restore a listing',
    description: 'Makes a hidden listing public again; open reports are dismissed (D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'Restored',
    type: AdminListingDto,
    example: { ...LISTING_EXAMPLE, state: 'published' },
  })
  @ApiStandardErrors(...ERR, 'listing.invalid_state')
  async restore(@Param('listingId', ParseUUIDPipe) id: string): Promise<AdminListingDto> {
    return listingDto(await this.moderation.restore(id));
  }

  @Get('listing-verifications')
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.listingVerifications.list',
    summary: 'Owner verifications',
    description: 'Verification requests, oldest first, by state (D-252).',
    implements: ['D-252'],
  })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: ListingVerificationStateName,
    enumName: 'ListingVerificationState',
  })
  @ApiSuccess(200, { description: 'Requests', type: [AdminVerificationDto], example: [VERIFICATION_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async verifications(@Query('state') state?: ListingVerificationStateName): Promise<AdminVerificationDto[]> {
    return (await this.moderation.verifications(state)).map(verificationDto);
  }

  @Get('listing-verifications/:verificationId')
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.listingVerifications.get',
    summary: 'One owner verification',
    description:
      'The request with short-lived links to its evidence; every link is an audited download (D-252, D-025).',
    implements: ['D-252', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Request',
    type: AdminVerificationDetailDto,
    example: { ...VERIFICATION_EXAMPLE, evidence: [] },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async verification(
    @Param('verificationId', ParseUUIDPipe) id: string,
  ): Promise<AdminVerificationDetailDto> {
    const v = await this.moderation.verification(id);
    return {
      ...verificationDto(v),
      evidence: v.evidence.map((e) => ({ ...e, expiresAt: e.expiresAt.toISOString() })),
    };
  }

  @Post('listing-verifications/:verificationId/actions/decide')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.listing.verify')
  @ApiEndpoint({
    id: 'admin.listingVerifications.decide',
    summary: 'Decide an owner verification',
    description:
      'Approve (the badge appears on every listing of the unit) or reject with a note. With `listing.verification.maker_checker` the first approval waits for a second platform user (`listing.checker_same_user` for the same one). Evidence is deleted after `listing.verification.evidence_retention_days` (D-252, O-018).',
    implements: ['D-252'],
  })
  @ApiJsonBody(VerificationDecisionDto, { approve: true })
  @ApiSuccess(200, {
    description: 'Decided (or waiting for the checker)',
    type: AdminVerificationDto,
    example: { ...VERIFICATION_EXAMPLE, state: 'approved', decidedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(...ERR, 'listing.verification_invalid_state', 'listing.checker_same_user')
  async decide(
    @Param('verificationId', ParseUUIDPipe) id: string,
    @Body() body: VerificationDecisionDto,
  ): Promise<AdminVerificationDto> {
    await this.moderation.decideVerification(id, body);
    return verificationDto(await this.moderation.verificationRow(id));
  }
}

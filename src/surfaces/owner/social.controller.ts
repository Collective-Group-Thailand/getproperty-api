import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { type SocialChannel } from '@generated/prisma/client';
import {
  ListingSocialService,
  postUrl,
  type SocialPostView,
} from '@modules/ops-listings/listing-social.service';
import { SocialChannelsService } from '@modules/ops-listings/social-channels.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;

export enum SocialProviderName {
  FacebookPage = 'facebook_page',
}
export enum SocialChannelStateName {
  Verified = 'verified',
  Failing = 'failing',
  Revoked = 'revoked',
}
export enum SocialPostStateName {
  Queued = 'queued',
  Posted = 'posted',
  Failed = 'failed',
  Deleted = 'deleted',
}
export enum SocialPostActionName {
  Publish = 'publish',
  Update = 'update',
  Delete = 'delete',
}

export class SocialChannelConnectDto {
  @ApiProperty({ example: '102345678901234', description: 'The numeric id of the Facebook Page.' })
  @Matches(/^\d{5,30}$/)
  pageId!: string;

  @ApiProperty({
    example: 'EAAG-page-access-token',
    description:
      'A Page access token with `pages_manage_posts` (from the Meta app of O-029). Checked with Facebook, stored encrypted with the tenant key (D-148), never shown again.',
  })
  @IsString()
  @Length(10, 1024)
  pageAccessToken!: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Post published listings automatically (default true).',
  })
  @IsOptional()
  @IsBoolean()
  autoPost?: boolean;
}

export class SocialChannelDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: SocialProviderName, enumName: 'SocialProvider', example: 'facebook_page' })
  provider!: SocialProviderName;

  @ApiProperty({ example: '102345678901234' })
  pageId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'บ้านดี พร็อพเพอร์ตี้' })
  pageName!: string | null;

  @ApiProperty({ enum: SocialChannelStateName, enumName: 'SocialChannelState', example: 'verified' })
  state!: SocialChannelStateName;

  @ApiProperty({ example: true })
  autoPost!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastCheckedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Why Facebook refused (no token).',
  })
  lastError!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class SocialPostDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  channelId!: string;

  @ApiProperty({ example: '102345678901234' })
  pageId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'บ้านดี พร็อพเพอร์ตี้' })
  pageName!: string | null;

  @ApiProperty({ enum: SocialPostStateName, enumName: 'SocialPostState', example: 'posted' })
  state!: SocialPostStateName;

  @ApiProperty({
    enum: SocialPostActionName,
    enumName: 'SocialPostAction',
    nullable: true,
    example: null,
    description: 'While `queued`: what getproperty is about to do on the Page.',
  })
  pendingAction!: SocialPostActionName | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://www.facebook.com/102345678901234/posts/1001',
  })
  postUrl!: string | null;

  @ApiProperty({ type: 'integer', example: 0 })
  attempts!: number;

  @ApiProperty({ type: String, nullable: true, example: null })
  lastError!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  postedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedOnPageAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletedAt!: string | null;
}

const CHANNEL_EXAMPLE: SocialChannelDto = {
  id: FAKE.uuid,
  provider: SocialProviderName.FacebookPage,
  pageId: '102345678901234',
  pageName: 'บ้านดี พร็อพเพอร์ตี้',
  state: SocialChannelStateName.Verified,
  autoPost: true,
  verifiedAt: '2026-11-01T10:00:00+07:00',
  lastCheckedAt: '2026-11-01T10:00:00+07:00',
  lastError: null,
  createdAt: '2026-11-01T10:00:00+07:00',
};

const POST_EXAMPLE: SocialPostDto = {
  id: FAKE.uuid,
  channelId: FAKE.uuid,
  pageId: '102345678901234',
  pageName: 'บ้านดี พร็อพเพอร์ตี้',
  state: SocialPostStateName.Posted,
  pendingAction: null,
  postUrl: 'https://www.facebook.com/102345678901234/posts/1001',
  attempts: 0,
  lastError: null,
  postedAt: '2026-11-01T10:01:00+07:00',
  updatedOnPageAt: null,
  deletedAt: null,
};

const channelDto = (c: SocialChannel): SocialChannelDto => ({
  id: c.id,
  provider: c.provider as SocialProviderName,
  pageId: c.pageId,
  pageName: c.pageName,
  state: c.state as SocialChannelStateName,
  autoPost: c.autoPost,
  verifiedAt: isoOrNull(c.verifiedAt),
  lastCheckedAt: isoOrNull(c.lastCheckedAt),
  lastError: c.lastError,
  createdAt: iso(c.createdAt),
});

const postDto = (p: SocialPostView): SocialPostDto => ({
  id: p.id,
  channelId: p.channelId,
  pageId: p.channel.pageId,
  pageName: p.channel.pageName,
  state: p.state as SocialPostStateName,
  pendingAction: (p.pendingAction as SocialPostActionName | null) ?? null,
  postUrl: p.state === 'deleted' ? null : postUrl(p.externalPostId),
  attempts: p.attempts,
  lastError: p.lastError,
  postedAt: isoOrNull(p.postedAt),
  updatedOnPageAt: isoOrNull(p.updatedOnPageAt),
  deletedAt: isoOrNull(p.deletedAt),
});

/** G4 (D-288): the tenant's own Facebook Page — connect, check, disconnect. Groups are never automated. */
@ApiTags('owner.social')
@ApiSurface(SURFACES.owner)
@Controller('owner/social-channels')
export class OwnerSocialChannelsController {
  constructor(private readonly channels: SocialChannelsService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.settings.read')
  @ApiEndpoint({
    id: 'owner.socialChannels.list',
    summary: 'My Facebook Page',
    description:
      'The Facebook Page connected for automatic listing posts (G4, D-288): page, state, auto-post switch, last check. Never the token.',
    implements: ['D-288', 'D-296'],
  })
  @ApiSuccess(200, { description: 'Pages', type: [SocialChannelDto], example: [CHANNEL_EXAMPLE] })
  @ApiStandardErrors(...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<SocialChannelDto[]> {
    return (await this.channels.list(ctx)).map(channelDto);
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('tenant.settings.update')
  @ApiEndpoint({
    id: 'owner.socialChannels.connect',
    summary: 'Connect my Facebook Page',
    description:
      'Connects the tenant’s own Facebook Page with a Page access token (G4, D-288): checked with Facebook first — a refused token stores nothing (`facebook.page_refused`) — then sealed with the tenant key (D-148 / D-240) and never shown again; replaces the Page connected before. Published listings are then posted there automatically, edited when the rent changes and deleted when the unit is let or the listing stops being public. Facebook groups are never automated (the share kit stays for them). `facebook.unavailable` while the Meta app is not approved (O-029).',
    implements: ['D-288', 'D-148', 'D-296'],
  })
  @ApiJsonBody(SocialChannelConnectDto, {
    pageId: '102345678901234',
    pageAccessToken: 'EAAG-page-access-token',
    autoPost: true,
  })
  @ApiSuccess(201, { description: 'Connected', type: SocialChannelDto, example: CHANNEL_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'facebook.page_refused',
    'facebook.unavailable',
    ...T,
  )
  async connect(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: SocialChannelConnectDto,
  ): Promise<SocialChannelDto> {
    return channelDto(await this.channels.connect(ctx, body));
  }

  @Post(':channelId/actions/verify')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.settings.update')
  @ApiEndpoint({
    id: 'owner.socialChannels.verify',
    summary: 'Check my Facebook Page again',
    description:
      'Asks Facebook for the Page with its token: `verified`, or `failing` with the reason (nothing is posted while failing). Another tenant’s Page: 404 (D-288).',
    implements: ['D-288'],
  })
  @ApiSuccess(200, { description: 'Checked', type: SocialChannelDto, example: CHANNEL_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'facebook.unavailable', ...T)
  async verify(
    @CurrentTenant() ctx: TenantContext,
    @Param('channelId', ParseUUIDPipe) id: string,
  ): Promise<SocialChannelDto> {
    return channelDto(await this.channels.verify(ctx, id));
  }

  @Post(':channelId/actions/revoke')
  @HttpCode(204)
  @TenantScoped()
  @Can('tenant.settings.update')
  @ApiEndpoint({
    id: 'owner.socialChannels.revoke',
    summary: 'Disconnect my Facebook Page',
    description:
      'Nothing more is posted on the Page; waiting posts are dropped; posts already there stay for the owner to manage on Facebook. Another tenant’s Page: 404 (D-288).',
    implements: ['D-288'],
  })
  @ApiSuccess(204, { description: 'Disconnected' })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('channelId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.channels.revoke(ctx, id);
  }
}

/** G4 (D-288): what getproperty posted for a listing on the tenant's Page. */
@ApiTags('owner.social')
@ApiSurface(SURFACES.owner)
@Controller('owner/listings/:listingId/social-posts')
export class OwnerListingSocialPostsController {
  constructor(private readonly posts: ListingSocialService) {}

  @Get()
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.listingSocialPosts.list',
    summary: 'Facebook Page posts of a listing',
    description:
      'One entry per connected Page: queued (with what is about to happen), posted (link to the post), failed (why) or deleted (D-288). Another tenant’s listing: 404.',
    implements: ['D-288', 'D-296'],
  })
  @ApiSuccess(200, { description: 'Posts', type: [SocialPostDto], example: [POST_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) listingId: string,
  ): Promise<SocialPostDto[]> {
    return (await this.posts.list(ctx, listingId)).map(postDto);
  }

  @Post(':postId/actions/retry')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.listingSocialPosts.retry',
    summary: 'Try a failed Page post again',
    description:
      'Queues what the listing needs now on its Page (publish, edit or delete) for a failed post on a verified Page; `social.post_invalid_state` otherwise. Another tenant’s post: 404 (D-288).',
    implements: ['D-288'],
  })
  @ApiSuccess(200, {
    description: 'Queued',
    type: SocialPostDto,
    example: {
      ...POST_EXAMPLE,
      state: SocialPostStateName.Queued,
      pendingAction: SocialPostActionName.Publish,
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'social.post_invalid_state', ...T)
  async retry(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) listingId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
  ): Promise<SocialPostDto> {
    return postDto(await this.posts.retry(ctx, listingId, postId));
  }
}

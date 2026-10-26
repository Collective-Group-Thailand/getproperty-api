import { Can } from '@common/auth/can.decorator';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import {
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { type GuideInput, type GuidePatch, GuidesService } from '@modules/platform-content/guides.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ifMatchVersion } from '../owner/assets.mappers';
import {
  ADMIN_GUIDE_EXAMPLE,
  AdminGuideDto,
  adminGuideDto,
  GUIDE_DETAIL_EXAMPLE,
  GuideCreateDto,
  GuideListQuery,
  GuideStateName,
  GuideUpdateDto,
} from '../shared/guides.dto';
import { ApiSurface, SURFACES } from '../surfaces';

function currentUser(): string {
  const user = userIdOf(RequestContext.actor());
  if (!user) throw new DomainException('auth.unauthenticated');
  return user;
}

function toPatch(body: GuideUpdateDto): GuidePatch {
  const { reviewed, published, ...rest } = body;
  return {
    ...rest,
    ...(reviewed !== undefined ? { reviewedOn: reviewed } : {}),
    ...(published !== undefined ? { publishedOn: published } : {}),
  };
}

/** Guides of the public site (D-271): written by the platform team, published by a second platform user. */
@ApiTags('admin.guides')
@ApiSurface(SURFACES.admin)
@Controller('admin/guides')
export class AdminGuidesController {
  constructor(private readonly guides: GuidesService) {}

  @Get()
  @Can('admin.guide.manage')
  @ApiEndpoint({
    id: 'admin.guides.list',
    summary: 'Guides',
    description: 'Every guide in both languages, draft or published (D-271).',
    implements: ['D-271'],
  })
  @ApiSuccess(200, { description: 'Guides', type: [AdminGuideDto], example: [ADMIN_GUIDE_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: GuideListQuery): Promise<AdminGuideDto[]> {
    return (await this.guides.list({ locale: query.locale, state: query.state })).map(adminGuideDto);
  }

  @Get(':guideId')
  @Can('admin.guide.manage')
  @UseEtag((g: AdminGuideDto) => etagOf(g.id, g.version))
  @ApiEndpoint({
    id: 'admin.guides.get',
    summary: 'One guide',
    description: 'A guide with its body (D-271).',
    implements: ['D-271'],
  })
  @ApiSuccess(200, { description: 'Guide', type: AdminGuideDto, example: ADMIN_GUIDE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('guideId', ParseUUIDPipe) id: string): Promise<AdminGuideDto> {
    return adminGuideDto(await this.guides.get(id));
  }

  @Post()
  @Can('admin.guide.manage')
  @ApiEndpoint({
    id: 'admin.guides.create',
    summary: 'Write a guide',
    description:
      'A new guide as a draft (one per slug and language, `guide.slug_taken`). The body must be the shared article shape — sections of p / ul / ol / note / affiliate blocks, FAQ, https sources (D-271, D-277).',
    implements: ['D-271'],
  })
  @ApiJsonBody(GuideCreateDto, GUIDE_DETAIL_EXAMPLE)
  @ApiSuccess(201, {
    description: 'Draft',
    type: AdminGuideDto,
    example: {
      ...ADMIN_GUIDE_EXAMPLE,
      state: GuideStateName.Draft,
      reviewedBy: null,
      publishedAt: null,
      version: 1,
    },
  })
  @ApiStandardErrors('http.malformed_json', 'validation.failed', 'guide.slug_taken')
  async create(@Body() body: GuideCreateDto): Promise<AdminGuideDto> {
    const { reviewed, published, ...rest } = body;
    const input: GuideInput = {
      ...rest,
      locale: rest.locale,
      reviewedOn: reviewed,
      publishedOn: published,
    };
    return adminGuideDto(await this.guides.create(currentUser(), input));
  }

  @Patch(':guideId')
  @Can('admin.guide.manage')
  @UseEtag((g: AdminGuideDto) => etagOf(g.id, g.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'admin.guides.update',
    summary: 'Edit a guide',
    description:
      'Changes any field but slug and language; requires `If-Match`. A published guide shows the change at once (D-271).',
    implements: ['D-271'],
  })
  @ApiJsonBody(GuideUpdateDto, { reviewed: '2026-11-01' })
  @ApiSuccess(200, { description: 'Updated', type: AdminGuideDto, example: ADMIN_GUIDE_EXAMPLE })
  @ApiStandardErrors('http.malformed_json', 'http.not_found', 'validation.failed')
  async update(
    @Param('guideId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: GuideUpdateDto,
  ): Promise<AdminGuideDto> {
    const version = ifMatchVersion(ifMatch, await this.guides.get(id));
    return adminGuideDto(await this.guides.update(currentUser(), id, version, toPatch(body)));
  }

  @Post(':guideId/actions/publish')
  @HttpCode(200)
  @Can('admin.guide.manage')
  @ApiEndpoint({
    id: 'admin.guides.publish',
    summary: 'Review and publish',
    description:
      'A platform user other than the last editor (`guide.same_reviewer`) publishes the guide and is recorded as its reviewer; it is public at once (D-271, D-091).',
    implements: ['D-271', 'D-091'],
  })
  @ApiSuccess(200, { description: 'Published', type: AdminGuideDto, example: ADMIN_GUIDE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'guide.same_reviewer')
  async publish(@Param('guideId', ParseUUIDPipe) id: string): Promise<AdminGuideDto> {
    return adminGuideDto(await this.guides.publish(currentUser(), id));
  }

  @Post(':guideId/actions/unpublish')
  @HttpCode(200)
  @Can('admin.guide.manage')
  @ApiEndpoint({
    id: 'admin.guides.unpublish',
    summary: 'Take off the site',
    description: 'Back to draft; the public page is gone at once (D-271).',
    implements: ['D-271'],
  })
  @ApiSuccess(200, {
    description: 'Draft',
    type: AdminGuideDto,
    example: { ...ADMIN_GUIDE_EXAMPLE, state: GuideStateName.Draft, publishedAt: null },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async unpublish(@Param('guideId', ParseUUIDPipe) id: string): Promise<AdminGuideDto> {
    return adminGuideDto(await this.guides.unpublish(currentUser(), id));
  }
}

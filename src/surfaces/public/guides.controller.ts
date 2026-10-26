import { Public } from '@common/auth/auth.decorators';
import { DomainException } from '@common/errors/domain.exception';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { GuidesService } from '@modules/platform-content/guides.service';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiParam, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { LanguageName } from '../shared/common.dto';
import {
  GUIDE_DETAIL_EXAMPLE,
  GUIDE_SUMMARY_EXAMPLE,
  GuideDetailDto,
  guideDetailDto,
  guideSummaryDto,
  PublicGuidesDto,
} from '../shared/guides.dto';
import { ApiSurface, SURFACES } from '../surfaces';

export class GuideLocaleQuery {
  @ApiPropertyOptional({
    enum: LanguageName,
    enumName: 'Language',
    example: LanguageName.Th,
    description: 'Default th.',
  })
  @IsOptional()
  @IsEnum(LanguageName)
  locale?: LanguageName;
}

/** Guides of the public site (D-271): published ones only. */
@ApiTags('public.guides')
@ApiSurface(SURFACES.public)
@Controller('public/guides')
export class PublicGuidesController {
  constructor(private readonly guides: GuidesService) {}

  @Get()
  @Public()
  @ApiEndpoint({
    id: 'public.guides.list',
    summary: 'Guides',
    description: 'Published guides of one language, newest first (D-271).',
    implements: ['D-271'],
  })
  @ApiSuccess(200, {
    description: 'Guides',
    type: PublicGuidesDto,
    example: { data: [GUIDE_SUMMARY_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: GuideLocaleQuery): Promise<PublicGuidesDto> {
    return { data: (await this.guides.published(query.locale ?? 'th')).map(guideSummaryDto) };
  }

  @Get(':slug')
  @Public()
  @ApiParam({ name: 'slug', example: 'rental-income-tax' })
  @ApiEndpoint({
    id: 'public.guides.get',
    summary: 'One guide',
    description:
      'A published guide in one language with its sections, FAQ and sources (D-271); unpublished or unknown = 404.',
    implements: ['D-271'],
  })
  @ApiSuccess(200, { description: 'Guide', type: GuideDetailDto, example: GUIDE_DETAIL_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('slug') slug: string, @Query() query: GuideLocaleQuery): Promise<GuideDetailDto> {
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new DomainException('http.not_found');
    return guideDetailDto(await this.guides.publishedBySlug(slug, query.locale ?? 'th'));
  }
}

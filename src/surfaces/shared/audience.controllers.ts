import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page, PageQuery } from '@common/pagination/pagination.dto';
import { type AudiencePreference } from '@generated/prisma/client';
import {
  AudienceService,
  hhmmOf,
  type RecommendationsView,
} from '@modules/platform-audience/audience.service';
import { Body, Controller, Get, HttpCode, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  type AudiencePreferencesDto,
  type AudienceUnitKindName,
  HISTORY_EXAMPLE,
  RecommendationHistoryItemDto,
  RECOMMENDATIONS_EXAMPLE,
  RecommendationsDto,
  RecommendationsUpdateDto,
} from './audience.dto';
import { currentUserId, dateOnly, iso, isoOrNull } from './mappers';

const LABEL = { th: 'โฆษณา', en: 'Sponsored' } as const;
const lang = (req: Request): 'th' | 'en' =>
  req.headers['accept-language']?.toLowerCase().startsWith('en') ? 'en' : 'th';
/** The person's language for the consent text: their preference header (th / en; others read the English text). */
const language = (req: Request): string => req.headers['accept-language']?.slice(0, 2).toLowerCase() || 'th';

function preferencesDto(p: AudiencePreference | null): AudiencePreferencesDto | null {
  if (!p) return null;
  const start = hhmmOf(p.quietStart);
  const end = hhmmOf(p.quietEnd);
  return {
    areas: p.areaSlugs,
    budgetMin: p.budgetMin ? p.budgetMin.toFixed(2) : null,
    budgetMax: p.budgetMax ? p.budgetMax.toFixed(2) : null,
    unitKinds: p.unitKinds as AudienceUnitKindName[],
    moveInFrom: dateOnly(p.moveInFrom),
    moveInTo: dateOnly(p.moveInTo),
    language: p.language,
    quietHours: start && end ? { start, end } : null,
    updatedAt: iso(p.updatedAt),
  };
}

function recommendationsDto(v: RecommendationsView): RecommendationsDto {
  return {
    consent: {
      purposeKey: v.consent.purposeKey,
      version: v.consent.version,
      language: v.consent.language,
      title: v.consent.title,
      bodyMarkdown: v.consent.bodyMarkdown,
      effectiveFrom: iso(v.consent.effectiveFrom),
      granted: v.consent.granted,
      grantedVersion: v.consent.grantedVersion,
      capturedAt: isoOrNull(v.consent.capturedAt),
    },
    preferences: preferencesDto(v.preferences),
    maxPerWeek: v.maxPerWeek,
    quietHours: v.quietHours,
  };
}

const GET_DESCRIPTION =
  'My separate, optional consent `platform.recommendations` (Collective is the controller): the plain-language purpose with the profiling note in my language, `granted` true only after my explicit grant of the current version (never pre-ticked), my preferences while consented, the weekly cap and default quiet hours (D-300, D-025).';
const PUT_DESCRIPTION =
  'Sets what I want to hear about: areas, budget, unit kinds, move-in window, language and my own quiet hours — nothing else can be stored (no special-category data). `consentVersion` = I tick the box now (must be the current version, else `recommendations.consent_outdated`); without a valid grant: `recommendations.consent_required` (D-300).';
const WITHDRAW_DESCRIPTION =
  'One tap: records the withdrawal (`granted: false`), nothing more is sent from now on (pending messages are cancelled), and my preferences are deleted after `audience.preferences.keep_days_after_withdrawal` (unused meanwhile). Repeating it changes nothing (D-300, D-025).';
const HISTORY_DESCRIPTION =
  'Every sponsored message sent to me, newest first: when, who paid for it and which listings — labelled as an ad. Kept `broadcast.sponsored.delivery_keep_months` (D-300).';
const ERRORS = ['validation.failed', 'http.bad_request', 'auth.unauthenticated'] as const;

/** One controller per audience: a person is the same LINE login as resident and as prospect. */
abstract class RecommendationsBase {
  constructor(protected readonly audience: AudienceService) {}

  protected async read(req: Request): Promise<RecommendationsDto> {
    return recommendationsDto(await this.audience.view(currentUserId(), language(req)));
  }

  protected async write(req: Request, body: RecommendationsUpdateDto): Promise<RecommendationsDto> {
    return recommendationsDto(
      await this.audience.update(currentUserId(), body.consentVersion, body.preferences, language(req)),
    );
  }

  protected async stop(req: Request): Promise<RecommendationsDto> {
    return recommendationsDto(await this.audience.withdraw(currentUserId(), language(req)));
  }

  protected async sent(req: Request, q: PageQuery): Promise<Page<RecommendationHistoryItemDto>> {
    const l = lang(req);
    const { items, total } = await this.audience.history(currentUserId(), toSkipTake(q), l);
    return paginated(
      items.map((i) => ({
        id: i.id,
        sentAt: iso(i.sentAt),
        label: LABEL[l],
        sponsor: i.sponsor,
        listings: i.listings,
      })),
      total,
      q,
    );
  }
}

const PUT_EXAMPLE = {
  consentVersion: 1,
  preferences: {
    areas: ['ari'],
    budgetMin: '8000',
    budgetMax: '15000',
    unitKinds: ['condo_unit'],
    moveInFrom: '2026-12-01',
    moveInTo: '2027-01-31',
    language: 'th',
    quietHours: null,
  },
};

@ApiTags('resident.recommendations')
@ApiSurface(SURFACES.resident)
@Controller('resident/me/recommendations')
export class ResidentRecommendationsController extends RecommendationsBase {
  constructor(audience: AudienceService) {
    super(audience);
  }

  @Get()
  @ApiEndpoint({
    id: 'resident.recommendations.get',
    summary: 'Recommended places: my consent and preferences',
    description: GET_DESCRIPTION,
    implements: ['D-300', 'D-287', 'D-025'],
  })
  @ApiSuccess(200, { description: 'Mine', type: RecommendationsDto, example: RECOMMENDATIONS_EXAMPLE })
  @ApiStandardErrors('auth.unauthenticated')
  get(@Req() req: Request): Promise<RecommendationsDto> {
    return this.read(req);
  }

  @Put()
  @ApiEndpoint({
    id: 'resident.recommendations.update',
    summary: 'Opt in and set what I want to hear about',
    description: PUT_DESCRIPTION,
    implements: ['D-300', 'D-025'],
  })
  @ApiJsonBody(RecommendationsUpdateDto, PUT_EXAMPLE)
  @ApiSuccess(200, { description: 'Saved', type: RecommendationsDto, example: RECOMMENDATIONS_EXAMPLE })
  @ApiStandardErrors(...ERRORS, 'recommendations.consent_required', 'recommendations.consent_outdated')
  update(@Req() req: Request, @Body() body: RecommendationsUpdateDto): Promise<RecommendationsDto> {
    return this.write(req, body);
  }

  @Post('actions/withdraw')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.recommendations.withdraw',
    summary: 'Stop recommended places',
    description: WITHDRAW_DESCRIPTION,
    implements: ['D-300', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Withdrawn',
    type: RecommendationsDto,
    example: {
      ...RECOMMENDATIONS_EXAMPLE,
      consent: { ...RECOMMENDATIONS_EXAMPLE.consent, granted: false, grantedVersion: null },
      preferences: null,
    },
  })
  @ApiStandardErrors('auth.unauthenticated')
  withdraw(@Req() req: Request): Promise<RecommendationsDto> {
    return this.stop(req);
  }

  @Get('history')
  @ApiEndpoint({
    id: 'resident.recommendations.history',
    summary: 'What was sent to me',
    description: HISTORY_DESCRIPTION,
    implements: ['D-300', 'D-025'],
  })
  @ApiPaginated(RecommendationHistoryItemDto, { example: HISTORY_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'auth.unauthenticated')
  history(@Req() req: Request, @Query() q: PageQuery): Promise<Page<RecommendationHistoryItemDto>> {
    return this.sent(req, q);
  }
}

@ApiTags('prospect.recommendations')
@ApiSurface(SURFACES.prospect)
@Controller('prospect/me/recommendations')
export class ProspectRecommendationsController extends RecommendationsBase {
  constructor(audience: AudienceService) {
    super(audience);
  }

  @Get()
  @ApiEndpoint({
    id: 'prospect.recommendations.get',
    summary: 'Recommended places: my consent and preferences',
    description: GET_DESCRIPTION,
    implements: ['D-300', 'D-287', 'D-025'],
  })
  @ApiSuccess(200, { description: 'Mine', type: RecommendationsDto, example: RECOMMENDATIONS_EXAMPLE })
  @ApiStandardErrors('auth.unauthenticated')
  get(@Req() req: Request): Promise<RecommendationsDto> {
    return this.read(req);
  }

  @Put()
  @ApiEndpoint({
    id: 'prospect.recommendations.update',
    summary: 'Opt in and set what I want to hear about',
    description: PUT_DESCRIPTION,
    implements: ['D-300', 'D-025'],
  })
  @ApiJsonBody(RecommendationsUpdateDto, PUT_EXAMPLE)
  @ApiSuccess(200, { description: 'Saved', type: RecommendationsDto, example: RECOMMENDATIONS_EXAMPLE })
  @ApiStandardErrors(...ERRORS, 'recommendations.consent_required', 'recommendations.consent_outdated')
  update(@Req() req: Request, @Body() body: RecommendationsUpdateDto): Promise<RecommendationsDto> {
    return this.write(req, body);
  }

  @Post('actions/withdraw')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'prospect.recommendations.withdraw',
    summary: 'Stop recommended places',
    description: WITHDRAW_DESCRIPTION,
    implements: ['D-300', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Withdrawn',
    type: RecommendationsDto,
    example: {
      ...RECOMMENDATIONS_EXAMPLE,
      consent: { ...RECOMMENDATIONS_EXAMPLE.consent, granted: false, grantedVersion: null },
      preferences: null,
    },
  })
  @ApiStandardErrors('auth.unauthenticated')
  withdraw(@Req() req: Request): Promise<RecommendationsDto> {
    return this.stop(req);
  }

  @Get('history')
  @ApiEndpoint({
    id: 'prospect.recommendations.history',
    summary: 'What was sent to me',
    description: HISTORY_DESCRIPTION,
    implements: ['D-300', 'D-025'],
  })
  @ApiPaginated(RecommendationHistoryItemDto, { example: HISTORY_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'auth.unauthenticated')
  history(@Req() req: Request, @Query() q: PageQuery): Promise<Page<RecommendationHistoryItemDto>> {
    return this.sent(req, q);
  }
}

import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { addCalendarDays } from '@common/time/bangkok';
import { ListingAssistantService } from '@modules/ops-listings/listing-assistant.service';
import { ASSISTANT_DISCLAIMER } from '@modules/ops-listings/listing-assistant-rules';
import { EnergyInsightService, type EnergyInsightView } from '@modules/smart-energy/energy-insight.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { type Request } from 'express';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type EnergyBasisName,
  EnergyInsightDto,
  type EnergyInsightStateName,
  EnergyOptInDto,
  type EnergyScoreReasonName,
  ListingAssistantQuotaDto,
  ListingAssistantRequestDto,
  ListingAssistantResultDto,
} from './growth-insight.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const W = [...T, 'tenant.read_only'] as const;
const lang = (header: string | undefined): 'th' | 'en' =>
  header?.toLowerCase().startsWith('en') ? 'en' : 'th';
const dec = (x: number | null, digits: number) => (x === null ? null : x.toFixed(digits));

const DRAFT_TH = {
  title: 'คอนโด 28.5 ตร.ม. พญาไท, กรุงเทพมหานคร',
  description: 'คอนโด 1 ห้องนอน 28.5 ตร.ม. ย่านพญาไท\nค่าเช่า 12,000 บาท/เดือน มัดจำ 2 เดือน',
};
const RESULT_EXAMPLE: ListingAssistantResultDto = {
  drafts: {
    th: DRAFT_TH,
    en: {
      title: 'Condo 28.5 sqm, Phaya Thai',
      description: '1-bedroom condo of 28.5 sqm in Phaya Thai.\nRent 12,000 THB a month, 2 months deposit.',
    },
    zh: null,
  },
  model: 'text-default',
  photosUsed: 3,
  usedThisMonth: 4,
  monthlyLimit: 30,
  disclaimer: ASSISTANT_DISCLAIMER.th,
};

export function energyDto(v: EnergyInsightView): EnergyInsightDto {
  const m = v.result.metrics;
  return {
    buildingId: v.building.id,
    buildingName: v.building.name,
    score: v.result.score,
    reason: v.result.reason as EnergyScoreReasonName,
    scoreModel: v.result.modelVersion,
    windowFrom: v.window.from,
    windowTo: addCalendarDays(v.window.to, -1),
    metrics: {
      dataDays: m.dataDays,
      basis: m.basis as EnergyBasisName,
      totalKwh: m.totalKwh.toFixed(3),
      commonAreaKwh: m.commonAreaKwh.toFixed(3),
      commonAreaShare: dec(m.commonAreaShare, 4),
      peakKw: m.peakKw.toFixed(3),
      averageKw: m.averageKw.toFixed(3),
      loadFactor: dec(m.loadFactor, 4),
      pumpHoursPerDay: dec(m.pumpHoursPerDay, 2),
    },
    penalties: {
      commonShare: v.result.penalties.commonShare.toFixed(1),
      lowLoadFactor: v.result.penalties.lowLoadFactor.toFixed(1),
      pumpHours: v.result.penalties.pumpHours.toFixed(1),
    },
    canOptIn: v.canOptIn,
    optin: v.optin
      ? {
          state: v.optin.state as EnergyInsightStateName,
          optedInAt: iso(v.optin.optedInAt),
          optedOutAt: isoOrNull(v.optin.optedOutAt),
          lastSharedAt: isoOrNull(v.optin.lastSharedAt),
          lastScore: v.optin.lastScore,
        }
      : null,
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

const ENERGY_EXAMPLE: EnergyInsightDto = {
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  score: 82,
  reason: 'ok' as EnergyScoreReasonName,
  scoreModel: 'v1',
  windowFrom: '2026-10-01',
  windowTo: '2026-10-30',
  metrics: {
    dataDays: 30,
    basis: 'sum' as EnergyBasisName,
    totalKwh: '18250.500',
    commonAreaKwh: '4380.120',
    commonAreaShare: '0.2400',
    peakKw: '48.200',
    averageKw: '25.347',
    loadFactor: '0.5259',
    pumpHoursPerDay: '9.50',
  },
  penalties: { commonShare: '5.3', lowLoadFactor: '0.0', pumpHours: '3.8' },
  canOptIn: true,
  optin: null,
  consent: {
    purposeKey: 'energy.insight',
    version: 1,
    title: 'ส่งข้อมูลพลังงานของอาคารให้ getenergy',
    bodyMarkdown: 'ร่าง ⚖ — เลือกได้ ปิดได้ทุกเมื่อ …',
  },
};
const OPTED_IN = {
  ...ENERGY_EXAMPLE,
  optin: {
    state: 'opted_in' as EnergyInsightStateName,
    optedInAt: FAKE.dateTime,
    optedOutAt: null,
    lastSharedAt: null,
    lastScore: null,
  },
};
const BUILDING_PARAM = { name: 'buildingId', format: 'uuid', example: FAKE.buildingId };

/**
 * AI listing assistant (G9, D-301, D-161): titles and descriptions drafted in th / en / zh from the listing's own
 * facts (and a few photos, read only). Nothing is saved — the owner edits and saves through the listing update.
 */
@ApiTags('owner.listingAssistant')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerListingAssistantController {
  constructor(private readonly assistant: ListingAssistantService) {}

  @Get('listing-assistant')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.listingAssistant.quota',
    summary: 'Listing assistant: availability and quota',
    description:
      'Whether the AI listing assistant is on for this tenant (`listing.assistant.enabled`) and how many drafts it used this Bangkok month out of `listing.assistant.monthly_limit` (D-301, D-161).',
    implements: ['D-301', 'D-161'],
  })
  @ApiSuccess(200, {
    description: 'Quota',
    type: ListingAssistantQuotaDto,
    example: { enabled: true, usedThisMonth: 4, monthlyLimit: 30 },
  })
  @ApiStandardErrors(...T)
  async quota(@CurrentTenant() ctx: TenantContext): Promise<ListingAssistantQuotaDto> {
    return this.assistant.quota(ctx);
  }

  @Post('listings/:listingId/assistant')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('listing.manage')
  @ApiParam({ name: 'listingId', format: 'uuid', example: FAKE.uuid })
  @ApiEndpoint({
    id: 'owner.listings.assistant',
    summary: 'Draft the listing text with AI',
    description:
      'Drafts a title and a description per language (th / en / zh) from the listing’s own facts — unit kind, size, rooms, rent and terms, facilities, area, transit — and, with `includePhotos`, its first photos (read only; photos are never changed). **Nothing is saved**: edit the drafts and save them with `PATCH /v1/owner/listings/{listingId}`. Every call is recorded as AI usage of this tenant (D-161); monthly limit: `assistant.limit_reached`; switched off: `assistant.disabled`; AI gateway not available: `assistant.unavailable`; an unusable answer: `assistant.output_rejected`. Another tenant’s listing: 404 (D-301).',
    implements: ['D-301', 'D-161'],
  })
  @ApiJsonBody(ListingAssistantRequestDto, { languages: ['th', 'en', 'zh'], includePhotos: true })
  @ApiSuccess(200, { description: 'Drafts', type: ListingAssistantResultDto, example: RESULT_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'idempotency.key_required',
    'assistant.disabled',
    'assistant.limit_reached',
    'assistant.unavailable',
    'assistant.output_rejected',
    ...W,
  )
  async draft(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) id: string,
    @Body() body: ListingAssistantRequestDto,
    @Req() req: Request,
  ): Promise<ListingAssistantResultDto> {
    const r = await this.assistant.draft(ctx, id, body);
    return {
      drafts: { th: r.drafts.th ?? null, en: r.drafts.en ?? null, zh: r.drafts.zh ?? null },
      model: r.model,
      photosUsed: r.photosUsed,
      usedThisMonth: r.usedThisMonth,
      monthlyLimit: r.monthlyLimit,
      disclaimer: ASSISTANT_DISCLAIMER[lang(req.headers['accept-language'])],
    };
  }
}

/**
 * Energy insight → getenergy (G9, D-289 (6), D-301): the building's energy score from its electricity rollups, and
 * the owner's opt-in to share aggregate figures with getenergy (O-028). Nothing leaves before the opt-in.
 */
@ApiTags('owner.energyInsight')
@ApiSurface(SURFACES.owner)
@Controller('owner/buildings')
export class OwnerEnergyInsightController {
  constructor(private readonly energy: EnergyInsightService) {}

  @Get(':buildingId/energy-insight')
  @TenantScoped()
  @Can('report.read')
  @ApiParam(BUILDING_PARAM)
  @ApiEndpoint({
    id: 'owner.buildings.energyInsight',
    summary: 'Energy score of a building',
    description:
      'The building’s energy score (0–100, model `energy.insight.score_model`, O-036) from its hourly electricity rollups of the last `energy.insight.window_days` full days — total and common-area kWh, peak demand, load factor, pump hours — with the points taken off per factor; `insufficient_data` below `energy.insight.min_days` of data. Also whether it is shared with getenergy and the `energy.insight` consent text. Owner and operator tenants; others: 404 (D-301, D-289 (6)).',
    implements: ['D-301', 'D-289', 'D-030'],
  })
  @ApiSuccess(200, { description: 'Energy insight', type: EnergyInsightDto, example: ENERGY_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<EnergyInsightDto> {
    return energyDto(await this.energy.view(ctx, id, lang(req.headers['accept-language'])));
  }

  @Post(':buildingId/energy-insight/actions/opt-in')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('tenant.settings.update')
  @ApiParam(BUILDING_PARAM)
  @ApiEndpoint({
    id: 'owner.buildings.energyInsightOptIn',
    summary: 'Share energy figures with getenergy',
    description:
      'The building owner opts in with the current `energy.insight` consent version (`energy.consent_required` otherwise): getproperty then sends getenergy (Collective) the score and building-level aggregates — never names, contacts, units, residents or per-unit use — and refreshes them every `energy.insight.share_every_days`. Without a score (`insufficient_data`) nothing is sent until there is one. An operator that does not own the building: `energy.owner_required`; others: 404. A repeated opt-in changes nothing (D-301, D-289 (6), O-028).',
    implements: ['D-301', 'D-289', 'D-025', 'D-238'],
  })
  @ApiJsonBody(EnergyOptInDto, { consentVersion: 1 })
  @ApiSuccess(200, { description: 'Opted in', type: EnergyInsightDto, example: OPTED_IN })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'idempotency.key_required',
    'energy.consent_required',
    'energy.owner_required',
    ...W,
  )
  async optIn(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) id: string,
    @Body() body: EnergyOptInDto,
    @Req() req: Request,
  ): Promise<EnergyInsightDto> {
    return energyDto(
      await this.energy.optIn(ctx, id, {
        consentVersion: body.consentVersion,
        language: lang(req.headers['accept-language']),
      }),
    );
  }

  @Post(':buildingId/energy-insight/actions/opt-out')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.settings.update')
  @ApiParam(BUILDING_PARAM)
  @ApiEndpoint({
    id: 'owner.buildings.energyInsightOptOut',
    summary: 'Stop sharing energy figures with getenergy',
    description:
      'Records the withdrawal of `energy.insight`; nothing more is sent (unsent snapshots are dropped) and getenergy is told to delete this building’s lead (`energy.insight.withdrawn`). Not opted in: `energy.invalid_state`; not the owner: `energy.owner_required`; others: 404 (D-301, D-025).',
    implements: ['D-301', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Opted out',
    type: EnergyInsightDto,
    example: {
      ...OPTED_IN,
      optin: { ...OPTED_IN.optin, state: 'opted_out' as EnergyInsightStateName, optedOutAt: FAKE.dateTime },
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'energy.invalid_state',
    'energy.owner_required',
    ...W,
  )
  async optOut(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<EnergyInsightDto> {
    return energyDto(await this.energy.optOut(ctx, id, lang(req.headers['accept-language'])));
  }
}

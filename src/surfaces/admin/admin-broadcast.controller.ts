import { Can } from '@common/auth/can.decorator';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type QuietHours } from '@core/notifications/quiet-hours';
import { SettingsService } from '@core/settings/settings.service';
import { AudienceService } from '@modules/platform-audience/audience.service';
import { SponsoredCampaignsService } from '@modules/platform-audience/sponsored-campaigns.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ReasonDto } from '../owner/governance.dto';
import { campaignDtos } from '../owner/sponsored.controller';
import {
  AdminSponsoredCampaignDto,
  BroadcastConsentTextCreateDto,
  BroadcastConsentTextDto,
  BroadcastSettingsDto,
  BroadcastSettingsUpdateDto,
  CAMPAIGN_EXAMPLE,
  SponsoredCampaignListQuery,
} from '../owner/sponsored.dto';
import { iso } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const ADMIN_CAMPAIGN_EXAMPLE: AdminSponsoredCampaignDto = {
  ...CAMPAIGN_EXAMPLE,
  tenantId: FAKE.tenantId,
  tenantName: 'มาลี มีสุข',
};

/** The settings of the admin screen and their catalogue keys (D-291: every one an effective-dated setting). */
const KEYS = {
  enabled: 'broadcast.sponsored.enabled',
  maxPerWeek: 'broadcast.sponsored.max_per_week',
  quietHours: 'broadcast.sponsored.quiet_hours',
  maxListings: 'broadcast.sponsored.max_listings',
  sendWindowHours: 'broadcast.sponsored.send_window_hours',
  attributionDays: 'broadcast.sponsored.attribution_days',
  deliveryKeepMonths: 'broadcast.sponsored.delivery_keep_months',
  preferencesKeepDays: 'audience.preferences.keep_days_after_withdrawal',
} as const;

const SETTINGS_EXAMPLE: BroadcastSettingsDto = {
  enabled: false,
  maxPerWeek: 2,
  quietHours: { start: '21:00', end: '08:00', timezone: 'Asia/Bangkok' },
  maxListings: 5,
  sendWindowHours: 24,
  attributionDays: 7,
  deliveryKeepMonths: 12,
  preferencesKeepDays: 30,
  consentText: {
    version: 1,
    effectiveFrom: FAKE.dateTime,
    th: { title: 'รับห้องแนะนำจาก getproperty (รวมโฆษณา)', bodyMarkdown: 'ร่าง ⚖ — เลือกรับหรือไม่ก็ได้ …' },
    en: { title: 'Recommended places from getproperty (incl. ads)', bodyMarkdown: 'Draft ⚖ — optional …' },
  },
  consenting: 1240,
};

/** Sponsored campaigns of every buyer for the platform team (G6, D-300): list, reject. Aggregates only. */
@ApiTags('admin.sponsoredCampaigns')
@ApiSurface(SURFACES.admin)
@Controller('admin/sponsored-campaigns')
export class AdminSponsoredCampaignsController {
  constructor(private readonly campaigns: SponsoredCampaignsService) {}

  @Get()
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.sponsoredCampaigns.list',
    summary: 'Sponsored campaigns',
    description:
      'Every buyer’s campaigns, newest first, with state, schedule, price snapshot and aggregate counters — no recipient data (D-300).',
    implements: ['D-300'],
  })
  @ApiPaginated(AdminSponsoredCampaignDto, { example: ADMIN_CAMPAIGN_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() q: SponsoredCampaignListQuery): Promise<Page<AdminSponsoredCampaignDto>> {
    const { rows, total } = await this.campaigns.adminList({ state: q.state, ...toSkipTake(q) });
    const dtos = await campaignDtos(this.campaigns, rows);
    return paginated(
      dtos.map((d, i) => ({ ...d, tenantId: rows[i]!.tenantId, tenantName: rows[i]!.tenant.displayName })),
      total,
      q,
    );
  }

  @Post(':campaignId/actions/reject')
  @HttpCode(200)
  @Can('admin.listing.moderate')
  @ApiEndpoint({
    id: 'admin.sponsoredCampaigns.reject',
    summary: 'Reject a sponsored campaign',
    description:
      'Stops a draft, scheduled or sending campaign (content or policy): messages not yet sent are cancelled and the campaign is not billed. Finished: `broadcast.invalid_state` (D-300).',
    implements: ['D-300'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'ข้อความประกาศไม่ตรงกับห้องจริง' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: AdminSponsoredCampaignDto,
    example: { ...ADMIN_CAMPAIGN_EXAMPLE, state: 'rejected' as AdminSponsoredCampaignDto['state'] },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'broadcast.invalid_state')
  async reject(
    @Param('campaignId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<AdminSponsoredCampaignDto> {
    const row = await this.campaigns.reject(id, body.reason);
    const [dto] = await campaignDtos(this.campaigns, [row]);
    return { ...dto!, tenantId: row.tenantId, tenantName: row.tenant.displayName };
  }
}

/**
 * Sponsored broadcast settings for the admin console (G6, D-291, D-300): the switch (O-023), the weekly cap, quiet
 * hours, windows and retention — each a new effective-dated, audited setting version — and the
 * `platform.recommendations` consent text (a new version means everyone is asked again).
 */
@ApiTags('admin.broadcast')
@ApiSurface(SURFACES.admin)
@Controller('admin/broadcast')
export class AdminBroadcastController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audience: AudienceService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async read(): Promise<BroadcastSettingsDto> {
    const now = this.clock.now();
    const v = async <T>(key: string) => this.settings.valueAt<T>(key, now);
    const text = await this.audience.consentText();
    return {
      enabled: (await v<boolean>(KEYS.enabled)) === true,
      maxPerWeek: await v<number>(KEYS.maxPerWeek),
      quietHours: await v<QuietHours>(KEYS.quietHours),
      maxListings: await v<number>(KEYS.maxListings),
      sendWindowHours: await v<number>(KEYS.sendWindowHours),
      attributionDays: await v<number>(KEYS.attributionDays),
      deliveryKeepMonths: await v<number>(KEYS.deliveryKeepMonths),
      preferencesKeepDays: await v<number>(KEYS.preferencesKeepDays),
      consentText: text ? { ...text, effectiveFrom: iso(text.effectiveFrom) } : null,
      consenting: await this.audience.consenting(),
    };
  }

  @Get('settings')
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.broadcast.settings',
    summary: 'Sponsored broadcast settings',
    description:
      'The switch `broadcast.sponsored.enabled` (off until LINE Thailand confirms, O-023), weekly cap, quiet hours, listings per campaign, send window, lead attribution, retention, the consent text in force and how many people consent (aggregate) (D-300, D-291).',
    implements: ['D-300', 'D-291'],
  })
  @ApiSuccess(200, { description: 'Settings', type: BroadcastSettingsDto, example: SETTINGS_EXAMPLE })
  @ApiStandardErrors('auth.unauthenticated')
  get(): Promise<BroadcastSettingsDto> {
    return this.read();
  }

  @Put('settings')
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.broadcast.updateSettings',
    summary: 'Change sponsored broadcast settings',
    description:
      'Each given value becomes a new platform setting version from now (audited with the reason, never backdated; D-291). Switch it on only with LINE Thailand’s written confirmation (O-023) (D-300).',
    implements: ['D-300', 'D-291'],
  })
  @ApiJsonBody(BroadcastSettingsUpdateDto, { maxPerWeek: 1, reason: 'ลดความถี่ช่วงทดลอง' })
  @ApiSuccess(200, { description: 'Saved', type: BroadcastSettingsDto, example: SETTINGS_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'settings.invalid_value')
  async update(@Body() body: BroadcastSettingsUpdateDto): Promise<BroadcastSettingsDto> {
    const current = await this.read();
    for (const field of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
      const value = body[field];
      if (value === undefined || JSON.stringify(value) === JSON.stringify(current[field])) continue;
      await this.settings.setPlatform(KEYS[field], value, undefined, body.reason);
    }
    return this.read();
  }

  @Post('consent-texts')
  @Idempotent()
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.broadcast.publishConsentText',
    summary: 'New recommendations consent text',
    description:
      'Publishes a new version of `platform.recommendations` (th + en; from now or later). Once in force every earlier grant counts as not granted: nobody gets sponsored messages until they consent again (D-300, D-025). Legal review ⚖ before publishing.',
    implements: ['D-300', 'D-025'],
  })
  @ApiJsonBody(BroadcastConsentTextCreateDto, {
    th: {
      title: 'รับห้องแนะนำจาก getproperty (รวมโฆษณา)',
      bodyMarkdown: 'เลือกรับหรือไม่ก็ได้ ไม่มีผลต่อการใช้บริการอื่น …',
    },
    en: {
      title: 'Recommended places from getproperty (incl. ads)',
      bodyMarkdown: 'Optional; saying no changes nothing else …',
    },
  })
  @ApiSuccess(201, {
    description: 'Published',
    type: BroadcastConsentTextDto,
    example: SETTINGS_EXAMPLE.consentText,
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'consent.unknown_purpose')
  async publish(@Body() body: BroadcastConsentTextCreateDto): Promise<BroadcastConsentTextDto> {
    const text = await this.audience.publishConsentText(body, userIdOf(RequestContext.actor()));
    return { ...text!, effectiveFrom: iso(text!.effectiveFrom) };
  }
}

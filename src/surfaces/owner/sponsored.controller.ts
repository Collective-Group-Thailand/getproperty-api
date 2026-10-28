import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { parseSegment } from '@modules/platform-audience/audience-rules';
import {
  type CampaignRow,
  SponsoredCampaignsService,
  type SponsoredProduct,
} from '@modules/platform-audience/sponsored-campaigns.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { type AudienceUnitKindName } from '../shared/audience.dto';
import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { growthInvoiceDto } from './growth.mappers';
import {
  CAMPAIGN_EXAMPLE,
  PRODUCT_EXAMPLE,
  SponsoredCampaignCreateDto,
  SponsoredCampaignDto,
  SponsoredCampaignListQuery,
  type SponsoredCampaignStateName,
  SponsoredEstimateDto,
  SponsoredEstimateRequestDto,
  SponsoredProductDto,
  SponsoredReportDto,
  SponsoredScheduleDto,
} from './sponsored.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const W = [...T, 'tenant.read_only'] as const;

export function productDto(p: SponsoredProduct): SponsoredProductDto {
  return {
    enabled: p.enabled,
    onSale: p.onSale,
    pricePerRecipient: p.pricePerRecipient,
    vatRate: p.vatRate,
    currency: p.currency,
    minimumRecipients: p.minimumRecipients,
    maxListings: p.maxListings,
    maxPerWeek: p.maxPerWeek,
  };
}

/** Campaign rows → DTOs with their listings (one listing query for the page). */
export async function campaignDtos(
  campaigns: SponsoredCampaignsService,
  rows: CampaignRow[],
): Promise<SponsoredCampaignDto[]> {
  const listings = await campaigns.listingsOf(rows.flatMap((r) => r.listingIds));
  return rows.map((c) => {
    const s = parseSegment(c.segment).segment;
    return {
      id: c.id,
      name: c.name,
      state: c.state as SponsoredCampaignStateName,
      listings: c.listingIds.flatMap((id) => {
        const l = listings.get(id);
        return l ? [l] : [];
      }),
      segment: { ...s, unitKinds: s.unitKinds as AudienceUnitKindName[] },
      maxRecipients: c.maxRecipients,
      estimated: c.estimated,
      scheduledAt: isoOrNull(c.scheduledAt),
      pricePerRecipient: c.pricePerRecipient ? c.pricePerRecipient.toFixed(4) : null,
      vatRate: c.vatRate ? c.vatRate.toFixed(4) : null,
      minimumRecipients: c.minimumRecipients,
      delivered: c.delivered,
      clicks: c.clicks,
      invoice: growthInvoiceDto(c.platformInvoice),
      rejectReason: c.rejectReason,
      sendingStartedAt: isoOrNull(c.sendingStartedAt),
      completedAt: isoOrNull(c.completedAt),
      createdAt: iso(c.createdAt),
    };
  });
}

const ESTIMATE_BODY = {
  listingIds: [CAMPAIGN_EXAMPLE.listings[0]!.id],
  segment: { areas: ['ari'] },
  maxRecipients: 1000,
};

/**
 * Sponsored broadcast (G6, D-287, D-300): a buyer sends its own published listings through getproperty's LINE OA to
 * people who chose to receive recommendations and whose own preferences fit — estimate (aggregate, withheld below the
 * minimum), schedule, aggregate report; billed per delivered recipient on a `purchase` platform invoice (O-020: no
 * gateway). Off until LINE Thailand confirms (`broadcast.sponsored.enabled`, O-023); not on sale until priced (O-027).
 * The buyer never sees a person.
 */
@ApiTags('owner.sponsoredCampaigns')
@ApiSurface(SURFACES.owner)
@Controller('owner/sponsored-campaigns')
export class OwnerSponsoredCampaignsController {
  constructor(private readonly campaigns: SponsoredCampaignsService) {}

  @Get('product')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.sponsoredCampaigns.product',
    summary: 'Sponsored broadcast: availability and price',
    description:
      'Whether sponsored broadcasts are switched on (`enabled`, O-023), the price per delivered recipient of the price-plan version in force (`onSale: false` = no price yet, O-027), the minimum recipients per campaign, the listings per campaign and the weekly cap per person (D-300).',
    implements: ['D-300', 'D-287', 'D-291'],
  })
  @ApiSuccess(200, { description: 'Product', type: SponsoredProductDto, example: PRODUCT_EXAMPLE })
  @ApiStandardErrors(...T)
  async product(): Promise<SponsoredProductDto> {
    return productDto(await this.campaigns.product());
  }

  @Post('estimate')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.sponsoredCampaigns.estimate',
    summary: 'Estimate recipients and price',
    description:
      'How many people who consented to `platform.recommendations` and whose own preferences fit the segment and the listings would get it now — a number only, withheld (`estimated: null`, `belowMinimum: true`) below the minimum; with the price preview. Nothing is stored. Another tenant’s listing: 404; unpublished: `broadcast.listing_not_public` (D-300).',
    implements: ['D-300', 'D-025'],
  })
  @ApiJsonBody(SponsoredEstimateRequestDto, ESTIMATE_BODY)
  @ApiSuccess(200, {
    description: 'Estimate',
    type: SponsoredEstimateDto,
    example: {
      estimated: 1000,
      belowMinimum: false,
      minimumRecipients: 500,
      cost: null,
      product: PRODUCT_EXAMPLE,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'broadcast.listing_not_public',
    ...T,
  )
  async estimate(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: SponsoredEstimateRequestDto,
  ): Promise<SponsoredEstimateDto> {
    const e = await this.campaigns.estimate(ctx, body);
    return {
      estimated: e.estimated,
      belowMinimum: e.belowMinimum,
      minimumRecipients: e.minimumRecipients,
      cost: e.cost,
      product: productDto(e.product),
    };
  }

  @Get()
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.sponsoredCampaigns.list',
    summary: 'My sponsored campaigns',
    description: 'This tenant’s campaigns, newest first, with their aggregate counters (D-300).',
    implements: ['D-300'],
  })
  @ApiPaginated(SponsoredCampaignDto, { example: CAMPAIGN_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: SponsoredCampaignListQuery,
  ): Promise<Page<SponsoredCampaignDto>> {
    const { rows, total } = await this.campaigns.list(ctx, { state: q.state, ...toSkipTake(q) });
    return paginated(await campaignDtos(this.campaigns, rows), total, q);
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.sponsoredCampaigns.create',
    summary: 'Draft a sponsored campaign',
    description:
      'A draft of my own published listings (1–`broadcast.sponsored.max_listings`) to a segment from the closed whitelist (areas, budget, unit kinds, move-in window, languages — no special-category data); the estimate is stored as the aggregate number (null below the minimum). Another tenant’s listing: 404 (D-300).',
    implements: ['D-300', 'D-287'],
  })
  @ApiJsonBody(SponsoredCampaignCreateDto, { name: CAMPAIGN_EXAMPLE.name, ...ESTIMATE_BODY })
  @ApiSuccess(201, { description: 'Drafted', type: SponsoredCampaignDto, example: CAMPAIGN_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'broadcast.listing_not_public',
    ...W,
  )
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: SponsoredCampaignCreateDto,
  ): Promise<SponsoredCampaignDto> {
    const row = await this.campaigns.create(ctx, body);
    return (await campaignDtos(this.campaigns, [row]))[0]!;
  }

  @Get(':campaignId')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.sponsoredCampaigns.get',
    summary: 'A sponsored campaign',
    description: 'One of this tenant’s campaigns; another tenant’s: 404 (D-300).',
    implements: ['D-300'],
  })
  @ApiSuccess(200, { description: 'Campaign', type: SponsoredCampaignDto, example: CAMPAIGN_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('campaignId', ParseUUIDPipe) id: string,
  ): Promise<SponsoredCampaignDto> {
    return (await campaignDtos(this.campaigns, [await this.campaigns.get(ctx, id)]))[0]!;
  }

  @Post(':campaignId/actions/schedule')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.sponsoredCampaigns.schedule',
    summary: 'Schedule a sponsored campaign',
    description:
      'Commits to buy: the price per recipient, VAT rate and minimum of the price-plan version in force are snapshotted and the campaign starts at `scheduledAt` (now when empty). Switched off: `broadcast.sponsored_disabled` (O-023); no price: `broadcast.not_on_sale` (O-027); a listing no longer public: `broadcast.listing_not_public`; fewer people than the minimum: `broadcast.below_minimum`; not a draft: `broadcast.invalid_state`. Billed after sending for the delivered recipients only (D-300).',
    implements: ['D-300', 'D-287', 'D-291'],
  })
  @ApiJsonBody(SponsoredScheduleDto, { scheduledAt: '2026-11-02T10:00:00+07:00' })
  @ApiSuccess(200, {
    description: 'Scheduled',
    type: SponsoredCampaignDto,
    example: {
      ...CAMPAIGN_EXAMPLE,
      state: 'scheduled' as SponsoredCampaignStateName,
      scheduledAt: '2026-11-02T10:00:00+07:00',
      pricePerRecipient: '0.5000',
      vatRate: '0.0700',
      minimumRecipients: 500,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'broadcast.sponsored_disabled',
    'broadcast.not_on_sale',
    'broadcast.listing_not_public',
    'broadcast.below_minimum',
    'broadcast.invalid_state',
    ...W,
  )
  async schedule(
    @CurrentTenant() ctx: TenantContext,
    @Param('campaignId', ParseUUIDPipe) id: string,
    @Body() body: SponsoredScheduleDto,
  ): Promise<SponsoredCampaignDto> {
    return (await campaignDtos(this.campaigns, [await this.campaigns.schedule(ctx, id, body)]))[0]!;
  }

  @Post(':campaignId/actions/cancel')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.sponsoredCampaigns.cancel',
    summary: 'Cancel a sponsored campaign',
    description:
      'A draft or a scheduled campaign is cancelled (nothing sent, nothing billed); sending or finished: `broadcast.invalid_state` (D-300).',
    implements: ['D-300'],
  })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: SponsoredCampaignDto,
    example: { ...CAMPAIGN_EXAMPLE, state: 'cancelled' as SponsoredCampaignStateName },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'broadcast.invalid_state', ...W)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('campaignId', ParseUUIDPipe) id: string,
  ): Promise<SponsoredCampaignDto> {
    return (await campaignDtos(this.campaigns, [await this.campaigns.cancel(ctx, id)]))[0]!;
  }

  @Get(':campaignId/report')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.sponsoredCampaigns.report',
    summary: 'Campaign report (aggregates only)',
    description:
      'Sent, opened (null — not available for a multicast), clicks on the campaign links and leads (enquiries on these listings by people who got it, within `broadcast.sponsored.attribution_days`) — numbers only, never a person; a person reaches me only by enquiring (D-300, D-025).',
    implements: ['D-300', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Report',
    type: SponsoredReportDto,
    example: {
      campaignId: CAMPAIGN_EXAMPLE.id,
      state: 'sent' as SponsoredCampaignStateName,
      sent: 812,
      opened: null,
      clicks: 64,
      leads: 5,
      attributionDays: 7,
      invoice: null,
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async report(
    @CurrentTenant() ctx: TenantContext,
    @Param('campaignId', ParseUUIDPipe) id: string,
  ): Promise<SponsoredReportDto> {
    const r = await this.campaigns.report(ctx, id);
    return {
      campaignId: r.campaign.id,
      state: r.campaign.state as SponsoredCampaignStateName,
      sent: r.campaign.delivered,
      opened: null,
      clicks: r.campaign.clicks,
      leads: r.leads,
      attributionDays: r.attributionDays,
      invoice: growthInvoiceDto(r.campaign.platformInvoice),
    };
  }
}

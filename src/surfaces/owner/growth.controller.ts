import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { BoostsService } from '@modules/platform-subscriptions/boosts.service';
import { MediaServicesService } from '@modules/platform-subscriptions/media-services.service';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  BoostDto,
  BoostListQuery,
  BoostProductsDto,
  BoostPurchaseDto,
  BoostsDto,
  MediaServiceKindName,
  MediaServiceOrderCreateDto,
  MediaServiceOrderDto,
  MediaServiceOrdersDto,
  MediaServiceProductsDto,
} from './growth.dto';
import {
  BOOST_EXAMPLE,
  BOOST_PRODUCT_EXAMPLE,
  boostDto,
  boostProductDto,
  MEDIA_ORDER_EXAMPLE,
  MEDIA_PRODUCT_EXAMPLE,
  mediaOrderDto,
  mediaProductDto,
} from './growth.mappers';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const W = [...T, 'tenant.read_only'] as const;

/**
 * Boosts (G5, D-287, D-297): buy a listing boost (7 / 30 days) or a building boost (a month) — a `purchase` platform
 * invoice line (Collective issues it, O-008; nothing through the payment gateway, O-020); active from payment for its
 * window; public search shows boosted listings labelled "โฆษณา", a few per page. Prices are price-plan versions set by
 * the platform admin (O-027) — until then nothing is on sale. An unpaid boost is never active; nothing is suspended.
 */
@ApiTags('owner.boosts')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerBoostsController {
  constructor(private readonly boosts: BoostsService) {}

  @Get('boost-products')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.boosts.products',
    summary: 'Boost products',
    description:
      'Listing boosts (7 / 30 days) and the building boost (one month) with the price before and incl. VAT of the price-plan version in force; `onSale: false` = no price yet (O-027, shown "ยังไม่เปิดขาย"); `free: true` = the building boost is free for this tenant (`boost.building.free`, D-297).',
    implements: ['D-287', 'D-291', 'D-297'],
  })
  @ApiSuccess(200, {
    description: 'Products',
    type: BoostProductsDto,
    example: { products: [BOOST_PRODUCT_EXAMPLE] },
  })
  @ApiStandardErrors(...T)
  async products(@CurrentTenant() ctx: TenantContext): Promise<BoostProductsDto> {
    return { products: (await this.boosts.catalogue(ctx)).map(boostProductDto) };
  }

  @Post('listings/:listingId/boosts')
  @Idempotent()
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.boosts.boostListing',
    summary: 'Boost a listing',
    description:
      'Buys a listing boost for a published listing of this tenant (D-297): a pending boost and a `purchase` platform invoice (line `boost`); it is active from the payment for its days, queued after a boost of the listing still in force. Not on sale: `boost.not_on_sale`; the same boost already waiting for payment: `boost.pending`; listing not public: `boost.listing_not_public`. Another tenant’s listing: 404.',
    implements: ['D-287', 'D-297', 'D-250'],
  })
  @ApiJsonBody(BoostPurchaseDto, { productId: '0199f2a0-0000-7000-8000-0000000000e1' })
  @ApiSuccess(201, { description: 'Ordered', type: BoostDto, example: BOOST_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'boost.not_on_sale',
    'boost.pending',
    'boost.listing_not_public',
    ...W,
  )
  async boostListing(
    @CurrentTenant() ctx: TenantContext,
    @Param('listingId', ParseUUIDPipe) listingId: string,
    @Body() body: BoostPurchaseDto,
  ): Promise<BoostDto> {
    return boostDto(await this.boosts.boostListing(ctx, listingId, body.productId));
  }

  @Post('buildings/:buildingId/boosts')
  @Idempotent()
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.boosts.boostBuilding',
    summary: 'Boost a building',
    description:
      'Buys a building boost (every public listing of this tenant in the building, one month) for a building the tenant owns or operates (D-297); free and active at once where `boost.building.free` is on for the tenant (one free boost in force at a time: `boost.already_active`). Otherwise as a listing boost. Another tenant’s building: 404.',
    implements: ['D-287', 'D-297', 'D-250'],
  })
  @ApiJsonBody(BoostPurchaseDto, { productId: '0199f2a0-0000-7000-8000-0000000000e7' })
  @ApiSuccess(201, {
    description: 'Ordered',
    type: BoostDto,
    example: {
      ...BOOST_EXAMPLE,
      productKey: 'boost_building_month',
      name: 'โปรโมตอาคารรายเดือน',
      target: 'building',
      listingId: null,
      listingSlug: null,
      buildingId: FAKE.buildingId,
      targetName: FAKE.propertyName,
      days: null,
      months: 1,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'boost.not_on_sale',
    'boost.pending',
    'boost.already_active',
    ...W,
  )
  async boostBuilding(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: BoostPurchaseDto,
  ): Promise<BoostDto> {
    return boostDto(await this.boosts.boostBuilding(ctx, buildingId, body.productId));
  }

  @Get('boosts')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.boosts.list',
    summary: 'My boosts',
    description: 'The tenant’s boosts, newest first, with their window and purchase invoice (D-297).',
    implements: ['D-297'],
  })
  @ApiSuccess(200, { description: 'Boosts', type: BoostsDto, example: { data: [BOOST_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: BoostListQuery): Promise<BoostsDto> {
    return { data: (await this.boosts.list(ctx, query)).map(boostDto) };
  }

  @Get('boosts/:boostId')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.boosts.get',
    summary: 'One of my boosts',
    description: 'A boost of this tenant (D-297). Another tenant’s: 404.',
    implements: ['D-297'],
  })
  @ApiSuccess(200, { description: 'Boost', type: BoostDto, example: BOOST_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('boostId', ParseUUIDPipe) id: string,
  ): Promise<BoostDto> {
    return boostDto(await this.boosts.get(ctx, id));
  }
}

/**
 * Verified photo / 360° tour orders (G5, D-287, D-297): ordered from the platform for one of the tenant's listings as
 * a `purchase` platform invoice line; a partner fulfils it after payment (O-032); the files are stored as the tenant's
 * listing media (counted to the quota, D-286). Prices are price-plan versions (O-027).
 */
@ApiTags('owner.mediaServices')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerMediaServicesController {
  constructor(private readonly media: MediaServicesService) {}

  @Get('media-service-products')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.mediaServices.products',
    summary: 'Verified photo / 360° products',
    description:
      'The media services the platform offers with their price (before / incl. VAT); `onSale: false` = no price yet (O-027).',
    implements: ['D-287', 'D-291', 'D-297'],
  })
  @ApiSuccess(200, {
    description: 'Products',
    type: MediaServiceProductsDto,
    example: { products: [MEDIA_PRODUCT_EXAMPLE] },
  })
  @ApiStandardErrors(...T)
  async products(@CurrentTenant() ctx: TenantContext): Promise<MediaServiceProductsDto> {
    return { products: (await this.media.catalogue(ctx)).map(mediaProductDto) };
  }

  @Get('media-service-orders')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.mediaServices.list',
    summary: 'My media service orders',
    description: 'Verified photo / 360° orders of this tenant, newest first, with state and invoice (D-297).',
    implements: ['D-297'],
  })
  @ApiSuccess(200, {
    description: 'Orders',
    type: MediaServiceOrdersDto,
    example: { data: [MEDIA_ORDER_EXAMPLE] },
  })
  @ApiStandardErrors(...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<MediaServiceOrdersDto> {
    return { data: (await this.media.listOwn(ctx)).map(mediaOrderDto) };
  }

  @Post('media-service-orders')
  @Idempotent()
  @TenantScoped()
  @Can('tenant.subscription.manage')
  @ApiEndpoint({
    id: 'owner.mediaServices.order',
    summary: 'Order a verified photo / 360° tour',
    description:
      'Orders a media service for one of the tenant’s listings (D-297): a `purchase` platform invoice (line `media_service`); the order is `requested` once paid and the platform books the partner (O-032). Not on sale: `media_service.not_on_sale`; an open order for the unit and service: `media_service.order_open`; a closed / rejected listing: `boost.listing_not_public`. Another tenant’s listing: 404.',
    implements: ['D-287', 'D-297', 'D-250'],
  })
  @ApiJsonBody(MediaServiceOrderCreateDto, {
    listingId: '0199f2a0-0000-7000-8000-0000000000e3',
    service: MediaServiceKindName.VerifiedPhoto,
    note: null,
  })
  @ApiSuccess(201, { description: 'Ordered', type: MediaServiceOrderDto, example: MEDIA_ORDER_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'media_service.not_on_sale',
    'media_service.order_open',
    'boost.listing_not_public',
    ...W,
  )
  async order(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: MediaServiceOrderCreateDto,
  ): Promise<MediaServiceOrderDto> {
    return mediaOrderDto(await this.media.order(ctx, body));
  }

  @Get('media-service-orders/:orderId')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.mediaServices.get',
    summary: 'One media service order',
    description: 'A media service order of this tenant with its deliverables (D-297). Another tenant’s: 404.',
    implements: ['D-297'],
  })
  @ApiSuccess(200, { description: 'Order', type: MediaServiceOrderDto, example: MEDIA_ORDER_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('orderId', ParseUUIDPipe) id: string,
  ): Promise<MediaServiceOrderDto> {
    return mediaOrderDto(await this.media.getOwn(ctx, id));
  }
}

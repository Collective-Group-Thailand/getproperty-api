import { CurrentTenant, Public, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type RawBodyRequest } from '@common/http/json-body-parser';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import {
  type ChannelView,
  type LinkPreview,
  MessagingChannelsService,
} from '@core/messaging/messaging-channels.service';
import { MessagingUsageService } from '@core/messaging/messaging-usage.service';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  LineWebhookAckDto,
  MessagingChannelConnectDto,
  MessagingChannelDto,
  type MessagingChannelStateName,
  MessagingLinkDto,
  type MessagingLinkStateName,
  MessagingUsageDto,
  MessagingUsageQuery,
} from './messaging.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;

const CHANNEL_EXAMPLE: MessagingChannelDto = {
  id: FAKE.uuid,
  buildingId: null,
  lineChannelId: '1657000000',
  state: 'verified' as MessagingChannelStateName,
  botName: 'หอพักสุขใจ',
  botPictureUrl: null,
  webhookUrl: 'https://api.getproperty.co/webhooks/line/q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5',
  verifiedAt: FAKE.dateTime,
  lastCheckedAt: FAKE.dateTime,
  lastError: null,
  linkedUsers: 12,
  createdAt: FAKE.dateTime,
};

const LINK_EXAMPLE: MessagingLinkDto = {
  tenantName: 'หอพักสุขใจ',
  botName: 'หอพักสุขใจ',
  botPictureUrl: null,
  expiresAt: '2026-11-01T00:45:00+07:00',
  state: 'valid' as MessagingLinkStateName,
};

function channelDto(c: ChannelView): MessagingChannelDto {
  return {
    id: c.id,
    buildingId: c.buildingId,
    lineChannelId: c.lineChannelId,
    state: c.state as MessagingChannelStateName,
    botName: c.botName,
    botPictureUrl: c.botPictureUrl,
    webhookUrl: c.webhookUrl,
    verifiedAt: isoOrNull(c.verifiedAt),
    lastCheckedAt: isoOrNull(c.lastCheckedAt),
    lastError: c.lastError,
    linkedUsers: c.linkedUsers,
    createdAt: iso(c.createdAt),
  };
}

const linkDto = (l: LinkPreview): MessagingLinkDto => ({
  tenantName: l.tenantName,
  botName: l.botName,
  botPictureUrl: l.botPictureUrl,
  expiresAt: iso(l.expiresAt),
  state: l.state as MessagingLinkStateName,
});

/** The operator's own LINE OA (D-254): connect, check, disconnect. No channel = the shared getproperty OA. */
@ApiTags('owner.messaging')
@ApiSurface(SURFACES.owner)
@Controller('owner/messaging/channels')
export class OwnerMessagingController {
  constructor(private readonly channels: MessagingChannelsService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.settings.read')
  @ApiEndpoint({
    id: 'owner.messagingChannels.list',
    summary: 'My LINE Official Accounts',
    description:
      'The own LINE OAs connected for the tenant or a building, with their state, the webhook URL to set at LINE and how many residents linked them. None = residents are messaged through the shared getproperty OA (D-254).',
    implements: ['D-254'],
  })
  @ApiSuccess(200, { description: 'Channels', type: [MessagingChannelDto], example: [CHANNEL_EXAMPLE] })
  @ApiStandardErrors(...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<MessagingChannelDto[]> {
    return (await this.channels.list(ctx)).map(channelDto);
  }

  @Post()
  @TenantScoped()
  @Can('tenant.settings.update')
  @ApiEndpoint({
    id: 'owner.messagingChannels.connect',
    summary: 'Connect my own LINE Official Account',
    description:
      'The Messaging API channel id, secret and access token (sealed with the tenant key, D-148), for the tenant or one building; replaces the one connected before. getproperty checks the token with LINE (`verified`, or `failing` with the reason) and answers the webhook URL to set in the LINE console. Messages then go out under the operator’s OA to residents who linked it — the others keep the shared OA until they do; LINE’s quota and charges are the operator’s (D-254).',
    implements: ['D-254', 'D-148'],
  })
  @ApiJsonBody(MessagingChannelConnectDto, {
    lineChannelId: '1657000000',
    channelSecret: '0123456789abcdef0123456789abcdef',
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.long-lived-channel-access-token',
  })
  @ApiSuccess(201, { description: 'Connected', type: MessagingChannelDto, example: CHANNEL_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...T)
  async connect(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: MessagingChannelConnectDto,
  ): Promise<MessagingChannelDto> {
    return channelDto(await this.channels.connect(ctx, body));
  }

  @Post(':channelId/actions/verify')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.settings.update')
  @ApiEndpoint({
    id: 'owner.messagingChannels.verify',
    summary: 'Check my LINE Official Account again',
    description:
      'Asks LINE for the bot of the channel with its token; `verified` or `failing` with the reason (D-254).',
    implements: ['D-254'],
  })
  @ApiSuccess(200, { description: 'Checked', type: MessagingChannelDto, example: CHANNEL_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async verify(
    @CurrentTenant() ctx: TenantContext,
    @Param('channelId', ParseUUIDPipe) id: string,
  ): Promise<MessagingChannelDto> {
    return channelDto(await this.channels.verify(ctx, id));
  }

  @Post(':channelId/actions/revoke')
  @HttpCode(204)
  @TenantScoped()
  @Can('tenant.settings.update')
  @ApiEndpoint({
    id: 'owner.messagingChannels.revoke',
    summary: 'Disconnect my LINE Official Account',
    description:
      'Messages go back through the shared getproperty OA at once; the credentials stay sealed and unused (D-254).',
    implements: ['D-254'],
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

/** Account linking for an operator's own OA, confirmed by the resident in the LIFF (D-254). */
@ApiTags('resident.messagingLinks')
@ApiSurface(SURFACES.resident)
@Controller('resident/messaging-links')
export class ResidentMessagingLinksController {
  constructor(private readonly channels: MessagingChannelsService) {}

  @Get(':token')
  @ApiEndpoint({
    id: 'resident.messagingLinks.get',
    summary: 'Who asks me to link their LINE account',
    description:
      'The operator and its LINE OA behind the link the OA replied with, and whether it can still be used (D-254).',
    implements: ['D-254'],
  })
  @ApiSuccess(200, { description: 'The link', type: MessagingLinkDto, example: LINK_EXAMPLE })
  @ApiStandardErrors('messaging.link_invalid')
  async get(@Param('token') token: string): Promise<MessagingLinkDto> {
    return linkDto(await this.channels.preview(token.slice(0, 128)));
  }

  @Post(':token/actions/confirm')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.messagingLinks.confirm',
    summary: 'Link the operator’s LINE account to me',
    description:
      'My bills, repairs and lease messages from this operator then come through its own OA; the same OA user cannot be linked to another person (`messaging.line_user_taken`). Single use; expires after `messaging.link_token.ttl_minutes` (D-254).',
    implements: ['D-254'],
  })
  @ApiSuccess(200, {
    description: 'Linked',
    type: MessagingLinkDto,
    example: { ...LINK_EXAMPLE, state: 'used' as MessagingLinkStateName },
  })
  @ApiStandardErrors(
    'messaging.link_invalid',
    'messaging.link_expired',
    'messaging.link_used',
    'messaging.line_user_taken',
  )
  async confirm(@Param('token') token: string): Promise<MessagingLinkDto> {
    const actor = RequestContext.actor();
    if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
    return linkDto(await this.channels.confirm(actor.publicId, token.slice(0, 128)));
  }
}

/** `POST /webhooks/line/{webhookKey}`: an operator's own OA calls back (D-254). */
@ApiTags('webhooks.line')
@ApiSurface(SURFACES.webhooks)
@Controller({ path: 'webhooks/line', version: VERSION_NEUTRAL })
export class LineWebhooksController {
  constructor(private readonly channels: MessagingChannelsService) {}

  @Post(':webhookKey')
  @HttpCode(200)
  @Public()
  @ApiHeader({
    name: 'X-Line-Signature',
    required: true,
    description: 'Base64 HMAC-SHA256 of the raw body with the channel secret (Messaging API).',
  })
  @ApiEndpoint({
    id: 'webhooks.line.callback',
    summary: 'LINE webhook of an own OA',
    description:
      'Each connected own OA has its own URL. The signature is checked with that channel’s secret (401 `webhook.signature_invalid` otherwise); a follow or a message from an OA user who is not linked gets a reply with a single-use link to the LIFF (replies are not counted by LINE); an unfollow ends the link (D-254).',
    implements: ['D-254'],
  })
  @ApiBody({
    required: true,
    description: 'LINE’s webhook body (`destination`, `events`).',
    schema: { type: 'object', additionalProperties: true },
    examples: {
      follow: {
        summary: 'A user follows the OA',
        value: {
          destination: 'U0123456789abcdef0123456789abcdef',
          events: [
            {
              type: 'follow',
              replyToken: 'nHuyWiB7yP5Zw52FIkcQobQuGDXCTA',
              source: { type: 'user', userId: 'U4af4980629a1b2c3d4e5f60718293a4b' },
            },
          ],
        },
      },
    },
  })
  @ApiSuccess(200, { description: 'Accepted', type: LineWebhookAckDto, example: { handled: 1 } })
  @ApiStandardErrors(
    'webhook.signature_invalid',
    'webhook.malformed',
    'http.not_found',
    'http.malformed_json',
  )
  async callback(
    @Param('webhookKey') webhookKey: string,
    @Headers('x-line-signature') signature: string | undefined,
    @Req() req: RawBodyRequest,
  ): Promise<LineWebhookAckDto> {
    return this.channels.receive(webhookKey.slice(0, 64), signature, req.rawBody);
  }
}

const USAGE_EXAMPLE: MessagingUsageDto = {
  month: '2026-11',
  shared: {
    counted: 812,
    allowance: 1000,
    left: 188,
    usedPercent: 81,
    chargeable: 0,
    pricePerMessage: '0.1000',
    vatPercent: '7.00',
    estimatedCharge: '0.00',
    estimatedVat: '0.00',
  },
  own: { counted: 0, replies: 0 },
  quotaFallbacks: 0,
};

/** Message usage of the tenant (D-254). */
@ApiTags('owner.messaging')
@ApiSurface(SURFACES.owner)
@Controller('owner/messaging/usage')
export class OwnerMessagingUsageController {
  constructor(private readonly usage: MessagingUsageService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.settings.read')
  @ApiEndpoint({
    id: 'owner.messagingUsage.get',
    summary: 'My LINE messages this month',
    description:
      'Messages LINE counts through the shared getproperty OA against the free ones of the published rate (80 % / 100 % notices once a month), the estimated charge beyond them (billed on the monthly platform invoice), messages through my own OA (LINE bills me; replies free) and quota refusals that went by SMS (D-254).',
    implements: ['D-254'],
  })
  @ApiSuccess(200, { description: 'Usage', type: MessagingUsageDto, example: USAGE_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: MessagingUsageQuery,
  ): Promise<MessagingUsageDto> {
    return this.usage.summary(ctx, query.month);
  }
}

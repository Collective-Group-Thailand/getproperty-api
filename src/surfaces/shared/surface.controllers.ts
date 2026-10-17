import { TenantScoped } from '@common/auth/auth.decorators';
import { Public } from '@common/auth/auth.decorators';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { isUuid } from '@common/ids/uuidv7';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { ApiCursor } from '@common/pagination/api-paginated.decorator';
import { decodeCursor, encodeCursor } from '@common/pagination/cursor';
import { type CursorPage } from '@common/pagination/pagination.dto';
import { NotificationService } from '@core/notifications/notification.service';
import { type RenderedMessage } from '@core/notifications/renderer';
import { RealtimeHub } from '@core/realtime/realtime.hub';
import { TenantTx } from '@database/tenant-tx';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  type Type,
} from '@nestjs/common';
import { ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type Observable } from 'rxjs';

import { ApiSurface, type Surface, SURFACE_AUDIENCE } from '../surfaces';
import {
  InboxItemDto,
  InboxQuery,
  NotificationStateName,
  PushSubscriptionCreateDto,
  PushSubscriptionDto,
  RealtimeAuthDto,
  StreamQuery,
} from './common.dto';
import { currentUserId, iso, isoOrNull } from './mappers';

const named = (cls: Type<unknown>, name: string): Type<unknown> => {
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `GET /v1/{surface}/notifications` + `…/{id}/actions/read`: the in-app inbox of the signed-in user. */
export function notificationsController(surface: Surface): Type<unknown> {
  const tenantDoc = SURFACE_AUDIENCE[surface] === 'operator' ? TenantScoped() : () => undefined;

  @ApiTags(`${surface}.notifications`)
  @ApiSurface(surface)
  @Controller(`${surface}/notifications`)
  class InboxController {
    constructor(private readonly notifications: NotificationService) {}

    @Get()
    @tenantDoc
    @ApiEndpoint({
      id: `${surface}.notifications.list`,
      summary: 'List my in-app notifications',
      description:
        'The in-app inbox of the signed-in user across tenants, newest first (cursor feed). Other channels (LINE, SMS, email, web push) are listed in the delivery log, not here. B1.3 notifications.',
      implements: ['D-063', 'ADR-0003'],
    })
    @ApiCursor(InboxItemDto, {
      example: {
        id: '3b241101-e2bb-4255-8caf-4136c566a962',
        eventType: 'support_grant.requested',
        title: 'ขอสิทธิ์เข้าถึงจากทีมซัพพอร์ต',
        body: 'ทีมซัพพอร์ตขอสิทธิ์เข้าถึงข้อมูลชั่วคราว',
        state: NotificationStateName.Delivered,
        createdAt: '2026-11-01T00:15:00+07:00',
        readAt: null,
      } satisfies InboxItemDto,
    })
    @ApiStandardErrors('pagination.cursor_invalid', 'http.not_found')
    async list(@Query() query: InboxQuery): Promise<CursorPage<InboxItemDto>> {
      const userId = currentUserId();
      const position = decodeCursor(userId, query.cursor);
      const rows = await this.notifications.inbox(userId, { cursor: position?.id, limit: query.limit });
      const page = rows.slice(0, query.limit);
      return {
        data: page.map((n) => {
          const m = n.rendered as unknown as RenderedMessage | null;
          return {
            id: n.id,
            eventType: n.event?.type ?? null,
            title: m?.subject ?? null,
            body: m?.text ?? '',
            state: n.state as NotificationStateName,
            createdAt: iso(n.createdAt),
            readAt: isoOrNull(n.readAt),
          };
        }),
        meta: {
          nextCursor:
            rows.length > query.limit ? encodeCursor(userId, { id: page[page.length - 1]!.id }) : null,
        },
      };
    }

    @Post(':notificationId/actions/read')
    @HttpCode(204)
    @tenantDoc
    @ApiEndpoint({
      id: `${surface}.notifications.markRead`,
      summary: 'Mark a notification read',
      description:
        "Marks one of my in-app notifications read (idempotent). Another user's notification is a 404.",
      implements: ['D-063', 'ADR-0003'],
    })
    @ApiSuccess(204, { description: 'Marked read' })
    @ApiStandardErrors('http.not_found', 'validation.failed')
    async read(@Param('notificationId', ParseUUIDPipe) id: string): Promise<void> {
      await this.notifications.markRead(currentUserId(), id);
    }
  }
  return named(InboxController, `${cap(surface)}NotificationsController`);
}

/** Web push subscriptions of the signed-in user (VAPID; B1.3 channels). */
export function pushSubscriptionsController(surface: Surface): Type<unknown> {
  const tenantDoc = SURFACE_AUDIENCE[surface] === 'operator' ? TenantScoped() : () => undefined;

  @ApiTags(`${surface}.pushSubscriptions`)
  @ApiSurface(surface)
  @Controller(`${surface}/push-subscriptions`)
  class PushController {
    constructor(private readonly db: TenantTx) {}

    @Post()
    @Idempotent({ optional: true })
    @tenantDoc
    @ApiEndpoint({
      id: `${surface}.pushSubscriptions.create`,
      summary: 'Register a web push subscription',
      description:
        'Stores the browser PushSubscription of the signed-in user (endpoint + keys) for web push notifications; re-registering an endpoint updates it; an `Idempotency-Key` replays the first answer. Get the VAPID key from `auth.webPush.publicKey` (residents: the LIFF build carries it).',
      implements: ['D-063', 'ADR-0003'],
    })
    @ApiJsonBody(PushSubscriptionCreateDto, {
      endpoint: 'https://push.example.com/send/abc123',
      keys: {
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
        auth: 'tBHItJI5svbpez7KI4CCXg',
      },
    })
    @ApiSuccess(201, {
      description: 'Registered',
      type: PushSubscriptionDto,
      example: { id: '3b241101-e2bb-4255-8caf-4136c566a962', createdAt: '2026-11-01T00:15:00+07:00' },
    })
    @ApiStandardErrors('validation.failed', 'http.bad_request')
    async create(@Body() body: PushSubscriptionCreateDto): Promise<PushSubscriptionDto> {
      const userId = currentUserId();
      const ua = RequestContext.current()?.userAgent ?? null;
      const row = await this.db.platform((tx) =>
        tx.webPushSubscription.upsert({
          where: { endpoint: body.endpoint },
          create: {
            userId,
            endpoint: body.endpoint,
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            userAgent: ua,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            createdBy: userId,
          },
          update: {
            userId,
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            userAgent: ua,
            updatedBy: userId,
          },
        }),
      );
      return { id: row.id, createdAt: iso(row.createdAt) };
    }

    @Delete(':subscriptionId')
    @HttpCode(204)
    @tenantDoc
    @ApiEndpoint({
      id: `${surface}.pushSubscriptions.delete`,
      summary: 'Remove a web push subscription',
      description: 'Removes one of my push subscriptions (on sign-out or when the browser revokes it).',
      implements: ['D-063', 'ADR-0003'],
    })
    @ApiSuccess(204, { description: 'Removed' })
    @ApiStandardErrors('http.not_found', 'validation.failed')
    async remove(@Param('subscriptionId', ParseUUIDPipe) id: string): Promise<void> {
      const userId = currentUserId();
      const r = await this.db.platform((tx) => tx.webPushSubscription.deleteMany({ where: { id, userId } }));
      if (r.count === 0) throw new DomainException('http.not_found');
    }
  }
  return named(PushController, `${cap(surface)}PushSubscriptionsController`);
}

/** Realtime channels a caller of `surface` may hear (contract §6). */
export function realtimeChannels(surface: Surface): string[] {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  const channels = [`user:${actor.publicId}`];
  if (surface === 'owner' || surface === 'staff') {
    const tenant = RequestContext.tenant();
    if (!tenant) throw new DomainException('tenant.context_required');
    channels.push(`tenant:${tenant.tenantId}`);
    if (tenant.buildingIds) channels.push(...tenant.buildingIds.map((b) => `building:${b}`));
    else channels.push(`tenant:${tenant.tenantId}:buildings`);
  } else if (surface === 'resident') {
    channels.push(...actor.scopes.filter((s) => s.startsWith('unit:') || s.startsWith('lease:')));
  } else if (surface === 'technician') {
    channels.push(...actor.scopes.filter((s) => s.startsWith('work_order:')));
  } else if (surface === 'admin') {
    channels.push('platform');
  }
  return channels;
}

const SSE_EXAMPLE =
  'event: ready\ndata: {"channels":["user:3b241101-e2bb-4255-8caf-4136c566a962"]}\n\n' +
  'event: notification.created\ndata: {"type":"notification.created","ids":{"notificationId":"3b241101-e2bb-4255-8caf-4136c566a962"}}\n\n';

/** `POST /v1/{surface}/realtime/auth` + `GET /v1/{surface}/realtime/stream` (server-sent events). */
export function realtimeController(surface: Surface): Type<unknown> {
  const tenantDoc = SURFACE_AUDIENCE[surface] === 'operator' ? TenantScoped() : () => undefined;
  const audience = SURFACE_AUDIENCE[surface] ?? surface;

  @ApiTags(`${surface}.realtime`)
  @ApiSurface(surface)
  @Controller(`${surface}/realtime`)
  class RealtimeController {
    constructor(private readonly hub: RealtimeHub) {}

    @Post('auth')
    @HttpCode(200)
    @tenantDoc
    @ApiEndpoint({
      id: `${surface}.realtime.auth`,
      summary: 'Authorise a realtime stream',
      description:
        'Returns a 60-second token for the server-sent-event stream and the channels it carries: the user, and the tenant / buildings / units / work orders the token allows (contract §6). Events carry ids and type only; refetch through the API.',
      implements: ['D-002', 'ADR-0003'],
    })
    @ApiSuccess(200, {
      description: 'Stream token',
      type: RealtimeAuthDto,
      example: {
        streamToken: 'eyJzdWIiOiIuLi4ifQ.c2lnbmF0dXJl',
        streamUrl: `/v1/${surface}/realtime/stream?token=eyJzdWIiOiIuLi4ifQ.c2lnbmF0dXJl`,
        channels: ['user:3b241101-e2bb-4255-8caf-4136c566a962'],
        expiresAt: '2026-11-01T00:16:00+07:00',
      },
    })
    @ApiStandardErrors('http.not_found')
    authorise(): RealtimeAuthDto {
      const actor = RequestContext.actor();
      const channels = realtimeChannels(surface);
      const { token, expiresAt } = this.hub.issueStreamToken(
        actor?.type === 'user' ? actor.publicId : '',
        audience,
        channels,
      );
      return {
        streamToken: token,
        streamUrl: `/v1/${surface}/realtime/stream?token=${encodeURIComponent(token)}`,
        channels,
        expiresAt: iso(expiresAt),
      };
    }

    @Get('stream')
    @Sse()
    @Public()
    @ApiEndpoint({
      id: `${surface}.realtime.stream`,
      summary: 'Realtime stream (server-sent events)',
      description:
        'Opens the SSE stream authorised by `realtime/auth` (token in the query string because EventSource cannot send headers). Events: `ready`, `heartbeat` every 25 s, then `<event type>` with `{ type, ids }`.',
      implements: ['D-002', 'ADR-0003'],
    })
    @ApiProduces('text/event-stream')
    @ApiResponse({
      status: 200,
      description: 'Event stream',
      content: { 'text/event-stream': { schema: { type: 'string' }, example: SSE_EXAMPLE } },
    })
    @ApiStandardErrors('realtime.token_invalid', 'validation.failed')
    stream(@Query() query: StreamQuery): Observable<MessageEvent> {
      const claims = this.hub.verifyStreamToken(query.token, audience);
      if (!isUuid(claims.sub)) throw new DomainException('realtime.token_invalid');
      return this.hub.stream(claims.ch);
    }
  }
  return named(RealtimeController, `${cap(surface)}RealtimeController`);
}

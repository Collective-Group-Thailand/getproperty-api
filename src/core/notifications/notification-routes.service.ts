import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { TenantTx } from '@database/tenant-tx';
import { type NotificationAudience, type NotificationChannel } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../events/domain-events';

/** Audiences whose routes a tenant may override (resident-facing events, B1.3 routing matrix). */
export const TENANT_ROUTABLE_AUDIENCES: readonly NotificationAudience[] = ['resident'];

export interface RouteView {
  eventType: string;
  audience: NotificationAudience;
  channel: NotificationChannel;
  enabled: boolean;
  urgent: boolean;
  overridden: boolean;
}

/**
 * Routing matrix (`platform.notification_route`, event × audience × channel): platform defaults (`tenant_id` NULL)
 * and tenant overrides for resident-facing events. Changing a route is audited and evented.
 */
@Injectable()
export class NotificationRoutesService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  /** Effective routes of a tenant for the routable audiences. */
  async forTenant(ctx: TenantContext): Promise<RouteView[]> {
    return this.db.tenant(ctx, async (tx) => {
      const rows = await tx.notificationRoute.findMany({
        where: {
          audience: { in: [...TENANT_ROUTABLE_AUDIENCES] },
          OR: [{ tenantId: null }, { tenantId: ctx.tenantId }],
        },
        orderBy: [{ eventType: 'asc' }, { channel: 'asc' }],
      });
      const out = new Map<string, RouteView>();
      for (const r of rows) {
        const k = `${r.eventType}|${r.audience}|${r.channel}`;
        if (out.has(k) && !r.tenantId) continue;
        out.set(k, {
          eventType: r.eventType,
          audience: r.audience,
          channel: r.channel,
          enabled: r.enabled,
          urgent: r.urgent,
          overridden: Boolean(r.tenantId),
        });
      }
      return [...out.values()];
    });
  }

  async setTenant(
    ctx: TenantContext,
    input: {
      eventType: string;
      audience: NotificationAudience;
      channel: NotificationChannel;
      enabled: boolean;
    },
  ): Promise<RouteView> {
    const actor = userIdOf(RequestContext.actor());
    return this.db.tenant(ctx, async (tx) => {
      const platformDefault = await tx.notificationRoute.findFirst({
        where: {
          tenantId: null,
          eventType: input.eventType,
          audience: input.audience,
          channel: input.channel,
        },
      });
      const existing = await tx.notificationRoute.findFirst({
        where: {
          tenantId: ctx.tenantId,
          eventType: input.eventType,
          audience: input.audience,
          channel: input.channel,
        },
      });
      const urgent = existing?.urgent ?? platformDefault?.urgent ?? false;
      const row = existing
        ? await tx.notificationRoute.update({
            where: { id: existing.id },
            data: { enabled: input.enabled, updatedBy: actor },
          })
        : await tx.notificationRoute.create({
            data: { tenantId: ctx.tenantId, ...input, urgent, createdBy: actor, updatedBy: actor },
          });
      await this.audit.record(tx, {
        action: 'notification.route_changed',
        tenantId: ctx.tenantId,
        subjectType: 'platform.notification_route',
        subjectId: row.id,
        before: existing
          ? { enabled: existing.enabled }
          : platformDefault
            ? { enabled: platformDefault.enabled, default: true }
            : undefined,
        after: { enabled: row.enabled },
      });
      await this.events.record(tx, {
        type: 'notification.route_changed',
        aggregateType: 'platform.notification_route',
        aggregateId: row.id,
        tenantId: ctx.tenantId,
        payload: {
          eventType: row.eventType,
          audience: row.audience,
          channel: row.channel,
          enabled: row.enabled,
        },
      });
      return {
        eventType: row.eventType,
        audience: row.audience,
        channel: row.channel,
        enabled: row.enabled,
        urgent: row.urgent,
        overridden: true,
      };
    });
  }
}

import { LINE_MESSAGING, type LineMessagingPort } from '@collective/integrations/line';
import { TenantTx } from '@database/tenant-tx';
import { type Notification } from '@generated/prisma/client';
import { EMAIL, type EmailPort } from '@integrations/email/email.port';
import { SMS, type SmsPort } from '@integrations/sms/sms.port';
import { WEB_PUSH, type WebPushPort } from '@integrations/web-push/web-push.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { MessagingChannelsService } from '../messaging/messaging-channels.service';
import { RealtimeHub } from '../realtime/realtime.hub';
import { type RenderedMessage } from './renderer';

export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Sends one queued notification through its channel adapter (worker job `gp-notifications`). The row is locked for
 * the duration of the send (`FOR UPDATE SKIP LOCKED`), so a duplicate job cannot send twice; LINE pushes carry the
 * notification id as `X-Line-Retry-Key`. The delivery log keeps the provider and its message id; failures retry
 * with backoff and end as `failed` after MAX_DELIVERY_ATTEMPTS. In-app messages are delivered at once and announced
 * on the realtime channel of the user.
 */
@Injectable()
export class NotificationDelivery {
  private readonly logger = new Logger(NotificationDelivery.name);

  constructor(
    private readonly db: TenantTx,
    private readonly realtime: RealtimeHub,
    private readonly channels: MessagingChannelsService,
    @Inject(SMS) private readonly sms: SmsPort,
    @Inject(LINE_MESSAGING) private readonly line: LineMessagingPort,
    @Inject(EMAIL) private readonly email: EmailPort,
    @Inject(WEB_PUSH) private readonly webPush: WebPushPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async deliver(notificationId: string): Promise<'sent' | 'skipped' | 'failed' | 'retry'> {
    const now = this.clock.now();
    const outcome = await this.db.platform(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM platform.notification
         WHERE id = ${notificationId}::uuid AND state = 'queued' AND scheduled_for <= ${now.toISOString()}::timestamptz
         FOR UPDATE SKIP LOCKED`;
      if (!rows.length) return { status: 'skipped' as const };
      const n = await tx.notification.findUniqueOrThrow({ where: { id: notificationId } });
      const attempts = n.attempts + 1;
      try {
        const result = await this.send(tx, n);
        await tx.notification.update({
          where: { id: n.id },
          data: {
            attempts,
            state: result.state,
            sentAt: result.state === 'cancelled' ? null : now,
            deliveredAt: result.state === 'delivered' ? now : null,
            provider: result.provider,
            providerMessageId: result.providerMessageId,
            failedReason: result.reason ?? null,
          },
        });
        return { status: 'sent' as const, notification: n, inApp: result.state === 'delivered' };
      } catch (error) {
        const last = attempts >= MAX_DELIVERY_ATTEMPTS;
        await tx.notification.update({
          where: { id: n.id },
          data: {
            attempts,
            ...(last ? { state: 'failed' } : {}),
            failedReason: (error as Error).message.slice(0, 500),
          },
        });
        this.logger.warn(
          `notification ${n.id} (${n.channel}) attempt ${attempts} failed: ${(error as Error).message}`,
        );
        return { status: last ? ('failed' as const) : ('retry' as const), error };
      }
    });
    if (outcome.status === 'sent' && outcome.inApp && outcome.notification.recipientId)
      await this.realtime.publish({
        type: 'notification.created',
        ids: { notificationId: outcome.notification.id },
        channels: [`user:${outcome.notification.recipientId}`],
      });
    if (outcome.status === 'retry') throw outcome.error as Error;
    return outcome.status;
  }

  private async send(
    tx: Parameters<Parameters<TenantTx['platform']>[0]>[0],
    n: Notification,
  ): Promise<{
    state: 'sent' | 'delivered' | 'cancelled';
    provider: string | null;
    providerMessageId: string | null;
    reason?: string;
  }> {
    const message = n.rendered as unknown as RenderedMessage | null;
    if (!message) throw new Error('notification has no rendered content');
    switch (n.channel) {
      case 'in_app':
        return { state: 'delivered', provider: 'in_app', providerMessageId: null };
      case 'sms': {
        const r = await this.sms.send(n.recipientAddress!, message.text);
        return {
          state: 'sent',
          provider: this.sms.mode === 'fake' ? 'fake-sms' : 'sms',
          providerMessageId: r.providerMessageId,
        };
      }
      case 'line': {
        const payload = message.flex
          ? [{ type: 'flex' as const, altText: message.text.slice(0, 400), contents: message.flex }]
          : [{ type: 'text' as const, text: message.text.slice(0, 5000) }];
        // D-254: the operator's own OA (building → tenant) when the resident linked it; else the shared OA.
        const own = n.recipientId ? await this.channels.channelFor(tx, n.tenantId, n.buildingId) : null;
        const linked =
          own && n.recipientId
            ? await this.channels.linkedUser(tx, own.id, { type: n.recipientType, id: n.recipientId })
            : null;
        if (own && linked) {
          const r = await this.channels.push(tx, own, linked.lineUserId, payload, n.id);
          return {
            state: 'sent',
            provider: `${this.line.mode === 'fake' ? 'fake-line' : 'line'}:${own.id}`,
            providerMessageId: r.providerMessageId,
          };
        }
        const r = await this.line.push(n.recipientAddress!, payload, n.id);
        return {
          state: 'sent',
          provider: this.line.mode === 'fake' ? 'fake-line' : 'line',
          providerMessageId: r.providerMessageId,
        };
      }
      case 'email': {
        const r = await this.email.send({
          to: n.recipientAddress!,
          subject: message.subject ?? 'getproperty',
          html: message.html ?? message.text,
          text: message.text,
        });
        return {
          state: 'sent',
          provider: this.email.mode === 'fake' ? 'fake-email' : 'ses',
          providerMessageId: r.providerMessageId,
        };
      }
      case 'web_push': {
        const subs = await tx.webPushSubscription.findMany({ where: { userId: n.recipientId ?? undefined } });
        if (!subs.length)
          return {
            state: 'cancelled',
            provider: null,
            providerMessageId: null,
            reason: 'no push subscription',
          };
        let sent = 0;
        for (const s of subs) {
          const r = await this.webPush.send(
            s,
            JSON.stringify({
              title: message.subject ?? 'getproperty',
              body: message.text,
              notificationId: n.id,
            }),
            86_400,
          );
          if (r === 'gone') await tx.webPushSubscription.delete({ where: { id: s.id } });
          else sent += 1;
        }
        return sent
          ? { state: 'sent', provider: 'web_push', providerMessageId: null }
          : {
              state: 'cancelled',
              provider: null,
              providerMessageId: null,
              reason: 'push subscriptions expired',
            };
      }
    }
  }
}

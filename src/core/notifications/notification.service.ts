import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type Notification,
  type NotificationAudience,
  type NotificationChannel,
  type NotificationState,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { type DomainEventEnvelope } from '../events/domain-events';
import { QUEUE, QUEUE_NAMES, type QueuePort } from '../queue/queue.port';
import { SettingsService } from '../settings/settings.service';
import { type NotificationPlanInput, type Recipient } from './notifiable-events';
import { type QuietHours, quietUntil } from './quiet-hours';
import { renderTemplate, TemplateRenderError } from './renderer';
import { LOCKED_TOPICS, TOPIC_CHANNELS, topicOf } from './topic-preferences';

export interface DeliveryJob {
  notificationId: string;
}

const RESIDENT_AUDIENCES: NotificationAudience[] = ['resident', 'technician'];

/**
 * Plans notifications for a domain event (subscriber `notifications`, worker): routing matrix event × audience ×
 * channel (tenant overrides win over platform defaults), the recipient's channel preferences, PDPA consent gating
 * for residents (D-025: `held_no_consent` until the purpose is granted), quiet hours for non-urgent resident
 * messages (`held_quiet_hours` until the window ends), template selection by language, and one row per
 * (event, recipient, channel) — idempotent by the unique index. Deliveries are queued after the commit.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Channels for an event and audience: tenant routes override platform defaults per channel. */
  async channelsFor(tx: Tx, tenantId: string | null, eventType: string, audience: NotificationAudience) {
    const routes = await tx.notificationRoute.findMany({
      where: { eventType, audience, OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])] },
    });
    const byChannel = new Map<NotificationChannel, { enabled: boolean; urgent: boolean; tenant: boolean }>();
    for (const r of routes) {
      const existing = byChannel.get(r.channel);
      if (!existing || (r.tenantId && !existing.tenant))
        byChannel.set(r.channel, { enabled: r.enabled, urgent: r.urgent, tenant: Boolean(r.tenantId) });
    }
    return [...byChannel.entries()]
      .filter(([, v]) => v.enabled)
      .map(([channel, v]) => ({ channel, urgent: v.urgent }));
  }

  private async consentGranted(tx: Tx, recipient: Recipient, purpose: string): Promise<boolean> {
    const subjects: { type: 'user' | 'party'; id: string }[] = [{ type: recipient.type, id: recipient.id }];
    if (recipient.type === 'party') {
      const links = await tx.partyUserLink.findMany({
        where: { partyId: recipient.id, state: 'active' },
        select: { userId: true },
      });
      subjects.push(...links.map((l) => ({ type: 'user' as const, id: l.userId })));
    }
    for (const s of subjects) {
      const rows = await tx.$queryRaw<{ granted: boolean }[]>`
        SELECT granted FROM platform.v_consent_state
         WHERE subject_type = ${s.type}::platform.consent_subject AND subject_id = ${s.id}::uuid AND purpose_key = ${purpose}
           AND (tenant_id IS NULL OR ${recipient.tenantId}::uuid IS NULL OR tenant_id = ${recipient.tenantId}::uuid)`;
      if (rows.some((r) => r.granted)) return true;
    }
    return false;
  }

  private async quietHours(
    tx: Tx,
    recipient: Recipient,
    channel: NotificationChannel,
    now: Date,
  ): Promise<QuietHours> {
    const pref = await tx.notificationPreference.findFirst({
      where:
        recipient.type === 'user' ? { userId: recipient.id, channel } : { partyId: recipient.id, channel },
    });
    const fallback = await this.settings.valueAt<QuietHours>('notifications.quiet_hours', now, {
      tenantId: recipient.tenantId,
    });
    if (pref?.quietHoursStart && pref.quietHoursEnd) {
      const hhmm = (d: Date) => d.toISOString().slice(11, 16);
      return {
        start: hhmm(pref.quietHoursStart),
        end: hhmm(pref.quietHoursEnd),
        timezone: fallback.timezone,
      };
    }
    return fallback;
  }

  /**
   * LIFF #10 (D-203): a resident who switched a topic off on a channel does not get it there. The choice belongs to
   * the login(s) linked to the party; the message is skipped only when every linked login switched it off. Locked
   * topics (billing, lease) and other channels are never skipped.
   */
  private async topicDisabled(
    tx: Tx,
    recipient: Recipient,
    channel: NotificationChannel,
    templateKey: string,
  ): Promise<boolean> {
    if (!RESIDENT_AUDIENCES.includes(recipient.audience) || !TOPIC_CHANNELS.includes(channel)) return false;
    const topic = topicOf(templateKey);
    if (!topic || LOCKED_TOPICS.includes(topic)) return false;
    const userIds =
      recipient.type === 'user'
        ? [recipient.id]
        : (
            await tx.partyUserLink.findMany({
              where: { partyId: recipient.id, state: 'active' },
              select: { userId: true },
            })
          ).map((l) => l.userId);
    if (!userIds.length) return false;
    const off = await tx.notificationTopicPreference.count({
      where: { userId: { in: userIds }, topic, channel, enabled: false },
    });
    return off === userIds.length;
  }

  private address(recipient: Recipient, channel: NotificationChannel): string | null | undefined {
    switch (channel) {
      case 'line':
        return recipient.line;
      case 'sms':
        return recipient.phone;
      case 'email':
        return recipient.email;
      default:
        return undefined;
    }
  }

  /** Writes the notification rows of an event (inside the subscriber's transaction); returns the queued ids. */
  async plan(tx: Tx, event: DomainEventEnvelope, input: NotificationPlanInput): Promise<string[]> {
    const now = this.clock.now();
    const queued: string[] = [];
    const templateKey = input.templateKey ?? event.type;
    for (const recipient of input.recipients) {
      const channels = input.channels
        ? input.channels.map((channel) => ({ channel, urgent: input.urgent ?? false }))
        : await this.channelsFor(tx, recipient.tenantId, templateKey, recipient.audience);
      for (const { channel, urgent: routeUrgent } of channels) {
        const urgent = input.urgent === true || routeUrgent;
        const pref = await tx.notificationPreference.findFirst({
          where:
            recipient.type === 'user'
              ? { userId: recipient.id, channel }
              : { partyId: recipient.id, channel },
        });
        let state: NotificationState = 'queued';
        let scheduledFor = now;
        let failedReason: string | null = null;
        const address = this.address(recipient, channel);
        if (pref && !pref.enabled) {
          state = 'cancelled';
          failedReason = 'channel disabled by the recipient';
        } else if (await this.topicDisabled(tx, recipient, channel, templateKey)) {
          state = 'cancelled';
          failedReason = 'topic disabled by the recipient';
        } else if (address === null) {
          state = 'cancelled';
          failedReason = `no ${channel} address`;
        } else if (channel === 'web_push' && recipient.type !== 'user') {
          state = 'cancelled';
          failedReason = 'web push needs a user';
        } else if (
          RESIDENT_AUDIENCES.includes(recipient.audience) &&
          !(await this.consentGranted(tx, recipient, input.consentPurpose ?? 'resident.service'))
        ) {
          state = 'held_no_consent';
        } else if (RESIDENT_AUDIENCES.includes(recipient.audience) && !urgent && channel !== 'in_app') {
          const until = quietUntil(now, await this.quietHours(tx, recipient, channel, now));
          if (until) {
            state = 'held_quiet_hours';
            scheduledFor = until;
          }
        }
        const version = await this.templateVersion(
          tx,
          templateKey,
          channel,
          recipient.audience,
          recipient.language,
        );
        let rendered: Prisma.InputJsonValue | undefined;
        if (!version) {
          // a cancelled message keeps the reason it was cancelled; otherwise the missing template is the failure
          if (state !== 'cancelled') {
            state = 'failed';
            failedReason = `no published template ${templateKey}/${channel}/${recipient.audience}`;
          }
        } else {
          try {
            rendered = (await renderTemplate(version, {
              ...input.data,
              recipient: { language: recipient.language },
            })) as unknown as Prisma.InputJsonValue;
          } catch (error) {
            state = 'failed';
            failedReason = error instanceof TemplateRenderError ? error.message : String(error);
          }
        }
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO platform.notification (tenant_id, building_id, event_id, template_version_id, recipient_type, recipient_id,
                                             recipient_address, channel, state, scheduled_for, failed_reason, rendered)
          VALUES (${recipient.tenantId}::uuid, ${event.buildingId}::uuid, ${event.id}::uuid, ${version?.id ?? null}::uuid,
                  ${recipient.type}::platform.notification_recipient, ${recipient.id}::uuid, ${address ?? null},
                  ${channel}::platform.notification_channel, ${state}::platform.notification_state,
                  ${scheduledFor.toISOString()}::timestamptz, ${failedReason}, ${rendered === undefined ? null : JSON.stringify(rendered)}::jsonb)
          ON CONFLICT (event_id, recipient_type, recipient_id, channel) WHERE event_id IS NOT NULL DO NOTHING
          RETURNING id`;
        if (rows[0] && state === 'queued') queued.push(rows[0].id);
      }
    }
    return queued;
  }

  private async templateVersion(
    tx: Tx,
    key: string,
    channel: NotificationChannel,
    audience: NotificationAudience,
    language: string,
  ) {
    // Operator roles without their own template fall back to the owner template.
    const candidates = await tx.notificationTemplate.findMany({
      where: {
        key,
        channel,
        audience: RESIDENT_AUDIENCES.includes(audience) ? audience : { in: [audience, 'owner'] },
      },
      include: { versions: { where: { state: 'published' } } },
    });
    const template = candidates.find((t) => t.audience === audience) ?? candidates[0];
    if (!template) return null;
    return (
      template.versions.find((v) => v.language === language) ??
      template.versions.find((v) => v.language === 'th') ??
      template.versions[0] ??
      null
    );
  }

  async enqueue(ids: string[], delayMs = 0): Promise<void> {
    for (const id of ids)
      await this.queue.add<DeliveryJob>(
        QUEUE_NAMES.notifications,
        'deliver',
        { notificationId: id },
        { jobId: `n-${id}`, delayMs, attempts: 5 },
      );
  }

  /** Maintenance: held quiet-hours messages whose window ended go back to the queue. */
  async releaseHeld(): Promise<number> {
    const now = this.clock.now();
    const rows = await this.db.platform(
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
        UPDATE platform.notification SET state = 'queued'
         WHERE state = 'held_quiet_hours' AND scheduled_for <= ${now.toISOString()}::timestamptz
        RETURNING id`,
    );
    await this.enqueue(rows.map((r) => r.id));
    return rows.length;
  }

  /** After a consent is granted: messages held for it (≤ 7 days old) are re-planned for quiet hours and queued. */
  async releaseForConsent(tx: Tx, subject: { type: 'user' | 'party'; id: string }): Promise<string[]> {
    const since = new Date(this.clock.now().getTime() - 7 * 86_400_000);
    const partyIds =
      subject.type === 'user'
        ? (
            await tx.partyUserLink.findMany({
              where: { userId: subject.id, state: 'active' },
              select: { partyId: true },
            })
          ).map((l) => l.partyId)
        : [subject.id];
    const rows = await tx.notification.findMany({
      where: {
        state: 'held_no_consent',
        createdAt: { gt: since },
        OR: [
          { recipientType: 'party', recipientId: { in: partyIds } },
          ...(subject.type === 'user' ? [{ recipientType: 'user' as const, recipientId: subject.id }] : []),
        ],
      },
    });
    const ids: string[] = [];
    const now = this.clock.now();
    for (const n of rows) {
      const recipient = { type: n.recipientType, id: n.recipientId, tenantId: n.tenantId } as Recipient;
      const until =
        n.channel === 'in_app' ? null : quietUntil(now, await this.quietHours(tx, recipient, n.channel, now));
      if (until) {
        await tx.notification.update({
          where: { id: n.id },
          data: { state: 'held_quiet_hours', scheduledFor: until },
        });
        continue;
      }
      await tx.notification.update({ where: { id: n.id }, data: { state: 'queued', scheduledFor: now } });
      ids.push(n.id);
    }
    return ids;
  }

  /** In-app inbox of a user (all tenants), newest first. */
  inbox(userId: string, input: { cursor?: string; limit: number }) {
    return this.db.platform((tx) =>
      tx.notification.findMany({
        where: {
          recipientType: 'user',
          recipientId: userId,
          channel: 'in_app',
          state: { in: ['delivered', 'read', 'sent'] },
          ...(input.cursor ? { id: { lt: input.cursor } } : {}),
        },
        include: { event: { select: { type: true } } },
        orderBy: { id: 'desc' },
        take: input.limit + 1,
      }),
    );
  }

  async markRead(userId: string, notificationId: string): Promise<Notification> {
    return this.db.platform(async (tx) => {
      const n = await tx.notification.findFirst({
        where: { id: notificationId, recipientType: 'user', recipientId: userId, channel: 'in_app' },
      });
      if (!n) throw new DomainException('http.not_found');
      return n.state === 'read'
        ? n
        : tx.notification.update({ where: { id: n.id }, data: { state: 'read', readAt: this.clock.now() } });
    });
  }
}

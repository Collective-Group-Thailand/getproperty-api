import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import { type NotificationChannel, type NotificationTopic } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { LOCKED_TOPICS, NOTIFICATION_TOPICS } from './topic-preferences';

export interface TopicPreference {
  topic: NotificationTopic;
  line: boolean;
  sms: boolean;
  locked: boolean;
}

/**
 * The resident's notification preferences per topic (LIFF #10, D-203): LINE and SMS per topic, on unless switched
 * off; billing and lease notices are locked on (422 when a client tries). Stored per login
 * (`platform.notification_topic_preference`) and honoured by the notification planner for every tenant the login is
 * linked to. Changes are audited.
 */
@Injectable()
export class TopicPreferencesService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
  ) {}

  private userId(): string {
    const id = userIdOf(RequestContext.actor());
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  async list(): Promise<TopicPreference[]> {
    const userId = this.userId();
    const rows = await this.db.platform((tx) =>
      tx.notificationTopicPreference.findMany({ where: { userId } }),
    );
    const value = (topic: NotificationTopic, channel: NotificationChannel) =>
      LOCKED_TOPICS.includes(topic) ||
      (rows.find((r) => r.topic === topic && r.channel === channel)?.enabled ?? true);
    return NOTIFICATION_TOPICS.map((topic) => ({
      topic,
      line: value(topic, 'line'),
      sms: value(topic, 'sms'),
      locked: LOCKED_TOPICS.includes(topic),
    }));
  }

  async update(
    items: { topic: NotificationTopic; line: boolean; sms: boolean }[],
  ): Promise<TopicPreference[]> {
    const userId = this.userId();
    const errors = items.flatMap((item, i) =>
      LOCKED_TOPICS.includes(item.topic) && (!item.line || !item.sms)
        ? [
            {
              path: `items.${i}`,
              code: 'locked',
              message: `${item.topic} notices cannot be switched off`,
            },
          ]
        : [],
    );
    const topics = items.map((i) => i.topic);
    if (new Set(topics).size !== topics.length)
      errors.push({ path: 'items', code: 'duplicate', message: 'each topic at most once' });
    if (errors.length) throw new DomainException('validation.failed', { errors });
    await this.db.platform(async (tx) => {
      for (const item of items) {
        if (LOCKED_TOPICS.includes(item.topic)) continue;
        for (const channel of ['line', 'sms'] as const)
          await tx.notificationTopicPreference.upsert({
            where: { userId_topic_channel: { userId, topic: item.topic, channel } },
            create: { userId, topic: item.topic, channel, enabled: item[channel] },
            update: { enabled: item[channel] },
          });
      }
      await this.audit.record(tx, {
        action: 'notification.preferences_changed',
        subjectType: 'core.user_account',
        subjectId: userId,
        after: { items },
      });
    });
    return this.list();
  }
}

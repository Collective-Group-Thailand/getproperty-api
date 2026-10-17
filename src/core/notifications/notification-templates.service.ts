import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import {
  type NotificationAudience,
  type NotificationChannel,
  type Prisma,
  type TemplateFormat,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { type RenderedMessage, renderTemplate, TemplateRenderError } from './renderer';

/** Formats each channel accepts (LINE Flex JSON only on LINE, MJML only on email). */
export const CHANNEL_FORMATS: Record<NotificationChannel, readonly TemplateFormat[]> = {
  line: ['handlebars_text', 'line_flex_json', 'plain'],
  sms: ['handlebars_text', 'plain'],
  email: ['mjml', 'handlebars_text', 'plain'],
  in_app: ['handlebars_text', 'plain'],
  web_push: ['handlebars_text', 'plain'],
};

export interface TemplateVersionInput {
  key: string;
  channel: NotificationChannel;
  audience: NotificationAudience;
  description?: string;
  language: 'th' | 'en';
  format: TemplateFormat;
  subject?: string | null;
  body: string;
  sampleData?: Record<string, unknown>;
}

/**
 * Notification templates (B1.3): versioned per language; a new version is a draft, rendered against its sample data
 * before it is stored (a template that does not render is refused), previewed, then published — publishing retires
 * the previously published version of that language. Test sends go through the normal pipeline
 * (`notification.test_requested` event → notifications subscriber).
 */
@Injectable()
export class NotificationTemplatesService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(key?: string) {
    return this.db.platform((tx) =>
      tx.notificationTemplate.findMany({
        where: key ? { key } : {},
        include: { versions: { orderBy: [{ language: 'asc' }, { version: 'desc' }] } },
        orderBy: [{ key: 'asc' }, { channel: 'asc' }, { audience: 'asc' }],
      }),
    );
  }

  private async render(
    format: TemplateFormat,
    subject: string | null,
    body: string,
    data: Record<string, unknown>,
  ) {
    try {
      return await renderTemplate({ format, subject, body }, data);
    } catch (error) {
      if (error instanceof TemplateRenderError)
        throw new DomainException('notification.template_invalid', {
          errors: [{ path: 'body', code: 'render', message: error.message }],
        });
      throw error;
    }
  }

  async createVersion(input: TemplateVersionInput) {
    if (!CHANNEL_FORMATS[input.channel].includes(input.format))
      throw new DomainException('notification.template_invalid', {
        errors: [
          { path: 'format', code: 'isIn', message: `${input.format} is not accepted on ${input.channel}` },
        ],
      });
    await this.render(input.format, input.subject ?? null, input.body, input.sampleData ?? {});
    const actor = userIdOf(RequestContext.actor());
    return this.db.platform(async (tx) => {
      const template = await tx.notificationTemplate.upsert({
        where: { key_channel_audience: { key: input.key, channel: input.channel, audience: input.audience } },
        create: {
          key: input.key,
          channel: input.channel,
          audience: input.audience,
          description: input.description ?? input.key,
          createdBy: actor,
          updatedBy: actor,
        },
        update: input.description ? { description: input.description, updatedBy: actor } : {},
      });
      const last = await tx.notificationTemplateVersion.findFirst({
        where: { templateId: template.id, language: input.language },
        orderBy: { version: 'desc' },
      });
      const version = await tx.notificationTemplateVersion.create({
        data: {
          templateId: template.id,
          version: (last?.version ?? 0) + 1,
          language: input.language,
          subject: input.subject ?? null,
          body: input.body,
          format: input.format,
          sampleData: (input.sampleData ?? {}) as Prisma.InputJsonValue,
          createdBy: actor,
          updatedBy: actor,
        },
      });
      await this.audit.record(tx, {
        action: 'notification.template_created',
        subjectType: 'platform.notification_template_version',
        subjectId: version.id,
        after: {
          key: input.key,
          channel: input.channel,
          audience: input.audience,
          language: input.language,
          version: version.version,
        },
      });
      return { template, version };
    });
  }

  async preview(versionId: string, data?: Record<string, unknown>): Promise<RenderedMessage> {
    const v = await this.db.platform((tx) =>
      tx.notificationTemplateVersion.findUnique({ where: { id: versionId } }),
    );
    if (!v) throw new DomainException('http.not_found');
    return this.render(v.format, v.subject, v.body, data ?? (v.sampleData as Record<string, unknown>));
  }

  async publish(versionId: string) {
    const actor = userIdOf(RequestContext.actor());
    return this.db.platform(async (tx) => {
      const v = await tx.notificationTemplateVersion.findUnique({
        where: { id: versionId },
        include: { template: true },
      });
      if (!v) throw new DomainException('http.not_found');
      if (v.state !== 'draft') throw new DomainException('http.conflict');
      await tx.notificationTemplateVersion.updateMany({
        where: { templateId: v.templateId, language: v.language, state: 'published' },
        data: { state: 'retired', updatedBy: actor },
      });
      const published = await tx.notificationTemplateVersion.update({
        where: { id: v.id },
        data: { state: 'published', publishedAt: this.clock.now(), publishedBy: actor, updatedBy: actor },
      });
      await this.audit.record(tx, {
        action: 'notification.template_published',
        subjectType: 'platform.notification_template_version',
        subjectId: v.id,
        after: {
          key: v.template.key,
          channel: v.template.channel,
          audience: v.template.audience,
          language: v.language,
          version: v.version,
        },
      });
      await this.events.record(tx, {
        type: 'notification.template_published',
        aggregateType: 'platform.notification_template',
        aggregateId: v.templateId,
        tenantId: null,
        payload: {
          key: v.template.key,
          channel: v.template.channel,
          language: v.language,
          version: v.version,
        },
      });
      return { template: v.template, version: published };
    });
  }

  /** Queues a test send of the template's published version to one platform user (or a given user/party). */
  async testSend(templateId: string, input: { recipientUserId?: string; data?: Record<string, unknown> }) {
    const actorId = userIdOf(RequestContext.actor());
    const recipientId = input.recipientUserId ?? actorId;
    if (!recipientId) throw new DomainException('http.bad_request');
    return this.db.platform(async (tx) => {
      const t = await tx.notificationTemplate.findUnique({
        where: { id: templateId },
        include: { versions: { where: { state: 'published' }, take: 1 } },
      });
      if (!t) throw new DomainException('http.not_found');
      const user = await tx.userAccount.findUnique({ where: { id: recipientId } });
      if (!user) throw new DomainException('http.not_found');
      const sample = (t.versions[0]?.sampleData ?? {}) as Record<string, unknown>;
      const event = await this.events.record(tx, {
        type: 'notification.test_requested',
        aggregateType: 'platform.notification_template',
        aggregateId: t.id,
        tenantId: null,
        payload: {
          templateKey: t.key,
          channel: t.channel,
          audience: t.audience,
          recipientType: 'user',
          recipientId,
          data: input.data ?? sample,
          urgent: true,
        },
      });
      await this.audit.record(tx, {
        action: 'notification.test_sent',
        subjectType: 'platform.notification_template',
        subjectId: t.id,
        metadata: { channel: t.channel, recipientUserId: recipientId },
      });
      return { eventId: event.id };
    });
  }
}

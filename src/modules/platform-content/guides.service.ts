import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { TenantTx } from '@database/tenant-tx';
import { type Guide, type GuideAudience, type GuideCategory, Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { type GuideBody, guideBodyProblems } from './guide-content';

export interface GuideInput {
  slug: string;
  locale: 'th' | 'en';
  category: GuideCategory;
  audience: GuideAudience;
  title: string;
  summary: string;
  answer: string;
  readMinutes: number;
  general: boolean;
  reviewedOn: string;
  publishedOn: string;
  sections: unknown;
  faq: unknown;
  sources: unknown;
}

export type GuidePatch = Partial<Omit<GuideInput, 'slug' | 'locale'>>;

const day = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * Guides of the public site (B7.13, D-271): the platform team writes them (draft), another platform user reviews and
 * publishes them (`reviewedBy`, maker-checker like the message rates), and the public read serves published ones
 * per locale. The body is the shared article shape (`guide-content.ts`), refused when the page could not draw it.
 */
@Injectable()
export class GuidesService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private check(input: {
    sections?: unknown;
    faq?: unknown;
    sources?: unknown;
    reviewedOn?: string;
    publishedOn?: string;
  }) {
    const errors = guideBodyProblems(input).map((message) => ({
      path: message.split(':')[0]!,
      code: 'invalid',
      message,
    }));
    if (input.reviewedOn && input.publishedOn && input.reviewedOn < input.publishedOn)
      errors.push({ path: 'reviewedOn', code: 'invalid', message: 'reviewedOn: not before publishedOn' });
    if (errors.length) throw new DomainException('validation.failed', { errors });
  }

  list(filter: { locale?: string; state?: 'draft' | 'published' }) {
    return this.db.platform((tx) =>
      tx.guide.findMany({
        where: {
          ...(filter.locale ? { locale: filter.locale } : {}),
          ...(filter.state ? { state: filter.state } : {}),
        },
        orderBy: [{ slug: 'asc' }, { locale: 'asc' }],
        take: 500,
      }),
    );
  }

  async get(id: string): Promise<Guide> {
    const row = await this.db.platform((tx) => tx.guide.findUnique({ where: { id } }));
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  async create(userId: string, input: GuideInput): Promise<Guide> {
    this.check(input);
    return this.db.platform(async (tx) => {
      const taken = await tx.guide.findUnique({
        where: { slug_locale: { slug: input.slug, locale: input.locale } },
      });
      if (taken) throw new DomainException('guide.slug_taken');
      const row = await tx.guide.create({
        data: {
          ...input,
          reviewedOn: day(input.reviewedOn),
          publishedOn: day(input.publishedOn),
          sections: input.sections as Prisma.InputJsonValue,
          faq: input.faq as Prisma.InputJsonValue,
          sources: input.sources as Prisma.InputJsonValue,
          createdBy: userId,
          updatedBy: userId,
        },
      });
      await this.audit.record(tx, {
        action: 'guide.created',
        tenantId: null,
        subjectType: 'platform.guide',
        subjectId: row.id,
        after: { slug: row.slug, locale: row.locale },
      });
      return row;
    });
  }

  /** Edits a guide (draft or published — a published guide shows the change at once; its reviewer stays on record). */
  async update(userId: string, id: string, version: number, patch: GuidePatch): Promise<Guide> {
    return this.db.platform(async (tx) => {
      const current = await tx.guide.findUnique({ where: { id } });
      if (!current) throw new DomainException('http.not_found');
      if (current.version !== version) throw new DomainException('concurrency.stale');
      const next = {
        sections: patch.sections ?? current.sections,
        faq: patch.faq ?? current.faq,
        sources: patch.sources ?? current.sources,
        reviewedOn: patch.reviewedOn ?? bangkokDate(current.reviewedOn),
        publishedOn: patch.publishedOn ?? bangkokDate(current.publishedOn),
      };
      this.check(next);
      const row = await tx.guide.update({
        where: { id },
        data: {
          ...patch,
          reviewedOn: day(next.reviewedOn),
          publishedOn: day(next.publishedOn),
          sections: next.sections as Prisma.InputJsonValue,
          faq: next.faq as Prisma.InputJsonValue,
          sources: next.sources as Prisma.InputJsonValue,
          updatedBy: userId,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'guide.updated',
        tenantId: null,
        subjectType: 'platform.guide',
        subjectId: id,
        metadata: { fields: Object.keys(patch) },
      });
      return row;
    });
  }

  /** The reviewer — never the last editor — publishes; the guide is public at once. */
  async publish(userId: string, id: string): Promise<Guide> {
    return this.setState(userId, id, 'published');
  }

  async unpublish(userId: string, id: string): Promise<Guide> {
    return this.setState(userId, id, 'draft');
  }

  private async setState(userId: string, id: string, state: 'draft' | 'published'): Promise<Guide> {
    return this.db.platform(async (tx) => {
      const current = await tx.guide.findUnique({ where: { id } });
      if (!current) throw new DomainException('http.not_found');
      if (current.state === state) return current;
      if (state === 'published' && current.updatedBy === userId)
        throw new DomainException('guide.same_reviewer');
      const row = await tx.guide.update({
        where: { id },
        data:
          state === 'published'
            ? { state, reviewedBy: userId, publishedAt: this.clock.now(), version: { increment: 1 } }
            : { state, publishedAt: null, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: state === 'published' ? 'guide.published' : 'guide.unpublished',
        tenantId: null,
        subjectType: 'platform.guide',
        subjectId: id,
        after: { slug: row.slug, locale: row.locale },
      });
      await this.events.record(tx, {
        type: state === 'published' ? 'guide.published' : 'guide.unpublished',
        aggregateType: 'guide',
        aggregateId: id,
        tenantId: null,
        payload: { guideId: id, slug: row.slug, locale: row.locale },
      });
      return row;
    });
  }

  /** `GET /v1/public/guides`: published guides of a locale, newest first. */
  published(locale: 'th' | 'en') {
    return this.db.platform((tx) =>
      tx.guide.findMany({
        where: { state: 'published', locale },
        orderBy: [{ publishedOn: 'desc' }, { slug: 'asc' }],
      }),
    );
  }

  async publishedBySlug(slug: string, locale: 'th' | 'en'): Promise<Guide> {
    const row = await this.db.platform((tx) =>
      tx.guide.findFirst({ where: { slug, locale, state: 'published' } }),
    );
    if (!row) throw new DomainException('http.not_found');
    return row;
  }
}

export type { GuideBody };

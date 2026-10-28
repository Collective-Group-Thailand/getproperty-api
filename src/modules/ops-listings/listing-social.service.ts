import { createHash } from 'node:crypto';

import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type Listing,
  type ListingSocialPost,
  type SocialChannel,
  type SocialPostAction,
} from '@generated/prisma/client';
import {
  FACEBOOK_PAGES,
  FacebookError,
  type FacebookPagesPort,
} from '@integrations/facebook/facebook-pages.port';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ListingShareService } from './listing-share.service';
import { ListingsService } from './listings.service';
import { refusalOf, SocialChannelsService } from './social-channels.service';

const TABLE = 'ops.listing_social_post';

/** What a listing event asks of the tenant's Pages (D-288): publish, edit the text, or take the post down. */
const EVENT_ACTION: Record<string, SocialPostAction> = {
  'listing.published': 'publish',
  'listing.restored': 'publish',
  'listing.price_changed': 'update',
  'listing.closed': 'delete',
  'listing.paused': 'delete',
  'listing.hidden': 'delete',
};

export type SocialPostView = ListingSocialPost & { channel: Pick<SocialChannel, 'pageId' | 'pageName'> };

const isPublic = (l: Pick<Listing, 'state' | 'hiddenAt'>) => l.state === 'published' && !l.hiddenAt;
const live = (p: Pick<ListingSocialPost, 'externalPostId' | 'state'> | null) =>
  !!p?.externalPostId && p.state !== 'deleted';

/** The public link of a Page post id (`<page-id>_<post-id>`). */
export function postUrl(externalPostId: string | null): string | null {
  if (!externalPostId) return null;
  const [page, post] = externalPostId.split('_');
  return post ? `https://www.facebook.com/${page}/posts/${post}` : `https://www.facebook.com/${page}`;
}

/**
 * Automatic posts on a tenant's own Facebook Page (G4, D-288, D-296). Listing events queue the work in the event's
 * transaction (publish on publish / restore, edit on a new rent, delete when the listing closes — "delete on let" —,
 * pauses or is hidden); the worker job `social-posts` carries it out **outside** any transaction (read → call the
 * Graph API → write the outcome) so a slow provider never holds a database transaction. The post text is the B7.9 Thai
 * caption with the listing's `facebook_page` short link (UTM, enquiries counted per channel). A refused token marks
 * the Page `failing` (no retry); rate limits and provider errors are retried with backoff up to
 * `social.post.max_attempts`. Groups are never automated.
 */
@Injectable()
export class ListingSocialService implements EventSubscriber, OnModuleInit {
  readonly name = 'listing-social';
  readonly eventTypes = Object.keys(EVENT_ACTION);
  private readonly logger = new Logger('ListingSocial');

  constructor(
    private readonly db: TenantTx,
    private readonly registry: EventSubscriberRegistry,
    private readonly channels: SocialChannelsService,
    private readonly share: ListingShareService,
    private readonly listings: ListingsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(FACEBOOK_PAGES) private readonly facebook: FacebookPagesPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const action = EVENT_ACTION[event.type];
    const listingId = (event.payload.listingId as string | undefined) ?? event.aggregateId;
    if (action && typeof listingId === 'string') await this.queueIn(tx, listingId, action);
  }

  /** Queues `action` for every verified Page of the listing's tenant (auto-post on; deletes for any verified Page). */
  async queueIn(tx: Tx, listingId: string, action: SocialPostAction): Promise<number> {
    const listing = await tx.listing.findUnique({ where: { id: listingId } });
    if (!listing) return 0;
    const pages = await tx.socialChannel.findMany({
      where: {
        tenantId: listing.tenantId,
        state: 'verified',
        ...(action === 'delete' ? {} : { autoPost: true }),
      },
    });
    const now = this.clock.now();
    let queued = 0;
    for (const page of pages) {
      const existing = await tx.listingSocialPost.findUnique({
        where: { listingId_channelId: { listingId, channelId: page.id } },
      });
      let next: SocialPostAction | null;
      if (action === 'delete') next = live(existing) ? 'delete' : null;
      else if (!isPublic(listing)) next = null;
      else next = live(existing) ? 'update' : 'publish';
      if (!next) {
        // nothing on the Page yet: a waiting publish is simply cancelled
        if (existing?.state === 'queued')
          await tx.listingSocialPost.update({
            where: { id: existing.id },
            data: { state: 'deleted', pendingAction: null, deletedAt: now },
          });
        continue;
      }
      const data = {
        state: 'queued' as const,
        pendingAction: next,
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
      };
      if (existing) await tx.listingSocialPost.update({ where: { id: existing.id }, data });
      else
        await tx.listingSocialPost.create({
          data: { tenantId: listing.tenantId, listingId, channelId: page.id, ...data },
        });
      queued += 1;
    }
    return queued;
  }

  // ------------------------------------------------------------------------------------------------- worker

  /** Job `social-posts` (every minute): carries out the due posts, one at a time. */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const due = await this.db.platform((tx) =>
      tx.listingSocialPost.findMany({
        where: { state: 'queued', nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: 'asc' },
        take: 50,
        select: { id: true },
      }),
    );
    await RequestContext.run({ actor: systemActor('social-posts') }, async () => {
      for (const { id } of due) {
        try {
          await this.process(id);
        } catch (error) {
          this.logger.warn(`social post ${id} failed: ${(error as Error).message}`);
        }
      }
    });
    return due.length;
  }

  private async process(id: string): Promise<void> {
    // 1. read what to do (and the token) in one transaction
    const job = await this.db.platform(async (tx) => {
      const post = await tx.listingSocialPost.findUnique({
        where: { id },
        include: { channel: true, listing: true },
      });
      if (!post || post.state !== 'queued' || !post.pendingAction) return null;
      let action = post.pendingAction;
      if (action !== 'delete' && !isPublic(post.listing)) action = 'delete';
      if (action === 'publish' && live(post)) action = 'update';
      if (action === 'update' && !live(post)) action = 'publish';
      if (action === 'delete' && !live(post)) {
        await tx.listingSocialPost.update({
          where: { id },
          data: { state: 'deleted', pendingAction: null, deletedAt: this.clock.now() },
        });
        return null;
      }
      if (post.channel.state !== 'verified') {
        await this.fail(tx, post, 'the Page is not connected or its token was refused');
        return null;
      }
      const token = await this.channels.token(tx, post.channel);
      let message = '';
      let link = '';
      if (action !== 'delete') {
        link = await this.share.linkIn(tx, post.listing, 'facebook_page');
        const verified = await this.listings.verified(tx, post.listing.tenantId, post.listing.unitId);
        message = this.share.caption(post.listing, verified, 'th', link);
      }
      return { post, action, token, message, link, stamp: post.updatedAt };
    });
    if (!job) return;
    const { post, action, token, message, link } = job;
    const hash = createHash('sha256').update(message).digest('hex');

    // 2. call the provider outside any transaction
    let externalPostId = post.externalPostId;
    let error: unknown = null;
    try {
      if (action === 'publish')
        externalPostId = (await this.facebook.publish(token, post.channel.pageId, { message, link })).postId;
      else if (action === 'update') {
        if (hash !== post.contentHash) await this.facebook.update(token, post.externalPostId!, { message });
      } else await this.facebook.remove(token, post.externalPostId!);
    } catch (e) {
      error = e;
    }

    // 3. write the outcome
    await this.db.platform(async (tx) => {
      const now = this.clock.now();
      const current = await tx.listingSocialPost.findUnique({ where: { id }, include: { channel: true } });
      if (!current) return;
      const requeued = current.updatedAt.getTime() !== job.stamp.getTime();
      if (error) {
        if (error instanceof FacebookError && error.tokenRefused) {
          await this.channels.markFailing(tx, current.channel, error);
          await this.fail(tx, current, refusalOf(error));
          return;
        }
        const max = await this.settings.valueAt<number>('social.post.max_attempts', now);
        const minutes = await this.settings.valueAt<number>('social.post.retry_minutes', now);
        const attempts = current.attempts + 1;
        const retryable = !(error instanceof FacebookError) || error.retryable;
        if (retryable && attempts < max && !requeued) {
          await tx.listingSocialPost.update({
            where: { id },
            data: {
              attempts,
              lastError: refusalOf(error),
              nextAttemptAt: new Date(now.getTime() + minutes * 60_000 * 2 ** (attempts - 1)),
            },
          });
          return;
        }
        if (!requeued) await this.fail(tx, current, refusalOf(error));
        return;
      }
      if (requeued) {
        // a newer action was queued meanwhile: keep it, remember what is on the Page now
        if (action === 'publish')
          await tx.listingSocialPost.update({
            where: { id },
            data: { externalPostId, postedAt: now, contentHash: hash },
          });
        if (action === 'delete')
          await tx.listingSocialPost.update({
            where: { id },
            data: { externalPostId: null, deletedAt: now },
          });
        return;
      }
      if (action === 'delete') {
        await tx.listingSocialPost.update({
          where: { id },
          data: { state: 'deleted', pendingAction: null, deletedAt: now, lastError: null, attempts: 0 },
        });
      } else {
        await tx.listingSocialPost.update({
          where: { id },
          data: {
            state: 'posted',
            pendingAction: null,
            externalPostId,
            contentHash: hash,
            attempts: 0,
            lastError: null,
            deletedAt: null,
            ...(action === 'publish' ? { postedAt: now } : { updatedOnPageAt: now }),
          },
        });
      }
      const type = action === 'delete' ? 'listing.social_post_deleted' : 'listing.social_posted';
      await this.audit.record(tx, {
        action: type,
        tenantId: current.tenantId,
        subjectType: TABLE,
        subjectId: id,
        after: { listingId: current.listingId, channelId: current.channelId, action, externalPostId },
      });
      await this.events.record(tx, {
        type,
        aggregateType: 'listing',
        aggregateId: current.listingId,
        tenantId: current.tenantId,
        payload: { listingId: current.listingId, postId: id, action, externalPostId },
      });
    });
  }

  private async fail(tx: Tx, post: ListingSocialPost, reason: string): Promise<void> {
    await tx.listingSocialPost.update({
      where: { id: post.id },
      data: { state: 'failed', pendingAction: null, lastError: reason.slice(0, 500) },
    });
    await this.audit.record(tx, {
      action: 'listing.social_post_failed',
      tenantId: post.tenantId,
      subjectType: TABLE,
      subjectId: post.id,
      after: { listingId: post.listingId, channelId: post.channelId, reason },
    });
    await this.events.record(tx, {
      type: 'listing.social_post_failed',
      aggregateType: 'listing',
      aggregateId: post.listingId,
      tenantId: post.tenantId,
      payload: { listingId: post.listingId, postId: post.id, reason },
    });
  }

  // ------------------------------------------------------------------------------------------------- owner

  /** The Page posts of one of the tenant's listings (another tenant's listing: 404). */
  async list(ctx: TenantContext, listingId: string): Promise<SocialPostView[]> {
    return this.db.tenant(ctx, async (tx) => {
      const listing = await tx.listing.findFirst({ where: { id: listingId, tenantId: ctx.tenantId } });
      if (!listing) throw new DomainException('http.not_found');
      return tx.listingSocialPost.findMany({
        where: { listingId, tenantId: ctx.tenantId },
        include: { channel: { select: { pageId: true, pageName: true } } },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  /** Tries a failed post again (Idempotency-Key on the route): what the listing needs now, on a verified Page. */
  async retry(ctx: TenantContext, listingId: string, postId: string): Promise<SocialPostView> {
    return this.db.tenant(ctx, async (tx) => {
      const post = await tx.listingSocialPost.findFirst({
        where: { id: postId, listingId, tenantId: ctx.tenantId },
        include: { listing: true, channel: true },
      });
      if (!post) throw new DomainException('http.not_found');
      if (post.state !== 'failed') throw new DomainException('social.post_invalid_state');
      if (post.channel.state !== 'verified') throw new DomainException('social.post_invalid_state');
      const action: SocialPostAction | null = isPublic(post.listing)
        ? live(post)
          ? 'update'
          : 'publish'
        : live(post)
          ? 'delete'
          : null;
      if (!action) throw new DomainException('social.post_invalid_state');
      await tx.listingSocialPost.update({
        where: { id: post.id },
        data: {
          state: 'queued',
          pendingAction: action,
          attempts: 0,
          nextAttemptAt: this.clock.now(),
          lastError: null,
          contentHash: action === 'update' ? null : post.contentHash,
        },
      });
      await this.audit.record(tx, {
        action: 'listing.social_post_retried',
        tenantId: ctx.tenantId,
        subjectType: TABLE,
        subjectId: post.id,
        after: { listingId, action },
      });
      return tx.listingSocialPost.findUniqueOrThrow({
        where: { id: post.id },
        include: { channel: { select: { pageId: true, pageName: true } } },
      });
    });
  }
}

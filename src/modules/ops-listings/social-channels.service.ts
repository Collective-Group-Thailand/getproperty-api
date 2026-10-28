import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { TenantDataKeys } from '@core/tenancy/data-keys.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type SocialChannel } from '@generated/prisma/client';
import {
  FACEBOOK_PAGES,
  FacebookError,
  type FacebookPagesPort,
  FacebookUnavailableError,
} from '@integrations/facebook/facebook-pages.port';
import { Inject, Injectable } from '@nestjs/common';

const TABLE = 'platform.social_channel';
const by = () => userIdOf(RequestContext.actor());

export interface ConnectPageInput {
  pageId: string;
  pageAccessToken: string;
  autoPost?: boolean;
}

/** Why the provider refused, for the owner (never the token, never Facebook's raw payload). */
export function refusalOf(error: unknown): string {
  if (error instanceof FacebookError)
    return error.tokenRefused
      ? `Facebook refused the Page token (code ${error.code ?? error.status})`
      : `Facebook answered ${error.code ?? error.status}`;
  return 'Facebook could not be reached';
}

/**
 * A tenant's own Facebook Page (G4, D-288, D-296): the owner connects a Page with its Page access token, getproperty
 * checks it with the Graph API first (a refused token stores nothing — `facebook.page_refused`), seals it with the
 * tenant data key (D-148 / D-240: AAD tenant / table / `token` / row id) and posts the tenant's listings there
 * automatically (`ListingSocialService`). One live Page per tenant; connecting another replaces it. The token is never
 * returned, logged, audited or put in an event. `FACEBOOK_MODE=off` (O-029) answers `facebook.unavailable`.
 */
@Injectable()
export class SocialChannelsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly keys: TenantDataKeys,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(FACEBOOK_PAGES) private readonly facebook: FacebookPagesPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  private field(channel: Pick<SocialChannel, 'tenantId' | 'id'>) {
    return { tenantId: channel.tenantId, table: TABLE, column: 'token', rowId: channel.id };
  }

  /** The Page access token, decrypted (the key service audits data-key use, D-148). */
  async token(tx: Tx, channel: SocialChannel): Promise<string> {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${channel.tenantId}, true)`;
    return this.keys.decrypt(tx, this.field(channel), channel.tokenEnc);
  }

  /** Asks the provider for the Page; maps "switched off" and refusals to problems. */
  private async check(token: string, pageId: string) {
    try {
      return await this.facebook.page(token, pageId);
    } catch (error) {
      if (error instanceof FacebookUnavailableError) throw new DomainException('facebook.unavailable');
      if (error instanceof FacebookError) throw new DomainException('facebook.page_refused');
      throw error;
    }
  }

  list(ctx: TenantContext): Promise<SocialChannel[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.socialChannel.findMany({
        where: this.own(ctx, { state: { not: 'revoked' as const } }),
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async connect(ctx: TenantContext, input: ConnectPageInput): Promise<SocialChannel> {
    const page = await this.check(input.pageAccessToken, input.pageId);
    return this.db.tenant(ctx, async (tx) => {
      const now = this.clock.now();
      const existing = await tx.socialChannel.findFirst({
        where: this.own(ctx, { provider: 'facebook_page' as const, state: { not: 'revoked' as const } }),
      });
      if (existing)
        await tx.socialChannel.update({
          where: { id: existing.id },
          data: { state: 'revoked', revokedAt: now, revokedBy: by(), updatedBy: by() },
        });
      const id = crypto.randomUUID();
      const created = await tx.socialChannel.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          provider: 'facebook_page',
          pageId: input.pageId,
          pageName: page.name.slice(0, 200) || null,
          tokenEnc: await this.keys.encrypt(
            tx,
            this.field({ tenantId: ctx.tenantId, id }),
            input.pageAccessToken,
          ),
          state: 'verified',
          autoPost: input.autoPost ?? true,
          verifiedAt: now,
          lastCheckedAt: now,
          createdBy: by(),
          updatedBy: by(),
        },
      });
      await this.audit.record(tx, {
        action: 'social_channel.connected',
        tenantId: ctx.tenantId,
        subjectType: TABLE,
        subjectId: id,
        after: {
          provider: 'facebook_page',
          pageId: input.pageId,
          autoPost: created.autoPost,
          replaced: existing?.id ?? null,
        },
      });
      await this.events.record(tx, {
        type: 'social_channel.connected',
        aggregateType: 'social_channel',
        aggregateId: id,
        tenantId: ctx.tenantId,
        payload: { channelId: id, provider: 'facebook_page', pageId: input.pageId },
      });
      return created;
    });
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<SocialChannel> {
    return this.found(
      await tx.socialChannel.findFirst({ where: this.own(ctx, { id, state: { not: 'revoked' as const } }) }),
    );
  }

  /** Checks the Page token again: `verified`, or `failing` with the reason (posting stops while failing). */
  async verify(ctx: TenantContext, id: string): Promise<SocialChannel> {
    const { channel, token } = await this.db.tenant(ctx, async (tx) => {
      const row = await this.load(tx, ctx, id);
      return { channel: row, token: await this.token(tx, row) };
    });
    let error: unknown = null;
    try {
      await this.facebook.page(token, channel.pageId);
    } catch (e) {
      if (e instanceof FacebookUnavailableError) throw new DomainException('facebook.unavailable');
      error = e;
    }
    return this.db.tenant(ctx, async (tx) => {
      const now = this.clock.now();
      const updated = error
        ? await this.markFailing(tx, channel, error)
        : await tx.socialChannel.update({
            where: { id: channel.id },
            data: {
              state: 'verified',
              verifiedAt: channel.verifiedAt ?? now,
              lastCheckedAt: now,
              lastError: null,
              updatedBy: by(),
            },
          });
      await this.audit.record(tx, {
        action: 'social_channel.verified',
        tenantId: ctx.tenantId,
        subjectType: TABLE,
        subjectId: channel.id,
        after: { state: updated.state },
      });
      return updated;
    });
  }

  /** The provider refused the Page token: `failing` (no more posts until checked again); told once via an event. */
  async markFailing(tx: Tx, channel: SocialChannel, error: unknown): Promise<SocialChannel> {
    const now = this.clock.now();
    const reason = refusalOf(error);
    const updated = await tx.socialChannel.update({
      where: { id: channel.id },
      data: { state: 'failing', lastCheckedAt: now, lastError: reason },
    });
    if (channel.state === 'verified')
      await this.events.record(tx, {
        type: 'social_channel.failing',
        aggregateType: 'social_channel',
        aggregateId: channel.id,
        tenantId: channel.tenantId,
        payload: { channelId: channel.id, reason },
      });
    return updated;
  }

  /** Disconnects the Page: nothing more is posted; posts already on the Page stay (the owner manages them there). */
  async revoke(ctx: TenantContext, id: string): Promise<void> {
    await this.db.tenant(ctx, async (tx) => {
      const channel = await this.load(tx, ctx, id);
      const now = this.clock.now();
      await tx.socialChannel.update({
        where: { id: channel.id },
        data: { state: 'revoked', revokedAt: now, revokedBy: by(), updatedBy: by() },
      });
      await tx.listingSocialPost.updateMany({
        where: { channelId: channel.id, state: 'queued' },
        data: { state: 'failed', pendingAction: null, lastError: 'Page disconnected' },
      });
      await this.audit.record(tx, {
        action: 'social_channel.revoked',
        tenantId: ctx.tenantId,
        subjectType: TABLE,
        subjectId: channel.id,
        before: { pageId: channel.pageId, state: channel.state },
      });
      await this.events.record(tx, {
        type: 'social_channel.revoked',
        aggregateType: 'social_channel',
        aggregateId: channel.id,
        tenantId: ctx.tenantId,
        payload: { channelId: channel.id },
      });
    });
  }
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { type LineMessage } from '@collective/integrations/line';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type MessagingChannel, type MessagingChannelUser } from '@generated/prisma/client';
import {
  LINE_CHANNEL_API,
  type LineChannelApiPort,
  LineChannelError,
} from '@integrations/line-channels/line-channel-api.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { opaqueToken } from '../identity/crypto/secrets';
import { SettingsService } from '../settings/settings.service';
import { TenantDataKeys } from '../tenancy/data-keys.service';

const by = () => userIdOf(RequestContext.actor());
const TABLE = 'platform.messaging_channel';

export interface ConnectInput {
  buildingId?: string | null;
  lineChannelId: string;
  channelSecret: string;
  accessToken: string;
}

/** A channel as the owner console shows it (never its secrets). */
export type ChannelView = MessagingChannel & { webhookUrl: string; linkedUsers: number };

/** What a link page shows before the resident confirms (D-254). */
export interface LinkPreview {
  tenantName: string;
  botName: string | null;
  botPictureUrl: string | null;
  expiresAt: Date;
  state: 'valid' | 'used' | 'expired';
}

/** A LINE webhook event, as much as account linking reads (Messaging API webhook reference). */
interface LineEvent {
  type?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
}

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/**
 * Operators' own LINE Official Accounts (B7 deliverable 7.7 part 1, D-254). A tenant — or one of its buildings —
 * connects its Messaging API channel: the credentials are sealed with the tenant's data key (D-148) and checked with
 * LINE (bot info) before the channel is `verified`; the owner sets the per-channel webhook URL in the LINE console.
 * Messages to a resident then go out through the most specific verified channel (building → tenant), with the OA
 * user id of that login — residents are linked by account linking: a follow or a message on the OA gets a single-use
 * link to the LIFF, where the resident confirms. Until a resident is linked, messages keep going through the shared
 * getproperty OA, so nobody loses a bill.
 */
@Injectable()
export class MessagingChannelsService extends TenantScopedRepository {
  private readonly logger = new Logger(MessagingChannelsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly keys: TenantDataKeys,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
    @Inject(LINE_CHANNEL_API) private readonly api: LineChannelApiPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  webhookUrl(channel: Pick<MessagingChannel, 'webhookKey'>): string {
    return `${this.config.get('PUBLIC_API_BASE_URL')}/webhooks/line/${channel.webhookKey}`;
  }

  private field(channel: Pick<MessagingChannel, 'tenantId' | 'id'>, column: 'secret' | 'token') {
    return { tenantId: channel.tenantId, table: TABLE, column, rowId: channel.id };
  }

  /** The channel's access token and secret, decrypted (audited by the key service's policy, D-148). */
  async credentials(tx: Tx, channel: MessagingChannel): Promise<{ token: string; secret: string }> {
    // The tenant's data key is read through `app.tenant_id` (webhooks, linking and delivery run in platform
    // transactions; inside a tenant transaction this is the same value).
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${channel.tenantId}, true)`;
    const [token, secret] = await Promise.all([
      this.keys.decrypt(tx, this.field(channel, 'token'), channel.tokenEnc),
      this.keys.decrypt(tx, this.field(channel, 'secret'), channel.secretEnc),
    ]);
    return { token, secret };
  }

  private async view(tx: Tx, channel: MessagingChannel): Promise<ChannelView> {
    const linkedUsers = await tx.messagingChannelUser.count({
      where: { channelId: channel.id, unlinkedAt: null },
    });
    return { ...channel, webhookUrl: this.webhookUrl(channel), linkedUsers };
  }

  async list(ctx: TenantContext): Promise<ChannelView[]> {
    return this.db.tenant(ctx, async (tx) => {
      const rows = await tx.messagingChannel.findMany({
        where: this.own(ctx, { state: { not: 'revoked' } }),
        orderBy: { createdAt: 'asc' },
      });
      return Promise.all(rows.map((row) => this.view(tx, row)));
    });
  }

  /** Checks the token with LINE and records the bot; `verified` or `failing` with the reason. */
  private async check(tx: Tx, channel: MessagingChannel): Promise<MessagingChannel> {
    const now = this.clock.now();
    const { token } = await this.credentials(tx, channel);
    try {
      const bot = await this.api.botInfo(token);
      return tx.messagingChannel.update({
        where: { id: channel.id },
        data: {
          state: 'verified',
          verifiedAt: channel.verifiedAt ?? now,
          lastCheckedAt: now,
          lastError: null,
          botUserId: bot.userId,
          botName: bot.displayName.slice(0, 200) || null,
          botPictureUrl: bot.pictureUrl ?? null,
          updatedAt: now,
        },
      });
    } catch (error) {
      const reason =
        error instanceof LineChannelError
          ? error.status === 401
            ? 'LINE refused the channel access token (401)'
            : `LINE answered ${error.status}`
          : 'LINE could not be reached';
      return tx.messagingChannel.update({
        where: { id: channel.id },
        data: { state: 'failing', lastCheckedAt: now, lastError: reason, updatedAt: now },
      });
    }
  }

  /** Connects (or replaces) the own OA of the tenant or of one building, then verifies it with LINE. */
  async connect(ctx: TenantContext, input: ConnectInput): Promise<ChannelView> {
    return this.db.tenant(ctx, async (tx) => {
      if (input.buildingId) {
        const building = await tx.building.findFirst({ where: { id: input.buildingId, deletedAt: null } });
        if (!building || (building.operatorTenantId ?? building.ownerTenantId) !== ctx.tenantId)
          throw new DomainException('http.not_found');
      }
      const now = this.clock.now();
      const existing = await tx.messagingChannel.findFirst({
        where: this.own(ctx, { buildingId: input.buildingId ?? null, state: { not: 'revoked' } }),
      });
      if (existing) {
        await tx.messagingChannel.update({
          where: { id: existing.id },
          data: { state: 'revoked', revokedAt: now, updatedAt: now, updatedBy: by() },
        });
      }
      const id = crypto.randomUUID();
      const sealed = { tenantId: ctx.tenantId, id };
      const created = await tx.messagingChannel.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          buildingId: input.buildingId ?? null,
          lineChannelId: input.lineChannelId,
          secretEnc: await this.keys.encrypt(tx, this.field(sealed, 'secret'), input.channelSecret),
          tokenEnc: await this.keys.encrypt(tx, this.field(sealed, 'token'), input.accessToken),
          webhookKey: opaqueToken(24)
            .replace(/[^A-Za-z0-9_-]/g, '')
            .slice(0, 32)
            .padEnd(24, '0'),
          createdBy: by(),
          updatedBy: by(),
        },
      });
      const checked = await this.check(tx, created);
      await this.audit.record(tx, {
        action: 'messaging.channel_connected',
        tenantId: ctx.tenantId,
        buildingId: input.buildingId ?? null,
        subjectType: TABLE,
        subjectId: id,
        after: { lineChannelId: input.lineChannelId, state: checked.state, replaced: existing?.id ?? null },
      });
      return this.view(tx, checked);
    });
  }

  private async load(tx: Tx, ctx: TenantContext, id: string): Promise<MessagingChannel> {
    return this.found(
      await tx.messagingChannel.findFirst({ where: this.own(ctx, { id, state: { not: 'revoked' } }) }),
    );
  }

  async verify(ctx: TenantContext, id: string): Promise<ChannelView> {
    return this.db.tenant(ctx, async (tx) =>
      this.view(tx, await this.check(tx, await this.load(tx, ctx, id))),
    );
  }

  /** Disconnects the own OA; messages go back through the shared getproperty OA. */
  async revoke(ctx: TenantContext, id: string): Promise<void> {
    await this.db.tenant(ctx, async (tx) => {
      const channel = await this.load(tx, ctx, id);
      const now = this.clock.now();
      await tx.messagingChannel.update({
        where: { id: channel.id },
        data: { state: 'revoked', revokedAt: now, updatedAt: now, updatedBy: by() },
      });
      await this.audit.record(tx, {
        action: 'messaging.channel_revoked',
        tenantId: ctx.tenantId,
        buildingId: channel.buildingId,
        subjectType: TABLE,
        subjectId: channel.id,
        before: { lineChannelId: channel.lineChannelId, state: channel.state },
      });
    });
  }

  // --------------------------------------------------------------------------------------------- delivery

  /** The verified own channel that carries a tenant's (building's) messages, or null for the shared OA. */
  async channelFor(
    tx: Tx,
    tenantId: string | null,
    buildingId: string | null,
  ): Promise<MessagingChannel | null> {
    if (!tenantId) return null;
    const rows = await tx.messagingChannel.findMany({
      where: {
        tenantId,
        state: 'verified',
        OR: [{ buildingId: null }, ...(buildingId ? [{ buildingId }] : [])],
      },
    });
    return (
      rows.find((row) => row.buildingId === buildingId && buildingId) ??
      rows.find((row) => !row.buildingId) ??
      null
    );
  }

  /**
   * The OA user id of a recipient on a channel, when the resident linked it: a login directly, or a party through its
   * active logins (`core.party_user_link`). Other recipient kinds (a phone, a raw LINE id) stay on the shared OA.
   */
  async linkedUser(
    tx: Tx,
    channelId: string,
    recipient: { type: string; id: string },
  ): Promise<MessagingChannelUser | null> {
    let userIds: string[];
    if (recipient.type === 'user') userIds = [recipient.id];
    else if (recipient.type === 'party')
      userIds = (
        await tx.partyUserLink.findMany({
          where: { partyId: recipient.id, state: 'active', unlinkedAt: null },
          select: { userId: true },
        })
      ).map((l) => l.userId);
    else return null;
    if (!userIds.length) return null;
    return tx.messagingChannelUser.findFirst({
      where: { channelId, userId: { in: userIds }, unlinkedAt: null },
      orderBy: { linkedAt: 'desc' },
    });
  }

  /** Push through an own channel with its token (`LineChannelError` on refusal). */
  async push(tx: Tx, channel: MessagingChannel, to: string, messages: LineMessage[], retryKey: string) {
    const { token } = await this.credentials(tx, channel);
    return this.api.push(token, to, messages, retryKey);
  }

  // --------------------------------------------------------------------------------------------- webhook

  /**
   * `POST /webhooks/line/{webhookKey}`: verifies `X-Line-Signature` (base64 HMAC-SHA256 of the raw body with the
   * channel secret) and answers each follow / message from an OA user who is not linked yet with a link button to
   * the LIFF (a reply: not counted by LINE). An unfollow ends the link.
   */
  async receive(
    webhookKey: string,
    signature: string | undefined,
    raw: Buffer | undefined,
  ): Promise<{ handled: number }> {
    if (!raw) throw new DomainException('webhook.malformed');
    return this.db.platform(async (tx) => {
      const channel = await tx.messagingChannel.findUnique({ where: { webhookKey } });
      if (!channel || channel.state === 'revoked') throw new DomainException('http.not_found');
      const { token, secret } = await this.credentials(tx, channel);
      const expected = createHmac('sha256', secret).update(raw).digest();
      const given = Buffer.from(signature ?? '', 'base64');
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        throw new DomainException('webhook.signature_invalid');
      let events: LineEvent[];
      try {
        events = ((JSON.parse(raw.toString('utf8')) as { events?: LineEvent[] }).events ?? []).slice(0, 100);
      } catch {
        throw new DomainException('webhook.malformed');
      }
      const now = this.clock.now();
      const ttl = Number(
        await this.settings.valueAt<number>('messaging.link_token.ttl_minutes', now, {
          tenantId: channel.tenantId,
        }),
      );
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: channel.tenantId },
        select: { displayName: true },
      });
      let handled = 0;
      for (const event of events) {
        const lineUserId = event.source?.type === 'user' ? event.source.userId : undefined;
        if (!lineUserId || !/^U[0-9a-f]{32}$/.test(lineUserId)) continue;
        if (event.type === 'unfollow') {
          await tx.messagingChannelUser.updateMany({
            where: { channelId: channel.id, lineUserId, unlinkedAt: null },
            data: { unlinkedAt: now },
          });
          handled += 1;
          continue;
        }
        if (event.type !== 'follow' && event.type !== 'message') continue;
        const linked = await tx.messagingChannelUser.findFirst({
          where: { channelId: channel.id, lineUserId, unlinkedAt: null },
        });
        if (linked || !event.replyToken) continue;
        const link = opaqueToken(24);
        await tx.messagingLinkToken.create({
          data: {
            tenantId: channel.tenantId,
            channelId: channel.id,
            tokenHash: tokenHash(link),
            lineUserId,
            expiresAt: new Date(now.getTime() + ttl * 60_000),
          },
        });
        const url = `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/link/oa?t=${encodeURIComponent(link)}`;
        try {
          await this.api.reply(token, event.replyToken, [
            {
              type: 'text',
              text: `${tenant.displayName}: แตะลิงก์เพื่อรับบิลและแจ้งซ่อมผ่าน LINE นี้ / Tap to get your bills and repairs here\n${url}`,
            },
          ]);
        } catch (error) {
          this.logger.warn(`link reply on channel ${channel.id} failed: ${(error as Error).message}`);
        }
        handled += 1;
      }
      return { handled };
    });
  }

  // ------------------------------------------------------------------------------------------ account linking

  private async token(tx: Tx, token: string) {
    const row = await tx.messagingLinkToken.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: { channel: true },
    });
    if (!row || row.channel.state === 'revoked') throw new DomainException('messaging.link_invalid');
    return row;
  }

  /** `GET /v1/resident/messaging-links/{token}`: who is asking, before the resident confirms. */
  async preview(token: string): Promise<LinkPreview> {
    return this.db.platform(async (tx) => {
      const row = await this.token(tx, token);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: row.tenantId },
        select: { displayName: true },
      });
      return {
        tenantName: tenant.displayName,
        botName: row.channel.botName,
        botPictureUrl: row.channel.botPictureUrl,
        expiresAt: row.expiresAt,
        state: row.usedAt
          ? 'used'
          : row.expiresAt.getTime() <= this.clock.now().getTime()
            ? 'expired'
            : 'valid',
      };
    });
  }

  /**
   * The signed-in resident confirms: the OA user id of the token is kept for this login on that channel (once — the
   * same OA user cannot be linked to another login), and the OA says welcome.
   */
  async confirm(userId: string, token: string): Promise<LinkPreview> {
    const welcome = await this.db.platform(async (tx) => {
      const row = await this.token(tx, token);
      const now = this.clock.now();
      if (row.usedAt) throw new DomainException('messaging.link_used');
      if (row.expiresAt.getTime() <= now.getTime()) throw new DomainException('messaging.link_expired');
      const taken = await tx.messagingChannelUser.findFirst({
        where: { channelId: row.channelId, lineUserId: row.lineUserId, unlinkedAt: null },
      });
      if (taken && taken.userId !== userId) throw new DomainException('messaging.line_user_taken');
      await tx.messagingChannelUser.updateMany({
        where: { channelId: row.channelId, userId, unlinkedAt: null, lineUserId: { not: row.lineUserId } },
        data: { unlinkedAt: now },
      });
      if (!taken) {
        await tx.messagingChannelUser.create({
          data: {
            tenantId: row.tenantId,
            channelId: row.channelId,
            userId,
            lineUserId: row.lineUserId,
            linkedAt: now,
          },
        });
      }
      await tx.messagingLinkToken.update({ where: { id: row.id }, data: { usedAt: now, usedBy: userId } });
      await this.audit.record(tx, {
        action: 'messaging.user_linked',
        tenantId: row.tenantId,
        subjectType: 'core.user_account',
        subjectId: userId,
        after: { channelId: row.channelId },
      });
      return row;
    });
    try {
      await this.db.platform(async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: welcome.tenantId },
          select: { displayName: true },
        });
        await this.push(
          tx,
          welcome.channel,
          welcome.lineUserId,
          [
            {
              type: 'text',
              text: `${tenant.displayName}: เชื่อมบัญชีเรียบร้อย บิลและการแจ้งซ่อมจะส่งมาที่นี่ / You are linked: bills and repairs come here.`,
            },
          ],
          welcome.id,
        );
      });
    } catch (error) {
      this.logger.warn(`welcome on channel ${welcome.channelId} failed: ${(error as Error).message}`);
    }
    return this.preview(token);
  }
}

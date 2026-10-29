import { createHash } from 'node:crypto';

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { startOfBangkokMonth } from '@common/time/bangkok';
import { AiUsageService } from '@core/ai-usage/ai-usage.service';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import {
  LISTING_WRITER,
  type ListingWriterLanguage,
  type ListingWriterPort,
  ListingWriterUnavailable,
} from '@integrations/listing-writer/listing-writer.port';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { type AssistantResult, checkDrafts, listingFacts } from './listing-assistant-rules';
import { ListingsService } from './listings.service';

const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_BYTES = 8_000_000;
/**
 * The AI listing assistant (G9, E15, D-301, D-161): drafts a title and a description in th / en / zh from the
 * listing's facts and — when asked — a few of its photos (`listing.assistant.max_photos`), through the AI gateway
 * (fake adapter in dev / tests; the real adapter is UNVERIFIED). **Nothing is saved**: the owner edits the drafts and
 * saves them through the listing update. Photos are read only (sent to the model, never changed, re-encoded or stored
 * again). Every call writes one `platform.ai_usage_record` (feature `listing_assistant`, errors too); at most
 * `listing.assistant.monthly_limit` successful calls per tenant and Bangkok month (cost guard, O-009).
 */
@Injectable()
export class ListingAssistantService {
  private readonly logger = new Logger(ListingAssistantService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly listings: ListingsService,
    private readonly documents: DocumentsService,
    private readonly usage: AiUsageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(LISTING_WRITER) private readonly writer: ListingWriterPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async usedThisMonth(tenantId: string): Promise<number> {
    const from = startOfBangkokMonth(this.clock.now());
    return this.db.platform((tx) =>
      tx.aiUsageRecord.count({
        where: { tenantId, feature: 'listing_assistant', outcome: 'ok', occurredAt: { gte: from } },
      }),
    );
  }

  async draft(
    ctx: TenantContext,
    listingId: string,
    input: { languages: ListingWriterLanguage[]; includePhotos?: boolean },
  ): Promise<AssistantResult> {
    const listing = await this.listings.get(ctx, listingId);
    const now = this.clock.now();
    const scope = { tenantId: ctx.tenantId };
    if (!(await this.settings.valueAt<boolean>('listing.assistant.enabled', now, scope)))
      throw new DomainException('assistant.disabled');
    const limit = await this.settings.valueAt<number>('listing.assistant.monthly_limit', now, scope);
    const used = await this.usedThisMonth(ctx.tenantId);
    if (used >= limit)
      throw new DomainException('assistant.limit_reached', {
        params: { limit },
        headers: { 'Retry-After': String(Math.max(60, secondsToNextMonth(now))) },
      });
    const languages = [...new Set(input.languages)];
    const maxPhotos = input.includePhotos
      ? await this.settings.valueAt<number>('listing.assistant.max_photos', now)
      : 0;
    const photos: { data: Buffer; mimeType: string }[] = [];
    for (const p of listing.photos.slice(0, maxPhotos)) {
      try {
        const r = await this.documents.readBytes(ctx, p.documentId, {
          kinds: ['listing_photo'],
          mimeTypes: PHOTO_MIME,
          maxBytes: MAX_PHOTO_BYTES,
        });
        photos.push({ data: r.body, mimeType: r.document.mimeType });
      } catch (error) {
        // a photo still being scanned (or too large) is simply not sent
        this.logger.debug(`listing photo ${p.documentId} not sent: ${(error as Error).message}`);
      }
    }
    const facts = listingFacts(listing);
    // the place in the monthly limit is taken atomically before the AI call (G review #6): concurrent drafts at
    // limit − 1 cannot all pass the count above
    const reservationId = await this.usage.reserve({
      tenantId: ctx.tenantId,
      feature: 'listing_assistant',
      limit,
      since: startOfBangkokMonth(now),
      requestRef: RequestContext.current()?.requestId ?? null,
    });
    if (!reservationId)
      throw new DomainException('assistant.limit_reached', {
        params: { limit },
        headers: { 'Retry-After': String(Math.max(60, secondsToNextMonth(now))) },
      });
    const record = (
      outcome: 'ok' | 'error',
      model: string,
      units: { inputTokens: number; outputTokens: number } | null,
    ) =>
      this.usage.record({
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        feature: 'listing_assistant',
        provider: this.writer.mode === 'fake' ? 'fake' : 'ai_gateway',
        model,
        promptVersion: 'listing-assistant-v1',
        inputUnits: units?.inputTokens ?? 0,
        outputUnits: units?.outputTokens ?? 0,
        unitKind: 'tokens',
        requestRef: RequestContext.current()?.requestId ?? null,
        outcome,
        subjectType: 'ops.listing',
        subjectId: listing.id,
        reservationId,
      });
    let response;
    try {
      response = await this.writer.draft({ facts, languages, photos, tenantId: ctx.tenantId });
    } catch (error) {
      await record('error', 'unknown', null);
      if (error instanceof ListingWriterUnavailable) throw new DomainException('assistant.unavailable');
      this.logger.warn(`listing assistant failed: ${(error as Error).message}`);
      throw new DomainException('assistant.unavailable', { headers: { 'Retry-After': '60' } });
    }
    const drafts = checkDrafts(response.drafts, languages);
    if (!drafts) {
      await record('error', response.model, response.usage);
      throw new DomainException('assistant.output_rejected');
    }
    await record('ok', response.model, response.usage);
    await this.db.tenant(ctx, async (tx) => {
      await this.audit.record(tx, {
        action: 'listing.assistant_drafted',
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: listing.id,
        metadata: {
          languages,
          photos: photos.length,
          model: response.model,
          factsSha256: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
        },
      });
      await this.events.record(tx, {
        type: 'listing.assistant_drafted',
        aggregateType: 'listing',
        aggregateId: listing.id,
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        payload: {
          listingId: listing.id,
          languages,
          photos: photos.length,
          by: userIdOf(RequestContext.actor()),
        },
      });
    });
    return {
      drafts,
      model: response.model,
      photosUsed: photos.length,
      usedThisMonth: used + 1,
      monthlyLimit: limit,
    };
  }

  /** How many drafts the tenant used this month and its limit (for the button state). */
  async quota(
    ctx: TenantContext,
  ): Promise<{ enabled: boolean; usedThisMonth: number; monthlyLimit: number }> {
    const now = this.clock.now();
    const scope = { tenantId: ctx.tenantId };
    return {
      enabled: await this.settings.valueAt<boolean>('listing.assistant.enabled', now, scope),
      usedThisMonth: await this.usedThisMonth(ctx.tenantId),
      monthlyLimit: await this.settings.valueAt<number>('listing.assistant.monthly_limit', now, scope),
    };
  }
}

function secondsToNextMonth(now: Date): number {
  const bkk = new Date(now.getTime() + 7 * 3_600_000);
  const next = Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth() + 1, 1) - 7 * 3_600_000;
  return Math.ceil((next - now.getTime()) / 1000);
}

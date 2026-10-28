import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { type QuietHours } from '@core/notifications/quiet-hours';
import { ConsentService } from '@core/privacy/consent.service';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type AudiencePreference, type PortfolioUnitKind } from '@generated/prisma/client';
import { ListingInsightsService } from '@modules/ops-listings/listing-insights.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { AUDIENCE_LANGUAGES, RECOMMENDATIONS_PURPOSE, UNIT_KINDS } from './audience-rules';

const SUBJECT = 'platform.audience_preference';

export interface PreferencesInput {
  areas?: string[] | null;
  budgetMin?: string | null;
  budgetMax?: string | null;
  unitKinds?: string[] | null;
  moveInFrom?: string | null;
  moveInTo?: string | null;
  language?: string | null;
  quietHours?: { start: string; end: string } | null;
}

export interface ConsentView {
  purposeKey: string;
  version: number;
  language: string;
  title: string;
  bodyMarkdown: string;
  effectiveFrom: Date;
  granted: boolean;
  grantedVersion: number | null;
  capturedAt: Date | null;
}

export interface RecommendationsView {
  consent: ConsentView;
  preferences: AudiencePreference | null;
  maxPerWeek: number;
  quietHours: QuietHours;
}

export interface HistoryItem {
  id: string;
  sentAt: Date;
  sponsor: string;
  listings: { slug: string; title: string; public: boolean }[];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const timeOf = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
export const hhmmOf = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : null);

/**
 * Recommendations audience (G6, D-287, D-300): a person's **separate, optional** marketing consent
 * `platform.recommendations` (Collective is the controller — consent rows without a tenant; never pre-ticked: only an
 * explicit grant of the current version counts) and the preferences they type (areas, budget, unit kinds, move-in
 * window, language, own quiet hours — no special-category field exists). Withdrawal is one call and takes effect at
 * once: preferences become unusable, pending sponsored deliveries are cancelled, and the preferences are deleted after
 * `audience.preferences.keep_days_after_withdrawal`. Consent is checked again at send time
 * (`SponsoredCampaignsService`); this service never decides a send.
 */
@Injectable()
export class AudienceService implements EventSubscriber, OnModuleInit {
  readonly name = 'audience';
  readonly eventTypes = ['consent.changed'] as const;

  constructor(
    private readonly db: TenantTx,
    private readonly consents: ConsentService,
    private readonly settings: SettingsService,
    private readonly insights: ListingInsightsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly registry: EventSubscriberRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ------------------------------------------------------------------------------------------------- consent

  /** The current version number of the purpose (versions in force), or null when it is not seeded. */
  async currentVersion(tx: Tx): Promise<number | null> {
    const v = await tx.consentPurposeVersion.findFirst({
      where: { purpose: { key: RECOMMENDATIONS_PURPOSE }, effectiveFrom: { lte: this.clock.now() } },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return v?.version ?? null;
  }

  /** The user's grant at the current version (the consent row id), else null — the only test of consent. */
  async grantedConsent(tx: Tx, userId: string): Promise<string | null> {
    const current = await this.currentVersion(tx);
    if (current === null) return null;
    const rows = await tx.$queryRaw<{ consent_id: string; granted: boolean; purpose_version: number }[]>`
      SELECT consent_id, granted, purpose_version FROM platform.v_consent_state
       WHERE subject_type = 'user'::platform.consent_subject AND subject_id = ${userId}::uuid
         AND purpose_key = ${RECOMMENDATIONS_PURPOSE}`;
    const row = rows[0];
    return row?.granted && row.purpose_version >= current ? row.consent_id : null;
  }

  private async consentView(tx: Tx, userId: string, language: string): Promise<ConsentView> {
    const now = this.clock.now();
    const versions = await tx.consentPurposeVersion.findMany({
      where: { purpose: { key: RECOMMENDATIONS_PURPOSE }, effectiveFrom: { lte: now } },
      orderBy: { version: 'desc' },
    });
    const top = versions[0]?.version;
    const current = versions.filter((v) => v.version === top);
    const lang = language === 'th' ? 'th' : 'en';
    const text =
      current.find((v) => v.language === lang) ?? current.find((v) => v.language === 'th') ?? current[0];
    if (!text) throw new DomainException('consent.unknown_purpose');
    const state = await tx.$queryRaw<{ granted: boolean; purpose_version: number; captured_at: Date }[]>`
      SELECT granted, purpose_version, captured_at FROM platform.v_consent_state
       WHERE subject_type = 'user'::platform.consent_subject AND subject_id = ${userId}::uuid
         AND purpose_key = ${RECOMMENDATIONS_PURPOSE}`;
    const s = state[0];
    return {
      purposeKey: RECOMMENDATIONS_PURPOSE,
      version: text.version,
      language: text.language,
      title: text.title,
      bodyMarkdown: text.bodyMarkdown,
      effectiveFrom: text.effectiveFrom,
      // never pre-ticked: anything but an explicit grant of the current version is false
      granted: Boolean(s?.granted && s.purpose_version >= text.version),
      grantedVersion: s?.granted ? s.purpose_version : null,
      capturedAt: s?.captured_at ?? null,
    };
  }

  /** `GET …/me/recommendations`: my consent (text in my language), my preferences while consented, the limits. */
  async view(userId: string, language: string): Promise<RecommendationsView> {
    const now = this.clock.now();
    const { consent, preferences } = await this.db.platform(async (tx) => {
      const consent = await this.consentView(tx, userId, language);
      const pref = await tx.audiencePreference.findUnique({ where: { userId } });
      return { consent, preferences: consent.granted && pref && !pref.withdrawnAt ? pref : null };
    });
    return {
      consent,
      preferences,
      maxPerWeek: await this.settings.valueAt<number>('broadcast.sponsored.max_per_week', now),
      quietHours: await this.settings.valueAt<QuietHours>('broadcast.sponsored.quiet_hours', now),
    };
  }

  private async validate(input: PreferencesInput) {
    const errors: { path: string; code: string; message: string }[] = [];
    const areas = [...new Set((input.areas ?? []).map((a) => a.trim()).filter(Boolean))];
    if (areas.length > 10) errors.push({ path: 'preferences.areas', code: 'max', message: 'up to 10 areas' });
    for (const [i, slug] of areas.entries())
      if (!/^[a-z0-9-]{1,100}$/.test(slug) || !(await this.insights.areaFilter(slug)))
        errors.push({
          path: `preferences.areas[${i}]`,
          code: 'unknown',
          message: 'an area of /v1/public/listings/areas',
        });
    const kinds = [...new Set(input.unitKinds ?? [])];
    if (!kinds.every((k) => (UNIT_KINDS as readonly string[]).includes(k)))
      errors.push({ path: 'preferences.unitKinds', code: 'enum', message: UNIT_KINDS.join(', ') });
    const money = (v: string | null | undefined, path: string) => {
      if (v === null || v === undefined || v === '') return null;
      if (!/^\d{1,12}(\.\d{1,2})?$/.test(v)) {
        errors.push({ path, code: 'money', message: 'a decimal string' });
        return null;
      }
      return new Decimal(v).toFixed(2);
    };
    const budgetMin = money(input.budgetMin, 'preferences.budgetMin');
    const budgetMax = money(input.budgetMax, 'preferences.budgetMax');
    if (budgetMax !== null && new Decimal(budgetMax).lte(0))
      errors.push({ path: 'preferences.budgetMax', code: 'min', message: 'above zero' });
    if (budgetMin !== null && budgetMax !== null && new Decimal(budgetMin).gt(budgetMax))
      errors.push({ path: 'preferences.budgetMax', code: 'range', message: 'not below budgetMin' });
    const day = (v: string | null | undefined, path: string) => {
      if (v === null || v === undefined || v === '') return null;
      if (!DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        errors.push({ path, code: 'date', message: 'YYYY-MM-DD' });
        return null;
      }
      return v;
    };
    const moveInFrom = day(input.moveInFrom, 'preferences.moveInFrom');
    const moveInTo = day(input.moveInTo, 'preferences.moveInTo');
    if (moveInFrom && moveInTo && moveInFrom > moveInTo)
      errors.push({ path: 'preferences.moveInTo', code: 'range', message: 'not before moveInFrom' });
    const language = input.language ?? 'th';
    if (!(AUDIENCE_LANGUAGES as readonly string[]).includes(language))
      errors.push({ path: 'preferences.language', code: 'enum', message: AUDIENCE_LANGUAGES.join(', ') });
    const quiet = input.quietHours ?? null;
    if (quiet && (!HHMM.test(quiet.start) || !HHMM.test(quiet.end)))
      errors.push({ path: 'preferences.quietHours', code: 'time', message: '{start, end} as HH:MM' });
    if (errors.length) throw new DomainException('validation.failed', { errors });
    return {
      areaSlugs: areas,
      budgetMin,
      budgetMax,
      unitKinds: kinds as PortfolioUnitKind[],
      moveInFrom: moveInFrom ? new Date(`${moveInFrom}T00:00:00Z`) : null,
      moveInTo: moveInTo ? new Date(`${moveInTo}T00:00:00Z`) : null,
      language,
      quietStart: quiet ? timeOf(quiet.start) : null,
      quietEnd: quiet ? timeOf(quiet.end) : null,
    };
  }

  /**
   * `PUT …/me/recommendations`: sets my preferences. `consentVersion` = I tick the box now (it must be the current
   * version — `recommendations.consent_outdated` otherwise); without it my earlier grant must still be valid
   * (`recommendations.consent_required`). Nothing is ever granted implicitly.
   */
  async update(
    userId: string,
    consentVersion: number | null | undefined,
    input: PreferencesInput,
    language: string,
  ) {
    const data = await this.validate(input);
    if (consentVersion !== null && consentVersion !== undefined) {
      const current = await this.db.platform((tx) => this.currentVersion(tx));
      if (current === null || consentVersion !== current)
        throw new DomainException('recommendations.consent_outdated', { params: { version: current ?? 0 } });
      await this.consents.record(
        { type: 'user', id: userId },
        [{ purposeKey: RECOMMENDATIONS_PURPOSE, version: consentVersion, granted: true }],
        { channel: 'liff', language: language === 'th' ? 'th' : 'en', tenantIds: [null] },
      );
    }
    await this.db.platform(async (tx) => {
      const consentId = await this.grantedConsent(tx, userId);
      if (!consentId) throw new DomainException('recommendations.consent_required');
      const existing = await tx.audiencePreference.findUnique({ where: { userId } });
      const row = existing
        ? await tx.audiencePreference.update({
            where: { userId },
            data: { ...data, consentId, withdrawnAt: null, version: { increment: 1 }, updatedBy: userId },
          })
        : await tx.audiencePreference.create({ data: { ...data, userId, consentId, createdBy: userId } });
      // what changed, never the values (minimisation in the audit trail)
      await this.audit.record(tx, {
        action: 'audience.preferences_updated',
        subjectType: SUBJECT,
        subjectId: row.id,
        metadata: {
          areas: data.areaSlugs.length,
          budget: data.budgetMin !== null || data.budgetMax !== null,
          unitKinds: data.unitKinds.length,
          moveIn: data.moveInFrom !== null || data.moveInTo !== null,
          quietHours: data.quietStart !== null,
        },
      });
      await this.events.record(tx, {
        type: 'audience.preferences_updated',
        aggregateType: 'audience_preference',
        aggregateId: row.id,
        tenantId: null,
        payload: { userId },
      });
    });
    return this.view(userId, language);
  }

  /** `POST …/me/recommendations/actions/withdraw`: one tap — consent row `granted=false`, then {@link stop}. */
  async withdraw(userId: string, language: string): Promise<RecommendationsView> {
    const current = await this.db.platform((tx) => this.currentVersion(tx));
    if (current !== null)
      await this.consents.record(
        { type: 'user', id: userId },
        [{ purposeKey: RECOMMENDATIONS_PURPOSE, version: current, granted: false }],
        { channel: 'liff', language: language === 'th' ? 'th' : 'en', tenantIds: [null] },
      );
    await this.db.platform((tx) => this.stop(tx, userId));
    return this.view(userId, language);
  }

  /**
   * Withdrawal takes effect: preferences marked (or deleted at once when the keep setting is 0) and every pending
   * sponsored delivery cancelled. Idempotent (also run by the `consent.changed` subscriber).
   */
  async stop(tx: Tx, userId: string): Promise<void> {
    const now = this.clock.now();
    const cancelled = await tx.sponsoredDelivery.updateMany({
      where: { userId, state: 'pending' },
      data: { state: 'cancelled', failedReason: 'consent withdrawn' },
    });
    const pref = await tx.audiencePreference.findUnique({ where: { userId } });
    const keep = await this.settings.valueAt<number>('audience.preferences.keep_days_after_withdrawal', now);
    if (pref && !pref.withdrawnAt) {
      if (keep === 0) await tx.audiencePreference.delete({ where: { userId } });
      else
        await tx.audiencePreference.update({
          where: { userId },
          data: { withdrawnAt: now, version: { increment: 1 } },
        });
    }
    if (pref && !pref.withdrawnAt) {
      await this.audit.record(tx, {
        action: 'audience.withdrawn',
        subjectType: SUBJECT,
        subjectId: pref.id,
        metadata: { pendingCancelled: cancelled.count, deleted: keep === 0 },
      });
      await this.events.record(tx, {
        type: 'audience.withdrawn',
        aggregateType: 'audience_preference',
        aggregateId: pref.id,
        tenantId: null,
        payload: { userId },
      });
    }
  }

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.payload.purposeKey !== RECOMMENDATIONS_PURPOSE || event.payload.subjectType !== 'user') return;
    if (event.payload.granted === true) return;
    await this.stop(tx, String(event.payload.subjectId));
  }

  /** `GET …/me/recommendations/history`: what was sent to me, newest first (sponsor, listings) — my own data only. */
  async history(userId: string, input: { skip: number; take: number }, lang: 'th' | 'en') {
    return this.db.platform(async (tx) => {
      const where = { userId, state: 'sent' as const };
      const [rows, total] = await Promise.all([
        tx.sponsoredDelivery.findMany({
          where,
          include: { campaign: { select: { listingIds: true, tenant: { select: { displayName: true } } } } },
          orderBy: { sentAt: 'desc' },
          skip: input.skip,
          take: input.take,
        }),
        tx.sponsoredDelivery.count({ where }),
      ]);
      const ids = [...new Set(rows.flatMap((r) => r.campaign.listingIds))];
      const listings = await tx.listing.findMany({
        where: { id: { in: ids } },
        select: { id: true, slug: true, titleTh: true, titleEn: true, state: true, hiddenAt: true },
      });
      const byId = new Map(listings.map((l) => [l.id, l]));
      const items: HistoryItem[] = rows.map((r) => ({
        id: r.id,
        sentAt: r.sentAt!,
        sponsor: r.campaign.tenant.displayName,
        listings: r.campaign.listingIds.flatMap((id) => {
          const l = byId.get(id);
          return l
            ? [
                {
                  slug: l.slug,
                  title: lang === 'en' && l.titleEn ? l.titleEn : l.titleTh,
                  public: l.state === 'published' && !l.hiddenAt,
                },
              ]
            : [];
        }),
      }));
      return { items, total };
    });
  }

  // ------------------------------------------------------------------------------------------------- admin

  /** The `platform.recommendations` text in force (th / en) for the admin console. */
  async consentText() {
    return this.db.platform(async (tx) => {
      const current = await this.currentVersion(tx);
      if (current === null) return null;
      const rows = await tx.consentPurposeVersion.findMany({
        where: { purpose: { key: RECOMMENDATIONS_PURPOSE }, version: current },
      });
      const th = rows.find((r) => r.language === 'th');
      const en = rows.find((r) => r.language === 'en');
      if (!th || !en) return null;
      return {
        version: current,
        effectiveFrom: th.effectiveFrom,
        th: { title: th.title, bodyMarkdown: th.bodyMarkdown },
        en: { title: en.title, bodyMarkdown: en.bodyMarkdown },
      };
    });
  }

  /** People consenting at the current version (an aggregate for the admin console). */
  async consenting(): Promise<number> {
    return this.db.platform(async (tx) => {
      const current = await this.currentVersion(tx);
      if (current === null) return 0;
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM platform.v_consent_state
         WHERE purpose_key = ${RECOMMENDATIONS_PURPOSE} AND granted AND purpose_version >= ${current}`;
      return rows[0]?.n ?? 0;
    });
  }

  /**
   * A new version of the `platform.recommendations` text (th + en; from now or later, never backdated). Once in
   * force every earlier grant counts as not granted — people are asked again; nothing is sent to them meanwhile.
   */
  async publishConsentText(
    input: {
      th: { title: string; bodyMarkdown: string };
      en: { title: string; bodyMarkdown: string };
      effectiveFrom?: string | null;
    },
    actorId: string | null,
  ) {
    const now = this.clock.now();
    const from = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    if (Number.isNaN(from.getTime()) || from.getTime() < now.getTime() - 60_000)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'effectiveFrom', code: 'backdated', message: 'from now or later' }],
      });
    await this.db.platform(async (tx) => {
      const purpose = await tx.consentPurpose.findUnique({ where: { key: RECOMMENDATIONS_PURPOSE } });
      if (!purpose) throw new DomainException('consent.unknown_purpose');
      const top = await tx.consentPurposeVersion.findFirst({
        where: { purposeId: purpose.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (top?.version ?? 0) + 1;
      for (const [language, text] of [
        ['th', input.th],
        ['en', input.en],
      ] as const)
        await tx.consentPurposeVersion.create({
          data: {
            purposeId: purpose.id,
            version,
            language,
            title: text.title.trim(),
            bodyMarkdown: text.bodyMarkdown,
            effectiveFrom: from,
            createdBy: actorId,
          },
        });
      await this.audit.record(tx, {
        action: 'broadcast.consent_text_published',
        subjectType: 'platform.consent_purpose',
        subjectId: purpose.id,
        after: { purpose: RECOMMENDATIONS_PURPOSE, version, effectiveFrom: from.toISOString() },
      });
    });
    return this.consentText();
  }

  /** Maintenance (job `sponsored-broadcasts`): preferences withdrawn longer than the keep setting are deleted. */
  async purgeWithdrawn(): Promise<number> {
    return RequestContext.run({ actor: systemActor('sponsored-broadcasts') }, async () => {
      const now = this.clock.now();
      const keep = await this.settings.valueAt<number>(
        'audience.preferences.keep_days_after_withdrawal',
        now,
      );
      const before = new Date(now.getTime() - keep * 86_400_000);
      return this.db.platform(async (tx) => {
        const due = await tx.audiencePreference.findMany({
          where: { withdrawnAt: { not: null, lte: before } },
          select: { id: true },
          take: 1000,
        });
        if (!due.length) return 0;
        await tx.audiencePreference.deleteMany({ where: { id: { in: due.map((d) => d.id) } } });
        await this.audit.record(tx, {
          action: 'audience.purged',
          subjectType: SUBJECT,
          subjectId: null,
          metadata: { preferences: due.length, keepDays: keep },
        });
        return due.length;
      });
    });
  }
}

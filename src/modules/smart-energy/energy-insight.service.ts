import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { ConsentService } from '@core/privacy/consent.service';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type EnergyInsightOptin } from '@generated/prisma/client';
import {
  type EnergyInsightSharedPayload,
  type EnergyInsightWithdrawnPayload,
} from '@modules/bridge-integrations/getenergy-contract';
import { IntegrationEventsService } from '@modules/bridge-integrations/integration-events.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  decimal,
  type EnergyScore,
  energyScore,
  type HourlyRow,
  type ScoreModel,
  unitCountBand,
} from './energy-score';

export const ENERGY_PURPOSE = 'energy.insight';
const SUBJECT = 'platform.energy_insight_optin';

export interface BuildingRef {
  id: string;
  name: string;
  tenantId: string;
  ownerTenantId: string | null;
  address: unknown;
  property: { address: unknown };
  tenant: { type: string };
}

export interface EnergyInsightView {
  building: { id: string; name: string };
  /** This tenant owns the building and may opt in / out (an operator only reads). */
  canOptIn: boolean;
  optin: EnergyInsightOptin | null;
  window: { from: string; to: string };
  result: EnergyScore;
  consent: { key: string; version: number; title: string; bodyMarkdown: string } | null;
}

const text = (v: unknown, max = 100): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const addressPart = (b: BuildingRef, key: 'province' | 'district') => {
  const own = (b.address ?? {}) as Record<string, unknown>;
  const prop = (b.property.address ?? {}) as Record<string, unknown>;
  return text(own[key]) ?? text(prop[key]);
};

/**
 * Energy insight → getenergy (G9, E15, D-289 (6), D-301; contract O-028, model O-036). The owner console shows a
 * building **energy score** computed from the building's hourly electricity rollups (insight only, D-030). Nothing
 * leaves getproperty until the building's **owner tenant opts in** with the consent `energy.insight` (explicit current
 * version, never assumed): then a subscriber writes an `energy.insight.shared` event into `bridge.integration_event`
 * (outbox → signed webhook / fake transport, D-238) with **aggregate, anonymised** figures only, and the daily job
 * `energy-insight` refreshes it every `energy.insight.share_every_days`. Opting out records the withdrawal, parks
 * every unsent getenergy event of the building and sends `energy.insight.withdrawn` so getenergy deletes the lead.
 */
@Injectable()
export class EnergyInsightService implements EventSubscriber, OnModuleInit {
  readonly name = 'energy-insight';
  readonly eventTypes = ['energy_insight.opted_in', 'energy_insight.opted_out', 'consent.changed'] as const;
  private readonly logger = new Logger(EnergyInsightService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly registry: EventSubscriberRegistry,
    private readonly consents: ConsentService,
    private readonly settings: SettingsService,
    private readonly integrations: IntegrationEventsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ------------------------------------------------------------------------------------------- reads

  /** A building the tenant owns or operates (else 404, D-152). */
  private async building(tx: Tx, ctx: TenantContext, buildingId: string): Promise<BuildingRef> {
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ tenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }, { operatorTenantId: ctx.tenantId }],
      },
      select: {
        id: true,
        name: true,
        tenantId: true,
        ownerTenantId: true,
        address: true,
        property: { select: { address: true } },
        tenant: { select: { type: true } },
      },
    });
    if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(b.id)))
      throw new DomainException('http.not_found');
    return b;
  }

  private ownerOf(b: Pick<BuildingRef, 'tenantId' | 'ownerTenantId'>): string {
    return b.ownerTenantId ?? b.tenantId;
  }

  private async window(): Promise<{ from: string; to: string; minDays: number; model: ScoreModel }> {
    const now = this.clock.now();
    const days = await this.settings.valueAt<number>('energy.insight.window_days', now);
    const today = bangkokDate(now);
    return {
      from: addCalendarDays(today, -days),
      to: today,
      minDays: await this.settings.valueAt<number>('energy.insight.min_days', now),
      model: await this.settings.valueAt<ScoreModel>('energy.insight.score_model', now),
    };
  }

  /** Hourly kWh of the building's electricity meters by purpose / common-area label in [from, to) Bangkok days. */
  private async hourly(tx: Tx, buildingId: string, from: string, to: string): Promise<HourlyRow[]> {
    const rows = await tx.$queryRaw<
      { bucket: Date; purpose: HourlyRow['purpose']; label: string | null; kwh: string }[]
    >`
      SELECT h.bucket, ma.purpose, ma.common_area_label AS label, sum(h.usage * ma.multiplier)::text AS kwh
        FROM smart.telemetry_1h h
        JOIN core.meter_assignment ma
          ON ma.asset_item_id = h.asset_item_id AND ma.utility = 'electric'
         AND ma.valid_from <= h.bucket AND (ma.valid_to IS NULL OR ma.valid_to > h.bucket)
       WHERE h.building_id = ${buildingId}::uuid AND h.unit = 'kwh' AND h.usage IS NOT NULL AND h.usage >= 0
         AND h.bucket >= ${startOfBangkokDay(from)} AND h.bucket < ${startOfBangkokDay(to)}
       GROUP BY 1, 2, 3`;
    return rows.map((r) => ({ bucket: r.bucket, purpose: r.purpose, label: r.label, kwh: Number(r.kwh) }));
  }

  private async scoreIn(tx: Tx, buildingId: string) {
    const w = await this.window();
    return {
      window: { from: w.from, to: w.to },
      result: energyScore(await this.hourly(tx, buildingId, w.from, w.to), w.model, w.minDays),
    };
  }

  private async consentText(tx: Tx, language: string) {
    const versions = await tx.consentPurposeVersion.findMany({
      where: { purpose: { key: ENERGY_PURPOSE }, effectiveFrom: { lte: this.clock.now() } },
      orderBy: { version: 'desc' },
    });
    const top = versions[0]?.version;
    const v =
      versions.find((x) => x.version === top && x.language === language) ??
      versions.find((x) => x.version === top && x.language === 'th');
    return v
      ? { key: ENERGY_PURPOSE, version: v.version, title: v.title, bodyMarkdown: v.bodyMarkdown }
      : null;
  }

  async view(ctx: TenantContext, buildingId: string, language: string): Promise<EnergyInsightView> {
    return this.db.platform(async (tx) => {
      const b = await this.building(tx, ctx, buildingId);
      const owner = this.ownerOf(b) === ctx.tenantId;
      const optin = await tx.energyInsightOptin.findUnique({ where: { buildingId } });
      const { window, result } = await this.scoreIn(tx, buildingId);
      return {
        building: { id: b.id, name: b.name },
        canOptIn: owner,
        optin,
        window,
        result,
        consent: await this.consentText(tx, language),
      };
    });
  }

  // ------------------------------------------------------------------------------------------- opt in / out

  /** The owner opts in (Idempotency-Key on the route); a repeated opt-in while opted in changes nothing. */
  async optIn(ctx: TenantContext, buildingId: string, input: { consentVersion: number; language: string }) {
    const userId = userIdOf(RequestContext.actor());
    if (!userId) throw new DomainException('auth.unauthenticated');
    await this.db.platform(async (tx) => {
      const b = await this.building(tx, ctx, buildingId);
      if (this.ownerOf(b) !== ctx.tenantId) throw new DomainException('energy.owner_required');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`energy-insight:${buildingId}`}))`;
      const existing = await tx.energyInsightOptin.findUnique({ where: { buildingId } });
      if (existing?.state === 'opted_in') return;
      const current = await this.consents.currentVersion(tx, ENERGY_PURPOSE);
      if (current === null || input.consentVersion !== current)
        throw new DomainException('energy.consent_required');
      const consent = await this.consents.recordIn(
        tx,
        { type: 'user', id: userId },
        { purposeKey: ENERGY_PURPOSE, version: current, granted: true },
        { channel: 'web', language: input.language === 'en' ? 'en' : 'th', tenantId: ctx.tenantId },
      );
      const now = this.clock.now();
      const data = {
        state: 'opted_in' as const,
        consentId: consent.id,
        consentPurposeVersionId: consent.purposeVersionId,
        optedInAt: now,
        optedInBy: userId,
        optedOutAt: null,
        optedOutBy: null,
        lastSharedAt: null,
        lastScore: null,
        updatedBy: userId,
      };
      const row = existing
        ? await tx.energyInsightOptin.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.energyInsightOptin.create({
            data: { ...data, tenantId: ctx.tenantId, buildingId, createdBy: userId },
          });
      await this.audit.record(tx, {
        action: 'energy_insight.opted_in',
        tenantId: ctx.tenantId,
        buildingId,
        subjectType: SUBJECT,
        subjectId: row.id,
        after: { state: row.state, consentVersion: current },
      });
      await this.events.record(tx, {
        type: 'energy_insight.opted_in',
        aggregateType: 'energy_insight_optin',
        aggregateId: row.id,
        tenantId: ctx.tenantId,
        buildingId,
        payload: { optinId: row.id, buildingId },
      });
    });
    return this.view(ctx, buildingId, input.language);
  }

  /** The owner opts out: nothing more is sent, unsent events are parked, getenergy is asked to delete the lead. */
  async optOut(ctx: TenantContext, buildingId: string, language: string) {
    const userId = userIdOf(RequestContext.actor());
    if (!userId) throw new DomainException('auth.unauthenticated');
    await this.db.platform(async (tx) => {
      const b = await this.building(tx, ctx, buildingId);
      if (this.ownerOf(b) !== ctx.tenantId) throw new DomainException('energy.owner_required');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`energy-insight:${buildingId}`}))`;
      const row = await tx.energyInsightOptin.findUnique({ where: { buildingId } });
      if (!row || row.state !== 'opted_in') throw new DomainException('energy.invalid_state');
      const current = (await this.consents.currentVersion(tx, ENERGY_PURPOSE)) ?? 1;
      await this.consents.recordIn(
        tx,
        { type: 'user', id: userId },
        { purposeKey: ENERGY_PURPOSE, version: current, granted: false },
        { channel: 'web', language: language === 'en' ? 'en' : 'th', tenantId: ctx.tenantId },
      );
      await this.stopIn(tx, row, { by: userId, reason: 'owner opted out (D-301)' });
    });
    return this.view(ctx, buildingId, language);
  }

  /**
   * The opt-out in the caller's transaction (the owner's opt-out, a withdrawn consent, a share that finds the consent
   * gone): state `opted_out`, every unsent getenergy snapshot of the building parked, audited, and
   * `energy_insight.opted_out` (its subscriber sends `energy.insight.withdrawn` when something may have left).
   */
  private async stopIn(
    tx: Tx,
    row: EnergyInsightOptin,
    input: { by: string | null; reason: string },
  ): Promise<void> {
    const now = this.clock.now();
    const updated = await tx.energyInsightOptin.update({
      where: { id: row.id },
      data: {
        state: 'opted_out',
        optedOutAt: now,
        optedOutBy: input.by,
        version: { increment: 1 },
        updatedBy: input.by,
      },
    });
    // stop at once: whatever was not delivered yet never leaves
    const parked = await tx.integrationEvent.updateMany({
      where: {
        platform: 'getenergy',
        direction: 'outbound',
        buildingId: row.buildingId,
        eventType: 'energy.insight.shared',
        status: { in: ['pending', 'failed'] },
      },
      data: { status: 'dead', lastError: input.reason, nextAttemptAt: null },
    });
    await this.audit.record(tx, {
      action: 'energy_insight.opted_out',
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      subjectType: SUBJECT,
      subjectId: row.id,
      before: { state: row.state },
      after: { state: updated.state, parkedEvents: parked.count, reason: input.reason },
    });
    await this.events.record(tx, {
      type: 'energy_insight.opted_out',
      aggregateType: 'energy_insight_optin',
      aggregateId: row.id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: {
        optinId: row.id,
        buildingId: row.buildingId,
        everShared: row.lastSharedAt !== null || parked.count > 0,
      },
    });
  }

  /** Whose consent an opt-in rests on: the subject of its consent row, else the user who opted in. */
  private async subjectOf(tx: Tx, row: EnergyInsightOptin): Promise<string | null> {
    if (row.consentId) {
      const c = await tx.consent.findUnique({ where: { id: row.consentId }, select: { subjectId: true } });
      if (c) return c.subjectId;
    }
    return row.optedInBy;
  }

  /**
   * True when the subject withdrew `energy.insight` for the purpose as a whole (the consent page: a row without a
   * tenant) after this opt-in and did not grant it again since (G review #2). A building's own opt-out / opt-in rows
   * carry the owner tenant and speak for that building only.
   */
  private async withdrawnSince(tx: Tx, subjectId: string, since: Date): Promise<boolean> {
    const [latest] = await tx.$queryRaw<{ granted: boolean }[]>`
      SELECT c.granted FROM platform.consent c
        JOIN platform.consent_purpose_version v ON v.id = c.purpose_version_id
        JOIN platform.consent_purpose p ON p.id = v.purpose_id
       WHERE c.subject_type = 'user' AND c.subject_id = ${subjectId}::uuid AND p.key = ${ENERGY_PURPOSE}
         AND c.tenant_id IS NULL AND c.captured_at >= ${since}
       ORDER BY c.captured_at DESC, c.id DESC LIMIT 1`;
    return latest?.granted === false;
  }

  // ------------------------------------------------------------------------------------------- subscriber + job

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.type === 'consent.changed') {
      await this.consentChanged(event, tx);
      return;
    }
    const optinId = typeof event.payload.optinId === 'string' ? event.payload.optinId : '';
    if (event.type === 'energy_insight.opted_in') {
      await this.share(tx, optinId, event.id);
      return;
    }
    // opted out: tell getenergy to delete the lead (only when something may have reached it)
    const row = await tx.energyInsightOptin.findUnique({ where: { id: optinId } });
    if (!row || row.state !== 'opted_out' || !row.optedOutAt || event.payload.everShared !== true) return;
    const payload: EnergyInsightWithdrawnPayload = {
      leadId: row.id,
      building: { ref: row.buildingId },
      withdrawnAt: row.optedOutAt.toISOString(),
      reason: 'owner_opted_out',
    };
    await this.integrations.outbound(tx, {
      platform: 'getenergy',
      envelope: {
        eventId: uuidv7(this.clock.now().getTime()),
        type: 'energy.insight.withdrawn',
        version: 1,
        occurredAt: this.clock.now().toISOString(),
        idempotencyKey: `getproperty:energy_insight:${row.id}:withdrawn:${row.optedOutAt.getTime()}`,
        sourcePlatform: 'getproperty',
        tenantId: row.tenantId,
        payload,
      },
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      subjectType: SUBJECT,
      subjectId: row.id,
      causationEventId: event.id,
    });
  }

  /**
   * `consent.changed` (G review #2, D-301 (8)/(9)): `energy.insight` withdrawn on the owner consent page (a row
   * without a tenant) opts out every building whose opt-in rests on that person's earlier grant — exactly as the
   * opt-out does. The building's own opt-out records its withdrawal with the tenant and is handled there.
   */
  private async consentChanged(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const p = event.payload;
    if (p.purposeKey !== ENERGY_PURPOSE || p.subjectType !== 'user' || p.granted !== false) return;
    const consent = await tx.consent.findUnique({
      where: { id: event.aggregateId },
      select: { capturedAt: true, tenantId: true, subjectId: true },
    });
    if (!consent || consent.tenantId !== null) return;
    const rows = await tx.energyInsightOptin.findMany({
      where: {
        state: 'opted_in',
        optedInAt: { lte: consent.capturedAt },
        OR: [{ optedInBy: consent.subjectId }, { consent: { subjectId: consent.subjectId } }],
      },
    });
    for (const row of rows) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`energy-insight:${row.buildingId}`}))`;
      const fresh = await tx.energyInsightOptin.findUnique({ where: { id: row.id } });
      if (fresh?.state !== 'opted_in' || fresh.optedInAt > consent.capturedAt) continue;
      await this.stopIn(tx, fresh, { by: null, reason: 'consent energy.insight withdrawn (D-301)' });
    }
  }

  /**
   * Shares the current snapshot of an opted-in building (in the caller's transaction): nothing when the opt-in is no
   * longer active or the building has no score (insufficient data); one event per opt-in and window end day.
   */
  async share(tx: Tx, optinId: string, causationEventId: string | null): Promise<boolean> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`energy-insight-share:${optinId}`}))`;
    const row = await tx.energyInsightOptin.findUnique({
      where: { id: optinId },
      include: { consentPurposeVersion: { select: { version: true } } },
    });
    if (!row || row.state !== 'opted_in') return false;
    // the consent is checked again at send time (G review #2): withdrawn since the opt-in → opted out, nothing sent
    const subject = await this.subjectOf(tx, row);
    if (!subject || (await this.withdrawnSince(tx, subject, row.optedInAt))) {
      await this.stopIn(tx, row, { by: null, reason: 'consent energy.insight withdrawn (D-301)' });
      return false;
    }
    const b = await tx.building.findUnique({
      where: { id: row.buildingId },
      select: {
        id: true,
        name: true,
        tenantId: true,
        ownerTenantId: true,
        address: true,
        property: { select: { address: true } },
        tenant: { select: { type: true } },
        deletedAt: true,
      },
    });
    // the owner changed (or the building went): the opt-in no longer speaks for it
    if (!b || b.deletedAt || this.ownerOf(b) !== row.tenantId) return false;
    const { window, result } = await this.scoreIn(tx, b.id);
    if (result.score === null) return false;
    const units = await tx.unit.count({ where: { buildingId: b.id, deletedAt: null } });
    const ownerTenant = await tx.tenant.findUnique({ where: { id: row.tenantId }, select: { type: true } });
    const m = result.metrics;
    const payload: EnergyInsightSharedPayload = {
      leadId: row.id,
      building: {
        ref: b.id,
        province: addressPart(b, 'province'),
        district: addressPart(b, 'district'),
        tenantType: ownerTenant?.type ?? b.tenant.type,
        unitCountBand: unitCountBand(units),
      },
      window: { from: window.from, to: addCalendarDays(window.to, -1), dataDays: m.dataDays },
      score: result.score,
      scoreModel: result.modelVersion,
      metrics: {
        basis: m.basis,
        totalKwh: decimal(m.totalKwh),
        commonAreaKwh: decimal(m.commonAreaKwh),
        commonAreaShare: m.commonAreaShare === null ? null : decimal(m.commonAreaShare, 4),
        peakKw: decimal(m.peakKw),
        loadFactor: m.loadFactor === null ? null : decimal(m.loadFactor, 4),
        pumpHoursPerDay: m.pumpHoursPerDay === null ? null : decimal(m.pumpHoursPerDay, 2),
      },
      consent: {
        purposeKey: 'energy.insight',
        version: row.consentPurposeVersion?.version ?? 1,
        grantedAt: row.optedInAt.toISOString(),
      },
    };
    const now = this.clock.now();
    const event = await this.integrations.outbound(tx, {
      platform: 'getenergy',
      envelope: {
        eventId: uuidv7(now.getTime()),
        type: 'energy.insight.shared',
        version: 1,
        occurredAt: now.toISOString(),
        idempotencyKey: `getproperty:energy_insight:${row.id}:shared:${window.to}:${row.optedInAt.getTime()}`,
        sourcePlatform: 'getproperty',
        tenantId: row.tenantId,
        payload,
      },
      tenantId: row.tenantId,
      buildingId: b.id,
      subjectType: SUBJECT,
      subjectId: row.id,
      causationEventId,
    });
    await tx.energyInsightOptin.update({
      where: { id: row.id },
      data: { lastSharedAt: now, lastScore: result.score, lastIntegrationEventId: event.id },
    });
    await this.audit.record(tx, {
      action: 'energy_insight.shared',
      tenantId: row.tenantId,
      buildingId: b.id,
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: { integrationEventId: event.id, score: result.score, window },
    });
    return true;
  }

  /** Job `energy-insight` (daily): refreshes the snapshot of opted-in buildings every `share_every_days`. */
  async run(): Promise<number> {
    return RequestContext.run({ actor: systemActor('energy-insight') }, async () => {
      const now = this.clock.now();
      const every = await this.settings.valueAt<number>('energy.insight.share_every_days', now);
      const due = new Date(now.getTime() - every * 86_400_000);
      const rows = await this.db.platform((tx) =>
        tx.energyInsightOptin.findMany({
          where: { state: 'opted_in', OR: [{ lastSharedAt: null }, { lastSharedAt: { lte: due } }] },
          select: { id: true },
          take: 500,
        }),
      );
      let shared = 0;
      for (const r of rows) {
        try {
          if (await this.db.platform((tx) => this.share(tx, r.id, null))) shared += 1;
        } catch (error) {
          this.logger.error(`energy insight share ${r.id} failed: ${(error as Error).message}`);
        }
      }
      return shared;
    });
  }
}

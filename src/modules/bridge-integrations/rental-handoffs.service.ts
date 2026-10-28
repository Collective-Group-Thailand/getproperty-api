import { createHash, randomBytes } from 'node:crypto';

import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type PortfolioUnitKind, type Prisma, type RentalHandoff } from '@generated/prisma/client';
import {
  GETBUILD_HANDOFF,
  type GetbuildHandoffPort,
  type GetbuildUnitFacts,
} from '@integrations/getbuild/getbuild-handoff.port';
import { ListingsService } from '@modules/ops-listings/listings.service';
import { type PortfolioAddress, PortfolioService } from '@modules/ops-units/portfolio.service';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { IntegrationEventsService } from './integration-events.service';

const SUBJECT = 'ops.rental_handoff';
/** Delivery attempts through the port before the handoff waits for an admin resend. */
export const MAX_HANDOFF_DELIVERIES = 10;
const BATCH = 50;

/** What the handoff keeps about the unit (prefill of the portfolio wizard and the listing draft). */
export type HandoffFacts = Partial<GetbuildUnitFacts> & { kind?: PortfolioUnitKind };

export interface ClaimInput {
  token: string;
  /** Monthly rent of the draft (THB, decimal string) — the buyer's own figure. */
  rent: string;
  titleTh?: string;
  titleEn?: string | null;
  /** Needed only when getbuild could not tell the address (port off / unknown unit). */
  address?: PortfolioAddress;
}

/** Facts are plain JSON objects (strings, numbers, a nested address). */
const asJson = (value: HandoffFacts): Prisma.InputJsonValue => value;

export const tokenHash = (token: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(token, 'utf8').digest());

/** The first word of the buyer's name — all a public preview shows (D-025 minimisation). */
export const firstName = (displayName: string): string => displayName.trim().split(/\s+/)[0] ?? '';

/** A draft title from the facts (the owner edits it before submitting). */
export function draftTitles(facts: HandoffFacts): { th: string; en: string } {
  const project = facts.projectName?.trim() || 'คอนโด';
  const area = facts.areaSqm ? new Decimal(facts.areaSqm).toDecimalPlaces(1).toString() : null;
  const th = [project, facts.bedrooms ? `${facts.bedrooms} ห้องนอน` : null, area ? `${area} ตร.ม.` : null]
    .filter(Boolean)
    .join(' ');
  const en = [
    facts.bedrooms ? `${facts.bedrooms}-bedroom` : 'Unit',
    area ? `${area} sqm` : null,
    `at ${project}`,
  ]
    .filter(Boolean)
    .join(' ');
  return { th: th.slice(0, 120), en: en.slice(0, 120) };
}

/** `unit.transferred` payload (asset-core contract) as far as the handoff reads it. */
interface TransferPayload {
  buildingRef: string;
  unitRef: string;
  transferDate: string;
  rentalIntent: boolean;
  buyer: { ref: string; displayName: string; lineUserId?: string; language?: string };
}

/**
 * getbuild rental handoff (G8, D-289 (5), D-299): a buyer who told getbuild they want to rent the unit out
 * (`unit.transferred` with `rentalIntent`, received on the signed webhook, D-238) is invited to the landlord tier —
 * **once per transfer**. getbuild holds the buyer relationship: the invitation link (single-use token, sha256 kept)
 * goes back through the `GETBUILD_HANDOFF` port and getbuild shows it in its buyer portal; getproperty never messages
 * the buyer itself and keeps no phone or e-mail (minimisation). Claiming it (a landlord tenant, free — D-284) adds the
 * unit to the portfolio (ownership `getbuild_transfer`) with a prefilled listing draft tagged with the developer
 * campaign; its publication marks the handoff `listed`.
 */
@Injectable()
export class RentalHandoffsService implements EventSubscriber, OnModuleInit {
  readonly name = 'rental-handoffs';
  readonly eventTypes = ['listing.published'] as const;
  private readonly logger = new Logger(RentalHandoffsService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly integrations: IntegrationEventsService,
    private readonly registry: EventSubscriberRegistry,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly portfolio: PortfolioService,
    private readonly listings: ListingsService,
    private readonly config: AppConfig,
    @Inject(GETBUILD_HANDOFF) private readonly getbuild: GetbuildHandoffPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.integrations.onInbound('unit.transferred', (tx, envelope, row) =>
      this.received(tx, envelope, row.id),
    );
  }

  // ---------------------------------------------------------------------------------------------- inbound event

  /** Applies `unit.transferred` inside the receiving transaction; no rental intent = nothing to do. */
  async received(tx: Tx, envelope: Record<string, unknown>, integrationEventId: string): Promise<void> {
    const p = envelope.payload as TransferPayload;
    if (!p.rentalIntent) return;
    const developerRef = (
      typeof envelope.tenantId === 'string' ? envelope.tenantId : `source:${String(envelope.sourcePlatform)}`
    ).slice(0, 100);
    const transferDate = new Date(`${p.transferDate}T00:00:00Z`);
    const existing = await tx.rentalHandoff.findUnique({
      where: {
        developerRef_unitRef_transferDate: { developerRef, unitRef: p.unitRef, transferDate },
      },
      select: { id: true },
    });
    if (existing) return; // the same transfer re-sent under another key: once per transfer
    const now = this.clock.now();
    const [tags, validDays] = await Promise.all([
      this.settings.valueAt<Record<string, string>>('getbuild.handoff.campaign_tags', now),
      this.settings.valueAt<number>('getbuild.handoff.valid_days', now),
    ]);
    const campaignTag = (tags?.[developerRef] ?? `getbuild:${developerRef}`).slice(0, 100);
    const row = await tx.rentalHandoff.create({
      data: {
        integrationEventId,
        developerRef,
        buildingRef: p.buildingRef.slice(0, 100),
        unitRef: p.unitRef.slice(0, 100),
        transferDate,
        buyerRef: p.buyer.ref.slice(0, 100),
        buyerDisplayName: p.buyer.displayName.slice(0, 300),
        buyerLanguage: p.buyer.language?.slice(0, 2) ?? null,
        buyerLineHash: p.buyer.lineUserId ? tokenHash(p.buyer.lineUserId) : null,
        campaignTag,
        expiresAt: new Date(now.getTime() + validDays * 86_400_000),
      },
    });
    await this.audit.record(tx, {
      action: 'rental_handoff.created',
      subjectType: SUBJECT,
      subjectId: row.id,
      after: { developerRef, unitRef: row.unitRef, transferDate: p.transferDate, campaignTag },
    });
    await this.events.record(tx, {
      type: 'rental_handoff.created',
      aggregateType: 'rental_handoff',
      aggregateId: row.id,
      tenantId: null,
      payload: { handoffId: row.id, campaignTag, integrationEventId },
    });
  }

  // ---------------------------------------------------------------------------------------------- delivery job

  /**
   * Worker job `rental-handoffs`: invitations not delivered yet get a fresh single-use token and go to getbuild
   * through the port (outside any transaction); invited handoffs past `expires_at` expire. Port off → they wait.
   */
  async maintain(): Promise<{ delivered: number; expired: number }> {
    return RequestContext.run({ actor: systemActor('rental-handoffs') }, async () => {
      const now = this.clock.now();
      let expired = 0;
      const old = await this.db.platform((tx) =>
        tx.rentalHandoff.findMany({
          where: { state: 'invited', expiresAt: { lte: now } },
          select: { id: true },
          take: 500,
        }),
      );
      for (const { id } of old) {
        const done = await this.db.platform(async (tx) => {
          const hit = await tx.rentalHandoff.updateMany({
            where: { id, state: 'invited', expiresAt: { lte: now } },
            data: { state: 'expired', expiredAt: now, version: { increment: 1 } },
          });
          if (!hit.count) return false;
          await this.audit.record(tx, {
            action: 'rental_handoff.expired',
            subjectType: SUBJECT,
            subjectId: id,
          });
          await this.events.record(tx, {
            type: 'rental_handoff.expired',
            aggregateType: 'rental_handoff',
            aggregateId: id,
            tenantId: null,
            payload: { handoffId: id },
          });
          return true;
        });
        if (done) expired += 1;
      }
      if (this.getbuild.mode === 'off') return { delivered: 0, expired };
      const due = await this.db.platform((tx) =>
        tx.rentalHandoff.findMany({
          where: {
            state: 'invited',
            deliveredAt: null,
            expiresAt: { gt: now },
            deliveryAttempts: { lt: MAX_HANDOFF_DELIVERIES },
          },
          orderBy: { createdAt: 'asc' },
          take: BATCH,
        }),
      );
      let delivered = 0;
      for (const row of due) if (await this.deliver(row)) delivered += 1;
      return { delivered, expired };
    });
  }

  private hasFacts(facts: unknown): boolean {
    return Boolean(facts && typeof facts === 'object' && Object.keys(facts).length);
  }

  /** One delivery: facts fetched once, a new token (the previous link stops working), the port call, the outcome. */
  private async deliver(row: RentalHandoff): Promise<boolean> {
    const ref = { developerRef: row.developerRef, buildingRef: row.buildingRef, unitRef: row.unitRef };
    let facts = row.facts as HandoffFacts;
    if (!this.hasFacts(facts)) {
      try {
        facts = (await this.getbuild.unitFacts(ref)) ?? {};
        if (this.hasFacts(facts))
          await this.db.platform((tx) =>
            tx.rentalHandoff.update({
              where: { id: row.id },
              data: { facts: asJson(facts) },
            }),
          );
      } catch (error) {
        this.logger.warn({
          event: 'getbuild_facts_failed',
          handoffId: row.id,
          error: (error as Error).message,
        });
      }
    }
    const token = randomBytes(24).toString('base64url');
    await this.db.platform((tx) =>
      tx.rentalHandoff.update({ where: { id: row.id }, data: { tokenHash: tokenHash(token) } }),
    );
    try {
      await this.getbuild.deliverInvitation({
        ...ref,
        handoffId: row.id,
        buyerRef: row.buyerRef,
        url: `${this.config.get('PUBLIC_WEB_APP_URL')}/handoff/${token}`,
        campaignTag: row.campaignTag,
        expiresAt: row.expiresAt.toISOString(),
      });
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await this.db.platform((tx) =>
        tx.rentalHandoff.update({
          where: { id: row.id },
          data: { tokenHash: null, deliveryAttempts: { increment: 1 }, lastDeliveryError: message },
        }),
      );
      this.logger.warn({ event: 'getbuild_delivery_failed', handoffId: row.id, error: message });
      return false;
    }
    const now = this.clock.now();
    await this.db.platform(async (tx) => {
      await tx.rentalHandoff.update({
        where: { id: row.id },
        data: {
          deliveredAt: now,
          deliveryAttempts: { increment: 1 },
          lastDeliveryError: null,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'rental_handoff.delivered',
        subjectType: SUBJECT,
        subjectId: row.id,
      });
      await this.events.record(tx, {
        type: 'rental_handoff.delivered',
        aggregateType: 'rental_handoff',
        aggregateId: row.id,
        tenantId: null,
        payload: { handoffId: row.id },
      });
    });
    return true;
  }

  // ---------------------------------------------------------------------------------------------- buyer (public)

  private async byToken(tx: Tx, token: string): Promise<RentalHandoff> {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(token)) throw new DomainException('http.not_found');
    const row = await tx.rentalHandoff.findFirst({ where: { tokenHash: tokenHash(token) } });
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  /** An invited handoff past its date counts as expired at once (the job records it later). */
  effectiveState(row: Pick<RentalHandoff, 'state' | 'expiresAt'>): RentalHandoff['state'] {
    return row.state === 'invited' && row.expiresAt <= this.clock.now() ? 'expired' : row.state;
  }

  preview(token: string): Promise<RentalHandoff> {
    return this.db.platform((tx) => this.byToken(tx, token));
  }

  async decline(token: string): Promise<RentalHandoff> {
    return RequestContext.run({ actor: systemActor('rental-handoff-buyer') }, () =>
      this.db.platform(async (tx) => {
        const row = await this.byToken(tx, token);
        if (row.state === 'declined') return row; // a repeated decline answers the same outcome
        if (this.effectiveState(row) !== 'invited' || row.tenantId)
          throw new DomainException('handoff.invalid_state');
        const now = this.clock.now();
        const updated = await tx.rentalHandoff.update({
          where: { id: row.id },
          data: { state: 'declined', declinedAt: now, version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          action: 'rental_handoff.declined',
          subjectType: SUBJECT,
          subjectId: row.id,
        });
        await this.events.record(tx, {
          type: 'rental_handoff.declined',
          aggregateType: 'rental_handoff',
          aggregateId: row.id,
          tenantId: null,
          payload: { handoffId: row.id },
        });
        return updated;
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------- landlord

  /**
   * `POST /v1/owner/rental-handoffs/actions/claim`: the buyer, signed in as a landlord, takes the handoff — the unit
   * joins the portfolio (ownership `getbuild_transfer`) and a listing draft is prefilled with the facts, the rent the
   * buyer typed and the developer campaign tag. Reserved for the tenant first (a second tenant gets 409), so a failure
   * half-way is finished by retrying.
   */
  async claim(ctx: TenantContext, input: ClaimInput): Promise<RentalHandoff> {
    const tenant = await this.db.tenant(ctx, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { type: true } }),
    );
    if (tenant.type !== 'landlord') throw new DomainException('handoff.landlord_required');
    const by = userIdOf(RequestContext.actor());
    const reserved = await this.db.platform(async (tx) => {
      const row = await this.byToken(tx, input.token);
      if (row.tenantId === ctx.tenantId && (row.state === 'accepted' || row.state === 'listed')) return row;
      if (this.effectiveState(row) !== 'invited') throw new DomainException('handoff.invalid_state');
      if (row.tenantId && row.tenantId !== ctx.tenantId) throw new DomainException('handoff.invalid_state');
      if (!row.tenantId) {
        const hit = await tx.rentalHandoff.updateMany({
          where: { id: row.id, state: 'invited', tenantId: null },
          data: { tenantId: ctx.tenantId, claimedBy: by },
        });
        if (!hit.count) throw new DomainException('handoff.invalid_state');
      }
      return { ...row, tenantId: ctx.tenantId };
    });
    if (reserved.state !== 'invited') return reserved;
    try {
      return await this.finishClaim(ctx, reserved, input);
    } catch (error) {
      if (!reserved.unitId)
        await this.db.platform((tx) =>
          tx.rentalHandoff.updateMany({
            where: { id: reserved.id, state: 'invited', unitId: null },
            data: { tenantId: null, claimedBy: null },
          }),
        );
      throw error;
    }
  }

  private async finishClaim(
    ctx: TenantContext,
    row: RentalHandoff,
    input: ClaimInput,
  ): Promise<RentalHandoff> {
    let facts = row.facts as HandoffFacts;
    if (!this.hasFacts(facts) || !facts.address) {
      const fetched = await this.getbuild
        .unitFacts({ developerRef: row.developerRef, buildingRef: row.buildingRef, unitRef: row.unitRef })
        .catch(() => null);
      if (fetched) facts = { ...fetched, ...facts, address: facts.address ?? fetched.address };
    }
    const address = input.address ?? facts.address;
    if (!address)
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'address', code: 'required', message: 'getbuild did not tell the address: enter it' },
        ],
      });
    const kind: PortfolioUnitKind = facts.kind ?? 'condo_unit';
    const projectName = facts.projectName?.trim() || `getbuild ${row.buildingRef}`;
    let unitId = row.unitId;
    if (!unitId) {
      const added = await this.portfolio.addUnit(ctx, {
        kind,
        projectName,
        unitNo: facts.unitNo?.trim() || row.unitRef,
        address,
        lat: facts.lat,
        lng: facts.lng,
        areaSqm: facts.areaSqm,
        bedrooms: facts.bedrooms,
        bathrooms: facts.bathrooms,
        floorLabel: facts.floorLabel,
        defaultRent: input.rent,
        ownership: {
          source: 'getbuild_transfer',
          sourceRef: `getbuild:${row.developerRef}:${row.unitRef}`.slice(0, 200),
        },
      });
      unitId = added.unitId;
      await this.db.platform((tx) =>
        tx.rentalHandoff.update({
          where: { id: row.id },
          data: { unitId, facts: asJson({ ...facts, address }) },
        }),
      );
    }
    const titles = draftTitles({ ...facts, projectName });
    const listing = await this.listings.create(ctx, {
      unitId,
      titleTh: input.titleTh?.trim() || titles.th,
      titleEn: input.titleEn === undefined ? titles.en : input.titleEn,
      rent: input.rent,
    });
    await this.db.tenant(ctx, (tx) =>
      tx.listing.update({ where: { id: listing.id }, data: { campaignTag: row.campaignTag } }),
    );
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const updated = await tx.rentalHandoff.update({
        where: { id: row.id },
        data: {
          state: 'accepted',
          unitId,
          listingId: listing.id,
          acceptedAt: now,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'rental_handoff.accepted',
        tenantId: ctx.tenantId,
        subjectType: SUBJECT,
        subjectId: row.id,
        after: { unitId, listingId: listing.id, campaignTag: row.campaignTag },
      });
      await this.events.record(tx, {
        type: 'rental_handoff.accepted',
        aggregateType: 'rental_handoff',
        aggregateId: row.id,
        tenantId: ctx.tenantId,
        payload: { handoffId: row.id, unitId, listingId: listing.id, campaignTag: row.campaignTag },
      });
      return updated;
    });
  }

  listOwn(ctx: TenantContext): Promise<RentalHandoff[]> {
    return this.db.tenant(ctx, (tx) =>
      tx.rentalHandoff.findMany({
        where: { tenantId: ctx.tenantId, state: { in: ['accepted', 'listed'] } },
        orderBy: { acceptedAt: 'desc' },
      }),
    );
  }

  /** `listing.published`: the draft of a claimed handoff went live → `listed` (once). */
  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    const listingId = event.payload.listingId;
    if (typeof listingId !== 'string') return;
    const row = await tx.rentalHandoff.findFirst({ where: { listingId, state: 'accepted' } });
    if (!row) return;
    const now = this.clock.now();
    await tx.rentalHandoff.update({
      where: { id: row.id },
      data: { state: 'listed', listedAt: now, version: { increment: 1 } },
    });
    await this.audit.record(tx, {
      action: 'rental_handoff.listed',
      tenantId: row.tenantId,
      subjectType: SUBJECT,
      subjectId: row.id,
      after: { listingId, campaignTag: row.campaignTag },
    });
    await this.events.record(tx, {
      type: 'rental_handoff.listed',
      aggregateType: 'rental_handoff',
      aggregateId: row.id,
      tenantId: row.tenantId,
      payload: { handoffId: row.id, listingId, campaignTag: row.campaignTag },
    });
  }

  // ---------------------------------------------------------------------------------------------- platform

  async adminList(q: { state?: RentalHandoff['state']; skip: number; take: number }) {
    const where: Prisma.RentalHandoffWhereInput = q.state ? { state: q.state } : {};
    return this.db.platform(async (tx) => ({
      rows: await tx.rentalHandoff.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.take,
      }),
      total: await tx.rentalHandoff.count({ where }),
    }));
  }

  /** Admin resend: a new token goes to getbuild now (the old link stops working); the attempt counter restarts. */
  async resend(id: string): Promise<RentalHandoff> {
    const row = await this.db.platform(async (tx) => {
      const found = await tx.rentalHandoff.findUnique({ where: { id } });
      if (!found) throw new DomainException('http.not_found');
      if (this.effectiveState(found) !== 'invited' || found.tenantId)
        throw new DomainException('handoff.invalid_state');
      const reset = await tx.rentalHandoff.update({
        where: { id },
        data: { deliveredAt: null, tokenHash: null, deliveryAttempts: 0, lastDeliveryError: null },
      });
      await this.audit.record(tx, { action: 'rental_handoff.resent', subjectType: SUBJECT, subjectId: id });
      return reset;
    });
    if (this.getbuild.mode !== 'off') await this.deliver(row);
    return this.db.platform((tx) => tx.rentalHandoff.findUniqueOrThrow({ where: { id } }));
  }
}

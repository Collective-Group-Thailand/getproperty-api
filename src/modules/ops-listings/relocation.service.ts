import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { registerNotifiable } from '@core/notifications/notifiable-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type Prisma, type RelocationOffer } from '@generated/prisma/client';
import { RentRecordService } from '@modules/ops-leases/rent-record.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';

import { ListingLeadsService } from './listing-leads.service';
import { PublicListingsService } from './public-listings.service';

export const RELOCATION_PURPOSE = 'resident.relocation';
const SUBJECT = 'ops.relocation_offer';
/** Lease parties who live there and may be moving (not a guarantor). */
const MOVING_ROLES = ['lessee', 'co_tenant', 'occupant'] as const;
const UNDER_NOTICE = ['notice_given', 'ending'] as const;

export const OFFER_INCLUDE = {
  lease: {
    select: {
      id: true,
      noticeEffectiveDate: true,
      endDate: true,
      unit: { select: { unitNo: true } },
      tenant: { select: { displayName: true } },
    },
  },
} as const satisfies Prisma.RelocationOfferInclude;
export type OfferRow = Prisma.RelocationOfferGetPayload<{ include: typeof OFFER_INCLUDE }>;

export interface DestinationInput {
  /** An area / station slug of `GET /v1/public/listings/areas`, or a province (+ district). */
  areaSlug?: string | null;
  province?: string | null;
  district?: string | null;
  /** Decimal string. */
  maxRent?: string | null;
}

export interface EnquireInput {
  listingSlug: string;
  message: string;
  moveInDate?: string | null;
  /** Send my B7.11 rent record to the new landlord with this enquiry. */
  shareRentRecord: boolean;
  /** Purpose `prospect.enquiry` for the new landlord (PDPA, as any enquiry). */
  consent: boolean;
}

/**
 * Relocation network (G8, D-289 (2), D-299). A resident who gives (or gets) notice and **consented** to purpose
 * `resident.relocation` (Collective is the controller; optional, never pre-ticked) gets one relocation offer per lease:
 * they tell us where they are moving (area or province / district, a budget) and see public listings there; with an
 * explicit action they enquire as a prospect and may send their rent record (B7.11) to the new landlord — the record
 * travels only by that action. No consent → no offer row, no message, no matching (no profiling). Withdrawal stops
 * every open offer at once and erases its destination. The landlord never sees an offer (platform-only rows).
 */
@Injectable()
export class RelocationService implements EventSubscriber, OnModuleInit {
  readonly name = 'relocation';
  readonly eventTypes = ['lease.notice_given', 'consent.changed'] as const;

  constructor(
    private readonly db: TenantTx,
    private readonly registry: EventSubscriberRegistry,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly publicListings: PublicListingsService,
    private readonly leads: ListingLeadsService,
    private readonly rentRecord: RentRecordService,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    registerNotifiable('relocation.offer_ready', async (tx, e) => {
      const user = await tx.userAccount.findUnique({
        where: { id: String(e.payload.userId) },
        select: { id: true, language: true, lineUserId: true, status: true },
      });
      if (!user || user.status !== 'active') return null;
      return {
        recipients: [
          {
            audience: 'resident',
            type: 'user',
            id: user.id,
            tenantId: null,
            language: user.language,
            line: user.lineUserId,
          },
        ],
        data: {
          unit: { unitNo: typeof e.payload.unitNo === 'string' ? e.payload.unitNo : '' },
          link: `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/relocation/${String(e.payload.offerId)}`,
        },
        consentPurpose: RELOCATION_PURPOSE,
      };
    });
  }

  /** The current consent row of the user for `resident.relocation` when granted at the current version, else null. */
  async consent(tx: Tx, userId: string): Promise<string | null> {
    const rows = await tx.$queryRaw<{ consent_id: string; granted: boolean; purpose_version: number }[]>`
      SELECT consent_id, granted, purpose_version FROM platform.v_consent_state
       WHERE subject_type = 'user'::platform.consent_subject AND subject_id = ${userId}::uuid
         AND purpose_key = ${RELOCATION_PURPOSE}`;
    const current = await tx.consentPurposeVersion.findFirst({
      where: { purpose: { key: RELOCATION_PURPOSE }, effectiveFrom: { lte: this.clock.now() } },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const row = rows[0];
    return row?.granted && current && row.purpose_version >= current.version ? row.consent_id : null;
  }

  // ------------------------------------------------------------------------------------------- subscribers

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (event.type === 'lease.notice_given') {
      const leaseId = event.payload.leaseId;
      if (typeof leaseId !== 'string') return;
      for (const userId of await this.movingUsers(tx, leaseId)) await this.open(tx, leaseId, userId);
      return;
    }
    // consent.changed
    if (event.payload.purposeKey !== RELOCATION_PURPOSE || event.payload.subjectType !== 'user') return;
    const userId = String(event.payload.subjectId);
    if (event.payload.granted === true) {
      const leases = await tx.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT l.id FROM ops.lease l
          LEFT JOIN ops.lease_party lp ON lp.lease_id = l.id AND lp.role::text = ANY (${[...MOVING_ROLES]}::text[])
          JOIN core.party_user_link u ON u.party_id IN (l.lessee_party_id, lp.party_id) AND u.state = 'active'
         WHERE u.user_id = ${userId}::uuid AND l.status::text = ANY (${[...UNDER_NOTICE]}::text[])`;
      for (const l of leases) await this.open(tx, l.id, userId);
    } else {
      await this.withdraw(tx, userId);
    }
  }

  private async movingUsers(tx: Tx, leaseId: string): Promise<string[]> {
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: { lesseePartyId: true, parties: { select: { partyId: true, role: true } } },
    });
    if (!lease) return [];
    const partyIds = [
      lease.lesseePartyId,
      ...lease.parties
        .filter((p) => (MOVING_ROLES as readonly string[]).includes(p.role))
        .map((p) => p.partyId),
    ];
    const links = await tx.partyUserLink.findMany({
      where: { partyId: { in: partyIds }, state: 'active' },
      select: { userId: true },
    });
    return [...new Set(links.map((l) => l.userId))];
  }

  /** Opens one offer for a consenting user of a lease under notice (idempotent); notifies once. */
  private async open(tx: Tx, leaseId: string, userId: string): Promise<void> {
    const consentId = await this.consent(tx, userId);
    if (!consentId) return;
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        noticeEffectiveDate: true,
        endDate: true,
        unit: { select: { unitNo: true } },
      },
    });
    if (!lease || !(UNDER_NOTICE as readonly string[]).includes(lease.status)) return;
    const existing = await tx.relocationOffer.findUnique({
      where: { leaseId_userId: { leaseId, userId } },
    });
    if (existing && existing.state !== 'withdrawn') return;
    const now = this.clock.now();
    const offer = existing
      ? await tx.relocationOffer.update({
          where: { id: existing.id },
          data: { state: 'open', consentId, closedAt: null, notifiedAt: now, version: { increment: 1 } },
        })
      : await tx.relocationOffer.create({
          data: {
            tenantId: lease.tenantId,
            leaseId,
            userId,
            consentId,
            moveOutDate: lease.noticeEffectiveDate ?? lease.endDate,
            notifiedAt: now,
          },
        });
    // audit without the landlord's tenant: the row is the resident's, not the landlord's (platform-only)
    await this.audit.record(tx, {
      action: 'relocation.offer_created',
      subjectType: SUBJECT,
      subjectId: offer.id,
      metadata: { leaseId, userId },
    });
    await this.events.record(tx, {
      type: 'relocation.offer_ready',
      aggregateType: 'relocation_offer',
      aggregateId: offer.id,
      tenantId: null,
      payload: { offerId: offer.id, userId, unitNo: lease.unit.unitNo },
    });
  }

  /** Consent withdrawn: every open offer of the user stops and its destination is erased (PDPA). */
  private async withdraw(tx: Tx, userId: string): Promise<void> {
    const open = await tx.relocationOffer.findMany({
      where: { userId, state: 'open' },
      select: { id: true },
    });
    if (!open.length) return;
    const now = this.clock.now();
    for (const { id } of open) {
      await tx.relocationOffer.update({
        where: { id },
        data: {
          state: 'withdrawn',
          closedAt: now,
          areaSlug: null,
          province: null,
          district: null,
          maxRent: null,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, { action: 'relocation.withdrawn', subjectType: SUBJECT, subjectId: id });
      await this.events.record(tx, {
        type: 'relocation.offer_withdrawn',
        aggregateType: 'relocation_offer',
        aggregateId: id,
        tenantId: null,
        payload: { offerId: id, userId },
      });
    }
  }

  // ------------------------------------------------------------------------------------------- resident

  private userId(): string {
    const id = userIdOf(RequestContext.actor());
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  private async mine(tx: Tx, userId: string, id: string): Promise<OfferRow> {
    const offer = await tx.relocationOffer.findFirst({ where: { id, userId }, include: OFFER_INCLUDE });
    if (!offer) throw new DomainException('http.not_found');
    return offer;
  }

  /** Re-checks consent on every use (the `consent.changed` subscriber closes the offers; this refuses at once). */
  private async requireConsent(tx: Tx, userId: string): Promise<string> {
    const consentId = await this.consent(tx, userId);
    if (!consentId) throw new DomainException('relocation.consent_required');
    return consentId;
  }

  /** My offers with the listings matching each open offer's destination (only while I consent). */
  async list(lang: 'th' | 'en') {
    const userId = this.userId();
    const { offers, consented } = await this.db.platform(async (tx) => {
      const consentId = await this.consent(tx, userId);
      if (!consentId) await this.withdraw(tx, userId);
      return {
        consented: Boolean(consentId),
        offers: await tx.relocationOffer.findMany({
          where: { userId },
          include: OFFER_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      };
    });
    const limit = await this.settings.valueAt<number>('relocation.offer.max_listings', this.clock.now());
    return {
      consented,
      offers: await Promise.all(
        offers.map(async (offer) => ({
          offer,
          listings: consented && offer.state === 'open' ? await this.matches(offer, lang, limit) : [],
        })),
      ),
    };
  }

  async matches(offer: RelocationOffer, lang: 'th' | 'en', limit: number) {
    if (!offer.areaSlug && !offer.province) return [];
    const page = await this.publicListings.search(
      {
        area: offer.areaSlug ?? undefined,
        province: offer.areaSlug ? undefined : (offer.province ?? undefined),
        district: offer.areaSlug ? undefined : (offer.district ?? undefined),
        maxRent: offer.maxRent ? offer.maxRent.toFixed(2) : undefined,
        sort: 'newest',
        limit,
      },
      lang,
    );
    return page.data.slice(0, limit);
  }

  async setDestination(id: string, input: DestinationInput): Promise<OfferRow> {
    const userId = this.userId();
    const areaSlug = input.areaSlug?.trim() || null;
    const province = input.province?.trim() || null;
    const district = input.district?.trim() || null;
    if (!areaSlug && !province)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'areaSlug', code: 'required', message: 'an area or a province' }],
      });
    if (district && !province)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'province', code: 'required', message: 'the province of the district' }],
      });
    let maxRent: string | null = null;
    if (input.maxRent) {
      const d = new Decimal(input.maxRent);
      if (d.lte(0))
        throw new DomainException('validation.failed', {
          errors: [{ path: 'maxRent', code: 'min', message: 'above zero' }],
        });
      maxRent = d.toFixed(2);
    }
    return this.db.platform(async (tx) => {
      const offer = await this.mine(tx, userId, id);
      await this.requireConsent(tx, userId);
      if (offer.state !== 'open') throw new DomainException('relocation.invalid_state');
      await tx.relocationOffer.update({
        where: { id },
        data: {
          areaSlug,
          province: areaSlug ? null : province,
          district: areaSlug ? null : district,
          maxRent,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'relocation.destination_set',
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { area: Boolean(areaSlug), province: Boolean(province), budget: Boolean(maxRent) },
      });
      return this.mine(tx, userId, id);
    });
  }

  /**
   * Enquire about a listing from my offer (B7.3 as a prospect; consent `prospect.enquiry` for the new landlord) and,
   * only when I ask, send my rent record with it (B7.11) — the record travels by this action alone.
   */
  async enquire(id: string, input: EnquireInput) {
    const userId = this.userId();
    await this.db.platform(async (tx) => {
      const offer = await this.mine(tx, userId, id);
      await this.requireConsent(tx, userId);
      if (offer.state !== 'open') throw new DomainException('relocation.invalid_state');
    });
    const { lead, created } = await this.leads.enquire(input.listingSlug, {
      message: input.message,
      moveInDate: input.moveInDate ?? null,
      consent: input.consent,
    });
    let rentRecordShared = false;
    if (input.shareRentRecord) {
      try {
        await this.rentRecord.shareWithLead(userId, lead.id);
        rentRecordShared = true;
      } catch (error) {
        if (!(error instanceof DomainException) || error.code !== 'rent_record.empty') throw error;
      }
    }
    await this.db.platform(async (tx) => {
      const offer = await this.mine(tx, userId, id);
      const listingId = lead.listingId;
      const clicked = [...new Set([...offer.clickedListingIds, listingId])].slice(-50);
      await tx.relocationOffer.update({
        where: { id },
        data: { clickedListingIds: clicked, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'relocation.enquired',
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { listingId, leadId: lead.id, rentRecordShared },
      });
    });
    return { leadId: lead.id, listingId: lead.listingId, created, rentRecordShared };
  }

  async dismiss(id: string): Promise<OfferRow> {
    const userId = this.userId();
    return this.db.platform(async (tx) => {
      const offer = await this.mine(tx, userId, id);
      if (offer.state !== 'open') throw new DomainException('relocation.invalid_state');
      await tx.relocationOffer.update({
        where: { id },
        data: {
          state: 'dismissed',
          closedAt: this.clock.now(),
          areaSlug: null,
          province: null,
          district: null,
          maxRent: null,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, { action: 'relocation.dismissed', subjectType: SUBJECT, subjectId: id });
      return this.mine(tx, userId, id);
    });
  }

  // ------------------------------------------------------------------------------------------- job

  /** Worker job `relocation-offers`: open offers close `relocation.offer.keep_days` after the lease ended. */
  async maintain(): Promise<number> {
    return RequestContext.run({ actor: systemActor('relocation-offers') }, async () => {
      const now = this.clock.now();
      const keep = await this.settings.valueAt<number>('relocation.offer.keep_days', now);
      const cutoff = addCalendarDays(bangkokDate(now), -keep);
      return this.db.platform(async (tx) => {
        const due = await tx.relocationOffer.findMany({
          where: {
            state: 'open',
            lease: {
              status: { in: ['ended', 'terminated', 'cancelled'] },
              OR: [
                { endedAt: { lte: new Date(`${cutoff}T00:00:00Z`) } },
                { terminatedAt: { lte: new Date(`${cutoff}T00:00:00Z`) } },
                { cancelledAt: { lte: new Date(`${cutoff}T00:00:00Z`) } },
              ],
            },
          },
          select: { id: true },
          take: 500,
        });
        for (const { id } of due) {
          await tx.relocationOffer.update({
            where: { id },
            data: {
              state: 'closed',
              closedAt: now,
              areaSlug: null,
              province: null,
              district: null,
              maxRent: null,
              version: { increment: 1 },
            },
          });
          await this.audit.record(tx, { action: 'relocation.closed', subjectType: SUBJECT, subjectId: id });
        }
        return due.length;
      });
    });
  }
}

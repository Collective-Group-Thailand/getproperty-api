import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { SettingsService } from '@core/settings/settings.service';
import { isExclusionViolation, isUniqueViolation } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type Listing,
  type ListingChannel,
  type ListingLeadLostReason,
  type ListingLeadState,
  type ListingViewingState,
  Prisma,
} from '@generated/prisma/client';
import { IN_FORCE, LeasesService } from '@modules/ops-leases/leases.service';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

import { type AvailabilityException, type WeeklySlot } from './listings.service';
import { type Availability, freeSlots, type Slot, slotAt, type SlotRules } from './viewing-slots';

export const PROSPECT_CONSENT_PURPOSE = 'prospect.enquiry';

export interface EnquiryInput {
  message?: string | null;
  /** `YYYY-MM-DD`. */
  moveInDate?: string | null;
  termMonths?: number | null;
  occupants?: number | null;
  /** ISO 3166-1 alpha-2, optional (D-252). */
  nationality?: string | null;
  /** D-268: the share-kit channel the prospect came from; kept on a new enquiry only. */
  channel?: ListingChannel | null;
  /** The prospect agrees to purpose `prospect.enquiry` (PDPA, D-025). */
  consent: boolean;
}

export interface ViewingInput extends Omit<EnquiryInput, 'message'> {
  startsAt: Date;
  note?: string | null;
  message?: string | null;
}

/** States of an enquiry the owner may set (`new` and `viewing_booked` follow from what happens). */
export type OwnerLeadState = Extract<ListingLeadState, 'contacted' | 'viewed' | 'applied' | 'won' | 'lost'>;

const OPEN: ListingLeadState[] = ['new', 'contacted', 'viewing_booked', 'viewed', 'applied'];
const LIVE_VIEWING: ListingViewingState[] = ['requested', 'confirmed'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (path: string, message: string, code = 'invalid') =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

const leadInclude = {
  listing: {
    select: {
      id: true,
      slug: true,
      titleTh: true,
      titleEn: true,
      unitId: true,
      buildingId: true,
      state: true,
      rent: true,
      district: true,
      province: true,
      tenant: { select: { displayName: true } },
    },
  },
  party: { select: { id: true, displayName: true, phoneE164: true, lineUserId: true, language: true } },
  messages: { orderBy: { createdAt: 'asc' } },
  viewings: { orderBy: { startsAt: 'desc' } },
} satisfies Prisma.ListingLeadInclude;

export type LeadWithParts = Prisma.ListingLeadGetPayload<{ include: typeof leadInclude }>;

/**
 * Enquiries and viewings of B7.3 (D-252). A prospect (audience `prospect`) asks about a published listing or books a
 * viewing slot; the first contact with an owner creates the prospect's party in the owner's tenant (D-152, linked to
 * the login `line_match`) and records consent `prospect.enquiry` (PDPA, D-025) — one open lead per listing and
 * prospect. Viewings are slots of the listing's availability (notice and horizon are settings); overlapping live
 * viewings of a listing are refused by the database. The owner answers in the inbox (the reply reaches the
 * prospect in LINE through the notifications subscriber), confirms or declines viewings, keeps private notes and
 * closes the lead won or lost with a reason. The reminders job reminds both sides before a confirmed viewing and
 * the owner once about an enquiry left unanswered (settings).
 */
@Injectable()
export class ListingLeadsService {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly hasher: LookupHasher,
    private readonly leases: LeasesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private prospectId(): string {
    const id = userIdOf(RequestContext.actor());
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  private async rules(now: Date): Promise<SlotRules> {
    const [minNoticeHours, horizonDays] = await Promise.all([
      this.settings.valueAt<number>('listing.viewing.min_notice_hours', now),
      this.settings.valueAt<number>('listing.viewing.horizon_days', now),
    ]);
    return { now, minNoticeHours, horizonDays };
  }

  /** A listing a prospect may contact: published, not hidden, of an active tenant (anything else is a 404). */
  private async published(tx: Tx, slug: string) {
    const listing = await tx.listing.findFirst({
      where: { slug, state: 'published', hiddenAt: null, tenant: { status: 'active', deletedAt: null } },
      include: { availability: true },
    });
    if (!listing) throw new DomainException('http.not_found');
    return listing;
  }

  private availabilityOf(
    row: { weekly: unknown; exceptions: unknown; slotMinutes: number } | null,
  ): Availability {
    return {
      weekly: (row?.weekly ?? []) as WeeklySlot[],
      exceptions: (row?.exceptions ?? []) as AvailabilityException[],
      slotMinutes: row?.slotMinutes ?? 30,
    };
  }

  private enquiryFields(input: Omit<EnquiryInput, 'consent' | 'message' | 'channel'>) {
    const data: Prisma.ListingLeadUncheckedUpdateInput = {};
    if (input.moveInDate !== undefined) {
      if (input.moveInDate && !DAY.test(input.moveInDate))
        throw invalid('moveInDate', 'moveInDate is YYYY-MM-DD');
      data.moveInDate = input.moveInDate ? new Date(`${input.moveInDate}T00:00:00Z`) : null;
    }
    if (input.termMonths !== undefined) data.termMonths = input.termMonths;
    if (input.occupants !== undefined) data.occupants = input.occupants;
    if (input.nationality !== undefined) data.nationality = input.nationality?.toUpperCase() || null;
    return data;
  }

  // ---------------------------------------------------------------------------------------------- the party

  /** The prospect's party in the owner's tenant: the one linked to the login, else a new one linked `line_match`. */
  private async partyFor(tx: Tx, userId: string, tenantId: string): Promise<string> {
    const link = await tx.partyUserLink.findFirst({
      where: { userId, tenantId, state: 'active', party: { deletedAt: null, anonymisedAt: null } },
      orderBy: { linkedAt: 'asc' },
      select: { partyId: true },
    });
    if (link) return link.partyId;
    const user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
    const identity = await tx.userIdentity.findFirst({
      where: { userId, provider: 'line' },
      select: { id: true },
    });
    const now = this.clock.now();
    const phone = user.phoneVerifiedAt ? user.phoneE164 : null;
    const party = await tx.party.create({
      data: {
        tenantId,
        type: 'person',
        displayName: user.displayName.slice(0, 200),
        lineUserId: user.lineUserId,
        phoneE164: phone,
        phoneHash: phone ? this.hasher.tenantValue(tenantId, phone) : null,
        email: user.emailVerifiedAt ? user.email : null,
        language: user.language,
        createdBy: userId,
      },
    });
    const created = await tx.partyUserLink.create({
      data: {
        tenantId,
        partyId: party.id,
        userId,
        identityId: identity?.id ?? null,
        linkedAt: now,
        linkedVia: 'line_match',
        createdBy: userId,
      },
    });
    await this.audit.record(tx, {
      action: 'party.linked',
      tenantId,
      subjectType: 'core.party_user_link',
      subjectId: created.id,
      after: { partyId: party.id, userId, via: 'line_match', source: 'listing_enquiry' },
    });
    return party.id;
  }

  /** Consent `prospect.enquiry` of the party (D-025): recorded once per purpose version, in the owner's tenant. */
  private async consent(tx: Tx, partyId: string, tenantId: string, language: string) {
    const now = this.clock.now();
    const versions = await tx.consentPurposeVersion.findMany({
      where: { purpose: { key: PROSPECT_CONSENT_PURPOSE }, effectiveFrom: { lte: now } },
      orderBy: { version: 'desc' },
    });
    const version = versions.find((v) => v.language === language) ?? versions[0];
    if (!version) throw new DomainException('consent.unknown_purpose');
    const state = await tx.$queryRaw<{ granted: boolean; purpose_version: number }[]>`
      SELECT granted, purpose_version FROM platform.v_consent_state
       WHERE subject_type = 'party'::platform.consent_subject AND subject_id = ${partyId}::uuid
         AND purpose_key = ${PROSPECT_CONSENT_PURPOSE} AND tenant_id = ${tenantId}::uuid
       ORDER BY captured_at DESC LIMIT 1`;
    if (state[0]?.granted && state[0].purpose_version >= version.version) return;
    const request = RequestContext.current();
    const row = await tx.consent.create({
      data: {
        tenantId,
        subjectType: 'party',
        subjectId: partyId,
        purposeVersionId: version.id,
        granted: true,
        capturedAt: now,
        channel: 'liff',
        ip: request?.ip ?? null,
        userAgent: request?.userAgent ?? null,
      },
    });
    const payload = {
      subjectType: 'party',
      subjectId: partyId,
      purposeKey: PROSPECT_CONSENT_PURPOSE,
      version: version.version,
      granted: true,
    };
    await this.audit.record(tx, {
      action: 'consent.changed',
      tenantId,
      subjectType: 'platform.consent',
      subjectId: row.id,
      after: { ...payload, purpose: PROSPECT_CONSENT_PURPOSE, channel: 'liff' },
    });
    await this.events.record(tx, {
      type: 'consent.changed',
      aggregateType: 'consent',
      aggregateId: row.id,
      tenantId,
      payload,
    });
  }

  /** Whether the prospect's party in this tenant already holds consent `prospect.enquiry` (a new enquiry). */
  private async consented(tx: Tx, userId: string, tenantId: string): Promise<boolean> {
    const link = await tx.partyUserLink.findFirst({
      where: { userId, tenantId, state: 'active' },
      orderBy: { linkedAt: 'asc' },
      select: { partyId: true },
    });
    if (!link) return false;
    const rows = await tx.$queryRaw<{ granted: boolean }[]>`
      SELECT granted FROM platform.v_consent_state
       WHERE subject_type = 'party'::platform.consent_subject AND subject_id = ${link.partyId}::uuid
         AND purpose_key = ${PROSPECT_CONSENT_PURPOSE} AND tenant_id = ${tenantId}::uuid
       ORDER BY captured_at DESC LIMIT 1`;
    return rows[0]?.granted === true;
  }

  private async lead(tx: Tx, id: string) {
    return tx.listingLead.findUniqueOrThrow({ where: { id }, include: leadInclude });
  }

  private async event(
    tx: Tx,
    type: DomainEventType,
    listing: Pick<Listing, 'id' | 'tenantId' | 'buildingId'>,
    payload: Record<string, unknown>,
  ) {
    await this.events.record(tx, {
      type,
      aggregateType: 'listing_lead',
      aggregateId: (payload.leadId as string | undefined) ?? listing.id,
      tenantId: listing.tenantId,
      buildingId: listing.buildingId,
      payload: { listingId: listing.id, ...payload },
    });
  }

  /**
   * The open lead of the prospect for a listing, created on first contact (party, consent, daily limit). Returns
   * whether it was created.
   */
  private async openLead(
    tx: Tx,
    userId: string,
    listing: Listing,
    input: Omit<EnquiryInput, 'message'>,
  ): Promise<{ leadId: string; partyId: string; created: boolean }> {
    const now = this.clock.now();
    const existing = await tx.listingLead.findFirst({
      where: { listingId: listing.id, userId, state: { in: OPEN } },
      select: { id: true, partyId: true },
    });
    const fields = this.enquiryFields(input);
    if (existing) {
      if (Object.keys(fields).length)
        await tx.listingLead.update({
          where: { id: existing.id },
          data: { ...fields, version: { increment: 1 } },
        });
      return { leadId: existing.id, partyId: existing.partyId, created: false };
    }
    if (!input.consent && !(await this.consented(tx, userId, listing.tenantId)))
      throw new DomainException('listing.consent_required');
    const limit = await this.settings.valueAt<number>('listing.lead.daily_limit', now);
    const today = await tx.listingLead.count({
      where: { userId, createdAt: { gte: startOfBangkokDay(bangkokDate(now)) } },
    });
    if (today >= limit) throw new DomainException('listing.enquiry_limit');
    const user = await tx.userAccount.findUniqueOrThrow({
      where: { id: userId },
      select: { language: true },
    });
    const partyId = await this.partyFor(tx, userId, listing.tenantId);
    await this.consent(tx, partyId, listing.tenantId, user.language);
    const leadId = uuidv7(now.getTime());
    try {
      await tx.listingLead.create({
        data: {
          ...(fields as Prisma.ListingLeadUncheckedCreateInput),
          id: leadId,
          tenantId: listing.tenantId,
          listingId: listing.id,
          partyId,
          userId,
          channel: input.channel ?? null,
          lastProspectAt: now,
        },
      });
    } catch (error) {
      // a second request of the same prospect raced this one: the open lead exists now
      if (isUniqueViolation(error)) throw new DomainException('http.conflict');
      throw error;
    }
    await this.audit.record(tx, {
      action: 'listing.lead_created',
      tenantId: listing.tenantId,
      buildingId: listing.buildingId,
      subjectType: 'ops.listing_lead',
      subjectId: leadId,
      after: { listingId: listing.id, partyId },
    });
    return { leadId, partyId, created: true };
  }

  private async prospectMessage(tx: Tx, leadId: string, tenantId: string, userId: string, body: string) {
    const now = this.clock.now();
    const text = body.trim();
    if (!text) throw invalid('message', 'the message is empty', 'required');
    await tx.listingLeadMessage.create({
      data: { tenantId, leadId, author: 'prospect', authorUserId: userId, body: text, createdAt: now },
    });
    await tx.listingLead.update({ where: { id: leadId }, data: { lastProspectAt: now } });
    return text;
  }

  // ------------------------------------------------------------------------------------------------ prospect

  /** `POST /v1/prospect/listings/{slug}/enquiries`: a new enquiry, or a follow-up in the open one. */
  async enquire(slug: string, input: EnquiryInput & { message: string }) {
    const userId = this.prospectId();
    return this.db.platform(async (tx) => {
      const listing = await this.published(tx, slug);
      const { leadId, partyId, created } = await this.openLead(tx, userId, listing, input);
      const text = await this.prospectMessage(tx, leadId, listing.tenantId, userId, input.message);
      await this.audit.record(tx, {
        action: 'listing.lead_message_sent',
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing_lead',
        subjectId: leadId,
        metadata: { author: 'prospect', length: text.length },
      });
      await this.event(tx, created ? 'listing.lead_received' : 'listing.lead_message', listing, {
        leadId,
        partyId,
        excerpt: text.slice(0, 120),
      });
      return { lead: await this.lead(tx, leadId), created };
    });
  }

  async myLeads() {
    const userId = this.prospectId();
    return this.db.platform((tx) =>
      tx.listingLead.findMany({
        where: { userId },
        include: leadInclude,
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    );
  }

  async myLead(leadId: string) {
    const userId = this.prospectId();
    return this.db.platform(async (tx) => {
      const lead = await tx.listingLead.findFirst({ where: { id: leadId, userId }, include: leadInclude });
      if (!lead) throw new DomainException('http.not_found');
      return lead;
    });
  }

  async writeToOwner(leadId: string, body: string) {
    const userId = this.prospectId();
    return this.db.platform(async (tx) => {
      const lead = await tx.listingLead.findFirst({
        where: { id: leadId, userId },
        include: { listing: true },
      });
      if (!lead) throw new DomainException('http.not_found');
      if (!OPEN.includes(lead.state)) throw new DomainException('listing.lead_invalid_state');
      const text = await this.prospectMessage(tx, lead.id, lead.tenantId, userId, body);
      await this.audit.record(tx, {
        action: 'listing.lead_message_sent',
        tenantId: lead.tenantId,
        buildingId: lead.listing.buildingId,
        subjectType: 'ops.listing_lead',
        subjectId: lead.id,
        metadata: { author: 'prospect', length: text.length },
      });
      await this.event(tx, 'listing.lead_message', lead.listing, {
        leadId: lead.id,
        partyId: lead.partyId,
        excerpt: text.slice(0, 120),
      });
      return this.lead(tx, lead.id);
    });
  }

  /** Free viewing slots of a published listing (public; no personal data). */
  async slots(slug: string, fromDay: string | undefined, days: number) {
    const now = this.clock.now();
    const rules = await this.rules(now);
    const start = fromDay && DAY.test(fromDay) && fromDay > bangkokDate(now) ? fromDay : bangkokDate(now);
    const span = Math.max(1, Math.min(days, rules.horizonDays + 1));
    return this.db.platform(async (tx) => {
      const listing = await this.published(tx, slug);
      const until = new Date(startOfBangkokDay(start).getTime() + (span + 1) * 86_400_000);
      const taken = await tx.listingViewing.findMany({
        where: {
          listingId: listing.id,
          state: { in: LIVE_VIEWING },
          endsAt: { gt: startOfBangkokDay(start) },
          startsAt: { lt: until },
        },
        select: { startsAt: true, endsAt: true },
      });
      const availability = this.availabilityOf(listing.availability);
      return {
        slotMinutes: availability.slotMinutes,
        slots: freeSlots(availability, rules, start, span, taken),
      };
    });
  }

  private async insertViewing(
    tx: Tx,
    data: { tenantId: string; listingId: string; leadId: string; slot: Slot; note?: string | null },
  ): Promise<string> {
    const id = uuidv7(this.clock.now().getTime());
    try {
      await tx.listingViewing.create({
        data: {
          id,
          tenantId: data.tenantId,
          listingId: data.listingId,
          leadId: data.leadId,
          startsAt: data.slot.startsAt,
          endsAt: data.slot.endsAt,
          note: data.note?.trim() || null,
        },
      });
    } catch (error) {
      if (isExclusionViolation(error)) throw new DomainException('listing.viewing_slot_taken');
      throw error;
    }
    return id;
  }

  /** `POST /v1/prospect/listings/{slug}/viewings`: one live viewing per enquiry; the slot must be offered and free. */
  async requestViewing(slug: string, input: ViewingInput) {
    const userId = this.prospectId();
    const now = this.clock.now();
    const rules = await this.rules(now);
    return this.db.platform(async (tx) => {
      const listing = await this.published(tx, slug);
      const slot = slotAt(input.startsAt, this.availabilityOf(listing.availability), rules);
      if (!slot) throw new DomainException('listing.viewing_slot_unavailable');
      const { leadId, partyId, created } = await this.openLead(tx, userId, listing, input);
      const live = await tx.listingViewing.count({ where: { leadId, state: { in: LIVE_VIEWING } } });
      if (live) throw new DomainException('listing.viewing_exists');
      if (input.message?.trim())
        await this.prospectMessage(tx, leadId, listing.tenantId, userId, input.message);
      const viewingId = await this.insertViewing(tx, {
        tenantId: listing.tenantId,
        listingId: listing.id,
        leadId,
        slot,
        note: input.note,
      });
      await tx.listingLead.updateMany({
        where: { id: leadId, state: { in: ['new', 'contacted', 'viewed'] } },
        data: { state: 'viewing_booked', version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'listing.viewing_requested',
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing_viewing',
        subjectId: viewingId,
        after: { leadId, startsAt: slot.startsAt.toISOString() },
      });
      if (created)
        await this.event(tx, 'listing.lead_received', listing, {
          leadId,
          partyId,
          excerpt: input.message?.trim().slice(0, 120) ?? null,
          viewing: true,
        });
      await this.event(tx, 'listing.viewing_requested', listing, {
        leadId,
        partyId,
        viewingId,
        startsAt: slot.startsAt.toISOString(),
        rescheduledFrom: null,
      });
      return this.lead(tx, leadId);
    });
  }

  private async myViewing(tx: Tx, userId: string, viewingId: string) {
    const viewing = await tx.listingViewing.findFirst({
      where: { id: viewingId, lead: { userId } },
      include: { lead: true, listing: true },
    });
    if (!viewing) throw new DomainException('http.not_found');
    if (!LIVE_VIEWING.includes(viewing.state) || viewing.startsAt.getTime() <= this.clock.now().getTime())
      throw new DomainException('listing.viewing_invalid_state');
    return viewing;
  }

  /** After a viewing ends without a visit, the enquiry goes back to where it was before the booking. */
  private async unbook(tx: Tx, leadId: string) {
    const lead = await tx.listingLead.findUniqueOrThrow({ where: { id: leadId } });
    if (lead.state !== 'viewing_booked') return;
    const live = await tx.listingViewing.count({ where: { leadId, state: { in: LIVE_VIEWING } } });
    if (live) return;
    await tx.listingLead.update({
      where: { id: leadId },
      data: { state: lead.lastOwnerAt ? 'contacted' : 'new', version: { increment: 1 } },
    });
  }

  async cancelViewing(viewingId: string, reason?: string | null) {
    const userId = this.prospectId();
    return this.db.platform(async (tx) => {
      const viewing = await this.myViewing(tx, userId, viewingId);
      await tx.listingViewing.update({
        where: { id: viewing.id },
        data: {
          state: 'cancelled',
          cancelledBy: 'prospect',
          declineReason: reason?.trim() || null,
          version: { increment: 1 },
        },
      });
      await this.unbook(tx, viewing.leadId);
      await this.audit.record(tx, {
        action: 'listing.viewing_cancelled',
        tenantId: viewing.tenantId,
        buildingId: viewing.listing.buildingId,
        subjectType: 'ops.listing_viewing',
        subjectId: viewing.id,
        before: { state: viewing.state },
        after: { state: 'cancelled', by: 'prospect' },
      });
      await this.event(tx, 'listing.viewing_cancelled', viewing.listing, {
        leadId: viewing.leadId,
        partyId: viewing.lead.partyId,
        viewingId: viewing.id,
        startsAt: viewing.startsAt.toISOString(),
        by: 'prospect',
        rescheduled: false,
      });
      return this.lead(tx, viewing.leadId);
    });
  }

  /** Cancels the viewing and requests the new slot in one transaction (the old row points to the new one). */
  async rescheduleViewing(viewingId: string, startsAt: Date) {
    const userId = this.prospectId();
    const now = this.clock.now();
    const rules = await this.rules(now);
    return this.db.platform(async (tx) => {
      const viewing = await this.myViewing(tx, userId, viewingId);
      if (viewing.listing.state !== 'published' || viewing.listing.hiddenAt)
        throw new DomainException('listing.viewing_invalid_state');
      const availability = await tx.listingAvailability.findUnique({
        where: { listingId: viewing.listingId },
      });
      const slot = slotAt(startsAt, this.availabilityOf(availability), rules);
      if (!slot) throw new DomainException('listing.viewing_slot_unavailable');
      await tx.listingViewing.update({
        where: { id: viewing.id },
        data: { state: 'cancelled', cancelledBy: 'prospect', version: { increment: 1 } },
      });
      const newId = await this.insertViewing(tx, {
        tenantId: viewing.tenantId,
        listingId: viewing.listingId,
        leadId: viewing.leadId,
        slot,
        note: viewing.note,
      });
      await tx.listingViewing.update({ where: { id: viewing.id }, data: { rescheduledTo: newId } });
      await this.audit.record(tx, {
        action: 'listing.viewing_requested',
        tenantId: viewing.tenantId,
        buildingId: viewing.listing.buildingId,
        subjectType: 'ops.listing_viewing',
        subjectId: newId,
        before: { viewingId: viewing.id, startsAt: viewing.startsAt.toISOString() },
        after: { startsAt: slot.startsAt.toISOString() },
      });
      await this.event(tx, 'listing.viewing_requested', viewing.listing, {
        leadId: viewing.leadId,
        partyId: viewing.lead.partyId,
        viewingId: newId,
        startsAt: slot.startsAt.toISOString(),
        rescheduledFrom: viewing.startsAt.toISOString(),
      });
      return this.lead(tx, viewing.leadId);
    });
  }

  // --------------------------------------------------------------------------------------------------- owner

  private async ownerLead(tx: Tx, ctx: TenantContext, id: string) {
    const lead = await tx.listingLead.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: leadInclude,
    });
    if (!lead) throw new DomainException('http.not_found');
    return lead;
  }

  async list(
    ctx: TenantContext,
    filter: { state?: ListingLeadState; listingId?: string; open?: boolean } = {},
  ) {
    return this.db.tenant(ctx, (tx) =>
      tx.listingLead.findMany({
        where: {
          tenantId: ctx.tenantId,
          listingId: filter.listingId,
          state: filter.state ?? (filter.open ? { in: OPEN } : undefined),
        },
        include: leadInclude,
        orderBy: { lastProspectAt: 'desc' },
        take: 200,
      }),
    );
  }

  async get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, (tx) => this.ownerLead(tx, ctx, id));
  }

  /** The owner's reply: stored, the enquiry is `contacted`, the prospect gets it in LINE (subscriber). */
  async reply(ctx: TenantContext, id: string, body: string) {
    const by = userIdOf(RequestContext.actor());
    return this.db.tenant(ctx, async (tx) => {
      const lead = await this.ownerLead(tx, ctx, id);
      if (!OPEN.includes(lead.state)) throw new DomainException('listing.lead_invalid_state');
      const text = body.trim();
      if (!text) throw invalid('body', 'the message is empty', 'required');
      const now = this.clock.now();
      await tx.listingLeadMessage.create({
        data: {
          tenantId: ctx.tenantId,
          leadId: id,
          author: 'owner',
          authorUserId: by,
          body: text,
          createdAt: now,
        },
      });
      await tx.listingLead.update({
        where: { id },
        data: {
          lastOwnerAt: now,
          updatedBy: by,
          ...(lead.state === 'new' ? { state: 'contacted', version: { increment: 1 } } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'listing.lead_replied',
        tenantId: ctx.tenantId,
        buildingId: lead.listing.buildingId,
        subjectType: 'ops.listing_lead',
        subjectId: id,
        metadata: { length: text.length },
      });
      await this.event(
        tx,
        'listing.lead_replied',
        { id: lead.listingId, tenantId: ctx.tenantId, buildingId: lead.listing.buildingId },
        { leadId: id, partyId: lead.partyId, excerpt: text.slice(0, 200) },
      );
      return this.ownerLead(tx, ctx, id);
    });
  }

  async updateNotes(ctx: TenantContext, id: string, notes: string | null) {
    const by = userIdOf(RequestContext.actor());
    return this.db.tenant(ctx, async (tx) => {
      const lead = await this.ownerLead(tx, ctx, id);
      await tx.listingLead.update({
        where: { id },
        data: { notes: notes?.trim() || null, updatedBy: by, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'listing.lead_updated',
        tenantId: ctx.tenantId,
        buildingId: lead.listing.buildingId,
        subjectType: 'ops.listing_lead',
        subjectId: id,
        after: { fields: ['notes'] },
      });
      return this.ownerLead(tx, ctx, id);
    });
  }

  /**
   * Moves an open enquiry on. `lost` needs a reason; `won` and `lost` close it and cancel its live viewings. A
   * closed enquiry stays closed (the prospect starts a new one by writing again).
   */
  async setState(
    ctx: TenantContext,
    id: string,
    input: { state: OwnerLeadState; lostReason?: ListingLeadLostReason | null; lostNote?: string | null },
  ) {
    const by = userIdOf(RequestContext.actor());
    if (input.state === 'lost' && !input.lostReason)
      throw invalid('lostReason', 'a lost enquiry needs a reason', 'required');
    return this.db.tenant(ctx, async (tx) => {
      const lead = await this.ownerLead(tx, ctx, id);
      if (!OPEN.includes(lead.state)) throw new DomainException('listing.lead_invalid_state');
      const closing = input.state === 'won' || input.state === 'lost';
      await tx.listingLead.update({
        where: { id },
        data: {
          state: input.state,
          lostReason: input.state === 'lost' ? input.lostReason : null,
          lostNote: input.state === 'lost' ? input.lostNote?.trim() || null : null,
          updatedBy: by,
          version: { increment: 1 },
        },
      });
      if (closing) {
        const live = lead.viewings.filter((v) => LIVE_VIEWING.includes(v.state));
        for (const v of live) {
          await tx.listingViewing.update({
            where: { id: v.id },
            data: { state: 'cancelled', cancelledBy: 'owner', version: { increment: 1 } },
          });
          await this.event(
            tx,
            'listing.viewing_cancelled',
            { id: lead.listingId, tenantId: ctx.tenantId, buildingId: lead.listing.buildingId },
            {
              leadId: id,
              partyId: lead.partyId,
              viewingId: v.id,
              startsAt: v.startsAt.toISOString(),
              by: 'owner',
              rescheduled: false,
            },
          );
        }
      }
      await this.audit.record(tx, {
        action: 'listing.lead_state_changed',
        tenantId: ctx.tenantId,
        buildingId: lead.listing.buildingId,
        subjectType: 'ops.listing_lead',
        subjectId: id,
        before: { state: lead.state },
        after: { state: input.state, lostReason: input.lostReason ?? null },
      });
      await this.event(
        tx,
        'listing.lead_state_changed',
        { id: lead.listingId, tenantId: ctx.tenantId, buildingId: lead.listing.buildingId },
        {
          leadId: id,
          partyId: lead.partyId,
          from: lead.state,
          to: input.state,
          lostReason: input.lostReason ?? null,
        },
      );
      return this.ownerLead(tx, ctx, id);
    });
  }

  private async ownerViewing(tx: Tx, ctx: TenantContext, viewingId: string) {
    const viewing = await tx.listingViewing.findFirst({
      where: { id: viewingId, tenantId: ctx.tenantId },
      include: { lead: true, listing: true },
    });
    if (!viewing) throw new DomainException('http.not_found');
    return viewing;
  }

  async viewings(ctx: TenantContext, range: { from?: Date; to?: Date; listingId?: string }) {
    const now = this.clock.now();
    return this.db.tenant(ctx, (tx) =>
      tx.listingViewing.findMany({
        where: {
          tenantId: ctx.tenantId,
          listingId: range.listingId,
          startsAt: { gte: range.from ?? startOfBangkokDay(bangkokDate(now)), lt: range.to },
          state: { in: [...LIVE_VIEWING, 'completed', 'no_show'] },
        },
        include: {
          lead: { select: { id: true, party: { select: { displayName: true } } } },
          listing: { select: { id: true, titleTh: true, slug: true } },
        },
        orderBy: { startsAt: 'asc' },
        take: 500,
      }),
    );
  }

  async decideViewing(
    ctx: TenantContext,
    viewingId: string,
    decision: { action: 'confirm' } | { action: 'decline'; reason: string },
  ) {
    const by = userIdOf(RequestContext.actor());
    return this.db.tenant(ctx, async (tx) => {
      const viewing = await this.ownerViewing(tx, ctx, viewingId);
      const now = this.clock.now();
      const allowed: ListingViewingState[] = decision.action === 'confirm' ? ['requested'] : LIVE_VIEWING;
      if (!allowed.includes(viewing.state) || viewing.startsAt.getTime() <= now.getTime())
        throw new DomainException('listing.viewing_invalid_state');
      const state = decision.action === 'confirm' ? 'confirmed' : 'declined';
      await tx.listingViewing.update({
        where: { id: viewing.id },
        data: {
          state,
          decidedBy: by,
          decidedAt: now,
          declineReason: decision.action === 'decline' ? decision.reason.trim() : null,
          version: { increment: 1 },
        },
      });
      if (state === 'declined') await this.unbook(tx, viewing.leadId);
      await tx.listingLead.update({
        where: { id: viewing.leadId },
        data: { lastOwnerAt: now, updatedBy: by },
      });
      await this.audit.record(tx, {
        action: state === 'confirmed' ? 'listing.viewing_confirmed' : 'listing.viewing_declined',
        tenantId: ctx.tenantId,
        buildingId: viewing.listing.buildingId,
        subjectType: 'ops.listing_viewing',
        subjectId: viewing.id,
        before: { state: viewing.state },
        after: { state, reason: decision.action === 'decline' ? decision.reason : null },
      });
      await this.event(
        tx,
        state === 'confirmed' ? 'listing.viewing_confirmed' : 'listing.viewing_declined',
        viewing.listing,
        {
          leadId: viewing.leadId,
          partyId: viewing.lead.partyId,
          viewingId: viewing.id,
          startsAt: viewing.startsAt.toISOString(),
          reason: decision.action === 'decline' ? decision.reason.trim() : null,
        },
      );
      return this.ownerLead(tx, ctx, viewing.leadId);
    });
  }

  /** After the time: viewed (the enquiry becomes `viewed`) or no show. */
  async completeViewing(ctx: TenantContext, viewingId: string, outcome: 'completed' | 'no_show') {
    const by = userIdOf(RequestContext.actor());
    return this.db.tenant(ctx, async (tx) => {
      const viewing = await this.ownerViewing(tx, ctx, viewingId);
      if (viewing.state !== 'confirmed' || viewing.startsAt.getTime() > this.clock.now().getTime())
        throw new DomainException('listing.viewing_invalid_state');
      await tx.listingViewing.update({
        where: { id: viewing.id },
        data: { state: outcome, version: { increment: 1 } },
      });
      if (outcome === 'completed')
        await tx.listingLead.updateMany({
          where: { id: viewing.leadId, state: { in: ['new', 'contacted', 'viewing_booked'] } },
          data: { state: 'viewed', updatedBy: by, version: { increment: 1 } },
        });
      else await this.unbook(tx, viewing.leadId);
      await this.audit.record(tx, {
        action: 'listing.viewing_completed',
        tenantId: ctx.tenantId,
        buildingId: viewing.listing.buildingId,
        subjectType: 'ops.listing_viewing',
        subjectId: viewing.id,
        before: { state: 'confirmed' },
        after: { state: outcome },
      });
      await this.event(tx, 'listing.viewing_completed', viewing.listing, {
        leadId: viewing.leadId,
        partyId: viewing.lead.partyId,
        viewingId: viewing.id,
        outcome,
      });
      return this.ownerLead(tx, ctx, viewing.leadId);
    });
  }

  // ------------------------------------------------------------------------------------------- lead → lease

  /**
   * B7.4 (D-252, D-253): a lease draft (B2) from the listing's terms with the prospect as lessee — rent, deposit and
   * advance months, the term (the prospect's, else the listing's minimum), the start (given, else the prospect's
   * move-in, else the listing's available date, else today). The lead becomes `applied` and remembers the lease; the
   * lease's compliance checks answer as they do for any draft.
   */
  async leaseDraft(
    ctx: TenantContext,
    id: string,
    input: { startDate?: string; months?: number; acknowledgementIds?: string[]; language?: 'th' | 'en' },
  ) {
    const by = userIdOf(RequestContext.actor());
    const { lead, listing } = await this.db.tenant(ctx, async (tx) => {
      const lead = await this.ownerLead(tx, ctx, id);
      if (!OPEN.includes(lead.state)) throw new DomainException('listing.lead_invalid_state');
      if (lead.leaseId) {
        const existing = await tx.lease.findUnique({ where: { id: lead.leaseId }, select: { status: true } });
        if (existing && existing.status !== 'cancelled') throw new DomainException('listing.lease_exists');
      }
      const listing = await tx.listing.findUniqueOrThrow({ where: { id: lead.listingId } });
      return { lead, listing };
    });
    const today = bangkokDate(this.clock.now());
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    const later = (a: string | null) => (a && a > today ? a : null);
    const startDate =
      input.startDate ?? later(day(lead.moveInDate)) ?? later(day(listing.availableFrom)) ?? today;
    if (!DAY.test(startDate)) throw invalid('startDate', 'startDate is YYYY-MM-DD');
    const months = Math.max(input.months ?? lead.termMonths ?? listing.minTermMonths, listing.minTermMonths);
    const rent = new Decimal(listing.rent.toString());
    const lease = await this.leases.createDraft(ctx, {
      unitId: listing.unitId,
      lesseePartyId: lead.partyId,
      startDate,
      months,
      rent: rent.toFixed(2),
      depositAmount: rent.times(listing.depositMonths).toFixed(2),
      advanceRentAmount: rent.times(listing.advanceMonths).toFixed(2),
      acknowledgementIds: input.acknowledgementIds,
      language: input.language,
    });
    return this.db.tenant(ctx, async (tx) => {
      await tx.listingLead.update({
        where: { id },
        data: {
          leaseId: lease.id,
          state: 'applied',
          updatedBy: by,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'listing.lead_lease_drafted',
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing_lead',
        subjectId: id,
        after: { leaseId: lease.id, startDate, months, rent: rent.toFixed(2) },
      });
      if (lead.state !== 'applied')
        await this.event(tx, 'listing.lead_state_changed', listing, {
          leadId: id,
          partyId: lead.partyId,
          from: lead.state,
          to: 'applied',
          lostReason: null,
        });
      return { leaseId: lease.id, lead: await this.ownerLead(tx, ctx, id) };
    });
  }

  /**
   * Subscriber hook of `lease.activated` (B7.4): the unit is let — every live listing of it closes (`leased`, with
   * the lease), the lead the lease was drafted from is won, the other open leads of those listings are lost
   * (`unit_leased`, their live viewings cancelled) and their prospects get one polite LINE message.
   */
  async onLeaseActivated(tx: Tx, leaseId: string): Promise<{ closed: number; won: number; lost: number }> {
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: { id: true, tenantId: true, unitId: true, buildingId: true },
    });
    if (!lease) return { closed: 0, won: 0, lost: 0 };
    const now = this.clock.now();
    const live = await tx.listing.findMany({
      where: {
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        state: { in: ['pending_review', 'published', 'paused'] },
      },
    });
    for (const listing of live) {
      await tx.listing.update({
        where: { id: listing.id },
        data: { state: 'closed', closedAt: now, closedReason: 'leased', leaseId, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'listing.closed',
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: listing.id,
        before: { state: listing.state },
        after: { state: 'closed', reason: 'leased', leaseId },
      });
      await this.events.record(tx, {
        type: 'listing.closed',
        aggregateType: 'listing',
        aggregateId: listing.id,
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        payload: { listingId: listing.id, unitId: listing.unitId, reason: 'leased', leaseId },
      });
    }
    const leads = await tx.listingLead.findMany({
      where: {
        tenantId: lease.tenantId,
        state: { in: OPEN },
        OR: [{ listingId: { in: live.map((l) => l.id) } }, { leaseId }],
      },
      include: { listing: true, viewings: true },
    });
    let won = 0;
    let lost = 0;
    for (const lead of leads) {
      const winner = lead.leaseId === leaseId;
      await tx.listingLead.update({
        where: { id: lead.id },
        data: winner
          ? { state: 'won', version: { increment: 1 } }
          : { state: 'lost', lostReason: 'unit_leased', version: { increment: 1 } },
      });
      for (const v of lead.viewings.filter((x) => LIVE_VIEWING.includes(x.state)))
        await tx.listingViewing.update({
          where: { id: v.id },
          data: { state: 'cancelled', cancelledBy: 'owner', version: { increment: 1 } },
        });
      await this.audit.record(tx, {
        action: 'listing.lead_state_changed',
        tenantId: lead.tenantId,
        buildingId: lead.listing.buildingId,
        subjectType: 'ops.listing_lead',
        subjectId: lead.id,
        before: { state: lead.state },
        after: { state: winner ? 'won' : 'lost', lostReason: winner ? null : 'unit_leased', leaseId },
      });
      await this.event(tx, 'listing.lead_state_changed', lead.listing, {
        leadId: lead.id,
        partyId: lead.partyId,
        from: lead.state,
        to: winner ? 'won' : 'lost',
        lostReason: winner ? null : 'unit_leased',
      });
      if (winner) won += 1;
      else lost += 1;
    }
    return { closed: live.length, won, lost };
  }

  // ----------------------------------------------------------------------------------------------- reminders

  /**
   * Maintenance job `listing-reminders`: each confirmed viewing within `listing.viewing.reminder_hours_before` is
   * reminded once (both sides); each enquiry still `new` after `listing.lead.nudge_after_hours` reminds the owner
   * once. Returns how many reminders were raised.
   */
  async remind(): Promise<{ viewings: number; leads: number; relists: number }> {
    const now = this.clock.now();
    const [hoursBefore, nudgeHours] = await Promise.all([
      this.settings.valueAt<number>('listing.viewing.reminder_hours_before', now),
      this.settings.valueAt<number>('listing.lead.nudge_after_hours', now),
    ]);
    return this.db.platform(async (tx) => {
      let viewings = 0;
      let leads = 0;
      if (hoursBefore > 0) {
        const due = await tx.listingViewing.findMany({
          where: {
            state: 'confirmed',
            remindedAt: null,
            startsAt: { gt: now, lte: new Date(now.getTime() + hoursBefore * 3_600_000) },
          },
          include: { lead: true, listing: true },
          take: 500,
        });
        for (const v of due) {
          const claimed = await tx.listingViewing.updateMany({
            where: { id: v.id, remindedAt: null },
            data: { remindedAt: now },
          });
          if (!claimed.count) continue;
          await this.event(tx, 'listing.viewing_reminder', v.listing, {
            leadId: v.leadId,
            partyId: v.lead.partyId,
            viewingId: v.id,
            startsAt: v.startsAt.toISOString(),
          });
          viewings += 1;
        }
      }
      if (nudgeHours > 0) {
        const stale = await tx.listingLead.findMany({
          where: {
            state: 'new',
            nudgedAt: null,
            lastOwnerAt: null,
            lastProspectAt: { lte: new Date(now.getTime() - nudgeHours * 3_600_000) },
          },
          include: { listing: true },
          take: 500,
        });
        for (const lead of stale) {
          const claimed = await tx.listingLead.updateMany({
            where: { id: lead.id, nudgedAt: null },
            data: { nudgedAt: now },
          });
          if (!claimed.count) continue;
          await this.event(tx, 'listing.lead_unanswered', lead.listing, {
            leadId: lead.id,
            partyId: lead.partyId,
            hours: nudgeHours,
          });
          leads += 1;
        }
      }
      return { viewings, leads, relists: await this.relistReminders(tx, now) };
    });
  }

  /** Listings closed by a lease that ends within `listing.relist.remind_days_before` remind the owner once (B7.4). */
  private async relistReminders(tx: Tx, now: Date): Promise<number> {
    const days = await this.settings.valueAt<number>('listing.relist.remind_days_before', now);
    if (days <= 0) return 0;
    const today = bangkokDate(now);
    const until = new Date(startOfBangkokDay(today).getTime() + days * 86_400_000);
    const due = await tx.listing.findMany({
      where: {
        state: 'closed',
        closedReason: 'leased',
        relistRemindedAt: null,
        lease: { status: { in: IN_FORCE }, endDate: { gte: new Date(`${today}T00:00:00Z`), lte: until } },
      },
      include: { lease: { select: { id: true, endDate: true } } },
      take: 500,
    });
    let count = 0;
    for (const listing of due) {
      const claimed = await tx.listing.updateMany({
        where: { id: listing.id, relistRemindedAt: null },
        data: { relistRemindedAt: now },
      });
      if (!claimed.count) continue;
      await this.events.record(tx, {
        type: 'listing.relist_due',
        aggregateType: 'listing',
        aggregateId: listing.id,
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        payload: {
          listingId: listing.id,
          unitId: listing.unitId,
          leaseId: listing.lease?.id ?? null,
          endDate: listing.lease?.endDate.toISOString().slice(0, 10) ?? null,
        },
      });
      count += 1;
    }
    return count;
  }
}

import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { SettingsService } from '@core/settings/settings.service';
import { isExclusionViolation, raisedWith } from '@database/pg-errors';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type AccessEvent,
  type Listing,
  type ListingLead,
  type ListingViewing,
  type Lock,
  type ViewingAccess,
  type ViewingAccessState,
} from '@generated/prisma/client';
import { IN_FORCE } from '@modules/ops-leases/leases.service';
import { WorkOrdersService } from '@modules/ops-service/work-orders.service';
import { AccessCredentialsService } from '@modules/smart-access/access-credentials.service';
import { adapterVendor, generatePin, LIVE_STATUSES } from '@modules/smart-access/access-rules';
import { Inject, Injectable } from '@nestjs/common';

import {
  codeWindow,
  endStateAfterWindow,
  insideWindow,
  missingRequirements,
  overstaying,
  type SelfViewingSettings,
  termsOutdated,
  type VisitorTerms,
  visitorTerms,
} from './self-viewing-rules';
import { type Slot } from './viewing-slots';

/** Why a listing offers no self-viewing (`viewing.self_unavailable`, `viewing.unit_occupied`). */
export type SelfViewingBlock = 'disabled' | 'not_operated' | 'no_lock' | 'occupied';

export type Eligibility =
  { available: true; lock: Lock; doors: Lock[] } | { available: false; reason: SelfViewingBlock };

type ListingRef = Pick<Listing, 'id' | 'tenantId' | 'unitId' | 'buildingId' | 'mandateId'>;
type ViewingWithParts = ListingViewing & { lead: ListingLead; listing: Listing };

const VIEWING_SUBJECT = 'ops.viewing_access';
const LIVE_VIEWING = ['requested', 'confirmed'] as const;

export type AccessWithParts = ViewingAccess & { lock: Pick<Lock, 'id' | 'name' | 'scope'> };

/**
 * Self-viewing (G7, D-289 (1), D-295): a verified prospect (e-KYC approved, verified phone, visitor terms accepted)
 * books a self-viewing slot of a vacant unit that has an active lock of the listing's tenant; when the owner confirms,
 * one random PIN is issued as **visitor** credentials (`smart.access_credential.viewing_id`) on the unit lock and the
 * building doors for `viewing.self.code_early_minutes` before to `viewing.self.code_minutes` after the slot start —
 * created at the vendor after the commit through `LockVendorAdapter` (fake until a vendor is contracted). The code is
 * shown to the prospect only inside that window (audited decrypt, `Cache-Control: no-store`), never in events,
 * audit metadata, notifications or logs. Owner and staff are alerted when the visitor enters (app or lock log), on an
 * incident (→ work order) and when an entered visitor does not confirm leaving. Resident credentials are never read
 * or changed here (D-071); a unit that becomes occupied closes every window at once and the database refuses a
 * viewing credential for an occupied unit.
 */
@Injectable()
export class SelfViewingService {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly credentials: AccessCredentialsService,
    private readonly workOrders: WorkOrdersService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private prospectId(): string {
    const id = userIdOf(RequestContext.actor());
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }

  // ------------------------------------------------------------------------------------------------- settings

  async enabled(tenantId: string | null, at: Date): Promise<boolean> {
    return Boolean(
      await this.settings.valueAt<boolean>('viewing.self.enabled', at, tenantId ? { tenantId } : {}),
    );
  }

  async windowSettings(tenantId: string, at: Date): Promise<SelfViewingSettings> {
    const [codeMinutes, earlyMinutes] = await Promise.all([
      this.settings.valueAt<number>('viewing.self.code_minutes', at, { tenantId }),
      this.settings.valueAt<number>('viewing.self.code_early_minutes', at, { tenantId }),
    ]);
    return { codeMinutes: codeMinutes ?? 30, earlyMinutes: earlyMinutes ?? 5 };
  }

  async terms(at: Date): Promise<VisitorTerms> {
    const terms = visitorTerms(await this.settings.valueAt<unknown>('viewing.self.visitor_terms', at));
    if (!terms) throw new Error('setting viewing.self.visitor_terms is malformed');
    return terms;
  }

  // ---------------------------------------------------------------------------------------------- eligibility

  /** Whether the unit is occupied now: a current occupancy or a lease in force (any tenant). */
  async occupied(tx: Tx, unitId: string, at: Date): Promise<boolean> {
    const today = new Date(`${bangkokDate(at)}T00:00:00Z`);
    const [occupancies, leases] = await Promise.all([
      tx.occupancy.count({
        where: {
          unitId,
          validFrom: { lte: today },
          OR: [{ validTo: null }, { validTo: { gt: today } }],
          movedOutAt: null,
        },
      }),
      tx.lease.count({ where: { unitId, status: { in: IN_FORCE } } }),
    ]);
    return occupancies + leases > 0;
  }

  /**
   * Whether a listing can offer self-viewing now: the setting is on for its tenant, the listing tenant runs the unit
   * (an agency listing does not — the lock is the owner tenant's, O-031), the unit has an active lock of that tenant
   * with a vendor adapter, and nobody lives there.
   */
  async eligibility(tx: Tx, listing: ListingRef, at: Date): Promise<Eligibility> {
    if (!(await this.enabled(listing.tenantId, at))) return { available: false, reason: 'disabled' };
    if (listing.mandateId) return { available: false, reason: 'not_operated' };
    const locks = await tx.lock.findMany({
      where: { tenantId: listing.tenantId, unitId: listing.unitId, scope: 'unit', isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    const lock = locks.find((l) => adapterVendor(l.vendor) !== null);
    if (!lock) return { available: false, reason: 'no_lock' };
    if (await this.occupied(tx, listing.unitId, at)) return { available: false, reason: 'occupied' };
    const doors = await tx.lock.findMany({
      where: {
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        scope: 'building_door',
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return { available: true, lock, doors: doors.filter((d) => adapterVendor(d.vendor) !== null) };
  }

  private refuse(e: { available: false; reason: SelfViewingBlock }): never {
    if (e.reason === 'occupied') throw new DomainException('viewing.unit_occupied');
    throw new DomainException('viewing.self_unavailable', { extensions: { selfViewingReason: e.reason } });
  }

  /** The prospect's verification facts (the newest approved e-KYC attempt and the verified phone). */
  async verification(tx: Tx, userId: string) {
    const [approved, user] = await Promise.all([
      tx.identityVerification.findFirst({
        where: { userId, state: 'approved' },
        orderBy: { decidedAt: 'desc' },
        select: { id: true, decidedAt: true },
      }),
      tx.userAccount.findUnique({ where: { id: userId }, select: { phoneVerifiedAt: true } }),
    ]);
    return { identityVerificationId: approved?.id ?? null, phoneVerified: Boolean(user?.phoneVerifiedAt) };
  }

  /** `GET /v1/prospect/me/self-viewing`: what I still need, the visitor terms and the code window rules. */
  async myStatus() {
    const userId = this.prospectId();
    const now = this.clock.now();
    const [terms, enabled] = await Promise.all([this.terms(now), this.enabled(null, now)]);
    const facts = await this.db.platform((tx) => this.verification(tx, userId));
    const codeMinutes = await this.settings.valueAt<number>('viewing.self.code_minutes', now);
    const earlyMinutes = await this.settings.valueAt<number>('viewing.self.code_early_minutes', now);
    return {
      enabled,
      identityVerified: Boolean(facts.identityVerificationId),
      phoneVerified: facts.phoneVerified,
      missing: missingRequirements({
        identityVerified: Boolean(facts.identityVerificationId),
        phoneVerified: facts.phoneVerified,
        termsVersion: null,
        currentTermsVersion: terms.version,
      }),
      visitorTerms: terms,
      codeMinutes,
      earlyMinutes,
    };
  }

  /**
   * Booking checks of a self viewing (inside the booking transaction): the listing is eligible, the prospect is
   * verified and accepted the visitor terms in force, and no other self viewing of theirs overlaps the code window.
   */
  async checkBooking(
    tx: Tx,
    userId: string,
    listing: ListingRef,
    slot: Slot,
    termsVersion: number | null | undefined,
    excludeViewingId?: string,
  ): Promise<{ identityVerificationId: string; visitorTermsVersion: number }> {
    const now = this.clock.now();
    const eligibility = await this.eligibility(tx, listing, now);
    if (!eligibility.available) this.refuse(eligibility);
    const terms = await this.terms(now);
    const facts = await this.verification(tx, userId);
    const missing = missingRequirements({
      identityVerified: Boolean(facts.identityVerificationId),
      phoneVerified: facts.phoneVerified,
      termsVersion,
      currentTermsVersion: terms.version,
    });
    if (missing.length)
      throw new DomainException('viewing.requirements_missing', {
        extensions: { missingRequirements: missing },
      });
    if (termsOutdated(termsVersion, terms.version))
      throw new DomainException('viewing.terms_outdated', {
        extensions: { visitorTermsVersion: terms.version },
      });
    const settings = await this.windowSettings(listing.tenantId, now);
    const window = codeWindow(slot.startsAt, settings);
    const others = await tx.listingViewing.findMany({
      where: {
        mode: 'self',
        state: { in: [...LIVE_VIEWING] },
        lead: { userId },
        ...(excludeViewingId ? { id: { not: excludeViewingId } } : {}),
      },
      select: { startsAt: true, tenantId: true },
    });
    for (const other of others) {
      const w = codeWindow(other.startsAt, await this.windowSettings(other.tenantId, now));
      if (w.validFrom < window.validTo && window.validFrom < w.validTo)
        throw new DomainException('viewing.access_overlap');
    }
    return { identityVerificationId: facts.identityVerificationId!, visitorTermsVersion: terms.version };
  }

  // ------------------------------------------------------------------------------------------------- issuing

  /**
   * On the owner's confirmation of a self viewing (same transaction): re-checks eligibility, opens the access window
   * and issues one PIN as visitor credentials on the unit lock and the building doors. The PIN is not returned.
   */
  async issueIn(tx: Tx, viewing: ViewingWithParts): Promise<ViewingAccess> {
    const now = this.clock.now();
    const eligibility = await this.eligibility(tx, viewing.listing, now);
    if (!eligibility.available) this.refuse(eligibility);
    const window = codeWindow(viewing.startsAt, await this.windowSettings(viewing.tenantId, now));
    const party = await tx.party.findUnique({
      where: { id: viewing.lead.partyId },
      select: { displayName: true },
    });
    let access: ViewingAccess;
    try {
      access = await tx.viewingAccess.create({
        data: {
          id: uuidv7(now.getTime()),
          tenantId: viewing.tenantId,
          viewingId: viewing.id,
          listingId: viewing.listingId,
          unitId: viewing.listing.unitId,
          buildingId: viewing.listing.buildingId,
          prospectUserId: viewing.lead.userId,
          lockId: eligibility.lock.id,
          validFrom: window.validFrom,
          validTo: window.validTo,
        },
      });
    } catch (error) {
      if (isExclusionViolation(error)) throw new DomainException('viewing.access_overlap');
      throw error;
    }
    const pin = generatePin();
    try {
      for (const lock of [eligibility.lock, ...eligibility.doors])
        await this.credentials.issueIn(tx, {
          lock,
          holderKind: 'visitor',
          holderPartyId: viewing.lead.partyId,
          holderUserId: viewing.lead.userId,
          holderName: party?.displayName ?? 'visitor',
          viewingId: viewing.id,
          validFrom: window.validFrom,
          validTo: window.validTo,
          pin,
        });
    } catch (error) {
      if (raisedWith(error, 'access.unit_occupied')) throw new DomainException('viewing.unit_occupied');
      throw error;
    }
    await this.audit.record(tx, {
      action: 'listing.self_viewing_access_issued',
      tenantId: viewing.tenantId,
      buildingId: viewing.listing.buildingId,
      subjectType: VIEWING_SUBJECT,
      subjectId: access.id,
      after: {
        viewingId: viewing.id,
        lockId: eligibility.lock.id,
        doors: eligibility.doors.length,
        validFrom: window.validFrom.toISOString(),
        validTo: window.validTo.toISOString(),
      },
    });
    await this.event(tx, 'listing.self_viewing_access_issued', access, viewing.lead, viewing.startsAt);
    return access;
  }

  private async event(
    tx: Tx,
    type: DomainEventType,
    access: ViewingAccess,
    lead: Pick<ListingLead, 'id' | 'partyId'>,
    startsAt: Date,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.events.record(tx, {
      type,
      aggregateType: 'viewing_access',
      aggregateId: access.id,
      tenantId: access.tenantId,
      buildingId: access.buildingId,
      payload: {
        accessId: access.id,
        viewingId: access.viewingId,
        listingId: access.listingId,
        unitId: access.unitId,
        leadId: lead.id,
        partyId: lead.partyId,
        prospectUserId: access.prospectUserId,
        state: access.state,
        startsAt: startsAt.toISOString(),
        validFrom: access.validFrom.toISOString(),
        validTo: access.validTo.toISOString(),
        ...extra,
      },
    });
  }

  // ------------------------------------------------------------------------------------------------- closing

  /**
   * Closes the open access window of a viewing (if any) and revokes its live credentials in the same transaction:
   * cancelled / declined / rescheduled / enquiry closed / unit let / ended by the owner / no show / left.
   */
  async closeIn(
    tx: Tx,
    viewingId: string,
    state: Extract<ViewingAccessState, 'exited' | 'expired' | 'no_show' | 'cancelled'>,
    reason: string,
    origin: 'owner' | 'viewing' = 'viewing',
  ): Promise<ViewingAccess | null> {
    const access = await tx.viewingAccess.findFirst({ where: { viewingId, closedAt: null } });
    if (!access) return null;
    const now = this.clock.now();
    const live = await tx.accessCredential.findMany({
      where: { viewingId, status: { in: [...LIVE_STATUSES] } },
    });
    for (const cred of live) await this.credentials.revokeIn(tx, cred, `viewing: ${reason}`, origin);
    const updated = await tx.viewingAccess.update({
      where: { id: access.id },
      data: {
        state,
        closedAt: now,
        closeReason: reason.slice(0, 200),
        ...(state === 'exited' ? { exitedAt: now } : {}),
        version: { increment: 1 },
      },
    });
    const viewing = await tx.listingViewing.findUniqueOrThrow({
      where: { id: viewingId },
      include: { lead: { select: { id: true, partyId: true } } },
    });
    await this.audit.record(tx, {
      action: state === 'exited' ? 'listing.self_viewing_exited' : 'listing.self_viewing_closed',
      tenantId: access.tenantId,
      buildingId: access.buildingId,
      subjectType: VIEWING_SUBJECT,
      subjectId: access.id,
      before: { state: access.state },
      after: { state, reason, revoked: live.length },
    });
    await this.event(
      tx,
      state === 'exited' ? 'listing.self_viewing_exited' : 'listing.self_viewing_closed',
      updated,
      viewing.lead,
      viewing.startsAt,
      { reason },
    );
    return updated;
  }

  /** `lease.activated` (and any occupancy): every open self-viewing window of the unit closes at once (D-071). */
  async closeForUnit(tx: Tx, unitId: string, reason: string): Promise<number> {
    const open = await tx.viewingAccess.findMany({
      where: { unitId, closedAt: null },
      select: { viewingId: true },
    });
    for (const a of open) await this.closeIn(tx, a.viewingId, 'cancelled', reason);
    return open.length;
  }

  // ------------------------------------------------------------------------------------------------- prospect

  private async myAccess(tx: Tx, userId: string, viewingId: string) {
    const access = await tx.viewingAccess.findFirst({
      where: { viewingId, prospectUserId: userId },
      include: { lock: { select: { id: true, name: true, scope: true } } },
    });
    if (!access) throw new DomainException('http.not_found');
    const viewing = await tx.listingViewing.findUniqueOrThrow({
      where: { id: viewingId },
      include: { lead: true, listing: true },
    });
    return { access, viewing };
  }

  /**
   * `GET /v1/prospect/viewings/{id}/access-code`: the PIN, only inside the window, only for the booked prospect, only
   * while the unit is still vacant and no other self viewing of theirs is open inside a unit; audited decrypt.
   */
  async accessCode(viewingId: string) {
    const userId = this.prospectId();
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const { access, viewing } = await this.myAccess(tx, userId, viewingId);
      const window = { validFrom: access.validFrom, validTo: access.validTo };
      if (access.closedAt || !insideWindow(window, now))
        throw new DomainException('viewing.code_not_available', {
          extensions: {
            codeValidFrom: access.validFrom.toISOString(),
            codeValidTo: access.validTo.toISOString(),
          },
        });
      if (await this.occupied(tx, access.unitId, now)) throw new DomainException('viewing.unit_occupied');
      const elsewhere = await tx.viewingAccess.count({
        where: { prospectUserId: userId, id: { not: access.id }, state: 'entered', closedAt: null },
      });
      if (elsewhere) throw new DomainException('viewing.access_open_elsewhere');
      const creds = await tx.accessCredential.findMany({
        where: { viewingId, status: { in: [...LIVE_STATUSES] } },
        include: { lock: { select: { id: true, name: true, scope: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const first = creds.find((c) => c.lockId === access.lockId) ?? creds[0];
      if (!first) throw new DomainException('viewing.code_not_available');
      const code = await this.credentials.reveal(tx, first, 'self_viewing');
      if (!code) throw new DomainException('viewing.code_not_available');
      await tx.viewingAccess.update({
        where: { id: access.id },
        data: { codeRevealedAt: access.codeRevealedAt ?? now, revealCount: { increment: 1 } },
      });
      return {
        viewingId: viewing.id,
        doorCode: code,
        validFrom: access.validFrom,
        validTo: access.validTo,
        locks: creds.map((c) => ({ name: c.lock.name, scope: c.lock.scope, ready: c.status === 'active' })),
      };
    });
  }

  private async markEntered(
    tx: Tx,
    access: ViewingAccess,
    viewing: Pick<ListingViewing, 'startsAt'> & { lead: Pick<ListingLead, 'id' | 'partyId'> },
    at: Date,
    source: 'prospect' | 'lock_log',
  ): Promise<ViewingAccess> {
    if (access.state !== 'issued' || access.closedAt) return access;
    const updated = await tx.viewingAccess.update({
      where: { id: access.id },
      data: { state: 'entered', enteredAt: at, enteredSource: source, version: { increment: 1 } },
    });
    await this.audit.record(tx, {
      action: 'listing.self_viewing_entered',
      tenantId: access.tenantId,
      buildingId: access.buildingId,
      subjectType: VIEWING_SUBJECT,
      subjectId: access.id,
      before: { state: access.state },
      after: { state: 'entered', source },
    });
    await this.event(tx, 'listing.self_viewing_entered', updated, viewing.lead, viewing.startsAt, {
      enteredAt: at.toISOString(),
      source,
    });
    return updated;
  }

  /** `POST …/actions/arrive`: I am at the unit (inside the window); owner and staff are alerted. */
  async arrive(viewingId: string): Promise<ViewingAccess> {
    const userId = this.prospectId();
    const now = this.clock.now();
    return this.db.platform(async (tx) => {
      const { access, viewing } = await this.myAccess(tx, userId, viewingId);
      if (access.state === 'entered') return access;
      if (access.state !== 'issued' || !insideWindow(access, now))
        throw new DomainException('viewing.access_invalid_state');
      return this.markEntered(tx, access, viewing, now, 'prospect');
    });
  }

  /**
   * `POST …/actions/leave`: I left — the codes are revoked at once, the viewing is completed and the enquiry becomes
   * `viewed`.
   */
  async leave(viewingId: string): Promise<ViewingAccess> {
    const userId = this.prospectId();
    return this.db.platform(async (tx) => {
      const { access, viewing } = await this.myAccess(tx, userId, viewingId);
      if (access.state === 'exited') return access;
      if (
        access.closedAt ||
        !['issued', 'entered'].includes(access.state) ||
        access.validFrom > this.clock.now()
      )
        throw new DomainException('viewing.access_invalid_state');
      const closed = (await this.closeIn(tx, viewingId, 'exited', 'left'))!;
      if (viewing.state === 'confirmed') {
        await tx.listingViewing.update({
          where: { id: viewing.id },
          data: { state: 'completed', version: { increment: 1 } },
        });
        await tx.listingLead.updateMany({
          where: { id: viewing.leadId, state: { in: ['new', 'contacted', 'viewing_booked'] } },
          data: { state: 'viewed', version: { increment: 1 } },
        });
        await this.events.record(tx, {
          type: 'listing.viewing_completed',
          aggregateType: 'listing_lead',
          aggregateId: viewing.leadId,
          tenantId: viewing.tenantId,
          buildingId: viewing.listing.buildingId,
          payload: {
            listingId: viewing.listingId,
            leadId: viewing.leadId,
            partyId: viewing.lead.partyId,
            viewingId: viewing.id,
            outcome: 'completed',
          },
        });
      }
      return closed;
    });
  }

  /**
   * `POST …/actions/report-incident`: something is wrong at the unit (damage, a door that does not lock, someone
   * inside) — a high-priority inspection work order is opened on the unit and owner and staff are alerted. Once per
   * viewing; possible during the visit and up to the end of the Bangkok day of the viewing.
   */
  async reportIncident(viewingId: string, note: string): Promise<ViewingAccess> {
    const userId = this.prospectId();
    const now = this.clock.now();
    const text = note.trim();
    return this.db.platform(async (tx) => {
      const { access, viewing } = await this.myAccess(tx, userId, viewingId);
      if (
        access.incidentAt ||
        access.state === 'cancelled' ||
        access.validFrom > now ||
        bangkokDate(now) > bangkokDate(access.validTo)
      )
        throw new DomainException('viewing.access_invalid_state');
      const wo = await RequestContext.run({ actor: systemActor('self-viewing') }, () =>
        this.workOrders.createIn(tx, systemTenantContext(access.tenantId), {
          kind: 'inspection',
          unitId: access.unitId,
          title: `ตรวจห้องหลังผู้เข้าชมแจ้งปัญหา (self-viewing) — ${viewing.listing.titleTh}`.slice(0, 200),
          description: text,
          priority: 'high',
        }),
      );
      const updated = await tx.viewingAccess.update({
        where: { id: access.id },
        data: { incidentNote: text, incidentAt: now, workOrderId: wo.id, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'listing.self_viewing_incident',
        tenantId: access.tenantId,
        buildingId: access.buildingId,
        subjectType: VIEWING_SUBJECT,
        subjectId: access.id,
        after: { workOrderId: wo.id },
      });
      await this.event(tx, 'listing.self_viewing_incident', updated, viewing.lead, viewing.startsAt, {
        workOrderId: wo.id,
        note: text.slice(0, 200),
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------------------------- owner

  private async ownerAccess(tx: Tx, ctx: TenantContext, viewingId: string): Promise<AccessWithParts> {
    const access = await tx.viewingAccess.findFirst({
      where: { viewingId, tenantId: ctx.tenantId },
      include: { lock: { select: { id: true, name: true, scope: true } } },
    });
    if (!access) throw new DomainException('http.not_found');
    return access;
  }

  /** `GET /v1/owner/listing-viewings/{id}/access-log`: the window, its credentials and the door events (audited). */
  async accessLog(
    ctx: TenantContext,
    viewingId: string,
  ): Promise<{
    access: AccessWithParts;
    credentials: {
      lockName: string;
      lockScope: string;
      status: string;
      validFrom: Date;
      validTo: Date | null;
    }[];
    events: (AccessEvent & { lockName: string })[];
  }> {
    return this.db.tenant(ctx, async (tx) => {
      const access = await this.ownerAccess(tx, ctx, viewingId);
      const creds = await tx.accessCredential.findMany({
        where: { viewingId },
        include: { lock: { select: { id: true, name: true, scope: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const events = creds.length
        ? await tx.accessEvent.findMany({
            where: {
              credentialId: { in: creds.map((c) => c.id) },
              time: { gte: new Date(access.validFrom.getTime() - 86_400_000) },
            },
            orderBy: { time: 'asc' },
            take: 200,
          })
        : [];
      await this.audit.record(tx, {
        action: 'listing.self_viewing_log_read',
        tenantId: access.tenantId,
        buildingId: access.buildingId,
        subjectType: VIEWING_SUBJECT,
        subjectId: access.id,
      });
      const names = new Map(creds.map((c) => [c.lockId, c.lock.name]));
      return {
        access,
        credentials: creds.map((c) => ({
          lockName: c.lock.name,
          lockScope: c.lock.scope,
          status: c.status,
          validFrom: c.validFrom,
          validTo: c.validTo,
        })),
        events: events.map((e) => ({ ...e, lockName: names.get(e.lockId) ?? '' })),
      };
    });
  }

  /** `POST /v1/owner/listing-viewings/{id}/actions/end-access`: the owner ends a self viewing's codes now. */
  async endAccess(ctx: TenantContext, viewingId: string, reason: string): Promise<AccessWithParts> {
    return this.db.tenant(ctx, async (tx) => {
      const access = await this.ownerAccess(tx, ctx, viewingId);
      if (access.closedAt) throw new DomainException('viewing.access_invalid_state');
      await this.closeIn(tx, viewingId, 'cancelled', `ended by the owner: ${reason.trim()}`, 'owner');
      return this.ownerAccess(tx, ctx, viewingId);
    });
  }

  /** Access summaries of viewings (owner calendar, enquiry DTOs). */
  async summaries(tx: Tx, viewingIds: string[]): Promise<Map<string, ViewingAccess>> {
    if (!viewingIds.length) return new Map();
    const rows = await tx.viewingAccess.findMany({ where: { viewingId: { in: viewingIds } } });
    return new Map(rows.map((r) => [r.viewingId, r]));
  }

  // ------------------------------------------------------------------------------------------------- events + jobs

  /** `access.viewing_door_opened` (lock log): the visitor's entry, once. */
  async onDoorOpened(tx: Tx, viewingId: string, at: Date): Promise<void> {
    const access = await tx.viewingAccess.findFirst({ where: { viewingId } });
    if (!access || access.state !== 'issued' || access.closedAt) return;
    const viewing = await tx.listingViewing.findUniqueOrThrow({
      where: { id: viewingId },
      include: { lead: { select: { id: true, partyId: true } } },
    });
    await this.markEntered(tx, access, viewing, at, 'lock_log');
  }

  /**
   * Maintenance (with `listing-reminders`): windows that ended without an entry → `no_show` (the viewing too); an
   * entered visitor who did not confirm leaving `viewing.self.overstay_minutes` after the window → owner and staff
   * alerted once and the window closed `expired`; closed records older than `viewing.self.log_retention_days` deleted.
   */
  async sweep(): Promise<{ noShows: number; overstays: number; purged: number }> {
    const now = this.clock.now();
    return RequestContext.run({ actor: systemActor('self-viewing') }, () =>
      this.db.platform(async (tx) => {
        let noShows = 0;
        let overstays = 0;
        const due = await tx.viewingAccess.findMany({
          where: { closedAt: null, validTo: { lte: now } },
          take: 500,
          orderBy: { validTo: 'asc' },
        });
        for (const access of due) {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${access.tenantId}, true)`;
          if (endStateAfterWindow(access) === 'no_show') {
            await this.closeIn(tx, access.viewingId, 'no_show', 'no entry in the code window');
            const viewing = await tx.listingViewing.findUniqueOrThrow({ where: { id: access.viewingId } });
            if (viewing.state === 'confirmed') {
              await tx.listingViewing.update({
                where: { id: viewing.id },
                data: { state: 'no_show', version: { increment: 1 } },
              });
              const lead = await tx.listingLead.findUniqueOrThrow({ where: { id: viewing.leadId } });
              const live = await tx.listingViewing.count({
                where: { leadId: lead.id, state: { in: [...LIVE_VIEWING] } },
              });
              if (lead.state === 'viewing_booked' && !live)
                await tx.listingLead.update({
                  where: { id: lead.id },
                  data: { state: lead.lastOwnerAt ? 'contacted' : 'new', version: { increment: 1 } },
                });
            }
            noShows += 1;
            continue;
          }
          const minutes = await this.settings.valueAt<number>('viewing.self.overstay_minutes', now, {
            tenantId: access.tenantId,
          });
          if (!overstaying(access, now, minutes ?? 30)) continue;
          const viewing = await tx.listingViewing.findUniqueOrThrow({
            where: { id: access.viewingId },
            include: { lead: { select: { id: true, partyId: true } } },
          });
          const alerted = await tx.viewingAccess.update({
            where: { id: access.id },
            data: { overstayAlertedAt: now },
          });
          await this.event(tx, 'listing.self_viewing_overstayed', alerted, viewing.lead, viewing.startsAt);
          await this.closeIn(tx, access.viewingId, 'expired', 'exit not confirmed');
          overstays += 1;
        }
        const days = await this.settings.valueAt<number>('viewing.self.log_retention_days', now);
        const purged = await tx.viewingAccess.deleteMany({
          where: { closedAt: { lt: new Date(now.getTime() - (days ?? 365) * 86_400_000) } },
        });
        return { noShows, overstays, purged: purged.count };
      }),
    );
  }
}

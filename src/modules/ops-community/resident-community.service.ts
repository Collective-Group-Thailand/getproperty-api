import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { TenantTx } from '@database/tenant-tx';
import { type Announcement } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { cleanAudience, inAudience, localized } from './community-rules';
import { BOOKING_INCLUDE, type BookingRow, FacilitiesService } from './facilities.service';
import { PARCEL_INCLUDE, type ParcelRow, ParcelsService } from './parcels.service';
import { BuildingRulesService } from './rules-contacts.service';

function actorUser(): { userId: string; scopes: readonly string[] } {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return { userId: actor.publicId, scopes: actor.scopes };
}

export interface ResidentAnnouncement {
  row: Announcement;
  language: string;
  title: string;
  body: string;
  readAt: Date | null;
}

/**
 * Community in the resident LIFF (B5.3, D-073, D-025): announcements for my units (in my language, read receipts),
 * my units' parcels with the pick-up PIN, facilities of my building and my bookings, the building rules in force
 * with my acknowledgement, the building's contacts. Everything is scoped by the `unit:` scopes of my token; a unit I
 * do not occupy is a 404.
 */
@Injectable()
export class ResidentCommunityService {
  constructor(
    private readonly db: TenantTx,
    private readonly parcels: ParcelsService,
    private readonly facilities: FacilitiesService,
    private readonly rules: BuildingRulesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private unitIds(): string[] {
    return actorUser()
      .scopes.filter((s) => s.startsWith('unit:'))
      .map((s) => s.slice('unit:'.length));
  }

  private async myUnits() {
    const ids = this.unitIds();
    if (!ids.length) return [];
    return this.db.platform((tx) =>
      tx.unit.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, unitNo: true, tenantId: true, buildingId: true, floorId: true },
      }),
    );
  }

  async unit(unitId: string) {
    if (!this.unitIds().includes(unitId)) throw new DomainException('http.not_found');
    const unit = (await this.myUnits()).find((u) => u.id === unitId);
    if (!unit) throw new DomainException('http.not_found');
    const ctx: TenantContext = { tenantId: unit.tenantId, source: 'path' };
    return { ctx, unit };
  }

  /** My party in a tenant (occupying the unit when possible). */
  private async myParty(tenantId: string, unitId?: string): Promise<string | null> {
    const { userId } = actorUser();
    return this.db.platform(async (tx) => {
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active', tenantId },
        select: { partyId: true },
      });
      const ids = links.map((l) => l.partyId);
      if (!ids.length) return null;
      if (unitId) {
        const occ = await tx.occupancy.findFirst({
          where: { unitId, partyId: { in: ids } },
          orderBy: { validFrom: 'desc' },
          select: { partyId: true },
        });
        if (occ) return occ.partyId;
      }
      return ids[0]!;
    });
  }

  private async language(): Promise<string> {
    const { userId } = actorUser();
    const u = await this.db.platform((tx) =>
      tx.userAccount.findUnique({ where: { id: userId }, select: { language: true } }),
    );
    return u?.language ?? 'th';
  }

  // ------------------------------------------------------------------------------------------- announcements

  async announcements(): Promise<ResidentAnnouncement[]> {
    const units = await this.myUnits();
    if (!units.length) return [];
    const now = this.clock.now();
    const language = await this.language();
    const { userId } = actorUser();
    const rows = await this.db.platform((tx) =>
      tx.announcement.findMany({
        where: {
          publishedAt: { not: null, lte: now },
          archivedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          AND: [
            {
              OR: units.map((u) => ({
                tenantId: u.tenantId,
                OR: [{ buildingId: u.buildingId }, { buildingId: null }],
              })),
            },
          ],
        },
        orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
        take: 100,
      }),
    );
    const visible = rows.filter((a) =>
      units.some(
        (u) =>
          u.tenantId === a.tenantId &&
          (!a.buildingId || a.buildingId === u.buildingId) &&
          inAudience(cleanAudience(a.audienceFilter), { id: u.id, floorId: u.floorId }),
      ),
    );
    const parties = await this.db.platform((tx) =>
      tx.partyUserLink.findMany({ where: { userId, state: 'active' }, select: { partyId: true } }),
    );
    const reads = visible.length
      ? await this.db.platform((tx) =>
          tx.announcementRead.findMany({
            where: {
              announcementId: { in: visible.map((a) => a.id) },
              partyId: { in: parties.map((p) => p.partyId) },
            },
          }),
        )
      : [];
    return visible.map((row) => ({
      row,
      ...localized(row, row.translations, language),
      readAt: reads.find((r) => r.announcementId === row.id)?.readAt ?? null,
    }));
  }

  async markRead(id: string): Promise<ResidentAnnouncement> {
    const mine = (await this.announcements()).find((a) => a.row.id === id);
    if (!mine) throw new DomainException('http.not_found');
    if (!mine.readAt) {
      const party = await this.myParty(mine.row.tenantId);
      if (!party) throw new DomainException('http.not_found');
      const { userId } = actorUser();
      const ctx: TenantContext = { tenantId: mine.row.tenantId, source: 'path' };
      await this.db.tenant(ctx, async (tx) => {
        const exists = await tx.announcementRead.findUnique({
          where: { announcementId_partyId: { announcementId: id, partyId: party } },
        });
        if (!exists)
          await tx.announcementRead.create({
            data: {
              announcementId: id,
              partyId: party,
              tenantId: ctx.tenantId,
              userId,
              readAt: this.clock.now(),
            },
          });
      });
    }
    return (await this.announcements()).find((a) => a.row.id === id)!;
  }

  // -------------------------------------------------------------------------------------------------- parcels

  async myParcels(): Promise<(ParcelRow & { pin: string | null })[]> {
    const units = await this.myUnits();
    if (!units.length) return [];
    return this.db.platform(async (tx) => {
      const rows = await tx.parcel.findMany({
        where: { unitId: { in: units.map((u) => u.id) } },
        include: PARCEL_INCLUDE,
        orderBy: { receivedAt: 'desc' },
        take: 100,
      });
      const out: (ParcelRow & { pin: string | null })[] = [];
      for (const r of rows)
        out.push({
          ...r,
          pin: ['received', 'notified'].includes(r.status) ? await this.parcels.pin(tx, r) : null,
        });
      return out;
    });
  }

  // ----------------------------------------------------------------------------------------------- facilities

  async facilitiesOf(unitId: string) {
    const { ctx, unit } = await this.unit(unitId);
    return this.db.tenant(ctx, (tx) =>
      tx.facility.findMany({
        where: { buildingId: unit.buildingId, isActive: true, deletedAt: null },
        orderBy: { name: 'asc' },
      }),
    );
  }

  /** Busy times of a facility on a Bangkok day (no other unit is named). */
  async availability(facilityId: string, day: string) {
    const units = await this.myUnits();
    const facility = await this.db.platform((tx) => tx.facility.findUnique({ where: { id: facilityId } }));
    if (!facility || facility.deletedAt || !units.some((u) => u.buildingId === facility.buildingId))
      throw new DomainException('http.not_found');
    const from = new Date(`${day}T00:00:00+07:00`);
    const to = new Date(from.getTime() + 86_400_000);
    const busy = await this.db.platform((tx) =>
      tx.facilityBooking.findMany({
        where: {
          facilityId,
          status: { in: ['requested', 'confirmed'] },
          startsAt: { lt: to },
          endsAt: { gt: from },
        },
        select: { startsAt: true, endsAt: true, unitId: true, status: true },
        orderBy: { startsAt: 'asc' },
      }),
    );
    const mine = new Set(units.map((u) => u.id));
    return { facility, busy: busy.map((b) => ({ ...b, mine: mine.has(b.unitId) })) };
  }

  async book(input: {
    facilityId: string;
    unitId: string;
    startsAt: Date;
    endsAt: Date;
    note?: string | null;
  }) {
    const { ctx, unit } = await this.unit(input.unitId);
    const party = await this.myParty(ctx.tenantId, unit.id);
    const id = await this.db.tenant(ctx, async (tx) => {
      const facility = await tx.facility.findFirst({
        where: { id: input.facilityId, buildingId: unit.buildingId, deletedAt: null },
      });
      if (!facility) throw new DomainException('http.not_found');
      return (
        await this.facilities.bookIn(tx, {
          facility,
          unitId: unit.id,
          partyId: party,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          note: input.note ?? null,
        })
      ).id;
    });
    return this.booking(id);
  }

  async myBookings(): Promise<BookingRow[]> {
    const units = await this.myUnits();
    if (!units.length) return [];
    return this.db.platform((tx) =>
      tx.facilityBooking.findMany({
        where: { unitId: { in: units.map((u) => u.id) } },
        include: BOOKING_INCLUDE,
        orderBy: { startsAt: 'desc' },
        take: 100,
      }),
    );
  }

  async booking(id: string): Promise<BookingRow> {
    const row = (await this.myBookings()).find((b) => b.id === id);
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  async cancelBooking(id: string, reason: string | null): Promise<BookingRow> {
    const row = await this.booking(id);
    const ctx: TenantContext = { tenantId: row.tenantId, source: 'path' };
    await this.db.tenant(ctx, async (tx) => {
      const b = await tx.facilityBooking.findUniqueOrThrow({ where: { id } });
      await this.facilities.decideIn(tx, b, 'cancel', reason);
    });
    return this.booking(id);
  }

  // ------------------------------------------------------------------------------------------ rules, contacts

  async rulesOf(unitId: string) {
    const { ctx, unit } = await this.unit(unitId);
    const party = await this.myParty(ctx.tenantId, unit.id);
    return this.db.tenant(ctx, async (tx) => {
      const rule = await this.rules.inForce(tx, unit.buildingId, bangkokDate(this.clock.now()));
      const ack =
        rule && party
          ? await tx.buildingRuleAck.findUnique({
              where: { ruleId_partyId: { ruleId: rule.id, partyId: party } },
            })
          : null;
      return { rule, acknowledgedAt: ack?.ackedAt ?? null, language: await this.language() };
    });
  }

  async acknowledge(unitId: string) {
    const { ctx, unit } = await this.unit(unitId);
    const party = await this.myParty(ctx.tenantId, unit.id);
    if (!party) throw new DomainException('http.not_found');
    const { userId } = actorUser();
    await this.db.tenant(ctx, async (tx) => {
      const lease = await tx.lease.findFirst({
        where: {
          unitId: unit.id,
          status: { in: ['active', 'notice_given', 'ending'] },
          parties: { some: { partyId: party } },
        },
        select: { id: true },
      });
      const rule = await this.rules.acknowledgeIn(tx, {
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        partyIds: [party],
        leaseId: lease?.id ?? null,
        userId,
      });
      if (!rule) throw new DomainException('http.not_found');
    });
    return this.rulesOf(unitId);
  }

  async contactsOf(unitId: string) {
    const { ctx, unit } = await this.unit(unitId);
    return this.db.tenant(ctx, (tx) =>
      tx.contact.findMany({
        where: {
          tenantId: ctx.tenantId,
          deletedAt: null,
          OR: [{ buildingId: unit.buildingId }, { buildingId: null }],
        },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }
}

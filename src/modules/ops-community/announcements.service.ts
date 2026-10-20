import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type Announcement, type Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import {
  type AudienceFilter,
  cleanAudience,
  cleanTranslations,
  inAudience,
  type Translations,
} from './community-rules';

export interface AnnouncementInput {
  buildingId?: string | null;
  title: string;
  bodyTh: string;
  translations?: Translations;
  audienceFilter?: AudienceFilter;
  pinned?: boolean;
  expiresAt?: Date | null;
  publish?: boolean;
}

const by = () => userIdOf(RequestContext.actor());

/** Residents (party + login) of the units of a building today: lessees, co-tenants and occupants. */
export async function residentsOfBuildings(
  tx: Tx,
  tenantId: string,
  buildingIds: string[] | null,
  today: string,
): Promise<{ partyId: string; unitId: string; floorId: string | null }[]> {
  const rows = await tx.occupancy.findMany({
    where: {
      unit: {
        deletedAt: null,
        building: buildingIds
          ? { id: { in: buildingIds } }
          : { OR: [{ operatorTenantId: tenantId }, { ownerTenantId: tenantId }] },
      },
      validFrom: { lte: new Date(today) },
      OR: [{ validTo: null }, { validTo: { gt: new Date(today) } }],
    },
    select: { partyId: true, unitId: true, unit: { select: { floorId: true } } },
  });
  return rows.map((r) => ({ partyId: r.partyId, unitId: r.unitId, floorId: r.unit.floorId }));
}

/**
 * Announcements (B5.3, D-073): a building's or the whole tenant's, Thai body with translations, an audience filter
 * (floors / units), pinned, an expiry; published at once or later — publishing sends a LINE push to the residents in
 * the audience (quiet hours, consent and the `announcements` topic apply). Read receipts per party.
 */
@Injectable()
export class AnnouncementsService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  list(ctx: TenantContext, f: { buildingId?: string; published?: boolean; skip: number; take: number }) {
    const where: Prisma.AnnouncementWhereInput = this.own(ctx, {
      ...(f.buildingId ? { OR: [{ buildingId: f.buildingId }, { buildingId: null }] } : {}),
      ...(f.published === true
        ? { publishedAt: { not: null } }
        : f.published === false
          ? { publishedAt: null }
          : {}),
    });
    return this.db.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.announcement.findMany({
          where,
          include: { _count: { select: { reads: true } } },
          orderBy: [
            { pinned: 'desc' },
            { publishedAt: { sort: 'desc', nulls: 'first' } },
            { createdAt: 'desc' },
          ],
          skip: f.skip,
          take: f.take,
        }),
        tx.announcement.count({ where }),
      ]);
      return { rows, total };
    });
  }

  async get(ctx: TenantContext, id: string) {
    return this.found(
      await this.db.tenant(ctx, (tx) =>
        tx.announcement.findFirst({
          where: this.own(ctx, { id }),
          include: { _count: { select: { reads: true } } },
        }),
      ),
    );
  }

  private async checkBuilding(tx: Tx, ctx: TenantContext, buildingId: string | null | undefined) {
    if (!buildingId) {
      if (ctx.buildingIds) throw new DomainException('auth.forbidden');
      return;
    }
    const b = await tx.building.findFirst({
      where: {
        id: buildingId,
        deletedAt: null,
        OR: [{ operatorTenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }],
      },
    });
    if (!b || (ctx.buildingIds && !ctx.buildingIds.includes(buildingId)))
      throw new DomainException('http.not_found');
  }

  async create(ctx: TenantContext, input: AnnouncementInput) {
    const id = await this.db.tenant(ctx, async (tx) => {
      await this.checkBuilding(tx, ctx, input.buildingId);
      const row = await tx.announcement.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: input.buildingId ?? null,
          title: input.title.trim(),
          bodyTh: input.bodyTh.trim(),
          translations: cleanTranslations(input.translations) as Prisma.InputJsonValue,
          audienceFilter: cleanAudience(input.audienceFilter) as Prisma.InputJsonValue,
          pinned: input.pinned ?? false,
          expiresAt: input.expiresAt ?? null,
          createdAt: this.clock.now(),
          createdBy: by(),
        },
      });
      if (input.publish) await this.publishIn(tx, row);
      return row.id;
    });
    return this.get(ctx, id);
  }

  /** Drafts may change entirely; a published announcement only its pin and expiry (what residents read stays). */
  async update(ctx: TenantContext, id: string, input: Partial<AnnouncementInput>) {
    await this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.announcement.findFirst({ where: this.own(ctx, { id }) }));
      const published = row.publishedAt !== null;
      if (
        published &&
        (input.title !== undefined || input.bodyTh !== undefined || input.translations !== undefined)
      )
        throw new DomainException('announcement.published');
      await tx.announcement.update({
        where: { id: row.id },
        data: {
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.bodyTh !== undefined ? { bodyTh: input.bodyTh.trim() } : {}),
          ...(input.translations !== undefined
            ? { translations: cleanTranslations(input.translations) as Prisma.InputJsonValue }
            : {}),
          ...(input.audienceFilter !== undefined && !published
            ? { audienceFilter: cleanAudience(input.audienceFilter) as Prisma.InputJsonValue }
            : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          version: { increment: 1 },
          updatedBy: by(),
        },
      });
    });
    return this.get(ctx, id);
  }

  async publish(ctx: TenantContext, id: string) {
    await this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.announcement.findFirst({ where: this.own(ctx, { id }) }));
      if (row.publishedAt) throw new DomainException('announcement.published');
      await this.publishIn(tx, row);
    });
    return this.get(ctx, id);
  }

  private async publishIn(tx: Tx, row: Announcement): Promise<void> {
    const now = this.clock.now();
    await tx.announcement.update({
      where: { id: row.id },
      data: { publishedAt: now, version: { increment: 1 }, updatedBy: by() },
    });
    await this.events.record(tx, {
      type: 'announcement.published',
      aggregateType: 'announcement',
      aggregateId: row.id,
      tenantId: row.tenantId,
      buildingId: row.buildingId,
      payload: { announcementId: row.id, buildingId: row.buildingId, pinned: row.pinned },
    });
  }

  /** Takes an announcement down now (it stays in the history with its receipts). */
  async archive(ctx: TenantContext, id: string) {
    await this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.announcement.findFirst({ where: this.own(ctx, { id }) }));
      await tx.announcement.update({
        where: { id: row.id },
        data: { archivedAt: this.clock.now(), pinned: false, version: { increment: 1 }, updatedBy: by() },
      });
    });
    return this.get(ctx, id);
  }

  /** Who read it, against the audience today (count of residents in the filter). */
  async reads(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) => {
      const row = this.found(await tx.announcement.findFirst({ where: this.own(ctx, { id }) }));
      const reads = await tx.announcementRead.findMany({
        where: { announcementId: row.id },
        include: { party: { select: { displayName: true } } },
        orderBy: { readAt: 'asc' },
      });
      const filter = cleanAudience(row.audienceFilter);
      const residents = await residentsOfBuildings(
        tx,
        ctx.tenantId,
        row.buildingId ? [row.buildingId] : null,
        bangkokDate(this.clock.now()),
      );
      const audience = new Set(
        residents
          .filter((r) => inAudience(filter, { id: r.unitId, floorId: r.floorId }))
          .map((r) => r.partyId),
      );
      return { audience: audience.size, reads };
    });
  }
}

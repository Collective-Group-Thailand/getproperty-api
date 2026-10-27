import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { systemTenantContext, type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays, bangkokDate, startOfBangkokDay } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type ListingMandate, type MandateScope, type MandateState, Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

/** D-293: the grant modules a mandate scope opens on its unit (read access; the agency writes only its own rows). */
export const MANDATE_MODULES: Record<MandateScope, string[]> = {
  list: ['ops.listing'],
  list_and_lease: ['ops.listing', 'ops.lease'],
  manage: ['ops.listing', 'ops.lease', 'ops.billing', 'ops.service'],
};

/** Mandates that count for exclusivity and for the agency's access. */
export const HELD: MandateState[] = ['accepted', 'active'];
const OPEN: MandateState[] = ['invited', 'accepted', 'active'];
const LIVE_LISTING = ['draft', 'rejected', 'pending_review', 'published', 'paused'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface MandateInviteInput {
  agencyTenantId: string;
  unitId: string;
  scope?: MandateScope;
  exclusive?: boolean;
  commissionTerms?: string | null;
  commissionPercent?: string | null;
  commissionAmount?: string | null;
  /** `YYYY-MM-DD` (Bangkok), default today; never in the past. */
  validFrom?: string;
  validTo?: string | null;
}

export type MandateView = ListingMandate & {
  agencyName: string;
  ownerName: string;
  unitNo: string;
  buildingName: string;
};

const invalid = (path: string, message: string, code = 'invalid') =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Owner → agency listing mandates (G2, D-284, D-293). The owner of a unit — the tenant holding the unit row, or the
 * building's owner / operator — invites an `agency` tenant for one unit with a scope (`list`, `list_and_lease`,
 * `manage`), an exclusive flag, commission terms and a validity window. The agency accepts: a unit-scope
 * `core.asset_access_grant` (reason `listing_mandate`, modules per scope, expiring with the mandate) is written in
 * the owner's name and the mandate is `active` from its first day (`accepted` until then). An exclusive mandate
 * excludes any other held mandate on the unit, and a unit with held mandates cannot get an exclusive one. Revoking
 * (owner) or ending (either party, or the date) revokes the grant and closes the agency's open listings of the unit in
 * the same transaction — access stops at once. Every change: audit + domain event.
 */
@Injectable()
export class MandatesService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private today() {
    return bangkokDate(this.clock.now());
  }

  /** Names for the views (both tenants see the mandate; names come from rows the caller may not see under RLS). */
  async views(rows: ListingMandate[]): Promise<MandateView[]> {
    if (!rows.length) return [];
    const tenantIds = [...new Set(rows.flatMap((r) => [r.tenantId, r.ownerTenantId]))];
    const unitIds = [...new Set(rows.map((r) => r.unitId))];
    const [tenants, units] = await this.db.platform(async (tx) => [
      await tx.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, displayName: true } }),
      await tx.unit.findMany({
        where: { id: { in: unitIds } },
        select: { id: true, unitNo: true, building: { select: { name: true } } },
      }),
    ]);
    const name = new Map(tenants.map((t) => [t.id, t.displayName]));
    const unit = new Map(units.map((u) => [u.id, u]));
    return rows.map((r) => ({
      ...r,
      agencyName: name.get(r.tenantId) ?? '',
      ownerName: name.get(r.ownerTenantId) ?? '',
      unitNo: unit.get(r.unitId)?.unitNo ?? '',
      buildingName: unit.get(r.unitId)?.building.name ?? '',
    }));
  }

  /** Active agencies whose name matches (the owner's picker; names only, D-284). */
  async agencies(q: string | undefined, limit = 20) {
    const term = (q ?? '').trim();
    return this.db.platform((tx) =>
      tx.tenant.findMany({
        where: {
          type: 'agency',
          status: 'active',
          deletedAt: null,
          ...(term ? { displayName: { contains: term, mode: 'insensitive' as const } } : {}),
        },
        select: { id: true, displayName: true, slug: true },
        orderBy: { displayName: 'asc' },
        take: limit,
      }),
    );
  }

  /** Mandates the tenant gave (owner) or received (agency); RLS shows both sides. */
  async list(
    ctx: TenantContext,
    filter: { role?: 'owner' | 'agency'; state?: MandateState; unitId?: string } = {},
  ) {
    const rows = await this.db.tenant(ctx, (tx) =>
      tx.listingMandate.findMany({
        where: {
          ...(filter.role === 'owner'
            ? { ownerTenantId: ctx.tenantId }
            : filter.role === 'agency'
              ? { tenantId: ctx.tenantId }
              : { OR: [{ tenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }] }),
          state: filter.state,
          unitId: filter.unitId,
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return this.views(rows);
  }

  async get(ctx: TenantContext, id: string): Promise<MandateView> {
    const row = await this.db.tenant(ctx, (tx) =>
      tx.listingMandate.findFirst({
        where: { id, OR: [{ tenantId: ctx.tenantId }, { ownerTenantId: ctx.tenantId }] },
      }),
    );
    if (!row) throw new DomainException('http.not_found');
    return (await this.views([row]))[0]!;
  }

  /** Units the agency holds an active mandate for, with the facts it needs to list them. */
  async mandatedUnits(ctx: TenantContext) {
    const mandates = await this.db.tenant(ctx, (tx) =>
      tx.listingMandate.findMany({
        where: { tenantId: ctx.tenantId, state: 'active' },
        orderBy: { activatedAt: 'desc' },
      }),
    );
    if (!mandates.length) return [];
    const views = await this.views(mandates);
    const units = await this.db.platform((tx) =>
      tx.unit.findMany({
        where: { id: { in: mandates.map((m) => m.unitId) } },
        include: { building: { include: { property: true } } },
      }),
    );
    const byId = new Map(units.map((u) => [u.id, u]));
    const listings = await this.db.tenant(ctx, (tx) =>
      tx.listing.findMany({
        where: {
          tenantId: ctx.tenantId,
          mandateId: { in: mandates.map((m) => m.id) },
          state: { not: 'closed' },
        },
        select: { id: true, mandateId: true, state: true },
      }),
    );
    return views.map((m) => {
      const u = byId.get(m.unitId)!;
      const address = (u.building.address ?? u.building.property.address ?? {}) as Record<
        string,
        string | null
      >;
      return {
        mandate: m,
        unit: { id: u.id, unitNo: u.unitNo, type: u.type, areaSqm: u.areaSqm },
        building: { id: u.buildingId, name: u.building.name },
        province: address.province ?? null,
        district: address.district ?? null,
        listing: listings.find((l) => l.mandateId === m.id) ?? null,
      };
    });
  }

  // ------------------------------------------------------------------------------------------------- owner side

  async invite(ctx: TenantContext, input: MandateInviteInput): Promise<MandateView> {
    const today = this.today();
    const validFrom = input.validFrom ?? today;
    if (!DAY.test(validFrom)) throw invalid('validFrom', 'validFrom is YYYY-MM-DD');
    if (validFrom < today) throw invalid('validFrom', 'a mandate never starts in the past', 'min');
    if (input.validTo !== undefined && input.validTo !== null) {
      if (!DAY.test(input.validTo)) throw invalid('validTo', 'validTo is YYYY-MM-DD');
      if (input.validTo < validFrom) throw invalid('validTo', 'validTo is on or after validFrom', 'min');
    }
    const percent = input.commissionPercent ? new Decimal(input.commissionPercent) : null;
    if (percent && (percent.lt(0) || percent.gt(100)))
      throw invalid('commissionPercent', 'a percentage 0–100', 'range');
    const amount = input.commissionAmount ? new Decimal(input.commissionAmount) : null;
    if (amount?.lt(0)) throw invalid('commissionAmount', 'not negative', 'min');
    if (input.agencyTenantId === ctx.tenantId) throw new DomainException('mandate.agency_required');
    const agency = await this.db.platform((tx) =>
      tx.tenant.findFirst({
        where: { id: input.agencyTenantId, deletedAt: null, status: { not: 'deactivated' } },
        select: { id: true, type: true },
      }),
    );
    if (!agency) throw new DomainException('http.not_found');
    if (agency.type !== 'agency') throw new DomainException('mandate.agency_required');
    const scope = input.scope ?? 'list';
    const exclusive = input.exclusive ?? false;

    const id = await this.db.tenant(ctx, async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { id: input.unitId, deletedAt: null },
        include: { building: { select: { ownerTenantId: true, operatorTenantId: true } } },
      });
      // a unit the tenant only sees through someone else's grant is not its to mandate
      if (
        !unit ||
        (unit.tenantId !== ctx.tenantId &&
          unit.building.ownerTenantId !== ctx.tenantId &&
          unit.building.operatorTenantId !== ctx.tenantId)
      )
        throw new DomainException('http.not_found');
      await this.lockUnit(tx, unit.id);
      const others = await this.heldOn(unit.id);
      if (
        others.some((m) => m.tenantId === agency.id) ||
        (await tx.listingMandate.count({
          where: { unitId: unit.id, tenantId: agency.id, state: 'invited' },
        })) > 0
      )
        throw new DomainException('mandate.invalid_state');
      this.assertExclusivity(exclusive, others);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { legalPartyId: true },
      });
      const row = await tx.listingMandate.create({
        data: {
          tenantId: agency.id,
          ownerTenantId: ctx.tenantId,
          ownerPartyId: tenant.legalPartyId,
          unitId: unit.id,
          buildingId: unit.buildingId,
          scope,
          exclusive,
          commissionTerms: input.commissionTerms?.trim() || null,
          commissionPercent: percent?.toFixed(4) ?? null,
          commissionAmount: amount?.toFixed(2) ?? null,
          validFrom: new Date(`${validFrom}T00:00:00Z`),
          validTo: input.validTo ? new Date(`${input.validTo}T00:00:00Z`) : null,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.audit.record(tx, {
        action: 'mandate.invited',
        tenantId: ctx.tenantId,
        buildingId: unit.buildingId,
        subjectType: 'ops.listing_mandate',
        subjectId: row.id,
        after: {
          agencyTenantId: agency.id,
          unitId: unit.id,
          scope,
          exclusive,
          validFrom,
          validTo: input.validTo ?? null,
        },
      });
      await this.event(tx, 'mandate.invited', row);
      return row.id;
    });
    return this.get(ctx, id);
  }

  async revoke(ctx: TenantContext, id: string, reason: string | null): Promise<MandateView> {
    await this.close(ctx, id, 'revoked', reason);
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------------ agency side

  async accept(ctx: TenantContext, id: string): Promise<MandateView> {
    const found = await this.db.platform((tx) =>
      tx.listingMandate.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
    if (!found) throw new DomainException('http.not_found');
    const by = userIdOf(RequestContext.actor());
    // the grant is the owner's (RLS: the grantor writes it), so the transaction runs in the owner's tenant
    await this.db.tenant(systemTenantContext(found.ownerTenantId), async (tx) => {
      await this.lockUnit(tx, found.unitId);
      const m = await tx.listingMandate.findUniqueOrThrow({ where: { id } });
      if (m.state !== 'invited') throw new DomainException('mandate.invalid_state');
      const today = this.today();
      const until = day(m.validTo);
      if (until && until < today) throw new DomainException('mandate.invalid_state');
      this.assertExclusivity(
        m.exclusive,
        (await this.heldOn(m.unitId)).filter((x) => x.id !== id),
      );
      const startsLater = day(m.validFrom)! > today;
      const now = this.clock.now();
      const grant = await tx.assetAccessGrant.create({
        data: {
          tenantId: m.ownerTenantId,
          granteeTenantId: m.tenantId,
          buildingId: m.buildingId,
          unitId: m.unitId,
          scope: 'unit',
          modules: MANDATE_MODULES[m.scope],
          access: 'read',
          reason: 'listing_mandate',
          // database time when it starts today: RLS compares validity with now()
          validFrom: startsLater ? startOfBangkokDay(day(m.validFrom)!) : undefined,
          validTo: until ? startOfBangkokDay(addCalendarDays(until, 1)) : null,
          sourceRef: `ops.listing_mandate:${m.id}`,
          createdBy: by,
        },
      });
      let updated: ListingMandate;
      try {
        updated = await tx.listingMandate.update({
          where: { id },
          data: {
            state: startsLater ? 'accepted' : 'active',
            grantId: grant.id,
            acceptedAt: now,
            acceptedBy: by,
            activatedAt: startsLater ? null : now,
            updatedBy: by,
            version: { increment: 1 },
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new DomainException('mandate.exclusive_conflict');
        throw error;
      }
      await this.audit.record(tx, {
        action: 'mandate.accepted',
        tenantId: m.ownerTenantId,
        buildingId: m.buildingId,
        subjectType: 'ops.listing_mandate',
        subjectId: id,
        before: { state: 'invited' },
        after: { state: updated.state, grantId: grant.id, modules: MANDATE_MODULES[m.scope] },
      });
      await this.event(tx, 'mandate.accepted', updated);
      if (!startsLater) await this.event(tx, 'mandate.activated', updated);
    });
    return this.get(ctx, id);
  }

  async decline(ctx: TenantContext, id: string, reason: string | null): Promise<MandateView> {
    await this.db.tenant(ctx, async (tx) => {
      const m = await tx.listingMandate.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!m) throw new DomainException('http.not_found');
      if (m.state !== 'invited') throw new DomainException('mandate.invalid_state');
      const updated = await tx.listingMandate.update({
        where: { id },
        data: {
          state: 'revoked',
          revokedAt: this.clock.now(),
          revokedBy: userIdOf(RequestContext.actor()),
          endReason: reason?.trim() || 'declined',
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'mandate.declined',
        tenantId: ctx.tenantId,
        buildingId: m.buildingId,
        subjectType: 'ops.listing_mandate',
        subjectId: id,
        before: { state: 'invited' },
        after: { state: 'revoked', reason: updated.endReason },
      });
      await this.event(tx, 'mandate.declined', updated, ctx.tenantId);
    });
    return this.get(ctx, id);
  }

  /** Either party ends an accepted / active mandate now. */
  async end(ctx: TenantContext, id: string, reason: string | null): Promise<MandateView> {
    await this.close(ctx, id, 'ended', reason);
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------------ internals

  /**
   * Revoke (owner: invited / accepted / active) or end (either party: accepted / active). One platform transaction
   * after the caller is checked against the row: the grant is the owner's and the listings are the agency's, so no
   * single tenant context may write both.
   */
  private async close(ctx: TenantContext, id: string, to: 'revoked' | 'ended', reason: string | null) {
    const by = userIdOf(RequestContext.actor());
    await this.db.platform(async (tx) => {
      const m = await tx.listingMandate.findUnique({ where: { id } });
      if (!m || (m.tenantId !== ctx.tenantId && m.ownerTenantId !== ctx.tenantId))
        throw new DomainException('http.not_found');
      if (to === 'revoked' && m.ownerTenantId !== ctx.tenantId)
        throw new DomainException('mandate.invalid_state');
      const allowed: MandateState[] = to === 'revoked' ? OPEN : HELD;
      if (!allowed.includes(m.state)) throw new DomainException('mandate.invalid_state');
      await this.finish(tx, m, to, reason?.trim() || null, by, ctx.tenantId);
    });
  }

  private async finish(
    tx: Tx,
    m: ListingMandate,
    to: 'revoked' | 'ended',
    reason: string | null,
    by: string | null,
    actorTenantId: string | null,
  ) {
    const now = this.clock.now();
    if (m.grantId)
      await tx.assetAccessGrant.updateMany({
        where: { id: m.grantId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedBy: by,
          revokeReason: `mandate ${to}${reason ? `: ${reason}` : ''}`.slice(0, 500),
        },
      });
    const updated = await tx.listingMandate.update({
      where: { id: m.id },
      data:
        to === 'revoked'
          ? { state: 'revoked', revokedAt: now, revokedBy: by, endReason: reason, version: { increment: 1 } }
          : { state: 'ended', endedAt: now, endReason: reason, version: { increment: 1 } },
    });
    const listings = await tx.listing.findMany({
      where: { mandateId: m.id, state: { in: [...LIVE_LISTING] } },
    });
    for (const l of listings) {
      await tx.listing.update({
        where: { id: l.id },
        data: { state: 'closed', closedAt: now, closedReason: 'withdrawn', version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'listing.closed',
        tenantId: l.tenantId,
        buildingId: l.buildingId,
        subjectType: 'ops.listing',
        subjectId: l.id,
        before: { state: l.state },
        after: { state: 'closed', reason: 'withdrawn', mandate: to },
      });
      await this.events.record(tx, {
        type: 'listing.closed',
        aggregateType: 'listing',
        aggregateId: l.id,
        tenantId: l.tenantId,
        buildingId: l.buildingId,
        payload: { listingId: l.id, unitId: l.unitId, reason: 'withdrawn' },
      });
    }
    await this.audit.record(tx, {
      action: to === 'revoked' ? 'mandate.revoked' : 'mandate.ended',
      tenantId: actorTenantId ?? m.ownerTenantId,
      buildingId: m.buildingId,
      subjectType: 'ops.listing_mandate',
      subjectId: m.id,
      before: { state: m.state },
      after: { state: to, reason, grantRevoked: Boolean(m.grantId), listingsClosed: listings.length },
    });
    await this.event(
      tx,
      to === 'revoked' ? 'mandate.revoked' : 'mandate.ended',
      updated,
      actorTenantId ?? m.ownerTenantId,
    );
  }

  /** Accepted / active mandates on a unit, all agencies (gp_platform: other agencies' rows are invisible). */
  private heldOn(unitId: string) {
    return this.db.platform((tx) =>
      tx.listingMandate.findMany({
        where: { unitId, state: { in: HELD } },
        select: { id: true, tenantId: true, exclusive: true },
      }),
    );
  }

  private assertExclusivity(exclusive: boolean, held: { exclusive: boolean }[]) {
    if (held.some((h) => h.exclusive) || (exclusive && held.length > 0))
      throw new DomainException('mandate.exclusive_conflict');
  }

  /** Serialises mandate changes of one unit (exclusivity is checked across tenants). */
  private async lockUnit(tx: Tx, unitId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mandate:${unitId}`}, 0))`;
  }

  /** `tenantId`: the tenant of the transaction (RLS on the event row); the owner's by default. */
  private event(
    tx: Tx,
    type: Parameters<DomainEvents['record']>[1]['type'],
    m: ListingMandate,
    tenantId: string = m.ownerTenantId,
  ) {
    return this.events.record(tx, {
      type,
      aggregateType: 'listing_mandate',
      aggregateId: m.id,
      tenantId,
      buildingId: m.buildingId,
      payload: {
        mandateId: m.id,
        agencyTenantId: m.tenantId,
        ownerTenantId: m.ownerTenantId,
        unitId: m.unitId,
        scope: m.scope,
        exclusive: m.exclusive,
        state: m.state,
      },
    });
  }

  /**
   * Maintenance (`mandates-maintenance`, hourly): accepted mandates whose first day came are activated; mandates whose
   * last day passed end (grant revoked, agency listings closed). Returns the counts.
   */
  async maintain(): Promise<{ activated: number; ended: number }> {
    const today = new Date(`${this.today()}T00:00:00Z`);
    const due = await this.db.platform((tx) =>
      tx.listingMandate.findMany({ where: { state: 'accepted', validFrom: { lte: today } } }),
    );
    for (const m of due)
      await this.db.platform(async (tx) => {
        const updated = await tx.listingMandate.update({
          where: { id: m.id },
          data: { state: 'active', activatedAt: this.clock.now(), version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          action: 'mandate.activated',
          tenantId: m.ownerTenantId,
          buildingId: m.buildingId,
          subjectType: 'ops.listing_mandate',
          subjectId: m.id,
          before: { state: 'accepted' },
          after: { state: 'active' },
        });
        await this.event(tx, 'mandate.activated', updated);
      });
    const over = await this.db.platform((tx) =>
      tx.listingMandate.findMany({ where: { state: { in: HELD }, validTo: { lt: today } } }),
    );
    for (const m of over)
      await this.db.platform((tx) => this.finish(tx, m, 'ended', 'validity ended', null, null));
    return { activated: due.length, ended: over.length };
  }

  /** The active mandate the agency holds for a unit (null = none). */
  activeFor(tx: Tx, agencyTenantId: string, unitId: string) {
    return tx.listingMandate.findFirst({ where: { tenantId: agencyTenantId, unitId, state: 'active' } });
  }
}

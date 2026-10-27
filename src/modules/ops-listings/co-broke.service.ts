import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type CoBrokeAgreement, type CoBrokeState, Prisma } from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

export interface CoBrokeProposeInput {
  listingId: string;
  coAgencyTenantId: string;
  splitPercent: string;
  validFrom?: string;
  validTo?: string | null;
  note?: string | null;
}

export type CoBrokeView = CoBrokeAgreement & {
  listingAgencyName: string;
  coAgencyName: string;
  listingSlug: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (path: string, message: string, code = 'invalid') =>
  new DomainException('validation.failed', { errors: [{ path, code, message }] });

/**
 * Co-broke agreements (G2, D-293): the tenant holding a listing (usually the mandated agency) shares it with another
 * agency at a split of its commission. The co-agency signs (in-app acceptance recorded with user and time; the e-signed
 * co-broke contract of G3 attaches later); either side cancels a proposal or ends a signed agreement. The split is
 * applied to the commission recorded on the deal (money moves outside the platform, ADR-0008). Both agencies see the
 * row (RLS pair); everyone else gets a 404.
 */
@Injectable()
export class CoBrokeService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async views(rows: CoBrokeAgreement[]): Promise<CoBrokeView[]> {
    if (!rows.length) return [];
    const ids = [...new Set(rows.flatMap((r) => [r.tenantId, r.coAgencyTenantId]))];
    const [tenants, listings] = await this.db.platform(async (tx) => [
      await tx.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
      await tx.listing.findMany({
        where: { id: { in: rows.map((r) => r.listingId) } },
        select: { id: true, slug: true },
      }),
    ]);
    const name = new Map(tenants.map((t) => [t.id, t.displayName]));
    const slug = new Map(listings.map((l) => [l.id, l.slug]));
    return rows.map((r) => ({
      ...r,
      listingAgencyName: name.get(r.tenantId) ?? '',
      coAgencyName: name.get(r.coAgencyTenantId) ?? '',
      listingSlug: slug.get(r.listingId) ?? '',
    }));
  }

  async list(ctx: TenantContext, filter: { state?: CoBrokeState; listingId?: string } = {}) {
    const rows = await this.db.tenant(ctx, (tx) =>
      tx.coBrokeAgreement.findMany({
        where: {
          OR: [{ tenantId: ctx.tenantId }, { coAgencyTenantId: ctx.tenantId }],
          state: filter.state,
          listingId: filter.listingId,
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return this.views(rows);
  }

  async get(ctx: TenantContext, id: string): Promise<CoBrokeView> {
    const row = await this.db.tenant(ctx, (tx) => this.found(tx, ctx, id));
    return (await this.views([row]))[0]!;
  }

  private async found(tx: Tx, ctx: TenantContext, id: string) {
    const row = await tx.coBrokeAgreement.findFirst({
      where: { id, OR: [{ tenantId: ctx.tenantId }, { coAgencyTenantId: ctx.tenantId }] },
    });
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  async propose(ctx: TenantContext, input: CoBrokeProposeInput): Promise<CoBrokeView> {
    const today = bangkokDate(this.clock.now());
    const validFrom = input.validFrom ?? today;
    if (!DAY.test(validFrom)) throw invalid('validFrom', 'validFrom is YYYY-MM-DD');
    if (validFrom < today) throw invalid('validFrom', 'never in the past', 'min');
    if (input.validTo && (!DAY.test(input.validTo) || input.validTo < validFrom))
      throw invalid('validTo', 'validTo is YYYY-MM-DD on or after validFrom');
    const split = new Decimal(input.splitPercent);
    if (split.lte(0) || split.gte(100))
      throw invalid('splitPercent', 'a share above 0 and below 100', 'range');
    if (input.coAgencyTenantId === ctx.tenantId) throw new DomainException('mandate.agency_required');
    const co = await this.db.platform((tx) =>
      tx.tenant.findFirst({
        where: { id: input.coAgencyTenantId, deletedAt: null, status: { not: 'deactivated' } },
        select: { type: true },
      }),
    );
    if (!co) throw new DomainException('http.not_found');
    if (co.type !== 'agency') throw new DomainException('mandate.agency_required');
    const id = await this.db.tenant(ctx, async (tx) => {
      const listing = await tx.listing.findFirst({ where: { id: input.listingId, tenantId: ctx.tenantId } });
      if (!listing) throw new DomainException('http.not_found');
      if (listing.state === 'closed') throw new DomainException('co_broke.invalid_state');
      const live = await tx.coBrokeAgreement.count({
        where: {
          listingId: listing.id,
          coAgencyTenantId: input.coAgencyTenantId,
          state: { in: ['proposed', 'signed'] },
        },
      });
      if (live) throw new DomainException('co_broke.invalid_state');
      const row = await tx.coBrokeAgreement.create({
        data: {
          tenantId: ctx.tenantId,
          coAgencyTenantId: input.coAgencyTenantId,
          listingId: listing.id,
          unitId: listing.unitId,
          mandateId: listing.mandateId,
          splitPercent: split.toFixed(4),
          validFrom: new Date(`${validFrom}T00:00:00Z`),
          validTo: input.validTo ? new Date(`${input.validTo}T00:00:00Z`) : null,
          note: input.note?.trim() || null,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.audit.record(tx, {
        action: 'co_broke.proposed',
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.co_broke_agreement',
        subjectId: row.id,
        after: {
          listingId: listing.id,
          coAgencyTenantId: row.coAgencyTenantId,
          splitPercent: split.toFixed(4),
        },
      });
      await this.event(tx, 'co_broke.proposed', row, listing.buildingId);
      return row.id;
    });
    return this.get(ctx, id);
  }

  /** The co-agency signs; the listing agency cancels or either cancels a proposal; either ends a signed one. */
  async act(ctx: TenantContext, id: string, action: 'sign' | 'cancel' | 'end'): Promise<CoBrokeView> {
    await this.db.tenant(ctx, async (tx) => {
      const row = await this.found(tx, ctx, id);
      const now = this.clock.now();
      const by = userIdOf(RequestContext.actor());
      let data: Prisma.CoBrokeAgreementUpdateInput;
      if (action === 'sign') {
        if (row.state !== 'proposed' || row.coAgencyTenantId !== ctx.tenantId)
          throw new DomainException('co_broke.invalid_state');
        data = { state: 'signed', signedAt: now, signedBy: by };
      } else if (action === 'cancel') {
        if (row.state !== 'proposed') throw new DomainException('co_broke.invalid_state');
        data = { state: 'cancelled', cancelledAt: now };
      } else {
        if (row.state !== 'signed') throw new DomainException('co_broke.invalid_state');
        data = { state: 'ended', endedAt: now };
      }
      const updated = await tx.coBrokeAgreement.update({
        where: { id },
        data: { ...data, updatedBy: by, version: { increment: 1 } },
      });
      const listing = await this.db.platform((p) =>
        p.listing.findUniqueOrThrow({ where: { id: row.listingId }, select: { buildingId: true } }),
      );
      const type =
        action === 'sign' ? 'co_broke.signed' : action === 'cancel' ? 'co_broke.cancelled' : 'co_broke.ended';
      await this.audit.record(tx, {
        action: type,
        tenantId: ctx.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.co_broke_agreement',
        subjectId: id,
        before: { state: row.state },
        after: { state: updated.state },
      });
      await this.event(tx, type, updated, listing.buildingId, ctx.tenantId);
    });
    return this.get(ctx, id);
  }

  private event(
    tx: Tx,
    type: 'co_broke.proposed' | 'co_broke.signed' | 'co_broke.cancelled' | 'co_broke.ended',
    row: CoBrokeAgreement,
    buildingId: string,
    tenantId: string = row.tenantId,
  ) {
    return this.events.record(tx, {
      type,
      aggregateType: 'co_broke_agreement',
      aggregateId: row.id,
      tenantId,
      buildingId,
      payload: {
        agreementId: row.id,
        listingId: row.listingId,
        coAgencyTenantId: row.coAgencyTenantId,
        splitPercent: row.splitPercent.toFixed(4),
        state: row.state,
      },
    });
  }
}

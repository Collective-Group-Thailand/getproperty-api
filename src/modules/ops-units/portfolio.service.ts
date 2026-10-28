import { createHash } from 'node:crypto';

import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { uuidv7 } from '@common/ids/uuidv7';
import { bangkokDate, startOfBangkokMonth } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import {
  type Furnishing,
  type OwnershipSource,
  type PortfolioUnitKind,
  Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

export interface PortfolioAddress {
  line1: string;
  subdistrict?: string;
  district?: string;
  province: string;
  postcode: string;
}

export interface PortfolioUnitInput {
  kind: PortfolioUnitKind;
  /** Condo project (required for a condo unit) or the name the owner gives a house. */
  projectName?: string;
  /** Number on the door; a house defaults to its project name or "1". */
  unitNo?: string;
  address: PortfolioAddress;
  lat?: number;
  lng?: number;
  areaSqm?: string;
  bedrooms?: number;
  bathrooms?: number;
  floorLabel?: string;
  furnishing?: Furnishing;
  /** Default monthly rent, decimal string. */
  defaultRent?: string;
  /** G8 (D-299): how the ownership is known — a getbuild transfer instead of the owner's own declaration. */
  ownership?: { source: OwnershipSource; sourceRef?: string };
}

export type PortfolioUnitState = 'vacant' | 'leased' | 'notice_given';

const OPEN_LEASES = ['active', 'notice_given', 'ending'] as const;
const CLOSED_REQUESTS = ['done', 'closed', 'cancelled'] as const;

/** Project names compare without case, spaces, punctuation or the words "condo" / "คอนโด". */
export function stubKey(projectName: string, postcode: string): string {
  const name = projectName
    .normalize('NFC')
    .toLowerCase()
    .replace(/คอนโดมิเนียม|คอนโด|condominium|condo|the\s+/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return `stub:${createHash('sha256').update(`${name}|${postcode.trim()}`).digest('hex').slice(0, 32)}`;
}

/**
 * The landlord's portfolio (B7.1, D-251): units are added in a short wizard — a house, townhouse or room becomes a
 * one-unit property + building owned and operated by the landlord; a condo unit goes into a **stub** building of its
 * project (status `external`, no owner or operator), found or created by normalised project name + postcode, so two
 * landlords in the same condo share one stub and each sees only its own units (asset-core 0.5.0 RLS). The landlord's
 * legal party is recorded as the owner (`self_declared`; verification is D-252). The portfolio home lists every unit
 * with its occupancy state, lease end, this month's invoice and open repairs, and the month's totals.
 */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private address(a: PortfolioAddress): Prisma.InputJsonValue {
    return {
      line1: a.line1,
      subdistrict: a.subdistrict ?? null,
      district: a.district ?? null,
      province: a.province,
      postcode: a.postcode,
    };
  }

  /** The stub building of a condo project (platform lookup: another landlord's stub is invisible until joined). */
  private async stub(
    ctx: TenantContext,
    input: PortfolioUnitInput,
  ): Promise<{ id: string; propertyId: string }> {
    const key = stubKey(input.projectName!, input.address.postcode);
    return this.db.platform(async (tx) => {
      const found = await tx.building.findFirst({
        where: { sourceRef: key, deletedAt: null },
        select: { id: true, propertyId: true },
      });
      if (found) return found;
      const now = this.clock.now();
      const propertyId = uuidv7(now.getTime());
      const buildingId = uuidv7(now.getTime());
      const code = `S-${key.slice(5, 13).toUpperCase()}`;
      await tx.property.create({
        data: {
          id: propertyId,
          tenantId: ctx.tenantId,
          code,
          name: input.projectName!.trim(),
          address: this.address(input.address),
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          sourceRef: key,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await tx.building.create({
        data: {
          id: buildingId,
          tenantId: ctx.tenantId,
          propertyId,
          code,
          name: input.projectName!.trim(),
          type: 'condo',
          address: this.address(input.address),
          ownerTenantId: null,
          operatorTenantId: null,
          status: 'external',
          sourceRef: key,
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      return { id: buildingId, propertyId };
    });
  }

  async addUnit(ctx: TenantContext, input: PortfolioUnitInput) {
    const condo = input.kind === 'condo_unit';
    if (condo && !input.projectName?.trim())
      throw new DomainException('validation.failed', {
        errors: [{ path: 'projectName', code: 'required', message: 'the condo project name is required' }],
      });
    if (condo && !input.unitNo?.trim())
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'unitNo', code: 'required', message: 'the unit number is required for a condo unit' },
        ],
      });
    const place = condo ? await this.stub(ctx, input) : null;
    return this.db.tenant(ctx, async (tx) => {
      const now = this.clock.now();
      const by = userIdOf(RequestContext.actor());
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
      if (tenant.type !== 'landlord') throw new DomainException('auth.forbidden');
      let buildingId: string;
      let propertyId: string;
      if (place) {
        buildingId = place.id;
        propertyId = place.propertyId;
      } else {
        propertyId = uuidv7(now.getTime());
        buildingId = uuidv7(now.getTime());
        const code = `H-${buildingId.replace(/-/g, '').slice(-6).toUpperCase()}`;
        const name = (input.projectName?.trim() || input.address.line1).slice(0, 200);
        await tx.property.create({
          data: {
            id: propertyId,
            tenantId: ctx.tenantId,
            code,
            name,
            address: this.address(input.address),
            lat: input.lat ?? null,
            lng: input.lng ?? null,
            createdBy: by,
          },
        });
        await tx.building.create({
          data: {
            id: buildingId,
            tenantId: ctx.tenantId,
            propertyId,
            code,
            name,
            type: 'house',
            address: this.address(input.address),
            ownerTenantId: ctx.tenantId,
            operatorTenantId: ctx.tenantId,
            createdBy: by,
          },
        });
      }
      const unitNo = (input.unitNo?.trim() || (input.kind === 'room' ? 'R1' : '1')).slice(0, 40);
      const taken = await this.db.platform((p) =>
        p.unit.findFirst({ where: { buildingId, unitNo, deletedAt: null }, select: { tenantId: true } }),
      );
      if (taken)
        throw new DomainException(
          taken.tenantId === ctx.tenantId ? 'http.conflict' : 'portfolio.unit_claimed',
        );
      const unit = await tx.unit.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId,
          propertyId,
          unitNo,
          type: condo ? 'condo_unit' : input.kind === 'room' ? 'room' : 'house',
          areaSqm: input.areaSqm ?? null,
          baseRent: input.defaultRent ?? null,
          createdBy: by,
        },
      });
      await tx.unitDetail.create({
        data: {
          unitId: unit.id,
          tenantId: ctx.tenantId,
          buildingId,
          kind: input.kind,
          bedrooms: input.bedrooms ?? null,
          bathrooms: input.bathrooms ?? null,
          floorLabel: input.floorLabel ?? null,
          furnishing: input.furnishing ?? null,
          createdBy: by,
        },
      });
      if (tenant.legalPartyId)
        await tx.unitOwnership.create({
          data: {
            tenantId: ctx.tenantId,
            buildingId,
            unitId: unit.id,
            partyId: tenant.legalPartyId,
            sharePct: 100,
            validFrom: new Date(bangkokDate(now)),
            source: input.ownership?.source ?? 'self_declared',
            sourceRef: input.ownership?.sourceRef ?? null,
            createdBy: by,
          },
        });
      await this.audit.record(tx, {
        action: 'unit.portfolio_added',
        tenantId: ctx.tenantId,
        subjectType: 'core.unit',
        subjectId: unit.id,
        after: { kind: input.kind, unitNo, buildingId, stub: Boolean(place) },
      });
      await this.events.record(tx, {
        type: 'unit.changed',
        aggregateType: 'unit',
        aggregateId: unit.id,
        tenantId: ctx.tenantId,
        buildingId,
        payload: { unitId: unit.id, change: 'created', unitNo, kind: input.kind, source: 'portfolio' },
      });
      return { unitId: unit.id, buildingId, propertyId, stub: Boolean(place) };
    });
  }

  /**
   * `POST /v1/admin/buildings/{id}/actions/claim-stub` (D-280): the juristic person of a condo joins getproperty and
   * takes over the stub building its landlords created. The building moves to the juristic tenant (owner) and its
   * operator (itself or a PM company); the landlords keep their units, leases and invoices — nothing is copied.
   */
  async claim(buildingId: string, input: { ownerTenantId: string; operatorTenantId?: string }) {
    return this.db.platform(async (tx) => {
      const before = await tx.building.findFirst({ where: { id: buildingId, deletedAt: null } });
      const operatorTenantId = input.operatorTenantId ?? input.ownerTenantId;
      const claimed = await claimStub(tx, {
        buildingId,
        ownerTenantId: input.ownerTenantId,
        operatorTenantId,
        by: userIdOf(RequestContext.actor()),
        at: this.clock.now(),
      });
      await this.audit.record(tx, {
        action: 'building.operator_changed',
        tenantId: operatorTenantId,
        buildingId,
        subjectType: 'core.building',
        subjectId: buildingId,
        before: { status: 'external', dataOwnerTenantId: before?.tenantId ?? null },
        after: {
          ownerTenantId: input.ownerTenantId,
          operatorTenantId,
          reason: 'juristic_formed',
          claim: true,
        },
      });
      await this.events.record(tx, {
        type: 'building.operator_changed',
        aggregateType: 'building',
        aggregateId: buildingId,
        tenantId: operatorTenantId,
        buildingId,
        payload: {
          buildingId,
          previousOperatorTenantId: null,
          operatorTenantId,
          ownerTenantId: input.ownerTenantId,
          reason: 'juristic_formed',
        },
      });
      return claimed;
    });
  }

  /** `GET /v1/owner/portfolio`: every unit of the landlord with its state, lease end, invoice and repairs. */
  async portfolio(ctx: TenantContext) {
    return this.db.tenant(ctx, async (tx) => {
      const now = this.clock.now();
      const monthStart = new Date(bangkokDate(startOfBangkokMonth(now)));
      const units = await tx.unit.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null },
        include: { building: { select: { id: true, name: true, type: true, status: true, address: true } } },
        orderBy: [{ createdAt: 'asc' }],
      });
      const ids = units.map((u) => u.id);
      const [details, leases, invoices, requests, overdue, listings, ended] = await Promise.all([
        tx.unitDetail.findMany({ where: { unitId: { in: ids } } }),
        tx.lease.findMany({
          where: { tenantId: ctx.tenantId, unitId: { in: ids }, status: { in: [...OPEN_LEASES] } },
          select: { id: true, unitId: true, status: true, endDate: true, noticeEffectiveDate: true },
          orderBy: { startDate: 'desc' },
        }),
        tx.invoice.findMany({
          where: {
            tenantId: ctx.tenantId,
            unitId: { in: ids },
            periodStart: { gte: monthStart },
            status: { notIn: ['draft', 'void'] },
          },
          select: { id: true, unitId: true, status: true, total: true, paidTotal: true, balance: true },
        }),
        tx.serviceRequest.groupBy({
          by: ['unitId'],
          where: { tenantId: ctx.tenantId, unitId: { in: ids }, status: { notIn: [...CLOSED_REQUESTS] } },
          _count: { _all: true },
        }),
        tx.invoice.aggregate({
          where: { tenantId: ctx.tenantId, status: 'overdue' },
          _sum: { balance: true },
        }),
        // D-261: the latest listing of each unit and its open enquiries (the vacancy view)
        tx.listing.findMany({
          where: { tenantId: ctx.tenantId, unitId: { in: ids } },
          select: {
            id: true,
            unitId: true,
            state: true,
            slug: true,
            availableFrom: true,
            _count: { select: { leads: { where: { state: { notIn: ['won', 'lost'] } } } } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        tx.lease.findMany({
          where: { tenantId: ctx.tenantId, unitId: { in: ids }, status: { in: ['ended', 'terminated'] } },
          select: { unitId: true, endDate: true, noticeEffectiveDate: true },
          orderBy: { endDate: 'desc' },
        }),
      ]);
      const listing = new Map<string, (typeof listings)[number]>();
      for (const row of listings) if (!listing.has(row.unitId)) listing.set(row.unitId, row);
      const lastEnd = new Map<string, Date>();
      for (const row of ended) {
        const end = row.noticeEffectiveDate ?? row.endDate;
        const before = lastEnd.get(row.unitId);
        if (!before || end > before) lastEnd.set(row.unitId, end);
      }
      const detail = new Map(details.map((d) => [d.unitId, d]));
      const lease = new Map<string, (typeof leases)[number]>();
      for (const l of leases) if (!lease.has(l.unitId)) lease.set(l.unitId, l);
      const invoice = new Map(invoices.map((i) => [i.unitId!, i]));
      const repairs = new Map(requests.map((r) => [r.unitId!, r._count._all]));
      const sum = (pick: (i: (typeof invoices)[number]) => Prisma.Decimal) =>
        invoices.reduce((total, i) => total.plus(pick(i).toString()), new Decimal(0)).toFixed(2);
      return {
        units: units.map((u) => {
          const l = lease.get(u.id);
          const d = detail.get(u.id);
          const i = invoice.get(u.id);
          const state: PortfolioUnitState = !l
            ? 'vacant'
            : l.status === 'notice_given'
              ? 'notice_given'
              : 'leased';
          return {
            unitId: u.id,
            unitNo: u.unitNo,
            kind: d?.kind ?? null,
            building: {
              id: u.building.id,
              name: u.building.name,
              external: u.building.status === 'external',
            },
            address: u.building.address as Record<string, unknown> | null,
            areaSqm: u.areaSqm?.toFixed(2) ?? null,
            bedrooms: d?.bedrooms ?? null,
            bathrooms: d?.bathrooms ?? null,
            floorLabel: d?.floorLabel ?? null,
            furnishing: d?.furnishing ?? null,
            defaultRent: u.baseRent?.toFixed(2) ?? null,
            state,
            leaseId: l?.id ?? null,
            leaseEndDate: l ? bangkokDate(l.noticeEffectiveDate ?? l.endDate) : null,
            invoice: i
              ? { id: i.id, status: i.status, total: i.total.toFixed(2), balance: i.balance.toFixed(2) }
              : null,
            openServiceRequests: repairs.get(u.id) ?? 0,
            vacantSince: !l && lastEnd.has(u.id) ? bangkokDate(lastEnd.get(u.id)!) : null,
            listing: (() => {
              const row = listing.get(u.id);
              return row
                ? {
                    id: row.id,
                    state: row.state,
                    slug: row.slug,
                    availableFrom: row.availableFrom ? row.availableFrom.toISOString().slice(0, 10) : null,
                    openLeads: row._count.leads,
                  }
                : null;
            })(),
          };
        }),
        totals: {
          month: bangkokDate(now).slice(0, 7),
          expected: sum((i) => i.total),
          collected: sum((i) => i.paidTotal),
          overdue: new Decimal((overdue._sum.balance ?? 0).toString()).toFixed(2),
        },
      };
    });
  }
}

/**
 * A condo's juristic person (or its PM company) joins getproperty and **claims** the stub its landlords created
 * (D-251, D-280): the stub becomes the juristic's building — owner and operator set, status active, data-owner moved —
 * so nothing is duplicated; the landlords' unit rows stay theirs (their leases and invoices are untouched) and the
 * juristic sees them as the operator. Platform admin action, audited.
 */
export async function claimStub(
  tx: Tx,
  input: { buildingId: string; ownerTenantId: string; operatorTenantId: string; by: string | null; at: Date },
) {
  const building = await tx.building.findFirst({ where: { id: input.buildingId, deletedAt: null } });
  if (!building) throw new DomainException('http.not_found');
  if (building.status !== 'external') throw new DomainException('portfolio.not_a_stub');
  const tenants = await tx.tenant.findMany({
    where: { id: { in: [input.ownerTenantId, input.operatorTenantId] }, deletedAt: null },
    select: { id: true, type: true },
  });
  const type = (id: string) => tenants.find((t) => t.id === id)?.type;
  if (type(input.ownerTenantId) !== 'condo_juristic') throw new DomainException('portfolio.claimant_invalid');
  const operator = type(input.operatorTenantId);
  if (operator !== 'condo_juristic' && operator !== 'pm_company')
    throw new DomainException('portfolio.claimant_invalid');
  await tx.property.update({
    where: { id: building.propertyId },
    data: { tenantId: input.operatorTenantId, updatedBy: input.by },
  });
  const claimed = await tx.building.update({
    where: { id: building.id },
    data: {
      tenantId: input.operatorTenantId,
      ownerTenantId: input.ownerTenantId,
      operatorTenantId: input.operatorTenantId,
      status: 'active',
      updatedBy: input.by,
      version: { increment: 1 },
    },
  });
  await tx.buildingOperatorPeriod.create({
    data: {
      tenantId: input.operatorTenantId,
      buildingId: building.id,
      ownerTenantId: input.ownerTenantId,
      operatorTenantId: input.operatorTenantId,
      validFrom: input.at,
      reason: 'juristic_formed',
      createdBy: input.by,
    },
  });
  return claimed;
}

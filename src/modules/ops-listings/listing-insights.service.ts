import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { Prisma } from '@generated/prisma/client';
import { type RateTiers } from '@modules/ops-billing/engine/rate-tiers';
import { Inject, Injectable } from '@nestjs/common';

import { districtKey, districtName, provinceEn, stationDisplay, stationKey, stationName } from './area-names';

export interface UtilityRate {
  kind: 'flat' | 'tiered';
  pricePerUnit: string | null;
  tiers: { fromUnits: string; toUnits: string | null; pricePerUnit: string }[];
  minimumCharge: string | null;
}

export interface UtilityBlock {
  electricity: UtilityRate | null;
  water: UtilityRate | null;
  fixedCharges: { kind: 'common_fee' | 'service' | 'fund'; name: string; amount: string }[];
  averageBill3m: string | null;
  basedOnBills: number;
}

export interface RentBand {
  p25: string;
  p50: string;
  p75: string;
}

export interface Comparables {
  band: RentBand | null;
  medianDaysToLet: number | null;
  sampleSize: number;
  minimum: number;
}

export interface Area {
  slug: string;
  name: string;
  nameEn: string;
  kind: 'district' | 'station';
  province: string | null;
  provinceEn: string | null;
  /** A station's line (as owners name it, else its system: BTS, MRT, ARL). */
  line: string | null;
  count: number;
  band: RentBand | null;
  indexable: boolean;
}

const UTILITY_LINES = ['electricity', 'water', 'water_minimum'] as const;
const CONFIRMED = ['issued', 'partially_paid', 'paid', 'overdue'] as const;

const money = (value: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(value).toDecimalPlaces(2).toFixed(2);

/** percentile_cont at 25 / 50 / 75 % (linear interpolation, as PostgreSQL). */
export function rentBand(values: Prisma.Decimal[]): RentBand | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a.comparedTo(b));
  const at = (p: number) => {
    const pos = p * (v.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, v.length - 1);
    return v[lo]!.plus(v[hi]!.minus(v[lo]!).times(pos - lo));
  };
  return { p25: money(at(0.25)), p50: money(at(0.5)), p75: money(at(0.75)) };
}

/**
 * Listings that tell the truth (B7.9 part 1): the unit's real utility cost (D-265) — the power and water rates it is
 * billed at and the average of its last confirmed utility bills — the rent band and time-to-let of comparable
 * listings for the owner (D-269), and the areas and stations with published listings (D-272). Cross-tenant reads are
 * aggregates only (as gp_platform); nothing names another owner or unit.
 */
@Injectable()
export class ListingInsightsService {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async setting(key: string, fallback: number): Promise<number> {
    const value = await this.settings.valueAt<number>(key, this.clock.now(), {});
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  private rate(tiers: RateTiers, minimumCharge: Prisma.Decimal | null): UtilityRate | null {
    if (tiers.kind === 'flat')
      return {
        kind: 'flat',
        pricePerUnit: tiers.pricePerUnit,
        tiers: [],
        minimumCharge: minimumCharge ? money(minimumCharge) : null,
      };
    if (tiers.kind === 'tiered')
      return {
        kind: 'tiered',
        pricePerUnit: null,
        tiers: tiers.tiers.map((t) => ({
          fromUnits: t.fromUnits,
          toUnits: t.toUnits,
          pricePerUnit: t.pricePerUnit,
        })),
        minimumCharge: minimumCharge ? money(minimumCharge) : null,
      };
    return null;
  }

  /**
   * D-265: the rates the unit is billed at today (the building's default power / water plans, else the tenant's), its
   * fixed monthly charges, and — with the owner's switch on and at least `listing.utility_history.min_bills`
   * confirmed bills — the average utility amount of its last three. Null when there is nothing to show.
   */
  async utility(
    tx: Tx,
    listing: { tenantId: string; unitId: string; buildingId: string; showUtilityHistory: boolean },
  ): Promise<UtilityBlock | null> {
    const today = new Date(`${bangkokDate(this.clock.now())}T00:00:00Z`);
    const plans = await tx.ratePlan.findMany({
      where: {
        tenantId: listing.tenantId,
        deletedAt: null,
        isDefault: true,
        kind: { in: ['power', 'water', 'common_fee', 'service', 'fund'] },
        OR: [{ buildingId: listing.buildingId }, { buildingId: null }],
      },
      include: {
        versions: {
          where: {
            effectiveFrom: { lte: today },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: today } }],
          },
          orderBy: { effectiveFrom: 'desc' },
          take: 1,
        },
      },
    });
    const pick = (kind: string) =>
      plans.find((p) => p.kind === kind && p.buildingId === listing.buildingId && p.versions.length) ??
      plans.find((p) => p.kind === kind && !p.buildingId && p.versions.length);
    const rateOf = (kind: 'power' | 'water') => {
      const version = pick(kind)?.versions[0];
      return version ? this.rate(version.tiers as unknown as RateTiers, version.minimumCharge) : null;
    };
    const unit = await tx.unit.findUnique({ where: { id: listing.unitId }, select: { type: true } });
    const fixedCharges: UtilityBlock['fixedCharges'] = [];
    for (const kind of ['common_fee', 'service', 'fund'] as const) {
      const plan = pick(kind);
      const version = plan?.versions[0];
      const tiers = version?.tiers as unknown as RateTiers | undefined;
      if (!plan || !version || tiers?.kind !== 'fixed' || version.basis !== 'fixed') continue;
      const amount = (unit?.type && tiers.byUnitType?.[unit.type]) || tiers.amount;
      if (amount) fixedCharges.push({ kind, name: plan.name, amount: money(amount) });
    }

    const minBills = await this.setting('listing.utility_history.min_bills', 3);
    const bills = await tx.$queryRaw<{ total: Prisma.Decimal }[]>`
      SELECT sum(li.amount) AS total
        FROM ops.invoice i JOIN ops.invoice_line li ON li.invoice_id = i.id
       WHERE i.unit_id = ${listing.unitId}::uuid AND i.tenant_id = ${listing.tenantId}::uuid
         AND i.status::text = ANY (${[...CONFIRMED]}::text[])
         AND li.line_kind::text = ANY (${[...UTILITY_LINES]}::text[])
       GROUP BY i.id, i.period_end
       ORDER BY i.period_end DESC
       LIMIT ${Math.max(3, minBills)}`;
    const lastThree = bills.slice(0, 3);
    const enough = listing.showUtilityHistory && bills.length > 0 && bills.length >= minBills;
    const average = enough
      ? lastThree.reduce((sum, b) => sum.plus(b.total), new Prisma.Decimal(0)).div(lastThree.length)
      : null;
    const block: UtilityBlock = {
      electricity: rateOf('power'),
      water: rateOf('water'),
      fixedCharges,
      averageBill3m: average ? money(average) : null,
      basedOnBills: enough ? lastThree.length : 0,
    };
    return block.electricity || block.water || block.fixedCharges.length || block.averageBill3m
      ? block
      : null;
  }

  private band(rents: Prisma.Decimal[] | null): RentBand | null {
    return rents && rents.length === 3 && rents.every((r) => r !== null)
      ? { p25: money(rents[0]!), p50: money(rents[1]!), p75: money(rents[2]!) }
      : null;
  }

  /**
   * D-269: comparable listings of a listing — same kind and bedrooms, size within ±20 %, same district or within
   * 1 km of the same transit station, published now or let in the last 12 months — their rent band (25th / 50th /
   * 75th percentile) and median days from publishing to let. Nothing below `listing.comparables.min`.
   */
  async comparables(ctx: TenantContext, listingId: string): Promise<Comparables> {
    const listing = await this.db.tenant(ctx, (tx) =>
      tx.listing.findFirst({ where: { id: listingId, tenantId: ctx.tenantId } }),
    );
    if (!listing) throw new DomainException('http.not_found');
    const minimum = await this.setting('listing.comparables.min', 8);
    const since = new Date(this.clock.now().getTime() - 365 * 86_400_000);
    const nearStation = listing.transitName && (listing.transitDistanceM ?? Infinity) <= 1000;
    const place = [
      listing.province && listing.district
        ? Prisma.sql`(l.province = ${listing.province} AND l.district = ${listing.district})`
        : null,
      nearStation
        ? Prisma.sql`(l.transit_name = ${listing.transitName} AND l.transit_distance_m <= 1000)`
        : null,
    ].filter((p): p is Prisma.Sql => p !== null);
    if (!place.length) return { band: null, medianDaysToLet: null, sampleSize: 0, minimum };
    const size = listing.sizeSqm ? new Prisma.Decimal(listing.sizeSqm) : null;
    const rows = await this.db.platform(
      (tx) => tx.$queryRaw<{ n: number; rents: Prisma.Decimal[] | null; days: number | null }[]>`
        SELECT count(*)::int AS n,
               percentile_cont(ARRAY[0.25, 0.5, 0.75]) WITHIN GROUP (ORDER BY l.rent)::numeric[] AS rents,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM l.closed_at - l.published_at) / 86400)
                 FILTER (WHERE l.state = 'closed')::float8 AS days
          FROM ops.listing l JOIN core.tenant t ON t.id = l.tenant_id
         WHERE l.id <> ${listing.id}::uuid AND t.status = 'active' AND t.deleted_at IS NULL
           AND l.unit_kind IS NOT DISTINCT FROM ${listing.unitKind}::ops.portfolio_unit_kind
           AND l.bedrooms IS NOT DISTINCT FROM ${listing.bedrooms}::smallint
           AND (${size === null} OR l.size_sqm BETWEEN ${size?.times(0.8) ?? 0}::numeric AND ${size?.times(1.2) ?? 0}::numeric)
           AND (${Prisma.join(place, ' OR ')})
           AND ((l.state = 'published' AND l.hidden_at IS NULL)
                OR (l.state = 'closed' AND l.closed_reason = 'leased' AND l.closed_at >= ${since}
                    AND l.published_at IS NOT NULL))`,
    );
    const row = rows[0];
    const n = row?.n ?? 0;
    if (n < minimum) return { band: null, medianDaysToLet: null, sampleSize: n, minimum };
    return {
      band: this.band(row!.rents),
      medianDaysToLet: row!.days === null ? null : Math.round(row!.days),
      sampleSize: n,
      minimum,
    };
  }

  /**
   * D-272: every district and transit station (within 1 km) with published listings, its count, the rent band from
   * `listing.comparables.min` listings, and whether its page may be indexed (`listing.area.index_min`). Districts and
   * stations are matched by name (`เขตพญาไท` = `พญาไท`, `BTS อารีย์` = `อารีย์`) and carry an English name and an
   * ASCII slug from the reference names (`area-names.ts`).
   */
  async areas(): Promise<Area[]> {
    return (await this.grouped()).map(({ rents: _rents, transitNames: _names, ...area }) => area);
  }

  private async grouped(): Promise<(Area & { rents: Prisma.Decimal[]; transitNames: string[] })[]> {
    const [minimum, indexMin] = await Promise.all([
      this.setting('listing.comparables.min', 8),
      this.setting('listing.area.index_min', 3),
    ]);
    const rows = await this.db.platform(
      (tx) => tx.$queryRaw<
        {
          province: string | null;
          district: string | null;
          transit_name: string | null;
          transit_line: string | null;
          near: boolean;
          rent: Prisma.Decimal;
        }[]
      >`
        SELECT l.province, l.district, l.transit_name, l.transit_line,
               coalesce(l.transit_distance_m <= 1000, false) AS near, l.rent
          FROM ops.listing l JOIN core.tenant t ON t.id = l.tenant_id
         WHERE l.state = 'published' AND l.hidden_at IS NULL AND t.status = 'active' AND t.deleted_at IS NULL`,
    );
    type Group = Area & {
      rents: Prisma.Decimal[];
      transitNames: string[];
      lines: Map<string, number>;
      provinces: Map<string, number>;
    };
    const groups = new Map<string, Group>();
    const bump = (m: Map<string, number>, k: string | null) => k && m.set(k, (m.get(k) ?? 0) + 1);
    const top = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const add = (key: string, init: () => Group, rent: Prisma.Decimal, extra: (g: Group) => void) => {
      const g = groups.get(key) ?? init();
      groups.set(key, g);
      g.rents.push(rent);
      extra(g);
    };
    for (const r of rows) {
      if (r.district) {
        const district = districtKey(r.district);
        const place = districtName(district, r.province);
        add(
          `d:${place.slug}`,
          () => ({
            slug: place.slug,
            name: district,
            nameEn: place.en,
            kind: 'district',
            province: r.province,
            provinceEn: provinceEn(r.province),
            line: null,
            count: 0,
            band: null,
            indexable: false,
            rents: [],
            transitNames: [],
            lines: new Map(),
            provinces: new Map(),
          }),
          r.rent,
          () => undefined,
        );
      }
      if (r.transit_name && r.near) {
        const key = stationKey(r.transit_name);
        if (!key) continue;
        const place = stationName(r.transit_name);
        add(
          `s:${place.slug}`,
          () => ({
            slug: place.slug,
            name: stationDisplay(key),
            nameEn: place.en,
            kind: 'station',
            province: null,
            provinceEn: null,
            line: place.system,
            count: 0,
            band: null,
            indexable: false,
            rents: [],
            transitNames: [],
            lines: new Map(),
            provinces: new Map(),
          }),
          r.rent,
          (g) => {
            if (!g.transitNames.includes(r.transit_name!)) g.transitNames.push(r.transit_name!);
            bump(g.lines, r.transit_line);
            bump(g.provinces, r.province);
          },
        );
      }
    }
    const areas = [...groups.values()].map(({ lines, provinces, ...g }) => {
      const count = g.rents.length;
      const province = g.kind === 'station' ? top(provinces) : g.province;
      return {
        ...g,
        province,
        provinceEn: provinceEn(province),
        line: g.kind === 'station' ? (top(lines) ?? g.line) : null,
        count,
        band: count >= minimum ? rentBand(g.rents) : null,
        indexable: count >= indexMin,
      };
    });
    return areas.sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  }

  /** The search filter of an area slug (`?area=`), or null when no published listing is there any more. */
  async areaFilter(
    slug: string,
  ): Promise<{ province?: string | null; districts?: string[]; stations?: string[] } | null> {
    const area = (await this.grouped()).find((a) => a.slug === slug);
    if (!area) return null;
    if (area.kind === 'station') return { stations: area.transitNames };
    return { province: area.province, districts: [area.name, `เขต${area.name}`, `อำเภอ${area.name}`] };
  }

  /**
   * D-274: median minutes from a prospect's first message on an enquiry to the owner's first answer, over the last
   * 12 months; null with fewer than 3 answered enquiries.
   */
  async medianReplyMinutes(tenantId: string): Promise<number | null> {
    const since = new Date(this.clock.now().getTime() - 365 * 86_400_000);
    const rows = await this.db.platform(
      (tx) => tx.$queryRaw<{ n: number; minutes: number | null }[]>`
        WITH asked AS (
          SELECT lead_id, min(created_at) AS at FROM ops.listing_lead_message
           WHERE tenant_id = ${tenantId}::uuid AND author = 'prospect' AND created_at >= ${since}
           GROUP BY lead_id
        ), answered AS (
          SELECT a.at AS asked_at,
                 (SELECT min(r.created_at) FROM ops.listing_lead_message r
                   WHERE r.lead_id = a.lead_id AND r.author = 'owner' AND r.created_at >= a.at) AS answered_at
            FROM asked a
        )
        SELECT count(answered_at)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - asked_at) / 60)
                 FILTER (WHERE answered_at IS NOT NULL)::float8 AS minutes
          FROM answered`,
    );
    const row = rows[0];
    return row && row.n >= 3 && row.minutes !== null ? Math.max(1, Math.round(row.minutes)) : null;
  }
}

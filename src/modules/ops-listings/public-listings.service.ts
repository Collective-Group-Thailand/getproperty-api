import { OBJECT_STORAGE, type ObjectStorage } from '@collective/integrations/storage';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate, toBangkokIso } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { CLOCK, type Clock } from '@core/clock/clock';
import { renditionKey } from '@core/documents/document-policy';
import { IdentityVerificationService } from '@core/identity/identity-verification.service';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { type Furnishing, type PortfolioUnitKind, Prisma } from '@generated/prisma/client';
import { sponsoredSlots } from '@modules/platform-subscriptions/growth-products';
import { Inject, Injectable } from '@nestjs/common';

import { ListingInsightsService } from './listing-insights.service';
import { listingJsonLd } from './listing-json-ld';

export interface PublicListingQuery {
  q?: string;
  kind?: PortfolioUnitKind;
  province?: string;
  district?: string;
  /** An area or station slug (`GET /v1/public/listings/areas`, D-272). */
  area?: string;
  /** Internal: the listings of one owner organisation (the public owner page, D-274). */
  ownerTenantId?: string;
  minRent?: string;
  maxRent?: string;
  minSize?: string;
  bedrooms?: number;
  furnishing?: Furnishing;
  pets?: boolean;
  availableBy?: string;
  sort?: 'newest' | 'rent_asc' | 'rent_desc';
  cursor?: string;
  limit?: number;
}

export interface PublicPhoto {
  url: string;
  width: number;
  height: number;
  caption: string | null;
}

/** Public links of listing photos live long enough to outlast the 5-minute cache of the pages that embed them. */
const PHOTO_URL_TTL_SECONDS = 3600;

const PUBLIC = Prisma.sql`l.state = 'published' AND l.hidden_at IS NULL AND t.status = 'active' AND t.deleted_at IS NULL`;

type Row = {
  id: string;
  slug: string;
  title_th: string;
  title_en: string | null;
  unit_kind: PortfolioUnitKind | null;
  rent: Prisma.Decimal;
  deposit_months: number;
  advance_months: number;
  min_term_months: number;
  size_sqm: Prisma.Decimal | null;
  bedrooms: number | null;
  bathrooms: number | null;
  furnishing: Furnishing | null;
  pets_allowed: boolean;
  available_from: Date | null;
  province: string | null;
  district: string | null;
  address_text: string | null;
  transit_name: string | null;
  transit_line: string | null;
  transit_distance_m: number | null;
  published_at: Date;
  updated_at: Date;
  verified: boolean;
  identity_verified: boolean;
  /** G4: no current occupancy, no lease in force or waiting for signature (any tenant). */
  no_occupant: boolean;
  /** G4: the last day of the unit's last ended / terminated lease on getproperty (null = no history). */
  last_lease_end: Date | null;
};

/** G5 (D-297): the label of a sponsored result (boosted listings are always shown as ads). */
export const SPONSORED_LABEL = { th: 'โฆษณา', en: 'Ad' } as const;

const ISO_DAY = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Offset cursor, opaque to clients (base64url of the next offset). */
const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^o:(\d{1,6})$/.exec(text);
  if (!match)
    throw new DomainException('validation.failed', {
      errors: [{ path: 'cursor', code: 'invalid', message: 'invalid cursor' }],
    });
  return Number(match[1]);
}

/**
 * The anonymous read of listings (B7.3 part 1, D-252): search, detail by slug and the sitemap — only published,
 * not hidden listings of active tenants. Honest pages: the full address and the map pin are public (founder
 * 2026-10-24), the unit number only when the owner chose to show it, the owner's display name and whether the unit's
 * owner is verified. Photo links point at the cleaned WebP renditions (EXIF removed by the scan job).
 */
@Injectable()
export class PublicListingsService {
  constructor(
    private readonly db: TenantTx,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly insights: ListingInsightsService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly identity: IdentityVerificationService,
    private readonly config: AppConfig,
  ) {}

  /** The public page of a listing on the marketing site (D-252: `/rent/{slug}`). */
  pageUrl(slug: string): string {
    return `${this.config.get('PUBLIC_WEB_APP_URL')}/rent/${slug}`;
  }

  /** The stable Open Graph card URL (G4) — a redirect-free PNG served by this API. */
  ogImageUrl(slug: string): string {
    return `${this.config.get('PUBLIC_API_BASE_URL')}/v1/public/listings/${slug}/og-image`;
  }

  /**
   * G4 (D-296) "verified vacant": getproperty's own data says nobody lives there — no current occupancy, no lease in
   * force or waiting for signature — and, unless `listing.verified_vacant.require_history` is off, the unit had a
   * lease on the platform that ended (otherwise there is no evidence either way). `vacantSince` = that lease's end.
   */
  private async vacancyRule(): Promise<boolean> {
    return (
      (await this.settings.valueAt<boolean>('listing.verified_vacant.require_history', this.clock.now())) !==
      false
    );
  }

  private vacancy(row: Row, requireHistory: boolean) {
    const verified = row.no_occupant && (!requireHistory || row.last_lease_end !== null);
    return { verifiedVacant: verified, vacantSince: verified ? ISO_DAY(row.last_lease_end) : null };
  }

  async photo(
    doc: { storageKey: string; width: number | null; height: number | null },
    caption: string | null,
    width: 480 | 960 | 1600,
  ): Promise<PublicPhoto> {
    const w = doc.width ? Math.min(doc.width, width) : width;
    const h = doc.width && doc.height ? Math.round((doc.height * w) / doc.width) : Math.round((w * 3) / 4);
    const url = await this.storage.presignGet(renditionKey(doc.storageKey, width), {
      expiresInSeconds: PHOTO_URL_TTL_SECONDS,
      fileName: `photo-${width}.webp`,
      contentType: 'image/webp',
    });
    return { url, width: w, height: h, caption };
  }

  private title(row: { title_th: string; title_en: string | null }, lang: 'th' | 'en') {
    return lang === 'en' && row.title_en ? row.title_en : row.title_th;
  }

  private async covers(ids: string[]) {
    if (!ids.length) return new Map<string, PublicPhoto>();
    const photos = await this.db.platform((tx) =>
      tx.listingPhoto.findMany({
        where: { listingId: { in: ids }, sortOrder: 0 },
        include: { document: { select: { storageKey: true, width: true, height: true } } },
      }),
    );
    const out = new Map<string, PublicPhoto>();
    for (const p of photos) out.set(p.listingId, await this.photo(p.document, p.caption, 960));
    return out;
  }

  private summary(
    row: Row,
    cover: PublicPhoto | null,
    lang: 'th' | 'en',
    requireHistory: boolean,
    sponsored = false,
  ) {
    return {
      ...this.vacancy(row, requireHistory),
      // G5 (D-297): a boosted listing in a sponsored slot is labelled as an ad
      sponsored,
      sponsoredLabel: sponsored ? SPONSORED_LABEL[lang] : null,
      slug: row.slug,
      title: this.title(row, lang),
      unitKind: row.unit_kind,
      rent: new Prisma.Decimal(row.rent).toFixed(2),
      depositMonths: row.deposit_months,
      advanceMonths: row.advance_months,
      minTermMonths: row.min_term_months,
      sizeSqm: row.size_sqm === null ? null : new Prisma.Decimal(row.size_sqm).toFixed(2),
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      furnishing: row.furnishing,
      petsAllowed: row.pets_allowed,
      availableFrom: ISO_DAY(row.available_from),
      province: row.province,
      district: row.district,
      address: row.address_text,
      nearestTransit:
        row.transit_name && row.transit_distance_m !== null
          ? { name: row.transit_name, line: row.transit_line, distanceM: row.transit_distance_m }
          : null,
      cover,
      verifiedOwner: row.verified,
      ownerIdentityVerified: row.identity_verified,
      publishedAt: row.published_at,
    };
  }

  private select(today: string) {
    return Prisma.sql`
    SELECT l.id, l.slug, l.title_th, l.title_en, l.unit_kind, l.rent, l.deposit_months, l.advance_months,
           l.min_term_months, l.size_sqm, l.bedrooms, l.bathrooms, l.furnishing, l.pets_allowed, l.available_from,
           l.province, l.district, l.address_text, l.transit_name, l.transit_line, l.transit_distance_m,
           l.published_at, l.updated_at,
           EXISTS (SELECT 1 FROM platform.listing_verification v
                    WHERE v.unit_id = l.unit_id AND v.tenant_id = l.tenant_id AND v.state = 'approved') AS verified,
           EXISTS (SELECT 1 FROM core.membership m
                     JOIN platform.identity_verification iv ON iv.user_id = m.user_id AND iv.state = 'approved'
                    WHERE m.tenant_id = l.tenant_id AND m.role = 'owner' AND m.status = 'active') AS identity_verified,
           (NOT EXISTS (SELECT 1 FROM core.occupancy o
                         WHERE o.unit_id = l.unit_id AND o.valid_from <= ${today}::date
                           AND (o.valid_to IS NULL OR o.valid_to > ${today}::date) AND o.moved_out_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM ops.lease x
                             WHERE x.unit_id = l.unit_id
                               AND x.status IN ('pending_signature', 'active', 'notice_given', 'ending'))) AS no_occupant,
           (SELECT max(COALESCE((x.move_out_at AT TIME ZONE 'Asia/Bangkok')::date,
                                CASE WHEN x.status = 'terminated' AND x.terminated_at IS NOT NULL
                                     THEN (x.terminated_at AT TIME ZONE 'Asia/Bangkok')::date END,
                                x.end_date))
              FROM ops.lease x WHERE x.unit_id = l.unit_id AND x.status IN ('ended', 'terminated')) AS last_lease_end
      FROM ops.listing l JOIN core.tenant t ON t.id = l.tenant_id`;
  }

  async search(query: PublicListingQuery, lang: 'th' | 'en') {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const offset = decodeCursor(query.cursor);
    const where: Prisma.Sql[] = [PUBLIC];
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        Prisma.sql`(l.title_th ILIKE ${like} OR l.title_en ILIKE ${like} OR l.address_text ILIKE ${like}
                    OR l.district ILIKE ${like} OR l.province ILIKE ${like} OR l.transit_name ILIKE ${like})`,
      );
    }
    if (query.ownerTenantId) where.push(Prisma.sql`l.tenant_id = ${query.ownerTenantId}::uuid`);
    if (query.kind) where.push(Prisma.sql`l.unit_kind = ${query.kind}::ops.portfolio_unit_kind`);
    if (query.province) where.push(Prisma.sql`l.province = ${query.province}`);
    if (query.district) where.push(Prisma.sql`l.district = ${query.district}`);
    if (query.area) {
      const area = await this.insights.areaFilter(query.area);
      if (!area) return { data: [], total: 0, nextCursor: null };
      if (area.districts) where.push(Prisma.sql`l.district = ANY (${area.districts}::text[])`);
      if (area.province) where.push(Prisma.sql`l.province = ${area.province}`);
      if (area.stations)
        where.push(
          Prisma.sql`l.transit_name = ANY (${area.stations}::text[]) AND l.transit_distance_m <= 1000`,
        );
    }
    if (query.minRent) where.push(Prisma.sql`l.rent >= ${query.minRent}::numeric`);
    if (query.maxRent) where.push(Prisma.sql`l.rent <= ${query.maxRent}::numeric`);
    if (query.minSize) where.push(Prisma.sql`l.size_sqm >= ${query.minSize}::numeric`);
    if (query.bedrooms !== undefined) where.push(Prisma.sql`l.bedrooms >= ${query.bedrooms}`);
    if (query.furnishing) where.push(Prisma.sql`l.furnishing = ${query.furnishing}::ops.furnishing`);
    if (query.pets) where.push(Prisma.sql`l.pets_allowed`);
    if (query.availableBy)
      where.push(Prisma.sql`(l.available_from IS NULL OR l.available_from <= ${query.availableBy}::date)`);
    const order =
      query.sort === 'rent_asc'
        ? Prisma.sql`l.rent ASC, l.published_at DESC`
        : query.sort === 'rent_desc'
          ? Prisma.sql`l.rent DESC, l.published_at DESC`
          : Prisma.sql`l.published_at DESC, l.id DESC`;
    const filter = Prisma.join(where, ' AND ');
    const now = this.clock.now();
    const today = bangkokDate(now);
    const requireHistory = await this.vacancyRule();
    const [rows, total] = await this.db.platform(async (tx) => [
      await tx.$queryRaw<
        Row[]
      >`${this.select(today)} WHERE ${filter} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`,
      (
        await tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*) AS n FROM ops.listing l JOIN core.tenant t ON t.id = l.tenant_id WHERE ${filter}`
      )[0]!.n,
    ]);
    // G5 (D-297): boosted listings matching the same query on top of the page, labelled, at most N per page
    const sponsored = query.ownerTenantId
      ? []
      : await this.sponsored(filter, today, now, requireHistory, Math.floor(offset / limit));
    const sponsoredIds = new Set(sponsored.map((r) => r.id));
    const page = rows.slice(0, limit);
    const organic = page.filter((r) => !sponsoredIds.has(r.id));
    const covers = await this.covers([...sponsored, ...organic].map((r) => r.id));
    return {
      data: [
        ...sponsored.map((row) => this.summary(row, covers.get(row.id) ?? null, lang, requireHistory, true)),
        ...organic.map((row) => this.summary(row, covers.get(row.id) ?? null, lang, requireHistory)),
      ],
      total: Number(total),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  /**
   * The sponsored slots of one results page (G5, D-297): listings with a boost in force — of the listing itself or of
   * its building (bought by the listing's tenant) — matching the query; ranked by verified vacancy, freshness, id;
   * `boost.search.max_per_page` per page (0 = none), each boosted listing once across pages.
   */
  private async sponsored(
    filter: Prisma.Sql,
    today: string,
    now: Date,
    requireHistory: boolean,
    pageIndex: number,
  ): Promise<Row[]> {
    const perPage = (await this.settings.valueAt<number>('boost.search.max_per_page', now)) ?? 0;
    if (perPage <= 0) return [];
    const candidates = await this.db.platform(
      (tx) =>
        tx.$queryRaw<Row[]>`${this.select(today)} WHERE ${filter} AND EXISTS (
          SELECT 1 FROM ops.listing_boost b
           WHERE b.state = 'active' AND b.starts_at <= ${now} AND b.ends_at > ${now}
             AND (b.listing_id = l.id OR (b.building_id = l.building_id AND b.tenant_id = l.tenant_id)))
          ORDER BY l.published_at DESC, l.id LIMIT 500`,
    );
    return sponsoredSlots(
      candidates.map((row) => ({
        row,
        id: row.id,
        verifiedVacant: this.vacancy(row, requireHistory).verifiedVacant,
        publishedAt: row.published_at,
      })),
      pageIndex,
      perPage,
    ).map((c) => c.row);
  }

  async detail(slug: string, lang: 'th' | 'en') {
    const today = bangkokDate(this.clock.now());
    const requireHistory = await this.vacancyRule();
    const rows = await this.db.platform(
      (tx) => tx.$queryRaw<Row[]>`${this.select(today)} WHERE ${PUBLIC} AND l.slug = ${slug}`,
    );
    const row = rows[0];
    if (!row) throw new DomainException('http.not_found');
    const listing = await this.db.platform((tx) =>
      tx.listing.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          tenant: { select: { displayName: true, slug: true } },
          photos: {
            orderBy: { sortOrder: 'asc' },
            include: { document: { select: { storageKey: true, width: true, height: true } } },
          },
        },
      }),
    );
    const photos = [];
    for (const p of listing.photos) photos.push(await this.photo(p.document, p.caption, 1600));
    const utility = await this.db.platform((tx) => this.insights.utility(tx, listing));
    const cover = listing.photos[0]
      ? await this.photo(listing.photos[0].document, listing.photos[0].caption, 960)
      : null;
    const summary = this.summary(row, cover, lang, requireHistory);
    const description =
      lang === 'en' && listing.descriptionEn ? listing.descriptionEn : listing.descriptionTh;
    const geo = listing.lat && listing.lng ? { lat: Number(listing.lat), lng: Number(listing.lng) } : null;
    const ogImageUrl = this.ogImageUrl(row.slug);
    return {
      ...summary,
      description,
      ogImageUrl,
      jsonLd: listingJsonLd({
        url: this.pageUrl(row.slug),
        imageUrl: ogImageUrl,
        title: summary.title,
        description,
        unitKind: row.unit_kind,
        rent: summary.rent,
        sizeSqm: summary.sizeSqm,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        petsAllowed: row.pets_allowed,
        availableFrom: summary.availableFrom,
        address: row.address_text,
        district: row.district,
        province: row.province,
        geo,
        publishedAt: toBangkokIso(row.published_at),
        language: lang,
      }),
      facilities: listing.facilities,
      photos,
      floor: listing.floorLabel,
      geo,
      ownerDisplayName: listing.tenant.displayName,
      ownerProfileSlug: (await this.verifiedUnits(listing.tenantId)) > 0 ? listing.tenant.slug : null,
      smokingAllowed: listing.smokingAllowed,
      utility,
    };
  }

  async sitemap() {
    const rows = await this.db.platform(
      (tx) =>
        tx.$queryRaw<{ slug: string; updated_at: Date }[]>`
          SELECT l.slug, l.updated_at FROM ops.listing l JOIN core.tenant t ON t.id = l.tenant_id
           WHERE ${PUBLIC} ORDER BY l.published_at DESC LIMIT 50000`,
    );
    return { data: rows.map((r) => ({ slug: r.slug, updatedAt: r.updated_at })) };
  }

  /**
   * D-274: the public page of a verified owner — display name, verification (units whose ownership the platform
   * approved, D-252), member since, median reply time to enquiries and the published listings. 404 when the owner
   * has no approved verification or switched the page off (`listing.public_profile.enabled`). No contact details.
   */
  /** Units of the owner whose ownership the platform approved — 0 when the owner switched the page off (D-274). */
  private async verifiedUnits(tenantId: string): Promise<number> {
    const enabled = await this.settings.valueAt<boolean>('listing.public_profile.enabled', this.clock.now(), {
      tenantId,
    });
    if (enabled === false) return 0;
    return this.db.platform((tx) => tx.listingVerification.count({ where: { tenantId, state: 'approved' } }));
  }

  async ownerProfile(slug: string, lang: 'th' | 'en') {
    const tenant = await this.db.platform((tx) =>
      tx.tenant.findFirst({
        where: { slug, status: 'active', deletedAt: null },
        select: { id: true, slug: true, displayName: true, createdAt: true },
      }),
    );
    if (!tenant) throw new DomainException('http.not_found');
    const verifiedUnits = await this.verifiedUnits(tenant.id);
    if (verifiedUnits === 0) throw new DomainException('http.not_found');
    const [replyMinutes, listings] = await Promise.all([
      this.insights.medianReplyMinutes(tenant.id),
      this.search({ ownerTenantId: tenant.id, limit: 50 }, lang),
    ]);
    return {
      slug: tenant.slug,
      displayName: tenant.displayName,
      verification: {
        level: 'unit_ownership' as const,
        verifiedUnits,
        identityVerified: (await this.identity.verifiedOwnerTenants([tenant.id])).has(tenant.id),
      },
      memberSince: tenant.createdAt.toISOString().slice(0, 10),
      medianReplyMinutes: replyMinutes,
      listings: listings.data,
      listingCount: listings.total,
    };
  }
}

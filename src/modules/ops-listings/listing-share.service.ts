import { createHash, randomInt } from 'node:crypto';

import { OBJECT_STORAGE, type ObjectStorage } from '@collective/integrations/storage';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { renditionKey } from '@core/documents/document-policy';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type Listing, type ListingChannel, Prisma } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { districtName, provinceEn, stationName } from './area-names';
import { ListingsService } from './listings.service';
import { renderShareCard } from './share-card';

/** Channels of the share kit, in the order the owner sees them (D-268). */
export const SHARE_CHANNELS: ListingChannel[] = [
  'line',
  'facebook_group',
  'facebook_marketplace',
  'qr',
  'link',
];
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CARD_URL_TTL_SECONDS = 600;

export interface ShareKitLink {
  channel: ListingChannel;
  url: string;
  clicks: number;
  enquiries: number;
  captionTh: string;
  captionEn: string;
  /** LINE only: opens LINE's share picker with the Thai caption. */
  shareUrl: string | null;
}

export interface ShareKit {
  listingId: string;
  links: ShareKitLink[];
  cards: { th: ShareCardFile; en: ShareCardFile };
  /** G4 image bundle: the listing's photos in order (1600 px WebP renditions, signed for 10 minutes). */
  photos: ShareCardFile[];
}

export interface ShareCardFile {
  documentId: string;
  url: string;
  width: number;
  height: number;
}

const baht = (rent: Prisma.Decimal) =>
  `฿${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(rent.toFixed(2)))}`;

/**
 * The share kit of a listing (B7.9 part 2, D-268): one short link per channel (`<web>/s/<code>` → the listing with
 * UTM, clicks counted), captions in Thai and English per channel, and the 1080 × 1080 photo cards (th / en) with a QR
 * of the listing's link — rendered again only when what they show changes. Nothing is posted anywhere: Facebook's
 * terms forbid automated posting, so the owner copies and downloads; LINE opens its own share picker.
 */
@Injectable()
export class ListingShareService {
  private readonly logger = new Logger(ListingShareService.name);

  constructor(
    private readonly db: TenantTx,
    private readonly listings: ListingsService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private origin(): string {
    return this.config.get('PUBLIC_WEB_APP_URL');
  }

  shortUrl(code: string): string {
    return `${this.origin()}/s/${code}`;
  }

  code(): string {
    let s = '';
    for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return s;
  }

  /** Creates the missing links of a listing (one per channel); a code collision retries with a new code. */
  private async ensureLinks(ctx: TenantContext, listing: Listing) {
    const existing = await this.db.tenant(ctx, (tx) =>
      tx.listingShareLink.findMany({ where: { listingId: listing.id, tenantId: ctx.tenantId } }),
    );
    const missing = SHARE_CHANNELS.filter((c) => !existing.some((l) => l.channel === c));
    for (const channel of missing)
      for (let attempt = 0; ; attempt++) {
        try {
          await this.db.tenant(ctx, (tx) =>
            tx.listingShareLink.create({
              data: {
                tenantId: ctx.tenantId,
                listingId: listing.id,
                channel,
                code: this.code(),
                createdBy: userIdOf(RequestContext.actor()),
              },
            }),
          );
          break;
        } catch (error) {
          const unique = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
          const sameChannel = unique && JSON.stringify(error.meta ?? {}).includes('channel');
          if (sameChannel) break; // made at the same moment by another request
          if (!unique || attempt >= 4) throw error;
        }
      }
    return this.db.tenant(ctx, (tx) =>
      tx.listingShareLink.findMany({ where: { listingId: listing.id, tenantId: ctx.tenantId } }),
    );
  }

  /** Card / caption texts of a listing in one language (also the Open Graph card and Page posts, G4). */
  texts(listing: Listing, verified: boolean, lang: 'th' | 'en') {
    const th = lang === 'th';
    const rent = baht(listing.rent);
    const title = (!th && listing.titleEn) || listing.titleTh;
    const station = listing.transitName
      ? th
        ? listing.transitName
        : stationName(listing.transitName).en
      : null;
    const district = listing.district
      ? th
        ? listing.district
        : districtName(listing.district, listing.province).en
      : null;
    const province = th ? listing.province : provinceEn(listing.province);
    const place = [
      [district, province].filter(Boolean).join(', '),
      station && listing.transitDistanceM !== null
        ? th
          ? `${station} ${listing.transitDistanceM} ม.`
          : `${station} ${listing.transitDistanceM} m`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const size = listing.sizeSqm ? listing.sizeSqm.toDecimalPlaces(1).toString() : null;
    const facts = [
      listing.bedrooms !== null
        ? th
          ? listing.bedrooms === 0
            ? 'สตูดิโอ'
            : `${listing.bedrooms} ห้องนอน`
          : listing.bedrooms === 0
            ? 'Studio'
            : `${listing.bedrooms} bedroom${listing.bedrooms === 1 ? '' : 's'}`
        : null,
      size ? (th ? `${size} ตร.ม.` : `${size} m²`) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const terms = th
      ? `ค่าเช่า ${rent}/เดือน · มัดจำ ${listing.depositMonths} เดือน · ล่วงหน้า ${listing.advanceMonths} เดือน · สัญญาขั้นต่ำ ${listing.minTermMonths} เดือน`
      : `Rent ${rent}/month · deposit ${listing.depositMonths} mo · advance ${listing.advanceMonths} mo · minimum ${listing.minTermMonths} months`;
    // G4: an agency's listing (G2 mandate) never claims "no agent fee"
    const direct = listing.mandateId === null;
    const badge = th
      ? [verified ? 'เจ้าของยืนยันแล้ว' : null, direct ? 'ไม่มีค่านายหน้า' : null].filter(Boolean).join(' · ')
      : [verified ? 'Verified owner' : null, direct ? 'No agent fee' : null].filter(Boolean).join(' · ');
    return { rent, title, place, facts, terms, badge };
  }

  /** The caption of a channel (B7.9); the Facebook Page post text too (G4). */
  caption(listing: Listing, verified: boolean, lang: 'th' | 'en', url: string): string {
    const t = this.texts(listing, verified, lang);
    const lines =
      lang === 'th'
        ? [
            t.title,
            t.terms,
            t.place ? `ที่ตั้ง: ${t.place}` : null,
            t.facts || null,
            t.badge || null,
            `ดูรูปทั้งหมด ถามหรือนัดดูห้อง: ${url}`,
          ]
        : [
            t.title,
            t.terms,
            t.place ? `Where: ${t.place}` : null,
            t.facts || null,
            t.badge || null,
            `All photos, questions and viewings: ${url}`,
          ];
    return lines.filter(Boolean).join('\n');
  }

  /** The cover photo's bytes (its 1600 px rendition, else the original), or null without photos. */
  async cover(tx: Tx, listingId: string): Promise<{ id: string; body: Buffer } | null> {
    const photo = await tx.listingPhoto.findFirst({
      where: { listingId },
      orderBy: { sortOrder: 'asc' },
      include: { document: true },
    });
    if (!photo) return null;
    const read = async (key: string) => {
      const chunks: Buffer[] = [];
      for await (const chunk of await this.storage.getStream(key))
        chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    };
    try {
      return { id: photo.documentId, body: await read(renditionKey(photo.document.storageKey, 1600)) };
    } catch {
      try {
        return { id: photo.documentId, body: await read(photo.document.storageKey) };
      } catch (error) {
        this.logger.warn(`share card without photo for ${listingId}: ${(error as Error).message}`);
        return null;
      }
    }
  }

  private async card(document: { id: string; storageKey: string; title: string | null; mimeType: string }) {
    return {
      documentId: document.id,
      url: await this.storage.presignGet(document.storageKey, {
        expiresInSeconds: CARD_URL_TTL_SECONDS,
        fileName: document.title ?? 'share-card.png',
        contentType: document.mimeType,
      }),
      width: 1080,
      height: 1080,
    };
  }

  /**
   * D-268: the listing's share kit — links (created on first use), captions, enquiries per channel and the cards.
   * Only a published listing can be shared (a draft or paused one has no public page to link to).
   */
  async kit(ctx: TenantContext, listingId: string): Promise<ShareKit> {
    const listing = await this.listings.get(ctx, listingId);
    if (listing.state !== 'published' || listing.hiddenAt) throw new DomainException('listing.invalid_state');
    const links = await this.ensureLinks(ctx, listing);
    const verified = await this.db.platform((tx) => this.listings.verified(tx, ctx.tenantId, listing.unitId));
    const counts = await this.db.tenant(ctx, (tx) =>
      tx.listingLead.groupBy({
        by: ['channel'],
        where: { listingId, tenantId: ctx.tenantId, channel: { not: null } },
        _count: { _all: true },
      }),
    );
    const qr = links.find((l) => l.channel === 'qr')!;
    const qrUrl = this.shortUrl(qr.code);

    const cover = await this.db.tenant(ctx, (tx) => this.cover(tx, listingId));
    const th = this.texts(listing, verified, 'th');
    const en = this.texts(listing, verified, 'en');
    const hash = createHash('sha256')
      .update(JSON.stringify({ v: 1, cover: cover?.id ?? null, th, en, qrUrl }))
      .digest('hex');

    let thId = listing.shareCardThDocumentId;
    let enId = listing.shareCardEnDocumentId;
    if (hash !== listing.shareCardHash || !thId || !enId) {
      const render = (t: typeof th, lang: 'th' | 'en') =>
        renderShareCard({
          photo: cover?.body ?? null,
          rent: t.rent,
          perMonth: lang === 'th' ? '/ เดือน' : '/ month',
          title: t.title,
          place: t.place,
          facts: t.facts,
          badge: t.badge,
          scan: lang === 'th' ? 'สแกนดูห้อง' : 'Scan to view',
          url: qrUrl,
        });
      const [thPng, enPng] = await Promise.all([render(th, 'th'), render(en, 'en')]);
      const upload = (body: Buffer, lang: 'th' | 'en') =>
        this.documents.uploadGenerated({
          tenantId: ctx.tenantId,
          kind: 'other',
          scopeType: 'unit',
          scopeId: listing.unitId,
          buildingId: listing.buildingId,
          title: `share-card-${listing.slug}-${lang}.png`,
          mimeType: 'image/png',
          body,
          sourceRef: `listing:${listing.id}:share-card:${lang}`,
        });
      const [thUp, enUp] = await Promise.all([upload(thPng, 'th'), upload(enPng, 'en')]);
      await this.db.tenant(ctx, async (tx) => {
        const thDoc = await this.documents.recordGenerated(tx, thUp);
        const enDoc = await this.documents.recordGenerated(tx, enUp);
        await tx.listing.update({
          where: { id: listing.id },
          data: { shareCardThDocumentId: thDoc.id, shareCardEnDocumentId: enDoc.id, shareCardHash: hash },
        });
        await this.audit.record(tx, {
          action: 'listing.share_kit_generated',
          tenantId: ctx.tenantId,
          buildingId: listing.buildingId,
          subjectType: 'ops.listing',
          subjectId: listing.id,
          after: { cards: [thDoc.id, enDoc.id], channels: links.map((l) => l.channel) },
        });
        await this.events.record(tx, {
          type: 'listing.share_kit_generated',
          aggregateType: 'listing',
          aggregateId: listing.id,
          tenantId: ctx.tenantId,
          buildingId: listing.buildingId,
          payload: { listingId: listing.id, cardThDocumentId: thDoc.id, cardEnDocumentId: enDoc.id },
        });
      });
      thId = thUp.id;
      enId = enUp.id;
    }
    const docs = await this.db.tenant(ctx, (tx) =>
      tx.document.findMany({ where: { id: { in: [thId, enId] }, tenantId: ctx.tenantId } }),
    );
    const doc = (id: string) => docs.find((d) => d.id === id)!;

    return {
      listingId,
      links: SHARE_CHANNELS.map((channel) => {
        const link = links.find((l) => l.channel === channel)!;
        const url = this.shortUrl(link.code);
        const captionTh = this.caption(listing, verified, 'th', url);
        return {
          channel,
          url,
          clicks: link.clicks,
          enquiries: counts.find((c) => c.channel === channel)?._count._all ?? 0,
          captionTh,
          captionEn: this.caption(listing, verified, 'en', url),
          shareUrl:
            channel === 'line' ? `https://line.me/R/share?text=${encodeURIComponent(captionTh)}` : null,
        };
      }),
      cards: { th: await this.card(doc(thId)), en: await this.card(doc(enId)) },
      photos: await this.photoBundle(ctx, listingId),
    };
  }

  /** G4: the photos of the share kit's image bundle, in order (downloaded and posted by hand in groups, D-288). */
  private async photoBundle(ctx: TenantContext, listingId: string): Promise<ShareCardFile[]> {
    const photos = await this.db.tenant(ctx, (tx) =>
      tx.listingPhoto.findMany({
        where: { listingId, tenantId: ctx.tenantId },
        orderBy: { sortOrder: 'asc' },
        include: { document: { select: { storageKey: true, width: true, height: true } } },
      }),
    );
    const out: ShareCardFile[] = [];
    for (const [i, p] of photos.entries()) {
      const w = p.document.width ? Math.min(p.document.width, 1600) : 1600;
      const h =
        p.document.width && p.document.height
          ? Math.round((p.document.height * w) / p.document.width)
          : Math.round((w * 3) / 4);
      out.push({
        documentId: p.documentId,
        url: await this.storage.presignGet(renditionKey(p.document.storageKey, 1600), {
          expiresInSeconds: CARD_URL_TTL_SECONDS,
          fileName: `photo-${String(i + 1).padStart(2, '0')}.webp`,
          contentType: 'image/webp',
        }),
        width: w,
        height: h,
      });
    }
    return out;
  }

  /**
   * The short link of a listing for one channel, made on first use (G4: the `facebook_page` link of a Page post, so
   * its clicks and enquiries are counted like the share kit's). Runs in the caller's transaction.
   */
  async linkIn(tx: Tx, listing: Pick<Listing, 'id' | 'tenantId'>, channel: ListingChannel): Promise<string> {
    const existing = await tx.listingShareLink.findFirst({ where: { listingId: listing.id, channel } });
    if (existing) return this.shortUrl(existing.code);
    for (let attempt = 0; ; attempt++) {
      const code = this.code();
      const clash = await tx.listingShareLink.findUnique({ where: { code } });
      if (clash) {
        if (attempt >= 4) throw new Error('share link: no free code');
        continue;
      }
      await tx.listingShareLink.create({
        data: { tenantId: listing.tenantId, listingId: listing.id, channel, code, createdBy: null },
      });
      return this.shortUrl(code);
    }
  }

  /**
   * A short link was opened (public, D-268): counts the click and answers where to go — the listing's slug and the
   * UTM of its channel. A listing no longer public is a 404 (the web shows the search instead).
   */
  /**
   * G6 (D-300): the link of a listing in a sponsored campaign (same `<web>/s/<code>` page) — counts the click on the
   * link and the campaign (never per person) and answers channel `line_sponsored`, which the enquiry then carries.
   */
  private async openSponsored(tx: Tx, code: string): Promise<{ slug: string; channel: ListingChannel }> {
    const link = await tx.sponsoredCampaignLink.findUnique({ where: { code }, include: { listing: true } });
    const l = link?.listing;
    if (!link || !l || l.state !== 'published' || l.hiddenAt) throw new DomainException('http.not_found');
    const now = this.clock.now();
    await tx.sponsoredCampaignLink.update({
      where: { id: link.id },
      data: { clicks: { increment: 1 }, lastClickedAt: now },
    });
    await tx.sponsoredCampaign.update({ where: { id: link.campaignId }, data: { clicks: { increment: 1 } } });
    return { slug: l.slug, channel: 'line_sponsored' };
  }

  async open(code: string): Promise<{ slug: string; channel: ListingChannel }> {
    if (!/^[a-z0-9]{8}$/.test(code)) throw new DomainException('http.not_found');
    return this.db.platform(async (tx) => {
      const link = await tx.listingShareLink.findUnique({ where: { code }, include: { listing: true } });
      if (!link) return this.openSponsored(tx, code);
      const l = link.listing;
      if (!l || l.state !== 'published' || l.hiddenAt) throw new DomainException('http.not_found');
      await tx.listingShareLink.update({
        where: { id: link.id },
        data: { clicks: { increment: 1 }, lastClickedAt: this.clock.now() },
      });
      return { slug: l.slug, channel: link.channel };
    });
  }
}

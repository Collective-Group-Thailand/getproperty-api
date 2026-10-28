import { createHash } from 'node:crypto';

import { OBJECT_STORAGE, type ObjectStorage } from '@collective/integrations/storage';
import { systemTenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { DocumentsService } from '@core/documents/documents.service';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { ListingShareService } from './listing-share.service';
import { ListingsService } from './listings.service';
import { PublicListingsService } from './public-listings.service';
import { renderOgCard } from './share-card';

/**
 * The Open Graph card of a public listing (G4, D-296): 1200 × 630 PNG rendered with the share-card renderer
 * (sharp / Pango, Sarabun — no headless browser, D-236's aim), stored as a document of the listing tenant (counted to
 * its quota, D-286) and rendered again only when what it shows changes (content hash). A listing that is not public
 * is a 404.
 */
@Injectable()
export class ListingOgImageService {
  constructor(
    private readonly db: TenantTx,
    private readonly listings: ListingsService,
    private readonly share: ListingShareService,
    private readonly publicListings: PublicListingsService,
    private readonly documents: DocumentsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async image(slug: string): Promise<{ body: Buffer; etag: string }> {
    const detail = await this.publicListings.detail(slug, 'th'); // 404 unless public
    const listing = await this.db.platform((tx) =>
      tx.listing.findUniqueOrThrow({ where: { slug }, include: { ogImage: true } }),
    );
    const verified = await this.db.platform((tx) =>
      this.listings.verified(tx, listing.tenantId, listing.unitId),
    );
    const t = this.share.texts(listing, verified, 'th');
    const badges = [detail.verifiedVacant ? 'ว่างจริง ตรวจจากสัญญาในระบบ' : null, t.badge || null]
      .filter(Boolean)
      .join(' · ');
    const ctx = systemTenantContext(listing.tenantId);
    const cover = await this.db.tenant(ctx, (tx) => this.share.cover(tx, listing.id));
    const hash = createHash('sha256')
      .update(JSON.stringify({ v: 1, cover: cover?.id ?? null, t, badges }))
      .digest('hex');
    if (listing.ogImage && listing.ogImageHash === hash && !listing.ogImage.deletedAt) {
      try {
        return { body: await this.read(listing.ogImage.storageKey), etag: hash.slice(0, 32) };
      } catch {
        // the stored card is gone: render it again below
      }
    }
    const body = await renderOgCard({
      photo: cover?.body ?? null,
      rent: t.rent,
      perMonth: '/ เดือน',
      title: t.title,
      place: t.place,
      facts: t.facts,
      badges,
    });
    const uploaded = await this.documents.uploadGenerated({
      tenantId: listing.tenantId,
      kind: 'other',
      scopeType: 'unit',
      scopeId: listing.unitId,
      buildingId: listing.buildingId,
      title: `og-image-${listing.slug}.png`,
      mimeType: 'image/png',
      body,
      sourceRef: `listing:${listing.id}:og-image`,
    });
    await this.db.tenant(ctx, async (tx) => {
      const doc = await this.documents.recordGenerated(tx, uploaded);
      await tx.listing.update({
        where: { id: listing.id },
        data: { ogImageDocumentId: doc.id, ogImageHash: hash },
      });
    });
    return { body, etag: hash.slice(0, 32) };
  }

  private async read(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.storage.getStream(key))
      chunks.push(Buffer.from(chunk as Uint8Array));
    const body = Buffer.concat(chunks);
    if (!body.length) throw new DomainException('http.not_found');
    return body;
  }
}

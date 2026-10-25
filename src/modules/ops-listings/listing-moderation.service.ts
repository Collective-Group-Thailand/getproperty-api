import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { LookupHasher } from '@common/crypto/lookup-hasher';
import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type Listing, type ListingReportReason } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

export type QueueKind = 'pending_review' | 'hidden' | 'reported';

/**
 * The platform side of listings (B7.2, D-252): the moderation queue (pending review, hidden, reported), the
 * moderator's decisions (approve, reject with a reason, hide, restore), viewers' reports (one open report per
 * reporter; after `listing.report.hide_after` the listing hides itself pending review), and owner verification
 * (approve / reject; a second reviewer when `listing.verification.maker_checker`; evidence deleted
 * `listing.verification.evidence_retention_days` after the decision — O-018).
 */
@Injectable()
export class ListingModerationService {
  private readonly logger = new Logger('ListingModeration');

  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly hasher: LookupHasher,
    private readonly documents: DocumentsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private by() {
    return userIdOf(RequestContext.actor());
  }

  private async listing(tx: Tx, id: string): Promise<Listing> {
    const listing = await tx.listing.findUnique({ where: { id } });
    if (!listing) throw new DomainException('http.not_found');
    return listing;
  }

  async queue(kind: QueueKind | undefined) {
    return this.db.platform(async (tx) => {
      const where =
        kind === 'pending_review'
          ? { state: 'pending_review' as const }
          : kind === 'hidden'
            ? { hiddenAt: { not: null } }
            : kind === 'reported'
              ? { reports: { some: { state: 'open' as const } } }
              : {
                  OR: [
                    { state: 'pending_review' as const },
                    { hiddenAt: { not: null } },
                    { reports: { some: { state: 'open' as const } } },
                  ],
                };
      return tx.listing.findMany({
        where: { ...where, state: kind === 'pending_review' ? 'pending_review' : { not: 'closed' } },
        include: {
          tenant: { select: { id: true, displayName: true, type: true } },
          reports: {
            where: { state: 'open' },
            select: { id: true, reason: true, details: true, createdAt: true },
          },
          photos: { orderBy: { sortOrder: 'asc' }, select: { documentId: true }, take: 1 },
        },
        orderBy: { updatedAt: 'asc' },
        take: 200,
      });
    });
  }

  private async decide(
    id: string,
    action: 'listing.approved' | 'listing.rejected' | 'listing.hidden' | 'listing.restored',
    change: (listing: Listing, now: Date) => Parameters<Tx['listing']['update']>[0]['data'],
    event: {
      type: 'listing.published' | 'listing.rejected' | 'listing.hidden' | 'listing.restored';
      reason?: string;
    },
    reports?: 'upheld' | 'dismissed',
  ) {
    return this.db.platform(async (tx) => {
      const listing = await this.listing(tx, id);
      const now = this.clock.now();
      const updated = await tx.listing.update({
        where: { id },
        data: { ...change(listing, now), reviewedBy: this.by(), reviewedAt: now, version: { increment: 1 } },
      });
      if (reports)
        await tx.listingReport.updateMany({
          where: { listingId: id, state: 'open' },
          data: { state: reports, decidedBy: this.by(), decidedAt: now },
        });
      await this.audit.record(tx, {
        action,
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: id,
        before: { state: listing.state, hidden: Boolean(listing.hiddenAt) },
        after: { state: updated.state, hidden: Boolean(updated.hiddenAt), reason: event.reason ?? null },
      });
      await this.events.record(tx, {
        type: event.type,
        aggregateType: 'listing',
        aggregateId: id,
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        payload: { listingId: id, unitId: listing.unitId, reason: event.reason ?? null },
      });
      return updated;
    });
  }

  async approve(id: string) {
    const listing = await this.db.platform((tx) => this.listing(tx, id));
    if (listing.state !== 'pending_review') throw new DomainException('listing.invalid_state');
    return this.decide(
      id,
      'listing.approved',
      (_l, now) => ({ state: 'published', publishedAt: now, reviewReasons: [], rejectedReason: null }),
      { type: 'listing.published' },
    );
  }

  async reject(id: string, reason: string) {
    const listing = await this.db.platform((tx) => this.listing(tx, id));
    if (!['pending_review', 'published', 'paused'].includes(listing.state))
      throw new DomainException('listing.invalid_state');
    return this.decide(
      id,
      'listing.rejected',
      () => ({ state: 'rejected', rejectedReason: reason, hiddenAt: null, hiddenReason: null }),
      { type: 'listing.rejected', reason },
      'upheld',
    );
  }

  async hide(id: string, reason: string) {
    const listing = await this.db.platform((tx) => this.listing(tx, id));
    if (listing.hiddenAt || !['published', 'paused'].includes(listing.state))
      throw new DomainException('listing.invalid_state');
    return this.decide(
      id,
      'listing.hidden',
      (_l, now) => ({ hiddenAt: now, hiddenReason: reason }),
      { type: 'listing.hidden', reason },
      'upheld',
    );
  }

  async restore(id: string) {
    const listing = await this.db.platform((tx) => this.listing(tx, id));
    if (!listing.hiddenAt) throw new DomainException('listing.invalid_state');
    return this.decide(
      id,
      'listing.restored',
      () => ({ hiddenAt: null, hiddenReason: null, reportCount: 0 }),
      { type: 'listing.restored' },
      'dismissed',
    );
  }

  // ------------------------------------------------------------------------------------------------- reports

  /**
   * A viewer reports a public listing (anonymous: the reporter is a keyed hash of the user or the client address,
   * one open report per reporter). The N-th open report hides the listing until a moderator decides.
   */
  async report(slug: string, input: { reason: ListingReportReason; details?: string | null }) {
    const ctx = RequestContext.current();
    const actor = userIdOf(RequestContext.actor());
    const who = actor ?? `${ctx?.ip ?? 'unknown'}|${ctx?.userAgent ?? ''}`;
    return this.db.platform(async (tx) => {
      const listing = await tx.listing.findUnique({ where: { slug } });
      if (!listing || listing.state !== 'published' || listing.hiddenAt)
        throw new DomainException('http.not_found');
      const reporterHash = this.hasher.secret('listing-report', `${listing.id}|${who}`);
      const open = await tx.listingReport.findFirst({
        where: { listingId: listing.id, reporterHash, state: 'open' },
        select: { id: true },
      });
      if (open) throw new DomainException('listing.report_duplicate');
      const now = this.clock.now();
      const report = await tx.listingReport.create({
        data: {
          listingId: listing.id,
          tenantId: listing.tenantId,
          reason: input.reason,
          details: input.details?.trim() || null,
          reporterUserId: actor,
          reporterHash,
        },
      });
      const count = await tx.listingReport.count({ where: { listingId: listing.id, state: 'open' } });
      const hideAfter = await this.settings.valueAt<number>('listing.report.hide_after', now);
      const hide = hideAfter > 0 && count >= hideAfter;
      await tx.listing.update({
        where: { id: listing.id },
        data: { reportCount: count, ...(hide ? { hiddenAt: now, hiddenReason: 'reports' } : {}) },
      });
      await this.audit.record(tx, {
        action: 'listing.reported',
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        subjectType: 'ops.listing',
        subjectId: listing.id,
        after: { reason: input.reason, openReports: count, hidden: hide },
      });
      await this.events.record(tx, {
        type: 'listing.reported',
        aggregateType: 'listing',
        aggregateId: listing.id,
        tenantId: listing.tenantId,
        buildingId: listing.buildingId,
        payload: { listingId: listing.id, reason: input.reason, openReports: count },
      });
      if (hide)
        await this.events.record(tx, {
          type: 'listing.hidden',
          aggregateType: 'listing',
          aggregateId: listing.id,
          tenantId: listing.tenantId,
          buildingId: listing.buildingId,
          payload: { listingId: listing.id, unitId: listing.unitId, reason: 'reports' },
        });
      return { id: report.id };
    });
  }

  // -------------------------------------------------------------------------------------------- verification

  async verifications(state: 'pending' | 'approved' | 'rejected' | undefined) {
    return this.db.platform((tx) =>
      tx.listingVerification.findMany({
        where: { state },
        include: {
          tenant: { select: { id: true, displayName: true } },
          unit: { select: { id: true, unitNo: true, building: { select: { id: true, name: true } } } },
        },
        orderBy: { submittedAt: 'asc' },
        take: 200,
      }),
    );
  }

  private readonly verificationInclude = {
    tenant: { select: { id: true, displayName: true } },
    unit: { select: { id: true, unitNo: true, building: { select: { id: true, name: true } } } },
  } as const;

  async verificationRow(id: string) {
    const row = await this.db.platform((tx) =>
      tx.listingVerification.findUnique({ where: { id }, include: this.verificationInclude }),
    );
    if (!row) throw new DomainException('http.not_found');
    return row;
  }

  /** One verification with short-lived download links of its evidence (every download audited, D-025). */
  async verification(id: string) {
    const row = await this.verificationRow(id);
    const evidence = row.evidencePurgedAt
      ? []
      : await this.db.platform(async (tx) => {
          const docs = await tx.document.findMany({
            where: { id: { in: row.evidenceDocumentIds }, deletedAt: null },
            select: { id: true, storageKey: true, title: true, mimeType: true },
          });
          const links = [];
          for (const doc of docs) {
            await this.audit.record(tx, {
              action: 'document.downloaded',
              tenantId: row.tenantId,
              subjectType: 'core.document',
              subjectId: doc.id,
              metadata: { purpose: 'listing_verification', verificationId: row.id },
            });
            const signed = await this.documents.signedUrl(doc);
            links.push({
              documentId: doc.id,
              mimeType: doc.mimeType,
              url: signed.url,
              expiresAt: signed.expiresAt,
            });
          }
          return links;
        });
    return { ...row, evidence };
  }

  async decideVerification(id: string, input: { approve: boolean; note?: string | null }) {
    const now = this.clock.now();
    const [makerChecker, retentionDays] = await Promise.all([
      this.settings.valueAt<boolean>('listing.verification.maker_checker', now),
      this.settings.valueAt<number>('listing.verification.evidence_retention_days', now),
    ]);
    return this.db.platform(async (tx) => {
      const row = await tx.listingVerification.findUnique({ where: { id } });
      if (!row) throw new DomainException('http.not_found');
      if (row.state !== 'pending') throw new DomainException('listing.verification_invalid_state');
      const by = this.by();
      if (!input.approve && !input.note?.trim())
        throw new DomainException('validation.failed', {
          errors: [{ path: 'note', code: 'required', message: 'a reason the owner will read' }],
        });
      // Maker-checker: the first approval records the reviewer; a different user confirms it.
      if (input.approve && makerChecker && !row.reviewedBy) {
        const updated = await tx.listingVerification.update({
          where: { id },
          data: { reviewedBy: by, decisionNote: input.note?.trim() || null, version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          action: 'listing.verification_decided',
          tenantId: row.tenantId,
          subjectType: 'platform.listing_verification',
          subjectId: id,
          after: { step: 'maker', approve: true },
        });
        return updated;
      }
      if (input.approve && makerChecker && row.reviewedBy === by)
        throw new DomainException('listing.checker_same_user');
      const state = input.approve ? 'approved' : 'rejected';
      const updated = await tx.listingVerification.update({
        where: { id },
        data: {
          state,
          decidedAt: now,
          reviewedBy: row.reviewedBy ?? by,
          checkedBy: input.approve && makerChecker ? by : null,
          decisionNote: input.note?.trim() || row.decisionNote,
          evidencePurgeAfter: new Date(now.getTime() + retentionDays * 86_400_000),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'listing.verification_decided',
        tenantId: row.tenantId,
        subjectType: 'platform.listing_verification',
        subjectId: id,
        before: { state: 'pending' },
        after: { state, note: input.note ?? null },
      });
      await this.events.record(tx, {
        type: 'listing.verification_decided',
        aggregateType: 'listing_verification',
        aggregateId: id,
        tenantId: row.tenantId,
        payload: { verificationId: id, unitId: row.unitId, state },
      });
      return updated;
    });
  }

  /** Maintenance job: deletes ownership evidence whose retention ended (O-018); the decision row stays. */
  async purgeEvidence(): Promise<number> {
    const now = this.clock.now();
    const due = await this.db.platform((tx) =>
      tx.listingVerification.findMany({
        where: { evidencePurgeAfter: { lte: now }, evidencePurgedAt: null },
        select: { id: true, tenantId: true, evidenceDocumentIds: true },
        take: 100,
      }),
    );
    for (const row of due) {
      try {
        await this.db.platform(async (tx) => {
          await tx.document.updateMany({
            where: { id: { in: row.evidenceDocumentIds }, deletedAt: null },
            data: { deletedAt: now, uploadState: 'deleted' },
          });
          await tx.listingVerification.update({ where: { id: row.id }, data: { evidencePurgedAt: now } });
          await this.audit.record(tx, {
            action: 'listing.verification_evidence_purged',
            tenantId: row.tenantId,
            subjectType: 'platform.listing_verification',
            subjectId: row.id,
            after: { documents: row.evidenceDocumentIds.length },
          });
        });
      } catch (error) {
        this.logger.error(`evidence purge of ${row.id} failed: ${(error as Error).message}`);
      }
    }
    return due.length;
  }
}

import { systemActor, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { TenantTx } from '@database/tenant-tx';
import { type DocumentKind, type StorageCategory } from '@generated/prisma/client';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DocumentsService } from '../documents/documents.service';
import { DomainEvents } from '../events/domain-events';
import { SettingsService } from '../settings/settings.service';
import { LegalHoldService } from './legal-hold.service';
import { type ReclaimRefusal, reclaimRefusal } from './storage-categories';

export const RECLAIM_REASON = 'reclaim';

export interface StoredFileRow {
  id: string;
  kind: DocumentKind;
  title: string | null;
  mimeType: string;
  category: StorageCategory;
  bytes: bigint;
  objects: number;
  createdAt: Date;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  held: boolean;
  retainUntil: string | null;
  deletable: boolean;
  notDeletableReason: ReclaimRefusal | null;
}

export interface FileListQuery {
  category?: StorageCategory;
  /** `active` (default) = counted and not deleted; `deleted` = deleted for reclaim, waiting for the purge. */
  state?: 'active' | 'deleted';
  sort?: 'size' | 'created';
  page: number;
  perPage: number;
}

interface RawFile {
  id: string;
  kind: DocumentKind;
  title: string | null;
  mime_type: string;
  category: StorageCategory;
  bytes: bigint;
  objects: number;
  created_at: Date;
  deleted_at: Date | null;
  held: boolean;
  retain_until: Date | null;
  on_live_listing: boolean;
  delete_reason: string | null;
  upload_state: string;
}

/**
 * Reclaiming space (D-285): the owner lists what takes the most space and deletes optional files it no longer needs.
 * A delete is soft (`deleted_at`, reason `reclaim`): the file still counts and can be restored for
 * `storage.reclaim.purge_after_days`; the purge job then removes its objects and the quota drops. Legal documents
 * (D-286), evidence, identity and system files, and photos of a live listing are never deleted here; a request with any
 * of them is refused as a whole.
 */
@Injectable()
export class StorageReclaimService {
  private readonly logger = new Logger('StorageReclaim');

  constructor(
    private readonly db: TenantTx,
    private readonly holds: LegalHoldService,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async purgeDays(at: Date): Promise<number> {
    return this.settings.valueAt<number>('storage.reclaim.purge_after_days', at);
  }

  private toRow(r: RawFile, purgeDays: number): StoredFileRow {
    const refusal = reclaimRefusal({
      kind: r.kind,
      category: r.category,
      held: r.held,
      onLiveListing: r.on_live_listing,
    });
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      mimeType: r.mime_type,
      category: r.category,
      bytes: r.bytes,
      objects: r.objects,
      createdAt: r.created_at,
      deletedAt: r.deleted_at,
      purgeAfter: r.deleted_at ? new Date(r.deleted_at.getTime() + purgeDays * 86_400_000) : null,
      held: r.held,
      retainUntil: r.retain_until ? r.retain_until.toISOString().slice(0, 10) : null,
      deletable: !r.deleted_at && refusal === null,
      notDeletableReason: r.deleted_at ? null : refusal,
    };
  }

  private query(today: string, where: string, tail = '', countedOnly = true) {
    return `SELECT d.id, d.kind, d.title, d.mime_type, s.category, s.bytes, s.objects, d.created_at, d.deleted_at,
                   d.delete_reason, d.upload_state::text AS upload_state,
                   (h.id IS NOT NULL AND h.released_at IS NULL AND (h.retain_until IS NULL OR h.retain_until > '${today}'::date)) AS held,
                   h.retain_until,
                   EXISTS (SELECT 1 FROM ops.listing_photo lp JOIN ops.listing l ON l.id = lp.listing_id
                            WHERE lp.document_id = d.id AND l.state IN ('draft', 'pending_review', 'published', 'paused')) AS on_live_listing
              FROM platform.document_storage s
              JOIN core.document d ON d.id = s.document_id
              LEFT JOIN platform.document_legal_hold h ON h.document_id = d.id
             WHERE s.tenant_id = $1::uuid ${countedOnly ? 'AND s.counted' : ''} ${where} ${tail}`;
  }

  /** The tenant's counted files, largest first by default (bytes include thumbnails and renditions). */
  async list(ctx: TenantContext, q: FileListQuery): Promise<{ rows: StoredFileRow[]; total: number }> {
    const now = this.clock.now();
    const today = bangkokDate(now);
    const days = await this.purgeDays(now);
    const params: unknown[] = [ctx.tenantId];
    let where =
      q.state === 'deleted'
        ? `AND d.deleted_at IS NOT NULL AND d.delete_reason = '${RECLAIM_REASON}'`
        : 'AND d.deleted_at IS NULL';
    if (q.category) {
      params.push(q.category);
      where += ` AND s.category = $${params.length}::platform.storage_category`;
    }
    const order = q.sort === 'created' ? 'd.created_at DESC, d.id' : 's.bytes DESC, d.id';
    return this.db.tenant(ctx, async (tx) => {
      const rows = await tx.$queryRawUnsafe<RawFile[]>(
        this.query(today, where, `ORDER BY ${order} LIMIT ${q.perPage} OFFSET ${(q.page - 1) * q.perPage}`),
        ...params,
      );
      const count = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM platform.document_storage s JOIN core.document d ON d.id = s.document_id
          WHERE s.tenant_id = $1::uuid AND s.counted ${where}`,
        ...params,
      );
      return { rows: rows.map((r) => this.toRow(r, days)), total: count[0]?.n ?? 0 };
    });
  }

  private async load(ctx: TenantContext, ids: string[]) {
    const today = bangkokDate(this.clock.now());
    return this.db.tenant(ctx, (tx) =>
      tx.$queryRawUnsafe<RawFile[]>(
        this.query(today, 'AND d.id = ANY($2::uuid[])', '', false),
        ctx.tenantId,
        ids,
      ),
    );
  }

  /** Soft-deletes optional files to reclaim space (all or nothing); they count until the purge. */
  async delete(ctx: TenantContext, ids: string[]): Promise<StoredFileRow[]> {
    const unique = [...new Set(ids)];
    const found = await this.load(ctx, unique);
    if (found.length !== unique.length) throw new DomainException('http.not_found');
    const held = found.filter((f) => f.held && !f.deleted_at).map((f) => f.id);
    if (held.length)
      throw new DomainException('storage.legal_hold', { extensions: { heldDocumentIds: held } });
    const refused = found
      .filter((f) => !f.deleted_at)
      .map((f) => ({
        f,
        why: reclaimRefusal({
          kind: f.kind,
          category: f.category,
          held: f.held,
          onLiveListing: f.on_live_listing,
        }),
      }))
      .filter((x) => x.why !== null);
    if (refused.length)
      throw new DomainException('storage.not_deletable', {
        errors: refused.map(({ f, why }) => ({
          path: `documentIds[${unique.indexOf(f.id)}]`,
          code: why!,
          message: `${f.kind}: ${why}`,
        })),
      });
    const now = this.clock.now();
    const by = userIdOf(RequestContext.actor());
    const todo = found.filter((f) => !f.deleted_at).map((f) => f.id);
    await this.db.tenant(ctx, async (tx) => {
      // re-checked under the transaction: a hold placed meanwhile wins (D-286)
      const nowHeld = await this.holds.heldAmong(tx, todo, now);
      if (nowHeld.length)
        throw new DomainException('storage.legal_hold', { extensions: { heldDocumentIds: nowHeld } });
      if (todo.length)
        await tx.document.updateMany({
          where: { id: { in: todo }, tenantId: ctx.tenantId, deletedAt: null },
          data: { deletedAt: now, deletedBy: by, deleteReason: RECLAIM_REASON, updatedBy: by },
        });
      const bytes = found.filter((f) => todo.includes(f.id)).reduce((sum, f) => sum + f.bytes, 0n);
      await this.audit.record(tx, {
        action: 'storage.files_deleted',
        tenantId: ctx.tenantId,
        subjectType: 'core.document',
        subjectId: todo[0] ?? unique[0]!,
        after: { documentIds: todo, bytes: bytes.toString() },
      });
      await this.events.record(tx, {
        type: 'storage.files_deleted',
        aggregateType: 'tenant',
        aggregateId: ctx.tenantId,
        tenantId: ctx.tenantId,
        payload: { documentIds: todo, bytes: bytes.toString() },
      });
    });
    const days = await this.purgeDays(now);
    return (await this.load(ctx, unique)).map((r) => this.toRow(r, days));
  }

  /** Restores files deleted for reclaim that are not purged yet. */
  async restore(ctx: TenantContext, ids: string[]): Promise<StoredFileRow[]> {
    const unique = [...new Set(ids)];
    const found = await this.load(ctx, unique);
    if (found.length !== unique.length) throw new DomainException('http.not_found');
    const bad = found.filter(
      (f) => f.deleted_at && (f.delete_reason !== RECLAIM_REASON || f.upload_state === 'deleted'),
    );
    if (bad.length)
      throw new DomainException('storage.not_restorable', {
        errors: bad.map((f) => ({
          path: `documentIds[${unique.indexOf(f.id)}]`,
          code: 'not_reclaimed',
          message: f.id,
        })),
      });
    const todo = found.filter((f) => f.deleted_at).map((f) => f.id);
    const by = userIdOf(RequestContext.actor());
    await this.db.tenant(ctx, async (tx) => {
      if (todo.length)
        await tx.document.updateMany({
          where: {
            id: { in: todo },
            tenantId: ctx.tenantId,
            deleteReason: RECLAIM_REASON,
            uploadState: { not: 'deleted' },
          },
          data: { deletedAt: null, deletedBy: null, deleteReason: null, updatedBy: by },
        });
      await this.audit.record(tx, {
        action: 'storage.files_restored',
        tenantId: ctx.tenantId,
        subjectType: 'core.document',
        subjectId: todo[0] ?? unique[0]!,
        after: { documentIds: todo },
      });
      await this.events.record(tx, {
        type: 'storage.files_restored',
        aggregateType: 'tenant',
        aggregateId: ctx.tenantId,
        tenantId: ctx.tenantId,
        payload: { documentIds: todo },
      });
    });
    const days = await this.purgeDays(this.clock.now());
    return (await this.load(ctx, unique)).map((r) => this.toRow(r, days));
  }

  /**
   * Maintenance: removes the objects of files deleted for reclaim longer than the purge window (the quota drops);
   * one transaction per file; a file that came under a hold meanwhile is left alone. Runs as gp_platform.
   */
  async purge(limit = 200): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - (await this.purgeDays(now)) * 86_400_000);
    const due = await this.db.platform((tx) =>
      tx.document.findMany({
        where: {
          deleteReason: RECLAIM_REASON,
          deletedAt: { lte: cutoff },
          uploadState: { in: ['uploaded', 'verified'] },
          tenantId: { not: null },
        },
        select: { id: true, tenantId: true, storageKey: true, thumbnailKey: true, deletedAt: true },
        take: limit,
      }),
    );
    let purged = 0;
    await RequestContext.run({ actor: systemActor('storage-reclaim') }, async () => {
      for (const doc of due) {
        try {
          // the objects go only after the guarded row update committed (G review #7)
          const keys: string[] = [];
          await this.db.platform(
            async (tx) => {
              if ((await this.holds.heldAmong(tx, [doc.id], now)).length) return;
              keys.push(...(await this.documents.purgeStored(tx, doc, { at: now, reason: RECLAIM_REASON })));
              await this.events.record(tx, {
                type: 'storage.file_purged',
                aggregateType: 'document',
                aggregateId: doc.id,
                tenantId: doc.tenantId,
                payload: { documentId: doc.id },
              });
              purged += 1;
            },
            { tenantId: doc.tenantId! },
          );
          await this.documents.deleteObjects(keys);
        } catch (error) {
          this.logger.error(`purge of ${doc.id} failed: ${(error as Error).message}`);
        }
      }
    });
    return purged;
  }
}

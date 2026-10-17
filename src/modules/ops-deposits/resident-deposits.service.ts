import { DomainException } from '@common/errors/domain.exception';
import { DocumentsService } from '@core/documents/documents.service';
import { TenantTx } from '@database/tenant-tx';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import { Injectable } from '@nestjs/common';

import { DEPOSIT_INCLUDE, type DepositRow, DepositsService } from './deposits.service';

/** At most this many photos on a dispute (LIFF #9). */
export const MAX_DISPUTE_PHOTOS = 6;
/** Dispute photos: images up to 10 MB (LIFF #9). */
export const DISPUTE_PHOTO_MAX_BYTES = 10_000_000;

/**
 * The resident side of deposits (`/v1/resident/deposits*`, D-023): the deposit and settlement of my leases (lease
 * scope + party link, like the lease views), the itemised deductions with 5-minute links to their evidence photos and
 * to the move-in photos of the same checklist item, and my answer to a proposal — accept, or dispute with a reason
 * and up to 6 photos I uploaded (`POST /v1/resident/uploads`, D-203) (lessee or co-tenant only).
 */
@Injectable()
export class ResidentDepositsService {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: ResidentLeasesService,
    private readonly deposits: DepositsService,
    private readonly documents: DocumentsService,
  ) {}

  /** Deposits of every lease I can open (my leases list, D-061). */
  async list() {
    const { rows } = await this.leases.listWithParties();
    const leaseIds = rows.map((l) => l.id);
    if (!leaseIds.length) return [];
    return this.db.platform((tx) =>
      tx.deposit.findMany({
        where: { leaseId: { in: leaseIds } },
        include: DEPOSIT_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  private async access(depositId: string) {
    const found = await this.db.platform((tx) =>
      tx.deposit.findUnique({ where: { id: depositId }, select: { leaseId: true } }),
    );
    if (!found) throw new DomainException('http.not_found');
    return { ...(await this.leases.access(found.leaseId)), depositId };
  }

  private signerOf(a: Awaited<ReturnType<ResidentDepositsService['access']>>) {
    const signer = a.lease.parties.find(
      (p) => ['lessee', 'co_tenant'].includes(p.role) && a.partyIds.includes(p.partyId),
    );
    if (!signer) throw new DomainException('lease.not_signer');
    return signer;
  }

  /**
   * One deposit with signed links to the evidence of each deduction and to the move-in photos of the same
   * checklist item (move-out line → its item key → the move-in inspection of the settlement).
   */
  async get(depositId: string): Promise<{
    deposit: DepositRow;
    evidence: Map<string, string[]>;
    before: Map<string, string[]>;
  }> {
    const a = await this.access(depositId);
    const deposit = await this.deposits.get(a.ctx, depositId);
    const items = deposit.settlement?.items ?? [];
    const moveInId = deposit.settlement?.moveInInspectionId ?? null;
    const lineIds = items.map((i) => i.inspectionItemId).filter((x): x is string => Boolean(x));
    const { lines, moveIn } = await this.db.tenant(a.ctx, async (tx) => ({
      lines: lineIds.length
        ? await tx.inspectionItem.findMany({
            where: { id: { in: lineIds } },
            select: { id: true, itemKey: true },
          })
        : [],
      moveIn: moveInId
        ? await tx.inspectionItem.findMany({
            where: { inspectionId: moveInId },
            select: { itemKey: true, photoDocumentIds: true },
          })
        : [],
    }));
    const keyOfLine = new Map(lines.map((l) => [l.id, l.itemKey]));
    const moveInPhotos = new Map(moveIn.map((m) => [m.itemKey, m.photoDocumentIds]));
    const beforeIds = new Map(
      items.map((i) => [
        i.id,
        i.inspectionItemId ? (moveInPhotos.get(keyOfLine.get(i.inspectionItemId) ?? '') ?? []) : [],
      ]),
    );
    const ids = [
      ...new Set([...items.flatMap((i) => i.evidenceDocumentIds), ...[...beforeIds.values()].flat()]),
    ];
    const docs = ids.length
      ? await this.db.tenant(a.ctx, (tx) =>
          tx.document.findMany({ where: { id: { in: ids }, deletedAt: null } }),
        )
      : [];
    const urls = new Map<string, string>();
    for (const d of docs) urls.set(d.id, (await this.documents.signedUrl(d)).url);
    const linksOf = (list: string[]) => list.map((id) => urls.get(id)).filter((u): u is string => Boolean(u));
    return {
      deposit,
      evidence: new Map(items.map((i) => [i.id, linksOf(i.evidenceDocumentIds)])),
      before: new Map(items.map((i) => [i.id, linksOf(beforeIds.get(i.id) ?? [])])),
    };
  }

  /**
   * `POST /v1/resident/uploads` (purpose `deposit_dispute`, LIFF #9): a 15-minute PUT URL for a photo of the unit,
   * while the settlement waits for my answer. The file is an `inspection_photo` of the unit created by me, scanned
   * like every upload; it is attached when I dispute.
   */
  async presignDisputePhoto(
    depositId: string,
    input: { contentType: string; sizeBytes: number; sha256: string },
  ) {
    const a = await this.access(depositId);
    this.signerOf(a);
    const deposit = await this.deposits.get(a.ctx, depositId);
    if (deposit.settlement?.status !== 'proposed')
      throw new DomainException('deposit.invalid_state', {
        params: { status: deposit.settlement?.status ?? deposit.status },
      });
    if (input.sizeBytes > DISPUTE_PHOTO_MAX_BYTES)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'sizeBytes', code: 'max', message: `at most ${DISPUTE_PHOTO_MAX_BYTES} bytes` }],
      });
    const ext = input.contentType.split('/')[1] ?? 'jpg';
    return this.documents.presign(a.ctx, {
      kind: 'inspection_photo',
      scopeType: 'unit',
      scopeId: a.lease.unitId,
      fileName: `dispute-${deposit.lease.unit.unitNo}.${ext}`,
      title: `ภาพประกอบการโต้แย้งเงินประกัน ${deposit.lease.unit.unitNo}`,
      mimeType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
    });
  }

  /** Photos of a dispute: mine (created by my login), of this unit, uploaded; completed here when still presigned. */
  private async disputePhotos(
    a: Awaited<ReturnType<ResidentDepositsService['access']>>,
    ids: string[],
  ): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_DISPUTE_PHOTOS)
      throw new DomainException('validation.failed', {
        errors: [{ path: 'photoDocumentIds', code: 'max', message: `at most ${MAX_DISPUTE_PHOTOS} photos` }],
      });
    if (!unique.length) return [];
    const userId = this.leases.currentUserId();
    const docs = await this.db.tenant(a.ctx, (tx) =>
      tx.document.findMany({
        where: {
          id: { in: unique },
          tenantId: a.ctx.tenantId,
          deletedAt: null,
          kind: 'inspection_photo',
          scopeType: 'unit',
          scopeId: a.lease.unitId,
          createdBy: userId,
        },
      }),
    );
    if (docs.length !== unique.length)
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'photoDocumentIds',
            code: 'notMine',
            message: 'photos must be my uploads for this deposit (POST /v1/resident/uploads)',
          },
        ],
      });
    for (const d of docs) if (d.uploadState === 'presigned') await this.documents.complete(a.ctx, d.id, {});
    return unique;
  }

  async respond(
    depositId: string,
    input: { accept: boolean; reason?: string | null; photoDocumentIds?: string[] },
  ) {
    const a = await this.access(depositId);
    const signer = this.signerOf(a);
    if (!input.accept && !input.reason?.trim())
      throw new DomainException('validation.failed', {
        errors: [{ path: 'reason', code: 'required', message: 'say what you dispute' }],
      });
    const documentIds = input.accept ? [] : await this.disputePhotos(a, input.photoDocumentIds ?? []);
    await this.deposits.respond(a.ctx, depositId, {
      accept: input.accept,
      reason: input.reason ?? null,
      partyId: signer.partyId,
      documentIds,
    });
    return this.get(depositId);
  }
}

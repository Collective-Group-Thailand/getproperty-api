import { DomainException } from '@common/errors/domain.exception';
import { AuditService } from '@core/audit/audit.service';
import { DocumentsService } from '@core/documents/documents.service';
import { TenantTx } from '@database/tenant-tx';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import { Injectable } from '@nestjs/common';

export type ResidentDocumentKind = 'lease_contract' | 'lease_notice' | 'deposit_statement' | 'receipt';

export interface ResidentDocument {
  documentId: string;
  tenantId: string;
  kind: ResidentDocumentKind;
  title: string;
  createdAt: Date;
  leaseId: string | null;
}

/**
 * "Documents on file" in the resident profile (LIFF #11, D-203), view only: for the parties linked to my login,
 * across tenants — the contract of each lease I can open (the signed copy once countersigned), the evidence of a
 * lease notice, deposit receipts and settlement statements, and the receipts issued to me. Downloads are 5-minute
 * signed URLs, audited like the contract download; a document outside that set is a 404.
 */
@Injectable()
export class ResidentDocumentsService {
  constructor(
    private readonly db: TenantTx,
    private readonly leases: ResidentLeasesService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ResidentDocument[]> {
    const { rows: leases, partyIds } = await this.leases.listWithParties();
    if (!partyIds.length) return [];
    return this.db.platform(async (tx) => {
      const out: Omit<ResidentDocument, 'createdAt'>[] = [];
      const leaseIds = leases.map((l) => l.id);
      for (const l of leases) {
        const contract = l.signedDocumentId ?? l.contractDocumentId;
        if (contract)
          out.push({
            documentId: contract,
            tenantId: l.tenantId,
            kind: 'lease_contract',
            title: `สัญญาเช่า ${l.number ?? ''} ห้อง ${l.unit.unitNo}`.trim(),
            leaseId: l.id,
          });
        for (const id of l.noticeEvidenceDocumentIds)
          out.push({
            documentId: id,
            tenantId: l.tenantId,
            kind: 'lease_notice',
            title: `หนังสือบอกเลิกสัญญา ${l.number ?? ''} ห้อง ${l.unit.unitNo}`.trim(),
            leaseId: l.id,
          });
      }
      const deposits = leaseIds.length
        ? await tx.deposit.findMany({
            where: { leaseId: { in: leaseIds } },
            include: { settlement: true, lease: { select: { unit: { select: { unitNo: true } } } } },
          })
        : [];
      for (const d of deposits) {
        if (d.receiptDocumentId)
          out.push({
            documentId: d.receiptDocumentId,
            tenantId: d.tenantId,
            kind: 'receipt',
            title: `ใบรับเงินประกัน ${d.receiptNumber ?? ''} ห้อง ${d.lease.unit.unitNo}`.trim(),
            leaseId: d.leaseId,
          });
        if (d.settlement?.statementDocumentId)
          out.push({
            documentId: d.settlement.statementDocumentId,
            tenantId: d.tenantId,
            kind: 'deposit_statement',
            title:
              `ใบแจ้งคืนเงินประกัน ${d.settlement.statementNumber ?? ''} ห้อง ${d.lease.unit.unitNo}`.trim(),
            leaseId: d.leaseId,
          });
      }
      const receipts = await tx.receipt.findMany({
        where: { payerPartyId: { in: partyIds }, documentId: { not: null }, voidedAt: null },
        include: { unit: { select: { unitNo: true } } },
        orderBy: { issuedAt: 'desc' },
        take: 200,
      });
      for (const r of receipts)
        out.push({
          documentId: r.documentId!,
          tenantId: r.tenantId,
          kind: 'receipt',
          title: `ใบเสร็จรับเงิน ${r.number}${r.unit ? ` ห้อง ${r.unit.unitNo}` : ''}`,
          leaseId: null,
        });
      const ids = [...new Set(out.map((o) => o.documentId))];
      const docs = new Map(
        (
          await tx.document.findMany({
            where: { id: { in: ids }, deletedAt: null, uploadState: { not: 'presigned' } },
            select: { id: true, createdAt: true },
          })
        ).map((d) => [d.id, d.createdAt]),
      );
      const seen = new Set<string>();
      return out
        .filter((o) => docs.has(o.documentId) && !seen.has(o.documentId) && seen.add(o.documentId))
        .map((o) => ({ ...o, createdAt: docs.get(o.documentId)! }))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    });
  }

  async download(documentId: string) {
    const entry = (await this.list()).find((d) => d.documentId === documentId);
    if (!entry) throw new DomainException('http.not_found');
    return this.db.platform(async (tx) => {
      const doc = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
      if (doc.scanStatus !== 'clean' && doc.scanStatus !== 'skipped')
        throw new DomainException('document.scan_pending');
      await this.audit.record(tx, {
        action: 'document.downloaded',
        tenantId: entry.tenantId,
        buildingId: doc.buildingId,
        subjectType: 'core.document',
        subjectId: doc.id,
        metadata: { kind: doc.kind, purpose: 'resident_documents', residentKind: entry.kind },
      });
      return { entry, ...(await this.documents.signedUrl(doc)) };
    });
  }
}

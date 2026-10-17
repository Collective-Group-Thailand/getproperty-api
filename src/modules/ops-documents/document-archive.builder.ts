import { createHash } from 'node:crypto';

import { startOfBangkokDay } from '@common/time/bangkok';
import { zip, type ZipEntry } from '@common/zip/zip';
import { DocumentsService } from '@core/documents/documents.service';
import { type Tx } from '@database/prisma.service';
import { type DocumentKind, type ExportJob } from '@generated/prisma/client';
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { BillingDocuments } from './billing-documents.service';
import { type ExportBuilder, type ExportFile, ExportsService } from './exports.service';

const FOLDER: Partial<Record<DocumentKind, string>> = {
  pdf_invoice: 'invoices',
  pdf_note: 'credit-debit-notes',
  pdf_receipt: 'receipts',
  pdf_tax_invoice: 'tax-invoices',
  pdf_statement: 'deposit-statements',
  pdf_report: 'reports',
  contract: 'contracts',
};
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `document_archive_zip` (B4.3, D-050): every financial document the tenant generated in a Bangkok month — invoices
 * (A4, missing PDFs generated first), credit/debit notes, receipts, tax invoices, deposit receipts and statements,
 * signed contracts, inspection reports — in one ZIP with an `index.csv` (folder, file, sha256). Params
 * `{ period: 'YYYY-MM', buildingId? }`.
 */
@Injectable()
export class DocumentArchiveBuilder implements ExportBuilder, OnModuleInit {
  readonly kind = 'document_archive_zip' as const;

  constructor(
    private readonly exports: ExportsService,
    private readonly billing: BillingDocuments,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.exports.register(this);
  }

  validate(params: Record<string, unknown>) {
    const problems: { path: string; message: string }[] = [];
    if (typeof params.period !== 'string' || !MONTH.test(params.period))
      problems.push({ path: 'period', message: 'a month YYYY-MM' });
    if (
      params.buildingId !== undefined &&
      (typeof params.buildingId !== 'string' || !UUID.test(params.buildingId))
    )
      problems.push({ path: 'buildingId', message: 'a building id' });
    return problems;
  }

  async build(tx: Tx, job: ExportJob): Promise<ExportFile> {
    const period = (job.params as { period: string }).period;
    const [y, m] = period.split('-').map(Number) as [number, number];
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const from = startOfBangkokDay(`${period}-01`);
    const to = startOfBangkokDay(next);
    const scope = { tenantId: job.tenantId, ...(job.buildingId ? { buildingId: job.buildingId } : {}) };
    // invoices issued in the month always have their PDF in the archive
    const issued = await tx.invoice.findMany({
      where: { ...scope, issuedAt: { gte: from, lt: to }, documentId: null },
      select: { id: true },
    });
    for (const i of issued) await this.billing.generateInvoice(tx, i.id);
    const docs = await tx.document.findMany({
      where: {
        ...scope,
        kind: { in: Object.keys(FOLDER) as DocumentKind[] },
        createdAt: { gte: from, lt: to },
        deletedAt: null,
        uploadState: 'verified',
        versionOfDocumentId: null,
      },
      orderBy: [{ kind: 'asc' }, { title: 'asc' }, { createdAt: 'asc' }],
    });
    const entries: ZipEntry[] = [];
    const index = ['folder,file,sha256,document_id'];
    const used = new Set<string>();
    for (const d of docs) {
      const folder = FOLDER[d.kind] ?? 'other';
      let name = `${folder}/${(d.title ?? d.id).replace(/[\\/:*?"<>|]/g, '_')}`;
      if (!name.toLowerCase().endsWith('.pdf') && d.mimeType === 'application/pdf') name += '.pdf';
      if (used.has(name)) name = name.replace(/(\.pdf)?$/i, `-${d.id.slice(-6)}$1`);
      used.add(name);
      const data = await this.documents.bytesOf(d);
      entries.push({ name, data });
      index.push(
        [folder, name.slice(folder.length + 1), createHash('sha256').update(data).digest('hex'), d.id]
          .map((v) => `"${v.replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    entries.unshift({ name: 'index.csv', data: Buffer.from(`\uFEFF${index.join('\r\n')}\r\n`, 'utf8') });
    return {
      fileName: `documents-${period}${job.buildingId ? `-${job.buildingId.slice(0, 8)}` : ''}.zip`,
      mimeType: 'application/zip',
      body: zip(entries),
      rowCount: docs.length,
    };
  }
}

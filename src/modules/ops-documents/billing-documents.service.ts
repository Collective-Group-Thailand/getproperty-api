import { htmlToText } from '@common/text/html-text';
import { AppConfig } from '@config/app-config';
import { DocumentsService } from '@core/documents/documents.service';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { type Document } from '@generated/prisma/client';
import { PDF_RENDERER, type PdfRendererPort } from '@integrations/pdf/pdf-renderer.port';
import { fonts } from '@modules/ops-leases/contract-renderer';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type Handlebars from 'handlebars';
import QRCode from 'qrcode';

import { hbs, type Paper, STYLE_80MM, STYLE_A4, templateFor } from './billing-templates';
import {
  type DocumentView,
  type InvoiceSnapshot,
  type InvoiceView,
  invoiceView,
  type NoteView,
  noteView,
} from './document-views';

const compiled = new Map<string, Handlebars.TemplateDelegate>();
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Billing documents (B4.3, D-050): Handlebars → HTML with embedded Thai fonts → PDF (A4, or the 80 mm roll for
 * invoices and receipts). Invoices render from their issue snapshot. `generateInvoice` / `generateNote` store the
 * A4 PDF once (`core.document`, kinds `pdf_invoice` / `pdf_note`) and link it to the row (`document_id` may be set
 * once on an issued invoice); the thermal copy is stored as a version of the A4 document on first request.
 */
@Injectable()
export class BillingDocuments {
  constructor(
    @Inject(PDF_RENDERER) private readonly renderer: PdfRendererPort,
    private readonly documents: DocumentsService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------------------------------- rendering (pure)

  body(view: DocumentView, paper: Paper): string {
    const t = templateFor(view.docType, paper);
    const id = `${t.key}@${t.version}`;
    let fn = compiled.get(id);
    if (!fn) {
      fn = hbs.compile(t.source, { strict: false });
      compiled.set(id, fn);
    }
    return fn(view);
  }

  html(view: DocumentView, paper: Paper): string {
    const title = hbs.Utils.escapeExpression(`${view.title} ${view.number}`);
    const style = paper === 'thermal_80mm' ? STYLE_80MM : STYLE_A4;
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${title}</title><style>${fonts()}\n${style}</style></head><body>${this.body(view, paper)}</body></html>`;
  }

  /** The canonical text of a document (snapshot tests, the fake PDF). */
  text(view: DocumentView, paper: Paper = 'a4'): string {
    return htmlToText(this.body(view, paper).replace(/<img\b[^>]*>/gi, ''));
  }

  pdf(view: DocumentView, paper: Paper = 'a4'): Promise<Buffer> {
    return this.renderer.render(this.html(view, paper), {
      title: `${view.title} ${view.number}`,
      footer: `${view.title} เลขที่ ${view.number} · ${view.issuer.displayName}`,
      paper,
    });
  }

  // ------------------------------------------------------------------------------------------- views

  invoiceLink(invoiceId: string): string {
    return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/invoices/${invoiceId}`;
  }

  private async logo(tx: Tx, tenantId: string): Promise<string | null> {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, include: { logoDocument: true } });
    const doc = tenant?.logoDocument;
    if (!doc || doc.deletedAt || !IMAGE_MIME.includes(doc.mimeType) || doc.scanStatus === 'infected')
      return null;
    const bytes = await this.documents.bytesOf(doc).catch(() => null);
    return bytes ? `data:${doc.mimeType};base64,${bytes.toString('base64')}` : null;
  }

  async invoiceViewOf(
    tx: Tx,
    inv: {
      id: string;
      tenantId: string;
      snapshot: unknown;
      qrPayload: string | null;
      promptpayRef: string | null;
    },
  ): Promise<InvoiceView> {
    if (!inv.snapshot || !(inv.snapshot as { number?: string }).number)
      throw new RangeError(`invoice ${inv.id} has no issue snapshot`);
    return invoiceView(inv.snapshot as InvoiceSnapshot, {
      logoDataUrl: await this.logo(tx, inv.tenantId),
      qrDataUrl: inv.qrPayload ? await QRCode.toDataURL(inv.qrPayload, { margin: 1, width: 360 }) : null,
      promptpayRef: inv.promptpayRef,
      link: this.invoiceLink(inv.id),
    });
  }

  async noteViewOf(
    tx: Tx,
    kind: 'credit' | 'debit',
    noteId: string,
  ): Promise<{ view: NoteView; row: NoteRow }> {
    const row: NoteRow =
      kind === 'credit'
        ? await tx.creditNote.findUniqueOrThrow({ where: { id: noteId }, include: NOTE_INCLUDE })
        : await tx.debitNote.findUniqueOrThrow({ where: { id: noteId }, include: NOTE_INCLUDE });
    const inv = await tx.invoice.findUniqueOrThrow({
      where: { id: row.invoiceId },
      include: {
        creditNotes: { where: { issuedAt: { lt: row.issuedAt } }, select: { total: true } },
        debitNotes: { where: { issuedAt: { lt: row.issuedAt } }, select: { total: true } },
      },
    });
    const sum = (rows: { total: { toString(): string } }[]) =>
      rows.reduce((s, n) => s.plus(n.total.toString()), new Decimal(0));
    const before = new Decimal(inv.total.toString()).plus(sum(inv.debitNotes)).minus(sum(inv.creditNotes));
    const view = noteView({
      kind,
      number: row.number,
      issuedAt: row.issuedAt.toISOString(),
      reason: row.reason,
      reasonText: row.reasonText,
      lines: row.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        amount: l.amount.toFixed(2),
      })),
      subtotal: row.subtotal.toFixed(2),
      vatAmount: row.vatAmount.toFixed(2),
      total: row.total.toFixed(2),
      invoice: inv.snapshot as unknown as InvoiceSnapshot,
      valueBefore: before.toFixed(2),
      logoDataUrl: await this.logo(tx, row.tenantId),
    });
    return { view, row };
  }

  // ------------------------------------------------------------------------------------------- generation

  /** The stored A4 PDF of an issued invoice (generated once, `document.generated`). */
  async generateInvoice(tx: Tx, invoiceId: string): Promise<Document> {
    // one generator at a time per invoice (worker subscriber vs an on-demand download): document_id is set once
    await tx.$queryRaw`SELECT id FROM ops.invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { document: true } });
    if (inv.document) return inv.document;
    if (!inv.issuedAt || !inv.number) throw new RangeError(`invoice ${invoiceId} is not issued`);
    const view = await this.invoiceViewOf(tx, inv);
    const doc = await this.documents.storeGenerated(tx, {
      tenantId: inv.tenantId,
      kind: 'pdf_invoice',
      scopeType: inv.unitId ? 'unit' : 'building',
      scopeId: inv.unitId ?? inv.buildingId,
      buildingId: inv.buildingId,
      title: `${view.title} ${inv.number}.pdf`,
      mimeType: 'application/pdf',
      body: await this.pdf(view, 'a4'),
    });
    await tx.invoice.update({ where: { id: invoiceId }, data: { documentId: doc.id } });
    await this.generated(tx, doc, {
      docType: 'invoice',
      subjectId: invoiceId,
      number: inv.number,
      paper: 'a4',
    });
    return doc;
  }

  /** The 80 mm copy of an issued invoice, stored as a version of its A4 document on first request. */
  async thermalInvoice(tx: Tx, invoiceId: string): Promise<Document> {
    const a4 = await this.generateInvoice(tx, invoiceId);
    const existing = await tx.document.findFirst({
      where: { versionOfDocumentId: a4.id, title: { endsWith: '(80mm).pdf' }, deletedAt: null },
    });
    if (existing) return existing;
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const view = await this.invoiceViewOf(tx, inv);
    const doc = await this.documents.storeGenerated(tx, {
      tenantId: inv.tenantId,
      kind: 'pdf_invoice',
      scopeType: a4.scopeType,
      scopeId: a4.scopeId,
      buildingId: inv.buildingId,
      title: `${view.title} ${inv.number} (80mm).pdf`,
      mimeType: 'application/pdf',
      body: await this.pdf(view, 'thermal_80mm'),
      versionOfDocumentId: a4.id,
    });
    await this.generated(tx, doc, {
      docType: 'invoice',
      subjectId: invoiceId,
      number: inv.number!,
      paper: 'thermal_80mm',
    });
    return doc;
  }

  async generateNote(tx: Tx, kind: 'credit' | 'debit', noteId: string): Promise<Document> {
    if (kind === 'credit')
      await tx.$queryRaw`SELECT id FROM ops.credit_note WHERE id = ${noteId}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM ops.debit_note WHERE id = ${noteId}::uuid FOR UPDATE`;
    const { view, row } = await this.noteViewOf(tx, kind, noteId);
    if (row.documentId) return tx.document.findUniqueOrThrow({ where: { id: row.documentId } });
    const doc = await this.documents.storeGenerated(tx, {
      tenantId: row.tenantId,
      kind: 'pdf_note',
      scopeType: row.unitId ? 'unit' : 'building',
      scopeId: row.unitId ?? row.buildingId,
      buildingId: row.buildingId,
      title: `${view.title} ${row.number}.pdf`,
      mimeType: 'application/pdf',
      body: await this.pdf(view, 'a4'),
    });
    if (kind === 'credit')
      await tx.creditNote.update({ where: { id: noteId }, data: { documentId: doc.id } });
    else await tx.debitNote.update({ where: { id: noteId }, data: { documentId: doc.id } });
    await this.generated(tx, doc, {
      docType: view.docType,
      subjectId: noteId,
      number: row.number,
      paper: 'a4',
    });
    return doc;
  }

  private async generated(
    tx: Tx,
    doc: Document,
    p: { docType: string; subjectId: string; number: string; paper: Paper },
  ): Promise<void> {
    await this.events.record(tx, {
      type: 'document.generated',
      aggregateType: 'document',
      aggregateId: doc.id,
      tenantId: doc.tenantId,
      buildingId: doc.buildingId,
      payload: { documentId: doc.id, ...p },
    });
  }
}

const NOTE_INCLUDE = { lines: { orderBy: { lineNo: 'asc' } } } as const;
type NoteRow = {
  id: string;
  tenantId: string;
  buildingId: string;
  unitId: string | null;
  invoiceId: string;
  number: string;
  documentId: string | null;
  reason: string;
  reasonText: string;
  subtotal: Money;
  vatAmount: Money;
  total: Money;
  issuedAt: Date;
  lines: { lineNo: number; description: string; amount: Money }[];
};
type Money = { toFixed(dp: number): string };

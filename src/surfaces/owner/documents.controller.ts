import { AllowWhenReadOnly, CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiAsync,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { monthWindow } from '@core/compliance/compliance-score.service';
import { BillingDocuments } from '@modules/ops-documents/billing-documents.service';
import { templateFor } from '@modules/ops-documents/billing-templates';
import { type ExportJobRow, ExportsService } from '@modules/ops-documents/exports.service';
import { type DocumentLink, InvoiceDocumentsService } from '@modules/ops-documents/invoice-documents.service';
import { sampleView } from '@modules/ops-documents/sample-documents';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { type DocumentKindName } from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';
import { DocumentDownloadDto } from './deposits.dto';
import {
  DocumentPaperQuery,
  DocumentTemplatePreviewDto,
  DocumentTemplatePreviewResultDto,
  ExportCreateDto,
  ExportJobDto,
  type ExportKindName,
  ExportListQuery,
  type ExportParamsDto,
  type ExportStatusName,
  FinancialDocumentDto,
  FinancialDocumentListQuery,
  InvoiceDeliveriesDto,
  InvoiceDeliveryKindName,
  InvoiceDeliveryStatusName,
  ResendResultDto,
} from './documents.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', 'asset.read_only', ...T] as const;

const linkDto = (l: DocumentLink): DocumentDownloadDto => ({
  documentId: l.documentId,
  number: l.number,
  url: l.url,
  expiresAt: iso(l.expiresAt),
});
const DOWNLOAD_EXAMPLE: DocumentDownloadDto = {
  documentId: FAKE.uuid,
  number: 'INV-2026-00042',
  url: 'https://storage.example.com/invoice.pdf?X-Amz-Signature=abc',
  expiresAt: '2026-11-01T09:05:00+07:00',
};

export function exportDto(
  j: ExportJobRow,
  download: { url: string; expiresAt: Date } | null = null,
): ExportJobDto {
  return {
    id: j.id,
    kind: j.kind as ExportKindName,
    status: j.status as ExportStatusName,
    params: j.params as ExportParamsDto,
    buildingId: j.buildingId,
    rowCount: j.rowCount,
    error: j.error,
    requestedAt: iso(j.createdAt),
    finishedAt: isoOrNull(j.finishedAt),
    download: download ? { url: download.url, expiresAt: iso(download.expiresAt) } : null,
    version: j.version,
  };
}
export const EXPORT_EXAMPLE: ExportJobDto = {
  id: FAKE.uuid,
  kind: 'document_archive_zip' as ExportKindName,
  status: 'done' as ExportStatusName,
  params: { period: '2026-11' },
  buildingId: null,
  rowCount: 24,
  error: null,
  requestedAt: FAKE.dateTime,
  finishedAt: FAKE.dateTime,
  download: {
    url: 'https://storage.example.com/documents-2026-11.zip?X-Amz-Signature=abc',
    expiresAt: FAKE.dateTime,
  },
  version: 2,
};

// ------------------------------------------------------------------------------------------- owner documents

@ApiTags('owner.documents')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerBillingDocumentsController {
  constructor(private readonly docs: InvoiceDocumentsService) {}

  @Get('invoices/:invoiceId/document')
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.invoices.document',
    summary: 'Download an issued invoice (PDF)',
    description:
      'The invoice as issued (rendered from its snapshot, D-040): A4 with the tenant’s company data, the meter disclosure of every metered line (D-022), the VAT block only for VAT-registered tenants (O-004) and the Thai QR when payments are on (B4.4); `paper=thermal_80mm` for receipt printers. A 5-minute link.',
    implements: ['D-050', 'D-022', 'D-040'],
  })
  @ApiSuccess(200, { description: 'Link', type: DocumentDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('invoice.invalid_state', 'http.not_found', 'validation.failed', ...T)
  async invoice(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Query() q: DocumentPaperQuery,
  ): Promise<DocumentDownloadDto> {
    return linkDto(await this.docs.invoiceDocument(ctx, id, q.paper ?? 'a4'));
  }

  @Get('credit-notes/:noteId/document')
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.creditNotes.document',
    summary: 'Download a credit note (PDF)',
    description:
      'Credit note with the invoice it corrects, the original and corrected values and the difference (D-040, D-050).',
    implements: ['D-040', 'D-050'],
  })
  @ApiSuccess(200, {
    description: 'Link',
    type: DocumentDownloadDto,
    example: { ...DOWNLOAD_EXAMPLE, number: 'CRN-2026-00001' },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async creditNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('noteId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    return linkDto(await this.docs.noteDocument(ctx, 'credit', id));
  }

  @Get('debit-notes/:noteId/document')
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.debitNotes.document',
    summary: 'Download a debit note (PDF)',
    description:
      'Debit note with the invoice it corrects, the original and corrected values and the difference (D-040, D-050).',
    implements: ['D-040', 'D-050'],
  })
  @ApiSuccess(200, {
    description: 'Link',
    type: DocumentDownloadDto,
    example: { ...DOWNLOAD_EXAMPLE, number: 'DBN-2026-00001' },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async debitNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('noteId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    return linkDto(await this.docs.noteDocument(ctx, 'debit', id));
  }

  @Post('invoices/:invoiceId/actions/resend')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.invoices.resend',
    summary: 'Send the invoice to the payer again',
    description:
      'The invoice LINE Flex message (amount due, due date, link to view and pay) goes to the billed party again — quiet hours and consent apply; audited (D-011, D-025).',
    implements: ['D-011', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Queued',
    type: ResendResultDto,
    example: { invoiceId: FAKE.uuid, channel: 'line', requestedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('invoice.invalid_state', ...WRITE)
  async resend(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<ResendResultDto> {
    const r = await this.docs.resend(ctx, id);
    return { invoiceId: r.invoiceId, channel: 'line', requestedAt: iso(r.requestedAt) };
  }

  @Get('invoices/:invoiceId/deliveries')
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.invoices.deliveries',
    summary: 'Delivery log of an invoice',
    description:
      'Every message sent for the invoice, oldest first: the first send once it is payable (`issue`), the owner’s resends (`resend`) and the payment reminders (`reminder`), per channel (LINE, SMS, e-mail) with the delivery state and the failure reason (web F2; D-011, D-045, D-208). 404 for another tenant’s invoice.',
    implements: ['D-011', 'D-045', 'D-208'],
  })
  @ApiSuccess(200, {
    description: 'Deliveries',
    type: InvoiceDeliveriesDto,
    example: {
      data: [
        {
          id: FAKE.uuid,
          channel: 'line',
          kind: 'issue',
          status: 'delivered',
          at: FAKE.dateTime,
          error: null,
        },
        { id: FAKE.uuid, channel: 'line', kind: 'reminder', status: 'held', at: FAKE.dateTime, error: null },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async deliveries(
    @CurrentTenant() ctx: TenantContext,
    @Param('invoiceId', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDeliveriesDto> {
    const rows = await this.docs.deliveries(ctx, id);
    const kind = (type: string): InvoiceDeliveryKindName =>
      type === 'invoice.resent'
        ? InvoiceDeliveryKindName.Resend
        : type === 'invoice.reminder_sent'
          ? InvoiceDeliveryKindName.Reminder
          : InvoiceDeliveryKindName.Issue;
    const status = (state: string): InvoiceDeliveryStatusName => {
      switch (state) {
        case 'held_quiet_hours':
        case 'held_no_consent':
          return InvoiceDeliveryStatusName.Held;
        case 'read':
        case 'delivered':
          return InvoiceDeliveryStatusName.Delivered;
        default:
          return state as InvoiceDeliveryStatusName;
      }
    };
    return {
      data: rows.map((n) => ({
        id: n.id,
        channel: n.channel,
        kind: kind(n.event?.type ?? ''),
        status: status(n.state),
        at: iso(n.deliveredAt ?? n.sentAt ?? (n.state === 'failed' ? n.updatedAt : n.scheduledFor)),
        error: n.state === 'failed' || n.state === 'cancelled' ? n.failedReason : null,
      })),
    };
  }

  @Get('billing-documents')
  @TenantScoped()
  @Can('document.read')
  @ApiEndpoint({
    id: 'owner.billingDocuments.list',
    summary: 'Generated documents of a month',
    description:
      'Invoices, notes, receipts, tax invoices, deposit receipts and statements, contracts and reports generated in a Bangkok month — the archive view; download through `GET /v1/owner/files/{fileId}` or export the month as a ZIP (`POST /v1/owner/exports`, `document_archive_zip`, D-050).',
    implements: ['D-050', 'D-051'],
  })
  @ApiPaginated(FinancialDocumentDto, {
    example: {
      id: FAKE.uuid,
      kind: 'pdf_invoice' as DocumentKindName,
      title: 'ใบแจ้งหนี้ INV-2026-00042.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 48211,
      buildingId: FAKE.uuid,
      createdAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: FinancialDocumentListQuery,
  ): Promise<Page<FinancialDocumentDto>> {
    const w = monthWindow(q.period);
    const { rows, total } = await this.docs.list(ctx, {
      from: w.start,
      to: w.end,
      kind: q.kind,
      buildingId: q.buildingId,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((d) => ({
        id: d.id,
        kind: d.kind as DocumentKindName,
        title: d.title ?? d.id,
        mimeType: d.mimeType,
        sizeBytes: Number(d.sizeBytes ?? 0),
        buildingId: d.buildingId,
        createdAt: iso(d.createdAt),
      })),
      total,
      q,
    );
  }
}

// ------------------------------------------------------------------------------------------- exports

@ApiTags('owner.exports')
@ApiSurface(SURFACES.owner)
@Controller('owner/exports')
export class OwnerExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @HttpCode(202)
  @Idempotent()
  @TenantScoped()
  @AllowWhenReadOnly()
  @Can('export.create')
  @ApiAsync({ poll: 'owner.exports.get' })
  @ApiEndpoint({
    id: 'owner.exports.create',
    summary: 'Request an export',
    description:
      'Queued and built by the worker (D-051): `document_archive_zip` = every document generated in `params.period` as a ZIP with an index (B4.3); the Excel / FlowAccount / PEAK / VAT formats arrive with B4.5. Poll `GET /v1/owner/exports/{id}` for the link.',
    implements: ['D-051', 'D-050'],
  })
  @ApiJsonBody(ExportCreateDto, { kind: 'document_archive_zip', params: { period: '2026-11' } })
  @ApiSuccess(202, {
    description: 'Queued',
    type: ExportJobDto,
    example: {
      ...EXPORT_EXAMPLE,
      status: 'queued' as ExportStatusName,
      finishedAt: null,
      download: null,
      rowCount: null,
    },
  })
  @ApiStandardErrors(...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: ExportCreateDto): Promise<ExportJobDto> {
    return exportDto(
      await this.exports.request(ctx, {
        kind: body.kind,
        params: JSON.parse(JSON.stringify(body.params ?? {})) as Record<string, unknown>,
      }),
    );
  }

  @Get()
  @TenantScoped()
  @Can('export.create')
  @ApiEndpoint({
    id: 'owner.exports.list',
    summary: 'My exports',
    description: 'Export jobs, newest first, with their status (D-051).',
    implements: ['D-051'],
  })
  @ApiPaginated(ExportJobDto, { example: { ...EXPORT_EXAMPLE, download: null } })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: ExportListQuery): Promise<Page<ExportJobDto>> {
    const { rows, total } = await this.exports.list(ctx, { kind: q.kind, ...toSkipTake(q) });
    return paginated(
      rows.map((r) => exportDto(r)),
      total,
      q,
    );
  }

  @Get(':exportId')
  @TenantScoped()
  @Can('export.create')
  @ApiEndpoint({
    id: 'owner.exports.get',
    summary: 'One export (with its link when done)',
    description: 'Status, row count, failure reason, and a 5-minute download link once done (D-051).',
    implements: ['D-051'],
  })
  @ApiSuccess(200, { description: 'The export', type: ExportJobDto, example: EXPORT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('exportId', ParseUUIDPipe) id: string,
  ): Promise<ExportJobDto> {
    const job = await this.exports.get(ctx, id);
    if (job.status !== 'done') return exportDto(job);
    const { link } = await this.exports.download(ctx, id);
    return exportDto(job, link);
  }
}

// ------------------------------------------------------------------------------------------- resident

@ApiTags('resident.invoices')
@ApiSurface(SURFACES.resident)
@Controller('resident/invoices')
export class ResidentInvoiceDocumentsController {
  constructor(private readonly docs: InvoiceDocumentsService) {}

  @Get(':invoiceId/document')
  @ApiEndpoint({
    id: 'resident.invoices.document',
    summary: 'Download my invoice (PDF)',
    description:
      'The issued invoice as a PDF (A4 or the 80 mm roll), a 5-minute link; 404 when it is not mine (D-063).',
    implements: ['D-050', 'D-063', 'D-154'],
  })
  @ApiSuccess(200, { description: 'Link', type: DocumentDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('auth.unauthenticated', 'http.not_found', 'validation.failed')
  async document(
    @Param('invoiceId', ParseUUIDPipe) id: string,
    @Query() q: DocumentPaperQuery,
  ): Promise<DocumentDownloadDto> {
    return linkDto(await this.docs.residentInvoiceDocument(id, q.paper ?? 'a4'));
  }
}

// ------------------------------------------------------------------------------------------- admin preview

@ApiTags('admin.documentTemplates')
@ApiSurface(SURFACES.admin)
@Controller('admin/document-templates')
export class AdminDocumentTemplatesController {
  constructor(private readonly billing: BillingDocuments) {}

  @Post('preview')
  @HttpCode(200)
  @Can('admin.notification_template.manage')
  @ApiEndpoint({
    id: 'admin.documentTemplates.preview',
    summary: 'Preview a document template with sample data',
    description:
      'Renders the current template of a document type (invoice, credit/debit note, receipt, advance receipt, tax invoice, receipt-tax invoice) on A4 or the 80 mm roll with obviously fake data: the text and the PDF (D-050).',
    implements: ['D-050'],
  })
  @ApiJsonBody(DocumentTemplatePreviewDto, { sample: 'invoice', paper: 'a4' })
  @ApiSuccess(200, {
    description: 'Preview',
    type: DocumentTemplatePreviewResultDto,
    example: {
      templateKey: 'invoice_a4_th',
      templateVersion: 1,
      text: 'ใบแจ้งหนี้ …',
      pdfBase64: 'JVBERi0xLjQK',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request')
  async preview(@Body() body: DocumentTemplatePreviewDto): Promise<DocumentTemplatePreviewResultDto> {
    const view = sampleView(body.sample);
    const paper = body.paper ?? 'a4';
    let template: ReturnType<typeof templateFor>;
    try {
      template = templateFor(view.docType, paper);
    } catch {
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'paper', code: 'unsupported', message: 'the 80 mm roll exists for invoices and receipts' },
        ],
      });
    }
    const pdf = await this.billing.pdf(view, paper);
    return {
      templateKey: template.key,
      templateVersion: template.version,
      text: this.billing.text(view, paper),
      pdfBase64: pdf.toString('base64'),
    };
  }
}

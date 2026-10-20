import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type EtaxSubmission } from '@generated/prisma/client';
import { EtaxService } from '@modules/ops-etax/etax.service';
import { type Tm30Row, Tm30Service } from '@modules/ops-tm30/tm30.service';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  EtaxListQuery,
  type EtaxStatusName,
  type EtaxSubjectTypeName,
  EtaxSubmissionDto,
  EtaxSummaryDto,
  EtaxSummaryQuery,
  Tm30CancelDto,
  Tm30ExportDto,
  Tm30FileDto,
  Tm30GenerateDto,
  Tm30ListQuery,
  type Tm30StatusName,
  Tm30SubmittedDto,
} from './etax-tm30.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const W = ['validation.failed', 'http.bad_request', 'http.not_found', 'tenant.read_only', ...T] as const;

const etaxDto = (s: EtaxSubmission): EtaxSubmissionDto => ({
  nextActions: s.status === 'rejected' || s.status === 'failed' ? ['retry'] : [],
  id: s.id,
  buildingId: s.buildingId,
  subjectType: s.subjectType as EtaxSubjectTypeName,
  subjectId: s.subjectId,
  number: s.number,
  documentTypeCode: s.documentTypeCode,
  issuedAt: iso(s.issuedAt),
  subtotal: s.subtotal.toFixed(2),
  vatAmount: s.vatAmount.toFixed(2),
  total: s.total.toFixed(2),
  provider: s.provider,
  providerDocId: s.providerDocId,
  status: s.status as EtaxStatusName,
  attempts: s.attempts,
  nextAttemptAt: isoOrNull(s.nextAttemptAt),
  sourceDocumentId: s.sourceDocumentId,
  signedPdfDocumentId: s.signedPdfDocumentId,
  signedXmlDocumentId: s.signedXmlDocumentId,
  submittedAt: isoOrNull(s.submittedAt),
  signedAt: isoOrNull(s.signedAt),
  error: s.error,
});

const ETAX_EXAMPLE = {
  nextActions: [],
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  subjectType: 'receipt',
  subjectId: FAKE.uuid,
  number: 'RC2611-0001',
  documentTypeCode: 'T01',
  issuedAt: FAKE.dateTime,
  subtotal: '4500.00',
  vatAmount: '0.00',
  total: '4500.00',
  provider: 'inet',
  providerDocId: 'TX-20261101-0001',
  status: 'signed',
  attempts: 1,
  nextAttemptAt: null,
  sourceDocumentId: FAKE.uuid,
  signedPdfDocumentId: FAKE.uuid,
  signedXmlDocumentId: FAKE.uuid,
  submittedAt: FAKE.dateTime,
  signedAt: FAKE.dateTime,
  error: null,
};

/** e-Tax Invoice & e-Receipt of my tenant (B6.2, D-050, D-215). */
@ApiTags('owner.etax')
@ApiSurface(SURFACES.owner)
@Controller('owner/etax')
export class OwnerEtaxController {
  constructor(private readonly etax: EtaxService) {}

  @Get('submissions')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.etax.list',
    summary: 'e-Tax submissions',
    description:
      'Receipts and receipt-tax invoices sent to my e-Tax service provider (VAT-registered tenants with `etax.enabled`), newest first: status, the provider’s reference, the signed PDF / XML and any error (D-050, D-215).',
    implements: ['D-050', 'D-215'],
  })
  @ApiPaginated(EtaxSubmissionDto, { example: ETAX_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: EtaxListQuery,
  ): Promise<Page<EtaxSubmissionDto>> {
    const { rows, total } = await this.etax.list(ctx, { ...q, ...toSkipTake(q) });
    return paginated(rows.map(etaxDto), total, q);
  }

  @Get('submissions/:submissionId')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.etax.get',
    summary: 'One e-Tax submission',
    description:
      'Status, provider reference, signed artefacts and the last error (D-215); another tenant’s is 404.',
    implements: ['D-215'],
  })
  @ApiSuccess(200, { description: 'The submission', type: EtaxSubmissionDto, example: ETAX_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('submissionId', ParseUUIDPipe) id: string,
  ): Promise<EtaxSubmissionDto> {
    return etaxDto(await this.etax.get(ctx, id));
  }

  @Post('submissions/:submissionId/actions/retry')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('receipt.issue')
  @ApiEndpoint({
    id: 'owner.etax.retry',
    summary: 'Send a rejected or failed document again',
    description:
      'After fixing what the provider refused (e.g. the buyer’s tax id): back to `queued` with the attempts reset and sent at once (409 `etax.invalid_state` unless rejected or failed). Audited (D-215).',
    implements: ['D-215'],
  })
  @ApiSuccess(200, {
    description: 'Queued again (or already submitted)',
    type: EtaxSubmissionDto,
    example: { ...ETAX_EXAMPLE, status: 'submitted', signedAt: null, signedPdfDocumentId: null },
  })
  @ApiStandardErrors(...W, 'etax.invalid_state')
  async retry(
    @CurrentTenant() ctx: TenantContext,
    @Param('submissionId', ParseUUIDPipe) id: string,
  ): Promise<EtaxSubmissionDto> {
    return etaxDto(await this.etax.retry(ctx, id));
  }

  @Get('summary')
  @TenantScoped()
  @Can('payment.read')
  @ApiEndpoint({
    id: 'owner.etax.summary',
    summary: 'e-Tax figures of a month',
    description:
      'For my accountant (D-051, D-215): documents per status, the signed totals (subtotal, VAT, total) and per ETDA type of the Bangkok month. The register itself is the `etax_monthly_xlsx` export; on the 1st the owner and accountant are told the previous month’s figures.',
    implements: ['D-051', 'D-215'],
  })
  @ApiSuccess(200, {
    description: 'Summary',
    type: EtaxSummaryDto,
    example: {
      month: '2026-11',
      enabled: true,
      provider: 'inet',
      counts: { queued: 0, submitted: 0, signed: 120, rejected: 1, failed: 0 },
      signed: { documents: 120, subtotal: '540000.00', vatAmount: '1260.00', total: '541260.00' },
      byType: [{ typeCode: 'T01', documents: 100, total: '450000.00' }],
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async summary(@CurrentTenant() ctx: TenantContext, @Query() q: EtaxSummaryQuery): Promise<EtaxSummaryDto> {
    return this.etax.summary(ctx, q.month);
  }
}

const TM30_EXAMPLE = {
  nextActions: ['generate', 'mark-submitted', 'cancel'],
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  unitId: FAKE.uuid,
  unitNo: 'A-101',
  leaseId: FAKE.uuid,
  partyId: FAKE.uuid,
  name: 'John Smith',
  nationality: 'GB',
  arrivalDate: '2026-10-30',
  movedInAt: FAKE.dateTime,
  dueAt: FAKE.dateTime,
  overdue: false,
  status: 'due',
  missing: [],
  format: 'immigration_xlsx_v1',
  generatedAt: null,
  fileDocumentId: null,
  downloadedAt: null,
  submittedAt: null,
  submissionRef: null,
  cancelReason: null,
};

/** TM30 notifications of foreign occupants (B6.2, D-052, D-216). */
@ApiTags('owner.tm30')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerTm30Controller {
  constructor(
    private readonly tm30: Tm30Service,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private dto(r: Tm30Row): Tm30ExportDto {
    const pending = ['due', 'generated', 'downloaded'].includes(r.status);
    return {
      nextActions: pending ? ['generate', 'mark-submitted', 'cancel'] : [],
      id: r.id,
      buildingId: r.buildingId,
      unitId: r.unitId,
      unitNo: r.unit.unitNo,
      leaseId: r.leaseId,
      partyId: r.partyId,
      name: r.party.displayName,
      nationality: r.party.nationality,
      arrivalDate: r.arrivalDate ? r.arrivalDate.toISOString().slice(0, 10) : null,
      movedInAt: iso(r.movedInAt),
      dueAt: iso(r.dueAt),
      overdue: pending && r.dueAt.getTime() < this.clock.now().getTime(),
      status: r.status as Tm30StatusName,
      missing: pending ? this.tm30.missing(r) : [],
      format: r.format,
      generatedAt: isoOrNull(r.generatedAt),
      fileDocumentId: r.fileDocumentId,
      downloadedAt: isoOrNull(r.downloadedAt),
      submittedAt: isoOrNull(r.submittedAt),
      submissionRef: r.submissionRef,
      cancelReason: r.cancelReason,
    };
  }

  @Get('tm30-exports')
  @TenantScoped()
  @Can('tm30.manage')
  @ApiEndpoint({
    id: 'owner.tm30.list',
    summary: 'TM30 notifications (export log)',
    description:
      'Every foreign occupant who moved in, with the 24-hour deadline (Immigration Act B.E. 2522 s.38, `tm30.notify_within_hours`), the data still missing for the Immigration Bureau, the upload file it went into and the recorded submission — the building’s export log (D-052, D-216).',
    implements: ['D-052', 'D-216'],
  })
  @ApiPaginated(Tm30ExportDto, { example: TM30_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: Tm30ListQuery): Promise<Page<Tm30ExportDto>> {
    const { rows, total } = await this.tm30.list(ctx, {
      buildingId: q.building,
      status: q.status,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((r) => this.dto(r)),
      total,
      q,
    );
  }

  @Get('tm30-exports/:tm30ExportId')
  @TenantScoped()
  @Can('tm30.manage')
  @ApiEndpoint({
    id: 'owner.tm30.get',
    summary: 'One TM30 notification',
    description:
      'Deadline, missing data, file and submission of one foreign occupant’s notification (D-216).',
    implements: ['D-052', 'D-216'],
  })
  @ApiSuccess(200, { description: 'The notification', type: Tm30ExportDto, example: TM30_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('tm30ExportId', ParseUUIDPipe) id: string,
  ): Promise<Tm30ExportDto> {
    return this.dto(await this.tm30.get(ctx, id));
  }

  @Post('buildings/:buildingId/tm30-exports/actions/generate')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @TenantScoped()
  @Can('tm30.manage')
  @ApiEndpoint({
    id: 'owner.tm30.generate',
    summary: 'Generate the Immigration Bureau upload file of a building',
    description:
      'One `.xlsx` in the Immigration Bureau’s upload format (`immigration_xlsx_v1`: passport no., nationality, names, gender, birth date, arrival date, visa, port of entry, check-in date, room; dates DD/MM/YYYY พ.ศ.) for every pending notification of the building, or the chosen ones; passport numbers are decrypted for the file only (each reveal audited, D-148). 422 `tm30.data_missing` lists what to complete per person; 409 `tm30.nothing_pending`. Upload it on the Immigration Bureau’s site, then record the submission — the platform never submits (D-052).',
    implements: ['D-052', 'D-216', 'D-148'],
  })
  @ApiJsonBody(Tm30GenerateDto, {})
  @ApiSuccess(200, {
    description: 'The file (5-minute link) and the notifications in it',
    type: Tm30FileDto,
    example: {
      fileDocumentId: FAKE.uuid,
      title: 'tm30-A-2026-11-01.xlsx',
      url: 'https://storage.example.com/file?X-Amz-Signature=abc',
      expiresAt: FAKE.dateTime,
      exports: [
        { ...TM30_EXAMPLE, status: 'generated', nextActions: ['generate', 'mark-submitted', 'cancel'] },
      ],
    },
  })
  @ApiStandardErrors(...W, 'tm30.data_missing', 'tm30.nothing_pending', 'workflow.invalid_transition')
  async generate(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
    @Body() body: Tm30GenerateDto,
  ): Promise<Tm30FileDto> {
    const r = await this.tm30.generate(ctx, buildingId, body.exportIds);
    return {
      fileDocumentId: r.document.id,
      title: r.document.title ?? r.document.id,
      url: r.url,
      expiresAt: iso(r.expiresAt),
      exports: r.rows.map((x) => this.dto(x)),
    };
  }

  @Get('tm30-exports/:tm30ExportId/file')
  @TenantScoped()
  @Can('tm30.manage')
  @ApiEndpoint({
    id: 'owner.tm30.file',
    summary: 'Download the upload file of a notification',
    description:
      'A 5-minute link to the last file the notification went into; the notifications of that file become `downloaded`. Audited (D-216, D-025).',
    implements: ['D-216', 'D-025'],
  })
  @ApiSuccess(200, {
    description: 'Link',
    type: Tm30FileDto,
    example: {
      fileDocumentId: FAKE.uuid,
      title: 'tm30-A-2026-11-01.xlsx',
      url: 'https://storage.example.com/file?X-Amz-Signature=abc',
      expiresAt: FAKE.dateTime,
      exports: [],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'tm30.invalid_state', ...T)
  async file(
    @CurrentTenant() ctx: TenantContext,
    @Param('tm30ExportId', ParseUUIDPipe) id: string,
  ): Promise<Tm30FileDto> {
    const r = await this.tm30.download(ctx, id);
    return {
      fileDocumentId: r.document.id,
      title: r.document.title ?? r.document.id,
      url: r.url,
      expiresAt: iso(r.expiresAt),
      exports: [],
    };
  }

  @Post('tm30-exports/:tm30ExportId/actions/mark-submitted')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @TenantScoped()
  @Can('tm30.manage')
  @ApiEndpoint({
    id: 'owner.tm30.markSubmitted',
    summary: 'Record the TM30 submission',
    description:
      'I uploaded the file (or notified in person) at the Immigration Bureau: the notification closes with the time and the receipt reference; its deadline timers stop (D-052, D-216). Audited.',
    implements: ['D-052', 'D-216'],
  })
  @ApiJsonBody(Tm30SubmittedDto, { reference: 'TM30-6611-000123' })
  @ApiSuccess(200, {
    description: 'Submitted',
    type: Tm30ExportDto,
    example: { ...TM30_EXAMPLE, status: 'submitted_manually', nextActions: [], submittedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(...W, 'tm30.invalid_state', 'workflow.invalid_transition')
  async markSubmitted(
    @CurrentTenant() ctx: TenantContext,
    @Param('tm30ExportId', ParseUUIDPipe) id: string,
    @Body() body: Tm30SubmittedDto,
  ): Promise<Tm30ExportDto> {
    return this.dto(
      await this.tm30.markSubmitted(ctx, id, {
        submittedAt: body.submittedAt ? new Date(body.submittedAt) : undefined,
        reference: body.reference ?? null,
      }),
    );
  }

  @Post('tm30-exports/:tm30ExportId/actions/cancel')
  @HttpCode(200)
  @TenantScoped()
  @Can('tm30.manage')
  @ApiEndpoint({
    id: 'owner.tm30.cancel',
    summary: 'Cancel a TM30 notification',
    description:
      'Not due after all (e.g. the occupant is Thai and the nationality was wrong), with a reason; its timers stop. Audited (D-216).',
    implements: ['D-216'],
  })
  @ApiJsonBody(Tm30CancelDto, { reason: 'ผู้เช่าเป็นคนไทย บันทึกสัญชาติผิด' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: Tm30ExportDto,
    example: { ...TM30_EXAMPLE, status: 'cancelled', nextActions: [], cancelReason: 'ผู้เช่าเป็นคนไทย' },
  })
  @ApiStandardErrors(...W, 'tm30.invalid_state', 'workflow.invalid_transition')
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('tm30ExportId', ParseUUIDPipe) id: string,
    @Body() body: Tm30CancelDto,
  ): Promise<Tm30ExportDto> {
    return this.dto(await this.tm30.cancel(ctx, id, body.reason));
  }
}

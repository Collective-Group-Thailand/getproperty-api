import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { toBangkokIso } from '@common/time/bangkok';
import { type RentCertificate } from '@generated/prisma/client';
import { IncomeSummariesService, type IncomeYear } from '@modules/ops-leases/income-summaries.service';
import { RentCertificatesService } from '@modules/ops-leases/rent-certificates.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { type LanguageName } from '../shared/common.dto';
import { ApiSurface, SURFACES } from '../surfaces';
import { DocumentDownloadDto } from './deposits.dto';
import {
  IncomeSummaryCreateDto,
  IncomeSummaryGeneratedDto,
  IncomeSummaryQuery,
  IncomeYearDto,
  RentCertificateCreateDto,
  RentCertificateDeclineDto,
  RentCertificateDto,
  RentCertificateListQuery,
  type RentCertificatePurposeName,
  RentCertificateStateName,
} from './rent-certificates.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function rentCertificateDto(
  r: RentCertificate & { lease?: { number: string | null }; unit?: { unitNo: string } },
): RentCertificateDto {
  return {
    id: r.id,
    leaseId: r.leaseId,
    unitNo: r.unit?.unitNo ?? null,
    leaseNumber: r.lease?.number ?? null,
    purpose: r.purpose as RentCertificatePurposeName,
    periodFrom: day(r.periodFrom),
    periodTo: day(r.periodTo),
    language: (r.language === 'en' ? 'en' : 'th') as LanguageName,
    note: r.note,
    state: r.state as RentCertificateStateName,
    requestedByResident: r.requestedByPartyId !== null,
    number: r.number,
    totalPaid: r.totalPaid ? r.totalPaid.toFixed(2) : null,
    declineReason: r.declineReason,
    documentId: r.documentId,
    requestedAt: toBangkokIso(r.requestedAt),
    decidedAt: r.decidedAt ? toBangkokIso(r.decidedAt) : null,
  };
}

const EXAMPLE: RentCertificateDto = {
  id: FAKE.uuid,
  leaseId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  leaseNumber: 'CTR-2026-00001',
  purpose: 'visa' as RentCertificatePurposeName,
  periodFrom: '2025-11-01',
  periodTo: FAKE.date,
  language: 'th' as LanguageName,
  note: null,
  state: RentCertificateStateName.Requested,
  requestedByResident: true,
  number: null,
  totalPaid: null,
  declineReason: null,
  documentId: null,
  requestedAt: FAKE.dateTime,
  decidedAt: null,
};
const ISSUED: RentCertificateDto = {
  ...EXAMPLE,
  state: RentCertificateStateName.Issued,
  number: 'RPC-2026-00001',
  totalPaid: '180000.00',
  documentId: FAKE.uuid,
  decidedAt: FAKE.dateTime,
};
const DOWNLOAD: DocumentDownloadDto = {
  documentId: FAKE.uuid,
  number: 'RPC-2026-00001',
  url: 'https://storage.example.com/certificate.pdf?X-Amz-Signature=abc',
  expiresAt: '2026-11-01T00:20:00+07:00',
};
const YEAR_EXAMPLE: IncomeYearDto = {
  year: 2026,
  deductionPercent: '30',
  units: [
    {
      unitId: FAKE.uuid,
      unitNo: '12/345',
      months: [
        '15000.00',
        '15000.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
      ],
      chargeMonths: [
        '1200.00',
        '1150.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
      ],
      rent: '30000.00',
      charges: '2350.00',
      retained: '0.00',
      gross: '30000.00',
      expenses: '900.00',
      expenseItems: [{ categoryKey: 'plumbing', nameTh: 'ประปา', nameEn: 'Plumbing', amount: '900.00' }],
    },
  ],
  totals: {
    rent: '30000.00',
    charges: '2350.00',
    retained: '0.00',
    gross: '30000.00',
    deduction: '9000.00',
    net: '21000.00',
    expenses: '900.00',
    netActual: '29100.00',
  },
};
const yearDto = (y: IncomeYear): IncomeYearDto => ({
  year: y.year,
  deductionPercent: y.deductionPercent,
  units: y.units.map(({ buildingId: _b, ...u }) => u),
  totals: y.totals,
});

@ApiTags('owner.leases')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerRentCertificatesController {
  constructor(private readonly certificates: RentCertificatesService) {}

  @Get('rent-certificates')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.rentCertificates.list',
    summary: 'Rent payment certificates',
    description:
      'Requests from residents and certificates issued, newest first; `state=requested` is what waits for the owner (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'Certificates', type: [RentCertificateDto], example: [EXAMPLE] })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: RentCertificateListQuery,
  ): Promise<RentCertificateDto[]> {
    return (await this.certificates.list(ctx, q)).map(rentCertificateDto);
  }

  @Post('rent-certificates/:certificateId/actions/issue')
  @TenantScoped()
  @Can('lease.manage')
  @Idempotent()
  @HttpCode(200)
  @ApiEndpoint({
    id: 'owner.rentCertificates.issue',
    summary: 'Issue a requested certificate',
    description:
      "A numbered PDF (RPC series) in the landlord's name listing the receipts of the period asked for and whether anything is overdue; the resident gets it in LINE (B7.5, D-253).",
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'Issued', type: RentCertificateDto, example: ISSUED })
  @ApiStandardErrors('http.not_found', 'rent_certificate.invalid_state', 'idempotency.key_required', ...T)
  async issue(
    @CurrentTenant() ctx: TenantContext,
    @Param('certificateId', ParseUUIDPipe) id: string,
  ): Promise<RentCertificateDto> {
    return rentCertificateDto(await this.certificates.issue(ctx, id));
  }

  @Post('rent-certificates/:certificateId/actions/decline')
  @TenantScoped()
  @Can('lease.manage')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'owner.rentCertificates.decline',
    summary: 'Decline a certificate request',
    description: 'With a reason the resident reads in LINE (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiJsonBody(RentCertificateDeclineDto, { reason: 'ยังไม่มีรายการชำระในช่วงที่ขอ' })
  @ApiSuccess(200, {
    description: 'Declined',
    type: RentCertificateDto,
    example: {
      ...EXAMPLE,
      state: RentCertificateStateName.Declined,
      declineReason: 'ยังไม่มีรายการชำระในช่วงที่ขอ',
      decidedAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'rent_certificate.invalid_state', ...T)
  async decline(
    @CurrentTenant() ctx: TenantContext,
    @Param('certificateId', ParseUUIDPipe) id: string,
    @Body() body: RentCertificateDeclineDto,
  ): Promise<RentCertificateDto> {
    return rentCertificateDto(await this.certificates.decline(ctx, id, body.reason));
  }

  @Post('leases/:leaseId/rent-certificates')
  @TenantScoped()
  @Can('lease.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.leases.issueRentCertificate',
    summary: 'Issue a rent certificate directly',
    description:
      'Without a resident request (asked in person or by phone); same document as an issued request (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiJsonBody(RentCertificateCreateDto, { purpose: 'bank' })
  @ApiSuccess(201, {
    description: 'Issued',
    type: RentCertificateDto,
    example: { ...ISSUED, requestedByResident: false },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'lease.invalid_state',
    'idempotency.key_required',
    ...T,
  )
  async issueDirect(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Body() body: RentCertificateCreateDto,
  ): Promise<RentCertificateDto> {
    return rentCertificateDto(await this.certificates.issueDirect(ctx, leaseId, body));
  }

  @Get('rent-certificates/:certificateId/document')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.rentCertificates.document',
    summary: 'Open a certificate',
    description: 'A 5-minute signed URL of the certificate PDF (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'Download', type: DocumentDownloadDto, example: DOWNLOAD })
  @ApiStandardErrors('http.not_found', ...T)
  async document(
    @CurrentTenant() ctx: TenantContext,
    @Param('certificateId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.certificates.document(ctx, id);
    return {
      documentId: r.row.documentId!,
      number: r.row.number!,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }
}

@ApiTags('owner.documents')
@ApiSurface(SURFACES.owner)
@Controller('owner/income-summaries')
export class OwnerIncomeSummariesController {
  constructor(private readonly summaries: IncomeSummariesService) {}

  @Get()
  @TenantScoped()
  @Can('document.read')
  @ApiEndpoint({
    id: 'owner.incomeSummaries.year',
    summary: 'Rental income of a year',
    description:
      'Per unit and Bangkok calendar year: rent received month by month (receipts issued through the platform, not voided; rent and furniture lines pro rata of each invoice paid, advance rent included; deposits excluded) and, apart, the utilities and service charges received (D-282); deposit deductions kept; the assessable income of section 40(5) and the flat-rate deduction `tax.income_40_5.flat_deduction_percent` as an estimate (B7.5, D-253). A summary for PND 90 / 94, not a filing.',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'The year', type: IncomeYearDto, example: YEAR_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async year(@CurrentTenant() ctx: TenantContext, @Query() q: IncomeSummaryQuery): Promise<IncomeYearDto> {
    return yearDto(await this.summaries.year(ctx, q.year, q.unitId));
  }

  @Post()
  @TenantScoped()
  @Can('document.read')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.incomeSummaries.generate',
    summary: 'Make the PDF summary of a unit',
    description:
      'A numbered PDF (ISM series) of one unit and year in the owner’s name, stored with the unit (`pdf_summary`, listed in `GET /v1/owner/documents`) (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiJsonBody(IncomeSummaryCreateDto, { year: 2026, unitId: FAKE.uuid })
  @ApiSuccess(201, {
    description: 'Made',
    type: IncomeSummaryGeneratedDto,
    example: { documentId: FAKE.uuid, number: 'ISM-2026-00001', summary: YEAR_EXAMPLE },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'idempotency.key_required', ...T)
  async generate(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: IncomeSummaryCreateDto,
  ): Promise<IncomeSummaryGeneratedDto> {
    const r = await this.summaries.generate(ctx, body);
    return { documentId: r.document.id, number: r.number, summary: yearDto(r.summary) };
  }
}

@ApiTags('resident.leases')
@ApiSurface(SURFACES.resident)
@Controller('resident/leases')
export class ResidentRentCertificatesController {
  constructor(private readonly certificates: RentCertificatesService) {}

  @Get(':leaseId/rent-certificates')
  @ApiEndpoint({
    id: 'resident.leases.rentCertificates',
    summary: 'My rent certificates',
    description: 'Requests and certificates of my lease, newest first (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiSuccess(200, {
    description: 'Certificates',
    type: [RentCertificateDto],
    example: [{ ...ISSUED, unitNo: null, leaseNumber: null }],
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async list(@Param('leaseId', ParseUUIDPipe) leaseId: string): Promise<RentCertificateDto[]> {
    return (await this.certificates.residentList(leaseId)).map(rentCertificateDto);
  }

  @Post(':leaseId/rent-certificates')
  @ApiEndpoint({
    id: 'resident.leases.requestRentCertificate',
    summary: 'Ask for a rent certificate',
    description:
      'For a visa, a bank or an employer: the period (default the last 12 months, at most 24) and the language; one open request at a time (`rent_certificate.request_open`). The landlord is told and issues or declines it; I get the answer in LINE (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiJsonBody(RentCertificateCreateDto, { purpose: 'visa', language: 'en' })
  @ApiSuccess(201, {
    description: 'Requested',
    type: RentCertificateDto,
    example: { ...EXAMPLE, unitNo: null, leaseNumber: null },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'lease.invalid_state',
    'rent_certificate.request_open',
  )
  async request(
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Body() body: RentCertificateCreateDto,
  ): Promise<RentCertificateDto> {
    return rentCertificateDto(await this.certificates.residentRequest(leaseId, body));
  }

  @Get(':leaseId/rent-certificates/:certificateId/document')
  @ApiEndpoint({
    id: 'resident.leases.rentCertificateDocument',
    summary: 'Open my rent certificate',
    description: 'A 5-minute signed URL of the certificate PDF (B7.5, D-253).',
    implements: ['D-253'],
  })
  @ApiSuccess(200, { description: 'Download', type: DocumentDownloadDto, example: DOWNLOAD })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async document(
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Param('certificateId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.certificates.residentDocument(leaseId, id);
    return {
      documentId: r.row.documentId!,
      number: r.row.number!,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }
}

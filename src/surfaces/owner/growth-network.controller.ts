import { AllowWhenReadOnly, CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiAsync,
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { type RentalHandoff } from '@generated/prisma/client';
import {
  type HandoffFacts,
  RentalHandoffsService,
} from '@modules/bridge-integrations/rental-handoffs.service';
import {
  type AgreementRow,
  EmployerHousingService,
  type Statement,
} from '@modules/ops-leases/employer-housing.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { ifMatchVersion } from './assets.mappers';
import { EXPORT_EXAMPLE, exportDto } from './documents.controller';
import { ExportJobDto, type ExportKindName, type ExportStatusName } from './documents.dto';
import {
  EmployerAgreementCreateDto,
  EmployerAgreementDto,
  EmployerAgreementListQuery,
  EmployerAgreementsDto,
  EmployerAgreementStateName,
  EmployerAgreementUpdateDto,
  EmployerMonthQuery,
  EmployerSplitRuleName,
  EmployerStatementDto,
  EmployerWorkersDto,
  HandoffFactsDto,
  LeaseEmployerDto,
  LeaseEmployerResultDto,
  PayrollExportCreateDto,
  RentalHandoffClaimDto,
  RentalHandoffDto,
  RentalHandoffsDto,
  RentalHandoffStateName,
} from './growth-network.dto';
import { PortfolioUnitKindName } from './portfolio.controller';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const W = [...T, 'tenant.read_only'] as const;

// ------------------------------------------------------------------------------------------- mappers

export function handoffFactsDto(facts: unknown): HandoffFactsDto {
  const f = (facts ?? {}) as HandoffFacts;
  return {
    projectName: f.projectName ?? null,
    unitNo: f.unitNo ?? null,
    kind: (f.kind ?? 'condo_unit') as PortfolioUnitKindName,
    district: f.address?.district ?? null,
    province: f.address?.province ?? null,
    areaSqm: f.areaSqm ?? null,
    bedrooms: f.bedrooms ?? null,
    bathrooms: f.bathrooms ?? null,
    floorLabel: f.floorLabel ?? null,
  };
}

export const rentalHandoffDto = (r: RentalHandoff): RentalHandoffDto => ({
  id: r.id,
  state: r.state as RentalHandoffStateName,
  campaignTag: r.campaignTag,
  facts: handoffFactsDto(r.facts),
  transferDate: dateOnly(r.transferDate)!,
  unitId: r.unitId,
  listingId: r.listingId,
  acceptedAt: isoOrNull(r.acceptedAt),
  listedAt: isoOrNull(r.listedAt),
});

export const FACTS_EXAMPLE: HandoffFactsDto = {
  projectName: FAKE.propertyName,
  unitNo: FAKE.unitCode,
  kind: PortfolioUnitKindName.CondoUnit,
  district: 'จตุจักร',
  province: 'กรุงเทพมหานคร',
  areaSqm: '32.00',
  bedrooms: 1,
  bathrooms: 1,
  floorLabel: '12',
};

const HANDOFF_EXAMPLE: RentalHandoffDto = {
  id: FAKE.uuid,
  state: RentalHandoffStateName.Accepted,
  campaignTag: 'getbuild:dev-campaign-2026',
  facts: FACTS_EXAMPLE,
  transferDate: FAKE.date,
  unitId: '0199f2a0-0000-7000-8000-0000000000c1',
  listingId: '0199f2a0-0000-7000-8000-0000000000c2',
  acceptedAt: FAKE.dateTime,
  listedAt: null,
};

export const agreementDto = (a: AgreementRow): EmployerAgreementDto => ({
  id: a.id,
  employer: { id: a.employer.id, displayName: a.employer.displayName, type: a.employer.type },
  buildingId: a.buildingId,
  buildingName: a.building?.name ?? null,
  reference: a.reference,
  splitRule: a.splitRule as EmployerSplitRuleName,
  deductPercent: a.deductPercent.toFixed(2),
  payrollExportFormat: a.payrollExportFormat,
  validFrom: dateOnly(a.validFrom)!,
  validTo: dateOnly(a.validTo),
  state: a.state as EmployerAgreementStateName,
  endedAt: isoOrNull(a.endedAt),
  workers: a.workers.map((w) => ({ partyId: w.partyId, employeeNo: w.employeeNo })),
  leaseIds: a.leases.map((l) => l.id),
  version: a.version,
  createdAt: iso(a.createdAt),
});

const AGREEMENT_EXAMPLE: EmployerAgreementDto = {
  id: FAKE.uuid,
  employer: { id: '0199f2a0-0000-7000-8000-0000000000e1', displayName: FAKE.companyName, type: 'company' },
  buildingId: FAKE.buildingId,
  buildingName: FAKE.propertyName,
  reference: 'HR-2026-014',
  splitRule: EmployerSplitRuleName.PerOccupant,
  deductPercent: '100.00',
  payrollExportFormat: 'generic_csv',
  validFrom: FAKE.date,
  validTo: null,
  state: EmployerAgreementStateName.Active,
  endedAt: null,
  workers: [{ partyId: '0199f2a0-0000-7000-8000-0000000000e2', employeeNo: 'E-0042' }],
  leaseIds: ['0199f2a0-0000-7000-8000-0000000000e3'],
  version: 1,
  createdAt: FAKE.dateTime,
};

export const statementDto = (s: Statement): EmployerStatementDto => ({
  agreementId: s.agreement.id,
  employerName: s.employerName,
  month: s.month,
  splitRule: s.agreement.splitRule as EmployerSplitRuleName,
  deductPercent: s.agreement.deductPercent.toFixed(2),
  lines: s.lines.map((l) => ({
    invoiceId: l.invoiceId,
    number: l.number,
    leaseId: l.leaseId,
    unitNo: l.unitNo,
    issuedAt: iso(l.issuedAt),
    periodStart: dateOnly(l.periodStart)!,
    periodEnd: dateOnly(l.periodEnd)!,
    total: l.total.toFixed(2),
    paidTotal: l.paidTotal.toFixed(2),
    balance: l.balance.toFixed(2),
    shares: l.shares.map((x) => ({
      partyId: x.partyId,
      name: x.name,
      employeeNo: x.employeeNo,
      share: x.share.toFixed(2),
      deduction: x.deduction.toFixed(2),
      employerPays: x.employerPays.toFixed(2),
    })),
  })),
  total: s.total.toFixed(2),
  paid: s.paid.toFixed(2),
  balance: s.balance.toFixed(2),
  deductions: s.deductions.toFixed(2),
  employerPays: s.employerPays.toFixed(2),
});

const STATEMENT_EXAMPLE: EmployerStatementDto = {
  agreementId: FAKE.uuid,
  employerName: FAKE.companyName,
  month: '2026-11',
  splitRule: EmployerSplitRuleName.PerOccupant,
  deductPercent: '100.00',
  lines: [
    {
      invoiceId: '0199f2a0-0000-7000-8000-0000000000e4',
      number: 'INV-2026-00042',
      leaseId: '0199f2a0-0000-7000-8000-0000000000e3',
      unitNo: FAKE.unitCode,
      issuedAt: FAKE.dateTime,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      total: '5000.00',
      paidTotal: '0.00',
      balance: '5000.00',
      shares: [
        {
          partyId: '0199f2a0-0000-7000-8000-0000000000e2',
          name: FAKE.nameTh,
          employeeNo: 'E-0042',
          share: '2500.00',
          deduction: '2500.00',
          employerPays: '0.00',
        },
        {
          partyId: '0199f2a0-0000-7000-8000-0000000000e5',
          name: FAKE.name,
          employeeNo: null,
          share: '2500.00',
          deduction: '2500.00',
          employerPays: '0.00',
        },
      ],
    },
  ],
  total: '5000.00',
  paid: '0.00',
  balance: '5000.00',
  deductions: '5000.00',
  employerPays: '0.00',
};

// ------------------------------------------------------------------------------------------- employer housing

/**
 * Employer housing (G8, D-289 (4), D-299): an employer pays the leases of its workers — agreements, the workers'
 * payroll numbers, leases attached (invoices addressed to the employer from the next one), the monthly statement split
 * per occupant / per unit with each worker's payroll deduction, and the payroll-deduction CSV export. TM30 of the
 * employer's foreign workers: `GET /v1/owner/tm30-exports?employerAgreementId=`.
 */
@ApiTags('owner.employerAgreements')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerEmployerHousingController {
  constructor(private readonly employers: EmployerHousingService) {}

  @Get('employer-agreements')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.employerAgreements.list',
    summary: 'Employer agreements',
    description:
      'Employers paying their workers’ leases, newest first, with the workers’ payroll numbers and the open leases attached (D-299).',
    implements: ['D-289', 'D-299'],
  })
  @ApiSuccess(200, {
    description: 'Agreements',
    type: EmployerAgreementsDto,
    example: { data: [AGREEMENT_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: EmployerAgreementListQuery,
  ): Promise<EmployerAgreementsDto> {
    return { data: (await this.employers.list(ctx, { state: q.state })).map(agreementDto) };
  }

  @Post('employer-agreements')
  @TenantScoped()
  @Can('lease.manage')
  @UseEtag((a: EmployerAgreementDto) => etagOf(a.id, a.version))
  @ApiEndpoint({
    id: 'owner.employerAgreements.create',
    summary: 'Record an employer agreement',
    description:
      'An employer (a party of this tenant) pays the leases of its workers (D-289 (4)): split rule (`per_occupant` / `per_unit`), payroll deduction percent, validity, optionally one building. Attach leases with `PUT /v1/owner/leases/{leaseId}/employer`. Another tenant’s party or building: 404 (D-299).',
    implements: ['D-289', 'D-299'],
  })
  @ApiJsonBody(EmployerAgreementCreateDto, {
    employerPartyId: '0199f2a0-0000-7000-8000-0000000000e1',
    buildingId: FAKE.buildingId,
    splitRule: 'per_occupant',
    deductPercent: '100',
    validFrom: FAKE.date,
  })
  @ApiSuccess(201, { description: 'Recorded', type: EmployerAgreementDto, example: AGREEMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...W)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: EmployerAgreementCreateDto,
  ): Promise<EmployerAgreementDto> {
    return agreementDto(await this.employers.create(ctx, body));
  }

  @Get('employer-agreements/:agreementId')
  @TenantScoped()
  @Can('lease.read')
  @UseEtag((a: EmployerAgreementDto) => etagOf(a.id, a.version))
  @ApiEndpoint({
    id: 'owner.employerAgreements.get',
    summary: 'One employer agreement',
    description: 'An agreement of this tenant (404 otherwise, contract §8) (D-299).',
    implements: ['D-299'],
  })
  @ApiSuccess(200, { description: 'The agreement', type: EmployerAgreementDto, example: AGREEMENT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
  ): Promise<EmployerAgreementDto> {
    return agreementDto(await this.employers.get(ctx, id));
  }

  @Patch('employer-agreements/:agreementId')
  @TenantScoped()
  @Can('lease.manage')
  @UseEtag((a: EmployerAgreementDto) => etagOf(a.id, a.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.employerAgreements.update',
    summary: 'Change or end an employer agreement',
    description:
      'Split rule, deduction percent, reference, end date — or `end: true`, which detaches its open leases (their next invoices go to the lessees again; issued invoices never change, D-040). Requires `If-Match`; an ended agreement: `employer.invalid_state` (D-299).',
    implements: ['D-299', 'D-040'],
  })
  @ApiJsonBody(EmployerAgreementUpdateDto, { deductPercent: '50' })
  @ApiSuccess(200, {
    description: 'Updated',
    type: EmployerAgreementDto,
    example: { ...AGREEMENT_EXAMPLE, deductPercent: '50.00', version: 2 },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'employer.invalid_state',
    ...W,
  )
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: EmployerAgreementUpdateDto,
  ): Promise<EmployerAgreementDto> {
    const version = ifMatchVersion(ifMatch, await this.employers.get(ctx, id));
    return agreementDto(await this.employers.update(ctx, id, version, body));
  }

  @Put('employer-agreements/:agreementId/workers')
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.employerAgreements.setWorkers',
    summary: 'Set the workers’ payroll numbers',
    description:
      'Replaces the payroll numbers of the employer’s workers (parties of this tenant) used by the statement and the payroll export (D-299). A party of another tenant: 404.',
    implements: ['D-299'],
  })
  @ApiJsonBody(EmployerWorkersDto, {
    workers: [{ partyId: '0199f2a0-0000-7000-8000-0000000000e2', employeeNo: 'E-0042' }],
  })
  @ApiSuccess(200, { description: 'Updated', type: EmployerAgreementDto, example: AGREEMENT_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'employer.invalid_state',
    ...W,
  )
  async setWorkers(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
    @Body() body: EmployerWorkersDto,
  ): Promise<EmployerAgreementDto> {
    return agreementDto(await this.employers.setWorkers(ctx, id, body.workers));
  }

  @Put('leases/:leaseId/employer')
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.employerAgreements.setLeaseEmployer',
    summary: 'Attach a lease to an employer (or detach it)',
    description:
      'The lease’s next invoices are addressed to the employer of an active agreement (`payerPartyId`); `null` sends them to the lessee again. Issued invoices never change (D-040). Only open leases (draft … ending): `employer.invalid_state`; a lease outside the agreement’s building: `employer.building_mismatch`. Another tenant’s lease or agreement: 404 (D-299).',
    implements: ['D-299', 'D-040'],
  })
  @ApiJsonBody(LeaseEmployerDto, { employerAgreementId: FAKE.uuid })
  @ApiSuccess(200, {
    description: 'Payer set',
    type: LeaseEmployerResultDto,
    example: {
      leaseId: '0199f2a0-0000-7000-8000-0000000000e3',
      employerAgreementId: FAKE.uuid,
      payerPartyId: '0199f2a0-0000-7000-8000-0000000000e1',
      version: 3,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'employer.invalid_state',
    'employer.building_mismatch',
    ...W,
  )
  async setLeaseEmployer(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Body() body: LeaseEmployerDto,
  ): Promise<LeaseEmployerResultDto> {
    const l = await this.employers.setLeaseEmployer(ctx, leaseId, body.employerAgreementId);
    return {
      leaseId: l.id,
      employerAgreementId: l.employerAgreementId,
      payerPartyId: l.payerPartyId,
      version: l.version,
    };
  }

  @Get('employer-agreements/:agreementId/statement')
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.employerAgreements.statement',
    summary: 'Employer statement of a month',
    description:
      'Invoices addressed to the employer for the agreement’s leases, issued in the Bangkok month (not void): totals, paid, due, and each invoice split between the people who stayed (`per_occupant`, equal shares, satang to the first) or on the lessee (`per_unit`), with each share’s payroll deduction (`deductPercent`) and what the employer carries (D-299).',
    implements: ['D-299'],
  })
  @ApiSuccess(200, { description: 'Statement', type: EmployerStatementDto, example: STATEMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async statement(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
    @Query() q: EmployerMonthQuery,
  ): Promise<EmployerStatementDto> {
    return statementDto(await this.employers.statement(ctx, id, q.month));
  }

  @Post('employer-agreements/:agreementId/payroll-exports')
  @HttpCode(202)
  @Idempotent()
  @TenantScoped()
  @AllowWhenReadOnly()
  @Can('export.create')
  @ApiAsync({ poll: 'owner.exports.get' })
  @ApiEndpoint({
    id: 'owner.employerAgreements.payrollExport',
    summary: 'Export the payroll deductions of a month',
    description:
      'Queues export `payroll_deduction` (`generic_csv`: employee no, worker, unit, invoice, share, deduction; UTF-8 with BOM) of the month’s statement; poll `GET /v1/owner/exports/{id}` for the link. The figures are for the employer’s payroll — whether it may deduct from wages is the employer’s responsibility (Labour Protection Act s.76, O-034) (D-299).',
    implements: ['D-299', 'D-051'],
  })
  @ApiJsonBody(PayrollExportCreateDto, { month: '2026-11' })
  @ApiSuccess(202, {
    description: 'Queued',
    type: ExportJobDto,
    example: {
      ...EXPORT_EXAMPLE,
      kind: 'payroll_deduction' as ExportKindName,
      params: { period: '2026-11', employerAgreementId: FAKE.uuid },
      status: 'queued' as ExportStatusName,
      finishedAt: null,
      download: null,
      rowCount: null,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...W)
  async payrollExport(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
    @Body() body: PayrollExportCreateDto,
  ): Promise<ExportJobDto> {
    return exportDto(await this.employers.requestPayrollExport(ctx, id, body.month));
  }
}

// ------------------------------------------------------------------------------------------- rental handoff

/**
 * getbuild rental handoff (G8, D-289 (5), D-299): a buyer who bought a unit through getbuild with rental intent claims
 * the invitation as a landlord — the unit joins the portfolio and a prefilled listing draft waits for photos.
 */
@ApiTags('owner.rentalHandoffs')
@ApiSurface(SURFACES.owner)
@Controller('owner/rental-handoffs')
export class OwnerRentalHandoffsController {
  constructor(private readonly handoffs: RentalHandoffsService) {}

  @Get()
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.rentalHandoffs.list',
    summary: 'Units handed over from getbuild',
    description:
      'Handoffs this tenant claimed: the unit, its listing draft, the developer campaign, `listed` once the listing was published (D-299).',
    implements: ['D-289', 'D-299'],
  })
  @ApiSuccess(200, { description: 'Handoffs', type: RentalHandoffsDto, example: { data: [HANDOFF_EXAMPLE] } })
  @ApiStandardErrors(...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<RentalHandoffsDto> {
    return { data: (await this.handoffs.listOwn(ctx)).map(rentalHandoffDto) };
  }

  @Post('actions/claim')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.rentalHandoffs.claim',
    summary: 'Claim a getbuild rental handoff',
    description:
      'With the token of the invitation link, a **landlord** tenant (free, D-284; else `handoff.landlord_required`) adds the bought unit to its portfolio (ownership source `getbuild_transfer`) and gets a listing draft prefilled from getbuild’s facts, the rent typed here and the developer campaign tag — add photos and submit it as any listing. Used, declined or expired invitation (or claimed by another tenant): `handoff.invalid_state`; unknown token: 404. `address` is needed only when getbuild did not tell it (D-299).',
    implements: ['D-289', 'D-299', 'D-284', 'D-252'],
  })
  @ApiJsonBody(RentalHandoffClaimDto, { token: 'q3K8xF0bW2yR9mT4vN6pL1sA7dE5gH0j', rent: '15000' })
  @ApiSuccess(200, { description: 'Claimed', type: RentalHandoffDto, example: HANDOFF_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'handoff.invalid_state',
    'handoff.landlord_required',
    'portfolio.unit_claimed',
    ...W,
  )
  async claim(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: RentalHandoffClaimDto,
  ): Promise<RentalHandoffDto> {
    return rentalHandoffDto(await this.handoffs.claim(ctx, body));
  }
}

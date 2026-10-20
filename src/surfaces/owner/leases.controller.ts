import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import { AcceptLanguage, resolveLanguage } from '@common/i18n/language';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiCompliance,
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { type Invitation } from '@generated/prisma/client';
import { LeasesService } from '@modules/ops-leases/leases.service';
import { ResidentLeasesService } from '@modules/ops-leases/resident-leases.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import Decimal from 'decimal.js';
import { type Response } from 'express';

import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { LeaseLineKindName } from './assets.dto';
import { ifMatchVersion } from './assets.mappers';
import {
  type AddendumClauseTypeName,
  CancelLeaseDto,
  CompleteMoveOutDto,
  ComplianceOutcomeName,
  ComplianceSeverityName,
  ContractDownloadDto,
  CountersignDto,
  InvitationAcceptedDto,
  InvitationPreviewDto,
  LeaseCompliancePreviewDto,
  LeaseCreateDto,
  LeaseDto,
  LeaseEventDto,
  LeaseInvitationCreatedDto,
  LeaseInvitationCreateDto,
  LeaseInvitationDto,
  LeaseListQuery,
  type LeaseStatusName,
  LeaseTemplateDto,
  LeaseUpdateDto,
  LineRecurrenceName,
  RecordNoticeDto,
  RenewLeaseDto,
  ResidentLeaseDto,
  ResidentNoticeDto,
  ResidentSignatureOtpDto,
  ResidentSignatureOtpRequestDto,
  ResidentSignDto,
  type TemplateVersionStateName,
  TerminateLeaseDto,
} from './leases.dto';
import {
  CONTRACT_SHA_EXAMPLE,
  LEASE_EXAMPLE,
  leaseDto,
  leaseEventDto,
  RESIDENT_LEASE_EXAMPLE,
  residentLeaseDto,
} from './leases.mappers';
import { type InvitationChannelName, type InvitationStateName } from './tenancy.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', 'asset.read_only', ...T] as const;
const TERMS_RULES = [
  'compliance.deposit_cap',
  'compliance.forbidden_clause',
  'compliance.no_renewal_fee',
  'compliance.bill_disclosure',
  'compliance.no_midterm_increase',
  'compliance.water_minimum',
  'compliance.late_fee_policy',
] as const;
const PNG_EXAMPLE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF_EXAMPLE = 'JVBERi0xLjcK… (pdf bytes)';

const png = (base64: string): Buffer => {
  const body = Buffer.from(base64, 'base64');
  if (!body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || body.length > 200_000)
    throw new DomainException('lease.signature_invalid');
  return body;
};

const invitationDto = (i: Invitation): LeaseInvitationDto => ({
  id: i.id,
  partyId: i.partyId,
  channel: i.channel as InvitationChannelName,
  state: (i.state === 'pending' && i.expiresAt.getTime() <= Date.now()
    ? 'expired'
    : i.state) as InvitationStateName,
  expiresAt: iso(i.expiresAt),
  acceptedAt: isoOrNull(i.acceptedAt),
  createdAt: iso(i.createdAt),
});

const INVITATION_EXAMPLE: LeaseInvitationDto = {
  id: FAKE.uuid,
  partyId: FAKE.uuid,
  channel: 'line_qr' as InvitationChannelName,
  state: 'pending' as InvitationStateName,
  expiresAt: '2026-11-08T00:15:00+07:00',
  acceptedAt: null,
  createdAt: FAKE.dateTime,
};

const EVENT_EXAMPLE: LeaseEventDto = {
  id: FAKE.uuid,
  type: 'sent_for_signature',
  occurredAt: FAKE.dateTime,
  actorType: 'user',
  data: { number: 'CTR-2026-00001' },
};

const CREATE_EXAMPLE = {
  unitId: FAKE.uuid,
  lesseePartyId: FAKE.uuid,
  startDate: FAKE.date,
  months: 12,
  rent: '4500.00',
  depositAmount: '4500.00',
  advanceRentAmount: '4500.00',
  billingDay: 5,
  keysCount: 2,
  addendum: [{ type: 'pets', title: 'สัตว์เลี้ยง', text: 'อนุญาตแมวได้ 1 ตัว ผู้เช่ารับผิดชอบความสะอาด' }],
};

// ------------------------------------------------------------------------------------------- owner

@ApiTags('owner.leases')
@ApiSurface(SURFACES.owner)
@Controller('owner/leases')
export class OwnerLeasesController {
  constructor(
    private readonly leases: LeasesService,
    private readonly residents: ResidentLeasesService,
  ) {}

  @Get()
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leases.list',
    summary: 'Leases of my buildings',
    description:
      'Filter by status, building, unit or party; `q` matches the contract number, unit number or lessee name. Staff with building limits see their buildings only (D-090).',
    implements: ['D-020', 'D-151'],
  })
  @ApiPaginated(LeaseDto, { example: LEASE_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: LeaseListQuery): Promise<Page<LeaseDto>> {
    const { rows, total } = await this.leases.list(ctx, {
      status: query.status,
      buildingId: query.buildingId,
      unitId: query.unitId,
      partyId: query.partyId,
      q: query.q,
      ...toSkipTake(query),
    });
    return paginated(rows.map(leaseDto), total, query);
  }

  @Post()
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.create',
    summary: 'Draft a lease on the standard contract',
    description:
      'A draft on the platform standard contract (สคบ. 2568 template, D-020) with defaults from the unit and its room type (rent, deposit/advance months, fixed lines, D-041). Checked before it is written: deposit + advance ≤ `deposit.max_months_short` months of rent (`compliance.deposit_cap`), forbidden clause types and wording of the announcement (`compliance.forbidden_clause`), no renewal fee, no fixed utility lines, rent changes only as recorded at signing, the water minimum and late-fee policy. A warning needs the Owner’s acknowledgement (409 `compliance.acknowledgement_required` → acknowledge → repeat with `acknowledgementIds`, D-021a).',
    implements: ['D-020', 'D-021', 'D-022', 'D-041', 'D-158'],
  })
  @ApiCompliance(...TERMS_RULES)
  @ApiJsonBody(LeaseCreateDto, CREATE_EXAMPLE)
  @ApiSuccess(201, {
    description: 'Draft created',
    type: LeaseDto,
    example: { ...LEASE_EXAMPLE, status: 'draft', number: null },
  })
  @ApiStandardErrors('compliance.acknowledgement_required', 'lease.unit_unavailable', ...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: LeaseCreateDto): Promise<LeaseDto> {
    return leaseDto(await this.leases.createDraft(ctx, body));
  }

  @Post('compliance-preview')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.previewCompliance',
    summary: 'Dry-run the compliance checks of a lease draft',
    description:
      'The same body as `POST /v1/owner/leases`, nothing written and no evaluation recorded (web F2 lease wizard): each rule the create would apply (deposit cap, forbidden clauses, renewal fee, utility lines, rent changes, water minimum, late fee) with its outcome now (pass / warn / block), severity and legal reference; the problems the create would answer (a refusal, an acknowledgement to give, a unit that cannot be leased); and the defaults the API applies (rent, deposit and advance from the unit and its room type, end date, fixed lines). D-208.',
    implements: ['D-020', 'D-021a', 'D-158', 'D-208'],
  })
  @ApiJsonBody(LeaseCreateDto, CREATE_EXAMPLE)
  @ApiSuccess(200, {
    description: 'Checks, problems and defaults',
    type: LeaseCompliancePreviewDto,
    example: {
      inScope: true,
      checks: [
        {
          ruleId: 'compliance.deposit_cap',
          outcome: 'block',
          severity: 'block',
          legalRef: 'ประกาศ สคบ. 2568 ข้อ 4 (3)',
          context: { depositAmount: '13500.00', capAmount: '9000.00' },
        },
      ],
      problems: [
        {
          code: 'compliance.deposit_cap',
          status: 422,
          ruleId: 'compliance.deposit_cap',
          legalRef: 'ประกาศ สคบ. 2568 ข้อ 4 (3)',
          errors: [
            { path: 'depositAmount', code: 'max', message: 'deposit + advance exceed 3 months of rent' },
          ],
        },
      ],
      defaults: {
        rent: '4500.00',
        depositAmount: '4500.00',
        advanceRentAmount: '4500.00',
        billingDay: 5,
        months: 12,
        endDate: '2027-10-31',
        lines: [
          { kind: 'internet', description: 'อินเทอร์เน็ตไฟเบอร์', amount: '300.00', recurrence: 'monthly' },
        ],
      },
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', ...T)
  async previewCompliance(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: LeaseCreateDto,
  ): Promise<LeaseCompliancePreviewDto> {
    const r = await this.leases.previewDraft(ctx, body);
    return {
      inScope: r.inScope,
      checks: r.checks.map((c) => ({
        ruleId: c.ruleId,
        outcome: c.outcome as ComplianceOutcomeName,
        severity: c.severity as ComplianceSeverityName,
        legalRef: c.legalRef,
        context: c.context,
      })),
      problems: r.problems.map((p) => ({
        ...p,
        errors: (p.errors as { path: string; code: string; message: string }[]).map((e) => ({
          path: e.path,
          code: e.code,
          message: e.message,
        })),
      })),
      defaults: r.defaults
        ? {
            ...r.defaults,
            lines: r.defaults.lines.map((l) => ({
              kind: l.kind as LeaseLineKindName,
              description: l.description,
              amount: new Decimal(l.amount).toFixed(2),
              recurrence: (l.recurrence ?? 'monthly') as LineRecurrenceName,
            })),
          }
        : null,
    };
  }

  @Get(':leaseId')
  @TenantScoped()
  @Can('lease.read')
  @UseEtag((l: LeaseDto) => etagOf(l.id, l.version))
  @ApiEndpoint({
    id: 'owner.leases.get',
    summary: 'One lease',
    description:
      'Terms, parties, signatures with their evidence summary, the contract and its sha256, notice/termination, the last compliance evaluation and the next actions the status allows (404 for another tenant’s lease, contract §8).',
    implements: ['D-020', 'D-062'],
  })
  @ApiSuccess(200, { description: 'The lease', type: LeaseDto, example: LEASE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.get(ctx, id));
  }

  @Patch(':leaseId')
  @TenantScoped()
  @Can('lease.manage')
  @UseEtag((l: LeaseDto) => etagOf(l.id, l.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.leases.update',
    summary: 'Edit a lease draft',
    description:
      'Drafts only; the same compliance checks as create. After sending for signature the agreed money terms are frozen (`compliance.no_midterm_increase`, D-020). Requires `If-Match`.',
    implements: ['D-020', 'D-021'],
  })
  @ApiCompliance(...TERMS_RULES)
  @ApiJsonBody(LeaseUpdateDto, { rent: '4600.00', keysCount: 2 })
  @ApiSuccess(200, {
    description: 'Updated',
    type: LeaseDto,
    example: { ...LEASE_EXAMPLE, status: 'draft', number: null },
  })
  @ApiStandardErrors('compliance.acknowledgement_required', 'lease.invalid_state', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: LeaseUpdateDto,
  ): Promise<LeaseDto> {
    const version = ifMatchVersion(ifMatch, await this.leases.get(ctx, id));
    return leaseDto(await this.leases.updateDraft(ctx, id, version, body));
  }

  @Get(':leaseId/contract-preview')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leases.previewContract',
    summary: 'Preview the contract PDF',
    description:
      'The standard contract filled with this lease (Thai, Sarabun), marked ร่าง while a draft; not stored. Decrypting the lessee’s ID number for the PDF is audited (`pii.decrypted`, D-148).',
    implements: ['D-020', 'D-148'],
  })
  @ApiResponse({
    status: 200,
    description: 'The PDF',
    content: { 'application/pdf': { schema: { type: 'string', format: 'binary' }, example: PDF_EXAMPLE } },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async preview(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const pdf = await this.leases.previewPdf(ctx, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="lease-${id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(pdf);
  }

  @Get(':leaseId/contract')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leases.contract',
    summary: 'Download the contract',
    description:
      'A 5-minute signed URL of the contract PDF (the signed one once countersigned) with its sha256; audited (`document.downloaded`).',
    implements: ['D-062'],
  })
  @ApiSuccess(200, {
    description: 'Download',
    type: ContractDownloadDto,
    example: {
      documentId: FAKE.uuid,
      number: 'CTR-2026-00001',
      url: 'https://storage.example.com/contract.pdf?X-Amz-Signature=abc',
      expiresAt: '2026-11-01T00:20:00+07:00',
      sha256: CONTRACT_SHA_EXAMPLE,
      signed: true,
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'lease.invalid_state',
    'document.not_uploaded',
    'validation.failed',
    ...T,
  )
  async contract(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
  ): Promise<ContractDownloadDto> {
    const { lease, download } = await this.leases.contract(ctx, id);
    return {
      documentId: download.document.id,
      number: lease.number,
      url: download.url,
      expiresAt: iso(download.expiresAt),
      sha256: LeasesService.hex(lease.contractSha256) ?? '',
      signed: Boolean(lease.signedDocumentId),
    };
  }

  @Get(':leaseId/events')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leases.events',
    summary: 'History of a lease',
    description:
      'Append-only lease history: drafted, sent, signed, activated, notices, move-out, end (D-020, D-062).',
    implements: ['D-020', 'D-062'],
  })
  @ApiSuccess(200, { description: 'Events, oldest first', type: [LeaseEventDto], example: [EVENT_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async events(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
  ): Promise<LeaseEventDto[]> {
    return (await this.leases.listEvents(ctx, id)).map(leaseEventDto);
  }

  @Post(':leaseId/actions/send-for-signature')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.sendForSignature',
    summary: 'Send the lease for signature',
    description:
      'Final compliance check, the lessee’s identity document on file (422 `lease.lessee_identity_missing`), the number from the `contract` series, the contract PDF stored with its sha256 (what residents sign) and the unit reserved. Then invite the residents (`…/invitations`).',
    implements: ['D-020', 'D-062'],
  })
  @ApiCompliance(...TERMS_RULES)
  @ApiSuccess(200, {
    description: 'Waiting for signatures',
    type: LeaseDto,
    example: { ...LEASE_EXAMPLE, status: 'pending_signature', signatures: [] },
  })
  @ApiStandardErrors(
    'compliance.acknowledgement_required',
    'lease.invalid_state',
    'lease.lessee_identity_missing',
    ...WRITE,
  )
  async send(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.sendForSignature(ctx, id));
  }

  @Post(':leaseId/actions/countersign')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.countersign',
    summary: 'Countersign and activate the lease',
    description:
      'Once every lessee signer signed (409 `lease.signatures_missing`): the lessor’s drawn signature, the final PDF with both signatures and its new sha256, and activation in the same transaction — occupancies from the start date, the unit occupied (reserved until a future start), the unit’s current lease and the deposit (D-023). An overlapping lease in force is refused (409 `lease.overlap`).',
    implements: ['D-020', 'D-023', 'D-062'],
  })
  @ApiJsonBody(CountersignDto, { signaturePng: PNG_EXAMPLE })
  @ApiSuccess(200, { description: 'Active', type: LeaseDto, example: LEASE_EXAMPLE })
  @ApiStandardErrors(
    'lease.invalid_state',
    'lease.signatures_missing',
    'lease.overlap',
    'lease.signature_invalid',
    ...WRITE,
  )
  async countersign(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: CountersignDto,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.countersign(ctx, id, { signaturePng: png(body.signaturePng) }));
  }

  @Post(':leaseId/actions/cancel')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.cancel',
    summary: 'Cancel a draft or unsigned lease',
    description:
      'Draft or pending signature only; releases the reserved unit and revokes pending invitations.',
    implements: ['D-020'],
  })
  @ApiJsonBody(CancelLeaseDto, { cancelReason: 'ผู้เช่าเปลี่ยนใจไม่เช่า' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: LeaseDto,
    example: { ...LEASE_EXAMPLE, status: 'cancelled' },
  })
  @ApiStandardErrors('lease.invalid_state', ...WRITE)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: CancelLeaseDto,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.cancel(ctx, id, body.cancelReason));
  }

  @Post(':leaseId/actions/record-notice')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.recordNotice',
    summary: 'Record a notice to end the lease',
    description:
      'The lessee’s written notice (≥ 30 days, `compliance.notice_period`, ข้อ 4 (11)) or the lessor’s notice with a legal ground, its notice period and evidence (`compliance.termination_notice`, ข้อ 4 (12)). Shorter periods are warnings the Owner must acknowledge (D-021a).',
    implements: ['D-020', 'D-021'],
  })
  @ApiCompliance('compliance.notice_period', 'compliance.termination_notice')
  @ApiJsonBody(RecordNoticeDto, {
    by: 'lessee',
    noticeDate: FAKE.date,
    effectiveDate: '2026-12-31',
    evidenceDocumentIds: [FAKE.uuid],
  })
  @ApiSuccess(200, {
    description: 'Notice recorded',
    type: LeaseDto,
    example: { ...LEASE_EXAMPLE, status: 'notice_given' },
  })
  @ApiStandardErrors('compliance.acknowledgement_required', 'lease.invalid_state', ...WRITE)
  async recordNotice(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: RecordNoticeDto,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.recordNotice(ctx, id, body));
  }

  @Post(':leaseId/actions/begin-move-out')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.beginMoveOut',
    summary: 'Start the move-out',
    description:
      'The lease enters `ending` (also automatic at the notice date or the end date): inspection and keys next (D-023).',
    implements: ['D-020', 'D-023'],
  })
  @ApiSuccess(200, { description: 'Ending', type: LeaseDto, example: { ...LEASE_EXAMPLE, status: 'ending' } })
  @ApiStandardErrors('lease.invalid_state', ...WRITE)
  async beginMoveOut(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.beginMoveOut(ctx, id));
  }

  @Post(':leaseId/actions/complete-move-out')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.completeMoveOut',
    summary: 'Complete the move-out',
    description:
      'The lease ends: occupancies closed on the move-out date, the unit vacant, and the deposit settlement opened with its 7-day deadline (D-023).',
    implements: ['D-020', 'D-023'],
  })
  @ApiJsonBody(CompleteMoveOutDto, { moveOutAt: FAKE.dateTime })
  @ApiSuccess(200, {
    description: 'Ended',
    type: LeaseDto,
    example: { ...LEASE_EXAMPLE, status: 'ended', moveOutAt: FAKE.dateTime },
  })
  @ApiStandardErrors('lease.invalid_state', ...WRITE)
  async completeMoveOut(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: CompleteMoveOutDto,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.completeMoveOut(ctx, id, body));
  }

  @Post(':leaseId/actions/terminate')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.terminate',
    summary: 'Terminate the lease',
    description:
      'With a ground and evidence (D-020): the lessor’s grounds need their notice period and the written notice on file (`compliance.termination_notice`); `lessee_notice` closes a lease the lessee gave notice for. Occupancies close, the unit becomes vacant, the deposit settlement opens (D-023). Never cuts power or access (D-024).',
    implements: ['D-020', 'D-023', 'D-024'],
  })
  @ApiCompliance('compliance.termination_notice')
  @ApiJsonBody(TerminateLeaseDto, {
    reasonCode: 'mutual_agreement',
    effectiveDate: FAKE.date,
    evidenceDocumentIds: [FAKE.uuid],
  })
  @ApiSuccess(200, {
    description: 'Terminated',
    type: LeaseDto,
    example: { ...LEASE_EXAMPLE, status: 'terminated' },
  })
  @ApiStandardErrors('compliance.acknowledgement_required', 'lease.invalid_state', ...WRITE)
  async terminate(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: TerminateLeaseDto,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.terminate(ctx, id, body));
  }

  @Post(':leaseId/actions/renew')
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.renew',
    summary: 'Renew into a new draft',
    description:
      'A new draft from the day after the end date with the same parties, lines and addendum; the deposit carries over, no renewal fee (`compliance.no_renewal_fee`, D-020). Sign it like any lease.',
    implements: ['D-020'],
  })
  @ApiCompliance(...TERMS_RULES)
  @ApiJsonBody(RenewLeaseDto, { months: 12, rent: '4700.00' })
  @ApiSuccess(201, {
    description: 'The renewal draft',
    type: LeaseDto,
    example: { ...LEASE_EXAMPLE, status: 'draft', number: null, renewedFromLeaseId: FAKE.uuid },
  })
  @ApiStandardErrors('compliance.acknowledgement_required', 'lease.invalid_state', ...WRITE)
  async renew(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: RenewLeaseDto,
  ): Promise<LeaseDto> {
    return leaseDto(await this.leases.renew(ctx, id, body));
  }

  @Post(':leaseId/invitations')
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.leases.invite',
    summary: 'Invite a resident to the lease',
    description:
      'A one-time code for a party of this lease (the lessee by default), valid `invitation.expiry_days`: shown as a LINE QR, sent by SMS, or a link. The resident opens the LINE Mini App, signs in with LINE, gives the PDPA consents and accepts (D-025, D-061).',
    implements: ['D-025', 'D-061'],
  })
  @ApiJsonBody(LeaseInvitationCreateDto, { channel: 'line_qr' })
  @ApiSuccess(201, {
    description: 'Created; the code is shown once',
    type: LeaseInvitationCreatedDto,
    example: {
      ...INVITATION_EXAMPLE,
      code: 'ABCD-EFGH-JKLM-NPQR',
      url: 'https://liff.getproperty.invalid/link?code=ABCD-EFGH-JKLM-NPQR',
      qrPngDataUrl: `data:image/png;base64,${PNG_EXAMPLE}`,
    },
  })
  @ApiStandardErrors('lease.invalid_state', 'provider.unavailable', ...WRITE)
  async invite(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: LeaseInvitationCreateDto,
  ): Promise<LeaseInvitationCreatedDto> {
    const r = await this.residents.invite(ctx, id, body);
    return { ...invitationDto(r.invitation), code: r.code, url: r.url, qrPngDataUrl: r.qrPngDataUrl };
  }

  @Get(':leaseId/invitations')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leases.listInvitations',
    summary: 'Invitations of a lease',
    description:
      'Pending, accepted, expired and revoked resident invitations (codes are never shown again, D-061).',
    implements: ['D-061'],
  })
  @ApiSuccess(200, { description: 'Invitations', type: [LeaseInvitationDto], example: [INVITATION_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async invitations(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) id: string,
  ): Promise<LeaseInvitationDto[]> {
    return (await this.residents.listInvitations(ctx, id)).map(invitationDto);
  }
}

@ApiTags('owner.leaseTemplates')
@ApiSurface(SURFACES.owner)
@Controller('owner/lease-templates')
export class OwnerLeaseTemplatesController {
  constructor(private readonly leases: LeasesService) {}

  @Get()
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.leaseTemplates.list',
    summary: 'Contract templates',
    description:
      'The platform standard residential lease (สคบ. 2568, Thai) with its versions, the clause types an addendum may use and the forbidden ones (D-020).',
    implements: ['D-020'],
  })
  @ApiSuccess(200, {
    description: 'Templates',
    type: [LeaseTemplateDto],
    example: [
      {
        id: FAKE.uuid,
        key: 'ocpb_2568_residential_th',
        name: 'สัญญาเช่าอาคารเพื่ออยู่อาศัย (แบบมาตรฐาน สคบ. 2568)',
        platform: true,
        versions: [
          {
            id: FAKE.uuid,
            version: 1,
            language: 'th',
            state: 'published',
            effectiveFrom: '2025-09-04',
            legalRef: 'ประกาศคณะกรรมการว่าด้วยสัญญา … พ.ศ. 2568 ข้อ 4–6',
            forbiddenClauseTypes: ['renewal_fee', 'lockout_or_removal'],
            allowedClauseTypes: ['house_rules', 'pets'],
          },
        ],
      },
    ],
  })
  @ApiStandardErrors(...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<LeaseTemplateDto[]> {
    return (await this.leases.templates(ctx)).map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      platform: t.tenantId === null,
      versions: t.versions.map((v) => ({
        id: v.id,
        version: v.version,
        language: v.language,
        state: v.state as TemplateVersionStateName,
        effectiveFrom: dateOnly(v.effectiveFrom)!,
        legalRef: v.legalRef,
        forbiddenClauseTypes: v.forbiddenClauseTypes,
        allowedClauseTypes: (((v.clauseSchema ?? {}) as { allowed?: string[] }).allowed ??
          []) as AddendumClauseTypeName[],
      })),
    }));
  }
}

// ------------------------------------------------------------------------------------------- resident

@ApiTags('resident.leases')
@ApiSurface(SURFACES.resident)
@Controller('resident/leases')
export class ResidentLeasesController {
  constructor(private readonly residents: ResidentLeasesService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.leases.list',
    summary: 'My leases',
    description:
      'Every lease of the parties linked to my login, across tenants (one LINE account, several leases, D-061); drafts and cancelled leases are never shown.',
    implements: ['D-061', 'D-154'],
  })
  @ApiSuccess(200, { description: 'Leases', type: [ResidentLeaseDto], example: [RESIDENT_LEASE_EXAMPLE] })
  @ApiStandardErrors('auth.unauthenticated')
  async list(): Promise<ResidentLeaseDto[]> {
    const { rows, partyIds } = await this.residents.listWithParties();
    const today = this.residents.today();
    return rows.map((l) => residentLeaseDto(l, partyIds, today));
  }

  @Get(':leaseId')
  @ApiEndpoint({
    id: 'resident.leases.get',
    summary: 'One of my leases',
    description:
      'Needs the `lease:<id>` scope of my token and a link to a party of the lease (404 otherwise, contract §8).',
    implements: ['D-061', 'D-154'],
  })
  @ApiSuccess(200, { description: 'The lease', type: ResidentLeaseDto, example: RESIDENT_LEASE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('leaseId', ParseUUIDPipe) id: string): Promise<ResidentLeaseDto> {
    const a = await this.residents.access(id);
    const tenant = await this.residents.tenantOf(a.ctx.tenantId);
    return residentLeaseDto({ ...a.lease, tenant }, a.partyIds, this.residents.today());
  }

  @Get(':leaseId/contract')
  @ApiEndpoint({
    id: 'resident.leases.contract',
    summary: 'Open the contract',
    description:
      'A 5-minute signed URL of the contract PDF and its sha256 — send that sha256 back when signing; the signed contract after countersignature (D-062). Audited.',
    implements: ['D-062'],
  })
  @ApiSuccess(200, {
    description: 'Download',
    type: ContractDownloadDto,
    example: {
      documentId: FAKE.uuid,
      number: 'CTR-2026-00001',
      url: 'https://storage.example.com/contract.pdf?X-Amz-Signature=abc',
      expiresAt: '2026-11-01T00:20:00+07:00',
      sha256: CONTRACT_SHA_EXAMPLE,
      signed: false,
    },
  })
  @ApiStandardErrors('http.not_found', 'lease.invalid_state', 'validation.failed')
  async contract(@Param('leaseId', ParseUUIDPipe) id: string): Promise<ContractDownloadDto> {
    const r = await this.residents.contract(id);
    return {
      documentId: r.document.id,
      number: r.lease.number,
      url: r.url,
      expiresAt: iso(r.expiresAt),
      sha256: r.sha256,
      signed: r.signed,
    };
  }

  @Post(':leaseId/signature/otp')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.leases.requestSignatureOtp',
    summary: 'Send my signature OTP',
    description:
      'Step 1 of the e-signature: a 6-digit SMS code to the phone the office recorded for me (D-062). The lease must be waiting for my signature.',
    implements: ['D-062'],
  })
  @ApiJsonBody(ResidentSignatureOtpRequestDto, { language: 'th' })
  @ApiSuccess(200, {
    description: 'Code sent',
    type: ResidentSignatureOtpDto,
    example: {
      challengeId: FAKE.uuid,
      expiresAt: '2026-11-01T00:20:00+07:00',
      resendAvailableAt: '2026-11-01T00:16:00+07:00',
      phoneMasked: '+66•••••1234',
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'http.bad_request',
    'validation.failed',
    'lease.invalid_state',
    'lease.not_signer',
    'lease.already_signed',
    'lease.lessee_identity_missing',
    'auth.otp_rate_limited',
    'provider.unavailable',
  )
  async otp(
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: ResidentSignatureOtpRequestDto,
    @AcceptLanguage() acceptLanguage?: string,
  ): Promise<ResidentSignatureOtpDto> {
    const r = await this.residents.requestSignatureOtp(id, body.language ?? resolveLanguage(acceptLanguage));
    return {
      challengeId: r.challenge.challengeId,
      expiresAt: iso(r.challenge.expiresAt),
      resendAvailableAt: iso(r.challenge.resendAvailableAt),
      phoneMasked: r.phoneMasked,
    };
  }

  @Post(':leaseId/sign')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.leases.sign',
    summary: 'Sign the lease',
    description:
      'Step 2 (D-062): the OTP, the sha256 of the contract PDF I read (409 `lease.contract_changed` when it differs) and my drawn signature (PNG ≤ 200 KB). Evidence kept: OTP challenge, LINE user id, PDF hash, time, IP, device. The lease activates when the lessor countersigns.',
    implements: ['D-062'],
  })
  @ApiJsonBody(ResidentSignDto, {
    challengeId: FAKE.uuid,
    code: '123456',
    contractSha256: CONTRACT_SHA_EXAMPLE,
    signaturePng: PNG_EXAMPLE,
  })
  @ApiSuccess(200, {
    description: 'Signed',
    type: ResidentLeaseDto,
    example: { ...RESIDENT_LEASE_EXAMPLE, signatureRequired: false, nextActions: ['view-contract'] },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'lease.invalid_state',
    'lease.not_signer',
    'lease.already_signed',
    'lease.contract_changed',
    'lease.signature_invalid',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
  )
  async sign(
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: ResidentSignDto,
  ): Promise<ResidentLeaseDto> {
    const r = await this.residents.sign(id, {
      challengeId: body.challengeId,
      code: body.code,
      contractSha256: body.contractSha256,
      signaturePng: Buffer.from(body.signaturePng, 'base64'),
    });
    const a = await this.residents.access(id);
    const tenant = await this.residents.tenantOf(r.lease.tenantId);
    return residentLeaseDto({ ...r.lease, tenant }, a.partyIds, this.residents.today());
  }

  @Post(':leaseId/notice')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.leases.giveNotice',
    summary: 'Give my 30-day notice',
    description:
      'The lessee ends the lease with written notice of at least 30 days (ข้อ 4 (11), `compliance.notice_period`); shorter periods are refused here — talk to the office (D-020).',
    implements: ['D-020', 'D-063'],
  })
  @ApiCompliance('compliance.notice_period')
  @ApiJsonBody(ResidentNoticeDto, { effectiveDate: '2026-12-31', reason: 'ย้ายที่ทำงาน' })
  @ApiSuccess(200, {
    description: 'Notice recorded',
    type: ResidentLeaseDto,
    example: {
      ...RESIDENT_LEASE_EXAMPLE,
      status: 'notice_given',
      signatureRequired: false,
      nextActions: ['view-contract'],
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'http.bad_request',
    'validation.failed',
    'lease.invalid_state',
    'lease.not_signer',
  )
  async notice(
    @Param('leaseId', ParseUUIDPipe) id: string,
    @Body() body: ResidentNoticeDto,
  ): Promise<ResidentLeaseDto> {
    const lease = await this.residents.notice(id, body);
    const a = await this.residents.access(id);
    const tenant = await this.residents.tenantOf(lease.tenantId);
    return residentLeaseDto({ ...lease, tenant }, a.partyIds, this.residents.today());
  }

  @Post(':leaseId/rules/acknowledge')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.leases.acknowledgeRules',
    summary: 'Acknowledge the building rules',
    description:
      'I confirm that I read the building rules of my lease’s addendum (`house_rules`, `pets`, `smoking`, `guests`, `quiet_hours`, `parking_rules`, `waste`). Recorded on my lease-party rows with who and when, audited (`lease.rules_acknowledged`); repeating it changes nothing. 409 `lease.invalid_state` for an ended or cancelled lease or a lease without rule clauses (D-063, D-203).',
    implements: ['D-063', 'D-203'],
  })
  @ApiSuccess(200, {
    description: 'Acknowledged',
    type: ResidentLeaseDto,
    example: {
      ...RESIDENT_LEASE_EXAMPLE,
      rulesAcknowledgedAt: FAKE.dateTime,
      nextActions: ['view-contract', 'sign'],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'lease.invalid_state')
  async acknowledgeRules(@Param('leaseId', ParseUUIDPipe) id: string): Promise<ResidentLeaseDto> {
    const lease = await this.residents.acknowledgeRules(id);
    const a = await this.residents.access(id);
    const tenant = await this.residents.tenantOf(lease.tenantId);
    return residentLeaseDto({ ...lease, tenant }, a.partyIds, this.residents.today());
  }
}

@ApiTags('resident.invitations')
@ApiSurface(SURFACES.resident)
@Controller('resident/invitations/:code')
export class ResidentInvitationsController {
  constructor(private readonly residents: ResidentLeasesService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.invitations.preview',
    summary: 'What an invitation is for',
    description:
      'The property, unit and a masked name before I accept (D-061); 404 for an unknown code, 409 when used or expired.',
    implements: ['D-061'],
  })
  @ApiSuccess(200, {
    description: 'Preview',
    type: InvitationPreviewDto,
    example: {
      tenantName: FAKE.propertyName,
      buildingName: 'อาคาร A',
      unitNo: FAKE.unitCode,
      partyDisplayName: 'ผู้••••••',
      leaseStatus: 'pending_signature',
      startDate: FAKE.date,
      expiresAt: '2026-11-08T00:15:00+07:00',
    },
  })
  @ApiStandardErrors('invitation.not_found', 'invitation.not_pending')
  async preview(@Param('code') code: string): Promise<InvitationPreviewDto> {
    const p = await this.residents.previewInvitation(code);
    return {
      ...p,
      leaseStatus: p.leaseStatus as LeaseStatusName,
      startDate: dateOnly(p.startDate)!,
      expiresAt: iso(p.expiresAt),
    };
  }

  @Post('accept')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.invitations.accept',
    summary: 'Accept a lease invitation',
    description:
      'Links my login to the invited party (D-061). The required PDPA consents must be given first (409 `consent.required`, D-025); they then also bind this tenant as controller. Refresh my token to receive the `lease:` scope.',
    implements: ['D-025', 'D-061'],
  })
  @ApiSuccess(200, {
    description: 'Accepted',
    type: InvitationAcceptedDto,
    example: {
      tenantId: FAKE.tenantId,
      leaseId: FAKE.uuid,
      partyId: FAKE.uuid,
      refreshRequired: true,
      acceptedOn: FAKE.date,
    },
  })
  @ApiStandardErrors(
    'invitation.not_found',
    'invitation.not_pending',
    'invitation.party_mismatch',
    'consent.required',
  )
  async accept(
    @Param('code') code: string,
    @AcceptLanguage() acceptLanguage?: string,
  ): Promise<InvitationAcceptedDto> {
    return this.residents.acceptInvitation(code, resolveLanguage(acceptLanguage));
  }
}

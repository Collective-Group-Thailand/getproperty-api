import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { AcceptLanguage, resolveLanguage } from '@common/i18n/language';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import {
  ApiCompliance,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { type LeaseTemplate, type LeaseTemplateVersion } from '@generated/prisma/client';
import { type ClauseDiff } from '@modules/ops-leases/contract-diff';
import {
  ContractLibraryService,
  type Disclaimer,
  type TemplateCheckResult,
} from '@modules/ops-leases/contract-library.service';
import { type ContractRow, ContractsService } from '@modules/ops-leases/contracts.service';
import { LeaseRenewalsService, type OfferRow } from '@modules/ops-leases/lease-renewals.service';
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
import { type Response } from 'express';

import { type LanguageName } from '../shared/common.dto';
import { dateOnly, iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type ClauseFindingSourceName,
  type ClauseStatusName,
  ContractCreateDto,
  type ContractDocumentStateName,
  ContractDto,
  type ContractKindName,
  ContractLibraryDto,
  ContractLibraryQuery,
  ContractListQuery,
  ContractOperatorSignDto,
  ContractsDto,
  type ContractSignerRoleName,
  ContractTemplateCheckDto,
  ContractTemplateCopyDto,
  ContractTemplateDetailDto,
  ContractTemplateDiffDto,
  ContractTemplateDto,
  ContractTemplatePublishedDto,
  ContractTemplateUpdateDto,
  type ContractTemplateVersionDto,
  type LegalReviewStateName,
  RenewalOfferCreateDto,
  RenewalOfferDto,
  RenewalOfferQuery,
  RenewalOffersDto,
  type RenewalOfferStateName,
  type RenewalRentSourceName,
  RenewalSuggestionDto,
  type SignableContractKindName,
  type TemplateStateName,
} from './contracts.dto';
import {
  type ComplianceSeverityName,
  ContractDownloadDto,
  ResidentSignatureOtpDto,
  ResidentSignatureOtpRequestDto,
  ResidentSignDto,
} from './leases.dto';
import { MandateReasonDto } from './mandates.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const PNG_EXAMPLE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF_EXAMPLE = 'JVBERi0xLjcK… (pdf bytes)';
const DISCLAIMER = {
  th: 'ตัวอย่างสัญญาเพื่ออำนวยความสะดวก ไม่ใช่คำแนะนำทางกฎหมาย',
  en: 'A sample contract provided for convenience; not legal advice.',
  settingKey: 'contract.library.disclaimer',
};

const png = (base64: string): Buffer => Buffer.from(base64, 'base64');

function me(): string {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return actor.publicId;
}

// ------------------------------------------------------------------------------------------------- mappers

export function templateVersionDto(v: LeaseTemplateVersion): ContractTemplateVersionDto {
  return {
    id: v.id,
    version: v.version,
    language: v.language as LanguageName,
    state: v.state as TemplateStateName,
    legalReviewState: v.legalReviewState as LegalReviewStateName,
    legalReviewedAt: isoOrNull(v.legalReviewedAt),
    effectiveFrom: dateOnly(v.effectiveFrom)!,
    publishedAt: isoOrNull(v.publishedAt),
    derivedFromVersionId: v.derivedFromVersionId,
    legalRef: v.legalRef,
  };
}

export function templateDto(t: LeaseTemplate & { versions: LeaseTemplateVersion[] }): ContractTemplateDto {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    kind: t.kind as ContractKindName,
    platform: t.tenantId === null,
    versions: t.versions.map(templateVersionDto),
  };
}

function detailDto(
  d: Awaited<ReturnType<ContractLibraryService['detail']>>,
  disclaimer: Disclaimer,
): ContractTemplateDetailDto {
  return {
    ...templateDto(d.template),
    current: templateVersionDto(d.version),
    bodyHtml: d.version.bodyHtml,
    base: d.base ? templateVersionDto(d.base) : null,
    variables: d.variables,
    disclaimer,
  };
}

function checkDto(c: TemplateCheckResult): ContractTemplateCheckDto {
  return {
    inScope: c.inScope,
    problems: c.problems,
    unknownVariables: c.unknownVariables,
    findings: c.findings.map((f) => ({
      ...f,
      source: f.source as ClauseFindingSourceName,
      severity: f.severity as ComplianceSeverityName,
    })),
    publishable: c.publishable,
  };
}

export function contractDto(row: ContractRow, disclaimer: Disclaimer, nextActions: string[]): ContractDto {
  const signedAt = new Map(row.signatures.map((s) => [s.signerIndex, s.signedAt]));
  return {
    id: row.id,
    kind: row.kind as SignableContractKindName,
    title: row.title,
    number: row.number,
    state: row.state as ContractDocumentStateName,
    language: row.language as LanguageName,
    templateVersionId: row.templateVersionId,
    templateKey: row.templateVersion.template.key,
    templateVersion: row.templateVersion.version,
    legalReviewState: row.templateVersion.legalReviewState as LegalReviewStateName,
    disclaimer,
    leaseId: row.leaseId,
    unitId: row.unitId,
    coBrokeAgreementId: row.coBrokeAgreementId,
    mandateId: row.mandateId,
    counterpartyTenantId: row.counterpartyTenantId,
    signers: ContractsService.signers(row).map((s) => ({
      index: s.index,
      role: s.role as ContractSignerRoleName,
      name: s.name,
      partyId: s.partyId ?? null,
      tenantId: s.tenantId ?? null,
      signedAt: isoOrNull(signedAt.get(s.index) ?? null),
    })),
    variables: (row.variables ?? {}) as Record<string, unknown>,
    sha256: row.sha256 ? Buffer.from(row.sha256).toString('hex') : null,
    sentAt: isoOrNull(row.sentAt),
    signedAt: isoOrNull(row.signedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
    nextActions,
    createdAt: iso(row.createdAt),
  };
}

export function offerDto(o: OfferRow, nextActions: string[] = []): RenewalOfferDto {
  return {
    id: o.id,
    leaseId: o.leaseId,
    unitId: o.unitId,
    noticeId: o.noticeId,
    currentRent: o.currentRent.toFixed(2),
    suggestedRent: o.suggestedRent?.toFixed(2) ?? null,
    suggestionSource: o.suggestionSource as RenewalRentSourceName,
    offeredRent: o.offeredRent.toFixed(2),
    months: o.months,
    startDate: dateOnly(o.startDate)!,
    respondBy: dateOnly(o.respondBy)!,
    state: o.state as RenewalOfferStateName,
    message: o.message,
    newLeaseId: o.newLeaseId,
    decidedAt: isoOrNull(o.decidedAt),
    declineReason: o.declineReason,
    nextActions,
    createdAt: iso(o.createdAt),
  };
}

// ------------------------------------------------------------------------------------------------- examples

const VERSION_EXAMPLE: ContractTemplateVersionDto = {
  id: FAKE.uuid,
  version: 1,
  language: 'th' as LanguageName,
  state: 'published' as TemplateStateName,
  legalReviewState: 'pending_legal_verification' as LegalReviewStateName,
  legalReviewedAt: null,
  effectiveFrom: FAKE.date,
  publishedAt: FAKE.dateTime,
  derivedFromVersionId: null,
  legalRef: '⚖ ร่างโดยระบบ รอการตรวจสอบทางกฎหมาย (O-025)',
};
const TEMPLATE_EXAMPLE: ContractTemplateDto = {
  id: FAKE.uuid,
  key: 'library_reservation',
  name: 'สัญญาจองห้องเช่า (ร่างจากคลังสัญญา)',
  kind: 'reservation' as ContractKindName,
  platform: true,
  versions: [VERSION_EXAMPLE],
};
const DETAIL_EXAMPLE: ContractTemplateDetailDto = {
  ...TEMPLATE_EXAMPLE,
  key: 'my_reservation_1',
  name: 'สัญญาจองของบ้านมาลี',
  platform: false,
  versions: [
    {
      ...VERSION_EXAMPLE,
      state: 'draft' as TemplateStateName,
      publishedAt: null,
      derivedFromVersionId: FAKE.uuid,
    },
  ],
  current: {
    ...VERSION_EXAMPLE,
    state: 'draft' as TemplateStateName,
    publishedAt: null,
    derivedFromVersionId: FAKE.uuid,
  },
  bodyHtml:
    '<article class="contract"><section><h2>เงินจอง</h2><p>{{reservation.fee}}</p></section></article>',
  base: VERSION_EXAMPLE,
  variables: ['premises.unitNo', 'reservation.fee'],
  disclaimer: DISCLAIMER,
};
const CHECK_EXAMPLE: ContractTemplateCheckDto = {
  inScope: false,
  problems: [],
  unknownVariables: [],
  findings: [
    {
      clauseType: 'renewal_fee',
      clauseKey: 'ข้อ ๑๒ ข้อปฏิบัติของผู้ให้เช่า',
      clauseTitle: 'ข้อ ๑๒ ข้อปฏิบัติของผู้ให้เช่า',
      source: 'added_wording' as ClauseFindingSourceName,
      excerpt: 'ค่าต่อสัญญา',
      legalRef: 'ประกาศคณะกรรมการว่าด้วยสัญญา … พ.ศ. 2568 ข้อ 5 (11) ⚖',
      severity: 'warn' as ComplianceSeverityName,
    },
  ],
  publishable: true,
};
const CONTRACT_EXAMPLE: ContractDto = {
  id: FAKE.uuid,
  kind: 'reservation' as SignableContractKindName,
  title: 'สัญญาจองห้องเช่า (ร่างจากคลังสัญญา) A-101',
  number: 'CTR-2026-00002',
  state: 'pending_signature' as ContractDocumentStateName,
  language: 'th' as LanguageName,
  templateVersionId: FAKE.uuid,
  templateKey: 'library_reservation',
  templateVersion: 1,
  legalReviewState: 'pending_legal_verification' as LegalReviewStateName,
  disclaimer: DISCLAIMER,
  leaseId: null,
  unitId: FAKE.uuid,
  coBrokeAgreementId: null,
  mandateId: null,
  counterpartyTenantId: null,
  signers: [
    {
      index: 0,
      role: 'lessor' as ContractSignerRoleName,
      name: 'มาลี มีสุข',
      partyId: null,
      tenantId: FAKE.tenantId,
      signedAt: null,
    },
    {
      index: 1,
      role: 'prospect' as ContractSignerRoleName,
      name: 'สมศรี ใจดี',
      partyId: FAKE.uuid,
      tenantId: null,
      signedAt: null,
    },
  ],
  variables: { fee: '5000.00', rent: '15000.00', moveInDate: '2026-12-01', expiresOn: '2026-11-15' },
  sha256: SHA,
  sentAt: FAKE.dateTime,
  signedAt: null,
  cancelledAt: null,
  nextActions: ['sign', 'download', 'cancel'],
  createdAt: FAKE.dateTime,
};
const DOWNLOAD_EXAMPLE: ContractDownloadDto = {
  documentId: FAKE.uuid,
  number: 'CTR-2026-00002',
  url: 'https://storage.example.com/contract.pdf?X-Amz-Signature=abc',
  expiresAt: '2026-11-01T00:20:00+07:00',
  sha256: SHA,
  signed: false,
};
const OFFER_EXAMPLE: RenewalOfferDto = {
  id: FAKE.uuid,
  leaseId: FAKE.uuid,
  unitId: FAKE.uuid,
  noticeId: FAKE.uuid,
  currentRent: '15000.00',
  suggestedRent: '15500.00',
  suggestionSource: 'benchmark' as RenewalRentSourceName,
  offeredRent: '15500.00',
  months: 12,
  startDate: '2027-10-01',
  respondBy: '2027-08-15',
  state: 'offered' as RenewalOfferStateName,
  message: null,
  newLeaseId: null,
  decidedAt: null,
  declineReason: null,
  nextActions: ['withdraw'],
  createdAt: FAKE.dateTime,
};

const pdf = (res: Response, body: Buffer, name: string) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
};

const download = (
  r: Awaited<ReturnType<ContractsService['download']>>,
  number: string | null,
): ContractDownloadDto => ({
  documentId: r.document.id,
  number,
  url: r.url,
  expiresAt: iso(r.expiresAt),
  sha256: r.sha256,
  signed: r.signed,
});

// ------------------------------------------------------------------------------------------------- library (owner)

/**
 * Contract library (G3, D-290, D-294): platform drafts and the tenant's own templates; copy, edit, diff, check and
 * publish. Every draft is pending legal verification (O-025) and carries the disclaimer.
 */
@ApiTags('owner.contractLibrary')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerContractLibraryController {
  constructor(private readonly library: ContractLibraryService) {}

  @Get('contract-library')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contractLibrary.list',
    summary: 'Contract library',
    description:
      'Platform drafts (lease kinds, reservation, brokerage mandate, co-broke, addendum, renewal / termination notice texts; th / en) and the tenant’s own templates with their versions and legal-review state — every draft is `pending_legal_verification` until counsel signs it off and shows the disclaimer (D-290, D-294, O-025).',
    implements: ['D-290', 'D-294'],
  })
  @ApiSuccess(200, {
    description: 'Library',
    type: ContractLibraryDto,
    example: { disclaimer: DISCLAIMER, data: [TEMPLATE_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ContractLibraryQuery,
  ): Promise<ContractLibraryDto> {
    const rows = await this.library.library(ctx, { kind: q.kind, language: q.language });
    return { disclaimer: await this.library.disclaimer(), data: rows.map(templateDto) };
  }

  @Post('contract-templates')
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.contractTemplates.copy',
    summary: 'Copy a library version into my templates',
    description:
      'A new template of the tenant with a draft version 1 holding the copied text; `derivedFromVersionId` keeps the base for the clause diff and the compliance check (D-294).',
    implements: ['D-294'],
  })
  @ApiJsonBody(ContractTemplateCopyDto, { derivedFromVersionId: FAKE.uuid, name: 'สัญญาจองของบ้านมาลี' })
  @ApiSuccess(201, { description: 'Copied', type: ContractTemplateDetailDto, example: DETAIL_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async copy(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ContractTemplateCopyDto,
  ): Promise<ContractTemplateDetailDto> {
    return detailDto(await this.library.copy(ctx, body), await this.library.disclaimer());
  }

  @Get('contract-templates/:templateId')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contractTemplates.get',
    summary: 'One template with its text',
    description:
      'A platform draft or an own template: versions, the text of the open draft (else the latest published), its base and the variables its kind allows (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, { description: 'Template', type: ContractTemplateDetailDto, example: DETAIL_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) id: string,
  ): Promise<ContractTemplateDetailDto> {
    return detailDto(await this.library.detail(ctx, id), await this.library.disclaimer());
  }

  @Patch('contract-templates/:templateId')
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.contractTemplates.update',
    summary: 'Edit my template',
    description:
      'Renames the template or replaces the draft text (allowed HTML only, variables of the kind only — `contract.template_invalid`, `contract.unknown_variable`); editing a published template opens its next draft version. Platform drafts are read-only (404).',
    implements: ['D-294'],
  })
  @ApiJsonBody(ContractTemplateUpdateDto, {
    bodyHtml:
      '<article class="contract"><section><h2>เงินจอง</h2><p>{{reservation.fee}} บาท</p></section></article>',
  })
  @ApiSuccess(200, { description: 'Updated', type: ContractTemplateDetailDto, example: DETAIL_EXAMPLE })
  @ApiStandardErrors('contract.template_invalid', 'contract.unknown_variable', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) id: string,
    @Body() body: ContractTemplateUpdateDto,
  ): Promise<ContractTemplateDetailDto> {
    return detailDto(await this.library.update(ctx, id, body), await this.library.disclaimer());
  }

  @Get('contract-templates/:templateId/diff')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contractTemplates.diff',
    summary: 'Clause diff against the base',
    description:
      'Clause by clause (a clause = a section keyed by its heading): unchanged, changed, added or removed against the library version the template was copied from (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, {
    description: 'Diff',
    type: ContractTemplateDiffDto,
    example: {
      versionId: FAKE.uuid,
      baseVersionId: FAKE.uuid,
      clauses: [
        {
          key: 'เงินจอง',
          title: 'เงินจอง',
          status: 'changed',
          baseText: 'เงินจอง 5,000 บาท',
          text: 'เงินจอง 3,000 บาท',
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async diff(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) id: string,
  ): Promise<ContractTemplateDiffDto> {
    const d = await this.library.diff(ctx, id);
    return {
      versionId: d.version.id,
      baseVersionId: d.base?.id ?? null,
      clauses: d.clauses.map((c: ClauseDiff) => ({ ...c, status: c.status as ClauseStatusName })),
    };
  }

  @Get('contract-templates/:templateId/preview')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contractTemplates.preview',
    summary: 'Preview a template as PDF',
    description:
      'The open draft (else the latest published) filled with sample values, marked as a draft with the disclaimer; not stored (D-294).',
    implements: ['D-294'],
  })
  @ApiResponse({
    status: 200,
    description: 'The PDF',
    content: { 'application/pdf': { schema: { type: 'string', format: 'binary' }, example: PDF_EXAMPLE } },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async preview(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    pdf(res, await this.library.preview(ctx, id), `template-${id}`);
  }

  @Post('contract-templates/:templateId/actions/check')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contractTemplates.check',
    summary: 'Check my template',
    description:
      'Structure, variables and the forbidden clause types of the สคบ. 2568 announcement (protective wording removed, forbidden wording added): `block` inside the scope of D-158, `warn` with the legal reason outside it. Nothing is written (D-294).',
    implements: ['D-294', 'D-158', 'D-020'],
  })
  @ApiSuccess(200, { description: 'Check', type: ContractTemplateCheckDto, example: CHECK_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async check(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) id: string,
  ): Promise<ContractTemplateCheckDto> {
    return checkDto(await this.library.check(ctx, id));
  }

  @Post('contract-templates/:templateId/actions/publish')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.contractTemplates.publish',
    summary: 'Publish my template',
    description:
      'Publishes the open draft after the check: inside the สคบ. scope (D-158) a forbidden clause is refused (422 `compliance.forbidden_clause` with the legal reference); outside it the findings come back as warnings. The version stays `pending_legal_verification` (O-025) and is immutable once published (D-294).',
    implements: ['D-294', 'D-158', 'D-020'],
  })
  @ApiCompliance('compliance.forbidden_clause')
  @ApiSuccess(200, {
    description: 'Published',
    type: ContractTemplatePublishedDto,
    example: { ...DETAIL_EXAMPLE, check: CHECK_EXAMPLE },
  })
  @ApiStandardErrors(
    'contract.invalid_state',
    'contract.template_invalid',
    'contract.unknown_variable',
    ...WRITE,
  )
  async publish(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) id: string,
  ): Promise<ContractTemplatePublishedDto> {
    const r = await this.library.publish(ctx, id);
    return { ...detailDto(r, await this.library.disclaimer()), check: checkDto(r.check) };
  }
}

// ------------------------------------------------------------------------------------------------- documents (owner)

/** Signable contract documents (G3, D-294): reservation, brokerage mandate, co-broke, addendum. */
@ApiTags('owner.contracts')
@ApiSurface(SURFACES.owner)
@Controller('owner/contracts')
export class OwnerContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly library: ContractLibraryService,
  ) {}

  private async dto(ctx: TenantContext, row: ContractRow): Promise<ContractDto> {
    return contractDto(row, await this.library.disclaimer(), this.contracts.nextActions(row, ctx.tenantId));
  }

  @Get()
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contracts.list',
    summary: 'Contract documents',
    description:
      'Documents the tenant wrote or must sign as the counterparty (agency ↔ owner / co-agency), newest first; filter by kind, state or lease (D-294).',
    implements: ['D-294'],
  })
  @ApiPaginated(ContractDto, { example: CONTRACT_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: ContractListQuery): Promise<Page<ContractDto>> {
    const { rows, total } = await this.contracts.list(
      ctx,
      { kind: q.kind, state: q.state, leaseId: q.leaseId },
      toSkipTake(q),
    );
    const disclaimer = await this.library.disclaimer();
    return paginated(
      rows.map((r) => contractDto(r, disclaimer, this.contracts.nextActions(r, ctx.tenantId))),
      total,
      q,
    );
  }

  @Post()
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.contracts.create',
    summary: 'Draft a contract document',
    description:
      'A reservation (unit + party), a brokerage mandate (mandate, written by the owner), a co-broke contract (agreement, written by the listing agency) or a lease addendum (lease): signers and facts are filled from those records, the typed values are checked (unknown keys → `contract.unknown_variable`) and the template version is pinned (D-294).',
    implements: ['D-294', 'D-062'],
  })
  @ApiJsonBody(ContractCreateDto, {
    kind: 'reservation',
    unitId: FAKE.uuid,
    partyId: FAKE.uuid,
    variables: { fee: '5000.00', moveInDate: '2026-12-01', expiresOn: '2026-11-15' },
  })
  @ApiSuccess(201, {
    description: 'Drafted',
    type: ContractDto,
    example: { ...CONTRACT_EXAMPLE, state: 'draft', number: null, sha256: null, sentAt: null },
  })
  @ApiStandardErrors(
    'contract.unknown_variable',
    'lease.invalid_state',
    'co_broke.invalid_state',
    'mandate.invalid_state',
    ...WRITE,
  )
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: ContractCreateDto): Promise<ContractDto> {
    return this.dto(ctx, await this.contracts.create(ctx, body));
  }

  @Get(':contractId')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contracts.get',
    summary: 'One contract document',
    description:
      'A document of the tenant or of which it is the counterparty; anyone else gets 404 (D-294, D-152).',
    implements: ['D-294', 'D-152'],
  })
  @ApiSuccess(200, { description: 'Contract', type: ContractDto, example: CONTRACT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ContractDto> {
    return this.dto(ctx, await this.contracts.get(ctx, id));
  }

  @Get(':contractId/preview')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contracts.preview',
    summary: 'Preview the document PDF',
    description:
      'Rendered now from the pinned template version and current facts, marked as a draft; not stored (D-294).',
    implements: ['D-294'],
  })
  @ApiResponse({
    status: 200,
    description: 'The PDF',
    content: { 'application/pdf': { schema: { type: 'string', format: 'binary' }, example: PDF_EXAMPLE } },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async preview(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    pdf(res, await this.contracts.preview(ctx, id), `contract-${id}`);
  }

  @Get(':contractId/document')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.contracts.document',
    summary: 'Download the document',
    description:
      'A 5-minute signed URL of the signed PDF (else the one to sign) with its sha256 — the value a signer confirms; audited `document.downloaded` (D-062, D-294).',
    implements: ['D-062', 'D-294'],
  })
  @ApiSuccess(200, { description: 'Download', type: ContractDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'contract.invalid_state', ...T)
  async document(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ContractDownloadDto> {
    const row = await this.contracts.get(ctx, id);
    return download(await this.contracts.download(ctx, row, 'contract_document'), row.number);
  }

  @Post(':contractId/actions/send-for-signature')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.contracts.sendForSignature',
    summary: 'Send for signature',
    description:
      'Numbers the document (series `contract`), renders the PDF from the pinned version, stores it under legal hold with its sha256 (D-286) and tells the signers (LINE for parties, the counterparty tenant’s owners) (D-062, D-294).',
    implements: ['D-062', 'D-294', 'D-286'],
  })
  @ApiSuccess(200, { description: 'Sent', type: ContractDto, example: CONTRACT_EXAMPLE })
  @ApiStandardErrors('contract.invalid_state', ...WRITE)
  async send(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ContractDto> {
    return this.dto(ctx, await this.contracts.sendForSignature(ctx, id));
  }

  @Post(':contractId/actions/sign')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.contracts.sign',
    summary: 'Sign for my tenant',
    description:
      'An operator signs for the tenant’s signer role (lessor, owner, agency, co-agency) with a drawn signature (PNG ≤ 200 KB) and the sha256 of the PDF read (409 `contract.changed` when it differs). The last signature renders the signed PDF; a signed co-broke contract signs its agreement (D-062, D-294).',
    implements: ['D-062', 'D-294', 'D-293'],
  })
  @ApiJsonBody(ContractOperatorSignDto, { contractSha256: SHA, signaturePng: PNG_EXAMPLE })
  @ApiSuccess(200, {
    description: 'Signed',
    type: ContractDto,
    example: { ...CONTRACT_EXAMPLE, nextActions: ['download'] },
  })
  @ApiStandardErrors(
    'contract.invalid_state',
    'contract.not_signer',
    'contract.already_signed',
    'contract.changed',
    'contract.signature_invalid',
    ...WRITE,
  )
  async sign(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ContractOperatorSignDto,
  ): Promise<ContractDto> {
    return this.dto(
      ctx,
      await this.contracts.signAsTenant(ctx, id, {
        signaturePng: png(body.signaturePng),
        contractSha256: body.contractSha256,
      }),
    );
  }

  @Post(':contractId/actions/cancel')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.contracts.cancel',
    summary: 'Cancel a contract document',
    description:
      'A draft or a document not yet fully signed; the stored PDF stays (legal hold, D-286, D-294).',
    implements: ['D-294'],
  })
  @ApiJsonBody(MandateReasonDto, { reason: 'ผู้จองเปลี่ยนใจ' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: ContractDto,
    example: { ...CONTRACT_EXAMPLE, state: 'cancelled', cancelledAt: FAKE.dateTime, nextActions: [] },
  })
  @ApiStandardErrors('contract.invalid_state', ...WRITE)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: MandateReasonDto,
  ): Promise<ContractDto> {
    return this.dto(ctx, await this.contracts.cancel(ctx, id, body.reason ?? null));
  }
}

// ------------------------------------------------------------------------------------------------- renewals (owner)

/** Renewal offers (G3, D-294) on top of the B7.5 renewal letter. */
@ApiTags('owner.renewals')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerRenewalsController {
  constructor(private readonly renewals: LeaseRenewalsService) {}

  @Get('leases/:leaseId/renewal-suggestion')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.renewals.suggestion',
    summary: 'Suggested renewal rent',
    description:
      'Candidates in order: the k ≥ 5 `rent_per_m2` benchmark of the district × unit area (only when the tenant shares anonymised analytics, give to get), the median of the comparables of the unit’s listing (D-269), the current rent; the first available is the suggestion (D-294).',
    implements: ['D-294', 'D-269'],
  })
  @ApiSuccess(200, {
    description: 'Suggestion',
    type: RenewalSuggestionDto,
    example: {
      currentRent: '15000.00',
      suggested: { source: 'current_rent', rent: '15000.00', basis: 'the current rent' },
      candidates: [{ source: 'current_rent', rent: '15000.00', basis: 'the current rent' }],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async suggestion(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
  ): Promise<RenewalSuggestionDto> {
    const s = await this.renewals.suggestion(ctx, leaseId);
    return s as RenewalSuggestionDto;
  }

  @Get('leases/:leaseId/renewal-offers')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.renewals.listForLease',
    summary: 'Renewal offers of a lease',
    description: 'Every offer made on the lease with its answer, newest first (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, { description: 'Offers', type: RenewalOffersDto, example: { data: [OFFER_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async forLease(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
  ): Promise<RenewalOffersDto> {
    await this.renewals.assertLease(ctx, leaseId);
    return {
      data: (await this.renewals.list(ctx, { leaseId })).map((o) =>
        offerDto(o, o.state === 'offered' ? ['withdraw'] : []),
      ),
    };
  }

  @Post('leases/:leaseId/renewal-offers')
  @TenantScoped()
  @Can('lease.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.renewals.offer',
    summary: 'Offer a renewal',
    description:
      'Offers rent (default the suggestion) and term (default the current one) for the period after the lease ends; issues the B7.5 renewal letter (numbered PDF, LINE to the resident) in the same transaction; one open offer per lease (`renewal.offer_exists`). The resident answers in LIFF by `respondBy` (`lease.notice.renewal_response_days`) (D-294, D-253).',
    implements: ['D-294', 'D-253'],
  })
  @ApiJsonBody(RenewalOfferCreateDto, { rent: '15500.00', months: 12 })
  @ApiSuccess(201, { description: 'Offered', type: RenewalOfferDto, example: OFFER_EXAMPLE })
  @ApiStandardErrors('renewal.offer_exists', 'lease.invalid_state', ...WRITE)
  async offer(
    @CurrentTenant() ctx: TenantContext,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Body() body: RenewalOfferCreateDto,
  ): Promise<RenewalOfferDto> {
    return offerDto(await this.renewals.offer(ctx, leaseId, body), ['withdraw']);
  }

  @Get('renewal-offers')
  @TenantScoped()
  @Can('lease.read')
  @ApiEndpoint({
    id: 'owner.renewals.list',
    summary: 'Renewal offers',
    description:
      'All offers of the tenant (filter by state), newest first — the renewal workflow board (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, { description: 'Offers', type: RenewalOffersDto, example: { data: [OFFER_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: RenewalOfferQuery): Promise<RenewalOffersDto> {
    return {
      data: (await this.renewals.list(ctx, { state: q.state })).map((o) =>
        offerDto(o, o.state === 'offered' ? ['withdraw'] : []),
      ),
    };
  }

  @Post('renewal-offers/:offerId/actions/withdraw')
  @HttpCode(200)
  @TenantScoped()
  @Can('lease.manage')
  @ApiEndpoint({
    id: 'owner.renewals.withdraw',
    summary: 'Withdraw a renewal offer',
    description: 'An offer not yet answered; the letter stays on record (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, {
    description: 'Withdrawn',
    type: RenewalOfferDto,
    example: { ...OFFER_EXAMPLE, state: 'withdrawn', nextActions: [] },
  })
  @ApiStandardErrors('renewal.invalid_state', 'validation.failed', 'http.not_found', ...T)
  async withdraw(
    @CurrentTenant() ctx: TenantContext,
    @Param('offerId', ParseUUIDPipe) id: string,
  ): Promise<RenewalOfferDto> {
    return offerDto(await this.renewals.withdraw(ctx, id));
  }
}

// ------------------------------------------------------------------------------------------------- parties (LIFF)

/** One controller per audience: the same LINE account is resident and prospect. */
abstract class PartyContractsBase {
  constructor(
    protected readonly contracts: ContractsService,
    protected readonly library: ContractLibraryService,
  ) {}

  protected async dto(row: ContractRow, partyIds: string[]): Promise<ContractDto> {
    const signed = new Set(row.signatures.map((s) => s.signerIndex));
    const mine =
      row.state === 'pending_signature' &&
      ContractsService.signers(row).some(
        (s) => s.partyId && partyIds.includes(s.partyId) && !signed.has(s.index),
      );
    return contractDto(row, await this.library.disclaimer(), [...(mine ? ['sign'] : []), 'download']);
  }

  protected async listMine(): Promise<ContractsDto> {
    const { rows, partyIds } = await this.contracts.mine(me());
    return { data: await Promise.all(rows.map((r) => this.dto(r, partyIds))) };
  }

  protected async one(id: string): Promise<ContractDto> {
    const { row, partyIds } = await this.contracts.access(me(), id);
    return this.dto(row, partyIds);
  }

  protected async file(id: string): Promise<ContractDownloadDto> {
    const { row } = await this.contracts.access(me(), id);
    return download(await this.contracts.download(null, row, 'contract_document_party'), row.number);
  }

  protected async otp(id: string, body: ResidentSignatureOtpRequestDto, acceptLanguage?: string) {
    const r = await this.contracts.requestOtp(me(), id, body.language ?? resolveLanguage(acceptLanguage));
    return {
      challengeId: r.challenge.challengeId,
      expiresAt: iso(r.challenge.expiresAt),
      resendAvailableAt: iso(r.challenge.resendAvailableAt),
      phoneMasked: r.phoneMasked,
    };
  }

  protected async signIt(id: string, body: ResidentSignDto): Promise<ContractDto> {
    const user = me();
    const row = await this.contracts.signAsParty(user, id, {
      challengeId: body.challengeId,
      code: body.code,
      contractSha256: body.contractSha256,
      signaturePng: png(body.signaturePng),
    });
    const { partyIds } = await this.contracts.access(user, id);
    return this.dto(row, partyIds);
  }
}

const OTP_EXAMPLE = {
  challengeId: FAKE.uuid,
  expiresAt: '2026-11-01T00:20:00+07:00',
  resendAvailableAt: '2026-11-01T00:16:00+07:00',
  phoneMasked: '+66•••••1234',
};
const PARTY_SIGN_ERRORS = [
  'http.not_found',
  'validation.failed',
  'contract.invalid_state',
  'contract.already_signed',
  'contract.changed',
  'contract.signature_invalid',
  'auth.otp_invalid',
  'auth.otp_expired',
  'auth.otp_attempts_exceeded',
] as const;
const OTP_ERRORS = [
  'http.not_found',
  'http.bad_request',
  'validation.failed',
  'contract.invalid_state',
  'contract.already_signed',
  'lease.lessee_identity_missing',
  'auth.otp_rate_limited',
  'provider.unavailable',
] as const;

@ApiTags('resident.contracts')
@ApiSurface(SURFACES.resident)
@Controller('resident/contracts')
export class ResidentContractsController extends PartyContractsBase {
  constructor(contracts: ContractsService, library: ContractLibraryService) {
    super(contracts, library);
  }

  @Get()
  @ApiEndpoint({
    id: 'resident.contracts.list',
    summary: 'Contracts I sign',
    description:
      'Reservation, addendum and other library documents waiting for my signature or signed by me, across tenants (parties linked to my login); drafts and cancelled ones are never shown (D-294).',
    implements: ['D-294', 'D-062'],
  })
  @ApiSuccess(200, { description: 'Contracts', type: ContractsDto, example: { data: [CONTRACT_EXAMPLE] } })
  @ApiStandardErrors('auth.unauthenticated')
  list(): Promise<ContractsDto> {
    return this.listMine();
  }

  @Get(':contractId')
  @ApiEndpoint({
    id: 'resident.contracts.get',
    summary: 'One contract I sign',
    description:
      'With the legal-review state and the disclaimer as the API returns them; 404 unless I am a signer (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, { description: 'Contract', type: ContractDto, example: CONTRACT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  get(@Param('contractId', ParseUUIDPipe) id: string): Promise<ContractDto> {
    return this.one(id);
  }

  @Get(':contractId/document')
  @ApiEndpoint({
    id: 'resident.contracts.document',
    summary: 'Open the contract PDF',
    description: 'A 5-minute signed URL and the sha256 to send back when signing (D-062); audited.',
    implements: ['D-062', 'D-294'],
  })
  @ApiSuccess(200, { description: 'Download', type: ContractDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'contract.invalid_state')
  document(@Param('contractId', ParseUUIDPipe) id: string): Promise<ContractDownloadDto> {
    return this.file(id);
  }

  @Post(':contractId/signature/otp')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.contracts.requestSignatureOtp',
    summary: 'Send my signature OTP',
    description: 'Step 1: a 6-digit SMS code to the phone the office recorded for me (D-062).',
    implements: ['D-062', 'D-294'],
  })
  @ApiJsonBody(ResidentSignatureOtpRequestDto, { language: 'th' })
  @ApiSuccess(200, { description: 'Code sent', type: ResidentSignatureOtpDto, example: OTP_EXAMPLE })
  @ApiStandardErrors(...OTP_ERRORS)
  requestOtp(
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ResidentSignatureOtpRequestDto,
    @AcceptLanguage() acceptLanguage?: string,
  ): Promise<ResidentSignatureOtpDto> {
    return this.otp(id, body, acceptLanguage);
  }

  @Post(':contractId/sign')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.contracts.sign',
    summary: 'Sign the contract',
    description:
      'Step 2: the OTP, the sha256 of the PDF I read (409 `contract.changed` otherwise) and my drawn signature; evidence kept (OTP challenge, LINE user id, hash, time, IP, device) (D-062, D-294).',
    implements: ['D-062', 'D-294'],
  })
  @ApiJsonBody(ResidentSignDto, {
    challengeId: FAKE.uuid,
    code: '123456',
    contractSha256: SHA,
    signaturePng: PNG_EXAMPLE,
  })
  @ApiSuccess(200, {
    description: 'Signed',
    type: ContractDto,
    example: { ...CONTRACT_EXAMPLE, nextActions: ['download'] },
  })
  @ApiStandardErrors(...PARTY_SIGN_ERRORS)
  sign(@Param('contractId', ParseUUIDPipe) id: string, @Body() body: ResidentSignDto): Promise<ContractDto> {
    return this.signIt(id, body);
  }
}

@ApiTags('prospect.contracts')
@ApiSurface(SURFACES.prospect)
@Controller('prospect/contracts')
export class ProspectContractsController extends PartyContractsBase {
  constructor(contracts: ContractsService, library: ContractLibraryService) {
    super(contracts, library);
  }

  @Get()
  @ApiEndpoint({
    id: 'prospect.contracts.list',
    summary: 'Contracts I sign',
    description: 'Reservations and other documents for me from owners I enquired with (D-294, D-281).',
    implements: ['D-294', 'D-281'],
  })
  @ApiSuccess(200, { description: 'Contracts', type: ContractsDto, example: { data: [CONTRACT_EXAMPLE] } })
  @ApiStandardErrors('auth.unauthenticated')
  list(): Promise<ContractsDto> {
    return this.listMine();
  }

  @Get(':contractId')
  @ApiEndpoint({
    id: 'prospect.contracts.get',
    summary: 'One contract I sign',
    description: 'With the legal-review state and the disclaimer; 404 unless I am a signer (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, { description: 'Contract', type: ContractDto, example: CONTRACT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  get(@Param('contractId', ParseUUIDPipe) id: string): Promise<ContractDto> {
    return this.one(id);
  }

  @Get(':contractId/document')
  @ApiEndpoint({
    id: 'prospect.contracts.document',
    summary: 'Open the contract PDF',
    description: 'A 5-minute signed URL and the sha256 to send back when signing (D-062); audited.',
    implements: ['D-062', 'D-294'],
  })
  @ApiSuccess(200, { description: 'Download', type: ContractDownloadDto, example: DOWNLOAD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'contract.invalid_state')
  document(@Param('contractId', ParseUUIDPipe) id: string): Promise<ContractDownloadDto> {
    return this.file(id);
  }

  @Post(':contractId/signature/otp')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'prospect.contracts.requestSignatureOtp',
    summary: 'Send my signature OTP',
    description: 'Step 1: a 6-digit SMS code to the phone the owner recorded for me (D-062).',
    implements: ['D-062', 'D-294'],
  })
  @ApiJsonBody(ResidentSignatureOtpRequestDto, { language: 'th' })
  @ApiSuccess(200, { description: 'Code sent', type: ResidentSignatureOtpDto, example: OTP_EXAMPLE })
  @ApiStandardErrors(...OTP_ERRORS)
  requestOtp(
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ResidentSignatureOtpRequestDto,
    @AcceptLanguage() acceptLanguage?: string,
  ): Promise<ResidentSignatureOtpDto> {
    return this.otp(id, body, acceptLanguage);
  }

  @Post(':contractId/sign')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'prospect.contracts.sign',
    summary: 'Sign the contract',
    description:
      'Step 2: OTP, the sha256 of the PDF I read and my drawn signature; evidence kept (D-062, D-294).',
    implements: ['D-062', 'D-294'],
  })
  @ApiJsonBody(ResidentSignDto, {
    challengeId: FAKE.uuid,
    code: '123456',
    contractSha256: SHA,
    signaturePng: PNG_EXAMPLE,
  })
  @ApiSuccess(200, {
    description: 'Signed',
    type: ContractDto,
    example: { ...CONTRACT_EXAMPLE, nextActions: ['download'] },
  })
  @ApiStandardErrors(...PARTY_SIGN_ERRORS)
  sign(@Param('contractId', ParseUUIDPipe) id: string, @Body() body: ResidentSignDto): Promise<ContractDto> {
    return this.signIt(id, body);
  }
}

@ApiTags('resident.renewals')
@ApiSurface(SURFACES.resident)
@Controller('resident/renewal-offers')
export class ResidentRenewalOffersController {
  constructor(private readonly renewals: LeaseRenewalsService) {}

  private leaseScopes(): string[] {
    const actor = RequestContext.actor();
    const scopes = actor && 'scopes' in actor ? actor.scopes : [];
    return scopes.filter((s) => s.startsWith('lease:')).map((s) => s.slice('lease:'.length));
  }

  @Get()
  @ApiEndpoint({
    id: 'resident.renewals.list',
    summary: 'Renewal offers for me',
    description:
      'Offers on the leases of my token, newest first; `nextActions` has accept / decline while an offer is open and I am a lessee (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, {
    description: 'Offers',
    type: RenewalOffersDto,
    example: { data: [{ ...OFFER_EXAMPLE, nextActions: ['accept', 'decline'] }] },
  })
  @ApiStandardErrors('auth.unauthenticated')
  async list(): Promise<RenewalOffersDto> {
    const rows = await this.renewals.residentList(this.leaseScopes());
    const today = this.renewals.today();
    return {
      data: rows.map((o) =>
        offerDto(o, o.state === 'offered' && dateOnly(o.respondBy)! >= today ? ['accept', 'decline'] : []),
      ),
    };
  }

  @Get(':offerId')
  @ApiEndpoint({
    id: 'resident.renewals.get',
    summary: 'One renewal offer',
    description: 'An offer on a lease of mine (404 otherwise, contract §8) (D-294).',
    implements: ['D-294'],
  })
  @ApiSuccess(200, {
    description: 'Offer',
    type: RenewalOfferDto,
    example: { ...OFFER_EXAMPLE, nextActions: ['accept', 'decline'] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async get(@Param('offerId', ParseUUIDPipe) id: string): Promise<RenewalOfferDto> {
    const { row, lessee } = await this.renewals.residentAccess(id);
    const open = row.state === 'offered' && dateOnly(row.respondBy)! >= this.renewals.today();
    return offerDto(row, open && lessee ? ['accept', 'decline'] : []);
  }

  @Post(':offerId/actions/accept')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.renewals.accept',
    summary: 'Accept the renewal',
    description:
      'The renewal lease is drafted from my lease at the offered rent and term (deposit carried, no renewal fee) and sent to me for e-signature (`newLeaseId`; refresh my session to open it); the current lease closes by itself at its end once the renewal is signed. `renewal.invalid_state` after `respondBy` or once answered (D-294, D-020).',
    implements: ['D-294', 'D-020', 'D-062'],
  })
  @ApiSuccess(200, {
    description: 'Accepted',
    type: RenewalOfferDto,
    example: {
      ...OFFER_EXAMPLE,
      state: 'accepted',
      newLeaseId: FAKE.uuid,
      decidedAt: FAKE.dateTime,
      nextActions: [],
    },
  })
  @ApiStandardErrors(
    'renewal.invalid_state',
    'lease.not_signer',
    'compliance.acknowledgement_required',
    'http.not_found',
    'validation.failed',
  )
  async accept(@Param('offerId', ParseUUIDPipe) id: string): Promise<RenewalOfferDto> {
    return offerDto(await this.renewals.accept(id));
  }

  @Post(':offerId/actions/decline')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.renewals.decline',
    summary: 'Decline the renewal',
    description:
      'With 30 days or more left, my notice to the end date is recorded and the move-out follows (D-219); with fewer days the lease simply ends on its end date. The owner is told (D-294).',
    implements: ['D-294', 'D-219', 'D-020'],
  })
  @ApiJsonBody(MandateReasonDto, { reason: 'ย้ายไปทำงานต่างจังหวัด' })
  @ApiSuccess(200, {
    description: 'Declined',
    type: RenewalOfferDto,
    example: {
      ...OFFER_EXAMPLE,
      state: 'declined',
      decidedAt: FAKE.dateTime,
      declineReason: 'ย้ายไปทำงานต่างจังหวัด',
      nextActions: [],
    },
  })
  @ApiStandardErrors(
    'renewal.invalid_state',
    'lease.not_signer',
    'lease.invalid_state',
    'http.not_found',
    'validation.failed',
  )
  async decline(
    @Param('offerId', ParseUUIDPipe) id: string,
    @Body() body: MandateReasonDto,
  ): Promise<RenewalOfferDto> {
    return offerDto(await this.renewals.decline(id, body.reason ?? null));
  }
}

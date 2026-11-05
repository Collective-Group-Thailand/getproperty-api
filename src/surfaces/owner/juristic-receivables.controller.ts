import { AllowWhenReadOnly, CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
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
import { type Page, PageQuery } from '@common/pagination/pagination.dto';
import { toBangkokIso } from '@common/time/bangkok';
import { permissionsOf } from '@core/tenancy/access.service';
import { type LetterBatch, type WorkspaceLink } from '@generated/prisma/client';
import { CollectionReportsService } from '@modules/ops-juristic/collection-reports.service';
import {
  type CollectionCaseRow,
  type CollectionLadderRow,
  CollectionsService,
} from '@modules/ops-juristic/collections.service';
import { legalReviewRequired } from '@modules/ops-juristic/collections/ladder-templates';
import { JuristicWorkspaceService } from '@modules/ops-juristic/juristic-workspace.service';
import {
  type StatementRow,
  type StatementSnapshot,
  StatementsService,
} from '@modules/ops-juristic/statements.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { type LanguageName } from '../shared/common.dto';
import { isoOrNull } from '../shared/mappers';
import { type BuildingLegalFormName } from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';
import { INVOICE_EXAMPLE, invoiceDto } from './billing.controller';
import { InvoiceDto } from './billing.dto';
import { DocumentDownloadDto } from './deposits.dto';
import { EXPORT_EXAMPLE, exportDto } from './documents.controller';
import { ExportJobDto, type ExportKindName, type ExportStatusName } from './documents.dto';
import { type BudgetLineKindName } from './juristic.dto';
import {
  AgingQuery,
  BudgetActualIncomeDto,
  CaseReasonDto,
  type CollectionActionName,
  CollectionCaseDto,
  CollectionCaseListQuery,
  type CollectionCaseStateName,
  type CollectionChannelName,
  type CollectionEventKindName,
  CollectionLadderDto,
  CollectionLadderListDto,
  type CollectionOutcomeName,
  CollectionRateDto,
  CollectionRateQuery,
  CollectionStepUpdateDto,
  type IncomeKindName,
  JuristicAgingDto,
  LetterBatchCreateDto,
  LetterBatchDto,
  type LetterBatchStateName,
  ReceivablesExportDto,
  ReceivablesPageDto,
  ReceivablesQuery,
  StatementDto,
  StatementIssueDto,
  StatementIssueResultDto,
  StatementListQuery,
  StatementPaymentCreateDto,
  StatementPaymentResultDto,
  StepDecisionDto,
  WorkspaceInvitationCreateDto,
  WorkspaceInvitationDto,
  WorkspaceInvitationListDto,
  WorkspaceInvoiceCreateDto,
  type WorkspaceLinkStateName,
  WorkspaceUnitListDto,
} from './juristic-receivables.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);
const permsOf = (ctx: TenantContext): ReadonlySet<string> => permissionsOf(ctx.role ? [ctx.role] : []);

// ------------------------------------------------------------------------------------------- mappers

export function ladderDto(l: CollectionLadderRow, gates: Map<string, string | null>): CollectionLadderDto {
  return {
    id: l.id,
    legalForm: l.legalForm as BuildingLegalFormName,
    name: l.name,
    sourceTemplateKey: l.sourceTemplateKey,
    steps: l.steps.map((s) => ({
      id: s.id,
      seq: s.seq,
      offsetDays: s.offsetDays,
      action: s.action as CollectionActionName,
      channels: s.channels as CollectionChannelName[],
      templateKey: s.templateKey,
      requiresApproval: s.requiresApproval,
      enabled: s.enabled,
      legalReviewRequired: legalReviewRequired(s.action),
      gateClosedReason: gates.get(s.id) ?? null,
      version: s.version,
    })),
  };
}

function caseActions(ctx: TenantContext, c: CollectionCaseRow): string[] {
  const perms = permsOf(ctx);
  const out: string[] = [];
  if (c.state === 'resolved') return out;
  if (perms.has('juristic.collections.manage'))
    out.push(c.disputeOpenedAt ? 'close_dispute' : 'open_dispute');
  if (c.awaitingStepId && c.state === 'open' && perms.has('juristic.collections.approve'))
    out.push('approve_step', 'refuse_step');
  return out;
}

export function caseDto(
  service: CollectionsService,
  ctx: TenantContext,
  c: CollectionCaseRow,
): CollectionCaseDto {
  const next = service.nextStep(c);
  return {
    id: c.id,
    unitId: c.unitId,
    unitNo: c.unit.unitNo,
    partyId: c.partyId,
    partyName: c.party.displayName,
    legalForm: c.legalForm as BuildingLegalFormName,
    ladderId: c.ladderId,
    state: c.state as CollectionCaseStateName,
    anchorOn: day(c.anchorOn),
    pausedDays: c.pausedDays,
    planId: c.planId,
    disputeOpenedAt: isoOrNull(c.disputeOpenedAt),
    disputeReason: c.disputeReason,
    nextStep: next ? { ...next, action: next.action as CollectionActionName } : null,
    timeline: c.events.map((e) => ({
      id: e.id,
      kind: e.kind as CollectionEventKindName,
      seq: e.seq,
      action: (e.action as CollectionActionName | null) ?? null,
      outcome: (e.outcome as CollectionOutcomeName | null) ?? null,
      reason: e.reason,
      amount: e.amount?.toFixed(2) ?? null,
      invoiceChargeId: e.invoiceChargeId,
      documentId: e.documentId,
      occurredAt: toBangkokIso(e.occurredAt),
    })),
    nextActions: caseActions(ctx, c),
    openedAt: toBangkokIso(c.openedAt),
    resolvedAt: isoOrNull(c.resolvedAt),
    version: c.version,
  };
}

export function statementDto(s: StatementRow): StatementDto {
  const snap = s.snapshot as unknown as StatementSnapshot;
  return {
    id: s.id,
    number: s.number,
    partyId: s.partyId,
    partyName: s.party.displayName,
    period: s.periodKey,
    periodStart: day(s.periodStart),
    periodEnd: day(s.periodEnd),
    units: snap.units ?? [],
    opening: s.opening.toFixed(2),
    charges: s.charges.toFixed(2),
    credits: s.credits.toFixed(2),
    payments: s.payments.toFixed(2),
    closing: s.closing.toFixed(2),
    amountDue: s.amountDue.toFixed(2),
    openInvoices: (snap.openInvoices ?? []).map((i) => ({
      id: i.id,
      number: i.number,
      unitNo: i.unitNo,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      dueDate: i.dueDate,
      balance: i.balance,
    })),
    language: s.language as LanguageName,
    documentId: s.documentId,
    deliveredVia: s.deliveredVia,
    letterBatchId: s.letterBatchId,
    paymentIds: s.paymentIds,
    issuedAt: toBangkokIso(s.issuedAt),
  };
}

export function letterBatchDto(b: LetterBatch): LetterBatchDto {
  return {
    id: b.id,
    period: b.periodKey,
    state: b.state as LetterBatchStateName,
    statementIds: b.statementIds,
    documentId: b.documentId,
    error: b.error,
    requestedAt: toBangkokIso(b.createdAt),
    finishedAt: isoOrNull(b.finishedAt),
  };
}

export function invitationDto(l: WorkspaceLink, code: string | null = null, url: string | null = null) {
  return {
    id: l.id,
    buildingId: l.buildingId,
    unitIds: l.unitIds,
    officeName: l.officeName,
    state: l.state as WorkspaceLinkStateName,
    codeHint: l.codeHint,
    code,
    url,
    expiresAt: toBangkokIso(l.expiresAt),
    acceptedAt: isoOrNull(l.acceptedAt),
    revokedAt: isoOrNull(l.revokedAt),
    createdAt: toBangkokIso(l.createdAt),
  } satisfies WorkspaceInvitationDto;
}

// ------------------------------------------------------------------------------------------- examples

const STEP_EXAMPLE = {
  id: FAKE.uuid,
  seq: 1,
  offsetDays: 3,
  action: 'remind' as CollectionActionName,
  channels: ['line', 'email'] as CollectionChannelName[],
  templateKey: 'juristic.collection.reminder',
  requiresApproval: false,
  enabled: true,
  legalReviewRequired: false,
  gateClosedReason: null,
  version: 1,
};
const LADDER_EXAMPLE: CollectionLadderDto = {
  id: FAKE.uuid,
  legalForm: 'condo_act' as BuildingLegalFormName,
  name: 'ขั้นตอนติดตามยอดค้าง — อาคารชุด',
  sourceTemplateKey: 'condo_act.v1',
  steps: [
    STEP_EXAMPLE,
    {
      ...STEP_EXAMPLE,
      seq: 3,
      offsetDays: 30,
      action: 'surcharge' as CollectionActionName,
      templateKey: 'juristic.collection.surcharge',
      enabled: false,
      legalReviewRequired: true,
      gateClosedReason: 'surcharge_disabled',
    },
    {
      ...STEP_EXAMPLE,
      seq: 7,
      offsetDays: 180,
      action: 'suspend_services' as CollectionActionName,
      templateKey: 'juristic.collection.suspend_services',
      requiresApproval: true,
      enabled: false,
      legalReviewRequired: true,
      gateClosedReason: 'suspend_services_disabled',
    },
  ],
};
const CASE_EXAMPLE: CollectionCaseDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  partyId: FAKE.uuid,
  partyName: FAKE.nameTh,
  legalForm: 'condo_act' as BuildingLegalFormName,
  ladderId: FAKE.uuid,
  state: 'open' as CollectionCaseStateName,
  anchorOn: '2027-01-05',
  pausedDays: 0,
  planId: null,
  disputeOpenedAt: null,
  disputeReason: null,
  nextStep: {
    stepId: FAKE.uuid,
    seq: 2,
    action: 'remind' as CollectionActionName,
    dueOn: '2027-01-20',
    legalReviewRequired: false,
    awaitingApproval: false,
  },
  timeline: [
    {
      id: FAKE.uuid,
      kind: 'opened' as CollectionEventKindName,
      seq: null,
      action: null,
      outcome: null,
      reason: null,
      amount: null,
      invoiceChargeId: null,
      documentId: null,
      occurredAt: FAKE.dateTime,
    },
    {
      id: FAKE.uuid,
      kind: 'step' as CollectionEventKindName,
      seq: 1,
      action: 'remind' as CollectionActionName,
      outcome: 'sent' as CollectionOutcomeName,
      reason: null,
      amount: null,
      invoiceChargeId: null,
      documentId: null,
      occurredAt: FAKE.dateTime,
    },
  ],
  nextActions: ['open_dispute'],
  openedAt: FAKE.dateTime,
  resolvedAt: null,
  version: 3,
};
const STATEMENT_EXAMPLE: StatementDto = {
  id: FAKE.uuid,
  number: 'STM-2027-00001',
  partyId: FAKE.uuid,
  partyName: FAKE.nameTh,
  period: '2027-01',
  periodStart: '2027-01-01',
  periodEnd: '2027-01-31',
  units: [
    { id: FAKE.uuid, unitNo: 'A-101', building: 'อาคาร A' },
    { id: FAKE.uuid, unitNo: 'A-102', building: 'อาคาร A' },
  ],
  opening: '0.00',
  charges: '9000.00',
  credits: '0.00',
  payments: '0.00',
  closing: '9000.00',
  amountDue: '9000.00',
  openInvoices: [
    {
      id: FAKE.uuid,
      number: 'INV-2027-00012',
      unitNo: 'A-101',
      periodStart: '2027-01-01',
      periodEnd: '2027-03-31',
      dueDate: '2027-01-05',
      balance: '4500.00',
    },
  ],
  language: 'th' as LanguageName,
  documentId: FAKE.uuid,
  deliveredVia: ['line', 'email'],
  letterBatchId: null,
  paymentIds: [],
  issuedAt: FAKE.dateTime,
};
const LETTERS_EXAMPLE: LetterBatchDto = {
  id: FAKE.uuid,
  period: '2027-01',
  state: 'ready' as LetterBatchStateName,
  statementIds: [FAKE.uuid],
  documentId: FAKE.uuid,
  error: null,
  requestedAt: FAKE.dateTime,
  finishedAt: FAKE.dateTime,
};
const STM_DOWNLOAD: DocumentDownloadDto = {
  documentId: FAKE.uuid,
  number: 'STM-2027-00001',
  url: 'https://storage.example.com/statement.pdf?X-Amz-Signature=abc',
  expiresAt: '2027-01-31T10:05:00+07:00',
};
const INVITATION_EXAMPLE: WorkspaceInvitationDto = {
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  unitIds: [FAKE.uuid],
  officeName: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง',
  state: 'invited' as WorkspaceLinkStateName,
  codeHint: 'Q7XK',
  code: null,
  url: null,
  expiresAt: FAKE.dateTime,
  acceptedAt: null,
  revokedAt: null,
  createdAt: FAKE.dateTime,
};

// ------------------------------------------------------------------------------------------- ladders

@ApiTags('owner.juristicCollections')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/collection-ladders')
export class OwnerCollectionLaddersController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicCollectionLadders.list',
    summary: 'Collections ladders',
    description:
      'One ladder per legal form of the tenant’s buildings, copied from the code template the first time it is read (condo_act / land_allocation_act: remind +3, remind +15, surcharge +30, notice letter +45, remind +60, lawyer letter +90, suspension of common services +180, legal action +365; voluntary / lease_contract: remind +3, remind +15, notice letter +45, remind +60). Every step but `remind` is a legal measure: disabled, `legalReviewRequired: true` and `gateClosedReason` until counsel confirms its rule (O-038) (D-305, D-326).',
    implements: ['D-305', 'D-326'],
  })
  @ApiSuccess(200, {
    description: 'Ladders',
    type: CollectionLadderListDto,
    example: { items: [LADDER_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<CollectionLadderListDto> {
    const ladders = await this.collections.ladders(ctx);
    const items: CollectionLadderDto[] = [];
    for (const l of ladders) items.push(ladderDto(l, await this.collections.stepGates(ctx.tenantId, l)));
    return { items };
  }

  @Patch(':ladderId/steps/:stepId')
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicCollectionLadders.updateStep',
    summary: 'Edit a ladder step',
    description:
      'Offset (strictly between the neighbours), channels (line · email · sms · letter), approval and enabled. Suspension, lawyer letter and legal action always need approval (422 `collections.approval_required`); a legal measure can be enabled only while its legal gate is open (422 `collections.legal_review_required`, params `reason`). Applies to cases from their next step; audited, `juristic.collection_ladder.changed` (D-305, D-326).',
    implements: ['D-305', 'D-326'],
  })
  @ApiJsonBody(CollectionStepUpdateDto, { offsetDays: 5, channels: ['line', 'email', 'sms'] })
  @ApiSuccess(200, { description: 'Ladder', type: CollectionLadderDto, example: LADDER_EXAMPLE })
  @ApiStandardErrors('collections.approval_required', 'collections.legal_review_required', ...WRITE)
  async updateStep(
    @CurrentTenant() ctx: TenantContext,
    @Param('ladderId', ParseUUIDPipe) ladderId: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() body: CollectionStepUpdateDto,
  ): Promise<CollectionLadderDto> {
    const l = await this.collections.updateStep(ctx, ladderId, stepId, body);
    return ladderDto(l, await this.collections.stepGates(ctx.tenantId, l));
  }
}

// ------------------------------------------------------------------------------------------- cases

@ApiTags('owner.juristicCollections')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/collection-cases')
export class OwnerCollectionCasesController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicCollectionCases.list',
    summary: 'Collection cases',
    description:
      'Cases per billed party × unit, newest first, with the timeline and the next step; filters `state`, `unitId`, `partyId` (D-305, D-326).',
    implements: ['D-305', 'D-326'],
  })
  @ApiPaginated(CollectionCaseDto, { example: CASE_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: CollectionCaseListQuery,
  ): Promise<Page<CollectionCaseDto>> {
    const { rows, total } = await this.collections.list(ctx, {
      state: q.state,
      unitId: q.unitId,
      partyId: q.partyId,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((c) => caseDto(this.collections, ctx, c)),
      total,
      q,
    );
  }

  @Get(':caseId')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicCollectionCases.get',
    summary: 'A collection case',
    description: 'The case with its full timeline (append-only evidence) and next step (D-305, D-326).',
    implements: ['D-305', 'D-326'],
  })
  @ApiSuccess(200, { description: 'Case', type: CollectionCaseDto, example: CASE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('caseId', ParseUUIDPipe) id: string,
  ): Promise<CollectionCaseDto> {
    return caseDto(this.collections, ctx, await this.collections.get(ctx, id));
  }

  @Post(':caseId/actions/open-dispute')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicCollectionCases.openDispute',
    summary: 'Open a dispute',
    description:
      'The owner disputes the debt: the ladder pauses (no step runs) until the dispute is closed; the days paused move the rest of the ladder back. The resident is told (`juristic.collection.dispute_opened`). Audited. Requires `Idempotency-Key` (D-305, D-326).',
    implements: ['D-305', 'D-326'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'เจ้าของร่วมโต้แย้งยอดค่าส่วนกลางเดือนมกราคม' })
  @ApiSuccess(200, {
    description: 'Paused by the dispute',
    type: CollectionCaseDto,
    example: {
      ...CASE_EXAMPLE,
      state: 'paused' as CollectionCaseStateName,
      disputeOpenedAt: FAKE.dateTime,
      disputeReason: 'เจ้าของร่วมโต้แย้งยอดค่าส่วนกลางเดือนมกราคม',
      nextActions: ['close_dispute'],
    },
  })
  @ApiStandardErrors('collections.invalid_state', 'idempotency.key_required', ...WRITE)
  async openDispute(
    @CurrentTenant() ctx: TenantContext,
    @Param('caseId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<CollectionCaseDto> {
    return caseDto(this.collections, ctx, await this.collections.openDispute(ctx, id, body.reason));
  }

  @Post(':caseId/actions/close-dispute')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicCollectionCases.closeDispute',
    summary: 'Close a dispute',
    description:
      'With the outcome: the ladder resumes unless an active payment plan still holds it; the resident is told (`juristic.collection.dispute_closed`). Audited. Requires `Idempotency-Key` (D-305, D-326).',
    implements: ['D-305', 'D-326'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ตรวจสอบแล้ว ยอดถูกต้องตามมติที่ประชุม' })
  @ApiSuccess(200, { description: 'Resumed', type: CollectionCaseDto, example: CASE_EXAMPLE })
  @ApiStandardErrors('collections.invalid_state', 'idempotency.key_required', ...WRITE)
  async closeDispute(
    @CurrentTenant() ctx: TenantContext,
    @Param('caseId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<CollectionCaseDto> {
    return caseDto(this.collections, ctx, await this.collections.closeDispute(ctx, id, body.reason));
  }

  @Post(':caseId/actions/approve-step')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.approve')
  @ApiEndpoint({
    id: 'owner.juristicCollectionCases.approveStep',
    summary: 'Approve the waiting step',
    description:
      'Owner, manager or committee (D-320): the step the case waits on runs now — its legal gate re-checked (a closed gate records it `skipped`) — and the ladder moves on. Audited, `juristic.collection.step_executed`. Requires `Idempotency-Key` (D-305, D-326).',
    implements: ['D-305', 'D-320', 'D-326'],
  })
  @ApiJsonBody(StepDecisionDto, { reason: 'ที่ประชุมกรรมการอนุมัติ ครั้งที่ 3/2570' })
  @ApiSuccess(200, { description: 'Approved', type: CollectionCaseDto, example: CASE_EXAMPLE })
  @ApiStandardErrors(
    'collections.no_pending_approval',
    'collections.invalid_state',
    'idempotency.key_required',
    ...WRITE,
  )
  async approveStep(
    @CurrentTenant() ctx: TenantContext,
    @Param('caseId', ParseUUIDPipe) id: string,
    @Body() body: StepDecisionDto,
  ): Promise<CollectionCaseDto> {
    return caseDto(
      this.collections,
      ctx,
      await this.collections.decide(ctx, id, 'approve', body.reason ?? null),
    );
  }

  @Post(':caseId/actions/refuse-step')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.approve')
  @ApiEndpoint({
    id: 'owner.juristicCollectionCases.refuseStep',
    summary: 'Refuse the waiting step',
    description:
      'The step the case waits on is recorded `refused` with the reason and the ladder moves to the next step. Audited. Requires `Idempotency-Key` (D-305, D-326).',
    implements: ['D-305', 'D-326'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ให้เวลาเจ้าของร่วมอีก 30 วัน' })
  @ApiSuccess(200, { description: 'Refused', type: CollectionCaseDto, example: CASE_EXAMPLE })
  @ApiStandardErrors(
    'collections.no_pending_approval',
    'collections.invalid_state',
    'idempotency.key_required',
    ...WRITE,
  )
  async refuseStep(
    @CurrentTenant() ctx: TenantContext,
    @Param('caseId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<CollectionCaseDto> {
    return caseDto(this.collections, ctx, await this.collections.decide(ctx, id, 'refuse', body.reason));
  }
}

// ------------------------------------------------------------------------------------------- receivables & reports

@ApiTags('owner.juristicCollections')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic')
export class OwnerJuristicReportsController {
  constructor(private readonly reports: CollectionReportsService) {}

  @Get('receivables')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicReceivables.list',
    summary: 'Receivables console',
    description:
      'One row per billed party × unit with something owed, a payment plan or an open case: unit, owner with context (owns n units, non-resident, agent bill-to), outstanding (open balances + queued plan / surcharge charges + plan instalments not yet billed), surcharge, oldest overdue date and months, the next ladder step `{kind, date, legalReviewRequired}`, the channels (line · email · sms, or letter). Tabs `all` · `at_step` (a step was sent) · `plan` · `dispute`; `q` searches unit or owner; `sort` amount (default) or age; totals of every matching row (D-305, D-326).',
    implements: ['D-305', 'D-307', 'D-326'],
  })
  @ApiSuccess(200, {
    description: 'Receivables',
    type: ReceivablesPageDto,
    example: {
      data: [
        {
          unitId: FAKE.uuid,
          unitNo: 'A-101',
          buildingId: FAKE.buildingId,
          partyId: FAKE.uuid,
          ownerName: FAKE.nameTh,
          context: { ownsUnits: 2, nonResident: true, agent: false },
          outstanding: '7500.00',
          surcharge: '120.55',
          oldestOverdueOn: '2026-11-05',
          oldestOverdueMonths: 2,
          daysOverdue: 66,
          nextStep: {
            kind: 'notice_letter',
            date: '2026-12-20',
            legalReviewRequired: true,
            awaitingApproval: false,
          },
          caseId: FAKE.uuid,
          caseState: 'open',
          disputeOpen: false,
          planId: null,
          channels: ['line', 'email'],
        },
      ],
      meta: { page: 1, perPage: 25, total: 1 },
      totals: { outstanding: '7500.00', surcharge: '120.55' },
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: ReceivablesQuery): Promise<ReceivablesPageDto> {
    const r = await this.reports.receivables(ctx, {
      tab: q.tab,
      q: q.q,
      sort: q.sort,
      order: q.order,
      buildingId: q.buildingId,
      ...toSkipTake(q),
    });
    return {
      data: r.rows.map((row) => ({
        ...row,
        caseState: row.caseState as CollectionCaseStateName | null,
        nextStep: row.nextStep
          ? {
              kind: row.nextStep.kind as CollectionActionName,
              date: row.nextStep.dueOn,
              legalReviewRequired: row.nextStep.legalReviewRequired,
              awaitingApproval: row.nextStep.awaitingApproval,
            }
          : null,
      })),
      meta: { page: q.page, perPage: q.perPage, total: r.total },
      totals: r.totals,
    };
  }

  @Post('receivables/exports')
  @HttpCode(202)
  @Idempotent()
  @TenantScoped()
  @AllowWhenReadOnly()
  @Can('juristic.collections.read', 'export.create')
  @ApiAsync({ poll: 'owner.exports.get' })
  @ApiEndpoint({
    id: 'owner.juristicReceivables.export',
    summary: 'Export the receivables list (CSV)',
    description:
      'Queues export `juristic_receivables_csv` of the list with the same tab / search / sort (UTF-8 with BOM); poll `GET /v1/owner/exports/{id}` for the link. Requires `Idempotency-Key` (D-051, D-326).',
    implements: ['D-051', 'D-326'],
  })
  @ApiJsonBody(ReceivablesExportDto, { tab: 'all', sort: 'amount' })
  @ApiSuccess(202, {
    description: 'Queued',
    type: ExportJobDto,
    example: {
      ...EXPORT_EXAMPLE,
      kind: 'juristic_receivables_csv' as ExportKindName,
      params: {},
      status: 'queued' as ExportStatusName,
      finishedAt: null,
      download: null,
      rowCount: null,
    },
  })
  @ApiStandardErrors('idempotency.key_required', ...WRITE)
  async export(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ReceivablesExportDto,
  ): Promise<ExportJobDto> {
    return exportDto(
      await this.reports.requestExport(ctx, {
        tab: body.tab,
        q: body.q,
        sort: body.sort,
        buildingId: body.buildingId,
      }),
    );
  }

  @Get('reports/aging')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicReports.aging',
    summary: 'Aging (juristic buckets)',
    description:
      'Open balances now by days past due in the buckets of `juristic.aging_buckets` (default 0–30 · 31–90 · 91–365 · > 365) plus not yet due — invoices, accounts (party × unit) and amount — per building and overall. D-045’s buckets stay for apartments (D-326).',
    implements: ['D-326'],
  })
  @ApiSuccess(200, {
    description: 'Aging',
    type: JuristicAgingDto,
    example: {
      asOf: '2027-01-10',
      bounds: [30, 90, 365],
      overall: {
        notDue: { invoices: 2, accounts: 2, amount: '9000.00' },
        buckets: [
          { key: '0-30', fromDays: 0, toDays: 30, invoices: 1, accounts: 1, amount: '4500.00' },
          { key: '31-90', fromDays: 31, toDays: 90, invoices: 0, accounts: 0, amount: '0.00' },
          { key: '91-365', fromDays: 91, toDays: 365, invoices: 0, accounts: 0, amount: '0.00' },
          { key: '>365', fromDays: 366, toDays: null, invoices: 0, accounts: 0, amount: '0.00' },
        ],
        overdue: { invoices: 1, accounts: 1, amount: '4500.00' },
      },
      buildings: [],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  aging(@CurrentTenant() ctx: TenantContext, @Query() q: AgingQuery): Promise<JuristicAgingDto> {
    return this.reports.aging(ctx, { buildingId: q.buildingId });
  }

  @Get('reports/collection-rate')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicReports.collectionRate',
    summary: 'Collection rate per cycle (KPI)',
    description:
      'Per billing cycle starting in [`from`, `to`] (default the last 365 days): billed (net of credit notes), collected, collected within `juristic.kpi_collection_days` (30) after each invoice’s due date, both rates in percent (2 dp), and the totals — `total.withinDaysRatePct` is the KPI (D-326).',
    implements: ['D-326'],
  })
  @ApiSuccess(200, {
    description: 'Collection rate',
    type: CollectionRateDto,
    example: {
      from: '2026-01-10',
      to: '2027-01-10',
      kpiDays: 30,
      cycles: [
        {
          billingCycleId: FAKE.uuid,
          periodKey: '2027-Q1',
          frequency: 'quarterly',
          periodStart: '2027-01-01',
          propertyId: FAKE.propertyId,
          invoices: 2,
          billed: '9000.00',
          collected: '4500.00',
          collectedWithinDays: '4500.00',
          collectionRatePct: '50.00',
          withinDaysRatePct: '50.00',
        },
      ],
      total: {
        billed: '9000.00',
        collected: '4500.00',
        collectedWithinDays: '4500.00',
        collectionRatePct: '50.00',
        withinDaysRatePct: '50.00',
      },
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  collectionRate(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: CollectionRateQuery,
  ): Promise<CollectionRateDto> {
    return this.reports.collectionRate(ctx, q);
  }

  @Get('budgets/:budgetId/actual-income')
  @TenantScoped()
  @Can('juristic.budget.read')
  @ApiEndpoint({
    id: 'owner.juristicBudgets.actualIncome',
    summary: 'Budget vs actual',
    description:
      'The budget’s income lines against what was billed in its period for its building (common fee, fund, surcharge, other — net of credit notes) and collected, and since J2.1 its expense and fund lines against Σ debits − credits of their accounts in the journals for the building and period (`expenseSideAvailable: true`) (D-304, D-326, D-329).',
    implements: ['D-304', 'D-326', 'D-329'],
  })
  @ApiSuccess(200, {
    description: 'Income side',
    type: BudgetActualIncomeDto,
    example: {
      budgetId: FAKE.uuid,
      buildingId: FAKE.buildingId,
      fiscalYear: 2027,
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
      asOf: '2027-06-30',
      budgetedIncome: '1500000.00',
      incomeLines: [{ label: 'ค่าส่วนกลาง', amount: '1500000.00' }],
      billed: '740000.00',
      billedByKind: [
        { kind: 'common_fee', amount: '700000.00' },
        { kind: 'fund', amount: '40000.00' },
        { kind: 'surcharge', amount: '0.00' },
        { kind: 'other', amount: '0.00' },
      ],
      collected: '690000.00',
      billedVsBudgetPct: '49.33',
      collectedVsBilledPct: '93.24',
      expenseSideAvailable: true,
      budgetedExpense: '1450000.00',
      actualExpense: '690000.00',
      expenseLines: [
        {
          budgetLineId: FAKE.uuid,
          kind: 'expense' as BudgetLineKindName,
          label: 'ค่าจ้างรักษาความปลอดภัย',
          accountId: FAKE.uuid,
          budgeted: '480000.00',
          actual: '236500.00',
          remaining: '243500.00',
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async actualIncome(
    @CurrentTenant() ctx: TenantContext,
    @Param('budgetId', ParseUUIDPipe) id: string,
  ): Promise<BudgetActualIncomeDto> {
    const r = await this.reports.actualIncome(ctx, id);
    return {
      ...r,
      billedByKind: r.billedByKind.map((k) => ({ ...k, kind: k.kind as IncomeKindName })),
      expenseLines: r.expenseLines.map((l) => ({ ...l, kind: l.kind as BudgetLineKindName })),
    };
  }
}

// ------------------------------------------------------------------------------------------- statements

@ApiTags('owner.juristicStatements')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/statements')
export class OwnerStatementsController {
  constructor(private readonly statements: StatementsService) {}

  @Post('actions/issue')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiEndpoint({
    id: 'owner.juristicStatements.issue',
    summary: 'Issue the statements of a month',
    description:
      'One statement per owner (billed) party across all their units: opening, charges (invoices + debit notes issued in the month), credits, payments, closing, what is due now (open balances − credit) and the open invoices; gapless number `STM-YYYY-NNNNN`. Every party billed or paid in the month or owing now — or only `partyIds` / one `buildingId`; a party already stated for the month is skipped. The worker builds the PDF, then the party gets the LINE Flex summary / e-mail (`juristic.statement.ready`); parties without LINE, e-mail or phone are marked `letter`. Audited. Requires `Idempotency-Key` (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiJsonBody(StatementIssueDto, { period: '2027-01' })
  @ApiSuccess(200, {
    description: 'Issued',
    type: StatementIssueResultDto,
    example: { issued: [{ ...STATEMENT_EXAMPLE, documentId: null }], skipped: 0 },
  })
  @ApiStandardErrors('idempotency.key_required', ...WRITE)
  async issue(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: StatementIssueDto,
  ): Promise<StatementIssueResultDto> {
    const r = await this.statements.issue(ctx, body);
    return { issued: r.issued.map(statementDto), skipped: r.skipped };
  }

  @Get()
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicStatements.list',
    summary: 'Statements',
    description: 'Newest month first; filters `period`, `partyId` (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiPaginated(StatementDto, { example: STATEMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: StatementListQuery,
  ): Promise<Page<StatementDto>> {
    const { rows, total } = await this.statements.list(ctx, {
      period: q.period,
      partyId: q.partyId,
      ...toSkipTake(q),
    });
    return paginated(rows.map(statementDto), total, q);
  }

  @Get(':statementId')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicStatements.get',
    summary: 'A statement',
    description: 'One statement with its figures and the invoices open when it was issued (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiSuccess(200, { description: 'Statement', type: StatementDto, example: STATEMENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('statementId', ParseUUIDPipe) id: string,
  ): Promise<StatementDto> {
    return statementDto(await this.statements.get(ctx, id));
  }

  @Get(':statementId/document')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicStatements.document',
    summary: 'Download the statement PDF',
    description:
      'A 5-minute link; 409 `statement.document_pending` until the worker built it (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiSuccess(200, { description: 'Link', type: DocumentDownloadDto, example: STM_DOWNLOAD })
  @ApiStandardErrors('statement.document_pending', 'validation.failed', 'http.not_found', ...T)
  async document(
    @CurrentTenant() ctx: TenantContext,
    @Param('statementId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.statements.document(ctx, id);
    return {
      documentId: r.row.documentId!,
      number: r.row.number,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }

  @Post(':statementId/payments')
  @Idempotent()
  @TenantScoped()
  @Can('payment.record')
  @ApiEndpoint({
    id: 'owner.juristicStatements.pay',
    summary: 'Record a payment of a statement',
    description:
      'Money received for the statement is spread over its invoices still open — across the owner’s units — by the tenant’s allocation policy (`payments.allocation_policy`, J1.2a allocator) and booked as one payment per unit (receipts as usual); the excess becomes the owner’s credit on the unit of the oldest invoice. Juristic manual payments need evidence and a note (J1.2a); less than due needs `payments.allow_partial`; nothing open → 409 `statement.nothing_due`. Audited, `juristic.statement.paid`. Requires `Idempotency-Key` (D-307, D-308, D-326).',
    implements: ['D-307', 'D-308', 'D-326'],
  })
  @ApiJsonBody(StatementPaymentCreateDto, {
    amount: '9000.00',
    method: 'bank_transfer_manual',
    paidAt: FAKE.dateTime,
    evidenceDocumentId: FAKE.uuid,
    notes: 'โอนจากต่างประเทศ SWIFT BKKBTHBK',
  })
  @ApiSuccess(201, {
    description: 'Booked',
    type: StatementPaymentResultDto,
    example: {
      statement: { ...STATEMENT_EXAMPLE, paymentIds: [FAKE.uuid] },
      payments: [{ paymentId: FAKE.uuid, unitId: FAKE.uuid, amount: '4500.00' }],
    },
  })
  @ApiStandardErrors(
    'statement.nothing_due',
    'payment.partial_not_allowed',
    'idempotency.key_required',
    ...WRITE,
  )
  async pay(
    @CurrentTenant() ctx: TenantContext,
    @Param('statementId', ParseUUIDPipe) id: string,
    @Body() body: StatementPaymentCreateDto,
  ): Promise<StatementPaymentResultDto> {
    const r = await this.statements.pay(ctx, id, { ...body, paidAt: new Date(body.paidAt) });
    return {
      statement: statementDto(r.statement),
      payments: r.payments.map((p) => ({ paymentId: p.id, unitId: p.unitId, amount: p.amount })),
    };
  }
}

@ApiTags('owner.juristicStatements')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/letter-batches')
export class OwnerLetterBatchesController {
  constructor(private readonly statements: StatementsService) {}

  @Post()
  @HttpCode(202)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.collections.manage')
  @ApiAsync({ poll: 'owner.juristicLetterBatches.get' })
  @ApiEndpoint({
    id: 'owner.juristicLetterBatches.create',
    summary: 'Print the letters of a month',
    description:
      'The month’s statements of owners with no LINE, e-mail or phone as one printable PDF (A4, one page each, name and address placed in the window of a DL envelope), built by the worker; poll the batch. Nothing to print → state `failed` with the reason. Audited. Requires `Idempotency-Key` (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiJsonBody(LetterBatchCreateDto, { period: '2027-01' })
  @ApiSuccess(202, {
    description: 'Queued',
    type: LetterBatchDto,
    example: {
      ...LETTERS_EXAMPLE,
      state: 'queued' as LetterBatchStateName,
      documentId: null,
      finishedAt: null,
    },
  })
  @ApiStandardErrors('idempotency.key_required', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: LetterBatchCreateDto,
  ): Promise<LetterBatchDto> {
    return letterBatchDto(await this.statements.requestLetters(ctx, body.period));
  }

  @Get()
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicLetterBatches.list',
    summary: 'Letter batches',
    description: 'Newest first (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiPaginated(LetterBatchDto, { example: LETTERS_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: PageQuery): Promise<Page<LetterBatchDto>> {
    const { rows, total } = await this.statements.listLetterBatches(ctx, toSkipTake(q));
    return paginated(rows.map(letterBatchDto), total, q);
  }

  @Get(':letterBatchId')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicLetterBatches.get',
    summary: 'A letter batch',
    description: 'Its state and statements (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiSuccess(200, { description: 'Batch', type: LetterBatchDto, example: LETTERS_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('letterBatchId', ParseUUIDPipe) id: string,
  ): Promise<LetterBatchDto> {
    return letterBatchDto(await this.statements.letterBatch(ctx, id));
  }

  @Get(':letterBatchId/document')
  @TenantScoped()
  @Can('juristic.collections.read')
  @ApiEndpoint({
    id: 'owner.juristicLetterBatches.document',
    summary: 'Download the letters PDF',
    description: 'A 5-minute link; 409 `statement.document_pending` until ready (D-307, D-326).',
    implements: ['D-307', 'D-326'],
  })
  @ApiSuccess(200, {
    description: 'Link',
    type: DocumentDownloadDto,
    example: { ...STM_DOWNLOAD, number: '2027-01' },
  })
  @ApiStandardErrors('statement.document_pending', 'validation.failed', 'http.not_found', ...T)
  async document(
    @CurrentTenant() ctx: TenantContext,
    @Param('letterBatchId', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadDto> {
    const r = await this.statements.letterBatchDocument(ctx, id);
    return {
      documentId: r.row.documentId!,
      number: r.row.periodKey,
      url: r.url,
      expiresAt: toBangkokIso(r.expiresAt),
    };
  }
}

// ------------------------------------------------------------------------------------------- D-270 workspace

@ApiTags('owner.juristicWorkspace')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/workspace')
export class OwnerJuristicWorkspaceController {
  constructor(private readonly workspace: JuristicWorkspaceService) {}

  @Get('units')
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'owner.juristicWorkspace.units',
    summary: 'Units landlords linked to my workspace',
    description:
      'D-270: the units of stub condos whose landlords invited this juristic office and that are still linked (grants live), with the landlord as a billed party of this tenant. Nothing else of the landlord is visible (D-270, D-326).',
    implements: ['D-270', 'D-326'],
  })
  @ApiSuccess(200, {
    description: 'Linked units',
    type: WorkspaceUnitListDto,
    example: {
      items: [
        {
          unitId: FAKE.uuid,
          unitNo: '12/345',
          buildingId: FAKE.buildingId,
          buildingName: 'เดอะ ตัวอย่าง คอนโด',
          landlordPartyId: FAKE.uuid,
          landlordName: 'สมชาย ใจดี',
          linkedAt: FAKE.dateTime,
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async units(@CurrentTenant() ctx: TenantContext): Promise<WorkspaceUnitListDto> {
    return {
      items: (await this.workspace.workspaceUnits(ctx)).map((u) => ({
        unitId: u.unitId,
        unitNo: u.unitNo,
        buildingId: u.buildingId,
        buildingName: u.buildingName,
        landlordPartyId: u.landlordPartyId,
        landlordName: u.landlordName,
        linkedAt: toBangkokIso(u.linkedAt),
      })),
    };
  }

  @Get('invoices')
  @TenantScoped()
  @Can('invoice.read')
  @ApiEndpoint({
    id: 'owner.juristicWorkspace.invoices',
    summary: 'Bills of my workspace to landlords',
    description:
      'The invoices this workspace issued to the landlords of its linked units (also after a link was revoked), newest first (D-270, D-326).',
    implements: ['D-270', 'D-326'],
  })
  @ApiPaginated(InvoiceDto, { example: INVOICE_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async invoices(@CurrentTenant() ctx: TenantContext, @Query() q: PageQuery): Promise<Page<InvoiceDto>> {
    const { rows, total } = await this.workspace.invoicesOf(ctx, toSkipTake(q));
    return paginated(
      rows.map((i) => invoiceDto(i)),
      total,
      q,
    );
  }

  @Post('units/:unitId/invoices')
  @Idempotent()
  @TenantScoped()
  @Can('invoice.issue')
  @ApiEndpoint({
    id: 'owner.juristicWorkspace.billLandlord',
    summary: 'Bill the common fee of a linked unit',
    description:
      'An invoice of this workspace to the unit’s landlord (line `common_fee`), issued at once with this tenant’s number series and due-date settings; the landlord sees and pays it in LIFF like any bill. A unit that is not (or no longer) linked → 404. Audited. Requires `Idempotency-Key` (D-270, D-326).',
    implements: ['D-270', 'D-326'],
  })
  @ApiJsonBody(WorkspaceInvoiceCreateDto, {
    periodStart: '2027-01-01',
    periodEnd: '2027-03-31',
    amount: '4500.00',
    description: 'ค่าส่วนกลาง ไตรมาส 1/2570',
  })
  @ApiSuccess(201, { description: 'Issued', type: InvoiceDto, example: INVOICE_EXAMPLE })
  @ApiStandardErrors('invoice.not_ready', 'idempotency.key_required', ...WRITE)
  async bill(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: WorkspaceInvoiceCreateDto,
  ): Promise<InvoiceDto> {
    return invoiceDto(await this.workspace.billLandlord(ctx, unitId, body));
  }
}

@ApiTags('owner.juristicWorkspaceInvitations')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic-workspace-invitations')
export class OwnerWorkspaceInvitationsController {
  constructor(private readonly workspace: JuristicWorkspaceService) {}

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('tenant.grant.manage')
  @ApiEndpoint({
    id: 'owner.juristicWorkspaceInvitations.create',
    summary: 'Invite my condo’s juristic office',
    description:
      'A landlord invites the juristic office of a **stub** condo (status external; else 422 `workspace.not_a_stub`) for its own units there (another tenant’s unit → 404). The code (10 characters) and link are returned **once** — give them to the office; valid `juristic.workspace_invite_days` (14). On acceptance the office’s juristic tenant sees only these units (unit grants, module juristic) and bills the common fee to me; my leases and rent stay invisible. Audited. Requires `Idempotency-Key` (D-270, D-326).',
    implements: ['D-270', 'D-326'],
  })
  @ApiJsonBody(WorkspaceInvitationCreateDto, {
    buildingId: FAKE.buildingId,
    unitIds: [FAKE.uuid],
    officeName: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง',
  })
  @ApiSuccess(201, {
    description: 'Invited',
    type: WorkspaceInvitationDto,
    example: {
      ...INVITATION_EXAMPLE,
      code: 'H4N8R2Q7XK',
      url: 'https://app.getproperty.co/juristic/join/H4N8R2Q7XK',
    },
  })
  @ApiStandardErrors('workspace.not_a_stub', 'auth.forbidden', 'idempotency.key_required', ...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: WorkspaceInvitationCreateDto,
  ): Promise<WorkspaceInvitationDto> {
    const r = await this.workspace.invite(ctx, body);
    return invitationDto(r.link, r.code, r.url);
  }

  @Get()
  @TenantScoped()
  @Can('tenant.grant.manage')
  @ApiEndpoint({
    id: 'owner.juristicWorkspaceInvitations.list',
    summary: 'My juristic office invitations',
    description: 'Invited, active and revoked, newest first (D-270, D-326).',
    implements: ['D-270', 'D-326'],
  })
  @ApiSuccess(200, {
    description: 'Invitations',
    type: WorkspaceInvitationListDto,
    example: { items: [INVITATION_EXAMPLE] },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<WorkspaceInvitationListDto> {
    return { items: (await this.workspace.list(ctx)).map((l) => invitationDto(l)) };
  }

  @Post(':linkId/actions/revoke')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('tenant.grant.manage')
  @ApiEndpoint({
    id: 'owner.juristicWorkspaceInvitations.revoke',
    summary: 'Revoke an invitation or link',
    description:
      'An open invitation is withdrawn; an accepted link’s unit grants are revoked at once (the office then gets 404 on these units; invoices already issued stay, D-040). Audited, `juristic.workspace.revoked`. Requires `Idempotency-Key` (D-270, D-326).',
    implements: ['D-270', 'D-326'],
  })
  @ApiJsonBody(CaseReasonDto, { reason: 'ขายห้องแล้ว' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: WorkspaceInvitationDto,
    example: { ...INVITATION_EXAMPLE, state: 'revoked' as WorkspaceLinkStateName, revokedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('workspace.invalid_state', 'idempotency.key_required', ...WRITE)
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('linkId', ParseUUIDPipe) id: string,
    @Body() body: CaseReasonDto,
  ): Promise<WorkspaceInvitationDto> {
    return invitationDto(await this.workspace.revoke(ctx, id, body.reason));
  }
}

import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { maskPhone } from '@core/identity/phone';
import { permissionsOf } from '@core/tenancy/access.service';
import { type OwnershipTransfer } from '@generated/prisma/client';
import {
  type BudgetRow,
  JuristicBudgetsService,
  type ResolutionRow,
} from '@modules/ops-juristic/budgets.service';
import {
  type BillToEntry,
  JuristicRegisterService,
  type RegisterEntry,
  type RegisterPartyRow,
} from '@modules/ops-juristic/register.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Decimal from 'decimal.js';

import { iso, isoOrNull } from '../shared/mappers';
import { type BuildingLegalFormName } from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';
import { RATE_PLAN_EXAMPLE, ratePlanDto } from './billing.controller';
import {
  BillToCreateDto,
  type BillToDto,
  BillToEndDto,
  type BillToKindName,
  BudgetApproveDto,
  BudgetCreateDto,
  BudgetDto,
  type BudgetLineKindName,
  BudgetListQuery,
  type BudgetStateName,
  BudgetUpdateDto,
  type MeetingKindName,
  OwnerAddDto,
  OwnershipTransferDto,
  type PartyTypeInputName,
  RateDraftCreateDto,
  RateDraftDto,
  RatePreviewDto,
  RatePreviewRequestDto,
  RegisterListQuery,
  type RegisterPartyDto,
  RegisterUnitDetailDto,
  RegisterUnitDto,
  RegisterUnitUpdateDto,
  ResolutionCreateDto,
  ResolutionDocumentAddDto,
  type ResolutionDocumentKindName,
  ResolutionDto,
  ResolutionListQuery,
  type ResolutionStateName,
  ResolutionUpdateDto,
  ResolutionVoidDto,
  TransferCreateDto,
  type TransferProrationName,
  TransferResultDto,
} from './juristic.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);
/** The operator's permissions in the tenant (for `nextActions`). */
const permsOf = (ctx: TenantContext): ReadonlySet<string> => permissionsOf(ctx.role ? [ctx.role] : []);

// ------------------------------------------------------------------------------------------- mappers

const partyDto = (p: RegisterPartyRow): RegisterPartyDto => ({
  id: p.id,
  type: (p.type === 'company' ? 'company' : 'person') as PartyTypeInputName,
  displayName: p.displayName,
  phoneMasked: p.phoneE164 ? maskPhone(p.phoneE164) : null,
  email: p.email,
  lineLinked: Boolean(p.lineUserId),
  residentLinked: p.userLinks.length > 0,
});

const billToDto = (b: BillToEntry): BillToDto => ({
  id: b.id,
  ownerPartyId: b.ownerPartyId,
  billToParty: partyDto(b.billToParty),
  kind: b.kind as BillToKindName,
  consentDocumentId: b.consentDocumentId,
  consentNote: b.consentNote,
  validFrom: b.validFrom,
  validTo: b.validTo,
  endedReason: b.endedReason,
});

const ownerDto = (o: RegisterEntry['owners'][number]) => ({ ...o, party: partyDto(o.party) });

function registerDto(e: RegisterEntry): RegisterUnitDto {
  const u = e.unit;
  return {
    unitId: u.id,
    unitNo: u.unitNo,
    type: u.type,
    buildingId: u.buildingId,
    buildingName: u.building.name,
    legalForm: (u.building.legalForm ?? null) as BuildingLegalFormName | null,
    areaSqm: u.areaSqm?.toFixed(2) ?? null,
    ownershipRatio: u.ownershipRatio?.toFixed(6) ?? null,
    landAreaSqwa: u.landAreaSqwa?.toFixed(2) ?? null,
    plotNo: u.plotNo,
    titleDeedNo: u.titleDeedNo,
    owners: e.owners.map(ownerDto),
    sharesTotal: e.sharesTotal,
    incomplete: e.incomplete,
    billTo: e.billTo.map(billToDto),
    version: u.version,
  };
}

export function transferDto(t: OwnershipTransfer): OwnershipTransferDto {
  return {
    id: t.id,
    unitId: t.unitId,
    transferDate: day(t.transferDate),
    policy: t.policy as TransferProrationName,
    fromOwnershipIds: t.fromOwnershipIds,
    toOwnershipIds: t.toOwnershipIds,
    creditNoteIds: t.creditNoteIds,
    chargeIds: t.chargeIds,
    note: t.note,
    createdAt: iso(t.createdAt),
  };
}

function registerDetailDto(
  d: RegisterEntry & {
    history: RegisterEntry['owners'];
    billToHistory: BillToEntry[];
    transfers: OwnershipTransfer[];
  },
): RegisterUnitDetailDto {
  return {
    ...registerDto(d),
    history: d.history.map(ownerDto),
    billToHistory: d.billToHistory.map(billToDto),
    transfers: d.transfers.map(transferDto),
  };
}

function resolutionDto(r: ResolutionRow, perms: ReadonlySet<string>): ResolutionDto {
  const nextActions: string[] = [];
  if (r.state === 'draft' && perms.has('juristic.resolution.adopt')) nextActions.push('adopt');
  if (r.state !== 'void' && perms.has('juristic.resolution.adopt')) nextActions.push('void');
  return {
    nextActions,
    id: r.id,
    buildingId: r.buildingId,
    meetingKind: r.meetingKind as MeetingKindName,
    meetingDate: day(r.meetingDate),
    number: r.number,
    title: r.title,
    text: r.text,
    votesSummary: r.votesSummary,
    state: r.state as ResolutionStateName,
    adoptedAt: isoOrNull(r.adoptedAt),
    voidedAt: isoOrNull(r.voidedAt),
    voidReason: r.voidReason,
    documents: r.documents.map((d) => ({
      documentId: d.documentId,
      kind: d.kind as ResolutionDocumentKindName,
      createdAt: iso(d.createdAt),
    })),
    version: r.version,
    createdAt: iso(r.createdAt),
  };
}

function budgetDto(b: BudgetRow, perms: ReadonlySet<string>): BudgetDto {
  const nextActions: string[] = [];
  if (b.state === 'draft' && perms.has('juristic.budget.approve')) nextActions.push('approve');
  if (b.state === 'approved' && perms.has('rate_plan.manage')) nextActions.push('create-rate-plan-draft');
  return {
    nextActions,
    id: b.id,
    buildingId: b.buildingId,
    fiscalYear: b.fiscalYear,
    name: b.name,
    periodStart: day(b.periodStart),
    periodEnd: day(b.periodEnd),
    state: b.state as BudgetStateName,
    resolutionId: b.resolutionId,
    total: b.total.toFixed(2),
    incomeTotal: b.lines
      .filter((l) => l.kind === 'income')
      .reduce((s, l) => s.plus(l.amount.toString()), new Decimal(0))
      .toFixed(2),
    lines: b.lines.map((l) => ({
      id: l.id,
      kind: l.kind as BudgetLineKindName,
      label: l.label,
      amount: l.amount.toFixed(2),
      accountId: l.accountId,
    })),
    approvedAt: isoOrNull(b.approvedAt),
    version: b.version,
  };
}

// ------------------------------------------------------------------------------------------- examples

const PARTY_EXAMPLE: RegisterPartyDto = {
  id: FAKE.uuid,
  type: 'person' as PartyTypeInputName,
  displayName: FAKE.nameTh,
  phoneMasked: '+66•••••1234',
  email: null,
  lineLinked: false,
  residentLinked: true,
};
const REGISTER_EXAMPLE: RegisterUnitDto = {
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  type: 'condo_unit',
  buildingId: FAKE.buildingId,
  buildingName: 'อาคาร A',
  legalForm: 'condo_act' as BuildingLegalFormName,
  areaSqm: '34.77',
  ownershipRatio: '0.012345',
  landAreaSqwa: null,
  plotNo: null,
  titleDeedNo: null,
  owners: [
    {
      ownershipId: FAKE.uuid,
      party: PARTY_EXAMPLE,
      sharePct: '60.0000',
      validFrom: '2020-01-01',
      validTo: null,
      source: 'manual',
    },
  ],
  sharesTotal: '60.0000',
  incomplete: true,
  billTo: [],
  version: 1,
};
const TRANSFER_EXAMPLE: OwnershipTransferDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  transferDate: '2027-03-15',
  policy: 'carry_to_buyer' as TransferProrationName,
  fromOwnershipIds: [FAKE.uuid],
  toOwnershipIds: [FAKE.uuid],
  creditNoteIds: [FAKE.uuid],
  chargeIds: [FAKE.uuid],
  note: null,
  createdAt: FAKE.dateTime,
};
const DETAIL_EXAMPLE: RegisterUnitDetailDto = {
  ...REGISTER_EXAMPLE,
  history: REGISTER_EXAMPLE.owners,
  billToHistory: [],
  transfers: [TRANSFER_EXAMPLE],
};
const RESOLUTION_EXAMPLE: ResolutionDto = {
  nextActions: ['adopt', 'void'],
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  meetingKind: 'agm' as MeetingKindName,
  meetingDate: '2026-12-10',
  number: '3/2569',
  title: 'อนุมัติงบประมาณประจำปี 2570',
  text: 'ที่ประชุมใหญ่มีมติอนุมัติงบประมาณประจำปี 2570 และอัตราค่าส่วนกลาง',
  votesSummary: 'เห็นด้วย 182 ไม่เห็นด้วย 3 งดออกเสียง 5',
  state: 'draft' as ResolutionStateName,
  adoptedAt: null,
  voidedAt: null,
  voidReason: null,
  documents: [],
  version: 1,
  createdAt: FAKE.dateTime,
};
const BUDGET_EXAMPLE: BudgetDto = {
  nextActions: ['approve'],
  id: FAKE.uuid,
  buildingId: FAKE.buildingId,
  fiscalYear: 2027,
  name: 'งบประมาณประจำปี 2570',
  periodStart: '2027-01-01',
  periodEnd: '2027-12-31',
  state: 'draft' as BudgetStateName,
  resolutionId: null,
  total: '1234567.89',
  incomeTotal: '0.00',
  lines: [
    {
      id: FAKE.uuid,
      kind: 'expense' as BudgetLineKindName,
      label: 'ค่ารักษาความปลอดภัย',
      amount: '1234567.89',
      accountId: null,
    },
  ],
  approvedAt: null,
  version: 1,
};
const PREVIEW_EXAMPLE = {
  budgetId: FAKE.uuid,
  buildingId: FAKE.buildingId,
  kind: 'common_fee',
  splitBy: 'ownership_ratio',
  frequency: 'annual',
  annualAmount: '1234567.89',
  cycleAmount: '1234567.89',
  min: '2104.11',
  median: '3968.74',
  max: '7920.00',
  sum: '1234567.89',
  sumMatches: true,
  unitsCount: 312,
  missingUnitIds: [],
  units: [{ unitId: FAKE.uuid, unitNo: FAKE.unitCode, weight: '0.003215', amount: '3969.13' }],
  ratePlanId: null,
} as unknown as RatePreviewDto;

// ------------------------------------------------------------------------------------------- register

@ApiTags('owner.juristicRegister')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/register')
export class OwnerJuristicRegisterController {
  constructor(private readonly register: JuristicRegisterService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.register.read')
  @ApiEndpoint({
    id: 'owner.juristicRegister.list',
    summary: 'Co-owner register',
    description:
      'Units of the buildings the tenant operates with their **current** owners (party, share, since), Σ shares and `incomplete` (Σ < 100 %: an owner is missing, common-fee drafts of the unit are not issuable), contact channels (masked phone, e-mail, LINE, resident login), plot fields and ratio, and the bill-to parties in force (D-303, D-307, D-324). Filters `buildingId`, `incomplete`, `q` (unit no., plot no., owner name).',
    implements: ['D-302', 'D-307', 'D-324'],
  })
  @ApiPaginated(RegisterUnitDto, { example: REGISTER_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: RegisterListQuery,
  ): Promise<Page<RegisterUnitDto>> {
    const { rows, total } = await this.register.list(ctx, {
      buildingId: q.buildingId,
      q: q.q,
      incomplete: q.incomplete,
      ...toSkipTake(q),
    });
    return paginated(rows.map(registerDto), total, q);
  }

  @Get('units/:unitId')
  @TenantScoped()
  @Can('juristic.register.read')
  @ApiEndpoint({
    id: 'owner.juristicRegister.get',
    summary: 'One unit of the register',
    description:
      'The unit’s current owners plus every ownership row (history), every bill-to row and the recorded transfers (D-303, D-307, D-324). A unit of a building the tenant does not operate is 404.',
    implements: ['D-307', 'D-324'],
  })
  @ApiSuccess(200, {
    description: 'The register entry',
    type: RegisterUnitDetailDto,
    example: DETAIL_EXAMPLE,
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<RegisterUnitDetailDto> {
    return registerDetailDto(await this.register.get(ctx, unitId));
  }

  @Patch('units/:unitId')
  @TenantScoped()
  @Can('juristic.register.manage')
  @ApiEndpoint({
    id: 'owner.juristicRegister.updateUnit',
    summary: 'Edit plot fields and ratio',
    description:
      'Land area (ตารางวา, used by `per_sqwa` and `budget_split` by land area), plot no. (unique per building), title deed no., floor area and ownership ratio of a unit (D-302, D-324). `version` guards concurrent edits (412 `concurrency.stale`). Audited, `unit.changed` event.',
    implements: ['D-302', 'D-324'],
  })
  @ApiJsonBody(RegisterUnitUpdateDto, { landAreaSqwa: '52.50', plotNo: '12/48', version: 1 })
  @ApiSuccess(200, { description: 'Updated', type: RegisterUnitDetailDto, example: DETAIL_EXAMPLE })
  @ApiStandardErrors('concurrency.stale', ...WRITE)
  async updateUnit(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: RegisterUnitUpdateDto,
  ): Promise<RegisterUnitDetailDto> {
    return registerDetailDto(await this.register.updateUnit(ctx, unitId, body));
  }

  @Post('units/:unitId/owners')
  @TenantScoped()
  @Can('juristic.register.manage')
  @ApiEndpoint({
    id: 'owner.juristicRegister.addOwner',
    summary: 'Add a co-owner',
    description:
      'A co-owner (an existing party or a new one) with a share from a date (default today). The shares of the owners of a unit may never sum above 100 % on any day (422 `register.shares_exceeded`; asset-core enforces it again at commit); below 100 % the unit stays `incomplete` (D-323, D-324). Audited, `unit_ownership.added` event.',
    implements: ['D-307', 'D-323', 'D-324'],
  })
  @ApiJsonBody(OwnerAddDto, {
    party: { type: 'person', displayName: FAKE.nameTh, phone: '+66810001234' },
    sharePct: '40',
    validFrom: '2027-01-01',
  })
  @ApiSuccess(201, { description: 'Added', type: RegisterUnitDetailDto, example: DETAIL_EXAMPLE })
  @ApiStandardErrors('register.shares_exceeded', ...WRITE)
  async addOwner(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: OwnerAddDto,
  ): Promise<RegisterUnitDetailDto> {
    return registerDetailDto(await this.register.addOwner(ctx, unitId, body));
  }

  @Post('units/:unitId/transfers')
  @Idempotent()
  @TenantScoped()
  @Can('juristic.register.manage')
  @ApiEndpoint({
    id: 'owner.juristicRegister.transfer',
    summary: 'Record an ownership transfer',
    description:
      'A whole-unit transfer on `transferDate`: every owner current that day is closed at the date (exclusive end) and the buyers (existing or new parties, Σ shares ≤ 100) own from it; the sellers’ bill-to rows end. Cycles not yet issued split seller and buyer by days (D-323). Where an **issued** advance invoice covers the date, `juristic.transfer_proration` applies (D-303, D-324): `carry_to_buyer` (default) issues a credit note to the seller for the days from the transfer date and queues the same amount to the buyers by share for the next monthly cycle; `refund_seller` issues the credit note only. 409 `register.transfer_invalid` when nobody owns the unit that day or an owner starts on / after it. Audited, internal event `unit_ownership.transferred`. Requires `Idempotency-Key`.',
    implements: ['D-303', 'D-307', 'D-323', 'D-324'],
  })
  @ApiJsonBody(TransferCreateDto, {
    transferDate: '2027-03-15',
    buyers: [{ party: { type: 'person', displayName: FAKE.nameTh, phone: '+66810001234' }, sharePct: '100' }],
  })
  @ApiSuccess(201, {
    description: 'Recorded',
    type: TransferResultDto,
    example: { transfer: TRANSFER_EXAMPLE, register: DETAIL_EXAMPLE },
  })
  @ApiStandardErrors(
    'register.transfer_invalid',
    'register.shares_exceeded',
    'invoice.credit_exceeds',
    'idempotency.key_required',
    ...WRITE,
  )
  async transfer(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: TransferCreateDto,
  ): Promise<TransferResultDto> {
    const r = await this.register.transfer(ctx, unitId, body);
    return { transfer: transferDto(r.transfer), register: registerDetailDto(r.register) };
  }

  @Get('units/:unitId/transfers')
  @TenantScoped()
  @Can('juristic.register.read')
  @ApiEndpoint({
    id: 'owner.juristicRegister.transfers',
    summary: 'Transfers of a unit',
    description:
      'Recorded ownership transfers of the unit, newest first, with their credit notes and buyer charges (D-324).',
    implements: ['D-324'],
  })
  @ApiSuccess(200, { description: 'Transfers', type: [OwnershipTransferDto], example: [TRANSFER_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async transfers(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<OwnershipTransferDto[]> {
    return (await this.register.transfers(ctx, unitId)).map(transferDto);
  }

  @Post('units/:unitId/bill-to')
  @TenantScoped()
  @Can('juristic.register.manage')
  @ApiEndpoint({
    id: 'owner.juristicRegister.setBillTo',
    summary: 'Name a bill-to party',
    description:
      'A co-owner names the party (a relative, an agency) who receives and pays the unit’s invoices from `validFrom`, with the owner’s **written consent** (`consentDocumentId`, required; D-307, D-324). Invoices of cycles from then on are addressed to the payer (owners naming the same payer share one invoice) and the payer’s resident login sees them (role `payer`, source `bill_to`). A bill-to already open ends the day before; one per owner and day. Audited, `juristic.bill_to.changed` event.',
    implements: ['D-307', 'D-309', 'D-324'],
  })
  @ApiJsonBody(BillToCreateDto, {
    ownerPartyId: FAKE.uuid,
    payer: { party: { type: 'company', displayName: 'บริษัท ตัวแทน จำกัด', email: FAKE.email } },
    kind: 'agency',
    consentDocumentId: FAKE.uuid,
    validFrom: '2027-01-01',
  })
  @ApiSuccess(201, { description: 'Set', type: RegisterUnitDetailDto, example: DETAIL_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async setBillTo(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: BillToCreateDto,
  ): Promise<RegisterUnitDetailDto> {
    return registerDetailDto(await this.register.setBillTo(ctx, unitId, body));
  }

  @Post('units/:unitId/bill-to/:billToId/actions/end')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.register.manage')
  @ApiEndpoint({
    id: 'owner.juristicRegister.endBillTo',
    summary: 'End a bill-to',
    description:
      'From `validTo` (default today) the co-owner is billed again (D-307, D-324). Audited, `juristic.bill_to.changed` event.',
    implements: ['D-307', 'D-324'],
  })
  @ApiJsonBody(BillToEndDto, { validTo: '2027-06-01', reason: 'owner request' })
  @ApiSuccess(200, { description: 'Ended', type: RegisterUnitDetailDto, example: DETAIL_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async endBillTo(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('billToId', ParseUUIDPipe) billToId: string,
    @Body() body: BillToEndDto,
  ): Promise<RegisterUnitDetailDto> {
    return registerDetailDto(await this.register.endBillTo(ctx, unitId, billToId, body));
  }
}

// ------------------------------------------------------------------------------------------- resolutions

@ApiTags('owner.juristicResolutions')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/resolutions')
export class OwnerJuristicResolutionsController {
  constructor(private readonly budgets: JuristicBudgetsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.resolution.read')
  @ApiEndpoint({
    id: 'owner.juristicResolutions.list',
    summary: 'Meeting resolutions',
    description: 'AGM / EGM / committee resolutions of the tenant’s buildings, newest meeting first (D-304).',
    implements: ['D-304'],
  })
  @ApiPaginated(ResolutionDto, { example: RESOLUTION_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ResolutionListQuery,
  ): Promise<Page<ResolutionDto>> {
    const { rows, total } = await this.budgets.listResolutions(ctx, {
      buildingId: q.buildingId,
      state: q.state,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((r) => resolutionDto(r, permsOf(ctx))),
      total,
      q,
    );
  }

  @Post()
  @TenantScoped()
  @Can('juristic.resolution.manage')
  @ApiEndpoint({
    id: 'owner.juristicResolutions.create',
    summary: 'Record a resolution',
    description:
      'A draft resolution of a building: meeting kind and date, number (unique per building and meeting kind), title, text, votes summary (D-304). Adopt it to use it for a budget or a rate. Audited, `juristic.resolution.changed` event.',
    implements: ['D-304', 'D-324'],
  })
  @ApiJsonBody(ResolutionCreateDto, {
    buildingId: FAKE.buildingId,
    meetingKind: 'agm',
    meetingDate: '2026-12-10',
    number: '3/2569',
    title: 'อนุมัติงบประมาณประจำปี 2570',
    text: 'ที่ประชุมใหญ่มีมติอนุมัติงบประมาณประจำปี 2570 และอัตราค่าส่วนกลาง',
  })
  @ApiSuccess(201, { description: 'Recorded', type: ResolutionDto, example: RESOLUTION_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ResolutionCreateDto,
  ): Promise<ResolutionDto> {
    return resolutionDto(await this.budgets.createResolution(ctx, body), permsOf(ctx));
  }

  @Get(':resolutionId')
  @TenantScoped()
  @Can('juristic.resolution.read')
  @ApiEndpoint({
    id: 'owner.juristicResolutions.get',
    summary: 'One resolution',
    description: 'The resolution with its documents (D-304).',
    implements: ['D-304'],
  })
  @ApiSuccess(200, { description: 'The resolution', type: ResolutionDto, example: RESOLUTION_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('resolutionId', ParseUUIDPipe) id: string,
  ): Promise<ResolutionDto> {
    return resolutionDto(await this.budgets.getResolution(ctx, id), permsOf(ctx));
  }

  @Patch(':resolutionId')
  @TenantScoped()
  @Can('juristic.resolution.manage')
  @ApiEndpoint({
    id: 'owner.juristicResolutions.update',
    summary: 'Edit a draft resolution',
    description:
      'Only drafts change (409 `resolution.invalid_state`); `version` guards concurrent edits (D-304).',
    implements: ['D-304'],
  })
  @ApiJsonBody(ResolutionUpdateDto, { votesSummary: 'เห็นด้วย 182 ไม่เห็นด้วย 3 งดออกเสียง 5', version: 1 })
  @ApiSuccess(200, { description: 'Updated', type: ResolutionDto, example: RESOLUTION_EXAMPLE })
  @ApiStandardErrors('resolution.invalid_state', 'concurrency.stale', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('resolutionId', ParseUUIDPipe) id: string,
    @Body() body: ResolutionUpdateDto,
  ): Promise<ResolutionDto> {
    return resolutionDto(await this.budgets.updateResolution(ctx, id, body), permsOf(ctx));
  }

  @Post(':resolutionId/actions/adopt')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.resolution.adopt')
  @ApiEndpoint({
    id: 'owner.juristicResolutions.adopt',
    summary: 'Adopt a resolution',
    description:
      'Committee or Owner (D-320): the draft becomes **adopted** — irreversible (only void with a reason afterwards); budgets are approved and common-fee / fund rates are set with adopted resolutions (D-304, D-324). Requires `Idempotency-Key`. Audited.',
    implements: ['D-304', 'D-320', 'D-324'],
  })
  @ApiSuccess(200, { description: 'Adopted', type: ResolutionDto, example: RESOLUTION_EXAMPLE })
  @ApiStandardErrors('resolution.invalid_state', 'idempotency.key_required', ...WRITE)
  async adopt(
    @CurrentTenant() ctx: TenantContext,
    @Param('resolutionId', ParseUUIDPipe) id: string,
  ): Promise<ResolutionDto> {
    return resolutionDto(await this.budgets.adoptResolution(ctx, id), permsOf(ctx));
  }

  @Post(':resolutionId/actions/void')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.resolution.adopt')
  @ApiEndpoint({
    id: 'owner.juristicResolutions.void',
    summary: 'Void a resolution',
    description:
      'With a reason; refused while an approved budget or a rate version relies on it (409 `resolution.invalid_state`, D-304). Audited.',
    implements: ['D-304', 'D-320'],
  })
  @ApiJsonBody(ResolutionVoidDto, { reason: 'บันทึกซ้ำ' })
  @ApiSuccess(200, { description: 'Voided', type: ResolutionDto, example: RESOLUTION_EXAMPLE })
  @ApiStandardErrors('resolution.invalid_state', ...WRITE)
  async void(
    @CurrentTenant() ctx: TenantContext,
    @Param('resolutionId', ParseUUIDPipe) id: string,
    @Body() body: ResolutionVoidDto,
  ): Promise<ResolutionDto> {
    return resolutionDto(await this.budgets.voidResolution(ctx, id, body.reason), permsOf(ctx));
  }

  @Post(':resolutionId/documents')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.resolution.manage')
  @ApiEndpoint({
    id: 'owner.juristicResolutions.addDocument',
    summary: 'Attach minutes or a document',
    description: 'A document of the tenant (minutes, notice, attachment); not to a void resolution (D-304).',
    implements: ['D-304'],
  })
  @ApiJsonBody(ResolutionDocumentAddDto, { documentId: FAKE.uuid, kind: 'minutes' })
  @ApiSuccess(200, { description: 'Attached', type: ResolutionDto, example: RESOLUTION_EXAMPLE })
  @ApiStandardErrors('resolution.invalid_state', ...WRITE)
  async addDocument(
    @CurrentTenant() ctx: TenantContext,
    @Param('resolutionId', ParseUUIDPipe) id: string,
    @Body() body: ResolutionDocumentAddDto,
  ): Promise<ResolutionDto> {
    return resolutionDto(await this.budgets.addResolutionDocument(ctx, id, body), permsOf(ctx));
  }

  @Delete(':resolutionId/documents/:documentId')
  @TenantScoped()
  @Can('juristic.resolution.manage')
  @ApiEndpoint({
    id: 'owner.juristicResolutions.removeDocument',
    summary: 'Detach a document',
    description: 'Only while the resolution is a draft (D-304).',
    implements: ['D-304'],
  })
  @ApiSuccess(200, { description: 'Detached', type: ResolutionDto, example: RESOLUTION_EXAMPLE })
  @ApiStandardErrors('resolution.invalid_state', ...WRITE)
  async removeDocument(
    @CurrentTenant() ctx: TenantContext,
    @Param('resolutionId', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<ResolutionDto> {
    return resolutionDto(await this.budgets.removeResolutionDocument(ctx, id, documentId), permsOf(ctx));
  }
}

// ------------------------------------------------------------------------------------------- budgets

@ApiTags('owner.juristicBudgets')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/budgets')
export class OwnerJuristicBudgetsController {
  constructor(private readonly budgets: JuristicBudgetsService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.budget.read')
  @ApiEndpoint({
    id: 'owner.juristicBudgets.list',
    summary: 'Budgets',
    description:
      'Budgets of the tenant’s buildings by fiscal year (draft, approved, superseded) with their lines (D-304).',
    implements: ['D-304'],
  })
  @ApiPaginated(BudgetDto, { example: BUDGET_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: BudgetListQuery): Promise<Page<BudgetDto>> {
    const { rows, total } = await this.budgets.listBudgets(ctx, {
      buildingId: q.buildingId,
      fiscalYear: q.fiscalYear,
      state: q.state,
      ...toSkipTake(q),
    });
    return paginated(
      rows.map((b) => budgetDto(b, permsOf(ctx))),
      total,
      q,
    );
  }

  @Post()
  @TenantScoped()
  @Can('juristic.budget.manage')
  @ApiEndpoint({
    id: 'owner.juristicBudgets.create',
    summary: 'Draft a budget',
    description:
      'A draft budget of a building for a fiscal year (default 1 Jan – 31 Dec) with lines (income / expense / fund, annual amounts). One draft per building and year. `total` = Σ expense + fund lines (D-304). Audited.',
    implements: ['D-304', 'D-324'],
  })
  @ApiJsonBody(BudgetCreateDto, {
    buildingId: FAKE.buildingId,
    fiscalYear: 2027,
    name: 'งบประมาณประจำปี 2570',
    lines: [{ kind: 'expense', label: 'ค่ารักษาความปลอดภัย', amount: '480000.00' }],
  })
  @ApiSuccess(201, { description: 'Drafted', type: BudgetDto, example: BUDGET_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: BudgetCreateDto): Promise<BudgetDto> {
    return budgetDto(await this.budgets.createBudget(ctx, body), permsOf(ctx));
  }

  @Get(':budgetId')
  @TenantScoped()
  @Can('juristic.budget.read')
  @ApiEndpoint({
    id: 'owner.juristicBudgets.get',
    summary: 'One budget',
    description: 'The budget with its lines (D-304).',
    implements: ['D-304'],
  })
  @ApiSuccess(200, { description: 'The budget', type: BudgetDto, example: BUDGET_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('budgetId', ParseUUIDPipe) id: string,
  ): Promise<BudgetDto> {
    return budgetDto(await this.budgets.getBudget(ctx, id), permsOf(ctx));
  }

  @Patch(':budgetId')
  @TenantScoped()
  @Can('juristic.budget.manage')
  @ApiEndpoint({
    id: 'owner.juristicBudgets.update',
    summary: 'Edit a draft budget',
    description:
      'Name, period and lines (replaced as a whole) of a draft (409 `budget.invalid_state` otherwise, D-304).',
    implements: ['D-304'],
  })
  @ApiJsonBody(BudgetUpdateDto, {
    lines: [{ kind: 'expense', label: 'ค่ารักษาความปลอดภัย', amount: '480000.00' }],
    version: 1,
  })
  @ApiSuccess(200, { description: 'Updated', type: BudgetDto, example: BUDGET_EXAMPLE })
  @ApiStandardErrors('budget.invalid_state', 'concurrency.stale', ...WRITE)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('budgetId', ParseUUIDPipe) id: string,
    @Body() body: BudgetUpdateDto,
  ): Promise<BudgetDto> {
    return budgetDto(await this.budgets.updateBudget(ctx, id, body), permsOf(ctx));
  }

  @Post(':budgetId/actions/approve')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.budget.approve')
  @ApiEndpoint({
    id: 'owner.juristicBudgets.approve',
    summary: 'Approve a budget',
    description:
      'Committee or Owner (D-320): the draft is approved with an **adopted** resolution of the same building; the previous approved budget of that year is superseded (D-304, D-324). Requires `Idempotency-Key`. Audited.',
    implements: ['D-304', 'D-320', 'D-324'],
  })
  @ApiJsonBody(BudgetApproveDto, { resolutionId: FAKE.uuid })
  @ApiSuccess(200, { description: 'Approved', type: BudgetDto, example: BUDGET_EXAMPLE })
  @ApiStandardErrors('budget.invalid_state', 'idempotency.key_required', ...WRITE)
  async approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('budgetId', ParseUUIDPipe) id: string,
    @Body() body: BudgetApproveDto,
  ): Promise<BudgetDto> {
    return budgetDto(await this.budgets.approveBudget(ctx, id, body.resolutionId), permsOf(ctx));
  }

  @Post(':budgetId/rate-preview')
  @HttpCode(200)
  @TenantScoped()
  @Can('juristic.budget.read')
  @ApiEndpoint({
    id: 'owner.juristicBudgets.ratePreview',
    summary: 'Preview a rate from the budget',
    description:
      'What each unit of the building would pay per cycle if the chosen lines (default: expense lines for a common fee, fund lines for a fund) were split by `splitBy` (ownership ratio, m², ตารางวา, per unit): annual ÷ 12 × the months of the frequency, half-up to satang, the remainder on the largest weight (ties: first unit id) so Σ = the cycle amount exactly; min / median / max and the units missing the weight (D-304, D-324). Nothing is saved.',
    implements: ['D-304', 'D-324'],
  })
  @ApiJsonBody(RatePreviewRequestDto, { kind: 'common_fee', splitBy: 'ownership_ratio', frequency: 'annual' })
  @ApiSuccess(200, { description: 'The preview', type: RatePreviewDto, example: PREVIEW_EXAMPLE })
  @ApiStandardErrors(...WRITE)
  async ratePreview(
    @CurrentTenant() ctx: TenantContext,
    @Param('budgetId', ParseUUIDPipe) id: string,
    @Body() body: RatePreviewRequestDto,
  ): Promise<RatePreviewDto> {
    return (await this.budgets.ratePreview(ctx, id, body)) as unknown as RatePreviewDto;
  }

  @Post(':budgetId/actions/create-rate-plan-draft')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('rate_plan.manage')
  @ApiEndpoint({
    id: 'owner.juristicBudgets.createRateDraft',
    summary: 'Draft a common-fee rate from the budget',
    description:
      'An **approved** budget becomes a `budget_split` version (`{kind: budget, amount: Σ lines, period: year, splitBy}`) of the building’s default plan of the kind (created when missing) from `effectiveFrom` — editable until it takes effect — carrying the budget’s resolution (D-304, D-324). 422 when units lack the weight. Returns the plan and the preview. Requires `Idempotency-Key`. Audited.',
    implements: ['D-304', 'D-324'],
  })
  @ApiJsonBody(RateDraftCreateDto, {
    kind: 'common_fee',
    splitBy: 'ownership_ratio',
    effectiveFrom: '2027-01-01',
  })
  @ApiSuccess(200, {
    description: 'Drafted',
    type: RateDraftDto,
    example: { plan: RATE_PLAN_EXAMPLE, preview: PREVIEW_EXAMPLE },
  })
  @ApiStandardErrors(
    'budget.invalid_state',
    'rate_plan.backdated',
    'rate_plan.version_in_force',
    'rate_plan.resolution_required',
    'rate_plan.resolution_invalid',
    'idempotency.key_required',
    ...WRITE,
  )
  async createRateDraft(
    @CurrentTenant() ctx: TenantContext,
    @Param('budgetId', ParseUUIDPipe) id: string,
    @Body() body: RateDraftCreateDto,
  ): Promise<RateDraftDto> {
    const r = await this.budgets.createRateDraft(ctx, id, body);
    return {
      plan: ratePlanDto(r.plan, this.budgets.today()),
      preview: r.preview as unknown as RatePreviewDto,
    };
  }
}

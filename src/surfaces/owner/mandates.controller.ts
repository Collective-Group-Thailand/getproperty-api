import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { CoBrokeService, type CoBrokeView } from '@modules/ops-listings/co-broke.service';
import { DealsService, type DealView } from '@modules/ops-listings/deals.service';
import { MandatesService, type MandateView } from '@modules/ops-listings/mandates.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  AgenciesDto,
  CoBrokeDto,
  CoBrokeProposeDto,
  CoBrokesDto,
  CoBrokeStateName,
  DealDto,
  DealsDto,
  type FeeAccrualKindName,
  type FeeBillingUnitName,
  MandateDto,
  MandatedUnitsDto,
  MandateInviteDto,
  MandateReasonDto,
  MandateRoleName,
  type MandateScopeName,
  MandatesDto,
  MandateStateName,
} from './mandates.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const iso = (d: Date | null) => d?.toISOString() ?? null;

export function mandateDto(m: MandateView): MandateDto {
  return {
    id: m.id,
    agencyTenantId: m.tenantId,
    agencyName: m.agencyName,
    ownerTenantId: m.ownerTenantId,
    ownerName: m.ownerName,
    unitId: m.unitId,
    unitNo: m.unitNo,
    buildingId: m.buildingId,
    buildingName: m.buildingName,
    scope: m.scope as MandateScopeName,
    exclusive: m.exclusive,
    commissionTerms: m.commissionTerms,
    commissionPercent: m.commissionPercent?.toFixed(4) ?? null,
    commissionAmount: m.commissionAmount?.toFixed(2) ?? null,
    validFrom: day(m.validFrom)!,
    validTo: day(m.validTo),
    state: m.state as MandateStateName,
    acceptedAt: iso(m.acceptedAt),
    activatedAt: iso(m.activatedAt),
    endedAt: iso(m.endedAt),
    revokedAt: iso(m.revokedAt),
    endReason: m.endReason,
    contractDocumentId: m.contractDocumentId,
    createdAt: m.createdAt.toISOString(),
  };
}

export function coBrokeDto(c: CoBrokeView): CoBrokeDto {
  return {
    id: c.id,
    listingAgencyTenantId: c.tenantId,
    listingAgencyName: c.listingAgencyName,
    coAgencyTenantId: c.coAgencyTenantId,
    coAgencyName: c.coAgencyName,
    listingId: c.listingId,
    listingSlug: c.listingSlug,
    unitId: c.unitId,
    mandateId: c.mandateId,
    splitPercent: c.splitPercent.toFixed(4),
    validFrom: day(c.validFrom)!,
    validTo: day(c.validTo),
    state: c.state as CoBrokeStateName,
    note: c.note,
    signedAt: iso(c.signedAt),
    contractDocumentId: c.contractDocumentId,
    createdAt: c.createdAt.toISOString(),
  };
}

export function dealDto(d: DealView): DealDto {
  return {
    id: d.id,
    ownerTenantId: d.tenantId,
    ownerName: d.ownerName,
    leaseId: d.leaseId,
    unitId: d.unitId,
    unitNo: d.unitNo,
    listingId: d.listingId,
    mandateId: d.mandateId,
    coBrokeAgreementId: d.coBrokeAgreementId,
    listingAgencyTenantId: d.listingAgencyTenantId,
    listingAgencyName: d.listingAgencyTenantId ? (d.agencyNames[d.listingAgencyTenantId] ?? null) : null,
    coAgencyTenantId: d.coAgencyTenantId,
    coAgencyName: d.coAgencyTenantId ? (d.agencyNames[d.coAgencyTenantId] ?? null) : null,
    monthlyRent: d.monthlyRent.toFixed(2),
    commissionAmount: d.commissionAmount?.toFixed(2) ?? null,
    coBrokeAmount: d.coBrokeAmount?.toFixed(2) ?? null,
    closedAt: d.closedAt.toISOString(),
    accruals: d.accruals.map((a) => ({
      id: a.id,
      kind: a.kind as FeeAccrualKindName,
      billingUnit: a.billingUnit as FeeBillingUnitName,
      rate: a.rate.toFixed(4),
      baseAmount: a.baseAmount?.toFixed(2) ?? null,
      amount: a.amount.toFixed(2),
      capped: a.capped,
      accruedOn: day(a.accruedOn)!,
      invoiced: Boolean(a.platformInvoiceLineId),
    })),
  };
}

const MANDATE_EXAMPLE: MandateDto = {
  id: FAKE.uuid,
  agencyTenantId: FAKE.tenantId,
  agencyName: 'บ้านดี พร็อพเพอร์ตี้',
  ownerTenantId: '7b9f1c2e-3d4a-4f5b-8c6d-9e0f1a2b3c4d',
  ownerName: 'สมชาย ใจดี',
  unitId: FAKE.uuid,
  unitNo: '12/345',
  buildingId: FAKE.buildingId,
  buildingName: 'คอนโดตัวอย่าง',
  scope: 'list' as MandateScopeName,
  exclusive: false,
  commissionTerms: 'ค่านายหน้า 1 เดือนต่อสัญญาเช่า 1 ปี',
  commissionPercent: '100.0000',
  commissionAmount: null,
  validFrom: FAKE.date,
  validTo: null,
  state: MandateStateName.Active,
  acceptedAt: FAKE.dateTime,
  activatedAt: FAKE.dateTime,
  endedAt: null,
  revokedAt: null,
  endReason: null,
  contractDocumentId: null,
  createdAt: FAKE.dateTime,
};

const CO_BROKE_EXAMPLE: CoBrokeDto = {
  id: FAKE.uuid,
  listingAgencyTenantId: FAKE.tenantId,
  listingAgencyName: 'บ้านดี พร็อพเพอร์ตี้',
  coAgencyTenantId: '7b9f1c2e-3d4a-4f5b-8c6d-9e0f1a2b3c4d',
  coAgencyName: 'นายหน้าร่วม จำกัด',
  listingId: FAKE.uuid,
  listingSlug: 'condo-1br-0a1b2c3d4e',
  unitId: FAKE.uuid,
  mandateId: FAKE.uuid,
  splitPercent: '40.0000',
  validFrom: FAKE.date,
  validTo: null,
  state: CoBrokeStateName.Signed,
  note: null,
  signedAt: FAKE.dateTime,
  contractDocumentId: null,
  createdAt: FAKE.dateTime,
};

const DEAL_EXAMPLE: DealDto = {
  id: FAKE.uuid,
  ownerTenantId: '7b9f1c2e-3d4a-4f5b-8c6d-9e0f1a2b3c4d',
  ownerName: 'สมชาย ใจดี',
  leaseId: FAKE.uuid,
  unitId: FAKE.uuid,
  unitNo: '12/345',
  listingId: FAKE.uuid,
  mandateId: FAKE.uuid,
  coBrokeAgreementId: null,
  listingAgencyTenantId: FAKE.tenantId,
  listingAgencyName: 'บ้านดี พร็อพเพอร์ตี้',
  coAgencyTenantId: null,
  coAgencyName: null,
  monthlyRent: '15000.00',
  commissionAmount: '15000.00',
  coBrokeAmount: null,
  closedAt: FAKE.dateTime,
  accruals: [
    {
      id: FAKE.uuid,
      kind: 'success_fee' as FeeAccrualKindName,
      billingUnit: 'percent_of_amount' as FeeBillingUnitName,
      rate: '10.0000',
      baseAmount: '15000.00',
      amount: '1500.00',
      capped: false,
      accruedOn: FAKE.date,
      invoiced: false,
    },
  ],
};

/**
 * Agency mandates, co-broke agreements and deals (G2, D-284, D-287, D-293). Landlords and other owners mandate
 * estate agencies (tenant type `agency`) for single units; agencies accept, list the unit, share listings with other
 * agencies and see the deals they took part in with the fees they owe. Owner-side actions need
 * `tenant.grant.manage` (a mandate opens a grant), agency-side actions `listing.manage`.
 */
@ApiTags('owner.mandates')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerMandatesController {
  constructor(
    private readonly mandates: MandatesService,
    private readonly coBrokes: CoBrokeService,
    private readonly deals: DealsService,
  ) {}

  @Get('agencies')
  @TenantScoped()
  @Can('tenant.grant.manage')
  @ApiEndpoint({
    id: 'owner.agencies.search',
    summary: 'Find an estate agency',
    description:
      'Active agencies (tenant type `agency`, D-284) whose name contains `q` — id, name and slug only — to pick one for a mandate (D-293).',
    implements: ['D-284', 'D-293'],
  })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 100 } })
  @ApiSuccess(200, {
    description: 'Agencies',
    type: AgenciesDto,
    example: {
      data: [{ id: FAKE.tenantId, displayName: 'บ้านดี พร็อพเพอร์ตี้', slug: 'agency-0a1b2c3d4e' }],
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async agencies(@Query('q') q?: string): Promise<AgenciesDto> {
    return { data: await this.mandates.agencies(q?.slice(0, 100)) };
  }

  @Get('mandates')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.mandates.list',
    summary: 'Mandates given or received',
    description:
      'Mandates the tenant gave as an owner and received as an agency (`role` narrows it), newest first, with names of both sides, the unit and its building (D-293).',
    implements: ['D-293'],
  })
  @ApiQuery({ name: 'role', required: false, enum: MandateRoleName, enumName: 'MandateRole' })
  @ApiQuery({ name: 'state', required: false, enum: MandateStateName, enumName: 'MandateState' })
  @ApiQuery({ name: 'unitId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiSuccess(200, { description: 'Mandates', type: MandatesDto, example: { data: [MANDATE_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query('role') role?: MandateRoleName,
    @Query('state') state?: MandateStateName,
    @Query('unitId', new ParseUUIDPipe({ optional: true })) unitId?: string,
  ): Promise<MandatesDto> {
    const rows = await this.mandates.list(ctx, {
      role: role === MandateRoleName.Owner || role === MandateRoleName.Agency ? role : undefined,
      state: state && Object.values(MandateStateName).includes(state) ? state : undefined,
      unitId,
    });
    return { data: rows.map(mandateDto) };
  }

  @Post('mandates')
  @TenantScoped()
  @Can('tenant.grant.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.mandates.invite',
    summary: 'Mandate an agency for a unit',
    description:
      'Invites an agency (tenant type `agency`) to list — or list and lease, or manage — one unit the tenant holds (or of a building it owns / operates), with commission terms and a validity window (D-293). Nothing is shared until the agency accepts. `mandate.exclusive_conflict` when the unit has an exclusive mandate, or an exclusive one is asked while other agencies hold mandates; `mandate.agency_required` for a tenant that is not an agency; `mandate.invalid_state` when the agency already has an open mandate on the unit.',
    implements: ['D-293', 'D-284'],
  })
  @ApiJsonBody(MandateInviteDto, {
    agencyTenantId: FAKE.tenantId,
    unitId: FAKE.uuid,
    scope: 'list',
    exclusive: false,
    commissionTerms: 'ค่านายหน้า 1 เดือนต่อสัญญาเช่า 1 ปี',
    commissionPercent: '100',
    validFrom: FAKE.date,
  })
  @ApiSuccess(201, {
    description: 'Invited',
    type: MandateDto,
    example: { ...MANDATE_EXAMPLE, state: 'invited', acceptedAt: null, activatedAt: null },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'mandate.exclusive_conflict',
    'mandate.agency_required',
    'mandate.invalid_state',
    ...T,
  )
  async invite(@CurrentTenant() ctx: TenantContext, @Body() body: MandateInviteDto): Promise<MandateDto> {
    return mandateDto(await this.mandates.invite(ctx, body));
  }

  @Get('mandates/:mandateId')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.mandates.get',
    summary: 'One mandate',
    description: 'A mandate the tenant gave or received (D-293); anyone else gets 404.',
    implements: ['D-293'],
  })
  @ApiSuccess(200, { description: 'Mandate', type: MandateDto, example: MANDATE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('mandateId', ParseUUIDPipe) id: string,
  ): Promise<MandateDto> {
    return mandateDto(await this.mandates.get(ctx, id));
  }

  @Post('mandates/:mandateId/actions/accept')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.mandates.accept',
    summary: 'Accept a mandate (agency)',
    description:
      'The agency accepts an invitation: a unit-scope asset access grant (reason `listing_mandate`, modules by scope, ending with the mandate) is written in the owner’s name and the mandate is `active` from its first day (`accepted` until then) — the agency then sees the unit and may list it (D-293, D-152). Exclusivity is checked again.',
    implements: ['D-293', 'D-152'],
  })
  @ApiSuccess(200, { description: 'Accepted', type: MandateDto, example: MANDATE_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'mandate.invalid_state',
    'mandate.exclusive_conflict',
    ...T,
  )
  async accept(
    @CurrentTenant() ctx: TenantContext,
    @Param('mandateId', ParseUUIDPipe) id: string,
  ): Promise<MandateDto> {
    return mandateDto(await this.mandates.accept(ctx, id));
  }

  @Post('mandates/:mandateId/actions/decline')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.mandates.decline',
    summary: 'Decline a mandate (agency)',
    description: 'The agency declines an invitation; the mandate ends as `revoked` with the reason (D-293).',
    implements: ['D-293'],
  })
  @ApiJsonBody(MandateReasonDto, { reason: 'ไม่รับพื้นที่นี้' })
  @ApiSuccess(200, {
    description: 'Declined',
    type: MandateDto,
    example: { ...MANDATE_EXAMPLE, state: 'revoked', endReason: 'ไม่รับพื้นที่นี้' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'mandate.invalid_state', ...T)
  async decline(
    @CurrentTenant() ctx: TenantContext,
    @Param('mandateId', ParseUUIDPipe) id: string,
    @Body() body: MandateReasonDto,
  ): Promise<MandateDto> {
    return mandateDto(await this.mandates.decline(ctx, id, body.reason ?? null));
  }

  @Post('mandates/:mandateId/actions/revoke')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.grant.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.mandates.revoke',
    summary: 'Revoke a mandate (owner)',
    description:
      'The owner withdraws an invitation or revokes an accepted / active mandate: the grant is revoked and the agency’s open listings of the unit close (`withdrawn`) in the same transaction — the agency loses access at once (D-293, D-152).',
    implements: ['D-293', 'D-152'],
  })
  @ApiJsonBody(MandateReasonDto, { reason: 'ขายห้องแล้ว' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: MandateDto,
    example: { ...MANDATE_EXAMPLE, state: 'revoked', revokedAt: FAKE.dateTime, endReason: 'ขายห้องแล้ว' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'mandate.invalid_state', ...T)
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('mandateId', ParseUUIDPipe) id: string,
    @Body() body: MandateReasonDto,
  ): Promise<MandateDto> {
    return mandateDto(await this.mandates.revoke(ctx, id, body.reason ?? null));
  }

  @Post('mandates/:mandateId/actions/end')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.read')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.mandates.end',
    summary: 'End a mandate (either party)',
    description:
      'The owner or the agency ends an accepted / active mandate now: grant revoked, the agency’s open listings of the unit closed (D-293). Mandates also end by themselves after their last day.',
    implements: ['D-293'],
  })
  @ApiJsonBody(MandateReasonDto, { reason: 'ครบตามที่ตกลง' })
  @ApiSuccess(200, {
    description: 'Ended',
    type: MandateDto,
    example: { ...MANDATE_EXAMPLE, state: 'ended', endedAt: FAKE.dateTime, endReason: 'ครบตามที่ตกลง' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'mandate.invalid_state', ...T)
  async end(
    @CurrentTenant() ctx: TenantContext,
    @Param('mandateId', ParseUUIDPipe) id: string,
    @Body() body: MandateReasonDto,
  ): Promise<MandateDto> {
    return mandateDto(await this.mandates.end(ctx, id, body.reason ?? null));
  }

  @Get('mandated-units')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.mandatedUnits.list',
    summary: 'Units mandated to the agency',
    description:
      'Units the agency holds an active mandate for — unit, building, area, district — and its open listing of each, the agency’s work list (D-293). Nothing of other units is visible.',
    implements: ['D-293'],
  })
  @ApiSuccess(200, {
    description: 'Mandated units',
    type: MandatedUnitsDto,
    example: {
      data: [
        {
          mandate: MANDATE_EXAMPLE,
          unitId: FAKE.uuid,
          unitNo: '12/345',
          unitType: 'condo_unit',
          areaSqm: '28.50',
          buildingId: FAKE.buildingId,
          buildingName: 'คอนโดตัวอย่าง',
          province: 'กรุงเทพมหานคร',
          district: 'พญาไท',
          listing: null,
        },
      ],
    },
  })
  @ApiStandardErrors('validation.failed', ...T)
  async mandatedUnits(@CurrentTenant() ctx: TenantContext): Promise<MandatedUnitsDto> {
    const rows = await this.mandates.mandatedUnits(ctx);
    return {
      data: rows.map((r) => ({
        mandate: mandateDto(r.mandate),
        unitId: r.unit.id,
        unitNo: r.unit.unitNo,
        unitType: r.unit.type,
        areaSqm: r.unit.areaSqm?.toFixed(2) ?? null,
        buildingId: r.building.id,
        buildingName: r.building.name,
        province: r.province,
        district: r.district,
        listing: r.listing ? { id: r.listing.id, state: r.listing.state } : null,
      })),
    };
  }

  // ------------------------------------------------------------------------------------------------- co-broke

  @Get('co-broke-agreements')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.coBroke.list',
    summary: 'Co-broke agreements',
    description: 'Agreements where the tenant is the listing agency or the co-agency (D-293).',
    implements: ['D-293'],
  })
  @ApiQuery({ name: 'state', required: false, enum: CoBrokeStateName, enumName: 'CoBrokeState' })
  @ApiQuery({ name: 'listingId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiSuccess(200, { description: 'Agreements', type: CoBrokesDto, example: { data: [CO_BROKE_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', ...T)
  async coBrokeList(
    @CurrentTenant() ctx: TenantContext,
    @Query('state') state?: CoBrokeStateName,
    @Query('listingId', new ParseUUIDPipe({ optional: true })) listingId?: string,
  ): Promise<CoBrokesDto> {
    const rows = await this.coBrokes.list(ctx, {
      state: state && Object.values(CoBrokeStateName).includes(state) ? state : undefined,
      listingId,
    });
    return { data: rows.map(coBrokeDto) };
  }

  @Post('co-broke-agreements')
  @TenantScoped()
  @Can('listing.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.coBroke.propose',
    summary: 'Propose a co-broke agreement',
    description:
      'The tenant holding a listing shares it with another agency at a split of its commission (above 0 and below 100 %); the co-agency signs it (D-293). The split applies to the commission recorded on the deal; money between the agencies moves outside the platform (ADR-0008).',
    implements: ['D-293', 'D-287'],
  })
  @ApiJsonBody(CoBrokeProposeDto, {
    listingId: FAKE.uuid,
    coAgencyTenantId: FAKE.tenantId,
    splitPercent: '40',
    note: 'แบ่งค่านายหน้า 60/40',
  })
  @ApiSuccess(201, {
    description: 'Proposed',
    type: CoBrokeDto,
    example: { ...CO_BROKE_EXAMPLE, state: 'proposed', signedAt: null },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'mandate.agency_required',
    'co_broke.invalid_state',
    ...T,
  )
  async coBrokePropose(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CoBrokeProposeDto,
  ): Promise<CoBrokeDto> {
    return coBrokeDto(await this.coBrokes.propose(ctx, body));
  }

  @Get('co-broke-agreements/:agreementId')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.coBroke.get',
    summary: 'One co-broke agreement',
    description: 'An agreement of the tenant (either side); anyone else gets 404 (D-293).',
    implements: ['D-293'],
  })
  @ApiSuccess(200, { description: 'Agreement', type: CoBrokeDto, example: CO_BROKE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async coBrokeGet(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
  ): Promise<CoBrokeDto> {
    return coBrokeDto(await this.coBrokes.get(ctx, id));
  }

  @Post('co-broke-agreements/:agreementId/actions/sign')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.coBroke.sign',
    summary: 'Sign a co-broke agreement (co-agency)',
    description:
      'The co-agency accepts the proposal; recorded with the user and time (in-app acceptance; the e-signed co-broke contract of G3 attaches later) (D-293).',
    implements: ['D-293'],
  })
  @ApiSuccess(200, { description: 'Signed', type: CoBrokeDto, example: CO_BROKE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'co_broke.invalid_state', ...T)
  async coBrokeSign(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
  ): Promise<CoBrokeDto> {
    return coBrokeDto(await this.coBrokes.act(ctx, id, 'sign'));
  }

  @Post('co-broke-agreements/:agreementId/actions/cancel')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.coBroke.cancel',
    summary: 'Cancel a co-broke proposal',
    description: 'Either agency cancels a proposal that is not signed yet (D-293).',
    implements: ['D-293'],
  })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: CoBrokeDto,
    example: { ...CO_BROKE_EXAMPLE, state: 'cancelled', signedAt: null },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'co_broke.invalid_state', ...T)
  async coBrokeCancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
  ): Promise<CoBrokeDto> {
    return coBrokeDto(await this.coBrokes.act(ctx, id, 'cancel'));
  }

  @Post('co-broke-agreements/:agreementId/actions/end')
  @HttpCode(200)
  @TenantScoped()
  @Can('listing.manage')
  @ApiEndpoint({
    id: 'owner.coBroke.end',
    summary: 'End a co-broke agreement',
    description: 'Either agency ends a signed agreement; deals closed later carry no co-broke share (D-293).',
    implements: ['D-293'],
  })
  @ApiSuccess(200, {
    description: 'Ended',
    type: CoBrokeDto,
    example: { ...CO_BROKE_EXAMPLE, state: 'ended' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'co_broke.invalid_state', ...T)
  async coBrokeEnd(
    @CurrentTenant() ctx: TenantContext,
    @Param('agreementId', ParseUUIDPipe) id: string,
  ): Promise<CoBrokeDto> {
    return coBrokeDto(await this.coBrokes.act(ctx, id, 'end'));
  }

  // ----------------------------------------------------------------------------------------------------- deals

  @Get('deals')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.deals.list',
    summary: 'Deals',
    description:
      'Leases of listed / mandated units that closed through the platform (activated, e-signed, first payment confirmed) where the tenant is the owner, the listing agency or the co-agency, newest first, with the recorded commissions and the fees the tenant owes (D-293, D-287). Commissions are paid outside the platform (ADR-0008); fees are invoiced on the platform invoice, never deducted from rent.',
    implements: ['D-293', 'D-287'],
  })
  @ApiSuccess(200, { description: 'Deals', type: DealsDto, example: { data: [DEAL_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', ...T)
  async dealList(@CurrentTenant() ctx: TenantContext): Promise<DealsDto> {
    return { data: (await this.deals.list(ctx)).map(dealDto) };
  }

  @Get('deals/:dealId')
  @TenantScoped()
  @Can('listing.read')
  @ApiEndpoint({
    id: 'owner.deals.get',
    summary: 'One deal',
    description: 'A deal the tenant took part in, with its own fee accruals (D-293); anyone else gets 404.',
    implements: ['D-293'],
  })
  @ApiSuccess(200, { description: 'Deal', type: DealDto, example: DEAL_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', ...T)
  async dealGet(
    @CurrentTenant() ctx: TenantContext,
    @Param('dealId', ParseUUIDPipe) id: string,
  ): Promise<DealDto> {
    return dealDto(await this.deals.get(ctx, id));
  }
}

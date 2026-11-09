import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { permissionsOf } from '@core/tenancy/access.service';
import { type Handover } from '@generated/prisma/client';
import { type HandoverTotals } from '@modules/ops-juristic/handovers/handover-plan';
import { type HandoverReview, HandoversService } from '@modules/ops-juristic/handovers/handovers.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type HandoverBankDto,
  type HandoverProblemCode,
  HandoverStateName,
  JuristicHandoverAcceptDto,
  JuristicHandoverDto,
  JuristicHandoverFormedDto,
  JuristicHandoverListQuery,
  JuristicHandoverRejectDto,
  JuristicHandoverReviewDto,
} from './juristic-handovers.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = [
  'validation.failed',
  'http.bad_request',
  'http.not_found',
  'idempotency.key_required',
  ...T,
] as const;
const READ = ['validation.failed', 'http.not_found', ...T] as const;
const IMPLEMENTS = ['D-314', 'D-333'];
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const TOTALS_EXAMPLE: HandoverTotals = {
  units: 312,
  floors: 8,
  parties: 330,
  ownerships: 336,
  unitsWithMoney: 312,
  advanceCommonFees: '4492800.00',
  firstFundContributions: '5070000.00',
  receivablesBroughtForward: '37200.00',
  receivableItems: 31,
};

export function handoverBank(h: Handover): HandoverBankDto | null {
  const rb = h.receivingBank as {
    bankCode: string;
    bankName?: string;
    accountName: string;
    accountNoMasked: string;
  } | null;
  if (!rb) return null;
  return {
    bankCode: rb.bankCode,
    bankName: rb.bankName ?? null,
    accountName: rb.accountName,
    accountNoMasked: rb.accountNoMasked,
    matchedBankAccountId: h.bankAccountId,
  };
}

function nextActions(perms: ReadonlySet<string>, h: Handover): string[] {
  if (!perms.has('juristic.handover.manage')) return [];
  if (h.state === 'pending_review') return ['accept', 'reject'];
  if (h.state === 'accepted' && !h.formedAt) return ['juristic_formed'];
  return [];
}

export function handoverDto(h: Handover, perms: ReadonlySet<string> = new Set()): JuristicHandoverDto {
  return {
    id: h.id,
    state: h.state as HandoverStateName,
    contractVersion: h.contractVersion,
    developerRef: h.developerRef,
    buildingRef: h.buildingRef,
    buildingName: h.buildingName,
    requestedHandoverAt: iso(h.requestedHandoverAt),
    asOfDate: day(h.asOfDate),
    totals: h.totals as unknown as HandoverTotals,
    receivingBank: handoverBank(h),
    developerTenantId: h.developerTenantId,
    buildingId: h.buildingId,
    acceptedAt: isoOrNull(h.acceptedAt),
    rejectedAt: isoOrNull(h.rejectedAt),
    rejectReason: h.rejectReason,
    rejectionDeliveredAt: isoOrNull(h.rejectionDeliveredAt),
    formedOn: day(h.formedOn),
    registrationNo: h.registrationNo,
    nextActions: nextActions(perms, h),
    createdAt: iso(h.createdAt),
    version: h.version,
  };
}

function reviewDto(ctx: TenantContext, r: HandoverReview): JuristicHandoverReviewDto {
  const perms = permissionsOf(ctx.role ? [ctx.role] : []);
  return {
    ...handoverDto(r.handover, perms),
    receivingBank: handoverBank({
      ...r.handover,
      bankAccountId: r.bankAccount?.id ?? r.handover.bankAccountId,
    }),
    problems: r.problems.map((p) => ({
      code: p.code as HandoverProblemCode,
      unitRef: p.unitRef ?? null,
      ref: p.ref ?? null,
    })),
    units: r.units,
    partiesToAttach: r.partiesToAttach,
    partiesToCreate: r.partiesToCreate,
    applied: r.applied,
  };
}

export const HANDOVER_EXAMPLE: JuristicHandoverDto = {
  id: FAKE.uuid,
  state: HandoverStateName.PendingReview,
  contractVersion: 2,
  developerRef: 'dev-tenant-42',
  buildingRef: 'bldg-a',
  buildingName: 'อาคาร A',
  requestedHandoverAt: FAKE.dateTime,
  asOfDate: '2026-10-31',
  totals: TOTALS_EXAMPLE,
  receivingBank: {
    bankCode: '014',
    bankName: 'ธนาคารตัวอย่าง',
    accountName: 'นิติบุคคลอาคารชุดตัวอย่าง',
    accountNoMasked: 'XXX-X-XX1234',
    matchedBankAccountId: FAKE.uuid,
  },
  developerTenantId: null,
  buildingId: null,
  acceptedAt: null,
  rejectedAt: null,
  rejectReason: null,
  rejectionDeliveredAt: null,
  formedOn: null,
  registrationNo: null,
  nextActions: ['accept', 'reject'],
  createdAt: FAKE.dateTime,
  version: 1,
};

const REVIEW_EXAMPLE: JuristicHandoverReviewDto = {
  ...HANDOVER_EXAMPLE,
  problems: [],
  units: [
    {
      unitRef: 'u-101',
      unitNo: 'A-101',
      owners: [{ partyRef: 'p-1', displayName: 'ผู้ซื้อ ตัวอย่าง', sharePct: '100.0000' }],
      advanceCommonFees: '14400.00',
      advancePeriodFrom: '2026-11-01',
      advancePeriodTo: '2027-10-31',
      firstFundContribution: '16250.00',
      receivablesBroughtForward: '1200.00',
      receivableItems: 1,
    },
  ],
  partiesToAttach: 0,
  partiesToCreate: 330,
  applied: null,
};

const ACCEPTED_EXAMPLE: JuristicHandoverReviewDto = {
  ...REVIEW_EXAMPLE,
  state: HandoverStateName.Accepted,
  buildingId: FAKE.buildingId,
  acceptedAt: FAKE.dateTime,
  nextActions: ['juristic_formed'],
  applied: {
    credits: '4492800.00',
    openingInvoices: 31,
    openingInvoicesTotal: '37200.00',
    fundContributions: '5070000.00',
  },
  version: 2,
};

@ApiTags('owner.juristicHandovers')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/handovers')
export class OwnerJuristicHandoversController {
  constructor(private readonly handovers: HandoversService) {}

  @Get()
  @TenantScoped()
  @Can('juristic.handover.read')
  @ApiEndpoint({
    id: 'owner.juristicHandovers.list',
    summary: 'Developer handovers',
    description:
      'The handovers getbuild sent for buildings of this juristic tenant (assigned by the platform or to the tenant already holding the building), newest first; filter by state. Juristic tenants only (D-314, D-333).',
    implements: IMPLEMENTS,
  })
  @ApiPaginated(JuristicHandoverDto, { example: HANDOVER_EXAMPLE })
  @ApiStandardErrors(...READ)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: JuristicHandoverListQuery,
  ): Promise<Page<JuristicHandoverDto>> {
    const perms = permissionsOf(ctx.role ? [ctx.role] : []);
    const { rows, total } = await this.handovers.list(ctx, { state: q.state, ...toSkipTake(q) });
    return paginated(
      rows.map((r) => handoverDto(r, perms)),
      total,
      q,
    );
  }

  @Get(':handoverId')
  @TenantScoped()
  @Can('juristic.handover.read')
  @ApiEndpoint({
    id: 'owner.juristicHandovers.get',
    summary: 'Review a developer handover',
    description:
      'Totals of the payload (units, parties, ownerships, Σ advance common fees, Σ first fund contributions, Σ receivables brought forward), per-unit money with the owners on the as-of date, the problems that block an acceptance, how many parties are matched to existing ones (same LINE id), the receiving bank account (masked) and the tenant bank account it matches; after acceptance what was recorded (equal to the payload). Party contact data getbuild encrypts is never kept (D-025). D-314, D-333.',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, { description: 'Review', type: JuristicHandoverReviewDto, example: REVIEW_EXAMPLE })
  @ApiStandardErrors(...READ)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('handoverId', ParseUUIDPipe) id: string,
  ): Promise<JuristicHandoverReviewDto> {
    return reviewDto(ctx, await this.handovers.review(ctx, id));
  }

  @Post(':handoverId/actions/accept')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.handover.manage')
  @ApiEndpoint({
    id: 'owner.juristicHandovers.accept',
    summary: 'Accept a developer handover',
    description:
      'From the handover date (409 `handover.not_due` before) and without problems (422 `handover.invalid`), in one transaction: the property and the building (legal form from getbuild or the body; owner = this tenant, operator = the developer until the juristic person is formed when the platform named one, else this tenant), floors, units (an existing unit with current owners → 409 `handover.unit_owned`), parties (never duplicated: same LINE id or an earlier handover), ownerships, LINE logins linked; advance common fees as each owner’s credit by share (paying the next invoices, never set off against debt brought forward), first fund contributions into the sinking fund, receivables brought forward as opening-balance invoices issued now (series OPB, normal due date), journals per unit. The recorded totals must equal the payload (409 `handover.totals_mismatch`, nothing recorded). Audited and evented; requires `Idempotency-Key` (D-314, D-333).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(JuristicHandoverAcceptDto, { legalForm: 'condo_act', notifyOpeningBalances: true })
  @ApiSuccess(200, { description: 'Accepted', type: JuristicHandoverReviewDto, example: ACCEPTED_EXAMPLE })
  @ApiStandardErrors(
    'handover.invalid_state',
    'handover.not_due',
    'handover.invalid',
    'handover.unit_owned',
    'handover.totals_mismatch',
    'register.shares_exceeded',
    ...WRITE,
  )
  async accept(
    @CurrentTenant() ctx: TenantContext,
    @Param('handoverId', ParseUUIDPipe) id: string,
    @Body() body: JuristicHandoverAcceptDto,
  ): Promise<JuristicHandoverReviewDto> {
    return reviewDto(ctx, await this.handovers.accept(ctx, id, body));
  }

  @Post(':handoverId/actions/reject')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.handover.manage')
  @ApiEndpoint({
    id: 'owner.juristicHandovers.reject',
    summary: 'Reject a developer handover',
    description:
      'Pending handovers only: refused with a reason (5–1000) that goes back to getbuild through the handoff port (retried by the job `juristic-handovers`; waits while `GETBUILD_MODE=off`, O-033); getbuild may then send a corrected handover. Nothing is recorded in the register. Audited; requires `Idempotency-Key` (D-333).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(JuristicHandoverRejectDto, { reason: 'ยอดเงินกองทุนไม่ตรงกับสมุดบัญชี โปรดตรวจสอบและส่งใหม่' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: JuristicHandoverReviewDto,
    example: {
      ...REVIEW_EXAMPLE,
      state: HandoverStateName.Rejected,
      rejectedAt: FAKE.dateTime,
      rejectReason: 'ยอดเงินกองทุนไม่ตรงกับสมุดบัญชี โปรดตรวจสอบและส่งใหม่',
      nextActions: [],
    },
  })
  @ApiStandardErrors('handover.invalid_state', ...WRITE)
  async reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('handoverId', ParseUUIDPipe) id: string,
    @Body() body: JuristicHandoverRejectDto,
  ): Promise<JuristicHandoverReviewDto> {
    return reviewDto(ctx, await this.handovers.reject(ctx, id, body));
  }

  @Post(':handoverId/actions/juristic-formed')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.handover.manage')
  @ApiEndpoint({
    id: 'owner.juristicHandovers.juristicFormed',
    summary: 'Record the juristic person’s formation',
    description:
      'Accepted handovers, once: while the developer operates the building its operator period closes and the juristic tenant’s opens (reason `juristic_formed`; nothing is copied — residents, invoices and credits stay on the building); the developer keeps a `warranty` grant until the last building / unit warranty end of the handover. `juristic.formed` goes to getbuild through the integration outbox. Audited; requires `Idempotency-Key` (D-150 D1, D-333).',
    implements: ['D-150', ...IMPLEMENTS],
  })
  @ApiJsonBody(JuristicHandoverFormedDto, { formedOn: '2026-12-15', registrationNo: 'นต.123/2569' })
  @ApiSuccess(200, {
    description: 'Recorded',
    type: JuristicHandoverReviewDto,
    example: { ...ACCEPTED_EXAMPLE, formedOn: '2026-12-15', registrationNo: 'นต.123/2569', nextActions: [] },
  })
  @ApiStandardErrors('handover.invalid_state', ...WRITE)
  async formed(
    @CurrentTenant() ctx: TenantContext,
    @Param('handoverId', ParseUUIDPipe) id: string,
    @Body() body: JuristicHandoverFormedDto,
  ): Promise<JuristicHandoverReviewDto> {
    return reviewDto(ctx, await this.handovers.formed(ctx, id, body));
  }
}

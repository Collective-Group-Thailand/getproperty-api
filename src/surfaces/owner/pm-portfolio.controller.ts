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
import { ManagementContractsService } from '@modules/ops-juristic/pm/management-contracts.service';
import { PmPortfolioService } from '@modules/ops-juristic/pm/pm-portfolio.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  ManagementContractDto,
  ManagementContractListQuery,
  ManagementContractReasonDto,
  ManagementContractStateName,
  ManagementContractTerminateDto,
  ManagementFeeChargeDto,
  PmPortfolioBuildingDto,
  PmPortfolioDto,
  PmStaffAssignmentCreateDto,
  PmStaffAssignmentDto,
  PmStaffAssignmentEndDto,
  PmStaffAssignmentListQuery,
  StaffBoardDto,
} from './pm-portfolio.dto';
import {
  ASSIGNMENT_EXAMPLE,
  assignmentDto,
  CHARGE_EXAMPLE,
  chargeDto,
  CONTRACT_EXAMPLE,
  managementContractDto,
  PORTFOLIO_BUILDING_EXAMPLE,
  PORTFOLIO_EXAMPLE,
  portfolioBuildingDto,
  portfolioDto,
  STAFF_BOARD_EXAMPLE,
  staffBoardDto,
} from './pm-portfolio.mappers';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const IRREVERSIBLE = [...WRITE, 'idempotency.key_required'] as const;
const READ = ['validation.failed', 'http.not_found', ...T] as const;
const IMPLEMENTS = ['D-150', 'D-334'];

const perms = (ctx: TenantContext) => permissionsOf(ctx.role ? [ctx.role] : []);
const PM_CONTRACT_EXAMPLE: ManagementContractDto = {
  ...CONTRACT_EXAMPLE,
  vendorId: null,
  expenseAccountId: null,
  whtKey: null,
  resolutionId: null,
};
const PM_CHARGE_EXAMPLE: ManagementFeeChargeDto = { ...CHARGE_EXAMPLE, expenseRequest: null };

@ApiTags('owner.pmPortfolio')
@ApiSurface(SURFACES.owner)
@Controller('owner/pm/portfolio')
export class OwnerPmPortfolioController {
  constructor(private readonly portfolio: PmPortfolioService) {}

  @Get()
  @TenantScoped()
  @Can('pm.portfolio.read')
  @ApiEndpoint({
    id: 'owner.pmPortfolio.get',
    summary: 'Portfolio of managed buildings',
    description:
      'One row per building this PM company manages **today** — an active management contract inside its term **and** a live read grant on the building (a revoked or expired grant hides the building at once) — with aggregate KPIs computed in the juristic tenant: 12-month collection rate and within-`kpiDays` rate (last cycle too), arrears (overdue now, > 90 days), budget use of the approved budget in force, open service requests / SLA-breached / open work orders, service contracts ending within `pm.portfolio_expiring_days`; PM staff assigned today; totals. A PM `staff` member sees only the buildings he is assigned to today. No resident, invoice or ledger line is exposed. `pm_company` tenants only (D-150 C3, D-334).',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, { description: 'Portfolio', type: PmPortfolioDto, example: PORTFOLIO_EXAMPLE })
  @ApiStandardErrors(...READ)
  async get(@CurrentTenant() ctx: TenantContext): Promise<PmPortfolioDto> {
    return portfolioDto(await this.portfolio.portfolio(ctx));
  }

  @Get('buildings/:buildingId')
  @TenantScoped()
  @Can('pm.portfolio.read')
  @ApiEndpoint({
    id: 'owner.pmPortfolio.building',
    summary: 'A managed building',
    description:
      'The portfolio row of one building managed today (with the expiring service contracts listed); any other building — never managed, contract ended or terminated, grant revoked, or not assigned to a `staff` caller — is 404 (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, {
    description: 'Building',
    type: PmPortfolioBuildingDto,
    example: PORTFOLIO_BUILDING_EXAMPLE,
  })
  @ApiStandardErrors(...READ)
  async building(
    @CurrentTenant() ctx: TenantContext,
    @Param('buildingId', ParseUUIDPipe) buildingId: string,
  ): Promise<PmPortfolioBuildingDto> {
    const b = await this.portfolio.portfolioBuilding(ctx, buildingId);
    return portfolioBuildingDto(b, this.portfolio.asOf());
  }
}

@ApiTags('owner.pmContracts')
@ApiSurface(SURFACES.owner)
@Controller('owner/pm/management-contracts')
export class OwnerPmContractsController {
  constructor(private readonly contracts: ManagementContractsService) {}

  @Get()
  @TenantScoped()
  @Can('pm.contract.read')
  @ApiEndpoint({
    id: 'owner.pmContracts.list',
    summary: 'Management contracts of the PM company',
    description:
      'Offers addressed to this PM company and the contracts it holds or held (drafts of the juristic office are not shown); filters state, building and juristic tenant (`counterpartTenantId`). Juristic-internal references (vendor, account, resolution, document) are null on this side (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiPaginated(ManagementContractDto, { example: PM_CONTRACT_EXAMPLE })
  @ApiStandardErrors(...READ)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ManagementContractListQuery,
  ): Promise<Page<ManagementContractDto>> {
    const { rows, total } = await this.contracts.list(ctx, 'pm', {
      state: q.state,
      buildingId: q.buildingId,
      counterpartTenantId: q.counterpartTenantId,
      ...toSkipTake(q),
    });
    const p = perms(ctx);
    return paginated(
      rows.map((r) => managementContractDto(r, p)),
      total,
      q,
    );
  }

  @Get(':contractId')
  @TenantScoped()
  @Can('pm.contract.read')
  @ApiEndpoint({
    id: 'owner.pmContracts.get',
    summary: 'A management contract (PM side)',
    description:
      'An offer or contract of this PM company; a draft or another company’s contract is 404 (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, { description: 'Contract', type: ManagementContractDto, example: PM_CONTRACT_EXAMPLE })
  @ApiStandardErrors(...READ)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.get(ctx, 'pm', id), perms(ctx));
  }

  @Post(':contractId/actions/accept')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('pm.contract.manage')
  @ApiEndpoint({
    id: 'owner.pmContracts.accept',
    summary: 'Accept a management contract',
    description:
      'Offered → active, on or before the start date (later: 409 `management_contract.offer_expired`): the juristic tenant’s building becomes visible to this PM company through a **read** grant (module `juristic`, reason `pm_contract`) from the start date to the day after the end date (Bangkok midnight). Audited in both tenants and evented; requires `Idempotency-Key` (D-152, D-334).',
    implements: ['D-152', ...IMPLEMENTS],
  })
  @ApiSuccess(200, {
    description: 'Accepted',
    type: ManagementContractDto,
    example: { ...PM_CONTRACT_EXAMPLE, feesRequested: 0 },
  })
  @ApiStandardErrors(
    'management_contract.invalid_state',
    'management_contract.offer_expired',
    'management_contract.overlap',
    ...IRREVERSIBLE,
  )
  async accept(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.accept(ctx, id), perms(ctx));
  }

  @Post(':contractId/actions/decline')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('pm.contract.manage')
  @ApiEndpoint({
    id: 'owner.pmContracts.decline',
    summary: 'Decline a management contract offer',
    description:
      'Offered → declined with a reason (the juristic office may offer again). Audited; requires `Idempotency-Key` (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(ManagementContractReasonDto, { reason: 'ค่าบริการต่ำกว่าต้นทุนบุคลากรที่ต้องจัดให้' })
  @ApiSuccess(200, {
    description: 'Declined',
    type: ManagementContractDto,
    example: {
      ...PM_CONTRACT_EXAMPLE,
      state: ManagementContractStateName.Declined,
      access: { active: false, validFrom: null, validTo: null, revokedAt: null },
      acceptedAt: null,
      declinedAt: FAKE.dateTime,
      declineReason: 'ค่าบริการต่ำกว่าต้นทุนบุคลากรที่ต้องจัดให้',
      feesRequested: 0,
      nextActions: [],
    },
  })
  @ApiStandardErrors('management_contract.invalid_state', ...IRREVERSIBLE)
  async decline(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ManagementContractReasonDto,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.decline(ctx, id, body.reason), perms(ctx));
  }

  @Post(':contractId/actions/terminate')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('pm.contract.manage')
  @ApiEndpoint({
    id: 'owner.pmContracts.terminate',
    summary: 'Terminate a management contract (PM side)',
    description:
      'Active → terminated with a reason; `effectiveOn` today (default) … the end date. Access to the building ends at once (today) or at that date; fees stop at the last day of service; staff assignments end. Audited in both tenants; requires `Idempotency-Key` (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(ManagementContractTerminateDto, {
    reason: 'บริษัทยุติการให้บริการในพื้นที่นี้',
    effectiveOn: '2027-06-01',
  })
  @ApiSuccess(200, {
    description: 'Terminated',
    type: ManagementContractDto,
    example: {
      ...PM_CONTRACT_EXAMPLE,
      state: ManagementContractStateName.Terminated,
      terminatedOn: '2027-06-01',
      terminatedAt: FAKE.dateTime,
      terminatedBy: 'pm' as ManagementContractDto['terminatedBy'],
      terminationReason: 'บริษัทยุติการให้บริการในพื้นที่นี้',
      nextActions: [],
    },
  })
  @ApiStandardErrors('management_contract.invalid_state', ...IRREVERSIBLE)
  async terminate(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ManagementContractTerminateDto,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.terminate(ctx, 'pm', id, body), perms(ctx));
  }

  @Get(':contractId/charges')
  @TenantScoped()
  @Can('pm.contract.read')
  @ApiEndpoint({
    id: 'owner.pmContracts.charges',
    summary: 'Fees requested from the juristic office',
    description:
      'The fee requested per ended period (days of service, prorated amount and VAT, due date). Approval and payment happen in the juristic tenant (its expense request is not shown here) (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, { description: 'Charges', type: [ManagementFeeChargeDto], example: [PM_CHARGE_EXAMPLE] })
  @ApiStandardErrors(...READ)
  async charges(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ManagementFeeChargeDto[]> {
    return (await this.contracts.charges(ctx, 'pm', id)).map(chargeDto);
  }
}

@ApiTags('owner.pmStaff')
@ApiSurface(SURFACES.owner)
@Controller('owner/pm')
export class OwnerPmStaffController {
  constructor(private readonly portfolio: PmPortfolioService) {}

  @Get('staff-board')
  @TenantScoped()
  @Can('pm.staff.read')
  @ApiEndpoint({
    id: 'owner.pmStaff.board',
    summary: 'Staff board',
    description:
      'Today: members of the PM company with their assignments, each managed building with its staff, and active members without an assignment. A `staff` caller sees only himself and his buildings (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, { description: 'Board', type: StaffBoardDto, example: STAFF_BOARD_EXAMPLE })
  @ApiStandardErrors(...READ)
  async board(@CurrentTenant() ctx: TenantContext): Promise<StaffBoardDto> {
    return staffBoardDto(await this.portfolio.staffBoard(ctx));
  }

  @Get('staff-assignments')
  @TenantScoped()
  @Can('pm.staff.read')
  @ApiEndpoint({
    id: 'owner.pmStaff.list',
    summary: 'Staff assignments',
    description:
      'Newest first; filters building, member and `current` (in force today). A `staff` caller sees his own (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiPaginated(PmStaffAssignmentDto, { example: ASSIGNMENT_EXAMPLE })
  @ApiStandardErrors(...READ)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: PmStaffAssignmentListQuery,
  ): Promise<Page<PmStaffAssignmentDto>> {
    const { rows, total } = await this.portfolio.listAssignments(ctx, {
      buildingId: q.buildingId,
      userId: q.userId,
      current: q.current,
      ...toSkipTake(q),
    });
    return paginated(rows.map(assignmentDto), total, q);
  }

  @Post('staff-assignments')
  @TenantScoped()
  @Can('pm.staff.manage')
  @ApiEndpoint({
    id: 'owner.pmStaff.assign',
    summary: 'Assign a member to a managed building',
    description:
      'An active member of this PM company (422 `pm_staff.not_member`) on the building of an active contract (else 404), inside the contract term (422 `pm_staff.outside_term`), never twice for overlapping days (409 `pm_staff.overlap`); role, shift, from / to (exclusive; open-ended assignments stop with the contract). Audited (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(PmStaffAssignmentCreateDto, {
    contractId: FAKE.uuid,
    userId: FAKE.uuid,
    role: 'building_manager',
    shift: 'จ.–ศ. 08:00–17:00',
    startsOn: '2027-01-01',
  })
  @ApiSuccess(201, { description: 'Assigned', type: PmStaffAssignmentDto, example: ASSIGNMENT_EXAMPLE })
  @ApiStandardErrors('pm_staff.not_member', 'pm_staff.outside_term', 'pm_staff.overlap', ...WRITE)
  async assign(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: PmStaffAssignmentCreateDto,
  ): Promise<PmStaffAssignmentDto> {
    return assignmentDto(await this.portfolio.assign(ctx, body));
  }

  @Post('staff-assignments/:assignmentId/actions/end')
  @HttpCode(200)
  @TenantScoped()
  @Can('pm.staff.manage')
  @ApiEndpoint({
    id: 'owner.pmStaff.end',
    summary: 'End a staff assignment',
    description:
      '`endsOn` (exclusive) today (default) or later, after the start and not after a set end; an ended assignment is 409 `pm_staff.ended`. Audited (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(PmStaffAssignmentEndDto, { endsOn: '2027-03-01' })
  @ApiSuccess(200, {
    description: 'Ended',
    type: PmStaffAssignmentDto,
    example: { ...ASSIGNMENT_EXAMPLE, endsOn: '2027-03-01', version: 2 },
  })
  @ApiStandardErrors('pm_staff.ended', ...WRITE)
  async end(
    @CurrentTenant() ctx: TenantContext,
    @Param('assignmentId', ParseUUIDPipe) id: string,
    @Body() body: PmStaffAssignmentEndDto,
  ): Promise<PmStaffAssignmentDto> {
    return assignmentDto(await this.portfolio.endAssignment(ctx, id, body));
  }
}

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
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import {
  ManagementContractCreateDto,
  ManagementContractDto,
  ManagementContractListQuery,
  ManagementContractReasonDto,
  ManagementContractStateName,
  ManagementContractTerminateDto,
  ManagementContractUpdateDto,
  ManagementFeeChargeDto,
  PmStaffAssignmentDto,
} from './pm-portfolio.dto';
import {
  ASSIGNMENT_EXAMPLE,
  assignmentDto,
  CHARGE_EXAMPLE,
  chargeDto,
  CONTRACT_EXAMPLE,
  managementContractDto,
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
const DRAFT_EXAMPLE: ManagementContractDto = {
  ...CONTRACT_EXAMPLE,
  state: ManagementContractStateName.Draft,
  access: { active: false, validFrom: null, validTo: null, revokedAt: null },
  feesRequested: 0,
  offeredAt: null,
  acceptedAt: null,
  nextActions: ['edit', 'offer', 'cancel'],
  version: 1,
};

@ApiTags('owner.juristicManagementContracts')
@ApiSurface(SURFACES.owner)
@Controller('owner/juristic/management-contracts')
export class OwnerJuristicManagementContractsController {
  constructor(
    private readonly contracts: ManagementContractsService,
    private readonly portfolio: PmPortfolioService,
  ) {}

  @Get()
  @TenantScoped()
  @Can('juristic.management_contract.read')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.list',
    summary: 'Management contracts with PM companies',
    description:
      'Newest start first; filters state, building and PM company (`counterpartTenantId`). Members limited to buildings see those buildings only. Juristic tenants only (D-150 C3, D-334).',
    implements: IMPLEMENTS,
  })
  @ApiPaginated(ManagementContractDto, { example: CONTRACT_EXAMPLE })
  @ApiStandardErrors(...READ)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ManagementContractListQuery,
  ): Promise<Page<ManagementContractDto>> {
    const { rows, total } = await this.contracts.list(ctx, 'juristic', {
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

  @Post()
  @TenantScoped()
  @Can('juristic.management_contract.manage')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.create',
    summary: 'Draft a management contract',
    description:
      'A building of this tenant, the PM company’s getproperty tenant (an active `pm_company`, else 422 `management_contract.pm_tenant_invalid`), the PM company as a vendor of this tenant (payee of the fee; blocked → 422 `vendor.blocked`), fee per period (VAT included) and its VAT part, period monthly · quarterly · annual, due day (in arrears), term, expense account, WHT key, resolution and contract document. Audited (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(ManagementContractCreateDto, {
    buildingId: FAKE.buildingId,
    pmTenantId: FAKE.tenantId,
    vendorId: FAKE.uuid,
    title: 'สัญญาจ้างบริหารจัดการอาคาร 2570',
    fee: '85600.00',
    vatAmount: '5600.00',
    feePeriod: 'monthly',
    dueDay: 5,
    startsOn: '2027-01-01',
    endsOn: '2027-12-31',
    expenseAccountId: FAKE.uuid,
    whtKey: 'services',
    resolutionId: FAKE.uuid,
  })
  @ApiSuccess(201, { description: 'Draft', type: ManagementContractDto, example: DRAFT_EXAMPLE })
  @ApiStandardErrors(
    'management_contract.pm_tenant_invalid',
    'management_contract.overlap',
    'vendor.blocked',
    ...WRITE,
  )
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ManagementContractCreateDto,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.create(ctx, body), perms(ctx));
  }

  @Get(':contractId')
  @TenantScoped()
  @Can('juristic.management_contract.read')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.get',
    summary: 'A management contract',
    description:
      'Terms, state, whether the PM company’s read grant on the building is in force, the number of periods whose fee was requested and the caller’s next actions (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, { description: 'Contract', type: ManagementContractDto, example: CONTRACT_EXAMPLE })
  @ApiStandardErrors(...READ)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.get(ctx, 'juristic', id), perms(ctx));
  }

  @Patch(':contractId')
  @TenantScoped()
  @Can('juristic.management_contract.manage')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.update',
    summary: 'Edit a draft management contract',
    description:
      'Drafts only (409 `management_contract.invalid_state`); `version` → 412 when changed meanwhile. Audited (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(ManagementContractUpdateDto, { fee: '90950.00', vatAmount: '5950.00', version: 1 })
  @ApiSuccess(200, { description: 'Draft', type: ManagementContractDto, example: DRAFT_EXAMPLE })
  @ApiStandardErrors(
    'management_contract.invalid_state',
    'management_contract.pm_tenant_invalid',
    'concurrency.stale',
    'vendor.blocked',
    ...WRITE,
  )
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ManagementContractUpdateDto,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.update(ctx, id, body), perms(ctx));
  }

  @Post(':contractId/actions/offer')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.management_contract.manage')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.offer',
    summary: 'Offer the contract to the PM company',
    description:
      'Draft → offered: the terms are complete — expense account, the adopted resolution of the building that appoints the manager (422 `management_contract.resolution_required` / `…resolution_invalid`), start today or later — and no other offered / active contract of the building overlaps the term (409 `management_contract.overlap`). The PM company then sees the offer. Audited and evented; requires `Idempotency-Key` (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, {
    description: 'Offered',
    type: ManagementContractDto,
    example: {
      ...CONTRACT_EXAMPLE,
      state: ManagementContractStateName.Offered,
      access: { active: false, validFrom: null, validTo: null, revokedAt: null },
      acceptedAt: null,
      feesRequested: 0,
      nextActions: ['cancel'],
      version: 2,
    },
  })
  @ApiStandardErrors(
    'management_contract.invalid_state',
    'management_contract.resolution_required',
    'management_contract.resolution_invalid',
    'management_contract.pm_tenant_invalid',
    'management_contract.overlap',
    'vendor.blocked',
    ...IRREVERSIBLE,
  )
  async offer(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.offer(ctx, id), perms(ctx));
  }

  @Post(':contractId/actions/cancel')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.management_contract.manage')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.cancel',
    summary: 'Cancel a draft or offered contract',
    description:
      'Draft / offered → cancelled with a reason; an accepted contract is terminated instead (409 `management_contract.invalid_state`). Audited; requires `Idempotency-Key` (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(ManagementContractReasonDto, { reason: 'ที่ประชุมใหญ่มีมติเลือกบริษัทอื่น' })
  @ApiSuccess(200, {
    description: 'Cancelled',
    type: ManagementContractDto,
    example: {
      ...DRAFT_EXAMPLE,
      state: ManagementContractStateName.Cancelled,
      cancelledAt: FAKE.dateTime,
      cancelReason: 'ที่ประชุมใหญ่มีมติเลือกบริษัทอื่น',
      nextActions: [],
    },
  })
  @ApiStandardErrors('management_contract.invalid_state', ...IRREVERSIBLE)
  async cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ManagementContractReasonDto,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.cancel(ctx, id, body.reason), perms(ctx));
  }

  @Post(':contractId/actions/terminate')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('juristic.management_contract.manage')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.terminate',
    summary: 'Terminate an active management contract',
    description:
      'Active → terminated with a reason; `effectiveOn` = the first day without service, today (default) … the end date. The PM company’s read grant is revoked at once when the date is today (or the term had not started), else cut at that date — the PM no longer sees the building; fees stop at the last day of service; its staff assignments end. Audited in both tenants; requires `Idempotency-Key` (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiJsonBody(ManagementContractTerminateDto, {
    reason: 'ผลงานไม่เป็นไปตามสัญญา ตามมติคณะกรรมการ',
    effectiveOn: '2027-06-01',
  })
  @ApiSuccess(200, {
    description: 'Terminated',
    type: ManagementContractDto,
    example: {
      ...CONTRACT_EXAMPLE,
      state: ManagementContractStateName.Terminated,
      access: { active: false, validFrom: FAKE.dateTime, validTo: null, revokedAt: FAKE.dateTime },
      terminatedOn: '2027-06-01',
      terminatedAt: FAKE.dateTime,
      terminatedBy: 'juristic' as ManagementContractDto['terminatedBy'],
      terminationReason: 'ผลงานไม่เป็นไปตามสัญญา ตามมติคณะกรรมการ',
      nextActions: [],
    },
  })
  @ApiStandardErrors('management_contract.invalid_state', ...IRREVERSIBLE)
  async terminate(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
    @Body() body: ManagementContractTerminateDto,
  ): Promise<ManagementContractDto> {
    return managementContractDto(await this.contracts.terminate(ctx, 'juristic', id, body), perms(ctx));
  }

  @Get(':contractId/charges')
  @TenantScoped()
  @Can('juristic.management_contract.read')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.charges',
    summary: 'Management fees requested',
    description:
      'One row per ended billing period: days of service, the prorated fee and VAT, the due date (in arrears) and the submitted expense request carrying it — approved by the approval bands and paid by the juristic like any expense, never automatically (D-311, D-329, D-334).',
    implements: ['D-311', ...IMPLEMENTS],
  })
  @ApiSuccess(200, { description: 'Charges', type: [ManagementFeeChargeDto], example: [CHARGE_EXAMPLE] })
  @ApiStandardErrors(...READ)
  async charges(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<ManagementFeeChargeDto[]> {
    return (await this.contracts.charges(ctx, 'juristic', id)).map(chargeDto);
  }

  @Get(':contractId/staff')
  @TenantScoped()
  @Can('juristic.management_contract.read')
  @ApiEndpoint({
    id: 'owner.juristicManagementContracts.staff',
    summary: 'PM staff assigned to the building',
    description:
      'Who the PM company assigned to the building under this contract (name, role, shift, dates), newest first (D-334).',
    implements: IMPLEMENTS,
  })
  @ApiSuccess(200, {
    description: 'Assignments',
    type: [PmStaffAssignmentDto],
    example: [ASSIGNMENT_EXAMPLE],
  })
  @ApiStandardErrors(...READ)
  async staff(
    @CurrentTenant() ctx: TenantContext,
    @Param('contractId', ParseUUIDPipe) id: string,
  ): Promise<PmStaffAssignmentDto[]> {
    return (await this.portfolio.contractStaff(ctx, id)).map(assignmentDto);
  }
}

import { CurrentTenant } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { SupportGrantRequired } from '@common/auth/support-grant.guard';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiCursor, ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated } from '@common/pagination/pagination';
import { type CursorPage, type Page } from '@common/pagination/pagination.dto';
import { AuditQueryService } from '@core/audit/audit-query.service';
import { SettingsService } from '@core/settings/settings.service';
import { AccessService } from '@core/tenancy/access.service';
import { MembershipService } from '@core/tenancy/membership.service';
import { SupportGrantService } from '@core/tenancy/support-grant.service';
import { TenantService } from '@core/tenancy/tenant.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import {
  AUDIT_EXAMPLE,
  auditPage,
  auditQueryOf,
  SUPPORT_GRANT_EXAMPLE,
  supportGrantDto,
} from '../owner/governance.controller';
import {
  AuditEntryDto,
  AuditQueryDto,
  SupportGrantApproveDto,
  SupportGrantDto,
} from '../owner/governance.dto';
import { type SettingScopeName, SettingUpdateDto, SettingVersionDto } from '../owner/money-settings.dto';
import {
  INVITATION_EXAMPLE,
  invitationDto,
  MEMBER_EXAMPLE,
  memberDto,
  TENANT_EXAMPLE,
  tenantProfileDto,
} from '../owner/tenancy.controller';
import { MemberDto, TenantProfileDto } from '../owner/tenancy.dto';
import { currentUserId, iso } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  AdminBuildingDto,
  AdminTenantListQuery,
  type BuildingTenantRoleName,
  SupportGrantRequestDto,
  TenantCreatedDto,
  TenantCreateDto,
} from './admin.dto';

const pathTenant = (tenantId: string): TenantContext => ({ tenantId, source: 'path' });

@ApiTags('admin.tenants')
@ApiSurface(SURFACES.admin)
@Controller('admin/tenants')
export class AdminTenantsController {
  constructor(
    private readonly tenants: TenantService,
    private readonly memberships: MembershipService,
    private readonly audit: AuditQueryService,
    private readonly settings: SettingsService,
    private readonly grants: SupportGrantService,
  ) {}

  @Get()
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.tenants.list',
    summary: 'Tenants (SaaS customers)',
    description:
      'Every tenant with its type, plan and status (D-150, D-161). Company data only — tenant business data needs a support grant.',
    implements: ['D-150', 'D-161'],
  })
  @ApiPaginated(TenantProfileDto, { example: TENANT_EXAMPLE })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: AdminTenantListQuery): Promise<Page<TenantProfileDto>> {
    const { rows, total } = await this.tenants.list({
      q: query.q,
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    });
    return paginated(rows.map(tenantProfileDto), total, query);
  }

  @Post()
  @Idempotent()
  @Can('admin.tenant.manage')
  @ApiEndpoint({
    id: 'admin.tenants.create',
    summary: 'Onboard a tenant',
    description:
      'Creates the tenant of a type with its company data, its first data key and legal-entity party, and invites its first Owner by SMS (D-145, D-150, D-161). Audited and evented (`tenant.created`).',
    implements: ['D-145', 'D-150', 'D-151', 'D-161'],
  })
  @ApiJsonBody(TenantCreateDto, {
    type: 'apartment',
    slug: 'sample-dormitory',
    displayName: FAKE.propertyName,
    legalName: FAKE.companyName,
    legalForm: 'company',
    taxId: FAKE.taxId,
    vatRegistered: false,
    owner: { phone: '+66810001234', language: 'th' },
  })
  @ApiSuccess(201, {
    description: 'Onboarded',
    type: TenantCreatedDto,
    example: {
      tenant: TENANT_EXAMPLE,
      invitation: {
        ...INVITATION_EXAMPLE,
        role: 'owner',
        code: 'ABCD-EFGH-JKLM-NPQR',
        inviteUrl: 'https://app.getproperty.invalid/join?code=ABCD-EFGH-JKLM-NPQR',
      },
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.conflict', 'provider.unavailable')
  async create(@Body() body: TenantCreateDto): Promise<TenantCreatedDto> {
    const r = await this.tenants.onboard({ ...body, address: body.address as never });
    return {
      tenant: tenantProfileDto(r.tenant),
      invitation: {
        ...invitationDto(r.invitation.invitation),
        code: r.invitation.code,
        inviteUrl: r.invitation.inviteUrl,
      },
    };
  }

  @Get(':tenantId')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.tenants.get',
    summary: 'One tenant',
    description: 'Company data, type, plan and status of a tenant (D-161).',
    implements: ['D-161'],
  })
  @ApiSuccess(200, { description: 'The tenant', type: TenantProfileDto, example: TENANT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async get(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<TenantProfileDto> {
    return tenantProfileDto(await this.tenants.getAny(tenantId));
  }

  @Get(':tenantId/buildings')
  @Can('admin.tenant.read')
  @ApiEndpoint({
    id: 'admin.tenants.buildings',
    summary: 'Buildings of a tenant',
    description:
      'Buildings the tenant owns or operates with their property and unit count — what the console needs to assign a device or open an install order (web F5, D-214). Structure only, no business data (D-206).',
    implements: ['D-214', 'D-206', 'D-152'],
  })
  @ApiSuccess(200, {
    description: 'Buildings',
    type: [AdminBuildingDto],
    example: [
      {
        id: FAKE.buildingId,
        code: 'A',
        name: 'อาคาร A',
        propertyId: FAKE.uuid,
        propertyName: 'หอพักตัวอย่าง',
        unitCount: 12,
        roles: ['owner', 'operator'],
      },
    ],
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async buildings(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<AdminBuildingDto[]> {
    return (await this.tenants.buildingsOf(tenantId)).map((b) => ({
      ...b,
      roles: b.roles as BuildingTenantRoleName[],
    }));
  }

  @Get(':tenantId/members')
  @Can('admin.tenant.read')
  @SupportGrantRequired('tenantId')
  @ApiEndpoint({
    id: 'admin.tenants.members',
    summary: 'Members of a tenant (support grant)',
    description:
      'Tenant data: Support needs an active support grant approved by the tenant’s Owner; Platform admin bypasses it. Every request is audited (`support_grant.used` / `support_grant.bypassed`, D-090, D-161).',
    implements: ['D-090', 'D-161'],
  })
  @ApiSuccess(200, { description: 'Members', type: [MemberDto], example: [MEMBER_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'support.grant_required')
  async members(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @CurrentTenant() ctx: TenantContext,
  ): Promise<MemberDto[]> {
    return (await this.memberships.list(ctx.tenantId === tenantId ? ctx : pathTenant(tenantId))).map(
      memberDto,
    );
  }

  @Get(':tenantId/audit-log')
  @Can('admin.tenant.read')
  @SupportGrantRequired('tenantId')
  @ApiEndpoint({
    id: 'admin.tenants.auditLog',
    summary: 'Audit log of a tenant (support grant)',
    description:
      'As `owner.auditLog.list`, read by Collective support under an active grant (audited, D-090, D-161).',
    implements: ['D-090', 'D-161'],
  })
  @ApiCursor(AuditEntryDto, { example: AUDIT_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'pagination.cursor_invalid',
    'http.not_found',
    'support.grant_required',
  )
  async auditLog(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: AuditQueryDto,
  ): Promise<CursorPage<AuditEntryDto>> {
    const rows = await this.audit.forTenant(pathTenant(tenantId), auditQueryOf(query, tenantId));
    return auditPage(rows, query.limit, tenantId);
  }

  @Put(':tenantId/settings/:key')
  @Can('admin.setting.manage')
  @ApiParam({ name: 'key', example: 'compliance.tariff_cap', description: 'Setting key (catalogue).' })
  @ApiEndpoint({
    id: 'admin.tenants.updateSetting',
    summary: 'Set a tenant value of a setting as the platform',
    description:
      'For tenant-scoped keys the platform administers (e.g. the D-021a `compliance.tariff_cap` mode of one tenant): an effective-dated tenant version written by the platform, audited and evented (ADR-0004).',
    implements: ['D-021', 'D-144', 'ADR-0004'],
  })
  @ApiJsonBody(SettingUpdateDto, { value: { mode: 'warn' }, reason: 'ลูกค้ารายนี้ใช้โหมดเตือน' })
  @ApiSuccess(200, {
    description: 'Version created',
    type: SettingVersionDto,
    example: {
      versionId: FAKE.uuid,
      key: 'compliance.tariff_cap',
      scope: 'tenant',
      effectiveFrom: FAKE.dateTime,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'settings.unknown_key',
    'settings.invalid_value',
    'settings.backdated',
  )
  async updateSetting(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('key') key: string,
    @Body() body: SettingUpdateDto,
  ): Promise<SettingVersionDto> {
    await this.tenants.getAny(tenantId);
    const row = await this.settings.setTenant(
      pathTenant(tenantId),
      key,
      body.value,
      body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      body.reason,
      true,
    );
    return {
      versionId: row.id,
      key,
      scope: 'tenant' as SettingScopeName,
      effectiveFrom: iso(row.effectiveFrom),
    };
  }

  @Post(':tenantId/support-grants')
  @Can('admin.support_grant.request')
  @ApiEndpoint({
    id: 'admin.tenants.requestSupportGrant',
    summary: 'Ask a tenant for support access',
    description:
      'Creates a `requested` support grant; the tenant’s Owners are notified and approve it in-app for a limited time (D-090). Audited.',
    implements: ['D-090', 'D-161'],
  })
  @ApiJsonBody(SupportGrantRequestDto, { reason: 'ตรวจสอบปัญหาการส่งบิลรอบ พ.ย.', ticketRef: 'SUP-1024' })
  @ApiSuccess(201, {
    description: 'Requested',
    type: SupportGrantDto,
    example: {
      ...SUPPORT_GRANT_EXAMPLE,
      state: 'requested',
      approvedVia: null,
      validFrom: null,
      validTo: null,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async requestSupportGrant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: SupportGrantRequestDto,
  ): Promise<SupportGrantDto> {
    return supportGrantDto(await this.grants.request(tenantId, body));
  }
}

@ApiTags('admin.supportGrants')
@ApiSurface(SURFACES.admin)
@Controller('admin/support-grants')
export class AdminSupportGrantsController {
  constructor(
    private readonly grants: SupportGrantService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @Can('admin.support_grant.request')
  @ApiEndpoint({
    id: 'admin.supportGrants.list',
    summary: 'Support grants across tenants',
    description: 'Requested, active and past grants (D-090).',
    implements: ['D-090'],
  })
  @ApiSuccess(200, { description: 'Grants', type: [SupportGrantDto], example: [SUPPORT_GRANT_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<SupportGrantDto[]> {
    return (await this.grants.listAll()).map(supportGrantDto);
  }

  @Post(':supportGrantId/actions/approve-incident')
  @HttpCode(200)
  @Can('admin.support_grant.approve_incident')
  @ApiEndpoint({
    id: 'admin.supportGrants.approveIncident',
    summary: 'Approve support access for an incident',
    description:
      'Platform admin only, for an incident when the Owner cannot be reached: approves a requested grant for a short window, recorded as `platform_admin_incident` and audited; the Owners are notified (D-090).',
    implements: ['D-090', 'D-161'],
  })
  @ApiJsonBody(SupportGrantApproveDto, { hours: 2 })
  @ApiSuccess(200, {
    description: 'Active',
    type: SupportGrantDto,
    example: { ...SUPPORT_GRANT_EXAMPLE, approvedVia: 'platform_admin_incident' },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'support.invalid_transition')
  async approveIncident(
    @Param('supportGrantId', ParseUUIDPipe) id: string,
    @Body() body: SupportGrantApproveDto,
  ): Promise<SupportGrantDto> {
    return supportGrantDto(await this.grants.approveIncident(id, body.hours));
  }

  @Post(':supportGrantId/actions/revoke')
  @HttpCode(200)
  @Can('admin.support_grant.request')
  @ApiEndpoint({
    id: 'admin.supportGrants.revoke',
    summary: 'End support access',
    description: 'Support ends its own access early, or the platform admin ends any grant (audited, D-090).',
    implements: ['D-090'],
  })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: SupportGrantDto,
    example: { ...SUPPORT_GRANT_EXAMPLE, state: 'revoked' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'support.invalid_transition')
  async revoke(@Param('supportGrantId', ParseUUIDPipe) id: string): Promise<SupportGrantDto> {
    const userId = currentUserId();
    const { roles } = await this.access.platform(userId);
    return supportGrantDto(
      await this.grants.revoke(null, id, roles.includes('platform_admin') ? undefined : userId),
    );
  }
}

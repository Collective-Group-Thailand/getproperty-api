import { Can } from '@common/auth/can.decorator';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiCursor } from '@common/pagination/api-paginated.decorator';
import { type CursorPage } from '@common/pagination/pagination.dto';
import { AuditQueryService } from '@core/audit/audit-query.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';
import { DsrService } from '@core/privacy/dsr.service';
import { SettingsService } from '@core/settings/settings.service';
import { PlatformUsersService } from '@core/tenancy/platform-users.service';
import { WorkflowService } from '@core/workflow/workflow.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

import { AUDIT_EXAMPLE, auditPage, auditQueryOf, DSR_EXAMPLE, dsrDto } from '../owner/governance.controller';
import { AuditEntryDto, AuditQueryDto, DsrDto, DsrListQuery } from '../owner/governance.dto';
import { type SettingScopeName, SettingUpdateDto, SettingVersionDto } from '../owner/money-settings.dto';
import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  FeatureFlagChangeDto,
  FeatureFlagDto,
  PlatformRoleName,
  PlatformUserCreateDto,
  PlatformUserDto,
  RoleGrantDto,
  SettingDefinitionDto,
  WorkflowDefinitionDto,
} from './admin.dto';

/** Platform-wide audit filter (optional tenant). */
export class PlatformAuditQueryDto extends AuditQueryDto {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}

type PlatformUserRow = Awaited<ReturnType<PlatformUsersService['list']>>[number];

const platformUserDto = (u: PlatformUserRow): PlatformUserDto => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  status: u.status,
  totpEnabled: Boolean(u.userCredentialUser?.totpEnabledAt),
  roles: u.platformRoleAssignmentUser.map((a) => ({
    role: a.role.key as PlatformRoleName,
    expiresAt: isoOrNull(a.expiresAt),
  })),
  lastLoginAt: isoOrNull(u.lastLoginAt),
});

const PLATFORM_USER_EXAMPLE = {
  id: FAKE.uuid,
  email: FAKE.email,
  displayName: FAKE.name,
  status: 'active',
  totpEnabled: true,
  roles: [{ role: PlatformRoleName.Support, expiresAt: null }],
  lastLoginAt: FAKE.dateTime,
};

@ApiTags('admin.platformUsers')
@ApiSurface(SURFACES.admin)
@Controller('admin/platform-users')
export class AdminPlatformUsersController {
  constructor(private readonly users: PlatformUsersService) {}

  @Get()
  @Can('admin.user.manage')
  @ApiEndpoint({
    id: 'admin.platformUsers.list',
    summary: 'Collective staff with platform roles',
    description:
      'Platform users and their roles (Platform admin, Support, Field engineer, Finance — D-161); TOTP is mandatory for all.',
    implements: ['D-161'],
  })
  @ApiSuccess(200, { description: 'Users', type: [PlatformUserDto], example: [PLATFORM_USER_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<PlatformUserDto[]> {
    return (await this.users.list()).map(platformUserDto);
  }

  @Post()
  @Idempotent()
  @Can('admin.user.manage')
  @ApiEndpoint({
    id: 'admin.platformUsers.create',
    summary: 'Create a platform user',
    description: 'Email + temporary password; TOTP enrolment is forced at first sign-in (D-161). Audited.',
    implements: ['D-161'],
  })
  @ApiJsonBody(PlatformUserCreateDto, {
    email: FAKE.email,
    displayName: FAKE.name,
    roles: ['support'],
    temporaryPassword: 'Temp-Passw0rd-Example!',
  })
  @ApiSuccess(201, {
    description: 'Created',
    type: PlatformUserDto,
    example: { ...PLATFORM_USER_EXAMPLE, totpEnabled: false, lastLoginAt: null },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.conflict', 'auth.weak_password')
  async create(@Body() body: PlatformUserCreateDto): Promise<PlatformUserDto> {
    const user = await this.users.create(body);
    const row = (await this.users.list()).find((u) => u.id === user.id);
    return row
      ? platformUserDto(row)
      : {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          status: user.status,
          totpEnabled: false,
          roles: [],
          lastLoginAt: null,
        };
  }

  @Post(':userId/roles')
  @HttpCode(204)
  @Can('admin.user.manage')
  @ApiEndpoint({
    id: 'admin.platformUsers.grantRole',
    summary: 'Grant a platform role',
    description:
      'Optionally time-boxed; takes effect on the next request (access cache invalidated). Audited.',
    implements: ['D-161'],
  })
  @ApiJsonBody(RoleGrantDto, { role: 'support', expiresAt: null })
  @ApiSuccess(204, { description: 'Granted' })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async grant(@Param('userId', ParseUUIDPipe) userId: string, @Body() body: RoleGrantDto): Promise<void> {
    await this.users.grant(userId, body.role, body.expiresAt ? new Date(body.expiresAt) : null);
  }

  @Delete(':userId/roles/:role')
  @HttpCode(204)
  @Can('admin.user.manage')
  @ApiParam({
    name: 'role',
    enum: PlatformRoleName,
    enumName: 'PlatformRole',
    example: PlatformRoleName.Support,
  })
  @ApiEndpoint({
    id: 'admin.platformUsers.revokeRole',
    summary: 'Revoke a platform role',
    description: 'Immediate: the user’s sessions are revoked. Audited.',
    implements: ['D-161'],
  })
  @ApiSuccess(204, { description: 'Revoked' })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async revoke(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('role', new ParseEnumPipe(PlatformRoleName)) role: PlatformRoleName,
  ): Promise<void> {
    await this.users.revoke(userId, role);
  }
}

@ApiTags('admin.settings')
@ApiSurface(SURFACES.admin)
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.settings.list',
    summary: 'Setting catalogue with platform values',
    description:
      'Every configurable business value (decisions marked configurable), its scopes, who may edit it, and the platform value in force now (ADR-0004).',
    implements: ['D-144', 'ADR-0004'],
  })
  @ApiSuccess(200, {
    description: 'Catalogue',
    type: [SettingDefinitionDto],
    example: [
      {
        key: 'reminders.schedule',
        valueType: 'json',
        scopeAllowed: ['platform', 'tenant'],
        editableBy: ['tenant.settings.update'],
        description: 'D-045: LINE reminders after due date + grace.',
        value: [1, 3, 7],
        effectiveFrom: FAKE.dateTime,
      },
    ],
  })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<SettingDefinitionDto[]> {
    const now = this.clock.now();
    const out: SettingDefinitionDto[] = [];
    for (const def of this.settings.catalogue()) {
      const v = await this.settings.at(def.key, now);
      out.push({
        key: def.key,
        valueType: def.valueType,
        scopeAllowed: [...def.scopeAllowed],
        editableBy: [...def.editableBy],
        description: def.description,
        value: v?.value ?? null,
        effectiveFrom: v ? iso(v.effectiveFrom) : null,
      });
    }
    return out;
  }

  @Put(':key')
  @Can('admin.setting.manage')
  @ApiParam({ name: 'key', example: 'notifications.quiet_hours', description: 'Setting key (catalogue).' })
  @ApiEndpoint({
    id: 'admin.settings.update',
    summary: 'Add a platform version of a setting',
    description:
      'Effective-dated platform default (no backdating); compliance keys need `admin.compliance.manage` per the catalogue. Audited, cache invalidated through the outbox (ADR-0004).',
    implements: ['D-144', 'D-021', 'ADR-0004'],
  })
  @ApiJsonBody(SettingUpdateDto, {
    value: { start: '21:00', end: '08:00', timezone: 'Asia/Bangkok' },
    reason: 'ค่าเริ่มต้นช่วงเวลาเงียบ',
  })
  @ApiSuccess(200, {
    description: 'Version created',
    type: SettingVersionDto,
    example: {
      versionId: FAKE.uuid,
      key: 'notifications.quiet_hours',
      scope: 'platform',
      effectiveFrom: FAKE.dateTime,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'settings.unknown_key',
    'settings.not_editable',
    'settings.invalid_value',
    'settings.backdated',
  )
  async update(@Param('key') key: string, @Body() body: SettingUpdateDto): Promise<SettingVersionDto> {
    const row = await this.settings.setPlatform(
      key,
      body.value,
      body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      body.reason,
    );
    return {
      versionId: row.id,
      key,
      scope: 'platform' as SettingScopeName,
      effectiveFrom: iso(row.effectiveFrom),
    };
  }
}

type FlagRow = Awaited<ReturnType<FeatureFlagsService['list']>>[number];
const flagDto = (f: FlagRow): FeatureFlagDto => ({
  key: f.key,
  description: f.description,
  defaultEnabled: f.defaultEnabled,
  rolloutPct: f.rolloutPct,
  overrides: f.overrides.map((o) => ({ tenantId: o.tenantId, enabled: o.enabled, reason: o.reason })),
});
const FLAG_EXAMPLE = {
  key: 'module.service_requests',
  description: 'Service requests module (B5).',
  defaultEnabled: false,
  rolloutPct: 0,
  overrides: [{ tenantId: FAKE.tenantId, enabled: true, reason: 'นำร่องลูกค้ารายแรก' }],
};

@ApiTags('admin.featureFlags')
@ApiSurface(SURFACES.admin)
@Controller('admin/feature-flags')
export class AdminFeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  @Can('admin.feature_flag.manage')
  @ApiEndpoint({
    id: 'admin.featureFlags.list',
    summary: 'Feature flags',
    description:
      'Defaults, rollout percentage and tenant overrides (module entitlements reach `/v1/owner/me`).',
    implements: ['D-161'],
  })
  @ApiSuccess(200, { description: 'Flags', type: [FeatureFlagDto], example: [FLAG_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<FeatureFlagDto[]> {
    return (await this.flags.list()).map(flagDto);
  }

  @Put(':key')
  @Can('admin.feature_flag.manage')
  @ApiParam({ name: 'key', example: 'module.service_requests' })
  @ApiEndpoint({
    id: 'admin.featureFlags.update',
    summary: 'Change a flag default or a tenant override',
    description: 'Audited and evented (`feature_flag.changed`); caches drop through the outbox.',
    implements: ['D-161'],
  })
  @ApiJsonBody(FeatureFlagChangeDto, { tenantId: FAKE.tenantId, enabled: true, reason: 'นำร่องลูกค้ารายแรก' })
  @ApiSuccess(200, { description: 'Flag', type: FeatureFlagDto, example: FLAG_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async update(@Param('key') key: string, @Body() body: FeatureFlagChangeDto): Promise<FeatureFlagDto> {
    return flagDto(await this.flags.change(key, body));
  }
}

@ApiTags('admin.auditLog')
@ApiSurface(SURFACES.admin)
@Controller('admin/audit-log')
export class AdminAuditLogController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @Can('admin.audit.read')
  @ApiEndpoint({
    id: 'admin.auditLog.list',
    summary: 'Platform audit log',
    description:
      'All audit rows across tenants (platform admin), newest first; filter by tenant, action prefix, subject or actor (D-161).',
    implements: ['D-161', 'D-025'],
  })
  @ApiCursor(AuditEntryDto, { example: AUDIT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'pagination.cursor_invalid', 'http.not_found')
  async list(@Query() query: PlatformAuditQueryDto): Promise<CursorPage<AuditEntryDto>> {
    const rows = await this.audit.forPlatform({
      ...auditQueryOf(query, 'platform'),
      tenantId: query.tenantId,
    });
    return auditPage(rows, query.limit, 'platform');
  }
}

@ApiTags('admin.dataSubjectRequests')
@ApiSurface(SURFACES.admin)
@Controller('admin/data-subject-requests')
export class AdminDsrController {
  constructor(private readonly dsr: DsrService) {}

  @Get()
  @Can('admin.dsr.manage')
  @ApiEndpoint({
    id: 'admin.dataSubjectRequests.list',
    summary: 'PDPA requests across tenants',
    description:
      'Collective as processor oversees deadlines; platform-level requests (no tenant) are handled here (D-025).',
    implements: ['D-025'],
  })
  @ApiSuccess(200, { description: 'Requests', type: [DsrDto], example: [DSR_EXAMPLE] })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: DsrListQuery): Promise<DsrDto[]> {
    return (await this.dsr.listAll(query.state)).map(dsrDto);
  }
}

@ApiTags('admin.workflowDefinitions')
@ApiSurface(SURFACES.admin)
@Controller('admin/workflow-definitions')
export class AdminWorkflowDefinitionsController {
  constructor(private readonly workflow: WorkflowService) {}

  @Get()
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.workflowDefinitions.list',
    summary: 'Workflow definitions',
    description:
      'Versioned state machines seeded from code (deposit settlement, DSR, …) with their SLA rules (D-159).',
    implements: ['D-159'],
  })
  @ApiSuccess(200, {
    description: 'Definitions',
    type: [WorkflowDefinitionDto],
    example: [
      {
        key: 'deposit_settlement',
        version: 1,
        tenantId: null,
        states: [{ key: 'open', initial: true }],
        transitions: [{ from: 'open', event: 'settle', to: 'settled' }],
        active: true,
      },
    ],
  })
  @ApiStandardErrors('validation.failed')
  async list(): Promise<WorkflowDefinitionDto[]> {
    return (await this.workflow.listDefinitions()).map((d) => ({
      key: d.key,
      version: d.version,
      tenantId: d.tenantId,
      states: d.states as Record<string, unknown>[],
      transitions: d.transitions as Record<string, unknown>[],
      active: d.isActive,
    }));
  }
}

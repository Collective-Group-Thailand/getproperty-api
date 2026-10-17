import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiCursor } from '@common/pagination/api-paginated.decorator';
import { decodeCursor, encodeCursor } from '@common/pagination/cursor';
import { type CursorPage } from '@common/pagination/pagination.dto';
import { GrantService } from '@core/asset/grant.service';
import { AuditQueryService } from '@core/audit/audit-query.service';
import { NotificationRoutesService } from '@core/notifications/notification-routes.service';
import { DsrService } from '@core/privacy/dsr.service';
import { SupportGrantService } from '@core/tenancy/support-grant.service';
import {
  type AssetAccessGrant,
  type AuditLog,
  type DataSubjectRequest,
  type SupportGrant,
} from '@generated/prisma/client';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  AssetGrantCreateDto,
  AssetGrantDto,
  AuditEntryDto,
  type AuditOutcomeName,
  AuditQueryDto,
  DsrActionDto,
  DsrActionName,
  DsrDto,
  type DsrKindName,
  DsrListQuery,
  type DsrStateName,
  type GrantAccessName,
  type GrantReasonName,
  type GrantScopeName,
  NotificationRouteDto,
  NotificationRouteUpdateDto,
  ReasonDto,
  type SupportGrantApprovalViaName,
  SupportGrantApproveDto,
  SupportGrantDto,
  type SupportGrantStateName,
} from './governance.dto';

const TENANT_ERRORS = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

export function supportGrantDto(g: SupportGrant): SupportGrantDto {
  return {
    id: g.id,
    tenantId: g.tenantId,
    reason: g.reason,
    ticketRef: g.ticketRef,
    state: g.state as SupportGrantStateName,
    approvedVia: g.approvedVia as SupportGrantApprovalViaName | null,
    validFrom: isoOrNull(g.validFrom),
    validTo: isoOrNull(g.validTo),
    createdAt: iso(g.createdAt),
  };
}

export const SUPPORT_GRANT_EXAMPLE = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  reason: 'ตรวจสอบปัญหาการส่งบิลรอบ พ.ย.',
  ticketRef: 'SUP-1024',
  state: 'active',
  approvedVia: 'in_app',
  validFrom: FAKE.dateTime,
  validTo: '2026-11-01T04:15:00+07:00',
  createdAt: FAKE.dateTime,
};

export function assetGrantDto(g: AssetAccessGrant): AssetGrantDto {
  return {
    id: g.id,
    tenantId: g.tenantId,
    granteeTenantId: g.granteeTenantId,
    buildingId: g.buildingId,
    unitId: g.unitId,
    scope: g.scope as GrantScopeName,
    modules: g.modules,
    access: g.access as GrantAccessName,
    reason: g.reason as GrantReasonName,
    validFrom: iso(g.validFrom),
    validTo: isoOrNull(g.validTo),
    revokedAt: isoOrNull(g.revokedAt),
  };
}

const ASSET_GRANT_EXAMPLE = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  granteeTenantId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  buildingId: FAKE.buildingId,
  unitId: null,
  scope: 'building',
  modules: ['readings'],
  access: 'read',
  reason: 'pm_contract',
  validFrom: FAKE.dateTime,
  validTo: null,
  revokedAt: null,
};

export function auditEntryDto(a: AuditLog): AuditEntryDto {
  return {
    id: a.id,
    occurredAt: iso(a.occurredAt),
    action: a.action,
    outcome: a.outcome as AuditOutcomeName,
    actor: a.actor as Record<string, unknown>,
    subjectType: a.subjectType,
    subjectId: a.subjectId,
    buildingId: a.buildingId,
    supportGrantId: a.supportGrantId,
    ip: a.ip,
    before: (a.before as Record<string, unknown> | null) ?? null,
    after: (a.after as Record<string, unknown> | null) ?? null,
    metadata: a.metadata as Record<string, unknown>,
  };
}

export const AUDIT_EXAMPLE = {
  id: FAKE.uuid,
  occurredAt: FAKE.dateTime,
  action: 'tenant.bank_account.changed',
  outcome: 'success',
  actor: { type: 'user', audience: 'operator', id: FAKE.uuid },
  subjectType: 'core.tenant_bank_account',
  subjectId: FAKE.uuid,
  buildingId: null,
  supportGrantId: null,
  ip: '203.0.113.10',
  before: null,
  after: { state: 'active' },
  metadata: {},
};

/** Keyset page of audit rows (signed cursor bound to `binding`, newest first). */
export function auditPage(rows: AuditLog[], limit: number, binding: string): CursorPage<AuditEntryDto> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map(auditEntryDto),
    meta: { nextCursor: rows.length > limit && last ? encodeCursor(binding, { id: last.id }) : null },
  };
}

export function auditQueryOf(q: AuditQueryDto, binding: string) {
  const position = decodeCursor(binding, q.cursor);
  return {
    action: q.action,
    subjectId: q.subjectId,
    actorId: q.actorId,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    beforeId: position?.id,
    limit: q.limit,
  };
}

export function dsrDto(d: DataSubjectRequest): DsrDto {
  return {
    id: d.id,
    tenantId: d.tenantId,
    kind: d.kind as DsrKindName,
    state: d.state as DsrStateName,
    receivedAt: iso(d.receivedAt),
    dueAt: iso(d.dueAt),
    fulfilledAt: isoOrNull(d.fulfilledAt),
    exportDocumentId: d.exportDocumentId,
    notes: d.notes,
  };
}

export const DSR_EXAMPLE = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  kind: 'access',
  state: 'received',
  receivedAt: FAKE.dateTime,
  dueAt: '2026-12-01T00:15:00+07:00',
  fulfilledAt: null,
  exportDocumentId: null,
  notes: null,
};

@ApiTags('owner.supportGrants')
@ApiSurface(SURFACES.owner)
@Controller('owner/support-grants')
export class OwnerSupportGrantsController {
  constructor(private readonly grants: SupportGrantService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.support_grant.approve')
  @ApiEndpoint({
    id: 'owner.supportGrants.list',
    summary: 'Support access requests for my tenant',
    description:
      'Collective support staff read tenant data only through a time-boxed grant the Owner approves in-app (D-090, D-161); every use is audited. Lists requested, active and past grants.',
    implements: ['D-090', 'D-161'],
  })
  @ApiSuccess(200, { description: 'Grants', type: [SupportGrantDto], example: [SUPPORT_GRANT_EXAMPLE] })
  @ApiStandardErrors(...TENANT_ERRORS)
  async list(@CurrentTenant() ctx: TenantContext): Promise<SupportGrantDto[]> {
    return (await this.grants.list(ctx)).map(supportGrantDto);
  }

  @Post(':supportGrantId/actions/approve')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.support_grant.approve')
  @ApiEndpoint({
    id: 'owner.supportGrants.approve',
    summary: 'Approve a support access request',
    description:
      'Starts the access window now for `hours` (default and maximum: the `support.grant_max_hours` setting). Audited and evented; the support user can read this tenant until the window ends or the Owner revokes it (D-090).',
    implements: ['D-090', 'D-161'],
  })
  @ApiJsonBody(SupportGrantApproveDto, { hours: 4 })
  @ApiSuccess(200, { description: 'Active', type: SupportGrantDto, example: SUPPORT_GRANT_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'support.invalid_transition', ...TENANT_ERRORS)
  async approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('supportGrantId', ParseUUIDPipe) id: string,
    @Body() body: SupportGrantApproveDto,
  ): Promise<SupportGrantDto> {
    return supportGrantDto(await this.grants.approve(ctx, id, body.hours));
  }

  @Post(':supportGrantId/actions/deny')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.support_grant.approve')
  @ApiEndpoint({
    id: 'owner.supportGrants.deny',
    summary: 'Deny a support access request',
    description: 'The request is closed without access (audited, D-090).',
    implements: ['D-090'],
  })
  @ApiSuccess(200, {
    description: 'Denied',
    type: SupportGrantDto,
    example: { ...SUPPORT_GRANT_EXAMPLE, state: 'denied', approvedVia: null, validFrom: null, validTo: null },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'support.invalid_transition', ...TENANT_ERRORS)
  async deny(
    @CurrentTenant() ctx: TenantContext,
    @Param('supportGrantId', ParseUUIDPipe) id: string,
  ): Promise<SupportGrantDto> {
    return supportGrantDto(await this.grants.deny(ctx, id));
  }

  @Post(':supportGrantId/actions/revoke')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.support_grant.approve')
  @ApiEndpoint({
    id: 'owner.supportGrants.revoke',
    summary: 'Revoke support access now',
    description: 'Ends an approved or active grant immediately (audited, D-090).',
    implements: ['D-090'],
  })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: SupportGrantDto,
    example: { ...SUPPORT_GRANT_EXAMPLE, state: 'revoked' },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'support.invalid_transition', ...TENANT_ERRORS)
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('supportGrantId', ParseUUIDPipe) id: string,
  ): Promise<SupportGrantDto> {
    return supportGrantDto(await this.grants.revoke(ctx, id));
  }
}

@ApiTags('owner.assetGrants')
@ApiSurface(SURFACES.owner)
@Controller('owner/asset-grants')
export class OwnerAssetGrantsController {
  constructor(private readonly grants: GrantService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.grant.manage')
  @ApiEndpoint({
    id: 'owner.assetGrants.list',
    summary: 'Asset access grants given or received',
    description:
      'Grants on my buildings to other tenants (PM company, landlord, contractor) and grants other tenants gave me — the only cross-tenant visibility, per module and access level (D-152).',
    implements: ['D-152'],
  })
  @ApiSuccess(200, { description: 'Grants', type: [AssetGrantDto], example: [ASSET_GRANT_EXAMPLE] })
  @ApiStandardErrors(...TENANT_ERRORS)
  async list(@CurrentTenant() ctx: TenantContext): Promise<AssetGrantDto[]> {
    return (await this.grants.list(ctx)).map(assetGrantDto);
  }

  @Post()
  @TenantScoped()
  @Idempotent()
  @Can('tenant.grant.manage')
  @ApiEndpoint({
    id: 'owner.assetGrants.create',
    summary: 'Grant another tenant access to a building or unit',
    description:
      'Only the building’s owner or operator tenant may grant; modules are the asset-core grant module keys; audited and evented (`grant.changed`). An unknown grantee or a building of another tenant is a 404 (D-152).',
    implements: ['D-152', 'D-153'],
  })
  @ApiJsonBody(AssetGrantCreateDto, {
    granteeTenantId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    buildingId: FAKE.buildingId,
    modules: ['readings'],
    access: 'read',
    reason: 'pm_contract',
  })
  @ApiSuccess(201, { description: 'Granted', type: AssetGrantDto, example: ASSET_GRANT_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'grant.not_allowed',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: AssetGrantCreateDto,
  ): Promise<AssetGrantDto> {
    return assetGrantDto(
      await this.grants.create(ctx, {
        granteeTenantId: body.granteeTenantId,
        buildingId: body.buildingId,
        unitId: body.unitId ?? null,
        modules: body.modules,
        access: body.access,
        reason: body.reason,
        validFrom: body.validFrom ? new Date(body.validFrom) : undefined,
        validTo: body.validTo ? new Date(body.validTo) : null,
      }),
    );
  }

  @Post(':grantId/actions/revoke')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.grant.manage')
  @ApiEndpoint({
    id: 'owner.assetGrants.revoke',
    summary: 'Revoke an asset access grant',
    description: 'The grantee loses access at once (audited, `grant.changed`, D-152).',
    implements: ['D-152'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'สิ้นสุดสัญญาบริหาร' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: AssetGrantDto,
    example: { ...ASSET_GRANT_EXAMPLE, revokedAt: FAKE.dateTime },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'grant.not_allowed',
    'http.conflict',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('grantId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<AssetGrantDto> {
    return assetGrantDto(await this.grants.revoke(ctx, id, body.reason));
  }
}

@ApiTags('owner.auditLog')
@ApiSurface(SURFACES.owner)
@Controller('owner/audit-log')
export class OwnerAuditLogController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.audit.read')
  @ApiEndpoint({
    id: 'owner.auditLog.list',
    summary: 'Audit log of my tenant',
    description:
      'Security, money and PDPA-relevant actions of my tenant, newest first (login, roles, permission denials, settings, bank account, support-grant use, consents, DSR, PII decrypts, grants). The cursor is signed with the tenant id; a cursor of another tenant is a 404 (contract §8).',
    implements: ['D-090', 'D-025', 'D-161'],
  })
  @ApiCursor(AuditEntryDto, { example: AUDIT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'pagination.cursor_invalid', 'http.not_found', ...TENANT_ERRORS)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: AuditQueryDto,
  ): Promise<CursorPage<AuditEntryDto>> {
    const rows = await this.audit.forTenant(ctx, auditQueryOf(query, ctx.tenantId));
    return auditPage(rows, query.limit, ctx.tenantId);
  }
}

@ApiTags('owner.dataSubjectRequests')
@ApiSurface(SURFACES.owner)
@Controller('owner/data-subject-requests')
export class OwnerDsrController {
  constructor(private readonly dsr: DsrService) {}

  @Get()
  @TenantScoped()
  @Can('privacy.manage')
  @ApiEndpoint({
    id: 'owner.dataSubjectRequests.list',
    summary: 'PDPA data subject requests addressed to my tenant',
    description:
      'The tenant is the controller of its residents’ data, Collective the processor (D-025): requests arrive here with a due date (`privacy.dsr_due_days`) tracked by the workflow engine (D-159).',
    implements: ['D-025', 'D-159'],
  })
  @ApiSuccess(200, { description: 'Requests', type: [DsrDto], example: [DSR_EXAMPLE] })
  @ApiStandardErrors('validation.failed', ...TENANT_ERRORS)
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: DsrListQuery): Promise<DsrDto[]> {
    return (await this.dsr.list(ctx, query.state)).map(dsrDto);
  }

  @Post(':requestId/actions/:action')
  @HttpCode(200)
  @TenantScoped()
  @Can('privacy.manage')
  @ApiParam({ name: 'action', enum: DsrActionName, enumName: 'DsrAction', example: DsrActionName.Verify })
  @ApiEndpoint({
    id: 'owner.dataSubjectRequests.transition',
    summary: 'Move a data subject request through its workflow',
    description:
      '`verify` → `start` → `fulfil` (access/portability: an export file is produced; erasure: the subject’s party data is anonymised where no legal hold applies) or `reject`. Audited (D-025, D-159).',
    implements: ['D-025', 'D-159'],
  })
  @ApiJsonBody(DsrActionDto, { notes: 'ยืนยันตัวตนผ่านบัตรประชาชนที่สำนักงานแล้ว' })
  @ApiSuccess(200, {
    description: 'New state',
    type: DsrDto,
    example: { ...DSR_EXAMPLE, state: 'verifying' },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'workflow.invalid_transition',
    'workflow.guard_failed',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async transition(
    @CurrentTenant() ctx: TenantContext,
    @Param('requestId', ParseUUIDPipe) id: string,
    @Param('action', new ParseEnumPipe(DsrActionName)) action: DsrActionName,
    @Body() body: DsrActionDto,
  ): Promise<DsrDto> {
    return dsrDto(await this.dsr.transition(ctx, id, action, body.notes ?? null));
  }
}

@ApiTags('owner.notificationRoutes')
@ApiSurface(SURFACES.owner)
@Controller('owner/notification-routes')
export class OwnerNotificationRoutesController {
  constructor(private readonly routes: NotificationRoutesService) {}

  @Get()
  @TenantScoped()
  @Can('notification.route.manage')
  @ApiEndpoint({
    id: 'owner.notificationRoutes.list',
    summary: 'Channels used for resident notifications',
    description:
      'The routing matrix event × channel for resident-facing events: platform defaults with my tenant’s overrides (B1.3). Consent gating and quiet hours still apply to every channel (D-025).',
    implements: ['D-025', 'D-063'],
  })
  @ApiSuccess(200, {
    description: 'Routes',
    type: [NotificationRouteDto],
    example: [
      {
        eventType: 'invoice.issued',
        audience: 'resident',
        channel: 'line',
        enabled: true,
        urgent: false,
        overridden: false,
      },
    ],
  })
  @ApiStandardErrors(...TENANT_ERRORS)
  async list(@CurrentTenant() ctx: TenantContext): Promise<NotificationRouteDto[]> {
    return (await this.routes.forTenant(ctx)) as NotificationRouteDto[];
  }

  @Put()
  @TenantScoped()
  @Can('notification.route.manage')
  @ApiEndpoint({
    id: 'owner.notificationRoutes.update',
    summary: 'Turn a resident notification channel on or off',
    description:
      'Writes my tenant’s override of one event × channel (audited, `notification.route_changed`).',
    implements: ['D-063'],
  })
  @ApiJsonBody(NotificationRouteUpdateDto, {
    eventType: 'invoice.issued',
    audience: 'resident',
    channel: 'sms',
    enabled: false,
  })
  @ApiSuccess(200, {
    description: 'Route',
    type: NotificationRouteDto,
    example: {
      eventType: 'invoice.issued',
      audience: 'resident',
      channel: 'sms',
      enabled: false,
      urgent: false,
      overridden: true,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'tenant.read_only', ...TENANT_ERRORS)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: NotificationRouteUpdateDto,
  ): Promise<NotificationRouteDto> {
    return (await this.routes.setTenant(ctx, body)) as NotificationRouteDto;
  }
}

import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { etagOf } from '@common/etag/etag';
import { UseEtag } from '@common/etag/etag.interceptor';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type AccessEvent } from '@generated/prisma/client';
import {
  AccessCredentialsService,
  type CredentialRow,
} from '@modules/smart-access/access-credentials.service';
import { AccessViewsService, type RevealedCredential } from '@modules/smart-access/access-views.service';
import { type LockRow, LocksService } from '@modules/smart-access/locks.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type AccessEventDto,
  AccessEventQuery,
  AccessEventsDto,
  type AccessHolderKindName,
  type AccessResultName,
  type AccessSourceName,
  CredentialDto,
  CredentialListQuery,
  CredentialsDto,
  type CredentialStatusName,
  type CredentialTypeName,
  IssuedCredentialDto,
  LockActiveDto,
  LockDto,
  LockQuery,
  LockRegisterDto,
  type LockScopeName,
  LocksDto,
  type LockVendorName,
  ResidentAccessEventQuery,
  RevealedCredentialsDto,
  StaffCodeCreateDto,
  VisitorCodeCreateDto,
} from './access.dto';
import { ReasonDto } from './governance.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;
const WRITE = ['validation.failed', 'http.bad_request', 'http.not_found', ...T] as const;
const DAY = 86_400_000;

export function lockDto(l: LockRow, lowPct = 20): LockDto {
  return {
    id: l.id,
    name: l.name,
    scope: l.scope as LockScopeName,
    vendor: l.vendor as LockVendorName,
    vendorLockId: l.vendorLockId,
    buildingId: l.buildingId,
    unitId: l.unitId,
    unitNo: l.unit?.unitNo ?? null,
    deviceId: l.deviceId,
    serial: l.device.serial,
    assetItemId: l.assetItemId,
    batteryPct: l.batteryPct,
    batteryLow: l.batteryLowSince !== null || (l.batteryPct !== null && l.batteryPct <= lowPct),
    batteryCheckedAt: isoOrNull(l.batteryCheckedAt),
    online: l.online,
    lastLogSyncAt: isoOrNull(l.lastLogSyncAt),
    isActive: l.isActive,
    version: l.version,
  };
}

export function credentialDto(c: CredentialRow): CredentialDto {
  return {
    id: c.id,
    lockId: c.lockId,
    lockName: c.lock.name,
    unitId: c.unitId,
    unitNo: c.unit?.unitNo ?? null,
    holderKind: c.holderKind as AccessHolderKindName,
    holderPartyId: c.holderPartyId,
    holderUserId: c.holderUserId,
    holderName: c.holderName,
    leaseId: c.leaseId,
    workOrderId: c.workOrderId,
    type: c.type as CredentialTypeName,
    status: c.status as CredentialStatusName,
    validFrom: iso(c.validFrom),
    validTo: isoOrNull(c.validTo),
    vendorError: c.vendorError,
    revokedAt: isoOrNull(c.revokedAt),
    revokeReason: c.revokeReason,
    createdAt: iso(c.createdAt),
  };
}

const revealedDto = (c: RevealedCredential) => ({ ...credentialDto(c), pin: c.pin });

export function accessEventDto(e: AccessEvent): AccessEventDto {
  return {
    id: e.id,
    time: iso(e.time),
    lockId: e.lockId,
    unitId: e.unitId,
    result: e.result as AccessResultName,
    source: e.source as AccessSourceName,
    credentialId: e.credentialId,
  };
}

const LOCK_EXAMPLE = {
  id: FAKE.uuid,
  name: 'ประตูห้อง A-201',
  scope: 'unit',
  vendor: 'ttlock',
  vendorLockId: '8123456',
  buildingId: FAKE.buildingId,
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  deviceId: FAKE.uuid,
  serial: 'TTL-S31-0001',
  assetItemId: FAKE.uuid,
  batteryPct: 82,
  batteryLow: false,
  batteryCheckedAt: FAKE.dateTime,
  online: true,
  lastLogSyncAt: FAKE.dateTime,
  isActive: true,
  version: 1,
};

const CREDENTIAL_EXAMPLE = {
  id: FAKE.uuid,
  lockId: FAKE.uuid,
  lockName: 'ประตูห้อง A-201',
  unitId: FAKE.uuid,
  unitNo: FAKE.unitCode,
  holderKind: 'resident',
  holderPartyId: FAKE.uuid,
  holderUserId: null,
  holderName: FAKE.nameTh,
  leaseId: FAKE.uuid,
  workOrderId: null,
  type: 'pin',
  status: 'active',
  validFrom: FAKE.dateTime,
  validTo: null,
  vendorError: null,
  revokedAt: null,
  revokeReason: null,
  createdAt: FAKE.dateTime,
};

const EVENT_EXAMPLE = {
  id: FAKE.uuid,
  time: FAKE.dateTime,
  lockId: FAKE.uuid,
  unitId: FAKE.uuid,
  result: 'success',
  source: 'pin',
  credentialId: FAKE.uuid,
};

function range(q: AccessEventQuery, now: Date) {
  return {
    from: q.from ? new Date(q.from) : new Date(now.getTime() - 30 * DAY),
    to: q.to ? new Date(q.to) : new Date(now.getTime() + 1000),
    take: q.limit ?? 100,
  };
}

/**
 * Locks and access of the owner console (`/v1/owner/locks`, `/v1/owner/access-credentials`; B5.2, D-070, D-071):
 * register locks of units and building doors, see their credentials and battery, issue time-boxed visitor and staff
 * codes, revoke a credential with a reason, read the unlock log (audited, D-025). No action here depends on what a
 * resident owes (D-024, D-071).
 */
@ApiTags('owner.access')
@ApiSurface(SURFACES.owner)
@Controller('owner')
export class OwnerAccessController {
  constructor(
    private readonly locks: LocksService,
    private readonly credentials: AccessCredentialsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('locks')
  @TenantScoped()
  @Can('access.read')
  @ApiEndpoint({
    id: 'owner.access.locks',
    summary: 'Locks',
    description:
      'Locks of units, building doors and common areas of my buildings with battery and sync state.',
    implements: ['D-070'],
  })
  @ApiSuccess(200, { description: 'Locks', type: LocksDto, example: { data: [LOCK_EXAMPLE] } })
  @ApiStandardErrors('validation.failed', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: LockQuery): Promise<LocksDto> {
    return { data: (await this.locks.list(ctx, q)).map((l) => lockDto(l)) };
  }

  @Post('locks')
  @TenantScoped()
  @Can('access.manage')
  @ApiEndpoint({
    id: 'owner.access.registerLock',
    summary: 'Register a lock',
    description:
      'A TTLock / Tuya lock of a unit, a building door or a common area: becomes an asset item (category lock) and a device (kind lock). A unit lock on a leased unit (or a building door) gives the current residents their codes at once — access follows the lease (D-071). Real vendor calls need `locks.vendor.<vendor>` for the tenant.',
    implements: ['D-070', 'D-071'],
  })
  @ApiJsonBody(LockRegisterDto, {
    scope: 'unit',
    unitId: FAKE.uuid,
    vendor: 'ttlock',
    vendorLockId: '8123456',
    serial: 'TTL-S31-0001',
    name: 'ประตูห้อง A-201',
  })
  @ApiSuccess(201, { description: 'Registered', type: LockDto, example: LOCK_EXAMPLE })
  @ApiStandardErrors(...WRITE, 'lock.exists')
  async register(@CurrentTenant() ctx: TenantContext, @Body() body: LockRegisterDto): Promise<LockDto> {
    return lockDto(await this.locks.register(ctx, body));
  }

  @Get('locks/:lockId')
  @TenantScoped()
  @Can('access.read')
  @UseEtag((l: LockDto) => etagOf(l.id, l.version))
  @ApiEndpoint({
    id: 'owner.access.lock',
    summary: 'One lock',
    description: 'Place, vendor, battery and the last log sync.',
    implements: ['D-070'],
  })
  @ApiSuccess(200, { description: 'The lock', type: LockDto, example: LOCK_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('lockId', ParseUUIDPipe) id: string,
  ): Promise<LockDto> {
    return lockDto(await this.locks.get(ctx, id));
  }

  @Patch('locks/:lockId')
  @TenantScoped()
  @Can('access.manage')
  @ApiEndpoint({
    id: 'owner.access.setLockActive',
    summary: 'Take a lock out of service (or back)',
    description: 'An inactive lock gets no new codes and is not synced; existing codes are not touched.',
    implements: ['D-070'],
  })
  @ApiJsonBody(LockActiveDto, { isActive: false })
  @ApiSuccess(200, { description: 'Changed', type: LockDto, example: { ...LOCK_EXAMPLE, isActive: false } })
  @ApiStandardErrors(...WRITE)
  async setActive(
    @CurrentTenant() ctx: TenantContext,
    @Param('lockId', ParseUUIDPipe) id: string,
    @Body() body: LockActiveDto,
  ): Promise<LockDto> {
    return lockDto(await this.locks.setActive(ctx, id, body.isActive));
  }

  @Post('locks/:lockId/actions/refresh')
  @HttpCode(200)
  @TenantScoped()
  @Can('access.read')
  @ApiEndpoint({
    id: 'owner.access.refreshLock',
    summary: 'Refresh battery and unlock log now',
    description:
      'Reads the battery (a low battery opens one automatic repair request, D-034) and the unlock log from the vendor (the worker does it hourly).',
    implements: ['D-070', 'D-034'],
  })
  @ApiSuccess(200, { description: 'Refreshed', type: LockDto, example: LOCK_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async refresh(
    @CurrentTenant() ctx: TenantContext,
    @Param('lockId', ParseUUIDPipe) id: string,
  ): Promise<LockDto> {
    const lock = await this.locks.get(ctx, id);
    await this.locks.refreshStatus(lock.id);
    await this.locks.syncLog(lock.id);
    return lockDto(await this.locks.get(ctx, id));
  }

  @Get('locks/:lockId/credentials')
  @TenantScoped()
  @Can('access.read')
  @ApiEndpoint({
    id: 'owner.access.credentials',
    summary: 'Credentials of a lock',
    description:
      'Residents (lease), staff, technicians (work order) and visitors, newest first; codes are not shown.',
    implements: ['D-070', 'D-071'],
  })
  @ApiSuccess(200, {
    description: 'Credentials',
    type: CredentialsDto,
    example: { data: [CREDENTIAL_EXAMPLE] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async credentialsOf(
    @CurrentTenant() ctx: TenantContext,
    @Param('lockId', ParseUUIDPipe) id: string,
    @Query() q: CredentialListQuery,
  ): Promise<CredentialsDto> {
    return { data: (await this.locks.credentialsOf(ctx, id, q.live === true)).map(credentialDto) };
  }

  @Post('locks/:lockId/visitor-codes')
  @TenantScoped()
  @Can('access.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.access.visitorCode',
    summary: 'Issue a visitor code',
    description:
      'A time-boxed keypad code (≤ 31 days) for a named visitor; the code is answered this once (give it to the visitor), then lives at the vendor until it ends.',
    implements: ['D-070'],
  })
  @ApiJsonBody(VisitorCodeCreateDto, {
    visitorName: 'คุณผู้มาเยือน ทดสอบ',
    validFrom: FAKE.dateTime,
    validTo: '2026-11-01T18:00:00+07:00',
  })
  @ApiSuccess(201, {
    description: 'Issued',
    type: IssuedCredentialDto,
    example: {
      ...CREDENTIAL_EXAMPLE,
      holderKind: 'visitor',
      holderPartyId: null,
      leaseId: null,
      status: 'pending',
      validTo: '2026-11-01T18:00:00+07:00',
      pin: '482913',
    },
  })
  @ApiStandardErrors(...WRITE, 'access.invalid_state')
  async visitorCode(
    @CurrentTenant() ctx: TenantContext,
    @Param('lockId', ParseUUIDPipe) id: string,
    @Body() body: VisitorCodeCreateDto,
  ): Promise<IssuedCredentialDto> {
    const c = await this.locks.issueCode(ctx, id, {
      kind: 'visitor',
      name: body.visitorName,
      validFrom: new Date(body.validFrom),
      validTo: new Date(body.validTo),
    });
    return { ...credentialDto(c), pin: c.pin };
  }

  @Post('locks/:lockId/staff-codes')
  @TenantScoped()
  @Can('access.manage')
  @Idempotent()
  @ApiEndpoint({
    id: 'owner.access.staffCode',
    summary: 'Issue a staff code',
    description:
      'A time-boxed code (≤ 31 days) for a member of the tenant outside a work order (work orders issue their own codes for the visit window).',
    implements: ['D-070'],
  })
  @ApiJsonBody(StaffCodeCreateDto, {
    userId: FAKE.uuid,
    validFrom: FAKE.dateTime,
    validTo: '2026-11-01T18:00:00+07:00',
  })
  @ApiSuccess(201, {
    description: 'Issued',
    type: IssuedCredentialDto,
    example: {
      ...CREDENTIAL_EXAMPLE,
      holderKind: 'staff',
      holderPartyId: null,
      holderUserId: FAKE.uuid,
      leaseId: null,
      status: 'pending',
      validTo: '2026-11-01T18:00:00+07:00',
      pin: '482913',
    },
  })
  @ApiStandardErrors(...WRITE, 'access.invalid_state')
  async staffCode(
    @CurrentTenant() ctx: TenantContext,
    @Param('lockId', ParseUUIDPipe) id: string,
    @Body() body: StaffCodeCreateDto,
  ): Promise<IssuedCredentialDto> {
    const c = await this.locks.issueCode(ctx, id, {
      kind: 'staff',
      userId: body.userId,
      validFrom: new Date(body.validFrom),
      validTo: new Date(body.validTo),
    });
    return { ...credentialDto(c), pin: c.pin };
  }

  @Post('access-credentials/:credentialId/actions/revoke')
  @HttpCode(200)
  @TenantScoped()
  @Can('access.manage')
  @ApiEndpoint({
    id: 'owner.access.revoke',
    summary: 'Revoke a credential',
    description:
      'With a reason (required, audited); a resident whose code is revoked is told on LINE with the reason. Never for arrears: residents keep access for the lease (D-024, D-071).',
    implements: ['D-071', 'D-024'],
  })
  @ApiJsonBody(ReasonDto, { reason: 'กุญแจหาย ออกรหัสใหม่ให้แล้ว' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: CredentialDto,
    example: { ...CREDENTIAL_EXAMPLE, status: 'revoked', revokedAt: FAKE.dateTime, revokeReason: 'กุญแจหาย' },
  })
  @ApiStandardErrors(...WRITE, 'access.invalid_state')
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('credentialId', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<CredentialDto> {
    return credentialDto(await this.credentials.revoke(ctx, id, body.reason));
  }

  @Get('locks/:lockId/events')
  @TenantScoped()
  @Can('access.read')
  @ApiEndpoint({
    id: 'owner.access.events',
    summary: 'Unlock log of a lock',
    description: 'Who opened when, newest first (default the last 30 days); each read is audited (D-025).',
    implements: ['D-070', 'D-025'],
  })
  @ApiSuccess(200, { description: 'Events', type: AccessEventsDto, example: { data: [EVENT_EXAMPLE] } })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async events(
    @CurrentTenant() ctx: TenantContext,
    @Param('lockId', ParseUUIDPipe) id: string,
    @Query() q: AccessEventQuery,
  ): Promise<AccessEventsDto> {
    return { data: (await this.locks.eventsOf(ctx, id, range(q, this.clock.now()))).map(accessEventDto) };
  }
}

/** The resident's own door codes and their unit's unlock log in the LIFF (`/v1/resident/access/*`, D-070, D-025). */
@ApiTags('resident.access')
@ApiSurface(SURFACES.resident)
@Controller('resident/access')
export class ResidentAccessController {
  constructor(
    private readonly views: AccessViewsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('credentials')
  @ApiEndpoint({
    id: 'resident.access.credentials',
    summary: 'My door codes',
    description:
      'The codes of my unit’s locks and building doors for my leases, with the code itself (each reveal is audited); they last until the lease ends (D-071).',
    implements: ['D-070', 'D-071'],
  })
  @ApiSuccess(200, {
    description: 'My codes',
    type: RevealedCredentialsDto,
    example: { data: [{ ...CREDENTIAL_EXAMPLE, pin: '482913' }] },
  })
  @ApiStandardErrors('validation.failed')
  async credentials(): Promise<RevealedCredentialsDto> {
    return { data: (await this.views.residentCredentials()).map(revealedDto) };
  }

  @Get('events')
  @ApiEndpoint({
    id: 'resident.access.events',
    summary: 'My unit’s unlock log',
    description:
      'Unlocks of my unit’s locks and the building-door unlocks made with my own codes — never another unit’s (D-025); 404 for a unit I do not occupy.',
    implements: ['D-070', 'D-025'],
  })
  @ApiSuccess(200, { description: 'Events', type: AccessEventsDto, example: { data: [EVENT_EXAMPLE] } })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async events(@Query() q: ResidentAccessEventQuery): Promise<AccessEventsDto> {
    return {
      data: (await this.views.residentEvents(q.unitId, range(q, this.clock.now()))).map(accessEventDto),
    };
  }
}

/** The technician's door codes of a work order (`/v1/technician/work-orders/{id}/access`, D-070). */
@ApiTags('technician.workOrders')
@ApiSurface(SURFACES.technician)
@Controller('technician/work-orders')
export class TechnicianAccessController {
  constructor(private readonly views: AccessViewsService) {}

  @Get(':workOrderId/access')
  @ApiEndpoint({
    id: 'technician.workOrders.access',
    summary: 'Door codes of my work order',
    description:
      'The time-boxed codes of the unit and building doors for the visit window (created at assignment, ended with the work order); each reveal is audited.',
    implements: ['D-070'],
  })
  @ApiSuccess(200, {
    description: 'Codes',
    type: RevealedCredentialsDto,
    example: {
      data: [
        {
          ...CREDENTIAL_EXAMPLE,
          holderKind: 'technician',
          leaseId: null,
          workOrderId: FAKE.uuid,
          validTo: '2026-11-01T12:00:00+07:00',
          pin: '482913',
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed')
  async access(@Param('workOrderId', ParseUUIDPipe) id: string): Promise<RevealedCredentialsDto> {
    return { data: (await this.views.technicianCodes(id)).map(revealedDto) };
  }
}

/** The staff member's door codes of a work order assigned to them (`/v1/staff/work-orders/{id}/access`). */
@ApiTags('staff.workOrders')
@ApiSurface(SURFACES.staff)
@Controller('staff/work-orders')
export class StaffAccessController {
  constructor(private readonly views: AccessViewsService) {}

  @Get(':workOrderId/access')
  @TenantScoped()
  @Can('service_request.handle')
  @ApiEndpoint({
    id: 'staff.workOrders.access',
    summary: 'My door codes of a work order',
    description: 'The time-boxed codes issued to me for the visit window; each reveal is audited.',
    implements: ['D-070'],
  })
  @ApiSuccess(200, {
    description: 'Codes',
    type: RevealedCredentialsDto,
    example: {
      data: [
        {
          ...CREDENTIAL_EXAMPLE,
          holderKind: 'staff',
          holderPartyId: null,
          holderUserId: FAKE.uuid,
          leaseId: null,
          workOrderId: FAKE.uuid,
          validTo: '2026-11-01T12:00:00+07:00',
          pin: '482913',
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async access(
    @CurrentTenant() ctx: TenantContext,
    @Param('workOrderId', ParseUUIDPipe) id: string,
  ): Promise<RevealedCredentialsDto> {
    return { data: (await this.views.staffCodes(ctx, id)).map(revealedDto) };
  }
}

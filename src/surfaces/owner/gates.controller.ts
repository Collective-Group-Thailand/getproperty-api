import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { GateAdminService } from '@modules/smart-gate/gate-admin.service';
import { GateHardwareService } from '@modules/smart-gate/gate-hardware.service';
import { IncidentsService } from '@modules/smart-gate/incidents.service';
import { VisitsService } from '@modules/smart-gate/visits.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  BlacklistCreateDto,
  BlacklistDto,
  BlacklistQuery,
  BlacklistRevokeDto,
  GateCreateDto,
  GateDeviceCreatedDto,
  GateDeviceCreateDto,
  GateDeviceDto,
  type GateDeviceKindName,
  type GateDeviceStateName,
  GateDto,
  GateGuardDto,
  type GateGuardStateName,
  GateKindName,
  GateListQuery,
  GatePolicyActionName,
  type GateStateName,
  GateUpdateDto,
  GUARD_VISIT_EXAMPLE,
  GuardCreateDto,
  GuardPinDto,
  GuardUpdateDto,
  GuardVisitDto,
  HousePolicyDto,
  HousePolicyUpdateDto,
  INVITE_EXAMPLE,
  InviteDecisionDto,
  InviteListQuery,
  PLATE_EXAMPLE,
  POLICY_EXAMPLE,
  RevokeReasonDto,
  VisitActorKindName,
  VisitInviteDto,
  VisitInviteStateName,
  VisitLogDetailDto,
  VisitLogQuery,
  VisitLogReasonQuery,
} from '../shared/gate.dto';
import {
  blacklistDto,
  deviceDto,
  gateDto,
  guardDto,
  guardVisitDto,
  inviteDto,
  policyDto,
  visitEventDto,
} from '../shared/gate.mappers';
import {
  EdgeDeviceAttachDto,
  GateHardwareKindName,
  INCIDENT_EXAMPLE,
  IncidentDecisionDto,
  IncidentDetailDto,
  IncidentDto,
  IncidentEventKindName,
  IncidentLogQuery,
  IncidentReasonQuery,
  IncidentStateName,
  OwnerVehicleQuery,
  RESIDENT_VEHICLE_EXAMPLE,
  ResidentVehicleDto,
} from '../shared/gate-hardware.dto';
import {
  incidentDto,
  incidentEventDto,
  incidentVisitDto,
  residentVehicleDto,
} from '../shared/gate-hardware.mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;

const GATE_EXAMPLE: GateDto = {
  id: FAKE.uuid,
  propertyId: FAKE.propertyId,
  name: 'ป้อมหน้า',
  kind: GateKindName.Main,
  state: 'active' as GateStateName,
  barrier: false,
  lpr: false,
  devices: 1,
  createdAt: FAKE.dateTime,
};
const DEVICE_EXAMPLE: GateDeviceDto = {
  id: FAKE.uuid,
  gateId: FAKE.uuid,
  kind: 'guard_tablet' as GateDeviceKindName,
  name: 'แท็บเล็ตป้อมหน้า',
  state: 'pending' as GateDeviceStateName,
  enrolExpiresAt: '2026-11-06T18:00:00+07:00',
  enrolledAt: null,
  lastSeenAt: null,
  revokedAt: null,
  edgeDeviceId: null,
  channel: null,
  pulseMs: null,
  hwState: null,
  hwStateAt: null,
};
const GUARD_EXAMPLE: GateGuardDto = {
  id: FAKE.uuid,
  propertyId: FAKE.propertyId,
  displayName: 'สมศักดิ์',
  state: 'active' as GateGuardStateName,
  pinSetAt: FAKE.dateTime,
  lockedUntil: null,
  onShiftAtGateId: null,
  createdAt: FAKE.dateTime,
};
const BLACKLIST_EXAMPLE: BlacklistDto = {
  id: FAKE.uuid,
  propertyId: FAKE.propertyId,
  plate: PLATE_EXAMPLE,
  reason: 'ขับรถเร็วในหมู่บ้านซ้ำหลายครั้ง (มติกรรมการ 3/2569)',
  createdAt: FAKE.dateTime,
  revokedAt: null,
};

/** `/v1/owner/gates*` (J4.1, D-315, D-320, D-327): gates of the tenant's properties and their tablets. */
@ApiTags('owner.gates')
@ApiSurface(SURFACES.owner)
@Controller('owner/gates')
export class OwnerGatesController {
  constructor(
    private readonly gates: GateAdminService,
    private readonly hardware: GateHardwareService,
  ) {}

  @Post()
  @Idempotent({ optional: true })
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gates.create',
    summary: 'Create a gate',
    description:
      'A gate (guard post) of one of the tenant’s properties; names are unique per property (409) (D-315, D-327).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(GateCreateDto, { propertyId: FAKE.propertyId, name: 'ป้อมหน้า', kind: GateKindName.Main })
  @ApiSuccess(201, { description: 'Created', type: GateDto, example: { ...GATE_EXAMPLE, devices: 0 } })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'http.conflict', 'auth.forbidden', ...T)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: GateCreateDto): Promise<GateDto> {
    return gateDto(await this.gates.createGate(ctx, body));
  }

  @Get()
  @TenantScoped()
  @Can('gate.read')
  @ApiEndpoint({
    id: 'owner.gates.list',
    summary: 'Gates',
    description: 'The tenant’s gates (optionally of one property) with the count of live tablets (D-327).',
    implements: ['D-327'],
  })
  @ApiSuccess(200, { description: 'Gates', type: [GateDto], example: [GATE_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'auth.forbidden', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: GateListQuery): Promise<GateDto[]> {
    return (await this.gates.listGates(ctx, q.propertyId)).map(gateDto);
  }

  @Get(':gateId')
  @TenantScoped()
  @Can('gate.read')
  @ApiEndpoint({
    id: 'owner.gates.get',
    summary: 'A gate',
    description: 'One gate; another tenant’s gate is a 404 (D-327).',
    implements: ['D-327'],
  })
  @ApiSuccess(200, { description: 'Gate', type: GateDto, example: GATE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('gateId', ParseUUIDPipe) id: string,
  ): Promise<GateDto> {
    return gateDto(await this.gates.getGate(ctx, id));
  }

  @Patch(':gateId')
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gates.update',
    summary: 'Edit a gate',
    description:
      'Rename, change the kind, switch off (`inactive`: its tablets refuse new visits) or mark barrier / LPR wiring for J4.2 (D-327).',
    implements: ['D-327'],
  })
  @ApiJsonBody(GateUpdateDto, { name: 'ป้อมหน้า (ฝั่งถนนใหญ่)' })
  @ApiSuccess(200, { description: 'Updated', type: GateDto, example: GATE_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'http.conflict', 'auth.forbidden', ...T)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('gateId', ParseUUIDPipe) id: string,
    @Body() body: GateUpdateDto,
  ): Promise<GateDto> {
    return gateDto(await this.gates.updateGate(ctx, id, body));
  }

  @Post(':gateId/devices')
  @Idempotent()
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gates.addDevice',
    summary: 'Add a gate tablet',
    description:
      'Creates a tablet slot and a one-time enrolment code (shown once, valid `gate.device_enrol_hours`, stored hashed). The tablet enters it in `POST /v1/auth/guard/devices/enrol` (D-320, D-327).',
    implements: ['D-320', 'D-327'],
  })
  @ApiJsonBody(GateDeviceCreateDto, { name: 'แท็บเล็ตป้อมหน้า' })
  @ApiSuccess(201, {
    description: 'Created',
    type: GateDeviceCreatedDto,
    example: { ...DEVICE_EXAMPLE, enrolCode: 'ABCD-EFGH-JKLM' },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async addDevice(
    @CurrentTenant() ctx: TenantContext,
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Body() body: GateDeviceCreateDto,
  ): Promise<GateDeviceCreatedDto> {
    const r = await this.gates.addDevice(ctx, gateId, body.name);
    return { ...deviceDto(r.device), enrolCode: r.enrolCode };
  }

  @Get(':gateId/devices')
  @TenantScoped()
  @Can('gate.read')
  @ApiEndpoint({
    id: 'owner.gates.devices',
    summary: 'Tablets of a gate',
    description:
      'Pending, active and revoked tablets of the gate (codes and secrets are never shown again) (D-327).',
    implements: ['D-327'],
  })
  @ApiSuccess(200, { description: 'Tablets', type: [GateDeviceDto], example: [DEVICE_EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async devices(
    @CurrentTenant() ctx: TenantContext,
    @Param('gateId', ParseUUIDPipe) gateId: string,
  ): Promise<GateDeviceDto[]> {
    return (await this.gates.listDevices(ctx, gateId)).map(deviceDto);
  }

  @Post(':gateId/devices/:deviceId/actions/revoke')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gates.revokeDevice',
    summary: 'Revoke a gate tablet',
    description:
      'The tablet stops working at once: its open guard shifts end and their sessions are revoked; it needs a new enrolment code. Idempotent (D-320, D-327).',
    implements: ['D-320', 'D-327'],
  })
  @ApiJsonBody(RevokeReasonDto, { reason: 'แท็บเล็ตหาย' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: GateDeviceDto,
    example: { ...DEVICE_EXAMPLE, state: 'revoked' as GateDeviceStateName },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async revokeDevice(
    @CurrentTenant() ctx: TenantContext,
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Body() body: RevokeReasonDto,
  ): Promise<GateDeviceDto> {
    return deviceDto(await this.gates.revokeDevice(ctx, gateId, deviceId, body.reason));
  }
  @Post(':gateId/edge-devices')
  @Idempotent()
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gates.attachEdgeDevice',
    summary: 'Attach a barrier or LPR camera',
    description:
      'A barrier relay or an LPR camera on a getproperty-edge gateway (a provisioned gateway of a building of this estate, same tenant — else 422 `gate.edge_device_invalid`) and its channel there (409 when another live device uses it). Active at once; the gate’s `barrier` / `lpr` flags follow; the gateway config (`gateDevices`, protocol 1.3) is recompiled and published (D-316, D-328).',
    implements: ['D-316', 'D-328'],
  })
  @ApiJsonBody(EdgeDeviceAttachDto, {
    kind: GateHardwareKindName.Barrier,
    name: 'ไม้กั้นขาเข้า',
    edgeDeviceId: FAKE.uuid,
    channel: 'relay-1',
    pulseMs: 800,
  })
  @ApiSuccess(201, {
    description: 'Attached',
    type: GateDeviceDto,
    example: {
      ...DEVICE_EXAMPLE,
      kind: 'barrier' as GateDeviceKindName,
      name: 'ไม้กั้นขาเข้า',
      state: 'active' as GateDeviceStateName,
      enrolExpiresAt: null,
      enrolledAt: FAKE.dateTime,
      edgeDeviceId: FAKE.uuid,
      channel: 'relay-1',
      pulseMs: 800,
    },
  })
  @ApiStandardErrors(
    'http.not_found',
    'validation.failed',
    'auth.forbidden',
    'gate.edge_device_invalid',
    'gate.channel_taken',
    ...T,
  )
  async attachEdgeDevice(
    @CurrentTenant() ctx: TenantContext,
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Body() body: EdgeDeviceAttachDto,
  ): Promise<GateDeviceDto> {
    return deviceDto(await this.hardware.attach(ctx, gateId, body));
  }

  @Post(':gateId/edge-devices/:gateDeviceId/actions/detach')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gates.detachEdgeDevice',
    summary: 'Detach a barrier or LPR camera',
    description:
      'The device stops at once (no more `gate.open` to it, its events are refused); the gateway config drops it. Idempotent (D-328).',
    implements: ['D-328'],
  })
  @ApiJsonBody(RevokeReasonDto, { reason: 'เปลี่ยนชุดไม้กั้นใหม่' })
  @ApiSuccess(200, {
    description: 'Detached',
    type: GateDeviceDto,
    example: {
      ...DEVICE_EXAMPLE,
      kind: 'barrier' as GateDeviceKindName,
      state: 'revoked' as GateDeviceStateName,
      revokedAt: FAKE.dateTime,
      edgeDeviceId: FAKE.uuid,
      channel: 'relay-1',
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async detachEdgeDevice(
    @CurrentTenant() ctx: TenantContext,
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Param('gateDeviceId', ParseUUIDPipe) gateDeviceId: string,
    @Body() body: RevokeReasonDto,
  ): Promise<GateDeviceDto> {
    return deviceDto(await this.hardware.detach(ctx, gateId, gateDeviceId, body.reason));
  }
}

/** `/v1/owner/gate-guards*` (D-320): guards of the tenant's properties and their PINs. */
@ApiTags('owner.gates')
@ApiSurface(SURFACES.owner)
@Controller('owner/gate-guards')
export class OwnerGateGuardsController {
  constructor(private readonly gates: GateAdminService) {}

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('gate.guard.manage')
  @ApiEndpoint({
    id: 'owner.gateGuards.create',
    summary: 'Create a guard',
    description:
      'A guard of a property with a PIN (4–6 digits, stored as argon2id; tell it to the guard in person). The guard signs in only on an enrolled gate tablet of that property — a credential-less login with tenant role `guard`, never invitable (D-320, D-327).',
    implements: ['D-320', 'D-327'],
  })
  @ApiJsonBody(GuardCreateDto, { propertyId: FAKE.propertyId, displayName: 'สมศักดิ์', pin: '482913' })
  @ApiSuccess(201, { description: 'Created', type: GateGuardDto, example: GUARD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: GuardCreateDto): Promise<GateGuardDto> {
    return guardDto(await this.gates.createGuard(ctx, body));
  }

  @Get()
  @TenantScoped()
  @Can('gate.read')
  @ApiEndpoint({
    id: 'owner.gateGuards.list',
    summary: 'Guards',
    description:
      'Active and revoked guards (optionally of one property), the gate of an open shift and a lockout (D-320).',
    implements: ['D-320', 'D-327'],
  })
  @ApiSuccess(200, { description: 'Guards', type: [GateGuardDto], example: [GUARD_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'auth.forbidden', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: GateListQuery): Promise<GateGuardDto[]> {
    return (await this.gates.listGuards(ctx, q.propertyId)).map(guardDto);
  }

  @Patch(':guardId')
  @TenantScoped()
  @Can('gate.guard.manage')
  @ApiEndpoint({
    id: 'owner.gateGuards.update',
    summary: 'Rename a guard',
    description: 'Changes the display name shown on the tablet roster (D-320).',
    implements: ['D-320'],
  })
  @ApiJsonBody(GuardUpdateDto, { displayName: 'สมศักดิ์ (กะดึก)' })
  @ApiSuccess(200, { description: 'Updated', type: GateGuardDto, example: GUARD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'http.conflict', 'validation.failed', 'auth.forbidden', ...T)
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('guardId', ParseUUIDPipe) id: string,
    @Body() body: GuardUpdateDto,
  ): Promise<GateGuardDto> {
    return guardDto(
      await this.gates.updateGuard(ctx, id, {
        ...(body.displayName ? { displayName: body.displayName } : {}),
      }),
    );
  }

  @Post(':guardId/actions/reset-pin')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('gate.guard.manage')
  @ApiEndpoint({
    id: 'owner.gateGuards.resetPin',
    summary: 'Set a new PIN',
    description: 'Replaces the guard’s PIN and lifts a lockout (audited without the PIN) (D-320, D-327).',
    implements: ['D-320', 'D-327'],
  })
  @ApiJsonBody(GuardPinDto, { pin: '730154' })
  @ApiSuccess(200, { description: 'PIN set', type: GateGuardDto, example: GUARD_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'http.conflict', 'validation.failed', 'auth.forbidden', ...T)
  async resetPin(
    @CurrentTenant() ctx: TenantContext,
    @Param('guardId', ParseUUIDPipe) id: string,
    @Body() body: GuardPinDto,
  ): Promise<GateGuardDto> {
    return guardDto(await this.gates.updateGuard(ctx, id, { pin: body.pin }));
  }

  @Post(':guardId/actions/revoke')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('gate.guard.manage')
  @ApiEndpoint({
    id: 'owner.gateGuards.revoke',
    summary: 'Revoke a guard',
    description:
      'The guard can no longer sign in; an open shift ends and its session stops at once; the login is disabled. Idempotent (D-320).',
    implements: ['D-320', 'D-327'],
  })
  @ApiJsonBody(RevokeReasonDto, { reason: 'ลาออก' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: GateGuardDto,
    example: { ...GUARD_EXAMPLE, state: 'revoked' as GateGuardStateName },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('guardId', ParseUUIDPipe) id: string,
    @Body() body: RevokeReasonDto,
  ): Promise<GateGuardDto> {
    return guardDto(await this.gates.revokeGuard(ctx, id, body.reason));
  }
}

/** `/v1/owner/gate-policies/units/{unitId}` (D-315): what the gate does when a house does not answer. */
@ApiTags('owner.gates')
@ApiSurface(SURFACES.owner)
@Controller('owner/gate-policies/units/:unitId')
export class OwnerGatePoliciesController {
  constructor(private readonly gates: GateAdminService) {}

  @Get()
  @TenantScoped()
  @Can('gate.read')
  @ApiEndpoint({
    id: 'owner.gatePolicies.get',
    summary: 'House gate policy of a unit',
    description:
      'The unit’s own policy or the estate defaults (`gate.policy.timeout_seconds` 180, `gate.policy.action` guard_calls) (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, { description: 'Policy', type: HousePolicyDto, example: POLICY_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<HousePolicyDto> {
    return policyDto((await this.gates.unitPolicy(ctx, unitId)).policy);
  }

  @Put()
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gatePolicies.set',
    summary: 'Set the house gate policy of a unit',
    description:
      'Timeout 60–900 s; when nobody answers: `allow_and_log` (let in, the household sees the log), `deny`, or `guard_calls` (the guard phones the house); deliveries may skip the question (null = the estate drop-point setting); a household note for the guard. Audited (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(HousePolicyUpdateDto, { timeoutSeconds: 120, action: GatePolicyActionName.AllowAndLog })
  @ApiSuccess(200, {
    description: 'Policy',
    type: HousePolicyDto,
    example: { ...POLICY_EXAMPLE, custom: true },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async set(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: HousePolicyUpdateDto,
  ): Promise<HousePolicyDto> {
    return policyDto((await this.gates.setUnitPolicy(ctx, unitId, body)).policy);
  }
}

/** `/v1/owner/gate-blacklist*` (D-315): plates refused at the estate's gates. */
@ApiTags('owner.gates')
@ApiSurface(SURFACES.owner)
@Controller('owner/gate-blacklist')
export class OwnerGateBlacklistController {
  constructor(private readonly gates: GateAdminService) {}

  @Get()
  @TenantScoped()
  @Can('gate.read')
  @ApiEndpoint({
    id: 'owner.gateBlacklist.list',
    summary: 'Estate blacklist',
    description: 'Live entries (optionally of one property), newest first (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, { description: 'Entries', type: [BlacklistDto], example: [BLACKLIST_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'auth.forbidden', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: BlacklistQuery): Promise<BlacklistDto[]> {
    return (await this.gates.listBlacklist(ctx, q.propertyId)).map(blacklistDto);
  }

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gateBlacklist.add',
    summary: 'Add a plate to the blacklist',
    description:
      'Visits of this plate are refused at once at the property’s gates; the reason (5–500) is required and audited (409 `gate.blacklist_exists`) (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(BlacklistCreateDto, {
    propertyId: FAKE.propertyId,
    plate: PLATE_EXAMPLE,
    reason: 'ขับรถเร็วในหมู่บ้านซ้ำหลายครั้ง (มติกรรมการ 3/2569)',
  })
  @ApiSuccess(201, { description: 'Added', type: BlacklistDto, example: BLACKLIST_EXAMPLE })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'gate.blacklist_exists', 'auth.forbidden', ...T)
  async add(@CurrentTenant() ctx: TenantContext, @Body() body: BlacklistCreateDto): Promise<BlacklistDto> {
    return blacklistDto(await this.gates.addBlacklist(ctx, body));
  }

  @Post(':entryId/actions/revoke')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('gate.manage')
  @ApiEndpoint({
    id: 'owner.gateBlacklist.revoke',
    summary: 'Remove a plate from the blacklist',
    description:
      'With a reason (audited); the revoked entry is deleted by gate-retention after `gate.retention_days` (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(BlacklistRevokeDto, { reason: 'กรรมการยกเลิกตามคำร้อง' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: BlacklistDto,
    example: { ...BLACKLIST_EXAMPLE, revokedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('entryId', ParseUUIDPipe) id: string,
    @Body() body: BlacklistRevokeDto,
  ): Promise<BlacklistDto> {
    return blacklistDto(await this.gates.revokeBlacklist(ctx, id, body.reason));
  }
}

/** `/v1/owner/gate-invites*` (D-315): residents' invites; contractors wait for approval. */
@ApiTags('owner.gates')
@ApiSurface(SURFACES.owner)
@Controller('owner/gate-invites')
export class OwnerGateInvitesController {
  constructor(private readonly gates: GateAdminService) {}

  @Get()
  @TenantScoped()
  @Can('gate.read')
  @ApiEndpoint({
    id: 'owner.gateInvites.list',
    summary: 'Visitor invites',
    description:
      'Residents’ invites (no tokens), filter `state=pending_approval` for contractors waiting (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, { description: 'Invites', type: [VisitInviteDto], example: [INVITE_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'auth.forbidden', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: InviteListQuery): Promise<VisitInviteDto[]> {
    return (await this.gates.listInvites(ctx, q)).map(inviteDto);
  }

  @Post(':inviteId/actions/approve')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('gate.invite.approve')
  @ApiEndpoint({
    id: 'owner.gateInvites.approve',
    summary: 'Approve a contractor invite',
    description: 'The invite becomes active; the resident is told. Repeating it is harmless (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Approved',
    type: VisitInviteDto,
    example: { ...INVITE_EXAMPLE, visitorKind: 'contractor' },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'visit_invite.not_active', 'auth.forbidden', ...T)
  async approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('inviteId', ParseUUIDPipe) id: string,
  ): Promise<VisitInviteDto> {
    return inviteDto(await this.gates.decideInvite(ctx, id, 'approve'));
  }

  @Post(':inviteId/actions/reject')
  @HttpCode(200)
  @Idempotent()
  @TenantScoped()
  @Can('gate.invite.approve')
  @ApiEndpoint({
    id: 'owner.gateInvites.reject',
    summary: 'Reject a contractor invite',
    description: 'With a reason (3–500, shown to the resident); repeating it is harmless (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(InviteDecisionDto, { reason: 'ช่างไม่มีใบอนุญาตทำงานในหมู่บ้าน' })
  @ApiSuccess(200, {
    description: 'Rejected',
    type: VisitInviteDto,
    example: {
      ...INVITE_EXAMPLE,
      state: VisitInviteStateName.Rejected,
      rejectReason: 'ช่างไม่มีใบอนุญาตทำงานในหมู่บ้าน',
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'visit_invite.not_active', 'auth.forbidden', ...T)
  async reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('inviteId', ParseUUIDPipe) id: string,
    @Body() body: InviteDecisionDto,
  ): Promise<VisitInviteDto> {
    return inviteDto(await this.gates.decideInvite(ctx, id, 'reject', body.reason));
  }
}

/** `/v1/owner/gate-visits*` (D-315 PDPA): the visit log, readable only with a logged reason. */
@ApiTags('owner.gates')
@ApiSurface(SURFACES.owner)
@Controller('owner/gate-visits')
export class OwnerGateVisitsController {
  constructor(
    private readonly gates: GateAdminService,
    private readonly visits: VisitsService,
  ) {}

  @Get()
  @TenantScoped()
  @Can('gate.log.read')
  @ApiEndpoint({
    id: 'owner.gateVisits.list',
    summary: 'Visit log',
    description:
      'The estate’s visits (plate, name, ID last 4 digits) newest first, filtered by property, gate, unit, state and period. A `reason` (5–500) is required and every read is audited (`gate.visit_log_read`) — PDPA purpose limitation (D-315). Staff limited to buildings see only visits to their buildings’ units.',
    implements: ['D-025', 'D-315', 'D-327'],
  })
  @ApiPaginated(GuardVisitDto, { example: { ...GUARD_VISIT_EXAMPLE, state: 'exited' } })
  @ApiStandardErrors('validation.failed', 'auth.forbidden', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: VisitLogQuery): Promise<Page<GuardVisitDto>> {
    const { rows, total } = await this.gates.visitLog(
      ctx,
      q.reason,
      q,
      toSkipTake(q).skip,
      toSkipTake(q).take,
    );
    const names = await this.visits.userNames(rows);
    return paginated(
      rows.map((v) => guardVisitDto(v, names)),
      total,
      q,
    );
  }

  @Get(':visitId')
  @TenantScoped()
  @Can('gate.log.read')
  @ApiEndpoint({
    id: 'owner.gateVisits.get',
    summary: 'A visit of the log',
    description: 'One visit with its timeline; `reason` required and audited (D-315).',
    implements: ['D-025', 'D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Visit',
    type: VisitLogDetailDto,
    example: { ...GUARD_VISIT_EXAMPLE, events: [] },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('visitId', ParseUUIDPipe) id: string,
    @Query() q: VisitLogReasonQuery,
  ): Promise<VisitLogDetailDto> {
    const r = await this.gates.visitLogGet(ctx, id, q.reason);
    return {
      ...guardVisitDto(r.visit, await this.visits.userNames([r.visit])),
      events: r.events.map(visitEventDto),
    };
  }
}

/** `/v1/owner/incidents*` (J4.2, D-317, D-328): the SOS / incident log — every read needs a reason (audited). */
@ApiTags('owner.gates')
@ApiSurface(SURFACES.owner)
@Controller('owner/incidents')
export class OwnerIncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @TenantScoped()
  @Can('gate.incident.read')
  @ApiEndpoint({
    id: 'owner.incidents.list',
    summary: 'Incident log',
    description:
      'SOS and incidents of the tenant’s estates, newest first, by property, state and period. `reason` (5–500) is required; every read writes one `gate.incident_log_read` audit row (PDPA, like the visit log) (D-317, D-328).',
    implements: ['D-317', 'D-328'],
  })
  @ApiPaginated(IncidentDto, { example: INCIDENT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'auth.forbidden', ...T)
  async list(@CurrentTenant() ctx: TenantContext, @Query() q: IncidentLogQuery): Promise<Page<IncidentDto>> {
    const { skip, take } = toSkipTake(q);
    const r = await this.incidents.log(ctx, q, skip, take);
    return paginated(r.rows.map(incidentDto), r.total, q);
  }

  @Get(':incidentId')
  @TenantScoped()
  @Can('gate.incident.read')
  @ApiEndpoint({
    id: 'owner.incidents.get',
    summary: 'An incident',
    description:
      'The incident, its timeline (raised, acknowledged, resolved, cancelled) and the visits inside the estate at that time (entered and not exited before the SOS − `gate.incident.visit_window_minutes`). `reason` required, audited (D-317, D-328).',
    implements: ['D-317', 'D-328'],
  })
  @ApiSuccess(200, {
    description: 'Incident',
    type: IncidentDetailDto,
    example: {
      ...INCIDENT_EXAMPLE,
      events: [
        {
          id: FAKE.uuid,
          kind: IncidentEventKindName.Raised,
          actorKind: VisitActorKindName.Resident,
          occurredAt: FAKE.dateTime,
        },
      ],
      visits: [],
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', ...T)
  async get(
    @CurrentTenant() ctx: TenantContext,
    @Param('incidentId', ParseUUIDPipe) id: string,
    @Query() q: IncidentReasonQuery,
  ): Promise<IncidentDetailDto> {
    const r = await this.incidents.logGet(ctx, id, q.reason);
    return {
      ...incidentDto(r.incident),
      events: r.events.map(incidentEventDto),
      visits: r.visits.map(incidentVisitDto),
    };
  }

  @Post(':incidentId/actions/acknowledge')
  @HttpCode(200)
  @TenantScoped()
  @Can('gate.incident.manage')
  @ApiEndpoint({
    id: 'owner.incidents.acknowledge',
    summary: 'Acknowledge an incident',
    description: 'The office has it: `open` → `acknowledged` (idempotent); the resident is told (D-317).',
    implements: ['D-317', 'D-328'],
  })
  @ApiJsonBody(IncidentDecisionDto, { note: 'ผู้จัดการรับเรื่องแล้ว' })
  @ApiSuccess(200, {
    description: 'Acknowledged',
    type: IncidentDto,
    example: { ...INCIDENT_EXAMPLE, state: IncidentStateName.Acknowledged, acknowledgedAt: FAKE.dateTime },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', 'incident.invalid_state', ...T)
  async acknowledge(
    @CurrentTenant() ctx: TenantContext,
    @Param('incidentId', ParseUUIDPipe) id: string,
    @Body() body: IncidentDecisionDto,
  ): Promise<IncidentDto> {
    return incidentDto(await this.incidents.operatorDecide(ctx, id, 'acknowledge', body.note));
  }

  @Post(':incidentId/actions/resolve')
  @HttpCode(200)
  @TenantScoped()
  @Can('gate.incident.manage')
  @ApiEndpoint({
    id: 'owner.incidents.resolve',
    summary: 'Resolve an incident',
    description:
      '`open` | `acknowledged` → `resolved` with an optional note (idempotent once resolved) (D-317).',
    implements: ['D-317', 'D-328'],
  })
  @ApiJsonBody(IncidentDecisionDto, { note: 'ตรวจสอบแล้ว ไม่มีผู้บาดเจ็บ' })
  @ApiSuccess(200, {
    description: 'Resolved',
    type: IncidentDto,
    example: {
      ...INCIDENT_EXAMPLE,
      state: IncidentStateName.Resolved,
      acknowledgedAt: FAKE.dateTime,
      resolvedAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('http.not_found', 'validation.failed', 'auth.forbidden', 'incident.invalid_state', ...T)
  async resolve(
    @CurrentTenant() ctx: TenantContext,
    @Param('incidentId', ParseUUIDPipe) id: string,
    @Body() body: IncidentDecisionDto,
  ): Promise<IncidentDto> {
    return incidentDto(await this.incidents.operatorDecide(ctx, id, 'resolve', body.note));
  }
}

/** `/v1/owner/gate-vehicles` (J4.2, D-328): the registered cars of the tenant's units. */
@ApiTags('owner.gates')
@ApiSurface(SURFACES.owner)
@Controller('owner/gate-vehicles')
export class OwnerGateVehiclesController {
  constructor(private readonly hardware: GateHardwareService) {}

  @Get()
  @TenantScoped()
  @Can('gate.read')
  @ApiEndpoint({
    id: 'owner.gateVehicles.list',
    summary: 'Registered cars',
    description:
      'Cars the households registered (LPR entry, resident open), optionally of one unit or property; residents add and remove them (D-328).',
    implements: ['D-328'],
  })
  @ApiSuccess(200, { description: 'Cars', type: [ResidentVehicleDto], example: [RESIDENT_VEHICLE_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'auth.forbidden', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: OwnerVehicleQuery,
  ): Promise<ResidentVehicleDto[]> {
    return (await this.hardware.ownerVehicles(ctx, q)).map(residentVehicleDto);
  }
}

import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ApiPaginated } from '@common/pagination/api-paginated.decorator';
import { paginated, toSkipTake } from '@common/pagination/pagination';
import { type Page } from '@common/pagination/pagination.dto';
import { GateAdminService } from '@modules/smart-gate/gate-admin.service';
import { VisitsService } from '@modules/smart-gate/visits.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  GateKindName,
  GatePolicyActionName,
  HousePolicyUpdateDto,
  INVITE_EXAMPLE,
  InviteVisitorKindName,
  NOTICE_EXAMPLE,
  PLATE_EXAMPLE,
  POLICY_EXAMPLE,
  RememberedVehicleCreateDto,
  RememberedVehicleDto,
  RememberedVehicleKindName,
  ResidentGateDto,
  ResidentVisitAnswerDto,
  ResidentVisitDto,
  ResidentVisitListQuery,
  VISIT_EXAMPLE,
  VisitAnswerResultDto,
  VisitDto,
  VisitInviteCreatedDto,
  VisitInviteCreateDto,
  VisitInviteDto,
  VisitInviteUsageName,
} from '../shared/gate.dto';
import { inviteDto, policyDto, vehicleDto, visitDto } from '../shared/gate.mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const RESIDENT_VISIT_EXAMPLE: ResidentVisitDto = {
  ...VISIT_EXAMPLE,
  decidedByName: null,
  policy: POLICY_EXAMPLE,
  photoUrl: null,
};
const VEHICLE_EXAMPLE: RememberedVehicleDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  kind: RememberedVehicleKindName.Visitor,
  plate: PLATE_EXAMPLE,
  label: 'รถพี่สาว',
  expiresAt: '2026-12-05T18:00:00+07:00',
};

/**
 * `/v1/resident/visits*` (J4.1, D-315): visits to the units I hold a role on today (co-owner, tenant, co-tenant,
 * family — payer-only gets none). The first answer of the household wins; another unit's visit is a 404.
 */
@ApiTags('resident.gate')
@ApiSurface(SURFACES.resident)
@Controller('resident/visits')
export class ResidentVisitsController {
  constructor(private readonly visits: VisitsService) {}

  private async view(id: string): Promise<ResidentVisitDto> {
    const r = await this.visits.residentGet(id);
    return {
      ...visitDto(r.visit),
      decidedByName: r.decidedByName,
      policy: policyDto(r.policy),
      photoUrl: await this.visits.photoLink(
        { tenantId: r.visit.tenantId, source: 'path' },
        r.visit.photoDocumentId,
      ),
    };
  }

  @Get()
  @ApiEndpoint({
    id: 'resident.visits.list',
    summary: 'Visits to my houses',
    description:
      'Newest first, of every unit I hold a gate role on (or one `unitId`), optionally by state (D-315, D-309).',
    implements: ['D-309', 'D-315', 'D-327'],
  })
  @ApiPaginated(VisitDto, { example: VISIT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async list(@Query() q: ResidentVisitListQuery): Promise<Page<VisitDto>> {
    const { skip, take } = toSkipTake(q);
    const { rows, total } = await this.visits.residentList({ unitId: q.unitId, state: q.state }, skip, take);
    return paginated(rows.map(visitDto), total, q);
  }

  @Get(':visitId')
  @ApiEndpoint({
    id: 'resident.visits.get',
    summary: 'A visit to my house',
    description:
      'The visit (plate, name, kind — never the ID digits), who of the household answered, what the house policy does if nobody answers, and a 5-minute link to the gate photo (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, { description: 'Visit', type: ResidentVisitDto, example: RESIDENT_VISIT_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  get(@Param('visitId', ParseUUIDPipe) id: string): Promise<ResidentVisitDto> {
    return this.view(id);
  }

  private async answer(id: string, answer: 'approve' | 'deny' | 'call_me', remember?: boolean) {
    const r = await this.visits.answer(id, answer, { rememberVehicle: remember ?? false });
    return { accepted: r.accepted, visit: await this.view(id) };
  }

  @Post(':visitId/actions/approve')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.visits.approve',
    summary: 'Let the visitor in',
    description:
      'First answer wins: when the visit still waits it becomes `approved` (the gate sees it at once); otherwise `accepted: false` and the visit shows who answered first. `rememberVehicle` remembers the car for `gate.remember_days` (30) — its next entries are notify-only (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(ResidentVisitAnswerDto, { rememberVehicle: false })
  @ApiSuccess(200, {
    description: 'Answered',
    type: VisitAnswerResultDto,
    example: { accepted: true, visit: { ...RESIDENT_VISIT_EXAMPLE, state: 'approved' } },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  approve(
    @Param('visitId', ParseUUIDPipe) id: string,
    @Body() body: ResidentVisitAnswerDto,
  ): Promise<VisitAnswerResultDto> {
    return this.answer(id, 'approve', body.rememberVehicle);
  }

  @Post(':visitId/actions/deny')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.visits.deny',
    summary: 'Do not let the visitor in',
    description: 'First answer wins (same rules as approve) (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Answered',
    type: VisitAnswerResultDto,
    example: { accepted: true, visit: { ...RESIDENT_VISIT_EXAMPLE, state: 'denied' } },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  deny(@Param('visitId', ParseUUIDPipe) id: string): Promise<VisitAnswerResultDto> {
    return this.answer(id, 'deny');
  }

  @Post(':visitId/actions/call-me')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.visits.callMe',
    summary: 'Ask the guard to call me',
    description:
      'The gate sees "call back" with my name; decides nothing (the visit keeps waiting). `accepted: false` once the visit is decided (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Answered',
    type: VisitAnswerResultDto,
    example: { accepted: true, visit: { ...RESIDENT_VISIT_EXAMPLE, callMeAt: FAKE.dateTime } },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  callMe(@Param('visitId', ParseUUIDPipe) id: string): Promise<VisitAnswerResultDto> {
    return this.answer(id, 'call_me');
  }

  @Post(':visitId/actions/exit')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.visits.exit',
    summary: 'My visitor has left',
    description: 'Exit stamp by the household (from `entered`); repeating it is harmless (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Exited',
    type: ResidentVisitDto,
    example: { ...RESIDENT_VISIT_EXAMPLE, state: 'exited' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'visit.invalid_state')
  async exit(@Param('visitId', ParseUUIDPipe) id: string): Promise<ResidentVisitDto> {
    await this.visits.residentExit(id);
    return this.view(id);
  }
}

/** `/v1/resident/units/{unitId}/gate*`, invites and remembered cars of my house (J4.1, D-315). */
@ApiTags('resident.gate')
@ApiSurface(SURFACES.resident)
@Controller('resident/units/:unitId')
export class ResidentUnitGateController {
  constructor(private readonly gates: GateAdminService) {}

  private gateView(r: Awaited<ReturnType<GateAdminService['residentGate']>>): ResidentGateDto {
    return {
      unitId: r.unit.id,
      unitNo: r.unit.unitNo,
      policy: policyDto(r.policy),
      canEdit: r.canEdit,
      gates: r.gates.map((g) => ({ id: g.id, name: g.name, kind: g.kind as GateKindName })),
      privacyNotice: r.notice,
      rememberDays: r.rememberDays,
      inviteMaxDays: r.inviteMaxDays,
    };
  }

  @Get('gate')
  @ApiEndpoint({
    id: 'resident.units.gate',
    summary: 'My house at the gate',
    description:
      'The house policy, the estate’s gates, the privacy notice and whether I may change the policy or create invites (co-owner, tenant, co-tenant) (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Gate view',
    type: ResidentGateDto,
    example: {
      unitId: FAKE.uuid,
      unitNo: '88/12',
      policy: POLICY_EXAMPLE,
      canEdit: true,
      gates: [{ id: FAKE.uuid, name: 'ป้อมหน้า', kind: GateKindName.Main }],
      privacyNotice: NOTICE_EXAMPLE,
      rememberDays: 30,
      inviteMaxDays: 30,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async gate(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<ResidentGateDto> {
    return this.gateView(await this.gates.residentGate(unitId));
  }

  @Put('gate-policy')
  @ApiEndpoint({
    id: 'resident.units.setGatePolicy',
    summary: 'Set my house gate policy',
    description:
      'Timeout 60–900 s and what the gate does when nobody answers (`allow_and_log`, `deny`, `guard_calls`), deliveries, a note for the guard — co-owner, tenant or co-tenant only (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(HousePolicyUpdateDto, { timeoutSeconds: 180, action: GatePolicyActionName.GuardCalls })
  @ApiSuccess(200, {
    description: 'Gate view',
    type: ResidentGateDto,
    example: {
      unitId: FAKE.uuid,
      unitNo: '88/12',
      policy: { ...POLICY_EXAMPLE, custom: true },
      canEdit: true,
      gates: [],
      privacyNotice: NOTICE_EXAMPLE,
      rememberDays: 30,
      inviteMaxDays: 30,
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async setPolicy(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: HousePolicyUpdateDto,
  ): Promise<ResidentGateDto> {
    return this.gateView(await this.gates.residentSetPolicy(unitId, body));
  }

  @Post('visit-invites')
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.units.createVisitInvite',
    summary: 'Invite a visitor',
    description:
      'A single- or multi-use invite with a time window (≤ `gate.invite_max_days`) and an optional plate; the QR token is returned once and stored hashed. At the gate the guard scans it and the visitor enters without waiting. Contractor invites wait for the office’s approval (`pending_approval`). Co-owner, tenant or co-tenant only (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(VisitInviteCreateDto, {
    usage: VisitInviteUsageName.Single,
    visitorKind: InviteVisitorKindName.Guest,
    validFrom: '2026-11-06T09:00:00+07:00',
    validTo: '2026-11-06T18:00:00+07:00',
    visitorName: 'คุณแม่',
  })
  @ApiSuccess(201, {
    description: 'Created; the token is shown once',
    type: VisitInviteCreatedDto,
    example: { ...INVITE_EXAMPLE, token: 'gpv1.Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'visit_invite.window_too_long')
  async createInvite(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: VisitInviteCreateDto,
  ): Promise<VisitInviteCreatedDto> {
    const r = await this.gates.createInvite(unitId, body);
    return { ...inviteDto(r.invite), token: r.token };
  }

  @Get('visit-invites')
  @ApiEndpoint({
    id: 'resident.units.visitInvites',
    summary: 'Invites of my house',
    description: 'Newest first, with uses and state (tokens are never shown again) (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, { description: 'Invites', type: [VisitInviteDto], example: [INVITE_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async invites(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<VisitInviteDto[]> {
    return (await this.gates.residentInvites(unitId)).map(inviteDto);
  }

  @Get('visit-invites/:inviteId')
  @ApiEndpoint({
    id: 'resident.units.visitInvite',
    summary: 'One invite of my house',
    description:
      'The invite with its uses and state (the token is never shown again). An invite of another unit — or a unit not mine — is a 404 (J-CR, D-335; D-315).',
    implements: ['D-315', 'D-335'],
  })
  @ApiSuccess(200, { description: 'Invite', type: VisitInviteDto, example: INVITE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async invite(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): Promise<VisitInviteDto> {
    return inviteDto(await this.gates.residentInvite(unitId, inviteId));
  }

  @Post('visit-invites/:inviteId/actions/revoke')
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.units.revokeVisitInvite',
    summary: 'Revoke an invite',
    description: 'The QR stops working at once; repeating it is harmless (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: VisitInviteDto,
    example: { ...INVITE_EXAMPLE, state: 'revoked' },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async revokeInvite(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): Promise<VisitInviteDto> {
    return inviteDto(await this.gates.revokeInvite(unitId, inviteId));
  }

  @Get('remembered-vehicles')
  @ApiEndpoint({
    id: 'resident.units.rememberedVehicles',
    summary: 'Cars my house remembers',
    description: 'Live "remember this car" entries; their entries at the gate are notify-only (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(200, { description: 'Vehicles', type: [RememberedVehicleDto], example: [VEHICLE_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async vehicles(@Param('unitId', ParseUUIDPipe) unitId: string): Promise<RememberedVehicleDto[]> {
    return (await this.gates.residentVehicles(unitId)).map(vehicleDto);
  }

  @Post('remembered-vehicles')
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.units.rememberVehicle',
    summary: 'Remember a car',
    description:
      'For at most `gate.remember_days` (30); the same plate extends the entry. Co-owner, tenant or co-tenant only (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiJsonBody(RememberedVehicleCreateDto, { plate: PLATE_EXAMPLE, label: 'รถพี่สาว' })
  @ApiSuccess(201, { description: 'Remembered', type: RememberedVehicleDto, example: VEHICLE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async remember(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: RememberedVehicleCreateDto,
  ): Promise<RememberedVehicleDto> {
    return vehicleDto(await this.gates.rememberVehicle(unitId, body));
  }

  @Delete('remembered-vehicles/:vehicleId')
  @HttpCode(204)
  @ApiEndpoint({
    id: 'resident.units.forgetVehicle',
    summary: 'Forget a car',
    description: 'The next visit of this car asks the house again (D-315).',
    implements: ['D-315', 'D-327'],
  })
  @ApiSuccess(204, { description: 'Forgotten' })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async forget(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
  ): Promise<void> {
    await this.gates.forgetVehicle(unitId, vehicleId);
  }
}

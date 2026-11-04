import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { type Invitation } from '@generated/prisma/client';
import { UnitResidentInvitationsService } from '@modules/ops-parties/unit-resident-invitations.service';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  ResidentInviteChannelName,
  UnitResidentInviteCreatedDto,
  UnitResidentInviteCreateDto,
  UnitResidentInviteDto,
} from '../resident/resident-units.dto';
import { iso } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { type InvitationChannelName, type InvitationStateName } from './tenancy.dto';

const T = [
  'tenant.context_required',
  'tenant.context_invalid',
  'tenant.not_in_scope',
  'tenant.read_only',
] as const;

const EXAMPLE: UnitResidentInviteDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  partyId: FAKE.uuid,
  channel: 'line_qr' as InvitationChannelName,
  state: 'pending' as InvitationStateName,
  expiresAt: '2026-11-19T10:00:00+07:00',
  acceptedAt: null,
  createdAt: FAKE.dateTime,
};

const inviteDto = (i: Invitation): UnitResidentInviteDto => ({
  id: i.id,
  unitId: i.unitId!,
  partyId: i.partyId!,
  channel: i.channel as InvitationChannelName,
  state: i.state as InvitationStateName,
  expiresAt: iso(i.expiresAt),
  acceptedAt: i.acceptedAt ? iso(i.acceptedAt) : null,
  createdAt: iso(i.createdAt),
});

@ApiTags('owner.unitResidentInvites')
@ApiSurface(SURFACES.owner)
@Controller('owner/units/:unitId/resident-invites')
export class OwnerUnitResidentInvitesController {
  constructor(private readonly invitations: UnitResidentInvitationsService) {}

  @Post()
  @Idempotent()
  @TenantScoped()
  @Can('unit.manage')
  @ApiEndpoint({
    id: 'owner.units.inviteResident',
    summary: 'Invite a co-owner to the resident app',
    description:
      'A single-use code for a **current co-owner** of the unit in the register (`partyId`; default: the only current co-owner), valid `juristic.resident_invite_days` (14 days): a QR to show or print in a letter (`line_qr`), an SMS with the link to the owner’s phone (`sms`) or a link. The co-owner redeems it in the LINE Mini App with an OTP sent to **the phone of the ownership party** — no lease needed (D-309, D-322). A new code for the same unit and party revokes the pending one. 422 `invitation.phone_missing` when the party has no phone; 422 `validation.failed` (`partyId`: `required` / `notOwner`) when the party is not a current co-owner or the unit has several. Audited, `unit.resident_invited` event (no code in it).',
    implements: ['D-025', 'D-061', 'D-309', 'D-322'],
  })
  @ApiJsonBody(UnitResidentInviteCreateDto, { channel: ResidentInviteChannelName.LineQr })
  @ApiSuccess(201, {
    description: 'Created; the code is shown once',
    type: UnitResidentInviteCreatedDto,
    example: {
      ...EXAMPLE,
      unitNo: FAKE.unitCode,
      code: 'ABCD-EFGH-JKLM-NPQR',
      url: 'https://liff.getproperty.invalid/link/unit?code=ABCD-EFGH-JKLM-NPQR',
      qrPayload: 'https://liff.getproperty.invalid/link/unit?code=ABCD-EFGH-JKLM-NPQR',
      qrPngDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'invitation.phone_missing',
    'provider.unavailable',
    'idempotency.key_required',
    ...T,
  )
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body() body: UnitResidentInviteCreateDto,
  ): Promise<UnitResidentInviteCreatedDto> {
    const r = await this.invitations.invite(ctx, unitId, body);
    return {
      ...inviteDto(r.invitation),
      unitNo: r.unitNo,
      code: r.code,
      url: r.url,
      qrPayload: r.qrPayload,
      qrPngDataUrl: r.qrPngDataUrl,
    };
  }

  @Get()
  @TenantScoped()
  @Can('unit.read')
  @ApiEndpoint({
    id: 'owner.units.residentInvites',
    summary: 'Co-owner invitations of a unit',
    description:
      'Pending, accepted, expired and revoked co-owner invitations of the unit, newest first (codes are never shown again, D-322).',
    implements: ['D-322'],
  })
  @ApiSuccess(200, { description: 'Invitations', type: [UnitResidentInviteDto], example: [EXAMPLE] })
  @ApiStandardErrors('http.not_found', 'validation.failed', ...T)
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<UnitResidentInviteDto[]> {
    return (await this.invitations.list(ctx, unitId)).map(inviteDto);
  }
}

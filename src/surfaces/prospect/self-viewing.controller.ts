import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { toBangkokIso } from '@common/time/bangkok';
import { AuthService } from '@core/identity/auth.service';
import { maskPhone } from '@core/identity/phone';
import { SelfViewingService } from '@modules/ops-listings/self-viewing.service';
import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { LockScopeName } from '../owner/access.dto';
import { viewingAccessDto } from '../owner/leads.controller';
import { VIEWING_ACCESS_EXAMPLE, ViewingAccessSummaryDto } from '../owner/leads.dto';
import { OtpChallengeDto, OtpRequestDto, OtpVerifyDto } from '../shared/auth.dto';
import { otpChallengeDto } from '../shared/mappers';
import { ViewingAccessStateName } from '../shared/status.enums';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  IncidentReportDto,
  ProspectPhoneDto,
  SelfViewingStatusDto,
  ViewingAccessCodeDto,
} from './self-viewing.dto';

const TERMS_EXAMPLE = {
  version: 1,
  th: 'ร่างเงื่อนไขผู้เข้าชม (รอตรวจทางกฎหมาย): ฉันจะเข้าชมห้องเฉพาะช่วงเวลาที่นัดไว้ …',
  en: 'Draft visitor terms (pending legal review): I will view the unit only during my booked time …',
};
const ACCESS_ERRORS = ['validation.failed', 'http.bad_request', 'http.not_found'] as const;

/**
 * Self-viewing for prospects (G7, D-289 (1), D-295): what I need (verified identity, verified phone, visitor
 * terms), verifying my phone, my door code — only inside the window of a self viewing the owner confirmed — and
 * telling the platform I arrived, left or found a problem. Another prospect's viewing is a 404.
 */
@ApiTags('prospect.selfViewing')
@ApiSurface(SURFACES.prospect)
@Controller('prospect')
export class ProspectSelfViewingController {
  constructor(
    private readonly selfViewing: SelfViewingService,
    private readonly auth: AuthService,
  ) {}

  @Get('me/self-viewing')
  @ApiEndpoint({
    id: 'prospect.selfViewing.status',
    summary: 'What I need for self-viewing',
    description:
      'Whether self-viewing is on (`viewing.self.enabled`, off until the insurance partner and visitor terms are settled — O-024), whether my identity (e-KYC, D-267) and phone are verified, the visitor terms in force (draft, pending legal review) and the door-code window rules (D-295).',
    implements: ['D-295', 'D-289', 'D-267'],
  })
  @ApiSuccess(200, {
    description: 'Status',
    type: SelfViewingStatusDto,
    example: {
      enabled: true,
      identityVerified: true,
      phoneVerified: false,
      missing: ['phone', 'terms'],
      visitorTerms: TERMS_EXAMPLE,
      codeMinutes: 30,
      earlyMinutes: 5,
    },
  })
  @ApiStandardErrors('validation.failed')
  async status(): Promise<SelfViewingStatusDto> {
    return this.selfViewing.myStatus();
  }

  @Post('me/phone/otp')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'prospect.phone.requestCode',
    summary: 'Send a code to verify my phone',
    description:
      'Sends an SMS code (purpose `phone_verify`) bound to my account — self-viewing needs a verified phone (D-295); a LINE sign-in has none. Rate limits as for every OTP.',
    implements: ['D-295', 'D-255'],
  })
  @ApiJsonBody(OtpRequestDto, { phone: '+66810001234', language: 'th' })
  @ApiSuccess(200, {
    description: 'Code sent',
    type: OtpChallengeDto,
    example: {
      challengeId: FAKE.uuid,
      expiresAt: '2026-11-01T00:20:00+07:00',
      resendAvailableAt: '2026-11-01T00:16:00+07:00',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.otp_rate_limited', 'provider.unavailable')
  async requestPhoneCode(@Body() body: OtpRequestDto): Promise<OtpChallengeDto> {
    return otpChallengeDto(await this.auth.prospectPhoneOtpRequest(this.me(), body.phone, body.language));
  }

  @Post('me/phone')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'prospect.phone.verify',
    summary: 'Verify my phone',
    description:
      'Checks the SMS code; the phone becomes my account’s verified phone (a later phone sign-in opens this same account). `auth.identity_in_use` when another account already has the number — sign in with it instead (D-295, D-255).',
    implements: ['D-295', 'D-255'],
  })
  @ApiJsonBody(OtpVerifyDto, { challengeId: FAKE.uuid, code: '123456' })
  @ApiSuccess(200, {
    description: 'Verified',
    type: ProspectPhoneDto,
    example: { phoneMasked: '+66•••••1234', phoneVerified: true },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
    'auth.identity_in_use',
  )
  async verifyPhone(@Body() body: OtpVerifyDto): Promise<ProspectPhoneDto> {
    const user = await this.auth.prospectPhoneVerify(this.me(), body.challengeId, body.code);
    return { phoneMasked: maskPhone(user.phoneE164!), phoneVerified: true };
  }

  @Get('viewings/:viewingId/access-code')
  @Header('Cache-Control', 'no-store')
  @ApiEndpoint({
    id: 'prospect.selfViewing.accessCode',
    summary: 'My door code',
    description:
      'The keypad code of my confirmed self viewing — **only inside its window** (`viewing.self.code_early_minutes` before to `viewing.self.code_minutes` after the slot start; `viewing.code_not_available` with the window otherwise), only while the unit is vacant (`viewing.unit_occupied`) and while no other self viewing of mine is open inside a unit (`viewing.access_open_elsewhere`). `Cache-Control: no-store`; fetch it on tap, never store it. Each reveal is audited (D-295, D-148).',
    implements: ['D-295', 'D-289', 'D-070'],
  })
  @ApiSuccess(200, {
    description: 'Door code',
    type: ViewingAccessCodeDto,
    example: {
      viewingId: FAKE.uuid,
      doorCode: '482913',
      validFrom: '2026-11-07T09:55:00+07:00',
      validTo: '2026-11-07T10:30:00+07:00',
      locks: [
        { name: 'ประตูห้อง A-102', scope: LockScopeName.Unit, ready: true },
        { name: 'ประตูหน้าอาคาร', scope: LockScopeName.BuildingDoor, ready: true },
      ],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'viewing.code_not_available',
    'viewing.unit_occupied',
    'viewing.access_open_elsewhere',
  )
  async accessCode(@Param('viewingId', ParseUUIDPipe) id: string): Promise<ViewingAccessCodeDto> {
    const r = await this.selfViewing.accessCode(id);
    return {
      viewingId: r.viewingId,
      doorCode: r.doorCode,
      validFrom: toBangkokIso(r.validFrom),
      validTo: toBangkokIso(r.validTo),
      locks: r.locks.map((l) => ({ name: l.name, scope: l.scope as LockScopeName, ready: l.ready })),
    };
  }

  @Post('viewings/:viewingId/actions/arrive')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'prospect.selfViewing.arrive',
    summary: 'I have arrived',
    description:
      'Inside the code window: records my entry (also recorded when the lock log shows my code opened the door); the owner and staff are alerted at once (D-295). Repeating it changes nothing.',
    implements: ['D-295'],
  })
  @ApiSuccess(200, {
    description: 'Entered',
    type: ViewingAccessSummaryDto,
    example: {
      ...VIEWING_ACCESS_EXAMPLE,
      state: ViewingAccessStateName.Entered,
      enteredAt: '2026-11-07T10:01:00+07:00',
      enteredSource: 'prospect',
    },
  })
  @ApiStandardErrors(...ACCESS_ERRORS, 'viewing.access_invalid_state')
  async arrive(@Param('viewingId', ParseUUIDPipe) id: string): Promise<ViewingAccessSummaryDto> {
    return viewingAccessDto(await this.selfViewing.arrive(id))!;
  }

  @Post('viewings/:viewingId/actions/leave')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'prospect.selfViewing.leave',
    summary: 'I have left',
    description:
      'Ends my self viewing: the door codes are revoked at once (unit lock and building doors), the viewing is completed and my enquiry becomes `viewed` (D-295).',
    implements: ['D-295', 'D-070'],
  })
  @ApiSuccess(200, {
    description: 'Left',
    type: ViewingAccessSummaryDto,
    example: {
      ...VIEWING_ACCESS_EXAMPLE,
      state: ViewingAccessStateName.Exited,
      enteredAt: '2026-11-07T10:01:00+07:00',
      enteredSource: 'lock_log',
      exitedAt: '2026-11-07T10:20:00+07:00',
      closedAt: '2026-11-07T10:20:00+07:00',
      closeReason: 'left',
    },
  })
  @ApiStandardErrors(...ACCESS_ERRORS, 'viewing.access_invalid_state')
  async leave(@Param('viewingId', ParseUUIDPipe) id: string): Promise<ViewingAccessSummaryDto> {
    return viewingAccessDto(await this.selfViewing.leave(id))!;
  }

  @Post('viewings/:viewingId/actions/report-incident')
  @HttpCode(200)
  @Idempotent()
  @ApiEndpoint({
    id: 'prospect.selfViewing.reportIncident',
    summary: 'Report a problem at the unit',
    description:
      'Once per self viewing, from the window start to the end of that Bangkok day: what is wrong (damage, a door that does not lock, someone inside). A high-priority inspection work order is opened on the unit and the owner and staff are alerted at once (D-295, D-072).',
    implements: ['D-295', 'D-072'],
  })
  @ApiJsonBody(IncidentReportDto, { note: 'ก๊อกน้ำในห้องน้ำรั่ว น้ำนองพื้น' })
  @ApiSuccess(200, {
    description: 'Reported',
    type: ViewingAccessSummaryDto,
    example: {
      ...VIEWING_ACCESS_EXAMPLE,
      state: ViewingAccessStateName.Entered,
      enteredAt: '2026-11-07T10:01:00+07:00',
      enteredSource: 'prospect',
      incidentAt: '2026-11-07T10:05:00+07:00',
      incidentNote: 'ก๊อกน้ำในห้องน้ำรั่ว น้ำนองพื้น',
      workOrderId: FAKE.uuid,
    },
  })
  @ApiStandardErrors(...ACCESS_ERRORS, 'viewing.access_invalid_state')
  async reportIncident(
    @Param('viewingId', ParseUUIDPipe) id: string,
    @Body() body: IncidentReportDto,
  ): Promise<ViewingAccessSummaryDto> {
    return viewingAccessDto(await this.selfViewing.reportIncident(id, body.note))!;
  }

  private me(): string {
    const id = userIdOf(RequestContext.actor());
    if (!id) throw new DomainException('auth.unauthenticated');
    return id;
  }
}

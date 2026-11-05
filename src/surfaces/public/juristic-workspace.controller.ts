import { Public } from '@common/auth/auth.decorators';
import { DomainException } from '@common/errors/domain.exception';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { toBangkokIso } from '@common/time/bangkok';
import { AuthService } from '@core/identity/auth.service';
import { type AnyIdentity } from '@core/identity/identity-sign-in.service';
import { JuristicWorkspaceService } from '@modules/ops-juristic/juristic-workspace.service';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';

import {
  WorkspaceAcceptDto,
  WorkspaceAcceptResultDto,
  WorkspacePreviewDto,
} from '../owner/juristic-receivables.dto';
import { OtpChallengeDto, OtpRequestDto, TOKEN_PAIR_EXAMPLE } from '../shared/auth.dto';
import { AUTH_RATE_LIMIT, otpChallengeDto, tokenPairDto } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const LIMIT = { default: { limit: AUTH_RATE_LIMIT, ttl: seconds(60) } };

function identityOf(body: WorkspaceAcceptDto): AnyIdentity {
  const missing = (path: string) =>
    new DomainException('validation.failed', {
      errors: [{ path, code: 'required', message: `${path} is required` }],
    });
  if (body.provider === 'phone_otp') {
    if (!body.challengeId) throw missing('challengeId');
    if (!body.code6) throw missing('code6');
    return { provider: 'phone_otp', challengeId: body.challengeId, code: body.code6 };
  }
  if (!body.idToken) throw missing('idToken');
  return body.provider === 'line'
    ? { provider: 'line', idToken: body.idToken }
    : { provider: body.provider, idToken: body.idToken };
}

/**
 * D-270 (J1.2b, D-326): a condo's juristic office accepts a landlord's invitation — it signs in like a landlord sign-up
 * (phone OTP, LINE, Google, Apple, D-255) and gets its free juristic workspace (or links the juristic tenant it owns).
 */
@ApiTags('public.juristicWorkspaces')
@ApiSurface(SURFACES.public)
@Controller('public/juristic-workspaces')
export class PublicJuristicWorkspacesController {
  constructor(
    private readonly auth: AuthService,
    private readonly workspace: JuristicWorkspaceService,
  ) {}

  @Post('otp')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'public.juristicWorkspaces.otp',
    summary: 'Send a sign-in code to the juristic office',
    description:
      'A 6-digit SMS code for the office accepting an invitation (same limits as sign-up codes, D-255) (D-270, D-326).',
    implements: ['D-270', 'D-326'],
  })
  @ApiJsonBody(OtpRequestDto, { phone: '+66810001234', language: 'th' })
  @ApiSuccess(200, {
    description: 'Code sent',
    type: OtpChallengeDto,
    example: {
      challengeId: '3b241101-e2bb-4255-8caf-4136c566a962',
      expiresAt: '2026-11-01T00:20:00+07:00',
      resendAvailableAt: '2026-11-01T00:16:00+07:00',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.otp_rate_limited', 'provider.unavailable')
  async otp(@Body() body: OtpRequestDto): Promise<OtpChallengeDto> {
    return otpChallengeDto(await this.auth.landlordOtpRequest(body.phone, body.language));
  }

  @Get(':code')
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'public.juristicWorkspaces.preview',
    summary: 'What the office is invited to',
    description:
      'The office name the landlord typed, the condo name and how many units — no landlord personal data. Unknown, used, revoked or expired code → 404 `workspace.invitation_invalid` (D-270, D-326).',
    implements: ['D-270', 'D-326'],
  })
  @ApiSuccess(200, {
    description: 'Invitation',
    type: WorkspacePreviewDto,
    example: {
      officeName: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง',
      buildingName: 'เดอะ ตัวอย่าง คอนโด',
      units: 2,
      expiresAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors('workspace.invitation_invalid', 'validation.failed')
  async preview(@Param('code') code: string): Promise<WorkspacePreviewDto> {
    const p = await this.workspace.preview(code);
    return { ...p, expiresAt: toBangkokIso(p.expiresAt) };
  }

  @Post('accept')
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'public.juristicWorkspaces.accept',
    summary: 'Accept the invitation',
    description:
      'Verifies the office’s identity; links the juristic tenant it already owns or creates a free `juristic` workspace (owning no building — D-326: the only self-serve juristic tenant); grants it the invited units (module juristic only) and adds the landlord as its billed party, linked to the landlord’s login; answers operator tokens. Single use (D-270, D-326).',
    implements: ['D-270', 'D-255', 'D-326'],
  })
  @ApiJsonBody(WorkspaceAcceptDto, {
    code: 'H4N8R2Q7XK',
    provider: 'phone_otp',
    challengeId: FAKE.uuid,
    code6: '123456',
    displayName: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง',
  })
  @ApiSuccess(201, {
    description: 'Linked',
    type: WorkspaceAcceptResultDto,
    example: {
      created: true,
      tenantId: FAKE.tenantId,
      tenantName: 'นิติบุคคลอาคารชุด เดอะ ตัวอย่าง',
      linkId: FAKE.uuid,
      tokens: TOKEN_PAIR_EXAMPLE,
    },
  })
  @ApiStandardErrors(
    'workspace.invitation_invalid',
    'validation.failed',
    'http.bad_request',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
    'auth.line_token_invalid',
    'auth.identity_token_invalid',
    'auth.identity_email_in_use',
    'auth.identity_contact_required',
    'auth.account_disabled',
    'provider.unavailable',
  )
  async accept(@Body() body: WorkspaceAcceptDto): Promise<WorkspaceAcceptResultDto> {
    const r = await this.workspace.accept({
      code: body.code,
      identity: identityOf(body),
      displayName: body.displayName,
      language: body.language,
    });
    return {
      created: r.created,
      tenantId: r.tenant.id,
      tenantName: r.tenant.displayName,
      linkId: r.linkId,
      tokens: tokenPairDto(r.tokens),
    };
  }
}

import { Public } from '@common/auth/auth.decorators';
import { DomainException } from '@common/errors/domain.exception';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { AuthService } from '@core/identity/auth.service';
import { LandlordSignupService, type SignupIdentity } from '@core/tenancy/landlord-signup.service';
import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { type Response } from 'express';

import { OtpChallengeDto, OtpRequestDto, TOKEN_PAIR_EXAMPLE, TokenPairDto } from '../shared/auth.dto';
import { LanguageName } from '../shared/common.dto';
import { AUTH_RATE_LIMIT, otpChallengeDto, tokenPairDto } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const LIMIT = { default: { limit: AUTH_RATE_LIMIT, ttl: seconds(60) } };
const PROVIDERS = ['phone_otp', 'line', 'firebase_google', 'firebase_apple'] as const;

export class LandlordSignupDto {
  @ApiProperty({
    enum: PROVIDERS,
    enumName: 'SignupProvider',
    example: 'line',
    description:
      'How the landlord proves who they are (D-255): phone OTP, LINE Login / LIFF, Google or Apple (Firebase).',
  })
  @IsIn(PROVIDERS)
  provider!: (typeof PROVIDERS)[number];

  @ApiPropertyOptional({
    example: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl',
    description: '`line`: the LINE id token; `firebase_google` / `firebase_apple`: the Firebase ID token.',
  })
  @IsOptional()
  @IsString()
  @Length(10, 8192)
  idToken?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: '`phone_otp`: the challenge of `POST …/signup/landlord/otp`.',
  })
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @ApiPropertyOptional({ example: '123456', description: '`phone_otp`: the 6-digit SMS code.' })
  @IsOptional()
  @Matches(/^\d{6}$/)
  code?: string;

  @ApiProperty({
    example: 'สมชาย ใจดี',
    description: 'The landlord’s name as residents will see it on documents.',
  })
  @IsString()
  @Length(1, 200)
  displayName!: string;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;
}

export class SignupTenantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'landlord-0a1b2c3d4e' })
  slug!: string;

  @ApiProperty({ example: 'สมชาย ใจดี' })
  displayName!: string;

  @ApiProperty({ example: 'landlord' })
  type!: string;
}

export class LandlordSignupResultDto {
  @ApiProperty({
    example: true,
    description: 'False when this identity already owned a landlord tenant (idempotent).',
  })
  created!: boolean;

  @ApiProperty({ type: SignupTenantDto })
  tenant!: SignupTenantDto;

  @ApiProperty({ type: TokenPairDto })
  tokens!: TokenPairDto;
}

function identityOf(body: LandlordSignupDto): SignupIdentity {
  const missing = (path: string) =>
    new DomainException('validation.failed', {
      errors: [{ path, code: 'required', message: `${path} is required` }],
    });
  if (body.provider === 'phone_otp') {
    if (!body.challengeId) throw missing('challengeId');
    if (!body.code) throw missing('code');
    return { provider: 'phone_otp', challengeId: body.challengeId, code: body.code };
  }
  if (!body.idToken) throw missing('idToken');
  return body.provider === 'line'
    ? { provider: 'line', idToken: body.idToken }
    : { provider: body.provider, idToken: body.idToken };
}

/**
 * Self-serve sign-up of landlords (B7.1, D-251, D-255): owners of a house or a condo unit create their own account —
 * free (D-250), no invitation. Phone sign-ups first ask for an SMS code.
 */
@ApiTags('public.signup')
@ApiSurface(SURFACES.public)
@Controller('public/signup/landlord')
export class PublicSignupController {
  constructor(
    private readonly auth: AuthService,
    private readonly signups: LandlordSignupService,
  ) {}

  @Post('otp')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'public.landlordSignup.otp',
    summary: 'Send a sign-up code by SMS',
    description:
      'A 6-digit code for a landlord signing up by phone (any phone: no account or invitation is needed, D-251). Same limits as sign-in codes: one per OTP_RESEND_SECONDS, at most OTP_MAX_PER_HOUR per hour, expiry OTP_TTL_SECONDS.',
    implements: ['D-251', 'D-255'],
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

  @Post()
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'public.landlordSignup.create',
    summary: 'Sign up as a landlord',
    description:
      'Verifies the identity (phone OTP, LINE, Google or Apple through Firebase — D-255) and creates a tenant of type `landlord` (active, free per D-250) with its data key, the person as its legal party and an Owner membership; answers operator tokens. Idempotent per identity: the same identity again answers `200` with the landlord tenant it already owns. Identities are never merged by e-mail: a Google / Apple sign-up whose e-mail already has an account answers `auth.identity_email_in_use`, one without a verified e-mail `auth.identity_contact_required`. Company landlords add legal form, tax id and VAT later in settings.',
    implements: ['D-250', 'D-251', 'D-255'],
  })
  @ApiJsonBody(LandlordSignupDto, {
    provider: 'line',
    idToken: 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln',
    displayName: 'สมชาย ใจดี',
  })
  @ApiSuccess(201, {
    description: 'Landlord tenant created',
    type: LandlordSignupResultDto,
    example: {
      created: true,
      tenant: { id: FAKE.tenantId, slug: 'landlord-0a1b2c3d4e', displayName: 'สมชาย ใจดี', type: 'landlord' },
      tokens: TOKEN_PAIR_EXAMPLE,
    },
  })
  @ApiSuccess(200, {
    description: 'Already signed up: the existing landlord tenant',
    type: LandlordSignupResultDto,
    example: {
      created: false,
      tenant: { id: FAKE.tenantId, slug: 'landlord-0a1b2c3d4e', displayName: 'สมชาย ใจดี', type: 'landlord' },
      tokens: TOKEN_PAIR_EXAMPLE,
    },
  })
  @ApiStandardErrors(
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
  async create(
    @Body() body: LandlordSignupDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LandlordSignupResultDto> {
    const result = await this.signups.signup({
      identity: identityOf(body),
      displayName: body.displayName,
      language: body.language,
    });
    res.status(result.created ? 201 : 200);
    return {
      created: result.created,
      tenant: {
        id: result.tenant.id,
        slug: result.tenant.slug,
        displayName: result.tenant.displayName,
        type: result.tenant.type,
      },
      tokens: tokenPairDto(result.tokens),
    };
  }
}

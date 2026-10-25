import { Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { AuthService } from '@core/identity/auth.service';
import { IdentitySignInService } from '@core/identity/identity-sign-in.service';
import { SigningKeys } from '@core/identity/signing-keys';
import { WEB_PUSH, type WebPushPort } from '@integrations/web-push/web-push.port';
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';

import {
  FirebaseSignInDto,
  IdentitySignInDto,
  JwksDto,
  LineExchangeDto,
  OperatorOtpVerifyDto,
  OtpChallengeDto,
  OtpRequestDto,
  OtpVerifyDto,
  PasswordLoginDto,
  RefreshDto,
  TOKEN_PAIR_EXAMPLE,
  TokenPairDto,
  TotpActivateDto,
  TotpEnrollDto,
  TotpSecretDto,
  VapidKeyDto,
} from '../shared/auth.dto';
import { AUTH_RATE_LIMIT, otpChallengeDto, tokenPairDto } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const LIMIT = { default: { limit: AUTH_RATE_LIMIT, ttl: seconds(60) } };
const OTP_EXAMPLE: OtpChallengeDto = {
  challengeId: '3b241101-e2bb-4255-8caf-4136c566a962',
  expiresAt: '2026-11-01T00:20:00+07:00',
  resendAvailableAt: '2026-11-01T00:16:00+07:00',
};

@ApiTags('auth.operator')
@ApiSurface(SURFACES.auth)
@Controller('auth/operator')
export class OperatorAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly identities: IdentitySignInService,
  ) {}

  @Post('identity')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.operatorIdentity.exchange',
    summary: 'Sign in an operator with Google, Apple or LINE',
    description:
      'Verifies the Firebase (Google / Apple) or LINE id token and signs in the account the identity is linked to — linked on the profile (`POST /v1/owner/me/identities`) or by the landlord sign-up. An identity never creates an operator and is never matched by e-mail: an unknown one is `auth.identity_not_linked` (sign in by phone, then link it). Returns tokens of audience `operator` like the SMS sign-in (D-255, D-283).',
    implements: ['D-090', 'D-255', 'D-283', 'ADR-0003'],
  })
  @ApiJsonBody(IdentitySignInDto, {
    provider: 'firebase_google',
    idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl',
  })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.line_token_invalid',
    'auth.identity_token_invalid',
    'auth.identity_not_linked',
    'auth.no_access',
    'auth.account_disabled',
    'provider.unavailable',
  )
  async identity(@Body() body: IdentitySignInDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.identities.signIn('operator', body));
  }

  @Post('otp/request')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.operatorOtp.request',
    summary: 'Send a sign-in code by SMS to an operator',
    description:
      'Sends a 6-digit code when the phone belongs to an active operator or to a pending member invitation; the answer is the same for unknown phones (no account enumeration). One code per OTP_RESEND_SECONDS, at most OTP_MAX_PER_HOUR per hour; codes expire after OTP_TTL_SECONDS (contract §4).',
    implements: ['D-090', 'D-145', 'ADR-0003'],
  })
  @ApiJsonBody(OtpRequestDto, { phone: '+66810001234', language: 'th' })
  @ApiSuccess(200, {
    description: 'Challenge created (or simulated)',
    type: OtpChallengeDto,
    example: OTP_EXAMPLE,
    headers: [],
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.otp_rate_limited', 'provider.unavailable')
  async request(@Body() body: OtpRequestDto): Promise<OtpChallengeDto> {
    return otpChallengeDto(await this.auth.operatorOtpRequest(body.phone, body.language));
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.operatorOtp.verify',
    summary: 'Sign in an operator with the SMS code',
    description:
      'Checks the code (5 attempts per challenge). With an `invitationCode` the account is created when needed and the membership of the invitation becomes active (D-145). Returns tokens of audience `operator` scoped to every active tenant (`tenant:<uuid>`), plus `building:<uuid>` for Staff limited to buildings (D-090).',
    implements: ['D-090', 'D-145', 'D-151', 'ADR-0003'],
  })
  @ApiJsonBody(OperatorOtpVerifyDto, { challengeId: '3b241101-e2bb-4255-8caf-4136c566a962', code: '123456' })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
    'auth.no_access',
    'auth.account_disabled',
    'invitation.not_found',
    'invitation.not_pending',
  )
  async verify(@Body() body: OperatorOtpVerifyDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.operatorOtpVerify(body.challengeId, body.code, body.invitationCode));
  }

  @Post('login')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.operatorSessions.login',
    summary: 'Sign in an operator with email and password',
    description:
      'For operators who set a password (and optionally TOTP). Passwords are argon2id; LOGIN_MAX_FAILURES wrong attempts lock the credential for LOGIN_LOCK_MINUTES. `auth.totp_required` asks the client to repeat with `totpCode`.',
    implements: ['D-090', 'ADR-0003'],
  })
  @ApiJsonBody(PasswordLoginDto, { email: 'test@example.com', password: 'correct horse battery staple' })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.invalid_credentials',
    'auth.totp_required',
    'auth.totp_invalid',
    'auth.account_locked',
    'auth.account_disabled',
    'auth.no_access',
  )
  async login(@Body() body: PasswordLoginDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.operatorPasswordLogin(body.email, body.password, body.totpCode));
  }
}

@ApiTags('auth.resident')
@ApiSurface(SURFACES.auth)
@Controller('auth/resident')
export class ResidentAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly identities: IdentitySignInService,
  ) {}

  @Post('identity')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.residentIdentity.exchange',
    summary: 'Sign in a resident with Google or Apple',
    description:
      'Outside LINE (D-255): verifies the Firebase ID token and signs in the account the identity is linked to (`POST /v1/resident/me/identities`); an unknown identity is `auth.identity_not_linked` — a resident first signs in with LINE or the SMS code, which is what links them to their leases (D-061, D-226). Returns `resident` tokens.',
    implements: ['D-060', 'D-255', 'D-283', 'ADR-0003'],
  })
  @ApiJsonBody(FirebaseSignInDto, {
    provider: 'firebase_apple',
    idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl',
  })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.identity_token_invalid',
    'auth.identity_not_linked',
    'auth.account_disabled',
    'provider.unavailable',
  )
  async identity(@Body() body: FirebaseSignInDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.identities.signIn('resident', body));
  }

  @Post('line')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.residentLine.exchange',
    summary: 'Sign in a resident with a LINE id token',
    description:
      "Verifies the LIFF id token with LINE, creates the account on first use and links the parties that carry this LINE user id in any tenant (D-061). Returns tokens of audience `resident` scoped to the units of the resident's current occupancies (`unit:<uuid>`; `lease:<uuid>` from B2.3).",
    implements: ['D-060', 'D-061', 'D-154', 'ADR-0003'],
  })
  @ApiJsonBody(LineExchangeDto, { idToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl' })
  @ApiSuccess(200, {
    description: 'Signed in',
    type: TokenPairDto,
    example: {
      ...TOKEN_PAIR_EXAMPLE,
      subject: {
        ...TOKEN_PAIR_EXAMPLE.subject,
        audience: 'resident',
        roles: [],
        permissions: [],
        scopes: ['unit:5c8e2a1f-6b3d-4e7a-9f0c-1d2e3f4a5b6c'],
      },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.line_token_invalid',
    'auth.account_disabled',
  )
  async line(@Body() body: LineExchangeDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.lineLogin(body.idToken, 'resident'));
  }

  @Post('otp/request')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.residentOtp.request',
    summary: 'Send a sign-in code / magic link by SMS to a resident',
    description:
      'Fallback for residents without LINE (D-060): sends a code and a link to the resident app when the phone belongs to an account or to a party an operator entered; same answer otherwise (no enumeration).',
    implements: ['D-060', 'ADR-0003'],
  })
  @ApiJsonBody(OtpRequestDto, { phone: '+66810001234', language: 'th' })
  @ApiSuccess(200, {
    description: 'Challenge created (or simulated)',
    type: OtpChallengeDto,
    example: OTP_EXAMPLE,
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.otp_rate_limited', 'provider.unavailable')
  async request(@Body() body: OtpRequestDto): Promise<OtpChallengeDto> {
    return otpChallengeDto(await this.auth.residentOtpRequest(body.phone, body.language));
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.residentOtp.verify',
    summary: 'Sign in a resident with the SMS code',
    description:
      'Checks the code and creates the account on first use. A verified phone that matches parties an operator entered (any tenant) does **not** link them: each match becomes a link request the tenant’s Owner confirms (`/v1/owner/party-link-requests`, D-226) — until then the login sees none of those parties (leases, bills, door codes); `ResidentMeDto.linkRequestsPending` counts them. An invitation code (D-175) or LINE sign-in of an invited party links at once. Returns `resident` tokens.',
    implements: ['D-060', 'D-061', 'ADR-0003'],
  })
  @ApiJsonBody(OtpVerifyDto, { challengeId: '3b241101-e2bb-4255-8caf-4136c566a962', code: '123456' })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
    'auth.account_disabled',
  )
  async verify(@Body() body: OtpVerifyDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.residentOtpVerify(body.challengeId, body.code));
  }
}

@ApiTags('auth.technician')
@ApiSurface(SURFACES.auth)
@Controller('auth/technician')
export class TechnicianAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('line')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.technicianLine.exchange',
    summary: 'Sign in a technician with a LINE id token',
    description:
      'Same LINE exchange as residents: parties carrying this LINE id are linked to the login, and the token of audience `technician` carries `work_order:<uuid>` for every work order assigned to such a party and not yet verified (B5.1); refresh to pick up new assignments.',
    implements: ['D-072', 'D-154', 'ADR-0003'],
  })
  @ApiJsonBody(LineExchangeDto, { idToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl' })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.line_token_invalid',
    'auth.account_disabled',
  )
  async line(@Body() body: LineExchangeDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.lineLogin(body.idToken, 'technician'));
  }

  @Post('otp/request')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.technicianOtp.request',
    summary: 'Send a sign-in code by SMS to a technician',
    description:
      'For an external technician the owner entered with a phone number (B5.1): sends a code when the phone belongs to an account or to a party of a tenant; same answer otherwise (no enumeration).',
    implements: ['D-072', 'D-154', 'ADR-0003'],
  })
  @ApiJsonBody(OtpRequestDto, { phone: '+66810001234', language: 'th' })
  @ApiSuccess(200, {
    description: 'Challenge created (or simulated)',
    type: OtpChallengeDto,
    example: OTP_EXAMPLE,
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.otp_rate_limited', 'provider.unavailable')
  async otpRequest(@Body() body: OtpRequestDto): Promise<OtpChallengeDto> {
    return otpChallengeDto(await this.auth.technicianOtpRequest(body.phone, body.language));
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.technicianOtp.verify',
    summary: 'Sign in a technician with the SMS code',
    description:
      'Checks the code and creates the account on first use. Parties carrying the verified phone are not linked automatically: each match is a link request the tenant’s Owner confirms (D-226); once linked (or when the work order carries the technician’s LINE id), the `technician` token carries `work_order:<uuid>` for the work orders assigned to them (B5.1) from the next refresh.',
    implements: ['D-072', 'D-154', 'ADR-0003'],
  })
  @ApiJsonBody(OtpVerifyDto, { challengeId: '3b241101-e2bb-4255-8caf-4136c566a962', code: '123456' })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
    'auth.account_disabled',
  )
  async otpVerify(@Body() body: OtpVerifyDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.technicianOtpVerify(body.challengeId, body.code));
  }
}

@ApiTags('auth.platform')
@ApiSurface(SURFACES.auth)
@Controller('auth/platform')
export class PlatformAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.platformSessions.login',
    summary: 'Sign in Collective staff (password + TOTP)',
    description:
      'Email, password and a TOTP code are all required for the platform audience (contract §4). An account without an enrolled authenticator gets 403 `auth.totp_enrollment_required` with a one-time `enrollmentToken`.',
    implements: ['D-090', 'ADR-0003'],
  })
  @ApiJsonBody(PasswordLoginDto, {
    email: 'test@example.com',
    password: 'correct horse battery staple',
    totpCode: '123456',
  })
  @ApiSuccess(200, {
    description: 'Signed in',
    type: TokenPairDto,
    example: {
      ...TOKEN_PAIR_EXAMPLE,
      subject: {
        ...TOKEN_PAIR_EXAMPLE.subject,
        audience: 'platform',
        roles: ['platform_admin'],
        permissions: ['admin.tenant.read'],
        scopes: ['platform'],
      },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.invalid_credentials',
    'auth.totp_required',
    'auth.totp_invalid',
    'auth.totp_enrollment_required',
    'auth.account_locked',
    'auth.account_disabled',
    'auth.no_access',
  )
  async login(@Body() body: PasswordLoginDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.platformLogin(body.email, body.password, body.totpCode));
  }

  @Post('totp/enroll')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.platformTotp.enroll',
    summary: 'Create the authenticator secret of a platform account',
    description:
      'With the enrolment token from `auth.totp_enrollment_required`: returns a new TOTP secret and otpauth URI (shown once).',
    implements: ['D-090', 'ADR-0003'],
  })
  @ApiJsonBody(TotpEnrollDto, { enrollmentToken: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5' })
  @ApiSuccess(200, {
    description: 'Secret created',
    type: TotpSecretDto,
    example: {
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUri:
        'otpauth://totp/getproperty:test%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=getproperty&algorithm=SHA1&digits=6&period=30',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.unauthenticated')
  async enroll(@Body() body: TotpEnrollDto): Promise<TotpSecretDto> {
    return this.auth.platformTotpEnroll(body.enrollmentToken);
  }

  @Post('totp/activate')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.platformTotp.activate',
    summary: 'Confirm the authenticator and sign in',
    description:
      'The first code from the authenticator enables TOTP on the account and signs in (audience `platform`).',
    implements: ['D-090', 'ADR-0003'],
  })
  @ApiJsonBody(TotpActivateDto, { enrollmentToken: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5', code: '123456' })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.unauthenticated',
    'auth.totp_invalid',
    'auth.no_access',
  )
  async activate(@Body() body: TotpActivateDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.platformTotpActivate(body.enrollmentToken, body.code));
  }
}

@ApiTags('auth.sessions')
@ApiSurface(SURFACES.auth)
@Controller('auth')
export class SessionsController {
  constructor(
    private readonly auth: AuthService,
    private readonly keys: SigningKeys,
    @Inject(WEB_PUSH) private readonly webPush: WebPushPort,
  ) {}

  @Post('refresh')
  @HttpCode(200)
  @Public()
  @ApiEndpoint({
    id: 'auth.sessions.refresh',
    summary: 'Rotate the refresh token',
    description:
      'Single-use rotation for every audience (contract §4): returns a new access token and a new refresh token of the same sign-in, with scopes recomputed. Presenting a refresh token that was already used ends the whole sign-in (`auth.refresh_reused`, audited).',
    implements: ['ADR-0003'],
  })
  @ApiJsonBody(RefreshDto, { refreshToken: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9' })
  @ApiSuccess(200, { description: 'New tokens', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.refresh_invalid', 'auth.refresh_reused')
  async refresh(@Body() body: RefreshDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.refresh(body.refreshToken));
  }

  @Post('logout')
  @HttpCode(204)
  @Public()
  @ApiEndpoint({
    id: 'auth.sessions.logout',
    summary: 'End the sign-in of a refresh token',
    description:
      'Revokes every token of the sign-in (refresh family) at once; access tokens of it stop working immediately. Idempotent.',
    implements: ['ADR-0003'],
  })
  @ApiJsonBody(RefreshDto, { refreshToken: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9' })
  @ApiSuccess(204, { description: 'Signed out' })
  @ApiStandardErrors('validation.failed', 'http.bad_request')
  async logout(@Body() body: RefreshDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('.well-known/jwks.json')
  @Public()
  @ApiEndpoint({
    id: 'auth.keys.jwks',
    summary: 'Public keys of the access tokens',
    description:
      'JWKS of the EdDSA (Ed25519) keys that sign access tokens, current and previous during a rotation (contract §4).',
    implements: ['ADR-0003'],
  })
  @ApiSuccess(200, {
    description: 'JSON Web Key Set',
    type: JwksDto,
    example: {
      keys: [
        {
          kty: 'OKP',
          crv: 'Ed25519',
          x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
          kid: 'gp-dev-1',
          use: 'sig',
          alg: 'EdDSA',
        },
      ],
    },
  })
  @ApiStandardErrors('http.not_found')
  jwks(): JwksDto {
    return this.keys.jwks();
  }

  @Get('web-push/public-key')
  @Public()
  @ApiEndpoint({
    id: 'auth.webPush.publicKey',
    summary: 'VAPID public key for web push',
    description:
      'The application server key browsers pass to `pushManager.subscribe()` before registering a push subscription (B1.3 notifications).',
    implements: ['ADR-0003'],
  })
  @ApiSuccess(200, {
    description: 'VAPID key',
    type: VapidKeyDto,
    example: {
      publicKey: 'BFakeVapidPublicKeyForDevelopmentOnly0000000000000000000000000000000000000000000000000',
    },
  })
  @ApiStandardErrors('http.not_found')
  vapid(): VapidKeyDto {
    return { publicKey: this.webPush.publicKey };
  }
}

@ApiTags('auth.prospect')
@ApiSurface(SURFACES.auth)
@Controller('auth/prospect')
export class ProspectAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly identities: IdentitySignInService,
  ) {}

  @Post('identity')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.prospectIdentity.exchange',
    summary: 'Sign in a prospect with Google or Apple',
    description:
      'For people looking for a place outside LINE (D-252, D-255): verifies the Firebase ID token; the first sign-in creates the account, which needs the verified e-mail of the token when no other account holds it (`auth.identity_contact_required`, `auth.identity_email_in_use`). Returns `prospect` tokens.',
    implements: ['D-252', 'D-255', 'D-283', 'ADR-0003'],
  })
  @ApiJsonBody(FirebaseSignInDto, {
    provider: 'firebase_google',
    idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl',
  })
  @ApiSuccess(200, {
    description: 'Signed in',
    type: TokenPairDto,
    example: {
      ...TOKEN_PAIR_EXAMPLE,
      subject: {
        ...TOKEN_PAIR_EXAMPLE.subject,
        audience: 'prospect',
        roles: [],
        permissions: [],
        scopes: [],
      },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.identity_token_invalid',
    'auth.identity_contact_required',
    'auth.identity_email_in_use',
    'auth.account_disabled',
    'provider.unavailable',
  )
  async identity(@Body() body: FirebaseSignInDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.identities.signIn('prospect', body));
  }

  @Post('otp/request')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.prospectOtp.request',
    summary: 'Send a sign-in code by SMS to a prospect',
    description:
      'Outside LINE (D-255): a code to any phone — a prospect has no account before the first sign-in. One code per OTP_RESEND_SECONDS, at most OTP_MAX_PER_HOUR per hour; codes expire after OTP_TTL_SECONDS (contract §4).',
    implements: ['D-252', 'D-255', 'D-283', 'ADR-0003'],
  })
  @ApiJsonBody(OtpRequestDto, { phone: '+66810001234', language: 'en' })
  @ApiSuccess(200, { description: 'Challenge created', type: OtpChallengeDto, example: OTP_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.otp_rate_limited', 'provider.unavailable')
  async otpRequest(@Body() body: OtpRequestDto): Promise<OtpChallengeDto> {
    return otpChallengeDto(await this.auth.prospectOtpRequest(body.phone, body.language));
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.prospectOtp.verify',
    summary: 'Sign in a prospect with the SMS code',
    description:
      'Checks the code (5 attempts per challenge) and creates the account on first use; returns `prospect` tokens (no scopes). Parties an owner entered with this phone are not linked here — a prospect sees only their own enquiries (D-281).',
    implements: ['D-252', 'D-255', 'D-281', 'D-283', 'ADR-0003'],
  })
  @ApiJsonBody(OtpVerifyDto, { challengeId: '3b241101-e2bb-4255-8caf-4136c566a962', code: '123456' })
  @ApiSuccess(200, { description: 'Signed in', type: TokenPairDto, example: TOKEN_PAIR_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.otp_invalid',
    'auth.otp_expired',
    'auth.otp_attempts_exceeded',
    'auth.account_disabled',
  )
  async otpVerify(@Body() body: OtpVerifyDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.prospectOtpVerify(body.challengeId, body.code));
  }

  @Post('line')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.prospectLine.exchange',
    summary: 'Sign in a prospect with a LINE id token',
    description:
      'For people looking for a place to rent (B7.3, D-252): verifies the LIFF / LINE Login id token, creates the account on first use and returns tokens of audience `prospect` (no scopes — every prospect operation reads only the caller’s own enquiries and viewings). Phone, Google and Apple: `…/otp/*` and `…/identity` (D-255, D-283).',
    implements: ['D-252', 'D-255', 'ADR-0003'],
  })
  @ApiJsonBody(LineExchangeDto, { idToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl' })
  @ApiSuccess(200, {
    description: 'Signed in',
    type: TokenPairDto,
    example: {
      ...TOKEN_PAIR_EXAMPLE,
      subject: {
        ...TOKEN_PAIR_EXAMPLE.subject,
        audience: 'prospect',
        roles: [],
        permissions: [],
        scopes: [],
      },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.line_token_invalid',
    'auth.account_disabled',
  )
  async line(@Body() body: LineExchangeDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.auth.lineLogin(body.idToken, 'prospect'));
  }
}

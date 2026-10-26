import { Public, TenantOptional, TenantScoped } from '@common/auth/auth.decorators';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { type RawBodyRequest } from '@common/http/json-body-parser';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { AppConfig } from '@config/app-config';
import {
  type IdentityStatus,
  IdentityVerificationService,
} from '@core/identity/identity-verification.service';
import { type Audience } from '@generated/prisma/client';
import { EKYC, type EkycPort } from '@integrations/ekyc/ekyc.port';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiBody,
  ApiExcludeEndpoint,
  ApiHeader,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { ApiSurface, SURFACES } from '../surfaces';
import { LanguageName } from './common.dto';
import { iso, isoOrNull } from './mappers';

export enum IdentityVerificationStateName {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
  Expired = 'expired',
}

export class IdentityVerificationAttemptDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: IdentityVerificationStateName,
    enumName: 'IdentityVerificationState',
    example: 'pending',
  })
  state!: IdentityVerificationStateName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://ekyc.example.com/session/abc',
    description: 'While pending: the provider’s page where I verify (ID card and selfie); null otherwise.',
  })
  verificationUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Why the provider did not verify me.',
  })
  failureReason!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'A pending attempt expires then.',
  })
  expiresAt!: string;
}

export class IdentityVerificationDto {
  @ApiProperty({ example: false, description: 'My identity is verified (D-267): the badge shows.' })
  verified!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  verifiedAt!: string | null;

  @ApiProperty({
    example: true,
    description: 'Whether online identity verification is offered now (a provider is configured, O-021).',
  })
  available!: boolean;

  @ApiProperty({ type: IdentityVerificationAttemptDto, nullable: true, description: 'My latest attempt.' })
  latest!: IdentityVerificationAttemptDto | null;
}

export class IdentityVerificationStartDto {
  @ApiPropertyOptional({
    enum: LanguageName,
    enumName: 'Language',
    example: LanguageName.Th,
    description: 'Language of the provider’s page.',
  })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;
}

export class EkycWebhookAckDto {
  @ApiProperty({
    example: true,
    description: 'false when the attempt was already decided (a repeated delivery).',
  })
  handled!: boolean;

  @ApiProperty({
    enum: IdentityVerificationStateName,
    enumName: 'IdentityVerificationState',
    example: 'approved',
  })
  state!: IdentityVerificationStateName;
}

const EXAMPLE: IdentityVerificationDto = {
  verified: false,
  verifiedAt: null,
  available: true,
  latest: {
    id: FAKE.uuid,
    state: IdentityVerificationStateName.Pending,
    verificationUrl: 'https://ekyc.example.com/session/abc',
    failureReason: null,
    createdAt: FAKE.dateTime,
    expiresAt: FAKE.dateTime,
  },
};

function dto(s: IdentityStatus): IdentityVerificationDto {
  const l = s.latest;
  return {
    verified: s.verified,
    verifiedAt: isoOrNull(s.verifiedAt),
    available: s.available,
    latest: l
      ? {
          id: l.id,
          state: l.state as IdentityVerificationStateName,
          verificationUrl: l.state === 'pending' ? l.verificationUrl : null,
          failureReason: l.failureReason,
          createdAt: iso(l.createdAt),
          expiresAt: iso(l.expiresAt),
        }
      : null,
  };
}

function me(): string {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return actor.publicId;
}

const DESCRIPTION_GET =
  'Whether my identity is verified and my latest attempt (D-267). Only the outcome is kept — never my ID number, photos or date of birth.';
const DESCRIPTION_START =
  'Opens a verification at the licensed e-KYC provider (ID card and selfie; O-021) and answers its page to open; a pending attempt is answered again. `identity.already_verified` once verified; `ekyc.unavailable` while no provider is configured. The provider’s signed webhook decides (D-267).';
const START_ERRORS = [
  'http.malformed_json',
  'validation.failed',
  'identity.already_verified',
  'ekyc.unavailable',
] as const;
const TENANT_ERRORS = ['tenant.context_invalid', 'tenant.not_in_scope'] as const;

/** One controller per audience: the same flow, the page to come back to differs. */
abstract class IdentityVerificationBase {
  protected abstract readonly audience: Audience;

  constructor(
    protected readonly verifications: IdentityVerificationService,
    protected readonly config: AppConfig,
  ) {}

  protected returnUrl(): string {
    if (this.audience === 'operator') return `${this.config.get('PUBLIC_WEB_APP_URL')}/settings/verification`;
    if (this.audience === 'prospect')
      return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/rent/verification`;
    return `${this.config.get('PUBLIC_RESIDENT_APP_URL')}/profile/verification`;
  }

  protected async read(): Promise<IdentityVerificationDto> {
    return dto(await this.verifications.status(me()));
  }

  protected async begin(body: IdentityVerificationStartDto): Promise<IdentityVerificationDto> {
    const user = me();
    await this.verifications.start(user, this.audience, {
      returnUrl: this.returnUrl(),
      language: body.language === LanguageName.En ? 'en' : 'th',
    });
    return dto(await this.verifications.status(user));
  }
}

@ApiTags('owner.identityVerification')
@ApiSurface(SURFACES.owner)
@Controller('owner/me/identity-verification')
export class OwnerIdentityVerificationController extends IdentityVerificationBase {
  protected readonly audience = 'operator' as const;

  constructor(verifications: IdentityVerificationService, config: AppConfig) {
    super(verifications, config);
  }

  @Get()
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.identityVerification.get',
    summary: 'My identity verification',
    description: DESCRIPTION_GET,
    implements: ['D-267'],
  })
  @ApiSuccess(200, { description: 'Status', type: IdentityVerificationDto, example: EXAMPLE })
  @ApiStandardErrors(...TENANT_ERRORS)
  get(): Promise<IdentityVerificationDto> {
    return this.read();
  }

  @Post()
  @HttpCode(200)
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.identityVerification.start',
    summary: 'Verify my identity',
    description: DESCRIPTION_START,
    implements: ['D-267'],
  })
  @ApiJsonBody(IdentityVerificationStartDto, { language: 'th' })
  @ApiSuccess(200, { description: 'Started', type: IdentityVerificationDto, example: EXAMPLE })
  @ApiStandardErrors(...START_ERRORS, ...TENANT_ERRORS)
  start(@Body() body: IdentityVerificationStartDto): Promise<IdentityVerificationDto> {
    return this.begin(body);
  }
}

@ApiTags('resident.identityVerification')
@ApiSurface(SURFACES.resident)
@Controller('resident/me/identity-verification')
export class ResidentIdentityVerificationController extends IdentityVerificationBase {
  protected readonly audience = 'resident' as const;

  constructor(verifications: IdentityVerificationService, config: AppConfig) {
    super(verifications, config);
  }

  @Get()
  @ApiEndpoint({
    id: 'resident.identityVerification.get',
    summary: 'My identity verification',
    description: DESCRIPTION_GET,
    implements: ['D-267'],
  })
  @ApiSuccess(200, { description: 'Status', type: IdentityVerificationDto, example: EXAMPLE })
  @ApiStandardErrors()
  get(): Promise<IdentityVerificationDto> {
    return this.read();
  }

  @Post()
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.identityVerification.start',
    summary: 'Verify my identity',
    description: DESCRIPTION_START,
    implements: ['D-267'],
  })
  @ApiJsonBody(IdentityVerificationStartDto, { language: 'th' })
  @ApiSuccess(200, { description: 'Started', type: IdentityVerificationDto, example: EXAMPLE })
  @ApiStandardErrors(...START_ERRORS)
  start(@Body() body: IdentityVerificationStartDto): Promise<IdentityVerificationDto> {
    return this.begin(body);
  }
}

@ApiTags('prospect.identityVerification')
@ApiSurface(SURFACES.prospect)
@Controller('prospect/me/identity-verification')
export class ProspectIdentityVerificationController extends IdentityVerificationBase {
  protected readonly audience = 'prospect' as const;

  constructor(verifications: IdentityVerificationService, config: AppConfig) {
    super(verifications, config);
  }

  @Get()
  @ApiEndpoint({
    id: 'prospect.identityVerification.get',
    summary: 'My identity verification',
    description: DESCRIPTION_GET,
    implements: ['D-267'],
  })
  @ApiSuccess(200, { description: 'Status', type: IdentityVerificationDto, example: EXAMPLE })
  @ApiStandardErrors()
  get(): Promise<IdentityVerificationDto> {
    return this.read();
  }

  @Post()
  @HttpCode(200)
  @ApiEndpoint({
    id: 'prospect.identityVerification.start',
    summary: 'Verify my identity',
    description: DESCRIPTION_START,
    implements: ['D-267'],
  })
  @ApiJsonBody(IdentityVerificationStartDto, { language: 'th' })
  @ApiSuccess(200, { description: 'Started', type: IdentityVerificationDto, example: EXAMPLE })
  @ApiStandardErrors(...START_ERRORS)
  start(@Body() body: IdentityVerificationStartDto): Promise<IdentityVerificationDto> {
    return this.begin(body);
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** `POST /webhooks/ekyc/{provider}`: the e-KYC provider's outcome (D-267), and the fake provider's page (demos). */
@ApiTags('webhooks.ekyc')
@ApiSurface(SURFACES.webhooks)
@Controller({ path: 'webhooks/ekyc', version: VERSION_NEUTRAL })
export class EkycWebhooksController {
  constructor(
    private readonly verifications: IdentityVerificationService,
    @Inject(EKYC) private readonly ekyc: EkycPort,
  ) {}

  @Post(':provider')
  @HttpCode(200)
  @Public()
  @ApiHeader({
    name: 'X-Ekyc-Signature',
    required: true,
    description: 'Hex HMAC-SHA256 of the raw body with the shared secret (`EKYC_WEBHOOK_SECRET`).',
  })
  @ApiEndpoint({
    id: 'webhooks.ekyc.callback',
    summary: 'e-KYC outcome',
    description:
      'The provider tells the outcome of a verification session: `approved` makes the person identity-verified, `rejected` keeps the reason. Signed (401 `webhook.signature_invalid` otherwise); a repeated delivery is answered `handled: false` (D-267).',
    implements: ['D-267'],
  })
  @ApiBody({
    required: true,
    description: '`sessionId`, `outcome` (approved | rejected), `reason` (optional).',
    schema: { type: 'object', additionalProperties: true },
    examples: {
      approved: { summary: 'Verified', value: { sessionId: 'sess_0123456789', outcome: 'approved' } },
    },
  })
  @ApiSuccess(200, {
    description: 'Accepted',
    type: EkycWebhookAckDto,
    example: { handled: true, state: 'approved' },
  })
  @ApiStandardErrors(
    'webhook.signature_invalid',
    'webhook.malformed',
    'http.not_found',
    'http.malformed_json',
  )
  async callback(
    @Param('provider') provider: string,
    @Headers('x-ekyc-signature') signature: string | undefined,
    @Req() req: RawBodyRequest,
  ): Promise<EkycWebhookAckDto> {
    const r = await this.verifications.receive(provider.slice(0, 40), req.rawBody, signature);
    return { handled: r.handled, state: r.state as IdentityVerificationStateName };
  }

  /** The fake provider's page (EKYC_MODE=fake only; not in the contract): approve or reject this session. */
  @Get('fake/sessions/:sessionId')
  @Public()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(@Param('sessionId') sessionId: string): string {
    if (this.ekyc.mode !== 'fake') throw new DomainException('http.not_found');
    const id = escape(sessionId.slice(0, 200));
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake e-KYC</title></head><body style="font-family:sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem"><h1>Fake e-KYC</h1><p>Session <code>${id}</code></p><form method="post" action="${id}/approve"><button style="font-size:1.1rem;padding:.6rem 1rem">Approve</button></form><form method="post" action="${id}/reject" style="margin-top:1rem"><button style="font-size:1.1rem;padding:.6rem 1rem">Reject</button></form></body></html>`;
  }

  @Post('fake/sessions/:sessionId/:outcome')
  @HttpCode(200)
  @Public()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html; charset=utf-8')
  async fake(@Param('sessionId') sessionId: string, @Param('outcome') outcome: string): Promise<string> {
    if (this.ekyc.mode !== 'fake' || (outcome !== 'approve' && outcome !== 'reject'))
      throw new DomainException('http.not_found');
    const r = await this.verifications.decide(
      'fake',
      sessionId.slice(0, 200),
      outcome === 'approve' ? 'approved' : 'rejected',
      outcome === 'approve' ? null : 'The ID card photo could not be read (fake provider).',
    );
    return `<!doctype html><html><body style="font-family:sans-serif;max-width:28rem;margin:2rem auto"><p>${escape(r.state)}. You can close this page.</p></body></html>`;
  }
}

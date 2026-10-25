import { TenantOptional, TenantScoped } from '@common/auth/auth.decorators';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { type AccountIdentities, IdentitySignInService } from '@core/identity/identity-sign-in.service';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import { AccountIdentitiesDto, type IdentityProviderName, IdentitySignInDto } from './auth.dto';
import { iso, isoOrNull } from './mappers';

export const ACCOUNT_IDENTITIES_EXAMPLE: AccountIdentitiesDto = {
  phoneMasked: '08•-•••-1234',
  hasPassword: false,
  identities: [
    {
      id: FAKE.uuid,
      provider: 'firebase_google' as IdentityProviderName,
      displayName: 'Somchai J.',
      email: 'test@example.com',
      linkedAt: '2026-11-01T00:15:00+07:00',
      lastSeenAt: '2026-11-02T09:00:00+07:00',
      removable: true,
    },
  ],
};

function dto(value: AccountIdentities): AccountIdentitiesDto {
  return {
    phoneMasked: value.phoneMasked,
    hasPassword: value.hasPassword,
    identities: value.identities.map((row) => ({
      id: row.id,
      provider: row.provider as IdentityProviderName,
      displayName: row.displayName,
      email: row.email,
      linkedAt: iso(row.linkedAt),
      lastSeenAt: isoOrNull(row.lastSeenAt),
      removable: row.removable,
    })),
  };
}

function me(): string {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return actor.publicId;
}

const LINK_ERRORS = [
  'validation.failed',
  'http.bad_request',
  'auth.line_token_invalid',
  'auth.identity_token_invalid',
  'auth.identity_in_use',
  'provider.unavailable',
] as const;
const UNLINK_ERRORS = ['http.not_found', 'auth.identity_locked', 'auth.identity_last'] as const;
const TENANT_ERRORS = ['tenant.context_invalid', 'tenant.not_in_scope'] as const;

@ApiTags('owner.identities')
@ApiSurface(SURFACES.owner)
@Controller('owner/me/identities')
export class OwnerIdentitiesController {
  constructor(private readonly identities: IdentitySignInService) {}

  @Get()
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.identities.list',
    summary: 'My ways to sign in',
    description:
      'The verified phone (masked), whether a password is set, and the Google, Apple and LINE identities linked to my account (D-255).',
    implements: ['D-255', 'D-283'],
  })
  @ApiSuccess(200, {
    description: 'Sign-in methods',
    type: AccountIdentitiesDto,
    example: ACCOUNT_IDENTITIES_EXAMPLE,
  })
  @ApiStandardErrors(...TENANT_ERRORS)
  async list(): Promise<AccountIdentitiesDto> {
    return dto(await this.identities.list(me()));
  }

  @Post()
  @HttpCode(200)
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.identities.link',
    summary: 'Add Google, Apple or LINE sign-in',
    description:
      'Links the identity of the token to my account, so I can sign in to the console with it next time; an identity that belongs to another account is never moved (`auth.identity_in_use`). Idempotent (D-255, D-283).',
    implements: ['D-255', 'D-283'],
  })
  @ApiJsonBody(IdentitySignInDto, {
    provider: 'firebase_google',
    idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl',
  })
  @ApiSuccess(200, { description: 'Linked', type: AccountIdentitiesDto, example: ACCOUNT_IDENTITIES_EXAMPLE })
  @ApiStandardErrors(...LINK_ERRORS, ...TENANT_ERRORS)
  async link(@Body() body: IdentitySignInDto): Promise<AccountIdentitiesDto> {
    return dto(await this.identities.link(me(), body));
  }

  @Delete(':identityId')
  @HttpCode(200)
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.identities.unlink',
    summary: 'Remove a Google or Apple sign-in',
    description:
      'Another way to sign in must remain (`auth.identity_last`); LINE and the phone stay on the account (`auth.identity_locked`) (D-255).',
    implements: ['D-255', 'D-283'],
  })
  @ApiSuccess(200, {
    description: 'Removed',
    type: AccountIdentitiesDto,
    example: ACCOUNT_IDENTITIES_EXAMPLE,
  })
  @ApiStandardErrors(...UNLINK_ERRORS, ...TENANT_ERRORS)
  async unlink(@Param('identityId', ParseUUIDPipe) id: string): Promise<AccountIdentitiesDto> {
    return dto(await this.identities.unlink(me(), id));
  }
}

@ApiTags('resident.identities')
@ApiSurface(SURFACES.resident)
@Controller('resident/me/identities')
export class ResidentIdentitiesController {
  constructor(private readonly identities: IdentitySignInService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.identities.list',
    summary: 'My ways to sign in',
    description:
      'The verified phone (masked) and the Google, Apple and LINE identities linked to my account — the ways to open the resident app outside LINE (D-255).',
    implements: ['D-255', 'D-283'],
  })
  @ApiSuccess(200, {
    description: 'Sign-in methods',
    type: AccountIdentitiesDto,
    example: ACCOUNT_IDENTITIES_EXAMPLE,
  })
  @ApiStandardErrors('http.not_found')
  async list(): Promise<AccountIdentitiesDto> {
    return dto(await this.identities.list(me()));
  }

  @Post()
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.identities.link',
    summary: 'Add Google or Apple sign-in',
    description:
      'Links a Google / Apple identity (or LINE) to my account, so the resident app opens with it outside LINE; an identity of another account is never moved (`auth.identity_in_use`) (D-255, D-283).',
    implements: ['D-255', 'D-283'],
  })
  @ApiJsonBody(IdentitySignInDto, {
    provider: 'firebase_apple',
    idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl',
  })
  @ApiSuccess(200, { description: 'Linked', type: AccountIdentitiesDto, example: ACCOUNT_IDENTITIES_EXAMPLE })
  @ApiStandardErrors(...LINK_ERRORS)
  async link(@Body() body: IdentitySignInDto): Promise<AccountIdentitiesDto> {
    return dto(await this.identities.link(me(), body));
  }

  @Delete(':identityId')
  @HttpCode(200)
  @ApiEndpoint({
    id: 'resident.identities.unlink',
    summary: 'Remove a Google or Apple sign-in',
    description:
      'Another way to sign in must remain (`auth.identity_last`); LINE and the phone stay (`auth.identity_locked`) (D-255).',
    implements: ['D-255', 'D-283'],
  })
  @ApiSuccess(200, {
    description: 'Removed',
    type: AccountIdentitiesDto,
    example: ACCOUNT_IDENTITIES_EXAMPLE,
  })
  @ApiStandardErrors(...UNLINK_ERRORS)
  async unlink(@Param('identityId', ParseUUIDPipe) id: string): Promise<AccountIdentitiesDto> {
    return dto(await this.identities.unlink(me(), id));
  }
}

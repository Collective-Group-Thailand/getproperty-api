import { Can } from '@common/auth/can.decorator';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ProviderCredentialsService } from '@core/credentials/provider-credentials.service';
import { type ProviderCredential } from '@generated/prisma/client';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';

import { iso, isoOrNull } from '../shared/mappers';
import { DeviceReasonDto } from '../shared/smart.dto';
import { ApiSurface, SURFACES } from '../surfaces';

export enum ProviderCredentialKindName {
  Payment = 'payment',
  Lock = 'lock',
  Etax = 'etax',
}

export enum ProviderCredentialSourceName {
  Admin = 'admin',
  Import = 'import',
}

export class ProviderCredentialDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.tenantId,
    description: 'null = the platform’s own merchant (platform invoices, payments only).',
  })
  tenantId!: string | null;

  @ApiProperty({ enum: ProviderCredentialKindName, enumName: 'ProviderCredentialKind', example: 'payment' })
  kind!: ProviderCredentialKindName;

  @ApiProperty({
    example: 'kbank',
    description: 'payment: kbank | scb | opn · lock: ttlock | tuya · etax: inet',
  })
  provider!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0042',
    description: 'Last 4 characters of the merchant reference (payments); never the full reference.',
  })
  accountRefHint!: string | null;

  @ApiProperty({ type: [String], example: ['apiKey', 'apiSecret', 'webhookSecret'] })
  keyNames!: string[];

  @ApiProperty({
    example: '9a1f03c2b7de',
    description: 'Changes whenever the values change; reveals nothing.',
  })
  fingerprint!: string;

  @ApiProperty({ enum: ProviderCredentialSourceName, enumName: 'ProviderCredentialSource', example: 'admin' })
  source!: ProviderCredentialSourceName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  revokedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  revokeReason!: string | null;
}

export class ProviderCredentialListQuery {
  @ApiPropertyOptional({
    example: FAKE.tenantId,
    description: 'A tenant id, or `platform` for the platform merchant; omitted = all.',
  })
  @IsOptional()
  @ValidateIf((o: ProviderCredentialListQuery) => o.tenantId !== 'platform')
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: ProviderCredentialKindName, enumName: 'ProviderCredentialKind' })
  @IsOptional()
  @IsEnum(ProviderCredentialKindName)
  kind?: ProviderCredentialKindName;

  @ApiPropertyOptional({ example: false, description: 'Also list revoked and replaced credentials.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  includeRevoked?: boolean;
}

export class ProviderCredentialSetDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.tenantId,
    description: 'The tenant whose merchant / vendor / e-Tax account this is; null = the platform merchant.',
  })
  @ValidateIf((o: ProviderCredentialSetDto) => o.tenantId !== null)
  @IsUUID()
  tenantId!: string | null;

  @ApiProperty({ enum: ProviderCredentialKindName, enumName: 'ProviderCredentialKind', example: 'payment' })
  @IsEnum(ProviderCredentialKindName)
  kind!: ProviderCredentialKindName;

  @ApiProperty({ example: 'kbank' })
  @IsString()
  @Length(2, 32)
  provider!: string;

  @ApiPropertyOptional({
    example: 'KB-M-000042',
    description:
      'payments: the merchant reference at the provider (the tenant bank account’s provider reference).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  merchantRef?: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { apiKey: 'k_live_…', apiSecret: '…', webhookSecret: '…' },
    description:
      'Write-only: 1–20 string values, sealed with the tenant data key and never returned (D-240).',
  })
  @IsObject()
  values!: Record<string, string>;

  @ApiProperty({ example: 'new API key from the bank portal (ticket FIN-2026-031)' })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

const CREDENTIAL_EXAMPLE: ProviderCredentialDto = {
  id: FAKE.uuid,
  tenantId: FAKE.tenantId,
  kind: ProviderCredentialKindName.Payment,
  provider: 'kbank',
  accountRefHint: '0042',
  keyNames: ['apiKey', 'apiSecret', 'webhookSecret'],
  fingerprint: '9a1f03c2b7de',
  source: ProviderCredentialSourceName.Admin,
  createdAt: FAKE.dateTime,
  revokedAt: null,
  revokeReason: null,
};

const credentialDto = (r: ProviderCredential): ProviderCredentialDto => ({
  id: r.id,
  tenantId: r.tenantId,
  kind: r.kind as ProviderCredentialKindName,
  provider: r.provider,
  accountRefHint: r.accountRefHint,
  keyNames: r.keyNames,
  fingerprint: r.fingerprint,
  source: r.source as ProviderCredentialSourceName,
  createdAt: iso(r.createdAt),
  revokedAt: isoOrNull(r.revokedAt),
  revokeReason: r.revokeReason,
});

/**
 * `/v1/admin/provider-credentials` (D-240, O-013 resolved): per-merchant provider credentials (payment providers,
 * smart-lock vendors, e-Tax providers) in PostgreSQL sealed with the tenant data key — replacing the Secrets Manager
 * sub-paths so the product keeps one secret (D-233). Values are write-only; lists show metadata.
 */
@ApiTags('admin.providerCredentials')
@ApiSurface(SURFACES.admin)
@Controller('admin/provider-credentials')
export class AdminProviderCredentialsController {
  constructor(private readonly credentials: ProviderCredentialsService) {}

  @Get()
  @Can('admin.provider_credential.manage')
  @ApiEndpoint({
    id: 'admin.providerCredentials.list',
    summary: 'Provider credentials (metadata only)',
    description:
      'Live credentials per tenant (or the platform merchant) with key names, a fingerprint and the last 4 characters of the merchant reference; values are never returned (D-240).',
    implements: ['D-240', 'D-233'],
  })
  @ApiSuccess(200, {
    description: 'Credentials',
    type: [ProviderCredentialDto],
    example: [CREDENTIAL_EXAMPLE],
  })
  @ApiStandardErrors('validation.failed')
  async list(@Query() query: ProviderCredentialListQuery): Promise<ProviderCredentialDto[]> {
    const rows = await this.credentials.list({
      ...(query.tenantId ? { tenantId: query.tenantId === 'platform' ? null : query.tenantId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      includeRevoked: query.includeRevoked === true,
    });
    return rows.map(credentialDto);
  }

  @Post()
  @HttpCode(201)
  @Idempotent()
  @Can('admin.provider_credential.manage')
  @ApiEndpoint({
    id: 'admin.providerCredentials.set',
    summary: 'Set or replace a provider credential',
    description:
      'Seals the values with the tenant’s data key (the platform field key for the platform merchant) and replaces the live credential of the same tenant, kind, provider (and merchant reference for payments) — the previous one is revoked. Audited with key names and fingerprint, never values; outbox event `provider_credential.changed` (D-240).',
    implements: ['D-240', 'D-148'],
  })
  @ApiJsonBody(ProviderCredentialSetDto, {
    tenantId: FAKE.tenantId,
    kind: ProviderCredentialKindName.Payment,
    provider: 'kbank',
    merchantRef: 'KB-M-000042',
    values: { apiKey: 'k_live_…', apiSecret: '…', webhookSecret: '…' },
    reason: 'new API key from the bank portal (ticket FIN-2026-031)',
  })
  @ApiSuccess(201, { description: 'Stored', type: ProviderCredentialDto, example: CREDENTIAL_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.not_found', 'http.bad_request')
  async set(@Body() body: ProviderCredentialSetDto): Promise<ProviderCredentialDto> {
    return credentialDto(
      await this.credentials.set(
        { tenantId: body.tenantId, kind: body.kind, provider: body.provider, merchantRef: body.merchantRef },
        body.values,
        body.reason,
      ),
    );
  }

  @Post(':credentialId/actions/revoke')
  @HttpCode(200)
  @Idempotent()
  @Can('admin.provider_credential.manage')
  @ApiEndpoint({
    id: 'admin.providerCredentials.revoke',
    summary: 'Revoke a provider credential',
    description:
      'The adapter has no credential afterwards (QR codes, lock syncs or e-Tax submissions of that account fail until a new one is set). Audited; outbox event (D-240).',
    implements: ['D-240'],
  })
  @ApiJsonBody(DeviceReasonDto, { reason: 'key leaked in a support e-mail', incidentRef: 'INC-2026-031' })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: ProviderCredentialDto,
    example: {
      ...CREDENTIAL_EXAMPLE,
      revokedAt: FAKE.dateTime,
      revokeReason: 'key leaked in a support e-mail',
    },
  })
  @ApiStandardErrors('validation.failed', 'http.not_found')
  async revoke(
    @Param('credentialId', ParseUUIDPipe) id: string,
    @Body() body: DeviceReasonDto,
  ): Promise<ProviderCredentialDto> {
    const reason = body.incidentRef ? `${body.reason} [${body.incidentRef}]` : body.reason;
    return credentialDto(await this.credentials.revoke(id, reason));
  }
}

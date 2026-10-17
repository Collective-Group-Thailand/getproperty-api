import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

import { normalisePhone } from '../../core/identity/phone';

export enum TokenAudience {
  Operator = 'operator',
  Resident = 'resident',
  Technician = 'technician',
  Platform = 'platform',
  Device = 'device',
}

export enum SubjectType {
  User = 'user',
  Device = 'device',
}

const FAKE_E164 = '+66810001234';

/** Normalises a phone to E.164 before validation (Thai local forms accepted). */
export const ToE164 = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (normalisePhone(value) ?? value) : value,
  );

export class OtpRequestDto {
  @ApiProperty({
    example: FAKE_E164,
    description: 'Mobile number, E.164 or Thai local form (`0810001234`). Stored in E.164 (D-148).',
  })
  @ToE164()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be a valid mobile number' })
  phone!: string;

  @ApiPropertyOptional({ example: 'th', description: 'Language of the SMS: `th` (default) or `en`.' })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: string;
}

export class OtpChallengeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'Send it back with the code.' })
  challengeId!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:20:00+07:00' })
  expiresAt!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-01T00:16:00+07:00',
    description: 'Earliest time for another code.',
  })
  resendAvailableAt!: string;
}

export class OtpVerifyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  challengeId!: string;

  @ApiProperty({ example: '123456', description: '6-digit code from the SMS.' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class OperatorOtpVerifyDto extends OtpVerifyDto {
  @ApiPropertyOptional({
    example: 'ABCD-EFGH-JKLM-NPQR',
    description: 'Invitation code from the SMS link or QR (D-145): creates the account and the membership.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invitationCode?: string;
}

export class PasswordLoginDto {
  @ApiProperty({ example: FAKE.email })
  @IsString()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple', description: 'Never logged.' })
  @IsString()
  @Length(1, 128)
  password!: string;

  @ApiPropertyOptional({
    example: '123456',
    description: 'Authenticator code (required when TOTP is enabled).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totpCode?: string;
}

export class LineExchangeDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVMDAwMCJ9.c2lnbmF0dXJl',
    description: 'LINE Login / LIFF id token obtained in the LINE app (`liff.getIDToken()`).',
  })
  @IsString()
  @Length(10, 8192)
  idToken!: string;
}

export class RefreshDto {
  @ApiProperty({
    example: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9',
    description: 'Opaque refresh token (single use).',
  })
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}

export class TotpEnrollDto {
  @ApiProperty({
    example: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5',
    description: 'From the `auth.totp_enrollment_required` problem.',
  })
  @IsString()
  @Length(16, 200)
  enrollmentToken!: string;
}

export class TotpActivateDto extends TotpEnrollDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class TotpSecretDto {
  @ApiProperty({ example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', description: 'Base32 secret, shown once.' })
  secret!: string;

  @ApiProperty({
    example:
      'otpauth://totp/getproperty:test%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=getproperty&algorithm=SHA1&digits=6&period=30',
  })
  otpauthUri!: string;
}

export class SubjectDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'core.user_account id (or smart.device id).',
  })
  id!: string;

  @ApiProperty({ enum: SubjectType, enumName: 'SubjectType', example: SubjectType.User })
  type!: SubjectType;

  @ApiProperty({ enum: TokenAudience, enumName: 'TokenAudience', example: TokenAudience.Operator })
  audience!: TokenAudience;

  @ApiProperty({
    type: [String],
    example: ['owner'],
    description: 'Roles (operators with one tenant, platform).',
  })
  roles!: string[];

  @ApiProperty({ type: [String], example: ['tenant.read', 'invoice.read'] })
  permissions!: string[];

  @ApiProperty({
    type: [String],
    example: [`tenant:${FAKE.tenantId}`],
    description:
      '`tenant:<uuid>`, `building:<uuid>`, `unit:<uuid>`, `lease:<uuid>`, `work_order:<uuid>`, `platform`, `device:<uuid>`.',
  })
  scopes!: string[];
}

export class TokenPairDto {
  @ApiProperty({
    example: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImdwLWRldi0xIn0.eyJzdWIiOiIuLi4ifQ.c2ln',
  })
  accessToken!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:30:00+07:00' })
  accessTokenExpiresAt!: string;

  @ApiProperty({ example: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9' })
  refreshToken!: string;

  @ApiProperty({ format: 'date-time', example: '2026-12-01T00:15:00+07:00' })
  refreshTokenExpiresAt!: string;

  @ApiProperty({ type: () => SubjectDto })
  subject!: SubjectDto;
}

export const TOKEN_PAIR_EXAMPLE: TokenPairDto = {
  accessToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImdwLWRldi0xIn0.eyJzdWIiOiIuLi4ifQ.c2ln',
  accessTokenExpiresAt: '2026-11-01T00:30:00+07:00',
  refreshToken: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9',
  refreshTokenExpiresAt: '2026-12-01T00:15:00+07:00',
  subject: {
    id: FAKE.uuid,
    type: SubjectType.User,
    audience: TokenAudience.Operator,
    roles: ['owner'],
    permissions: ['tenant.read', 'tenant.update'],
    scopes: [`tenant:${FAKE.tenantId}`],
  },
};

export class JwkDto {
  @ApiProperty({ example: 'OKP' })
  kty!: string;

  @ApiProperty({ example: 'Ed25519' })
  crv!: string;

  @ApiProperty({
    example: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    description: 'Public key (base64url).',
  })
  x!: string;

  @ApiProperty({ example: 'gp-dev-1' })
  kid!: string;

  @ApiProperty({ example: 'sig' })
  use!: string;

  @ApiProperty({ example: 'EdDSA' })
  alg!: string;
}

export class JwksDto {
  @ApiProperty({ type: () => [JwkDto] })
  keys!: JwkDto[];
}

export class VapidKeyDto {
  @ApiProperty({
    example: 'BFakeVapidPublicKeyForDevelopmentOnly0000000000000000000000000000000000000000000000000',
    description: 'VAPID application server key for `pushManager.subscribe()`.',
  })
  publicKey!: string;
}

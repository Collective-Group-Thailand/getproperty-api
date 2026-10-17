import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One field-level error inside a problem (e.g. from validation). */
export class ProblemFieldError {
  @ApiProperty({
    example: 'lines[1].pricePerUnit',
    description: 'Path of the offending field, e.g. `lines[1].pricePerUnit`.',
  })
  path!: string;

  @ApiProperty({ example: 'max', description: 'Machine-readable rule that failed, e.g. `max`, `isUuid`.' })
  code!: string;

  @ApiProperty({ example: 'pricePerUnit must not exceed the tariff cap 4.1800' })
  message!: string;
}

/**
 * Extension members a problem may carry (RFC 9457 §3.2). Each is published on `ProblemDetails`
 * and set only by the codes named in its description.
 */
export interface ProblemExtensions {
  /** `compliance.*` only: the legal reference of the refused rule (D-020). */
  legalRef?: string;
  /** `compliance.*` only: the rule id in the compliance registry (B4.1). */
  ruleId?: string;
  attemptsRemaining?: number;
  /** `auth.totp_enrollment_required` only: one-time token for `POST /v1/auth/platform/totp/enroll`. */
  enrollmentToken?: string;
  /** `compliance.acknowledgement_required` only: the evaluation to acknowledge (contract §3, D-021a). */
  evaluationId?: string;
  /** `compliance.acknowledgement_required` only: the values the warning shows (rate, cap, units, tariff version). */
  shown?: Record<string, unknown>;
}

/** RFC 9457 problem details, served as `application/problem+json` (contract §3). */
export class ProblemDetails {
  @ApiProperty({ example: 'https://errors.getproperty.co/compliance.tariff_cap' })
  type!: string;

  @ApiProperty({ example: 'Bill line above the utility tariff cap' })
  title!: string;

  @ApiProperty({ type: 'integer', example: 422 })
  status!: number;

  @ApiProperty({
    example: 'compliance.tariff_cap',
    description: 'Stable machine-readable code; never renamed. `compliance.*` codes carry `legalRef`.',
  })
  code!: string;

  @ApiProperty({
    example: 'ค่าไฟฟ้าต่อหน่วยสูงกว่าอัตราของการไฟฟ้า ไม่สามารถออกบิลได้',
    description: 'Localised by `Accept-Language` (`th` default, `en`).',
  })
  detail!: string;

  @ApiPropertyOptional({ type: () => [ProblemFieldError] })
  errors?: ProblemFieldError[];

  @ApiPropertyOptional({
    example:
      'ประกาศคณะกรรมการว่าด้วยสัญญา เรื่อง ให้ธุรกิจการให้เช่าอาคารเพื่ออยู่อาศัยเป็นธุรกิจที่ควบคุมสัญญา พ.ศ. 2568 ข้อ 4',
    description: '`compliance.*` only: the legal reference of the refused rule (D-020)',
  })
  legalRef?: string;

  @ApiPropertyOptional({
    example: 'compliance.tariff_cap',
    description: '`compliance.*` only: the rule id in the compliance registry',
  })
  ruleId?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    example: 4,
    description: '`auth.otp_invalid` only (B1.3): codes that may still be tried on this challenge',
  })
  attemptsRemaining?: number;

  @ApiPropertyOptional({
    example: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5',
    description: '`auth.totp_enrollment_required` only: one-time token to enrol an authenticator (B1.3)',
  })
  enrollmentToken?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '3b241101-e2bb-4255-8caf-4136c566a962',
    description:
      '`compliance.acknowledgement_required` only: acknowledge it with `POST /v1/owner/compliance-acknowledgements`, then repeat the request with the acknowledgement id (D-021a)',
  })
  evaluationId?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: {
      tenantRate: '7.0000',
      capPerUnit: '4.4312',
      units: '150.000',
      utility: 'electric',
      provider: 'mea',
    },
    description: '`compliance.acknowledgement_required` only: the values shown in the warning (D-021a)',
  })
  shown?: Record<string, unknown>;

  @ApiProperty({ example: '6f1c2d8e-2c7b-4d0e-9d1c-3f1a2b3c4d5e' })
  requestId!: string;
}

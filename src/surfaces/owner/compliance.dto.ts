import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

export enum ComplianceSeverityName {
  Block = 'block',
  Warn = 'warn',
}
export enum ComplianceRuleTargetName {
  Tenant = 'tenant',
  Lease = 'lease',
  RatePlan = 'rate_plan',
  Invoice = 'invoice',
  Deposit = 'deposit',
  Access = 'access',
  Notice = 'notice',
}
export enum ComplianceRuleStatusName {
  Active = 'active',
  PendingLegalVerification = 'pending_legal_verification',
  Verified = 'verified',
  Retired = 'retired',
}
export enum ComplianceScoreComponentName {
  InvoicesWithinRate = 'invoices_within_rate',
  AboveCapAcknowledged = 'above_cap_acknowledged',
  DepositsOnTime = 'deposits_on_time',
  StandardContracts = 'standard_contracts',
}

export class ComplianceRuleDto {
  @ApiProperty({ example: 'compliance.tariff_cap' })
  id!: string;

  @ApiProperty({
    example: 'ประกาศ คกก.ว่าด้วยสัญญา 2568 ข้อ 5 (6); legal-reference §1 ค่าน้ำ/ค่าไฟ, §4; D-021a, D-140',
    description: 'Clauses of docs/compliance/legal-reference.md (D-149).',
  })
  legalRef!: string;

  @ApiProperty({ enum: ComplianceSeverityName, enumName: 'ComplianceSeverity', example: 'warn' })
  defaultSeverity!: ComplianceSeverityName;

  @ApiProperty({
    enum: ComplianceSeverityName,
    enumName: 'ComplianceSeverity',
    example: 'warn',
    description: 'The severity in force for this tenant now (platform admin overrides, D-021a).',
  })
  severity!: ComplianceSeverityName;

  @ApiProperty({
    enum: ComplianceRuleTargetName,
    enumName: 'ComplianceRuleTarget',
    isArray: true,
    example: ['rate_plan', 'invoice'],
  })
  appliesTo!: ComplianceRuleTargetName[];

  @ApiProperty({
    enum: ComplianceRuleStatusName,
    enumName: 'ComplianceRuleStatus',
    example: 'pending_legal_verification',
    description: 'D-149: rules stay pending until the legal team verifies legal-reference.md.',
  })
  status!: ComplianceRuleStatusName;

  @ApiProperty({ example: 'อัตราค่าไฟฟ้า/ค่าน้ำต้องไม่เกินอัตราที่ผู้ให้บริการเรียกเก็บ' })
  descriptionTh!: string;

  @ApiProperty({
    example: 'Electricity/water rates above the utility’s effective average rate trigger the warning.',
  })
  descriptionEn!: string;

  @ApiProperty({ type: [String], example: ['compliance.tariff_cap.severity'] })
  settingsUsed!: string[];
}

export class ComplianceRuleListDto {
  @ApiProperty({
    example: true,
    description: 'The tenant is in scope of the สคบ. 2568 announcement (D-158).',
  })
  inScope!: boolean;

  @ApiProperty({ type: [ComplianceRuleDto] })
  data!: ComplianceRuleDto[];
}

export class ComplianceScoreComponentDto {
  @ApiProperty({
    enum: ComplianceScoreComponentName,
    enumName: 'ComplianceScoreComponent',
    example: 'invoices_within_rate',
  })
  key!: ComplianceScoreComponentName;

  @ApiProperty({ example: 118 })
  numerator!: number;

  @ApiProperty({ example: 120 })
  denominator!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0.9833',
    description: 'numerator / denominator, 4 decimals; null when nothing was judged (left out of the mean).',
  })
  ratio!: string | null;
}

export class ComplianceScoreDto {
  @ApiProperty({ example: '2026-11', description: 'Bangkok month `YYYY-MM`.' })
  month!: string;

  @ApiProperty({ example: '97.50', description: 'Mean of the judged components × 100, 2 decimals (0–100).' })
  score!: string;

  @ApiProperty({ example: 120 })
  invoicesTotal!: number;

  @ApiProperty({ example: 118 })
  invoicesWithinRate!: number;

  @ApiProperty({ example: 2, description: 'Invoice lines above the utility rate (D-021a).' })
  linesAboveCap!: number;

  @ApiProperty({ example: 2 })
  linesAboveCapAcknowledged!: number;

  @ApiProperty({ example: 3 })
  depositsDue!: number;

  @ApiProperty({ example: 3 })
  depositsRefundedOnTime!: number;

  @ApiProperty({ example: 120 })
  leasesTotal!: number;

  @ApiProperty({ example: 118 })
  leasesOnStandardTemplate!: number;

  @ApiProperty({ type: [ComplianceScoreComponentDto] })
  components!: ComplianceScoreComponentDto[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  computedAt!: string;
}

export class ComplianceScoreListDto {
  @ApiProperty({ type: [ComplianceScoreDto] })
  data!: ComplianceScoreDto[];
}

export class ComplianceScoreQuery {
  @ApiPropertyOptional({
    example: '2026-11',
    description: 'Bangkok month `YYYY-MM` (default: the current month).',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;
}

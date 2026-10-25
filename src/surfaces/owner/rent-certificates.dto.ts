import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { LanguageName } from '../shared/common.dto';
import { MoneyOutput } from '../shared/fields';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `ops.rent_certificate_purpose` (B7.5). */
export enum RentCertificatePurposeName {
  Visa = 'visa',
  Bank = 'bank',
  Employer = 'employer',
  Other = 'other',
}

/** `ops.rent_certificate_state` (B7.5). */
export enum RentCertificateStateName {
  Requested = 'requested',
  Issued = 'issued',
  Declined = 'declined',
}

export class RentCertificateCreateDto {
  @ApiProperty({
    enum: RentCertificatePurposeName,
    enumName: 'RentCertificatePurpose',
    example: RentCertificatePurposeName.Visa,
  })
  @IsEnum(RentCertificatePurposeName)
  purpose!: RentCertificatePurposeName;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2025-11-01',
    description: 'Default: 12 months before the end of the period (not before the lease starts).',
  })
  @IsOptional()
  @Matches(DATE)
  periodFrom?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: FAKE.date,
    description: 'Default: today (or the end of the lease). Never after today; at most 24 months.',
  })
  @IsOptional()
  @Matches(DATE)
  periodTo?: string;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', description: 'Default th.' })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500, example: 'ใช้ยื่นต่อวีซ่าเดือนหน้า' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class RentCertificateDeclineDto {
  @ApiProperty({ minLength: 1, maxLength: 300, example: 'ยังไม่มีรายการชำระในช่วงที่ขอ' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}

export class RentCertificateListQuery {
  @ApiPropertyOptional({ enum: RentCertificateStateName, enumName: 'RentCertificateState' })
  @IsOptional()
  @IsEnum(RentCertificateStateName)
  state?: RentCertificateStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  leaseId?: string;
}

export class RentCertificateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode, description: 'Owner lists only.' })
  unitNo!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'CTR-2026-00001', description: 'Owner lists only.' })
  leaseNumber!: string | null;

  @ApiProperty({
    enum: RentCertificatePurposeName,
    enumName: 'RentCertificatePurpose',
    example: RentCertificatePurposeName.Visa,
  })
  purpose!: RentCertificatePurposeName;

  @ApiProperty({ format: 'date', example: '2025-11-01' })
  periodFrom!: string;

  @ApiProperty({ format: 'date', example: FAKE.date })
  periodTo!: string;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  language!: LanguageName;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({
    enum: RentCertificateStateName,
    enumName: 'RentCertificateState',
    example: RentCertificateStateName.Requested,
  })
  state!: RentCertificateStateName;

  @ApiProperty({
    example: true,
    description: 'Asked for by the resident (false: issued directly by the owner).',
  })
  requestedByResident!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'RPC-2026-00001' })
  number!: string | null;

  @MoneyOutput({ example: '180000.00', description: 'Payments listed in the certificate.', nullable: true })
  totalPaid!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  declineReason!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  documentId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  requestedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  decidedAt!: string | null;
}

export class IncomeSummaryQuery {
  @ApiProperty({ type: 'integer', example: 2026, description: 'Bangkok calendar (tax) year.' })
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class IncomeSummaryCreateDto {
  @ApiProperty({ type: 'integer', example: 2026 })
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  unitId!: string;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', description: 'Default th.' })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;
}

export class UnitIncomeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: '12/345' })
  unitNo!: string;

  @ApiProperty({
    type: [String],
    example: [
      '15000.00',
      '15000.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
    ],
    description: 'Rent received per Bangkok month, January first (decimal strings).',
  })
  months!: string[];

  @ApiProperty({
    type: [String],
    example: [
      '1200.00',
      '1150.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
    ],
    description: 'Utilities and service charges received per Bangkok month (not 40(5) income, D-282).',
  })
  chargeMonths!: string[];

  @MoneyOutput({
    example: '30000.00',
    description: 'Rent received (rent and furniture lines, pro rata of each invoice paid; advance rent).',
  })
  rent!: string;

  @MoneyOutput({ example: '2350.00', description: 'Utilities and service charges received (shown apart).' })
  charges!: string;

  @MoneyOutput({ example: '0.00', description: 'Deposit deductions kept at settlement.' })
  retained!: string;

  @MoneyOutput({ example: '30000.00', description: 'Assessable income, section 40(5).' })
  gross!: string;
}

export class IncomeTotalsDto {
  @MoneyOutput({ example: '30000.00', description: 'Rent received.' })
  rent!: string;

  @MoneyOutput({ example: '2350.00', description: 'Utilities and service charges received (not in gross).' })
  charges!: string;

  @MoneyOutput({ example: '0.00', description: 'Deposits retained.' })
  retained!: string;

  @MoneyOutput({ example: '30000.00', description: 'Gross 40(5).' })
  gross!: string;

  @MoneyOutput({ example: '9000.00', description: 'Flat-rate deduction (estimate).' })
  deduction!: string;

  @MoneyOutput({ example: '21000.00', description: 'Gross minus the deduction (estimate).' })
  net!: string;
}

export class IncomeYearDto {
  @ApiProperty({ type: 'integer', example: 2026 })
  year!: number;

  @ApiProperty({ example: '30', description: '`tax.income_40_5.flat_deduction_percent`.' })
  deductionPercent!: string;

  @ApiProperty({ type: () => [UnitIncomeDto] })
  units!: UnitIncomeDto[];

  @ApiProperty({ type: () => IncomeTotalsDto })
  totals!: IncomeTotalsDto;
}

export class IncomeSummaryGeneratedDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The PDF; open it through `GET /v1/owner/files/{fileId}`.',
  })
  documentId!: string;

  @ApiProperty({ example: 'ISM-2026-00001' })
  number!: string;

  @ApiProperty({ type: () => IncomeYearDto })
  summary!: IncomeYearDto;
}

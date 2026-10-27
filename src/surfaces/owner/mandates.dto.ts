import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

import { DecimalInput, MoneyInput, MoneyOutput } from '../shared/fields';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export enum MandateScopeName {
  List = 'list',
  ListAndLease = 'list_and_lease',
  Manage = 'manage',
}
export enum MandateStateName {
  Invited = 'invited',
  Accepted = 'accepted',
  Active = 'active',
  Ended = 'ended',
  Revoked = 'revoked',
}
export enum MandateRoleName {
  Owner = 'owner',
  Agency = 'agency',
}
export enum CoBrokeStateName {
  Proposed = 'proposed',
  Signed = 'signed',
  Ended = 'ended',
  Cancelled = 'cancelled',
}
export enum FeeAccrualKindName {
  SuccessFee = 'success_fee',
  CoBrokeFee = 'co_broke_fee',
}
export enum FeeBillingUnitName {
  PercentOfAmount = 'percent_of_amount',
  PerDeal = 'per_deal',
}

export class AgencyDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'บ้านดี พร็อพเพอร์ตี้' })
  displayName!: string;

  @ApiProperty({ type: String, example: 'agency-0a1b2c3d4e' })
  slug!: string;
}

export class AgenciesDto {
  @ApiProperty({ type: [AgencyDto] })
  data!: AgencyDto[];
}

export class MandateInviteDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The agency tenant (from `GET /v1/owner/agencies`).',
  })
  @IsUUID()
  agencyTenantId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A unit the tenant holds, or of a building it owns / operates.',
  })
  @IsUUID()
  unitId!: string;

  @ApiPropertyOptional({ enum: MandateScopeName, enumName: 'MandateScope', example: MandateScopeName.List })
  @IsOptional()
  @IsEnum(MandateScopeName)
  scope?: MandateScopeName;

  @ApiPropertyOptional({
    example: false,
    description: 'Exclusive: no other agency may hold a mandate on the unit at the same time.',
  })
  @IsOptional()
  @IsBoolean()
  exclusive?: boolean;

  @ApiPropertyOptional({ type: String, example: 'ค่านายหน้า 1 เดือนต่อสัญญาเช่า 1 ปี', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  commissionTerms?: string | null;

  @DecimalInput({
    example: '100',
    description: 'Commission as a percentage of one month’s rent (recorded on the deal).',
    optional: true,
    nullable: true,
  })
  commissionPercent?: string | null;

  @MoneyInput({
    example: '15000.00',
    description: 'Fixed commission (wins over the percentage).',
    optional: true,
    nullable: true,
  })
  commissionAmount?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: FAKE.date,
    description: 'First day (Bangkok), default today; never in the past.',
  })
  @IsOptional()
  @Matches(DAY)
  validFrom?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2027-10-31',
    nullable: true,
    description: 'Last day (Bangkok); null = open.',
  })
  @IsOptional()
  @Matches(DAY)
  validTo?: string | null;
}

export class MandateReasonDto {
  @ApiPropertyOptional({ type: String, example: 'ขายห้องแล้ว', nullable: true })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string | null;
}

export class MandateDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  agencyTenantId!: string;

  @ApiProperty({ type: String, example: 'บ้านดี พร็อพเพอร์ตี้' })
  agencyName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  ownerTenantId!: string;

  @ApiProperty({ type: String, example: 'สมชาย ใจดี' })
  ownerName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  unitId!: string;

  @ApiProperty({ type: String, example: '12/345' })
  unitNo!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  buildingId!: string;

  @ApiProperty({ type: String, example: 'คอนโดตัวอย่าง' })
  buildingName!: string;

  @ApiProperty({ enum: MandateScopeName, enumName: 'MandateScope', example: MandateScopeName.List })
  scope!: MandateScopeName;

  @ApiProperty({ example: false })
  exclusive!: boolean;

  @ApiProperty({ type: String, example: 'ค่านายหน้า 1 เดือน', nullable: true })
  commissionTerms!: string | null;

  @ApiProperty({
    type: String,
    example: '100.0000',
    nullable: true,
    description: 'Percent of one month’s rent. Decimal string.',
  })
  commissionPercent!: string | null;

  @MoneyOutput({ example: null, description: 'Fixed commission.', nullable: true })
  commissionAmount!: string | null;

  @ApiProperty({ type: String, format: 'date', example: FAKE.date })
  validFrom!: string;

  @ApiProperty({ type: String, format: 'date', example: null, nullable: true })
  validTo!: string | null;

  @ApiProperty({ enum: MandateStateName, enumName: 'MandateState', example: MandateStateName.Active })
  state!: MandateStateName;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime, nullable: true })
  acceptedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime, nullable: true })
  activatedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: null, nullable: true })
  endedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: null, nullable: true })
  revokedAt!: string | null;

  @ApiProperty({ type: String, example: null, nullable: true })
  endReason!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description:
      'G3 (D-294): the brokerage-mandate contract sent for e-signature (evidence; the accept flow stays).',
  })
  contractDocumentId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class MandatesDto {
  @ApiProperty({ type: [MandateDto] })
  data!: MandateDto[];
}

export class MandatedUnitListingDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'published' })
  state!: string;
}

export class MandatedUnitDto {
  @ApiProperty({ type: MandateDto })
  mandate!: MandateDto;

  @ApiProperty({ type: String, format: 'uuid' })
  unitId!: string;

  @ApiProperty({ type: String, example: '12/345' })
  unitNo!: string;

  @ApiProperty({ type: String, example: 'condo_unit' })
  unitType!: string;

  @ApiProperty({ type: String, example: '28.50', nullable: true, description: 'm². Decimal string.' })
  areaSqm!: string | null;

  @ApiProperty({ type: String, format: 'uuid' })
  buildingId!: string;

  @ApiProperty({ type: String, example: 'คอนโดตัวอย่าง' })
  buildingName!: string;

  @ApiProperty({ type: String, example: 'กรุงเทพมหานคร', nullable: true })
  province!: string | null;

  @ApiProperty({ type: String, example: 'พญาไท', nullable: true })
  district!: string | null;

  @ApiProperty({
    type: MandatedUnitListingDto,
    nullable: true,
    description: 'The agency’s open listing of the unit.',
  })
  listing!: MandatedUnitListingDto | null;
}

export class MandatedUnitsDto {
  @ApiProperty({ type: [MandatedUnitDto] })
  data!: MandatedUnitDto[];
}

export class CoBrokeProposeDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'A listing of the tenant (not closed).' })
  @IsUUID()
  listingId!: string;

  @ApiProperty({ type: String, format: 'uuid', description: 'The co-agency (an `agency` tenant).' })
  @IsUUID()
  coAgencyTenantId!: string;

  @DecimalInput({
    example: '40',
    description: 'Share of the commission for the co-agency, above 0 and below 100 (%).',
  })
  splitPercent!: string;

  @ApiPropertyOptional({ type: String, format: 'date', example: FAKE.date })
  @IsOptional()
  @Matches(DAY)
  validFrom?: string;

  @ApiPropertyOptional({ type: String, format: 'date', example: null, nullable: true })
  @IsOptional()
  @Matches(DAY)
  validTo?: string | null;

  @ApiPropertyOptional({ type: String, example: 'แบ่งค่านายหน้า 60/40', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

export class CoBrokeDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  listingAgencyTenantId!: string;

  @ApiProperty({ type: String, example: 'บ้านดี พร็อพเพอร์ตี้' })
  listingAgencyName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  coAgencyTenantId!: string;

  @ApiProperty({ type: String, example: 'นายหน้าร่วม จำกัด' })
  coAgencyName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  listingId!: string;

  @ApiProperty({ type: String, example: 'condo-1br-0a1b2c3d4e' })
  listingSlug!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  unitId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  mandateId!: string | null;

  @ApiProperty({
    type: String,
    example: '40.0000',
    description: 'Co-agency share of the commission (%). Decimal string.',
  })
  splitPercent!: string;

  @ApiProperty({ type: String, format: 'date', example: FAKE.date })
  validFrom!: string;

  @ApiProperty({ type: String, format: 'date', example: null, nullable: true })
  validTo!: string | null;

  @ApiProperty({ enum: CoBrokeStateName, enumName: 'CoBrokeState', example: CoBrokeStateName.Signed })
  state!: CoBrokeStateName;

  @ApiProperty({ type: String, example: null, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime, nullable: true })
  signedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description:
      'G3 (D-294): the co-broke contract; once both agencies e-signed it the agreement is `signed`.',
  })
  contractDocumentId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class CoBrokesDto {
  @ApiProperty({ type: [CoBrokeDto] })
  data!: CoBrokeDto[];
}

export class FeeAccrualDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: FeeAccrualKindName,
    enumName: 'FeeAccrualKind',
    example: FeeAccrualKindName.SuccessFee,
  })
  kind!: FeeAccrualKindName;

  @ApiProperty({
    enum: FeeBillingUnitName,
    enumName: 'FeeBillingUnit',
    example: FeeBillingUnitName.PercentOfAmount,
  })
  billingUnit!: FeeBillingUnitName;

  @ApiProperty({
    type: String,
    example: '10.0000',
    description: 'Percent or flat price of the price-plan version. Decimal string.',
  })
  rate!: string;

  @MoneyOutput({ example: '15000.00', description: 'Base the percentage applies to.', nullable: true })
  baseAmount!: string | null;

  @MoneyOutput({ example: '1500.00', description: 'Fee owed (invoiced on the platform invoice, G5).' })
  amount!: string;

  @ApiProperty({ example: false })
  capped!: boolean;

  @ApiProperty({ type: String, format: 'date', example: FAKE.date })
  accruedOn!: string;

  @ApiProperty({ example: false, description: 'True once on a platform invoice (G5).' })
  invoiced!: boolean;
}

export class DealDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  ownerTenantId!: string;

  @ApiProperty({ type: String, example: 'สมชาย ใจดี' })
  ownerName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  leaseId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  unitId!: string;

  @ApiProperty({ type: String, example: '12/345' })
  unitNo!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  listingId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  mandateId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  coBrokeAgreementId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  listingAgencyTenantId!: string | null;

  @ApiProperty({ type: String, example: 'บ้านดี พร็อพเพอร์ตี้', nullable: true })
  listingAgencyName!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  coAgencyTenantId!: string | null;

  @ApiProperty({ type: String, example: null, nullable: true })
  coAgencyName!: string | null;

  @MoneyOutput({ example: '15000.00', description: 'Monthly rent of the lease.' })
  monthlyRent!: string;

  @MoneyOutput({
    example: '15000.00',
    description: 'Commission recorded from the mandate terms (paid outside the platform, ADR-0008).',
    nullable: true,
  })
  commissionAmount!: string | null;

  @MoneyOutput({ example: null, description: 'Co-agency share of the commission.', nullable: true })
  coBrokeAmount!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  closedAt!: string;

  @ApiProperty({
    type: [FeeAccrualDto],
    description: 'Fees the calling tenant owes for this deal (only its own).',
  })
  accruals!: FeeAccrualDto[];
}

export class DealsDto {
  @ApiProperty({ type: [DealDto] })
  data!: DealDto[];
}

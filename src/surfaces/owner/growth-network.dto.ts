import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { MoneyInput, MoneyOutput } from '../shared/fields';
import { PortfolioAddressDto, PortfolioUnitKindName } from './portfolio.controller';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERCENT = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;

// ------------------------------------------------------------------------------------------- employer housing

/** `ops.employer_split_rule`. */
export enum EmployerSplitRuleName {
  PerOccupant = 'per_occupant',
  PerUnit = 'per_unit',
}

/** `ops.employer_agreement_state`. */
export enum EmployerAgreementStateName {
  Active = 'active',
  Ended = 'ended',
}

export class EmployerAgreementCreateDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The employer — a party of this tenant (usually a company), invoices are addressed to it.',
  })
  @IsUUID()
  employerPartyId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.buildingId,
    description: 'Only leases in this building may be attached; null = any building of the tenant.',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'HR-2026-014',
    description: 'The employer’s own reference.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string | null;

  @ApiPropertyOptional({
    enum: EmployerSplitRuleName,
    enumName: 'EmployerSplitRule',
    default: EmployerSplitRuleName.PerOccupant,
    description:
      '`per_occupant`: each invoice split equally between the people staying under the lease; `per_unit`: the whole invoice on the lessee.',
  })
  @IsOptional()
  @IsEnum(EmployerSplitRuleName)
  splitRule?: EmployerSplitRuleName;

  @ApiPropertyOptional({
    type: String,
    example: '100',
    pattern: PERCENT.source,
    description:
      'Share of each worker’s portion the employer recovers through payroll (0–100, decimal string; default 100). Whether the employer may deduct is its own responsibility (O-034).',
  })
  @IsOptional()
  @Matches(PERCENT)
  deductPercent?: string;

  @ApiProperty({ format: 'date', example: FAKE.date })
  @Matches(DATE)
  validFrom!: string;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: null })
  @IsOptional()
  @Matches(DATE)
  validTo?: string | null;
}

export class EmployerAgreementUpdateDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'HR-2026-014' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string | null;

  @ApiPropertyOptional({ enum: EmployerSplitRuleName, enumName: 'EmployerSplitRule' })
  @IsOptional()
  @IsEnum(EmployerSplitRuleName)
  splitRule?: EmployerSplitRuleName;

  @ApiPropertyOptional({ type: String, example: '50', pattern: PERCENT.source })
  @IsOptional()
  @Matches(PERCENT)
  deductPercent?: string;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2027-10-31' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE)
  validTo?: string | null;

  @ApiPropertyOptional({
    example: false,
    description:
      'Ends the agreement now: its open leases go back to their lessees for the next invoices (issued invoices never change).',
  })
  @IsOptional()
  @IsBoolean()
  end?: boolean;
}

export class EmployerWorkerDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'A party of this tenant (the worker).' })
  @IsUUID()
  partyId!: string;

  @ApiProperty({ example: 'E-0042', description: 'The employer’s payroll number.' })
  @IsString()
  @Length(1, 50)
  employeeNo!: string;
}

export class EmployerWorkersDto {
  @ApiProperty({ type: [EmployerWorkerDto], maxItems: 2000, description: 'Replaces the whole list.' })
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => EmployerWorkerDto)
  workers!: EmployerWorkerDto[];
}

export class EmployerPartyRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: FAKE.companyName })
  displayName!: string;

  @ApiProperty({ example: 'company', description: '`person` | `company`.' })
  type!: string;
}

export class EmployerAgreementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: EmployerPartyRefDto })
  employer!: EmployerPartyRefDto;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  buildingId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.propertyName })
  buildingName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'HR-2026-014' })
  reference!: string | null;

  @ApiProperty({ enum: EmployerSplitRuleName, enumName: 'EmployerSplitRule' })
  splitRule!: EmployerSplitRuleName;

  @ApiProperty({ example: '100.00', description: 'Payroll deduction percent of each worker’s share.' })
  deductPercent!: string;

  @ApiProperty({ example: 'generic_csv' })
  payrollExportFormat!: string;

  @ApiProperty({ format: 'date' })
  validFrom!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  validTo!: string | null;

  @ApiProperty({ enum: EmployerAgreementStateName, enumName: 'EmployerAgreementState' })
  state!: EmployerAgreementStateName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt!: string | null;

  @ApiProperty({ type: [EmployerWorkerDto] })
  workers!: EmployerWorkerDto[];

  @ApiProperty({ type: [String], format: 'uuid', description: 'Open leases the employer pays.' })
  leaseIds!: string[];

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class EmployerAgreementsDto {
  @ApiProperty({ type: [EmployerAgreementDto] })
  data!: EmployerAgreementDto[];
}

export class EmployerAgreementListQuery {
  @ApiPropertyOptional({ enum: EmployerAgreementStateName, enumName: 'EmployerAgreementState' })
  @IsOptional()
  @IsEnum(EmployerAgreementStateName)
  state?: EmployerAgreementStateName;
}

export class LeaseEmployerDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description:
      'An active employer agreement of this tenant; null detaches the lease (invoices go to the lessee again).',
  })
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  employerAgreementId!: string | null;
}

export class LeaseEmployerResultDto {
  @ApiProperty({ format: 'uuid' })
  leaseId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  employerAgreementId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The party the lease’s next invoices are addressed to (the employer); null = the lessee.',
  })
  payerPartyId!: string | null;

  @ApiProperty({ type: 'integer', example: 3 })
  version!: number;
}

export class EmployerMonthQuery {
  @ApiProperty({ example: '2026-11', description: 'Bangkok month (YYYY-MM): invoices issued in it.' })
  @Matches(MONTH)
  month!: string;
}

export class PayrollExportCreateDto {
  @ApiProperty({ example: '2026-11', description: 'Bangkok month (YYYY-MM) of the statement to export.' })
  @Matches(MONTH)
  month!: string;
}

export class WorkerShareDto {
  @ApiProperty({ format: 'uuid' })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'E-0042' })
  employeeNo!: string | null;

  @MoneyOutput({ example: '2500.00', description: 'The worker’s share of the invoice.' })
  share!: string;

  @MoneyOutput({ example: '2500.00', description: 'Recovered through payroll (share × deduct percent).' })
  deduction!: string;

  @MoneyOutput({ example: '0.00', description: 'Carried by the employer.' })
  employerPays!: string;
}

export class StatementLineDto {
  @ApiProperty({ format: 'uuid' })
  invoiceId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'INV-2026-00042' })
  number!: string | null;

  @ApiProperty({ format: 'uuid' })
  leaseId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'date-time' })
  issuedAt!: string;

  @ApiProperty({ format: 'date' })
  periodStart!: string;

  @ApiProperty({ format: 'date' })
  periodEnd!: string;

  @MoneyOutput({ example: '5000.00', description: 'Invoice total.' })
  total!: string;

  @MoneyOutput({ example: '0.00', description: 'Paid so far.' })
  paidTotal!: string;

  @MoneyOutput({ example: '5000.00', description: 'Still due.' })
  balance!: string;

  @ApiProperty({ type: [WorkerShareDto] })
  shares!: WorkerShareDto[];
}

export class EmployerStatementDto {
  @ApiProperty({ format: 'uuid' })
  agreementId!: string;

  @ApiProperty({ example: FAKE.companyName })
  employerName!: string;

  @ApiProperty({ example: '2026-11' })
  month!: string;

  @ApiProperty({ enum: EmployerSplitRuleName, enumName: 'EmployerSplitRule' })
  splitRule!: EmployerSplitRuleName;

  @ApiProperty({ example: '100.00' })
  deductPercent!: string;

  @ApiProperty({ type: [StatementLineDto] })
  lines!: StatementLineDto[];

  @MoneyOutput({ example: '5000.00', description: 'Sum of the invoices.' })
  total!: string;

  @MoneyOutput({ example: '0.00', description: 'Paid so far.' })
  paid!: string;

  @MoneyOutput({ example: '5000.00', description: 'Still due.' })
  balance!: string;

  @MoneyOutput({ example: '5000.00', description: 'Sum of the payroll deductions.' })
  deductions!: string;

  @MoneyOutput({ example: '0.00', description: 'Carried by the employer (total − deductions).' })
  employerPays!: string;
}

// ------------------------------------------------------------------------------------------- rental handoff

/** `ops.rental_handoff_state`. */
export enum RentalHandoffStateName {
  Invited = 'invited',
  Accepted = 'accepted',
  Listed = 'listed',
  Declined = 'declined',
  Expired = 'expired',
}

export class RentalHandoffClaimDto {
  @ApiProperty({
    example: 'q3K8xF0bW2yR9mT4vN6pL1sA7dE5gH0j',
    description: 'The token of the invitation link getbuild showed the buyer (`/handoff/<token>`).',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,100}$/)
  token!: string;

  @MoneyInput({ example: '15000', description: 'Monthly rent of the listing draft.' })
  rent!: string;

  @ApiPropertyOptional({
    example: 'คอนโด 1 ห้องนอน ใกล้รถไฟฟ้า',
    description: 'Default: from the unit facts.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  titleTh?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '1-bedroom condo near the train' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 120)
  titleEn?: string | null;

  @ApiPropertyOptional({
    type: PortfolioAddressDto,
    description: 'Needed only when getbuild did not tell the address (`validation.failed` on `address`).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PortfolioAddressDto)
  address?: PortfolioAddressDto;
}

export class HandoffFactsDto {
  @ApiProperty({ type: String, nullable: true, example: FAKE.propertyName })
  projectName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ enum: PortfolioUnitKindName, enumName: 'PortfolioUnitKind' })
  kind!: PortfolioUnitKindName;

  @ApiProperty({ type: String, nullable: true, example: 'จตุจักร' })
  district!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'กรุงเทพมหานคร' })
  province!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '32.00' })
  areaSqm!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1 })
  bedrooms!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1 })
  bathrooms!: number | null;

  @ApiProperty({ type: String, nullable: true, example: '12' })
  floorLabel!: string | null;
}

export class RentalHandoffDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RentalHandoffStateName, enumName: 'RentalHandoffState' })
  state!: RentalHandoffStateName;

  @ApiProperty({
    example: 'getbuild:dev-campaign-2026',
    description: 'The developer campaign (also on the listing).',
  })
  campaignTag!: string;

  @ApiProperty({ type: HandoffFactsDto })
  facts!: HandoffFactsDto;

  @ApiProperty({ format: 'date' })
  transferDate!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The prefilled listing draft.' })
  listingId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  listedAt!: string | null;
}

export class RentalHandoffsDto {
  @ApiProperty({ type: [RentalHandoffDto] })
  data!: RentalHandoffDto[];
}

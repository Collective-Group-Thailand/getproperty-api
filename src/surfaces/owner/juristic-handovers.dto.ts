import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

import { MoneyOutput } from '../shared/fields';

/** J3.2 developer handover from getbuild (D-314, D-333). */

export enum HandoverStateName {
  Received = 'received',
  PendingReview = 'pending_review',
  Accepted = 'accepted',
  Rejected = 'rejected',
  Superseded = 'superseded',
}
export enum HandoverLegalFormName {
  CondoAct = 'condo_act',
  LandAllocationAct = 'land_allocation_act',
  Voluntary = 'voluntary',
  LeaseContract = 'lease_contract',
}
export enum HandoverPropertyKindName {
  Apartment = 'apartment',
  Condo = 'condo',
  Village = 'village',
  Community = 'community',
  Office = 'office',
  Retail = 'retail',
  Industrial = 'industrial',
  Mixed = 'mixed',
}
export enum HandoverProblemCode {
  OwnerMissing = 'owner_missing',
  PartyUnknown = 'party_unknown',
  UnitUnknown = 'unit_unknown',
  FloorUnknown = 'floor_unknown',
  SharesExceeded = 'shares_exceeded',
  DuplicateUnitNo = 'duplicate_unit_no',
  ReceivableAfterAsOf = 'receivable_after_as_of',
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------------------------------- requests

export class JuristicHandoverListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: HandoverStateName, enumName: 'HandoverState' })
  @IsOptional()
  @IsEnum(HandoverStateName)
  state?: HandoverStateName;
}

export class JuristicHandoverAcceptDto {
  @ApiPropertyOptional({
    enum: HandoverLegalFormName,
    enumName: 'BuildingLegalForm',
    description: 'Required when getbuild did not send the building’s legal form (D-302).',
  })
  @IsOptional()
  @IsEnum(HandoverLegalFormName)
  legalForm?: HandoverLegalFormName;

  @ApiPropertyOptional({
    enum: HandoverPropertyKindName,
    enumName: 'PropertyKind',
    description:
      'When getbuild did not send it; default from the building type (condo → condo, house cluster → village).',
  })
  @IsOptional()
  @IsEnum(HandoverPropertyKindName)
  propertyKind?: HandoverPropertyKindName;

  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description: 'Send each opening balance to its owner like a new invoice (false: issued silently).',
  })
  @IsOptional()
  @IsBoolean()
  notifyOpeningBalances?: boolean;
}

/** Same shape as the import rollback body (one schema in the contract). */
export { JuristicImportRollbackDto as JuristicHandoverRejectDto } from './juristic-imports.dto';

export class JuristicHandoverFormedDto {
  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-12-15',
    description: 'Registration date (not after today).',
  })
  @Matches(DATE)
  formedOn!: string;

  @ApiPropertyOptional({ type: String, example: 'นต.123/2569', nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNo?: string | null;
}

export class AdminHandoverAssignDto {
  @ApiProperty({ type: String, format: 'uuid', example: FAKE.tenantId, description: 'A juristic tenant.' })
  @IsUUID()
  juristicTenantId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description:
      'The developer’s getproperty tenant (`pm_company`) when it operates the building until the juristic person is formed (D-150 D1).',
  })
  @IsOptional()
  @IsUUID()
  developerTenantId?: string | null;
}

// ------------------------------------------------------------------------------------------- responses

export class HandoverTotalsDto {
  @ApiProperty({ example: 312 }) units!: number;
  @ApiProperty({ example: 8 }) floors!: number;
  @ApiProperty({ example: 330 }) parties!: number;
  @ApiProperty({ example: 336 }) ownerships!: number;
  @ApiProperty({ example: 312 }) unitsWithMoney!: number;
  @MoneyOutput({ example: '4492800.00', description: 'Σ advance common fees.' }) advanceCommonFees!: string;
  @MoneyOutput({ example: '5070000.00', description: 'Σ first sinking-fund contributions.' })
  firstFundContributions!: string;
  @MoneyOutput({ example: '37200.00', description: 'Σ receivables brought forward.' })
  receivablesBroughtForward!: string;
  @ApiProperty({ example: 31 }) receivableItems!: number;
}

export class HandoverAppliedDto {
  @MoneyOutput({ example: '4492800.00', description: 'Σ owners’ credit recorded.' }) credits!: string;
  @ApiProperty({ example: 31 }) openingInvoices!: number;
  @MoneyOutput({ example: '37200.00', description: 'Σ opening-balance invoices issued.' })
  openingInvoicesTotal!: string;
  @MoneyOutput({ example: '5070000.00', description: 'Σ posted into the sinking fund.' })
  fundContributions!: string;
}

export class HandoverProblemDto {
  @ApiProperty({
    enum: HandoverProblemCode,
    enumName: 'HandoverProblemCode',
    example: HandoverProblemCode.OwnerMissing,
  })
  code!: HandoverProblemCode;
  @ApiProperty({ type: String, nullable: true, example: 'u-101' }) unitRef!: string | null;
  @ApiProperty({ type: String, nullable: true, example: null }) ref!: string | null;
}

export class HandoverOwnerDto {
  @ApiProperty({ example: 'p-1' }) partyRef!: string;
  @ApiProperty({ example: 'ผู้ซื้อ ตัวอย่าง' }) displayName!: string;
  @ApiProperty({ example: '100.0000' }) sharePct!: string;
}

export class HandoverUnitDto {
  @ApiProperty({ example: 'u-101' }) unitRef!: string;
  @ApiProperty({ example: 'A-101' }) unitNo!: string;
  @ApiProperty({ type: [HandoverOwnerDto] }) owners!: HandoverOwnerDto[];
  @MoneyOutput({ example: '14400.00', description: 'Advance common fees.' }) advanceCommonFees!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-11-01' })
  advancePeriodFrom!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-10-31' })
  advancePeriodTo!: string | null;
  @MoneyOutput({ example: '16250.00', description: 'First fund contribution.' })
  firstFundContribution!: string;
  @MoneyOutput({ example: '1200.00', description: 'Receivables brought forward.' })
  receivablesBroughtForward!: string;
  @ApiProperty({ example: 1 }) receivableItems!: number;
}

export class HandoverBankDto {
  @ApiProperty({ example: '014' }) bankCode!: string;
  @ApiProperty({ type: String, nullable: true, example: 'ธนาคารตัวอย่าง' }) bankName!: string | null;
  @ApiProperty({ example: 'นิติบุคคลอาคารชุดตัวอย่าง' }) accountName!: string;
  @ApiProperty({ example: 'XXX-X-XX1234', description: 'Masked: last 4 digits only.' })
  accountNoMasked!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description:
      'The tenant bank account with the same bank and last 4 digits (journals post to it), else null.',
  })
  matchedBankAccountId!: string | null;
}

export class JuristicHandoverDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) id!: string;
  @ApiProperty({
    enum: HandoverStateName,
    enumName: 'HandoverState',
    example: HandoverStateName.PendingReview,
  })
  state!: HandoverStateName;
  @ApiProperty({
    example: 2,
    description: 'Contract version of the event (1 register only, 2 with finance).',
  })
  contractVersion!: number;
  @ApiProperty({ example: 'dev-tenant-42' }) developerRef!: string;
  @ApiProperty({ example: 'bldg-a' }) buildingRef!: string;
  @ApiProperty({ example: 'อาคาร A' }) buildingName!: string;
  @ApiProperty({ format: 'date-time', example: FAKE.dateTime }) requestedHandoverAt!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-31' }) asOfDate!:
    string | null;
  @ApiProperty({ type: HandoverTotalsDto }) totals!: HandoverTotalsDto;
  @ApiProperty({ type: HandoverBankDto, nullable: true }) receivingBank!: HandoverBankDto | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null }) developerTenantId!:
    string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null }) buildingId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null }) acceptedAt!:
    string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null }) rejectedAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true, example: null }) rejectReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  rejectionDeliveredAt!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: null }) formedOn!: string | null;
  @ApiProperty({ type: String, nullable: true, example: null }) registrationNo!: string | null;
  @ApiProperty({ type: [String], example: ['accept', 'reject'] }) nextActions!: string[];
  @ApiProperty({ format: 'date-time', example: FAKE.dateTime }) createdAt!: string;
  @ApiProperty({ example: 1 }) version!: number;
}

export class JuristicHandoverReviewDto extends JuristicHandoverDto {
  @ApiProperty({ type: [HandoverProblemDto] }) problems!: HandoverProblemDto[];
  @ApiProperty({ type: [HandoverUnitDto] }) units!: HandoverUnitDto[];
  @ApiProperty({
    example: 0,
    description: 'Parties matched to existing ones (same LINE id or an earlier handover).',
  })
  partiesToAttach!: number;
  @ApiProperty({ example: 330 }) partiesToCreate!: number;
  @ApiProperty({
    type: HandoverAppliedDto,
    nullable: true,
    description: 'What the acceptance recorded (accepted only).',
  })
  applied!: HandoverAppliedDto | null;
}

export class AdminHandoverDto extends JuristicHandoverDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId }) tenantId!:
    string | null;
  @ApiProperty({ format: 'uuid', example: FAKE.uuid }) integrationEventId!: string;
  @ApiProperty({ example: 0 }) rejectionAttempts!: number;
  @ApiProperty({ type: String, nullable: true, example: null }) lastDeliveryError!: string | null;
}

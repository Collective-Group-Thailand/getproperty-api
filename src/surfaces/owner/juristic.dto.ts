import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { ToE164 } from '../shared/auth.dto';
import { DecimalInput, MoneyInput, MoneyOutput } from '../shared/fields';
import { BillingFrequencyName, BuildingLegalFormName } from '../shared/status.enums';
import { RatePlanDto } from './billing.dto';
import { PartyTypeName as PartyTypeInputName } from './parties.dto';

/** `share_pct`: 0 < x ≤ 100, up to 4 decimals. */
const SHARE = /^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/;

/** = `PartyType` of the parties API (person / company). */
export { PartyTypeInputName };
export enum MeetingKindName {
  Agm = 'agm',
  Egm = 'egm',
  Committee = 'committee',
}
export enum ResolutionStateName {
  Draft = 'draft',
  Adopted = 'adopted',
  Void = 'void',
}
export enum ResolutionDocumentKindName {
  Minutes = 'minutes',
  Attachment = 'attachment',
  Notice = 'notice',
}
export enum BudgetStateName {
  Draft = 'draft',
  Approved = 'approved',
  Superseded = 'superseded',
}
export enum BudgetLineKindName {
  Income = 'income',
  Expense = 'expense',
  Fund = 'fund',
}
export enum BillToKindName {
  NamedParty = 'named_party',
  Agency = 'agency',
}
export enum TransferProrationName {
  CarryToBuyer = 'carry_to_buyer',
  RefundSeller = 'refund_seller',
}
export enum BudgetSplitByName {
  OwnershipRatio = 'ownership_ratio',
  AreaSqm = 'area_sqm',
  LandAreaSqwa = 'land_area_sqwa',
  PerUnit = 'per_unit',
}
export enum JuristicChargeKindName {
  CommonFee = 'common_fee',
  Fund = 'fund',
}

// ------------------------------------------------------------------------------------------- register

export class RegisterPartyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: PartyTypeInputName,
    enumName: 'PartyType',
    example: PartyTypeInputName.Person,
  })
  type!: PartyTypeInputName;

  @ApiProperty({ example: FAKE.nameTh })
  displayName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '+66•••••1234',
    description: 'Masked (open the party with `party.pii.decrypt` for the full number).',
  })
  phoneMasked!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  email!: string | null;

  @ApiProperty({ example: false, description: 'A LINE user id is on file (LINE channel available).' })
  lineLinked!: boolean;

  @ApiProperty({ example: true, description: 'The party is linked to a resident login (LINE Mini App).' })
  residentLinked!: boolean;
}

export class RegisterOwnerDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  ownershipId!: string;

  @ApiProperty({ type: () => RegisterPartyDto })
  party!: RegisterPartyDto;

  @ApiProperty({
    example: '60.0000',
    description: 'Ownership share in percent (decimal string, 4 decimals).',
  })
  sharePct!: string;

  @ApiProperty({ format: 'date', example: '2020-01-01' })
  validFrom!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: null,
    description: 'First day not owned any more (exclusive, the transfer date).',
  })
  validTo!: string | null;

  @ApiProperty({ example: 'manual' })
  source!: string;
}

export class BillToDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The co-owner who named the payer.' })
  ownerPartyId!: string;

  @ApiProperty({ type: () => RegisterPartyDto, description: 'Receives and pays the invoices (D-307).' })
  billToParty!: RegisterPartyDto;

  @ApiProperty({ enum: BillToKindName, enumName: 'BillToKind', example: BillToKindName.NamedParty })
  kind!: BillToKindName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The owner’s written consent (document).' })
  consentDocumentId!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  consentNote!: string | null;

  @ApiProperty({ format: 'date', example: '2027-01-01' })
  validFrom!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null, description: 'Exclusive.' })
  validTo!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'ended · replaced · ownership_transfer',
  })
  endedReason!: string | null;
}

export class RegisterUnitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ example: 'condo_unit', description: 'Unit type (`plot` for a housing-estate plot).' })
  type!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({
    enum: BuildingLegalFormName,
    enumName: 'BuildingLegalForm',
    nullable: true,
    example: BuildingLegalFormName.CondoAct,
  })
  legalForm!: BuildingLegalFormName | null;

  @ApiProperty({ type: String, nullable: true, example: '34.77', description: 'Floor area m².' })
  areaSqm!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0.012345',
    description: 'อัตราส่วนกรรมสิทธิ์ (6 decimals).',
  })
  ownershipRatio!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Land area in ตารางวา.' })
  landAreaSqwa!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Plot number (housing estates).' })
  plotNo!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Title deed / condo title number.',
  })
  titleDeedNo!: string | null;

  @ApiProperty({ type: () => [RegisterOwnerDto], description: 'Owners current today.' })
  owners!: RegisterOwnerDto[];

  @ApiProperty({ example: '100.0000', description: 'Σ of the current owners’ shares.' })
  sharesTotal!: string;

  @ApiProperty({
    example: false,
    description:
      'Σ shares < 100 %: the register misses an owner; common-fee drafts of the unit are not issuable (`ownership_shares_incomplete`, D-323).',
  })
  incomplete!: boolean;

  @ApiProperty({ type: () => [BillToDto], description: 'Bill-to parties in force today or later.' })
  billTo!: BillToDto[];

  @ApiProperty({ type: 'integer', example: 1, description: 'Unit version (for PATCH).' })
  version!: number;
}

export class OwnershipTransferDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ format: 'date', example: '2027-03-15' })
  transferDate!: string;

  @ApiProperty({
    enum: TransferProrationName,
    enumName: 'TransferProration',
    example: TransferProrationName.CarryToBuyer,
  })
  policy!: TransferProrationName;

  @ApiProperty({ type: [String], example: [FAKE.uuid] })
  fromOwnershipIds!: string[];

  @ApiProperty({ type: [String], example: [FAKE.uuid] })
  toOwnershipIds!: string[];

  @ApiProperty({
    type: [String],
    example: [],
    description: 'Credit notes to the sellers’ issued advance invoices.',
  })
  creditNoteIds!: string[];

  @ApiProperty({
    type: [String],
    example: [],
    description: 'One-off charges queued for the buyers (carry_to_buyer).',
  })
  chargeIds!: string[];

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class RegisterUnitDetailDto extends RegisterUnitDto {
  @ApiProperty({
    type: () => [RegisterOwnerDto],
    description: 'Every ownership row of the unit, oldest first.',
  })
  history!: RegisterOwnerDto[];

  @ApiProperty({ type: () => [BillToDto] })
  billToHistory!: BillToDto[];

  @ApiProperty({ type: () => [OwnershipTransferDto] })
  transfers!: OwnershipTransferDto[];
}

export class RegisterListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Only units whose shares sum below (true) / to (false) 100 %.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  incomplete?: boolean;
}

export class RegisterUnitUpdateDto {
  @DecimalInput({ example: '52.50', description: 'Land area in ตารางวา.', optional: true, nullable: true })
  landAreaSqwa?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '12/48', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  plotNo?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null, maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  titleDeedNo?: string | null;

  @DecimalInput({ example: '34.77', description: 'Floor area m².', optional: true, nullable: true })
  areaSqm?: string | null;

  @DecimalInput({
    example: '0.012345',
    description: 'Ownership ratio (≤ 6 decimals).',
    optional: true,
    nullable: true,
  })
  ownershipRatio?: string | null;

  @ApiPropertyOptional({
    type: 'integer',
    example: 1,
    description: 'The unit version you read (409/412 on mismatch).',
  })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class NewPartyDto {
  @ApiProperty({
    enum: PartyTypeInputName,
    enumName: 'PartyType',
    example: PartyTypeInputName.Person,
  })
  @IsEnum(PartyTypeInputName)
  type!: PartyTypeInputName;

  @ApiProperty({ example: FAKE.nameTh })
  @IsString()
  @Length(1, 200)
  displayName!: string;

  @ApiPropertyOptional({ example: '+66810001234' })
  @IsOptional()
  @ToE164()
  @Matches(/^\+[1-9]\d{6,14}$/)
  phone?: string;

  @ApiPropertyOptional({ example: FAKE.email })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'th' })
  @IsOptional()
  @IsIn(['th', 'en', 'zh', 'my', 'km', 'lo'])
  language?: string;
}

export class PartyRefDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'An existing party of the tenant…' })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ type: () => NewPartyDto, description: '…or a new one created with the change.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => NewPartyDto)
  party?: NewPartyDto;
}

export class OwnerAddDto extends PartyRefDto {
  @ApiProperty({ example: '40', pattern: SHARE.source, description: 'Share in percent, 0 < x ≤ 100.' })
  @IsString()
  @Matches(SHARE)
  sharePct!: string;

  @ApiPropertyOptional({ format: 'date', example: '2027-01-01', description: 'Default today.' })
  @IsOptional()
  @IsDateString({ strict: true })
  validFrom?: string;
}

export class TransferBuyerDto extends PartyRefDto {
  @ApiProperty({ example: '100', pattern: SHARE.source })
  @IsString()
  @Matches(SHARE)
  sharePct!: string;
}

export class TransferCreateDto {
  @ApiProperty({ format: 'date', example: '2027-03-15', description: 'First day the buyers own the unit.' })
  @IsDateString({ strict: true })
  transferDate!: string;

  @ApiProperty({ type: () => [TransferBuyerDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TransferBuyerDto)
  buyers!: TransferBuyerDto[];

  @ApiPropertyOptional({
    enum: TransferProrationName,
    enumName: 'TransferProration',
    description: 'Default the setting `juristic.transfer_proration` (carry_to_buyer).',
  })
  @IsOptional()
  @IsEnum(TransferProrationName)
  policy?: TransferProrationName;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class TransferResultDto {
  @ApiProperty({ type: () => OwnershipTransferDto })
  transfer!: OwnershipTransferDto;

  @ApiProperty({ type: () => RegisterUnitDetailDto })
  register!: RegisterUnitDetailDto;
}

export class BillToCreateDto {
  @ApiProperty({ format: 'uuid', description: 'A co-owner of the unit on `validFrom`.' })
  @IsUUID()
  ownerPartyId!: string;

  @ApiProperty({ type: () => PartyRefDto, description: 'The payer (existing or new party).' })
  @ValidateNested()
  @Type(() => PartyRefDto)
  payer!: PartyRefDto;

  @ApiProperty({ enum: BillToKindName, enumName: 'BillToKind', example: BillToKindName.NamedParty })
  @IsEnum(BillToKindName)
  kind!: BillToKindName;

  @ApiProperty({
    format: 'uuid',
    description: 'The owner’s signed consent (uploaded through `files/presign`, a document of the tenant).',
  })
  @IsUUID()
  consentDocumentId!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  consentNote?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Default today.' })
  @IsOptional()
  @IsDateString({ strict: true })
  validFrom?: string;
}

export class BillToEndDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'First day the owner is billed again (default today).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  validTo?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// ------------------------------------------------------------------------------------------- resolutions

export class ResolutionDocumentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  documentId!: string;

  @ApiProperty({ enum: ResolutionDocumentKindName, enumName: 'ResolutionDocumentKind', example: 'minutes' })
  kind!: ResolutionDocumentKindName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ResolutionDto {
  @ApiProperty({
    type: [String],
    example: ['adopt', 'void'],
    description: 'Actions the caller may take now.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ enum: MeetingKindName, enumName: 'MeetingKind', example: MeetingKindName.Agm })
  meetingKind!: MeetingKindName;

  @ApiProperty({ format: 'date', example: '2026-12-10' })
  meetingDate!: string;

  @ApiProperty({ example: '3/2569' })
  number!: string;

  @ApiProperty({ example: 'อนุมัติงบประมาณประจำปี 2570' })
  title!: string;

  @ApiProperty({ example: 'ที่ประชุมใหญ่มีมติอนุมัติงบประมาณประจำปี 2570 และอัตราค่าส่วนกลาง' })
  text!: string;

  @ApiProperty({ type: String, nullable: true, example: 'เห็นด้วย 182 ไม่เห็นด้วย 3 งดออกเสียง 5' })
  votesSummary!: string | null;

  @ApiProperty({
    enum: ResolutionStateName,
    enumName: 'ResolutionState',
    example: ResolutionStateName.Adopted,
  })
  state!: ResolutionStateName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  adoptedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  voidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  voidReason!: string | null;

  @ApiProperty({ type: () => [ResolutionDocumentDto] })
  documents!: ResolutionDocumentDto[];

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ResolutionListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ enum: ResolutionStateName, enumName: 'ResolutionState' })
  @IsOptional()
  @IsEnum(ResolutionStateName)
  state?: ResolutionStateName;
}

export class ResolutionCreateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ enum: MeetingKindName, enumName: 'MeetingKind' })
  @IsEnum(MeetingKindName)
  meetingKind!: MeetingKindName;

  @ApiProperty({ format: 'date', example: '2026-12-10' })
  @IsDateString({ strict: true })
  meetingDate!: string;

  @ApiProperty({ example: '3/2569', maxLength: 50 })
  @IsString()
  @Length(1, 50)
  number!: string;

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @Length(1, 300)
  title!: string;

  @ApiProperty({ maxLength: 20000, description: 'The resolution text as recorded in the minutes.' })
  @IsString()
  @Length(1, 20000)
  text!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  votesSummary?: string;
}

export class ResolutionUpdateDto {
  @ApiPropertyOptional({ enum: MeetingKindName, enumName: 'MeetingKind' })
  @IsOptional()
  @IsEnum(MeetingKindName)
  meetingKind?: MeetingKindName;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString({ strict: true })
  meetingDate?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  number?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  title?: string;

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @IsString()
  @Length(1, 20000)
  text?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  votesSummary?: string | null;

  @ApiPropertyOptional({ type: 'integer', example: 1 })
  @IsOptional()
  @IsInt()
  version?: number;
}

/** The void body is the shared `ReasonDto` (a reason, 1–500 characters). */
export { ReasonDto as ResolutionVoidDto } from './governance.dto';

export class ResolutionDocumentAddDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A document of the tenant (uploaded through `files/presign`).',
  })
  @IsUUID()
  documentId!: string;

  @ApiProperty({ enum: ResolutionDocumentKindName, enumName: 'ResolutionDocumentKind' })
  @IsEnum(ResolutionDocumentKindName)
  kind!: ResolutionDocumentKindName;
}

// ------------------------------------------------------------------------------------------- budgets

export class BudgetLineDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: BudgetLineKindName, enumName: 'BudgetLineKind', example: BudgetLineKindName.Expense })
  kind!: BudgetLineKindName;

  @ApiProperty({ example: 'ค่ารักษาความปลอดภัย' })
  label!: string;

  @MoneyOutput({ example: '480000.00', description: 'Annual amount.' })
  amount!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Chart of accounts (J2.1).',
  })
  accountId!: string | null;
}

export class BudgetDto {
  @ApiProperty({ type: [String], example: ['approve'], description: 'Actions the caller may take now.' })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: 'integer', example: 2027 })
  fiscalYear!: number;

  @ApiProperty({ example: 'งบประมาณประจำปี 2570' })
  name!: string;

  @ApiProperty({ format: 'date', example: '2027-01-01' })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2027-12-31' })
  periodEnd!: string;

  @ApiProperty({ enum: BudgetStateName, enumName: 'BudgetState', example: BudgetStateName.Draft })
  state!: BudgetStateName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  resolutionId!: string | null;

  @MoneyOutput({ example: '1234567.89', description: 'Σ expense + fund lines (what the owners pay for).' })
  total!: string;

  @MoneyOutput({ example: '120000.00', description: 'Σ income lines (shown, not deducted).' })
  incomeTotal!: string;

  @ApiProperty({ type: () => [BudgetLineDto] })
  lines!: BudgetLineDto[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  approvedAt!: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class BudgetLineInputDto {
  @ApiProperty({ enum: BudgetLineKindName, enumName: 'BudgetLineKind' })
  @IsEnum(BudgetLineKindName)
  kind!: BudgetLineKindName;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @Length(1, 200)
  label!: string;

  @MoneyInput({ example: '480000.00', description: 'Annual amount.' })
  amount!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class BudgetListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ type: 'integer', example: 2027 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2200)
  fiscalYear?: number;

  @ApiPropertyOptional({ enum: BudgetStateName, enumName: 'BudgetState' })
  @IsOptional()
  @IsEnum(BudgetStateName)
  state?: BudgetStateName;
}

export class BudgetCreateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ type: 'integer', example: 2027 })
  @IsInt()
  @Min(2000)
  @Max(2200)
  fiscalYear!: number;

  @ApiProperty({ maxLength: 200, example: 'งบประมาณประจำปี 2570' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ format: 'date', description: 'Default 1 January of the fiscal year.' })
  @IsOptional()
  @IsDateString({ strict: true })
  periodStart?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Default 31 December of the fiscal year.' })
  @IsOptional()
  @IsDateString({ strict: true })
  periodEnd?: string;

  @ApiProperty({ type: () => [BudgetLineInputDto] })
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => BudgetLineInputDto)
  lines!: BudgetLineInputDto[];
}

export class BudgetUpdateDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString({ strict: true })
  periodStart?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString({ strict: true })
  periodEnd?: string;

  @ApiPropertyOptional({ type: () => [BudgetLineInputDto], description: 'Replaces every line.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => BudgetLineInputDto)
  lines?: BudgetLineInputDto[];

  @ApiPropertyOptional({ type: 'integer', example: 1 })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class BudgetApproveDto {
  @ApiProperty({ format: 'uuid', description: 'An adopted resolution of the budget’s building.' })
  @IsUUID()
  resolutionId!: string;
}

export class RatePreviewRequestDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Budget lines to bill (default: every expense line for a common fee, every fund line for a fund).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @IsUUID('all', { each: true })
  lineIds?: string[];

  @ApiProperty({ enum: JuristicChargeKindName, enumName: 'JuristicChargeKind', example: 'common_fee' })
  @IsEnum(JuristicChargeKindName)
  kind!: JuristicChargeKindName;

  @ApiProperty({ enum: BudgetSplitByName, enumName: 'BudgetSplitBy', example: 'ownership_ratio' })
  @IsEnum(BudgetSplitByName)
  splitBy!: BudgetSplitByName;

  @ApiPropertyOptional({
    enum: BillingFrequencyName,
    enumName: 'BillingFrequency',
    description: 'Default: the frequency of the building’s default plan of the kind, else monthly.',
  })
  @IsOptional()
  @IsEnum(BillingFrequencyName)
  frequency?: BillingFrequencyName;
}

export class RatePreviewUnitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ example: '0.003215', description: 'The unit’s weight (ratio, m², ตร.วา or 1).' })
  weight!: string;

  @MoneyOutput({ example: '3968.74', description: 'Amount per cycle.' })
  amount!: string;
}

export class RatePreviewDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  budgetId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ enum: JuristicChargeKindName, enumName: 'JuristicChargeKind', example: 'common_fee' })
  kind!: JuristicChargeKindName;

  @ApiProperty({ enum: BudgetSplitByName, enumName: 'BudgetSplitBy', example: 'ownership_ratio' })
  splitBy!: BudgetSplitByName;

  @ApiProperty({ enum: BillingFrequencyName, enumName: 'BillingFrequency', example: 'quarterly' })
  frequency!: BillingFrequencyName;

  @MoneyOutput({ example: '1234567.89', description: 'Σ of the chosen budget lines (a year).' })
  annualAmount!: string;

  @MoneyOutput({ example: '308641.97', description: 'The amount one cycle bills (annual ÷ 12 × months).' })
  cycleAmount!: string;

  @MoneyOutput({ example: '2104.11', description: 'Smallest unit amount per cycle.' })
  min!: string;

  @MoneyOutput({ example: '3968.74', description: 'Median unit amount per cycle.' })
  median!: string;

  @MoneyOutput({ example: '7920.00', description: 'Largest unit amount per cycle.' })
  max!: string;

  @MoneyOutput({ example: '308641.97', description: 'Σ of the unit amounts.' })
  sum!: string;

  @ApiProperty({
    example: true,
    description: 'Σ units = the cycle amount to the satang (always, unless units lack the weight).',
  })
  sumMatches!: boolean;

  @ApiProperty({ type: 'integer', example: 312 })
  unitsCount!: number;

  @ApiProperty({
    type: [String],
    example: [],
    description: 'Units without the weight: the rate cannot be drafted until they have it.',
  })
  missingUnitIds!: string[];

  @ApiProperty({ type: () => [RatePreviewUnitDto] })
  units!: RatePreviewUnitDto[];

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The plan the draft goes to.',
  })
  ratePlanId!: string | null;
}

export class RateDraftCreateDto extends RatePreviewRequestDto {
  @ApiProperty({ format: 'date', example: '2027-01-01', description: 'Today or later; editable until then.' })
  @IsDateString({ strict: true })
  effectiveFrom!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Name of the plan when the building has none of the kind.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  planName?: string;
}

export class RateDraftDto {
  @ApiProperty({ type: () => RatePlanDto })
  plan!: RatePlanDto;

  @ApiProperty({ type: () => RatePreviewDto })
  preview!: RatePreviewDto;
}

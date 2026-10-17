import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
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

import { MoneyInput, MoneyOutput } from '../shared/fields';
import { LeasePartyRoleName, LeaseStatusName } from '../shared/status.enums';
import { LeaseLineKindName } from './assets.dto';
import { InvitationChannelName, InvitationStateName } from './tenancy.dto';

export { LeasePartyRoleName, LeaseStatusName };
export enum UtilityBillingModeName {
  Metered = 'metered',
  Included = 'included',
}
export enum LineRecurrenceName {
  Monthly = 'monthly',
  Once = 'once',
}
export enum SignerRoleName {
  Lessee = 'lessee',
  CoTenant = 'co_tenant',
  Lessor = 'lessor',
  Witness = 'witness',
}
export enum SignatureMethodName {
  DrawLiff = 'draw_liff',
  DrawWeb = 'draw_web',
  ScanUpload = 'scan_upload',
}
export enum NoticePartyName {
  Lessee = 'lessee',
  Lessor = 'lessor',
}
export enum AddendumClauseTypeName {
  HouseRules = 'house_rules',
  Pets = 'pets',
  Smoking = 'smoking',
  Guests = 'guests',
  QuietHours = 'quiet_hours',
  ParkingRules = 'parking_rules',
  FurnitureCare = 'furniture_care',
  Waste = 'waste',
  Other = 'other',
}
export enum LessorReasonName {
  LesseeBreach = 'lessee_breach',
  Disturbance = 'disturbance',
  EndOfTerm = 'end_of_term',
  MutualAgreement = 'mutual_agreement',
  UnlawfulUse = 'unlawful_use',
}
export enum TerminationReasonName {
  LesseeNotice = 'lessee_notice',
  LesseeBreach = 'lessee_breach',
  Disturbance = 'disturbance',
  EndOfTerm = 'end_of_term',
  MutualAgreement = 'mutual_agreement',
  UnlawfulUse = 'unlawful_use',
}
export enum ComplianceOutcomeName {
  Pass = 'pass',
  Warn = 'warn',
  Block = 'block',
}
export enum ComplianceSeverityName {
  Warn = 'warn',
  Block = 'block',
}
export enum LeaseInvitationChannelName {
  Sms = 'sms',
  LineQr = 'line_qr',
  Link = 'link',
}
export enum TemplateVersionStateName {
  Draft = 'draft',
  Published = 'published',
  Retired = 'retired',
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export class LeaseLineInputDto {
  @ApiProperty({ enum: LeaseLineKindName, enumName: 'LeaseLineKind', example: LeaseLineKindName.Internet })
  @IsEnum(LeaseLineKindName)
  kind!: LeaseLineKindName;

  @ApiProperty({ example: 'อินเทอร์เน็ตไฟเบอร์', description: 'Utilities are never fixed lines (D-022).' })
  @IsString()
  @Length(1, 200)
  description!: string;

  @MoneyInput({ example: '300.00', description: 'Amount per occurrence.' })
  amount!: string;

  @ApiPropertyOptional({
    enum: LineRecurrenceName,
    enumName: 'LineRecurrence',
    default: LineRecurrenceName.Monthly,
  })
  @IsOptional()
  @IsEnum(LineRecurrenceName)
  recurrence?: LineRecurrenceName;
}

export class LeaseLineDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: LeaseLineKindName, enumName: 'LeaseLineKind', example: LeaseLineKindName.Internet })
  kind!: LeaseLineKindName;

  @ApiProperty({ example: 'อินเทอร์เน็ตไฟเบอร์' })
  description!: string;

  @MoneyOutput({ example: '300.00', description: 'Amount per occurrence.' })
  amount!: string;

  @ApiProperty({ enum: LineRecurrenceName, enumName: 'LineRecurrence', example: LineRecurrenceName.Monthly })
  recurrence!: LineRecurrenceName;

  @ApiProperty({ format: 'date', example: FAKE.date })
  effectiveFrom!: string;
}

export class AddendumClauseDto {
  @ApiProperty({
    enum: AddendumClauseTypeName,
    enumName: 'AddendumClauseType',
    example: AddendumClauseTypeName.Pets,
    description:
      'Allowed clause types; forbidden clause types of the announcement are refused (compliance.forbidden_clause).',
  })
  @IsString()
  @MaxLength(50)
  type!: string;

  @ApiProperty({ example: 'สัตว์เลี้ยง' })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ example: 'อนุญาตแมวได้ 1 ตัว ผู้เช่ารับผิดชอบความสะอาด' })
  @IsString()
  @Length(1, 2000)
  text!: string;
}

export class RentIncreaseDto {
  @ApiProperty({ format: 'date', example: '2027-05-01', description: 'Inside the term, after its start.' })
  @Matches(DATE)
  effectiveFrom!: string;

  @MoneyInput({ example: '4800.00', description: 'Monthly rent from that date (agreed at signing, D-020).' })
  rent!: string;
}

export class LeaseCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  unitId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'A party of my tenant (D-151).' })
  @IsUUID()
  lesseePartyId!: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  coTenantPartyIds?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsUUID('all', { each: true })
  guarantorPartyIds?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  occupantPartyIds?: string[];

  @ApiProperty({ format: 'date', example: FAKE.date })
  @Matches(DATE)
  startDate!: string;

  @ApiPropertyOptional({
    type: 'integer',
    example: 12,
    minimum: 1,
    maximum: 360,
    description: 'Default 12; or give endDate.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(360)
  months?: number;

  @ApiPropertyOptional({ type: String, format: 'date', example: '2027-10-31' })
  @IsOptional()
  @Matches(DATE)
  endDate?: string;

  @MoneyInput({
    example: '4500.00',
    description: 'Monthly rent (default: the unit base rent).',
    optional: true,
  })
  rent?: string;

  @MoneyInput({
    example: '4500.00',
    description: 'Security deposit (default: rent × room-type months).',
    optional: true,
  })
  depositAmount?: string;

  @MoneyInput({
    example: '4500.00',
    description: 'Advance rent (default: rent × room-type months).',
    optional: true,
  })
  advanceRentAmount?: string;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    example: 5,
    minimum: 1,
    maximum: 28,
    description: 'Rent due day; null = property cut-off.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  billingDay?: number | null;

  @ApiPropertyOptional({
    enum: UtilityBillingModeName,
    enumName: 'UtilityBillingMode',
    default: UtilityBillingModeName.Metered,
  })
  @IsOptional()
  @IsEnum(UtilityBillingModeName)
  utilityBillingMode?: UtilityBillingModeName;

  @ApiPropertyOptional({ type: 'integer', example: 2, minimum: 0, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  keysCount?: number;

  @ApiPropertyOptional({ type: 'integer', example: 0, minimum: 0, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  parkingSlots?: number;

  @ApiPropertyOptional({ type: () => [LeaseLineInputDto], description: 'Default: the room type lines.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LeaseLineInputDto)
  lines?: LeaseLineInputDto[];

  @ApiPropertyOptional({ type: () => [AddendumClauseDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AddendumClauseDto)
  addendum?: AddendumClauseDto[];

  @ApiPropertyOptional({
    type: () => [RentIncreaseDto],
    description: 'The only lawful mid-term increases (D-020).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => RentIncreaseDto)
  rentIncreases?: RentIncreaseDto[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { petsAllowed: true },
    description: 'Agreed terms not modelled elsewhere.',
  })
  @IsOptional()
  @IsObject()
  terms?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: [],
    description: 'Acknowledgements of compliance warnings (D-021a).',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  acknowledgementIds?: string[];
}

export class LeaseUpdateDto {
  @ApiPropertyOptional({ type: String, format: 'date', example: FAKE.date })
  @IsOptional()
  @Matches(DATE)
  startDate?: string;

  @ApiPropertyOptional({ type: 'integer', example: 12, minimum: 1, maximum: 360 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(360)
  months?: number;

  @ApiPropertyOptional({ type: String, format: 'date', example: '2027-10-31' })
  @IsOptional()
  @Matches(DATE)
  endDate?: string;

  @MoneyInput({ example: '4500.00', description: 'Monthly rent.', optional: true })
  rent?: string;

  @MoneyInput({ example: '4500.00', description: 'Security deposit.', optional: true })
  depositAmount?: string;

  @MoneyInput({ example: '4500.00', description: 'Advance rent.', optional: true })
  advanceRentAmount?: string;

  @ApiPropertyOptional({ type: 'integer', nullable: true, example: 5, minimum: 1, maximum: 28 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  billingDay?: number | null;

  @ApiPropertyOptional({ enum: UtilityBillingModeName, enumName: 'UtilityBillingMode' })
  @IsOptional()
  @IsEnum(UtilityBillingModeName)
  utilityBillingMode?: UtilityBillingModeName;

  @ApiPropertyOptional({ type: 'integer', example: 2, minimum: 0, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  keysCount?: number;

  @ApiPropertyOptional({ type: 'integer', example: 1, minimum: 0, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  parkingSlots?: number;

  @ApiPropertyOptional({ type: () => [LeaseLineInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LeaseLineInputDto)
  lines?: LeaseLineInputDto[];

  @ApiPropertyOptional({ type: () => [AddendumClauseDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AddendumClauseDto)
  addendum?: AddendumClauseDto[];

  @ApiPropertyOptional({ type: () => [RentIncreaseDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => RentIncreaseDto)
  rentIncreases?: RentIncreaseDto[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, example: { petsAllowed: false } })
  @IsOptional()
  @IsObject()
  terms?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  acknowledgementIds?: string[];
}

export class LeaseListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: LeaseStatusName, enumName: 'LeaseStatus' })
  @IsOptional()
  @IsEnum(LeaseStatusName)
  status?: LeaseStatusName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partyId?: string;
}

export class LeasePartyViewDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: FAKE.nameTh,
    description: 'null on another tenant’s lease (D-152).',
  })
  displayName!: string | null;

  @ApiProperty({ enum: LeasePartyRoleName, enumName: 'LeasePartyRole', example: LeasePartyRoleName.Lessee })
  role!: LeasePartyRoleName;

  @ApiProperty({ example: true })
  isSigner!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  signedAt!: string | null;
}

export class LeaseSignatureViewDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: SignerRoleName, enumName: 'SignerRole', example: SignerRoleName.Lessee })
  signerRole!: SignerRoleName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  partyId!: string | null;

  @ApiProperty({
    enum: SignatureMethodName,
    enumName: 'SignatureMethod',
    example: SignatureMethodName.DrawLiff,
  })
  method!: SignatureMethodName;

  @ApiProperty({ example: true, description: 'Signed from a LINE-linked login (D-062).' })
  lineLinked!: boolean;

  @ApiProperty({ example: true, description: 'Phone OTP verified (residents).' })
  otpVerified!: boolean;

  @ApiProperty({
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    description: 'sha256 of the PDF signed.',
  })
  pdfSha256!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  signedAt!: string;
}

export class LeaseNoticeViewDto {
  @ApiProperty({ enum: NoticePartyName, enumName: 'NoticeParty', example: NoticePartyName.Lessee })
  by!: NoticePartyName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  givenAt!: string;

  @ApiProperty({ type: String, nullable: true, example: 'lessee_notice' })
  reasonCode!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-01-31' })
  effectiveDate!: string | null;

  @ApiProperty({ type: [String], format: 'uuid', example: [] })
  evidenceDocumentIds!: string[];
}

export class LeaseTerminationViewDto {
  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  terminatedAt!: string;

  @ApiProperty({ example: 'mutual_agreement' })
  reasonCode!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ type: [String], format: 'uuid', example: [FAKE.uuid] })
  evidenceDocumentIds!: string[];
}

export class ComplianceCheckViewDto {
  @ApiProperty({ example: 'compliance.deposit_cap' })
  ruleId!: string;

  @ApiProperty({
    enum: ComplianceOutcomeName,
    enumName: 'ComplianceOutcome',
    example: ComplianceOutcomeName.Pass,
  })
  outcome!: ComplianceOutcomeName;

  @ApiProperty({
    enum: ComplianceSeverityName,
    enumName: 'ComplianceSeverity',
    example: ComplianceSeverityName.Block,
  })
  severity!: ComplianceSeverityName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  acknowledgementId!: string | null;
}

export class LeaseComplianceViewDto {
  @ApiProperty({ example: true, description: 'The tenant is in scope of the announcement (D-158).' })
  inScope!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  evaluatedAt!: string | null;

  @ApiProperty({ type: () => [ComplianceCheckViewDto] })
  checks!: ComplianceCheckViewDto[];
}

export class LeaseContractViewDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  documentId!: string;

  @ApiProperty({ example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' })
  sha256!: string;

  @ApiProperty({ example: false, description: 'true once both parties signed.' })
  signed!: boolean;
}

export class LeaseDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CTR-2026-00001',
    description: 'From the contract series, at send-for-signature.',
  })
  number!: string | null;

  @ApiProperty({ enum: LeaseStatusName, enumName: 'LeaseStatus', example: LeaseStatusName.Active })
  status!: LeaseStatusName;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'อาคาร A',
    description: 'null for a unit grantee (D-152).',
  })
  buildingName!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  lesseePartyId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: FAKE.nameTh,
    description: 'null on another tenant’s lease (D-152).',
  })
  lesseeName!: string | null;

  @ApiProperty({ type: () => [LeasePartyViewDto] })
  parties!: LeasePartyViewDto[];

  @ApiProperty({ format: 'date', example: FAKE.date })
  startDate!: string;

  @ApiProperty({ format: 'date', example: '2027-10-31' })
  endDate!: string;

  @ApiProperty({ type: 'integer', example: 12 })
  months!: number;

  @MoneyOutput({ example: '4500.00', description: 'Monthly rent.' })
  rent!: string;

  @MoneyOutput({ example: '4500.00', description: 'Security deposit.' })
  depositAmount!: string;

  @MoneyOutput({ example: '4500.00', description: 'Advance rent.' })
  advanceRentAmount!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ type: 'integer', nullable: true, example: 5 })
  billingDay!: number | null;

  @ApiProperty({
    enum: UtilityBillingModeName,
    enumName: 'UtilityBillingMode',
    example: UtilityBillingModeName.Metered,
  })
  utilityBillingMode!: UtilityBillingModeName;

  @ApiProperty({ type: 'integer', example: 2 })
  keysCount!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  parkingSlots!: number;

  @ApiProperty({ type: () => [LeaseLineDto] })
  lines!: LeaseLineDto[];

  @ApiProperty({ type: () => [AddendumClauseDto] })
  addendum!: AddendumClauseDto[];

  @ApiProperty({ type: () => [RentIncreaseDto] })
  rentIncreases!: RentIncreaseDto[];

  @ApiProperty({ type: 'object', additionalProperties: true, example: { petsAllowed: true } })
  terms!: Record<string, unknown>;

  @ApiProperty({ type: () => LeaseNoticeViewDto, nullable: true })
  notice!: LeaseNoticeViewDto | null;

  @ApiProperty({ type: () => LeaseTerminationViewDto, nullable: true })
  termination!: LeaseTerminationViewDto | null;

  @ApiProperty({ type: () => [LeaseSignatureViewDto] })
  signatures!: LeaseSignatureViewDto[];

  @ApiProperty({ type: () => LeaseContractViewDto, nullable: true })
  contract!: LeaseContractViewDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  moveInAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  moveOutAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  renewedFromLeaseId!: string | null;

  @ApiProperty({ type: () => LeaseComplianceViewDto })
  compliance!: LeaseComplianceViewDto;

  @ApiProperty({ type: [String], example: ['record-notice', 'begin-move-out', 'terminate', 'renew'] })
  nextActions!: string[];

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: 'integer', example: 1, description: 'Aggregate version (ETag).' })
  version!: number;
}

export class CountersignDto {
  @ApiProperty({
    example: PNG_BASE64,
    description: 'The lessor’s drawn signature: base64 PNG, at most 200 KB (D-062).',
  })
  @IsString()
  @IsBase64()
  @MaxLength(280_000)
  signaturePng!: string;
}

export class CancelLeaseDto {
  @ApiProperty({ example: 'ผู้เช่าเปลี่ยนใจไม่เช่า' })
  @IsString()
  @Length(3, 500)
  cancelReason!: string;
}

export class RecordNoticeDto {
  @ApiProperty({ enum: NoticePartyName, enumName: 'NoticeParty', example: NoticePartyName.Lessee })
  @IsEnum(NoticePartyName)
  by!: NoticePartyName;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: FAKE.date,
    description: 'Date of the written notice (default today).',
  })
  @IsOptional()
  @Matches(DATE)
  noticeDate?: string;

  @ApiProperty({ format: 'date', example: '2026-12-31', description: 'Move-out / termination date.' })
  @Matches(DATE)
  effectiveDate!: string;

  @ApiPropertyOptional({
    enum: LessorReasonName,
    enumName: 'LessorReason',
    description: 'Required for a lessor notice (ข้อ 4 (12)).',
  })
  @IsOptional()
  @IsEnum(LessorReasonName)
  reasonCode?: LessorReasonName;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: [],
    description: 'Uploaded files: the written notice, photos.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  evidenceDocumentIds?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  acknowledgementIds?: string[];
}

export class CompleteMoveOutDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'Default now; never in the future.',
  })
  @IsOptional()
  @IsDateString()
  moveOutAt?: string;
}

export class TerminateLeaseDto {
  @ApiProperty({
    enum: TerminationReasonName,
    enumName: 'TerminationReason',
    example: TerminationReasonName.MutualAgreement,
  })
  @IsEnum(TerminationReasonName)
  reasonCode!: TerminationReasonName;

  @ApiProperty({ format: 'date', example: FAKE.date })
  @Matches(DATE)
  effectiveDate!: string;

  @ApiPropertyOptional({ type: String, format: 'date', example: '2026-10-01' })
  @IsOptional()
  @Matches(DATE)
  noticeDate?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ตกลงเลิกสัญญาร่วมกัน' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [FAKE.uuid] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  evidenceDocumentIds?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  acknowledgementIds?: string[];
}

export class RenewLeaseDto {
  @ApiPropertyOptional({ type: 'integer', example: 12, minimum: 1, maximum: 360 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(360)
  months?: number;

  @MoneyInput({
    example: '4700.00',
    description: 'Rent of the new term (default: unchanged).',
    optional: true,
  })
  rent?: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  acknowledgementIds?: string[];
}

export class LeaseEventDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'sent_for_signature' })
  type!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  occurredAt!: string;

  @ApiProperty({ example: 'user', description: 'user | system | webhook | device' })
  actorType!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { number: 'CTR-2026-00001' } })
  data!: Record<string, unknown>;
}

export class ContractDownloadDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  documentId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'CTR-2026-00001' })
  number!: string | null;

  @ApiProperty({
    example: 'https://storage.example.com/contract.pdf?X-Amz-Signature=abc',
    description: 'Valid 5 minutes.',
  })
  url!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:20:00+07:00' })
  expiresAt!: string;

  @ApiProperty({
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    description: 'sha256 of this PDF — the value a resident signs.',
  })
  sha256!: string;

  @ApiProperty({ example: false })
  signed!: boolean;
}

export class LeaseInvitationCreateDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    example: FAKE.uuid,
    description: 'A party of this lease (default: the lessee).',
  })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiProperty({
    enum: LeaseInvitationChannelName,
    enumName: 'LeaseInvitationChannel',
    example: LeaseInvitationChannelName.LineQr,
  })
  @IsEnum(LeaseInvitationChannelName)
  channel!: LeaseInvitationChannelName;

  @ApiPropertyOptional({ example: 'th' })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: string;
}

export class LeaseInvitationDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  partyId!: string | null;

  @ApiProperty({
    enum: InvitationChannelName,
    enumName: 'InvitationChannel',
    example: InvitationChannelName.LineQr,
  })
  channel!: InvitationChannelName;

  @ApiProperty({
    enum: InvitationStateName,
    enumName: 'InvitationState',
    example: InvitationStateName.Pending,
  })
  state!: InvitationStateName;

  @ApiProperty({ format: 'date-time', example: '2026-11-08T00:15:00+07:00' })
  expiresAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  acceptedAt!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class LeaseInvitationCreatedDto extends LeaseInvitationDto {
  @ApiProperty({ example: 'ABCD-EFGH-JKLM-NPQR', description: 'Shown once; never stored in clear.' })
  code!: string;

  @ApiProperty({ example: 'https://liff.getproperty.invalid/link?code=ABCD-EFGH-JKLM-NPQR' })
  url!: string;

  @ApiProperty({
    example: `data:image/png;base64,${PNG_BASE64}`,
    description: 'QR of the URL for LINE (PNG data URL).',
  })
  qrPngDataUrl!: string;
}

export class LeaseTemplateVersionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({ example: 'th' })
  language!: string;

  @ApiProperty({
    enum: TemplateVersionStateName,
    enumName: 'TemplateVersionState',
    example: TemplateVersionStateName.Published,
  })
  state!: TemplateVersionStateName;

  @ApiProperty({ format: 'date', example: '2025-09-04' })
  effectiveFrom!: string;

  @ApiProperty({ example: 'ประกาศคณะกรรมการว่าด้วยสัญญา … พ.ศ. 2568 ข้อ 4–6' })
  legalRef!: string;

  @ApiProperty({ type: [String], example: ['renewal_fee', 'lockout_or_removal'] })
  forbiddenClauseTypes!: string[];

  @ApiProperty({
    enum: AddendumClauseTypeName,
    enumName: 'AddendumClauseType',
    isArray: true,
    example: ['house_rules', 'pets'],
  })
  allowedClauseTypes!: AddendumClauseTypeName[];
}

export class LeaseTemplateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'ocpb_2568_residential_th' })
  key!: string;

  @ApiProperty({ example: 'สัญญาเช่าอาคารเพื่ออยู่อาศัย (แบบมาตรฐาน สคบ. 2568)' })
  name!: string;

  @ApiProperty({ example: true, description: 'Platform standard contract (D-020).' })
  platform!: boolean;

  @ApiProperty({ type: () => [LeaseTemplateVersionDto] })
  versions!: LeaseTemplateVersionDto[];
}

// ------------------------------------------------------------------------------------------- resident

export class ResidentLeaseDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'CTR-2026-00001' })
  number!: string | null;

  @ApiProperty({ enum: LeaseStatusName, enumName: 'LeaseStatus', example: LeaseStatusName.PendingSignature })
  status!: LeaseStatusName;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'date', example: FAKE.date })
  startDate!: string;

  @ApiProperty({ format: 'date', example: '2027-10-31' })
  endDate!: string;

  @ApiProperty({ type: 'integer', example: 12 })
  months!: number;

  @MoneyOutput({ example: '4500.00', description: 'Monthly rent.' })
  rent!: string;

  @MoneyOutput({ example: '4500.00', description: 'Security deposit.' })
  depositAmount!: string;

  @MoneyOutput({ example: '4500.00', description: 'Advance rent.' })
  advanceRentAmount!: string;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({
    enum: UtilityBillingModeName,
    enumName: 'UtilityBillingMode',
    example: UtilityBillingModeName.Metered,
  })
  utilityBillingMode!: UtilityBillingModeName;

  @ApiProperty({ type: () => [LeaseLineDto] })
  lines!: LeaseLineDto[];

  @ApiProperty({ type: () => [AddendumClauseDto] })
  addendum!: AddendumClauseDto[];

  @ApiProperty({ type: () => [LeasePartyViewDto] })
  parties!: LeasePartyViewDto[];

  @ApiProperty({ type: () => LeaseNoticeViewDto, nullable: true })
  notice!: LeaseNoticeViewDto | null;

  @ApiProperty({ example: true, description: 'I still have to sign this lease.' })
  signatureRequired!: boolean;

  @ApiProperty({ example: true, description: 'A contract PDF is available.' })
  contractAvailable!: boolean;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-12-01',
    description:
      'Earliest move-out date the notice form may offer: today (Asia/Bangkok) + the lessee notice period of ข้อ 4 (11) (`compliance.notice_period`, 30 days) while `give-notice` is offered; null otherwise. The client never computes it.',
  })
  noticeEarliestDate!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description:
      'When one of my parties acknowledged the building rules of the addendum (`house_rules`, `pets`, `smoking`, `guests`, `quiet_hours`, `parking_rules`, `waste`); null until then. `acknowledge-rules` is offered while it is null and the lease has rule clauses.',
  })
  rulesAcknowledgedAt!: string | null;

  @ApiProperty({ type: [String], example: ['view-contract', 'sign', 'acknowledge-rules'] })
  nextActions!: string[];
}

export class ResidentSignatureOtpRequestDto {
  @ApiPropertyOptional({ example: 'th' })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: string;
}

export class ResidentSignatureOtpDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  challengeId!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:20:00+07:00' })
  expiresAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:16:00+07:00' })
  resendAvailableAt!: string;

  @ApiProperty({
    example: '+66•••••1234',
    description: 'Where the code went (the phone the office recorded).',
  })
  phoneMasked!: string;
}

export class ResidentSignDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  challengeId!: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/)
  code!: string;

  @ApiProperty({
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    description:
      'sha256 of the contract PDF I read (from `GET …/contract`); a different value means the contract changed.',
  })
  @Matches(/^[0-9a-fA-F]{64}$/)
  contractSha256!: string;

  @ApiProperty({ example: PNG_BASE64, description: 'Drawn signature, base64 PNG ≤ 200 KB.' })
  @IsString()
  @IsBase64()
  @MaxLength(280_000)
  signaturePng!: string;
}

export class ResidentNoticeDto {
  @ApiProperty({
    format: 'date',
    example: '2026-12-31',
    description: 'My move-out date: at least 30 days from today (ข้อ 4 (11)).',
  })
  @Matches(DATE)
  effectiveDate!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ย้ายที่ทำงาน' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class InvitationPreviewDto {
  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ example: 'ผู้••••••', description: 'Masked name of the invited party.' })
  partyDisplayName!: string;

  @ApiProperty({ enum: LeaseStatusName, enumName: 'LeaseStatus', example: LeaseStatusName.PendingSignature })
  leaseStatus!: LeaseStatusName;

  @ApiProperty({ format: 'date', example: FAKE.date })
  startDate!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-08T00:15:00+07:00' })
  expiresAt!: string;
}

export class InvitationAcceptedDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({
    example: true,
    description: 'Call `POST /v1/auth/refresh` to receive the new `lease:` scope.',
  })
  refreshRequired!: boolean;

  @ApiProperty({ format: 'date', example: FAKE.date })
  acceptedOn!: string;
}

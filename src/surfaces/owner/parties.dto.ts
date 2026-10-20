import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ToE164 } from '../shared/auth.dto';
import { ConsentPurposeDto, DsrDto } from './governance.dto';
import { AddressDto } from './tenancy.dto';

export enum PartyTypeName {
  Person = 'person',
  Company = 'company',
}
export enum IdDocumentTypeName {
  ThaiNationalId = 'thai_national_id',
  Passport = 'passport',
  Other = 'other',
}
export enum PartyLinkViaName {
  Invitation = 'invitation',
  LineMatch = 'line_match',
  PhoneMatch = 'phone_match',
  Integration = 'integration',
  Admin = 'admin',
}
export enum PartyLinkStateName {
  Active = 'active',
  Unlinked = 'unlinked',
}
export enum RevealFieldName {
  IdNumber = 'idNumber',
  EmergencyContactPhone = 'emergencyContactPhone',
}
export enum ResidentLanguageName {
  Th = 'th',
  En = 'en',
  My = 'my',
  Km = 'km',
  Lo = 'lo',
  Zh = 'zh',
}
export enum HeldFieldName {
  Name = 'name',
  Phone = 'phone',
  Email = 'email',
  LineId = 'line_id',
  IdNumber = 'id_number',
  IdDocumentImage = 'id_document_image',
  DateOfBirth = 'date_of_birth',
  Address = 'address',
  EmergencyContact = 'emergency_contact',
  Tm30 = 'tm30',
}

const PHONE = /^\+[1-9]\d{6,14}$/;
const ID_NUMBER = /^[0-9A-Za-z][0-9A-Za-z -]{4,24}$/;
const COUNTRY = /^[A-Z]{2}$/;

export class EmergencyContactDto {
  @ApiProperty({ example: 'ญาติ ทดสอบ' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ example: 'พี่สาว' })
  @IsString()
  @Length(1, 50)
  relation!: string;

  @ApiProperty({ example: '+66810001234', description: 'Sealed with the tenant data key (D-148).' })
  @ToE164()
  @IsString()
  @Matches(PHONE)
  phone!: string;
}

export class EmergencyContactViewDto {
  @ApiProperty({ example: 'ญาติ ทดสอบ' })
  name!: string;

  @ApiProperty({ example: 'พี่สาว' })
  relation!: string;

  @ApiProperty({
    example: true,
    description: 'The phone is stored sealed; reveal it with `actions/reveal-pii`.',
  })
  phoneOnFile!: boolean;
}

export class OccupantProfileDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Non-B', description: 'TM30 (D-052).' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  visaType?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: FAKE.date })
  @IsOptional()
  @IsDateString({ strict: true })
  arrivalDate?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'สุวรรณภูมิ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entryPort?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'JP' })
  @IsOptional()
  @Matches(COUNTRY)
  passportIssuedCountry?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'พนักงานบริษัท' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  occupation?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class PartyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: PartyTypeName, enumName: 'PartyType', example: PartyTypeName.Person })
  type!: PartyTypeName;

  @ApiProperty({ example: FAKE.nameTh })
  displayName!: string;

  @ApiProperty({ type: String, nullable: true, example: 'ผู้เช่า' })
  firstName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ทดสอบ' })
  lastName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  companyName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Companies only.' })
  taxId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+66810001234' })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.email })
  email!: string | null;

  @ApiProperty({ example: true, description: 'A LINE user id is recorded on the party.' })
  lineLinked!: boolean;

  @ApiProperty({ enum: ResidentLanguageName, enumName: 'ResidentLanguage', example: ResidentLanguageName.Th })
  language!: ResidentLanguageName;

  @ApiProperty({ type: String, nullable: true, example: 'TH' })
  nationality!: string | null;

  @ApiProperty({
    enum: IdDocumentTypeName,
    enumName: 'IdDocumentType',
    nullable: true,
    example: IdDocumentTypeName.ThaiNationalId,
  })
  idDocumentType!: IdDocumentTypeName | null;

  @ApiProperty({ type: String, nullable: true, example: 'TH' })
  idDocumentCountry!: string | null;

  @ApiProperty({
    example: true,
    description: 'An ID/passport number is stored sealed (never returned here, D-148).',
  })
  idNumberOnFile!: boolean;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2030-01-31' })
  idExpiresOn!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  dateOfBirth!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'M, F or X (TM30).' })
  gender!: string | null;

  @ApiProperty({ type: () => AddressDto, nullable: true })
  address!: AddressDto | null;

  @ApiProperty({ type: () => EmergencyContactViewDto, nullable: true })
  emergencyContact!: EmergencyContactViewDto | null;

  @ApiProperty({ type: () => OccupantProfileDto, nullable: true })
  occupantProfile!: OccupantProfileDto | null;

  @ApiProperty({ type: 'integer', example: 1, description: 'Active resident logins linked to the party.' })
  linkedLogins!: number;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ example: false, description: 'PDPA erasure done (personal fields cleared).' })
  anonymised!: boolean;

  @ApiProperty({ type: 'integer', example: 1, description: 'Aggregate version (ETag).' })
  version!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class PartyCreateDto {
  @ApiProperty({ enum: PartyTypeName, enumName: 'PartyType', example: PartyTypeName.Person })
  @IsEnum(PartyTypeName)
  type!: PartyTypeName;

  @ApiProperty({ example: FAKE.nameTh })
  @IsString()
  @Length(1, 200)
  displayName!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ผู้เช่า' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ทดสอบ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: FAKE.taxId })
  @IsOptional()
  @Matches(/^\d{13}$/)
  taxId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+66810001234',
    description: 'E.164 or Thai local form.',
  })
  @IsOptional()
  @ToE164()
  @IsString()
  @Matches(PHONE)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: FAKE.email })
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string | null;

  @ApiPropertyOptional({
    enum: ResidentLanguageName,
    enumName: 'ResidentLanguage',
    default: ResidentLanguageName.Th,
  })
  @IsOptional()
  @IsEnum(ResidentLanguageName)
  language?: ResidentLanguageName;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'TH' })
  @IsOptional()
  @Matches(COUNTRY)
  nationality?: string | null;

  @ApiPropertyOptional({ enum: IdDocumentTypeName, enumName: 'IdDocumentType', nullable: true })
  @IsOptional()
  @IsEnum(IdDocumentTypeName)
  idDocumentType?: IdDocumentTypeName | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: FAKE.nationalId,
    description:
      'ID card or passport number — optional until the contract is signed (D-025); sealed with the tenant data key, never returned (D-148). Thai national ids must pass the checksum.',
  })
  @IsOptional()
  @IsString()
  @Matches(ID_NUMBER)
  idNumber?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'TH' })
  @IsOptional()
  @Matches(COUNTRY)
  idDocumentCountry?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2030-01-31' })
  @IsOptional()
  @IsDateString({ strict: true })
  idExpiresOn?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: null })
  @IsOptional()
  @IsDateString({ strict: true })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsIn(['M', 'F', 'X'])
  gender?: string | null;

  @ApiPropertyOptional({ type: () => AddressDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto | null;

  @ApiPropertyOptional({ type: () => EmergencyContactDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EmergencyContactDto)
  emergencyContact?: EmergencyContactDto | null;

  @ApiPropertyOptional({ type: () => OccupantProfileDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => OccupantProfileDto)
  occupantProfile?: OccupantProfileDto | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class PartyUpdateDto {
  @ApiPropertyOptional({ example: FAKE.nameTh })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  displayName?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ผู้เช่า' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ทดสอบ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '+66810001235' })
  @IsOptional()
  @ToE164()
  @IsString()
  @Matches(PHONE)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: FAKE.email })
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string | null;

  @ApiPropertyOptional({ enum: ResidentLanguageName, enumName: 'ResidentLanguage' })
  @IsOptional()
  @IsEnum(ResidentLanguageName)
  language?: ResidentLanguageName;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'TH' })
  @IsOptional()
  @Matches(COUNTRY)
  nationality?: string | null;

  @ApiPropertyOptional({ enum: IdDocumentTypeName, enumName: 'IdDocumentType', nullable: true })
  @IsOptional()
  @IsEnum(IdDocumentTypeName)
  idDocumentType?: IdDocumentTypeName | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: FAKE.nationalId,
    description: 'Sealed (D-148).',
  })
  @IsOptional()
  @IsString()
  @Matches(ID_NUMBER)
  idNumber?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'TH' })
  @IsOptional()
  @Matches(COUNTRY)
  idDocumentCountry?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2031-01-31' })
  @IsOptional()
  @IsDateString({ strict: true })
  idExpiresOn?: string | null;

  @ApiPropertyOptional({ type: () => EmergencyContactDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EmergencyContactDto)
  emergencyContact?: EmergencyContactDto | null;

  @ApiPropertyOptional({ type: () => OccupantProfileDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OccupantProfileDto)
  occupantProfile?: OccupantProfileDto;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'โทรหลัง 18:00' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class PartyListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: PartyTypeName, enumName: 'PartyType' })
  @IsOptional()
  @IsEnum(PartyTypeName)
  type?: PartyTypeName;
}

export class RevealPiiDto {
  @ApiProperty({ enum: RevealFieldName, enumName: 'RevealField', isArray: true, example: ['idNumber'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(RevealFieldName, { each: true })
  fields!: RevealFieldName[];

  @ApiProperty({ example: 'ตรวจสอบตัวตนก่อนทำสัญญา', description: 'Recorded in the audit log (D-148).' })
  @IsString()
  @Length(3, 200)
  purpose!: string;
}

export class RevealedPiiDto {
  @ApiProperty({ type: String, nullable: true, example: FAKE.nationalId })
  idNumber!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  emergencyContactPhone!: string | null;
}

export class PartyLinkDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'core.user_account of the resident.' })
  userId!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.nameTh })
  userDisplayName!: string | null;

  @ApiProperty({ example: true })
  lineLinked!: boolean;

  @ApiProperty({ enum: PartyLinkViaName, enumName: 'PartyLinkVia', example: PartyLinkViaName.Invitation })
  linkedVia!: PartyLinkViaName;

  @ApiProperty({ enum: PartyLinkStateName, enumName: 'PartyLinkState', example: PartyLinkStateName.Active })
  state!: PartyLinkStateName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  linkedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  unlinkedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  unlinkReason!: string | null;
}

export class UnlinkDto {
  @ApiProperty({
    example: 'ผู้เช่าเปลี่ยนบัญชี LINE',
    description: 'Why the Owner approves the unlink (audited).',
  })
  @IsString()
  @Length(3, 300)
  unlinkReason!: string;
}

export class PrivacyPartyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  displayName!: string;

  @ApiProperty({
    enum: HeldFieldName,
    enumName: 'HeldField',
    isArray: true,
    example: ['name', 'phone', 'id_number'],
  })
  fieldsHeld!: HeldFieldName[];
}

export class PrivacyControllerDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({ example: FAKE.companyName, description: 'The data controller (D-025).' })
  legalName!: string;

  @ApiProperty({ type: () => [PrivacyPartyDto] })
  parties!: PrivacyPartyDto[];
}

export class PrivacyUserDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: FAKE.nameTh })
  displayName!: string;
}

export class ResidentPrivacyDto {
  @ApiProperty({ type: () => PrivacyUserDto })
  user!: PrivacyUserDto;

  @ApiProperty({
    type: () => [PrivacyControllerDto],
    description:
      'Each tenant that holds data about me as controller, with the categories held per party (D-025).',
  })
  controllers!: PrivacyControllerDto[];

  @ApiProperty({ type: () => [ConsentPurposeDto] })
  consents!: ConsentPurposeDto[];

  @ApiProperty({ example: true, description: 'Every required purpose is granted in its current version.' })
  consentComplete!: boolean;

  @ApiProperty({
    type: () => [DsrDto],
    description: 'My PDPA requests (file new ones at /v1/resident/data-subject-requests).',
  })
  requests!: DsrDto[];
}

/** `ops.party_link_request_state` (D-226). */
export enum PartyLinkRequestStateName {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Rejected = 'rejected',
}

export class PartyLinkRequestDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  partyDisplayName!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The login that signed in with the SMS code sent to the party’s phone.',
  })
  userId!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.nameTh })
  userDisplayName!: string | null;

  @ApiProperty({ example: false, description: 'The login also signed in with LINE.' })
  lineLinked!: boolean;

  @ApiProperty({ example: 'phone_match', description: 'How the login matched the party (`phone_match`).' })
  via!: string;

  @ApiProperty({
    enum: PartyLinkRequestStateName,
    enumName: 'PartyLinkRequestState',
    example: PartyLinkRequestStateName.Pending,
  })
  state!: PartyLinkRequestStateName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  requestedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  rejectReason!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The link created on confirmation (`linkedVia: admin`).',
  })
  linkId!: string | null;
}

export class PartyLinkRequestListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: PartyLinkRequestStateName, enumName: 'PartyLinkRequestState' })
  @IsOptional()
  @IsEnum(PartyLinkRequestStateName)
  state?: PartyLinkRequestStateName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partyId?: string;
}

export class RejectLinkRequestDto {
  @ApiProperty({
    example: 'ไม่ใช่ผู้เช่าห้องนี้ เบอร์โทรพิมพ์ผิด',
    description: 'Why the match is refused (audited).',
  })
  @IsString()
  @Length(3, 300)
  reason!: string;
}

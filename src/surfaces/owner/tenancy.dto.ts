import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { TenantRoleName, TenantStatusName, TenantTypeName } from '../shared/me.dto';

export enum TenantLegalFormName {
  Person = 'person',
  Company = 'company',
  JuristicPerson = 'juristic_person',
}

export enum MembershipStatusName {
  Invited = 'invited',
  Active = 'active',
  Suspended = 'suspended',
  Removed = 'removed',
}

export enum InvitationChannelName {
  Sms = 'sms',
  LineQr = 'line_qr',
  Email = 'email',
  Link = 'link',
}

export enum InvitationStateName {
  Pending = 'pending',
  Accepted = 'accepted',
  Expired = 'expired',
  Revoked = 'revoked',
}

export class AddressDto {
  @ApiProperty({ example: FAKE.addressLine })
  @IsString()
  @Length(1, 200)
  line1!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string | null;

  @ApiPropertyOptional({ example: 'แขวงตัวอย่าง' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  subdistrict?: string;

  @ApiPropertyOptional({ example: 'เขตตัวอย่าง' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  district?: string;

  @ApiProperty({ example: 'กรุงเทพมหานคร' })
  @IsString()
  @Length(1, 100)
  province!: string;

  @ApiProperty({ example: FAKE.postcode })
  @IsString()
  @Matches(/^\d{5}$/)
  postcode!: string;

  @ApiProperty({ example: 'TH' })
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  country!: string;
}

export class TenantProfileDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  id!: string;

  @ApiProperty({ enum: TenantTypeName, enumName: 'TenantType', example: TenantTypeName.Apartment })
  type!: TenantTypeName;

  @ApiProperty({ example: 'sample-dormitory' })
  slug!: string;

  @ApiProperty({ example: FAKE.propertyName })
  displayName!: string;

  @ApiProperty({ example: FAKE.companyName })
  legalName!: string;

  @ApiProperty({
    enum: TenantLegalFormName,
    enumName: 'TenantLegalForm',
    example: TenantLegalFormName.Company,
  })
  legalForm!: TenantLegalFormName;

  @ApiProperty({ type: String, nullable: true, example: FAKE.taxId })
  taxId!: string | null;

  @ApiProperty({ example: false, description: 'VAT documents only when true (O-004).' })
  vatRegistered!: boolean;

  @ApiProperty({ type: () => AddressDto, nullable: true })
  address!: AddressDto | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'A `logo` file (core.document).',
  })
  logoDocumentId!: string | null;

  @ApiProperty({ example: 'th' })
  defaultLanguage!: string;

  @ApiProperty({ enum: TenantStatusName, enumName: 'TenantStatus', example: TenantStatusName.Active })
  status!: TenantStatusName;

  @ApiProperty({ type: String, nullable: true, example: 'apartment_starter' })
  plan!: string | null;

  @ApiProperty({ type: 'integer', example: 3, description: 'Aggregate version (ETag).' })
  version!: number;
}

export class TenantUpdateDto {
  @ApiPropertyOptional({ example: FAKE.propertyName })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  displayName?: string;

  @ApiPropertyOptional({ example: FAKE.companyName })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  legalName?: string;

  @ApiPropertyOptional({
    enum: TenantLegalFormName,
    enumName: 'TenantLegalForm',
    example: TenantLegalFormName.Company,
  })
  @IsOptional()
  @IsEnum(TenantLegalFormName)
  legalForm?: TenantLegalFormName;

  @ApiPropertyOptional({ type: String, nullable: true, example: FAKE.taxId, description: '13 digits.' })
  @IsOptional()
  @Matches(/^\d{13}$/)
  taxId?: string | null;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  vatRegistered?: boolean;

  @ApiPropertyOptional({ type: () => AddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  logoDocumentId?: string | null;

  @ApiPropertyOptional({ example: 'th' })
  @IsOptional()
  @IsIn(['th', 'en'])
  defaultLanguage?: string;
}

export class MemberDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'Membership id.' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  userId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  displayName!: string;

  @ApiProperty({ type: String, nullable: true, example: '+66810001234' })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.email })
  email!: string | null;

  @ApiProperty({ enum: TenantRoleName, enumName: 'TenantRole', example: TenantRoleName.Staff })
  role!: TenantRoleName;

  @ApiProperty({
    enum: MembershipStatusName,
    enumName: 'MembershipStatus',
    example: MembershipStatusName.Active,
  })
  status!: MembershipStatusName;

  @ApiProperty({
    type: [String],
    nullable: true,
    example: [FAKE.buildingId],
    description: 'null = every building.',
  })
  buildingIds!: string[] | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  joinedAt!: string | null;
}

export class MemberUpdateDto {
  @ApiPropertyOptional({ enum: TenantRoleName, enumName: 'TenantRole', example: TenantRoleName.Staff })
  @IsOptional()
  @IsEnum(TenantRoleName)
  role?: TenantRoleName;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    example: [FAKE.buildingId],
    description: 'null or [] = every building.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  buildingIds?: string[] | null;

  @ApiPropertyOptional({ enum: ['active', 'suspended'], enumName: 'MemberSettableStatus', example: 'active' })
  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}

export class InvitationDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: TenantRoleName, enumName: 'TenantRole', example: TenantRoleName.Staff })
  role!: TenantRoleName;

  @ApiProperty({ type: [String], example: [] })
  buildingIds!: string[];

  @ApiProperty({ type: String, nullable: true, example: '+66•••••1234' })
  phoneMasked!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  email!: string | null;

  @ApiProperty({
    enum: InvitationChannelName,
    enumName: 'InvitationChannel',
    example: InvitationChannelName.Sms,
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

export class InvitationCreatedDto extends InvitationDto {
  @ApiProperty({
    example: 'ABCD-EFGH-JKLM-NPQR',
    description: 'Shown once (QR / link); never retrievable later.',
  })
  code!: string;

  @ApiProperty({ example: 'https://app.getproperty.invalid/join?code=ABCD-EFGH-JKLM-NPQR' })
  inviteUrl!: string;
}

export class InvitationCreateDto {
  @ApiProperty({ enum: TenantRoleName, enumName: 'TenantRole', example: TenantRoleName.Staff })
  @IsEnum(TenantRoleName)
  role!: TenantRoleName;

  @ApiPropertyOptional({
    type: [String],
    example: [FAKE.buildingId],
    description: 'Limit a Staff member to buildings.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  buildingIds?: string[];

  @ApiPropertyOptional({ example: '+66810001234' })
  @IsOptional()
  @ToE164()
  @Matches(/^\+[1-9]\d{6,14}$/)
  phone?: string;

  @ApiPropertyOptional({ example: FAKE.email })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    enum: InvitationChannelName,
    enumName: 'InvitationChannel',
    example: InvitationChannelName.Sms,
  })
  @IsEnum(InvitationChannelName)
  channel!: InvitationChannelName;

  @ApiPropertyOptional({ example: 'th' })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: string;
}

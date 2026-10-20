import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : value === true || value === 'true' || value === '1';

export enum LockVendorName {
  Ttlock = 'ttlock',
  Tuya = 'tuya',
  Hikvision = 'hikvision',
  Zkteco = 'zkteco',
  Other = 'other',
}

export enum LockScopeName {
  Unit = 'unit',
  BuildingDoor = 'building_door',
  CommonArea = 'common_area',
}

export enum AccessHolderKindName {
  Resident = 'resident',
  Staff = 'staff',
  Visitor = 'visitor',
  Owner = 'owner',
  Technician = 'technician',
}

export enum CredentialTypeName {
  App = 'app',
  Pin = 'pin',
  Card = 'card',
  Fingerprint = 'fingerprint',
  Face = 'face',
  Qr = 'qr',
}

export enum CredentialStatusName {
  Pending = 'pending',
  Active = 'active',
  Revoked = 'revoked',
  Expired = 'expired',
  Failed = 'failed',
}

export enum AccessResultName {
  Success = 'success',
  Denied = 'denied',
  Error = 'error',
}

export enum AccessSourceName {
  App = 'app',
  Pin = 'pin',
  Card = 'card',
  Remote = 'remote',
  VendorSync = 'vendor_sync',
  Face = 'face',
  Qr = 'qr',
  Fingerprint = 'fingerprint',
}

// ------------------------------------------------------------------------------------------------------ locks

export class LockDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'ประตูห้อง A-201' })
  name!: string;

  @ApiProperty({ enum: LockScopeName, enumName: 'LockScope', example: LockScopeName.Unit })
  scope!: LockScopeName;

  @ApiProperty({ enum: LockVendorName, enumName: 'LockVendor', example: LockVendorName.Ttlock })
  vendor!: LockVendorName;

  @ApiProperty({ example: '8123456', description: 'The vendor’s lock id.' })
  vendorLockId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: '`smart.device` (kind lock).' })
  deviceId!: string;

  @ApiProperty({ example: 'TTL-S31-0001' })
  serial!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: '`core.asset_item` (category lock).' })
  assetItemId!: string;

  @ApiProperty({ type: 'integer', nullable: true, example: 82 })
  batteryPct!: number | null;

  @ApiProperty({
    example: false,
    description: 'At or below `access.battery_low_pct` (a repair request opens).',
  })
  batteryLow!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  batteryCheckedAt!: string | null;

  @ApiProperty({ type: Boolean, nullable: true, example: true })
  online!: boolean | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  lastLogSyncAt!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class LocksDto {
  @ApiProperty({ type: [LockDto] })
  data!: LockDto[];
}

export class LockQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class LockRegisterDto {
  @ApiProperty({ enum: LockScopeName, enumName: 'LockScope', example: LockScopeName.Unit })
  @IsEnum(LockScopeName)
  scope!: LockScopeName;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Unit locks.' })
  @IsOptional()
  @IsUUID()
  unitId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Building doors and common areas.',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiProperty({ enum: LockVendorName, enumName: 'LockVendor', example: LockVendorName.Ttlock })
  @IsEnum(LockVendorName)
  vendor!: LockVendorName;

  @ApiProperty({ example: '8123456', maxLength: 100 })
  @IsString()
  @Length(1, 100)
  vendorLockId!: string;

  @ApiProperty({ example: 'TTL-S31-0001', maxLength: 100 })
  @IsString()
  @Length(1, 100)
  serial!: string;

  @ApiProperty({ example: 'ประตูห้อง A-201', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'S31' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  model?: string | null;
}

export class LockActiveDto {
  @ApiProperty({
    example: false,
    description: 'false stops new codes and syncs (existing codes stay at the vendor).',
  })
  @IsBoolean()
  isActive!: boolean;
}

// ------------------------------------------------------------------------------------------------ credentials

export class CredentialDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  lockId!: string;

  @ApiProperty({ example: 'ประตูห้อง A-201' })
  lockName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({
    enum: AccessHolderKindName,
    enumName: 'AccessHolderKind',
    example: AccessHolderKindName.Resident,
  })
  holderKind!: AccessHolderKindName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  holderPartyId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  holderUserId!: string | null;

  @ApiProperty({ example: FAKE.nameTh })
  holderName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  leaseId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  workOrderId!: string | null;

  @ApiProperty({ enum: CredentialTypeName, enumName: 'CredentialType', example: CredentialTypeName.Pin })
  type!: CredentialTypeName;

  @ApiProperty({
    enum: CredentialStatusName,
    enumName: 'CredentialStatus',
    example: CredentialStatusName.Active,
  })
  status!: CredentialStatusName;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  validFrom!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'null = until the lease ends (residents).',
  })
  validTo!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Last vendor problem (retried).' })
  vendorError!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  revokedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  revokeReason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class CredentialsDto {
  @ApiProperty({ type: [CredentialDto] })
  data!: CredentialDto[];
}

export class CredentialListQuery {
  @ApiPropertyOptional({ type: Boolean, description: 'Only pending / active.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  live?: boolean;
}

export class IssuedCredentialDto extends CredentialDto {
  @ApiProperty({ example: '482913', description: 'The code — shown this once; give it to the visitor.' })
  pin!: string;
}

export class RevealedCredentialDto extends CredentialDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '482913',
    description: 'My code (each reveal is audited, D-148); null when not a keypad code.',
  })
  pin!: string | null;
}

export class RevealedCredentialsDto {
  @ApiProperty({ type: [RevealedCredentialDto] })
  data!: RevealedCredentialDto[];
}

export class VisitorCodeCreateDto {
  @ApiProperty({ example: 'คุณผู้มาเยือน ทดสอบ', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  visitorName!: string;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  @IsDateString()
  validFrom!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-11-01T18:00:00+07:00',
    description: '≤ 31 days.',
  })
  @IsDateString()
  validTo!: string;
}

export class StaffCodeCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'A member of the tenant.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  @IsDateString()
  validFrom!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-11-01T18:00:00+07:00',
    description: '≤ 31 days.',
  })
  @IsDateString()
  validTo!: string;
}

// ------------------------------------------------------------------------------------------------- unlock log

export class AccessEventDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  time!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  lockId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ enum: AccessResultName, enumName: 'AccessResult', example: AccessResultName.Success })
  result!: AccessResultName;

  @ApiProperty({ enum: AccessSourceName, enumName: 'AccessSource', example: AccessSourceName.Pin })
  source!: AccessSourceName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  credentialId!: string | null;
}

export class AccessEventsDto {
  @ApiProperty({ type: [AccessEventDto] })
  data!: AccessEventDto[];
}

export class AccessEventQuery {
  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Default: 30 days ago.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Default: now.' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 500, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class ResidentAccessEventQuery extends AccessEventQuery {
  @ApiProperty({ format: 'uuid', description: 'A unit I occupy.' })
  @IsUUID()
  unitId!: string;
}

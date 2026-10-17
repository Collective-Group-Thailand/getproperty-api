import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
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

import { DecimalInput, MoneyInput, MoneyOutput } from '../shared/fields';
import { LeaseStatusName } from '../shared/status.enums';
import { AddressDto } from './tenancy.dto';

/** `active | inactive` of properties and buildings (core.property_status, core.building_status). */
export enum ActiveStatusName {
  Active = 'active',
  Inactive = 'inactive',
}
export enum BuildingTypeName {
  Apartment = 'apartment',
  Condo = 'condo',
  HouseCluster = 'house_cluster',
  MixedUse = 'mixed_use',
}
export enum BuildingAccessName {
  Operator = 'operator',
  Owner = 'owner',
  Grant = 'grant',
}
export enum UnitTypeName {
  Room = 'room',
  CondoUnit = 'condo_unit',
  House = 'house',
  Shop = 'shop',
  Parking = 'parking',
}
export enum UnitStatusName {
  Vacant = 'vacant',
  Reserved = 'reserved',
  Occupied = 'occupied',
  Maintenance = 'maintenance',
  Inactive = 'inactive',
}
export enum ManualUnitStatusName {
  Vacant = 'vacant',
  Maintenance = 'maintenance',
  Inactive = 'inactive',
}
export enum UtilityName {
  Electric = 'electric',
  Water = 'water',
}
export enum UtilityProviderName {
  Mea = 'mea',
  Pea = 'pea',
  Mwa = 'mwa',
  Pwa = 'pwa',
}
export enum MeterPurposeName {
  Unit = 'unit',
  CommonArea = 'common_area',
  Main = 'main',
}
export enum CommonMeterPurposeName {
  CommonArea = 'common_area',
  Main = 'main',
}
export enum LeaseLineKindName {
  Internet = 'internet',
  Parking = 'parking',
  Cleaning = 'cleaning',
  Furniture = 'furniture',
  CommonFee = 'common_fee',
  WaterMinimum = 'water_minimum',
  OtherFixed = 'other_fixed',
}
export enum AmenityCategoryName {
  Appliance = 'appliance',
  Furniture = 'furniture',
  Hvac = 'hvac',
  Other = 'other',
}
export enum AssetStatusName {
  Active = 'active',
  Inactive = 'inactive',
  Retired = 'retired',
}
export enum ImportActionName {
  Create = 'create',
  Update = 'update',
  Unchanged = 'unchanged',
  Error = 'error',
}
export enum UnitSortName {
  UnitNo = 'unitNo',
  CreatedAt = 'createdAt',
  Status = 'status',
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;
const UNIT_NO = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ./_-]{0,19}$/u;

// ------------------------------------------------------------------------------------------- properties

export class PropertyDto {
  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  id!: string;

  @ApiProperty({ example: 'MAIN', description: 'Short code, unique per tenant.' })
  code!: string;

  @ApiProperty({ example: FAKE.propertyName })
  name!: string;

  @ApiProperty({ type: () => AddressDto, nullable: true })
  address!: AddressDto | null;

  @ApiProperty({ type: String, nullable: true, example: '10', description: 'Province code (2 digits).' })
  provinceCode!: string | null;

  @ApiProperty({ enum: ActiveStatusName, enumName: 'ActiveStatus', example: ActiveStatusName.Active })
  status!: ActiveStatusName;

  @ApiProperty({ type: 'integer', example: 1, description: 'Aggregate version (ETag).' })
  version!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class PropertyCreateDto {
  @ApiProperty({ example: 'MAIN', description: 'Letters, digits, - and _ (max 20), unique per tenant.' })
  @IsString()
  @Matches(CODE)
  code!: string;

  @ApiProperty({ example: FAKE.propertyName })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ type: () => AddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional({ type: String, nullable: true, example: '10' })
  @IsOptional()
  @Matches(/^\d{2}$/)
  provinceCode?: string | null;
}

export class PropertyUpdateDto {
  @ApiPropertyOptional({ example: FAKE.propertyName })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ type: () => AddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @ApiPropertyOptional({ type: String, nullable: true, example: '10' })
  @IsOptional()
  @Matches(/^\d{2}$/)
  provinceCode?: string | null;

  @ApiPropertyOptional({ enum: ActiveStatusName, enumName: 'ActiveStatus' })
  @IsOptional()
  @IsEnum(ActiveStatusName)
  status?: ActiveStatusName;
}

// ------------------------------------------------------------------------------------------- buildings

export class BuildingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ example: 'A' })
  code!: string;

  @ApiProperty({ example: 'อาคาร A' })
  name!: string;

  @ApiProperty({ enum: BuildingTypeName, enumName: 'BuildingType', example: BuildingTypeName.Apartment })
  type!: BuildingTypeName;

  @ApiProperty({ type: 'integer', nullable: true, example: 5 })
  floorsCount!: number | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  ownerTenantId!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  operatorTenantId!: string;

  @ApiProperty({
    enum: BuildingAccessName,
    enumName: 'BuildingAccess',
    example: BuildingAccessName.Operator,
    description: 'How the current tenant sees the building: as operator, owner, or through a grant (D-152).',
  })
  access!: BuildingAccessName;

  @ApiProperty({ enum: ActiveStatusName, enumName: 'ActiveStatus', example: ActiveStatusName.Active })
  status!: ActiveStatusName;

  @ApiProperty({ type: 'integer', example: 120, description: 'Units (not deleted) in the building.' })
  unitCount!: number;

  @ApiProperty({ type: 'integer', example: 1, description: 'Aggregate version (ETag).' })
  version!: number;
}

export class BuildingCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  @IsUUID()
  propertyId!: string;

  @ApiProperty({
    example: 'A',
    description: 'Unique per property; used by unit number patterns (`{building}`).',
  })
  @IsString()
  @Matches(CODE)
  code!: string;

  @ApiProperty({ example: 'อาคาร A' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ enum: BuildingTypeName, enumName: 'BuildingType', example: BuildingTypeName.Apartment })
  @IsEnum(BuildingTypeName)
  type!: BuildingTypeName;

  @ApiPropertyOptional({ type: 'integer', example: 5, minimum: 1, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  floorsCount?: number;

  @ApiPropertyOptional({ type: () => AddressDto, description: 'Defaults to the property address.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

export class BuildingUpdateDto {
  @ApiPropertyOptional({ example: 'อาคาร A' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ enum: BuildingTypeName, enumName: 'BuildingType' })
  @IsOptional()
  @IsEnum(BuildingTypeName)
  type?: BuildingTypeName;

  @ApiPropertyOptional({ type: 'integer', example: 6, minimum: 1, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  floorsCount?: number;

  @ApiPropertyOptional({ enum: ActiveStatusName, enumName: 'ActiveStatus' })
  @IsOptional()
  @IsEnum(ActiveStatusName)
  status?: ActiveStatusName;
}

export class FloorDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  level!: number;

  @ApiProperty({ example: 'ชั้น 2' })
  name!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  sortOrder!: number;

  @ApiProperty({ type: 'integer', example: 6 })
  unitCount!: number;
}

export class FloorCreateDto {
  @ApiProperty({ type: 'integer', example: 2, minimum: -5, maximum: 200 })
  @IsInt()
  @Min(-5)
  @Max(200)
  level!: number;

  @ApiProperty({ example: 'ชั้น 2' })
  @IsString()
  @Length(1, 50)
  name!: string;

  @ApiPropertyOptional({ type: 'integer', example: 2, description: 'Defaults to the level.' })
  @IsOptional()
  @IsInt()
  @Min(-100)
  @Max(1000)
  sortOrder?: number;
}

export class FloorUpdateDto {
  @ApiPropertyOptional({ type: 'integer', example: 3, minimum: -5, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(-5)
  @Max(200)
  level?: number;

  @ApiPropertyOptional({ example: 'ชั้น 3' })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  name?: string;

  @ApiPropertyOptional({ type: 'integer', example: 3 })
  @IsOptional()
  @IsInt()
  @Min(-100)
  @Max(1000)
  sortOrder?: number;
}

// ------------------------------------------------------------------------------------------- units

export class UnitDto {
  @ApiProperty({
    type: [String],
    example: ['set-status'],
    description: 'Actions (`…/actions/{name}`) the caller may take now — never infer them from the status.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  floorId!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  floorLevel!: number | null;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ enum: UnitTypeName, enumName: 'UnitType', example: UnitTypeName.Room })
  type!: UnitTypeName;

  @ApiProperty({ type: String, nullable: true, example: '28.50', description: 'Area in m², decimal string.' })
  areaSqm!: string | null;

  @MoneyOutput({
    example: '4500.00',
    description: 'Monthly base rent proposed on new leases.',
    nullable: true,
  })
  baseRent!: string | null;

  @ApiProperty({ enum: UnitStatusName, enumName: 'UnitStatus', example: UnitStatusName.Vacant })
  status!: UnitStatusName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Reason of the last manual change.',
  })
  statusReason!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  statusChangedAt!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ห้องสตูดิโอ' })
  unitProfileName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Condo ownership ratio (fraction); null for apartments (D-151).',
  })
  ownershipRatio!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Lease in force (B2.3).',
  })
  currentLeaseId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ example: 'THB' })
  currency!: string;

  @ApiProperty({ type: 'integer', example: 1, description: 'Aggregate version (ETag).' })
  version!: number;
}

export class UnitCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  floorId?: string | null;

  @ApiProperty({
    example: FAKE.unitCode,
    description: 'Unique per building (letters, digits, - _ . /, max 20).',
  })
  @IsString()
  @Matches(UNIT_NO)
  unitNo!: string;

  @ApiPropertyOptional({ enum: UnitTypeName, enumName: 'UnitType', default: UnitTypeName.Room })
  @IsOptional()
  @IsEnum(UnitTypeName)
  type?: UnitTypeName;

  @DecimalInput({ example: '28.50', description: 'Area in m².', optional: true, nullable: true })
  areaSqm?: string | null;

  @MoneyInput({
    example: '4500.00',
    description: 'Monthly base rent; defaults to the profile rent.',
    optional: true,
    nullable: true,
  })
  baseRent?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  unitProfileId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ห้องมุม' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class UnitUpdateDto {
  @ApiPropertyOptional({ example: FAKE.unitCode })
  @IsOptional()
  @IsString()
  @Matches(UNIT_NO)
  unitNo?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  floorId?: string | null;

  @ApiPropertyOptional({ enum: UnitTypeName, enumName: 'UnitType' })
  @IsOptional()
  @IsEnum(UnitTypeName)
  type?: UnitTypeName;

  @DecimalInput({ example: '30.00', description: 'Area in m².', optional: true, nullable: true })
  areaSqm?: string | null;

  @MoneyInput({
    example: '4800.00',
    description: 'Monthly base rent for new leases.',
    optional: true,
    nullable: true,
  })
  baseRent?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  unitProfileId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ห้องมุม วิวสวน' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class UnitBulkCreateDto {
  @ApiProperty({ type: [String], format: 'uuid', example: [FAKE.uuid], description: 'Floors to fill.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  floorIds!: string[];

  @ApiProperty({ type: 'integer', example: 6, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  countPerFloor!: number;

  @ApiPropertyOptional({
    example: '{building}-{floor}{nn}',
    default: '{building}-{floor}{nn}',
    description:
      'Unit number pattern: `{building}` building code, `{floor}` level, `{ff}` level on 2 digits, `{nn}` sequence (one digit per n). `A-{floor}{nn}` on floor 2 gives A-201…',
  })
  @IsOptional()
  @IsString()
  @Length(3, 40)
  pattern?: string;

  @ApiPropertyOptional({ type: 'integer', example: 1, default: 1, minimum: 0, maximum: 999 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  start?: number;

  @ApiPropertyOptional({ enum: UnitTypeName, enumName: 'UnitType', default: UnitTypeName.Room })
  @IsOptional()
  @IsEnum(UnitTypeName)
  type?: UnitTypeName;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  unitProfileId?: string | null;

  @MoneyInput({
    example: '4500.00',
    description: 'Monthly base rent of every new unit.',
    optional: true,
    nullable: true,
  })
  baseRent?: string | null;

  @DecimalInput({
    example: '28.00',
    description: 'Area in m² of every new unit.',
    optional: true,
    nullable: true,
  })
  areaSqm?: string | null;
}

export class UnitStatusChangeDto {
  @ApiProperty({
    enum: ManualUnitStatusName,
    enumName: 'ManualUnitStatus',
    example: ManualUnitStatusName.Maintenance,
    description: 'Only vacant ↔ inactive | maintenance can be set manually (B2.1).',
  })
  @IsEnum(ManualUnitStatusName)
  status!: ManualUnitStatusName;

  @ApiProperty({ example: 'ปรับปรุงห้องน้ำ', description: 'Why (audited).' })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class UnitListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  floorId?: string;

  @ApiPropertyOptional({ enum: UnitStatusName, enumName: 'UnitStatus' })
  @IsOptional()
  @IsEnum(UnitStatusName)
  status?: UnitStatusName;
}

export class UnitStatusCountsDto {
  @ApiProperty({ type: 'integer', example: 3 })
  vacant!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  reserved!: number;

  @ApiProperty({ type: 'integer', example: 8 })
  occupied!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  maintenance!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  inactive!: number;
}

export class UnitCountDto {
  @ApiProperty({
    type: 'integer',
    example: 12,
    description: 'Units counted for the subscription: status other than inactive (D-082, D-156).',
  })
  billable!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  inactive!: number;

  @ApiProperty({ type: () => UnitStatusCountsDto })
  byStatus!: UnitStatusCountsDto;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  countedAt!: string;
}

// ------------------------------------------------------------------------------------------- unit profiles

export class LeaseLineDefaultDto {
  @ApiProperty({ enum: LeaseLineKindName, enumName: 'LeaseLineKind', example: LeaseLineKindName.Internet })
  @IsEnum(LeaseLineKindName)
  kind!: LeaseLineKindName;

  @ApiProperty({ example: 'อินเทอร์เน็ตไฟเบอร์' })
  @IsString()
  @Length(1, 200)
  description!: string;

  @MoneyInput({ example: '300.00', description: 'Fixed monthly amount.' })
  amount!: string;
}

export class UnitProfileDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'ห้องสตูดิโอ' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: '28.00' })
  areaSqm!: string | null;

  @MoneyOutput({ example: '4500.00', description: 'Default monthly rent.' })
  defaultRent!: string;

  @ApiProperty({ example: '1.0', description: 'Deposit proposed on new leases, in months of rent.' })
  defaultDepositMonths!: string;

  @ApiProperty({ example: '1.0', description: 'Advance rent proposed on new leases, in months.' })
  defaultAdvanceRentMonths!: string;

  @ApiProperty({ type: () => [LeaseLineDefaultDto] })
  defaultLeaseLines!: LeaseLineDefaultDto[];

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  inspectionTemplateId!: string | null;

  @ApiProperty({ type: 'integer', example: 1, description: 'Aggregate version (ETag).' })
  version!: number;
}

export class UnitProfileCreateDto {
  @ApiProperty({ example: 'ห้องสตูดิโอ' })
  @IsString()
  @Length(1, 100)
  name!: string;

  @DecimalInput({ example: '28.00', description: 'Area in m².', optional: true, nullable: true })
  areaSqm?: string | null;

  @MoneyInput({ example: '4500.00', description: 'Default monthly rent.' })
  defaultRent!: string;

  @DecimalInput({ example: '1', description: 'Deposit in months of rent (default 1).', optional: true })
  defaultDepositMonths?: string;

  @DecimalInput({ example: '1', description: 'Advance rent in months (default 1).', optional: true })
  defaultAdvanceRentMonths?: string;

  @ApiPropertyOptional({ type: () => [LeaseLineDefaultDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LeaseLineDefaultDto)
  defaultLeaseLines?: LeaseLineDefaultDto[];
}

export class UnitProfileUpdateDto {
  @ApiPropertyOptional({ example: 'ห้องสตูดิโอใหญ่' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @DecimalInput({ example: '32.00', description: 'Area in m².', optional: true, nullable: true })
  areaSqm?: string | null;

  @MoneyInput({ example: '5000.00', description: 'Default monthly rent.', optional: true })
  defaultRent?: string;

  @DecimalInput({ example: '1', description: 'Deposit in months of rent.', optional: true })
  defaultDepositMonths?: string;

  @DecimalInput({ example: '1', description: 'Advance rent in months.', optional: true })
  defaultAdvanceRentMonths?: string;

  @ApiPropertyOptional({ type: () => [LeaseLineDefaultDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LeaseLineDefaultDto)
  defaultLeaseLines?: LeaseLineDefaultDto[];
}

// ------------------------------------------------------------------------------------------- utility accounts

export class UtilityAccountDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  provider!: UtilityProviderName;

  @ApiProperty({ example: '000012345678', description: 'Customer number on the utility invoice.' })
  customerNo!: string;

  @ApiProperty({ type: String, nullable: true, example: '00012345' })
  meterNo!: string | null;

  @ApiProperty({ example: 'มิเตอร์หลักอาคาร A' })
  label!: string;
}

export class UtilityAccountCreateDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;

  @ApiProperty({
    enum: UtilityProviderName,
    enumName: 'UtilityProvider',
    example: UtilityProviderName.Mea,
    description: 'electric: mea | pea; water: mwa | pwa.',
  })
  @IsEnum(UtilityProviderName)
  provider!: UtilityProviderName;

  @ApiProperty({ example: '000012345678' })
  @IsString()
  @Matches(/^[0-9A-Za-z-]{4,30}$/)
  customerNo!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '00012345' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  meterNo?: string | null;

  @ApiProperty({ example: 'มิเตอร์หลักอาคาร A' })
  @IsString()
  @Length(1, 100)
  label!: string;
}

export class UtilityAccountUpdateDto {
  @ApiPropertyOptional({ enum: UtilityProviderName, enumName: 'UtilityProvider' })
  @IsOptional()
  @IsEnum(UtilityProviderName)
  provider?: UtilityProviderName;

  @ApiPropertyOptional({ example: '000012345679' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Za-z-]{4,30}$/)
  customerNo?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '00012346' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  meterNo?: string | null;

  @ApiPropertyOptional({ example: 'มิเตอร์น้ำหลัก' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  label?: string;
}

// ------------------------------------------------------------------------------------------- meters & amenities

export class MeterDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'core.meter_assignment id.' })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.meterId, description: 'The meter (core.asset_item).' })
  assetItemId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ enum: MeterPurposeName, enumName: 'MeterPurpose', example: MeterPurposeName.Unit })
  purpose!: MeterPurposeName;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ example: 'A-201-E' })
  code!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  commonAreaLabel!: string | null;

  @ApiProperty({ example: 'มิเตอร์ไฟฟ้า A-201' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  serial!: string | null;

  @ApiProperty({ example: '0.000', description: 'Register at installation (kWh / m³), decimal string.' })
  initialReading!: string;

  @ApiProperty({ example: '1.000000', description: 'CT ratio / scaling, decimal string.' })
  multiplier!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  validFrom!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  validTo!: string | null;
}

export class MeterCreateDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;

  @ApiPropertyOptional({ example: 'A-201-E', description: 'Defaults to `<unitNo>-E` / `<unitNo>-W`.' })
  @IsOptional()
  @IsString()
  @Matches(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}._/-]{0,29}$/u)
  code?: string;

  @ApiPropertyOptional({ example: 'มิเตอร์ไฟฟ้า A-201' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'SN-0000001' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  serial?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ตัวอย่างมิเตอร์' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'M-1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string | null;

  @DecimalInput({ example: '1234.5', description: 'Register at installation (default 0).', optional: true })
  initialReading?: string;

  @DecimalInput({ example: '1', description: 'Multiplier (default 1).', optional: true })
  multiplier?: string;
}

export class CommonMeterCreateDto {
  @ApiProperty({
    enum: CommonMeterPurposeName,
    enumName: 'CommonMeterPurpose',
    example: CommonMeterPurposeName.Main,
  })
  @IsEnum(CommonMeterPurposeName)
  purpose!: CommonMeterPurposeName;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;

  @ApiProperty({ example: 'MAIN-E', description: 'Unique code of the meter position in the building.' })
  @IsString()
  @Matches(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}._/-]{0,29}$/u)
  code!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ไฟส่วนกลางทางเดิน' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  commonAreaLabel?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'SN-0000002' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  serial?: string | null;

  @DecimalInput({ example: '20345.1', description: 'Register at installation (default 0).', optional: true })
  initialReading?: string;

  @DecimalInput({ example: '40', description: 'Multiplier / CT ratio (default 1).', optional: true })
  multiplier?: string;
}

export class MissingMetersCreateDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', isArray: true, example: ['electric', 'water'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(UtilityName, { each: true })
  utilities!: UtilityName[];

  @DecimalInput({ example: '0', description: 'Register of every new meter (default 0).', optional: true })
  initialReading?: string;
}

export class AmenityDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({
    enum: AmenityCategoryName,
    enumName: 'AmenityCategory',
    example: AmenityCategoryName.Appliance,
  })
  category!: AmenityCategoryName;

  @ApiProperty({ example: 'ตู้เย็น' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'ตัวอย่างยี่ห้อ' })
  manufacturer!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  model!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  serial!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ห้องนอน' })
  location!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: FAKE.date })
  installDate!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  warrantyUntil!: string | null;

  @ApiProperty({ enum: AssetStatusName, enumName: 'AssetStatus', example: AssetStatusName.Active })
  status!: AssetStatusName;
}

export class AmenityCreateDto {
  @ApiProperty({
    enum: AmenityCategoryName,
    enumName: 'AmenityCategory',
    example: AmenityCategoryName.Appliance,
  })
  @IsEnum(AmenityCategoryName)
  category!: AmenityCategoryName;

  @ApiProperty({ example: 'ตู้เย็น' })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ตัวอย่างยี่ห้อ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  serial?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ห้องนอน' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: FAKE.date })
  @IsOptional()
  @IsDateString({ strict: true })
  installDate?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: null })
  @IsOptional()
  @IsDateString({ strict: true })
  warrantyUntil?: string | null;
}

export class AmenityUpdateDto {
  @ApiPropertyOptional({ enum: AmenityCategoryName, enumName: 'AmenityCategory' })
  @IsOptional()
  @IsEnum(AmenityCategoryName)
  category?: AmenityCategoryName;

  @ApiPropertyOptional({ example: 'ตู้เย็น 2 ประตู' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ห้องครัว' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2027-11-01' })
  @IsOptional()
  @IsDateString({ strict: true })
  warrantyUntil?: string | null;
}

export class AmenityRetireDto {
  @ApiProperty({ example: 'ชำรุด เปลี่ยนเครื่องใหม่', description: 'Why the item leaves the unit.' })
  @IsString()
  @Length(3, 300)
  retiredReason!: string;
}

// ------------------------------------------------------------------------------------------- board

export class BoardLesseeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  displayName!: string;
}

export class BoardMeterDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ example: 'A-201-E' })
  code!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Meter health (B3.4); null until then.',
  })
  health!: string | null;
}

export class BoardUnitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ enum: UnitTypeName, enumName: 'UnitType', example: UnitTypeName.Room })
  type!: UnitTypeName;

  @ApiProperty({ enum: UnitStatusName, enumName: 'UnitStatus', example: UnitStatusName.Occupied })
  status!: UnitStatusName;

  @ApiProperty({ type: String, nullable: true, example: null })
  statusReason!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ห้องสตูดิโอ' })
  profileName!: string | null;

  @MoneyOutput({ example: '4500.00', description: 'Base rent of the unit.', nullable: true })
  baseRent!: string | null;

  @ApiProperty({ type: () => BoardLesseeDto, nullable: true })
  lessee!: BoardLesseeDto | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  leaseId!: string | null;

  @ApiProperty({
    enum: LeaseStatusName,
    enumName: 'LeaseStatus',
    nullable: true,
    example: LeaseStatusName.Active,
    description: 'Status of the current lease.',
  })
  leaseStatus!: LeaseStatusName | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2027-10-31' })
  leaseEndDate!: string | null;

  @MoneyOutput({
    example: null,
    description: 'Outstanding balance (B4.5); null until receivables exist.',
    nullable: true,
  })
  balance!: string | null;

  @ApiProperty({ type: () => [BoardMeterDto] })
  meters!: BoardMeterDto[];

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Worst meter health (B3.4).' })
  meterHealth!: string | null;
}

export class BoardFloorDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'null = units without floor.',
  })
  id!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  level!: number | null;

  @ApiProperty({ example: 'ชั้น 2' })
  name!: string;

  @ApiProperty({ type: () => [BoardUnitDto] })
  units!: BoardUnitDto[];
}

export class BoardSummaryDto extends UnitStatusCountsDto {
  @ApiProperty({ type: 'integer', example: 12 })
  total!: number;

  @ApiProperty({ example: '66.7', description: 'Occupied ÷ units not inactive, in percent (1 decimal).' })
  occupancyPct!: string;
}

export class BoardBuildingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  id!: string;

  @ApiProperty({ example: 'A' })
  code!: string;

  @ApiProperty({ example: 'อาคาร A' })
  name!: string;
}

export class BoardDto {
  @ApiProperty({ type: () => BoardBuildingDto })
  building!: BoardBuildingDto;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  generatedAt!: string;

  @ApiProperty({ type: () => BoardSummaryDto })
  summary!: BoardSummaryDto;

  @ApiProperty({ type: () => [BoardFloorDto], description: 'Top floor first.' })
  floors!: BoardFloorDto[];
}

// ------------------------------------------------------------------------------------------- import

export class UnitImportPreviewRequestDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'An uploaded file (kind `other`, xlsx) from `POST /v1/owner/files/presign`.',
  })
  @IsUUID()
  fileId!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Create floors the file names but the building lacks.',
  })
  @IsOptional()
  @IsBoolean()
  createFloors?: boolean;
}

export class UnitImportCommitDto extends UnitImportPreviewRequestDto {
  @ApiProperty({ example: 'q8u2ZJ6a0y1mXo5t4Vb3wNfLkR7sGh9cD2eP0iUaQx8', description: 'From the preview.' })
  @IsString()
  @Length(20, 100)
  previewToken!: string;
}

export class ImportRowErrorDto {
  @ApiProperty({ example: 'base_rent', description: 'Column key of the template, or `row`.' })
  column!: string;

  @ApiProperty({ example: 'money' })
  code!: string;

  @ApiProperty({ example: 'ค่าเช่าต้องเป็นจำนวนเงิน เช่น 4500 หรือ 4500.00' })
  message!: string;
}

export class ImportRowDto {
  @ApiProperty({ type: 'integer', example: 2, description: 'Row number in the sheet.' })
  row!: number;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  floorLevel!: number | null;

  @ApiProperty({ enum: UnitTypeName, enumName: 'UnitType', example: UnitTypeName.Room })
  type!: UnitTypeName;

  @ApiProperty({ type: String, nullable: true, example: '28.00' })
  areaSqm!: string | null;

  @MoneyOutput({ example: '4500.00', description: 'Base rent from the file.', nullable: true })
  baseRent!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ห้องสตูดิโอ' })
  unitProfile!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ enum: ImportActionName, enumName: 'ImportAction', example: ImportActionName.Create })
  action!: ImportActionName;

  @ApiProperty({ example: false, description: 'The floor of this row will be created.' })
  createsFloor!: boolean;

  @ApiProperty({ type: () => [ImportRowErrorDto] })
  errors!: ImportRowErrorDto[];
}

export class ImportSummaryDto {
  @ApiProperty({ type: 'integer', example: 10 })
  create!: number;

  @ApiProperty({ type: 'integer', example: 2 })
  update!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  unchanged!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  error!: number;

  @ApiProperty({ type: [Number], example: [3], description: 'Floor levels that will be created.' })
  floorsToCreate!: number[];
}

export class UnitImportPreviewDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  fileId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: () => [ImportRowDto] })
  rows!: ImportRowDto[];

  @ApiProperty({ type: () => ImportSummaryDto })
  summary!: ImportSummaryDto;

  @ApiProperty({
    example: 'q8u2ZJ6a0y1mXo5t4Vb3wNfLkR7sGh9cD2eP0iUaQx8',
    description: 'Send it back to commit exactly this plan.',
  })
  previewToken!: string;
}

export const UNIT_SORTS = Object.values(UnitSortName);
export const isUnitSort = (s: string | undefined): s is UnitSortName =>
  s !== undefined && (UNIT_SORTS as string[]).includes(s);

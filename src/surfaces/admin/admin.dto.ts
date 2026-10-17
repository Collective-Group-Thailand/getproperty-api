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
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { NotificationAudienceName } from '../owner/governance.dto';
import {
  ANY_JSON,
  TariffVersionStateName,
  UtilityName,
  UtilityProviderName,
} from '../owner/money-settings.dto';
import {
  AddressDto,
  InvitationCreatedDto,
  TenantLegalFormName,
  TenantProfileDto,
} from '../owner/tenancy.dto';
import { ToE164 } from '../shared/auth.dto';
import { LanguageName, NotificationChannelName } from '../shared/common.dto';
import { TenantTypeName } from '../shared/me.dto';

export class AdminTenantListQuery extends PageQuery {}

export class TenantOwnerInviteDto {
  @ApiProperty({
    example: '+66810001234',
    description: 'The first Owner receives an SMS invitation (D-145).',
  })
  @ToE164()
  @Matches(/^\+[1-9]\d{6,14}$/)
  phone!: string;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: string;
}

export class TenantCreateDto {
  @ApiProperty({ enum: TenantTypeName, enumName: 'TenantType', example: TenantTypeName.Apartment })
  @IsEnum(TenantTypeName)
  type!: TenantTypeName;

  @ApiProperty({ example: 'sample-dormitory', description: 'URL-safe unique slug.' })
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/)
  slug!: string;

  @ApiProperty({ example: FAKE.propertyName })
  @IsString()
  @Length(1, 200)
  displayName!: string;

  @ApiProperty({ example: FAKE.companyName })
  @IsString()
  @Length(1, 300)
  legalName!: string;

  @ApiProperty({
    enum: TenantLegalFormName,
    enumName: 'TenantLegalForm',
    example: TenantLegalFormName.Company,
  })
  @IsEnum(TenantLegalFormName)
  legalForm!: TenantLegalFormName;

  @ApiPropertyOptional({ type: String, nullable: true, example: FAKE.taxId })
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

  @ApiPropertyOptional({ type: String, nullable: true, example: 'apartment_starter' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  plan?: string | null;

  @ApiPropertyOptional({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  @IsOptional()
  @IsIn(['th', 'en'])
  defaultLanguage?: string;

  @ApiProperty({ type: () => TenantOwnerInviteDto })
  @ValidateNested()
  @Type(() => TenantOwnerInviteDto)
  owner!: TenantOwnerInviteDto;
}

export class TenantCreatedDto {
  @ApiProperty({ type: () => TenantProfileDto })
  tenant!: TenantProfileDto;

  @ApiProperty({ type: () => InvitationCreatedDto })
  invitation!: InvitationCreatedDto;
}

export enum PlatformRoleName {
  PlatformAdmin = 'platform_admin',
  Support = 'support',
  FieldEngineer = 'field_engineer',
  Finance = 'finance',
}

export class PlatformRoleDto {
  @ApiProperty({ enum: PlatformRoleName, enumName: 'PlatformRole', example: PlatformRoleName.Support })
  role!: PlatformRoleName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  expiresAt!: string | null;
}

export class PlatformUserDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.email })
  email!: string | null;

  @ApiProperty({ example: FAKE.name })
  displayName!: string;

  @ApiProperty({ example: 'active' })
  status!: string;

  @ApiProperty({ example: true })
  totpEnabled!: boolean;

  @ApiProperty({ type: [PlatformRoleDto] })
  roles!: PlatformRoleDto[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  lastLoginAt!: string | null;
}

export class PlatformUserCreateDto {
  @ApiProperty({ example: FAKE.email })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: FAKE.name })
  @IsString()
  @Length(1, 200)
  displayName!: string;

  @ApiPropertyOptional({ example: '+66810001234' })
  @IsOptional()
  @ToE164()
  @Matches(/^\+[1-9]\d{6,14}$/)
  phone?: string;

  @ApiProperty({
    enum: PlatformRoleName,
    enumName: 'PlatformRole',
    isArray: true,
    example: [PlatformRoleName.Support],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsEnum(PlatformRoleName, { each: true })
  roles!: PlatformRoleName[];

  @ApiProperty({
    example: 'Temp-Passw0rd-Example!',
    description: 'Temporary; TOTP enrolment is forced at first login.',
  })
  @IsString()
  @Length(12, 128)
  temporaryPassword!: string;
}

export class RoleGrantDto {
  @ApiProperty({ enum: PlatformRoleName, enumName: 'PlatformRole', example: PlatformRoleName.Support })
  @IsEnum(PlatformRoleName)
  role!: PlatformRoleName;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: null })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}

export class SupportGrantRequestDto {
  @ApiProperty({ example: 'ตรวจสอบปัญหาการส่งบิลรอบ พ.ย.' })
  @IsString()
  @Length(5, 500)
  reason!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'SUP-1024' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ticketRef?: string | null;
}

export class SettingDefinitionDto {
  @ApiProperty({ example: 'reminders.schedule' })
  key!: string;

  @ApiProperty({ example: 'json' })
  valueType!: string;

  @ApiProperty({ type: [String], example: ['platform', 'tenant'] })
  scopeAllowed!: string[];

  @ApiProperty({ type: [String], example: ['tenant.settings.update'] })
  editableBy!: string[];

  @ApiProperty({ example: 'D-045: LINE reminders after due date + grace.' })
  description!: string;

  @ApiProperty({
    oneOf: ANY_JSON,
    nullable: true,
    example: [1, 3, 7],
    description: 'Platform value in force now.',
  })
  value!: unknown;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  effectiveFrom!: string | null;
}

export class FeatureFlagOverrideDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({ example: 'นำร่องลูกค้ารายแรก' })
  reason!: string;
}

export class FeatureFlagDto {
  @ApiProperty({ example: 'module.service_requests' })
  key!: string;

  @ApiProperty({ example: 'Service requests module (B5).' })
  description!: string;

  @ApiProperty({ example: false })
  defaultEnabled!: boolean;

  @ApiProperty({ type: 'integer', example: 0 })
  rolloutPct!: number;

  @ApiProperty({ type: [FeatureFlagOverrideDto] })
  overrides!: FeatureFlagOverrideDto[];
}

export class FeatureFlagChangeDto {
  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  defaultEnabled?: boolean;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 100, example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  rolloutPct?: number;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.tenantId, description: 'Tenant override target.' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    example: true,
    description: 'Override value; null removes the override.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean | null;

  @ApiProperty({ example: 'นำร่องลูกค้ารายแรก' })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class TariffVersionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'date', example: '2026-09-01' })
  effectiveFrom!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: null })
  effectiveTo!: string | null;

  @ApiProperty({
    enum: TariffVersionStateName,
    enumName: 'TariffVersionState',
    example: TariffVersionStateName.Entered,
  })
  state!: TariffVersionStateName;

  @ApiProperty({ example: '4.6189', description: 'Decimal string, baht per unit excl. VAT.' })
  ceilingPerUnit!: string;

  @ApiProperty({ example: true })
  needsCheck!: boolean;

  @ApiProperty({ example: 'https://www.mea.or.th/' })
  sourceUrl!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { kind: 'tiered', unit: 'kwh', currency: 'THB' },
  })
  structure!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  enteredBy!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  verifiedBy!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  publishedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;
}

export class UtilityTariffDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  provider!: UtilityProviderName;

  @ApiProperty({ example: '1.1' })
  tariffCode!: string;

  @ApiProperty({ example: 'ประเภท 1.1 บ้านอยู่อาศัย' })
  nameTh!: string;

  @ApiProperty({ type: [TariffVersionDto] })
  versions!: TariffVersionDto[];
}

export class TariffEnterDto {
  @ApiProperty({ format: 'date', example: '2026-09-01' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      kind: 'tiered',
      unit: 'kwh',
      currency: 'THB',
      ceilingPerUnit: '4.6189',
      tiers: [
        { upTo: '150', pricePerUnit: '3.2484' },
        { upTo: null, pricePerUnit: '4.2218' },
      ],
    },
    description: 'Tariff structure (tariff-structure.ts); validated before it is stored.',
  })
  @IsObject()
  structure!: Record<string, unknown>;

  @ApiProperty({ example: 'https://www.mea.or.th/' })
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  sourceUrl!: string;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2026-08-20' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sourcePublishedOn?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'อัตรา Ft งวด ก.ย.–ธ.ค.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class TariffVerifyDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'ตรวจทุกค่ากับประกาศแล้ว' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export enum OutboxStateName {
  Pending = 'pending',
  Publishing = 'publishing',
  Published = 'published',
  Failed = 'failed',
  Dead = 'dead',
}

export enum ConsumptionStateName {
  Processed = 'processed',
  Failed = 'failed',
  Dead = 'dead',
}

export class OutboxListQuery {
  @ApiPropertyOptional({
    enum: OutboxStateName,
    enumName: 'OutboxState',
    description: 'Default: failed and dead.',
  })
  @IsOptional()
  @IsEnum(OutboxStateName)
  state?: OutboxStateName;
}

export class ConsumptionListQuery {
  @ApiPropertyOptional({
    enum: ConsumptionStateName,
    enumName: 'ConsumptionState',
    description: 'Default: failed and dead.',
  })
  @IsOptional()
  @IsEnum(ConsumptionStateName)
  state?: ConsumptionStateName;
}

export class OutboxMessageDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  eventId!: string;

  @ApiProperty({ example: 'tenant.bank_account.changed' })
  eventType!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  tenantId!: string | null;

  @ApiProperty({ example: 'tenant' })
  topic!: string;

  @ApiProperty({ enum: OutboxStateName, enumName: 'OutboxState', example: OutboxStateName.Dead })
  state!: OutboxStateName;

  @ApiProperty({ type: 'integer', example: 10 })
  attempts!: number;

  @ApiProperty({ type: String, nullable: true, example: 'queue unavailable' })
  lastError!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class EventConsumptionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  eventId!: string;

  @ApiProperty({ example: 'workflow.sla_breached' })
  eventType!: string;

  @ApiProperty({ example: 'notifications' })
  subscriber!: string;

  @ApiProperty({
    enum: ConsumptionStateName,
    enumName: 'ConsumptionState',
    example: ConsumptionStateName.Dead,
  })
  state!: ConsumptionStateName;

  @ApiProperty({ type: 'integer', example: 8 })
  attempts!: number;

  @ApiProperty({ type: String, nullable: true, example: 'provider unavailable' })
  lastError!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  replayedAt!: string | null;
}

export enum TemplateFormatName {
  HandlebarsText = 'handlebars_text',
  LineFlexJson = 'line_flex_json',
  Mjml = 'mjml',
  Plain = 'plain',
}

export enum TemplateVersionStateName {
  Draft = 'draft',
  Published = 'published',
  Retired = 'retired',
}

export class TemplateVersionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  language!: string;

  @ApiProperty({
    enum: TemplateFormatName,
    enumName: 'TemplateFormat',
    example: TemplateFormatName.HandlebarsText,
  })
  format!: TemplateFormatName;

  @ApiProperty({ type: String, nullable: true, example: 'บัญชีรับเงินถูกเปลี่ยน' })
  subject!: string | null;

  @ApiProperty({ example: 'บัญชีรับเงินของ {{tenant.name}} ถูกเปลี่ยนเป็น {{account.masked}}' })
  body!: string;

  @ApiProperty({
    enum: TemplateVersionStateName,
    enumName: 'TemplateVersionState',
    example: TemplateVersionStateName.Published,
  })
  state!: TemplateVersionStateName;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { tenant: { name: FAKE.propertyName } },
  })
  sampleData!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  publishedAt!: string | null;
}

export class NotificationTemplateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'tenant.bank_account.changed' })
  key!: string;

  @ApiProperty({
    enum: NotificationChannelName,
    enumName: 'NotificationChannel',
    example: NotificationChannelName.InApp,
  })
  channel!: NotificationChannelName;

  @ApiProperty({
    enum: NotificationAudienceName,
    enumName: 'NotificationAudience',
    example: NotificationAudienceName.Owner,
  })
  audience!: NotificationAudienceName;

  @ApiProperty({ example: 'Owner: receiving bank account changed.' })
  description!: string;

  @ApiProperty({ type: [TemplateVersionDto] })
  versions!: TemplateVersionDto[];
}

export class TemplateVersionCreateDto {
  @ApiProperty({ example: 'tenant.bank_account.changed' })
  @Matches(/^[a-z_]+(\.[a-z_]+)+$/)
  @MaxLength(100)
  key!: string;

  @ApiProperty({
    enum: NotificationChannelName,
    enumName: 'NotificationChannel',
    example: NotificationChannelName.InApp,
  })
  @IsEnum(NotificationChannelName)
  channel!: NotificationChannelName;

  @ApiProperty({
    enum: NotificationAudienceName,
    enumName: 'NotificationAudience',
    example: NotificationAudienceName.Owner,
  })
  @IsEnum(NotificationAudienceName)
  audience!: NotificationAudienceName;

  @ApiPropertyOptional({ example: 'Owner: receiving bank account changed.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ enum: LanguageName, enumName: 'Language', example: LanguageName.Th })
  @IsIn(['th', 'en'])
  language!: 'th' | 'en';

  @ApiProperty({
    enum: TemplateFormatName,
    enumName: 'TemplateFormat',
    example: TemplateFormatName.HandlebarsText,
  })
  @IsEnum(TemplateFormatName)
  format!: TemplateFormatName;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'บัญชีรับเงินถูกเปลี่ยน' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  subject?: string | null;

  @ApiProperty({ example: 'บัญชีรับเงินของ {{tenant.name}} ถูกเปลี่ยนเป็น {{account.masked}}' })
  @IsString()
  @Length(1, 20_000)
  body!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { tenant: { name: FAKE.propertyName }, account: { masked: 'xxxxxx1234' } },
  })
  @IsOptional()
  @IsObject()
  sampleData?: Record<string, unknown>;
}

export class TemplatePreviewDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { tenant: { name: FAKE.propertyName } },
    description: 'Defaults to the version sample data.',
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class RenderedMessageDto {
  @ApiProperty({
    enum: TemplateFormatName,
    enumName: 'TemplateFormat',
    example: TemplateFormatName.HandlebarsText,
  })
  format!: TemplateFormatName;

  @ApiProperty({ type: String, nullable: true, example: 'บัญชีรับเงินถูกเปลี่ยน' })
  subject!: string | null;

  @ApiProperty({ example: 'บัญชีรับเงินของ หอพักตัวอย่าง ถูกเปลี่ยนเป็น xxxxxx1234' })
  text!: string;

  @ApiPropertyOptional({ example: '<!doctype html>…' })
  html?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, example: { type: 'bubble' } })
  flex?: Record<string, unknown>;
}

export class TestSendDto {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid, description: 'Defaults to me.' })
  @IsOptional()
  @IsUUID()
  recipientUserId?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { tenant: { name: FAKE.propertyName } },
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class AcceptedDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The event that carries the request.' })
  eventId!: string;
}

export enum DeviceKindName {
  Gateway = 'gateway',
  ElectricMeter = 'electric_meter',
  WaterMeter = 'water_meter',
  Lock = 'lock',
  Breaker = 'breaker',
  Sensor = 'sensor',
  DoorController = 'door_controller',
  Camera = 'camera',
}

export enum DeviceOwnershipName {
  PlatformHaas = 'platform_haas',
  TenantOwned = 'tenant_owned',
}

export enum DeviceStatusName {
  Inventory = 'inventory',
  Assigned = 'assigned',
  Provisioned = 'provisioned',
  Online = 'online',
  Degraded = 'degraded',
  Offline = 'offline',
  Retired = 'retired',
}

export class DeviceCreateDto {
  @ApiProperty({ example: 'GP-GW-000123' })
  @IsString()
  @Length(3, 64)
  serial!: string;

  @ApiProperty({ enum: DeviceKindName, enumName: 'DeviceKind', example: DeviceKindName.Gateway })
  @IsEnum(DeviceKindName)
  kind!: DeviceKindName;

  @ApiProperty({ example: 'rpi-cm4' })
  @IsString()
  @Length(1, 100)
  model!: string;

  @ApiProperty({ example: 'Collective' })
  @IsString()
  @Length(1, 100)
  vendor!: string;

  @ApiProperty({
    enum: DeviceOwnershipName,
    enumName: 'DeviceOwnership',
    example: DeviceOwnershipName.PlatformHaas,
  })
  @IsEnum(DeviceOwnershipName)
  ownership!: DeviceOwnershipName;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  @IsOptional()
  @IsUUID()
  tenantId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.buildingId })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;
}

export class DeviceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  id!: string;

  @ApiProperty({ example: 'GP-GW-000123' })
  serial!: string;

  @ApiProperty({ enum: DeviceKindName, enumName: 'DeviceKind', example: DeviceKindName.Gateway })
  kind!: DeviceKindName;

  @ApiProperty({ example: 'rpi-cm4' })
  model!: string;

  @ApiProperty({
    enum: DeviceOwnershipName,
    enumName: 'DeviceOwnership',
    example: DeviceOwnershipName.PlatformHaas,
  })
  ownership!: DeviceOwnershipName;

  @ApiProperty({ enum: DeviceStatusName, enumName: 'DeviceStatus', example: DeviceStatusName.Assigned })
  status!: DeviceStatusName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  tenantId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.buildingId })
  buildingId!: string | null;
}

export class ProvisioningCodeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  deviceId!: string;

  @ApiProperty({ example: 'K7QX-2M9P-H4TD', description: 'Shown once; single use; 72 hours.' })
  code!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-04T00:15:00+07:00' })
  expiresAt!: string;
}

export enum OperatorChangeReasonName {
  PmContractStart = 'pm_contract_start',
  PmContractEnd = 'pm_contract_end',
  JuristicFormed = 'juristic_formed',
  Handover = 'handover',
  Other = 'other',
}

export class OperatorChangeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  operatorTenantId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'New owner tenant (omit to keep).',
  })
  @IsOptional()
  @IsUUID()
  ownerTenantId?: string | null;

  @ApiProperty({
    enum: OperatorChangeReasonName,
    enumName: 'OperatorChangeReason',
    example: OperatorChangeReasonName.PmContractStart,
  })
  @IsEnum(OperatorChangeReasonName)
  reason!: OperatorChangeReasonName;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'PM-2026-001' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourceRef?: string | null;
}

export class OperatorChangedDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  ownerTenantId!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  operatorTenantId!: string;
}

export class WorkflowDefinitionDto {
  @ApiProperty({ example: 'deposit_settlement' })
  key!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'null = platform definition.',
  })
  tenantId!: string | null;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [{ key: 'open', initial: true }],
  })
  states!: Record<string, unknown>[];

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [{ from: 'open', event: 'settle', to: 'settled' }],
  })
  transitions!: Record<string, unknown>[];

  @ApiProperty({ example: true })
  active!: boolean;
}

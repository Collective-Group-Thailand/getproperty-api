import { FAKE } from '@common/openapi/examples';
import { CursorQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
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

import { LanguageName, NotificationChannelName } from '../shared/common.dto';

export enum SupportGrantStateName {
  Requested = 'requested',
  Approved = 'approved',
  Active = 'active',
  Expired = 'expired',
  Revoked = 'revoked',
  Denied = 'denied',
}

export enum SupportGrantApprovalViaName {
  InApp = 'in_app',
  PlatformAdminIncident = 'platform_admin_incident',
}

export class SupportGrantDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: 'ตรวจสอบปัญหาการส่งบิลรอบ พ.ย.' })
  reason!: string;

  @ApiProperty({ type: String, nullable: true, example: 'SUP-1024' })
  ticketRef!: string | null;

  @ApiProperty({
    enum: SupportGrantStateName,
    enumName: 'SupportGrantState',
    example: SupportGrantStateName.Active,
  })
  state!: SupportGrantStateName;

  @ApiProperty({
    enum: SupportGrantApprovalViaName,
    enumName: 'SupportGrantApprovalVia',
    nullable: true,
    example: SupportGrantApprovalViaName.InApp,
  })
  approvedVia!: SupportGrantApprovalViaName | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  validFrom!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-11-02T00:15:00+07:00' })
  validTo!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class SupportGrantApproveDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 72,
    example: 4,
    description: 'Hours of access; defaults to and is capped by the `support.grant_max_hours` setting.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(72)
  hours?: number;
}

export enum GrantAccessName {
  Read = 'read',
  Write = 'write',
}

export enum GrantReasonName {
  PmContract = 'pm_contract',
  LandlordUnit = 'landlord_unit',
  OwnerPortal = 'owner_portal',
  Contractor = 'contractor',
  DeveloperPostSale = 'developer_post_sale',
  Warranty = 'warranty',
  JuristicHandover = 'juristic_handover',
  SupportOther = 'support_other',
}

export enum GrantScopeName {
  Building = 'building',
  Unit = 'unit',
}

export class AssetGrantDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.tenantId,
    description: 'Granting tenant (building owner or operator).',
  })
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  granteeTenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  unitId!: string | null;

  @ApiProperty({ enum: GrantScopeName, enumName: 'GrantScope', example: GrantScopeName.Building })
  scope!: GrantScopeName;

  @ApiProperty({
    type: [String],
    example: ['readings'],
    description: 'Module keys (asset-core `GRANT_MODULES`).',
  })
  modules!: string[];

  @ApiProperty({ enum: GrantAccessName, enumName: 'GrantAccess', example: GrantAccessName.Read })
  access!: GrantAccessName;

  @ApiProperty({ enum: GrantReasonName, enumName: 'GrantReason', example: GrantReasonName.PmContract })
  reason!: GrantReasonName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  validFrom!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  validTo!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  revokedAt!: string | null;
}

export class AssetGrantCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  granteeTenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Narrows the grant to one unit.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string | null;

  @ApiProperty({ type: [String], example: ['readings'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  modules!: string[];

  @ApiProperty({ enum: GrantAccessName, enumName: 'GrantAccess', example: GrantAccessName.Read })
  @IsEnum(GrantAccessName)
  access!: GrantAccessName;

  @ApiProperty({ enum: GrantReasonName, enumName: 'GrantReason', example: GrantReasonName.PmContract })
  @IsEnum(GrantReasonName)
  reason!: GrantReasonName;

  @ApiPropertyOptional({ format: 'date-time', example: FAKE.dateTime })
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2027-11-01T00:00:00+07:00',
  })
  @IsOptional()
  @IsDateString()
  validTo?: string | null;
}

export class ReasonDto {
  @ApiProperty({ example: 'สิ้นสุดสัญญาบริหาร', maxLength: 500 })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export enum AuditOutcomeName {
  Success = 'success',
  Denied = 'denied',
  Failure = 'failure',
}

export class AuditEntryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  occurredAt!: string;

  @ApiProperty({ example: 'tenant.bank_account.changed' })
  action!: string;

  @ApiProperty({ enum: AuditOutcomeName, enumName: 'AuditOutcome', example: AuditOutcomeName.Success })
  outcome!: AuditOutcomeName;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { type: 'user', audience: 'operator', id: FAKE.uuid },
    description: 'Actor envelope (user, device or system); a support actor carries the support grant id.',
  })
  actor!: Record<string, unknown>;

  @ApiProperty({ type: String, nullable: true, example: 'core.tenant_bank_account' })
  subjectType!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  subjectId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  buildingId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  supportGrantId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '203.0.113.10' })
  ip!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true, example: { state: 'active' } })
  before!: Record<string, unknown> | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true, example: { state: 'replaced' } })
  after!: Record<string, unknown> | null;

  @ApiProperty({ type: 'object', additionalProperties: true, example: {} })
  metadata!: Record<string, unknown>;
}

export class AuditQueryDto extends CursorQuery {
  @ApiPropertyOptional({
    example: 'tenant.bank_account.*',
    description: 'Exact action, or a prefix ending in `*`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z_.]+\*?$/)
  action?: string;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-10-01T00:00:00+07:00' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-11-01T00:00:00+07:00' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export enum DsrKindName {
  Access = 'access',
  Rectification = 'rectification',
  Erasure = 'erasure',
  Portability = 'portability',
  Objection = 'objection',
  Restriction = 'restriction',
}

export enum DsrStateName {
  Received = 'received',
  Verifying = 'verifying',
  InProgress = 'in_progress',
  Fulfilled = 'fulfilled',
  Rejected = 'rejected',
  Withdrawn = 'withdrawn',
}

export enum DsrActionName {
  Verify = 'verify',
  Start = 'start',
  Fulfil = 'fulfil',
  Reject = 'reject',
}

export class DsrDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  tenantId!: string | null;

  @ApiProperty({ enum: DsrKindName, enumName: 'DsrKind', example: DsrKindName.Access })
  kind!: DsrKindName;

  @ApiProperty({ enum: DsrStateName, enumName: 'DsrState', example: DsrStateName.Received })
  state!: DsrStateName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  receivedAt!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-12-01T00:15:00+07:00',
    description: 'PDPA s.30: 30 days.',
  })
  dueAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  fulfilledAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Export file (access/portability).',
  })
  exportDocumentId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;
}

export class DsrListQuery {
  @ApiPropertyOptional({ enum: DsrStateName, enumName: 'DsrState' })
  @IsOptional()
  @IsEnum(DsrStateName)
  state?: DsrStateName;
}

export class DsrActionDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ยืนยันตัวตนผ่านบัตรประชาชนที่สำนักงานแล้ว',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export enum NotificationAudienceName {
  Resident = 'resident',
  Technician = 'technician',
  Owner = 'owner',
  Manager = 'manager',
  Staff = 'staff',
  Accountant = 'accountant',
  Platform = 'platform',
}

export enum TenantRoutableAudienceName {
  Resident = 'resident',
}

export class NotificationRouteDto {
  @ApiProperty({ example: 'invoice.issued' })
  eventType!: string;

  @ApiProperty({
    enum: NotificationAudienceName,
    enumName: 'NotificationAudience',
    example: NotificationAudienceName.Resident,
  })
  audience!: NotificationAudienceName;

  @ApiProperty({
    enum: NotificationChannelName,
    enumName: 'NotificationChannel',
    example: NotificationChannelName.Line,
  })
  channel!: NotificationChannelName;

  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({ example: false, description: 'Urgent messages ignore quiet hours (platform-defined).' })
  urgent!: boolean;

  @ApiProperty({ example: false, description: 'True when my tenant overrides the platform default.' })
  overridden!: boolean;
}

export class NotificationRouteUpdateDto {
  @ApiProperty({ example: 'invoice.issued' })
  @IsString()
  @Matches(/^[a-z_]+(\.[a-z_]+)+$/)
  @MaxLength(100)
  eventType!: string;

  @ApiProperty({
    enum: TenantRoutableAudienceName,
    enumName: 'TenantRoutableAudience',
    example: TenantRoutableAudienceName.Resident,
    description: 'Only resident-facing routes are tenant-configurable.',
  })
  @IsEnum(TenantRoutableAudienceName)
  audience!: TenantRoutableAudienceName;

  @ApiProperty({
    enum: NotificationChannelName,
    enumName: 'NotificationChannel',
    example: NotificationChannelName.Sms,
  })
  @IsEnum(NotificationChannelName)
  channel!: NotificationChannelName;

  @ApiProperty({ example: false })
  @IsBoolean()
  enabled!: boolean;
}

export class ConsentPurposeDto {
  @ApiProperty({ example: 'resident.service' })
  key!: string;

  @ApiProperty({ example: true })
  required!: boolean;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({ example: 'th' })
  language!: string;

  @ApiProperty({ example: 'การใช้ข้อมูลเพื่อให้บริการผู้พักอาศัย' })
  title!: string;

  @ApiProperty({ example: 'เราใช้ข้อมูลของคุณเพื่อออกบิลและแจ้งเตือน…' })
  bodyMarkdown!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  effectiveFrom!: string;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    example: true,
    description: 'null = never answered, or the version changed since.',
  })
  granted!: boolean | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1 })
  grantedVersion!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  capturedAt!: string | null;
}

export class ConsentItemDto {
  @ApiProperty({ example: 'resident.service' })
  @IsString()
  @MaxLength(100)
  purposeKey!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({ example: true })
  @IsBoolean()
  granted!: boolean;
}

export class ConsentCaptureDto {
  @ApiProperty({ type: [ConsentItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ConsentItemDto)
  items!: ConsentItemDto[];

  @ApiPropertyOptional({
    enum: LanguageName,
    enumName: 'Language',
    example: LanguageName.Th,
    description: 'Language of the text shown.',
  })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: 'th' | 'en';
}

export class ConsentCapturedDto {
  @ApiProperty({
    type: 'integer',
    example: 2,
    description: 'Consent rows written (one per purpose and controller).',
  })
  recorded!: number;

  @ApiProperty({ type: [ConsentPurposeDto] })
  purposes!: ConsentPurposeDto[];
}

export class DsrCreateDto {
  @ApiProperty({ enum: DsrKindName, enumName: 'DsrKind', example: DsrKindName.Access })
  @IsEnum(DsrKindName)
  kind!: DsrKindName;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.tenantId,
    description:
      'The controller (tenant) the request is addressed to; omitted = every tenant I am a resident of.',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ขอสำเนาข้อมูลส่วนบุคคลทั้งหมด',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  details?: string | null;
}

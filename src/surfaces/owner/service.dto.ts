import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  Min,
} from 'class-validator';

import { ResidentUploadContentTypeName } from './deposits.dto';
import { ServiceDecisionStateDto } from './service-costs.dto';

const toBool = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : value === true || value === 'true' || value === '1';

// ------------------------------------------------------------------------------------------------- named enums

export enum ServiceRequestStatusName {
  New = 'new',
  Triaged = 'triaged',
  Assigned = 'assigned',
  InProgress = 'in_progress',
  WaitingParts = 'waiting_parts',
  Done = 'done',
  Closed = 'closed',
  Cancelled = 'cancelled',
}

export enum WorkOrderStatusName {
  Open = 'open',
  Assigned = 'assigned',
  Accepted = 'accepted',
  InProgress = 'in_progress',
  Done = 'done',
  Verified = 'verified',
  Cancelled = 'cancelled',
}

export enum ServicePriorityName {
  Low = 'low',
  Normal = 'normal',
  High = 'high',
  Urgent = 'urgent',
}

export enum ServiceReporterKindName {
  Resident = 'resident',
  Staff = 'staff',
  Owner = 'owner',
  System = 'system',
}

export enum WorkOrderKindName {
  Repair = 'repair',
  Preventive = 'preventive',
  Install = 'install',
  Deinstall = 'deinstall',
  Inspection = 'inspection',
}

export enum WorkOrderCostKindName {
  Part = 'part',
  Labour = 'labour',
  Travel = 'travel',
  Other = 'other',
}

export enum WorkOrderPhotoRoleName {
  Before = 'before',
  After = 'after',
}

export enum AssigneeTypeName {
  User = 'user',
  Party = 'party',
}

export enum ServiceCategorySourceName {
  Platform = 'platform',
  Tenant = 'tenant',
}

/** `ops.visit_preference` (LIFF #24, D-218). */
export enum VisitPreferenceName {
  Anytime = 'anytime',
  Morning = 'morning',
  Afternoon = 'afternoon',
  Evening = 'evening',
}

/** Role of a request / work-order photo (LIFF #22, #25). */
export enum ServicePhotoRoleName {
  Report = 'report',
  Before = 'before',
  After = 'after',
}

/** `ops.service_message_author` (LIFF #23). */
export enum ServiceMessageAuthorName {
  Resident = 'resident',
  Office = 'office',
  Technician = 'technician',
  System = 'system',
}

/** The SLA of a request as the resident sees it (LIFF #22, D-159). */
export enum ServiceSlaStateName {
  OnTrack = 'on_track',
  AtRisk = 'at_risk',
  Breached = 'breached',
  Paused = 'paused',
  None = 'none',
}

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const QUANTITY = /^\d{1,9}(\.\d{1,3})?$/;

// -------------------------------------------------------------------------------------------------- categories

export class ServiceCategoryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'Send this id as `categoryId`.' })
  id!: string;

  @ApiProperty({ example: 'plumbing' })
  key!: string;

  @ApiProperty({ example: 'ประปา' })
  nameTh!: string;

  @ApiProperty({ example: 'Plumbing' })
  nameEn!: string;

  @ApiProperty({ type: 'integer', example: 24, description: 'Default SLA of a request of this category.' })
  slaHours!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  sortOrder!: number;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({
    enum: ServiceCategorySourceName,
    enumName: 'ServiceCategorySource',
    example: ServiceCategorySourceName.Platform,
    description: '`platform` default or the tenant’s own version of the key.',
  })
  source!: ServiceCategorySourceName;
}

export class ServiceCategoryRefDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'plumbing' })
  key!: string;

  @ApiProperty({ example: 'ประปา' })
  nameTh!: string;

  @ApiProperty({ example: 'Plumbing' })
  nameEn!: string;
}

export class ServiceCategoriesDto {
  @ApiProperty({ type: [ServiceCategoryDto] })
  data!: ServiceCategoryDto[];
}

export class ServiceCategoryPutDto {
  @ApiPropertyOptional({ example: 'ประปาและท่อน้ำ', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  nameTh?: string;

  @ApiPropertyOptional({ example: 'Plumbing', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  nameEn?: string;

  @ApiProperty({ type: 'integer', example: 12, minimum: 1, maximum: 2160 })
  @IsInt()
  @Min(1)
  @Max(2160)
  slaHours!: number;

  @ApiPropertyOptional({ type: 'integer', example: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional({ example: true, description: 'false hides the category from new requests.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CategoryListQuery {
  @ApiPropertyOptional({ type: Boolean, description: 'Include hidden categories.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeInactive?: boolean;
}

// ---------------------------------------------------------------------------------------------- work orders

export class WorkOrderSummaryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: WorkOrderKindName, enumName: 'WorkOrderKind', example: WorkOrderKindName.Repair })
  kind!: WorkOrderKindName;

  @ApiProperty({ example: 'เปลี่ยนก๊อกน้ำ' })
  title!: string;

  @ApiProperty({
    enum: WorkOrderStatusName,
    enumName: 'WorkOrderStatus',
    example: WorkOrderStatusName.Assigned,
  })
  status!: WorkOrderStatusName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  assigneePartyId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  assigneeUserId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  scheduledAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  completedAt!: string | null;
}

export class CostLineDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: WorkOrderCostKindName,
    enumName: 'WorkOrderCostKind',
    example: WorkOrderCostKindName.Part,
  })
  kind!: WorkOrderCostKindName;

  @ApiProperty({ example: 'ก๊อกน้ำ' })
  description!: string;

  @ApiProperty({ example: '1.000' })
  quantity!: string;

  @ApiProperty({ example: '350.00' })
  unitPrice!: string;

  @ApiProperty({ example: '350.00' })
  amount!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  vendorPartyId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  receiptDocumentId!: string | null;
}

export class AssigneeDto {
  @ApiProperty({
    enum: AssigneeTypeName,
    enumName: 'AssigneeType',
    example: AssigneeTypeName.Party,
    description: 'Staff login (`user`) or technician party (`party`).',
  })
  type!: AssigneeTypeName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'ช่างทดสอบ' })
  displayName!: string;
}

export class WorkOrderDto {
  @ApiProperty({
    type: [String],
    example: ['assign', 'cancel'],
    description: 'Actions (`…/actions/{name}`) the caller may take now — never infer them from the status.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: WorkOrderKindName, enumName: 'WorkOrderKind', example: WorkOrderKindName.Repair })
  kind!: WorkOrderKindName;

  @ApiProperty({
    enum: WorkOrderStatusName,
    enumName: 'WorkOrderStatus',
    example: WorkOrderStatusName.Assigned,
  })
  status!: WorkOrderStatusName;

  @ApiProperty({ example: 'เปลี่ยนก๊อกน้ำ' })
  title!: string;

  @ApiProperty({ type: String, nullable: true, example: 'ก๊อกน้ำอ่างล้างหน้ารั่ว' })
  description!: string | null;

  @ApiProperty({
    enum: ServicePriorityName,
    enumName: 'ServicePriority',
    example: ServicePriorityName.Normal,
  })
  priority!: ServicePriorityName;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  serviceRequestId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  assetItemId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  maintenancePlanId!: string | null;

  @ApiProperty({ type: AssigneeDto, nullable: true })
  assignee!: AssigneeDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  scheduledAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'End of the visit window (time-boxed door codes of the assignee follow it, B5.2).',
  })
  scheduledUntil!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  assignedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  acceptedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  checkedInAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  completedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  verifiedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancelReason!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  completionNote!: string | null;

  @ApiProperty({ example: '350.00', description: 'Σ cost lines (THB).' })
  costTotal!: string;

  @ApiProperty({ type: [CostLineDto] })
  costLines!: CostLineDto[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: [FAKE.uuid],
    description: 'Photo file ids before.',
  })
  beforePhotoIds!: string[];

  @ApiProperty({ type: [String], format: 'uuid', example: [], description: 'Photo file ids after.' })
  afterPhotoIds!: string[];

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class WorkOrderListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ enum: WorkOrderStatusName, enumName: 'WorkOrderStatus' })
  @IsOptional()
  @IsEnum(WorkOrderStatusName)
  status?: WorkOrderStatusName;

  @ApiPropertyOptional({ enum: WorkOrderKindName, enumName: 'WorkOrderKind' })
  @IsOptional()
  @IsEnum(WorkOrderKindName)
  kind?: WorkOrderKindName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  serviceRequestId?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Only work orders assigned to me (staff PWA).' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  mine?: boolean;

  @ApiPropertyOptional({ type: Boolean, description: 'Only open / assigned / accepted / in progress.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  active?: boolean;
}

export class WorkOrderAssignDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: 'A member who handles service requests in the building (staff PWA); or',
  })
  @IsOptional()
  @IsUUID()
  assigneeUserId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'an external technician (a party of the tenant with a LINE id → technician app).',
  })
  @IsOptional()
  @IsUUID()
  assigneePartyId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: null })
  @IsOptional()
  @IsDateString()
  scheduledUntil?: string | null;
}

export class WorkOrderCreateDto extends WorkOrderAssignDto {
  @ApiProperty({ enum: WorkOrderKindName, enumName: 'WorkOrderKind', example: WorkOrderKindName.Repair })
  @IsEnum(WorkOrderKindName)
  kind!: WorkOrderKindName;

  @ApiProperty({ example: 'เปลี่ยนก๊อกน้ำ', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @IsString()
  @Length(0, 5000)
  description?: string | null;

  @ApiPropertyOptional({ enum: ServicePriorityName, enumName: 'ServicePriority' })
  @IsOptional()
  @IsEnum(ServicePriorityName)
  priority?: ServicePriorityName;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The request it works on.',
  })
  @IsOptional()
  @IsUUID()
  serviceRequestId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Equipment (preventive).',
  })
  @IsOptional()
  @IsUUID()
  assetItemId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  unitId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Common-area work.' })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;
}

export class WorkOrderNoteDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'เปลี่ยนก๊อกใหม่แล้ว ทดสอบไม่รั่ว',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string | null;
}

export class WorkOrderPhotoAttachDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'An uploaded file of kind `service_photo`.',
  })
  @IsUUID()
  documentId!: string;

  @ApiProperty({
    enum: WorkOrderPhotoRoleName,
    enumName: 'WorkOrderPhotoRole',
    example: WorkOrderPhotoRoleName.After,
  })
  @IsEnum(WorkOrderPhotoRoleName)
  role!: WorkOrderPhotoRoleName;
}

export class CostLineCreateDto {
  @ApiPropertyOptional({ enum: WorkOrderCostKindName, enumName: 'WorkOrderCostKind' })
  @IsOptional()
  @IsEnum(WorkOrderCostKindName)
  kind?: WorkOrderCostKindName;

  @ApiProperty({ example: 'ก๊อกน้ำ', maxLength: 500 })
  @IsString()
  @Length(1, 500)
  description!: string;

  @ApiPropertyOptional({ example: '1', description: 'Decimal string, up to 3 decimals (default 1).' })
  @IsOptional()
  @Matches(QUANTITY)
  quantity?: string;

  @ApiProperty({ example: '350.00', description: 'THB per unit, decimal string.' })
  @Matches(MONEY)
  unitPrice!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Supplier party.' })
  @IsOptional()
  @IsUUID()
  vendorPartyId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Supplier receipt file.',
  })
  @IsOptional()
  @IsUUID()
  receiptDocumentId?: string | null;
}

// ------------------------------------------------------------------------------------- photos, SLA, messages

export class ServicePhotoDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: ServicePhotoRoleName,
    enumName: 'ServicePhotoRole',
    example: ServicePhotoRoleName.Report,
    description: '`report` = the resident’s photo of the problem; `before` / `after` = the technician’s.',
  })
  role!: ServicePhotoRoleName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://storage.example.com/service-photo?X-Amz-Signature=abc',
    description: '5-minute signed link; null while the file is not scanned clean.',
  })
  url!: string | null;
}

export class ServiceStatusEventDto {
  @ApiProperty({
    enum: ServiceRequestStatusName,
    enumName: 'ServiceRequestStatus',
    example: ServiceRequestStatusName.New,
  })
  status!: ServiceRequestStatusName;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  at!: string;
}

export class ServiceSlaDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-11-02T00:15:00+07:00',
    description: 'Due time while the clock runs (or when it breached); null when paused or done.',
  })
  dueAt!: string | null;

  @ApiProperty({
    enum: ServiceSlaStateName,
    enumName: 'ServiceSlaState',
    example: ServiceSlaStateName.OnTrack,
    description:
      '`at_risk` within 2 h of the due time, `paused` while referred to the developer’s warranty, `none` once the work is done or the request ended.',
  })
  state!: ServiceSlaStateName;
}

export class ServiceMessageDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: ServiceMessageAuthorName,
    enumName: 'ServiceMessageAuthor',
    example: ServiceMessageAuthorName.Office,
  })
  author!: ServiceMessageAuthorName;

  @ApiProperty({ example: 'สมชาย (นิติบุคคล)', description: 'A display name — never a phone number.' })
  authorName!: string;

  @ApiProperty({ example: 'ช่างจะเข้าไปพรุ่งนี้ 10 โมงนะคะ', maxLength: 2000 })
  body!: string;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ example: false, description: 'Written by my login.' })
  mine!: boolean;
}

export class ServiceMessagesDto {
  @ApiProperty({ type: [ServiceMessageDto], description: 'Oldest first (the last 500).' })
  data!: ServiceMessageDto[];
}

export class ServiceMessageCreateDto {
  @ApiProperty({ example: 'สะดวกช่วงบ่ายค่ะ', minLength: 1, maxLength: 2000 })
  @IsString()
  @Length(1, 2000)
  body!: string;
}

// ------------------------------------------------------------------------------------------ service requests

export class ServiceRequestDto {
  @ApiProperty({
    type: [String],
    example: ['triage', 'create-work-order', 'cancel'],
    description: 'Actions (`…/actions/{name}`) the caller may take now — never infer them from the status.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    example: 'C566A962',
    description: 'Short reference for conversations (last id characters).',
  })
  ref!: string;

  @ApiProperty({
    enum: ServiceRequestStatusName,
    enumName: 'ServiceRequestStatus',
    example: ServiceRequestStatusName.New,
  })
  status!: ServiceRequestStatusName;

  @ApiProperty({
    enum: ServicePriorityName,
    enumName: 'ServicePriority',
    example: ServicePriorityName.Normal,
  })
  priority!: ServicePriorityName;

  @ApiProperty({
    enum: ServiceReporterKindName,
    enumName: 'ServiceReporterKind',
    example: ServiceReporterKindName.Resident,
  })
  reporterKind!: ServiceReporterKindName;

  @ApiProperty({ type: ServiceCategoryRefDto })
  category!: ServiceCategoryRefDto;

  @ApiProperty({ example: 'ก๊อกน้ำอ่างล้างหน้ารั่ว' })
  description!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  assetItemId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  requesterPartyId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.nameTh })
  requesterName!: string | null;

  @ApiProperty({ type: 'integer', example: 24, description: 'SLA of the category when reported.' })
  slaHours!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  slaDueAt!: string | null;

  @ApiProperty({ example: false, description: 'True once the SLA breached (emitted once, D-159).' })
  slaBreached!: boolean;

  @ApiProperty({
    example: false,
    description:
      'Inside a getbuild warranty: referred to the developer instead of the building’s technician (D-153).',
  })
  inWarranty!: boolean;

  @ApiProperty({ type: String, nullable: true, example: null })
  warrantyResolution!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Automatic requests (D-034).' })
  autoReason!: string | null;

  @ApiProperty({ type: [String], format: 'uuid', example: [FAKE.uuid] })
  photoIds!: string[];

  @ApiProperty({ type: [WorkOrderSummaryDto] })
  workOrders!: WorkOrderSummaryDto[];

  @ApiProperty({ type: 'integer', nullable: true, example: null, minimum: 1, maximum: 5 })
  rating!: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  ratingComment!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  triagedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  doneAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  closedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancelReason!: string | null;

  @ApiProperty({
    enum: VisitPreferenceName,
    enumName: 'VisitPreference',
    nullable: true,
    example: VisitPreferenceName.Afternoon,
    description: 'When the resident prefers the visit (LIFF #24).',
  })
  preferredVisit!: VisitPreferenceName | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'The resident confirmed the planned visit (null again once the visit is moved).',
  })
  visitConfirmedAt!: string | null;

  @ApiProperty({
    type: ServiceDecisionStateDto,
    nullable: true,
    description:
      'Landlords (D-263): who fixes it and who pays; null until the owner decides (and for buildings).',
  })
  decision!: ServiceDecisionStateDto | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ServiceRequestListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: ServiceRequestStatusName, enumName: 'ServiceRequestStatus' })
  @IsOptional()
  @IsEnum(ServiceRequestStatusName)
  status?: ServiceRequestStatusName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  inWarranty?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Only new / triaged / assigned / in progress / waiting.',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  open?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Only requests whose SLA breached (`true`) or not (`false`); with `open=true` = overdue (D-159).',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  slaBreached?: boolean;
}

export class ServiceRequestCreateDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  unitId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Common area: the building (when no unit or asset item).',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: null })
  @IsOptional()
  @IsUUID()
  assetItemId?: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'ก๊อกน้ำอ่างล้างหน้ารั่ว', maxLength: 5000 })
  @IsString()
  @Length(1, 5000)
  description!: string;

  @ApiPropertyOptional({ enum: ServicePriorityName, enumName: 'ServicePriority' })
  @IsOptional()
  @IsEnum(ServicePriorityName)
  priority?: ServicePriorityName;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Who reported it.' })
  @IsOptional()
  @IsUUID()
  requesterPartyId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: [FAKE.uuid],
    description: 'Uploaded files of kind `service_photo` (at most 10).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  photoDocumentIds?: string[];
  @ApiPropertyOptional({
    enum: VisitPreferenceName,
    enumName: 'VisitPreference',
    nullable: true,
    description: 'When the technician may come (LIFF #24).',
  })
  @IsOptional()
  @IsEnum(VisitPreferenceName)
  preferredVisit?: VisitPreferenceName | null;
}

export class ServiceTriageDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: ServicePriorityName, enumName: 'ServicePriority' })
  @IsOptional()
  @IsEnum(ServicePriorityName)
  priority?: ServicePriorityName;
}

export class ServiceTimelineEntryDto {
  @ApiProperty({ type: String, nullable: true, example: 'new' })
  from!: string | null;

  @ApiProperty({ example: 'triaged' })
  to!: string;

  @ApiProperty({
    example: 'triage',
    description: 'Workflow event (`sla_warning`, `sla_breached` for timers).',
  })
  event!: string;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  at!: string;
}

export class ServiceTimelineDto {
  @ApiProperty({ type: [ServiceTimelineEntryDto] })
  data!: ServiceTimelineEntryDto[];
}

// -------------------------------------------------------------------------------------- maintenance plans

export class MaintenancePlanDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  assetItemId!: string;

  @ApiProperty({ example: 'ปั๊มน้ำหลัก' })
  assetItemName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  categoryId!: string | null;

  @ApiProperty({ example: 'ล้างและตรวจปั๊มน้ำ' })
  title!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  description!: string | null;

  @ApiProperty({ type: 'integer', example: 90 })
  intervalDays!: number;

  @ApiProperty({ type: 'integer', example: 7 })
  leadDays!: number;

  @ApiProperty({ format: 'date', example: FAKE.date })
  nextDueOn!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  assigneeUserId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  assigneePartyId!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  lastWorkOrderId!: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class MaintenancePlansDto {
  @ApiProperty({ type: [MaintenancePlanDto] })
  data!: MaintenancePlanDto[];
}

export class MaintenancePlanQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetItemId?: string;
}

export class MaintenancePlanUpdateDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ example: 'ล้างและตรวจปั๊มน้ำ', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @IsString()
  @Length(0, 5000)
  description?: string | null;

  @ApiPropertyOptional({ type: 'integer', example: 90, minimum: 1, maximum: 3660 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3660)
  intervalDays?: number;

  @ApiPropertyOptional({ type: 'integer', example: 7, minimum: 0, maximum: 90 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  leadDays?: number;

  @ApiPropertyOptional({ format: 'date', example: FAKE.date })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  nextDueOn?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  assigneeUserId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  assigneePartyId?: string | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class MaintenancePlanCreateDto extends MaintenancePlanUpdateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  assetItemId!: string;

  @ApiProperty({ example: 'ล้างและตรวจปั๊มน้ำ', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  declare title: string;

  @ApiProperty({ type: 'integer', example: 90, minimum: 1, maximum: 3660 })
  @IsInt()
  @Min(1)
  @Max(3660)
  declare intervalDays: number;

  @ApiProperty({ format: 'date', example: FAKE.date, description: 'First due date.' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  declare nextDueOn: string;
}

// --------------------------------------------------------------------------------------- resident (LIFF)

export class ResidentServiceRequestDto {
  @ApiProperty({
    type: [String],
    example: ['cancel'],
    description: '`cancel` before work starts, `rate` when done.',
  })
  nextActions!: string[];

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'C566A962' })
  ref!: string;

  @ApiProperty({
    enum: ServiceRequestStatusName,
    enumName: 'ServiceRequestStatus',
    example: ServiceRequestStatusName.Assigned,
  })
  status!: ServiceRequestStatusName;

  @ApiProperty({
    enum: ServicePriorityName,
    enumName: 'ServicePriority',
    example: ServicePriorityName.Normal,
  })
  priority!: ServicePriorityName;

  @ApiProperty({ type: ServiceCategoryRefDto })
  category!: ServiceCategoryRefDto;

  @ApiProperty({ example: 'ก๊อกน้ำอ่างล้างหน้ารั่ว' })
  description!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ type: [String], format: 'uuid', example: [FAKE.uuid] })
  photoIds!: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: FAKE.dateTime,
    description: 'When the visit is planned (first scheduled work order), if any.',
  })
  visitAt!: string | null;

  @ApiProperty({ example: false })
  inWarranty!: boolean;

  @ApiProperty({ type: 'integer', nullable: true, example: null })
  rating!: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  ratingComment!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  doneAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  closedAt!: string | null;

  @ApiProperty({
    enum: VisitPreferenceName,
    enumName: 'VisitPreference',
    nullable: true,
    example: VisitPreferenceName.Afternoon,
  })
  preferredVisit!: VisitPreferenceName | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'When I confirmed the planned visit (`visitAt`); null until then or once the visit moved.',
  })
  visitConfirmedAt!: string | null;

  @ApiProperty({
    type: [ServicePhotoDto],
    description: 'My report photos, then the technician’s before / after photos (5-minute links, D-072).',
  })
  photos!: ServicePhotoDto[];

  @ApiProperty({ type: [ServiceStatusEventDto], description: 'Status history, oldest first.' })
  events!: ServiceStatusEventDto[];

  @ApiProperty({
    type: ServiceSlaDto,
    nullable: true,
    description: 'Null for a request without an SLA clock.',
  })
  sla!: ServiceSlaDto | null;

  @ApiProperty({
    type: ServiceDecisionStateDto,
    nullable: true,
    description:
      'Landlords (D-263): who fixes it and who pays; null until the owner decides (and for buildings).',
  })
  decision!: ServiceDecisionStateDto | null;
}

export class ResidentServiceRequestCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'A unit I occupy (`unit:` scope).' })
  @IsUUID()
  unitId!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'From `GET …/service-categories?unitId=`.',
  })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'ก๊อกน้ำอ่างล้างหน้ารั่ว', maxLength: 5000 })
  @IsString()
  @Length(1, 5000)
  description!: string;

  @ApiPropertyOptional({ enum: ServicePriorityName, enumName: 'ServicePriority' })
  @IsOptional()
  @IsEnum(ServicePriorityName)
  priority?: ServicePriorityName;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: [FAKE.uuid],
    description: 'Photos I uploaded (`POST /v1/resident/uploads`, purpose `service_request`), at most 10.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  photoDocumentIds?: string[];
  @ApiPropertyOptional({
    enum: VisitPreferenceName,
    enumName: 'VisitPreference',
    nullable: true,
    description: 'When the technician may come (LIFF #24).',
  })
  @IsOptional()
  @IsEnum(VisitPreferenceName)
  preferredVisit?: VisitPreferenceName | null;
}

export class ResidentCategoryQuery {
  @ApiProperty({ format: 'uuid', description: 'The unit the request is for.' })
  @IsUUID()
  unitId!: string;
}

export class ResidentRequestListQuery extends PageQuery {
  @ApiPropertyOptional({ type: Boolean, description: 'Only not yet closed or cancelled.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  open?: boolean;
}

export class ServiceRatingDto {
  @ApiProperty({ type: 'integer', example: 5, minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ช่างมาตรงเวลา', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  comment?: string | null;
}

// ---------------------------------------------------------------------------------------- technician (LIFF)

export class TechnicianWorkOrderDto extends WorkOrderDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
    description: 'Of the request.',
  })
  requestDescription!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'plumbing' })
  categoryKey!: string | null;

  @ApiProperty({ type: [String], format: 'uuid', example: [FAKE.uuid], description: 'Report photos.' })
  requestPhotoIds!: string[];

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({
    type: [ServicePhotoDto],
    description:
      'The resident’s report photos and my before / after photos of this work order (5-minute links).',
  })
  photos!: ServicePhotoDto[];

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: null,
    minimum: 1,
    maximum: 5,
    description: 'The resident’s rating once given (the rating closes the request).',
  })
  rating!: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  ratingComment!: string | null;

  @ApiProperty({
    enum: VisitPreferenceName,
    enumName: 'VisitPreference',
    nullable: true,
    example: VisitPreferenceName.Afternoon,
    description: 'When the resident prefers the visit.',
  })
  preferredVisit!: VisitPreferenceName | null;
}

export class TechnicianWorkOrdersDto {
  @ApiProperty({ type: [TechnicianWorkOrderDto] })
  data!: TechnicianWorkOrderDto[];
}

export class TechnicianPhotoPresignDto {
  @ApiProperty({
    enum: WorkOrderPhotoRoleName,
    enumName: 'WorkOrderPhotoRole',
    example: WorkOrderPhotoRoleName.After,
  })
  @IsEnum(WorkOrderPhotoRoleName)
  role!: WorkOrderPhotoRoleName;

  @ApiProperty({
    enum: ResidentUploadContentTypeName,
    enumName: 'ResidentUploadContentType',
    example: ResidentUploadContentTypeName.Jpeg,
  })
  @IsEnum(ResidentUploadContentTypeName)
  contentType!: ResidentUploadContentTypeName;

  @ApiProperty({ type: 'integer', example: 2345678, description: 'At most 10 MB.' })
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  sizeBytes!: number;

  @ApiProperty({ example: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' })
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256!: string;
}

export class TechnicianPhotoUploadDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  fileId!: string;

  @ApiProperty({
    enum: WorkOrderPhotoRoleName,
    enumName: 'WorkOrderPhotoRole',
    example: WorkOrderPhotoRoleName.After,
  })
  role!: WorkOrderPhotoRoleName;

  @ApiProperty({ example: 'https://storage.example.com/upload?X-Amz-Signature=abc' })
  uploadUrl!: string;

  @ApiProperty({ example: 'PUT' })
  method!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'Content-Type': 'image/jpeg' },
  })
  headers!: Record<string, string>;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;
}

/** `scheduledAt` / `scheduledUntil` strings → dates (undefined = unchanged, null = cleared). */
export function windowOf(dto: { scheduledAt?: string | null; scheduledUntil?: string | null }): {
  scheduledAt?: Date | null;
  scheduledUntil?: Date | null;
} {
  return {
    ...(dto.scheduledAt !== undefined
      ? { scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null }
      : {}),
    ...(dto.scheduledUntil !== undefined
      ? { scheduledUntil: dto.scheduledUntil ? new Date(dto.scheduledUntil) : null }
      : {}),
  };
}

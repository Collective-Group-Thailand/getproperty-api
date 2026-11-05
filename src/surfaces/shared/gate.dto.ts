import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
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

import { ActiveStatusName } from '../owner/assets.dto';
import { ResidentUploadContentTypeName } from '../owner/deposits.dto';

/** J4.1 gate & visitor DTOs shared by the guard, owner and resident surfaces (D-315, D-320, D-327). */

export enum VisitKindName {
  Guest = 'guest',
  Delivery = 'delivery',
  Contractor = 'contractor',
  ResidentVehicle = 'resident_vehicle',
  Other = 'other',
}
export enum InviteVisitorKindName {
  Guest = 'guest',
  Delivery = 'delivery',
  Contractor = 'contractor',
  Other = 'other',
}
export enum VisitStateName {
  Requested = 'requested',
  Approved = 'approved',
  Denied = 'denied',
  TimedOut = 'timed_out',
  Entered = 'entered',
  Exited = 'exited',
  Cancelled = 'cancelled',
}
export enum VisitEntryBasisName {
  Approval = 'approval',
  Invite = 'invite',
  RememberedVehicle = 'remembered_vehicle',
  DeliveryDropPoint = 'delivery_drop_point',
  Policy = 'policy',
  GuardOverride = 'guard_override',
  Offline = 'offline',
  ResidentVehicle = 'resident_vehicle',
}
export enum GatePolicyActionName {
  AllowAndLog = 'allow_and_log',
  Deny = 'deny',
  GuardCalls = 'guard_calls',
}
export enum VisitActorKindName {
  Guard = 'guard',
  Resident = 'resident',
  Operator = 'operator',
  System = 'system',
  Device = 'device',
}
export enum VisitEventKindName {
  Created = 'created',
  Notified = 'notified',
  Answered = 'answered',
  PolicyApplied = 'policy_applied',
  Entered = 'entered',
  Exited = 'exited',
  Cancelled = 'cancelled',
  PhotoAdded = 'photo_added',
  Overstayed = 'overstayed',
  Note = 'note',
  GateOpened = 'gate_opened',
}
export enum GateKindName {
  Main = 'main',
  Side = 'side',
  Service = 'service',
}
/** A gate is `active` or `inactive` — the shared `ActiveStatus` enum. */
export const GateStateName = ActiveStatusName;
export type GateStateName = ActiveStatusName;
export enum GateDeviceStateName {
  Pending = 'pending',
  Active = 'active',
  Revoked = 'revoked',
}
export enum GateDeviceKindName {
  GuardTablet = 'guard_tablet',
  Barrier = 'barrier',
  Lpr = 'lpr',
}
/** J4.2 (D-328): the position a barrier last reported (`gate.state`). */
export enum GateHwStateName {
  Open = 'open',
  Closed = 'closed',
  Fault = 'fault',
}
export enum GateGuardStateName {
  Active = 'active',
  Revoked = 'revoked',
}
export enum VisitInviteUsageName {
  Single = 'single',
  Multi = 'multi',
}
export enum VisitInviteStateName {
  PendingApproval = 'pending_approval',
  Active = 'active',
  Rejected = 'rejected',
  Revoked = 'revoked',
}
export enum RememberedVehicleKindName {
  Resident = 'resident',
  Visitor = 'visitor',
}
/** JPEG / PNG / WebP — the shared `ResidentUploadContentType` enum. */
export const VisitPhotoMimeName = ResidentUploadContentTypeName;
export type VisitPhotoMimeName = ResidentUploadContentTypeName;
export enum GuardVisitViewName {
  Waiting = 'waiting',
  Inside = 'inside',
  Today = 'today',
}

export const PLATE_EXAMPLE = { category: '1กข', number: '1234', province: 'กรุงเทพมหานคร' };

export class PlateDto {
  @ApiProperty({
    example: '1กข',
    description: 'Thai category: 1–4 digits / Thai consonants with at least one consonant.',
  })
  @IsString()
  @Length(1, 8)
  category!: string;

  @ApiProperty({ example: '1234', description: '1–4 digits.' })
  @IsString()
  @Matches(/^[0-9\s-]{1,6}$/)
  number!: string;

  @ApiProperty({ example: 'กรุงเทพมหานคร', description: 'Province (1–60 characters, from the web list).' })
  @IsString()
  @Length(1, 60)
  province!: string;
}

export class HousePolicyDto {
  @ApiProperty({
    type: 'integer',
    example: 180,
    description: 'Seconds the gate waits for an answer (60–900).',
  })
  timeoutSeconds!: number;

  @ApiProperty({
    enum: GatePolicyActionName,
    enumName: 'GatePolicyAction',
    example: GatePolicyActionName.GuardCalls,
  })
  action!: GatePolicyActionName;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    example: null,
    description: 'Deliveries enter without asking (null = the estate setting `gate.delivery_drop_point`).',
  })
  deliverySkipApproval!: boolean | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'กดกริ่งหน้าบ้านได้เลย',
    description: 'Household note for the guard (≤ 300).',
  })
  householdNote!: string | null;

  @ApiProperty({ example: false, description: 'False = the estate defaults (`gate.policy.*`) apply.' })
  custom!: boolean;
}

export class HousePolicyUpdateDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 60, maximum: 900, example: 180 })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(900)
  timeoutSeconds?: number;

  @ApiPropertyOptional({
    enum: GatePolicyActionName,
    enumName: 'GatePolicyAction',
    example: GatePolicyActionName.GuardCalls,
  })
  @IsOptional()
  @IsEnum(GatePolicyActionName)
  action?: GatePolicyActionName;

  @ApiPropertyOptional({ type: Boolean, nullable: true, example: null })
  @IsOptional()
  @IsBoolean()
  deliverySkipApproval?: boolean | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300, example: 'กดกริ่งหน้าบ้านได้เลย' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  householdNote?: string | null;
}

export const POLICY_EXAMPLE: HousePolicyDto = {
  timeoutSeconds: 180,
  action: GatePolicyActionName.GuardCalls,
  deliverySkipApproval: null,
  householdNote: null,
  custom: false,
};

export class PrivacyNoticeDto {
  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({ example: 'นิติบุคคลเก็บทะเบียนรถ ชื่อ (ถ้าให้) เลขบัตร 4 ตัวท้าย (ถ้าให้) …' })
  th!: string;

  @ApiProperty({ example: 'The juristic person records the plate, your name (optional) …' })
  en!: string;

  @ApiProperty({
    type: 'integer',
    example: 90,
    description: 'Days before the gate data is deleted (`gate.retention_days`).',
  })
  retentionDays!: number;
}

export const NOTICE_EXAMPLE: PrivacyNoticeDto = {
  version: 1,
  th: 'นิติบุคคลเก็บทะเบียนรถ ชื่อ (ถ้าให้) เลขบัตร 4 ตัวท้าย (ถ้าให้) และรูปถ่าย (ถ้ามี) ของผู้มาติดต่อ …',
  en: 'The juristic person records the plate, your name (optional), the last 4 digits of your ID (optional) …',
  retentionDays: 90,
};

/** A visit as the household (resident) and every surface sees it. */
export class VisitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  gateId!: string;

  @ApiProperty({ example: 'ป้อมหน้า' })
  gateName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '88/12' })
  unitNo!: string | null;

  @ApiProperty({ enum: VisitKindName, enumName: 'VisitKind', example: VisitKindName.Guest })
  kind!: VisitKindName;

  @ApiProperty({ enum: VisitStateName, enumName: 'VisitState', example: VisitStateName.Requested })
  state!: VisitStateName;

  @ApiProperty({ enum: VisitEntryBasisName, enumName: 'VisitEntryBasis', nullable: true, example: null })
  entryBasis!: VisitEntryBasisName | null;

  @ApiProperty({ type: PlateDto, nullable: true, example: PLATE_EXAMPLE })
  plate!: PlateDto | null;

  @ApiProperty({ type: String, nullable: true, example: 'สมชาย' })
  visitorName!: string | null;

  @ApiProperty({ example: false })
  hasPhoto!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-11-05T18:03:00+07:00',
    description: 'When the house policy applies if nobody answers.',
  })
  respondBy!: string | null;

  @ApiProperty({
    enum: GatePolicyActionName,
    enumName: 'GatePolicyAction',
    nullable: true,
    example: GatePolicyActionName.GuardCalls,
  })
  timeoutAction!: GatePolicyActionName | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  decidedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      '`timeout`, `nobody_reachable`, `blacklisted`, `no_destination` or the guard override reason.',
  })
  decisionReason!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'A resident asked the guard to call.',
  })
  callMeAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  enteredAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  exitedAt!: string | null;

  @ApiProperty({ enum: VisitActorKindName, enumName: 'VisitActorKind', nullable: true, example: null })
  exitedBy!: VisitActorKindName | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-11-05T18:00:00+07:00' })
  createdAt!: string;
}

export const VISIT_EXAMPLE: VisitDto = {
  id: FAKE.uuid,
  gateId: FAKE.uuid,
  gateName: 'ป้อมหน้า',
  unitId: FAKE.uuid,
  unitNo: '88/12',
  kind: VisitKindName.Guest,
  state: VisitStateName.Requested,
  entryBasis: null,
  plate: PLATE_EXAMPLE,
  visitorName: 'สมชาย',
  hasPhoto: false,
  respondBy: '2026-11-05T18:03:00+07:00',
  timeoutAction: GatePolicyActionName.GuardCalls,
  decidedAt: null,
  decisionReason: null,
  callMeAt: null,
  enteredAt: null,
  exitedAt: null,
  exitedBy: null,
  cancelledAt: null,
  createdAt: '2026-11-05T18:00:00+07:00',
};

/** What the gate (and the reason-logged operator log) sees on top of the household view. */
export class GuardVisitDto extends VisitDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The tablet-generated id (offline replays).',
  })
  clientRef!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1234',
    description: 'Last 4 ID digits only (D-315).',
  })
  idLast4!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'Offline record: when the tablet recorded it.',
  })
  recordedAt!: string | null;
}

export const GUARD_VISIT_EXAMPLE: GuardVisitDto = {
  ...VISIT_EXAMPLE,
  clientRef: FAKE.uuid,
  idLast4: '1234',
  note: null,
  recordedAt: null,
};

export class VisitCreatedDto extends GuardVisitDto {
  @ApiProperty({
    example: false,
    description:
      'True when this `clientRef` was already recorded (offline replay): the existing visit, nothing new.',
  })
  replayed!: boolean;
}

export class VisitEventDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'Also the SSE event id (`Last-Event-ID`).',
  })
  id!: string;

  @ApiProperty({ enum: VisitEventKindName, enumName: 'VisitEventKind', example: VisitEventKindName.Created })
  kind!: VisitEventKindName;

  @ApiProperty({ enum: VisitActorKindName, enumName: 'VisitActorKind', example: VisitActorKindName.Guard })
  actorKind!: VisitActorKindName;

  @ApiProperty({ format: 'date-time', example: '2026-11-05T18:00:00+07:00' })
  occurredAt!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { answer: 'approve' } })
  payload!: Record<string, unknown>;
}

export class GuardVisitDetailDto extends GuardVisitDto {
  @ApiProperty({ type: [VisitEventDto], example: [] })
  events!: VisitEventDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Name of the resident who asked to be called (the guard calls the house number on file).',
  })
  callBackName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: '5-minute link to the photo.' })
  photoUrl!: string | null;
}

export class VisitChangeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  visitId!: string;

  @ApiProperty({ enum: VisitEventKindName, enumName: 'VisitEventKind', example: VisitEventKindName.Answered })
  kind!: VisitEventKindName;

  @ApiProperty({ format: 'date-time', example: '2026-11-05T18:01:00+07:00' })
  occurredAt!: string;
}

export class VisitCreateDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'Generated by the tablet; a replay with the same id returns the recorded visit.',
  })
  @IsUUID()
  clientRef!: string;

  @ApiProperty({ enum: VisitKindName, enumName: 'VisitKind', example: VisitKindName.Guest })
  @IsEnum(VisitKindName)
  kind!: VisitKindName;

  @ApiPropertyOptional({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'Destination unit (required unless kind = other).',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ type: PlateDto, example: PLATE_EXAMPLE })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlateDto)
  plate?: PlateDto;

  @ApiPropertyOptional({ maxLength: 120, example: 'สมชาย' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  visitorName?: string;

  @ApiPropertyOptional({
    example: '1234',
    description: 'Exactly the last 4 digits of an ID — never more (D-315).',
  })
  @IsOptional()
  @Matches(/^[0-9]{4}$/)
  idLast4?: string;

  @ApiPropertyOptional({ maxLength: 500, example: 'ส่งพัสดุใหญ่' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-11-05T17:40:00+07:00',
    description: 'Offline record: when the tablet recorded it (≤ `gate.offline_max_hours` old).',
  })
  @IsOptional()
  @IsISO8601()
  recordedAt?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Offline record: the guard already let the visitor in at `recordedAt`.',
  })
  @IsOptional()
  @IsBoolean()
  enteredOffline?: boolean;
}

export class VisitReasonDto {
  @ApiPropertyOptional({ maxLength: 500, example: 'เจ้าของบ้านโทรยืนยันกับ รปภ.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class VisitPhotoDto {
  @ApiProperty({ example: '/9j/4AAQSkZJRgABAQ…', description: 'The photo, base64 (≤ 2 MB decoded).' })
  @IsString()
  @MaxLength(2_800_000)
  contentBase64!: string;

  @ApiProperty({
    enum: ResidentUploadContentTypeName,
    enumName: 'ResidentUploadContentType',
    example: ResidentUploadContentTypeName.Jpeg,
  })
  @IsEnum(ResidentUploadContentTypeName)
  mimeType!: VisitPhotoMimeName;
}

export class InviteScanDto {
  @ApiProperty({
    example: 'gpv1.Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5',
    description: 'The QR payload.',
  })
  @IsString()
  @Length(10, 200)
  token!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  clientRef!: string;

  @ApiPropertyOptional({ type: PlateDto, example: PLATE_EXAMPLE })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlateDto)
  plate?: PlateDto;
}

export class GuardVisitListQuery {
  @ApiPropertyOptional({
    enum: GuardVisitViewName,
    enumName: 'GuardVisitView',
    example: GuardVisitViewName.Waiting,
  })
  @IsOptional()
  @IsEnum(GuardVisitViewName)
  view?: GuardVisitViewName;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 200, example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class VisitChangesQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid, description: 'The last visit event id seen.' })
  @IsOptional()
  @IsUUID()
  after?: string;
}

export class GuardEventsQuery {
  @ApiPropertyOptional({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'Resume after this event (alternative to the `Last-Event-ID` header).',
  })
  @IsOptional()
  @IsUUID()
  lastEventId?: string;
}

export class GuardUnitsQuery {
  @ApiPropertyOptional({ maxLength: 40, example: '88/' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  q?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class GuardUnitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: '88/12' })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'โซน A' })
  buildingName!: string;

  @ApiProperty({
    example: true,
    description: '"สมาชิก LINE เชื่อมต่อแล้ว": somebody of the house can be asked in LINE.',
  })
  lineLinked!: boolean;

  @ApiProperty({ type: HousePolicyDto, example: POLICY_EXAMPLE })
  policy!: HousePolicyDto;

  @ApiPropertyOptional({
    example: false,
    description:
      'Present only while `gate.show_arrears` is on (⚖ O-038, off by default): a yes/no flag, never an amount.',
  })
  hasArrears?: boolean;
}

export class GuardMeDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  shiftId!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-05T18:00:00+07:00' })
  startedAt!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  guardId!: string;

  @ApiProperty({ example: 'สมศักดิ์' })
  guardName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  gateId!: string;

  @ApiProperty({ example: 'ป้อมหน้า' })
  gateName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ example: 'หมู่บ้านตัวอย่าง' })
  propertyName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  gateDeviceId!: string;

  @ApiProperty({ example: 'แท็บเล็ตป้อมหน้า' })
  gateDeviceName!: string;

  @ApiProperty({ type: PrivacyNoticeDto, example: NOTICE_EXAMPLE })
  privacyNotice!: PrivacyNoticeDto;
}

// ------------------------------------------------------------------------------------------------ guard sign-in

export class GuardEnrolDto {
  @ApiProperty({
    example: 'ABCD-EFGH-JKLM',
    description: 'The one-time enrolment code from the owner console.',
  })
  @IsString()
  @Length(6, 40)
  code!: string;

  @ApiPropertyOptional({ maxLength: 120, example: 'แท็บเล็ตป้อมหน้า' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class GuardEnrolledDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  deviceId!: string;

  @ApiProperty({
    example: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9',
    description: 'Shown once; the tablet keeps it in secure storage.',
  })
  deviceSecret!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  gateId!: string;

  @ApiProperty({ example: 'ป้อมหน้า' })
  gateName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ example: 'หมู่บ้านตัวอย่าง' })
  propertyName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: 'นิติบุคคลหมู่บ้านตัวอย่าง' })
  tenantName!: string;
}

export class GuardDeviceAuthDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  deviceId!: string;

  @ApiProperty({ example: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9' })
  @IsString()
  @Length(20, 200)
  deviceSecret!: string;
}

export class GuardSignInDto extends GuardDeviceAuthDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  guardId!: string;

  @ApiProperty({ example: '482913', description: '4–6 digits.' })
  @Matches(/^[0-9]{4,6}$/)
  pin!: string;
}

export class GuardRosterItemDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  guardId!: string;

  @ApiProperty({ example: 'สมศักดิ์' })
  displayName!: string;

  @ApiProperty({ example: false })
  locked!: boolean;
}

export class GuardRosterDto {
  @ApiProperty({ example: 'ป้อมหน้า' })
  gateName!: string;

  @ApiProperty({ example: 'หมู่บ้านตัวอย่าง' })
  propertyName!: string;

  @ApiProperty({
    type: [GuardRosterItemDto],
    example: [{ guardId: FAKE.uuid, displayName: 'สมศักดิ์', locked: false }],
  })
  guards!: GuardRosterItemDto[];
}

// ------------------------------------------------------------------------------------------------ owner

export class GateCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  @IsUUID()
  propertyId!: string;

  @ApiProperty({ example: 'ป้อมหน้า', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ enum: GateKindName, enumName: 'GateKind', example: GateKindName.Main })
  @IsOptional()
  @IsEnum(GateKindName)
  kind?: GateKindName;
}

export class GateUpdateDto {
  @ApiPropertyOptional({ example: 'ป้อมหน้า', maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ enum: GateKindName, enumName: 'GateKind', example: GateKindName.Main })
  @IsOptional()
  @IsEnum(GateKindName)
  kind?: GateKindName;

  @ApiPropertyOptional({ enum: ActiveStatusName, enumName: 'ActiveStatus', example: GateStateName.Active })
  @IsOptional()
  @IsEnum(GateStateName)
  state?: GateStateName;

  @ApiPropertyOptional({ example: false, description: 'A barrier is wired (J4.2).' })
  @IsOptional()
  @IsBoolean()
  barrier?: boolean;

  @ApiPropertyOptional({ example: false, description: 'An LPR camera is wired (J4.2).' })
  @IsOptional()
  @IsBoolean()
  lpr?: boolean;
}

export class GateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ example: 'ป้อมหน้า' })
  name!: string;

  @ApiProperty({ enum: GateKindName, enumName: 'GateKind', example: GateKindName.Main })
  kind!: GateKindName;

  @ApiProperty({ enum: ActiveStatusName, enumName: 'ActiveStatus', example: GateStateName.Active })
  state!: GateStateName;

  @ApiProperty({ example: false })
  barrier!: boolean;

  @ApiProperty({ example: false })
  lpr!: boolean;

  @ApiProperty({ type: 'integer', example: 1, description: 'Tablets enrolled or waiting for enrolment.' })
  devices!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class GateDeviceCreateDto {
  @ApiProperty({ example: 'แท็บเล็ตป้อมหน้า', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;
}

export class GateDeviceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  gateId!: string;

  @ApiProperty({
    enum: GateDeviceKindName,
    enumName: 'GateDeviceKind',
    example: GateDeviceKindName.GuardTablet,
  })
  kind!: GateDeviceKindName;

  @ApiProperty({ example: 'แท็บเล็ตป้อมหน้า' })
  name!: string;

  @ApiProperty({
    enum: GateDeviceStateName,
    enumName: 'GateDeviceState',
    example: GateDeviceStateName.Pending,
  })
  state!: GateDeviceStateName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-11-06T18:00:00+07:00' })
  enrolExpiresAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  enrolledAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  lastSeenAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  revokedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Barrier / LPR only (J4.2): the getproperty-edge gateway that drives it.',
  })
  edgeDeviceId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Barrier / LPR only: relay output / camera id on the gateway.',
  })
  channel!: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: null,
    description: 'Barrier only: relay pulse (null = `gate.barrier.pulse_ms`).',
  })
  pulseMs!: number | null;

  @ApiProperty({
    enum: GateHwStateName,
    enumName: 'GateHwState',
    nullable: true,
    example: null,
    description: 'Barrier only: the last reported position.',
  })
  hwState!: GateHwStateName | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  hwStateAt!: string | null;
}

export class GateDeviceCreatedDto extends GateDeviceDto {
  @ApiProperty({ example: 'ABCD-EFGH-JKLM', description: 'One-time enrolment code — shown once.' })
  enrolCode!: string;
}

export class RevokeReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 240, example: 'แท็บเล็ตหาย', description: 'Why (audited).' })
  @IsString()
  @Length(3, 240)
  reason!: string;
}

export class GuardCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  @IsUUID()
  propertyId!: string;

  @ApiProperty({ example: 'สมศักดิ์', maxLength: 80 })
  @IsString()
  @Length(1, 80)
  displayName!: string;

  @ApiProperty({ example: '482913', description: '4–6 digits, not one digit repeated.' })
  @Matches(/^[0-9]{4,6}$/)
  pin!: string;
}

export class GuardUpdateDto {
  @ApiPropertyOptional({ example: 'สมศักดิ์', maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  displayName?: string;
}

export class GuardPinDto {
  @ApiProperty({ example: '482913', description: '4–6 digits; also unlocks a locked guard.' })
  @Matches(/^[0-9]{4,6}$/)
  pin!: string;
}

export class GateGuardDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ example: 'สมศักดิ์' })
  displayName!: string;

  @ApiProperty({ enum: GateGuardStateName, enumName: 'GateGuardState', example: GateGuardStateName.Active })
  state!: GateGuardStateName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  pinSetAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  lockedUntil!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Gate of the open shift.',
  })
  onShiftAtGateId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class BlacklistCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  @IsUUID()
  propertyId!: string;

  @ApiProperty({ type: PlateDto, example: PLATE_EXAMPLE })
  @ValidateNested()
  @Type(() => PlateDto)
  plate!: PlateDto;

  @ApiProperty({
    minLength: 5,
    maxLength: 500,
    example: 'ขับรถเร็วในหมู่บ้านซ้ำหลายครั้ง (มติกรรมการ 3/2569)',
  })
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class BlacklistRevokeDto {
  @ApiProperty({ minLength: 5, maxLength: 500, example: 'กรรมการยกเลิกตามคำร้อง' })
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class BlacklistDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ type: PlateDto, example: PLATE_EXAMPLE })
  plate!: PlateDto;

  @ApiProperty({ example: 'ขับรถเร็วในหมู่บ้านซ้ำหลายครั้ง' })
  reason!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  revokedAt!: string | null;
}

export class BlacklistQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.propertyId })
  @IsOptional()
  @IsUUID()
  propertyId?: string;
}

export class GateListQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.propertyId })
  @IsOptional()
  @IsUUID()
  propertyId?: string;
}

export class VisitLogQuery extends PageQuery {
  @ApiProperty({
    minLength: 5,
    maxLength: 500,
    example: 'ตรวจสอบเหตุรถชนป้ายหน้าโครงการ 5 พ.ย.',
    description: 'Why the log is read — required and audited (D-315 PDPA).',
  })
  @IsString()
  @Length(5, 500)
  reason!: string;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.propertyId })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: VisitStateName, enumName: 'VisitState', example: VisitStateName.Entered })
  @IsOptional()
  @IsEnum(VisitStateName)
  state?: VisitStateName;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-11-01T00:00:00+07:00' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-11-06T00:00:00+07:00' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class VisitLogReasonQuery {
  @ApiProperty({ minLength: 5, maxLength: 500, example: 'ตรวจสอบเหตุรถชนป้ายหน้าโครงการ 5 พ.ย.' })
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class VisitLogDetailDto extends GuardVisitDto {
  @ApiProperty({ type: [VisitEventDto], example: [] })
  events!: VisitEventDto[];
}

export class InviteDecisionDto {
  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    example: 'ช่างไม่มีใบอนุญาตทำงานในหมู่บ้าน',
    description: 'Required to reject.',
  })
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}

export class InviteListQuery {
  @ApiPropertyOptional({
    enum: VisitInviteStateName,
    enumName: 'VisitInviteState',
    example: VisitInviteStateName.PendingApproval,
  })
  @IsOptional()
  @IsEnum(VisitInviteStateName)
  state?: VisitInviteStateName;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class VisitInviteDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ type: String, nullable: true, example: '88/12' })
  unitNo!: string | null;

  @ApiProperty({
    enum: VisitInviteUsageName,
    enumName: 'VisitInviteUsage',
    example: VisitInviteUsageName.Single,
  })
  usage!: VisitInviteUsageName;

  @ApiProperty({
    enum: InviteVisitorKindName,
    enumName: 'InviteVisitorKind',
    example: InviteVisitorKindName.Guest,
  })
  visitorKind!: InviteVisitorKindName;

  @ApiProperty({
    enum: VisitInviteStateName,
    enumName: 'VisitInviteState',
    example: VisitInviteStateName.Active,
  })
  state!: VisitInviteStateName;

  @ApiProperty({ format: 'date-time', example: '2026-11-06T09:00:00+07:00' })
  validFrom!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-06T18:00:00+07:00' })
  validTo!: string;

  @ApiProperty({ type: 'integer', example: 1 })
  maxUses!: number;

  @ApiProperty({ type: 'integer', example: 0 })
  uses!: number;

  @ApiProperty({ type: PlateDto, nullable: true, example: null })
  plate!: PlateDto | null;

  @ApiProperty({ type: String, nullable: true, example: 'คุณแม่' })
  visitorName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  rejectReason!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export const INVITE_EXAMPLE: VisitInviteDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  unitNo: '88/12',
  usage: VisitInviteUsageName.Single,
  visitorKind: InviteVisitorKindName.Guest,
  state: VisitInviteStateName.Active,
  validFrom: '2026-11-06T09:00:00+07:00',
  validTo: '2026-11-06T18:00:00+07:00',
  maxUses: 1,
  uses: 0,
  plate: null,
  visitorName: 'คุณแม่',
  note: null,
  rejectReason: null,
  createdAt: FAKE.dateTime,
};

export class VisitInviteCreatedDto extends VisitInviteDto {
  @ApiProperty({
    example: 'gpv1.Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5',
    description: 'QR payload — shown once (stored hashed).',
  })
  token!: string;
}

export class VisitInviteCreateDto {
  @ApiProperty({
    enum: VisitInviteUsageName,
    enumName: 'VisitInviteUsage',
    example: VisitInviteUsageName.Single,
  })
  @IsEnum(VisitInviteUsageName)
  usage!: VisitInviteUsageName;

  @ApiProperty({
    enum: InviteVisitorKindName,
    enumName: 'InviteVisitorKind',
    example: InviteVisitorKindName.Guest,
    description: 'Contractor invites wait for the operator approval.',
  })
  @IsEnum(InviteVisitorKindName)
  visitorKind!: InviteVisitorKindName;

  @ApiProperty({ format: 'date-time', example: '2026-11-06T09:00:00+07:00' })
  @IsISO8601()
  validFrom!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-06T18:00:00+07:00',
    description: 'Window ≤ `gate.invite_max_days`.',
  })
  @IsISO8601()
  validTo!: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 2,
    maximum: 100,
    example: 10,
    description: 'Multi-use only (default 10).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxUses?: number;

  @ApiPropertyOptional({
    type: PlateDto,
    example: PLATE_EXAMPLE,
    description: 'When given, the guard checks the car.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlateDto)
  plate?: PlateDto;

  @ApiPropertyOptional({ maxLength: 120, example: 'คุณแม่' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  visitorName?: string;

  @ApiPropertyOptional({ maxLength: 300, example: 'มาช่วงบ่าย' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class RememberedVehicleDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({
    enum: RememberedVehicleKindName,
    enumName: 'RememberedVehicleKind',
    example: RememberedVehicleKindName.Visitor,
  })
  kind!: RememberedVehicleKindName;

  @ApiProperty({ type: PlateDto, example: PLATE_EXAMPLE })
  plate!: PlateDto;

  @ApiProperty({ type: String, nullable: true, example: 'รถพี่สาว' })
  label!: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-12-05T18:00:00+07:00' })
  expiresAt!: string;
}

export class RememberedVehicleCreateDto {
  @ApiProperty({ type: PlateDto, example: PLATE_EXAMPLE })
  @ValidateNested()
  @Type(() => PlateDto)
  plate!: PlateDto;

  @ApiPropertyOptional({
    enum: RememberedVehicleKindName,
    enumName: 'RememberedVehicleKind',
    example: RememberedVehicleKindName.Visitor,
  })
  @IsOptional()
  @IsEnum(RememberedVehicleKindName)
  kind?: RememberedVehicleKindName;

  @ApiPropertyOptional({ maxLength: 80, example: 'รถพี่สาว' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 90,
    example: 30,
    description: 'At most `gate.remember_days`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

export class ResidentVisitAnswerDto {
  @ApiPropertyOptional({
    example: false,
    description: 'Approve only: remember this car for `gate.remember_days` (30).',
  })
  @IsOptional()
  @IsBoolean()
  rememberVehicle?: boolean;
}

export class ResidentVisitDto extends VisitDto {
  @ApiProperty({ type: String, nullable: true, example: null, description: 'Who of the household answered.' })
  decidedByName!: string | null;

  @ApiProperty({
    type: HousePolicyDto,
    example: POLICY_EXAMPLE,
    description: 'What happens if nobody answers.',
  })
  policy!: HousePolicyDto;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: '5-minute link to the gate photo.',
  })
  photoUrl!: string | null;
}

export class VisitAnswerResultDto {
  @ApiProperty({
    example: true,
    description: 'False when another answer was first — `visit` shows that result.',
  })
  accepted!: boolean;

  @ApiProperty({
    type: ResidentVisitDto,
    example: { ...VISIT_EXAMPLE, decidedByName: null, policy: POLICY_EXAMPLE, photoUrl: null },
  })
  visit!: ResidentVisitDto;
}

export class ResidentVisitListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: VisitStateName, enumName: 'VisitState', example: VisitStateName.Requested })
  @IsOptional()
  @IsEnum(VisitStateName)
  state?: VisitStateName;
}

export class GateRefDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'ป้อมหน้า' })
  name!: string;

  @ApiProperty({ enum: GateKindName, enumName: 'GateKind', example: GateKindName.Main })
  kind!: GateKindName;
}

export class ResidentGateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: '88/12' })
  unitNo!: string;

  @ApiProperty({ type: HousePolicyDto, example: POLICY_EXAMPLE })
  policy!: HousePolicyDto;

  @ApiProperty({
    example: true,
    description: 'I may change the policy and create invites (co-owner, tenant, co-tenant).',
  })
  canEdit!: boolean;

  @ApiProperty({
    type: [GateRefDto],
    example: [{ id: FAKE.uuid, name: 'ป้อมหน้า', kind: GateKindName.Main }],
  })
  gates!: GateRefDto[];

  @ApiProperty({ type: PrivacyNoticeDto, example: NOTICE_EXAMPLE })
  privacyNotice!: PrivacyNoticeDto;
}

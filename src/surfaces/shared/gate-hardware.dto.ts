import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
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

import {
  GateHwStateName,
  GateKindName,
  PLATE_EXAMPLE,
  PlateDto,
  VisitActorKindName,
  VisitKindName,
  VisitPhotoDto,
  VisitStateName,
} from './gate.dto';

/** J4.2 barrier, LPR, resident open, SOS DTOs shared by the guard, owner and resident surfaces (D-316, D-317, D-328). */

export enum GateHardwareKindName {
  Barrier = 'barrier',
  Lpr = 'lpr',
}
export enum GuardOpenReasonName {
  Visit = 'visit',
  Resident = 'resident',
  Delivery = 'delivery',
  Service = 'service',
  Emergency = 'emergency',
  Other = 'other',
}
export enum PlateDetectionStateName {
  Pending = 'pending',
  Matched = 'matched',
  Claimed = 'claimed',
  Dismissed = 'dismissed',
  Expired = 'expired',
  Ignored = 'ignored',
  /** CR-017 / D-330: read delivered later than gate.lpr.max_event_age_seconds — a past read, never acted on. */
  Historical = 'historical',
}
export enum PlateMatchName {
  ResidentVehicle = 'resident_vehicle',
  RememberedVehicle = 'remembered_vehicle',
  Blacklisted = 'blacklisted',
  Ambiguous = 'ambiguous',
  LowConfidence = 'low_confidence',
  None = 'none',
}
export enum PlateDetectionViewName {
  Pending = 'pending',
  Recent = 'recent',
}
export enum IncidentKindName {
  Fire = 'fire',
  Medical = 'medical',
  Intrusion = 'intrusion',
  Other = 'other',
}
export enum IncidentSourceName {
  ResidentSos = 'resident_sos',
  Guard = 'guard',
  Device = 'device',
}
export enum IncidentStateName {
  Open = 'open',
  Acknowledged = 'acknowledged',
  Resolved = 'resolved',
  Cancelled = 'cancelled',
}
export enum IncidentEventKindName {
  Raised = 'raised',
  Acknowledged = 'acknowledged',
  Resolved = 'resolved',
  Cancelled = 'cancelled',
  Note = 'note',
}
export enum GuardIncidentViewName {
  Active = 'active',
  Recent = 'recent',
}

// ------------------------------------------------------------------------------------------------ owner: hardware

export class EdgeDeviceAttachDto {
  @ApiProperty({
    enum: GateHardwareKindName,
    enumName: 'GateHardwareKind',
    example: GateHardwareKindName.Barrier,
  })
  @IsEnum(GateHardwareKindName)
  kind!: GateHardwareKindName;

  @ApiProperty({ maxLength: 120, example: 'ไม้กั้นขาเข้า' })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'A provisioned getproperty-edge gateway of a building of this estate (same tenant).',
  })
  @IsUUID()
  edgeDeviceId!: string;

  @ApiProperty({
    example: 'relay-1',
    description: 'Relay output / camera id on the gateway (1–32: letters, digits, _ . : -).',
  })
  @Matches(/^[A-Za-z0-9_.:-]{1,32}$/)
  channel!: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 200,
    maximum: 10000,
    example: 800,
    description: 'Barrier only: relay pulse in ms (default `gate.barrier.pulse_ms`).',
  })
  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(10_000)
  pulseMs?: number;
}

// ------------------------------------------------------------------------------------------------ open

export class GuardGateOpenDto {
  @ApiProperty({ enum: GuardOpenReasonName, enumName: 'GuardOpenReason', example: GuardOpenReasonName.Visit })
  @IsEnum(GuardOpenReasonName)
  reason!: GuardOpenReasonName;

  @ApiPropertyOptional({
    maxLength: 200,
    example: 'รถดับเพลิง',
    description: 'Required for `other` (3–200).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The visit of this gate the barrier opens for.',
  })
  @IsOptional()
  @IsUUID()
  visitId?: string;
}

export class GateOpenCommandDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: '`gate.open` cmdId = commandId on the wire.',
  })
  commandId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The barrier.' })
  gateDeviceId!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-05T18:00:30+07:00',
    description: 'The edge refuses after this instant.',
  })
  expiresAt!: string;
}

export class GateOpenResultDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  gateId!: string;

  @ApiProperty({ type: [GateOpenCommandDto] })
  commands!: GateOpenCommandDto[];
}

export class GeoClaimDto {
  @ApiProperty({ type: 'number', minimum: -90, maximum: 90, example: 13.6905 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ type: 'number', minimum: -180, maximum: 180, example: 100.6851 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiPropertyOptional({
    type: 'number',
    minimum: 0,
    maximum: 10000,
    example: 20,
    description: 'Reported GPS accuracy (credited up to 100 m).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10_000)
  accuracyM?: number;
}

export class ResidentGateOpenDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'One of the registered cars of my units in this estate.',
  })
  @IsUUID()
  vehicleId!: string;

  @ApiPropertyOptional({
    type: GeoClaimDto,
    description:
      'The phone location — required while `gate.resident_open.require_geofence` is on; checked against the estate location, never stored or logged (only the decision is audited).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => GeoClaimDto)
  location?: GeoClaimDto;
}

// ------------------------------------------------------------------------------------------------ vehicles

export class ResidentVehicleDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ type: PlateDto, example: PLATE_EXAMPLE })
  plate!: PlateDto;

  @ApiProperty({ type: String, nullable: true, example: 'รถคุณแม่' })
  label!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class ResidentVehicleCreateDto {
  @ApiProperty({ type: PlateDto, example: PLATE_EXAMPLE })
  @ValidateNested()
  @Type(() => PlateDto)
  plate!: PlateDto;

  @ApiPropertyOptional({ maxLength: 80, example: 'รถคุณแม่' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class OwnerVehicleQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  propertyId?: string;
}

export class ResidentOpenableGateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  gateId!: string;

  @ApiProperty({ example: 'ป้อมหน้า' })
  name!: string;

  @ApiProperty({ enum: GateKindName, enumName: 'GateKind', example: GateKindName.Main })
  kind!: GateKindName;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ example: 'หมู่บ้านตัวอย่าง' })
  propertyName!: string;

  @ApiProperty({ example: true, description: '`gate.resident_open.enabled` of the estate.' })
  enabled!: boolean;

  @ApiProperty({ example: false, description: 'Send `location` with the open request.' })
  requireGeofence!: boolean;

  @ApiProperty({ type: [ResidentVehicleDto], description: 'Registered cars of my units in this estate.' })
  vehicles!: ResidentVehicleDto[];
}

// ------------------------------------------------------------------------------------------------ plate reads

export class PlateReadDto {
  @ApiProperty({ example: '1กข' })
  category!: string;

  @ApiProperty({ example: '1234' })
  number!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'กรุงเทพมหานคร',
    description: 'Null when the camera did not read it.',
  })
  province!: string | null;
}

export class UnitRefDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'A-101' })
  unitNo!: string;
}

export class PlateDetectionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  gateId!: string;

  @ApiProperty({ type: PlateReadDto, example: PLATE_EXAMPLE })
  plate!: PlateReadDto;

  @ApiProperty({ example: '0.942', description: 'Decimal string 0–1.' })
  confidence!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  detectedAt!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  receivedAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'snap/2026-11-05/183000-1.jpg',
    description: 'Opaque edge reference of the snapshot (the image stays on the edge).',
  })
  imageRef!: string | null;

  @ApiProperty({
    enum: PlateDetectionStateName,
    enumName: 'PlateDetectionState',
    example: PlateDetectionStateName.Pending,
    description:
      '`historical` (D-330, edge CR-017): the read reached the cloud more than gate.lpr.max_event_age_seconds after ' +
      'the camera read it (queued during an outage) — kept as a past read only: no entry, no barrier open, not claimable.',
  })
  state!: PlateDetectionStateName;

  @ApiProperty({ enum: PlateMatchName, enumName: 'PlateMatch', example: PlateMatchName.None })
  match!: PlateMatchName;

  @ApiProperty({
    type: UnitRefDto,
    nullable: true,
    example: null,
    description: 'The unit of the matched car (also for low-confidence matches).',
  })
  unit!: UnitRefDto | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The visit a known plate entered with.',
  })
  visitId!: string | null;
}

export class PlateDetectionQuery {
  @ApiPropertyOptional({ enum: PlateDetectionViewName, enumName: 'PlateDetectionView', default: 'pending' })
  @IsOptional()
  @IsEnum(PlateDetectionViewName)
  view?: PlateDetectionViewName;
}

export class GuardHardwareDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: GateHardwareKindName,
    enumName: 'GateHardwareKind',
    example: GateHardwareKindName.Barrier,
  })
  kind!: GateHardwareKindName;

  @ApiProperty({ example: 'ไม้กั้นขาเข้า' })
  name!: string;

  @ApiProperty({
    enum: GateHwStateName,
    enumName: 'GateHwState',
    nullable: true,
    example: GateHwStateName.Closed,
  })
  hwState!: GateHwStateName | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  hwStateAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  lastSeenAt!: string | null;
}

// ------------------------------------------------------------------------------------------------ incidents

export class GateRefMiniDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'ป้อมหน้า' })
  name!: string;
}

export class IncidentDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.propertyId })
  propertyId!: string;

  @ApiProperty({ example: 'หมู่บ้านตัวอย่าง' })
  propertyName!: string;

  @ApiProperty({
    type: UnitRefDto,
    nullable: true,
    example: { id: FAKE.uuid, unitNo: 'A-101' },
    description: 'The house — where to go.',
  })
  unit!: UnitRefDto | null;

  @ApiProperty({
    type: GateRefMiniDto,
    nullable: true,
    example: null,
    description: 'The gate tablet that raised it (source guard).',
  })
  gate!: GateRefMiniDto | null;

  @ApiProperty({ enum: IncidentKindName, enumName: 'IncidentKind', example: IncidentKindName.Medical })
  kind!: IncidentKindName;

  @ApiProperty({
    enum: IncidentSourceName,
    enumName: 'IncidentSource',
    example: IncidentSourceName.ResidentSos,
  })
  source!: IncidentSourceName;

  @ApiProperty({ enum: IncidentStateName, enumName: 'IncidentState', example: IncidentStateName.Open })
  state!: IncidentStateName;

  @ApiProperty({ type: String, nullable: true, example: 'คุณพ่อหมดสติ' })
  note!: string | null;

  @ApiProperty({ example: false })
  hasPhoto!: boolean;

  @ApiProperty({ type: 'integer', example: 2, description: 'Visits inside the estate at the time.' })
  visitCount!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  acknowledgedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  resolvedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  cancelledAt!: string | null;
}

export class ResidentIncidentDto extends IncidentDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-11-05T18:00:30+07:00',
    description: 'Until when I may still cancel (null: not mine, or too late).',
  })
  cancellableUntil!: string | null;
}

export class SosCreatedDto extends ResidentIncidentDto {
  @ApiProperty({
    example: false,
    description: 'An open SOS of this unit by me already existed and is returned.',
  })
  existing!: boolean;
}

export class SosCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  unitId!: string;

  @ApiProperty({ enum: IncidentKindName, enumName: 'IncidentKind', example: IncidentKindName.Medical })
  @IsEnum(IncidentKindName)
  kind!: IncidentKindName;

  @ApiPropertyOptional({ maxLength: 500, example: 'คุณพ่อหมดสติ' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    type: VisitPhotoDto,
    description: 'An optional photo (JPEG / PNG / WebP, ≤ 2 MB decoded).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => VisitPhotoDto)
  photo?: VisitPhotoDto;
}

export class SosCancelDto {
  @ApiPropertyOptional({ maxLength: 300, example: 'กดผิด' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class SosListQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class GuardIncidentCreateDto {
  @ApiProperty({ enum: IncidentKindName, enumName: 'IncidentKind', example: IncidentKindName.Intrusion })
  @IsEnum(IncidentKindName)
  kind!: IncidentKindName;

  @ApiPropertyOptional({ format: 'uuid', example: FAKE.uuid, description: 'The house concerned, if any.' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ maxLength: 500, example: 'มีคนปีนรั้วด้านหลังโครงการ' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class IncidentDecisionDto {
  @ApiPropertyOptional({ maxLength: 1000, example: 'รปภ. ไปถึงบ้านแล้ว เรียกรถพยาบาลให้' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class GuardIncidentQuery {
  @ApiPropertyOptional({ enum: GuardIncidentViewName, enumName: 'GuardIncidentView', default: 'active' })
  @IsOptional()
  @IsEnum(GuardIncidentViewName)
  view?: GuardIncidentViewName;
}

export class IncidentEventDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: IncidentEventKindName,
    enumName: 'IncidentEventKind',
    example: IncidentEventKindName.Raised,
  })
  kind!: IncidentEventKindName;

  @ApiProperty({ enum: VisitActorKindName, enumName: 'VisitActorKind', example: VisitActorKindName.Resident })
  actorKind!: VisitActorKindName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  occurredAt!: string;
}

export class GuardIncidentDetailDto extends IncidentDto {
  @ApiProperty({ type: [IncidentEventDto] })
  events!: IncidentEventDto[];
}

export class IncidentVisitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'A-102' })
  unitNo!: string | null;

  @ApiProperty({ example: 'ป้อมหน้า' })
  gateName!: string;

  @ApiProperty({ enum: VisitKindName, enumName: 'VisitKind', example: VisitKindName.Guest })
  kind!: VisitKindName;

  @ApiProperty({ enum: VisitStateName, enumName: 'VisitState', example: VisitStateName.Entered })
  state!: VisitStateName;

  @ApiProperty({ type: String, nullable: true, example: 'กข 0000 กรุงเทพมหานคร' })
  plate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'สมปอง' })
  visitorName!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  enteredAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  exitedAt!: string | null;
}

export class IncidentDetailDto extends GuardIncidentDetailDto {
  @ApiProperty({
    type: [IncidentVisitDto],
    description: 'Visits inside the estate at the time of the incident.',
  })
  visits!: IncidentVisitDto[];
}

export class IncidentLogQuery extends PageQuery {
  @ApiProperty({
    minLength: 5,
    maxLength: 500,
    description: 'Why the log is read (audited).',
    example: 'ตรวจสอบเหตุ SOS คืนวันที่ 4',
  })
  @IsString()
  @Length(5, 500)
  reason!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  propertyId?: string;

  @ApiPropertyOptional({ enum: IncidentStateName, enumName: 'IncidentState' })
  @IsOptional()
  @IsEnum(IncidentStateName)
  state?: IncidentStateName;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class IncidentReasonQuery {
  @ApiProperty({
    minLength: 5,
    maxLength: 500,
    description: 'Why the record is read (audited).',
    example: 'ตรวจสอบเหตุ SOS คืนวันที่ 4',
  })
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export const INCIDENT_EXAMPLE: IncidentDto = {
  id: FAKE.uuid,
  propertyId: FAKE.propertyId,
  propertyName: 'หมู่บ้านตัวอย่าง',
  unit: { id: FAKE.uuid, unitNo: 'A-101' },
  gate: null,
  kind: IncidentKindName.Medical,
  source: IncidentSourceName.ResidentSos,
  state: IncidentStateName.Open,
  note: 'คุณพ่อหมดสติ',
  hasPhoto: false,
  visitCount: 2,
  createdAt: FAKE.dateTime,
  acknowledgedAt: null,
  resolvedAt: null,
  cancelledAt: null,
};
export const DETECTION_EXAMPLE: PlateDetectionDto = {
  id: FAKE.uuid,
  gateId: FAKE.uuid,
  plate: PLATE_EXAMPLE,
  confidence: '0.942',
  detectedAt: FAKE.dateTime,
  receivedAt: FAKE.dateTime,
  imageRef: null,
  state: PlateDetectionStateName.Pending,
  match: PlateMatchName.None,
  unit: null,
  visitId: null,
};
export const RESIDENT_VEHICLE_EXAMPLE: ResidentVehicleDto = {
  id: FAKE.uuid,
  unitId: FAKE.uuid,
  plate: PLATE_EXAMPLE,
  label: 'รถคุณแม่',
  createdAt: FAKE.dateTime,
};
export const OPEN_RESULT_EXAMPLE: GateOpenResultDto = {
  gateId: FAKE.uuid,
  commands: [{ commandId: FAKE.uuid, gateDeviceId: FAKE.uuid, expiresAt: '2026-11-05T18:00:30+07:00' }],
};

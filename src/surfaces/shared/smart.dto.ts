import { FAKE } from '@common/openapi/examples';
import { PageQuery } from '@common/pagination/pagination.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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

import { DeviceKindName, DeviceOwnershipName, DeviceStatusName } from '../admin/admin.dto';
import { UtilityName, UtilityProviderName } from '../owner/money-settings.dto';
import { DecimalInput, MoneyInput, MoneyOutput } from './fields';

export { DeviceKindName, DeviceOwnershipName, DeviceStatusName };

/** Meter registers on the wire: decimal strings with up to 3 decimals (numeric(12,3)). */
export const REGISTER = /^\d{1,9}(\.\d{1,3})?$/;
const REGISTER_EXAMPLE = '12345.678';

const bool = () =>
  Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : (value as unknown)));

// ------------------------------------------------------------------------------------------------ enums

export enum OtaRingName {
  Canary = 'canary',
  Pilot = 'pilot',
  All = 'all',
}
export enum MeterHealthName {
  Ok = 'ok',
  Stale = 'stale',
  Silent = 'silent',
  NoDevice = 'no_device',
  Unknown = 'unknown',
}
export enum BusTypeName {
  ModbusRtu = 'modbus_rtu',
  Gpio = 'gpio',
  Lorawan = 'lorawan',
  NbIot = 'nb_iot',
  VendorCloud = 'vendor_cloud',
}
export enum RegisterMapName {
  DriverDefault = 'driver_default',
  Custom = 'custom',
}
export enum CommandTypeName {
  ReadNow = 'read_now',
  Restart = 'restart',
  OtaApply = 'ota_apply',
  UploadLogs = 'upload_logs',
  SetLogLevel = 'set_log_level',
  Identify = 'identify',
}
export enum OperatorCommandTypeName {
  ReadNow = 'read_now',
  Restart = 'restart',
  Identify = 'identify',
  UploadLogs = 'upload_logs',
}
export enum CommandStatusName {
  Queued = 'queued',
  Sent = 'sent',
  Accepted = 'accepted',
  Done = 'done',
  Failed = 'failed',
  Expired = 'expired',
}
export enum RolloutStatusName {
  Planned = 'planned',
  Running = 'running',
  Paused = 'paused',
  Completed = 'completed',
  RolledBack = 'rolled_back',
  Aborted = 'aborted',
}
export enum OtaDeviceStatusName {
  Queued = 'queued',
  Commanded = 'commanded',
  Started = 'started',
  Applied = 'applied',
  RolledBack = 'rolled_back',
  Failed = 'failed',
}
export enum ReadingSourceName {
  Iot = 'iot',
  Ocr = 'ocr',
  Manual = 'manual',
  Estimated = 'estimated',
}
export enum ReadingReviewStateName {
  Accepted = 'accepted',
  PendingReview = 'pending_review',
  Rejected = 'rejected',
  Corrected = 'corrected',
}
export enum ReadingChannelName {
  Mqtt = 'mqtt',
  HttpsBatch = 'https_batch',
  StaffPwa = 'staff_pwa',
  OwnerWeb = 'owner_web',
  Inspection = 'inspection',
  CycleEstimate = 'cycle_estimate',
  Import = 'import',
}
export enum ReviewReasonName {
  NonMonotonic = 'non_monotonic',
  OutOfBand = 'out_of_band',
  OcrLowConfidence = 'ocr_low_confidence',
  ClockSuspect = 'clock_suspect',
  MissingPhoto = 'missing_photo',
  ManualFlag = 'manual_flag',
  DecreasingWithoutSwap = 'decreasing_without_swap',
}
export enum ReviewStatusName {
  Open = 'open',
  Accepted = 'accepted',
  Corrected = 'corrected',
  Rejected = 'rejected',
}
export enum ReviewDecisionName {
  Accept = 'accept',
  Correct = 'correct',
  Reject = 'reject',
}
export enum MeterUnitName {
  Kwh = 'kwh',
  M3 = 'm3',
}
export enum MeterPurposeName {
  Unit = 'unit',
  CommonArea = 'common_area',
  Main = 'main',
}
export enum SeriesBucketName {
  M15 = '15m',
  H1 = '1h',
  D1 = '1d',
}
export enum IngestFailureName {
  UnknownTopic = 'unknown_topic',
  MalformedJson = 'malformed_json',
  InvalidPayload = 'invalid_payload',
  GatewayMismatch = 'gateway_mismatch',
  BatchTooLarge = 'batch_too_large',
  UnknownGateway = 'unknown_gateway',
  ProcessingError = 'processing_error',
}
export enum UtilityInvoiceSourceName {
  Manual = 'manual',
  Ocr = 'ocr',
  EbillImport = 'ebill_import',
}
export enum LossPriceBasisName {
  UtilityTariff = 'utility_tariff',
  InvoiceAverage = 'invoice_average',
}
export enum BilledUnitsSourceName {
  Invoices = 'invoices',
  MeterReadingsStub = 'meter_readings_stub',
}
export enum LossSuspectKindName {
  ZeroConsumptionOccupied = 'zero_consumption_occupied',
  UsageWhileVacant = 'usage_while_vacant',
  EstimatedReading = 'estimated_reading',
  NightWaterFlow = 'night_water_flow',
  StaleMeter = 'stale_meter',
  ConsumptionAnomaly = 'consumption_anomaly',
}
export enum OtaChannelName {
  Stable = 'stable',
  Beta = 'beta',
  Canary = 'canary',
}
export enum IngestChannelName {
  Mqtt = 'mqtt',
  HttpsBatch = 'https_batch',
}
export enum OtaArchName {
  Arm64 = 'arm64',
  X64 = 'x64',
  Armv7 = 'armv7',
}

// ------------------------------------------------------------------------------------------------ devices

export class GatewayHealthDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  lastHeartbeatAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '0.3.0' })
  agentVersion!: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 4,
    description: 'Config version the gateway runs.',
  })
  configVersion!: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 0,
    description: 'Readings waiting in its buffer.',
  })
  bufferedReadings!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'ethernet' })
  link!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: null })
  rssi!: number | null;

  @ApiProperty({ type: 'integer', example: 0 })
  missedHeartbeats!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 850,
    description: 'Last observed ingest lag (ms).',
  })
  ingestLagMs!: number | null;
}

export class FleetDeviceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  id!: string;

  @ApiProperty({ example: 'GP-GW-000123' })
  serial!: string;

  @ApiProperty({ enum: DeviceKindName, enumName: 'DeviceKind', example: DeviceKindName.Gateway })
  kind!: DeviceKindName;

  @ApiProperty({ example: 'rpi-cm4' })
  model!: string;

  @ApiProperty({ example: 'Raspberry Pi' })
  vendor!: string;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Meter driver (meter devices).' })
  driver!: string | null;

  @ApiProperty({
    enum: DeviceOwnershipName,
    enumName: 'DeviceOwnership',
    example: DeviceOwnershipName.PlatformHaas,
  })
  ownership!: DeviceOwnershipName;

  @ApiProperty({ enum: DeviceStatusName, enumName: 'DeviceStatus', example: DeviceStatusName.Online })
  status!: DeviceStatusName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  tenantId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.buildingId })
  buildingId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The meter it reads.',
  })
  assetItemId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null, description: 'Its gateway.' })
  gatewayDeviceId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '0.3.0' })
  firmwareVersion!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'arm64' })
  arch!: string | null;

  @ApiProperty({ enum: OtaRingName, enumName: 'OtaRing', example: OtaRingName.All })
  otaRing!: OtaRingName;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  lastSeenAt!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 4 })
  configAppliedVersion!: number | null;

  @ApiProperty({ type: 'integer', example: 2, description: 'Open meter channels (gateways).' })
  meters!: number;

  @ApiProperty({ type: () => GatewayHealthDto, nullable: true })
  health!: GatewayHealthDto | null;

  @ApiProperty({ type: [String], example: ['read-now', 'restart', 'identify', 'upload-logs'] })
  nextActions!: string[];

  @ApiProperty({ type: 'integer', example: 3 })
  version!: number;
}

export class DeviceListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ enum: DeviceKindName, enumName: 'DeviceKind' })
  @IsOptional()
  @IsEnum(DeviceKindName)
  kind?: DeviceKindName;

  @ApiPropertyOptional({ enum: DeviceStatusName, enumName: 'DeviceStatus' })
  @IsOptional()
  @IsEnum(DeviceStatusName)
  status?: DeviceStatusName;
}

export class AdminDeviceListQuery extends DeviceListQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Only the platform inventory (no tenant).' })
  @IsOptional()
  @bool()
  @IsBoolean()
  inventory?: boolean;
}

export class MeterChannelDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.meterId, description: 'Meter asset item.' })
  meterAssetItemId!: string;

  @ApiProperty({ example: 'มิเตอร์ไฟ A-201' })
  meterName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  meterDeviceId!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  gatewayDeviceId!: string;

  @ApiProperty({ example: 'bus1' })
  busId!: string;

  @ApiProperty({ enum: BusTypeName, enumName: 'BusType', example: BusTypeName.ModbusRtu })
  busType!: BusTypeName;

  @ApiProperty({ type: 'integer', nullable: true, example: 12 })
  address!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: null })
  pin!: number | null;

  @ApiProperty({ example: 'sdm120' })
  driver!: string;

  @ApiProperty({ enum: RegisterMapName, enumName: 'RegisterMap', example: RegisterMapName.DriverDefault })
  registerMap!: RegisterMapName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  validFrom!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  validTo!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  unboundReason!: string | null;
}

export class GatewayConfigVersionDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  compiledAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  publishedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  appliedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  rejectedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  rejectError!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'Gateway not on this version after `health.config_drift_minutes`.',
  })
  driftFlaggedAt!: string | null;

  @ApiProperty({ type: 'integer', example: 2 })
  meters!: number;
}

export class DeviceEventDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'meter_unreachable' })
  type!: string;

  @ApiProperty({ example: 'warning' })
  severity!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  occurredAt!: string;

  @ApiProperty({ type: String, nullable: true, example: 'meter 12 timed out' })
  message!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  deviceId!: string | null;
}

export class DeviceDetailDto {
  @ApiProperty({ type: () => FleetDeviceDto })
  device!: FleetDeviceDto;

  @ApiProperty({ type: () => [MeterChannelDto], description: 'Open channels first, then history.' })
  channels!: MeterChannelDto[];

  @ApiProperty({ type: () => [GatewayConfigVersionDto], description: 'Last 5 config versions (gateways).' })
  configs!: GatewayConfigVersionDto[];

  @ApiProperty({ type: () => [DeviceEventDto], description: 'Last 20 operational events.' })
  events!: DeviceEventDto[];
}

export class DeviceCommandDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  gatewayDeviceId!: string;

  @ApiProperty({ enum: CommandTypeName, enumName: 'CommandType', example: CommandTypeName.ReadNow })
  type!: CommandTypeName;

  @ApiProperty({ type: 'object', additionalProperties: true, example: {} })
  args!: Record<string, unknown>;

  @ApiProperty({ enum: CommandStatusName, enumName: 'CommandStatus', example: CommandStatusName.Queued })
  status!: CommandStatusName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;

  @ApiProperty({ type: 'integer', example: 0 })
  attempts!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  finishedAt!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true, example: null })
  result!: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  error!: string | null;
}

export class OperatorCommandCreateDto {
  @ApiProperty({
    enum: OperatorCommandTypeName,
    enumName: 'OperatorCommandType',
    example: OperatorCommandTypeName.ReadNow,
  })
  @IsEnum(OperatorCommandTypeName)
  type!: OperatorCommandTypeName;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { meterIds: [FAKE.meterId] },
    description:
      '`read_now { meterIds? }` · `identify { seconds 1–600 }` · `upload_logs { hours 1–168 }` · `restart {}` (protocol §2).',
  })
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

export class AdminCommandCreateDto {
  @ApiProperty({ enum: CommandTypeName, enumName: 'CommandType', example: CommandTypeName.SetLogLevel })
  @IsEnum(CommandTypeName)
  type!: CommandTypeName;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, example: { level: 'debug' } })
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

export class FleetBuildingRowDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.tenantId })
  tenantId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.companyName })
  tenantName!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ enum: DeviceKindName, enumName: 'DeviceKind', example: DeviceKindName.Gateway })
  kind!: DeviceKindName;

  @ApiProperty({ enum: DeviceStatusName, enumName: 'DeviceStatus', example: DeviceStatusName.Online })
  status!: DeviceStatusName;

  @ApiProperty({ type: 'integer', example: 1 })
  count!: number;
}

export class FleetInventoryRowDto {
  @ApiProperty({ enum: DeviceKindName, enumName: 'DeviceKind', example: DeviceKindName.ElectricMeter })
  kind!: DeviceKindName;

  @ApiProperty({ type: 'integer', example: 40 })
  count!: number;
}

export class FleetSummaryDto {
  @ApiProperty({ type: () => [FleetBuildingRowDto] })
  byBuilding!: FleetBuildingRowDto[];

  @ApiProperty({ type: () => [FleetInventoryRowDto], description: 'Platform inventory (not yet assigned).' })
  inventory!: FleetInventoryRowDto[];
}

export class DeviceImportDto {
  @ApiProperty({
    example:
      'serial,kind,model,vendor,driver,ownership,arch\nGW-0001,gateway,rpi-cm4,Raspberry Pi,,platform_haas,arm64',
    description: 'CSV `serial,kind,model,vendor[,driver,ownership,arch]` with a header row; ≤ 5,000 rows.',
  })
  @IsString()
  @MaxLength(1_000_000)
  csv!: string;
}

export class ImportSkippedDto {
  @ApiProperty({ type: 'integer', example: 3 })
  line!: number;

  @ApiProperty({ example: 'GW-0001' })
  serial!: string;

  @ApiProperty({ example: 'exists' })
  reason!: string;
}

export class ImportErrorDto {
  @ApiProperty({ type: 'integer', example: 4 })
  line!: number;

  @ApiProperty({ example: 'kind: one of gateway, electric_meter, …' })
  message!: string;
}

export class DeviceImportResultDto {
  @ApiProperty({ type: 'integer', example: 20 })
  created!: number;

  @ApiProperty({ type: () => [ImportSkippedDto] })
  skipped!: ImportSkippedDto[];

  @ApiProperty({ type: () => [ImportErrorDto], description: 'Any error refuses the whole file.' })
  errors!: ImportErrorDto[];
}

export class DeviceAssignDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiPropertyOptional({ enum: OtaRingName, enumName: 'OtaRing' })
  @IsOptional()
  @IsEnum(OtaRingName)
  otaRing?: OtaRingName;
}

export class DeviceRingDto {
  @ApiProperty({ enum: OtaRingName, enumName: 'OtaRing', example: OtaRingName.Canary })
  @IsEnum(OtaRingName)
  otaRing!: OtaRingName;
}

export class DeviceReasonDto {
  @ApiProperty({ example: 'gateway stolen from the meter room' })
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'INC-2026-014',
    description: 'Support or incident reference, kept in the audit row.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  incidentRef?: string | null;
}

// ------------------------------------------------------------------------------------------------ installs

export class ProvisionGatewayDto {
  @ApiProperty({ example: 'GP-GW-000123', description: 'Serial from the gateway QR label.' })
  @IsString()
  @Length(3, 64)
  serial!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;
}

export class MeterDeviceInputDto {
  @ApiProperty({ example: 'SDM120-0042' })
  @IsString()
  @Length(3, 64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/)
  serial!: string;

  @ApiProperty({ example: 'SDM120' })
  @IsString()
  @Length(1, 100)
  model!: string;

  @ApiProperty({ example: 'Eastron' })
  @IsString()
  @Length(1, 100)
  vendor!: string;

  @ApiProperty({ example: 'sdm120', description: 'Edge driver key (snake_case).' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  driver!: string;
}

export class WiringInputDto {
  @ApiProperty({ example: 'bus1', description: 'Bus id of the gateway (its bus config).' })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{0,31}$/)
  busId!: string;

  @ApiProperty({ enum: BusTypeName, enumName: 'BusType', example: BusTypeName.ModbusRtu })
  @IsEnum(BusTypeName)
  busType!: BusTypeName;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 247, example: 12, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(247)
  address?: number | null;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 64, example: null, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(64)
  pin?: number | null;

  @DecimalInput({
    example: '1',
    description: 'Scale applied to the raw register.',
    optional: true,
    nullable: true,
  })
  scale?: string | null;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 1000, example: null, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  litresPerPulse?: number | null;

  @ApiPropertyOptional({ enum: RegisterMapName, enumName: 'RegisterMap' })
  @IsOptional()
  @IsEnum(RegisterMapName)
  registerMap?: RegisterMapName;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: null,
    description: 'Required exactly when `registerMap = custom` (protocol `CustomRegisterMap`, CR-005).',
  })
  @IsOptional()
  @IsObject()
  customRegisterMap?: Record<string, unknown> | null;
}

export class DeviceInstallDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.meterId,
    description: 'The meter (`core.asset_item`, meter_electric | meter_water).',
  })
  @IsUUID()
  meterAssetItemId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  @IsUUID()
  gatewayDeviceId!: string;

  @ApiProperty({ type: () => MeterDeviceInputDto })
  @ValidateNested()
  @Type(() => MeterDeviceInputDto)
  meterDevice!: MeterDeviceInputDto;

  @ApiProperty({ type: () => WiringInputDto })
  @ValidateNested()
  @Type(() => WiringInputDto)
  wiring!: WiringInputDto;

  @ApiProperty({
    example: REGISTER_EXAMPLE,
    pattern: REGISTER.source,
    description: 'Physical register at install (D-033).',
  })
  @IsString()
  @Matches(REGISTER)
  installRegister!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: '`core.document` kind `meter_photo`.' })
  @IsUUID()
  photoDocumentId!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: null })
  @IsOptional()
  @IsDateString()
  installedAt?: string | null;
}

export class DeviceUnbindDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.meterId,
    description: 'The meter (`core.asset_item`, meter_electric | meter_water).',
  })
  @IsUUID()
  meterAssetItemId!: string;

  @ApiProperty({
    example: REGISTER_EXAMPLE,
    pattern: REGISTER.source,
    description: 'Final register (photo).',
  })
  @IsString()
  @Matches(REGISTER)
  register!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  photoDocumentId!: string;

  @ApiProperty({ example: 'meter device faulty' })
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: null })
  @IsOptional()
  @IsDateString()
  at?: string | null;
}

export class NewMeterDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'SN-889911' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  serial?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Eastron' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  manufacturer?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'SDM120' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string | null;
}

export class MeterSwapDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.meterId,
    description: 'The meter (`core.asset_item`, meter_electric | meter_water).',
  })
  @IsUUID()
  meterAssetItemId!: string;

  @ApiProperty({
    example: '23456.700',
    pattern: REGISTER.source,
    description: 'Old meter final register (photo).',
  })
  @IsString()
  @Matches(REGISTER)
  oldFinalRegister!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  oldPhotoDocumentId!: string;

  @ApiProperty({ type: () => NewMeterDto })
  @ValidateNested()
  @Type(() => NewMeterDto)
  newMeter!: NewMeterDto;

  @ApiPropertyOptional({
    type: () => MeterDeviceInputDto,
    nullable: true,
    description: 'A new IoT device on the new meter.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MeterDeviceInputDto)
  newMeterDevice?: MeterDeviceInputDto | null;

  @ApiPropertyOptional({
    type: () => WiringInputDto,
    nullable: true,
    description: 'Defaults to the old channel’s wiring.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WiringInputDto)
  wiring?: WiringInputDto | null;

  @ApiProperty({
    example: '0.000',
    pattern: REGISTER.source,
    description: 'New meter initial register (photo).',
  })
  @IsString()
  @Matches(REGISTER)
  newInitialRegister!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  newPhotoDocumentId!: string;

  @ApiProperty({ example: 'meter display broken' })
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: null })
  @IsOptional()
  @IsDateString()
  swappedAt?: string | null;
}

export class DeviceInstalledDto {
  @ApiProperty({ type: () => FleetDeviceDto })
  device!: FleetDeviceDto;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  channelId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The install reading (`is_install`).' })
  readingId!: string;
}

export class DeviceUnboundDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  channelId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  readingId!: string;
}

export class MeterSwappedDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  swapId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  oldAssignmentId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  newAssignmentId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The new meter asset item.' })
  newAssetItemId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  newDeviceId!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  finalReadingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  firstReadingId!: string;
}

// ------------------------------------------------------------------------------------------------ OTA

export class OtaArtifactDto {
  @ApiProperty({ example: 'https://releases.getproperty.co/edge/0.4.0/arm64.tar.zst' })
  @IsString()
  @Matches(/^https:\/\//)
  url!: string;

  @ApiProperty({ example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/i)
  sha256!: string;

  @ApiProperty({ type: 'integer', example: 48211234 })
  @IsInt()
  @Min(1)
  size!: number;
}

export class OtaSignatureDto {
  @ApiProperty({ example: 'ed25519' })
  @IsIn(['ed25519'])
  alg!: 'ed25519';

  @ApiProperty({ example: 'gp-ota-2026' })
  @IsString()
  @Length(1, 64)
  keyId!: string;

  @ApiProperty({ example: 'bWFkZS11cC1zaWduYXR1cmU=' })
  @IsString()
  @Length(1, 200)
  value!: string;
}

/** The signed OTA manifest produced by getproperty-edge (edge CR-011). */
export class OtaManifestDto {
  @ApiProperty({ type: 'integer', example: 1 })
  @IsIn([1])
  schema!: 1;

  @ApiProperty({ example: '0.4.0' })
  @IsString()
  @Matches(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  version!: string;

  @ApiProperty({ enum: OtaChannelName, enumName: 'OtaChannel', example: OtaChannelName.Stable })
  @IsEnum(OtaChannelName)
  channel!: OtaChannelName;

  @ApiProperty({ enum: OtaArchName, enumName: 'OtaArch', example: OtaArchName.Arm64 })
  @IsEnum(OtaArchName)
  arch!: OtaArchName;

  @ApiProperty({ type: () => OtaArtifactDto })
  @ValidateNested()
  @Type(() => OtaArtifactDto)
  artifact!: OtaArtifactDto;

  @ApiProperty({ type: String, nullable: true, example: '0.3.0' })
  @IsOptional()
  @IsString()
  minAgentVersion!: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-10-15T09:00:00Z' })
  @IsDateString()
  releasedAt!: string;

  @ApiProperty({ type: () => OtaSignatureDto })
  @ValidateNested()
  @Type(() => OtaSignatureDto)
  signature!: OtaSignatureDto;
}

export class OtaReleaseCreateDto {
  @ApiProperty({ type: () => OtaManifestDto })
  @ValidateNested()
  @Type(() => OtaManifestDto)
  manifest!: OtaManifestDto;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Modbus timeouts fixed' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class OtaReleaseDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: '0.4.0' })
  version!: string;

  @ApiProperty({ enum: OtaArchName, enumName: 'OtaArch', example: OtaArchName.Arm64 })
  arch!: OtaArchName;

  @ApiProperty({ example: 'stable' })
  channel!: string;

  @ApiProperty({ example: 'https://releases.getproperty.co/edge/0.4.0/arm64.tar.zst' })
  artifactUrl!: string;

  @ApiProperty({ example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' })
  sha256!: string;

  @ApiProperty({ example: 'gp-ota-2026' })
  keyId!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  releasedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  deprecatedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;
}

export class OtaRolloutCreateDto {
  @ApiProperty({ enum: OtaRingName, enumName: 'OtaRing', example: OtaRingName.Canary })
  @IsEnum(OtaRingName)
  ring!: OtaRingName;

  @DecimalInput({
    example: '10',
    description: 'Pause when failures exceed this % of targeted gateways.',
    optional: true,
  })
  maxFailuresPct?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class OtaRolloutDeviceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  deviceId!: string;

  @ApiProperty({
    enum: OtaDeviceStatusName,
    enumName: 'OtaDeviceStatus',
    example: OtaDeviceStatusName.Applied,
  })
  status!: OtaDeviceStatusName;

  @ApiProperty({ type: String, nullable: true, example: '0.3.0' })
  fromVersion!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  error!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  updatedAt!: string;
}

export class OtaRolloutDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: () => OtaReleaseDto })
  release!: OtaReleaseDto;

  @ApiProperty({ enum: OtaRingName, enumName: 'OtaRing', example: OtaRingName.Canary })
  ring!: OtaRingName;

  @ApiProperty({ enum: RolloutStatusName, enumName: 'RolloutStatus', example: RolloutStatusName.Running })
  status!: RolloutStatusName;

  @ApiProperty({ example: '10.00' })
  maxFailuresPct!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  startedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  finishedAt!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { applied: 2, failed: 0, commanded: 1 },
  })
  counts!: Record<string, number>;

  @ApiProperty({ type: () => [OtaRolloutDeviceDto] })
  devices!: OtaRolloutDeviceDto[];

  @ApiProperty({ type: [String], example: ['pause', 'abort'] })
  nextActions!: string[];
}

// ------------------------------------------------------------------------------------------------ ingest

export class DeadLetterListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: IngestFailureName, enumName: 'IngestFailure' })
  @IsOptional()
  @IsEnum(IngestFailureName)
  reason?: IngestFailureName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gatewayDeviceId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @bool()
  @IsBoolean()
  replayed?: boolean;
}

export class DeadLetterDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  receivedAt!: string;

  @ApiProperty({ example: `gp/v1/${FAKE.gatewayId}/telemetry` })
  topic!: string;

  @ApiProperty({ enum: IngestChannelName, enumName: 'IngestChannel', example: IngestChannelName.Mqtt })
  channel!: IngestChannelName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.gatewayId })
  gatewayDeviceId!: string | null;

  @ApiProperty({
    enum: IngestFailureName,
    enumName: 'IngestFailure',
    example: IngestFailureName.InvalidPayload,
  })
  reason!: IngestFailureName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: `meter ${FAKE.meterId} is not bound to this gateway`,
  })
  detail!: string | null;

  @ApiProperty({ type: 'integer', example: 1840 })
  payloadBytes!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '{"gatewayId":"…"',
    description: 'First 2 KB of the payload (UTF-8).',
  })
  payloadPreview!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  replayedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  replayOutcome!: string | null;
}

export class DeadLetterReplayDto {
  @ApiProperty({ type: () => DeadLetterDto })
  deadLetter!: DeadLetterDto;

  @ApiProperty({
    example: 'telemetry',
    description: 'Pipeline outcome: telemetry · health · event · ack · lwt · dead_letter.',
  })
  outcome!: string;
}

export class RejectedReadingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.meterId })
  meterId!: string;

  @ApiProperty({ type: 'integer', example: 1042 })
  seq!: number;

  @ApiProperty({ example: 'unbound_meter' })
  reason!: string;
}

export class ReadingsBatchResultDto {
  @ApiProperty({ type: 'integer', example: 198, description: 'New points stored.' })
  accepted!: number;

  @ApiProperty({
    type: 'integer',
    example: 2,
    description: 'Already received (dedup on `(meterId, seq)`, D-143).',
  })
  duplicates!: number;

  @ApiProperty({
    type: () => [RejectedReadingDto],
    description: 'Refused readings (meter not bound to this gateway).',
  })
  rejected!: RejectedReadingDto[];
}

// ------------------------------------------------------------------------------------------------ series

export class SeriesQuery {
  @ApiProperty({ format: 'date-time', example: '2026-10-01T00:00:00+07:00' })
  @IsDateString()
  from!: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-02T00:00:00+07:00' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ enum: SeriesBucketName, enumName: 'SeriesBucket', default: SeriesBucketName.H1 })
  @IsOptional()
  @IsEnum(SeriesBucketName)
  bucket?: SeriesBucketName;
}

export class UsageQuery {
  @ApiPropertyOptional({ format: 'date-time', description: 'Default: 30 days before `to`.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Default: now.' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: SeriesBucketName, enumName: 'SeriesBucket', default: SeriesBucketName.D1 })
  @IsOptional()
  @IsEnum(SeriesBucketName)
  bucket?: SeriesBucketName;
}

export class SeriesPointDto {
  @ApiProperty({ format: 'date-time', example: '2026-10-01T01:00:00+07:00' })
  bucket!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0.412',
    description: 'Consumption in the bucket (kWh or m³).',
  })
  usage!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '12345.678' })
  lastRegister!: string | null;

  @ApiProperty({ type: 'integer', example: 4 })
  points!: number;

  @ApiProperty({ type: String, nullable: true, example: '410.5' })
  avgPowerW!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  avgFlowLpm!: string | null;
}

export class MeterSeriesDto {
  @ApiProperty({ format: 'uuid', example: FAKE.meterId })
  assetItemId!: string;

  @ApiProperty({ enum: MeterUnitName, enumName: 'MeterUnit', example: MeterUnitName.Kwh })
  unit!: MeterUnitName;

  @ApiProperty({ enum: SeriesBucketName, enumName: 'SeriesBucket', example: SeriesBucketName.H1 })
  bucket!: SeriesBucketName;

  @ApiProperty({ type: () => [SeriesPointDto] })
  points!: SeriesPointDto[];
}

export class UsagePointDto {
  @ApiProperty({ format: 'date-time', example: '2026-10-01T00:00:00+07:00' })
  bucket!: string;

  @ApiProperty({ example: '6.250' })
  usage!: string;
}

export class UtilityUsageDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ enum: MeterUnitName, enumName: 'MeterUnit', example: MeterUnitName.Kwh })
  unit!: MeterUnitName;

  @ApiProperty({ type: () => [UsagePointDto] })
  points!: UsagePointDto[];
}

export class CycleToDateDto {
  @ApiProperty({
    format: 'date-time',
    example: '2026-10-01T00:00:00+07:00',
    description: 'Start of the current billing period (after the last `billing.cutoff`) or of the lease.',
  })
  from!: string;

  @ApiProperty({ example: '84.250', description: 'Usage since `from` (kWh or m³), decimal string.' })
  usage!: string;

  @ApiProperty({
    example: true,
    description:
      'Always true: measured by the meters’ telemetry, not billed — the invoice uses the cumulative registers at the cut-off (D-030).',
  })
  estimated!: boolean;
}

export class UsageSummaryDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ enum: MeterUnitName, enumName: 'MeterUnit', example: MeterUnitName.Kwh })
  unit!: MeterUnitName;

  @ApiProperty({
    example: '187.500',
    description: 'Usage in the requested window (`from`–`to`), decimal string.',
  })
  total!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '172.000',
    description:
      'Usage in the same-length window right before `from`; null when that window precedes the lease.',
  })
  previousTotal!: string | null;

  @ApiProperty({ type: () => CycleToDateDto, nullable: true })
  cycleToDate!: CycleToDateDto | null;
}

export class ResidentUsageDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-01T00:00:00+07:00' })
  from!: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-31T00:00:00+07:00' })
  to!: string;

  @ApiProperty({ enum: SeriesBucketName, enumName: 'SeriesBucket', example: SeriesBucketName.D1 })
  bucket!: SeriesBucketName;

  @ApiProperty({
    type: () => [UtilityUsageDto],
    description: 'Empty for meters read manually (no telemetry).',
  })
  series!: UtilityUsageDto[];

  @ApiProperty({
    type: () => [UsageSummaryDto],
    description:
      'Totals per utility computed by the API (LIFF #12, D-203): the window, the previous window of the same length and the usage so far in the current billing period; only utilities with telemetry.',
  })
  summary!: UsageSummaryDto[];
}

// ------------------------------------------------------------------------------------------------ readings

export class MeterReadingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.meterId })
  assetItemId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  meterAssignmentId!: string;

  @ApiProperty({ example: 'E-A-201' })
  meterCode!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ example: REGISTER_EXAMPLE })
  register!: string;

  @ApiProperty({ enum: MeterUnitName, enumName: 'MeterUnit', example: MeterUnitName.Kwh })
  unit!: MeterUnitName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  readAt!: string;

  @ApiProperty({ enum: ReadingSourceName, enumName: 'ReadingSource', example: ReadingSourceName.Ocr })
  source!: ReadingSourceName;

  @ApiProperty({ enum: ReadingChannelName, enumName: 'ReadingChannel', example: ReadingChannelName.StaffPwa })
  via!: ReadingChannelName;

  @ApiProperty({ example: '0.900', description: 'Confidence 0–1 (`readings.confidence`, D-012).' })
  confidence!: string;

  @ApiProperty({
    enum: ReadingReviewStateName,
    enumName: 'ReadingReviewState',
    example: ReadingReviewStateName.Accepted,
  })
  reviewState!: ReadingReviewStateName;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '42.120',
    description: 'Since the previous accepted reading (rollover-aware).',
  })
  consumption!: string | null;

  @ApiProperty({ example: false })
  isRollover!: boolean;

  @ApiProperty({ example: false })
  isInstall!: boolean;

  @ApiProperty({ example: false })
  isFinal!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  evidenceDocumentId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '12345.678' })
  ocrRawValue!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '0.950' })
  ocrConfidence!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  typedValue!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  reviewId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Correcting reading (D-142).',
  })
  supersededByReadingId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  readingBatchId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;
}

export class MeterReadingCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.meterId, description: 'The meter asset item.' })
  @IsUUID()
  assetItemId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.uuid,
    description: '`meter_photo` document; required when `readings.require_photo`.',
  })
  @IsOptional()
  @IsUUID()
  photoDocumentId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: REGISTER_EXAMPLE,
    pattern: REGISTER.source,
    description: 'Typed register; OCR checks it. Without it the OCR value is used.',
  })
  @IsOptional()
  @IsString()
  @Matches(REGISTER)
  typedValue?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  @IsOptional()
  @IsDateString()
  readAt?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'Reading batch (defaults to the staff round of the period).',
  })
  @IsOptional()
  @IsUUID()
  batchId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class MeterReadingListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ReadingReviewDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({ enum: ReviewReasonName, enumName: 'ReviewReason', example: ReviewReasonName.OutOfBand })
  reason!: ReviewReasonName;

  @ApiProperty({ type: String, nullable: true, example: '0.000' })
  bandLow!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '210.000' })
  bandHigh!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '5.200', description: 'Trailing daily average.' })
  trailingAvg!: string | null;

  @ApiProperty({ enum: ReviewStatusName, enumName: 'ReviewStatus', example: ReviewStatusName.Open })
  status!: ReviewStatusName;

  @ApiProperty({ type: () => MeterReadingDto })
  reading!: MeterReadingDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  decisionNote!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  correctedRegister!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  correctedReadingId!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: [String], example: ['accept', 'correct', 'reject'] })
  nextActions!: string[];
}

export class ReviewListQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ReviewStatusName, enumName: 'ReviewStatus', default: ReviewStatusName.Open })
  @IsOptional()
  @IsEnum(ReviewStatusName)
  status?: ReviewStatusName;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class ReviewDecisionDto {
  @ApiProperty({ enum: ReviewDecisionName, enumName: 'ReviewDecision', example: ReviewDecisionName.Correct })
  @IsEnum(ReviewDecisionName)
  action!: ReviewDecisionName;

  @ApiPropertyOptional({
    example: '12350.000',
    pattern: REGISTER.source,
    description: 'Required to correct.',
  })
  @IsOptional()
  @IsString()
  @Matches(REGISTER)
  register?: string;

  @ApiPropertyOptional({ example: 'OCR read 1 as 7', description: 'Required to correct or reject.' })
  @IsOptional()
  @IsString()
  @Length(3, 500)
  note?: string;
}

export class MeterAssignmentHistoryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.meterId })
  assetItemId!: string;

  @ApiProperty({ example: 'มิเตอร์ไฟ A-201' })
  meterName!: string;

  @ApiProperty({ type: String, nullable: true, example: 'SN-1' })
  meterSerial!: string | null;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ example: 'E-A-201' })
  code!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  validFrom!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  validTo!: string | null;

  @ApiProperty({ example: '0.000' })
  initialReading!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  finalReading!: string | null;

  @ApiProperty({ type: () => [MeterReadingDto] })
  readings!: MeterReadingDto[];
}

export class MeterSwapRecordDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  oldAssignmentId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  newAssignmentId!: string;

  @ApiProperty({ example: '23456.700' })
  oldLastRegister!: string;

  @ApiProperty({ example: '0.000' })
  newFirstRegister!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  swappedAt!: string;

  @ApiProperty({ example: 'meter display broken' })
  reason!: string;
}

export class UnitMeterHistoryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({
    type: () => [MeterAssignmentHistoryDto],
    description: 'Oldest first, per utility (swaps included).',
  })
  assignments!: MeterAssignmentHistoryDto[];

  @ApiProperty({ type: () => [MeterSwapRecordDto] })
  swaps!: MeterSwapRecordDto[];
}

export class UtilityFilterQuery {
  @ApiPropertyOptional({ enum: UtilityName, enumName: 'Utility' })
  @IsOptional()
  @IsEnum(UtilityName)
  utility?: UtilityName;
}

export class ExportQuery {
  @ApiProperty({ format: 'date-time', example: '2026-10-01T00:00:00+07:00' })
  @IsDateString()
  from!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:00:00+07:00' })
  @IsDateString()
  to!: string;
}

export class RoundsQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class RoundLastReadingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: '12300.000' })
  register!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  readAt!: string;

  @ApiProperty({ enum: ReadingSourceName, enumName: 'ReadingSource', example: ReadingSourceName.Ocr })
  source!: ReadingSourceName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  photoDocumentId!: string | null;
}

export class RoundItemDto {
  @ApiProperty({ format: 'uuid', example: FAKE.meterId })
  assetItemId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  meterAssignmentId!: string;

  @ApiProperty({ example: 'E-A-201' })
  code!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ enum: MeterPurposeName, enumName: 'MeterPurpose', example: MeterPurposeName.Unit })
  purpose!: MeterPurposeName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.unitCode })
  unitNo!: string | null;

  @ApiProperty({
    example: false,
    description: 'Has an open gateway channel (listed because its health is not ok).',
  })
  iot!: boolean;

  @ApiProperty({ enum: MeterHealthName, enumName: 'MeterHealth', nullable: true, example: null })
  health!: MeterHealthName | null;

  @ApiProperty({ type: () => RoundLastReadingDto, nullable: true })
  lastReading!: RoundLastReadingDto | null;
}

export class RoundFloorDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  floorId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ชั้น 2' })
  floorName!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  level!: number | null;

  @ApiProperty({ type: () => [RoundItemDto] })
  items!: RoundItemDto[];
}

export class RoundBuildingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ example: '2026-10', description: 'Billing period (`billing.cutoff`).' })
  periodKey!: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-25T00:00:00+07:00' })
  cutoffAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-18T00:00:00+07:00' })
  windowStart!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The round (`reading_batch`), once started.',
  })
  batchId!: string | null;

  @ApiProperty({ type: 'integer', example: 12, description: 'Meters still to read (listed in `floors`).' })
  remaining!: number;

  @ApiProperty({
    type: 'integer',
    example: 30,
    description:
      'Meters in the round: read manually (no gateway channel) or IoT meters that are stale / silent / without a device.',
  })
  total!: number;

  @ApiProperty({
    type: 'integer',
    example: 18,
    description:
      'Of `total`, meters with an accepted or pending-review reading in the window, by anyone (`total = read + remaining`).',
  })
  read!: number;

  @ApiProperty({ type: () => [RoundFloorDto] })
  floors!: RoundFloorDto[];
}

// ------------------------------------------------------------------------------------------------ utility invoices & loss

export class UtilityInvoiceDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  provider!: UtilityProviderName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  utilityAccountId!: string | null;

  @ApiProperty({ format: 'date', example: '2026-09-26' })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2026-10-25' })
  periodEnd!: string;

  @ApiProperty({ type: String, nullable: true, example: '0123456789' })
  invoiceNo!: string | null;

  @ApiProperty({ example: '5230.000', description: 'Units billed by the utility (kWh or m³).' })
  units!: string;

  @MoneyOutput({ example: '24518.32', description: 'Invoice total.' })
  amount!: string;

  @ApiProperty({ type: String, nullable: true, example: '0.3972', description: 'Ft per kWh.' })
  ft!: string | null;

  @MoneyOutput({ example: '38.22', description: 'Service charge.', nullable: true })
  serviceCharge!: string | null;

  @MoneyOutput({ example: '1604.00', description: 'VAT.', nullable: true })
  vat!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '81200.000' })
  previousRegister!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '86430.000' })
  currentRegister!: string | null;

  @ApiProperty({
    enum: UtilityInvoiceSourceName,
    enumName: 'UtilityInvoiceSource',
    example: UtilityInvoiceSourceName.Manual,
  })
  source!: UtilityInvoiceSourceName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  invoiceDocumentId!: string | null;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;
}

export class UtilityInvoiceCreateDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;

  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  @IsEnum(UtilityProviderName)
  provider!: UtilityProviderName;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: null })
  @IsOptional()
  @IsUUID()
  utilityAccountId?: string | null;

  @ApiProperty({ format: 'date', example: '2026-09-26' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2026-10-25' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodEnd!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '0123456789' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoiceNo?: string | null;

  @ApiProperty({ example: '5230.000', pattern: REGISTER.source })
  @IsString()
  @Matches(REGISTER)
  units!: string;

  @MoneyInput({ example: '24518.32', description: 'Invoice total.' })
  amount!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0.3972',
    pattern: '^-?\\d{1,4}(\\.\\d{1,4})?$',
  })
  @IsOptional()
  @IsString()
  @Matches(/^-?\d{1,4}(\.\d{1,4})?$/)
  ft?: string | null;

  @MoneyInput({ example: '38.22', description: 'Service charge.', optional: true, nullable: true })
  serviceCharge?: string | null;

  @MoneyInput({ example: '1604.00', description: 'VAT.', optional: true, nullable: true })
  vat?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '81200.000', pattern: REGISTER.source })
  @IsOptional()
  @IsString()
  @Matches(REGISTER)
  previousRegister?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '86430.000', pattern: REGISTER.source })
  @IsOptional()
  @IsString()
  @Matches(REGISTER)
  currentRegister?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: '`utility_invoice` document.',
  })
  @IsOptional()
  @IsUUID()
  invoiceDocumentId?: string | null;
}

export class UtilityInvoiceUpdateDto {
  @ApiPropertyOptional({ format: 'date', example: '2026-09-26' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodStart?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-10-25' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  periodEnd?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '0123456789' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoiceNo?: string | null;

  @ApiPropertyOptional({ example: '5231.000', pattern: REGISTER.source })
  @IsOptional()
  @IsString()
  @Matches(REGISTER)
  units?: string;

  @MoneyInput({ example: '24522.10', description: 'Invoice total.', optional: true })
  amount?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '0.3972' })
  @IsOptional()
  @IsString()
  @Matches(/^-?\d{1,4}(\.\d{1,4})?$/)
  ft?: string | null;

  @MoneyInput({ example: '38.22', description: 'Service charge.', optional: true, nullable: true })
  serviceCharge?: string | null;

  @MoneyInput({ example: '1604.00', description: 'VAT.', optional: true, nullable: true })
  vat?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: null })
  @IsOptional()
  @IsUUID()
  invoiceDocumentId?: string | null;
}

export class UtilityInvoicePrefillRequestDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: '`utility_invoice` document (photo or PDF).',
  })
  @IsUUID()
  documentId!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;
}

export class UtilityInvoiceImportDto extends UtilityInvoicePrefillRequestDto {
  @ApiProperty({ enum: UtilityProviderName, enumName: 'UtilityProvider', example: UtilityProviderName.Mea })
  @IsEnum(UtilityProviderName)
  provider!: UtilityProviderName;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, example: null })
  @IsOptional()
  @IsUUID()
  utilityAccountId?: string | null;
}

export class UtilityInvoiceFieldsDto {
  @ApiProperty({ type: String, nullable: true, example: '0123456789' })
  invoiceNo!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-09-26' })
  periodStart!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-25' })
  periodEnd!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '5230.000' })
  units!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '24518.32' })
  amount!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '0.3972' })
  ft!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '38.22' })
  serviceCharge!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '1604.00' })
  vat!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '81200.000' })
  previousRegister!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '86430.000' })
  currentRegister!: string | null;
}

export class UtilityInvoicePrefillDto {
  @ApiProperty({
    type: () => UtilityInvoiceFieldsDto,
    description: 'Fields read from the document; the owner checks them before saving.',
  })
  fields!: UtilityInvoiceFieldsDto;

  @ApiProperty({ example: 0.92, description: 'Model confidence 0–1.' })
  confidence!: number;

  @ApiProperty({ example: 'fake-ocr' })
  model!: string;
}

export class LossQuery {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;

  @ApiPropertyOptional({
    example: '2026-10',
    description:
      'Billing cycle as its period key (`YYYY-MM`, `billing.cutoff`); default: the last closed cycle. B4 cycles keep the same key.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  cycle?: string;
}

export class LossRecomputeDto {
  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  @IsEnum(UtilityName)
  utility!: UtilityName;

  @ApiProperty({ example: '2026-10', description: 'Billing cycle period key.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  cycle!: string;
}

export class LossSuspectDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    enum: LossSuspectKindName,
    enumName: 'LossSuspectKind',
    example: LossSuspectKindName.UsageWhileVacant,
  })
  kind!: LossSuspectKindName;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  unitId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.meterId })
  assetItemId!: string | null;

  @ApiProperty({ example: '62.50', description: '0–100; bigger = look first.' })
  score!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { unitNo: 'A-305', units: '45.000' } })
  detail!: Record<string, unknown>;
}

export class LossReportDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Electric })
  utility!: UtilityName;

  @ApiProperty({ example: '2026-10' })
  periodKey!: string;

  @ApiProperty({ format: 'date', example: '2026-09-25' })
  periodStart!: string;

  @ApiProperty({ format: 'date', example: '2026-10-25' })
  periodEnd!: string;

  @ApiProperty({ example: '5230.000' })
  invoiceUnits!: string;

  @ApiProperty({ example: '4801.250' })
  unitBilledUnits!: string;

  @ApiProperty({ example: '310.000' })
  commonAreaUnits!: string;

  @ApiProperty({ example: '118.750', description: 'invoice − unit-billed − common area (D-032).' })
  lossUnits!: string;

  @ApiProperty({ type: String, nullable: true, example: '2.2706', description: '% of the invoice units.' })
  lossPct!: string | null;

  @MoneyOutput({ example: '548.68', description: 'Loss at the price basis.' })
  lossThb!: string;

  @ApiProperty({
    enum: LossPriceBasisName,
    enumName: 'LossPriceBasis',
    example: LossPriceBasisName.UtilityTariff,
  })
  priceBasis!: LossPriceBasisName;

  @ApiProperty({
    enum: BilledUnitsSourceName,
    enumName: 'BilledUnitsSource',
    example: BilledUnitsSourceName.MeterReadingsStub,
    description: '`meter_readings_stub` until B4 invoices exist.',
  })
  billedUnitsSource!: BilledUnitsSourceName;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  computedAt!: string;

  @ApiProperty({ type: () => [LossSuspectDto] })
  suspects!: LossSuspectDto[];
}

export class LossTrendPointDto {
  @ApiProperty({ format: 'date', example: '2026-10-25' })
  periodEnd!: string;

  @ApiProperty({ example: '118.750' })
  lossUnits!: string;

  @ApiProperty({ type: String, nullable: true, example: '2.2706' })
  lossPct!: string | null;

  @MoneyOutput({ example: '548.68', description: 'Loss.' })
  lossThb!: string;
}

export class LossViewDto {
  @ApiProperty({ type: () => LossReportDto })
  report!: LossReportDto;

  @ApiProperty({ type: () => [LossTrendPointDto], description: 'Up to 12 periods, oldest first.' })
  trend!: LossTrendPointDto[];
}

export class LossSummaryRowDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ enum: UtilityName, enumName: 'Utility', example: UtilityName.Water })
  utility!: UtilityName;

  @ApiProperty({ format: 'date', example: '2026-10-25' })
  periodEnd!: string;

  @ApiProperty({ example: '12.400' })
  lossUnits!: string;

  @ApiProperty({ type: String, nullable: true, example: '8.1000' })
  lossPct!: string | null;

  @MoneyOutput({ example: '210.80', description: 'Loss.' })
  lossThb!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  suspects!: number;
}

// ------------------------------------------------------------------------------------------------ device batch

/** OpenAPI mirror of the protocol `Reading` (contract/device-protocol.json is the source of truth). */
export class BatchReadingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.meterId })
  @IsUUID()
  meterId!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 1042 })
  @IsInt()
  @Min(0)
  seq!: number;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  @IsDateString()
  readAt!: string;

  @ApiProperty({ example: '12345.678', pattern: REGISTER.source })
  @IsString()
  register!: string;

  @ApiProperty({ enum: MeterUnitName, enumName: 'MeterUnit', example: MeterUnitName.Kwh })
  @IsEnum(MeterUnitName)
  unit!: MeterUnitName;

  @ApiProperty({
    example: 'good',
    description:
      'Protocol `ReadingQuality` (good, estimated_by_gateway, clock_suspect, overflow_corrected, register_decrease).',
  })
  @IsString()
  quality!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'number' }, example: { powerW: 710 } })
  @IsOptional()
  @IsObject()
  extra?: Record<string, number>;
}

/** OpenAPI mirror of the protocol `TelemetryBatch` for the HTTPS fallback (edge CR-009). */
export class ReadingsBatchDto {
  @ApiProperty({ format: 'uuid', example: FAKE.gatewayId })
  @IsUUID()
  gatewayId!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 2 })
  @IsInt()
  @Min(0)
  configVersion!: number;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T00:15:03+07:00' })
  @IsDateString()
  sentAt!: string;

  @ApiProperty({ type: () => [BatchReadingDto], description: '1–200 readings; no repeated (meterId, seq).' })
  @ValidateNested({ each: true })
  @Type(() => BatchReadingDto)
  readings!: BatchReadingDto[];
}

export class OtaManifestQuery {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The release of the `ota_apply` command (default: the latest commanded).',
  })
  @IsOptional()
  @IsUUID()
  releaseId?: string;
}

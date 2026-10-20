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
  ValidateNested,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : value === true || value === 'true' || value === '1';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export enum ParcelStatusName {
  Received = 'received',
  Notified = 'notified',
  PickedUp = 'picked_up',
  Returned = 'returned',
}

export enum PickupConfirmationName {
  ResidentPin = 'resident_pin',
  Staff = 'staff',
}

export enum FacilityKindName {
  MeetingRoom = 'meeting_room',
  Fitness = 'fitness',
  Pool = 'pool',
  Bbq = 'bbq',
  ParkingVisitor = 'parking_visitor',
  Other = 'other',
}

export enum BookingStatusName {
  Requested = 'requested',
  Confirmed = 'confirmed',
  Cancelled = 'cancelled',
  NoShow = 'no_show',
}

export enum ContactKindName {
  Emergency = 'emergency',
  Building = 'building',
  Vendor = 'vendor',
  Utility = 'utility',
}

// ------------------------------------------------------------------------------------------- translations

export class TranslationDto {
  @ApiPropertyOptional({ example: 'Water outage on Saturday', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @ApiProperty({ example: 'The water will be off from 9:00 to 12:00 for tank cleaning.', maxLength: 10000 })
  @IsString()
  @Length(1, 10000)
  body!: string;
}

export class TranslationsDto {
  @ApiPropertyOptional({ type: TranslationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationDto)
  en?: TranslationDto;

  @ApiPropertyOptional({ type: TranslationDto, description: 'Burmese.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationDto)
  my?: TranslationDto;

  @ApiPropertyOptional({ type: TranslationDto, description: 'Khmer.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationDto)
  km?: TranslationDto;

  @ApiPropertyOptional({ type: TranslationDto, description: 'Lao.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationDto)
  lo?: TranslationDto;

  @ApiPropertyOptional({ type: TranslationDto, description: 'Chinese.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationDto)
  zh?: TranslationDto;
}

export class AudienceFilterDto {
  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [FAKE.uuid] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  floorIds?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', example: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  unitIds?: string[];
}

// ------------------------------------------------------------------------------------------- announcements

export class AnnouncementDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: FAKE.buildingId,
    description: 'null = all buildings.',
  })
  buildingId!: string | null;

  @ApiProperty({ example: 'งดจ่ายน้ำวันเสาร์' })
  title!: string;

  @ApiProperty({ example: 'งดจ่ายน้ำเวลา 9:00–12:00 เพื่อล้างถังเก็บน้ำ' })
  bodyTh!: string;

  @ApiProperty({ type: TranslationsDto })
  translations!: TranslationsDto;

  @ApiProperty({ type: AudienceFilterDto })
  audienceFilter!: AudienceFilterDto;

  @ApiProperty({ example: true })
  pinned!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: FAKE.dateTime,
    description: 'null = draft.',
  })
  publishedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  expiresAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  archivedAt!: string | null;

  @ApiProperty({ type: 'integer', example: 12, description: 'Read receipts so far.' })
  readCount!: number;

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class AnnouncementListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'The building’s and the tenant-wide ones.' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  published?: boolean;
}

export class AnnouncementUpdateDto {
  @ApiPropertyOptional({ example: 'งดจ่ายน้ำวันเสาร์', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @ApiPropertyOptional({ example: 'งดจ่ายน้ำเวลา 9:00–12:00', maxLength: 10000 })
  @IsOptional()
  @IsString()
  @Length(1, 10000)
  bodyTh?: string;

  @ApiPropertyOptional({ type: TranslationsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationsDto)
  translations?: TranslationsDto;

  @ApiPropertyOptional({ type: AudienceFilterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceFilterDto)
  audienceFilter?: AudienceFilterDto;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}

export class AnnouncementCreateDto extends AnnouncementUpdateDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Omitted = every building.',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiProperty({ example: 'งดจ่ายน้ำวันเสาร์', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  declare title: string;

  @ApiProperty({ example: 'งดจ่ายน้ำเวลา 9:00–12:00 เพื่อล้างถังเก็บน้ำ', maxLength: 10000 })
  @IsString()
  @Length(1, 10000)
  declare bodyTh: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Publish now (LINE push to the audience) instead of a draft.',
  })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class AnnouncementReadDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  name!: string;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  readAt!: string;
}

export class AnnouncementReadsDto {
  @ApiProperty({ type: 'integer', example: 40, description: 'Residents in the audience today.' })
  audience!: number;

  @ApiProperty({ type: [AnnouncementReadDto] })
  data!: AnnouncementReadDto[];
}

export class ResidentAnnouncementDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'en', description: 'The language shown (mine when translated, else Thai).' })
  language!: string;

  @ApiProperty({ example: 'Water outage on Saturday' })
  title!: string;

  @ApiProperty({ example: 'The water will be off from 9:00 to 12:00.' })
  body!: string;

  @ApiProperty({ example: true })
  pinned!: boolean;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  publishedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  readAt!: string | null;
}

export class ResidentAnnouncementsDto {
  @ApiProperty({ type: [ResidentAnnouncementDto] })
  data!: ResidentAnnouncementDto[];
}

// ------------------------------------------------------------------------------------------------- parcels

export class ParcelDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  recipientPartyId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Kerry Express' })
  carrier!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'KEX0000000001' })
  trackingNo!: string | null;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  photoDocumentId!: string;

  @ApiProperty({ enum: ParcelStatusName, enumName: 'ParcelStatus', example: ParcelStatusName.Notified })
  status!: ParcelStatusName;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  receivedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  notifiedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  pickedUpAt!: string | null;

  @ApiProperty({
    enum: PickupConfirmationName,
    enumName: 'PickupConfirmation',
    nullable: true,
    example: null,
  })
  pickupConfirmedBy!: PickupConfirmationName | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  returnedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  returnReason!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;
}

export class ResidentParcelDto extends ParcelDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '482913',
    description: 'Show it at the desk to pick the parcel up (null once picked up or returned).',
  })
  pin!: string | null;
}

export class ResidentParcelsDto {
  @ApiProperty({ type: [ResidentParcelDto] })
  data!: ResidentParcelDto[];
}

export class ParcelListQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: ParcelStatusName, enumName: 'ParcelStatus' })
  @IsOptional()
  @IsEnum(ParcelStatusName)
  status?: ParcelStatusName;

  @ApiPropertyOptional({ type: Boolean, description: 'Waiting for pick-up.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  open?: boolean;
}

export class ParcelCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  unitId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Named recipient (party).',
  })
  @IsOptional()
  @IsUUID()
  recipientPartyId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Kerry Express', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  carrier?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'KEX0000000001', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  trackingNo?: string | null;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The photo staff took (`…/files/presign`).',
  })
  @IsUUID()
  photoDocumentId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string | null;
}

export class ParcelPickUpDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '482913',
    description: 'The PIN the resident shows.',
  })
  @IsOptional()
  @Matches(/^\d{6}$/)
  pin?: string | null;

  @ApiPropertyOptional({
    example: false,
    description: 'Staff confirm the hand-over without the PIN (recorded as such).',
  })
  @IsOptional()
  @IsBoolean()
  staffConfirmed?: boolean;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'Who collected it.' })
  @IsOptional()
  @IsUUID()
  pickedUpByPartyId?: string | null;
}

// ---------------------------------------------------------------------------------------------- facilities

export class BookingPolicyDto {
  @ApiPropertyOptional({ type: 'integer', example: 60, minimum: 15, maximum: 720 })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(720)
  slotMinutes?: number;

  @ApiPropertyOptional({ example: '08:00' })
  @IsOptional()
  @Matches(HHMM)
  openFrom?: string;

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @Matches(HHMM)
  openTo?: string;

  @ApiPropertyOptional({ type: 'integer', example: 120 })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(1440)
  maxDurationMinutes?: number;

  @ApiPropertyOptional({ type: 'integer', example: 14 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  maxAdvanceDays?: number;

  @ApiPropertyOptional({ type: 'integer', example: 2, description: 'Live bookings per unit per week.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxPerUnitPerWeek?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
}

export class FacilityDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'ห้องประชุมชั้น 1' })
  name!: string;

  @ApiProperty({ enum: FacilityKindName, enumName: 'FacilityKind', example: FacilityKindName.MeetingRoom })
  kind!: FacilityKindName;

  @ApiProperty({ type: 'integer', nullable: true, example: 10 })
  capacity!: number | null;

  @ApiProperty({ type: BookingPolicyDto })
  bookingPolicy!: Required<BookingPolicyDto>;

  @ApiProperty({ example: true })
  isActive!: boolean;
}

export class FacilitiesDto {
  @ApiProperty({ type: [FacilityDto] })
  data!: FacilityDto[];
}

export class FacilityQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class FacilityUpdateDto {
  @ApiPropertyOptional({ example: 'ห้องประชุมชั้น 1', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ enum: FacilityKindName, enumName: 'FacilityKind' })
  @IsOptional()
  @IsEnum(FacilityKindName)
  kind?: FacilityKindName;

  @ApiPropertyOptional({ type: 'integer', nullable: true, example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number | null;

  @ApiPropertyOptional({ type: BookingPolicyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BookingPolicyDto)
  bookingPolicy?: BookingPolicyDto;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class FacilityCreateDto extends FacilityUpdateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  @IsUUID()
  buildingId!: string;

  @ApiProperty({ example: 'ห้องประชุมชั้น 1', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  declare name: string;

  @ApiProperty({ enum: FacilityKindName, enumName: 'FacilityKind', example: FacilityKindName.MeetingRoom })
  @IsEnum(FacilityKindName)
  declare kind: FacilityKindName;
}

export class BookingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  facilityId!: string;

  @ApiProperty({ example: 'ห้องประชุมชั้น 1' })
  facilityName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-03T10:00:00+07:00' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-03T11:00:00+07:00' })
  endsAt!: string;

  @ApiProperty({ enum: BookingStatusName, enumName: 'BookingStatus', example: BookingStatusName.Confirmed })
  status!: BookingStatusName;

  @ApiProperty({ type: String, nullable: true, example: null })
  cancelReason!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  note!: string | null;
}

export class BookingsDto {
  @ApiProperty({ type: [BookingDto] })
  data!: BookingDto[];
}

export class BookingRangeQuery {
  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Default: now.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Default: 31 days after `from`.' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class BookingCreateDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  facilityId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'A unit I occupy.' })
  @IsUUID()
  unitId!: string;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-03T10:00:00+07:00' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-03T11:00:00+07:00' })
  @IsDateString()
  endsAt!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string | null;
}

export class BookingDecisionDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'ปิดปรับปรุง', maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string | null;
}

export class ResidentFacilityQuery {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  unitId!: string;
}

export class AvailabilityQuery {
  @ApiProperty({ format: 'date', example: FAKE.date })
  @Matches(DATE)
  date!: string;
}

export class BusySlotDto {
  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-03T10:00:00+07:00' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-03T11:00:00+07:00' })
  endsAt!: string;

  @ApiProperty({ enum: BookingStatusName, enumName: 'BookingStatus', example: BookingStatusName.Confirmed })
  status!: BookingStatusName;

  @ApiProperty({ example: false, description: 'Booked by my unit.' })
  mine!: boolean;
}

export class AvailabilityDto {
  @ApiProperty({ type: FacilityDto })
  facility!: FacilityDto;

  @ApiProperty({ format: 'date', example: FAKE.date })
  date!: string;

  @ApiProperty({ type: [BusySlotDto] })
  busy!: BusySlotDto[];
}

// ------------------------------------------------------------------------------------------------- rules

export class BuildingRuleDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  version!: number;

  @ApiProperty({ example: 'ระเบียบการอยู่อาศัย' })
  title!: string;

  @ApiProperty({ example: 'ห้ามส่งเสียงดังหลัง 22:00 น.' })
  bodyTh!: string;

  @ApiProperty({ type: TranslationsDto })
  translations!: TranslationsDto;

  @ApiProperty({ format: 'date', example: FAKE.date })
  effectiveFrom!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  publishedAt!: string | null;

  @ApiProperty({ type: 'integer', example: 30 })
  acknowledgements!: number;
}

export class BuildingRulesDto {
  @ApiProperty({ type: [BuildingRuleDto] })
  data!: BuildingRuleDto[];
}

export class BuildingRuleCreateDto {
  @ApiProperty({ example: 'ระเบียบการอยู่อาศัย', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ example: 'ห้ามส่งเสียงดังหลัง 22:00 น.', maxLength: 50000 })
  @IsString()
  @Length(1, 50000)
  bodyTh!: string;

  @ApiPropertyOptional({ type: TranslationsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationsDto)
  translations?: TranslationsDto;

  @ApiProperty({ format: 'date', example: FAKE.date, description: 'Today or later (never backdated).' })
  @Matches(DATE)
  effectiveFrom!: string;
}

export class RuleAckDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: FAKE.nameTh })
  name!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  leaseId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', example: FAKE.dateTime })
  ackedAt!: string;
}

export class RuleAcksDto {
  @ApiProperty({ type: [RuleAckDto] })
  data!: RuleAckDto[];
}

export class ResidentRulesDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.uuid })
  ruleId!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  version!: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'ระเบียบการอยู่อาศัย' })
  title!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ห้ามส่งเสียงดังหลัง 22:00 น.' })
  body!: string | null;

  @ApiProperty({ example: 'th' })
  language!: string;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: FAKE.date })
  effectiveFrom!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  acknowledgedAt!: string | null;
}

export class RuleAckRequestDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  @IsUUID()
  unitId!: string;
}

// ------------------------------------------------------------------------------------------------ contacts

export class ContactDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: FAKE.buildingId })
  buildingId!: string | null;

  @ApiProperty({ enum: ContactKindName, enumName: 'ContactKind', example: ContactKindName.Emergency })
  kind!: ContactKindName;

  @ApiProperty({ example: 'นิติบุคคล / สำนักงานอาคาร' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: FAKE.phone })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '@getproperty' })
  lineId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes!: string | null;

  @ApiProperty({ type: 'integer', example: 0 })
  sortOrder!: number;
}

export class ContactsDto {
  @ApiProperty({ type: [ContactDto] })
  data!: ContactDto[];
}

export class ContactUpdateDto {
  @ApiPropertyOptional({ enum: ContactKindName, enumName: 'ContactKind' })
  @IsOptional()
  @IsEnum(ContactKindName)
  kind?: ContactKindName;

  @ApiPropertyOptional({ example: 'สำนักงานอาคาร', maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: FAKE.phone, maxLength: 30 })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '@getproperty', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  lineId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string | null;

  @ApiPropertyOptional({ type: 'integer', example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class ContactCreateDto extends ContactUpdateDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Omitted = every building.',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiProperty({ enum: ContactKindName, enumName: 'ContactKind', example: ContactKindName.Emergency })
  @IsEnum(ContactKindName)
  declare kind: ContactKindName;

  @ApiProperty({ example: 'สำนักงานอาคาร', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  declare name: string;
}

export class ContactQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

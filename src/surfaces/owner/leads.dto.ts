import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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
} from 'class-validator';

import { LanguageName } from '../shared/common.dto';
import { MoneyOutput } from '../shared/fields';

/** D-268: where a listing is shared and where an enquiry came from. */
export enum ListingChannelName {
  Line = 'line',
  FacebookGroup = 'facebook_group',
  FacebookMarketplace = 'facebook_marketplace',
  Qr = 'qr',
  Link = 'link',
}
export enum ListingLeadStateName {
  New = 'new',
  Contacted = 'contacted',
  ViewingBooked = 'viewing_booked',
  Viewed = 'viewed',
  Applied = 'applied',
  Won = 'won',
  Lost = 'lost',
}
export enum OwnerLeadStateName {
  Contacted = 'contacted',
  Viewed = 'viewed',
  Applied = 'applied',
  Won = 'won',
  Lost = 'lost',
}
export enum ListingLeadLostReasonName {
  Price = 'price',
  Location = 'location',
  UnitUnsuitable = 'unit_unsuitable',
  ChoseOther = 'chose_other',
  NoResponse = 'no_response',
  NotQualified = 'not_qualified',
  UnitLeased = 'unit_leased',
  Other = 'other',
}
export enum ListingLeadAuthorName {
  Prospect = 'prospect',
  Owner = 'owner',
}
export enum ListingViewingStateName {
  Requested = 'requested',
  Confirmed = 'confirmed',
  Declined = 'declined',
  Cancelled = 'cancelled',
  Completed = 'completed',
  NoShow = 'no_show',
}
export enum ViewingOutcomeName {
  Completed = 'completed',
  NoShow = 'no_show',
}

const AT = '2026-11-07T10:00:00+07:00';
const AT_END = '2026-11-07T10:30:00+07:00';

// ------------------------------------------------------------------------------------------------- read models

export class LeadMessageDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: ListingLeadAuthorName, enumName: 'ListingLeadAuthor', example: 'prospect' })
  author!: ListingLeadAuthorName;

  @ApiProperty({ example: 'ห้องยังว่างไหมคะ อยากเข้าดูเสาร์นี้' })
  body!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T09:15:00+07:00' })
  createdAt!: string;
}

export class LeadViewingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'date-time', example: AT })
  startsAt!: string;

  @ApiProperty({ format: 'date-time', example: AT_END })
  endsAt!: string;

  @ApiProperty({ enum: ListingViewingStateName, enumName: 'ListingViewingState', example: 'requested' })
  state!: ListingViewingStateName;

  @ApiProperty({ type: String, nullable: true, example: 'จะมากับแฟนค่ะ' })
  note!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Why the owner declined (or why the prospect cancelled).',
  })
  reason!: string | null;

  @ApiProperty({ enum: ListingLeadAuthorName, enumName: 'ListingLeadAuthor', nullable: true, example: null })
  cancelledBy!: ListingLeadAuthorName | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The viewing that replaced this one when the prospect changed the time.',
  })
  rescheduledTo!: string | null;
}

export class LeadListingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'condo-1br-0193f2a4b1' })
  slug!: string;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  title!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;
}

export class LeadProspectDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'The prospect’s party in my tenant.' })
  partyId!: string;

  @ApiProperty({ example: 'สมศรี ใจดี' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Only when the prospect verified one.',
  })
  phone!: string | null;

  @ApiProperty({ example: true, description: 'Replies reach the prospect in LINE.' })
  lineLinked!: boolean;

  @ApiProperty({ example: false, description: 'The prospect verified their identity (e-KYC, D-267).' })
  identityVerified!: boolean;
}

export class OwnerLeadSummaryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: () => LeadListingDto })
  listing!: LeadListingDto;

  @ApiProperty({ type: () => LeadProspectDto })
  prospect!: LeadProspectDto;

  @ApiProperty({ enum: ListingLeadStateName, enumName: 'ListingLeadState', example: 'new' })
  state!: ListingLeadStateName;

  @ApiProperty({ type: String, nullable: true, example: 'ห้องยังว่างไหมคะ อยากเข้าดูเสาร์นี้' })
  lastMessage!: string | null;

  @ApiProperty({
    enum: ListingChannelName,
    enumName: 'ListingChannel',
    nullable: true,
    example: 'facebook_group',
    description: 'The share-kit channel the prospect came from (D-268); null when not through a share link.',
  })
  channel!: ListingChannelName | null;

  @ApiProperty({
    enum: ListingLeadAuthorName,
    enumName: 'ListingLeadAuthor',
    nullable: true,
    example: 'prospect',
  })
  lastMessageBy!: ListingLeadAuthorName | null;

  @ApiProperty({
    example: true,
    description: 'The prospect wrote last and the enquiry is open: waiting for my answer.',
  })
  awaitingReply!: boolean;

  @ApiProperty({ type: () => LeadViewingDto, nullable: true, description: 'The next live viewing.' })
  nextViewing!: LeadViewingDto | null;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T09:15:00+07:00' })
  lastProspectAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  lastOwnerAt!: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T09:15:00+07:00' })
  createdAt!: string;
}

export class OwnerLeadDto extends OwnerLeadSummaryDto {
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-12-01' })
  moveInDate!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 12 })
  termMonths!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  occupants!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'TH',
    description: 'ISO 3166-1 alpha-2, when given.',
  })
  nationality!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ทำงานแถวอารีย์ สะดวกดูวันเสาร์' })
  notes!: string | null;

  @ApiProperty({
    enum: ListingLeadLostReasonName,
    enumName: 'ListingLeadLostReason',
    nullable: true,
    example: null,
  })
  lostReason!: ListingLeadLostReasonName | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  lostNote!: string | null;

  @ApiProperty({ type: [LeadMessageDto] })
  messages!: LeadMessageDto[];

  @ApiProperty({ type: [LeadViewingDto], description: 'Newest first.' })
  viewings!: LeadViewingDto[];

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The lease drafted from this enquiry (B7.4), when there is one.',
  })
  leaseId!: string | null;

  @ApiProperty({ example: 1 })
  version!: number;
}

export class LeadLeaseDraftDto {
  @ApiProperty({
    format: 'uuid',
    example: FAKE.uuid,
    description: 'The new lease draft (`GET /v1/owner/leases/{id}`).',
  })
  leaseId!: string;

  @ApiProperty({ type: () => OwnerLeadDto })
  lead!: OwnerLeadDto;
}

export class OwnerViewingListingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  title!: string;

  @ApiProperty({ example: 'condo-1br-0193f2a4b1' })
  slug!: string;
}

export class OwnerViewingDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'date-time', example: AT })
  startsAt!: string;

  @ApiProperty({ format: 'date-time', example: AT_END })
  endsAt!: string;

  @ApiProperty({ enum: ListingViewingStateName, enumName: 'ListingViewingState', example: 'confirmed' })
  state!: ListingViewingStateName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leadId!: string;

  @ApiProperty({ example: 'สมศรี ใจดี' })
  prospectName!: string;

  @ApiProperty({ type: () => OwnerViewingListingDto })
  listing!: OwnerViewingListingDto;
}

export class EnquiryListingDto {
  @ApiProperty({ example: 'condo-1br-0193f2a4b1' })
  slug!: string;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  titleTh!: string;

  @ApiProperty({ type: String, nullable: true, example: 'One-bedroom condo near BTS Ari' })
  titleEn!: string | null;

  @MoneyOutput({ example: '15000.00', description: 'Monthly rent.' })
  rent!: string;

  @ApiProperty({ type: String, nullable: true, example: 'พญาไท' })
  district!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'กรุงเทพมหานคร' })
  province!: string | null;

  @ApiProperty({ example: 'มาลี ใจงาม', description: 'Display name of the owner (tenant).' })
  ownerName!: string;

  @ApiProperty({
    example: true,
    description: 'False once the listing is no longer public (leased, paused, hidden).',
  })
  available!: boolean;
}

export class ProspectEnquiryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ type: () => EnquiryListingDto })
  listing!: EnquiryListingDto;

  @ApiProperty({
    example: true,
    description: 'False when the owner closed it; write again on the listing to start anew.',
  })
  open!: boolean;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-12-01' })
  moveInDate!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 12 })
  termMonths!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2 })
  occupants!: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  nationality!: string | null;

  @ApiProperty({ type: [LeadMessageDto] })
  messages!: LeadMessageDto[];

  @ApiProperty({ type: [LeadViewingDto], description: 'Newest first.' })
  viewings!: LeadViewingDto[];

  @ApiProperty({ format: 'date-time', example: '2026-11-01T09:15:00+07:00' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-01T09:15:00+07:00' })
  updatedAt!: string;
}

export class ViewingSlotDto {
  @ApiProperty({ format: 'date-time', example: AT })
  startsAt!: string;

  @ApiProperty({ format: 'date-time', example: AT_END })
  endsAt!: string;
}

export class ViewingSlotsDto {
  @ApiProperty({ type: 'integer', example: 30 })
  slotMinutes!: number;

  @ApiProperty({ type: [ViewingSlotDto], description: 'Free slots in time order (Asia/Bangkok offsets).' })
  slots!: ViewingSlotDto[];
}

// ------------------------------------------------------------------------------------------------------ inputs

export class EnquiryTermsDto {
  @ApiPropertyOptional({ type: String, format: 'date', nullable: true, example: '2026-12-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  moveInDate?: string | null;

  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 1, maximum: 120, example: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  termMonths?: number | null;

  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 1, maximum: 20, example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  occupants?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'TH',
    description: 'ISO 3166-1 alpha-2 — optional; never required to enquire (D-252).',
  })
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/)
  nationality?: string | null;

  @ApiPropertyOptional({
    enum: ListingChannelName,
    enumName: 'ListingChannel',
    nullable: true,
    example: 'facebook_group',
    description:
      'D-268: the share-kit channel the prospect came from (the `ch` of the short link). Kept on a new enquiry only.',
  })
  @IsOptional()
  @IsEnum(ListingChannelName)
  channel?: ListingChannelName | null;

  @ApiProperty({
    example: true,
    description:
      'I agree that the owner uses my name, messages and LINE contact to answer this enquiry (consent `prospect.enquiry`, PDPA). Required for the first contact with a listing; later messages may send false.',
  })
  @IsBoolean()
  consent!: boolean;
}

export class EnquiryCreateDto extends EnquiryTermsDto {
  @ApiProperty({ example: 'ห้องยังว่างไหมคะ อยากเข้าดูเสาร์นี้', minLength: 1, maxLength: 2000 })
  @IsString()
  @Length(1, 2000)
  message!: string;
}

export class ViewingRequestDto extends EnquiryTermsDto {
  @ApiProperty({
    format: 'date-time',
    example: AT,
    description: 'The start of a free slot (`viewing-slots`).',
  })
  @IsDateString()
  startsAt!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500, example: 'จะมากับแฟนค่ะ' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 2000,
    description: 'A message to the owner.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string | null;
}

export class LeadMessageCreateDto {
  @ApiProperty({ example: 'ยังว่างค่ะ เสาร์นี้ 10 โมงสะดวกไหมคะ', minLength: 1, maxLength: 1000 })
  @IsString()
  @Length(1, 1000)
  body!: string;
}

export class ViewingCancelDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300, example: 'ได้ห้องแล้วค่ะ' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string | null;
}

export class ViewingRescheduleDto {
  @ApiProperty({ format: 'date-time', example: AT, description: 'The start of another free slot.' })
  @IsDateString()
  startsAt!: string;
}

export class ViewingDeclineDto {
  @ApiProperty({ example: 'ไม่สะดวกช่วงเช้า ขอเป็นบ่ายได้ไหมคะ', minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class LeadLeaseDraftCreateDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-12-01',
    description: "Default: the prospect's move-in date, else the listing's available date, else today.",
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 120,
    example: 12,
    description: "Default: the prospect's term, at least the listing's minimum.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  months?: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Acknowledged compliance warnings of the lease terms (D-021a), as for any lease draft.',
  })
  @IsOptional()
  @IsUUID('all', { each: true })
  acknowledgementIds?: string[];

  @ApiPropertyOptional({
    enum: LanguageName,
    enumName: 'Language',
    description: 'Contract language of the landlord template (B7.5), default `th`.',
  })
  @IsOptional()
  @IsEnum(LanguageName)
  language?: LanguageName;
}

export class ViewingCompleteDto {
  @ApiProperty({ enum: ViewingOutcomeName, enumName: 'ViewingOutcome', example: 'completed' })
  @IsEnum(ViewingOutcomeName)
  outcome!: ViewingOutcomeName;
}

export class LeadNotesDto {
  @ApiProperty({ type: String, nullable: true, maxLength: 2000, example: 'ทำงานแถวอารีย์ สะดวกดูวันเสาร์' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes!: string | null;
}

export class LeadStateDto {
  @ApiProperty({ enum: OwnerLeadStateName, enumName: 'OwnerLeadState', example: 'lost' })
  @IsEnum(OwnerLeadStateName)
  state!: OwnerLeadStateName;

  @ApiPropertyOptional({
    enum: ListingLeadLostReasonName,
    enumName: 'ListingLeadLostReason',
    nullable: true,
    description: 'Required with `lost`.',
  })
  @IsOptional()
  @IsEnum(ListingLeadLostReasonName)
  lostReason?: ListingLeadLostReasonName | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  lostNote?: string | null;
}

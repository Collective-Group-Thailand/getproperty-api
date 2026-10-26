import { FAKE } from '@common/openapi/examples';
import { toBangkokIso } from '@common/time/bangkok';
import { type RentRecordFacts } from '@modules/ops-leases/rent-record';
import { type ShareWithLead } from '@modules/ops-leases/rent-record.service';
import { ApiProperty } from '@nestjs/swagger';

export enum RentRecordMonthStatusName {
  OnTime = 'on_time',
  Late = 'late',
  Outstanding = 'outstanding',
}

export enum RentRecordShareKindName {
  Enquiry = 'enquiry',
  Letter = 'letter',
}

export enum RentRecordShareStateName {
  Live = 'live',
  Revoked = 'revoked',
  Expired = 'expired',
}

export class RentRecordMonthDto {
  @ApiProperty({ example: '2026-10', description: 'Month of the invoice period (Bangkok, YYYY-MM).' })
  month!: string;

  @ApiProperty({ enum: RentRecordMonthStatusName, enumName: 'RentRecordMonthStatus', example: 'on_time' })
  status!: RentRecordMonthStatusName;
}

export class RentRecordDto {
  @ApiProperty({ type: [RentRecordMonthDto], description: 'One row per month, newest first.' })
  months!: RentRecordMonthDto[];

  @ApiProperty({ example: 11, description: 'Months paid in full by the due date (D-256).' })
  onTime!: number;

  @ApiProperty({ example: 1, description: 'Months paid in full after the due date.' })
  late!: number;

  @ApiProperty({ example: 0, description: 'Months with money still owed past the due date.' })
  outstanding!: number;

  @ApiProperty({
    example: 0,
    description:
      'Months paid in a way getproperty did not confirm (cash, a transfer the owner recorded); not counted.',
  })
  notConfirmed!: number;

  @ApiProperty({ type: String, nullable: true, example: '2025-11' })
  firstMonth!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-10' })
  lastMonth!: string | null;
}

export class RentRecordShareLeadDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์' })
  listingTitle!: string;

  @ApiProperty({ example: 'มาลี มีสุข' })
  ownerName!: string;
}

export class RentRecordShareDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ enum: RentRecordShareKindName, enumName: 'RentRecordShareKind', example: 'enquiry' })
  kind!: RentRecordShareKindName;

  @ApiProperty({ enum: RentRecordShareStateName, enumName: 'RentRecordShareState', example: 'live' })
  state!: RentRecordShareStateName;

  @ApiProperty({
    type: RentRecordShareLeadDto,
    nullable: true,
    description: 'The enquiry it is shared with.',
  })
  lead!: RentRecordShareLeadDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'K7QX',
    description: 'A letter: the last 4 characters of its code.',
  })
  codeHint!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: FAKE.dateTime })
  expiresAt!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  revokedAt!: string | null;
}

export class MyRentRecordDto {
  @ApiProperty({ type: RentRecordDto })
  record!: RentRecordDto;

  @ApiProperty({ type: [RentRecordShareDto], description: 'Everything I shared, newest first.' })
  shares!: RentRecordShareDto[];
}

export class RentRecordLetterDto {
  @ApiProperty({ type: RentRecordShareDto })
  share!: RentRecordShareDto;

  @ApiProperty({
    example: 'H4N8R2K7QX',
    description: 'The verification code — shown once; only its hash is kept.',
  })
  code!: string;

  @ApiProperty({
    example: 'https://getproperty.co/rent-record/H4N8R2K7QX',
    description: 'Where anyone with the code checks it.',
  })
  verifyUrl!: string;
}

export class PublicRentRecordDto {
  @ApiProperty({ example: 'สมศรี ใจดี', description: 'The name the holder uses on getproperty.' })
  holderName!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  issuedAt!: string;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  expiresAt!: string;

  @ApiProperty({ type: RentRecordDto })
  record!: RentRecordDto;
}

export class LeadRentRecordDto extends RentRecordDto {
  @ApiProperty({
    format: 'date-time',
    example: FAKE.dateTime,
    description: 'When the prospect shared it with this enquiry.',
  })
  sharedAt!: string;
}

export function rentRecordDto(f: RentRecordFacts): RentRecordDto {
  return {
    months: f.months.map((m) => ({ month: m.month, status: m.status as RentRecordMonthStatusName })),
    onTime: f.onTime,
    late: f.late,
    outstanding: f.outstanding,
    notConfirmed: f.notConfirmed,
    firstMonth: f.firstMonth,
    lastMonth: f.lastMonth,
  };
}

export function rentRecordShareDto(s: ShareWithLead, state: RentRecordShareStateName): RentRecordShareDto {
  return {
    id: s.id,
    kind: s.kind as RentRecordShareKindName,
    state,
    lead: s.lead
      ? { id: s.lead.id, listingTitle: s.lead.listing.titleTh ?? '', ownerName: s.lead.tenant.displayName }
      : null,
    codeHint: s.codeHint,
    expiresAt: s.expiresAt ? toBangkokIso(s.expiresAt) : null,
    createdAt: toBangkokIso(s.createdAt),
    revokedAt: s.revokedAt ? toBangkokIso(s.revokedAt) : null,
  };
}

export const RENT_RECORD_EXAMPLE: RentRecordDto = {
  months: [
    { month: '2026-10', status: RentRecordMonthStatusName.OnTime },
    { month: '2026-09', status: RentRecordMonthStatusName.Late },
  ],
  onTime: 1,
  late: 1,
  outstanding: 0,
  notConfirmed: 0,
  firstMonth: '2026-09',
  lastMonth: '2026-10',
};

export const RENT_RECORD_SHARE_EXAMPLE: RentRecordShareDto = {
  id: FAKE.uuid,
  kind: RentRecordShareKindName.Enquiry,
  state: RentRecordShareStateName.Live,
  lead: { id: FAKE.uuid, listingTitle: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', ownerName: 'มาลี มีสุข' },
  codeHint: null,
  expiresAt: null,
  createdAt: '2026-11-01T09:15:00+07:00',
  revokedAt: null,
};

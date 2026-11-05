import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';

import { InvitationChannelName, InvitationStateName } from '../owner/tenancy.dto';
import { SeriesBucketName, UsageSummaryDto, UtilityUsageDto } from '../shared/smart.dto';
import { BuildingLegalFormName, PropertyKindName } from '../shared/status.enums';
import {
  ResidentUnitCapability,
  ResidentUnitRoleName,
  ResidentUnitRoleSourceName,
} from './resident-unit-roles.dto';

export {
  ResidentUnitCapability,
  ResidentUnitRoleName,
  ResidentUnitRoleRefDto,
  ResidentUnitRoleSourceName,
} from './resident-unit-roles.dto';

export enum ResidentInviteChannelName {
  LineQr = 'line_qr',
  Sms = 'sms',
  Link = 'link',
}

export class ResidentUnitRoleDto {
  @ApiProperty({
    enum: ResidentUnitRoleName,
    enumName: 'ResidentUnitRole',
    example: ResidentUnitRoleName.CoOwner,
  })
  role!: ResidentUnitRoleName;

  @ApiProperty({
    enum: ResidentUnitRoleSourceName,
    enumName: 'ResidentUnitRoleSource',
    example: ResidentUnitRoleSourceName.Ownership,
  })
  source!: ResidentUnitRoleSourceName;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid, description: 'My party that holds the role.' })
  partyId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: null,
    description: 'The lease of a `lease` role.',
  })
  leaseId!: string | null;

  @ApiProperty({ format: 'date', example: '2026-10-01' })
  from!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: null,
    description: 'End day (ownership / occupancy: the role ends on this day; lease: its planned last day).',
  })
  to!: string | null;
}

export class ResidentMeUnitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  propertyId!: string;

  @ApiProperty({
    enum: PropertyKindName,
    enumName: 'PropertyKind',
    nullable: true,
    example: PropertyKindName.Condo,
    description:
      'What the place is (D-302): the app names the unit by it — ห้อง (condo / apartment), บ้าน (village), พื้นที่ (office / retail). null = not set.',
  })
  propertyKind!: PropertyKindName | null;

  @ApiProperty({
    enum: BuildingLegalFormName,
    enumName: 'BuildingLegalForm',
    nullable: true,
    example: BuildingLegalFormName.CondoAct,
    description:
      'The law the building’s juristic management runs under (D-302); null for rentals without one.',
  })
  legalForm!: BuildingLegalFormName | null;

  @ApiProperty({
    format: 'uuid',
    example: FAKE.tenantId,
    description: 'The tenant that runs the unit for me.',
  })
  tenantId!: string;

  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({ type: () => [ResidentUnitRoleDto], description: 'Every role I hold on the unit today.' })
  roles!: ResidentUnitRoleDto[];

  @ApiProperty({
    enum: ResidentUnitCapability,
    enumName: 'ResidentUnitCapability',
    isArray: true,
    example: [
      ResidentUnitCapability.Notices,
      ResidentUnitCapability.Parcels,
      ResidentUnitCapability.Facilities,
      ResidentUnitCapability.Rules,
      ResidentUnitCapability.Contacts,
      ResidentUnitCapability.ServiceRequests,
      ResidentUnitCapability.Invoices,
    ],
    description:
      'Navigation for this unit (D-322): notices, parcels, facilities, rules, contacts and service requests for every role; `invoices` for co-owners, tenants, co-tenants and payers (bills addressed to me); `usage` and `access` only where I live (occupancy); `lease` only as a party of a lease in force on the unit. The tenant’s modules still gate the tiles (`/me` `entitlements`).',
  })
  capabilities!: ResidentUnitCapability[];

  @ApiProperty({
    type: [String],
    example: [],
    description: 'Leases in force on this unit that I am a party of.',
  })
  leaseIds!: string[];
}

export class ResidentMeUnitsDto {
  @ApiProperty({ type: () => [ResidentMeUnitDto] })
  units!: ResidentMeUnitDto[];

  @ApiProperty({
    example: '9f2c1a0e5b7d4c3a8e6f1b2d0c9a7e5f3b1d8c6a4e2f0b9d7c5a3e1f8b6d4c2a',
    description: 'sha256 of my unit roles today; changes whenever a role starts or ends.',
  })
  unitsHash!: string;

  @ApiProperty({
    example: false,
    description:
      'My access token’s `unit:` scopes differ from my units today (a new co-owner link, a move-in, an ownership that ended): refresh the token.',
  })
  refreshRequired!: boolean;
}

export class ResidentUnitUsageDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-01T00:00:00+07:00',
    description: 'Never before the start of my occupancy.',
  })
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

  @ApiProperty({ type: () => [UsageSummaryDto] })
  summary!: UsageSummaryDto[];
}

// ------------------------------------------------------------------------------------------------- invitations

export class UnitResidentInviteCreateDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    example: FAKE.uuid,
    description: 'A current co-owner of the unit (default: the only current co-owner).',
  })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiProperty({
    enum: ResidentInviteChannelName,
    enumName: 'ResidentInviteChannel',
    example: ResidentInviteChannelName.LineQr,
    description:
      '`line_qr`: the QR to show or print in a letter; `sms`: the link by SMS to the owner’s phone; `link`.',
  })
  @IsEnum(ResidentInviteChannelName)
  channel!: ResidentInviteChannelName;

  @ApiPropertyOptional({ example: 'th' })
  @IsOptional()
  @IsIn(['th', 'en'])
  language?: string;
}

export class UnitResidentInviteDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({
    enum: InvitationChannelName,
    enumName: 'InvitationChannel',
    example: InvitationChannelName.LineQr,
  })
  channel!: InvitationChannelName;

  @ApiProperty({
    enum: InvitationStateName,
    enumName: 'InvitationState',
    example: InvitationStateName.Pending,
  })
  state!: InvitationStateName;

  @ApiProperty({ format: 'date-time', example: '2026-11-19T10:00:00+07:00' })
  expiresAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  acceptedAt!: string | null;

  @ApiProperty({ format: 'date-time', example: FAKE.dateTime })
  createdAt!: string;
}

export class UnitResidentInviteCreatedDto extends UnitResidentInviteDto {
  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ example: 'ABCD-EFGH-JKLM-NPQR', description: 'Shown once; never stored in clear.' })
  code!: string;

  @ApiProperty({ example: 'https://liff.getproperty.invalid/link/unit?code=ABCD-EFGH-JKLM-NPQR' })
  url!: string;

  @ApiProperty({
    example: 'https://liff.getproperty.invalid/link/unit?code=ABCD-EFGH-JKLM-NPQR',
    description: 'What the QR encodes (render it yourself, e.g. in a printed letter).',
  })
  qrPayload!: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgo=',
    description: 'QR of the URL (PNG data URL).',
  })
  qrPngDataUrl!: string;
}

export class UnitInvitationPreviewDto {
  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({
    enum: PropertyKindName,
    enumName: 'PropertyKind',
    nullable: true,
    example: PropertyKindName.Condo,
    description:
      'What the place is (D-302): the app names the unit by it — ห้อง (condo / apartment), บ้าน (village), พื้นที่ (office / retail). null = not set.',
  })
  propertyKind!: PropertyKindName | null;

  @ApiProperty({
    enum: BuildingLegalFormName,
    enumName: 'BuildingLegalForm',
    nullable: true,
    example: BuildingLegalFormName.CondoAct,
    description:
      'The law the building’s juristic management runs under (D-302); null for rentals without one.',
  })
  legalForm!: BuildingLegalFormName | null;

  @ApiProperty({ example: 'สม••••••' })
  partyDisplayName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '+66•••••1234',
    description: 'Where the OTP will go: the phone of the co-owner in the register (masked).',
  })
  phoneMasked!: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-11-19T10:00:00+07:00' })
  expiresAt!: string;
}

export class UnitInvitationAcceptedDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({ example: true, description: 'Refresh the token to receive the unit’s `unit:` scope.' })
  refreshRequired!: boolean;

  @ApiProperty({ format: 'date', example: FAKE.date })
  acceptedOn!: string;
}

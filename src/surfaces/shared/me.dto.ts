import { FAKE } from '@common/openapi/examples';
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

import {
  AdminMenuKey,
  LeasePartyRoleName,
  LeaseStatusName,
  OccupancyRoleName,
  OwnerMenuKey,
  PlatformRoleName,
  ResidentEntitlement,
  StaffMenuKey,
} from './status.enums';

/** `core.user_account.language` values (th, en; residents also my, km, lo, zh — D-064). */
export enum UserLanguageName {
  Th = 'th',
  En = 'en',
  My = 'my',
  Km = 'km',
  Lo = 'lo',
  Zh = 'zh',
}

export enum TenantTypeName {
  Apartment = 'apartment',
  CondoJuristic = 'condo_juristic',
  PmCompany = 'pm_company',
  Landlord = 'landlord',
  Agency = 'agency',
}

export enum TenantStatusName {
  Active = 'active',
  ReadOnly = 'read_only',
  Deactivated = 'deactivated',
}

export enum TenantRoleName {
  Owner = 'owner',
  Manager = 'manager',
  Staff = 'staff',
  Accountant = 'accountant',
}

export enum SubscriptionStateName {
  Trial = 'trial',
  Active = 'active',
  PastDue = 'past_due',
  Suspended = 'suspended',
  Cancelled = 'cancelled',
}

export class MeUserDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  id!: string;

  @ApiProperty({ example: FAKE.nameTh })
  displayName!: string;

  @ApiProperty({ type: String, nullable: true, example: '+66810001234' })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true, example: FAKE.email })
  email!: string | null;

  @ApiProperty({
    enum: UserLanguageName,
    enumName: 'ResidentLanguage',
    example: UserLanguageName.Th,
    description: 'th | en (resident surface also my, km, lo, zh in R2, D-064)',
  })
  language!: UserLanguageName;

  @ApiProperty({ example: true, description: 'A LINE identity is linked.' })
  lineLinked!: boolean;
}

export class OperatorTenantDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  id!: string;

  @ApiProperty({ example: FAKE.propertyName })
  displayName!: string;

  @ApiProperty({ enum: TenantTypeName, enumName: 'TenantType', example: TenantTypeName.Apartment })
  type!: TenantTypeName;

  @ApiProperty({ enum: TenantStatusName, enumName: 'TenantStatus', example: TenantStatusName.Active })
  status!: TenantStatusName;

  @ApiProperty({ enum: TenantRoleName, enumName: 'TenantRole', example: TenantRoleName.Owner })
  role!: TenantRoleName;
}

export class CurrentTenantDto extends OperatorTenantDto {
  @ApiProperty({
    type: [String],
    nullable: true,
    example: null,
    description: 'null = every building; a list = Staff limited to these buildings (D-090).',
  })
  buildingIds!: string[] | null;
}

export class SubscriptionSummaryDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'apartment_starter',
    description: 'Price plan key (D-156).',
  })
  plan!: string | null;

  @ApiProperty({
    enum: SubscriptionStateName,
    enumName: 'SubscriptionState',
    nullable: true,
    example: null,
    description: 'From platform.subscription (B6.1, D-082); null before the platform subscribed the tenant.',
  })
  state!: SubscriptionStateName | null;

  @ApiProperty({ example: false, description: 'Suspended tenants are read-only (D-082).' })
  readOnly!: boolean;
}

export class OperatorMeDto {
  @ApiProperty({ type: () => MeUserDto })
  user!: MeUserDto;

  @ApiProperty({ example: true })
  hasPassword!: boolean;

  @ApiProperty({ example: false })
  totpEnabled!: boolean;

  @ApiProperty({ type: () => [OperatorTenantDto], description: 'Every tenant the operator belongs to.' })
  tenants!: OperatorTenantDto[];

  @ApiProperty({
    type: () => CurrentTenantDto,
    nullable: true,
    description:
      'The tenant of this request (single tenant or `X-Tenant-Id`); null when the operator must choose.',
  })
  currentTenant!: CurrentTenantDto | null;

  @ApiProperty({
    enum: TenantRoleName,
    enumName: 'TenantRole',
    isArray: true,
    example: [TenantRoleName.Owner],
  })
  roles!: TenantRoleName[];

  @ApiProperty({ type: [String], example: ['tenant.read', 'invoice.read'] })
  permissions!: string[];

  @ApiProperty({
    enum: OwnerMenuKey,
    enumName: 'OwnerMenuKey',
    isArray: true,
    example: [OwnerMenuKey.Dashboard, OwnerMenuKey.Buildings, OwnerMenuKey.Invoices],
    description: 'Menu entitlements of the owner console (keys of the web routes).',
  })
  menu!: OwnerMenuKey[];

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    example: { 'module.service_requests': false, 'channel.web_push': true },
  })
  featureFlags!: Record<string, boolean>;

  @ApiProperty({ type: () => SubscriptionSummaryDto, nullable: true })
  subscription!: SubscriptionSummaryDto | null;

  @ApiProperty({ type: [String], example: [`tenant:${FAKE.tenantId}`] })
  scopes!: string[];
}

/** `GET /v1/staff/me`: the operator view with the staff PWA's menu keys. */
export class StaffMeDto extends OmitType(OperatorMeDto, ['menu'] as const) {
  @ApiProperty({
    enum: StaffMenuKey,
    enumName: 'StaffMenuKey',
    isArray: true,
    example: [StaffMenuKey.Readings, StaffMenuKey.ReadingRounds, StaffMenuKey.Installs],
    description: 'Menu entitlements of the staff PWA.',
  })
  menu!: StaffMenuKey[];
}

export class ResidentUnitDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  unitId!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.buildingId })
  buildingId!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({
    enum: OccupancyRoleName,
    enumName: 'OccupancyRole',
    example: OccupancyRoleName.Tenant,
    description: 'Occupancy role (tenant = lessee, co_tenant, owner_occupier, family, staff).',
  })
  role!: OccupancyRoleName;

  @ApiProperty({ format: 'date', example: FAKE.date })
  validFrom!: string;
}

export class ResidentConsentStateDto {
  @ApiProperty({ example: 'resident.service' })
  purposeKey!: string;

  @ApiProperty({ example: true })
  required!: boolean;

  @ApiProperty({ type: 'integer', example: 1 })
  version!: number;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    example: true,
    description: 'null = never answered this version.',
  })
  granted!: boolean | null;
}

export class ResidentLeaseSummaryDto {
  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'CTR-2026-00001' })
  number!: string | null;

  @ApiProperty({ enum: LeaseStatusName, enumName: 'LeaseStatus', example: LeaseStatusName.Active })
  status!: LeaseStatusName;

  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ example: FAKE.propertyName })
  tenantName!: string;

  @ApiProperty({ example: FAKE.unitCode })
  unitNo!: string;

  @ApiProperty({ example: 'อาคาร A' })
  buildingName!: string;

  @ApiProperty({
    enum: LeasePartyRoleName,
    enumName: 'LeasePartyRole',
    example: LeasePartyRoleName.Lessee,
    description: 'My role on the lease.',
  })
  role!: LeasePartyRoleName;

  @ApiProperty({
    format: 'date',
    example: '2026-11-01',
    description: 'First day of the lease term (LIFF #21).',
  })
  startDate!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2027-10-31',
    description: 'Last day of the term; null for an open-ended lease.',
  })
  endDate!: string | null;
}

export class ResidentMeDto {
  @ApiProperty({ type: () => MeUserDto })
  user!: MeUserDto;

  @ApiProperty({ type: () => [ResidentUnitDto] })
  units!: ResidentUnitDto[];

  @ApiProperty({ type: [String], example: [FAKE.uuid], description: 'Leases I can open (B2.3).' })
  leaseIds!: string[];

  @ApiProperty({ type: () => [ResidentLeaseSummaryDto], description: 'My leases in every tenant (D-061).' })
  leases!: ResidentLeaseSummaryDto[];

  @ApiProperty({ type: () => [ResidentConsentStateDto] })
  consents!: ResidentConsentStateDto[];

  @ApiProperty({ example: true, description: 'Every required consent purpose is granted (D-025).' })
  consentComplete!: boolean;

  @ApiProperty({
    enum: ResidentEntitlement,
    enumName: 'ResidentEntitlement',
    isArray: true,
    example: [ResidentEntitlement.Bills, ResidentEntitlement.Usage, ResidentEntitlement.Lease],
    description:
      'Bottom navigation and home tiles (D-063): `bills` and `lease` with a lease, `usage` where an IoT meter serves one of my units, `service_requests` / `announcements` / `parcels` where the tenant has the module (feature flags).',
  })
  entitlements!: ResidentEntitlement[];

  @ApiProperty({ type: [String], example: ['unit:3b241101-e2bb-4255-8caf-4136c566a962'] })
  scopes!: string[];

  @ApiProperty({
    type: 'integer',
    example: 0,
    description:
      'Parties matched by my SMS-verified phone that wait for their landlord’s confirmation before I see them (D-226): show “waiting for your landlord to confirm” or offer the invitation code (D-175).',
  })
  linkRequestsPending!: number;
}

export class ResidentMeUpdateDto {
  @ApiProperty({
    enum: UserLanguageName,
    enumName: 'ResidentLanguage',
    example: UserLanguageName.Th,
    description: 'Language of LINE messages and documents for me (D-064).',
  })
  @IsEnum(UserLanguageName)
  language!: UserLanguageName;
}

export class ResidentLinkDto {
  @ApiProperty({
    example: 'ABCD-EFGH-JKLM-NPQR',
    description: 'The invitation code from the invite QR / SMS deep link (`liff.state=/link?code=…`).',
  })
  @IsString()
  @Length(8, 40)
  code!: string;

  @ApiPropertyOptional({
    enum: ['line_qr', 'sms', 'link'],
    enumName: 'LeaseInvitationChannel',
    example: 'line_qr',
    description: 'How the code reached me (analytics only).',
  })
  @IsOptional()
  @IsIn(['line_qr', 'sms', 'link'])
  via?: 'line_qr' | 'sms' | 'link';
}

export class ResidentLinkedDto {
  @ApiProperty({ format: 'uuid', example: FAKE.tenantId })
  tenantId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  leaseId!: string;

  @ApiProperty({ format: 'uuid', example: FAKE.uuid })
  partyId!: string;

  @ApiProperty({
    type: () => [ResidentUnitDto],
    description: 'The units I now occupy (empty until the lease starts).',
  })
  units!: ResidentUnitDto[];

  @ApiProperty({
    example: true,
    description: 'Refresh the token to receive the new `lease:`/`unit:` scopes (the BFF rotates on refresh).',
  })
  refreshRequired!: boolean;
}

export class TechnicianMeDto {
  @ApiProperty({ type: () => MeUserDto })
  user!: MeUserDto;

  @ApiProperty({
    type: [String],
    example: [],
    description: 'Work order ids my token covers (B5.1, `work_order:<uuid>`).',
  })
  workOrderIds!: string[];

  @ApiProperty({ type: [String], example: [] })
  scopes!: string[];

  @ApiProperty({
    type: 'integer',
    example: 0,
    description:
      'Parties matched by my SMS-verified phone that wait for their landlord’s confirmation before their work orders reach me (D-226, LIFF #29): with no work orders and a count above 0 show “waiting for the office to confirm you”, not “no work assigned yet”.',
  })
  linkRequestsPending!: number;
}

/** `GET /v1/prospect/me` (B7.3, D-252). */
export class ProspectMeDto {
  @ApiProperty({ type: () => MeUserDto })
  user!: MeUserDto;

  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'My enquiries that are still open (not won or lost).',
  })
  openEnquiries!: number;

  @ApiProperty({
    type: 'integer',
    example: 1,
    description: 'My viewings still to come (requested or confirmed, start in the future).',
  })
  upcomingViewings!: number;
}

export class AdminMeDto {
  @ApiProperty({ type: () => MeUserDto })
  user!: MeUserDto;

  @ApiProperty({
    enum: PlatformRoleName,
    enumName: 'PlatformRole',
    isArray: true,
    example: [PlatformRoleName.PlatformAdmin],
  })
  roles!: PlatformRoleName[];

  @ApiProperty({ type: [String], example: ['admin.tenant.read'] })
  permissions!: string[];

  @ApiProperty({
    enum: AdminMenuKey,
    enumName: 'AdminMenuKey',
    isArray: true,
    example: [AdminMenuKey.Tenants, AdminMenuKey.UtilityTariffs],
  })
  menu!: AdminMenuKey[];

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    example: { 'channel.web_push': true },
  })
  featureFlags!: Record<string, boolean>;

  @ApiProperty({ example: true })
  totpEnabled!: boolean;
}

export class SetPasswordDto {
  @ApiPropertyOptional({ example: FAKE.email, description: 'Required when the account has no email yet.' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: 'correct horse battery staple', description: '12–128 characters.' })
  @IsString()
  @Length(1, 200)
  password!: string;
}

export class TotpCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

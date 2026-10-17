import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { assertIfMatch, etagOf } from '@common/etag/etag';
import { IfMatch, UseEtag } from '@common/etag/etag.interceptor';
import {
  ApiConcurrency,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { maskPhone } from '@core/identity/phone';
import { InvitationService } from '@core/tenancy/invitation.service';
import { MembershipService } from '@core/tenancy/membership.service';
import { TenantService } from '@core/tenancy/tenant.service';
import { type Invitation, type Tenant } from '@generated/prisma/client';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso, isoOrNull } from '../shared/mappers';
import { type TenantRoleName, type TenantStatusName, type TenantTypeName } from '../shared/me.dto';
import { invitationActions } from '../shared/next-actions';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type AddressDto,
  type InvitationChannelName,
  InvitationCreatedDto,
  InvitationCreateDto,
  InvitationDto,
  type InvitationStateName,
  MemberDto,
  type MembershipStatusName,
  MemberUpdateDto,
  type TenantLegalFormName,
  TenantProfileDto,
  TenantUpdateDto,
} from './tenancy.dto';

export function tenantProfileDto(t: Tenant): TenantProfileDto {
  const address = t.address as unknown as AddressDto | null;
  return {
    id: t.id,
    type: t.type as TenantTypeName,
    slug: t.slug,
    displayName: t.displayName,
    legalName: t.legalName,
    legalForm: t.legalForm as TenantLegalFormName,
    taxId: t.taxId,
    vatRegistered: t.vatRegistered,
    address: address && Object.keys(address).length ? address : null,
    logoDocumentId: t.logoDocumentId,
    defaultLanguage: t.defaultLanguage,
    status: t.status as TenantStatusName,
    plan: t.plan,
    version: t.version,
  };
}

export function invitationDto(i: Invitation): InvitationDto {
  return {
    nextActions: invitationActions(i.state, i.expiresAt, new Date()),
    id: i.id,
    role: i.role as TenantRoleName,
    buildingIds: i.buildingIds,
    phoneMasked: i.phoneE164 ? maskPhone(i.phoneE164) : null,
    email: i.email,
    channel: i.channel as InvitationChannelName,
    state: i.state as InvitationStateName,
    expiresAt: iso(i.expiresAt),
    acceptedAt: isoOrNull(i.acceptedAt),
    createdAt: iso(i.createdAt),
  };
}

export const TENANT_EXAMPLE: TenantProfileDto = {
  id: FAKE.tenantId,
  type: 'apartment' as TenantTypeName,
  slug: 'sample-dormitory',
  displayName: FAKE.propertyName,
  legalName: FAKE.companyName,
  legalForm: 'company' as TenantLegalFormName,
  taxId: FAKE.taxId,
  vatRegistered: false,
  address: { line1: FAKE.addressLine, province: 'กรุงเทพมหานคร', postcode: FAKE.postcode, country: 'TH' },
  logoDocumentId: null,
  defaultLanguage: 'th',
  status: 'active' as TenantStatusName,
  plan: 'apartment_starter',
  version: 3,
};

export const MEMBER_EXAMPLE: MemberDto = {
  id: FAKE.uuid,
  userId: FAKE.uuid,
  displayName: FAKE.nameTh,
  phone: '+66810001234',
  email: null,
  role: 'staff' as TenantRoleName,
  status: 'active' as MembershipStatusName,
  buildingIds: [FAKE.buildingId],
  joinedAt: FAKE.dateTime,
};

export const INVITATION_EXAMPLE: InvitationDto = {
  nextActions: ['revoke'],
  id: FAKE.uuid,
  role: 'staff' as TenantRoleName,
  buildingIds: [],
  phoneMasked: '+66•••••1234',
  email: null,
  channel: 'sms' as InvitationChannelName,
  state: 'pending' as InvitationStateName,
  expiresAt: '2026-11-08T00:15:00+07:00',
  acceptedAt: null,
  createdAt: FAKE.dateTime,
};

type MemberRow = Awaited<ReturnType<MembershipService['list']>>[number];

export function memberDto(m: MemberRow): MemberDto {
  return {
    id: m.id,
    userId: m.userId,
    displayName: m.user.displayName,
    phone: m.user.phoneE164,
    email: m.user.email,
    role: m.role as TenantRoleName,
    status: m.status as MembershipStatusName,
    buildingIds: ((m.moduleScopes ?? {}) as { buildingIds?: string[] }).buildingIds ?? null,
    joinedAt: isoOrNull(m.joinedAt),
  };
}

const TENANT_ERRORS = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

@ApiTags('owner.tenant')
@ApiSurface(SURFACES.owner)
@Controller('owner/tenant')
export class OwnerTenantController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.read')
  @UseEtag((t: TenantProfileDto) => etagOf(t.id, t.version))
  @ApiEndpoint({
    id: 'owner.tenant.get',
    summary: 'Company data of my tenant',
    description:
      'The tenant (SaaS customer, D-151) with its type and company data used on documents: legal name, tax id, address, VAT flag, logo (D-050).',
    implements: ['D-050', 'D-150', 'D-151'],
  })
  @ApiSuccess(200, { description: 'The tenant', type: TenantProfileDto, example: TENANT_EXAMPLE })
  @ApiStandardErrors(...TENANT_ERRORS)
  async get(@CurrentTenant() ctx: TenantContext): Promise<TenantProfileDto> {
    return tenantProfileDto(await this.tenants.get(ctx));
  }

  @Patch()
  @TenantScoped()
  @Can('tenant.update')
  @UseEtag((t: TenantProfileDto) => etagOf(t.id, t.version))
  @ApiConcurrency()
  @ApiEndpoint({
    id: 'owner.tenant.update',
    summary: 'Update the company data of my tenant',
    description:
      'Owner only (D-090). Requires `If-Match`; audited (`tenant.updated`) with before/after values.',
    implements: ['D-050', 'D-090', 'D-151'],
  })
  @ApiJsonBody(TenantUpdateDto, { legalName: FAKE.companyName, taxId: FAKE.taxId, vatRegistered: false })
  @ApiSuccess(200, { description: 'Updated', type: TenantProfileDto, example: TENANT_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async update(
    @CurrentTenant() ctx: TenantContext,
    @IfMatch() ifMatch: string | undefined,
    @Body() body: TenantUpdateDto,
  ): Promise<TenantProfileDto> {
    const current = await this.tenants.get(ctx);
    assertIfMatch(ifMatch, etagOf(current.id, current.version));
    return tenantProfileDto(
      await this.tenants.update(ctx, current.version, {
        ...body,
        address: body.address as never,
      }),
    );
  }
}

@ApiTags('owner.members')
@ApiSurface(SURFACES.owner)
@Controller('owner/members')
export class OwnerMembersController {
  constructor(private readonly members: MembershipService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.member.read')
  @ApiEndpoint({
    id: 'owner.members.list',
    summary: 'People working for my tenant',
    description: 'Active and suspended memberships with role and building limits (D-090).',
    implements: ['D-090', 'D-151'],
  })
  @ApiSuccess(200, { description: 'Members', type: [MemberDto], example: [MEMBER_EXAMPLE] })
  @ApiStandardErrors(...TENANT_ERRORS)
  async list(@CurrentTenant() ctx: TenantContext): Promise<MemberDto[]> {
    return (await this.members.list(ctx)).map(memberDto);
  }

  @Patch(':membershipId')
  @TenantScoped()
  @Can('tenant.member.manage')
  @ApiEndpoint({
    id: 'owner.members.update',
    summary: 'Change a member’s role, buildings or status',
    description:
      'Owner only (D-090). Only an Owner grants or removes the Owner role; the tenant keeps at least one active Owner (409 `membership.last_owner`). Takes effect at once (cached access dropped).',
    implements: ['D-090'],
  })
  @ApiJsonBody(MemberUpdateDto, { role: 'staff', buildingIds: [FAKE.buildingId] })
  @ApiSuccess(200, { description: 'Updated', type: MemberDto, example: MEMBER_EXAMPLE })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'membership.last_owner',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param('membershipId', ParseUUIDPipe) id: string,
    @Body() body: MemberUpdateDto,
  ): Promise<MemberDto> {
    const m = await this.members.update(ctx, id, body);
    const all = await this.members.list(ctx);
    const full = all.find((x) => x.id === m.id)!;
    return {
      id: full.id,
      userId: full.userId,
      displayName: full.user.displayName,
      phone: full.user.phoneE164,
      email: full.user.email,
      role: full.role as TenantRoleName,
      status: full.status as MembershipStatusName,
      buildingIds: ((full.moduleScopes ?? {}) as { buildingIds?: string[] }).buildingIds ?? null,
      joinedAt: isoOrNull(full.joinedAt),
    };
  }

  @Delete(':membershipId')
  @HttpCode(204)
  @TenantScoped()
  @Can('tenant.member.manage')
  @ApiEndpoint({
    id: 'owner.members.remove',
    summary: 'Remove a member',
    description:
      'Ends the membership (soft delete, audited); the person loses access to this tenant at once. The last Owner cannot be removed.',
    implements: ['D-090'],
  })
  @ApiSuccess(204, { description: 'Removed' })
  @ApiStandardErrors(
    'http.not_found',
    'membership.last_owner',
    'validation.failed',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('membershipId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.members.remove(ctx, id, null);
  }
}

@ApiTags('owner.invitations')
@ApiSurface(SURFACES.owner)
@Controller('owner/invitations')
export class OwnerInvitationsController {
  constructor(private readonly invitations: InvitationService) {}

  @Get()
  @TenantScoped()
  @Can('tenant.member.read')
  @ApiEndpoint({
    id: 'owner.invitations.list',
    summary: 'Member invitations of my tenant',
    description:
      'Pending, accepted, expired and revoked member invitations (D-145). Codes are never shown again.',
    implements: ['D-145'],
  })
  @ApiSuccess(200, { description: 'Invitations', type: [InvitationDto], example: [INVITATION_EXAMPLE] })
  @ApiStandardErrors(...TENANT_ERRORS)
  async list(@CurrentTenant() ctx: TenantContext): Promise<InvitationDto[]> {
    return (await this.invitations.list(ctx)).map(invitationDto);
  }

  @Post()
  @TenantScoped()
  @Can('tenant.member.invite')
  @ApiEndpoint({
    id: 'owner.invitations.create',
    summary: 'Invite a person to my tenant',
    description:
      'Creates a one-time invitation (role, optional building limits) valid `invitation.expiry_days`; `sms` sends the link to the phone, `link`/`line_qr` return it once for a QR (D-061, D-145). The invitee signs in by SMS OTP with the code. Only an Owner invites an Owner.',
    implements: ['D-061', 'D-090', 'D-145'],
  })
  @ApiJsonBody(InvitationCreateDto, {
    role: 'staff',
    phone: '+66810001234',
    channel: 'sms',
    buildingIds: [FAKE.buildingId],
  })
  @ApiSuccess(201, {
    description: 'Invitation created',
    type: InvitationCreatedDto,
    example: {
      ...INVITATION_EXAMPLE,
      code: 'ABCD-EFGH-JKLM-NPQR',
      inviteUrl: 'https://app.getproperty.invalid/join?code=ABCD-EFGH-JKLM-NPQR',
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'http.not_found',
    'membership.already_member',
    'provider.unavailable',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async create(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: InvitationCreateDto,
  ): Promise<InvitationCreatedDto> {
    const r = await this.invitations.create(ctx, body);
    return { ...invitationDto(r.invitation), code: r.code, inviteUrl: r.inviteUrl };
  }

  @Post(':invitationId/actions/revoke')
  @HttpCode(200)
  @TenantScoped()
  @Can('tenant.member.invite')
  @ApiEndpoint({
    id: 'owner.invitations.revoke',
    summary: 'Revoke a pending invitation',
    description: 'The code stops working at once (audited).',
    implements: ['D-145'],
  })
  @ApiSuccess(200, {
    description: 'Revoked',
    type: InvitationDto,
    example: { ...INVITATION_EXAMPLE, state: 'revoked' },
  })
  @ApiStandardErrors(
    'http.not_found',
    'invitation.not_pending',
    'validation.failed',
    'tenant.read_only',
    ...TENANT_ERRORS,
  )
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('invitationId', ParseUUIDPipe) id: string,
  ): Promise<InvitationDto> {
    return invitationDto(await this.invitations.revoke(ctx, id));
  }
}

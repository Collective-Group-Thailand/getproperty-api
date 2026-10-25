import { TenantOptional, TenantScoped } from '@common/auth/auth.decorators';
import { RequestContext } from '@common/context/request-context';
import { AcceptLanguage, resolveLanguage } from '@common/i18n/language';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { AuthService } from '@core/identity/auth.service';
import { Body, Controller, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import { TotpSecretDto } from './auth.dto';
import {
  AdminMeDto,
  OperatorMeDto,
  ProspectMeDto,
  ResidentLinkDto,
  ResidentLinkedDto,
  ResidentMeDto,
  ResidentMeUpdateDto,
  SetPasswordDto,
  StaffMeDto,
  TechnicianMeDto,
  TotpCodeDto,
} from './me.dto';
import { MeService } from './me.service';

const OPERATOR_ME_EXAMPLE: OperatorMeDto = {
  user: {
    id: FAKE.uuid,
    displayName: FAKE.nameTh,
    phone: '+66810001234',
    email: FAKE.email,
    language: 'th' as never,
    lineLinked: false,
  },
  hasPassword: false,
  totpEnabled: false,
  tenants: [
    {
      id: FAKE.tenantId,
      displayName: FAKE.propertyName,
      type: 'apartment' as never,
      status: 'active' as never,
      role: 'owner' as never,
    },
  ],
  currentTenant: {
    id: FAKE.tenantId,
    displayName: FAKE.propertyName,
    type: 'apartment' as never,
    status: 'active' as never,
    role: 'owner' as never,
    buildingIds: null,
  },
  roles: ['owner' as never],
  permissions: ['invoice.read', 'tenant.read'],
  menu: ['dashboard', 'buildings', 'invoices'] as never[],
  featureFlags: { 'channel.web_push': true, 'module.service_requests': false },
  subscription: { plan: 'apartment_starter', state: null, readOnly: false },
  scopes: [`tenant:${FAKE.tenantId}`],
};

const RESIDENT_ME_EXAMPLE: ResidentMeDto = {
  user: {
    id: FAKE.uuid,
    displayName: FAKE.nameTh,
    phone: '+66810001234',
    email: null,
    language: 'th' as never,
    lineLinked: true,
  },
  units: [
    {
      unitId: FAKE.uuid,
      unitNo: FAKE.unitCode,
      buildingId: FAKE.buildingId,
      buildingName: 'อาคาร A',
      tenantId: FAKE.tenantId,
      tenantName: FAKE.propertyName,
      role: 'tenant' as never,
      validFrom: FAKE.date,
    },
  ],
  leaseIds: [FAKE.uuid],
  leases: [
    {
      leaseId: FAKE.uuid,
      number: 'CTR-2026-00001',
      status: 'active' as never,
      tenantId: FAKE.tenantId,
      tenantName: FAKE.propertyName,
      unitNo: FAKE.unitCode,
      buildingName: 'อาคาร A',
      role: 'lessee' as never,
      startDate: '2026-11-01',
      endDate: '2027-10-31',
    },
  ],
  consents: [{ purposeKey: 'resident.service', required: true, version: 1, granted: true }],
  consentComplete: true,
  entitlements: ['bills', 'usage', 'lease'] as never[],
  scopes: [`unit:${FAKE.uuid}`],
  linkRequestsPending: 0,
};

const ME_ERRORS = ['tenant.context_invalid', 'tenant.not_in_scope'] as const;

@ApiTags('owner.me')
@ApiSurface(SURFACES.owner)
@Controller('owner/me')
export class OwnerMeController {
  constructor(
    private readonly me: MeService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.me.get',
    summary: 'Who I am in the owner console',
    description:
      'The operator, every tenant they belong to, the current tenant (single tenant or `X-Tenant-Id`; null when they must choose) with its type, role, building limits, permissions, menu entitlements, feature flags and subscription state (D-090, D-150, D-156).',
    implements: ['D-090', 'D-150', 'D-151', 'ADR-0003'],
  })
  @ApiSuccess(200, {
    description: 'The signed-in operator',
    type: OperatorMeDto,
    example: OPERATOR_ME_EXAMPLE,
  })
  @ApiStandardErrors(...ME_ERRORS)
  get(): Promise<OperatorMeDto> {
    return this.me.operator('owner');
  }

  @Put('password')
  @HttpCode(204)
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.me.setPassword',
    summary: 'Set my email and password',
    description:
      'Operators may add email + password sign-in to the SMS OTP (contract §4); passwords are argon2id, 12–128 characters. Every other sign-in of the account ends.',
    implements: ['D-090', 'ADR-0003'],
  })
  @ApiJsonBody(SetPasswordDto, { email: 'test@example.com', password: 'correct horse battery staple' })
  @ApiSuccess(204, { description: 'Password set' })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'auth.weak_password',
    'http.conflict',
    ...ME_ERRORS,
  )
  async setPassword(@Body() body: SetPasswordDto): Promise<void> {
    const actor = RequestContext.actor();
    if (actor?.type !== 'user') return;
    await this.auth.operatorSetPassword(actor.publicId, actor.sessionId, body);
  }

  @Post('totp/setup')
  @HttpCode(200)
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.me.setupTotp',
    summary: 'Start authenticator (TOTP) set-up',
    description:
      'Owners who want it add TOTP to password sign-in (contract §4): a new secret, enabled by the first correct code.',
    implements: ['ADR-0003'],
  })
  @ApiSuccess(200, {
    description: 'Secret',
    type: TotpSecretDto,
    example: {
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUri:
        'otpauth://totp/getproperty:test%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=getproperty&algorithm=SHA1&digits=6&period=30',
    },
  })
  @ApiStandardErrors('auth.invalid_credentials', ...ME_ERRORS)
  setupTotp(): Promise<TotpSecretDto> {
    const actor = RequestContext.actor();
    return this.auth.operatorTotpSetup(actor?.type === 'user' ? actor.publicId : '');
  }

  @Post('totp/enable')
  @HttpCode(204)
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.me.enableTotp',
    summary: 'Enable my authenticator',
    description: 'Confirms the first code; password sign-in then requires a TOTP code.',
    implements: ['ADR-0003'],
  })
  @ApiJsonBody(TotpCodeDto, { code: '123456' })
  @ApiSuccess(204, { description: 'Enabled' })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'auth.totp_invalid', ...ME_ERRORS)
  async enableTotp(@Body() body: TotpCodeDto): Promise<void> {
    const actor = RequestContext.actor();
    await this.auth.operatorTotpEnable(actor?.type === 'user' ? actor.publicId : '', body.code);
  }
}

@ApiTags('staff.me')
@ApiSurface(SURFACES.staff)
@Controller('staff/me')
export class StaffMeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @TenantOptional()
  @TenantScoped()
  @ApiEndpoint({
    id: 'staff.me.get',
    summary: 'Who I am in the staff PWA',
    description:
      'Same shape as `owner.me.get`, with the staff PWA menu (readings, inspections, installs; service requests and parcels behind flags) and the building limits of a Staff member (D-090).',
    implements: ['D-090', 'D-151', 'ADR-0003'],
  })
  @ApiSuccess(200, {
    description: 'The signed-in operator',
    type: StaffMeDto,
    example: {
      ...OPERATOR_ME_EXAMPLE,
      roles: ['staff' as never],
      menu: ['readings', 'reading_rounds', 'inspections', 'installs'] as never[],
    } satisfies StaffMeDto,
  })
  @ApiStandardErrors(...ME_ERRORS)
  get(): Promise<StaffMeDto> {
    return this.me.operator('staff') as unknown as Promise<StaffMeDto>;
  }
}

@ApiTags('resident.me')
@ApiSurface(SURFACES.resident)
@Controller('resident/me')
export class ResidentMeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.me.get',
    summary: 'Who I am in the resident app',
    description:
      'The resident, the units of their current occupancies in every tenant (and leases from B2.3), their language and the state of the consent purposes (D-025: the LIFF asks for missing required consents on first use).',
    implements: ['D-025', 'D-061', 'D-063', 'D-154'],
  })
  @ApiSuccess(200, {
    description: 'The signed-in resident',
    type: ResidentMeDto,
    example: RESIDENT_ME_EXAMPLE,
  })
  @ApiStandardErrors('http.not_found')
  get(): Promise<ResidentMeDto> {
    return this.me.resident();
  }

  @Patch()
  @ApiEndpoint({
    id: 'resident.me.update',
    summary: 'Change my language',
    description:
      'The language of my LINE messages and documents (th, en; my, km, lo, zh in R2 — D-064). Returns my updated profile.',
    implements: ['D-064', 'D-154'],
  })
  @ApiJsonBody(ResidentMeUpdateDto, { language: 'en' })
  @ApiSuccess(200, { description: 'Updated', type: ResidentMeDto, example: RESIDENT_ME_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found')
  async update(@Body() body: ResidentMeUpdateDto): Promise<ResidentMeDto> {
    await this.me.setResidentLanguage(body.language);
    return this.me.resident();
  }
}

@ApiTags('resident.link')
@ApiSurface(SURFACES.resident)
@Controller('resident/link')
export class ResidentLinkController {
  constructor(private readonly me: MeService) {}

  @Post()
  @HttpCode(200)
  @Idempotent({ optional: true })
  @ApiEndpoint({
    id: 'resident.link.create',
    summary: 'Link me with an invitation code',
    description:
      'Accepts the operator’s single-use invitation code from the invite QR / SMS deep link (`liff.state=/link?code=…`) and links my login to the invited party (D-061). The required PDPA consents must be granted first (409 `consent.required`, D-025). Returns the units I now occupy; refresh the token to receive the new scopes (`refreshRequired`).',
    implements: ['D-025', 'D-061'],
  })
  @ApiJsonBody(ResidentLinkDto, { code: 'ABCD-EFGH-JKLM-NPQR' })
  @ApiSuccess(200, {
    description: 'Linked',
    type: ResidentLinkedDto,
    example: {
      tenantId: FAKE.tenantId,
      leaseId: FAKE.uuid,
      partyId: FAKE.uuid,
      units: [],
      refreshRequired: true,
    } satisfies ResidentLinkedDto,
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'invitation.not_found',
    'invitation.not_pending',
    'invitation.party_mismatch',
    'consent.required',
  )
  link(@Body() body: ResidentLinkDto, @AcceptLanguage() acceptLanguage?: string): Promise<ResidentLinkedDto> {
    return this.me.residentLink(body.code, resolveLanguage(acceptLanguage));
  }
}

@ApiTags('technician.me')
@ApiSurface(SURFACES.technician)
@Controller('technician/me')
export class TechnicianMeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiEndpoint({
    id: 'technician.me.get',
    summary: 'Who I am in the technician app',
    description:
      'The technician and the work orders their token covers (`work_order:<uuid>`, B5.1); details in `GET /v1/technician/work-orders`. `linkRequestsPending` counts the SMS-matched parties still waiting for the office to confirm me (D-226).',
    implements: ['D-072', 'D-154', 'D-226'],
  })
  @ApiSuccess(200, {
    description: 'The signed-in technician',
    type: TechnicianMeDto,
    example: {
      user: {
        id: FAKE.uuid,
        displayName: FAKE.name,
        phone: null,
        email: null,
        language: 'th' as never,
        lineLinked: true,
      },
      workOrderIds: [],
      scopes: [],
      linkRequestsPending: 0,
    } satisfies TechnicianMeDto,
  })
  @ApiStandardErrors('http.not_found')
  get(): Promise<TechnicianMeDto> {
    return this.me.technician();
  }
}

@ApiTags('prospect.me')
@ApiSurface(SURFACES.prospect)
@Controller('prospect/me')
export class ProspectMeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiEndpoint({
    id: 'prospect.me.get',
    summary: 'Who I am as a prospect',
    description:
      'The signed-in prospect, with how many of my enquiries are open and how many viewings are still to come (B7.3, D-252).',
    implements: ['D-252'],
  })
  @ApiSuccess(200, {
    description: 'The signed-in prospect',
    type: ProspectMeDto,
    example: {
      user: {
        id: FAKE.uuid,
        displayName: FAKE.name,
        phone: null,
        email: null,
        language: 'th' as never,
        lineLinked: true,
      },
      openEnquiries: 1,
      upcomingViewings: 1,
    } satisfies ProspectMeDto,
  })
  @ApiStandardErrors('http.not_found')
  get(): Promise<ProspectMeDto> {
    return this.me.prospect();
  }
}

@ApiTags('admin.me')
@ApiSurface(SURFACES.admin)
@Controller('admin/me')
export class AdminMeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiEndpoint({
    id: 'admin.me.get',
    summary: 'Who I am in the platform admin',
    description:
      'The platform user, their platform roles (D-090), permissions, admin menu entitlements and platform feature flags.',
    implements: ['D-090', 'D-161'],
  })
  @ApiSuccess(200, {
    description: 'The signed-in platform user',
    type: AdminMeDto,
    example: {
      user: {
        id: FAKE.uuid,
        displayName: FAKE.name,
        phone: null,
        email: FAKE.email,
        language: 'th' as never,
        lineLinked: false,
      },
      roles: ['platform_admin' as never],
      permissions: ['admin.tenant.read', 'admin.tenant.manage'],
      menu: ['tenants', 'utility_tariffs'] as never[],
      featureFlags: { 'channel.web_push': true },
      totpEnabled: true,
    } satisfies AdminMeDto,
  })
  @ApiStandardErrors('http.not_found')
  get(): Promise<AdminMeDto> {
    return this.me.admin();
  }
}

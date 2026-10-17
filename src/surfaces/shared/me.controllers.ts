import { TenantOptional, TenantScoped } from '@common/auth/auth.decorators';
import { RequestContext } from '@common/context/request-context';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { AuthService } from '@core/identity/auth.service';
import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiSurface, SURFACES } from '../surfaces';
import { TotpSecretDto } from './auth.dto';
import {
  AdminMeDto,
  OperatorMeDto,
  ResidentMeDto,
  SetPasswordDto,
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
    language: 'th',
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
  roles: ['owner'],
  permissions: ['invoice.read', 'tenant.read'],
  menu: ['dashboard', 'buildings', 'invoices'],
  featureFlags: { 'channel.web_push': true, 'module.service_requests': false },
  subscription: { plan: 'apartment_starter', state: null, readOnly: false },
  scopes: [`tenant:${FAKE.tenantId}`],
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
    type: OperatorMeDto,
    example: { ...OPERATOR_ME_EXAMPLE, roles: ['staff'], menu: ['readings', 'inspections'] },
  })
  @ApiStandardErrors(...ME_ERRORS)
  get(): Promise<OperatorMeDto> {
    return this.me.operator('staff');
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
    example: {
      user: {
        id: FAKE.uuid,
        displayName: FAKE.nameTh,
        phone: '+66810001234',
        email: null,
        language: 'th',
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
          role: 'tenant',
          validFrom: FAKE.date,
        },
      ],
      leaseIds: [FAKE.uuid],
      leases: [
        {
          leaseId: FAKE.uuid,
          number: 'CTR-2026-00001',
          status: 'active',
          tenantId: FAKE.tenantId,
          tenantName: FAKE.propertyName,
          unitNo: FAKE.unitCode,
          buildingName: 'อาคาร A',
          role: 'lessee',
        },
      ],
      consents: [{ purposeKey: 'resident.service', required: true, version: 1, granted: true }],
      consentComplete: true,
      scopes: [`unit:${FAKE.uuid}`],
    } satisfies ResidentMeDto,
  })
  @ApiStandardErrors('http.not_found')
  get(): Promise<ResidentMeDto> {
    return this.me.resident();
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
      'The technician and the work orders their token covers (`work_order:<uuid>`; work orders arrive in B5, R2).',
    implements: ['D-072', 'D-154'],
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
        language: 'th',
        lineLinked: true,
      },
      workOrderIds: [],
      scopes: [],
    } satisfies TechnicianMeDto,
  })
  @ApiStandardErrors('http.not_found')
  get(): Promise<TechnicianMeDto> {
    return this.me.technician();
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
        language: 'th',
        lineLinked: false,
      },
      roles: ['platform_admin'],
      permissions: ['admin.tenant.read', 'admin.tenant.manage'],
      menu: ['tenants', 'utility_tariffs'],
      featureFlags: { 'channel.web_push': true },
      totpEnabled: true,
    } satisfies AdminMeDto,
  })
  @ApiStandardErrors('http.not_found')
  get(): Promise<AdminMeDto> {
    return this.me.admin();
  }
}

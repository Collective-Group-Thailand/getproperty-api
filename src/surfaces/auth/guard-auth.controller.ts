import { Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { toBangkokIso } from '@common/time/bangkok';
import { GuardAuthService } from '@modules/smart-gate/guard-auth.service';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';

import { TOKEN_PAIR_EXAMPLE, TokenAudience, TokenPairDto } from '../shared/auth.dto';
import {
  GuardDeviceAuthDto,
  GuardEnrolDto,
  GuardEnrolledDto,
  GuardRosterDto,
  GuardSignInDto,
} from '../shared/gate.dto';
import { AUTH_RATE_LIMIT, tokenPairDto } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

const LIMIT = { default: { limit: AUTH_RATE_LIMIT, ttl: seconds(60) } };

/**
 * Gate tablets and guard sign-in (J4.1, D-320, D-327): a tablet enrols once with the owner's one-time code and keeps
 * its device secret; guards of the property sign in on it with their PIN (a shift; tokens of audience `guard`).
 * Refresh and logout use `/v1/auth/refresh` and `/v1/auth/logout` like every audience.
 */
@ApiTags('auth.guard')
@ApiSurface(SURFACES.auth)
@Controller('auth/guard')
export class GuardAuthController {
  constructor(private readonly guards: GuardAuthService) {}

  @Post('devices/enrol')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.guard.enrol',
    summary: 'Enrol a gate tablet',
    description:
      'Exchanges the one-time enrolment code from the owner console (`POST /v1/owner/gates/{gateId}/devices`, valid `gate.device_enrol_hours`) for the tablet’s device secret — shown once, stored only as sha256. A used, expired or unknown code is 401 `gate.enrol_code_invalid` (D-320, D-327).',
    implements: ['D-320', 'D-327'],
  })
  @ApiJsonBody(GuardEnrolDto, { code: 'ABCD-EFGH-JKLM', name: 'แท็บเล็ตป้อมหน้า' })
  @ApiSuccess(200, {
    description: 'Enrolled',
    type: GuardEnrolledDto,
    example: {
      deviceId: FAKE.uuid,
      deviceSecret: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9',
      gateId: FAKE.uuid,
      gateName: 'ป้อมหน้า',
      propertyId: FAKE.propertyId,
      propertyName: 'หมู่บ้านตัวอย่าง',
      tenantId: FAKE.tenantId,
      tenantName: 'นิติบุคคลหมู่บ้านตัวอย่าง',
    } satisfies GuardEnrolledDto,
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'gate.enrol_code_invalid')
  async enrol(@Body() body: GuardEnrolDto): Promise<GuardEnrolledDto> {
    const r = await this.guards.enrol(body.code, body.name);
    return {
      deviceId: r.deviceId,
      deviceSecret: r.deviceSecret,
      gateId: r.gate.id,
      gateName: r.gate.name,
      propertyId: r.property.id,
      propertyName: r.property.name,
      tenantId: r.tenant.id,
      tenantName: r.tenant.name,
    };
  }

  @Post('roster')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.guard.roster',
    summary: 'Guards who may sign in on this tablet',
    description:
      'The active guards of the tablet’s property (id, display name, locked flag) for the sign-in screen. A revoked or unknown tablet is 401 `gate.device_unknown` (D-320).',
    implements: ['D-320', 'D-327'],
  })
  @ApiJsonBody(GuardDeviceAuthDto, {
    deviceId: FAKE.uuid,
    deviceSecret: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9',
  })
  @ApiSuccess(200, {
    description: 'Roster',
    type: GuardRosterDto,
    example: {
      gateName: 'ป้อมหน้า',
      propertyName: 'หมู่บ้านตัวอย่าง',
      guards: [{ guardId: FAKE.uuid, displayName: 'สมศักดิ์', locked: false, lockedUntil: null }],
    },
  })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'gate.device_unknown', 'gate.inactive')
  async roster(@Body() body: GuardDeviceAuthDto): Promise<GuardRosterDto> {
    const r = await this.guards.roster(body.deviceId, body.deviceSecret);
    const now = Date.now();
    return {
      gateName: r.device.gate.name,
      propertyName: r.device.gate.property.name,
      guards: r.guards.map((g) => {
        const locked = Boolean(g.lockedUntil && g.lockedUntil.getTime() > now);
        return {
          guardId: g.id,
          displayName: g.displayName,
          locked,
          lockedUntil: locked ? toBangkokIso(g.lockedUntil!) : null,
        };
      }),
    };
  }

  @Post('sign-in')
  @HttpCode(200)
  @Public()
  @Throttle(LIMIT)
  @ApiEndpoint({
    id: 'auth.guard.signIn',
    summary: 'Guard sign-in with a PIN',
    description:
      'Starts a shift on the enrolled tablet: a token pair of audience `guard` (scopes `tenant:`, `property:`, `gate:`, `gate_device:`, `shift:`; refresh family ≤ `GUARD_REFRESH_TOKEN_TTL_HOURS`). A guard’s open shift on another tablet ends (`superseded`). Wrong PINs are counted: after `gate.pin_max_attempts` the guard is locked for `gate.pin_lock_minutes` (423 `gate.pin_locked` with `lockedUntil`); unknown guard or wrong PIN is 401 `gate.pin_invalid` (D-320, D-327).',
    implements: ['D-320', 'D-327', 'ADR-0003'],
  })
  @ApiJsonBody(GuardSignInDto, {
    deviceId: FAKE.uuid,
    deviceSecret: 'q2r8XoT1Vb9mJ0yPz4LkWnE6aGs3dHf5Q2r8XoT1Vb9',
    guardId: FAKE.uuid,
    pin: '482913',
  })
  @ApiSuccess(200, {
    description: 'Signed in',
    type: TokenPairDto,
    example: {
      ...TOKEN_PAIR_EXAMPLE,
      subject: {
        ...TOKEN_PAIR_EXAMPLE.subject,
        audience: TokenAudience.Guard,
        roles: ['guard'],
        permissions: ['gate.visit.record', 'gate.open', 'gate.incident.respond'],
        scopes: [`tenant:${FAKE.tenantId}`, `gate:${FAKE.uuid}`],
      },
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'gate.device_unknown',
    'gate.inactive',
    'gate.pin_invalid',
    'gate.pin_locked',
  )
  async signIn(@Body() body: GuardSignInDto): Promise<TokenPairDto> {
    return tokenPairDto(await this.guards.signIn(body));
  }
}

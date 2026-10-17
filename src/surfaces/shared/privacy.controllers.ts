import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { type TenantContext } from '@common/context/tenant-context';
import { resolveLanguage } from '@common/i18n/language';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ConsentService, type PurposeView } from '@core/privacy/consent.service';
import { DsrService } from '@core/privacy/dsr.service';
import { type NotificationAudience } from '@generated/prisma/client';
import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DSR_EXAMPLE, dsrDto } from '../owner/governance.controller';
import {
  ConsentCapturedDto,
  ConsentCaptureDto,
  ConsentPurposeDto,
  DsrCreateDto,
  DsrDto,
} from '../owner/governance.dto';
import { ApiSurface, SURFACES } from '../surfaces';
import { currentUserId, iso, isoOrNull } from './mappers';

export const purposeDto = (p: PurposeView): ConsentPurposeDto => ({
  key: p.key,
  required: p.required,
  version: p.version,
  language: p.language,
  title: p.title,
  bodyMarkdown: p.bodyMarkdown,
  effectiveFrom: iso(p.effectiveFrom),
  granted: p.granted,
  grantedVersion: p.grantedVersion,
  capturedAt: isoOrNull(p.capturedAt),
});

export const PURPOSE_EXAMPLE = {
  key: 'resident.service',
  required: true,
  version: 1,
  language: 'th',
  title: 'การใช้ข้อมูลเพื่อให้บริการผู้พักอาศัย',
  bodyMarkdown: 'เราใช้ข้อมูลของคุณเพื่อออกบิลและแจ้งเตือน',
  effectiveFrom: FAKE.dateTime,
  granted: true,
  grantedVersion: 1,
  capturedAt: FAKE.dateTime,
};
const CAPTURE_EXAMPLE = {
  items: [{ purposeKey: 'resident.service', version: 1, granted: true }],
  language: 'th',
};

const language = (acceptLanguage?: string): string => resolveLanguage(acceptLanguage);

@ApiTags('resident.consents')
@ApiSurface(SURFACES.resident)
@Controller('resident/consents')
export class ResidentConsentsController {
  constructor(private readonly consents: ConsentService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.consents.list',
    summary: 'My PDPA consents',
    description:
      'Every resident consent purpose in my language with its current version and my answer (null when never answered or when the text changed since, D-025). Asked in the LIFF on first use.',
    implements: ['D-025', 'D-154'],
  })
  @ApiSuccess(200, { description: 'Purposes', type: [ConsentPurposeDto], example: [PURPOSE_EXAMPLE] })
  @ApiStandardErrors('auth.unauthenticated')
  async list(@Headers('accept-language') acceptLanguage?: string): Promise<ConsentPurposeDto[]> {
    return (
      await this.consents.purposes(
        ['resident'],
        language(acceptLanguage),
        { type: 'user', id: currentUserId() },
        null,
      )
    ).map(purposeDto);
  }

  @Post()
  @ApiEndpoint({
    id: 'resident.consents.capture',
    summary: 'Give or withdraw consents',
    description:
      'Appends one consent row per purpose and controller tenant (the tenants I am a resident of), with time, channel, IP and user agent; audited, `consent.changed` releases held notifications when `resident.service` is granted (D-025).',
    implements: ['D-025'],
  })
  @ApiJsonBody(ConsentCaptureDto, CAPTURE_EXAMPLE)
  @ApiSuccess(201, {
    description: 'Recorded',
    type: ConsentCapturedDto,
    example: { recorded: 1, purposes: [PURPOSE_EXAMPLE] },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'consent.unknown_purpose',
    'auth.unauthenticated',
  )
  async capture(
    @Body() body: ConsentCaptureDto,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<ConsentCapturedDto> {
    const userId = currentUserId();
    const lang = body.language ?? language(acceptLanguage);
    const tenants = await this.consents.residentTenants(userId);
    const recorded = await this.consents.record({ type: 'user', id: userId }, body.items, {
      channel: 'liff',
      language: lang,
      tenantIds: tenants.length ? tenants : [null],
    });
    const purposes = await this.consents.purposes(['resident'], lang, { type: 'user', id: userId }, null);
    return { recorded, purposes: purposes.map(purposeDto) };
  }
}

@ApiTags('resident.dataSubjectRequests')
@ApiSurface(SURFACES.resident)
@Controller('resident/data-subject-requests')
export class ResidentDsrController {
  constructor(private readonly dsr: DsrService) {}

  @Get()
  @ApiEndpoint({
    id: 'resident.dataSubjectRequests.list',
    summary: 'My PDPA requests',
    description:
      'Access, rectification, erasure and other requests I filed, with their state and due date (D-025).',
    implements: ['D-025'],
  })
  @ApiSuccess(200, { description: 'Requests', type: [DsrDto], example: [DSR_EXAMPLE] })
  @ApiStandardErrors('auth.unauthenticated')
  async list(): Promise<DsrDto[]> {
    return (await this.dsr.listForSubject(currentUserId())).map(dsrDto);
  }

  @Post()
  @Idempotent()
  @ApiEndpoint({
    id: 'resident.dataSubjectRequests.create',
    summary: 'File a PDPA request',
    description:
      'One request per controller tenant (the tenants I am a resident of, or the one named), each tracked by the workflow engine with the `privacy.dsr_due_days` deadline; the tenant’s Owners are notified (D-025, D-159).',
    implements: ['D-025', 'D-159'],
  })
  @ApiJsonBody(DsrCreateDto, { kind: 'access', details: 'ขอสำเนาข้อมูลส่วนบุคคลทั้งหมด' })
  @ApiSuccess(201, { description: 'Filed', type: [DsrDto], example: [DSR_EXAMPLE] })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.not_found', 'auth.unauthenticated')
  async create(@Body() body: DsrCreateDto): Promise<DsrDto[]> {
    return (await this.dsr.create(currentUserId(), body)).map(dsrDto);
  }
}

@ApiTags('owner.consents')
@ApiSurface(SURFACES.owner)
@Controller('owner/consents')
export class OwnerConsentsController {
  constructor(private readonly consents: ConsentService) {}

  private audiences(ctx: TenantContext): NotificationAudience[] {
    const role = (ctx.role ?? 'owner') as NotificationAudience;
    return [...new Set<NotificationAudience>([role, 'owner'])];
  }

  @Get()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.consents.list',
    summary: 'My consents as an operator',
    description:
      'Platform terms and privacy notices for operators, with my answers (Collective is the controller of operator accounts, D-025).',
    implements: ['D-025'],
  })
  @ApiSuccess(200, {
    description: 'Purposes',
    type: [ConsentPurposeDto],
    example: [{ ...PURPOSE_EXAMPLE, key: 'operator.terms', title: 'ข้อกำหนดการใช้งาน getproperty' }],
  })
  @ApiStandardErrors('tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope')
  async list(
    @CurrentTenant() ctx: TenantContext,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<ConsentPurposeDto[]> {
    return (
      await this.consents.purposes(
        this.audiences(ctx),
        language(acceptLanguage),
        { type: 'user', id: currentUserId() },
        null,
      )
    ).map(purposeDto);
  }

  @Post()
  @TenantScoped()
  @ApiEndpoint({
    id: 'owner.consents.capture',
    summary: 'Accept or withdraw operator consents',
    description: 'Appends my consent rows (platform controller, channel `web`), audited and evented (D-025).',
    implements: ['D-025'],
  })
  @ApiJsonBody(ConsentCaptureDto, {
    items: [{ purposeKey: 'operator.terms', version: 1, granted: true }],
    language: 'th',
  })
  @ApiSuccess(201, {
    description: 'Recorded',
    type: ConsentCapturedDto,
    example: {
      recorded: 1,
      purposes: [{ ...PURPOSE_EXAMPLE, key: 'operator.terms', title: 'ข้อกำหนดการใช้งาน getproperty' }],
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.bad_request',
    'consent.unknown_purpose',
    'tenant.context_required',
    'tenant.context_invalid',
    'tenant.not_in_scope',
  )
  async capture(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ConsentCaptureDto,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<ConsentCapturedDto> {
    const userId = currentUserId();
    const lang = body.language ?? language(acceptLanguage);
    const recorded = await this.consents.record({ type: 'user', id: userId }, body.items, {
      channel: 'web',
      language: lang,
      tenantIds: [null],
    });
    const purposes = await this.consents.purposes(
      this.audiences(ctx),
      lang,
      { type: 'user', id: userId },
      null,
    );
    return { recorded, purposes: purposes.map(purposeDto) };
  }
}

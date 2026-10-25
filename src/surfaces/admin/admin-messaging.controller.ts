import { Can } from '@common/auth/can.decorator';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { Idempotent } from '@common/idempotency/idempotent.decorator';
import { ApiEndpoint, ApiJsonBody, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { MessagingUsageService } from '@core/messaging/messaging-usage.service';
import { type MessagingRate } from '@generated/prisma/client';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  MessagingRateCreateDto,
  MessagingRateDto,
  type MessagingRateStateName,
} from '../owner/messaging.dto';
import { iso, isoOrNull } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';

export function messagingRateDto(r: MessagingRate): MessagingRateDto {
  return {
    id: r.id,
    effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
    freePerTenant: r.freePerTenant,
    freePerUnit: r.freePerUnit,
    pricePerMessage: r.pricePerMessage.toFixed(4),
    vatPercent: r.vatPercent.toFixed(2),
    notes: r.notes,
    state: r.state as MessagingRateStateName,
    enteredBy: r.enteredBy,
    enteredAt: iso(r.enteredAt),
    publishedBy: r.publishedBy,
    publishedAt: isoOrNull(r.publishedAt),
  };
}

const RATE_EXAMPLE: MessagingRateDto = {
  id: FAKE.uuid,
  effectiveFrom: '2026-12-01',
  freePerTenant: 500,
  freePerUnit: 10,
  pricePerMessage: '0.1000',
  vatPercent: '7.00',
  notes: null,
  state: 'entered' as MessagingRateStateName,
  enteredBy: FAKE.uuid,
  enteredAt: FAKE.dateTime,
  publishedBy: null,
  publishedAt: null,
};

function currentUser(): string {
  const user = userIdOf(RequestContext.actor());
  if (!user) throw new DomainException('auth.unauthenticated');
  return user;
}

/** The shared getproperty LINE OA's charge (D-254): versions entered by one platform user, published by another. */
@ApiTags('admin.messagingRates')
@ApiSurface(SURFACES.admin)
@Controller('admin/messaging-rates')
export class AdminMessagingRatesController {
  constructor(private readonly usage: MessagingUsageService) {}

  @Get()
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.messagingRates.list',
    summary: 'Rates of the shared LINE OA',
    description:
      'Every version (entered, published, withdrawn), newest first: free messages per tenant and per unit, price per counted message, VAT (D-254).',
    implements: ['D-254'],
  })
  @ApiSuccess(200, { description: 'Rates', type: [MessagingRateDto], example: [RATE_EXAMPLE] })
  @ApiStandardErrors()
  async list(): Promise<MessagingRateDto[]> {
    return (await this.usage.listRates()).map(messagingRateDto);
  }

  @Post()
  @Idempotent()
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.messagingRates.enter',
    summary: 'Enter a rate (maker)',
    description:
      'A new version in state `entered`, effective from today or later (`messaging_rate.in_the_past`). Another platform user publishes it (D-254, D-091). LINE’s own prices are not hard-coded: re-check them before setting a rate.',
    implements: ['D-254', 'D-091'],
  })
  @ApiJsonBody(MessagingRateCreateDto, {
    effectiveFrom: '2026-12-01',
    freePerTenant: 500,
    freePerUnit: 10,
    pricePerMessage: '0.1000',
    vatPercent: '7.00',
  })
  @ApiSuccess(201, { description: 'Entered', type: MessagingRateDto, example: RATE_EXAMPLE })
  @ApiStandardErrors('validation.failed', 'http.bad_request', 'http.conflict', 'messaging_rate.in_the_past')
  async enter(@Body() body: MessagingRateCreateDto): Promise<MessagingRateDto> {
    return messagingRateDto(
      await this.usage.enterRate(currentUser(), {
        effectiveFrom: body.effectiveFrom,
        freePerTenant: body.freePerTenant,
        freePerUnit: body.freePerUnit ?? 0,
        pricePerMessage: body.pricePerMessage,
        vatPercent: body.vatPercent,
        notes: body.notes ?? null,
      }),
    );
  }

  @Post(':rateId/actions/publish')
  @HttpCode(200)
  @Can('admin.setting.manage')
  @ApiEndpoint({
    id: 'admin.messagingRates.publish',
    summary: 'Publish a rate (checker)',
    description:
      'A platform user other than the one who entered it (`messaging_rate.same_checker`) publishes the version; a version already published for the same day is withdrawn. It is charged from its effective date and shown on the public pricing (D-254, D-091).',
    implements: ['D-254', 'D-091'],
  })
  @ApiSuccess(200, {
    description: 'Published',
    type: MessagingRateDto,
    example: {
      ...RATE_EXAMPLE,
      state: 'published' as MessagingRateStateName,
      publishedBy: FAKE.uuid,
      publishedAt: FAKE.dateTime,
    },
  })
  @ApiStandardErrors(
    'validation.failed',
    'http.not_found',
    'messaging_rate.invalid_state',
    'messaging_rate.same_checker',
    'messaging_rate.in_the_past',
  )
  async publish(@Param('rateId', ParseUUIDPipe) id: string): Promise<MessagingRateDto> {
    return messagingRateDto(await this.usage.publishRate(currentUser(), id));
  }
}

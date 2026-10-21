import { verifyIntegrationWebhook, WEBHOOK_HEADERS } from '@collective/asset-core/contracts';
import { Public } from '@common/auth/auth.decorators';
import { DomainException } from '@common/errors/domain.exception';
import { type RawBodyRequest } from '@common/http/json-body-parser';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { AppConfig } from '@config/app-config';
import { CLOCK, type Clock } from '@core/clock/clock';
import { type IntegrationPlatform } from '@generated/prisma/client';
import { keysOf } from '@modules/bridge-integrations/integration-delivery.service';
import { IntegrationEventsService } from '@modules/bridge-integrations/integration-events.service';
import { Controller, Headers, HttpCode, Inject, Param, Post, Req, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiProperty, ApiTags } from '@nestjs/swagger';

import { IntegrationSystemName } from '../admin/admin.dto';
import { ApiSurface, SURFACES } from '../surfaces';

export enum IntegrationReceiptStatus {
  Applied = 'applied',
  Rejected = 'rejected',
  Duplicate = 'duplicate',
}

export class IntegrationReceiptDto {
  @ApiProperty({ format: 'uuid', example: '0199f1c2-7a00-7000-8000-0000000000aa' })
  id!: string;

  @ApiProperty({
    enum: IntegrationReceiptStatus,
    enumName: 'IntegrationReceiptStatus',
    example: IntegrationReceiptStatus.Applied,
    description:
      '`applied` (stored and applied), `rejected` (stored; the contract or the consumer refused it — do not resend), `duplicate` (this idempotency key was received before).',
  })
  status!: IntegrationReceiptStatus;
}

const PLATFORMS: readonly IntegrationPlatform[] = ['getbuild', 'getpack'];

/**
 * `POST /webhooks/integration/{platform}` — the receiving side of D-238 (blueprint T-16): another Collective product
 * sends one integration event per request over the box's docker network, signed with `@collective/asset-core`'s
 * webhook helpers. The signature is checked against `INTEGRATION_<PLATFORM>_VERIFY_KEYS` over the raw body; the event
 * is stored once per idempotency key, validated against the contract and applied by its registered consumer
 * (`IntegrationEventsService.receive`). 2xx = stored (the sender stops retrying), also for a refused or duplicate event.
 */
@ApiTags('webhooks.integration')
@ApiSurface(SURFACES.webhooks)
@Controller({ path: 'webhooks/integration', version: VERSION_NEUTRAL })
export class IntegrationWebhooksController {
  constructor(
    private readonly events: IntegrationEventsService,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post(':platform')
  @HttpCode(200)
  @Public()
  @ApiParam({
    name: 'platform',
    enum: IntegrationSystemName,
    enumName: 'IntegrationSystem',
    description: 'The sending product.',
  })
  @ApiHeader({
    name: 'X-Collective-Event-Id',
    required: true,
    description: 'The envelope’s idempotency key.',
  })
  @ApiHeader({
    name: 'X-Collective-Source',
    required: true,
    description: 'The sending product (= `platform`).',
  })
  @ApiHeader({
    name: 'X-Collective-Timestamp',
    required: true,
    description: 'Unix seconds of the signature (± 300 s).',
  })
  @ApiHeader({
    name: 'X-Collective-Signature',
    required: true,
    description: '`v1=<hex HMAC-SHA256(key, "<timestamp>.<raw body>")>`, several during a key rotation.',
  })
  @ApiEndpoint({
    id: 'webhooks.integration.receive',
    summary: 'Integration event from another Collective product',
    description:
      'Cross-product events (D-238, D-153): HMAC-signed over the raw body (401 `webhook.signature_invalid`), stored once per idempotency key, validated against the `@collective/asset-core` contract and applied by its consumer — `warranty.defect.closed` today (B5.1). Answers 200 once stored, including refused and duplicate events. Senders call it over the box’s docker network; only correctly signed requests are accepted wherever it is reached from.',
    implements: ['D-238', 'D-153'],
  })
  @ApiBody({
    required: true,
    description: 'An integration event envelope of `@collective/asset-core/contracts`.',
    schema: { type: 'object', additionalProperties: true },
    examples: {
      closed: {
        summary: 'A warranty defect closed by getbuild',
        value: {
          eventId: '0199f1c2-7a00-7000-8000-000000000004',
          type: 'warranty.defect.closed',
          version: 1,
          occurredAt: '2026-11-04T09:00:00+07:00',
          idempotencyKey: 'getbuild:defect:D-0042:closed',
          sourcePlatform: 'getbuild',
          tenantId: null,
          payload: {},
        },
      },
    },
  })
  @ApiSuccess(200, {
    description: 'Stored',
    type: IntegrationReceiptDto,
    example: { id: '0199f1c2-7a00-7000-8000-0000000000aa', status: IntegrationReceiptStatus.Applied },
  })
  @ApiStandardErrors(
    'webhook.signature_invalid',
    'webhook.malformed',
    'http.not_found',
    'http.malformed_json',
  )
  async receive(
    @Param('platform') platform: string,
    @Headers() headers: Record<string, string | undefined>,
    @Req() req: RawBodyRequest,
  ): Promise<IntegrationReceiptDto> {
    if (!(PLATFORMS as readonly string[]).includes(platform)) throw new DomainException('http.not_found');
    const p = platform as IntegrationPlatform;
    const keys = keysOf(
      this.config.get(
        p === 'getbuild' ? 'INTEGRATION_GETBUILD_VERIFY_KEYS' : 'INTEGRATION_GETPACK_VERIFY_KEYS',
      ),
    );
    if (!req.rawBody?.length) throw new DomainException('webhook.malformed');
    const verified = verifyIntegrationWebhook({
      keys,
      body: req.rawBody,
      headers,
      now: Math.floor(this.clock.now().getTime() / 1000),
    });
    if (!verified.ok || headers[WEBHOOK_HEADERS.source] !== p)
      throw new DomainException('webhook.signature_invalid');
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      throw new DomainException('webhook.malformed');
    }
    const outcome = await this.events.receive(p, body);
    return { id: outcome.id, status: outcome.status as IntegrationReceiptStatus };
  }
}

import { Public } from '@common/auth/auth.decorators';
import { DomainException } from '@common/errors/domain.exception';
import { type RawBodyRequest } from '@common/http/json-body-parser';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { RecurringPaymentsService } from '@modules/ops-payments/recurring-payments.service';
import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiBody, ApiExcludeEndpoint, ApiHeader, ApiTags } from '@nestjs/swagger';

import { WebhookAckDto } from '../owner/payments.dto';
import { ApiSurface, SURFACES } from '../surfaces';

const escape = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '');

@ApiTags('webhooks.recurring')
@ApiSurface(SURFACES.webhooks)
@Controller({ path: 'webhooks/recurring', version: VERSION_NEUTRAL })
export class RecurringWebhooksController {
  constructor(private readonly recurring: RecurringPaymentsService) {}

  @Post(':provider')
  @HttpCode(200)
  @Public()
  @ApiHeader({
    name: 'X-Recurring-Signature',
    required: true,
    description:
      'Hex HMAC-SHA256 of the raw body with the shared secret (`RECURRING_WEBHOOK_SECRET`; fake provider).',
  })
  @ApiEndpoint({
    id: 'webhooks.recurring.callback',
    summary: 'Recurring-payment provider callback',
    description:
      'The direct-debit / card provider (fake until O-020) reports a mandate (`mandate.activated` / `mandate.failed` / `mandate.revoked`) or a charge (`charge.succeeded` books a `recurring` payment allocated by `payments.allocation_policy`, receipt as usual; `charge.failed`). Signed (401 `webhook.signature_invalid` otherwise); stored once per (provider, event id) — a replay answers `duplicate: true` and changes nothing (D-308, D-325).',
    implements: ['D-308', 'D-325'],
  })
  @ApiBody({
    required: true,
    description:
      '`eventId`, `type`, `mandateRef`, `chargeRef` (charges), `amount` (decimal string), `occurredAt`, `masked`, `reason`.',
    schema: { type: 'object', additionalProperties: true },
    examples: {
      charge: {
        summary: 'A charge succeeded',
        value: {
          eventId: 'evt_0001',
          type: 'charge.succeeded',
          mandateRef: 'fake-mandate-0001',
          chargeRef: 'fake-charge-0001',
          amount: '16380.00',
          occurredAt: '2027-01-01T03:00:00.000Z',
        },
      },
    },
  })
  @ApiSuccess(200, {
    description: 'Accepted',
    type: WebhookAckDto,
    example: { received: true, duplicate: false },
  })
  @ApiStandardErrors(
    'webhook.signature_invalid',
    'webhook.malformed',
    'http.not_found',
    'http.malformed_json',
  )
  async callback(
    @Param('provider') provider: string,
    @Headers('x-recurring-signature') signature: string | undefined,
    @Req() req: RawBodyRequest,
  ): Promise<WebhookAckDto> {
    return this.recurring.receive(provider.slice(0, 40), req.rawBody, signature);
  }

  /** The fake provider's page (RECURRING_PAYMENTS_MODE=fake only; not in the contract): authorise or decline. */
  @Get('fake/mandates/:mandateRef')
  @Public()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(@Param('mandateRef') mandateRef: string): string {
    if (this.recurring.mode !== 'fake') throw new DomainException('http.not_found');
    const ref = escape(mandateRef.slice(0, 200));
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake direct debit</title></head><body style="font-family:sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem"><h1>Fake direct debit</h1><p>Mandate <code>${ref}</code></p><form method="post" action="${ref}/approve"><button style="font-size:1.1rem;padding:.6rem 1rem">Authorise</button></form><form method="post" action="${ref}/decline" style="margin-top:1rem"><button style="font-size:1.1rem;padding:.6rem 1rem">Decline</button></form></body></html>`;
  }

  @Post('fake/mandates/:mandateRef/:decision')
  @HttpCode(200)
  @Public()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/html; charset=utf-8')
  async decide(
    @Param('mandateRef') mandateRef: string,
    @Param('decision') decision: string,
  ): Promise<string> {
    if (this.recurring.mode !== 'fake' || !['approve', 'decline'].includes(decision))
      throw new DomainException('http.not_found');
    const ref = escape(mandateRef.slice(0, 200));
    await this.recurring.apply('fake', {
      eventId: `fake-page-${ref}-${decision}`,
      type: decision === 'approve' ? 'mandate.activated' : 'mandate.failed',
      mandateRef: ref,
      chargeRef: null,
      amount: null,
      occurredAt: new Date(),
      masked: decision === 'approve' ? 'xxx-x-x0000-x' : null,
      reason: decision === 'approve' ? null : 'declined on the fake page',
    });
    return `<!doctype html><html><body style="font-family:sans-serif;max-width:28rem;margin:2rem auto">${decision === 'approve' ? 'Authorised' : 'Declined'} — you can close this page.</body></html>`;
  }
}

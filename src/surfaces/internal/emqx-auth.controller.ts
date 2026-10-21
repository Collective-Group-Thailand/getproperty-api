import { timingSafeEqual } from 'node:crypto';

import { Public } from '@common/auth/auth.decorators';
import { systemActor } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { ipAllowed, parseCidrList } from '@common/http/cidr';
import { PRIVATE_RANGES } from '@common/observability/metrics';
import { AppConfig } from '@config/app-config';
import {
  type EmqxAuthnRequest,
  EmqxAuthService,
  type EmqxAuthzRequest,
  type EmqxResult,
} from '@core/devices/emqx-auth.service';
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpCode,
  Injectable,
  Post,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { seconds, Throttle } from '@nestjs/throttler';
import { type Request } from 'express';

/** The header collective-infra's EMQX sends on every HTTP authn / authz call (D-235, T-7). */
export const EMQX_AUTH_HEADER = 'x-emqx-auth-token';

const EMQX_RATE_LIMIT = () => Number(process.env.EMQX_HTTP_RATE_LIMIT ?? 6000);

/**
 * `/internal/*` is for the platform's docker network only: the caller (`req.ip`, after `trust proxy`) must be inside
 * `EMQX_HTTP_ALLOWED_CIDRS` (default loopback + private ranges) — a request relayed by Caddy carries the public client
 * address and gets 404, as Caddy itself answers 404 for `/internal/*` on every public host — and must present
 * `x-emqx-auth-token` equal to `EMQX_AUTH_TOKEN` (constant-time); an empty `EMQX_AUTH_TOKEN` refuses everything.
 */
@Injectable()
export class InternalEmqxGuard implements CanActivate {
  private readonly allowed;

  constructor(private readonly config: AppConfig) {
    this.allowed = parseCidrList(config.get('EMQX_HTTP_ALLOWED_CIDRS') || PRIVATE_RANGES);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!ipAllowed(this.allowed, req.ip)) throw new DomainException('http.not_found');
    const expected = this.config.get('EMQX_AUTH_TOKEN') ?? '';
    const raw = req.headers[EMQX_AUTH_HEADER];
    const presented = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b))
      throw new DomainException('auth.forbidden');
    RequestContext.setActor(systemActor('emqx'));
    return true;
  }
}

/**
 * EMQX HTTP authn / authz for gateways on the shared broker (D-235, blueprint T-7–T-9, D-239). Internal: not part of
 * the public OpenAPI contract (`@ApiExcludeController`); the request / answer shapes are documented in
 * `docs/contract/device-protocol.md` §1a and agreed with collective-infra's EMQX configuration. Always 200 with
 * `{"result": "allow" | "deny" | "ignore"}` once the caller is accepted; rate-limited per caller.
 */
@ApiExcludeController()
@Controller({ path: 'internal/emqx', version: VERSION_NEUTRAL })
@UseGuards(InternalEmqxGuard)
export class EmqxAuthController {
  constructor(private readonly emqx: EmqxAuthService) {}

  @Post('authn')
  @HttpCode(200)
  @Public()
  @Throttle({ default: { limit: EMQX_RATE_LIMIT, ttl: seconds(60) } })
  async authn(@Body() body: EmqxAuthnRequest): Promise<{ result: EmqxResult; is_superuser?: false }> {
    const result = await this.emqx.authenticate(body ?? {});
    return result === 'allow' ? { result, is_superuser: false } : { result };
  }

  @Post('authz')
  @HttpCode(200)
  @Public()
  @Throttle({ default: { limit: EMQX_RATE_LIMIT, ttl: seconds(60) } })
  async authz(@Body() body: EmqxAuthzRequest): Promise<{ result: EmqxResult }> {
    return { result: await this.emqx.authorize(body ?? {}) };
  }
}

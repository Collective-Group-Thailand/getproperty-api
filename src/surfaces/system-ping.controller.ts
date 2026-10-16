import { OptionalAuth, Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { toBangkokIso } from '@common/time/bangkok';
import { Controller, type ControllerOptions, Get, type Type, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { APP_VERSION } from '../bootstrap';
import { ApiSurface, type Surface, SURFACE_AUDIENCE, SURFACES } from './surfaces';
import { pingExample, SystemPingDto } from './system-ping.dto';

/**
 * One fully documented placeholder operation per surface, `GET /v1/{surface}/ping`
 * (`/webhooks/ping` is version-neutral), so the contract pipeline and the e2e suite exercise every
 * surface module before the real endpoints arrive (B1.3 onwards). Surfaces with an audience accept
 * anonymous calls *or* a token of their audience (`@OptionalAuth`), which keeps every security scheme
 * referenced in the contract; `auth` and `webhooks` are plainly public.
 */
export function systemPingController(surface: Surface): Type<unknown> {
  const route: ControllerOptions =
    surface === SURFACES.webhooks ? { path: 'webhooks', version: VERSION_NEUTRAL } : { path: surface };
  const audience = SURFACE_AUDIENCE[surface];
  const access = audience ? OptionalAuth(audience) : Public();

  @ApiTags(`${surface}.system`)
  @ApiSurface(surface)
  @Controller(route)
  class SystemPingController {
    @Get('ping')
    @access
    @ApiEndpoint({
      id: `${surface}.system.ping`,
      summary: `Ping the ${surface} surface`,
      description:
        `Answers with the surface name, the server time (Asia/Bangkok) and the API version. Placeholder operation of the ` +
        `\`${surface}\` surface until its real endpoints land. ` +
        (audience
          ? `Anonymous or with an \`${audience}\` token (checked from B1.3: wrong audience → 403 \`auth.wrong_audience\`).`
          : 'Public: this surface has no token audience.'),
      implements: ['D-002', 'ADR-0002'],
    })
    @ApiSuccess(200, { description: 'The surface is up', type: SystemPingDto, example: pingExample(surface) })
    @ApiStandardErrors()
    ping(): SystemPingDto {
      return { ...pingExample(surface), serverTime: toBangkokIso(new Date()), version: APP_VERSION };
    }
  }

  // A stable, unique class name per surface: swagger names operations after it and tests print it.
  Object.defineProperty(SystemPingController, 'name', { value: `${capitalise(surface)}SystemController` });
  return SystemPingController;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

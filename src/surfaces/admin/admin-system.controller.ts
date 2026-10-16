import { Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { toBangkokIso } from '@common/time/bangkok';
import { AppConfig } from '@config/app-config';
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { APP_VERSION } from '../../bootstrap';
import { ApiSurface, SURFACES } from '../surfaces';
import { EnvironmentBadge, SystemInfoDto } from './system-info.dto';

@ApiTags('admin.system')
@ApiSurface(SURFACES.admin)
@Controller('admin/system')
export class AdminSystemController {
  constructor(private readonly config: AppConfig) {}

  @Get('info')
  // TODO(B1.3): platform audience + `settings.read`; public until the auth guard exists.
  @Public()
  @ApiEndpoint({
    id: 'admin.system.info',
    summary: 'Build and environment information',
    description:
      'Version, git commit and environment badge shown in the platform admin header, plus whether any ' +
      'dependency runs as an in-memory fake. Never exposes configuration values.',
    implements: ['ADR-0002'],
  })
  @ApiSuccess(200, {
    description: 'Build information',
    type: SystemInfoDto,
    example: {
      version: '0.1.0',
      commit: '9fceb02d',
      environment: EnvironmentBadge.Development,
      fakes: true,
      serverTime: '2026-11-01T00:15:00+07:00',
    } satisfies SystemInfoDto,
  })
  @ApiStandardErrors()
  info(): SystemInfoDto {
    return {
      version: APP_VERSION,
      commit: this.config.get('GIT_COMMIT')?.slice(0, 8) ?? null,
      environment: this.config.get('NODE_ENV') as unknown as EnvironmentBadge,
      fakes: this.config.useFakeDataStores || this.config.useFakes,
      serverTime: toBangkokIso(new Date()),
    };
  }
}

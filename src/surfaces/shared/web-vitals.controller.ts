import { OptionalAuth } from '@common/auth/auth.decorators';
import { RequestContext } from '@common/context/request-context';
import {
  ApiAsync,
  ApiEndpoint,
  ApiJsonBody,
  ApiStandardErrors,
  ApiSuccess,
} from '@common/openapi/decorators';
import { Body, Controller, HttpCode, Logger, Post, type Type } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type as TransformType } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { ApiSurface, type Surface, SURFACE_AUDIENCE } from '../surfaces';

export enum WebVitalName {
  Lcp = 'LCP',
  Inp = 'INP',
  Cls = 'CLS',
  Fcp = 'FCP',
  Ttfb = 'TTFB',
}

export enum WebVitalRating {
  Good = 'good',
  NeedsImprovement = 'needs-improvement',
  Poor = 'poor',
}

export enum WebVitalNavigationType {
  Navigate = 'navigate',
  Reload = 'reload',
  BackForward = 'back-forward',
  BackForwardCache = 'back-forward-cache',
  Prerender = 'prerender',
  Restore = 'restore',
}

export class WebVitalDto {
  @ApiProperty({ enum: WebVitalName, enumName: 'WebVitalName', example: WebVitalName.Lcp })
  @IsEnum(WebVitalName)
  name!: WebVitalName;

  @ApiProperty({ example: 1834.2, description: 'Milliseconds (CLS: unitless score).' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  value!: number;

  @ApiProperty({ enum: WebVitalRating, enumName: 'WebVitalRating', example: WebVitalRating.Good })
  @IsEnum(WebVitalRating)
  rating!: WebVitalRating;

  @ApiProperty({ example: 'v4-a1b2c3d4-e5f6', description: 'web-vitals metric id.' })
  @IsString()
  @MaxLength(80)
  id!: string;

  @ApiProperty({
    example: '/buildings/[buildingId]',
    description: 'Route pattern (never a URL with ids or query strings: no personal data).',
  })
  @Matches(/^\/[A-Za-z0-9/_[\]().-]{0,199}$/)
  route!: string;

  @ApiPropertyOptional({
    enum: WebVitalNavigationType,
    enumName: 'WebVitalNavigationType',
    example: WebVitalNavigationType.Navigate,
  })
  @IsOptional()
  @IsEnum(WebVitalNavigationType)
  navigationType?: WebVitalNavigationType;
}

export class WebVitalsReportDto {
  @ApiProperty({ type: () => [WebVitalDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @TransformType(() => WebVitalDto)
  metrics!: WebVitalDto[];
}

const named = (cls: Type<unknown>, name: string): Type<unknown> => {
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * `POST /v1/{owner,staff,admin}/telemetry/web-vitals` — real-user Web Vitals forwarded by each zone's BFF (D-179
 * budgets): anonymous on public pages or with the zone's token. Metrics are logged as structured `web_vitals`
 * records (route patterns only, no ids, no user) for the dashboards; nothing is stored per user.
 */
export function webVitalsController(surface: Extract<Surface, 'owner' | 'staff' | 'admin'>): Type<unknown> {
  const audience = SURFACE_AUDIENCE[surface]!;
  const logger = new Logger('WebVitals');

  @ApiTags(`${surface}.telemetry`)
  @ApiSurface(surface)
  @Controller(`${surface}/telemetry`)
  class WebVitalsController {
    @Post('web-vitals')
    @HttpCode(202)
    @ApiAsync({ poll: null })
    @OptionalAuth(audience)
    @ApiEndpoint({
      id: `${surface}.telemetry.webVitals`,
      summary: 'Report Web Vitals',
      description:
        'Real-user Core Web Vitals (LCP, INP, CLS, FCP, TTFB) of the web zone, batched by its BFF; anonymous on public pages. Route patterns only — never URLs with ids or query strings. Accepted for aggregation, nothing to poll (D-179 performance budgets).',
      implements: ['D-179'],
    })
    @ApiJsonBody(WebVitalsReportDto, {
      metrics: [
        {
          name: 'LCP',
          value: 1834.2,
          rating: 'good',
          id: 'v4-a1b2c3d4-e5f6',
          route: '/buildings/[buildingId]',
          navigationType: 'navigate',
        },
      ],
    })
    @ApiSuccess(202, { description: 'Accepted' })
    @ApiStandardErrors('validation.failed', 'http.bad_request')
    report(@Body() body: WebVitalsReportDto): void {
      const signedIn = Boolean(RequestContext.actor());
      for (const m of body.metrics)
        logger.log(
          {
            event: 'web_vitals',
            surface,
            name: m.name,
            value: m.value,
            rating: m.rating,
            route: m.route,
            navigationType: m.navigationType ?? null,
            signedIn,
          },
          `${m.name} ${m.rating} ${m.route}`,
        );
    }
  }
  return named(WebVitalsController, `${cap(surface)}WebVitalsController`);
}

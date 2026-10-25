import { Public } from '@common/auth/auth.decorators';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { MessagingUsageService } from '@core/messaging/messaging-usage.service';
import { UtilityTariffsService } from '@core/utility-tariffs/utility-tariffs.service';
import { TenantTx } from '@database/tenant-tx';
import { type MessagingRate } from '@generated/prisma/client';
import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { type UtilityName, type UtilityProviderName } from '../owner/assets.dto';
import { PublicMessagingRateDto, PublicPricingDto } from '../owner/messaging.dto';
import { dateOnly } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import { publicPlansFromCatalogue } from './plans';
import { PublicPlansDto, PublicTariffDto, PublicTariffQuery } from './public.dto';

const CACHE = 'public, max-age=300, stale-while-revalidate=600';

@ApiTags('public.plans')
@ApiSurface(SURFACES.public)
@Controller('public/plans')
export class PublicPlansController {
  constructor(
    private readonly db: TenantTx,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Public()
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.plans.list',
    summary: 'Price plans for the pricing page',
    description:
      'The price-plan catalogue (`platform.price_plan_version`, the prices billing uses, D-204): per plan the published version in force today (`sold: true`), else its newest draft shown as a proposal (`sold: false`) — THB, VAT excluded. While D-156 is Proposed every plan says `status: proposed`; quoted ranges come as `priceFrom`/`priceTo`. Anonymous and cacheable (5 min). D-208.',
    implements: ['D-156', 'D-204', 'D-208'],
  })
  @ApiSuccess(200, {
    description: 'Plans',
    type: PublicPlansDto,
    example: {
      data: [
        {
          key: 'apartment_starter',
          kind: 'plan',
          tenantType: 'apartment',
          name: 'Apartment Starter',
          summary: 'ออกบิล เก็บเงิน และแจ้งผู้เช่าผ่าน LINE สำหรับหอพักที่จดมิเตอร์เอง',
          pricePerUnit: '25.00',
          priceFrom: null,
          priceTo: null,
          priceUnit: 'unit_month',
          minimumUnits: 20,
          currency: 'THB',
          vatIncluded: false,
          status: 'proposed',
          features: ['A1', 'A2', 'A4', 'resident_liff', 'promptpay'],
          sold: true,
          effectiveFrom: '2026-01-01',
        },
      ],
    },
  })
  @ApiStandardErrors()
  async list(): Promise<PublicPlansDto> {
    const plans = await this.db.platform((tx) =>
      tx.pricePlan.findMany({ include: { versions: true }, orderBy: { createdAt: 'asc' } }),
    );
    return { data: publicPlansFromCatalogue(plans, bangkokDate(this.clock.now())) };
  }
}

@ApiTags('public.utilityTariffs')
@ApiSurface(SURFACES.public)
@Controller('public/utility-tariffs')
export class PublicUtilityTariffsController {
  constructor(
    private readonly tariffs: UtilityTariffsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('current')
  @Public()
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.utilityTariffs.current',
    summary: 'Published utility ceiling per unit',
    description:
      'The lawful ceiling per unit of the verified and published MEA/PEA/MWA/PWA tariff in force today (residential class 1.1 unless `tariffCode` is given) — the value the สคบ. 2568 notice compares a dormitory’s rate with (D-021a, D-140). For the landing-page loss calculator; anonymous and cacheable. 404 `tariff.not_found` while no version is published.',
    implements: ['D-021', 'D-140'],
  })
  @ApiSuccess(200, {
    description: 'Ceiling in force',
    type: PublicTariffDto,
    example: {
      utility: 'electric',
      provider: 'mea',
      nameTh: 'ประเภท 1.1 บ้านอยู่อาศัย',
      tariffCode: '1.1',
      ceilingPerUnit: '4.6189',
      effectiveFrom: '2026-09-01',
      sourceUrl: 'https://www.mea.or.th/',
    },
  })
  @ApiStandardErrors('validation.failed', 'tariff.not_found')
  async current(@Query() q: PublicTariffQuery): Promise<PublicTariffDto> {
    const day = new Date(`${bangkokDate(this.clock.now())}T00:00:00.000Z`);
    const rows = await this.tariffs.current({
      utility: q.utility,
      provider: q.provider,
      tariffCode: q.tariffCode,
      date: day,
    });
    const pick =
      rows.find((r) => r.tariff.tariffCode === (q.tariffCode ?? '1.1')) ??
      rows.find((r) => r.tariff.tariffCode.startsWith(q.tariffCode ?? '1.1')) ??
      rows[0]!;
    return {
      utility: pick.tariff.utility as UtilityName,
      provider: pick.tariff.provider as UtilityProviderName,
      nameTh: pick.tariff.nameTh,
      tariffCode: pick.tariff.tariffCode,
      ceilingPerUnit: pick.version.ceilingPerUnit.toFixed(4),
      effectiveFrom: dateOnly(pick.version.effectiveFrom)!,
      sourceUrl: pick.version.sourceUrl,
    };
  }
}

function publicRate(r: MessagingRate | null): PublicMessagingRateDto | null {
  return r
    ? {
        effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
        freePerTenant: r.freePerTenant,
        freePerUnit: r.freePerUnit,
        pricePerMessage: r.pricePerMessage.toFixed(4),
        vatPercent: r.vatPercent.toFixed(2),
        repliesFree: true,
      }
    : null;
}

@ApiTags('public.pricing')
@ApiSurface(SURFACES.public)
@Controller('public/pricing')
export class PublicPricingController {
  constructor(private readonly usage: MessagingUsageService) {}

  @Get()
  @Public()
  @Header('Cache-Control', CACHE)
  @ApiEndpoint({
    id: 'public.pricing.get',
    summary: 'Published prices',
    description:
      'What an operator pays getproperty, as published: the shared LINE OA’s free messages and price per counted message beyond them (replies free; an own OA is never charged by getproperty) — in force today and the next published change (D-254). Payment fee rules join with the payment gateway (D-250). Anonymous and cacheable.',
    implements: ['D-254'],
  })
  @ApiSuccess(200, {
    description: 'Prices',
    type: PublicPricingDto,
    example: {
      messaging: {
        effectiveFrom: '2026-12-01',
        freePerTenant: 500,
        freePerUnit: 10,
        pricePerMessage: '0.1000',
        vatPercent: '7.00',
        repliesFree: true,
      },
      messagingNext: null,
    },
  })
  @ApiStandardErrors()
  async get(): Promise<PublicPricingDto> {
    const { current, next } = await this.usage.pricing();
    return { messaging: publicRate(current), messagingNext: publicRate(next) };
  }
}

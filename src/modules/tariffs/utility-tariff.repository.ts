import { PrismaService } from '@database/prisma.service';
import { type TariffVersionState, type UtilityProvider } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';

import { type UtilityTariffStructure } from './tariff-structure';

export interface TariffVersionAt {
  id: string;
  provider: UtilityProvider;
  tariffCode: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  state: TariffVersionState;
  needsCheck: boolean;
  sourceUrl: string;
  structure: UtilityTariffStructure;
}

/**
 * Utility tariff versions (platform catalogue, RLS:P — readable by every tenant). `at()` returns the version in
 * force on a date: by default only `published` ones (the cap reference, B1.3/B4.1); seeds enter versions as
 * `entered` (unverified) until the platform admin verifies them (maker-checker, B6.4), so callers that accept
 * unverified tariffs (e.g. previews, tests) pass `states`.
 */
@Injectable()
export class UtilityTariffRepository {
  constructor(private readonly prisma: PrismaService) {}

  async at(
    provider: UtilityProvider,
    tariffCode: string,
    date: Date,
    states: TariffVersionState[] = ['published'],
  ): Promise<TariffVersionAt | null> {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const row = await this.prisma.utilityTariffVersion.findFirst({
      where: {
        state: { in: states },
        effectiveFrom: { lte: day },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }],
        utilityTariff: { provider, tariffCode },
      },
      orderBy: { effectiveFrom: 'desc' },
      include: { utilityTariff: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      provider: row.utilityTariff.provider,
      tariffCode: row.utilityTariff.tariffCode,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      state: row.state,
      needsCheck: row.needsCheck,
      sourceUrl: row.sourceUrl,
      structure: row.structure as unknown as UtilityTariffStructure,
    };
  }
}

import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { SettingsService } from '@core/settings/settings.service';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

/** The question of the periodic survey (version in the key: a new wording is a new key). */
export const CSAT_QUESTION = {
  key: 'csat.overall_v1',
  th: 'โดยรวมแล้ว คุณพึงพอใจกับการอยู่อาศัยและบริการของอาคารนี้มากน้อยเพียงใด',
  en: 'Overall, how satisfied are you with living here and the building’s service?',
} as const;

export interface CsatStatus {
  unitId: string;
  due: boolean;
  questionKey: string;
  question: { th: string; en: string };
  lastAnsweredAt: Date | null;
  nextDueOn: string | null;
}

function residentUser(): { userId: string; units: string[] } {
  const actor = RequestContext.actor();
  if (actor?.type !== 'user') throw new DomainException('auth.unauthenticated');
  return {
    userId: actor.publicId,
    units: actor.scopes.filter((s) => s.startsWith('unit:')).map((s) => s.slice('unit:'.length)),
  };
}

/**
 * The resident's 1-question satisfaction survey (B6.3, D-083 CSAT, D-217): offered in the LIFF for a unit when my
 * party there has not answered for `analytics.csat_survey_interval_days` (90); a 1–5 rating with an optional comment
 * stored in `platform.csat_response` and counted with the repair ratings (`csat.answered` → the `csat.rating` fact).
 */
@Injectable()
export class CsatSurveyService {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** My party on a unit of my scopes (404 otherwise) and the lease it lives under. */
  private async me(unitId: string) {
    const { userId, units } = residentUser();
    if (!units.includes(unitId)) throw new DomainException('http.not_found');
    return this.db.platform(async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { id: unitId, deletedAt: null },
        select: { tenantId: true },
      });
      if (!unit) throw new DomainException('http.not_found');
      const links = await tx.partyUserLink.findMany({
        where: { userId, state: 'active', tenantId: unit.tenantId },
        select: { partyId: true },
      });
      const today = new Date(`${bangkokDate(this.clock.now())}T00:00:00Z`);
      const occupancy = await tx.occupancy.findFirst({
        where: {
          unitId,
          partyId: { in: links.map((l) => l.partyId) },
          validFrom: { lte: today },
          OR: [{ validTo: null }, { validTo: { gte: today } }],
        },
        orderBy: { validFrom: 'desc' },
      });
      if (!occupancy) throw new DomainException('http.not_found');
      return { userId, tenantId: unit.tenantId, partyId: occupancy.partyId, leaseId: occupancy.leaseId };
    });
  }

  async status(unitId: string): Promise<CsatStatus> {
    const me = await this.me(unitId);
    const now = this.clock.now();
    const days = Number(
      (await this.settings.at('analytics.csat_survey_interval_days', now, { tenantId: me.tenantId }))
        ?.value ?? 90,
    );
    const last = await this.db.platform((tx) =>
      tx.csatResponse.findFirst({
        where: { tenantId: me.tenantId, partyId: me.partyId, questionKey: CSAT_QUESTION.key },
        orderBy: { answeredAt: 'desc' },
      }),
    );
    const next = last ? new Date(last.answeredAt.getTime() + days * 86_400_000) : null;
    return {
      unitId,
      due: !next || next.getTime() <= now.getTime(),
      questionKey: CSAT_QUESTION.key,
      question: { th: CSAT_QUESTION.th, en: CSAT_QUESTION.en },
      lastAnsweredAt: last?.answeredAt ?? null,
      nextDueOn: next ? bangkokDate(next) : null,
    };
  }

  async answer(unitId: string, rating: number, comment: string | null): Promise<CsatStatus> {
    const me = await this.me(unitId);
    if (!(await this.status(unitId)).due) throw new DomainException('csat.not_due');
    await this.db.tenant({ tenantId: me.tenantId, source: 'path' }, async (tx) => {
      const row = await tx.csatResponse.create({
        data: {
          tenantId: me.tenantId,
          partyId: me.partyId,
          unitId,
          leaseId: me.leaseId,
          questionKey: CSAT_QUESTION.key,
          rating,
          comment: comment?.trim() || null,
          answeredAt: this.clock.now(),
          answeredBy: me.userId,
        },
      });
      const unit = await tx.unit.findUniqueOrThrow({ where: { id: unitId }, select: { buildingId: true } });
      await this.events.record(tx, {
        type: 'csat.answered',
        aggregateType: 'csat_response',
        aggregateId: row.id,
        tenantId: me.tenantId,
        buildingId: unit.buildingId,
        payload: { csatResponseId: row.id, unitId, rating },
      });
    });
    return this.status(unitId);
  }
}

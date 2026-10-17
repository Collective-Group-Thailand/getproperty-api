import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { addCalendarDays } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { DomainEvents } from '@core/events/domain-events';
import { TenantTx } from '@database/tenant-tx';
import { type Prisma } from '@generated/prisma/client';
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

/**
 * The seven pilot KPIs of D-083 with their targets (the 90-day review compares the baseline captured before the
 * pilot with the current window): time to bill −80 %, bill errors < 1 %, on-time payment +10 points, ≥ 90 % payments
 * reconciled automatically, the utility loss identified, meter uptime ≥ 99.5 %, resident CSAT ≥ 4.3.
 */
export const DEFAULT_KPI_TARGETS = {
  timeToBillReductionPct: '80',
  invoiceCorrectionRatePctMax: '1',
  onTimePaymentGainPts: '10',
  autoReconciledPctMin: '90',
  lossIdentified: true,
  meterUptimePctMin: '99.5',
  csatMin: '4.3',
} as const;

/** What the owner measured before the pilot (entered by the platform with the owner, D-083). */
export interface PilotBaseline {
  timeToBillHours?: string | null;
  invoiceCorrectionRatePct?: string | null;
  onTimePaymentPct?: string | null;
  autoReconciledPct?: string | null;
  lossPct?: string | null;
  meterUptimePct?: string | null;
  csat?: string | null;
}

const by = () => userIdOf(RequestContext.actor());

/**
 * Pilot agreements (D-083): a paid pilot at a discounted rate (never free — CHECK < 100 %), reference-site rights,
 * anonymised data use per PDPA, bi-weekly feedback, the 90-day KPI review with targets and the baseline. Saving it
 * applies the discount to the tenant's open subscription (`discount_pct`, reason `pilot`).
 */
@Injectable()
export class PilotsService {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  list() {
    return this.db.platform((tx) =>
      tx.pilotAgreement.findMany({
        include: { tenant: { select: { id: true, displayName: true } } },
        orderBy: { signedAt: 'desc' },
      }),
    );
  }

  get(tenantId: string) {
    return this.db.platform(async (tx) => {
      const p = await tx.pilotAgreement.findUnique({ where: { tenantId } });
      if (!p) throw new DomainException('http.not_found');
      return p;
    });
  }

  upsert(
    tenantId: string,
    input: {
      signedAt: string;
      discountPct: string;
      termMonths: number;
      referenceSiteRights?: boolean;
      anonymisedDataUse?: boolean;
      feedbackCadence?: string;
      kpiReviewAt?: string | null;
      kpiTargets?: Record<string, unknown> | null;
      baseline?: PilotBaseline | null;
      agreementDocumentId?: string | null;
      notes?: string | null;
    },
  ) {
    const discount = new Decimal(input.discountPct);
    if (discount.lt(0) || discount.gte(100))
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'discountPct', code: 'range', message: 'a pilot is paid (D-083): 0 ≤ discount < 100' },
        ],
      });
    return this.db.platform(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
      if (!tenant) throw new DomainException('http.not_found');
      if (input.agreementDocumentId) {
        const doc = await tx.document.findFirst({
          where: { id: input.agreementDocumentId, tenantId, deletedAt: null },
        });
        if (!doc) throw new DomainException('http.not_found');
      }
      const data = {
        signedAt: new Date(`${input.signedAt}T00:00:00Z`),
        discountPct: discount.toFixed(4),
        termMonths: input.termMonths,
        referenceSiteRights: input.referenceSiteRights ?? true,
        anonymisedDataUse: input.anonymisedDataUse ?? true,
        feedbackCadence: input.feedbackCadence ?? 'biweekly',
        kpiReviewAt: new Date(`${input.kpiReviewAt ?? addCalendarDays(input.signedAt, 90)}T00:00:00Z`),
        kpiTargets: (input.kpiTargets ?? DEFAULT_KPI_TARGETS) as Prisma.InputJsonValue,
        baseline: (input.baseline ?? {}) as Prisma.InputJsonValue,
        agreementDocumentId: input.agreementDocumentId ?? null,
        notes: input.notes ?? null,
      };
      const before = await tx.pilotAgreement.findUnique({ where: { tenantId } });
      const pilot = before
        ? await tx.pilotAgreement.update({
            where: { tenantId },
            data: { ...data, updatedBy: by(), version: { increment: 1 } },
          })
        : await tx.pilotAgreement.create({ data: { ...data, tenantId, createdBy: by() } });
      const sub = await tx.subscription.findFirst({
        where: { tenantId, state: { in: ['trial', 'active', 'past_due', 'suspended'] } },
      });
      if (sub)
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            discountPct: pilot.discountPct,
            discountReason: 'pilot',
            pilotAgreementId: pilot.id,
            updatedBy: by(),
            version: { increment: 1 },
          },
        });
      await this.audit.record(tx, {
        action: 'pilot_agreement.saved',
        tenantId,
        subjectType: 'platform.pilot_agreement',
        subjectId: pilot.id,
        before: before
          ? { discountPct: before.discountPct.toString(), termMonths: before.termMonths }
          : undefined,
        after: {
          discountPct: pilot.discountPct.toString(),
          termMonths: pilot.termMonths,
          subscriptionId: sub?.id ?? null,
        },
      });
      await this.events.record(tx, {
        type: 'pilot_agreement.saved',
        aggregateType: 'pilot_agreement',
        aggregateId: pilot.id,
        tenantId,
        payload: { pilotAgreementId: pilot.id, discountPct: pilot.discountPct.toString() },
      });
      return pilot;
    });
  }
}

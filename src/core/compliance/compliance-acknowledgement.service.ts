import { actorEnvelope, userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { DomainException } from '@common/errors/domain.exception';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type ComplianceAcknowledgement,
  type ComplianceEvaluation,
  type ComplianceOutcome,
  type ComplianceSeverity,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { DomainEvents } from '../events/domain-events';
import { COMPLIANCE_RULES } from './rules';

/** Version of the warning text shown with an acknowledgement (legal-reference §4; ⚖ wording, D-021a). */
export const LEGAL_TEXT_VERSIONS: Record<string, number> = { 'compliance.tariff_cap.warning': 1 };

export interface EvaluationInput {
  ruleId: string;
  buildingId?: string | null;
  subjectType: string;
  subjectId: string;
  outcome: ComplianceOutcome;
  severityApplied: ComplianceSeverity;
  /** Values compared, setting versions, tariff version, consumption; `shown` = what the warning displays. */
  context: Record<string, unknown> & { shown?: Record<string, unknown> };
}

/**
 * Compliance evaluations ⟲ and acknowledgements ⟲ (D-021a, legal-reference §4; schema-design §3.2.8). A `warn`
 * evaluation that needs the Owner's acknowledgement is answered with **409 `compliance.acknowledgement_required`**
 * (contract §3) carrying the rule, its legal reference, the evaluation id and the values shown; the client calls
 * `acknowledge()` (who, when, IP, user agent, rule, values shown, legal text version) and repeats the request with
 * the acknowledgement id, which `assertAcknowledged()` checks. Used by rate plans (B4.2).
 */
@Injectable()
export class ComplianceAcknowledgementService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  static legalRef(ruleId: string): string {
    const rule = COMPLIANCE_RULES.find((r) => r.id === ruleId);
    if (!rule) throw new Error(`unknown compliance rule ${ruleId}`);
    return rule.legalRef;
  }

  /** Records an evaluation in the caller's tenant transaction. */
  evaluate(tx: Tx, ctx: TenantContext, input: EvaluationInput): Promise<ComplianceEvaluation> {
    return tx.complianceEvaluation.create({
      data: {
        tenantId: ctx.tenantId,
        buildingId: input.buildingId ?? null,
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        outcome: input.outcome,
        severityApplied: input.severityApplied,
        context: input.context as Prisma.InputJsonValue,
        legalRef: ComplianceAcknowledgementService.legalRef(input.ruleId),
        actor: actorEnvelope(RequestContext.actor()),
        occurredAt: this.clock.now(),
      },
    });
  }

  /** The 409 problem for a warning that needs an acknowledgement. */
  static required(evaluation: ComplianceEvaluation): DomainException {
    const context = evaluation.context as { shown?: Record<string, unknown> };
    return new DomainException('compliance.acknowledgement_required', {
      extensions: {
        ruleId: evaluation.ruleId,
        legalRef: evaluation.legalRef,
        evaluationId: evaluation.id,
        shown: context.shown ?? {},
      },
    });
  }

  /** `POST /v1/owner/compliance-acknowledgements`: the Owner acknowledges a `warn` evaluation. */
  async acknowledge(
    ctx: TenantContext,
    input: { evaluationId: string; legalTextKey: string; legalTextVersion: number; language: string },
  ): Promise<ComplianceAcknowledgement> {
    const actorId = userIdOf(RequestContext.actor());
    if (!actorId) throw new DomainException('auth.unauthenticated');
    const expected = LEGAL_TEXT_VERSIONS[input.legalTextKey];
    if (expected === undefined || expected !== input.legalTextVersion)
      throw new DomainException('validation.failed', {
        errors: [
          {
            path: 'legalTextVersion',
            code: 'current',
            message: 'acknowledge the current version of the warning text',
          },
        ],
      });
    const request = RequestContext.current();
    return this.db.tenant(ctx, async (tx) => {
      const evaluation = this.found(
        await tx.complianceEvaluation.findFirst({ where: this.own(ctx, { id: input.evaluationId }) }),
      );
      if (evaluation.outcome !== 'warn') throw new DomainException('http.conflict');
      const ack = await tx.complianceAcknowledgement.create({
        data: {
          tenantId: ctx.tenantId,
          buildingId: evaluation.buildingId,
          ruleId: evaluation.ruleId,
          evaluationId: evaluation.id,
          subjectType: evaluation.subjectType,
          subjectId: evaluation.subjectId,
          acknowledgedBy: actorId,
          acknowledgedAt: this.clock.now(),
          ip: request?.ip ?? null,
          userAgent: request?.userAgent ?? null,
          shown: (evaluation.context as { shown?: Prisma.InputJsonValue }).shown ?? {},
          legalTextKey: input.legalTextKey,
          legalTextVersion: input.legalTextVersion,
          language: input.language,
        },
      });
      await this.audit.record(tx, {
        action: 'compliance.acknowledged',
        tenantId: ctx.tenantId,
        buildingId: evaluation.buildingId,
        subjectType: 'platform.compliance_acknowledgement',
        subjectId: ack.id,
        after: {
          ruleId: ack.ruleId,
          evaluationId: evaluation.id,
          subjectType: ack.subjectType,
          subjectId: ack.subjectId,
        },
      });
      await this.events.record(tx, {
        type: 'compliance.acknowledged',
        aggregateType: 'compliance_acknowledgement',
        aggregateId: ack.id,
        tenantId: ctx.tenantId,
        buildingId: evaluation.buildingId,
        payload: {
          acknowledgementId: ack.id,
          ruleId: ack.ruleId,
          subjectType: ack.subjectType,
          subjectId: ack.subjectId,
        },
      });
      return ack;
    });
  }

  /** Inside a later request: the acknowledgement must exist in the tenant and match the rule and subject. */
  async assertAcknowledged(
    tx: Tx,
    ctx: TenantContext,
    acknowledgementId: string | undefined,
    expect: { ruleId: string; subjectType: string; subjectId: string },
  ): Promise<ComplianceAcknowledgement | null> {
    if (!acknowledgementId) return null;
    const ack = await tx.complianceAcknowledgement.findFirst({
      where: this.own(ctx, { id: acknowledgementId }),
    });
    if (
      !ack ||
      ack.ruleId !== expect.ruleId ||
      ack.subjectType !== expect.subjectType ||
      ack.subjectId !== expect.subjectId
    )
      return null;
    return ack;
  }

  get(ctx: TenantContext, id: string) {
    return this.db.tenant(ctx, async (tx) =>
      this.found(await tx.complianceAcknowledgement.findFirst({ where: this.own(ctx, { id }) })),
    );
  }
}

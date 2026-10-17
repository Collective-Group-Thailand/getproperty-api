import { type TenantContext } from '@common/context/tenant-context';
import { ComplianceException } from '@common/errors/compliance.exception';
import { DomainException } from '@common/errors/domain.exception';
import { type ComplianceCode } from '@common/errors/error-codes';
import { type ProblemFieldError } from '@common/errors/problem-details.dto';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { SETTINGS } from '../settings/catalogue';
import { SettingsService } from '../settings/settings.service';
import { ComplianceAcknowledgementService, LEGAL_TEXT_VERSIONS } from './compliance-acknowledgement.service';
import { COMPLIANCE_RULES } from './rules';

/** One rule checked against one subject (a pure evaluator returns these). */
export interface RuleCheck {
  ruleId: ComplianceCode;
  /** true = the rule is broken by the subject. */
  violated: boolean;
  /** Values compared (recorded with the evaluation as evidence). */
  context: Record<string, unknown>;
  /** Field errors for a refusal (problem `errors[]`). */
  errors?: ProblemFieldError[];
  /** What a warning shows the Owner (acknowledgement). */
  shown?: Record<string, unknown>;
}

export interface GateResult {
  inScope: boolean;
  checks: {
    ruleId: string;
    outcome: 'pass' | 'warn' | 'block';
    severity: 'warn' | 'block';
    acknowledgementId?: string;
  }[];
  evaluatedAt: string;
}

/**
 * Applies the compliance rule registry to checks computed by a module (D-020, D-021a semantics, D-158 scope;
 * ADR-0007 lands in B4.1 and reuses this). For each check: the effective severity is the setting
 * `<ruleId>.severity` when the catalogue defines one (platform, overridable per tenant), else the rule's default;
 * a violated `block` rule is refused with 422 `compliance.*` + `legalRef`; a violated `warn` rule needs the Owner's
 * acknowledgement — 409 `compliance.acknowledgement_required` with the evaluation id, then the request is repeated
 * with the acknowledgement id. Rules apply only while the tenant is in scope of the announcement
 * (`tenant.subject_to_ocpb_2568`, D-158). Every outcome other than a plain pass is recorded in
 * `platform.compliance_evaluation` in its own transaction, so refusals stay on record (evidence for disputes).
 */
@Injectable()
export class ComplianceGate {
  constructor(
    private readonly db: TenantTx,
    private readonly settings: SettingsService,
    private readonly acknowledgements: ComplianceAcknowledgementService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async inScope(tenantId: string, at: Date): Promise<boolean> {
    const v = await this.settings.at('tenant.subject_to_ocpb_2568', at, { tenantId });
    return v?.value !== false;
  }

  async severity(ruleId: string, tenantId: string, at: Date): Promise<'warn' | 'block'> {
    const key = `${ruleId}.severity`;
    if (SETTINGS.some((s) => s.key === key)) {
      const v = await this.settings.at(key, at, { tenantId });
      if (v?.value === 'warn' || v?.value === 'block') return v.value;
    }
    const rule = COMPLIANCE_RULES.find((r) => r.id === ruleId);
    if (!rule) throw new Error(`unknown compliance rule ${ruleId}`);
    return rule.defaultSeverity;
  }

  /**
   * Checks, records and enforces. `acknowledgementIds` are the client's acknowledgements of earlier warnings for the
   * same subject. `refuseWarnings` turns warnings into refusals (actors who cannot acknowledge, e.g. residents).
   */
  async enforce(
    ctx: TenantContext,
    input: {
      subjectType: string;
      subjectId: string;
      buildingId?: string | null;
      checks: RuleCheck[];
      acknowledgementIds?: string[];
      refuseWarnings?: boolean;
    },
  ): Promise<GateResult> {
    const now = this.clock.now();
    const inScope = await this.inScope(ctx.tenantId, now);
    const result: GateResult = { inScope, checks: [], evaluatedAt: now.toISOString() };
    if (!inScope) {
      result.checks = input.checks.map((c) => ({ ruleId: c.ruleId, outcome: 'pass', severity: 'warn' }));
      return result;
    }
    let refusal: { check: RuleCheck } | null = null;
    let needsAck: { evaluationId: string; check: RuleCheck } | null = null;
    await this.db.tenant(ctx, async (tx) => {
      for (const check of input.checks) {
        const severity = await this.severity(check.ruleId, ctx.tenantId, now);
        if (!check.violated) {
          result.checks.push({ ruleId: check.ruleId, outcome: 'pass', severity });
          continue;
        }
        const warn = severity === 'warn' && !input.refuseWarnings;
        let ackId: string | undefined;
        if (warn)
          for (const id of input.acknowledgementIds ?? []) {
            const ack = await this.acknowledgements.assertAcknowledged(tx, ctx, id, {
              ruleId: check.ruleId,
              subjectType: input.subjectType,
              subjectId: input.subjectId,
            });
            if (ack) ackId = ack.id;
          }
        const evaluation = await this.acknowledgements.evaluate(tx, ctx, {
          ruleId: check.ruleId,
          buildingId: input.buildingId ?? null,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          outcome: warn ? 'warn' : 'block',
          severityApplied: severity,
          context: {
            ...check.context,
            ...(check.shown ? { shown: check.shown } : {}),
            ...(ackId ? { acknowledgementId: ackId } : {}),
            ...(input.refuseWarnings && severity === 'warn' ? { refusedWarning: true } : {}),
          },
        });
        result.checks.push({
          ruleId: check.ruleId,
          outcome: warn ? 'warn' : 'block',
          severity,
          ...(ackId ? { acknowledgementId: ackId } : {}),
        });
        if (!warn) refusal ??= { check };
        else if (!ackId) needsAck ??= { evaluationId: evaluation.id, check };
      }
    });
    if (refusal) {
      const { check } = refusal as { check: RuleCheck };
      throw new ComplianceException(
        check.ruleId,
        { legalRef: ComplianceAcknowledgementService.legalRef(check.ruleId) },
        {
          errors: check.errors,
        },
      );
    }
    if (needsAck) {
      const { evaluationId, check } = needsAck as { evaluationId: string; check: RuleCheck };
      throw new DomainException('compliance.acknowledgement_required', {
        extensions: {
          ruleId: check.ruleId,
          legalRef: ComplianceAcknowledgementService.legalRef(check.ruleId),
          evaluationId,
          legalTextKey: `${check.ruleId}.warning`,
          legalTextVersion: LEGAL_TEXT_VERSIONS[`${check.ruleId}.warning`] ?? 1,
          shown: check.shown ?? check.context,
        },
        errors: check.errors,
      });
    }
    return result;
  }
}

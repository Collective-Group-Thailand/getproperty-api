import { type TenantContext } from '@common/context/tenant-context';
import { ComplianceException } from '@common/errors/compliance.exception';
import { DomainException } from '@common/errors/domain.exception';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { SETTINGS } from '../settings/catalogue';
import { SettingsService } from '../settings/settings.service';
import { ComplianceAcknowledgementService, LEGAL_TEXT_VERSIONS } from './compliance-acknowledgement.service';
import { type RuleCheck } from './evaluators';
import { COMPLIANCE_RULES } from './rules';

export type { RuleCheck } from './evaluators';

export type ComplianceSeverityName = 'warn' | 'block';
export type ComplianceOutcomeName = 'pass' | 'warn' | 'block';

/** Setting holding the platform admin's per-rule severity overrides (platform-wide or per tenant, D-021a). */
export const SEVERITY_OVERRIDES_KEY = 'compliance.severity_overrides';

/**
 * The D-021a semantics in one pure function (ADR-0007): a rule that is not broken passes; a broken `block` rule is
 * refused; a broken `warn` rule warns (the Owner acknowledges it and repeats the request) unless the actor cannot
 * acknowledge (`refuseWarnings`, e.g. residents), when it is refused too.
 */
export function outcomeOf(
  violated: boolean,
  severity: ComplianceSeverityName,
  options: { refuseWarnings?: boolean } = {},
): ComplianceOutcomeName {
  if (!violated) return 'pass';
  return severity === 'warn' && !options.refuseWarnings ? 'warn' : 'block';
}

/** The severity in force: a rule-specific setting (`<ruleId>.severity`), the overrides map, else the default. */
export function effectiveSeverity(
  ruleId: string,
  sources: { specific?: unknown; overrides?: unknown },
): ComplianceSeverityName {
  if (sources.specific === 'warn' || sources.specific === 'block') return sources.specific;
  const o = sources.overrides as Record<string, unknown> | null | undefined;
  const fromMap = o && typeof o === 'object' ? o[ruleId] : undefined;
  if (fromMap === 'warn' || fromMap === 'block') return fromMap;
  const rule = COMPLIANCE_RULES.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`unknown compliance rule ${ruleId}`);
  return rule.defaultSeverity;
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

  /**
   * Effective severity of a rule for a tenant at an instant (D-021a): the rule's own setting where the catalogue has
   * one (`compliance.tariff_cap.severity`), else the platform admin's `compliance.severity_overrides` map (tenant
   * version over platform version), else the registry default.
   */
  async severity(ruleId: string, tenantId: string, at: Date): Promise<ComplianceSeverityName> {
    const key = `${ruleId}.severity`;
    const specific = SETTINGS.some((s) => s.key === key)
      ? (await this.settings.at(key, at, { tenantId }))?.value
      : undefined;
    const overrides = (await this.settings.at(SEVERITY_OVERRIDES_KEY, at, { tenantId }))?.value;
    return effectiveSeverity(ruleId, { specific, overrides });
  }

  /** Severity in force platform-wide (no tenant version), for the admin view. */
  async platformSeverity(ruleId: string, at: Date): Promise<ComplianceSeverityName> {
    const key = `${ruleId}.severity`;
    const specific = SETTINGS.some((s) => s.key === key)
      ? (await this.settings.at(key, at))?.value
      : undefined;
    const overrides = (await this.settings.at(SEVERITY_OVERRIDES_KEY, at))?.value;
    return effectiveSeverity(ruleId, { specific, overrides });
  }

  /**
   * Dry run of `enforce` (web F2 lease wizard, D-208): the outcome each check would have now — severity in force,
   * legal reference, field errors — without recording an evaluation or asking for an acknowledgement.
   */
  async preview(
    tenantId: string,
    checks: RuleCheck[],
  ): Promise<{
    inScope: boolean;
    checks: (RuleCheck & {
      outcome: ComplianceOutcomeName;
      severity: ComplianceSeverityName;
      legalRef: string;
    })[];
  }> {
    const now = this.clock.now();
    const inScope = await this.inScope(tenantId, now);
    const out = [];
    for (const check of checks) {
      const severity = await this.severity(check.ruleId, tenantId, now);
      out.push({
        ...check,
        outcome: inScope ? outcomeOf(check.violated, severity) : ('pass' as const),
        severity,
        legalRef: ComplianceAcknowledgementService.legalRef(check.ruleId),
      });
    }
    return { inScope, checks: out };
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
        const warn = outcomeOf(true, severity, input) === 'warn';
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

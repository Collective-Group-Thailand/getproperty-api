import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../clock/clock';
import { ComplianceGate } from './compliance-gate.service';
import { COMPLIANCE_RULES } from './rules';

export interface RuleView {
  id: string;
  legalRef: string;
  defaultSeverity: 'warn' | 'block';
  severity: 'warn' | 'block';
  appliesTo: string[];
  status: string;
  descriptionTh: string;
  descriptionEn: string;
  settingsUsed: string[];
}

/**
 * The registry as the owner console and the platform admin see it (ADR-0007): each rule with its legal reference,
 * the severity in force (for one tenant, or platform-wide) and its legal-verification status from
 * `platform.compliance_rule` (D-149).
 */
@Injectable()
export class ComplianceRulesService {
  constructor(
    private readonly db: TenantTx,
    private readonly gate: ComplianceGate,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(tenantId: string | null): Promise<{ inScope: boolean; rules: RuleView[] }> {
    const now = this.clock.now();
    const stored = await this.db.platform((tx) =>
      tx.complianceRule.findMany({ select: { id: true, status: true } }),
    );
    const status = new Map(stored.map((r) => [r.id, r.status as string]));
    const rules: RuleView[] = [];
    for (const r of COMPLIANCE_RULES)
      rules.push({
        id: r.id,
        legalRef: r.legalRef,
        defaultSeverity: r.defaultSeverity,
        severity: tenantId
          ? await this.gate.severity(r.id, tenantId, now)
          : await this.gate.platformSeverity(r.id, now),
        appliesTo: [...r.appliesTo],
        status: status.get(r.id) ?? 'pending_legal_verification',
        descriptionTh: r.descriptionTh,
        descriptionEn: r.descriptionEn,
        settingsUsed: [...r.settingsUsed],
      });
    return { inScope: tenantId ? await this.gate.inScope(tenantId, now) : true, rules };
  }
}

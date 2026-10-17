import { CurrentTenant, TenantScoped } from '@common/auth/auth.decorators';
import { Can } from '@common/auth/can.decorator';
import { type TenantContext } from '@common/context/tenant-context';
import { ApiEndpoint, ApiStandardErrors, ApiSuccess } from '@common/openapi/decorators';
import { FAKE } from '@common/openapi/examples';
import { ComplianceRulesService, type RuleView } from '@core/compliance/compliance-rules.service';
import { ComplianceScoreService } from '@core/compliance/compliance-score.service';
import { type ComplianceScore } from '@generated/prisma/client';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { iso } from '../shared/mappers';
import { ApiSurface, SURFACES } from '../surfaces';
import {
  type ComplianceRuleDto,
  ComplianceRuleListDto,
  type ComplianceRuleStatusName,
  type ComplianceRuleTargetName,
  type ComplianceScoreComponentDto,
  ComplianceScoreDto,
  ComplianceScoreListDto,
  ComplianceScoreQuery,
  type ComplianceSeverityName,
} from './compliance.dto';

const T = ['tenant.context_required', 'tenant.context_invalid', 'tenant.not_in_scope'] as const;

export function ruleDto(r: RuleView): ComplianceRuleDto {
  return {
    id: r.id,
    legalRef: r.legalRef,
    defaultSeverity: r.defaultSeverity as ComplianceSeverityName,
    severity: r.severity as ComplianceSeverityName,
    appliesTo: r.appliesTo as ComplianceRuleTargetName[],
    status: r.status as ComplianceRuleStatusName,
    descriptionTh: r.descriptionTh,
    descriptionEn: r.descriptionEn,
    settingsUsed: r.settingsUsed,
  };
}

export function scoreDto(s: ComplianceScore): ComplianceScoreDto {
  const details = s.details as { components?: ComplianceScoreComponentDto[] };
  return {
    month: s.month.toISOString().slice(0, 7),
    score: s.score.toFixed(2),
    invoicesTotal: s.invoicesTotal,
    invoicesWithinRate: s.invoicesWithinRate,
    linesAboveCap: s.linesAboveCap,
    linesAboveCapAcknowledged: s.linesAboveCapAcknowledged,
    depositsDue: s.depositsDue,
    depositsRefundedOnTime: s.depositsRefundedOnTime,
    leasesTotal: s.leasesTotal,
    leasesOnStandardTemplate: s.leasesOnStandardTemplate,
    components: details.components ?? [],
    computedAt: iso(s.computedAt),
  };
}

const RULE_EXAMPLE: ComplianceRuleDto = {
  id: 'compliance.tariff_cap',
  legalRef: 'ประกาศ คกก.ว่าด้วยสัญญา 2568 ข้อ 5 (6); legal-reference §1 ค่าน้ำ/ค่าไฟ, §4; D-021a, D-140',
  defaultSeverity: 'warn' as ComplianceSeverityName,
  severity: 'warn' as ComplianceSeverityName,
  appliesTo: ['rate_plan', 'invoice'] as ComplianceRuleTargetName[],
  status: 'pending_legal_verification' as ComplianceRuleStatusName,
  descriptionTh: 'อัตราค่าไฟฟ้า/ค่าน้ำต้องไม่เกินอัตราที่ผู้ให้บริการเรียกเก็บ (เฉลี่ยตามหน่วยที่ใช้)',
  descriptionEn:
    'Electricity/water rates above the utility’s effective average rate trigger the legal warning.',
  settingsUsed: ['compliance.tariff_cap.severity'],
};

export const SCORE_EXAMPLE: ComplianceScoreDto = {
  month: '2026-11',
  score: '97.50',
  invoicesTotal: 120,
  invoicesWithinRate: 118,
  linesAboveCap: 2,
  linesAboveCapAcknowledged: 2,
  depositsDue: 3,
  depositsRefundedOnTime: 3,
  leasesTotal: 120,
  leasesOnStandardTemplate: 108,
  components: [
    { key: 'invoices_within_rate', numerator: 118, denominator: 120, ratio: '0.9833' },
    { key: 'above_cap_acknowledged', numerator: 2, denominator: 2, ratio: '1.0000' },
    { key: 'deposits_on_time', numerator: 3, denominator: 3, ratio: '1.0000' },
    { key: 'standard_contracts', numerator: 108, denominator: 120, ratio: '0.9000' },
  ] as ComplianceScoreComponentDto[],
  computedAt: FAKE.dateTime,
};

@ApiTags('owner.compliance')
@ApiSurface(SURFACES.owner)
@Controller('owner/compliance')
export class OwnerComplianceController {
  constructor(
    private readonly rules: ComplianceRulesService,
    private readonly scores: ComplianceScoreService,
  ) {}

  @Get('rules')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.compliance.rules',
    summary: 'Compliance rules in force for my tenant',
    description:
      'The compliance registry (ADR-0007): every rule with its legal reference (legal-reference.md, D-149), the subjects it applies to, its default severity and the severity in force for this tenant — `warn` rules need the Owner’s acknowledgement, `block` rules refuse (D-021a). `inScope` = the tenant is subject to the สคบ. 2568 announcement (≥ 3 units, D-158).',
    implements: ['D-020', 'D-021a', 'D-149', 'D-158'],
  })
  @ApiSuccess(200, {
    description: 'Rules',
    type: ComplianceRuleListDto,
    example: { inScope: true, data: [RULE_EXAMPLE] },
  })
  @ApiStandardErrors(...T)
  async list(@CurrentTenant() ctx: TenantContext): Promise<ComplianceRuleListDto> {
    const r = await this.rules.list(ctx.tenantId);
    return { inScope: r.inScope, data: r.rules.map(ruleDto) };
  }

  @Get('score')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.compliance.score',
    summary: 'Compliance score of a month',
    description:
      'Recomputes and returns the tenant’s compliance score of the month (`platform.compliance_score`, ADR-0007): invoices within the utility rate, lines above the cap acknowledged (D-021a), deposits refunded on time (D-023), leases on the สคบ. standard template (D-020); the mean of the judged components × 100.',
    implements: ['D-020', 'D-021a', 'D-023'],
  })
  @ApiSuccess(200, { description: 'Score', type: ComplianceScoreDto, example: SCORE_EXAMPLE })
  @ApiStandardErrors('validation.failed', ...T)
  async score(
    @CurrentTenant() ctx: TenantContext,
    @Query() q: ComplianceScoreQuery,
  ): Promise<ComplianceScoreDto> {
    return scoreDto(await this.scores.compute(ctx.tenantId, q.month ?? this.scores.currentMonth()));
  }

  @Get('scores')
  @TenantScoped()
  @Can('report.read')
  @ApiEndpoint({
    id: 'owner.compliance.scores',
    summary: 'Compliance score history',
    description:
      'Stored monthly scores, newest first (the last 12 months computed by the nightly job or on request, ADR-0007).',
    implements: ['D-020', 'D-021a'],
  })
  @ApiSuccess(200, {
    description: 'History',
    type: ComplianceScoreListDto,
    example: { data: [SCORE_EXAMPLE] },
  })
  @ApiStandardErrors(...T)
  async history(@CurrentTenant() ctx: TenantContext): Promise<ComplianceScoreListDto> {
    return { data: (await this.scores.history(ctx.tenantId)).map(scoreDto) };
  }
}

@ApiTags('admin.compliance')
@ApiSurface(SURFACES.admin)
@Controller('admin/compliance')
export class AdminComplianceController {
  constructor(private readonly rules: ComplianceRulesService) {}

  @Get('rules')
  @Can('admin.compliance.manage')
  @ApiEndpoint({
    id: 'admin.compliance.rules',
    summary: 'Compliance registry with platform severities',
    description:
      'Every rule of the registry with its legal reference, legal-verification status (D-149) and the severity in force platform-wide. Severities are changed through the settings `compliance.tariff_cap.severity` and `compliance.severity_overrides` (platform or per tenant, D-021a).',
    implements: ['D-021a', 'D-149', 'ADR-0007'],
  })
  @ApiSuccess(200, {
    description: 'Rules',
    type: ComplianceRuleListDto,
    example: { inScope: true, data: [RULE_EXAMPLE] },
  })
  @ApiStandardErrors()
  async list(): Promise<ComplianceRuleListDto> {
    const r = await this.rules.list(null);
    return { inScope: r.inScope, data: r.rules.map(ruleDto) };
  }
}

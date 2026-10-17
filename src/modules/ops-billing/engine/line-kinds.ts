/**
 * The invoice line kind catalogue (D-041; `ops.invoice_line_kind_rule`, seeded from here): the source type each kind
 * is billed under (`invoice_line.source_type`, D-151), whether it needs a lease line or a meter, the compliance rule
 * that guards it and the setting that must allow it. The engine never emits a kind outside this table.
 */
export type SourceType =
  'rent' | 'meter' | 'common_fee' | 'fund' | 'penalty' | 'service' | 'deposit' | 'adjustment';
export type LineKind =
  | 'rent'
  | 'electricity'
  | 'water'
  | 'internet'
  | 'parking'
  | 'cleaning'
  | 'furniture'
  | 'common_fee'
  | 'fund'
  | 'water_minimum'
  | 'other_fixed'
  | 'one_off'
  | 'late_fee'
  | 'estimate_settlement'
  | 'prior_balance'
  | 'discount'
  | 'deposit_offset'
  | 'service_charge_work';

export interface LineKindRule {
  lineKind: LineKind;
  sourceType: SourceType;
  requiresLeaseLine: boolean;
  requiresMeter: boolean;
  complianceRuleId: string | null;
  allowedWhenSetting: string | null;
  description: string;
}

export const LINE_KIND_RULES: readonly LineKindRule[] = [
  {
    lineKind: 'rent',
    sourceType: 'rent',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: 'compliance.no_midterm_increase',
    allowedWhenSetting: null,
    description: 'Rent of the lease, pro-rata by calendar days for partial periods (D-041).',
  },
  {
    lineKind: 'electricity',
    sourceType: 'meter',
    requiresLeaseLine: false,
    requiresMeter: true,
    complianceRuleId: 'compliance.tariff_cap',
    allowedWhenSetting: null,
    description:
      'Electricity from cumulative registers × the rate plan; compared with the utility rate (D-021a, D-022, D-030).',
  },
  {
    lineKind: 'water',
    sourceType: 'meter',
    requiresLeaseLine: false,
    requiresMeter: true,
    complianceRuleId: 'compliance.tariff_cap',
    allowedWhenSetting: null,
    description:
      'Water from cumulative registers × the rate plan; compared with the utility rate (D-021a, D-022, D-030).',
  },
  {
    lineKind: 'internet',
    sourceType: 'service',
    requiresLeaseLine: true,
    requiresMeter: false,
    complianceRuleId: 'compliance.bill_disclosure',
    allowedWhenSetting: null,
    description: 'Internet as agreed in the lease (fixed amount, D-041).',
  },
  {
    lineKind: 'parking',
    sourceType: 'service',
    requiresLeaseLine: true,
    requiresMeter: false,
    complianceRuleId: 'compliance.bill_disclosure',
    allowedWhenSetting: null,
    description: 'Parking as agreed in the lease (fixed amount, D-041).',
  },
  {
    lineKind: 'cleaning',
    sourceType: 'service',
    requiresLeaseLine: true,
    requiresMeter: false,
    complianceRuleId: 'compliance.bill_disclosure',
    allowedWhenSetting: null,
    description: 'Cleaning as agreed in the lease (fixed amount, D-041).',
  },
  {
    lineKind: 'furniture',
    sourceType: 'service',
    requiresLeaseLine: true,
    requiresMeter: false,
    complianceRuleId: 'compliance.bill_disclosure',
    allowedWhenSetting: null,
    description: 'Furniture rental as agreed in the lease (fixed amount, D-041).',
  },
  {
    lineKind: 'common_fee',
    sourceType: 'common_fee',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: 'compliance.bill_disclosure',
    allowedWhenSetting: null,
    description:
      'Common fee from a lease line or a common-fee rate plan (per m² or by ownership ratio for condos, D-151).',
  },
  {
    lineKind: 'fund',
    sourceType: 'fund',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: null,
    allowedWhenSetting: null,
    description: 'Sinking fund contribution from a fund rate plan (condo, Phase 2, D-151).',
  },
  {
    lineKind: 'water_minimum',
    sourceType: 'adjustment',
    requiresLeaseLine: true,
    requiresMeter: false,
    complianceRuleId: 'compliance.water_minimum',
    allowedWhenSetting: null,
    description:
      'Top-up to the water minimum charge agreed in the lease, never above the utility minimum (D-141).',
  },
  {
    lineKind: 'other_fixed',
    sourceType: 'service',
    requiresLeaseLine: true,
    requiresMeter: false,
    complianceRuleId: 'compliance.bill_disclosure',
    allowedWhenSetting: null,
    description: 'Another fixed monthly service agreed in the lease (never a utility, D-022).',
  },
  {
    lineKind: 'one_off',
    sourceType: 'service',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: 'compliance.no_renewal_fee',
    allowedWhenSetting: null,
    description: 'A one-off item queued for the period (keys, agreed damage, …; never a renewal fee).',
  },
  {
    lineKind: 'late_fee',
    sourceType: 'penalty',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: 'compliance.late_fee_policy',
    allowedWhenSetting: 'late_fee.enabled',
    description: 'Late fee assessed on an overdue invoice, added to the next invoice only (D-045, ⚖ O-002).',
  },
  {
    lineKind: 'estimate_settlement',
    sourceType: 'meter',
    requiresLeaseLine: false,
    requiresMeter: true,
    complianceRuleId: 'compliance.tariff_cap',
    allowedWhenSetting: null,
    description:
      'Difference between an estimated consumption and the actual one, at the estimated line’s price (D-012, D-031).',
  },
  {
    lineKind: 'prior_balance',
    sourceType: 'adjustment',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: null,
    allowedWhenSetting: null,
    description: 'Reserved: prior balance is shown in the invoice snapshot, not as a line (D-193).',
  },
  {
    lineKind: 'discount',
    sourceType: 'adjustment',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: null,
    allowedWhenSetting: null,
    description: 'A discount granted by the owner (negative amount).',
  },
  {
    lineKind: 'deposit_offset',
    sourceType: 'deposit',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: 'compliance.no_forfeiture',
    allowedWhenSetting: null,
    description: 'Advance rent applied to the final invoice at move-out (negative amount, D-023, D-177).',
  },
  {
    lineKind: 'service_charge_work',
    sourceType: 'service',
    requiresLeaseLine: false,
    requiresMeter: false,
    complianceRuleId: null,
    allowedWhenSetting: null,
    description: 'Billable work-order cost (B5, R2).',
  },
];

export const sourceTypeOf = (kind: LineKind): SourceType => {
  const r = LINE_KIND_RULES.find((x) => x.lineKind === kind);
  if (!r) throw new Error(`unknown invoice line kind ${kind}`);
  return r.sourceType;
};

/** Lease line kinds (B2.3) → invoice line kinds. */
export const LEASE_LINE_KIND: Record<string, LineKind> = {
  internet: 'internet',
  parking: 'parking',
  cleaning: 'cleaning',
  furniture: 'furniture',
  common_fee: 'common_fee',
  water_minimum: 'water_minimum',
  other_fixed: 'other_fixed',
};

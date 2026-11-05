import {
  type BuildingLegalForm,
  type CollectionAction,
  type CollectionChannel,
} from '@generated/prisma/client';

/**
 * Collections ladder templates (D-305 = D-J04, D-326): one per building legal form, in code like the workflow
 * definitions. A tenant's ladder is copied from its legal form's template the first time it is needed and is then the
 * tenant's own data (owner / manager edit offsets, channels, approval, enabled). Offsets are calendar days after the
 * due date of the case's oldest overdue invoice.
 *
 * Every step except `remind` is a legal measure whose rule is `pending_legal_verification` (docs/juristic-gap.md §6,
 * O-038): it ships **disabled**, the API flags it `legalReviewRequired`, and it can only be enabled / run while its
 * gate (below) is open. `suspend_services`, `lawyer_letter` and `legal_action` always need an approval
 * (manager / committee / owner). No step ever cuts utilities or access (D-024, D-157,
 * `compliance.juristic.no_utility_cutoff`).
 */
export interface TemplateStep {
  seq: number;
  offsetDays: number;
  action: CollectionAction;
  channels: CollectionChannel[];
  templateKey: string;
  requiresApproval: boolean;
  enabled: boolean;
}

export interface LadderTemplate {
  key: string;
  legalForm: BuildingLegalForm;
  nameTh: string;
  steps: TemplateStep[];
}

export const LEGAL_REVIEW_ACTIONS: readonly CollectionAction[] = [
  'surcharge',
  'notice_letter',
  'suspend_services',
  'lawyer_letter',
  'legal_action',
];
export const APPROVAL_ACTIONS: readonly CollectionAction[] = [
  'suspend_services',
  'lawyer_letter',
  'legal_action',
];

/** Whether a step's action rests on a rule still waiting for counsel (O-038): the UI shows the legal-review badge. */
export const legalReviewRequired = (action: CollectionAction): boolean =>
  LEGAL_REVIEW_ACTIONS.includes(action);
/** Whether a step of this action must always be approved before it runs (D-305). */
export const approvalForced = (action: CollectionAction): boolean => APPROVAL_ACTIONS.includes(action);

const DIGITAL: CollectionChannel[] = ['line', 'email'];
const step = (
  seq: number,
  offsetDays: number,
  action: CollectionAction,
  channels: CollectionChannel[] = DIGITAL,
): TemplateStep => ({
  seq,
  offsetDays,
  action,
  channels,
  templateKey: `juristic.collection.${action === 'remind' ? 'reminder' : action}`,
  requiresApproval: approvalForced(action),
  enabled: action === 'remind',
});

const STATUTORY = (legalForm: 'condo_act' | 'land_allocation_act', nameTh: string): LadderTemplate => ({
  key: `${legalForm}.v1`,
  legalForm,
  nameTh,
  steps: [
    step(1, 3, 'remind'),
    step(2, 15, 'remind'),
    step(3, 30, 'surcharge'),
    step(4, 45, 'notice_letter', ['letter', 'line', 'email']),
    step(5, 60, 'remind'),
    step(6, 90, 'lawyer_letter', ['letter', 'line', 'email']),
    step(7, 180, 'suspend_services'),
    step(8, 365, 'legal_action', []),
  ],
});

const SIMPLE = (legalForm: 'voluntary' | 'lease_contract', nameTh: string): LadderTemplate => ({
  key: `${legalForm}.v1`,
  legalForm,
  nameTh,
  steps: [
    step(1, 3, 'remind'),
    step(2, 15, 'remind'),
    step(3, 45, 'notice_letter', ['letter', 'line', 'email']),
    step(4, 60, 'remind'),
  ],
});

export const LADDER_TEMPLATES: Readonly<Record<BuildingLegalForm, LadderTemplate>> = {
  condo_act: STATUTORY('condo_act', 'ขั้นตอนติดตามยอดค้าง — อาคารชุด'),
  land_allocation_act: STATUTORY('land_allocation_act', 'ขั้นตอนติดตามยอดค้าง — หมู่บ้านจัดสรร'),
  voluntary: SIMPLE('voluntary', 'ขั้นตอนติดตามยอดค้าง — ชุมชน / สมาคม'),
  lease_contract: SIMPLE('lease_contract', 'ขั้นตอนติดตามยอดค้าง — สัญญาเช่า'),
};

/** A building without a legal form (a landlord's stub condo before it is claimed, D-251) is read as a condominium. */
export function legalFormOf(
  building: { legalForm: BuildingLegalForm | null; type: string } | null,
): BuildingLegalForm {
  if (building?.legalForm) return building.legalForm;
  return building?.type === 'condo' ? 'condo_act' : 'voluntary';
}

/** Settings that open each legal measure (all closed by default until O-038; checked when enabling and when running). */
export interface GateSettings {
  surchargeEnabled: boolean;
  surchargeRateCap: string | null;
  lettersTemplateVersion: string | null;
  suspendEnabled: boolean;
  suspendMinOverdueDays: number | null;
  legalActionEnabled: boolean;
}

/** Why a legal measure may not be enabled / run now (null = allowed). `remind` is always allowed. */
export function gateClosedReason(action: CollectionAction, g: GateSettings): string | null {
  switch (action) {
    case 'remind':
      return null;
    case 'surcharge':
      if (!g.surchargeEnabled) return 'surcharge_disabled';
      return g.surchargeRateCap === null ? 'surcharge_cap_unset' : null;
    case 'notice_letter':
    case 'lawyer_letter':
      return g.lettersTemplateVersion ? null : 'letter_wording_unverified';
    case 'suspend_services':
      if (!g.suspendEnabled) return 'suspend_services_disabled';
      return g.suspendMinOverdueDays === null ? 'suspend_services_min_days_unset' : null;
    case 'legal_action':
      return g.legalActionEnabled ? null : 'legal_action_disabled';
    default:
      return 'unknown_action';
  }
}

/**
 * The calendar day a step falls due for a case: the anchor (oldest due date) + the step's offset + the days the case
 * spent paused (a plan or a dispute moves the rest of the ladder back by the pause).
 */
export function stepDueOn(anchorOn: string, offsetDays: number, pausedDays: number): string {
  const [y, m, d] = anchorOn.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offsetDays + pausedDays)).toISOString().slice(0, 10);
}

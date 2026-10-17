import { type WorkflowDefinitionSpec } from './engine';

/**
 * Workflow definitions in code (D-159), seeded into `ops.workflow_definition` (platform rows, tenant_id NULL).
 * A change is a new version; running instances keep theirs. First consumers: deposit settlement (B2.4, D-023),
 * data subject requests (B1.3, D-025); dunning (B4.5) and service requests (B5.1) add their definitions here.
 */
export const WORKFLOW_DEFINITIONS: readonly WorkflowDefinitionSpec[] = [
  {
    key: 'deposit_settlement',
    version: 1,
    description:
      'D-023: deposit settlement after move-out with a refund clock of `deposit.refund_days` calendar days from opening (สคบ. 2568, legal-reference §1).',
    initial: 'opened',
    states: [
      {
        key: 'opened',
        sla: {
          settingKey: 'deposit.refund_days',
          settingUnit: 'days',
          calendar: 'calendar',
          warnBefore: 'P2D',
        },
      },
      {
        key: 'inspected',
        sla: {
          settingKey: 'deposit.refund_days',
          settingUnit: 'days',
          calendar: 'calendar',
          warnBefore: 'P2D',
        },
      },
      {
        key: 'proposed',
        sla: {
          settingKey: 'deposit.refund_days',
          settingUnit: 'days',
          calendar: 'calendar',
          warnBefore: 'P2D',
        },
      },
      {
        key: 'agreed',
        sla: {
          settingKey: 'deposit.refund_days',
          settingUnit: 'days',
          calendar: 'calendar',
          warnBefore: 'P2D',
        },
      },
      {
        key: 'disputed',
        sla: {
          settingKey: 'deposit.refund_days',
          settingUnit: 'days',
          calendar: 'calendar',
          warnBefore: 'P2D',
        },
      },
      { key: 'refunded', terminal: true },
    ],
    transitions: [
      { from: 'opened', event: 'inspect', to: 'inspected' },
      { from: 'inspected', event: 'propose', to: 'proposed', guard: 'deductions_have_evidence' },
      { from: 'proposed', event: 'agree', to: 'agreed' },
      { from: 'proposed', event: 'dispute', to: 'disputed' },
      { from: 'disputed', event: 'propose', to: 'proposed', guard: 'deductions_have_evidence' },
      { from: ['agreed', 'disputed'], event: 'refund', to: 'refunded' },
    ],
  },
  {
    key: 'deposit_settlement',
    version: 2,
    description:
      'D-023 (B2.4): deposit settlement after move-out — refund due `deposit.refund_days` calendar days after the move-out, reminders to the owner at T-3 and T-1, breach = late (compliance.deposit_deadline). A proposal may come straight after move-out when nothing is deducted; the owner may revise a proposal before the resident answers.',
    initial: 'opened',
    states: [
      ...(['opened', 'inspected', 'proposed', 'agreed', 'disputed'] as const).map((key) => ({
        key,
        sla: {
          settingKey: 'deposit.refund_days',
          settingUnit: 'days' as const,
          calendar: 'calendar' as const,
          remindBefore: ['P3D', 'P1D'],
        },
      })),
      { key: 'refunded', terminal: true },
    ],
    transitions: [
      { from: 'opened', event: 'inspect', to: 'inspected' },
      {
        from: ['opened', 'inspected', 'disputed'],
        event: 'propose',
        to: 'proposed',
        guard: 'deductions_have_evidence',
      },
      { from: 'proposed', event: 'revise', to: 'inspected' },
      { from: 'proposed', event: 'agree', to: 'agreed' },
      { from: 'proposed', event: 'dispute', to: 'disputed' },
      { from: ['agreed', 'disputed'], event: 'refund', to: 'refunded' },
    ],
  },
  {
    key: 'data_subject_request',
    version: 1,
    description:
      'D-025: PDPA data subject request handled by the tenant (controller) with Collective as processor; due `privacy.dsr_due_days` calendar days after receipt.',
    initial: 'received',
    states: [
      {
        key: 'received',
        sla: {
          settingKey: 'privacy.dsr_due_days',
          settingUnit: 'days',
          calendar: 'calendar',
          warnBefore: 'P5D',
        },
      },
      {
        key: 'verifying',
        sla: {
          settingKey: 'privacy.dsr_due_days',
          settingUnit: 'days',
          calendar: 'calendar',
          warnBefore: 'P5D',
        },
      },
      {
        key: 'in_progress',
        sla: {
          settingKey: 'privacy.dsr_due_days',
          settingUnit: 'days',
          calendar: 'calendar',
          warnBefore: 'P5D',
        },
      },
      { key: 'fulfilled', terminal: true },
      { key: 'rejected', terminal: true },
      { key: 'withdrawn', terminal: true },
    ],
    transitions: [
      { from: 'received', event: 'verify', to: 'verifying' },
      { from: ['received', 'verifying'], event: 'start', to: 'in_progress' },
      { from: 'in_progress', event: 'fulfil', to: 'fulfilled' },
      { from: ['received', 'verifying', 'in_progress'], event: 'reject', to: 'rejected' },
      { from: '*', event: 'withdraw', to: 'withdrawn' },
    ],
  },
  {
    key: 'dunning',
    version: 1,
    description:
      'D-045 (B4.5): light dunning of one overdue invoice — reminders on the days of `reminders.schedule` after the due date (step timers), stopped when the invoice is paid or voided. Nothing else happens automatically (D-024).',
    initial: 'overdue',
    states: [{ key: 'overdue' }, { key: 'paid', terminal: true }, { key: 'cancelled', terminal: true }],
    transitions: [
      { from: 'overdue', event: 'pay', to: 'paid' },
      { from: 'overdue', event: 'cancel', to: 'cancelled' },
    ],
  },
];

export function workflowDefinition(key: string, version?: number): WorkflowDefinitionSpec {
  const matches = WORKFLOW_DEFINITIONS.filter(
    (d) => d.key === key && (version === undefined || d.version === version),
  );
  const def = matches.sort((a, b) => b.version - a.version)[0];
  if (!def) throw new Error(`unknown workflow definition ${key}${version ? `@${version}` : ''}`);
  return def;
}

import Decimal from 'decimal.js';

/**
 * Pure rules of J2.2 vendors and contracts (D-310, D-331): instalment schedules, the ≥ 3 quotations rule, expiry
 * alert thresholds, SLA breaches of a vendor's work orders and the evaluation trend. No I/O — unit tested.
 */

export const INSTALMENT_FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual', 'once'] as const;
export type InstalmentFrequency = (typeof INSTALMENT_FREQUENCIES)[number];
const STEP_MONTHS: Record<Exclude<InstalmentFrequency, 'once'>, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export interface InstalmentPlan {
  frequency: InstalmentFrequency;
  /** Day of the month an instalment falls due (1–28, so every month has it). */
  dueDay: number;
  /** Amount of each instalment incl. VAT (decimal string). */
  amount: string;
  /** VAT part of each instalment (decimal string). */
  vatAmount?: string | null;
  /** First due date (`YYYY-MM-DD`); default the first `dueDay` on or after the contract start. */
  firstDueOn?: string | null;
}

export interface ScheduledInstalment {
  seq: number;
  dueOn: string;
  amount: string;
  vatAmount: string;
}

export const MAX_INSTALMENTS = 120;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

function ymd(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.toISOString().slice(0, 10);
}

/** Problems of an instalment plan (empty = valid) — shape only, the term is checked by `instalmentSchedule`. */
export function instalmentPlanProblems(plan: InstalmentPlan): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (!(INSTALMENT_FREQUENCIES as readonly string[]).includes(plan.frequency))
    out.push({ path: 'frequency', message: INSTALMENT_FREQUENCIES.join(' · ') });
  if (!Number.isInteger(plan.dueDay) || plan.dueDay < 1 || plan.dueDay > 28)
    out.push({ path: 'dueDay', message: '1–28' });
  if (!MONEY.test(plan.amount) || new Decimal(plan.amount).lte(0))
    out.push({ path: 'amount', message: 'a positive amount' });
  const vat = plan.vatAmount ?? '0.00';
  if (!MONEY.test(vat) || (MONEY.test(plan.amount) && new Decimal(vat).gt(plan.amount)))
    out.push({ path: 'vatAmount', message: '0 … amount' });
  if (plan.firstDueOn && !/^\d{4}-\d{2}-\d{2}$/.test(plan.firstDueOn))
    out.push({ path: 'firstDueOn', message: 'a date' });
  return out;
}

/**
 * The instalments of a plan inside the term `[startsOn, endsOn]` (inclusive dates): the first falls on `firstDueOn`
 * or on the first `dueDay` on / after the start, then every step of the frequency on `dueDay`; none after the end.
 * `once` = one instalment on the first due date. Throws `RangeError` when the first due date is outside the term or
 * the schedule would exceed `MAX_INSTALMENTS`.
 */
export function instalmentSchedule(
  plan: InstalmentPlan,
  startsOn: string,
  endsOn: string,
): ScheduledInstalment[] {
  const [sy, sm, sd] = startsOn.split('-').map(Number) as [number, number, number];
  const first =
    plan.firstDueOn ?? (sd <= plan.dueDay ? ymd(sy, sm - 1, plan.dueDay) : ymd(sy, sm, plan.dueDay));
  if (first < startsOn || first > endsOn) throw new RangeError('first_due_outside_term');
  const vat = new Decimal(plan.vatAmount ?? '0').toFixed(2);
  const amount = new Decimal(plan.amount).toFixed(2);
  if (plan.frequency === 'once') return [{ seq: 1, dueOn: first, amount, vatAmount: vat }];
  const step = STEP_MONTHS[plan.frequency];
  const [fy, fm] = first.split('-').map(Number) as [number, number];
  const out: ScheduledInstalment[] = [];
  for (let i = 0; ; i += 1) {
    const dueOn = i === 0 ? first : ymd(fy, fm - 1 + i * step, plan.dueDay);
    if (dueOn > endsOn) break;
    out.push({ seq: i + 1, dueOn, amount, vatAmount: vat });
    if (out.length > MAX_INSTALMENTS) throw new RangeError('too_many_instalments');
  }
  return out;
}

/** D-310: the minimum number of quotations above `juristic.quotation_threshold`. */
export const MIN_QUOTATIONS = 3;

export interface QuotationRuleInput {
  amount: Decimal.Value;
  threshold: Decimal.Value;
  quotations: number;
  reason?: string | null;
}

/** D-310: above the threshold a purchase needs ≥ 3 quotations, or a recorded reason (10–1000 characters). */
export function quotationRule(input: QuotationRuleInput): {
  aboveThreshold: boolean;
  minimumMet: boolean;
  allowed: boolean;
} {
  const aboveThreshold = new Decimal(input.amount).gt(input.threshold);
  const minimumMet = !aboveThreshold || input.quotations >= MIN_QUOTATIONS;
  const reason = input.reason?.trim() ?? '';
  return {
    aboveThreshold,
    minimumMet,
    allowed: minimumMet || (reason.length >= 10 && reason.length <= 1000),
  };
}

/**
 * The expiry alert due today: the smallest threshold ≥ the days left (a late first run sends only the nearest one,
 * never a burst of 90 / 60 / 30 at once), unless already sent for this end date. Null after the end or none due.
 */
export function alertDue(
  daysLeft: number,
  thresholds: readonly number[],
  sent: readonly number[],
): number | null {
  if (daysLeft < 0) return null;
  const due = [...thresholds].filter((t) => daysLeft <= t).sort((a, b) => a - b)[0];
  if (due === undefined || sent.includes(due)) return null;
  return due;
}

export const SLA_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SlaPriority = (typeof SLA_PRIORITIES)[number];
export interface SlaTerm {
  priority: SlaPriority;
  responseHours: number;
  resolveHours: number;
}

export function slaTermsProblems(terms: SlaTerm[]): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  terms.forEach((t, i) => {
    if (!(SLA_PRIORITIES as readonly string[]).includes(t.priority))
      out.push({ path: `slaTerms[${i}].priority`, message: SLA_PRIORITIES.join(' · ') });
    else if (seen.has(t.priority))
      out.push({ path: `slaTerms[${i}].priority`, message: 'once per priority' });
    seen.add(t.priority);
    for (const f of ['responseHours', 'resolveHours'] as const)
      if (!Number.isInteger(t[f]) || t[f] < 1 || t[f] > 8760)
        out.push({ path: `slaTerms[${i}].${f}`, message: 'whole hours 1–8760' });
    if (
      Number.isInteger(t.responseHours) &&
      Number.isInteger(t.resolveHours) &&
      t.resolveHours < t.responseHours
    )
      out.push({ path: `slaTerms[${i}].resolveHours`, message: '≥ responseHours' });
  });
  return out;
}

export interface SlaWorkOrder {
  id: string;
  title: string;
  priority: SlaPriority;
  status: string;
  createdAt: Date;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  checkedInAt: Date | null;
  completedAt: Date | null;
  serviceRequest: { id: string; createdAt: Date; slaBreachedAt: Date | null } | null;
}

export type SlaBreachKind = 'response' | 'resolve' | 'request_sla';
export interface SlaBreach {
  kind: SlaBreachKind;
  workOrderId: string;
  serviceRequestId: string | null;
  title: string;
  priority: SlaPriority;
  /** Hours the contract allows (null for a breach of the request's own SLA). */
  allowedHours: number | null;
  /** Hours it took, or has taken so far (1 decimal). */
  actualHours: number | null;
}

const hours = (from: Date, to: Date) => Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 10) / 10;

/**
 * Breaches of a vendor's work orders against the contract's SLA terms (D-310): response = accepted (or checked in)
 * − assigned (or created) above `responseHours`; resolve = completed − the request's (or work order's) creation above
 * `resolveHours`; an unfinished step counts until `now`. Plus every linked service request whose own SLA breached.
 * Cancelled work orders are not counted.
 */
export function slaBreaches(
  orders: readonly SlaWorkOrder[],
  terms: readonly SlaTerm[],
  now: Date,
): SlaBreach[] {
  const out: SlaBreach[] = [];
  for (const wo of orders) {
    if (wo.status === 'cancelled') continue;
    const term = terms.find((t) => t.priority === wo.priority);
    const base = {
      workOrderId: wo.id,
      serviceRequestId: wo.serviceRequest?.id ?? null,
      title: wo.title,
      priority: wo.priority,
    };
    if (term) {
      const responded = wo.acceptedAt ?? wo.checkedInAt ?? wo.completedAt ?? now;
      const r = hours(wo.assignedAt ?? wo.createdAt, responded);
      if (r > term.responseHours)
        out.push({ ...base, kind: 'response', allowedHours: term.responseHours, actualHours: r });
      const done = wo.completedAt ?? now;
      const d = hours(wo.serviceRequest?.createdAt ?? wo.createdAt, done);
      if (d > term.resolveHours)
        out.push({ ...base, kind: 'resolve', allowedHours: term.resolveHours, actualHours: d });
    }
    if (wo.serviceRequest?.slaBreachedAt)
      out.push({ ...base, kind: 'request_sla', allowedHours: null, actualHours: null });
  }
  return out;
}

export interface EvaluationPoint {
  month: string;
  score: string;
  slaBreaches: number;
}
export type Trend = 'improving' | 'declining' | 'steady';

/**
 * Trend over the last 6 evaluations: the last score against the average of the ones before it — ±0.25 or more is
 * improving / declining, else steady; null with fewer than 2.
 */
export function evaluationTrend(points: readonly EvaluationPoint[]): {
  count: number;
  averageScore: string | null;
  lastScore: string | null;
  trend: Trend | null;
  slaBreaches: number;
} {
  const last6 = [...points].sort((a, b) => a.month.localeCompare(b.month)).slice(-6);
  if (!last6.length) return { count: 0, averageScore: null, lastScore: null, trend: null, slaBreaches: 0 };
  const sum = last6.reduce((s, p) => s.plus(p.score), new Decimal(0));
  const last = last6[last6.length - 1]!;
  let trend: Trend | null = null;
  if (last6.length >= 2) {
    const before = last6.slice(0, -1);
    const avg = before.reduce((s, p) => s.plus(p.score), new Decimal(0)).div(before.length);
    const diff = new Decimal(last.score).minus(avg);
    trend = diff.gte(0.25) ? 'improving' : diff.lte(-0.25) ? 'declining' : 'steady';
  }
  return {
    count: last6.length,
    averageScore: sum.div(last6.length).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    lastScore: new Decimal(last.score).toFixed(2),
    trend,
    slaBreaches: last6.reduce((s, p) => s + p.slaBreaches, 0),
  };
}

/** Average of 1–5 scores, half-up to 2 decimals. */
export function averageScore(scores: readonly number[]): string {
  const sum = scores.reduce((s, x) => s.plus(x), new Decimal(0));
  return sum.div(scores.length).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

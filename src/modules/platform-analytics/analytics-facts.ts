import { Prisma } from '@generated/prisma/client';

/**
 * The analytics facts (B6.3, D-217): what is measured, from which rows, at which instant. Each definition is one
 * set-based `INSERT … SELECT … ON CONFLICT` over a time range and (optionally) one tenant — the same statement serves
 * the analytics subscriber (one tenant, the minutes around an event), the hourly worker (every tenant, the last two
 * days) and the KPI endpoint (one tenant, its window), so a fact is identical whichever path wrote it first
 * (unique fact × subject × time). Facts about a state that can still change (the month's compliance score) are
 * updated in place; the others are written once.
 */
export const FACT_KEYS = [
  'cycle.time_to_issue_s',
  'invoice.issued',
  'invoice.corrected',
  'payment.on_time',
  'payment.auto_reconciled',
  'payment.by_qr',
  'reminder.effective',
  'loss.pct',
  'meter.uptime_pct',
  'csat.rating',
  'compliance.score',
  'compliance.above_cap_acknowledged_pct',
  'service_request.via_line',
] as const;
export type FactKey = (typeof FACT_KEYS)[number];

export interface FactScope {
  tenantId: string | null;
  from: Date;
  to: Date;
  /** Facts about a deadline are written only once it passed. */
  now: Date;
  /** `analytics.reminder_effective_days`. */
  reminderDays: number;
}

const tenantOf = (column: string, s: FactScope) =>
  s.tenantId ? Prisma.sql`AND ${Prisma.raw(column)} = ${s.tenantId}::uuid` : Prisma.empty;

const INSERT = Prisma.sql`INSERT INTO platform.analytics_fact
  (time, tenant_id, building_id, fact, subject_type, subject_id, value, dims)`;
const ONCE = Prisma.sql`ON CONFLICT (fact, subject_id, time) DO NOTHING`;
const LATEST = Prisma.sql`ON CONFLICT (fact, subject_id, time) DO UPDATE SET value = EXCLUDED.value, dims = EXCLUDED.dims,
  recorded_at = now()`;

/** One statement per fact, in FACT_KEYS order. */
export function factStatements(s: FactScope): Record<FactKey, Prisma.Sql> {
  const { from, to, now } = s;
  return {
    // cut-off → issue of a billing cycle (D-011, D-031)
    'cycle.time_to_issue_s': Prisma.sql`${INSERT}
      SELECT c.issued_at, c.tenant_id, NULL, 'cycle.time_to_issue_s', 'ops.billing_cycle', c.id,
             extract(epoch FROM (c.issued_at - c.cut_off_at)), jsonb_build_object('propertyId', c.property_id)
        FROM ops.billing_cycle c
       WHERE c.issued_at >= ${from} AND c.issued_at < ${to} AND c.issued_at >= c.cut_off_at ${tenantOf('c.tenant_id', s)}
      ${ONCE}`,
    'invoice.issued': Prisma.sql`${INSERT}
      SELECT i.issued_at, i.tenant_id, i.building_id, 'invoice.issued', 'ops.invoice', i.id, 1, '{}'::jsonb
        FROM ops.invoice i
       WHERE i.issued_at >= ${from} AND i.issued_at < ${to} ${tenantOf('i.tenant_id', s)}
      ${ONCE}`,
    // a voided issued invoice or a credit note = a bill error corrected (D-040)
    'invoice.corrected': Prisma.sql`${INSERT}
      SELECT i.voided_at, i.tenant_id, i.building_id, 'invoice.corrected', 'ops.invoice', i.id, 1,
             jsonb_build_object('via', 'void')
        FROM ops.invoice i
       WHERE i.voided_at >= ${from} AND i.voided_at < ${to} AND i.issued_at IS NOT NULL ${tenantOf('i.tenant_id', s)}
      UNION ALL
      SELECT n.issued_at, n.tenant_id, n.building_id, 'invoice.corrected', 'ops.credit_note', n.id, 1,
             jsonb_build_object('via', 'credit_note')
        FROM ops.credit_note n
       WHERE n.issued_at >= ${from} AND n.issued_at < ${to} ${tenantOf('n.tenant_id', s)}
      ${ONCE}`,
    // an issued invoice whose due date passed: paid in full by the end of its due date (Bangkok)?
    'payment.on_time': Prisma.sql`${INSERT}
      SELECT d.due_end, i.tenant_id, i.building_id, 'payment.on_time', 'ops.invoice', i.id,
             CASE WHEN i.status = 'paid' AND i.last_payment_at < d.due_end THEN 1 ELSE 0 END,
             jsonb_build_object('dueDate', i.due_date)
        FROM ops.invoice i
       CROSS JOIN LATERAL (SELECT ((i.due_date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok') AS due_end) d
       WHERE i.issued_at IS NOT NULL AND i.voided_at IS NULL
         AND d.due_end > ${from} AND d.due_end <= ${to} AND d.due_end <= ${now} ${tenantOf('i.tenant_id', s)}
      ${ONCE}`,
    // payments confirmed without a person (bank callback, settlement file, verified slip — D-042, D-043)
    'payment.auto_reconciled': Prisma.sql`${INSERT}
      SELECT p.confirmed_at, p.tenant_id, p.building_id, 'payment.auto_reconciled', 'ops.payment', p.id,
             CASE WHEN p.confirmed_via IN ('webhook', 'settlement_file', 'slip_verified') THEN 1 ELSE 0 END,
             jsonb_build_object('method', p.method, 'via', p.confirmed_via)
        FROM ops.payment p
       WHERE p.status = 'confirmed' AND p.method <> 'offset' AND p.confirmed_at >= ${from} AND p.confirmed_at < ${to}
         ${tenantOf('p.tenant_id', s)}
      ${ONCE}`,
    'payment.by_qr': Prisma.sql`${INSERT}
      SELECT p.confirmed_at, p.tenant_id, p.building_id, 'payment.by_qr', 'ops.payment', p.id,
             CASE WHEN p.method = 'qr' THEN 1 ELSE 0 END, jsonb_build_object('method', p.method)
        FROM ops.payment p
       WHERE p.status = 'confirmed' AND p.method <> 'offset' AND p.confirmed_at >= ${from} AND p.confirmed_at < ${to}
         ${tenantOf('p.tenant_id', s)}
      ${ONCE}`,
    // a reminder sent N days ago: was the invoice paid within N days after it? (D-045)
    'reminder.effective': Prisma.sql`${INSERT}
      SELECT r.sent_at, r.tenant_id, r.building_id, 'reminder.effective', 'ops.dunning_reminder', r.id,
             CASE WHEN i.status = 'paid' AND i.last_payment_at >= r.sent_at
                   AND i.last_payment_at < r.sent_at + make_interval(days => ${s.reminderDays}::int) THEN 1 ELSE 0 END,
             jsonb_build_object('step', r.step, 'trigger', r.triggered_by)
        FROM ops.dunning_reminder r JOIN ops.invoice i ON i.id = r.invoice_id
       WHERE r.status = 'sent' AND r.sent_at >= ${from} AND r.sent_at < ${to}
         AND r.sent_at + make_interval(days => ${s.reminderDays}::int) <= ${now} ${tenantOf('r.tenant_id', s)}
      ${ONCE}`,
    'loss.pct': Prisma.sql`${INSERT}
      SELECT l.computed_at, l.tenant_id, l.building_id, 'loss.pct', 'ops.loss_report', l.id, l.loss_pct,
             jsonb_build_object('utility', l.utility)
        FROM ops.loss_report l
       WHERE l.loss_pct IS NOT NULL AND l.computed_at >= ${from} AND l.computed_at < ${to} ${tenantOf('l.tenant_id', s)}
      ${LATEST}`,
    // per building and Bangkok day: hours with telemetry ÷ hours a meter was bound to a gateway (D-034)
    'meter.uptime_pct': Prisma.sql`${INSERT}
      WITH days AS (
        SELECT (d::date::timestamp AT TIME ZONE 'Asia/Bangkok') AS s,
               ((d::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok') AS e
          FROM generate_series((${from}::timestamptz AT TIME ZONE 'Asia/Bangkok')::date,
                               ((${to}::timestamptz AT TIME ZONE 'Asia/Bangkok') - interval '1 day')::date, interval '1 day') d),
      ch AS (
        SELECT mc.tenant_id, mc.building_id, mc.meter_asset_item_id AS item, days.s AS day,
               greatest(mc.valid_from, days.s) AS s, least(coalesce(mc.valid_to, days.e), days.e) AS e
          FROM smart.meter_channel mc JOIN days ON mc.valid_from < days.e AND (mc.valid_to IS NULL OR mc.valid_to > days.s)
         WHERE days.e <= ${now} ${tenantOf('mc.tenant_id', s)}),
      per AS (
        SELECT ch.tenant_id, ch.building_id, ch.day,
               sum(greatest(0, ceil(extract(epoch FROM (ch.e - date_trunc('hour', ch.s))) / 3600)))::numeric AS expected,
               sum((SELECT count(*) FROM smart.telemetry_1h t
                     WHERE t.asset_item_id = ch.item AND t.bucket >= date_trunc('hour', ch.s) AND t.bucket < ch.e))::numeric AS seen
          FROM ch WHERE ch.e > ch.s GROUP BY 1, 2, 3)
      SELECT per.day, per.tenant_id, per.building_id, 'meter.uptime_pct', 'core.building', per.building_id,
             round(100 * least(per.seen, per.expected) / per.expected, 4),
             jsonb_build_object('seenHours', per.seen, 'expectedHours', per.expected)
        FROM per WHERE per.expected > 0
      ${LATEST}`,
    // 1–5: the rating of a done repair (B5.1) and the periodic resident survey (B6.3)
    'csat.rating': Prisma.sql`${INSERT}
      SELECT r.rated_at, r.tenant_id, r.building_id, 'csat.rating', 'ops.service_request', r.id, r.rating,
             jsonb_build_object('source', 'service_request')
        FROM ops.service_request r
       WHERE r.rating IS NOT NULL AND r.rated_at >= ${from} AND r.rated_at < ${to} ${tenantOf('r.tenant_id', s)}
      UNION ALL
      SELECT c.answered_at, c.tenant_id, u.building_id, 'csat.rating', 'platform.csat_response', c.id, c.rating,
             jsonb_build_object('source', 'survey', 'question', c.question_key)
        FROM platform.csat_response c LEFT JOIN core.unit u ON u.id = c.unit_id
       WHERE c.answered_at >= ${from} AND c.answered_at < ${to} ${tenantOf('c.tenant_id', s)}
      ${ONCE}`,
    // the month's compliance score (B4.1) and the share of above-cap lines the owner acknowledged (D-021a)
    'compliance.score': Prisma.sql`${INSERT}
      SELECT (cs.month::timestamp AT TIME ZONE 'Asia/Bangkok'), cs.tenant_id, NULL, 'compliance.score',
             'platform.compliance_score', cs.id, cs.score, '{}'::jsonb
        FROM platform.compliance_score cs
       WHERE (cs.month::timestamp AT TIME ZONE 'Asia/Bangkok') < ${to}
         AND ((cs.month + interval '1 month')::timestamp AT TIME ZONE 'Asia/Bangkok') > ${from} ${tenantOf('cs.tenant_id', s)}
      ${LATEST}`,
    'compliance.above_cap_acknowledged_pct': Prisma.sql`${INSERT}
      SELECT (cs.month::timestamp AT TIME ZONE 'Asia/Bangkok'), cs.tenant_id, NULL,
             'compliance.above_cap_acknowledged_pct', 'platform.compliance_score', cs.id,
             round(100.0 * cs.lines_above_cap_acknowledged / cs.lines_above_cap, 4),
             jsonb_build_object('linesAboveCap', cs.lines_above_cap)
        FROM platform.compliance_score cs
       WHERE cs.lines_above_cap > 0 AND (cs.month::timestamp AT TIME ZONE 'Asia/Bangkok') < ${to}
         AND ((cs.month + interval '1 month')::timestamp AT TIME ZONE 'Asia/Bangkok') > ${from} ${tenantOf('cs.tenant_id', s)}
      ${LATEST}`,
    // requests reported by people: through the resident LINE app (1) or by the office (0); automatic ones excluded
    'service_request.via_line': Prisma.sql`${INSERT}
      SELECT r.created_at, r.tenant_id, r.building_id, 'service_request.via_line', 'ops.service_request', r.id,
             CASE WHEN r.reporter_kind = 'resident' THEN 1 ELSE 0 END, jsonb_build_object('reporter', r.reporter_kind)
        FROM ops.service_request r
       WHERE r.reporter_kind <> 'system' AND r.created_at >= ${from} AND r.created_at < ${to} ${tenantOf('r.tenant_id', s)}
      ${ONCE}`,
  };
}

/** Events that change a fact, and the facts to refresh around them (the analytics subscriber). */
export const FACTS_BY_EVENT: Readonly<Record<string, readonly FactKey[]>> = {
  'billing_cycle.issued': ['cycle.time_to_issue_s'],
  'invoice.issued': ['invoice.issued'],
  'invoice.voided': ['invoice.corrected'],
  'credit_note.issued': ['invoice.corrected'],
  'payment.confirmed': ['payment.auto_reconciled', 'payment.by_qr'],
  'loss_report.computed': ['loss.pct'],
  'service_request.rated': ['csat.rating'],
  'csat.answered': ['csat.rating'],
  'service_request.created': ['service_request.via_line'],
};

/** Facts whose value is an average over count (the others are counts / shares written as 0 / 1). */
export const ROLLUP_BUCKETS = ['day', 'week', 'month'] as const;

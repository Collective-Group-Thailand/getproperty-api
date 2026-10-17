import { FEATURE_FLAGS } from '@core/feature-flags/catalogue';
import { WORKFLOW_DEFINITIONS } from '@core/workflow/definitions';

import { NOTIFICATION_ROUTES, NOTIFICATION_TEMPLATES } from '../../prisma/seed/data/notifications';
import { countRows, DEV, runSeed } from '../../prisma/seed/run';
import { COMPLIANCE_RULES } from '../../src/core/compliance/rules';
import { SETTINGS } from '../../src/core/settings/catalogue';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

describe('seeds (reference + dev)', () => {
  let db: IntDatabase;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_seed' }); // template = migrated + seeded once
  });
  afterAll(async () => {
    await db.drop();
  });

  it('are idempotent: running reference and dev again changes no count', async () => {
    const before = await countRows(db.admin);
    expect(await runSeed(db.admin, 'reference')).toEqual(before);
    expect(await runSeed(db.admin, 'dev')).toEqual(before);
  });

  it('seed the expected catalogue sizes', async () => {
    const counts = await countRows(db.admin);
    expect(counts).toMatchObject({
      'platform.role': 8,
      'platform.setting': SETTINGS.length,
      'platform.setting_version': SETTINGS.length,
      'platform.compliance_rule': COMPLIANCE_RULES.length,
      'platform.utility_tariff': 8,
      'platform.utility_tariff_version': 20,
      'platform.business_calendar': 46,
      'platform.consent_purpose': 5,
      'platform.notification_template': NOTIFICATION_TEMPLATES.length,
      'platform.notification_template_version': NOTIFICATION_TEMPLATES.length * 2,
      'platform.notification_route': NOTIFICATION_ROUTES.length,
      'platform.feature_flag': FEATURE_FLAGS.length,
      'ops.workflow_definition': WORKFLOW_DEFINITIONS.length,
      'platform.user_credential': 5,
      'core.tenant': 1,
      'core.user_account': 5,
      'core.membership': 3,
      'core.building': 1,
    });
  });

  it('compliance rules are pending legal verification (D-149) and carry a legal reference', async () => {
    const { rows } = await db.admin.query<{ status: string; n: number }>(
      `SELECT status::text, count(*)::int AS n FROM platform.compliance_rule WHERE legal_ref LIKE '%ข้อ%' GROUP BY 1`,
    );
    expect(rows).toEqual([{ status: 'pending_legal_verification', n: COMPLIANCE_RULES.length }]);
    const cap = await db.admin.query(
      `SELECT default_severity::text AS s FROM platform.compliance_rule WHERE id = 'compliance.tariff_cap'`,
    );
    expect(cap.rows[0]).toEqual({ s: 'warn' });
  });

  it('settings cite their decision and carry the decided values', async () => {
    const { rows } = await db.admin.query<{ key: string; value: unknown; description: string }>(
      `SELECT s.key, v.value, s.description FROM platform.setting s JOIN platform.setting_version v ON v.setting_id = s.id`,
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['compliance.tariff_cap.severity']!.value).toBe('warn');
    expect(byKey['compliance.tariff_cap.severity']!.description).toContain('D-021a');
    expect(byKey['deposit.max_months_short']!.value).toBe('3');
    expect(byKey['deposit.max_years_long']!.value).toBe('1');
    expect(byKey['deposit.refund_days']!.value).toBe(7);
    expect(byKey['reminders.schedule']!.value).toEqual([1, 3, 7]);
    expect(byKey['notifications.quiet_hours']!.value).toMatchObject({ start: '21:00', end: '08:00' });
    expect(byKey['late_fee.enabled']!.value).toBe(false);
    expect(byKey['readings.require_photo']!.value).toBe(true);
    expect(byKey['readings.plausibility_pct']!.value).toBe('60');
    expect(byKey['subscription.trial_days']!.value).toBe(30);
    expect(byKey['pricing.price_plans']!.value).toMatchObject({ status: 'proposed', decision: 'D-156' });
    expect(rows.every((r) => /[DO]-\d{3}/.test(r.description))).toBe(true);
  });

  it('utility tariffs are entered, unverified, with sources and needs_check where unsure', async () => {
    const { rows } = await db.admin.query<{
      state: string;
      verified: number;
      no_source: number;
      needs_check: number;
    }>(
      `SELECT state::text, count(verified_by)::int AS verified, count(*) FILTER (WHERE source_url = '')::int AS no_source,
              count(*) FILTER (WHERE needs_check)::int AS needs_check
         FROM platform.utility_tariff_version GROUP BY 1`,
    );
    expect(rows).toEqual([{ state: 'entered', verified: 0, no_source: 0, needs_check: 18 }]);
  });

  it('the development tenant is an apartment whose building is owned and operated by itself', async () => {
    const { rows } = await db.admin.query(
      `SELECT t.type::text, t.display_name, b.owner_tenant_id = t.id AS owner, b.operator_tenant_id = t.id AS operator,
              t.legal_party_id IS NOT NULL AS has_legal_party
         FROM core.tenant t JOIN core.building b ON b.tenant_id = t.id WHERE t.id = $1`,
      [DEV.tenantId],
    );
    expect(rows).toEqual([
      {
        type: 'apartment',
        display_name: 'หอพักตัวอย่าง',
        owner: true,
        operator: true,
        has_legal_party: true,
      },
    ]);
    const phones = await db.admin.query<{ phone_e164: string }>(`SELECT phone_e164 FROM core.user_account`);
    expect(phones.rows.every((r) => r.phone_e164.startsWith('+660'))).toBe(true); // +66 0… never exists: obviously fake
  });
});

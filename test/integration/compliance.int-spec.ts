import { ComplianceScoreService } from '@core/compliance/compliance-score.service';
import { COMPLIANCE_RULES } from '@core/compliance/rules';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, onboardTenant, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

/**
 * B4.1 acceptance (compliance engine, ADR-0007): the registry with the severities in force per tenant (platform
 * admin overrides, D-021a), the admin view with the legal-verification status (D-149), the monthly compliance score
 * (leases on the standard template; deposits refunded on time), tenant isolation of scores.
 */
describe('B4.1 compliance engine (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let admin: string;
  let other: { tenantId: string; token: string };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_compliance' });
    t = await createIntApp(db);
    owner = await ownerToken(t);
    admin = await adminToken(t);
    other = await onboardTenant(t, admin, { slug: 'other-b41', phone: '+660000000141', type: 'apartment' });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('lists every rule with its legal reference and the severity in force (D-021a defaults)', async () => {
    const res = await t.http.get('/v1/owner/compliance/rules').set(bearer(owner)).expect(200);
    expect(res.body.inScope).toBe(true);
    expect(res.body.data).toHaveLength(COMPLIANCE_RULES.length);
    const cap = (res.body.data as { id: string; severity: string; status: string; legalRef: string }[]).find(
      (r) => r.id === 'compliance.tariff_cap',
    )!;
    expect(cap).toMatchObject({ severity: 'warn', status: 'pending_legal_verification' });
    expect(cap.legalRef).toContain('ข้อ 5 (6)');
  });

  it('the platform admin overrides a severity for one tenant only (compliance.severity_overrides)', async () => {
    await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/settings/compliance.severity_overrides`)
      .set(bearer(admin))
      .send({ value: { 'compliance.notice_period': 'block' }, reason: 'ทดสอบ: บังคับระยะเวลาแจ้ง' })
      .expect(200);
    const mine = await t.http.get('/v1/owner/compliance/rules').set(bearer(owner)).expect(200);
    const theirs = await t.http.get('/v1/owner/compliance/rules').set(bearer(other.token)).expect(200);
    const severity = (body: { data: { id: string; severity: string }[] }) =>
      body.data.find((r) => r.id === 'compliance.notice_period')!.severity;
    expect(severity(mine.body)).toBe('block');
    expect(severity(theirs.body)).toBe('warn');
    const platform = await t.http.get('/v1/admin/compliance/rules').set(bearer(admin)).expect(200);
    expect(severity(platform.body)).toBe('warn');
    await t.http.get('/v1/admin/compliance/rules').set(bearer(owner)).expect(403);
  });

  it('computes the monthly score: the seeded lease is on the standard template', async () => {
    const month = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);
    const res = await t.http.get(`/v1/owner/compliance/score?month=${month}`).set(bearer(owner)).expect(200);
    expect(res.body).toMatchObject({ month, leasesTotal: 1, leasesOnStandardTemplate: 1, score: '100.00' });
    expect(res.body.components).toHaveLength(4);
    const stored = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.compliance_score WHERE tenant_id = $1`,
      [DEV.tenantId],
    );
    expect(stored.rows[0]!.n).toBe(1);
    const history = await t.http.get('/v1/owner/compliance/scores').set(bearer(owner)).expect(200);
    expect(history.body.data[0]).toMatchObject({ month, score: '100.00' });
    await t.http.get('/v1/owner/compliance/score?month=2026-13').set(bearer(owner)).expect(422);
  });

  it('a non-standard contract lowers the score; another tenant never sees it', async () => {
    const month = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);
    await db.admin.query(
      `WITH t AS (INSERT INTO ops.lease_template (tenant_id, key, name) VALUES ($1, 'own_th', 'สัญญาของหอ') RETURNING id),
            v AS (INSERT INTO ops.lease_template_version (template_id, tenant_id, version, body_html, legal_ref, state, effective_from, published_at)
                  SELECT id, $1, 1, '<p>own</p>', 'own', 'published', '2025-01-01', now() FROM t RETURNING id)
       UPDATE ops.lease SET template_version_id = (SELECT id FROM v) WHERE id = $2`,
      [DEV.tenantId, DEV.leaseId],
    );
    const res = await t.http.get(`/v1/owner/compliance/score?month=${month}`).set(bearer(owner)).expect(200);
    expect(res.body).toMatchObject({ leasesTotal: 1, leasesOnStandardTemplate: 0, score: '0.00' });
    const theirs = await t.http
      .get(`/v1/owner/compliance/score?month=${month}`)
      .set(bearer(other.token))
      .expect(200);
    expect(theirs.body).toMatchObject({ leasesTotal: 0, score: '100.00' });
    const rows = await db.admin.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM platform.compliance_score ORDER BY tenant_id`,
    );
    expect(new Set(rows.rows.map((r) => r.tenant_id))).toEqual(new Set([DEV.tenantId, other.tenantId]));
  });

  it('the nightly job scores every tenant for the current and the previous month', async () => {
    const n = await t.app.get(ComplianceScoreService).runAll();
    expect(n).toBeGreaterThanOrEqual(4);
  });
});

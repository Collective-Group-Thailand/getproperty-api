import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';

import { utilityCharge } from '@core/utility-tariffs/tariff-math';
import { type UtilityTariffStructure } from '@core/utility-tariffs/tariff-structure';
import { type FakeObjectStorage } from '@integrations/s3/fake-object-storage';
import { OBJECT_STORAGE } from '@integrations/s3/object-storage.port';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const PDF = Buffer.from('%PDF-1.4\n% tariff notice\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/**
 * Consumer contract requests of 2026-10-20 (getproperty-web F2 / F5, D-214): sample bill of an unpublished tariff
 * version, the tariff notice as an uploaded platform file, the owner's pilot KPIs, the integration-event list,
 * a tenant's buildings for the console, platform-level DSR actions, the version history of a setting and the typed
 * site-survey filter.
 */
describe('contract requests F5 (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let owner: string;
  let other: { tenantId: string; token: string };

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const A = () => bearer(admin);
  const O = () => bearer(owner);

  async function platformUpload(body: Buffer, kind = 'tariff_source', mimeType = 'application/pdf') {
    const presign = await t.http
      .post('/v1/admin/files/presign')
      .set(A())
      .send({
        kind,
        fileName: 'notice.pdf',
        mimeType,
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
      .expect(201);
    expect(presign.body.file).toMatchObject({ scopeType: 'platform', scopeId: null, kind });
    const id = presign.body.file.id as string;
    const [row] = await q<{ storage_key: string; tenant_id: string | null }>(
      'SELECT storage_key, tenant_id FROM core.document WHERE id = $1',
      [id],
    );
    expect(row!.tenant_id).toBeNull();
    expect(row!.storage_key.startsWith('p/')).toBe(true);
    t.app.get<FakeObjectStorage>(OBJECT_STORAGE).putDirect(row!.storage_key, body, mimeType);
    await t.http.post(`/v1/admin/files/${id}/actions/complete`).set(A()).send({}).expect(200);
    await t.worker.tick();
    return id;
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_crf5' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    admin = await adminToken(t);
    owner = await ownerToken(t);
    other = await onboardTenant(t, admin, { slug: 'other-f5', phone: '+660000000271', type: 'apartment' });
  });
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('tariff notice upload, sourceDocumentId on entry and the sample bill before publishing', async () => {
    const fileId = await platformUpload(PDF);
    const file = await t.http.get(`/v1/admin/files/${fileId}`).set(A()).expect(200);
    expect(file.body.file).toMatchObject({ id: fileId, scanStatus: 'clean', uploadState: 'verified' });
    expect(file.body.url).toEqual(expect.any(String));
    // a tenant's file is not a platform file
    const tenantFile = await uploadFile(t, db, owner, {
      kind: 'other',
      scopeType: 'tenant',
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      body: Buffer.concat([PDF, Buffer.from('tenant')]),
    });
    await t.http.get(`/v1/admin/files/${tenantFile}`).set(A()).expect(404);
    // platform files are not reachable on the owner surface (other audience → 401/403), nor a platform scope there
    const ownerTry = await t.http.get(`/v1/admin/files/${fileId}`).set(O());
    expect([401, 403]).toContain(ownerTry.status);
    await t.http
      .post('/v1/owner/files/presign')
      .set(O())
      .send({
        kind: 'other',
        scopeType: 'platform',
        fileName: 'p.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
        sha256: createHash('sha256').update(PDF).digest('hex'),
      })
      .expect(404);
    // wrong kind for a platform upload
    await t.http
      .post('/v1/admin/files/presign')
      .set(A())
      .send({
        kind: 'meter_photo',
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
      })
      .expect(422);

    const [tariff] = await q<{ id: string }>(
      `SELECT id FROM platform.utility_tariff WHERE provider = 'mea' AND tariff_code = '1.1.2'`,
    );
    // the seeded structure in force (entered from the PEA/MEA notice), re-entered for a future date
    const [seeded] = await q<{ structure: Record<string, unknown> }>(
      `SELECT structure FROM platform.utility_tariff_version
        WHERE utility_tariff_id = $1 ORDER BY effective_from DESC LIMIT 1`,
      [tariff!.id],
    );
    const structure = { ...seeded!.structure };
    delete structure.needsCheck;
    await t.http
      .post(`/v1/admin/utility-tariffs/${tariff!.id}/versions`)
      .set(A())
      .set(idem())
      .send({
        effectiveFrom: '2031-01-01',
        structure,
        sourceUrl: 'https://www.mea.or.th/',
        sourceDocumentId: tenantFile,
      })
      .expect(422);
    const entered = await t.http
      .post(`/v1/admin/utility-tariffs/${tariff!.id}/versions`)
      .set(A())
      .set(idem())
      .send({
        effectiveFrom: '2031-01-01',
        structure,
        sourceUrl: 'https://www.mea.or.th/',
        sourceDocumentId: fileId,
      });
    expect(entered.status).toBe(201);
    expect(entered.body).toMatchObject({ state: 'entered', sourceDocumentId: fileId });
    const listed = await t.http.get('/v1/admin/utility-tariffs').set(A()).expect(200);
    const version = (listed.body as { versions: { id: string; sourceDocumentId: string | null }[] }[])
      .flatMap((x) => x.versions)
      .find((v) => v.id === entered.body.id);
    expect(version?.sourceDocumentId).toBe(fileId);

    const sample = await t.http
      .get(`/v1/admin/utility-tariffs/versions/${entered.body.id}/charge?units=200`)
      .set(A())
      .expect(200);
    const expected = utilityCharge(structure as unknown as UtilityTariffStructure, { units: '200' });
    expect(sample.body).toEqual({
      units: expected.units,
      totalExVat: expected.totalExVat,
      effectiveAverageRate: expected.effectiveAverageRate,
      minimumApplied: expected.minimumApplied,
      lines: expected.lines,
    });
    await t.http
      .get(`/v1/admin/utility-tariffs/versions/${entered.body.id}/charge?units=0`)
      .set(A())
      .expect(422);
    await t.http.get(`/v1/admin/utility-tariffs/versions/${entered.body.id}/charge`).set(A()).expect(422);
    await t.http
      .get(`/v1/admin/utility-tariffs/versions/${randomUUID()}/charge?units=10`)
      .set(A())
      .expect(404);
  });

  it('owner pilot KPIs: 404 without a pilot agreement, the admin figures once there is one', async () => {
    await t.http.get('/v1/owner/pilot-kpis').set(O()).expect(404);
    await t.http
      .put(`/v1/admin/tenants/${DEV.tenantId}/pilot-agreement`)
      .set(A())
      .send({
        signedOn: '2026-10-01',
        discountPct: '30',
        termMonths: 6,
        baseline: { onTimePaymentPct: '60' },
      })
      .expect(200);
    const mine = await t.http.get('/v1/owner/pilot-kpis?window=30d').set(O()).expect(200);
    expect(mine.body).toMatchObject({ tenantId: DEV.tenantId, window: '30d', kpiReviewOn: '2026-12-30' });
    expect((mine.body.kpis as { kpi: string }[]).map((k) => k.kpi)).toEqual([
      'time_to_bill',
      'invoice_correction_rate',
      'on_time_payment',
      'auto_reconciled',
      'loss_identified',
      'meter_uptime',
      'csat',
    ]);
    const theirs = await t.http
      .get(`/v1/admin/tenants/${DEV.tenantId}/pilot-kpis?window=30d`)
      .set(A())
      .expect(200);
    expect(theirs.body.kpis).toEqual(mine.body.kpis);
    await t.http.get('/v1/owner/pilot-kpis?window=7d').set(O()).expect(422);
    // another tenant only ever sees its own (none)
    await t.http.get('/v1/owner/pilot-kpis').set(bearer(other.token)).expect(404);
  });

  it('integration events: paged list with filters, no payloads', async () => {
    const insert = (status: string, type: string, platform: string, tenantId: string | null) =>
      q(
        `INSERT INTO bridge.integration_event
           (direction, platform, event_type, contract_version, idempotency_key, tenant_id, subject_type, subject_id,
            payload, payload_sha256, status, occurred_at)
         VALUES ('outbound', $1::bridge.integration_platform, $2, '0.3.0', $3, $4, 'ops.service_request', $5,
                 '{"secret":"x"}', sha256('x'), $6::bridge.integration_status, now())`,
        [platform, type, randomUUID(), tenantId, randomUUID(), status],
      );
    await insert('pending', 'warranty.defect.reported', 'getbuild', DEV.tenantId);
    await insert('failed', 'warranty.defect.reported', 'getbuild', other.tenantId);
    await insert('acked', 'procurement.rfq.requested', 'getpack', DEV.tenantId);
    const all = await t.http.get('/v1/admin/integration-events?perPage=2').set(A()).expect(200);
    expect(all.body.meta).toMatchObject({ page: 1, perPage: 2, total: 3 });
    expect(all.body.data[0]).not.toHaveProperty('payload');
    expect(all.body.data[0].aggregateRef).toMatch(/^ops\.service_request:/);
    const failed = await t.http.get('/v1/admin/integration-events?state=failed').set(A()).expect(200);
    expect(failed.body.data).toHaveLength(1);
    expect(failed.body.data[0]).toMatchObject({
      tenantId: other.tenantId,
      state: 'failed',
      system: 'getbuild',
    });
    const getpack = await t.http.get('/v1/admin/integration-events?system=getpack').set(A()).expect(200);
    expect((getpack.body.data as { type: string }[]).map((e) => e.type)).toEqual([
      'procurement.rfq.requested',
    ]);
    const byType = await t.http.get('/v1/admin/integration-events?q=warranty').set(A()).expect(200);
    expect(byType.body.meta.total).toBe(2);
    await t.http.get('/v1/admin/integration-events?state=open').set(A()).expect(422);
    const denied = await t.http.get('/v1/admin/integration-events').set(O());
    expect([401, 403]).toContain(denied.status);
  });

  it('a tenant’s buildings for the console', async () => {
    const res = await t.http.get(`/v1/admin/tenants/${DEV.tenantId}/buildings`).set(A()).expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: DEV.buildingId,
        propertyId: DEV.propertyId,
        unitCount: 12,
        roles: ['owner', 'operator'],
      }),
    ]);
    const none = await t.http.get(`/v1/admin/tenants/${other.tenantId}/buildings`).set(A()).expect(200);
    expect(none.body).toEqual([]);
    await t.http.get(`/v1/admin/tenants/${randomUUID()}/buildings`).set(A()).expect(404);
  });

  it('platform-level DSRs move through the workflow; a tenant’s request stays with the tenant', async () => {
    const [user] = await q<{ id: string }>(
      `INSERT INTO core.user_account (display_name, email, phone_e164) VALUES ('ผู้ใช้ทดสอบ', 'dsr@example.invalid', '+660000000999')
       RETURNING id`,
    );
    const dsr = async (tenantId: string | null, kind: string, subject = user!.id) =>
      (
        await q<{ id: string }>(
          `INSERT INTO platform.data_subject_request (tenant_id, subject_type, subject_id, requester_contact_enc, kind, due_at)
           VALUES ($1, 'user', $2, '\\x00', $3::platform.dsr_kind, now() + interval '30 days') RETURNING id`,
          [tenantId, subject, kind],
        )
      )[0]!.id;
    const access = await dsr(null, 'access');
    const act = (id: string, action: string) =>
      t.http.post(`/v1/admin/data-subject-requests/${id}/actions/${action}`).set(A()).send({ notes: 'ok' });
    expect((await act(access, 'fulfil')).status).toBe(409); // received → fulfil is not a transition
    expect((await act(access, 'verify')).body).toMatchObject({ state: 'verifying', tenantId: null });
    expect((await act(access, 'start')).body).toMatchObject({ state: 'in_progress' });
    const fulfilled = await act(access, 'fulfil');
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body).toMatchObject({ state: 'fulfilled', exportDocumentId: expect.any(String) });
    const [doc] = await q<{ tenant_id: string | null; scope_type: string; kind: string }>(
      'SELECT tenant_id, scope_type, kind FROM core.document WHERE id = $1',
      [fulfilled.body.exportDocumentId],
    );
    expect(doc).toEqual({ tenant_id: null, scope_type: 'platform', kind: 'export' });

    // erasure of a login still working for a tenant is refused; of a free one it anonymises and disables
    const blocked = await dsr(null, 'erasure', DEV.users.staff);
    await act(blocked, 'start').expect(200);
    expect((await act(blocked, 'fulfil')).body.code).toBe('dsr.erasure_blocked');
    const erase = await dsr(null, 'erasure');
    await act(erase, 'start').expect(200);
    await act(erase, 'fulfil').expect(200);
    const [after] = await q<{ email: string | null; status: string; display_name: string }>(
      'SELECT email, status, display_name FROM core.user_account WHERE id = $1',
      [user!.id],
    );
    expect(after).toEqual({
      email: `erased+${user!.id}@erased.invalid`,
      status: 'disabled',
      display_name: 'ลบข้อมูลแล้ว (PDPA)',
    });

    const tenantOwned = await dsr(DEV.tenantId, 'access', DEV.users.owner);
    const r = await act(tenantOwned, 'verify');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('dsr.tenant_controlled');
    await act(randomUUID(), 'verify').expect(404);
    const audit = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE subject_id = $1 AND action IN ('dsr.transitioned','dsr.fulfilled')`,
      [access],
    );
    expect(audit[0]!.n).toBe(3);
  });

  it('setting history shows scheduled versions with platform, tenant and property scopes', async () => {
    const future = new Date(t.clock.now().getTime() + 30 * 86_400_000).toISOString();
    await t.http
      .put('/v1/owner/settings/reminders.schedule')
      .set(O())
      .send({ value: [2, 5], effectiveFrom: future, reason: 'เลื่อนการเตือน' })
      .expect(200);
    const res = await t.http.get('/v1/owner/settings/reminders.schedule/versions').set(O()).expect(200);
    expect(res.body[0]).toMatchObject({
      scope: 'tenant',
      value: [2, 5],
      scheduled: true,
      reason: 'เลื่อนการเตือน',
    });
    expect(
      (res.body as { scope: string; scheduled: boolean }[]).some(
        (v) => v.scope === 'platform' && !v.scheduled,
      ),
    ).toBe(true);
    // another tenant does not see my tenant's versions
    const theirs = await t.http
      .get('/v1/owner/settings/reminders.schedule/versions')
      .set(bearer(other.token))
      .expect(200);
    expect((theirs.body as { scope: string }[]).every((v) => v.scope === 'platform')).toBe(true);
    await t.http
      .get(`/v1/owner/settings/reminders.schedule/versions?propertyId=${DEV.propertyId}`)
      .set(bearer(other.token))
      .expect(404);
    await t.http.get('/v1/owner/settings/health.gateway_missed_heartbeats/versions').set(O()).expect(404);
    await t.http.get('/v1/owner/settings/no.such.key/versions').set(O()).expect(404);
  });

  it('site surveys filter by SiteSurveyState', async () => {
    await t.http.get('/v1/admin/site-surveys?state=requested').set(A()).expect(200);
    await t.http.get('/v1/admin/site-surveys?state=open').set(A()).expect(422);
  });
});

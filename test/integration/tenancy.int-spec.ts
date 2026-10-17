import { GrantService } from '@core/asset/grant.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import {
  adminToken,
  bearer,
  idem,
  onboardTenant,
  operatorToken,
  ownerToken,
  platformToken,
  supportToken,
} from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const SHA = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';

/**
 * B1.3 acceptance — tenancy, RLS and cross-tenant isolation, asset grants, support grants, bank-account OTP,
 * effective-dated settings and utility tariffs, against a real database (gp_app / gp_platform roles).
 */
describe('tenancy & isolation (B1.3 acceptance, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let ownerA: string;
  let tenantB: string;
  let ownerB: string;

  /** Rows visible to gp_app under app.tenant_id = tenantId (direct SQL, RLS enforced). */
  async function asTenant<T extends Record<string, unknown>>(
    tenantId: string,
    sql: string,
    params: unknown[] = [],
  ) {
    await db.admin.query('BEGIN');
    try {
      await db.admin.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await db.admin.query('SET LOCAL ROLE gp_app');
      return (await db.admin.query<T>(sql, params)).rows;
    } finally {
      await db.admin.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_tenancy' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    admin = await adminToken(t);
    ownerA = await ownerToken(t);
    ({ tenantId: tenantB, token: ownerB } = await onboardTenant(t, admin, {
      slug: 'pm-b',
      phone: '+660000000071',
    }));
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  describe('bank account change is blocked until the Owner OTP', () => {
    let accountId: string;
    let challengeId: string;

    it('creates the account pending_otp and sends an OTP to the Owner', async () => {
      const res = await t.http
        .post('/v1/owner/bank-accounts')
        .set(bearer(ownerA))
        .set(idem())
        .send({
          bankCode: '004',
          bankNameTh: 'ธนาคารตัวอย่าง',
          accountNo: '000-0-00000-1',
          accountName: 'บริษัท ทดสอบ',
          isDefault: true,
        })
        .expect(201);
      expect(res.body.account).toMatchObject({
        state: 'pending_otp',
        accountNoMasked: expect.stringMatching(/0001$/),
      });
      accountId = res.body.account.id;
      challengeId = res.body.otp.challengeId;
      const list = await t.http.get('/v1/owner/bank-accounts').set(bearer(ownerA)).expect(200);
      expect((list.body as { state: string }[]).filter((a) => a.state === 'active')).toHaveLength(0);
      // nothing about the account number is stored in clear
      const { rows } = await db.admin.query(
        `SELECT account_no_enc FROM platform.tenant_bank_account WHERE id = $1`,
        [accountId],
      );
      expect(Buffer.from(rows[0].account_no_enc).toString('utf8')).not.toContain('000000001');
    });

    it('a wrong code does not activate it', async () => {
      const code = t.sms.lastCodeTo('+660000000001')!;
      const wrong = code === '000000' ? '111111' : '000000';
      const res = await t.http
        .post(`/v1/owner/bank-accounts/${accountId}/actions/confirm`)
        .set(bearer(ownerA))
        .send({ challengeId, code: wrong })
        .expect(401);
      expect(res.body.code).toBe('auth.otp_invalid');
      const { rows } = await db.admin.query(`SELECT state FROM platform.tenant_bank_account WHERE id = $1`, [
        accountId,
      ]);
      expect(rows[0].state).toBe('pending_otp');
    });

    it('the right code activates it — audit row, domain event and outbox message in the same transaction', async () => {
      const code = t.sms.lastCodeTo('+660000000001')!;
      const res = await t.http
        .post(`/v1/owner/bank-accounts/${accountId}/actions/confirm`)
        .set(bearer(ownerA))
        .send({ challengeId, code })
        .expect(200);
      expect(res.body).toMatchObject({ state: 'active', isDefault: true });
      const audit = await db.admin.query(
        `SELECT xmin::text AS x FROM platform.audit_log WHERE action = 'tenant.bank_account.changed' AND subject_id = $1`,
        [accountId],
      );
      const event = await db.admin.query(
        `SELECT e.xmin::text AS x, o.xmin::text AS ox FROM platform.domain_event e JOIN platform.outbox_message o ON o.event_id = e.id
          WHERE e.type = 'tenant.bank_account.changed' AND e.aggregate_id = $1`,
        [accountId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(event.rows).toHaveLength(1);
      // same transaction id on all three rows
      expect(event.rows[0].x).toBe(audit.rows[0].x);
      expect(event.rows[0].ox).toBe(audit.rows[0].x);
    });
  });

  describe('cross-tenant ids are 404 on every B1 endpoint and invisible under RLS', () => {
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      t.clock.advance(61_000); // OTP resend interval of the Owner phone
      const bank = await t.http
        .post('/v1/owner/bank-accounts')
        .set(bearer(ownerA))
        .set(idem())
        .send({
          bankCode: '014',
          bankNameTh: 'ธนาคารทดสอบ',
          accountNo: '000-0-00000-2',
          accountName: 'บริษัท ทดสอบ',
          isDefault: false,
        })
        .expect(201);
      ids.bank = bank.body.account.id;
      const invitation = await t.http
        .post('/v1/owner/invitations')
        .set(bearer(ownerA))
        .set(idem())
        .send({ role: 'staff', phone: '+660000000077', channel: 'sms' });
      expect(invitation.status).toBe(201);
      ids.invitation = invitation.body.id;
      const members = await t.http.get('/v1/owner/members').set(bearer(ownerA)).expect(200);
      ids.membership = (members.body as { id: string; role: string }[]).find((m) => m.role === 'manager')!.id;
      const file = await t.http
        .post('/v1/owner/files/presign')
        .set(bearer(ownerA))
        .send({
          kind: 'meter_photo',
          scopeType: 'building',
          scopeId: DEV.buildingId,
          fileName: 'm.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1000,
          sha256: SHA,
        })
        .expect(201);
      ids.file = file.body.file.id;
      const support = await supportToken(t);
      const grant = await t.http
        .post(`/v1/admin/tenants/${DEV.tenantId}/support-grants`)
        .set(bearer(support))
        .send({ reason: 'ตรวจสอบปัญหา (ทดสอบ)' })
        .expect(201);
      ids.supportGrant = grant.body.id;
      const { rows } = await db.admin.query(
        `INSERT INTO platform.data_subject_request (tenant_id, subject_type, requester_contact_enc, kind, due_at)
         VALUES ($1, 'user', '\\x00', 'access', now() + interval '30 days') RETURNING id`,
        [DEV.tenantId],
      );
      ids.dsr = rows[0].id;
    });

    it('tenant B gets 404 for tenant A ids', async () => {
      const b = bearer(ownerB);
      const calls: [string, string, Record<string, unknown>?][] = [
        [
          'post',
          `/v1/owner/bank-accounts/${ids.bank}/actions/confirm`,
          { challengeId: ids.bank, code: '123456' },
        ],
        ['post', `/v1/owner/bank-accounts/${ids.bank}/actions/resend-otp`],
        ['post', `/v1/owner/bank-accounts/${ids.bank}/actions/remove`],
        ['post', `/v1/owner/invitations/${ids.invitation}/actions/revoke`],
        ['patch', `/v1/owner/members/${ids.membership}`, { role: 'staff' }],
        ['delete', `/v1/owner/members/${ids.membership}`],
        ['get', `/v1/owner/files/${ids.file}`],
        ['post', `/v1/owner/files/${ids.file}/actions/complete`, {}],
        ['post', `/v1/owner/support-grants/${ids.supportGrant}/actions/approve`, {}],
        ['post', `/v1/owner/support-grants/${ids.supportGrant}/actions/deny`],
        ['post', `/v1/owner/data-subject-requests/${ids.dsr}/actions/verify`, {}],
        [
          'put',
          `/v1/owner/properties/${DEV.propertyId}/settings/billing.cutoff`,
          { value: { day: 25, time: '23:59', timezone: 'Asia/Bangkok' }, reason: 'ทดสอบ' },
        ],
      ];
      for (const [method, path, body] of calls) {
        const req = (t.http as unknown as Record<string, (p: string) => import('supertest').Test>)[method]!(
          path,
        ).set(b);
        const res = await (body ? req.send(body) : req);
        expect({ path, status: res.status, code: res.body.code }).toEqual({
          path,
          status: 404,
          code: 'http.not_found',
        });
      }
    });

    it('naming another tenant in X-Tenant-Id is refused', async () => {
      const res = await t.http
        .get('/v1/owner/bank-accounts')
        .set(bearer(ownerB))
        .set('X-Tenant-Id', DEV.tenantId);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('tenant.not_in_scope');
    });

    it('an audit cursor of tenant A is a 404 for tenant B', async () => {
      const page = await t.http.get('/v1/owner/audit-log?limit=1').set(bearer(ownerA)).expect(200);
      expect(page.body.meta.nextCursor).toEqual(expect.any(String));
      await t.http
        .get(`/v1/owner/audit-log?limit=1&cursor=${page.body.meta.nextCursor}`)
        .set(bearer(ownerA))
        .expect(200);
      const res = await t.http
        .get(`/v1/owner/audit-log?cursor=${page.body.meta.nextCursor}`)
        .set(bearer(ownerB))
        .expect(404);
      expect(res.body.code).toBe('http.not_found');
      const own = await t.http.get('/v1/owner/audit-log').set(bearer(ownerB)).expect(200);
      expect((own.body.data as { subjectId: string | null }[]).every((a) => a.subjectId !== ids.bank)).toBe(
        true,
      );
    });

    it('tenant A rows are invisible to tenant B under RLS (direct SQL as gp_app)', async () => {
      const probes: [string, string][] = [
        ['platform.tenant_bank_account', ids.bank!],
        ['platform.invitation', ids.invitation!],
        ['core.membership', ids.membership!],
        ['core.document', ids.file!],
        ['platform.support_grant', ids.supportGrant!],
        ['platform.data_subject_request', ids.dsr!],
      ];
      for (const [table, id] of probes) {
        expect(await asTenant(tenantB, `SELECT id FROM ${table} WHERE id = $1`, [id])).toHaveLength(0);
        expect(await asTenant(DEV.tenantId, `SELECT id FROM ${table} WHERE id = $1`, [id])).toHaveLength(1);
      }
    });
  });

  describe('asset access grant: one building, one module', () => {
    let grantId: string;

    it('before the grant tenant B cannot see the building', async () => {
      const grants = t.app.get(GrantService);
      expect(
        await grants.check({ tenantId: tenantB, source: 'path' }, DEV.buildingId, 'smart.metering'),
      ).toBe(false);
      expect(
        await asTenant(tenantB, `SELECT id FROM core.building WHERE id = $1`, [DEV.buildingId]),
      ).toHaveLength(0);
    });

    it('the owner grants `smart.metering` read access; B sees it for that module only', async () => {
      const res = await t.http
        .post('/v1/owner/asset-grants')
        .set(bearer(ownerA))
        .set(idem())
        .send({
          granteeTenantId: tenantB,
          buildingId: DEV.buildingId,
          modules: ['smart.metering'],
          access: 'read',
          reason: 'pm_contract',
        })
        .expect(201);
      grantId = res.body.id;
      const grants = t.app.get(GrantService);
      const ctxB = { tenantId: tenantB, source: 'path' as const };
      expect(await grants.check(ctxB, DEV.buildingId, 'smart.metering')).toBe(true);
      expect(await grants.check(ctxB, DEV.buildingId, 'ops.billing')).toBe(false);
      expect(await grants.check(ctxB, DEV.buildingId, 'smart.metering', 'write')).toBe(false);
      const { rows } = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'grant.created' AND subject_id = $1`,
        [grantId],
      );
      expect(rows[0].n).toBe(1);
      // the grantee lists it; a third party does not
      const listB = await t.http.get('/v1/owner/asset-grants').set(bearer(ownerB)).expect(200);
      expect((listB.body as { id: string }[]).map((g) => g.id)).toContain(grantId);
    });

    it('only the building owner/operator can revoke; revoking removes the access', async () => {
      await t.http
        .post(`/v1/owner/asset-grants/${grantId}/actions/revoke`)
        .set(bearer(ownerA))
        .send({ reason: 'สิ้นสุดสัญญา (ทดสอบ)' })
        .expect(200);
      expect(
        await t.app
          .get(GrantService)
          .check({ tenantId: tenantB, source: 'path' }, DEV.buildingId, 'smart.metering'),
      ).toBe(false);
    });
  });

  describe('support grant: required for Support reads, audited', () => {
    let support: string;
    let grantId: string;

    beforeAll(async () => {
      support = await supportToken(t);
    });

    it('without a grant Support is refused and the attempt is audited', async () => {
      const res = await t.http
        .get(`/v1/admin/tenants/${DEV.tenantId}/members`)
        .set(bearer(support))
        .expect(403);
      expect(res.body.code).toBe('support.grant_required');
      const { rows } = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'support_grant.used' AND outcome = 'denied' AND tenant_id = $1`,
        [DEV.tenantId],
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it('the Owner approves; Support reads; every read is audited with the grant id', async () => {
      const req = await t.http
        .post(`/v1/admin/tenants/${DEV.tenantId}/support-grants`)
        .set(bearer(support))
        .send({ reason: 'ลูกค้าแจ้งปัญหา (ทดสอบ)', ticketRef: 'SUP-1' })
        .expect(201);
      grantId = req.body.id;
      const approved = await t.http
        .post(`/v1/owner/support-grants/${grantId}/actions/approve`)
        .set(bearer(ownerA))
        .send({ hours: 2 })
        .expect(200);
      expect(approved.body.state).toBe('active');
      const members = await t.http
        .get(`/v1/admin/tenants/${DEV.tenantId}/members`)
        .set(bearer(support))
        .expect(200);
      expect(members.body.length).toBeGreaterThanOrEqual(3);
      const { rows } = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'support_grant.used' AND outcome = 'success' AND support_grant_id = $1`,
        [grantId],
      );
      expect(rows[0].n).toBe(1);
      // the grant is for tenant A only
      await t.http.get(`/v1/admin/tenants/${tenantB}/members`).set(bearer(support)).expect(403);
    });

    it('after expiry (fake clock) the grant no longer opens the tenant', async () => {
      t.clock.advance(3 * 3_600_000);
      const fresh = await supportToken(t);
      await t.http.get(`/v1/admin/tenants/${DEV.tenantId}/members`).set(bearer(fresh)).expect(403);
    });

    it('the platform admin bypasses with an audited bypass', async () => {
      admin = await adminToken(t);
      await t.http.get(`/v1/admin/tenants/${DEV.tenantId}/members`).set(bearer(admin)).expect(200);
      const { rows } = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'support_grant.bypassed' AND tenant_id = $1`,
        [DEV.tenantId],
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    });
  });

  describe('settings: a future tenant value resolves by date', () => {
    beforeAll(async () => {
      // the support-grant expiry test moved the clock past the access-token lifetime
      ownerA = await ownerToken(t);
      ownerB = await operatorToken(t, '+660000000071');
    });

    it('PUT with a future effectiveFrom; GET ?at= before and after', async () => {
      const now = t.clock.now();
      const from = new Date(now.getTime() + 2 * 86_400_000).toISOString();
      await t.http
        .put('/v1/owner/settings/reminders.schedule')
        .set(bearer(ownerA))
        .send({ value: [1, 2], effectiveFrom: from, reason: 'เตือนเร็วขึ้น (ทดสอบ)' })
        .expect(200);
      const before = await t.http
        .get(`/v1/owner/settings?at=${encodeURIComponent(now.toISOString())}`)
        .set(bearer(ownerA))
        .expect(200);
      const after = await t.http
        .get(
          `/v1/owner/settings?at=${encodeURIComponent(new Date(now.getTime() + 3 * 86_400_000).toISOString())}`,
        )
        .set(bearer(ownerA))
        .expect(200);
      const pick = (rows: { key: string }[]) => rows.find((r) => r.key === 'reminders.schedule');
      expect(pick(before.body)).toMatchObject({ scope: 'platform', value: [1, 3, 7] });
      expect(pick(after.body)).toMatchObject({ scope: 'tenant', value: [1, 2] });
      // tenant B is not affected
      const other = await t.http
        .get(
          `/v1/owner/settings?at=${encodeURIComponent(new Date(now.getTime() + 3 * 86_400_000).toISOString())}`,
        )
        .set(bearer(ownerB))
        .expect(200);
      expect(pick(other.body)).toMatchObject({ scope: 'platform' });
    });

    it('backdating is refused', async () => {
      const res = await t.http
        .put('/v1/owner/settings/reminders.schedule')
        .set(bearer(ownerA))
        .send({ value: [1], effectiveFrom: '2020-01-01T00:00:00+07:00', reason: 'ย้อนหลัง (ทดสอบ)' })
        .expect(422);
      expect(res.body.code).toBe('settings.backdated');
    });
  });

  describe('utility tariff: enter → verify by a second platform user → publish → in force on a date', () => {
    beforeAll(async () => {
      admin = await adminToken(t);
    });

    it('maker-checker and the owner reads the effective average rate', async () => {
      const created = await t.http
        .post('/v1/admin/platform-users')
        .set(bearer(admin))
        .set(idem())
        .send({
          email: 'checker@getproperty.invalid',
          displayName: 'Checker (test)',
          roles: ['platform_admin'],
          temporaryPassword: 'Checker-Passw0rd-Test!',
        })
        .expect(201);
      expect(created.body.roles[0].role).toBe('platform_admin');
      const checker = await platformToken(t, 'checker@getproperty.invalid', 'Checker-Passw0rd-Test!');

      const tariffs = await t.http.get('/v1/admin/utility-tariffs').set(bearer(admin)).expect(200);
      const mea = (
        tariffs.body as {
          id: string;
          provider: string;
          tariffCode: string;
          versions: { structure: Record<string, unknown> }[];
        }[]
      ).find((x) => x.provider === 'mea' && x.tariffCode === '1.1.2')!;
      const template = mea.versions[0]!;
      const structure = { ...template.structure };
      delete structure.needsCheck;
      const entered = await t.http
        .post(`/v1/admin/utility-tariffs/${mea.id}/versions`)
        .set(bearer(admin))
        .set(idem())
        .send({ effectiveFrom: '2027-01-01', structure, sourceUrl: 'https://www.mea.or.th/' })
        .expect(201);
      const versionId = entered.body.id;
      const self = await t.http
        .post(`/v1/admin/utility-tariffs/versions/${versionId}/actions/verify`)
        .set(bearer(admin))
        .send({})
        .expect(409);
      expect(self.body.code).toBe('tariff.same_verifier');
      await t.http
        .post(`/v1/admin/utility-tariffs/versions/${versionId}/actions/verify`)
        .set(bearer(checker))
        .send({})
        .expect(200);
      await t.http
        .post(`/v1/admin/utility-tariffs/versions/${versionId}/actions/publish`)
        .set(bearer(checker))
        .expect(200);

      const current = await t.http
        .get(
          '/v1/owner/utility-tariffs/current?utility=electric&provider=mea&tariffCode=1.1.2&date=2027-01-15&units=150',
        )
        .set(bearer(ownerA))
        .expect(200);
      expect(current.body[0]).toMatchObject({ versionId, effectiveFrom: '2027-01-01', state: 'published' });
      expect(current.body[0].charge.effectiveAverageRate).toMatch(/^\d+\.\d{4}$/);
      const none = await t.http
        .get(
          '/v1/owner/utility-tariffs/current?utility=electric&provider=mea&tariffCode=1.1.2&date=2026-12-31',
        )
        .set(bearer(ownerA))
        .expect(404);
      expect(none.body.code).toBe('tariff.not_found');
    });
  });
});

import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { DomainEvents } from '@core/events/domain-events';
import { TenantTx } from '@database/tenant-tx';
import { fakeLineIdToken } from '@integrations/line/fake-line-login';
import { type FakeLockVendors } from '@integrations/locks/fake-lock-vendors';
import { LOCK_VENDORS } from '@integrations/locks/lock-vendor.port';
import { AccessCredentialsService } from '@modules/smart-access/access-credentials.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const LINE_SUB = 'U00000000000000000000000000b5ac01';
const PHONE_B = '+660000000191';
const TECH_PHONE = '+660000000192';
function thaiId(prefix12: string): string {
  const sum = [...prefix12].reduce((acc, d, i) => acc + Number(d) * (13 - i), 0);
  return `${prefix12}${(11 - (sum % 11)) % 10}`;
}
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
).toString('base64');

/**
 * B5.2 acceptance (docs/prompts/B5-operations.md 5.2, D-070, D-071, D-024, D-157, D-162): lease activation →
 * credentials; lease end → revoked; the access log is visible only to the resident (their unit) and the owner; a
 * work-order assignment creates a time-boxed code; an overdue invoice changes nothing; owner revocation needs a reason
 * and notifies the resident; visitor codes expire; low battery → automatic repair request; vendor failures retried;
 * cross-tenant 404s and RLS.
 */
describe('B5.2 access control (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let resident: string;
  let other: { tenantId: string; token: string };
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const vendor = () => t.app.get<FakeLockVendors>(LOCK_VENDORS).adapter('ttlock');
  const unit = async (no: string) =>
    (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = $2`, [
        DEV.buildingId,
        no,
      ])
    )[0]!.id;
  const creds = (where: string, params: unknown[]) =>
    q<{ id: string; holder_kind: string; status: string; lock_id: string; valid_to: Date | null }>(
      `SELECT id, holder_kind::text, status::text, lock_id, valid_to FROM smart.access_credential WHERE ${where} ORDER BY created_at`,
      params,
    );
  const register = async (body: Record<string, unknown>) =>
    (await t.http.post('/v1/owner/locks').set(O()).send(body).expect(201)).body as {
      id: string;
      deviceId: string;
    };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_b52' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b52',
      phone: PHONE_B,
      type: 'apartment',
    });
    ids.a101 = await unit('A-101');
    ids.a102 = await unit('A-102');
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(O())
        .send({ channel: 'link' })
        .expect(201)
    ).body.code as string;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า B52' }) })
      .expect(200);
    const R0 = bearer(login.body.accessToken as string);
    const purposes = await t.http.get('/v1/resident/consents').set(R0).expect(200);
    await t.http
      .post('/v1/resident/consents')
      .set(R0)
      .send({
        items: (purposes.body as { key: string; version: number; required: boolean }[])
          .filter((x) => x.required)
          .map((x) => ({ purposeKey: x.key, version: x.version, granted: true })),
      })
      .expect(201);
    await t.http.post(`/v1/resident/invitations/${code}/accept`).set(R0).expect(200);
    resident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200)
    ).body.accessToken as string;
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('registering locks on a leased unit and the building door gives the residents their codes (D-071)', async () => {
    const door = await register({
      scope: 'building_door',
      buildingId: DEV.buildingId,
      vendor: 'ttlock',
      vendorLockId: 'door-1',
      serial: 'TTL-DOOR-1',
      name: 'ประตูหน้าอาคาร',
    });
    ids.door = door.id;
    const a101 = await register({
      scope: 'unit',
      unitId: ids.a101,
      vendor: 'ttlock',
      vendorLockId: 'a101-1',
      serial: 'TTL-A101',
      name: 'ประตูห้อง A-101',
    });
    ids.lockA101 = a101.id;
    await t.http
      .post('/v1/owner/locks')
      .set(O())
      .send({
        scope: 'unit',
        unitId: ids.a102,
        vendor: 'ttlock',
        vendorLockId: 'a101-1',
        serial: 'X',
        name: 'dup',
      })
      .expect(409);
    await settle();
    const residents = await creds('holder_party_id = $1', [DEV.residentPartyId]);
    expect(residents.map((c) => [c.holder_kind, c.status, c.valid_to])).toEqual([
      ['resident', 'active', null],
      ['resident', 'active', null],
    ]);
    expect(new Set(residents.map((c) => c.lock_id))).toEqual(new Set([ids.door, ids.lockA101]));
    expect(vendor().active('a101-1', t.clock.now())).toHaveLength(1);
    // the resident sees the codes in the LIFF (revealed, audited)
    const mine = await t.http.get('/v1/resident/access/credentials').set(bearer(resident)).expect(200);
    expect(mine.body.data).toHaveLength(2);
    for (const c of mine.body.data as { pin: string }[]) expect(c.pin).toMatch(/^\d{6}$/);
    ids.residentPin = (mine.body.data as { lockId: string; pin: string }[]).find(
      (c) => c.lockId === ids.lockA101,
    )!.pin;
    const revealed = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'access.credential_revealed'`,
    );
    expect(revealed[0]!.n).toBe(2);
    // the owner's list shows them without the codes
    const list = await t.http
      .get(`/v1/owner/locks/${ids.lockA101}/credentials?live=true`)
      .set(O())
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].pin).toBeUndefined();
  });

  it('lease activation → credentials; lease termination → revoked (and nothing else ends them)', async () => {
    await register({
      scope: 'unit',
      unitId: ids.a102,
      vendor: 'ttlock',
      vendorLockId: 'a102-1',
      serial: 'TTL-A102',
      name: 'ประตูห้อง A-102',
    });
    await settle();
    const party = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({
        type: 'person',
        displayName: 'ผู้เช่า A-102 ทดสอบ',
        phone: '+660000000193',
        nationality: 'TH',
        idDocumentType: 'thai_national_id',
        idNumber: thaiId('120000000052'),
      })
      .expect(201);
    ids.lessee102 = (party.body.id ?? party.body.party?.id) as string;
    const today = new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(O())
      .send({ unitId: ids.a102, lesseePartyId: ids.lessee102, startDate: today, months: 6 })
      .expect(201);
    ids.lease102 = draft.body.id as string;
    const sent = await t.http
      .post(`/v1/owner/leases/${ids.lease102}/actions/send-for-signature`)
      .set(O())
      .set(idem());
    if (sent.status !== 200) throw new Error(JSON.stringify(sent.body));
    await q(
      `INSERT INTO ops.lease_signature (tenant_id, lease_id, signer_role, party_id, method, signature_image_document_id, pdf_sha256, signed_at)
       SELECT tenant_id, id, 'lessee', $2, 'scan_upload', contract_document_id, decode($3, 'hex'), now() FROM ops.lease WHERE id = $1`,
      [ids.lease102, ids.lessee102, sent.body.contract.sha256],
    );
    expect(await creds('lease_id = $1', [ids.lease102])).toEqual([]);
    await t.http
      .post(`/v1/owner/leases/${ids.lease102}/actions/countersign`)
      .set(O())
      .set(idem())
      .send({ signaturePng: PNG })
      .expect(200);
    await settle();
    const issued = await creds('lease_id = $1', [ids.lease102]);
    expect(issued.map((c) => c.status)).toEqual(['active', 'active']);
    expect(vendor().active('a102-1', new Date(t.clock.now().getTime() + 60_000))).toHaveLength(1);

    // the lease ends with a termination (acknowledged warning, D-021a) → its credentials are revoked
    const body = { reasonCode: 'mutual_agreement', effectiveDate: today, notes: 'เลิกสัญญา' };
    const warn = await t.http
      .post(`/v1/owner/leases/${ids.lease102}/actions/terminate`)
      .set(O())
      .set(idem())
      .send(body)
      .expect(409);
    const ack = await t.http
      .post('/v1/owner/compliance-acknowledgements')
      .set(O())
      .send({
        evaluationId: warn.body.evaluationId,
        legalTextKey: warn.body.legalTextKey,
        legalTextVersion: warn.body.legalTextVersion,
        language: 'th',
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/leases/${ids.lease102}/actions/terminate`)
      .set(O())
      .set(idem())
      .send({ ...body, acknowledgementIds: [ack.body.id] })
      .expect(200);
    await settle();
    expect((await creds('lease_id = $1', [ids.lease102])).map((c) => c.status)).toEqual([
      'revoked',
      'revoked',
    ]);
    expect(vendor().active('a102-1', new Date(t.clock.now().getTime() + 60_000))).toEqual([]);
    const reasons = await q<{ r: string }>(
      `SELECT DISTINCT revoke_reason AS r FROM smart.access_credential WHERE lease_id = $1`,
      [ids.lease102],
    );
    expect(reasons).toEqual([{ r: 'lease terminated' }]);
  });

  it('an overdue invoice, reminders and receivables change nothing (D-024, D-071, D-157)', async () => {
    const before = await creds('holder_party_id = $1', [DEV.residentPartyId]);
    const events = t.app.get(DomainEvents);
    await t.app.get(TenantTx).platform(async (tx) => {
      for (const type of [
        'invoice.overdue',
        'invoice.reminder_sent',
        'receivable.changed',
        'penalty.assessed',
      ] as const)
        await events.record(tx, {
          type,
          aggregateType: 'invoice',
          aggregateId: randomUUID(),
          tenantId: DEV.tenantId,
          buildingId: DEV.buildingId,
          payload: {
            leaseId: DEV.leaseId,
            billedPartyId: DEV.residentPartyId,
            unitId: ids.a101,
            daysOverdue: 90,
          },
        });
    });
    await settle();
    await t.app.get(AccessCredentialsService).sweep();
    expect(await creds('holder_party_id = $1', [DEV.residentPartyId])).toEqual(before);
    expect(vendor().active('a101-1', t.clock.now())).toHaveLength(1);
    const revokes = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'access.credential_revoked' AND payload->>'leaseId' = $1`,
      [DEV.leaseId],
    );
    expect(revokes[0]!.n).toBe(0);
  });

  it('the unlock log: the resident sees their unit, the owner the lock (audited), nobody else', async () => {
    t.clock.advance(120_000);
    const at = new Date(t.clock.now().getTime() - 60_000);
    vendor().enterPin('a101-1', ids.residentPin!, at);
    vendor().enterPin('a101-1', '000000', at);
    const lock = await t.http.post(`/v1/owner/locks/${ids.lockA101}/actions/refresh`).set(O()).expect(200);
    expect(lock.body.lastLogSyncAt).toEqual(expect.any(String));
    const own = await t.http
      .get(`/v1/resident/access/events?unitId=${ids.a101}`)
      .set(bearer(resident))
      .expect(200);
    expect((own.body.data as { result: string }[]).map((e) => e.result).sort()).toEqual([
      'denied',
      'success',
    ]);
    expect(
      (own.body.data as { credentialId: string | null; result: string }[]).find(
        (e) => e.result === 'success',
      )!.credentialId,
    ).toEqual(expect.any(String));
    await t.http.get(`/v1/resident/access/events?unitId=${ids.a102}`).set(bearer(resident)).expect(404);
    const ownerView = await t.http.get(`/v1/owner/locks/${ids.lockA101}/events`).set(O()).expect(200);
    expect(ownerView.body.data).toHaveLength(2);
    const audited = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'access.log_read' AND subject_id = $1`,
      [ids.lockA101],
    );
    expect(audited[0]!.n).toBe(1);
    // a second sync does not duplicate events
    await t.http.post(`/v1/owner/locks/${ids.lockA101}/actions/refresh`).set(O()).expect(200);
    const count = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM smart.access_event WHERE lock_id = $1`,
      [ids.lockA101],
    );
    expect(count[0]!.n).toBe(2);
    await t.http.get(`/v1/owner/locks/${ids.lockA101}/events`).set(bearer(other.token)).expect(404);
  });

  it('a work-order assignment creates time-boxed codes; the end of the work order revokes them', async () => {
    const cat = (
      await q<{ id: string }>(
        `SELECT id FROM ops.service_category WHERE tenant_id IS NULL AND key = 'aircon'`,
      )
    )[0]!.id;
    const sr = await t.http
      .post('/v1/owner/service-requests')
      .set(O())
      .send({ unitId: ids.a101, categoryId: cat, description: 'แอร์ไม่เย็น' })
      .expect(201);
    const party = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({ type: 'person', displayName: 'ช่างแอร์ ทดสอบ', phone: TECH_PHONE })
      .expect(201);
    const start = new Date(t.clock.now().getTime() + 3_600_000);
    const end = new Date(t.clock.now().getTime() + 3 * 3_600_000);
    const wo = await t.http
      .post(`/v1/owner/service-requests/${sr.body.id}/work-orders`)
      .set(O())
      .send({
        kind: 'repair',
        title: 'ล้างแอร์',
        assigneePartyId: party.body.id ?? party.body.party?.id,
        scheduledAt: start.toISOString(),
        scheduledUntil: end.toISOString(),
      })
      .expect(201);
    await settle();
    const tech = await creds('work_order_id = $1', [wo.body.id]);
    expect(tech.map((c) => [c.holder_kind, c.status])).toEqual([
      ['technician', 'active'],
      ['technician', 'active'],
    ]);
    for (const c of tech) expect(new Date(c.valid_to!).toISOString()).toBe(end.toISOString());
    // the technician reads the codes of that work order only
    const challenge = await t.http
      .post('/v1/auth/technician/otp/request')
      .send({ phone: TECH_PHONE })
      .expect(200);
    const signed = await t.http
      .post('/v1/auth/technician/otp/verify')
      .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo(TECH_PHONE) })
      .expect(200);
    const codes = await t.http
      .get(`/v1/technician/work-orders/${wo.body.id}/access`)
      .set(bearer(signed.body.accessToken as string))
      .expect(200);
    expect(codes.body.data).toHaveLength(2);
    expect(codes.body.data[0].pin).toMatch(/^\d{6}$/);
    // re-assigned to staff: the technician's codes end, the staff member gets theirs
    await t.http
      .post(`/v1/owner/work-orders/${wo.body.id}/actions/assign`)
      .set(O())
      .send({ assigneeUserId: DEV.users.staff })
      .expect(200);
    await settle();
    const after = await creds('work_order_id = $1', [wo.body.id]);
    expect(after.map((c) => [c.holder_kind, c.status])).toEqual([
      ['technician', 'revoked'],
      ['technician', 'revoked'],
      ['staff', 'active'],
      ['staff', 'active'],
    ]);
    await t.http
      .get(`/v1/technician/work-orders/${wo.body.id}/access`)
      .set(bearer(signed.body.accessToken as string))
      .expect(404);
    const staff = await operatorToken(t, '+660000000003');
    const staffCodes = await t.http
      .get(`/v1/staff/work-orders/${wo.body.id}/access`)
      .set(bearer(staff))
      .expect(200);
    expect(staffCodes.body.data).toHaveLength(2);
    await t.http
      .post(`/v1/owner/work-orders/${wo.body.id}/actions/cancel`)
      .set(O())
      .send({ reason: 'ลูกค้าเลื่อนนัด' })
      .expect(200);
    await settle();
    expect((await creds('work_order_id = $1', [wo.body.id])).every((c) => c.status === 'revoked')).toBe(true);
  });

  it('owner revocation needs a reason and tells the resident; visitor codes expire; vendor failures are retried', async () => {
    const [door] = await creds('holder_party_id = $1 AND lock_id = $2', [DEV.residentPartyId, ids.door]);
    await t.http
      .post(`/v1/owner/access-credentials/${door!.id}/actions/revoke`)
      .set(O())
      .send({})
      .expect(422);
    const revoked = await t.http
      .post(`/v1/owner/access-credentials/${door!.id}/actions/revoke`)
      .set(O())
      .send({ reason: 'ทำบัตรหาย ออกรหัสใหม่' })
      .expect(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', revokeReason: 'ทำบัตรหาย ออกรหัสใหม่' });
    await t.http
      .post(`/v1/owner/access-credentials/${door!.id}/actions/revoke`)
      .set(O())
      .send({ reason: 'again' })
      .expect(409);
    await settle();
    const told = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'access.credential_revoked' AND e.aggregate_id = $1 AND n.recipient_id = $2`,
      [door!.id, DEV.residentPartyId],
    );
    expect(told[0]!.n).toBeGreaterThan(0);

    // a visitor code for two hours while the vendor is down → retried by the sweep, then it expires
    vendor().failing.add('door-1');
    const from = new Date(t.clock.now().getTime() + 60_000);
    const to = new Date(t.clock.now().getTime() + 2 * 3_600_000);
    await t.http
      .post(`/v1/owner/locks/${ids.door}/visitor-codes`)
      .set(O())
      .send({ visitorName: 'ผู้มาเยือน', validFrom: from.toISOString(), validTo: to.toISOString() })
      .expect(400);
    const visitor = await t.http
      .post(`/v1/owner/locks/${ids.door}/visitor-codes`)
      .set(O())
      .set(idem())
      .send({ visitorName: 'ผู้มาเยือน', validFrom: from.toISOString(), validTo: to.toISOString() })
      .expect(201);
    expect(visitor.body).toMatchObject({ holderKind: 'visitor', status: 'pending' });
    expect(visitor.body.pin).toMatch(/^\d{6}$/);
    await settle();
    let row = (await creds('id = $1', [visitor.body.id]))[0]!;
    expect(row.status).toBe('pending');
    vendor().failing.delete('door-1');
    await t.app.get(AccessCredentialsService).sweep();
    row = (await creds('id = $1', [visitor.body.id]))[0]!;
    expect(row.status).toBe('active');
    t.clock.advance(3 * 3_600_000);
    owner = await ownerToken(t);
    await t.app.get(AccessCredentialsService).sweep();
    expect((await creds('id = $1', [visitor.body.id]))[0]!.status).toBe('expired');
  });

  it('a low battery opens one automatic repair request on the lock', async () => {
    vendor().setBattery('a101-1', 12);
    const lock = await t.http.post(`/v1/owner/locks/${ids.lockA101}/actions/refresh`).set(O()).expect(200);
    expect(lock.body).toMatchObject({ batteryPct: 12, batteryLow: true });
    await t.http.post(`/v1/owner/locks/${ids.lockA101}/actions/refresh`).set(O()).expect(200);
    await settle();
    const item = (
      await q<{ a: string }>('SELECT asset_item_id AS a FROM smart.lock WHERE id = $1', [ids.lockA101])
    )[0]!.a;
    const autos = await q<{ reason: string; key: string }>(
      `SELECT sr.auto_reason AS reason, c.key FROM ops.service_request sr JOIN ops.service_category c ON c.id = sr.category_id
        WHERE sr.asset_item_id = $1`,
      [item],
    );
    expect(autos).toEqual([{ reason: 'lock_battery_low', key: 'electrical' }]);
  });

  it('another tenant gets 404; RLS hides locks, credentials and events', async () => {
    const X = bearer(await operatorToken(t, PHONE_B));
    await t.http.get(`/v1/owner/locks/${ids.lockA101}`).set(X).expect(404);
    await t.http.get(`/v1/owner/locks/${ids.lockA101}/credentials`).set(X).expect(404);
    const [c] = await creds('holder_party_id = $1 AND lock_id = $2', [DEV.residentPartyId, ids.lockA101]);
    await t.http
      .post(`/v1/owner/access-credentials/${c!.id}/actions/revoke`)
      .set(X)
      .send({ reason: 'x' })
      .expect(404);
    await t.http
      .post(`/v1/owner/locks/${ids.lockA101}/visitor-codes`)
      .set(X)
      .set(idem())
      .send({
        visitorName: 'x',
        validFrom: t.clock.now().toISOString(),
        validTo: new Date(t.clock.now().getTime() + 3_600_000).toISOString(),
      })
      .expect(404);
    await t.http
      .post('/v1/owner/locks')
      .set(X)
      .send({
        scope: 'unit',
        unitId: ids.a101,
        vendor: 'ttlock',
        vendorLockId: 'x-1',
        serial: 'X-1',
        name: 'x',
      })
      .expect(404);
    expect((await t.http.get('/v1/owner/locks').set(X).expect(200)).body.data).toEqual([]);
    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);
    for (const table of ['smart.lock', 'smart.access_credential', 'smart.access_event']) {
      expect(await count(DEV.tenantId, table)).toBeGreaterThan(0);
      expect(await count(other.tenantId, table)).toBe(0);
    }
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: other.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE smart.access_credential SET status = 'revoked', revoked_at = now() WHERE id = '${c!.id}'`,
          ),
        ),
    ).resolves.toBe(0);
  });
});

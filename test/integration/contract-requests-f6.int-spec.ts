import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';

import { fakeLineIdToken } from '@integrations/line/fake-line-login';
import { type FakeObjectStorage } from '@integrations/s3/fake-object-storage';
import { OBJECT_STORAGE } from '@integrations/s3/object-storage.port';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const LINE_SUB = 'U00000000000000000000000000f6cr01';
const PHONE_B = '+660000000291';
const TECH_PHONE = '+660000000292';
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Consumer contract requests before release (LIFF #22–#28, web rows of 2026-10-21; D-218): the resident's request
 * with photo links, status history and SLA; message threads of the resident, the office and the technician; the
 * preferred visit and its confirmation; the technician's photo links and rating; resident visitor codes within the
 * operator's policy; the `facilities` / `access` entitlements; LINE deep links of the B5 messages; the dashboard's
 * overdue requests and waiting parcels; staff units; a building's asset items; the member filter — with cross-tenant
 * 404s for every new endpoint.
 */
describe('contract requests F6 (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let owner: string;
  let staff: string;
  let resident: string;
  let residentRefresh = '';
  let tech = '';
  let other: { tenantId: string; token: string };
  let unitId = '';
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const S = () => bearer(staff);
  const R = () => bearer(resident);
  const X = () => bearer(other.token);
  const TECH = () => bearer(tech);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const put = async (fileId: string, body: Buffer, mime = 'image/jpeg') => {
    const key = (
      await q<{ k: string }>('SELECT storage_key AS k FROM core.document WHERE id = $1', [fileId])
    )[0]!.k;
    t.app.get<FakeObjectStorage>(OBJECT_STORAGE).putDirect(key, body, mime);
  };
  const refreshResident = async () => {
    const r = await t.http.post('/v1/auth/refresh').send({ refreshToken: residentRefresh }).expect(200);
    resident = r.body.accessToken as string;
    residentRefresh = r.body.refreshToken as string;
  };
  const rendered = (type: string, aggregateId: string) =>
    q<{ audience: string; body: string }>(
      `SELECT tp.audience::text AS audience, n.rendered::text AS body FROM platform.notification n
         JOIN platform.domain_event e ON e.id = n.event_id
         JOIN platform.notification_template_version v ON v.id = n.template_version_id
         JOIN platform.notification_template tp ON tp.id = v.template_id
        WHERE e.type = $1 AND e.aggregate_id = $2 AND n.channel = 'line'`,
      [type, aggregateId],
    );
  const flag = (key: string, enabled: boolean) =>
    t.http
      .put(`/v1/admin/feature-flags/${key}`)
      .set(bearer(admin))
      .send({ tenantId: DEV.tenantId, enabled, reason: 'F6 integration test' })
      .expect(200);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_crf6' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    admin = await adminToken(t);
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
    other = await onboardTenant(t, admin, { slug: 'other-f6', phone: PHONE_B, type: 'apartment' });
    unitId = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(O())
        .send({ channel: 'link' })
        .expect(201)
    ).body.code as string;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า F6' }) })
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
    residentRefresh = login.body.refreshToken as string;
    await refreshResident();
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('#22 #24: the resident reports with a preferred time and sees photos, history and SLA', async () => {
    const upload = await t.http
      .post('/v1/resident/uploads')
      .set(R())
      .send({
        purpose: 'service_request',
        unitId,
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
        sha256: sha(JPEG),
      })
      .expect(201);
    await put(upload.body.fileId as string, JPEG);
    ids.reportPhoto = upload.body.fileId as string;
    const category = (
      await q<{ id: string }>(
        `SELECT id FROM ops.service_category WHERE tenant_id IS NULL AND key = 'plumbing'`,
      )
    )[0]!.id;
    // an unknown preference is refused (named enum)
    await t.http
      .post('/v1/resident/service-requests')
      .set(R())
      .send({ unitId, categoryId: category, description: 'x', preferredVisit: 'midnight' })
      .expect(422);
    const created = await t.http
      .post('/v1/resident/service-requests')
      .set(R())
      .set(idem())
      .send({
        unitId,
        categoryId: category,
        description: 'ก๊อกน้ำรั่ว',
        photoDocumentIds: [ids.reportPhoto],
        preferredVisit: 'afternoon',
      })
      .expect(201);
    ids.sr = created.body.id as string;
    expect(created.body).toMatchObject({
      status: 'new',
      preferredVisit: 'afternoon',
      visitConfirmedAt: null,
      nextActions: ['cancel'],
      events: [{ status: 'new' }],
      sla: { state: 'on_track' },
    });
    expect(created.body.sla.dueAt).toEqual(expect.any(String));
    // the photo has no link until the scan found it clean
    expect(created.body.photos).toEqual([{ id: ids.reportPhoto, role: 'report', url: null }]);
    await settle();
    const scanned = await t.http.get(`/v1/resident/service-requests/${ids.sr}`).set(R()).expect(200);
    expect(scanned.body.photos).toEqual([
      { id: ids.reportPhoto, role: 'report', url: expect.stringContaining('http') },
    ]);
    // the office sees the preference too; owners and staff may give one when they report
    const ownerView = await t.http.get(`/v1/owner/service-requests/${ids.sr}`).set(O()).expect(200);
    expect(ownerView.body).toMatchObject({ preferredVisit: 'afternoon', visitConfirmedAt: null });
    const byStaff = await t.http
      .post('/v1/staff/service-requests')
      .set(S())
      .send({ unitId, categoryId: category, description: 'ไฟทางเดินดับ', preferredVisit: 'morning' })
      .expect(201);
    expect(byStaff.body.preferredVisit).toBe('morning');
    ids.staffSr = byStaff.body.id as string;
    await t.http.post(`/v1/owner/service-requests/${ids.sr}/actions/triage`).set(O()).send({}).expect(200);
    const triaged = await t.http.get(`/v1/resident/service-requests/${ids.sr}`).set(R()).expect(200);
    expect((triaged.body.events as { status: string }[]).map((e) => e.status)).toEqual(['new', 'triaged']);
    // another resident's / tenant's request stays a 404
    await t.http.get(`/v1/resident/service-requests/${randomUUID()}`).set(R()).expect(404);
  });

  it('#24 #25: work order with a visit → the resident confirms; a moved visit asks again; the technician sees photos', async () => {
    const party = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({ type: 'person', displayName: 'ช่างประปา F6', phone: TECH_PHONE })
      .expect(201);
    ids.techParty = (party.body.id ?? party.body.party?.id) as string;
    const at = new Date(Math.floor(t.clock.now().getTime() / 1000) * 1000 + 2 * 86_400_000);
    const wo = await t.http
      .post(`/v1/owner/service-requests/${ids.sr}/work-orders`)
      .set(O())
      .send({
        kind: 'repair',
        title: 'เปลี่ยนก๊อก',
        assigneePartyId: ids.techParty,
        scheduledAt: at.toISOString(),
        scheduledUntil: new Date(at.getTime() + 3_600_000).toISOString(),
      })
      .expect(201);
    ids.wo = wo.body.id as string;
    await settle();
    // #28: the technician's LINE message opens the work order in the app
    const assigned = await rendered('work_order.assigned', ids.wo);
    expect(assigned.length).toBeGreaterThan(0);
    expect(assigned[0]!.body).toContain(`/technician/work-orders/${ids.wo}`);

    const before = await t.http.get(`/v1/resident/service-requests/${ids.sr}`).set(R()).expect(200);
    expect(before.body).toMatchObject({ status: 'assigned', nextActions: ['confirm-visit'] });
    expect(new Date(before.body.visitAt as string).getTime()).toBe(at.getTime());
    const confirmed = await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/actions/confirm-visit`)
      .set(R())
      .expect(200);
    expect(confirmed.body.visitConfirmedAt).toEqual(expect.any(String));
    expect(confirmed.body.nextActions).toEqual([]);
    await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/actions/confirm-visit`)
      .set(R())
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('service_request.invalid_state'));
    expect(
      (await t.http.get(`/v1/owner/service-requests/${ids.sr}`).set(O()).expect(200)).body.visitConfirmedAt,
    ).toEqual(expect.any(String));
    const audit = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'service_request.visit_confirmed' AND subject_id = $1`,
      [ids.sr],
    );
    expect(audit[0]!.n).toBe(1);
    await settle();
    expect((await rendered('service_request.visit_confirmed', ids.sr!)).length).toBeGreaterThan(0);
    // the office moves the visit: the resident is asked again
    const later = new Date(at.getTime() + 86_400_000);
    await t.http
      .post(`/v1/owner/work-orders/${ids.wo}/actions/assign`)
      .set(O())
      .send({
        assigneePartyId: ids.techParty,
        scheduledAt: later.toISOString(),
        scheduledUntil: new Date(later.getTime() + 3_600_000).toISOString(),
      })
      .expect(200);
    const moved = await t.http.get(`/v1/resident/service-requests/${ids.sr}`).set(R()).expect(200);
    expect(moved.body).toMatchObject({ visitConfirmedAt: null, nextActions: ['confirm-visit'] });
    // another resident cannot confirm it
    await t.http
      .post(`/v1/resident/service-requests/${randomUUID()}/actions/confirm-visit`)
      .set(R())
      .expect(404);

    // the technician signs in: report photo with a link, the preferred time, no rating yet
    const challenge = await t.http
      .post('/v1/auth/technician/otp/request')
      .send({ phone: TECH_PHONE })
      .expect(200);
    const signed = await t.http
      .post('/v1/auth/technician/otp/verify')
      .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo(TECH_PHONE) })
      .expect(200);
    tech = signed.body.accessToken as string;
    const view = await t.http.get(`/v1/technician/work-orders/${ids.wo}`).set(TECH()).expect(200);
    expect(view.body).toMatchObject({ preferredVisit: 'afternoon', rating: null, ratingComment: null });
    expect(view.body.photos).toEqual([
      { id: ids.reportPhoto, role: 'report', url: expect.stringContaining('http') },
    ]);
    await t.http.get(`/v1/technician/work-orders/${randomUUID()}`).set(TECH()).expect(404);
  });

  it('#23: one thread for the resident, the office and the technician — no phone numbers, cross-tenant 404', async () => {
    const mine = await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/messages`)
      .set(R())
      .set(idem())
      .send({ body: '  สะดวกช่วงบ่ายค่ะ  ' })
      .expect(201);
    expect(mine.body).toMatchObject({ author: 'resident', body: 'สะดวกช่วงบ่ายค่ะ', mine: true });
    const office = await t.http
      .post(`/v1/owner/service-requests/${ids.sr}/messages`)
      .set(O())
      .send({ body: 'ช่างจะเข้าไปตามนัดค่ะ' })
      .expect(201);
    expect(office.body).toMatchObject({ author: 'office', mine: true });
    const fromTech = await t.http
      .post(`/v1/technician/work-orders/${ids.wo}/messages`)
      .set(TECH())
      .send({ body: 'รับทราบครับ' })
      .expect(201);
    expect(fromTech.body).toMatchObject({ author: 'technician', authorName: 'ช่างประปา F6', mine: true });
    // the same thread everywhere, oldest first
    for (const [path, auth] of [
      [`/v1/resident/service-requests/${ids.sr}/messages`, R()],
      [`/v1/owner/service-requests/${ids.sr}/messages`, O()],
      [`/v1/staff/service-requests/${ids.sr}/messages`, S()],
      [`/v1/owner/work-orders/${ids.wo}/messages`, O()],
      [`/v1/technician/work-orders/${ids.wo}/messages`, TECH()],
    ] as const) {
      const list = await t.http.get(path).set(auth).expect(200);
      expect((list.body.data as { author: string }[]).map((m) => m.author)).toEqual([
        'resident',
        'office',
        'technician',
      ]);
      expect(JSON.stringify(list.body)).not.toContain(TECH_PHONE.slice(3));
    }
    const asResident = await t.http
      .get(`/v1/resident/service-requests/${ids.sr}/messages`)
      .set(R())
      .expect(200);
    expect((asResident.body.data as { mine: boolean }[]).map((m) => m.mine)).toEqual([true, false, false]);
    // validation: empty / too long
    await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/messages`)
      .set(R())
      .send({ body: 'x'.repeat(2001) })
      .expect(422);
    await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/messages`)
      .set(R())
      .send({ body: '   ' })
      .expect(422);
    // the resident hears from the office and the technician; the technician from the resident and the office
    await settle();
    const events = await q<{ id: string; author: string }>(
      `SELECT id, payload->>'authorKind' AS author FROM platform.domain_event
        WHERE type = 'service_request.message' AND aggregate_id = $1 ORDER BY occurred_at`,
      [ids.sr],
    );
    expect(events.map((e) => e.author)).toEqual(['resident', 'office', 'technician']);
    const audiences = async (eventId: string) =>
      (
        await q<{ a: string; body: string }>(
          `SELECT tp.audience::text AS a, n.rendered::text AS body FROM platform.notification n
             JOIN platform.notification_template_version v ON v.id = n.template_version_id
             JOIN platform.notification_template tp ON tp.id = v.template_id
            WHERE n.event_id = $1 AND n.channel = 'line'`,
          [eventId],
        )
      ).sort((x, y) => x.a.localeCompare(y.a));
    expect((await audiences(events[0]!.id)).map((n) => n.a)).toEqual(['technician']);
    const officeTold = await audiences(events[1]!.id);
    expect(officeTold.map((n) => n.a)).toEqual(['resident', 'technician']);
    expect(officeTold.find((n) => n.a === 'resident')!.body).toContain(`/requests/${ids.sr}`);
    expect(officeTold.find((n) => n.a === 'technician')!.body).toContain(`/technician/work-orders/${ids.wo}`);
    expect((await audiences(events[2]!.id)).map((n) => n.a)).toEqual(['resident']);
    const audited = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'service_request.message_posted' AND subject_id = $1`,
      [ids.sr],
    );
    expect(audited[0]!.n).toBe(3);

    // a work order without a request has its own office ↔ technician thread
    const inspection = await t.http
      .post('/v1/owner/work-orders')
      .set(O())
      .send({ kind: 'inspection', title: 'ตรวจปั๊ม', buildingId: DEV.buildingId })
      .expect(201);
    await t.http
      .post(`/v1/staff/work-orders/${inspection.body.id}/messages`)
      .set(S())
      .send({ body: 'กุญแจห้องเครื่องอยู่ที่สำนักงาน' })
      .expect(201);
    const own = await t.http.get(`/v1/owner/work-orders/${inspection.body.id}/messages`).set(O()).expect(200);
    expect(own.body.data).toHaveLength(1);
    expect(own.body.data[0]).toMatchObject({ author: 'office', mine: false });

    // another tenant: 404 everywhere; a technician outside their work order: 404
    await t.http.get(`/v1/owner/service-requests/${ids.sr}/messages`).set(X()).expect(404);
    await t.http
      .post(`/v1/owner/service-requests/${ids.sr}/messages`)
      .set(X())
      .send({ body: 'x' })
      .expect(404);
    await t.http.get(`/v1/owner/work-orders/${ids.wo}/messages`).set(X()).expect(404);
    await t.http
      .post(`/v1/owner/work-orders/${inspection.body.id}/messages`)
      .set(X())
      .send({ body: 'x' })
      .expect(404);
    await t.http.get(`/v1/technician/work-orders/${inspection.body.id}/messages`).set(TECH()).expect(404);
    await t.http.get(`/v1/resident/service-requests/${randomUUID()}/messages`).set(R()).expect(404);
    // RLS: the other tenant's session sees no message row
    const count = (tenantId: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM ops.service_message'),
        )
        .then((r) => r[0]!.n);
    expect(await count(DEV.tenantId)).toBe(4);
    expect(await count(other.tenantId)).toBe(0);
  });

  it('#22 #25: done with photos, the rating reaches the technician; a closed thread takes no message', async () => {
    await t.http.post(`/v1/technician/work-orders/${ids.wo}/actions/check-in`).set(TECH()).expect(200);
    for (const role of ['before', 'after'] as const) {
      const p = await t.http
        .post(`/v1/technician/work-orders/${ids.wo}/photos`)
        .set(TECH())
        .send({ role, contentType: 'image/jpeg', sizeBytes: JPEG.length, sha256: sha(JPEG) })
        .expect(201);
      await put(p.body.fileId as string, JPEG);
      ids[role] = p.body.fileId as string;
    }
    await t.http
      .post(`/v1/technician/work-orders/${ids.wo}/actions/complete`)
      .set(TECH())
      .send({ note: 'เรียบร้อย' })
      .expect(200);
    await settle();
    const done = await t.http.get(`/v1/resident/service-requests/${ids.sr}`).set(R()).expect(200);
    expect(done.body).toMatchObject({ status: 'done', sla: { state: 'none', dueAt: null } });
    expect((done.body.photos as { role: string }[]).map((p) => p.role)).toEqual([
      'report',
      'before',
      'after',
    ]);
    for (const p of done.body.photos as { url: string | null }[]) expect(p.url).toEqual(expect.any(String));
    await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/actions/rate`)
      .set(R())
      .send({ rating: 4, comment: 'ดีมาก' })
      .expect(200);
    const closed = await t.http.get(`/v1/resident/service-requests/${ids.sr}`).set(R()).expect(200);
    expect((closed.body.events as { status: string }[]).map((e) => e.status)).toEqual([
      'new',
      'triaged',
      'assigned',
      'in_progress',
      'done',
      'closed',
    ]);
    const techView = await t.http.get(`/v1/technician/work-orders/${ids.wo}`).set(TECH()).expect(200);
    expect(techView.body).toMatchObject({ rating: 4, ratingComment: 'ดีมาก' });
    expect((techView.body.photos as { id: string }[]).map((p) => p.id)).toEqual([
      ids.reportPhoto,
      ids.before,
      ids.after,
    ]);
    await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/messages`)
      .set(R())
      .send({ body: 'ขอบคุณค่ะ' })
      .expect(409);
    // #28: the resident's status messages open the request in the app
    await settle();
    const changed = await rendered('service_request.changed', ids.sr!);
    expect(changed.length).toBeGreaterThan(0);
    for (const n of changed) expect(n.body).toContain(`/requests/${ids.sr}`);
  });

  it('#26: visitor codes only within the operator’s policy (off by default)', async () => {
    const lock = await t.http
      .post('/v1/owner/locks')
      .set(O())
      .send({
        scope: 'unit',
        unitId,
        vendor: 'ttlock',
        vendorLockId: 'f6-a101',
        serial: 'TTL-F6-A101',
        name: 'ประตูห้อง A-101',
      })
      .expect(201);
    ids.lock = lock.body.id as string;
    await settle();
    const creds = await t.http.get('/v1/resident/access/credentials').set(R()).expect(200);
    expect(creds.body.visitorPolicy).toEqual({ allowed: false, maxHours: 0 });
    const from = new Date(t.clock.now().getTime() + 3_600_000);
    const window = (hours: number) => ({
      unitId,
      visitorName: 'คุณแม่',
      validFrom: from.toISOString(),
      validTo: new Date(from.getTime() + hours * 3_600_000).toISOString(),
    });
    await t.http
      .post('/v1/resident/access/visitor-codes')
      .set(R())
      .set(idem())
      .send(window(4))
      .expect(403)
      .expect((r) => expect(r.body.code).toBe('access.visitor_codes_disabled'));
    // the owner opts in (effective at once) with at most 12 hours
    for (const [key, value] of [
      ['access.resident_visitor_codes', true],
      ['access.resident_visitor_max_hours', 12],
    ] as const)
      await t.http
        .put(`/v1/owner/settings/${key}`)
        .set(O())
        .send({ value, reason: 'เปิดให้ผู้เช่าสร้างรหัสผู้มาเยือน' })
        .expect(200);
    await settle();
    const allowed = await t.http.get('/v1/resident/access/credentials').set(R()).expect(200);
    expect(allowed.body.visitorPolicy).toEqual({ allowed: true, maxHours: 12 });
    await t.http.post('/v1/resident/access/visitor-codes').set(R()).send(window(4)).expect(400);
    await t.http.post('/v1/resident/access/visitor-codes').set(R()).set(idem()).send(window(13)).expect(422);
    const issued = await t.http
      .post('/v1/resident/access/visitor-codes')
      .set(R())
      .set(idem())
      .send(window(4))
      .expect(201);
    expect(issued.body).toMatchObject({
      holderKind: 'visitor',
      holderName: 'คุณแม่',
      lockId: ids.lock,
      leaseId: null,
    });
    expect(issued.body.pin).toMatch(/^\d{6}$/);
    const row = await q<{ holder_kind: string; created_by: string | null; valid_to: Date }>(
      'SELECT holder_kind::text, created_by, valid_to FROM smart.access_credential WHERE id = $1',
      [issued.body.id],
    );
    expect(row[0]).toMatchObject({ holder_kind: 'visitor' });
    expect(row[0]!.created_by).toEqual(expect.any(String));
    // not my unit → 404
    const otherUnit = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-102'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    await t.http
      .post('/v1/resident/access/visitor-codes')
      .set(R())
      .set(idem())
      .send({ ...window(2), unitId: otherUnit })
      .expect(404);
  });

  it('#27: facilities and access entitlements follow the flags and what exists', async () => {
    const before = await t.http.get('/v1/resident/me').set(R()).expect(200);
    expect(before.body.entitlements).not.toContain('facilities');
    expect(before.body.entitlements).not.toContain('access');
    await flag('module.smart_access', true);
    await flag('module.community', true);
    await settle();
    const lockOnly = await t.http.get('/v1/resident/me').set(R()).expect(200);
    expect(lockOnly.body.entitlements).toContain('access');
    expect(lockOnly.body.entitlements).toContain('announcements');
    expect(lockOnly.body.entitlements).not.toContain('facilities');
    await t.http
      .post('/v1/owner/facilities')
      .set(O())
      .send({
        buildingId: DEV.buildingId,
        name: 'ฟิตเนส',
        kind: 'fitness',
        capacity: 5,
        bookingPolicy: { slotMinutes: 60, openFrom: '06:00', openTo: '22:00', maxPerUnitPerWeek: 3 },
      })
      .expect(201);
    const after = await t.http.get('/v1/resident/me').set(R()).expect(200);
    expect(after.body.entitlements).toEqual(expect.arrayContaining(['facilities', 'access']));
  });

  it('#28: announcement and parcel messages open their screen', async () => {
    const a = await t.http
      .post('/v1/owner/announcements')
      .set(O())
      .send({ buildingId: DEV.buildingId, title: 'ปิดน้ำ', bodyTh: 'ปิดน้ำวันเสาร์ 9–12 น.', publish: true })
      .expect(201);
    const photo = await uploadFile(t, db, staff, {
      kind: 'service_photo',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'parcel.jpg',
      mimeType: 'image/jpeg',
      body: JPEG,
      surface: 'staff',
    });
    const parcel = await t.http
      .post('/v1/staff/parcels')
      .set(S())
      .send({ unitId, carrier: 'Kerry Express', photoDocumentId: photo })
      .expect(201);
    ids.parcel = parcel.body.id as string;
    await settle();
    const announced = await rendered('announcement.published', a.body.id as string);
    expect(announced.length).toBeGreaterThan(0);
    expect(announced[0]!.body).toContain(`/announcements/${a.body.id}`);
    const parcels = await rendered('parcel.received', ids.parcel);
    expect(parcels.length).toBeGreaterThan(0);
    expect(parcels[0]!.body).toContain('/parcels');
  });

  it('web: dashboard counts overdue requests and waiting parcels; ?slaBreached filters the queue', async () => {
    const dash = async () =>
      (await t.http.get('/v1/owner/dashboard').set(O()).expect(200)).body.attention as Record<string, number>;
    const start = await dash();
    expect(start).toMatchObject({ serviceRequestsOverdue: 0 });
    expect(start.parcelsWaiting).toBeGreaterThanOrEqual(1);
    // the engine marks the staff-reported request as breached
    await db.admin.query(
      `UPDATE ops.workflow_instance SET sla_breached_at = now()
        WHERE id = (SELECT workflow_instance_id FROM ops.service_request WHERE id = $1)`,
      [ids.staffSr],
    );
    expect((await dash()).serviceRequestsOverdue).toBe(1);
    const overdue = await t.http
      .get('/v1/owner/service-requests?open=true&slaBreached=true')
      .set(O())
      .expect(200);
    expect((overdue.body.data as { id: string }[]).map((r) => r.id)).toEqual([ids.staffSr]);
    const resident = await t.http.get(`/v1/resident/service-requests/${ids.staffSr}`).set(R()).expect(200);
    expect(resident.body.sla.state).toBe('breached');
    const onTime = await t.http.get('/v1/staff/service-requests?slaBreached=false').set(S()).expect(200);
    expect((onTime.body.data as { id: string }[]).map((r) => r.id)).not.toContain(ids.staffSr);
    await t.http
      .post(`/v1/staff/parcels/${ids.parcel}/actions/return`)
      .set(S())
      .send({ reason: 'ไม่มีผู้รับ' })
      .expect(200);
    expect((await dash()).parcelsWaiting).toBe(start.parcelsWaiting! - 1);
    // another tenant counts nothing of ours
    const theirs = await t.http.get('/v1/owner/dashboard').set(X()).expect(200);
    expect(theirs.body.attention).toMatchObject({ serviceRequestsOverdue: 0, parcelsWaiting: 0 });
  });

  it('web: staff units of a building, a building’s asset items, the member filter — 404 across tenants', async () => {
    const units = await t.http.get(`/v1/staff/buildings/${DEV.buildingId}/units`).set(S()).expect(200);
    expect(units.body.data).toHaveLength(12);
    expect(units.body.data[0]).toMatchObject({
      unitNo: expect.any(String),
      floorName: expect.any(String),
      floorLevel: expect.any(Number),
      status: expect.any(String),
    });
    const levels = (units.body.data as { floorLevel: number }[]).map((u) => u.floorLevel);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    await t.http.get(`/v1/staff/buildings/${DEV.buildingId}/units`).set(X()).expect(404);
    await t.http.get(`/v1/staff/buildings/${randomUUID()}/units`).set(S()).expect(404);

    const all = await t.http.get(`/v1/owner/buildings/${DEV.buildingId}/asset-items`).set(O()).expect(200);
    const categories = new Set((all.body.data as { category: string }[]).map((i) => i.category));
    expect(categories).toEqual(expect.objectContaining({}));
    expect(categories.has('meter_electric')).toBe(true);
    expect(categories.has('lock')).toBe(true);
    const meters = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/asset-items?category=meter_water`)
      .set(O())
      .expect(200);
    expect(meters.body.data).toHaveLength(12);
    for (const i of meters.body.data as { category: string; unitId: string | null }[])
      expect(i.category).toBe('meter_water');
    await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/asset-items?category=spaceship`)
      .set(O())
      .expect(422);
    await t.http.get(`/v1/owner/buildings/${DEV.buildingId}/asset-items`).set(X()).expect(404);

    const members = async (query: string) =>
      (await t.http.get(`/v1/owner/members${query}`).set(O()).expect(200)).body as {
        role: string;
        status: string;
      }[];
    const everyone = await members('');
    const handlers = await members(`?permission=service_request.handle&buildingId=${DEV.buildingId}`);
    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers.every((m) => m.status === 'active')).toBe(true);
    expect(handlers.map((m) => m.role)).toContain('staff');
    const reporters = await members('?permission=report.read');
    expect(reporters.map((m) => m.role)).not.toContain('staff');
    expect(reporters.length).toBeLessThan(everyone.length);
    await t.http.get('/v1/owner/members?permission=no.such_permission').set(O()).expect(422);
    await t.http.get(`/v1/owner/members?buildingId=${randomUUID()}`).set(O()).expect(404);
    await t.http.get(`/v1/owner/members?buildingId=${DEV.buildingId}`).set(X()).expect(404);
  });
});

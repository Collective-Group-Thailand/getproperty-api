import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';

import { DomainEvents } from '@core/events/domain-events';
import { TenantTx } from '@database/tenant-tx';
import { fakeLineIdToken } from '@integrations/line/fake-line-login';
import { type FakeObjectStorage } from '@integrations/s3/fake-object-storage';
import { OBJECT_STORAGE } from '@integrations/s3/object-storage.port';
import { IntegrationEventsService } from '@modules/bridge-integrations/integration-events.service';
import { MaintenancePlansService } from '@modules/ops-service/maintenance-plans.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import {
  adminToken,
  bearer,
  idem,
  onboardTenant,
  operatorToken,
  otpSignIn,
  ownerToken,
} from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const LINE_SUB = 'U00000000000000000000000000b5sr01';
const PHONE_B = '+660000000181';
const TECH_PHONE = '+660000000182';
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * B5.1 acceptance (docs/prompts/B5-operations.md 5.1, D-072, D-034, D-153, D-159): resident → owner triage → work
 * order → technician done with photo (the technician token sees only that work order) → resident rates; SLA breach
 * event once; auto-request from a stale meter with 24 h dedup; a warranty request writes one integration event and
 * `warranty.defect.closed` closes it; preventive maintenance; cross-tenant 404s and RLS on every new table.
 */
describe('B5.1 service requests & work orders (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let staff: string;
  let resident: string;
  let residentRefresh = '';
  let other: { tenantId: string; token: string };
  let unitId = '';
  let electricMeter = '';
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const R = () => bearer(resident);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const put = async (fileId: string, body: Buffer, mime = 'image/jpeg') => {
    const key = (
      await q<{ k: string }>('SELECT storage_key AS k FROM core.document WHERE id = $1', [fileId])
    )[0]!.k;
    t.app.get<FakeObjectStorage>(OBJECT_STORAGE).putDirect(key, body, mime);
  };
  /** Fresh tokens after the fake clock jumped past their 15-minute life. */
  const relogin = async () => {
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
    if (other) other = { ...other, token: await operatorToken(t, PHONE_B) };
    const r = await t.http.post('/v1/auth/refresh').send({ refreshToken: residentRefresh }).expect(200);
    resident = r.body.accessToken as string;
    residentRefresh = r.body.refreshToken as string;
  };
  const categoryId = async (key: string) =>
    (
      await q<{ id: string }>('SELECT id FROM ops.service_category WHERE tenant_id IS NULL AND key = $1', [
        key,
      ])
    )[0]!.id;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_b51' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b51',
      phone: PHONE_B,
      type: 'apartment',
    });
    unitId = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    electricMeter = (
      await q<{ id: string }>(
        `SELECT asset_item_id AS id FROM core.meter_assignment WHERE unit_id = $1 AND utility = 'electric' AND valid_to IS NULL`,
        [unitId],
      )
    )[0]!.id;
    // the resident of A-101 signs in through LINE and accepts the lease invitation
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(O())
        .send({ channel: 'link' })
        .expect(201)
    ).body.code as string;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า B5' }) })
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
    await relogin();
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('categories: platform defaults; the tenant overrides the SLA of a key', async () => {
    const list = await t.http.get('/v1/owner/service-categories').set(O()).expect(200);
    expect((list.body.data as { key: string }[]).map((c) => c.key)).toEqual([
      'electrical',
      'plumbing',
      'aircon',
      'appliance',
      'structure',
      'pest',
      'cleaning',
      'other',
    ]);
    const put = await t.http
      .put('/v1/owner/service-categories/plumbing')
      .set(O())
      .send({ slaHours: 12 })
      .expect(200);
    expect(put.body).toMatchObject({ key: 'plumbing', slaHours: 12, source: 'tenant', nameTh: 'ประปา' });
    const forResident = await t.http
      .get(`/v1/resident/service-categories?unitId=${unitId}`)
      .set(R())
      .expect(200);
    expect((forResident.body.data as { key: string }[]).find((c) => c.key === 'plumbing')).toMatchObject({
      id: put.body.id,
      slaHours: 12,
    });
    ids.plumbing = put.body.id as string;
    // another tenant still sees the platform default
    const theirs = await t.http.get('/v1/owner/service-categories').set(bearer(other.token)).expect(200);
    expect(
      (theirs.body.data as { key: string; slaHours: number }[]).find((c) => c.key === 'plumbing')!.slaHours,
    ).toBe(24);
    // another unit is not mine
    await t.http.get(`/v1/resident/service-categories?unitId=${randomUUID()}`).set(R()).expect(404);
  });

  it('resident → owner triage → work order → technician done with photos → resident rates', async () => {
    // the resident photographs the leak and reports it
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
    const created = await t.http
      .post('/v1/resident/service-requests')
      .set(R())
      .set(idem())
      .send({
        unitId,
        categoryId: ids.plumbing,
        description: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
        photoDocumentIds: [upload.body.fileId],
      })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'new', unitNo: 'A-101', nextActions: ['cancel'] });
    expect(created.body.photoIds).toEqual([upload.body.fileId]);
    ids.sr = created.body.id as string;
    // the SLA clock runs from the report with the tenant's 12 h
    const sr = await t.http.get(`/v1/owner/service-requests/${ids.sr}`).set(O()).expect(200);
    expect(sr.body).toMatchObject({
      status: 'new',
      slaHours: 12,
      reporterKind: 'resident',
      slaBreached: false,
    });
    expect(
      new Date(sr.body.slaDueAt as string).getTime() - new Date(sr.body.createdAt as string).getTime(),
    ).toBe(12 * 3_600_000);
    expect(sr.body.nextActions).toEqual(['triage', 'create-work-order', 'cancel']);
    // operators hear of it; the resident sees it in the list
    await settle();
    const told = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'service_request.created' AND e.aggregate_id = $1`,
      [ids.sr],
    );
    expect(told[0]!.n).toBeGreaterThan(0);
    const mine = await t.http.get('/v1/resident/service-requests').set(R()).expect(200);
    expect((mine.body.data as { id: string }[]).map((x) => x.id)).toContain(ids.sr);

    // owner triage
    await t.http
      .post(`/v1/owner/service-requests/${ids.sr}/actions/triage`)
      .set(O())
      .send({ priority: 'high' })
      .expect(200);
    // an external technician with a phone (SMS sign-in)
    const party = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({ type: 'person', displayName: 'ช่างประปา ทดสอบ', phone: TECH_PHONE })
      .expect(201);
    ids.techParty = (party.body.id ?? party.body.party?.id) as string;
    const wo = await t.http
      .post(`/v1/owner/service-requests/${ids.sr}/work-orders`)
      .set(O())
      .set(idem())
      .send({
        kind: 'repair',
        title: 'เปลี่ยนก๊อกน้ำ',
        assigneePartyId: ids.techParty,
        scheduledAt: new Date(t.clock.now().getTime() + 3_600_000).toISOString(),
        scheduledUntil: new Date(t.clock.now().getTime() + 4 * 3_600_000).toISOString(),
      })
      .expect(201);
    expect(wo.body).toMatchObject({ status: 'assigned', assignee: { type: 'party', id: ids.techParty } });
    ids.wo = wo.body.id as string;
    expect((await t.http.get(`/v1/owner/service-requests/${ids.sr}`).set(O()).expect(200)).body.status).toBe(
      'assigned',
    );
    // a second work order (preventive, another job) the technician must not see
    const another = await t.http
      .post('/v1/owner/work-orders')
      .set(O())
      .send({ kind: 'inspection', title: 'ตรวจห้อง', unitId })
      .expect(201);
    ids.otherWo = another.body.id as string;

    // the technician signs in by SMS: the token covers exactly the assigned work order
    // (D-226: the phone the owner typed only requests the link — the owner confirms it)
    const signed = { body: await otpSignIn(t, 'technician', TECH_PHONE, owner) };
    expect(signed.body.subject.scopes).toEqual([`work_order:${ids.wo}`]);
    const TECH = bearer(signed.body.accessToken);
    ids.techToken = signed.body.accessToken;
    const list = await t.http.get('/v1/technician/work-orders').set(TECH).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: ids.wo,
      requestDescription: 'ก๊อกน้ำอ่างล้างหน้ารั่ว',
      categoryKey: 'plumbing',
      requestPhotoIds: [upload.body.fileId],
      nextActions: ['accept', 'check-in', 'complete'],
    });
    await t.http.get(`/v1/technician/work-orders/${ids.otherWo}`).set(TECH).expect(404);
    await t.http.post(`/v1/technician/work-orders/${ids.otherWo}/actions/check-in`).set(TECH).expect(404);
    // an operator token is not a technician token
    await t.http.get('/v1/technician/work-orders').set(O()).expect(403);

    await t.http.post(`/v1/technician/work-orders/${ids.wo}/actions/accept`).set(TECH).expect(200);
    const inProgress = await t.http
      .post(`/v1/technician/work-orders/${ids.wo}/actions/check-in`)
      .set(TECH)
      .expect(200);
    expect(inProgress.body.status).toBe('in_progress');
    expect(
      (await t.http.get(`/v1/resident/service-requests/${ids.sr}`).set(R()).expect(200)).body.status,
    ).toBe('in_progress');
    // parts
    await t.http
      .post(`/v1/technician/work-orders/${ids.wo}/actions/wait-parts`)
      .set(TECH)
      .send({})
      .expect(200);
    expect((await t.http.get(`/v1/owner/service-requests/${ids.sr}`).set(O()).expect(200)).body.status).toBe(
      'waiting_parts',
    );
    await t.http.post(`/v1/technician/work-orders/${ids.wo}/actions/resume`).set(TECH).expect(200);
    const costed = await t.http
      .post(`/v1/technician/work-orders/${ids.wo}/cost-lines`)
      .set(TECH)
      .send({ kind: 'part', description: 'ก๊อกน้ำ', quantity: '2', unitPrice: '175.25' })
      .expect(201);
    expect(costed.body.costTotal).toBe('350.50');
    // no after photo yet
    const refused = await t.http
      .post(`/v1/technician/work-orders/${ids.wo}/actions/complete`)
      .set(TECH)
      .send({})
      .expect(422);
    expect(refused.body.code).toBe('work_order.photo_required');
    for (const role of ['before', 'after'] as const) {
      const p = await t.http
        .post(`/v1/technician/work-orders/${ids.wo}/photos`)
        .set(TECH)
        .send({ role, contentType: 'image/jpeg', sizeBytes: JPEG.length, sha256: sha(JPEG) })
        .expect(201);
      await put(p.body.fileId as string, JPEG);
    }
    const done = await t.http
      .post(`/v1/technician/work-orders/${ids.wo}/actions/complete`)
      .set(TECH)
      .send({ note: 'เปลี่ยนก๊อกใหม่แล้ว' })
      .expect(200);
    expect(done.body).toMatchObject({ status: 'done', completionNote: 'เปลี่ยนก๊อกใหม่แล้ว' });
    expect(done.body.afterPhotoIds).toHaveLength(1);
    expect(done.body.beforePhotoIds).toHaveLength(1);

    // the resident is told and rates; the rating closes the request
    const back = await t.http.get(`/v1/resident/service-requests/${ids.sr}`).set(R()).expect(200);
    expect(back.body).toMatchObject({ status: 'done', nextActions: ['rate'] });
    const rated = await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/actions/rate`)
      .set(R())
      .send({ rating: 5, comment: 'ช่างมาตรงเวลา' })
      .expect(200);
    expect(rated.body).toMatchObject({ status: 'closed', rating: 5, nextActions: [] });
    await t.http
      .post(`/v1/resident/service-requests/${ids.sr}/actions/rate`)
      .set(R())
      .send({ rating: 4 })
      .expect(409);
    await settle();
    const residentMessages = await q<{ to: string }>(
      `SELECT e.payload->>'to' AS to FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'service_request.changed' AND e.aggregate_id = $1 AND n.recipient_type = 'party' ORDER BY e.occurred_at`,
      [ids.sr],
    );
    expect(residentMessages.map((m) => m.to)).toEqual(
      expect.arrayContaining(['triaged', 'assigned', 'in_progress', 'waiting_parts', 'done', 'closed']),
    );

    // the owner verifies; the technician's scope ends at once
    const verified = await t.http.post(`/v1/owner/work-orders/${ids.wo}/actions/verify`).set(O()).expect(200);
    expect(verified.body.status).toBe('verified');
    await t.http.get(`/v1/technician/work-orders/${ids.wo}`).set(TECH).expect(404);
    const audit = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action IN ('work_order.cost_changed', 'work_order.verified') AND subject_id = $1`,
      [ids.wo],
    );
    expect(audit[0]!.n).toBe(2);
    // the costs reach the income & expense numbers of the completion month
    const month = await q<{ s: string }>(
      `SELECT sum(cost_total)::text AS s FROM ops.work_order WHERE tenant_id = $1 AND status IN ('done', 'verified')`,
      [DEV.tenantId],
    );
    expect(month[0]!.s).toBe('350.50');
  });

  it('staff: my work orders, check in, attach photos, complete', async () => {
    const S = bearer(staff);
    const sr = await t.http
      .post('/v1/staff/service-requests')
      .set(S)
      .send({
        buildingId: DEV.buildingId,
        categoryId: await categoryId('electrical'),
        description: 'ไฟทางเดินชั้น 1 ดับ',
      })
      .expect(201);
    expect(sr.body).toMatchObject({ reporterKind: 'staff', unitId: null, status: 'new' });
    const wo = await t.http
      .post(`/v1/owner/service-requests/${sr.body.id}/work-orders`)
      .set(O())
      .send({ kind: 'repair', title: 'เปลี่ยนหลอดไฟ', assigneeUserId: DEV.users.staff })
      .expect(201);
    const mine = await t.http.get('/v1/staff/work-orders?mine=true&active=true').set(S).expect(200);
    expect((mine.body.data as { id: string }[]).map((w) => w.id)).toEqual([wo.body.id]);
    await t.http.post(`/v1/staff/work-orders/${wo.body.id}/actions/check-in`).set(S).expect(200);
    const photo = await uploadFile(t, db, staff, {
      kind: 'service_photo',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'after.jpg',
      mimeType: 'image/jpeg',
      body: JPEG,
      surface: 'staff',
    });
    await t.http
      .post(`/v1/staff/work-orders/${wo.body.id}/photos`)
      .set(S)
      .send({ documentId: photo, role: 'after' })
      .expect(200);
    const done = await t.http
      .post(`/v1/staff/work-orders/${wo.body.id}/actions/complete`)
      .set(S)
      .send({})
      .expect(200);
    expect(done.body.status).toBe('done');
    expect(
      (await t.http.get(`/v1/staff/service-requests/${sr.body.id}`).set(S).expect(200)).body.status,
    ).toBe('done');
    // staff do not verify (owner surface only)
    await t.http.post(`/v1/staff/work-orders/${wo.body.id}/actions/verify`).set(S).expect(404);
    // a done work order cannot be re-assigned
    const bad = await t.http
      .post(`/v1/owner/work-orders/${wo.body.id}/actions/assign`)
      .set(O())
      .send({ assigneeUserId: randomUUID() })
      .expect(409);
    expect(bad.body.code).toBe('work_order.invalid_state');
  });

  it('SLA breach is emitted once and reaches the owner (D-159)', async () => {
    const sr = await t.http
      .post('/v1/owner/service-requests')
      .set(O())
      .send({ unitId, categoryId: await categoryId('pest'), description: 'มดขึ้นห้องครัว' })
      .expect(201);
    const instance = (
      await q<{ id: string }>('SELECT workflow_instance_id AS id FROM ops.service_request WHERE id = $1', [
        sr.body.id,
      ])
    )[0]!.id;
    t.clock.advance(73 * 3_600_000);
    await settle(6);
    await settle(6);
    await relogin();
    const breaches = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'workflow.sla_breached' AND aggregate_id = $1`,
      [instance],
    );
    expect(breaches[0]!.n).toBe(1);
    const warned = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'workflow.sla_warning' AND aggregate_id = $1`,
      [instance],
    );
    expect(warned[0]!.n).toBe(1);
    const toOwner = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'workflow.sla_breached' AND e.aggregate_id = $1 AND n.recipient_id = $2`,
      [instance, DEV.users.owner],
    );
    expect(toOwner[0]!.n).toBeGreaterThan(0);
    const dto = await t.http.get(`/v1/owner/service-requests/${sr.body.id}`).set(O()).expect(200);
    expect(dto.body.slaBreached).toBe(true);
    const timeline = await t.http
      .get(`/v1/owner/service-requests/${sr.body.id}/timeline`)
      .set(O())
      .expect(200);
    expect((timeline.body.data as { event: string }[]).map((e) => e.event)).toEqual([
      'start',
      'sla_warning',
      'sla_breached',
    ]);
  });

  it('a stale meter opens one automatic request per 24 h (D-034)', async () => {
    const stale = () =>
      t.app.get(TenantTx).platform((tx) =>
        t.app.get(DomainEvents).record(tx, {
          type: 'meter.stale',
          aggregateType: 'asset_item',
          aggregateId: electricMeter,
          tenantId: DEV.tenantId,
          buildingId: DEV.buildingId,
          payload: {
            assetItemId: electricMeter,
            unitId,
            code: 'A-101-E',
            utility: 'electric',
            from: 'ok',
            to: 'stale',
          },
        }),
      );
    const autos = () =>
      q<{ id: string; category: string; status: string; reporter_kind: string; auto_reason: string }>(
        `SELECT sr.id, c.key AS category, sr.status, sr.reporter_kind, sr.auto_reason FROM ops.service_request sr
           JOIN ops.service_category c ON c.id = sr.category_id WHERE sr.asset_item_id = $1 ORDER BY sr.created_at`,
        [electricMeter],
      );
    await stale();
    await settle();
    await stale();
    await settle();
    expect(await autos()).toEqual([
      {
        id: expect.any(String),
        category: 'electrical',
        status: 'new',
        reporter_kind: 'system',
        auto_reason: 'meter_stale',
      },
    ]);
    t.clock.advance(25 * 3_600_000);
    await relogin();
    await stale();
    await settle();
    expect(await autos()).toHaveLength(2);
  });

  it('warranty: the request is referred with one integration event; warranty.defect.closed closes it (D-153)', async () => {
    const until = new Date(t.clock.now().getTime() + 365 * 86_400_000).toISOString().slice(0, 10);
    const item = (
      await q<{ id: string }>(
        `INSERT INTO core.asset_item (tenant_id, building_id, unit_id, category, name, warranty_until, source_ref)
         VALUES ($1, $2, $3, 'appliance', 'เครื่องทำน้ำอุ่น', $4, 'gb-asset-001') RETURNING id`,
        [DEV.tenantId, DEV.buildingId, unitId, until],
      )
    )[0]!.id;
    const sr = await t.http
      .post('/v1/owner/service-requests')
      .set(O())
      .send({
        assetItemId: item,
        categoryId: await categoryId('appliance'),
        description: 'เครื่องทำน้ำอุ่นไม่ร้อน',
      })
      .expect(201);
    expect(sr.body).toMatchObject({ inWarranty: true, status: 'triaged', nextActions: ['cancel'] });
    await settle();
    await settle();
    const events = await q<{
      id: string;
      status: string;
      direction: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, status::text, direction::text, payload FROM bridge.integration_event
        WHERE event_type = 'warranty.defect.reported' AND subject_id = $1`,
      [sr.body.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'pending', direction: 'outbound' });
    expect(events[0]!.payload).toMatchObject({
      type: 'warranty.defect.reported',
      idempotencyKey: `getproperty:service_request:${sr.body.id}:reported`,
      payload: { serviceRequestId: sr.body.id, assetItemRef: 'gb-asset-001', category: 'appliance' },
    });
    expect(JSON.stringify(events[0]!.payload)).not.toContain('ผู้เช่า');
    // the building's technician is not assigned to a warranty request
    const refused = await t.http
      .post(`/v1/owner/service-requests/${sr.body.id}/work-orders`)
      .set(O())
      .send({ kind: 'repair', title: 'ซ่อม' })
      .expect(409);
    expect(refused.body.code).toBe('service_request.in_warranty');
    // getbuild closes the defect
    const closed = {
      eventId: randomUUID(),
      type: 'warranty.defect.closed',
      version: 1,
      occurredAt: t.clock.now().toISOString(),
      idempotencyKey: `getbuild:defect:D-1:closed`,
      sourcePlatform: 'getbuild',
      tenantId: null,
      payload: {
        defectRef: 'D-1',
        serviceRequestId: sr.body.id,
        resolution: 'replaced',
        closedAt: t.clock.now().toISOString(),
        afterPhotos: [],
      },
    };
    const bridge = t.app.get(IntegrationEventsService);
    expect(await bridge.receive('getbuild', closed)).toMatchObject({ status: 'applied' });
    expect(await bridge.receive('getbuild', closed)).toMatchObject({ status: 'duplicate' });
    const after = await t.http.get(`/v1/owner/service-requests/${sr.body.id}`).set(O()).expect(200);
    expect(after.body).toMatchObject({ status: 'closed', warrantyResolution: 'replaced' });
    // a malformed event is stored as rejected with the reason
    const bad = await bridge.receive('getbuild', {
      ...closed,
      idempotencyKey: 'getbuild:bad:1',
      payload: {},
    });
    expect(bad.status).toBe('rejected');
  });

  it('preventive maintenance opens one work order per due date', async () => {
    const pump = (
      await q<{ id: string }>(
        `INSERT INTO core.asset_item (tenant_id, building_id, category, name) VALUES ($1, $2, 'pump', 'ปั๊มน้ำหลัก') RETURNING id`,
        [DEV.tenantId, DEV.buildingId],
      )
    )[0]!.id;
    const due = new Date(t.clock.now().getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const plan = await t.http
      .post('/v1/owner/maintenance-plans')
      .set(O())
      .send({ assetItemId: pump, title: 'ล้างและตรวจปั๊มน้ำ', intervalDays: 30, leadDays: 3, nextDueOn: due })
      .expect(201);
    const sweep = t.app.get(MaintenancePlansService);
    expect(await sweep.sweep()).toEqual({ opened: 1 });
    expect(await sweep.sweep()).toEqual({ opened: 0 });
    const after = await t.http.get(`/v1/owner/maintenance-plans/${plan.body.id}`).set(O()).expect(200);
    expect(after.body.lastWorkOrderId).toEqual(expect.any(String));
    const wo = await t.http.get(`/v1/owner/work-orders/${after.body.lastWorkOrderId}`).set(O()).expect(200);
    expect(wo.body).toMatchObject({ kind: 'preventive', assetItemId: pump, maintenancePlanId: plan.body.id });
    ids.plan = plan.body.id as string;
  });

  it('a new occupant never sees the previous occupants’ requests of the unit (review #9, D-224)', async () => {
    await relogin();
    // the current resident reported a leak ten days ago
    const old = await t.http
      .post('/v1/resident/service-requests')
      .set(R())
      .set(idem())
      .send({ unitId, categoryId: ids.plumbing, description: 'ท่อน้ำใต้ซิงก์รั่ว (ผู้เช่าเดิม)' })
      .expect(201);
    await q(`UPDATE ops.service_request SET created_at = created_at - interval '10 days' WHERE id = $1`, [
      old.body.id,
    ]);
    // a family member moves in today and signs in with their own LINE
    const party = (
      await q<{ id: string }>(
        `INSERT INTO core.party (tenant_id, type, display_name) VALUES ($1, 'person', 'ผู้อยู่ใหม่ A-101') RETURNING id`,
        [DEV.tenantId],
      )
    )[0]!.id;
    const today = new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from) VALUES ($1, $2, $3, $4, 'family', $5::date)`,
      [DEV.tenantId, DEV.buildingId, unitId, party, today],
    );
    const first = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b5sr09', name: 'ผู้อยู่ใหม่' }) })
      .expect(200);
    await q(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via) SELECT $1, $2, user_id, 'invitation' FROM core.user_identity WHERE provider_subject = $3`,
      [DEV.tenantId, party, 'U00000000000000000000000000b5sr09'],
    );
    const N = bearer(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200)).body
        .accessToken as string,
    );
    const listed = (await t.http.get('/v1/resident/service-requests').set(N).expect(200)).body.data as {
      id: string;
    }[];
    expect(listed.map((r) => r.id)).not.toContain(old.body.id);
    expect(listed.map((r) => r.id)).not.toContain(ids.sr);
    await t.http.get(`/v1/resident/service-requests/${old.body.id}`).set(N).expect(404);
    await t.http
      .post(`/v1/resident/service-requests/${old.body.id}/actions/cancel`)
      .set(N)
      .set(idem())
      .send({ reason: 'ไม่ใช่ของฉัน' })
      .expect(404);
    // what the unit reports from now on is theirs to follow; the reporter keeps their own request
    const mine = await t.http
      .post('/v1/resident/service-requests')
      .set(N)
      .set(idem())
      .send({ unitId, categoryId: ids.plumbing, description: 'ไฟห้องน้ำดับ' })
      .expect(201);
    const after = (await t.http.get('/v1/resident/service-requests').set(N).expect(200)).body.data as {
      id: string;
    }[];
    expect(after.map((r) => r.id)).toContain(mine.body.id);
    await t.http.get(`/v1/resident/service-requests/${old.body.id}`).set(R()).expect(200);
  });

  it('another tenant gets 404 on every request, work order and plan of this tenant', async () => {
    const X = bearer(other.token);
    await t.http.get(`/v1/owner/service-requests/${ids.sr}`).set(X).expect(404);
    await t.http.post(`/v1/owner/service-requests/${ids.sr}/actions/triage`).set(X).send({}).expect(404);
    await t.http
      .post(`/v1/owner/service-requests/${ids.sr}/work-orders`)
      .set(X)
      .send({ kind: 'repair', title: 'x' })
      .expect(404);
    await t.http.get(`/v1/owner/work-orders/${ids.wo}`).set(X).expect(404);
    await t.http
      .post(`/v1/owner/work-orders/${ids.otherWo}/actions/cancel`)
      .set(X)
      .send({ reason: 'x' })
      .expect(404);
    await t.http
      .post(`/v1/owner/work-orders/${ids.otherWo}/cost-lines`)
      .set(X)
      .send({ description: 'x', unitPrice: '1.00' })
      .expect(404);
    await t.http.get(`/v1/owner/maintenance-plans/${ids.plan}`).set(X).expect(404);
    await t.http
      .post('/v1/owner/service-requests')
      .set(X)
      .send({ unitId, categoryId: await categoryId('other'), description: 'x' })
      .expect(404);
    expect((await t.http.get('/v1/owner/service-requests').set(X).expect(200)).body.data).toEqual([]);
    // a resident sees only requests of their units
    const strangers = await t.http
      .post('/v1/owner/service-requests')
      .set(O())
      .send({
        buildingId: DEV.buildingId,
        categoryId: await categoryId('cleaning'),
        description: 'โถงชั้น 1 สกปรก',
      })
      .expect(201);
    await t.http.get(`/v1/resident/service-requests/${strangers.body.id}`).set(R()).expect(404);
    await t.http
      .post('/v1/resident/service-requests')
      .set(R())
      .send({ unitId: randomUUID(), categoryId: await categoryId('other'), description: 'x' })
      .expect(404);
  });

  it('RLS: rows of the new tables are invisible to another tenant and cannot be written for it', async () => {
    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);
    for (const table of [
      'ops.service_request',
      'ops.work_order',
      'ops.work_order_cost_line',
      'ops.maintenance_plan',
    ]) {
      expect(await count(DEV.tenantId, table)).toBeGreaterThan(0);
      expect(await count(other.tenantId, table)).toBe(0);
    }
    // categories: platform defaults are shared, overrides are not
    expect(await count(DEV.tenantId, 'ops.service_category')).toBe(9);
    expect(await count(other.tenantId, 'ops.service_category')).toBe(8);
    await expect(
      db.prisma().withTenant({ tenantId: other.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO ops.service_request (tenant_id, building_id, reporter_kind, category_id, description, sla_hours)
           VALUES ('${DEV.tenantId}', '${DEV.buildingId}', 'owner', '${ids.plumbing}', 'x', 1)`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      db.prisma().withTenant({ tenantId: other.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO ops.work_order_cost_line (tenant_id, work_order_id, description, unit_price, amount)
           VALUES ('${other.tenantId}', '${ids.otherWo}', 'x', 1, 1)`,
        ),
      ),
    ).rejects.toThrow();
  });
});

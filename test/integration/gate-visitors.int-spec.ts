import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import { SettingsService } from '@core/settings/settings.service';
import { GateRetentionService } from '@modules/smart-gate/gate-retention.service';
import { VisitsService } from '@modules/smart-gate/visits.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, otpSignIn } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const PHONE_J = '+660000000341';
const PHONE_J2 = '+660000000342';
const PHONE_P = '+66810003411';
const PHONE_Q = '+66810003412';
const PHONE_F = '+66810003413';
const PHONE_B = '+66810003414';
const PHONE_R = '+66810003415';
const PLATE = { category: '1กข', number: '1234', province: 'กรุงเทพมหานคร' };
const at = (d: string) => new Date(`${d}T09:00:00+07:00`);
const PIN = '482913';

interface Tablet {
  deviceId: string;
  deviceSecret: string;
}

/**
 * J4.1 acceptance (D-315, D-320, D-327) on a juristic estate: tablet enrolment and guard PIN sign-in (lockout), the
 * full visit loop (every resident of the unit asked in LINE — not the payer-only party —, concurrent answers: exactly
 * one wins, entry and exit), each timeout policy, the delivery drop point, invites single / multi / contractor
 * approval, the remembered car, the blacklist, offline replays without duplicates, retention that deletes rows and
 * photo objects, the reason-logged visit log, no arrears data at the gate, and isolation (another unit, another
 * estate's guard, another tenant: 404).
 */
describe('J4.1 gate & visitor (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let jur: { tenantId: string; token: string };
  let jur2: { tenantId: string; token: string };
  const ids: Record<string, string> = {};
  const users: Record<string, string> = {};
  const residents: Record<string, string> = {};
  let tablet: Tablet;
  let tablet2: Tablet;
  let guard: string;
  let guard2: string;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const settle = async (n = 5) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const J = () => bearer(jur.token);
  const G = () => bearer(guard);
  const visits = () => t.app.get(VisitsService);
  const setOwner = (token: string, key: string, value: unknown) =>
    t.http
      .put(`/v1/owner/settings/${key}`)
      .set(bearer(token))
      .send({ value, reason: 'J4.1 test' })
      .expect(200)
      .then(() => t.app.get(SettingsService).invalidate(key));
  const doc = async (tenantId: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO core.document (tenant_id, scope_type, kind, storage_bucket, storage_key, mime_type, size_bytes, sha256, retention_class, upload_state)
         VALUES ($1, 'tenant', 'other', 'b', 'k-' || gen_random_uuid(), 'application/pdf', 10, decode(repeat('ab', 32), 'hex'), 'legal', 'verified')
         RETURNING id`,
        [tenantId],
      )
    ).id;
  const signIn = (tb: Tablet, guardId: string, pin = PIN) =>
    t.http.post('/v1/auth/guard/sign-in').send({ ...tb, guardId, pin });
  const newVisit = (token: string, body: Record<string, unknown>) =>
    t.http
      .post('/v1/guard/visits')
      .set(bearer(token))
      .set(idem())
      .send({ clientRef: randomUUID(), kind: 'guest', ...body });
  const notified = (visitId: string, type: string) =>
    q<{ recipient_id: string; channel: string }>(
      `SELECT n.recipient_id, n.channel::text FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = $1 AND e.aggregate_id = $2 ORDER BY n.recipient_id`,
      [type, visitId],
    );

  async function estate(token: string, code: string) {
    const property = await t.http
      .post('/v1/owner/properties')
      .set(bearer(token))
      .send({ code, name: `คอนโด ${code}`, kind: 'condo' })
      .expect(201);
    const building = await t.http
      .post('/v1/owner/buildings')
      .set(bearer(token))
      .send({
        propertyId: property.body.id,
        code: 'A',
        name: 'อาคาร A',
        type: 'condo',
        legalForm: 'condo_act',
      })
      .expect(201);
    return { propertyId: property.body.id as string, buildingId: building.body.id as string };
  }
  const unit = async (token: string, buildingId: string, unitNo: string) =>
    (
      await t.http
        .post('/v1/owner/units')
        .set(bearer(token))
        .send({ buildingId, unitNo, type: 'condo_unit', areaSqm: '40.00' })
        .expect(201)
    ).body.id as string;
  async function gateWithTablet(
    token: string,
    propertyId: string,
  ): Promise<{ gateId: string; tablet: Tablet }> {
    const gate = await t.http
      .post('/v1/owner/gates')
      .set(bearer(token))
      .send({ propertyId, name: 'ป้อมหน้า', kind: 'main' })
      .expect(201);
    const slot = await t.http
      .post(`/v1/owner/gates/${gate.body.id}/devices`)
      .set(bearer(token))
      .set(idem())
      .send({ name: 'แท็บเล็ตป้อมหน้า' })
      .expect(201);
    expect(slot.body.state).toBe('pending');
    const enrolled = await t.http
      .post('/v1/auth/guard/devices/enrol')
      .send({ code: (slot.body.enrolCode as string).toLowerCase(), name: 'แท็บเล็ต 1' })
      .expect(200);
    return {
      gateId: gate.body.id as string,
      tablet: {
        deviceId: enrolled.body.deviceId as string,
        deviceSecret: enrolled.body.deviceSecret as string,
      },
    };
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_gate_visitors' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(at('2027-01-10'));
    admin = await adminToken(t);
    jur = await onboardTenant(t, admin, { slug: 'j41-estate', phone: PHONE_J, type: 'juristic' });
    jur2 = await onboardTenant(t, admin, { slug: 'j41-other', phone: PHONE_J2, type: 'juristic' });
    const e1 = await estate(jur.token, 'G1');
    ids.property = e1.propertyId;
    ids.building = e1.buildingId;
    for (const n of [1, 2, 3, 4]) ids[`u${n}`] = await unit(jur.token, ids.building, `A-10${n}`);
    // A-101: co-owners P (60) and Q (40), family F (occupancy), payer-only B (bill-to); A-102: R; A-103: nobody
    const owner = async (unitId: string, body: Record<string, unknown>) =>
      (
        await t.http
          .post(`/v1/owner/juristic/register/units/${unitId}/owners`)
          .set(J())
          .send({ validFrom: '2020-01-01', ...body })
          .expect(201)
      ).body.owners as { party: { id: string; displayName: string } }[];
    ids.P = (
      await owner(ids.u1!, {
        sharePct: '60',
        party: { type: 'person', displayName: 'สมชาย เจ้าของ', phone: PHONE_P },
      })
    ).find((o) => o.party.displayName === 'สมชาย เจ้าของ')!.party.id;
    ids.Q = (
      await owner(ids.u1!, {
        sharePct: '40',
        party: { type: 'person', displayName: 'สมหญิง ร่วม', phone: PHONE_Q },
      })
    ).find((o) => o.party.displayName === 'สมหญิง ร่วม')!.party.id;
    ids.R = (
      await owner(ids.u2!, {
        sharePct: '100',
        party: { type: 'person', displayName: 'สมศักดิ์ บ้านอื่น', phone: PHONE_R },
      })
    )[0]!.party.id;
    const party = async (displayName: string, phone: string) =>
      (
        await t.http
          .post('/v1/owner/parties')
          .set(J())
          .send({ type: 'person', displayName, phone })
          .expect(201)
      ).body.id as string;
    ids.F = await party('น้องฟ้า ครอบครัว', PHONE_F);
    ids.B = await party('บริษัท จ่ายแทน', PHONE_B);
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from) VALUES ($1, $2, $3, $4, 'family', '2020-01-01')`,
      [jur.tenantId, ids.building, ids.u1, ids.F],
    );
    await q(
      `INSERT INTO juristic.bill_to (tenant_id, building_id, unit_id, owner_party_id, bill_to_party_id, consent_document_id, valid_from)
       VALUES ($1, $2, $3, $4, $5, $6, '2020-01-01')`,
      [jur.tenantId, ids.building, ids.u1, ids.P, ids.B, await doc(jur.tenantId)],
    );
    for (const [key, phone] of [
      ['P', PHONE_P],
      ['Q', PHONE_Q],
      ['F', PHONE_F],
      ['B', PHONE_B],
      ['R', PHONE_R],
    ] as const) {
      const signed = await otpSignIn(t, 'resident', phone, jur.token);
      residents[key] = signed.accessToken;
      users[key] = signed.subject.id;
      await q(`UPDATE core.user_account SET line_user_id = $2 WHERE id = $1`, [
        signed.subject.id,
        `U${key}${'0'.repeat(31)}`,
      ]);
    }
    // the gate, a tablet and a guard of the estate; another estate with its own
    const g1 = await gateWithTablet(jur.token, ids.property);
    ids.gate = g1.gateId;
    tablet = g1.tablet;
    ids.guard = (
      await t.http
        .post('/v1/owner/gate-guards')
        .set(J())
        .set(idem())
        .send({ propertyId: ids.property, displayName: 'สมศักดิ์ กะเช้า', pin: PIN })
        .expect(201)
    ).body.id;
    const e2 = await estate(jur2.token, 'G2');
    ids.property2 = e2.propertyId;
    ids.u21 = await unit(jur2.token, e2.buildingId, 'B-201');
    const g2 = await gateWithTablet(jur2.token, e2.propertyId);
    tablet2 = g2.tablet;
    ids.guard2 = (
      await t.http
        .post('/v1/owner/gate-guards')
        .set(bearer(jur2.token))
        .set(idem())
        .send({ propertyId: e2.propertyId, displayName: 'ป้อมอื่น', pin: '730154' })
        .expect(201)
    ).body.id;
    guard = (await signIn(tablet, ids.guard!).expect(200)).body.accessToken;
    guard2 = (await signIn(tablet2, ids.guard2!, '730154').expect(200)).body.accessToken;
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('enrols a tablet once, signs a guard in with the PIN, locks out after wrong PINs, scopes the token to the gate', async () => {
    const roster = await t.http.post('/v1/auth/guard/roster').send(tablet).expect(200);
    expect(roster.body.guards).toEqual([
      { guardId: ids.guard, displayName: 'สมศักดิ์ กะเช้า', locked: false, lockedUntil: null },
    ]);
    await t.http
      .post('/v1/auth/guard/roster')
      .send({ ...tablet, deviceSecret: 'x'.repeat(43) })
      .expect(401);
    // a guard of another estate cannot sign in on this tablet (same answer as a wrong PIN)
    expect((await signIn(tablet, ids.guard2!, '730154')).body.code).toBe('gate.pin_invalid');
    const me = await t.http.get('/v1/guard/me').set(G()).expect(200);
    expect(me.body).toMatchObject({ gateId: ids.gate, propertyId: ids.property, guardId: ids.guard });
    expect(me.body.privacyNotice.version).toBe(1);
    expect(me.body.autoLockMinutes).toBe(5); // J-CR: gate.tablet.auto_lock_minutes
    // the guard token works nowhere else
    await t.http.get('/v1/owner/gates').set(G()).expect(403);
    await t.http.get('/v1/resident/visits').set(G()).expect(403);
    await t.http.get('/v1/guard/me').set(J()).expect(403);
    // a scratch guard: five wrong PINs lock it (423 with lockedUntil); the owner's reset lifts the lock
    const scratch = (
      await t.http
        .post('/v1/owner/gate-guards')
        .set(J())
        .set(idem())
        .send({ propertyId: ids.property, displayName: 'ทดสอบ ล็อก', pin: '135790' })
        .expect(201)
    ).body.id as string;
    for (let i = 0; i < 4; i += 1) expect((await signIn(tablet, scratch, '000001')).status).toBe(401);
    const locked = await signIn(tablet, scratch, '000001');
    expect(locked.status).toBe(423);
    expect(locked.body.lockedUntil).toBeTruthy();
    expect((await signIn(tablet, scratch, '135790')).status).toBe(423);
    // J-CR: the roster says until when
    const lockedRoster = await t.http.post('/v1/auth/guard/roster').send(tablet).expect(200);
    expect(
      (lockedRoster.body.guards as { guardId: string; locked: boolean; lockedUntil: string | null }[]).find(
        (g) => g.guardId === scratch,
      ),
    ).toMatchObject({ locked: true, lockedUntil: expect.stringMatching(/\+07:00$/) });
    await t.http
      .post(`/v1/owner/gate-guards/${scratch}/actions/reset-pin`)
      .set(J())
      .set(idem())
      .send({ pin: '246802' })
      .expect(200);
    const ok = await signIn(tablet, scratch, '246802').expect(200);
    expect(ok.body.subject.audience).toBe('guard');
    // revoking the guard ends the shift at once (token refused, refresh refused)
    await t.http
      .post(`/v1/owner/gate-guards/${scratch}/actions/revoke`)
      .set(J())
      .set(idem())
      .send({ reason: 'ทดสอบเสร็จ' })
      .expect(200);
    await t.http.get('/v1/guard/me').set(bearer(ok.body.accessToken)).expect(401);
    await t.http.post('/v1/auth/refresh').send({ refreshToken: ok.body.refreshToken }).expect(401);
    // a used enrolment code is refused
    const slot = await t.http
      .post(`/v1/owner/gates/${ids.gate}/devices`)
      .set(J())
      .set(idem())
      .send({ name: 'แท็บเล็ตสำรอง' })
      .expect(201);
    await t.http.post('/v1/auth/guard/devices/enrol').send({ code: slot.body.enrolCode }).expect(200);
    expect(
      (await t.http.post('/v1/auth/guard/devices/enrol').send({ code: slot.body.enrolCode })).body.code,
    ).toBe('gate.enrol_code_invalid');
    // guards are not console members
    const members = await t.http.get('/v1/owner/members').set(J()).expect(200);
    expect(JSON.stringify(members.body)).not.toContain('กะเช้า');
  });

  it('J review A1: a second sign-in of the same guard supersedes the first shift and its token stops at once', async () => {
    const twin = (
      await t.http
        .post('/v1/owner/gate-guards')
        .set(J())
        .set(idem())
        .send({ propertyId: ids.property, displayName: 'ทดสอบ สองเครื่อง', pin: '913570' })
        .expect(201)
    ).body.id as string;
    const first = (await signIn(tablet, twin, '913570').expect(200)).body;
    await t.http.get('/v1/guard/me').set(bearer(first.accessToken)).expect(200);
    const second = (await signIn(tablet, twin, '913570').expect(200)).body;
    // the superseded shift's access token is refused at once (not after its 15-minute lifetime)
    await t.http.get('/v1/guard/me').set(bearer(first.accessToken)).expect(401);
    await t.http
      .post(`/v1/guard/gates/${ids.gate}/actions/open`)
      .set(bearer(first.accessToken))
      .set(idem())
      .send({ reason: 'other', note: 'ทดสอบ' })
      .expect(401);
    await t.http.post('/v1/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await t.http.get('/v1/guard/me').set(bearer(second.accessToken)).expect(200);
    const shifts = await q<{ end_reason: string | null }>(
      `SELECT end_reason::text FROM smart.guard_shift WHERE guard_id = $1 ORDER BY ended_at NULLS LAST`,
      [twin],
    );
    expect(shifts.map((s) => s.end_reason)).toEqual(['superseded', null]);
  });

  it('full loop: every resident of the unit is asked (not the payer-only party), concurrent answers — one wins, entry and exit', async () => {
    const created = await newVisit(guard, {
      unitId: ids.u1,
      plate: PLATE,
      visitorName: 'สมปอง',
      idLast4: '9876',
    }).expect(201);
    const v = created.body;
    expect(v).toMatchObject({
      state: 'requested',
      unitNo: 'A-101',
      idLast4: '9876',
      timeoutAction: 'guard_calls',
      replayed: false,
    });
    expect(new Date(v.respondBy).getTime() - new Date(v.createdAt).getTime()).toBe(180_000);
    await settle();
    const asked = await notified(v.id, 'gate.visit.requested');
    expect(
      asked
        .filter((n) => n.channel === 'line')
        .map((n) => n.recipient_id)
        .sort(),
    ).toEqual([users.P, users.Q, users.F].sort());
    expect(asked.map((n) => n.recipient_id)).not.toContain(users.B);
    // the domain event carries ids only (PDPA)
    const payload = await one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'gate.visit.requested' AND aggregate_id = $1`,
      [v.id],
    );
    expect(JSON.stringify(payload.payload)).not.toMatch(/1234|สมปอง|9876/);
    // the payer-only party and another unit's owner cannot see the visit
    await t.http.get(`/v1/resident/visits/${v.id}`).set(bearer(residents.B!)).expect(404);
    await t.http.get(`/v1/resident/visits/${v.id}`).set(bearer(residents.R!)).expect(404);
    await t.http
      .post(`/v1/resident/visits/${v.id}/actions/approve`)
      .set(bearer(residents.R!))
      .send({})
      .expect(404);
    const family = await t.http.get(`/v1/resident/visits/${v.id}`).set(bearer(residents.F!)).expect(200);
    expect(family.body).not.toHaveProperty('idLast4');
    expect(family.body.policy).toMatchObject({ timeoutSeconds: 180, action: 'guard_calls', custom: false });
    // P approves while Q denies — exactly one answer is taken
    const [a, b] = await Promise.all([
      t.http.post(`/v1/resident/visits/${v.id}/actions/approve`).set(bearer(residents.P!)).send({}),
      t.http.post(`/v1/resident/visits/${v.id}/actions/deny`).set(bearer(residents.Q!)).send({}),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.accepted, b.body.accepted].sort()).toEqual([false, true]);
    const winner = a.body.accepted ? 'approved' : 'denied';
    expect(a.body.visit.state).toBe(winner);
    expect(b.body.visit.state).toBe(winner);
    const answered = await q(`SELECT 1 FROM smart.visit_event WHERE visit_id = $1 AND kind = 'answered'`, [
      v.id,
    ]);
    expect(answered).toHaveLength(1);
    // the gate stream / changes feed shows it
    const changes = await t.http.get('/v1/guard/visits/changes').set(G()).expect(200);
    expect(
      (changes.body as { visitId: string; kind: string }[]).map((c) => `${c.visitId}:${c.kind}`),
    ).toEqual(expect.arrayContaining([`${v.id}:created`, `${v.id}:answered`]));
    const after = changes.body[0].id as string;
    const tail = await t.http.get(`/v1/guard/visits/changes?after=${after}`).set(G()).expect(200);
    expect((tail.body as { id: string }[]).every((c) => c.id > after)).toBe(true);
    if (winner === 'approved') {
      await t.http.post(`/v1/guard/visits/${v.id}/actions/enter`).set(G()).send({}).expect(200);
      const exited = await t.http
        .post(`/v1/resident/visits/${v.id}/actions/exit`)
        .set(bearer(residents.F!))
        .expect(200);
      expect(exited.body).toMatchObject({ state: 'exited', exitedBy: 'resident' });
    } else {
      expect((await t.http.post(`/v1/guard/visits/${v.id}/actions/enter`).set(G()).send({})).body.code).toBe(
        'visit.denied',
      );
    }
    // a second visit: P answers first; Q's later answer is not taken and sees P's; P repeating is idempotent
    const v2 = (await newVisit(guard, { unitId: ids.u1, kind: 'contractor' }).expect(201)).body;
    const first = await t.http
      .post(`/v1/resident/visits/${v2.id}/actions/approve`)
      .set(bearer(residents.P!))
      .send({})
      .expect(200);
    expect(first.body.accepted).toBe(true);
    const late = await t.http
      .post(`/v1/resident/visits/${v2.id}/actions/deny`)
      .set(bearer(residents.Q!))
      .expect(200);
    expect(late.body).toMatchObject({
      accepted: false,
      visit: { state: 'approved', decidedByName: 'สมชาย เจ้าของ' },
    });
    const again = await t.http
      .post(`/v1/resident/visits/${v2.id}/actions/approve`)
      .set(bearer(residents.P!))
      .send({})
      .expect(200);
    expect(again.body.accepted).toBe(true);
    await t.http.post(`/v1/guard/visits/${v2.id}/actions/enter`).set(G()).send({}).expect(200);
    const out = await t.http.post(`/v1/guard/visits/${v2.id}/actions/exit`).set(G()).expect(200);
    expect(out.body).toMatchObject({ state: 'exited', exitedBy: 'guard' });
    await t.http.post(`/v1/guard/visits/${v2.id}/actions/exit`).set(G()).expect(200);
    // ID digits: exactly 4
    expect((await newVisit(guard, { unitId: ids.u1, idLast4: '12345' })).status).toBe(422);
    expect((await newVisit(guard, { unitId: ids.u1, idLast4: '123' })).status).toBe(422);
  });

  it('applies each house policy when nobody answers in time (and at once for a house nobody can be asked about)', async () => {
    const nobody = (await newVisit(guard, { unitId: ids.u3 }).expect(201)).body;
    expect(nobody).toMatchObject({
      state: 'timed_out',
      timeoutAction: 'guard_calls',
      decisionReason: 'nobody_reachable',
    });
    const outcomes: Record<string, string> = {};
    for (const action of ['allow_and_log', 'deny', 'guard_calls'] as const) {
      await t.http
        .put(`/v1/owner/gate-policies/units/${ids.u1}`)
        .set(J())
        .send({ timeoutSeconds: 60, action })
        .expect(200);
      const v = (await newVisit(guard, { unitId: ids.u1 }).expect(201)).body;
      expect(v).toMatchObject({ state: 'requested', timeoutAction: action });
      if (action === 'guard_calls') {
        const call = await t.http
          .post(`/v1/resident/visits/${v.id}/actions/call-me`)
          .set(bearer(residents.Q!))
          .expect(200);
        expect(call.body.accepted).toBe(true);
        const g = await t.http.get(`/v1/guard/visits/${v.id}`).set(G()).expect(200);
        expect(g.body.callBackName).toBe('สมหญิง'); // first names only at the gate (D-315, J-CR D-335)
      }
      t.clock.advance(59_000);
      await visits().sweep();
      expect((await t.http.get(`/v1/guard/visits/${v.id}`).set(G()).expect(200)).body.state).toBe(
        'requested',
      );
      t.clock.advance(2_000);
      expect((await visits().sweep()).timedOut).toBeGreaterThanOrEqual(1);
      const timed = await t.http.get(`/v1/guard/visits/${v.id}`).set(G()).expect(200);
      expect(timed.body).toMatchObject({ state: 'timed_out', decisionReason: 'timeout' });
      // a late answer is not taken
      const late = await t.http
        .post(`/v1/resident/visits/${v.id}/actions/approve`)
        .set(bearer(residents.P!))
        .send({})
        .expect(200);
      expect(late.body.accepted).toBe(false);
      const enter = await t.http.post(`/v1/guard/visits/${v.id}/actions/enter`).set(G()).send({});
      outcomes[action] = enter.status === 200 ? enter.body.entryBasis : enter.body.code;
      if (enter.status === 200) {
        await settle();
        expect((await notified(v.id, 'gate.visit.entered')).map((n) => n.recipient_id).sort()).toEqual(
          [users.P, users.Q, users.F].sort(),
        );
      }
    }
    expect(outcomes).toEqual({ allow_and_log: 'policy', deny: 'visit.denied', guard_calls: 'policy' });
    // the guard may still let a waiting visitor in with a reason (D-315)
    await t.http
      .put(`/v1/owner/gate-policies/units/${ids.u1}`)
      .set(J())
      .send({ timeoutSeconds: 180, action: 'guard_calls' })
      .expect(200);
    const waiting = (await newVisit(guard, { unitId: ids.u1 }).expect(201)).body;
    expect(
      (await t.http.post(`/v1/guard/visits/${waiting.id}/actions/enter`).set(G()).send({})).body.code,
    ).toBe('visit.awaiting_answer');
    const override = await t.http
      .post(`/v1/guard/visits/${waiting.id}/actions/enter`)
      .set(G())
      .send({ reason: 'เจ้าของบ้านโทรยืนยันกับ รปภ.' })
      .expect(200);
    expect(override.body).toMatchObject({ state: 'entered', entryBasis: 'guard_override' });
  });

  it('delivery: the estate drop point lets deliveries in at once unless the house says otherwise', async () => {
    const asks = (await newVisit(guard, { unitId: ids.u2, kind: 'delivery' }).expect(201)).body;
    expect(asks.state).toBe('requested');
    t.clock.advance(1_000);
    await setOwner(jur.token, 'gate.delivery_drop_point', true);
    const drop = (await newVisit(guard, { unitId: ids.u2, kind: 'delivery' }).expect(201)).body;
    expect(drop).toMatchObject({ state: 'entered', entryBasis: 'delivery_drop_point' });
    await settle();
    expect((await notified(drop.id, 'gate.visit.entered')).map((n) => n.recipient_id)).toEqual([users.R]);
    // a guest is still asked; a house that wants to be asked about deliveries is asked
    expect((await newVisit(guard, { unitId: ids.u2, kind: 'guest' }).expect(201)).body.state).toBe(
      'requested',
    );
    await t.http
      .put(`/v1/resident/units/${ids.u2}/gate-policy`)
      .set(bearer(residents.R!))
      .send({ deliverySkipApproval: false })
      .expect(200);
    expect((await newVisit(guard, { unitId: ids.u2, kind: 'delivery' }).expect(201)).body.state).toBe(
      'requested',
    );
    // family cannot change the house policy (co-owner / tenant / co-tenant only)
    await t.http
      .put(`/v1/resident/units/${ids.u1}/gate-policy`)
      .set(bearer(residents.F!))
      .send({ action: 'deny' })
      .expect(404);
    const view = await t.http.get(`/v1/resident/units/${ids.u1}/gate`).set(bearer(residents.F!)).expect(200);
    expect(view.body).toMatchObject({ canEdit: false, gates: [{ id: ids.gate, name: 'ป้อมหน้า' }] });
    t.clock.advance(1_000);
    await setOwner(jur.token, 'gate.delivery_drop_point', false);
  });

  it('invites: single use, multi use, contractor approval; another estate cannot scan them', async () => {
    const window = { validFrom: '2027-01-10T08:00:00+07:00', validTo: '2027-01-12T18:00:00+07:00' };
    const scan = (token: string, guardToken = guard, extra: Record<string, unknown> = {}) =>
      t.http
        .post('/v1/guard/invites/actions/scan')
        .set(bearer(guardToken))
        .set(idem())
        .send({ token, clientRef: randomUUID(), ...extra });
    const single = await t.http
      .post(`/v1/resident/units/${ids.u1}/visit-invites`)
      .set(bearer(residents.P!))
      .set(idem())
      .send({ usage: 'single', visitorKind: 'guest', visitorName: 'คุณแม่', plate: PLATE, ...window })
      .expect(201);
    expect(single.body.token).toMatch(/^gpv1\./);
    const stored = await one<{ token_hash: Buffer }>(
      `SELECT token_hash FROM smart.visit_invite WHERE id = $1`,
      [single.body.id],
    );
    expect(stored.token_hash.toString('utf8')).not.toContain(single.body.token);
    expect((await scan(single.body.token, guard2)).status).toBe(404);
    expect((await scan(single.body.token, guard, { plate: { ...PLATE, number: '9999' } })).body.code).toBe(
      'visit_invite.plate_mismatch',
    );
    const used = await scan(single.body.token).expect(201);
    expect(used.body).toMatchObject({
      state: 'entered',
      entryBasis: 'invite',
      visitorName: 'คุณแม่',
      unitId: ids.u1,
    });
    expect((await scan(single.body.token)).body.code).toBe('visit_invite.used_up');
    const multi = await t.http
      .post(`/v1/resident/units/${ids.u1}/visit-invites`)
      .set(bearer(residents.Q!))
      .set(idem())
      .send({ usage: 'multi', maxUses: 2, visitorKind: 'delivery', ...window })
      .expect(201);
    await scan(multi.body.token).expect(201);
    await scan(multi.body.token).expect(201);
    expect((await scan(multi.body.token)).body.code).toBe('visit_invite.used_up');
    const contractor = await t.http
      .post(`/v1/resident/units/${ids.u1}/visit-invites`)
      .set(bearer(residents.P!))
      .set(idem())
      .send({ usage: 'multi', maxUses: 5, visitorKind: 'contractor', ...window })
      .expect(201);
    expect(contractor.body.state).toBe('pending_approval');
    expect((await scan(contractor.body.token)).body.code).toBe('visit_invite.not_active');
    const pending = await t.http.get('/v1/owner/gate-invites?state=pending_approval').set(J()).expect(200);
    expect((pending.body as { id: string }[]).map((i) => i.id)).toEqual([contractor.body.id]);
    await t.http
      .post(`/v1/owner/gate-invites/${contractor.body.id}/actions/approve`)
      .set(J())
      .set(idem())
      .expect(200);
    expect((await scan(contractor.body.token).expect(201)).body.kind).toBe('contractor');
    // revoked and out-of-window invites
    await t.http
      .post(`/v1/resident/units/${ids.u1}/visit-invites/${contractor.body.id}/actions/revoke`)
      .set(bearer(residents.P!))
      .expect(200);
    expect((await scan(contractor.body.token)).body.code).toBe('visit_invite.not_active');
    expect(
      (
        await t.http
          .post(`/v1/resident/units/${ids.u1}/visit-invites`)
          .set(bearer(residents.P!))
          .set(idem())
          .send({
            usage: 'single',
            visitorKind: 'guest',
            validFrom: '2027-01-10T08:00:00+07:00',
            validTo: '2027-03-10T08:00:00+07:00',
          })
      ).body.code,
    ).toBe('visit_invite.window_too_long');
    // another unit's resident cannot list them; the family member can read but not create
    await t.http.get(`/v1/resident/units/${ids.u1}/visit-invites`).set(bearer(residents.R!)).expect(404);
    await t.http.get(`/v1/resident/units/${ids.u1}/visit-invites`).set(bearer(residents.F!)).expect(200);
    expect(
      (
        await t.http
          .post(`/v1/resident/units/${ids.u1}/visit-invites`)
          .set(bearer(residents.F!))
          .set(idem())
          .send({ usage: 'single', visitorKind: 'guest', ...window })
      ).status,
    ).toBe(404);
  });

  it('remembers a car for 30 days (next entries notify-only) and refuses blacklisted plates', async () => {
    const car = { category: 'กท', number: '55', province: 'ชลบุรี' };
    const v = (await newVisit(guard, { unitId: ids.u2, plate: car }).expect(201)).body;
    const ok = await t.http
      .post(`/v1/resident/visits/${v.id}/actions/approve`)
      .set(bearer(residents.R!))
      .send({ rememberVehicle: true })
      .expect(200);
    expect(ok.body.accepted).toBe(true);
    const list = await t.http
      .get(`/v1/resident/units/${ids.u2}/remembered-vehicles`)
      .set(bearer(residents.R!))
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(new Date(list.body[0].expiresAt).getTime() - t.clock.now().getTime()).toBe(30 * 86_400_000);
    const next = (await newVisit(guard, { unitId: ids.u2, plate: car }).expect(201)).body;
    expect(next).toMatchObject({ state: 'entered', entryBasis: 'remembered_vehicle' });
    // the same plate for another house is still asked
    expect((await newVisit(guard, { unitId: ids.u1, plate: car }).expect(201)).body.state).toBe('requested');
    await t.http
      .delete(`/v1/resident/units/${ids.u2}/remembered-vehicles/${list.body[0].id}`)
      .set(bearer(residents.R!))
      .expect(204);
    expect((await newVisit(guard, { unitId: ids.u2, plate: car }).expect(201)).body.state).toBe('requested');
    // blacklist: reason required, audited, refuses the plate at once
    expect(
      (
        await t.http
          .post('/v1/owner/gate-blacklist')
          .set(J())
          .set(idem())
          .send({ propertyId: ids.property, plate: car, reason: 'x' })
      ).status,
    ).toBe(422);
    const entry = await t.http
      .post('/v1/owner/gate-blacklist')
      .set(J())
      .set(idem())
      .send({ propertyId: ids.property, plate: car, reason: 'ขับรถเร็วในหมู่บ้านซ้ำหลายครั้ง' })
      .expect(201);
    const refused = (await newVisit(guard, { unitId: ids.u2, plate: car }).expect(201)).body;
    expect(refused).toMatchObject({ state: 'denied', decisionReason: 'blacklisted' });
    const audit = await one<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM platform.audit_log WHERE action = 'gate.blacklist_added' AND subject_id = $1`,
      [entry.body.id],
    );
    expect(audit.metadata.reason).toBe('ขับรถเร็วในหมู่บ้านซ้ำหลายครั้ง');
    // the other estate is not affected
    expect((await newVisit(guard2, { unitId: ids.u21, plate: car }).expect(201)).body.state).toBe(
      'timed_out',
    );
  });

  it('offline replays never duplicate a visit; offline entries keep their time; too old is refused', async () => {
    const clientRef = randomUUID();
    const body = {
      clientRef,
      kind: 'guest',
      unitId: ids.u2,
      enteredOffline: true,
      recordedAt: new Date(t.clock.now().getTime() - 2 * 3_600_000).toISOString(),
    };
    const first = await t.http.post('/v1/guard/visits').set(G()).set(idem()).send(body).expect(201);
    expect(first.body).toMatchObject({ state: 'entered', entryBasis: 'offline', replayed: false });
    expect(new Date(first.body.enteredAt).toISOString()).toBe(body.recordedAt);
    const replays = await Promise.all(
      [1, 2, 3].map(() => t.http.post('/v1/guard/visits').set(G()).set(idem()).send(body)),
    );
    for (const r of replays) expect(r.body).toMatchObject({ id: first.body.id, replayed: true });
    expect((await q(`SELECT id FROM smart.visit WHERE client_ref = $1`, [clientRef])).length).toBe(1);
    // the same Idempotency-Key replays the stored answer
    const key = randomUUID();
    const fresh = { clientRef: randomUUID(), kind: 'guest', unitId: ids.u2 };
    const a = await t.http
      .post('/v1/guard/visits')
      .set(G())
      .set('Idempotency-Key', key)
      .send(fresh)
      .expect(201);
    const b = await t.http
      .post('/v1/guard/visits')
      .set(G())
      .set('Idempotency-Key', key)
      .send(fresh)
      .expect(201);
    expect(b.body.id).toBe(a.body.id);
    expect(
      (
        await t.http
          .post('/v1/guard/visits')
          .set(G())
          .set(idem())
          .send({
            ...fresh,
            clientRef: randomUUID(),
            recordedAt: new Date(t.clock.now().getTime() - 30 * 3_600_000).toISOString(),
            enteredOffline: true,
          })
      ).body.code,
    ).toBe('visit.offline_too_old');
  });

  it('logs reads of the visit log with a reason; residents and other estates see nothing of it; no arrears at the gate', async () => {
    await t.http.get('/v1/owner/gate-visits').set(J()).expect(422);
    const log = await t.http
      .get('/v1/owner/gate-visits?reason=ตรวจสอบเหตุรถชนป้ายหน้าโครงการ&perPage=100')
      .set(J())
      .expect(200);
    expect(log.body.meta.total).toBeGreaterThan(5);
    expect(log.body.data[0]).toHaveProperty('idLast4');
    const reads = await q(
      `SELECT metadata FROM platform.audit_log WHERE action = 'gate.visit_log_read' AND tenant_id = $1`,
      [jur.tenantId],
    );
    expect(reads).toHaveLength(1);
    const anyVisit = log.body.data[0].id as string;
    await t.http.get(`/v1/owner/gate-visits/${anyVisit}?reason=ตรวจสอบเหตุ`).set(J()).expect(200);
    // another tenant, another estate's guard: 404
    await t.http
      .get(`/v1/owner/gate-visits/${anyVisit}?reason=ตรวจสอบเหตุ`)
      .set(bearer(jur2.token))
      .expect(404);
    await t.http.get(`/v1/owner/gates/${ids.gate}`).set(bearer(jur2.token)).expect(404);
    await t.http.get(`/v1/guard/visits/${anyVisit}`).set(bearer(guard2)).expect(404);
    await t.http.post(`/v1/guard/visits/${anyVisit}/actions/exit`).set(bearer(guard2)).expect(404);
    expect((await newVisit(guard2, { unitId: ids.u1 })).status).toBe(404);
    await t.http
      .put(`/v1/owner/gate-policies/units/${ids.u1}`)
      .set(bearer(jur2.token))
      .send({ action: 'deny' })
      .expect(404);
    await t.http
      .post(`/v1/owner/gates/${ids.gate}/devices/${tablet.deviceId}/actions/revoke`)
      .set(bearer(jur2.token))
      .set(idem())
      .send({ reason: 'ไม่ใช่ของเรา' })
      .expect(404);
    // R sees only visits of A-102
    const mine = await t.http.get('/v1/resident/visits?perPage=100').set(bearer(residents.R!)).expect(200);
    expect((mine.body.data as { unitId: string }[]).every((v) => v.unitId === ids.u2)).toBe(true);
    await t.http.get(`/v1/resident/visits?unitId=${ids.u1}`).set(bearer(residents.R!)).expect(404);
    // arrears: off by default — no field at all
    const units = await t.http.get('/v1/guard/units?q=A-10').set(G()).expect(200);
    const picked = units.body as { unitNo: string; lineLinked: boolean }[];
    expect(picked.map((u) => u.unitNo)).toEqual(['A-101', 'A-102', 'A-103', 'A-104']);
    for (const u of picked) expect(u).not.toHaveProperty('hasArrears');
    expect(picked.find((u) => u.unitNo === 'A-101')?.lineLinked).toBe(true);
    expect(picked.find((u) => u.unitNo === 'A-103')?.lineLinked).toBe(false);
  });

  it('J review A4: with gate.show_arrears on, only an overdue balance net of credit is an arrear (not a bill not yet due)', async () => {
    const setAdmin = async (key: string, value: unknown) => {
      t.clock.advance(1_000);
      await t.http
        .put(`/v1/admin/settings/${key}`)
        .set(bearer(admin))
        .send({ value, reason: 'J review A4' })
        .expect(200);
      t.app.get(SettingsService).invalidate(key);
    };
    const day = (offset: number) =>
      new Date(t.clock.now().getTime() + 7 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
    let n = 0;
    const bill = async (unitId: string, partyId: string, due: string, status: string, balance: number) => {
      n += 1;
      await q(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, number, snapshot, period_start,
           period_end, issued_at, due_date, status, subtotal, total, paid_total, balance)
         VALUES ($1, $2, $3, $4, $5, '{}', $6::date - 30, $6::date - 1, now(), $6::date, $7::ops.invoice_status, $8, $8, 0, $8)`,
        [jur.tenantId, ids.building, unitId, partyId, `INV-A4-${n}`, due, status, balance],
      );
      // the receivables projection as the subscriber keeps it (balance > 0 for both units)
      await q(
        `INSERT INTO ops.receivable_balance (tenant_id, building_id, party_id, unit_id, balance, open_invoices_count, oldest_due_date)
         VALUES ($1, $2, $3, $4, $5, 1, $6::date)
         ON CONFLICT (tenant_id, party_id, unit_id) WHERE unit_id IS NOT NULL DO UPDATE SET balance = EXCLUDED.balance`,
        [jur.tenantId, ids.building, partyId, unitId, balance, due],
      );
    };
    await bill(ids.u1!, ids.P!, day(5), 'issued', 1200); // A-101: this month's bill, not yet due
    await bill(ids.u2!, ids.R!, day(-10), 'overdue', 500); // A-102: 10 days overdue
    await setAdmin('gate.show_arrears', true);
    const flags = async () =>
      Object.fromEntries(
        (
          (await t.http.get('/v1/guard/units?q=A-10').set(G()).expect(200)).body as {
            unitNo: string;
            hasArrears: boolean;
          }[]
        ).map((u) => [u.unitNo, u.hasArrears]),
      );
    expect(await flags()).toEqual({ 'A-101': false, 'A-102': true, 'A-103': false, 'A-104': false });
    // the payer's credit on that unit covers the overdue bill → no arrear
    await q(
      `INSERT INTO ops.payer_credit (tenant_id, building_id, unit_id, party_id, kind, amount) VALUES ($1, $2, $3, $4, 'overpayment', 500)`,
      [jur.tenantId, ids.building, ids.u2, ids.R],
    );
    expect((await flags())['A-102']).toBe(false);
    await setAdmin('gate.show_arrears', false);
  });

  it('J-CR (D-335): first names on the gate lists, soi search, estate limits, the gate capability, one invite', async () => {
    // the gate lists name who decided — first names only (D-315)
    const today = await t.http.get('/v1/guard/visits?view=today&limit=200').set(G()).expect(200);
    const decided = (today.body as { decidedByName: string | null; overstayedAt: string | null }[]).filter(
      (v) => v.decidedByName,
    );
    expect(decided.length).toBeGreaterThan(0);
    for (const v of decided) {
      expect(['สมชาย', 'สมหญิง', 'สมศักดิ์']).toContain(v.decidedByName);
      expect(v.decidedByName).not.toMatch(/\s/);
    }
    expect(today.body[0]).toHaveProperty('overstayedAt');
    expect(today.body[0]).toHaveProperty('callBackName');
    // soi / building name search
    const bySoi = await t.http
      .get(`/v1/guard/units?q=${encodeURIComponent('อาคาร A')}`)
      .set(G())
      .expect(200);
    expect((bySoi.body as { unitNo: string }[]).map((u) => u.unitNo)).toEqual(
      expect.arrayContaining(['A-101', 'A-102']),
    );
    // the estate's limits on the resident gate view
    const view = await t.http.get(`/v1/resident/units/${ids.u1}/gate`).set(bearer(residents.P!)).expect(200);
    expect(view.body).toMatchObject({ rememberDays: 30, inviteMaxDays: 30 });
    // the gate capability follows the unit and the role (payer-only: none)
    const capsOf = async (token: string, unitId: string) =>
      (
        (await t.http.get('/v1/resident/me/units').set(bearer(token)).expect(200)).body.units as {
          unitId: string;
          capabilities: string[];
          areaSqm: string | null;
          recurringAvailable: boolean;
        }[]
      ).find((u) => u.unitId === unitId);
    const pUnit = (await capsOf(residents.P!, ids.u1!))!;
    expect(pUnit.capabilities).toContain('gate');
    expect(pUnit.areaSqm).toBe('40.00');
    expect(typeof pUnit.recurringAvailable).toBe('boolean');
    expect((await capsOf(residents.F!, ids.u1!))!.capabilities).toContain('gate');
    expect((await capsOf(residents.B!, ids.u1!))?.capabilities ?? []).not.toContain('gate');
    // one invite of my house; another house's path or id is a 404
    const inv = await t.http
      .post(`/v1/resident/units/${ids.u1}/visit-invites`)
      .set(bearer(residents.P!))
      .set(idem())
      .send({
        usage: 'single',
        visitorKind: 'guest',
        validFrom: '2027-01-10T08:00:00+07:00',
        validTo: '2027-01-11T18:00:00+07:00',
      })
      .expect(201);
    const got = await t.http
      .get(`/v1/resident/units/${ids.u1}/visit-invites/${inv.body.id}`)
      .set(bearer(residents.Q!))
      .expect(200);
    expect(got.body).toMatchObject({ id: inv.body.id, usage: 'single' });
    expect(got.body).not.toHaveProperty('token');
    await t.http
      .get(`/v1/resident/units/${ids.u2}/visit-invites/${inv.body.id}`)
      .set(bearer(residents.R!))
      .expect(404);
    await t.http
      .get(`/v1/resident/units/${ids.u1}/visit-invites/${inv.body.id}`)
      .set(bearer(residents.R!))
      .expect(404);
    await t.http
      .get(`/v1/resident/units/${ids.u1}/visit-invites/${randomUUID()}`)
      .set(bearer(residents.P!))
      .expect(404);
  });

  it('retention deletes visits, their events, photos (rows and objects), ended invites and expired cars', async () => {
    const v = (await newVisit(guard, { unitId: ids.u2, plate: PLATE }).expect(201)).body;
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082',
      'hex',
    );
    const photo = await t.http
      .post(`/v1/guard/visits/${v.id}/photo`)
      .set(G())
      .send({ contentBase64: png.toString('base64'), mimeType: 'image/png' })
      .expect(200);
    expect(photo.body.hasPhoto).toBe(true);
    const row = await one<{ photo_document_id: string; storage_key: string; retention_class: string }>(
      `SELECT v.photo_document_id, d.storage_key, d.retention_class FROM smart.visit v JOIN core.document d ON d.id = v.photo_document_id WHERE v.id = $1`,
      [v.id],
    );
    expect(row.retention_class).toBe('visitor');
    const storage = t.app.get<FakeObjectStorage>(OBJECT_STORAGE);
    expect(storage.objects.has(row.storage_key)).toBe(true);
    const fresh = (await newVisit(guard, { unitId: ids.u2 }).expect(201)).body;
    await q(`UPDATE smart.visit SET created_at = now() - interval '91 days' WHERE id = $1`, [v.id]);
    await q(
      `UPDATE smart.visit_invite SET valid_from = now() - interval '100 days', valid_to = now() - interval '95 days' WHERE tenant_id = $1 AND usage = 'single'`,
      [jur.tenantId],
    );
    await q(
      `INSERT INTO smart.remembered_vehicle (tenant_id, property_id, unit_id, plate_category, plate_number, plate_province, expires_at, revoked_at)
             VALUES ($1, $2, $3, 'ขข', '1', 'ระยอง', now() - interval '100 days', now() - interval '99 days')`,
      [jur.tenantId, ids.property, ids.u2],
    );
    const reports = await t.app.get(GateRetentionService).run();
    const mineReport = reports.find((r) => r.tenantId === jur.tenantId)!;
    expect(mineReport).toMatchObject({ visits: 1, photos: 1 });
    expect(mineReport.invites).toBeGreaterThanOrEqual(1);
    expect(mineReport.vehicles).toBeGreaterThanOrEqual(1);
    expect(await q(`SELECT 1 FROM smart.visit WHERE id = $1`, [v.id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM smart.visit_event WHERE visit_id = $1`, [v.id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM core.document WHERE id = $1`, [row.photo_document_id])).toHaveLength(0);
    expect(storage.objects.has(row.storage_key)).toBe(false);
    expect(await q(`SELECT 1 FROM smart.visit WHERE id = $1`, [fresh.id])).toHaveLength(1);
    const purged = await one<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM platform.audit_log WHERE action = 'gate.retention_purged' AND tenant_id = $1`,
      [jur.tenantId],
    );
    expect(JSON.stringify(purged.metadata)).not.toContain('1234');
    // a tenant may shorten the period, never lengthen it past 90
    await t.http
      .put('/v1/owner/settings/gate.retention_days')
      .set(J())
      .send({ value: 120, reason: 'J4.1 test' })
      .expect(422);
  });
});

import 'reflect-metadata';

import { fakeLineIdToken } from '@collective/integrations/line';
import { SettingsService } from '@core/settings/settings.service';
import { type FakeLockVendors } from '@integrations/locks/fake-lock-vendors';
import { LOCK_VENDORS } from '@integrations/locks/lock-vendor.port';
import { SelfViewingService } from '@modules/ops-listings/self-viewing.service';
import { LocksService } from '@modules/smart-access/locks.service';
import sharp from 'sharp';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, from: '08:00', to: '20:00' },
  { weekday, from: '00:00', to: '23:30', mode: 'self' },
]);
const MINUTE = 60_000;
const OTHER_PHONE = '+660000000271';
const SOMSRI = 'U000000000000000000000000000g7001';
const LEK = 'U000000000000000000000000000g7002';

interface Slot {
  startsAt: string;
  endsAt: string;
  mode: 'accompanied' | 'self';
}
interface Viewing {
  id: string;
  state: string;
  mode: string;
  startsAt: string;
  access: { state: string; validFrom: string; validTo: string; enteredSource: string | null } | null;
}

/**
 * G7 acceptance (docs/prompts/G-growth-api.md G7, D-289 (1), D-295, O-024): a verified prospect books a self-viewing
 * slot of a vacant unit with a lock, the owner confirms, one door code opens the unit lock and the building door only
 * inside its window; unverified prospects, a switched-off setting, a unit without a lock and an occupied unit are
 * refused; entry (lock log) alerts the owner and staff; leaving revokes the code; an incident opens a work order; a
 * second open visit blocks the next code; a missed window becomes a no show; resident codes are never touched;
 * the door code never reaches events or audit metadata; cross-tenant and other prospects get 404.
 */
describe('G7 self-viewing (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let other: { tenantId: string; token: string };
  let somsri: string;
  let lek: string;
  const ids: Record<string, string> = {};
  const listings: Record<string, { id: string; slug: string }> = {};
  let firstViewing: Viewing;
  let secondViewing: Viewing;
  let doorCode: string;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const vendor = () => t.app.get<FakeLockVendors>(LOCK_VENDORS).adapter('ttlock');
  const register = async (body: Record<string, unknown>) =>
    (await t.http.post('/v1/owner/locks').set(O()).send(body).expect(201)).body as { id: string };

  async function prospect(sub: string, name: string): Promise<string> {
    const res = await t.http
      .post('/v1/auth/prospect/line')
      .send({ idToken: fakeLineIdToken({ sub, name }) })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function publishListing(unitId: string, title: string): Promise<{ id: string; slug: string }> {
    const created = await t.http
      .post('/v1/owner/listings')
      .set(O())
      .send({ unitId, titleTh: title, rent: '9500' })
      .expect(201);
    const listing = { id: created.body.id as string, slug: created.body.slug as string };
    for (let i = 0; i < 5; i++) {
      const body = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7aa6c2' } })
        .jpeg()
        .toBuffer();
      const documentId = await uploadFile(t, db, owner, {
        kind: 'listing_photo',
        scopeType: 'unit',
        scopeId: unitId,
        fileName: 'room.jpg',
        mimeType: 'image/jpeg',
        body,
      });
      await t.http.post(`/v1/owner/listings/${listing.id}/photos`).set(O()).send({ documentId }).expect(201);
    }
    const saved = await t.http
      .put(`/v1/owner/listings/${listing.id}/availability`)
      .set(O())
      .send({ weekly: EVERY_DAY, exceptions: [], slotMinutes: 30 })
      .expect(200);
    expect(saved.body.availability.weekly).toContainEqual({
      weekday: 0,
      from: '00:00',
      to: '23:30',
      mode: 'self',
    });
    const submitted = await t.http
      .post(`/v1/owner/listings/${listing.id}/actions/submit`)
      .set(O())
      .expect(200);
    if (submitted.body.state === 'pending_review') {
      const admin = await adminToken(t);
      await t.http
        .post(`/v1/admin/listings/${listing.id}/actions/approve`)
        .set(bearer(admin))
        .set(idem())
        .expect(200);
    }
    return listing;
  }

  async function slots(slug: string): Promise<{ selfViewing: boolean; slots: Slot[] }> {
    const res = await t.http.get(`/v1/public/listings/${slug}/viewing-slots?days=3`).expect(200);
    return res.body as { selfViewing: boolean; slots: Slot[] };
  }

  async function enable(on: boolean) {
    await q(
      `INSERT INTO platform.tenant_setting_version (tenant_id, setting_id, value, effective_from, reason)
       SELECT $1, id, $2::jsonb, now(), 'G7 test' FROM platform.setting WHERE key = 'viewing.self.enabled'`,
      [DEV.tenantId, JSON.stringify(on)],
    );
    t.app.get(SettingsService).invalidate('viewing.self.enabled');
  }

  function book(token: string, slug: string, startsAt: string, extra: Record<string, unknown> = {}) {
    return t.http
      .post(`/v1/prospect/listings/${slug}/viewings`)
      .set(bearer(token))
      .send({ startsAt, consent: true, mode: 'self', visitorTermsVersion: 1, ...extra });
  }

  /** Moving the clock forward expires access tokens (10–15 min): sign everyone in again. */
  async function at(when: Date) {
    // each operator sign-in advances the clock 61 s (OTP resend window): start early, end at `when`
    t.clock.set(new Date(when.getTime() - 2 * 61_000));
    owner = await ownerToken(t);
    other.token = await operatorToken(t, OTHER_PHONE);
    somsri = await prospect(SOMSRI, 'สมศรี ใจดี');
    lek = await prospect(LEK, 'เล็ก ใจกว้าง');
  }

  const viewingsOf = (body: { viewings: Viewing[] }) => body.viewings;
  const views = async (token: string, slug: string) => {
    const list = await t.http.get('/v1/prospect/enquiries').set(bearer(token)).expect(200);
    const lead = (list.body as { listing: { slug: string }; viewings: Viewing[] }[]).find(
      (l) => l.listing.slug === slug,
    )!;
    return viewingsOf(lead);
  };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_g7' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20', EKYC_MODE: 'fake' });
    owner = await ownerToken(t);
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-g7',
      phone: OTHER_PHONE,
      type: 'apartment',
    });
    const vacant = await q<{ id: string; unit_no: string }>(
      `SELECT u.id, u.unit_no FROM core.unit u
        WHERE u.building_id = $1 AND u.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM core.occupancy o WHERE o.unit_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM ops.lease l WHERE l.unit_id = u.id)
        ORDER BY u.unit_no LIMIT 3`,
      [DEV.buildingId],
    );
    expect(vacant).toHaveLength(3);
    ids.unitA = vacant[0]!.id;
    ids.unitB = vacant[1]!.id;
    ids.unitNoLock = vacant[2]!.id;
    ids.a101 = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    ids.door = (
      await register({
        scope: 'building_door',
        buildingId: DEV.buildingId,
        vendor: 'ttlock',
        vendorLockId: 'g7-door',
        serial: 'G7-DOOR',
        name: 'ประตูหน้าอาคาร',
      })
    ).id;
    ids.lockA = (
      await register({
        scope: 'unit',
        unitId: ids.unitA,
        vendor: 'ttlock',
        vendorLockId: 'g7-a',
        serial: 'G7-A',
        name: 'ประตูห้อง A',
      })
    ).id;
    ids.lockB = (
      await register({
        scope: 'unit',
        unitId: ids.unitB,
        vendor: 'ttlock',
        vendorLockId: 'g7-b',
        serial: 'G7-B',
        name: 'ประตูห้อง B',
      })
    ).id;
    // the leased A-101 gets a lock too: its residents' codes must never change because of viewings (D-071)
    ids.lock101 = (
      await register({
        scope: 'unit',
        unitId: ids.a101,
        vendor: 'ttlock',
        vendorLockId: 'g7-101',
        serial: 'G7-101',
        name: 'ประตูห้อง A-101',
      })
    ).id;
    await settle();
    // the facts a listing needs (D-252): size, rooms, the building address
    await q(
      `UPDATE core.building SET address = '{"line1": "ถนนพหลโยธิน", "district": "พญาไท", "province": "กรุงเทพมหานคร", "postcode": "10400"}'::jsonb
        WHERE id = $1`,
      [DEV.buildingId],
    );
    for (const unitId of [ids.unitA, ids.unitB, ids.unitNoLock]) {
      await q(`UPDATE core.unit SET area_sqm = 24.50 WHERE id = $1`, [unitId]);
      await q(
        `INSERT INTO ops.unit_detail (unit_id, tenant_id, building_id, bedrooms, bathrooms)
         VALUES ($1, $2, $3, 1, 1)
         ON CONFLICT (unit_id) DO UPDATE SET bedrooms = 1, bathrooms = 1`,
        [unitId, DEV.tenantId, DEV.buildingId],
      );
    }
    listings.a = await publishListing(ids.unitA, 'ห้องสตูดิโอ ดูเองได้');
    listings.b = await publishListing(ids.unitB, 'ห้องสตูดิโอ ชั้น 2');
    listings.noLock = await publishListing(ids.unitNoLock, 'ห้องไม่มีกุญแจดิจิทัล');
    somsri = await prospect(SOMSRI, 'สมศรี ใจดี');
    lek = await prospect(LEK, 'เล็ก ใจกว้าง');
  }, 300_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('offers no self-viewing while the setting is off (O-024)', async () => {
    const free = await slots(listings.a!.slug);
    expect(free.selfViewing).toBe(false);
    expect(free.slots.every((s) => s.mode === 'accompanied')).toBe(true);
    const start = free.slots[0]!.startsAt;
    const refused = await book(somsri, listings.a!.slug, start).expect(409);
    expect(refused.body).toMatchObject({ code: 'viewing.self_unavailable', selfViewingReason: 'disabled' });
    const off = await t.http.get('/v1/prospect/me/self-viewing').set(bearer(somsri)).expect(200);
    expect(off.body).toMatchObject({ enabled: false, identityVerified: false, phoneVerified: false });
    expect(off.body.missing).toEqual(['identity', 'phone', 'terms']);
    expect(off.body.visitorTerms.version).toBe(1);
  });

  it('refuses an unverified prospect, a unit without a lock and outdated terms', async () => {
    await enable(true);
    const free = await slots(listings.a!.slug);
    expect(free.selfViewing).toBe(true);
    const self = free.slots.filter((s) => s.mode === 'self');
    expect(self.length).toBeGreaterThan(4);
    expect((await slots(listings.noLock!.slug)).selfViewing).toBe(false);
    const noLock = await book(somsri, listings.noLock!.slug, self[1]!.startsAt).expect(409);
    expect(noLock.body).toMatchObject({ code: 'viewing.self_unavailable', selfViewingReason: 'no_lock' });

    const unverified = await book(somsri, listings.a!.slug, self[1]!.startsAt).expect(422);
    expect(unverified.body).toMatchObject({
      code: 'viewing.requirements_missing',
      missingRequirements: ['identity', 'phone'],
    });
    const noTerms = await book(somsri, listings.a!.slug, self[1]!.startsAt, {
      visitorTermsVersion: null,
    }).expect(422);
    expect(noTerms.body.missingRequirements).toEqual(['identity', 'phone', 'terms']);

    // e-KYC (fake provider) + phone verification
    const started = await t.http
      .post('/v1/prospect/me/identity-verification')
      .set(bearer(somsri))
      .send({})
      .expect(200);
    const session = (started.body.latest.verificationUrl as string).split(
      '/webhooks/ekyc/fake/sessions/',
    )[1]!;
    await t.http.post(`/webhooks/ekyc/fake/sessions/${session}/approve`).expect(200);
    const phone = '+66810009771';
    const challenge = await t.http
      .post('/v1/prospect/me/phone/otp')
      .set(bearer(somsri))
      .send({ phone })
      .expect(200);
    await t.http
      .post('/v1/prospect/me/phone')
      .set(bearer(somsri))
      .send({ challengeId: challenge.body.challengeId, code: '000000' })
      .expect(401);
    const verified = await t.http
      .post('/v1/prospect/me/phone')
      .set(bearer(somsri))
      .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo(phone) })
      .expect(200);
    expect(verified.body).toMatchObject({ phoneVerified: true });
    expect(verified.body.phoneMasked).not.toBe(phone);
    // another account cannot take the same phone
    t.clock.advance(61_000);
    const taken = await t.http.post('/v1/prospect/me/phone/otp').set(bearer(lek)).send({ phone }).expect(200);
    const clash = await t.http
      .post('/v1/prospect/me/phone')
      .set(bearer(lek))
      .send({ challengeId: taken.body.challengeId, code: t.sms.lastCodeTo(phone) })
      .expect(409);
    expect(clash.body.code).toBe('auth.identity_in_use');

    const status = await t.http.get('/v1/prospect/me/self-viewing').set(bearer(somsri)).expect(200);
    expect(status.body).toMatchObject({ identityVerified: true, phoneVerified: true, missing: ['terms'] });
    // the clock moved (OTP resend windows): take a slot that is still bookable
    const fresh = (await slots(listings.a!.slug)).slots.filter((x) => x.mode === 'self')[1]!;
    const outdated = await book(somsri, listings.a!.slug, fresh.startsAt, {
      visitorTermsVersion: 2,
    }).expect(422);
    expect(outdated.body).toMatchObject({ code: 'viewing.terms_outdated', visitorTermsVersion: 1 });
  });

  it('books a self viewing; the owner confirms; one code on the unit lock and the building door', async () => {
    const self = (await slots(listings.a!.slug)).slots.filter((s) => s.mode === 'self');
    const booked = await book(somsri, listings.a!.slug, self[1]!.startsAt).expect(201);
    firstViewing = viewingsOf(booked.body)[0]!;
    expect(firstViewing).toMatchObject({ mode: 'self', state: 'requested', access: null });
    // a second self viewing of mine that overlaps the code window is refused
    const overlap = await book(somsri, listings.b!.slug, self[1]!.startsAt).expect(409);
    expect(overlap.body.code).toBe('viewing.access_overlap');
    // one an hour later is fine
    const later = self.find(
      (s) => new Date(s.startsAt).getTime() === new Date(self[1]!.startsAt).getTime() + 60 * MINUTE,
    )!;
    const second = await book(somsri, listings.b!.slug, later.startsAt).expect(201);
    secondViewing = viewingsOf(second.body)[0]!;

    // another tenant's owner cannot confirm it (404)
    await t.http
      .post(`/v1/owner/listing-viewings/${firstViewing.id}/actions/confirm`)
      .set(bearer(other.token))
      .expect(404);
    const confirmed = await t.http
      .post(`/v1/owner/listing-viewings/${firstViewing.id}/actions/confirm`)
      .set(O())
      .expect(200);
    const v = (confirmed.body.viewings as Viewing[]).find((x) => x.id === firstViewing.id)!;
    expect(v.access).toMatchObject({ state: 'issued', enteredSource: null });
    expect(new Date(v.access!.validFrom).getTime()).toBe(
      new Date(firstViewing.startsAt).getTime() - 5 * MINUTE,
    );
    expect(new Date(v.access!.validTo).getTime()).toBe(
      new Date(firstViewing.startsAt).getTime() + 30 * MINUTE,
    );
    await t.http.post(`/v1/owner/listing-viewings/${secondViewing.id}/actions/confirm`).set(O()).expect(200);
    await settle();
    const creds = await q<{ holder_kind: string; status: string; lock_id: string; valid_to: Date }>(
      `SELECT holder_kind::text, status::text, lock_id, valid_to FROM smart.access_credential WHERE viewing_id = $1 ORDER BY lock_id`,
      [firstViewing.id],
    );
    expect(creds).toHaveLength(2);
    expect(new Set(creds.map((c) => c.lock_id))).toEqual(new Set([ids.lockA, ids.door]));
    expect(creds.every((c) => c.holder_kind === 'visitor' && c.status === 'active')).toBe(true);
    // the vendor holds the same PIN on both locks; nothing opens before the window
    const atVendor = [...vendor().credentials.values()].filter(
      (c) =>
        (c.lockId === 'g7-a' || c.lockId === 'g7-door') &&
        c.validFrom.getTime() === new Date(v.access!.validFrom).getTime(),
    );
    expect(atVendor).toHaveLength(2);
    expect(new Set(atVendor.map((c) => c.pin)).size).toBe(1);
    expect(vendor().active('g7-a', t.clock.now())).toEqual([]);
    // the owner calendar shows the mode and the window, never a code
    const calendar = await t.http.get('/v1/owner/listing-viewings').set(O()).expect(200);
    const row = (calendar.body as Viewing[]).find((x) => x.id === firstViewing.id)!;
    expect(row).toMatchObject({ mode: 'self', access: { state: 'issued' } });
    expect(JSON.stringify(calendar.body)).not.toContain(atVendor[0]!.pin);
  });

  it('shows the code only inside the window, only to the booked prospect', async () => {
    const early = await t.http
      .get(`/v1/prospect/viewings/${firstViewing.id}/access-code`)
      .set(bearer(somsri))
      .expect(409);
    expect(early.body.code).toBe('viewing.code_not_available');
    expect(early.body.codeValidFrom).toBeDefined();
    await t.http.get(`/v1/prospect/viewings/${firstViewing.id}/access-code`).set(bearer(lek)).expect(404);

    await at(new Date(new Date(firstViewing.startsAt).getTime() - 2 * MINUTE));
    const res = await t.http
      .get(`/v1/prospect/viewings/${firstViewing.id}/access-code`)
      .set(bearer(somsri))
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    doorCode = res.body.doorCode as string;
    expect(doorCode).toMatch(/^\d{6}$/);
    expect(res.body.locks).toHaveLength(2);
    // the code never reaches events, audit metadata or the outbox
    const leaks = await q<{ n: number }>(
      `SELECT (SELECT count(*) FROM platform.domain_event WHERE payload::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM platform.audit_log WHERE coalesce(metadata::text, '') || coalesce(after::text, '') LIKE '%' || $1 || '%')
              AS n`,
      [doorCode],
    );
    expect(Number(leaks[0]!.n)).toBe(0);
    const reveals = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'access.credential_revealed' AND metadata->>'purpose' = 'self_viewing'`,
    );
    expect(reveals[0]!.n).toBe(1);
  });

  it('the lock log records the entry and alerts owner and staff; arrive is idempotent', async () => {
    const event = vendor().enterPin('g7-a', doorCode, t.clock.now());
    expect(event.result).toBe('success');
    await t.app.get(LocksService).syncLog(ids.lockA!);
    await settle();
    const after = (await views(somsri, listings.a!.slug)).find((x) => x.id === firstViewing.id)!;
    expect(after.access).toMatchObject({ state: 'entered', enteredSource: 'lock_log' });
    const alerts = await q<{ recipient_type: string }>(
      `SELECT n.recipient_type::text FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'listing.self_viewing_entered' AND e.tenant_id = $1`,
      [DEV.tenantId],
    );
    expect(alerts.length).toBeGreaterThan(0);
    const key = idem();
    const arrived = await t.http
      .post(`/v1/prospect/viewings/${firstViewing.id}/actions/arrive`)
      .set(bearer(somsri))
      .set(key)
      .expect(200);
    expect(arrived.body).toMatchObject({ state: 'entered', enteredSource: 'lock_log' });
    const replay = await t.http
      .post(`/v1/prospect/viewings/${firstViewing.id}/actions/arrive`)
      .set(bearer(somsri))
      .set(key)
      .expect(200);
    expect(replay.body).toEqual(arrived.body);
    await t.http
      .post(`/v1/prospect/viewings/${firstViewing.id}/actions/arrive`)
      .set(bearer(lek))
      .set(idem())
      .expect(404);
    await t.http
      .post(`/v1/prospect/viewings/${firstViewing.id}/actions/arrive`)
      .set(bearer(somsri))
      .expect(400);
  });

  it('a second code waits while I am still inside another unit', async () => {
    await at(new Date(new Date(secondViewing.startsAt).getTime() - 2 * MINUTE));
    const blocked = await t.http
      .get(`/v1/prospect/viewings/${secondViewing.id}/access-code`)
      .set(bearer(somsri))
      .expect(409);
    expect(blocked.body.code).toBe('viewing.access_open_elsewhere');
  });

  it('an incident opens a work order once; leaving revokes the codes and completes the viewing', async () => {
    const reported = await t.http
      .post(`/v1/prospect/viewings/${firstViewing.id}/actions/report-incident`)
      .set(bearer(somsri))
      .set(idem())
      .send({ note: 'ก๊อกน้ำในห้องน้ำรั่ว น้ำนองพื้น' })
      .expect(200);
    expect(reported.body.workOrderId).toBeDefined();
    const wo = await q<{ unit_id: string; priority: string; kind: string }>(
      `SELECT unit_id, priority::text, kind::text FROM ops.work_order WHERE id = $1`,
      [reported.body.workOrderId],
    );
    expect(wo[0]).toEqual({ unit_id: ids.unitA, priority: 'high', kind: 'inspection' });
    const again = await t.http
      .post(`/v1/prospect/viewings/${firstViewing.id}/actions/report-incident`)
      .set(bearer(somsri))
      .set(idem())
      .send({ note: 'อีกครั้ง' })
      .expect(409);
    expect(again.body.code).toBe('viewing.access_invalid_state');

    const left = await t.http
      .post(`/v1/prospect/viewings/${firstViewing.id}/actions/leave`)
      .set(bearer(somsri))
      .set(idem())
      .expect(200);
    expect(left.body).toMatchObject({ state: 'exited', closeReason: 'left' });
    await settle();
    const creds = await q<{ status: string }>(
      `SELECT status::text FROM smart.access_credential WHERE viewing_id = $1`,
      [firstViewing.id],
    );
    expect(creds.map((c) => c.status)).toEqual(['revoked', 'revoked']);
    expect(vendor().active('g7-a', t.clock.now())).toEqual([]);
    const done = (await views(somsri, listings.a!.slug)).find((x) => x.id === firstViewing.id)!;
    expect(done.state).toBe('completed');
    await t.http.get(`/v1/prospect/viewings/${firstViewing.id}/access-code`).set(bearer(somsri)).expect(409);

    // the next code is available now; the owner can end it early
    const next = await t.http
      .get(`/v1/prospect/viewings/${secondViewing.id}/access-code`)
      .set(bearer(somsri))
      .expect(200);
    expect(next.body.doorCode).toMatch(/^\d{6}$/);
    await t.http
      .post(`/v1/owner/listing-viewings/${secondViewing.id}/actions/end-access`)
      .set(bearer(other.token))
      .set(idem())
      .send({ reason: 'ทดสอบข้ามผู้เช่า' })
      .expect(404);
    const ended = await t.http
      .post(`/v1/owner/listing-viewings/${secondViewing.id}/actions/end-access`)
      .set(O())
      .set(idem())
      .send({ reason: 'ผู้เข้าชมโทรแจ้งว่ายกเลิก' })
      .expect(200);
    expect(ended.body).toMatchObject({ state: 'cancelled' });
    await t.http.get(`/v1/prospect/viewings/${secondViewing.id}/access-code`).set(bearer(somsri)).expect(409);
  });

  it('the owner reads the entry log (audited); other tenants get a 404', async () => {
    const log = await t.http
      .get(`/v1/owner/listing-viewings/${firstViewing.id}/access-log`)
      .set(O())
      .expect(200);
    expect(log.body.access).toMatchObject({ state: 'exited', enteredSource: 'lock_log' });
    expect(log.body.access.workOrderId).toBeDefined();
    expect(log.body.credentials).toHaveLength(2);
    expect(log.body.events).toEqual([
      expect.objectContaining({ lockName: 'ประตูห้อง A', result: 'success', source: 'pin' }),
    ]);
    expect(JSON.stringify(log.body)).not.toContain(doorCode);
    await t.http
      .get(`/v1/owner/listing-viewings/${firstViewing.id}/access-log`)
      .set(bearer(other.token))
      .expect(404);
    const audited = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'listing.self_viewing_log_read'`,
    );
    expect(audited[0]!.n).toBe(1);
  });

  it('a missed window becomes a no show', async () => {
    const self = (await slots(listings.a!.slug)).slots.filter((s) => s.mode === 'self');
    const booked = await book(somsri, listings.a!.slug, self[1]!.startsAt).expect(201);
    const viewing = viewingsOf(booked.body).find((x) => x.state === 'requested')!;
    await t.http.post(`/v1/owner/listing-viewings/${viewing.id}/actions/confirm`).set(O()).expect(200);
    await at(new Date(new Date(viewing.startsAt).getTime() + 31 * MINUTE));
    const swept = await t.app.get(SelfViewingService).sweep();
    expect(swept.noShows).toBe(1);
    const after = (await views(somsri, listings.a!.slug)).find((x) => x.id === viewing.id)!;
    expect(after).toMatchObject({ state: 'no_show', access: { state: 'no_show' } });
  });

  it('never for an occupied unit; resident codes untouched (D-071)', async () => {
    const residentsBefore = await q<{ id: string; status: string }>(
      `SELECT id, status::text FROM smart.access_credential WHERE holder_kind = 'resident' ORDER BY id`,
    );
    expect(residentsBefore.length).toBeGreaterThan(0);
    // the earlier B viewing (its codes ended by the owner) is recorded as a no show; then a new one
    await t.http
      .post(`/v1/owner/listing-viewings/${secondViewing.id}/actions/complete`)
      .set(O())
      .send({ outcome: 'no_show' })
      .expect(200);
    // somsri books a self viewing of B and the owner confirms it
    const self = (await slots(listings.b!.slug)).slots.filter((s) => s.mode === 'self');
    const booked = await book(somsri, listings.b!.slug, self[1]!.startsAt).expect(201);
    const viewing = viewingsOf(booked.body).find((x) => x.state === 'requested')!;
    await t.http.post(`/v1/owner/listing-viewings/${viewing.id}/actions/confirm`).set(O()).expect(200);
    // then someone moves in
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from)
       VALUES ($1, $2, $3, $4, 'tenant', (now() AT TIME ZONE 'Asia/Bangkok')::date)`,
      [DEV.tenantId, DEV.buildingId, ids.unitB, DEV.residentPartyId],
    );
    await at(new Date(new Date(viewing.startsAt).getTime() - MINUTE));
    const refused = await t.http
      .get(`/v1/prospect/viewings/${viewing.id}/access-code`)
      .set(bearer(somsri))
      .expect(409);
    expect(refused.body.code).toBe('viewing.unit_occupied');
    expect((await slots(listings.b!.slug)).selfViewing).toBe(false);
    // the database itself refuses a viewing credential for the occupied unit
    await expect(
      q(
        `INSERT INTO smart.access_credential (tenant_id, building_id, unit_id, lock_id, device_id, holder_kind, holder_name,
                                              type, vendor, valid_from, valid_to, viewing_id)
         SELECT tenant_id, building_id, unit_id, id, device_id, 'visitor', 'x', 'pin', vendor, now(), now() + interval '1 hour', $2
           FROM smart.lock WHERE id = $1`,
        [ids.lockB, viewing.id],
      ),
    ).rejects.toThrow(/access.unit_occupied/);
    const residentsAfter = await q<{ id: string; status: string }>(
      `SELECT id, status::text FROM smart.access_credential WHERE holder_kind = 'resident' ORDER BY id`,
    );
    expect(residentsAfter).toEqual(residentsBefore);
  });
});

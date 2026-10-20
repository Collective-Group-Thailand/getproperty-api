import 'reflect-metadata';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

/** The seeded lessee of A-101 (DEV lease) has this phone on file — typed by the office, never verified. */
const RESIDENT_PHONE = '+660000000011';

/**
 * Review #6 (D-226; D-061, D-070, D-209, D-211): whoever proves an SMS code for a phone an operator typed on a party is
 * not that party. The match becomes a link request the Owner confirms; until then nothing of the party — leases,
 * invoices, the landlord's bank account, door codes — is reachable. Door codes are revealed only through a confirmed
 * link, also for a phone match left over from before the release.
 */
describe('phone-matched logins wait for the owner (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const signIn = async (phone: string) => {
    t.clock.advance(61_000); // one SMS per phone per minute
    const challenge = await t.http.post('/v1/auth/resident/otp/request').send({ phone }).expect(200);
    const signed = await t.http
      .post('/v1/auth/resident/otp/verify')
      .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo(phone) })
      .expect(200);
    return signed.body as {
      accessToken: string;
      refreshToken: string;
      subject: { id: string; scopes: string[] };
    };
  };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_links' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    const unit = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    // a door lock on the leased unit: the lessee gets a live keypad code (D-211)
    await t.http
      .post('/v1/owner/locks')
      .set(O())
      .send({
        scope: 'unit',
        unitId: unit,
        vendor: 'ttlock',
        vendorLockId: 'links-a101',
        serial: 'TTL-LINKS-A101',
        name: 'ประตูห้อง A-101',
      })
      .expect(201);
    await settle();
    const live = await q(
      `SELECT 1 FROM smart.access_credential WHERE holder_party_id = $1 AND status = 'active'`,
      [DEV.residentPartyId],
    );
    expect(live).toHaveLength(1);
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('an SMS sign-in on the typed phone sees nothing of the party; the owner gets a link request', async () => {
    const stranger = await signIn(RESIDENT_PHONE);
    ids.user = stranger.subject.id;
    expect(stranger.subject.scopes).toEqual([]);
    const S = bearer(stranger.accessToken);
    expect((await t.http.get('/v1/resident/access/credentials').set(S).expect(200)).body.data).toEqual([]);
    expect((await t.http.get('/v1/resident/invoices').set(S).expect(200)).body.data).toEqual([]);
    const me = await t.http.get('/v1/resident/me').set(S).expect(200);
    expect(me.body).toMatchObject({ units: [], leaseIds: [], linkRequestsPending: 1 });
    expect(
      await q(`SELECT 1 FROM core.party_user_link WHERE user_id = $1 AND state = 'active'`, [ids.user]),
    ).toEqual([]);

    const pending = await t.http.get('/v1/owner/party-link-requests?state=pending').set(O()).expect(200);
    expect(pending.body.data).toEqual([
      expect.objectContaining({
        partyId: DEV.residentPartyId,
        userId: ids.user,
        via: 'phone_match',
        state: 'pending',
      }),
    ]);
    ids.request = pending.body.data[0].id as string;
    // signing in again does not pile up requests
    await signIn(RESIDENT_PHONE);
    expect(
      (await t.http.get('/v1/owner/party-link-requests?state=pending').set(O()).expect(200)).body.data,
    ).toHaveLength(1);
    await settle();
    const told = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'party.link_requested'`,
    );
    expect(told[0]!.n).toBeGreaterThan(0);
  });

  it('staff cannot decide; the owner rejects a stranger — still nothing reachable', async () => {
    owner = await ownerToken(t);
    const staff = bearer(await operatorToken(t, '+660000000003'));
    await t.http
      .post(`/v1/owner/party-link-requests/${ids.request}/actions/confirm`)
      .set(staff)
      .set(idem())
      .expect(403);
    const reject = await t.http
      .post(`/v1/owner/party-link-requests/${ids.request}/actions/reject`)
      .set(O())
      .set(idem())
      .send({ reason: 'ไม่ใช่ผู้เช่า เบอร์โทรพิมพ์ผิด' })
      .expect(200);
    expect(reject.body).toMatchObject({ state: 'rejected', linkId: null });
    await t.http
      .post(`/v1/owner/party-link-requests/${ids.request}/actions/confirm`)
      .set(O())
      .set(idem())
      .expect(409);
    const again = await signIn(RESIDENT_PHONE);
    expect(again.subject.scopes).toEqual([]);
  });

  it('a door code is never revealed through a phone match left from before the release', async () => {
    await q(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via) VALUES ($1, $2, $3, 'phone_match')`,
      [DEV.tenantId, DEV.residentPartyId, ids.user],
    );
    const legacy = await signIn(RESIDENT_PHONE);
    expect(
      (await t.http.get('/v1/resident/access/credentials').set(bearer(legacy.accessToken)).expect(200)).body
        .data,
    ).toEqual([]);
    await q(`UPDATE core.party_user_link SET state = 'unlinked', unlinked_at = now() WHERE user_id = $1`, [
      ids.user,
    ]);
  });

  it('once the owner confirms, the login is linked (admin) and sees the party, door code included', async () => {
    const signed = await signIn(RESIDENT_PHONE);
    const pending = await t.http.get('/v1/owner/party-link-requests?state=pending').set(O()).expect(200);
    const request = (pending.body.data as { id: string; userId: string }[]).find(
      (r) => r.userId === signed.subject.id,
    )!;
    const confirmed = await t.http
      .post(`/v1/owner/party-link-requests/${request.id}/actions/confirm`)
      .set(O())
      .set(idem())
      .expect(200);
    expect(confirmed.body).toMatchObject({ state: 'confirmed', linkId: expect.any(String) });
    const link = await q<{ linked_via: string }>(
      `SELECT linked_via::text FROM core.party_user_link WHERE id = $1 AND state = 'active'`,
      [confirmed.body.linkId],
    );
    expect(link).toEqual([{ linked_via: 'admin' }]);
    const refreshed = await t.http
      .post('/v1/auth/refresh')
      .send({ refreshToken: signed.refreshToken })
      .expect(200);
    expect(refreshed.body.subject.scopes).toEqual(
      expect.arrayContaining([`lease:${DEV.leaseId}`, expect.stringMatching(/^unit:/)]),
    );
    const R = bearer(refreshed.body.accessToken as string);
    const codes = await t.http.get('/v1/resident/access/credentials').set(R).expect(200);
    expect(codes.body.data).toHaveLength(1);
    expect(codes.body.data[0].pin).toMatch(/^\d{6}$/);
    expect((await t.http.get('/v1/resident/me').set(R).expect(200)).body.linkRequestsPending).toBe(0);
  });

  it('another tenant cannot see or decide my link requests', async () => {
    const res = await t.http.get('/v1/owner/party-link-requests').set(O()).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const counts = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.party_link_request WHERE tenant_id <> $1`,
      [DEV.tenantId],
    );
    expect(counts[0]!.n).toBe(0);
    const other = bearer(await ownerTokenOfOther());
    await t.http
      .post(`/v1/owner/party-link-requests/${ids.request}/actions/confirm`)
      .set(other)
      .set(idem())
      .expect(404);
  });

  async function ownerTokenOfOther(): Promise<string> {
    return (await onboardTenant(t, await adminToken(t), { slug: 'other-links', phone: '+660000000302' }))
      .token;
  }
});

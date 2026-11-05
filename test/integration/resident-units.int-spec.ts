import 'reflect-metadata';

import { fakeLineIdToken } from '@collective/integrations/line';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, otpSignIn, ownerToken } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PHONE_CO_OWNER = '+660000000211';
const PHONE_CO_OWNER_B = '+660000000212';
const PHONE_FAMILY = '+660000000213';
const PHONE_FORMER = '+660000000214';
const PHONE_LESSEE = '+660000000215';
const PHONE_TENANT_B = '+660000000216';

interface MeUnit {
  unitId: string;
  unitNo: string;
  tenantId: string;
  roles: { role: string; source: string; partyId: string; leaseId: string | null }[];
  capabilities: string[];
}

/**
 * JR (D-309 = D-J08, D-322): residents relate to units through ownership and occupancy; a lease is optional. A co-owner
 * who does not live in the unit is invited by the register keeper and redeems the code with an OTP to the phone of the
 * ownership party; they see the unit's notices and parcels and the invoices billed to them only. One login holds units
 * in several tenants; a family occupant sees no invoice unless billed; a former owner loses the unit on the ownership's
 * end date; every new endpoint answers 404 across tenants.
 */
describe('resident identity by unit (JR, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let tenantB: { tenantId: string; token: string };
  const ids: Record<string, string> = {};
  let coOwner = { access: '', refresh: '' };

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const unitOf = async (unitNo: string) =>
    (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = $2`, [
        DEV.buildingId,
        unitNo,
      ])
    )[0]!.id;
  const party = async (token: string, displayName: string, phone: string, tenantId?: string) => {
    const res = await t.http
      .post('/v1/owner/parties')
      .set({ ...bearer(token), ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}) })
      .send({ type: 'person', displayName, phone })
      .expect(201);
    return (res.body.id ?? res.body.party?.id) as string;
  };
  /** The register: `partyId` owns the unit from `from` (the previous owner's row closes there). */
  const own = async (unitId: string, partyId: string, from: string, to: string | null = null) => {
    await q(`DELETE FROM core.unit_ownership WHERE unit_id = $1 AND valid_from >= $2`, [unitId, from]);
    await q(`UPDATE core.unit_ownership SET valid_to = $2 WHERE unit_id = $1 AND valid_to IS NULL`, [
      unitId,
      from,
    ]);
    await q(
      `INSERT INTO core.unit_ownership (tenant_id, building_id, unit_id, party_id, share_pct, valid_from, valid_to, source)
       SELECT u.tenant_id, u.building_id, u.id, $2, 100, $3, $4, 'manual' FROM core.unit u WHERE u.id = $1`,
      [unitId, partyId, from, to],
    );
  };
  let invoiceNo = 0;
  const invoice = async (input: {
    tenantId: string;
    unitId: string;
    billedPartyId: string;
    kind: 'common_fee' | 'rent';
    amount: string;
  }) => {
    invoiceNo += 1;
    const unit = (
      await q<{ building_id: string }>('SELECT building_id FROM core.unit WHERE id = $1', [input.unitId])
    )[0]!;
    const id = (
      await q<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, period_start, period_end, subtotal, total, balance)
         VALUES ($1, $2, $3, $4, '2026-11-01', '2026-11-30', $5, $5, $5) RETURNING id`,
        [input.tenantId, unit.building_id, input.unitId, input.billedPartyId, input.amount],
      )
    )[0]!.id;
    await q(
      `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit,
                                     unit_price, amount, period_from, period_to)
       VALUES ($1, $2, 1, $3::text::ops.invoice_line_source_type, $3::text::ops.invoice_line_kind, $4, 1, 'month', $5, $5, '2026-11-01', '2026-11-30')`,
      [input.tenantId, id, input.kind, input.kind === 'rent' ? 'ค่าเช่า' : 'ค่าส่วนกลาง', input.amount],
    );
    await q(
      `UPDATE ops.invoice SET status = 'issued', number = $2, snapshot = '{}'::jsonb, issued_at = '2026-11-01T09:00:00+07:00',
              due_date = '2026-11-15' WHERE id = $1`,
      [id, `INV-2026-${String(90000 + invoiceNo)}`],
    );
    return id;
  };
  const residentLogin = async (sub: string) => {
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub, name: `resident ${sub}` }) })
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
    return { access: login.body.accessToken as string, refresh: login.body.refreshToken as string };
  };
  const refresh = async (s: { access: string; refresh: string }) => {
    const r = await t.http.post('/v1/auth/refresh').send({ refreshToken: s.refresh }).expect(200);
    return {
      access: r.body.accessToken as string,
      refresh: r.body.refreshToken as string,
      scopes: r.body.subject.scopes as string[],
    };
  };
  const invite = (token: string, unitId: string, body: Record<string, unknown>, tenantId?: string) =>
    t.http
      .post(`/v1/owner/units/${unitId}/resident-invites`)
      .set({ ...bearer(token), ...idem(), ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}) })
      .send(body);
  /** Preview → OTP to the ownership party's phone → redeem. */
  const redeem = async (access: string, code: string, phone: string) => {
    const R = bearer(access);
    const otp = await t.http.post(`/v1/resident/unit-invitations/${code}/otp`).set(R).expect(201);
    return t.http
      .post(`/v1/resident/unit-invitations/${code}/accept`)
      .set(R)
      .send({ challengeId: otp.body.challengeId, code: t.sms.lastCodeTo(phone) });
  };
  const parcel = async (unitId: string) => {
    const photo = await uploadFile(t, db, owner, {
      kind: 'service_photo',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'parcel.jpg',
      mimeType: 'image/jpeg',
      body: JPEG,
    });
    return (
      await t.http
        .post('/v1/owner/parcels')
        .set(bearer(owner))
        .send({ unitId, carrier: 'Kerry Express', photoDocumentId: photo })
        .expect(201)
    ).body.id as string;
  };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_jr' });
    await backdateSeededVersions(db.admin); // the clock is pinned to 2026-11-10 on any real date
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set('2026-11-10T03:00:00Z');
    owner = await ownerToken(t);
    tenantB = await onboardTenant(t, await adminToken(t), { slug: 'jr-b', phone: PHONE_TENANT_B });
    for (const no of ['A-201', 'A-202', 'A-203', 'A-204', 'A-205']) ids[no] = await unitOf(no);
    ids.coOwner = await party(owner, 'สมชาย เจ้าของร่วม', PHONE_CO_OWNER);
    ids.family = await party(owner, 'สมหญิง ครอบครัว', PHONE_FAMILY);
    ids.former = await party(owner, 'สมศักดิ์ เจ้าของเดิม', PHONE_FORMER);
    ids.lessee = await party(owner, 'ผู้เช่า อื่น', PHONE_LESSEE);
    ids.noPhone = (
      await t.http
        .post('/v1/owner/parties')
        .set(bearer(owner))
        .send({ type: 'person', displayName: 'ไม่มีเบอร์' })
        .expect(201)
    ).body.id as string;
    // the register: A-201 to the co-owner (no lease, nobody lives there), A-202 to the former owner until 2026-11-20,
    // A-204 to the party without a phone
    await own(ids['A-201']!, ids.coOwner, '2026-10-01');
    await own(ids['A-202']!, ids.former, '2026-10-01', '2026-11-20');
    await own(ids['A-204']!, ids.noPhone, '2026-10-01');
    // tenant B: a property, building and unit; its owner's legal party owns the unit until the co-owner's party does
    const B = bearer(tenantB.token);
    const p = await t.http
      .post('/v1/owner/properties')
      .set(B)
      .send({ code: 'JRB', name: 'โครงการ B' })
      .expect(201);
    const b = await t.http
      .post('/v1/owner/buildings')
      .set(B)
      .send({ propertyId: p.body.id, code: 'B1', name: 'อาคาร B1', type: 'apartment', floorsCount: 1 })
      .expect(201);
    ids.unitB = (
      await t.http.post('/v1/owner/units').set(B).send({ buildingId: b.body.id, unitNo: 'B-101' }).expect(201)
    ).body.id as string;
    ids.coOwnerB = await party(tenantB.token, 'สมชาย เจ้าของร่วม (B)', PHONE_CO_OWNER_B);
    await own(ids.unitB, ids.coOwnerB, '2026-10-01');
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('owner invites a co-owner: single use, 14 days, OTP to the register phone; cross-tenant 404', async () => {
    // cross-tenant: tenant B never sees DEV's unit, DEV never sees B's
    expect((await invite(tenantB.token, ids['A-201']!, { channel: 'line_qr' })).status).toBe(404);
    await t.http
      .get(`/v1/owner/units/${ids['A-201']}/resident-invites`)
      .set(bearer(tenantB.token))
      .expect(404);
    expect((await invite(owner, ids.unitB!, { channel: 'line_qr' })).status).toBe(404);
    await t.http.get(`/v1/owner/units/${ids.unitB}/resident-invites`).set(bearer(owner)).expect(404);
    // the party must be a current co-owner with a phone
    const notOwner = await invite(owner, ids['A-201']!, { channel: 'line_qr', partyId: ids.family });
    expect(notOwner.status).toBe(422);
    expect(notOwner.body.errors[0]).toMatchObject({ path: 'partyId', code: 'notOwner' });
    const noPhone = await invite(owner, ids['A-204']!, { channel: 'line_qr' });
    expect(noPhone.status).toBe(422);
    expect(noPhone.body.code).toBe('invitation.phone_missing');
    // an Idempotency-Key is required
    await t.http
      .post(`/v1/owner/units/${ids['A-201']}/resident-invites`)
      .set(bearer(owner))
      .send({ channel: 'line_qr' })
      .expect(400);

    const first = await invite(owner, ids['A-201']!, { channel: 'line_qr' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      unitId: ids['A-201'],
      partyId: ids.coOwner,
      unitNo: 'A-201',
      state: 'pending',
      channel: 'line_qr',
    });
    expect(first.body.url).toContain('/link/unit?code=');
    expect(first.body.qrPayload).toBe(first.body.url);
    expect(first.body.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(Date.parse(first.body.expiresAt as string) - Date.parse(first.body.createdAt as string)).toBe(
      14 * 86_400_000,
    );
    // a new code (by SMS) revokes the pending one
    const smsBefore = t.sms.sent.length;
    const second = await invite(owner, ids['A-201']!, { channel: 'sms' });
    expect(second.status).toBe(201);
    expect(t.sms.sent.length).toBe(smsBefore + 1);
    expect(t.sms.sent.at(-1)).toMatchObject({ to: PHONE_CO_OWNER });
    const list = await t.http
      .get(`/v1/owner/units/${ids['A-201']}/resident-invites`)
      .set(bearer(owner))
      .expect(200);
    expect((list.body as { id: string; state: string }[]).map((i) => i.state)).toEqual([
      'pending',
      'revoked',
    ]);
    expect(JSON.stringify(list.body)).not.toContain(second.body.code as string);
    // audit + outbox, no code in either
    const events = await q<{ payload: unknown }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'unit.resident_invited' AND aggregate_id = $1`,
      [ids['A-201']],
    );
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(second.body.code as string);
    expect((await q(`SELECT 1 FROM platform.audit_log WHERE action = 'unit.resident_invited'`)).length).toBe(
      2,
    );

    coOwner = await residentLogin('U-jr-co-owner');
    const R = bearer(coOwner.access);
    await t.http.get(`/v1/resident/unit-invitations/${first.body.code}`).set(R).expect(409);
    await t.http.get('/v1/resident/unit-invitations/ABCD-EFGH-JKLM-NPQR').set(R).expect(404);
    const preview = await t.http.get(`/v1/resident/unit-invitations/${second.body.code}`).set(R).expect(200);
    expect(preview.body).toMatchObject({
      unitNo: 'A-201',
      partyDisplayName: expect.stringMatching(/^สม•+$/),
    });
    expect(preview.body).toHaveProperty('propertyKind');
    expect(preview.body).toHaveProperty('legalForm');
    expect(preview.body.phoneMasked).not.toContain('0000000211');
    // a lease invitation code path does not accept a unit code
    await t.http.get(`/v1/resident/invitations/${second.body.code}`).set(R).expect(404);
    // wrong OTP → 401 with attempts left; the code stays usable
    const otp = await t.http.post(`/v1/resident/unit-invitations/${second.body.code}/otp`).set(R).expect(201);
    expect(otp.body.phoneMasked).toBeDefined();
    const right = t.sms.lastCodeTo(PHONE_CO_OWNER)!;
    const wrong = right === '111111' ? '222222' : '111111';
    const bad = await t.http
      .post(`/v1/resident/unit-invitations/${second.body.code}/accept`)
      .set(R)
      .send({ challengeId: otp.body.challengeId, code: wrong });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('auth.otp_invalid');
    const ok = await t.http
      .post(`/v1/resident/unit-invitations/${second.body.code}/accept`)
      .set(R)
      .send({ challengeId: otp.body.challengeId, code: right })
      .expect(200);
    expect(ok.body).toMatchObject({
      tenantId: DEV.tenantId,
      unitId: ids['A-201'],
      partyId: ids.coOwner,
      refreshRequired: true,
      acceptedOn: '2026-11-10',
    });
    // single use
    await t.http.post(`/v1/resident/unit-invitations/${second.body.code}/otp`).set(R).expect(409);
    expect((await q(`SELECT 1 FROM platform.domain_event WHERE type = 'unit.resident_linked'`)).length).toBe(
      1,
    );

    // expiry: a code for the former owner, 15 days later, is no longer pending
    const late = await invite(owner, ids['A-202']!, { channel: 'link' });
    expect(late.status).toBe(201);
    ids.lateCode = late.body.code as string;
  });

  it('co-owner without a lease: the unit, its notices and parcels, own common-fee invoices only', async () => {
    // the old token does not carry the unit yet: /me/units says so
    const before = await t.http.get('/v1/resident/me/units').set(bearer(coOwner.access)).expect(200);
    expect(before.body.refreshRequired).toBe(true);
    const r = await refresh(coOwner);
    coOwner = r;
    expect(r.scopes).toEqual([`unit:${ids['A-201']}`]);
    const R = bearer(coOwner.access);
    const units = await t.http.get('/v1/resident/me/units').set(R).expect(200);
    expect(units.body.refreshRequired).toBe(false);
    expect(units.body.unitsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(units.body.units).toHaveLength(1);
    const unit = units.body.units[0] as MeUnit;
    expect(unit).toMatchObject({ unitId: ids['A-201'], unitNo: 'A-201', tenantId: DEV.tenantId });
    // CR #41 (J1.1b): the property kind and the building's legal form name the place in the app
    const place = (
      await q<{ kind: string | null; legal_form: string | null }>(
        `SELECT p.kind::text AS kind, b.legal_form::text AS legal_form FROM core.unit u
           JOIN core.building b ON b.id = u.building_id JOIN core.property p ON p.id = b.property_id WHERE u.id = $1`,
        [ids['A-201']],
      )
    )[0]!;
    expect(unit).toMatchObject({ propertyKind: place.kind, legalForm: place.legal_form });
    expect(unit.roles).toEqual([
      expect.objectContaining({ role: 'co_owner', source: 'ownership', partyId: ids.coOwner, leaseId: null }),
    ]);
    expect(unit.capabilities).toEqual([
      'notices',
      'parcels',
      'facilities',
      'rules',
      'contacts',
      'service_requests',
      'invoices',
    ]);
    const me = await t.http.get('/v1/resident/me').set(R).expect(200);
    expect(me.body.units).toEqual([]); // occupancies only (unchanged shape)
    expect(me.body.unitRoles).toEqual([
      expect.objectContaining({
        unitId: ids['A-201'],
        role: 'co_owner',
        source: 'ownership',
        tenantId: DEV.tenantId,
      }),
    ]);
    expect(me.body.entitlements).toContain('bills');
    expect(me.body.entitlements).not.toContain('lease');
    expect(me.body.entitlements).not.toContain('access');

    // notices of the building and parcels of the unit (vacant: from the ownership start)
    const ann = await t.http
      .post('/v1/owner/announcements')
      .set(bearer(owner))
      .send({
        buildingId: DEV.buildingId,
        title: 'ประชุมใหญ่เจ้าของร่วม',
        bodyTh: 'วันเสาร์ 10:00',
        publish: true,
      })
      .expect(201);
    const notices = await t.http.get('/v1/resident/announcements').set(R).expect(200);
    expect((notices.body.data as { id: string }[]).map((a) => a.id)).toContain(ann.body.id);
    ids.parcelA201 = await parcel(ids['A-201']!);
    const parcels = await t.http.get('/v1/resident/parcels').set(R).expect(200);
    expect((parcels.body.data as { id: string }[]).map((p) => p.id)).toEqual([ids.parcelA201]);

    // invoices: the common fee billed to me, never the rent billed to someone else on the same unit
    ids.feeA201 = await invoice({
      tenantId: DEV.tenantId,
      unitId: ids['A-201']!,
      billedPartyId: ids.coOwner!,
      kind: 'common_fee',
      amount: '1250.00',
    });
    ids.rentA201 = await invoice({
      tenantId: DEV.tenantId,
      unitId: ids['A-201']!,
      billedPartyId: ids.lessee!,
      kind: 'rent',
      amount: '9000.00',
    });
    const mine = await t.http.get('/v1/resident/invoices').set(R).expect(200);
    expect((mine.body.data as { id: string }[]).map((i) => i.id)).toEqual([ids.feeA201]);
    expect(mine.body.data[0]).toMatchObject({ total: '1250.00' });
    await t.http.get(`/v1/resident/invoices/${ids.rentA201}`).set(R).expect(404);

    // occupant-only and lease-only features stay closed to a co-owner who does not live there
    await t.http.get(`/v1/resident/units/${ids['A-201']}/usage`).set(R).expect(404);
    await t.http.get(`/v1/resident/access/events?unitId=${ids['A-201']}`).set(R).expect(404);
    await t.http.get(`/v1/resident/leases/${DEV.leaseId}`).set(R).expect(404);
    await t.http.get(`/v1/resident/leases/${DEV.leaseId}/usage`).set(R).expect(404);
    // cross-tenant / not mine: usage of another unit
    await t.http.get(`/v1/resident/units/${ids['A-205']}/usage`).set(R).expect(404);
    await t.http.get(`/v1/resident/units/${ids.unitB}/usage`).set(R).expect(404);

    // PDPA: once someone else lives there, their parcels are theirs — the non-resident owner sees none of the unit's
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from)
       SELECT u.tenant_id, u.building_id, u.id, $2, 'tenant', '2026-11-10' FROM core.unit u WHERE u.id = $1`,
      [ids['A-201'], ids.lessee],
    );
    expect((await t.http.get('/v1/resident/parcels').set(R).expect(200)).body.data).toEqual([]);
    await q(`DELETE FROM core.occupancy WHERE unit_id = $1 AND party_id = $2`, [ids['A-201'], ids.lessee]);
  });

  it('one login, two units in two tenants: both listed, invoices per unit', async () => {
    const code = (await invite(tenantB.token, ids.unitB!, { channel: 'line_qr' }).expect(201)).body
      .code as string;
    expect((await redeem(coOwner.access, code, PHONE_CO_OWNER_B)).status).toBe(200);
    coOwner = await refresh(coOwner);
    const R = bearer(coOwner.access);
    const units = await t.http.get('/v1/resident/me/units').set(R).expect(200);
    expect((units.body.units as MeUnit[]).map((u) => [u.unitNo, u.tenantId])).toEqual([
      ['A-201', DEV.tenantId],
      ['B-101', tenantB.tenantId],
    ]);
    ids.feeB = await invoice({
      tenantId: tenantB.tenantId,
      unitId: ids.unitB!,
      billedPartyId: ids.coOwnerB!,
      kind: 'common_fee',
      amount: '800.00',
    });
    const all = await t.http.get('/v1/resident/invoices').set(R).expect(200);
    expect((all.body.data as { id: string }[]).map((i) => i.id).sort()).toEqual(
      [ids.feeA201, ids.feeB].sort(),
    );
    const onlyB = await t.http.get(`/v1/resident/invoices?unitId=${ids.unitB}`).set(R).expect(200);
    expect((onlyB.body.data as { id: string }[]).map((i) => i.id)).toEqual([ids.feeB]);
    const onlyA = await t.http.get(`/v1/resident/invoices?unitId=${ids['A-201']}`).set(R).expect(200);
    expect((onlyA.body.data as { id: string }[]).map((i) => i.id)).toEqual([ids.feeA201]);
  });

  it('family occupant: notices and parcels, no invoices unless billed (payer); usage where they live', async () => {
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from)
       SELECT u.tenant_id, u.building_id, u.id, $2, 'family', '2026-11-01' FROM core.unit u WHERE u.id = $1`,
      [ids['A-203'], ids.family],
    );
    const family = await otpSignIn(t, 'resident', PHONE_FAMILY, owner);
    expect(family.subject.scopes).toContain(`unit:${ids['A-203']}`);
    const R = bearer(family.accessToken);
    const units = await t.http.get('/v1/resident/me/units').set(R).expect(200);
    const unit = (units.body.units as MeUnit[])[0]!;
    expect(unit.roles).toEqual([expect.objectContaining({ role: 'family', source: 'occupancy' })]);
    expect(unit.capabilities).toEqual(expect.arrayContaining(['notices', 'parcels', 'usage', 'access']));
    expect(unit.capabilities).not.toContain('invoices');
    expect(unit.capabilities).not.toContain('lease');
    const p = await parcel(ids['A-203']!);
    expect(
      ((await t.http.get('/v1/resident/parcels').set(R).expect(200)).body.data as { id: string }[]).map(
        (x) => x.id,
      ),
    ).toEqual([p]);
    expect(
      ((await t.http.get('/v1/resident/announcements').set(R).expect(200)).body.data as unknown[]).length,
    ).toBeGreaterThan(0);
    // the unit's invoice billed to someone else is not theirs
    const other = await invoice({
      tenantId: DEV.tenantId,
      unitId: ids['A-203']!,
      billedPartyId: ids.lessee!,
      kind: 'common_fee',
      amount: '700.00',
    });
    expect((await t.http.get('/v1/resident/invoices').set(R).expect(200)).body.data).toEqual([]);
    await t.http.get(`/v1/resident/invoices/${other}`).set(R).expect(404);
    // as the payer (billed party) they see it
    const paid = await invoice({
      tenantId: DEV.tenantId,
      unitId: ids['A-203']!,
      billedPartyId: ids.family!,
      kind: 'common_fee',
      amount: '700.00',
    });
    expect(
      ((await t.http.get('/v1/resident/invoices').set(R).expect(200)).body.data as { id: string }[]).map(
        (i) => i.id,
      ),
    ).toEqual([paid]);
    // usage of the unit they live in (no lease needed): from their occupancy start, manual meters → empty series
    const usage = await t.http.get(`/v1/resident/units/${ids['A-203']}/usage`).set(R).expect(200);
    expect(usage.body).toMatchObject({ unitId: ids['A-203'], bucket: '1d' });
    expect(Date.parse(usage.body.from as string)).toBeGreaterThanOrEqual(
      Date.parse('2026-11-01T00:00:00+07:00'),
    );
  });

  it('former owner loses the unit on the ownership end date; an expired invitation is refused', async () => {
    // the former owner redeems before the transfer date
    const former = await residentLogin('U-jr-former');
    expect((await redeem(former.access, ids.lateCode!, PHONE_FORMER)).status).toBe(200);
    let s = await refresh(former);
    expect(s.scopes).toEqual([`unit:${ids['A-202']}`]);
    const p = await parcel(ids['A-202']!);
    expect(
      (
        (await t.http.get('/v1/resident/parcels').set(bearer(s.access)).expect(200)).body.data as {
          id: string;
        }[]
      ).map((x) => x.id),
    ).toEqual([p]);
    // 23:55 on 19 Nov (Bangkok): a fresh token; ten minutes later it is 20 Nov — the transfer date
    t.clock.set('2026-11-19T16:55:00Z');
    s = await refresh(s);
    expect(s.scopes).toEqual([`unit:${ids['A-202']}`]);
    t.clock.set('2026-11-19T17:05:00Z');
    owner = await ownerToken(t);
    const old = bearer(s.access);
    expect((await t.http.get('/v1/resident/parcels').set(old).expect(200)).body.data).toEqual([]);
    const units = await t.http.get('/v1/resident/me/units').set(old).expect(200);
    expect(units.body).toMatchObject({ units: [], refreshRequired: true });
    s = await refresh(s);
    expect(s.scopes).toEqual([]);
    expect(
      (await t.http.get('/v1/resident/announcements').set(bearer(s.access)).expect(200)).body.data,
    ).toEqual([]);
    // an invitation issued on 10 Nov expired 14 days later
    const stale = await invite(owner, ids['A-201']!, { channel: 'link' }); // issued now (19 Nov)
    expect(stale.status).toBe(201);
    t.clock.set('2026-12-04T03:00:00Z');
    const fresh = await residentLogin('U-jr-late');
    await t.http
      .get(`/v1/resident/unit-invitations/${stale.body.code}`)
      .set(bearer(fresh.access))
      .expect(409);
    await t.http
      .post(`/v1/resident/unit-invitations/${stale.body.code}/otp`)
      .set(bearer(fresh.access))
      .expect(409);
  });
});

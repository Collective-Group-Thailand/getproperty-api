import { fakeLineIdToken } from '@collective/integrations/line';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const LINE_SUB = 'U00000000000000000000000000b2b201';
const THAI_ID = '1234567890121'; // passes the checksum; a generated fixture, not a person

/**
 * B2.2 acceptance (parties): sealed ID numbers and emergency phones (D-148), reveal by Owner/Manager only and
 * audited (D-172), ID document images Owner/Manager only with audited downloads (D-025), LINE linking by match and
 * the Owner-approved unlink (D-061), the resident privacy page, cross-tenant 404s and RLS on ops.occupant_profile.
 * Lease invitations are covered with the leases (B2.3) because they need `ops.lease`.
 */
describe('B2.2 parties, PII, ID documents, links, privacy (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let manager: string;
  let staff: string;
  let other: { tenantId: string; token: string };
  let partyId: string;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_parties' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    manager = await operatorToken(t, '+660000000002');
    staff = await operatorToken(t, '+660000000003');
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b22',
      phone: '+660000000072',
      type: 'apartment',
    });
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('staff create a party; the ID number and emergency phone are sealed, never returned', async () => {
    const bad = await t.http
      .post('/v1/staff/parties')
      .set(bearer(staff))
      .send({
        type: 'person',
        displayName: 'ผิด',
        idDocumentType: 'thai_national_id',
        idNumber: '1234567890122',
      })
      .expect(422);
    expect(bad.body.errors[0]).toMatchObject({ path: 'idNumber', code: 'thaiId' });
    const res = await t.http
      .post('/v1/staff/parties')
      .set(bearer(staff))
      .send({
        type: 'person',
        displayName: 'ผู้เช่า ทดสอบ',
        firstName: 'ผู้เช่า',
        lastName: 'ทดสอบ',
        phone: '081-000-1234',
        nationality: 'TH',
        idDocumentType: 'thai_national_id',
        idNumber: '1-2345-67890-12-1',
        emergencyContact: { name: 'ญาติ ทดสอบ', relation: 'พี่สาว', phone: '0810004321' },
        occupantProfile: { occupation: 'พนักงานบริษัท' },
      })
      .expect(201);
    partyId = res.body.id;
    expect(res.body).toMatchObject({
      phone: '+66810001234',
      idNumberOnFile: true,
      emergencyContact: { name: 'ญาติ ทดสอบ', relation: 'พี่สาว', phoneOnFile: true },
      occupantProfile: { occupation: 'พนักงานบริษัท' },
    });
    expect(JSON.stringify(res.body)).not.toContain(THAI_ID);
    const { rows } = await db.admin.query<{ enc: Buffer; hash: Buffer; ec: { phoneEnc: string } }>(
      'SELECT id_number_enc AS enc, id_number_hash AS hash, emergency_contact AS ec FROM core.party WHERE id = $1',
      [partyId],
    );
    expect(rows[0]!.enc.toString('latin1')).not.toContain(THAI_ID);
    expect(rows[0]!.hash).toHaveLength(32);
    expect(JSON.stringify(rows[0]!.ec)).not.toContain('810004321');
  });

  it('finds the party by name, exact phone or exact ID number (lookup hashes)', async () => {
    for (const q of ['ผู้เช่า', '0810001234', THAI_ID]) {
      const res = await t.http
        .get(`/v1/owner/parties?q=${encodeURIComponent(q)}`)
        .set(bearer(owner))
        .expect(200);
      expect((res.body.data as { id: string }[]).map((p) => p.id)).toContain(partyId);
    }
  });

  it('reveals sealed fields to the Owner and the Manager (audited with the purpose), never to Staff', async () => {
    const r = await t.http
      .post(`/v1/owner/parties/${partyId}/actions/reveal-pii`)
      .set(bearer(owner))
      .send({ fields: ['idNumber', 'emergencyContactPhone'], purpose: 'ตรวจสอบตัวตนก่อนทำสัญญา' })
      .expect(200);
    expect(r.body).toEqual({ idNumber: THAI_ID, emergencyContactPhone: '+66810004321' });
    await t.http
      .post(`/v1/owner/parties/${partyId}/actions/reveal-pii`)
      .set(bearer(manager))
      .send({ fields: ['idNumber'], purpose: 'ผู้จัดการตรวจสอบ' })
      .expect(200);
    const denied = await t.http
      .post(`/v1/owner/parties/${partyId}/actions/reveal-pii`)
      .set(bearer(staff))
      .send({ fields: ['idNumber'], purpose: 'พนักงาน' })
      .expect(403);
    expect(denied.body.code).toBe('auth.forbidden');
    const audit = await db.admin.query<{ field: string; purpose: string }>(
      `SELECT metadata->>'field' AS field, metadata->>'purpose' AS purpose FROM platform.audit_log
        WHERE action = 'pii.decrypted' AND subject_id = $1 ORDER BY occurred_at, id`,
      [partyId],
    );
    expect(audit.rows).toEqual([
      { field: 'id_number', purpose: 'ตรวจสอบตัวตนก่อนทำสัญญา' },
      { field: 'emergency_contact.phone', purpose: 'ตรวจสอบตัวตนก่อนทำสัญญา' },
      { field: 'id_number', purpose: 'ผู้จัดการตรวจสอบ' },
    ]);
  });

  it('ID document images: staff upload them but only Owner/Manager list and open them; every open is audited', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
      'hex',
    );
    const fileId = await uploadFile(t, db, staff, {
      surface: 'staff',
      kind: 'id_document',
      scopeType: 'party',
      scopeId: partyId,
      fileName: 'id-card.png',
      mimeType: 'image/png',
      body: png,
    });
    expect((await t.http.get(`/v1/staff/files/${fileId}`).set(bearer(staff))).status).toBe(403);
    expect((await t.http.get(`/v1/owner/parties/${partyId}/id-documents`).set(bearer(staff))).status).toBe(
      403,
    );
    const list = await t.http
      .get(`/v1/owner/parties/${partyId}/id-documents`)
      .set(bearer(manager))
      .expect(200);
    expect((list.body as { id: string }[]).map((d) => d.id)).toEqual([fileId]);
    const dl = await t.http
      .get(`/v1/owner/parties/${partyId}/id-documents/${fileId}?purpose=${encodeURIComponent('ทำสัญญาเช่า')}`)
      .set(bearer(owner))
      .expect(200);
    expect(dl.body.url).toContain('http');
    const audit = await db.admin.query(
      `SELECT metadata->>'purpose' AS purpose FROM platform.audit_log WHERE action = 'document.downloaded' AND subject_id = $1`,
      [fileId],
    );
    expect(audit.rows).toEqual([{ purpose: 'ทำสัญญาเช่า' }]);
  });

  it('a LINE sign-in links the party (line_match); the Owner (only) approves an unlink', async () => {
    // the LINE id is recorded on the party when a resident accepts an invitation (B2.3); set it directly here
    await db.admin.query('UPDATE core.party SET line_user_id = $2 WHERE id = $1', [partyId, LINE_SUB]);
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า LINE' }) })
      .expect(200);
    const links = await t.http.get(`/v1/owner/parties/${partyId}/links`).set(bearer(owner)).expect(200);
    expect(links.body).toHaveLength(1);
    expect(links.body[0]).toMatchObject({ linkedVia: 'line_match', state: 'active', lineLinked: true });
    const privacy = await t.http
      .get('/v1/resident/me/privacy')
      .set(bearer(login.body.accessToken as string))
      .expect(200);
    expect(privacy.body.controllers).toHaveLength(1);
    expect(privacy.body.controllers[0]).toMatchObject({ tenantId: DEV.tenantId });
    expect(privacy.body.controllers[0].parties[0].fieldsHeld).toEqual(
      expect.arrayContaining([
        'name',
        'phone',
        'line_id',
        'id_number',
        'id_document_image',
        'emergency_contact',
        'tm30',
      ]),
    );
    expect(JSON.stringify(privacy.body)).not.toContain(THAI_ID);
    const linkId = links.body[0].id as string;
    expect(
      (
        await t.http
          .post(`/v1/owner/parties/${partyId}/links/${linkId}/actions/unlink`)
          .set(bearer(manager))
          .send({ unlinkReason: 'ผู้จัดการ' })
      ).status,
    ).toBe(403);
    await t.http
      .post(`/v1/owner/parties/${partyId}/links/${linkId}/actions/unlink`)
      .set(bearer(owner))
      .send({ unlinkReason: 'ผู้เช่าเปลี่ยนบัญชี LINE' })
      .expect(204);
    const again = await t.http
      .post(`/v1/owner/parties/${partyId}/links/${linkId}/actions/unlink`)
      .set(bearer(owner))
      .send({ unlinkReason: 'ซ้ำ' })
      .expect(409);
    expect(again.body.code).toBe('party.link_not_active');
    const audit = await db.admin.query(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'party.unlinked'`,
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('updates with If-Match and re-seals a changed ID number', async () => {
    const current = await t.http.get(`/v1/owner/parties/${partyId}`).set(bearer(owner)).expect(200);
    await t.http
      .patch(`/v1/owner/parties/${partyId}`)
      .set(bearer(owner))
      .set('If-Match', current.headers.etag!)
      .send({ idDocumentType: 'passport', idNumber: 'AA1234567', idDocumentCountry: 'JP', nationality: 'JP' })
      .expect(200);
    const r = await t.http
      .post(`/v1/owner/parties/${partyId}/actions/reveal-pii`)
      .set(bearer(owner))
      .send({ fields: ['idNumber'], purpose: 'ตรวจสอบหนังสือเดินทาง' })
      .expect(200);
    expect(r.body.idNumber).toBe('AA1234567');
    await t.http
      .patch(`/v1/owner/parties/${partyId}`)
      .set(bearer(owner))
      .set('If-Match', current.headers.etag!)
      .send({ notes: 'เก่า' })
      .expect(412);
  });

  it('another tenant gets 404 on every party endpoint of tenant A', async () => {
    const B = bearer(other.token);
    for (const path of [
      `/v1/owner/parties/${partyId}`,
      `/v1/owner/parties/${partyId}/links`,
      `/v1/owner/parties/${partyId}/id-documents`,
    ])
      expect((await t.http.get(path).set(B)).status).toBe(404);
    expect(
      (
        await t.http
          .post(`/v1/owner/parties/${partyId}/actions/reveal-pii`)
          .set(B)
          .send({ fields: ['idNumber'], purpose: 'ข้ามผู้เช่า' })
      ).status,
    ).toBe(404);
    expect(
      (await t.http.patch(`/v1/owner/parties/${partyId}`).set(B).set('If-Match', '*').send({ notes: 'x' }))
        .status,
    ).toBe(404);
    const list = await t.http.get(`/v1/owner/parties?q=${THAI_ID}`).set(B).expect(200);
    expect(list.body.meta.total).toBe(0);
  });

  it('RLS: ops.occupant_profile rows are invisible to another tenant and cannot be written for it', async () => {
    const count = (tenantId: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) => tx.occupantProfile.count())
        .then((n) => n);
    expect(await count(DEV.tenantId)).toBe(1);
    expect(await count(other.tenantId)).toBe(0);
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: other.tenantId }, (tx) =>
          tx.occupantProfile.update({ where: { partyId }, data: { notes: 'แอบแก้' } }),
        ),
    ).rejects.toThrow();
    await expect(
      db
        .prisma()
        .withTenant({ tenantId: other.tenantId }, (tx) =>
          tx.occupantProfile.create({ data: { partyId: DEV.legalPartyId, tenantId: DEV.tenantId } }),
        ),
    ).rejects.toThrow(/row-level security/);
  });
});

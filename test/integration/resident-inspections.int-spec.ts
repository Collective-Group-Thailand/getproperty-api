import { createHash } from 'node:crypto';

import { fakeLineIdToken } from '@collective/integrations/line';
import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import { TenantTx } from '@database/tenant-tx';
import { DepositsService } from '@modules/ops-deposits/deposits.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const ADDRESS = { line1: 'ถนนสุขุมวิท', district: 'คลองเตย', province: 'กรุงเทพมหานคร', postcode: '10110' };
const LINE_SUB = 'U000000000000000000000000000b5201';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * L5 5.2 support (D-253): a landlord completes the move-in report without the resident there → the resident is told in
 * LINE, opens it in the LIFF (lines, photos, PDF) and countersigns → the owner hears it; once only, signers only.
 */
describe('resident countersigns the move-in report (D-253, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string };
  let unitId: string;
  let lessee: string;
  let resident: string;
  let leaseId: string;
  let inspectionId: string;

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });
  const today = () => new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_resident_inspections' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.advance(61_000);
    const phone = '+66810009911';
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const signup = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName: 'สมศรี เช่าดี',
    });
    owner = { tenantId: signup.body.tenant.id as string, token: signup.body.tokens.accessToken as string };
    unitId = (
      await t.http
        .post('/v1/owner/portfolio/units')
        .set(as())
        .send({
          kind: 'house',
          projectName: 'หมู่บ้านตัวอย่าง',
          unitNo: '99/1',
          address: ADDRESS,
          bedrooms: 3,
          bathrooms: 2,
        })
        .expect(201)
    ).body.unitId as string;
    lessee = (
      await t.http
        .post('/v1/owner/parties')
        .set(as())
        .send({
          type: 'person',
          displayName: 'Ben Example',
          phone: '+66810009912',
          nationality: 'GB',
          idDocumentType: 'passport',
          idNumber: 'X1234567',
        })
        .expect(201)
    ).body.id as string;
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(as())
      .send({ unitId, lesseePartyId: lessee, startDate: today(), months: 12, rent: '25000' })
      .expect(201);
    leaseId = draft.body.id as string;
    await t.http
      .post(`/v1/owner/leases/${draft.body.id}/actions/send-for-signature`)
      .set(as())
      .set(idem())
      .expect(200);
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [draft.body.id],
    );
    // What activation does (the signature flow is another spec): the lessee occupies the unit from the start date.
    await db.admin.query(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from, lease_id)
       SELECT tenant_id, building_id, unit_id, $2, 'tenant', start_date, id FROM ops.lease WHERE id = $1`,
      [draft.body.id, lessee],
    );
    const first = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'Ben' }) })
      .expect(200);
    await db.admin.query(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via)
       SELECT $1, $2, user_id, 'invitation' FROM core.user_identity WHERE provider_subject = $3`,
      [owner.tenantId, lessee, LINE_SUB],
    );
    resident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200)
    ).body.accessToken as string;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  const drain = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };

  it('the owner completes the move-in report alone; the resident is asked in LINE', async () => {
    const created = await t.http
      .post('/v1/owner/inspections')
      .set(as())
      .set(idem())
      .send({ leaseId, type: 'move_in' });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    inspectionId = created.body.id as string;
    const current = await t.http.get(`/v1/owner/inspections/${inspectionId}`).set(as()).expect(200);
    const items = (current.body.items as { itemKey: string }[]).map((i) => ({
      itemKey: i.itemKey,
      condition: 'good',
      ...(i.itemKey.startsWith('meter:') ? { meterRegister: '10.000' } : {}),
    }));
    await t.http
      .patch(`/v1/owner/inspections/${inspectionId}/items`)
      .set(as())
      .set('If-Match', current.headers.etag!)
      .send({ items })
      .expect(200);
    const done = await t.http
      .post(`/v1/owner/inspections/${inspectionId}/actions/complete`)
      .set(as())
      .set(idem())
      .send({ staffSignaturePng: PNG.toString('base64') })
      .expect(200);
    expect(done.body).toMatchObject({ status: 'completed', residentSigned: false });
    await drain();
    const asked = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'inspection.completed' AND n.channel = 'line' AND n.recipient_type = 'party'`,
    );
    expect(asked.rows[0]!.n).toBe(1);
  });

  it('the resident opens the report and countersigns it once', async () => {
    const list = await t.http
      .get(`/v1/resident/inspections?leaseId=${leaseId}`)
      .set(bearer(resident))
      .expect(200);
    expect((list.body as { id: string; status: string }[]).map((i) => [i.id, i.status])).toEqual([
      [inspectionId, 'completed'],
    ]);
    const one = await t.http
      .get(`/v1/resident/inspections/${inspectionId}`)
      .set(bearer(resident))
      .expect(200);
    expect(one.body).toMatchObject({ canCountersign: true, ownerSigned: true, residentSigned: false });
    expect(one.body.reportUrl).toEqual(expect.any(String));
    expect((one.body.items as unknown[]).length).toBeGreaterThan(0);

    const bad = await t.http
      .post(`/v1/resident/inspections/${inspectionId}/actions/countersign`)
      .set(bearer(resident))
      .send({ signaturePng: Buffer.from('not a png').toString('base64') });
    expect(bad.body.code).toBe('lease.signature_invalid');

    // D-266: a photo of my own and a note with my signature
    const presigned = await t.http
      .post('/v1/resident/uploads')
      .set(bearer(resident))
      .send({
        purpose: 'inspection_note',
        inspectionId,
        contentType: 'image/png',
        sizeBytes: PNG.length,
        sha256: createHash('sha256').update(PNG).digest('hex'),
      })
      .expect(201);
    const key = (
      await db.admin.query<{ storage_key: string }>('SELECT storage_key FROM core.document WHERE id = $1', [
        presigned.body.fileId,
      ])
    ).rows[0]!.storage_key;
    t.app.get<FakeObjectStorage>(OBJECT_STORAGE).putDirect(key, PNG, 'image/png');
    const signed = await t.http
      .post(`/v1/resident/inspections/${inspectionId}/actions/countersign`)
      .set(bearer(resident))
      .send({
        signaturePng: PNG.toString('base64'),
        note: 'ผนังห้องนอนมีรอยขีดอยู่ก่อนแล้ว',
        photoDocumentIds: [presigned.body.fileId],
      })
      .expect(200);
    expect(signed.body).toMatchObject({
      status: 'signed',
      residentSigned: true,
      canCountersign: false,
      residentNote: 'ผนังห้องนอนมีรอยขีดอยู่ก่อนแล้ว',
    });
    expect(signed.body.residentPhotoUrls).toHaveLength(1);
    const again = await t.http
      .post(`/v1/resident/inspections/${inspectionId}/actions/countersign`)
      .set(bearer(resident))
      .send({ signaturePng: PNG.toString('base64') });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('inspection.invalid_state');

    const owners = await t.http.get(`/v1/owner/inspections/${inspectionId}`).set(as()).expect(200);
    expect(owners.body).toMatchObject({
      status: 'signed',
      residentSigned: true,
      residentNote: 'ผนังห้องนอนมีรอยขีดอยู่ก่อนแล้ว',
      residentPhotoDocumentIds: [presigned.body.fileId],
    });
    const late = await t.http
      .post('/v1/resident/uploads')
      .set(bearer(resident))
      .send({
        purpose: 'inspection_note',
        inspectionId,
        contentType: 'image/png',
        sizeBytes: PNG.length,
        sha256: createHash('sha256').update(PNG).digest('hex'),
      });
    expect(late.status).toBe(409);
    await drain();
    const told = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'inspection.countersigned' AND n.channel = 'in_app'`,
    );
    expect(told.rows[0]!.n).toBeGreaterThan(0);
  });

  it("a landlord's deduction must point at a move-out item; the resident accepts with a note (D-266)", async () => {
    await t.app
      .get(TenantTx)
      .platform(async (tx) =>
        t.app
          .get(DepositsService)
          .openDeposit(tx, await tx.lease.findUniqueOrThrow({ where: { id: leaseId } })),
      );
    const list = await t.http.get(`/v1/owner/deposits?leaseId=${leaseId}`).set(as()).expect(200);
    const depositId = (list.body.data as { id: string }[])[0]!.id;
    await t.http
      .post(`/v1/owner/deposits/${depositId}/actions/record-receipt`)
      .set(as())
      .set(idem())
      .send({})
      .expect(200);
    await t.http.post(`/v1/owner/leases/${leaseId}/actions/begin-move-out`).set(as()).expect(200);
    await t.http
      .post(`/v1/owner/leases/${leaseId}/actions/complete-move-out`)
      .set(as())
      .set(idem())
      .send({})
      .expect(200);
    const refused = await t.http
      .post(`/v1/owner/deposits/${depositId}/settlement/items`)
      .set(as())
      .send({ kind: 'cleaning', description: 'ทำความสะอาดใหญ่', amount: '800.00' })
      .expect(422);
    expect(refused.body.code).toBe('deposit.item_required');

    await t.http
      .post(`/v1/owner/deposits/${depositId}/settlement/actions/propose`)
      .set(as())
      .send({})
      .expect(200);
    const accepted = await t.http
      .post(`/v1/resident/deposits/${depositId}/actions/accept`)
      .set(bearer(resident))
      .send({ note: 'ขอบคุณที่คืนเงินครบครับ' })
      .expect(200);
    expect(accepted.body.settlement).toMatchObject({
      residentResponse: 'accepted',
      residentNote: 'ขอบคุณที่คืนเงินครบครับ',
    });
    const owners = await t.http.get(`/v1/owner/deposits/${depositId}`).set(as()).expect(200);
    expect(owners.body.settlement.residentNote).toBe('ขอบคุณที่คืนเงินครบครับ');
  });

  it('is invisible outside my lease scopes', async () => {
    const stranger = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U000000000000000000000000000b5202', name: 'Stranger' }) })
      .expect(200);
    const res = await t.http
      .get(`/v1/resident/inspections/${inspectionId}`)
      .set(bearer(stranger.body.accessToken as string));
    expect(res.status).toBe(404);
  });
});

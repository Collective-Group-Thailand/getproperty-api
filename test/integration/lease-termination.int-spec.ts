import 'reflect-metadata';

import { type FakeLockVendors } from '@integrations/locks/fake-lock-vendors';
import { LOCK_VENDORS } from '@integrations/locks/lock-vendor.port';
import { LeasesService } from '@modules/ops-leases/leases.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { bearer, idem, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
).toString('base64');
function thaiId(prefix12: string): string {
  const sum = [...prefix12].reduce((acc, d, i) => acc + Number(d) * (13 - i), 0);
  return `${prefix12}${(11 - (sum % 11)) % 10}`;
}
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Review #1 / #14 (D-024, D-071, D-176, D-219): a lessor termination with a future effective date records the notice
 * and leaves the lease in force — occupancy, unit status, door codes and the deposit clock — until the lifecycle sweep
 * starts the move-out on the effective date; completing the move-out closes it as `terminated` and only then ends the
 * door codes.
 */
describe('lease termination with a future effective date (real PostgreSQL)', () => {
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
  const vendor = () => t.app.get<FakeLockVendors>(LOCK_VENDORS).adapter('ttlock');
  const today = () => new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const creds = (leaseId: string | undefined) =>
    q<{ status: string }>(
      `SELECT status::text FROM smart.access_credential WHERE lease_id = $1 ORDER BY created_at`,
      [leaseId],
    );
  const terminate = async (body: Record<string, unknown>) => {
    const warn = await t.http
      .post(`/v1/owner/leases/${ids.lease}/actions/terminate`)
      .set(O())
      .set(idem())
      .send(body);
    if (warn.status !== 409) return warn;
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
    return t.http
      .post(`/v1/owner/leases/${ids.lease}/actions/terminate`)
      .set(O())
      .set(idem())
      .send({ ...body, acknowledgementIds: [ack.body.id] });
  };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_term' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    ids.unit = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-102'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    await t.http
      .post('/v1/owner/locks')
      .set(O())
      .send({
        scope: 'unit',
        unitId: ids.unit,
        vendor: 'ttlock',
        vendorLockId: 'term-a102',
        serial: 'TTL-TERM-A102',
        name: 'ประตูห้อง A-102',
      })
      .expect(201);
    const party = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({
        type: 'person',
        displayName: 'ผู้เช่า ทดสอบเลิกสัญญา',
        phone: '+660000000301',
        nationality: 'TH',
        idDocumentType: 'thai_national_id',
        idNumber: thaiId('130000000061'),
      })
      .expect(201);
    ids.party = party.body.id as string;
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(O())
      .send({
        unitId: ids.unit,
        lesseePartyId: ids.party,
        startDate: today(),
        months: 6,
        depositAmount: '4500.00',
      })
      .expect(201);
    ids.lease = draft.body.id as string;
    const sent = await t.http
      .post(`/v1/owner/leases/${ids.lease}/actions/send-for-signature`)
      .set(O())
      .set(idem());
    if (sent.status !== 200) throw new Error(JSON.stringify(sent.body));
    await q(
      `INSERT INTO ops.lease_signature (tenant_id, lease_id, signer_role, party_id, method, signature_image_document_id, pdf_sha256, signed_at)
       SELECT tenant_id, id, 'lessee', $2, 'scan_upload', contract_document_id, decode($3, 'hex'), now() FROM ops.lease WHERE id = $1`,
      [ids.lease, ids.party, sent.body.contract.sha256],
    );
    await t.http
      .post(`/v1/owner/leases/${ids.lease}/actions/countersign`)
      .set(O())
      .set(idem())
      .send({ signaturePng: PNG })
      .expect(200);
    await settle();
    expect((await creds(ids.lease)).map((c) => c.status)).toEqual(['active']);
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('terminate effective in 30 days records the lessor notice: nothing closes, the door code stays', async () => {
    const effective = addDays(today(), 30);
    const res = await terminate({
      reasonCode: 'lessee_breach',
      effectiveDate: effective,
      notes: 'ค้างชำระ 2 เดือน',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'notice_given',
      notice: { by: 'lessor', reasonCode: 'lessee_breach', effectiveDate: effective },
      termination: null,
    });
    await settle();
    expect((await creds(ids.lease)).map((c) => c.status)).toEqual(['active']);
    expect(vendor().active('term-a102', new Date(t.clock.now().getTime() + 60_000))).toHaveLength(1);
    expect(
      (await q<{ status: string }>('SELECT status::text FROM core.unit WHERE id = $1', [ids.unit]))[0],
    ).toEqual({
      status: 'occupied',
    });
    expect(
      await q('SELECT 1 FROM core.occupancy WHERE lease_id = $1 AND valid_to IS NOT NULL', [ids.lease]),
    ).toEqual([]);
    expect(await q('SELECT 1 FROM ops.deposit_settlement WHERE lease_id = $1', [ids.lease])).toEqual([]);
    const audit = await q<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE subject_id = $1 AND action LIKE 'lease.termin%'`,
      [ids.lease],
    );
    expect(audit.map((a) => a.action)).toEqual(['lease.termination_scheduled']);
  });

  it('the sweep starts the move-out on the effective date; completing it terminates and only then revokes', async () => {
    t.clock.advanceDays(29);
    await t.app.get(LeasesService).sweep();
    owner = await ownerToken(t);
    expect((await t.http.get(`/v1/owner/leases/${ids.lease}`).set(O()).expect(200)).body.status).toBe(
      'notice_given',
    );
    t.clock.advanceDays(1);
    expect(await t.app.get(LeasesService).sweep()).toBeGreaterThan(0);
    owner = await ownerToken(t);
    expect((await t.http.get(`/v1/owner/leases/${ids.lease}`).set(O()).expect(200)).body.status).toBe(
      'ending',
    );
    await settle();
    expect((await creds(ids.lease)).map((c) => c.status)).toEqual(['active']);
    const done = await t.http
      .post(`/v1/owner/leases/${ids.lease}/actions/complete-move-out`)
      .set(O())
      .set(idem())
      .send({})
      .expect(200);
    expect(done.body).toMatchObject({
      status: 'terminated',
      termination: { reasonCode: 'lessee_breach', notes: 'ค้างชำระ 2 เดือน' },
    });
    await settle();
    expect((await creds(ids.lease)).map((c) => c.status)).toEqual(['revoked']);
    expect(vendor().active('term-a102', new Date(t.clock.now().getTime() + 60_000))).toEqual([]);
    expect(
      (await q<{ status: string }>('SELECT status::text FROM core.unit WHERE id = $1', [ids.unit]))[0],
    ).toEqual({
      status: 'vacant',
    });
    expect(
      await q('SELECT 1 FROM core.occupancy WHERE lease_id = $1 AND valid_to IS NULL', [ids.lease]),
    ).toEqual([]);
  });
});

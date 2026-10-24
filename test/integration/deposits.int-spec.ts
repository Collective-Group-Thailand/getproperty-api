import { createHash } from 'node:crypto';

import { fakeLineIdToken } from '@collective/integrations/line';
import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import { bangkokDate } from '@common/time/bangkok';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082';
const PNG = Buffer.from(PNG_HEX, 'hex');
const LINE_SUB = 'U00000000000000000000000000b2b401';
const PHONE = '+66810007788';

function thaiId(prefix12: string): string {
  const sum = [...prefix12].reduce((acc, d, i) => acc + Number(d) * (13 - i), 0);
  return `${prefix12}${(11 - (sum % 11)) % 10}`;
}

interface Item {
  id: string;
  itemKey: string;
  condition: string | null;
}

/**
 * B2.4 acceptance (deposits): activation opens the deposit → receipt → move-in inspection → move-out → settlement on
 * the workflow (deadline = move-out + 7 days, T-3/T-1 reminders) → move-out inspection → comparison → deductions
 * (normal wear refused, no evidence refused) → proposal → resident accepts → refund with slip → statement; a second
 * lease disputed, refunded after the deadline: flagged late by the SLA breach (audit + compliance evaluation).
 * Cross-tenant 404s and RLS on the B2.4 tables.
 */
describe('B2.4 deposits, inspections, 7-day settlement (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let staff: string;
  let other: { tenantId: string; token: string };
  let resident: string;
  let today: string;
  const ids: Record<string, string> = {};

  const unitId = async (unitNo: string) =>
    (
      await db.admin.query<{ id: string }>(
        'SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = $2',
        [DEV.buildingId, unitNo],
      )
    ).rows[0]!.id;

  /** An active lease of the shared party: draft → send → lessee signature on file (scan) → countersign. */
  async function activeLease(unitNo: string): Promise<string> {
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(bearer(owner))
      .send({
        unitId: await unitId(unitNo),
        lesseePartyId: ids.party,
        startDate: today,
        months: 12,
        rent: '4500.00',
        depositAmount: '4500.00',
        advanceRentAmount: '4500.00',
      })
      .expect(201);
    const sent = await t.http
      .post(`/v1/owner/leases/${draft.body.id}/actions/send-for-signature`)
      .set(bearer(owner))
      .set(idem())
      .expect(200);
    await db.admin.query(
      `INSERT INTO ops.lease_signature (tenant_id, lease_id, signer_role, party_id, method, signature_image_document_id, pdf_sha256, signed_at)
       VALUES ($1, $2, 'lessee', $3, 'scan_upload', $4, decode($5, 'hex'), now())`,
      [DEV.tenantId, draft.body.id, ids.party, ids.signatureDoc, sent.body.contract.sha256],
    );
    await t.http
      .post(`/v1/owner/leases/${draft.body.id}/actions/countersign`)
      .set(bearer(owner))
      .set(idem())
      .send({ signaturePng: PNG.toString('base64') })
      .expect(200);
    return draft.body.id as string;
  }

  const depositOf = async (leaseId: string) =>
    (
      (await t.http.get(`/v1/owner/deposits?leaseId=${leaseId}`).set(bearer(owner)).expect(200)).body as {
        data: { id: string; status: string }[];
      }
    ).data[0]!;

  const photo = () =>
    uploadFile(t, db, staff, {
      surface: 'staff',
      kind: 'inspection_photo',
      scopeType: 'unit',
      scopeId: ids.unit1,
      fileName: 'photo.png',
      mimeType: 'image/png',
      body: PNG,
    });

  /** Fills every line (good unless listed), meters with registers, then completes with both signatures. */
  async function inspect(inspectionId: string, damaged: Record<string, string[]> = {}) {
    const S = bearer(staff);
    const current = await t.http.get(`/v1/staff/inspections/${inspectionId}`).set(S).expect(200);
    const items = (current.body.items as Item[]).map((i) => ({
      itemKey: i.itemKey,
      condition: damaged[i.itemKey] ? 'damaged' : 'good',
      ...(damaged[i.itemKey] ? { notes: 'รูเจาะ 3 จุด', photoDocumentIds: damaged[i.itemKey] } : {}),
      ...(i.itemKey.startsWith('meter:') ? { meterRegister: '120.500' } : {}),
    }));
    const patched = await t.http
      .patch(`/v1/staff/inspections/${inspectionId}/items`)
      .set(S)
      .set('If-Match', current.headers.etag!)
      .send({ items })
      .expect(200);
    expect(patched.body.status).toBe('in_progress');
    return t.http
      .post(`/v1/staff/inspections/${inspectionId}/actions/complete`)
      .set(S)
      .set(idem())
      .send({ staffSignaturePng: PNG.toString('base64'), residentSignaturePng: PNG.toString('base64') })
      .expect(200);
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_deposits' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b24',
      phone: '+660000000074',
      type: 'apartment',
    });
    today = bangkokDate(t.clock.now());
    ids.unit1 = await unitId('A-103');
    ids.party = (
      await t.http
        .post('/v1/owner/parties')
        .set(bearer(owner))
        .send({
          type: 'person',
          displayName: 'ผู้เช่า เงินประกัน',
          phone: PHONE,
          nationality: 'TH',
          idDocumentType: 'thai_national_id',
          idNumber: thaiId('120000000000'),
        })
        .expect(201)
    ).body.id;
    ids.signatureDoc = await uploadFile(t, db, owner, {
      kind: 'other',
      scopeType: 'unit',
      scopeId: ids.unit1,
      fileName: 'signature.png',
      mimeType: 'image/png',
      body: PNG,
    });
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  describe('accepted settlement', () => {
    it('activation opens the deposit; the receipt is numbered (deposit_receipt series)', async () => {
      ids.lease1 = await activeLease('A-103');
      const d = await depositOf(ids.lease1);
      expect(d).toMatchObject({
        status: 'pending',
        amountSecurity: '4500.00',
        amountAdvanceRent: '4500.00',
        nextActions: ['record-receipt'],
      });
      ids.deposit1 = d.id;
      const r = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/actions/record-receipt`)
        .set(bearer(owner))
        .set(idem())
        .send({ reference: 'เงินสด ณ วันทำสัญญา' })
        .expect(200);
      expect(r.body.status).toBe('held');
      expect(r.body.receiptNumber).toMatch(/^DPR-\d{4}-\d{5}$/);
      expect(r.body.receiptNumber).not.toBe('DPR-2026-00001'); // the seeded deposit holds 00001
      const receipt = await t.http
        .get(`/v1/owner/deposits/${ids.deposit1}/receipt`)
        .set(bearer(owner))
        .expect(200);
      expect(receipt.body.url).toContain('http');
      await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/actions/record-receipt`)
        .set(bearer(owner))
        .set(idem())
        .send({})
        .expect(409);
    });

    it('staff inspect at move-in: checklist + meter lines, photos, signatures, numbered report', async () => {
      const created = await t.http
        .post('/v1/staff/inspections')
        .set(bearer(staff))
        .send({ leaseId: ids.lease1, type: 'move_in' })
        .expect(201);
      const keys = (created.body.items as Item[]).map((i) => i.itemKey);
      expect(keys).toEqual(
        expect.arrayContaining(['door_lock', 'walls', 'bathroom_toilet', 'meter:electric', 'meter:water']),
      );
      await t.http
        .post('/v1/staff/inspections')
        .set(bearer(staff))
        .send({ leaseId: ids.lease1, type: 'move_in' })
        .expect(409);
      const done = await inspect(created.body.id);
      expect(done.body).toMatchObject({ status: 'signed', staffSigned: true, residentSigned: true });
      expect(done.body.reportNumber).toMatch(/^INS-\d{4}-\d{5}$/);
      await t.http.get(`/v1/staff/inspections/${created.body.id}/report`).set(bearer(staff)).expect(200);
      // B3.3: the meter registers of the inspection are manual readings (channel `inspection`)
      const readings = await db.admin.query<{ register: string; source: string; submitted_via: string }>(
        `SELECT register::text, source::text, submitted_via::text FROM smart.meter_reading WHERE unit_id = $1`,
        [ids.unit1],
      );
      expect(readings.rows.length).toBeGreaterThan(0);
      expect(
        readings.rows.every(
          (r) => r.register === '120.500' && r.source === 'manual' && r.submitted_via === 'inspection',
        ),
      ).toBe(true);
    });

    it('move-out opens the settlement on the workflow: deadline = move-out + 7 days, T-3/T-1 reminders, move-out task', async () => {
      await t.http
        .post(`/v1/owner/leases/${ids.lease1}/actions/begin-move-out`)
        .set(bearer(owner))
        .expect(200);
      await t.http
        .post(`/v1/owner/leases/${ids.lease1}/actions/complete-move-out`)
        .set(bearer(owner))
        .set(idem())
        .send({})
        .expect(200);
      const d = (await t.http.get(`/v1/owner/deposits/${ids.deposit1}`).set(bearer(owner)).expect(200)).body;
      expect(d.status).toBe('settling');
      expect(d.settlement).toMatchObject({
        status: 'opened',
        depositHeld: '4500.00',
        deductionsTotal: '0.00',
        isLate: false,
      });
      const days = (Date.parse(d.settlement.deadlineAt) - Date.parse(d.settlement.moveOutAt)) / 86_400_000;
      expect(days).toBe(7);
      const timers = await db.admin.query<{ kind: string }>(
        `SELECT t.kind::text FROM ops.workflow_timer t JOIN ops.deposit_settlement s ON s.workflow_instance_id = t.instance_id
          WHERE s.id = $1 ORDER BY t.fire_at`,
        [d.settlement.id],
      );
      expect(timers.rows.map((r) => r.kind)).toEqual(['reminder', 'reminder', 'sla_breach']);
      ids.moveOut1 = d.settlement.moveOutInspectionId;
      const tasks = await t.http
        .get(`/v1/staff/inspections?leaseId=${ids.lease1}&type=move_out`)
        .set(bearer(staff))
        .expect(200);
      expect(tasks.body.data[0]).toMatchObject({ id: ids.moveOut1, status: 'scheduled' });
    });

    it('the move-out inspection finds damage; the settlement is inspected; comparison shows the change', async () => {
      ids.wallPhoto = await photo();
      await inspect(ids.moveOut1!, { walls: [ids.wallPhoto] });
      const d = (await t.http.get(`/v1/owner/deposits/${ids.deposit1}`).set(bearer(owner)).expect(200)).body;
      expect(d.settlement.status).toBe('inspected');
      const cmp = await t.http
        .get(`/v1/owner/deposits/${ids.deposit1}/inspection-comparison`)
        .set(bearer(owner))
        .expect(200);
      const walls = (
        cmp.body.lines as {
          itemKey: string;
          changed: boolean;
          moveIn: { condition: string };
          moveOut: { condition: string; inspectionItemId: string };
        }[]
      ).find((l) => l.itemKey === 'walls')!;
      expect(walls).toMatchObject({
        changed: true,
        moveIn: { condition: 'good' },
        moveOut: { condition: 'damaged' },
      });
      ids.wallItem = walls.moveOut.inspectionItemId;
      ids.doorItem = (cmp.body.lines as { itemKey: string; moveOut: { inspectionItemId: string } }[]).find(
        (l) => l.itemKey === 'door_lock',
      )!.moveOut.inspectionItemId;
    });

    it('deductions: normal wear refused, damage without the inspection finding refused, damage with evidence added', async () => {
      const O = bearer(owner);
      const wear = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/settlement/items`)
        .set(O)
        .send({
          kind: 'damage',
          description: 'สีผนังซีดตามอายุ',
          amount: '500.00',
          wearCategory: 'normal_wear',
          inspectionItemId: ids.wallItem,
        })
        .expect(422);
      expect(wear.body.code).toBe('compliance.deposit_wear');
      expect(wear.body.legalRef).toContain('ข้อ 5');
      const noFinding = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/settlement/items`)
        .set(O)
        .send({
          kind: 'damage',
          description: 'ประตูเสียหาย',
          amount: '1500.00',
          inspectionItemId: ids.doorItem,
        })
        .expect(422);
      expect(noFinding.body.code).toBe('compliance.deposit_evidence');
      expect(noFinding.body.legalRef).toContain('ข้อ 4 (10)');
      const noEvidence = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/settlement/items`)
        .set(O)
        .send({ kind: 'cleaning', description: 'ทำความสะอาดใหญ่', amount: '300.00' })
        .expect(422);
      expect(noEvidence.body.code).toBe('compliance.deposit_evidence');
      const ok = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/settlement/items`)
        .set(O)
        .send({
          kind: 'damage',
          description: 'ผนังเป็นรูจากการเจาะยึดชั้นวาง 3 จุด',
          amount: '800.00',
          inspectionItemId: ids.wallItem,
        })
        .expect(201);
      expect(ok.body.settlement.deductionsTotal).toBe('800.00');
      expect(ok.body.settlement.items[0].evidenceDocumentIds).toEqual([ids.wallPhoto]);
      const evals = await db.admin.query<{ rule_id: string; outcome: string }>(
        `SELECT rule_id, outcome::text FROM platform.compliance_evaluation WHERE subject_type = 'ops.deposit_settlement' AND outcome <> 'pass' ORDER BY occurred_at`,
      );
      expect(evals.rows.map((r) => r.rule_id)).toEqual(
        expect.arrayContaining(['compliance.deposit_wear', 'compliance.deposit_evidence']),
      );
    });

    it('the owner proposes; the resident sees the evidence and accepts in the LIFF', async () => {
      const p = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/settlement/actions/propose`)
        .set(bearer(owner))
        .send({ utilitiesFinal: '350.50' })
        .expect(200);
      expect(p.body.settlement).toMatchObject({
        status: 'proposed',
        proposedRefund: '3349.50',
        utilitiesFinal: '350.50',
      });

      // the lessee links LINE through an invitation (B2.3) and sees the proposal
      const inv = await t.http
        .post(`/v1/owner/leases/${ids.lease1}/invitations`)
        .set(bearer(owner))
        .send({ channel: 'link' })
        .expect(409);
      expect(inv.body.code).toBe('lease.invalid_state'); // an ended lease takes no invitations
      ids.lease2 = await activeLease('A-104');
      const code = (
        await t.http
          .post(`/v1/owner/leases/${ids.lease2}/invitations`)
          .set(bearer(owner))
          .send({ channel: 'link' })
          .expect(201)
      ).body.code;
      const login = await t.http
        .post('/v1/auth/resident/line')
        .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า' }) })
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
      ).body.accessToken;
      const R = bearer(resident);

      const mine = await t.http.get('/v1/resident/deposits').set(R).expect(200);
      expect((mine.body as { id: string }[]).map((d) => d.id)).toContain(ids.deposit1);
      // LIFF #9 (D-203): the move-in photo of the same checklist item is shown beside the move-out evidence
      ids.wallBefore = await photo();
      await db.admin.query(
        `UPDATE ops.inspection_item i SET photo_document_ids = ARRAY[$1::uuid]
           FROM ops.deposit_settlement s
          WHERE s.deposit_id = $2 AND i.inspection_id = s.move_in_inspection_id AND i.item_key = 'walls'`,
        [ids.wallBefore, ids.deposit1],
      );
      const view = await t.http.get(`/v1/resident/deposits/${ids.deposit1}`).set(R).expect(200);
      expect(view.body.nextActions).toEqual(['accept', 'dispute']);
      expect(view.body.deductions[0].evidenceUrls).toHaveLength(1);
      const wall = (
        view.body.deductions as { inspectionItemId: string | null; beforeEvidenceUrls: string[] }[]
      ).find((x) => x.inspectionItemId === ids.wallItem)!;
      expect(wall.beforeEvidenceUrls).toHaveLength(1);
      expect(wall.beforeEvidenceUrls[0]).not.toEqual(view.body.deductions[0].evidenceUrls[0]);
      const accepted = await t.http
        .post(`/v1/resident/deposits/${ids.deposit1}/actions/accept`)
        .set(R)
        .expect(200);
      expect(accepted.body.settlement).toMatchObject({
        status: 'agreed',
        residentResponse: 'accepted',
        agreedRefund: '3349.50',
      });
      await t.http.post(`/v1/resident/deposits/${ids.deposit1}/actions/accept`).set(R).expect(409);
    });

    it('refund: slip required, never below what is owed (no forfeiture), then statement and closed workflow', async () => {
      const O = bearer(owner);
      const noSlip = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/settlement/actions/record-refund`)
        .set(O)
        .set(idem())
        .send({ amount: '3349.50', method: 'bank_transfer' })
        .expect(422);
      expect(noSlip.body.errors[0]).toMatchObject({ path: 'evidenceDocumentId' });
      const slip = await uploadFile(t, db, owner, {
        kind: 'slip',
        scopeType: 'unit',
        scopeId: ids.unit1,
        fileName: 'slip.png',
        mimeType: 'image/png',
        body: PNG,
      });
      const short = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/settlement/actions/record-refund`)
        .set(O)
        .set(idem())
        .send({ amount: '3000.00', method: 'bank_transfer', evidenceDocumentId: slip })
        .expect(422);
      expect(short.body.code).toBe('compliance.no_forfeiture');
      const done = await t.http
        .post(`/v1/owner/deposits/${ids.deposit1}/settlement/actions/record-refund`)
        .set(O)
        .set(idem())
        .send({
          amount: '3349.50',
          method: 'bank_transfer',
          reference: 'KBANK 10:12',
          evidenceDocumentId: slip,
        })
        .expect(200);
      expect(done.body.status).toBe('forfeited_partially');
      expect(done.body.settlement).toMatchObject({
        status: 'refunded',
        refundAmount: '3349.50',
        isLate: false,
      });
      expect(done.body.settlement.statementNumber).toMatch(/^DPS-\d{4}-\d{5}$/);
      await t.http.get(`/v1/owner/deposits/${ids.deposit1}/statement`).set(O).expect(200);
      const wf = await db.admin.query(
        `SELECT i.state, i.closed_at IS NOT NULL AS closed,
                (SELECT count(*)::int FROM ops.workflow_timer t WHERE t.instance_id = i.id AND t.fired_at IS NULL AND t.cancelled_at IS NULL) AS open_timers
           FROM ops.workflow_instance i JOIN ops.deposit_settlement s ON s.workflow_instance_id = i.id WHERE s.deposit_id = $1`,
        [ids.deposit1],
      );
      expect(wf.rows[0]).toEqual({ state: 'refunded', closed: true, open_timers: 0 });
    });
  });

  describe('tenancy and RLS', () => {
    it('another tenant gets 404 on my deposits and inspections', async () => {
      const B = bearer(other.token);
      expect((await t.http.get(`/v1/owner/deposits/${ids.deposit1}`).set(B)).status).toBe(404);
      expect(
        (
          await t.http
            .post(`/v1/owner/deposits/${ids.deposit1}/settlement/items`)
            .set(B)
            .send({ kind: 'other', description: 'แอบหัก', amount: '1.00' })
        ).status,
      ).toBe(404);
      expect((await t.http.get(`/v1/owner/inspections/${ids.moveOut1}`).set(B)).status).toBe(404);
      expect(
        (await t.http.post('/v1/owner/inspections').set(B).send({ leaseId: ids.lease1, type: 'move_out' }))
          .status,
      ).toBe(404);
      expect((await t.http.get('/v1/owner/deposits').set(B).expect(200)).body.meta.total).toBe(0);
    });

    it('RLS: B2.4 rows are invisible to another tenant; the default checklist is shared', async () => {
      const count = (tenantId: string, table: string) =>
        db
          .prisma()
          .withTenant({ tenantId }, (tx) =>
            tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
          )
          .then((r) => r[0]!.n);
      for (const table of [
        'ops.deposit',
        'ops.deposit_settlement',
        'ops.deposit_settlement_item',
        'ops.inspection',
        'ops.inspection_item',
      ]) {
        const own = (
          await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [DEV.tenantId])
        ).rows[0].n;
        expect(own).toBeGreaterThan(0);
        expect({ table, n: await count(DEV.tenantId, table) }).toEqual({ table, n: own });
        expect({ table, n: await count(other.tenantId, table) }).toEqual({ table, n: 0 });
      }
      expect(await count(other.tenantId, 'ops.inspection_template')).toBe(1);
      await expect(
        db
          .prisma()
          .withTenant({ tenantId: other.tenantId }, (tx) =>
            tx.inspectionTemplate.create({ data: { tenantId: DEV.tenantId, name: 'แอบ', items: [] } }),
          ),
      ).rejects.toThrow(/row-level security/);
      // a deduction for normal wear cannot even be stored (CHECK), whatever the service does
      await expect(
        db.admin.query(
          `INSERT INTO ops.deposit_settlement_item (tenant_id, settlement_id, kind, description, amount, wear_category, evidence_document_ids)
           SELECT tenant_id, id, 'other', 'x', 1, 'normal_wear', ARRAY[gen_random_uuid()] FROM ops.deposit_settlement LIMIT 1`,
        ),
      ).rejects.toThrow(/deposit_settlement_item_wear_check/);
    });
  });

  describe('disputed settlement refunded late', () => {
    it('the resident disputes with a reason', async () => {
      const O = bearer(owner);
      const d = await depositOf(ids.lease2!);
      ids.deposit2 = d.id;
      await t.http
        .post(`/v1/owner/deposits/${ids.deposit2}/actions/record-receipt`)
        .set(O)
        .set(idem())
        .send({})
        .expect(200);
      await t.http.post(`/v1/owner/leases/${ids.lease2}/actions/begin-move-out`).set(O).expect(200);
      await t.http
        .post(`/v1/owner/leases/${ids.lease2}/actions/complete-move-out`)
        .set(O)
        .set(idem())
        .send({})
        .expect(200);
      const receipt = await uploadFile(t, db, owner, {
        kind: 'other',
        scopeType: 'unit',
        scopeId: ids.unit1,
        fileName: 'cleaning.png',
        mimeType: 'image/png',
        body: PNG,
      });
      await t.http
        .post(`/v1/owner/deposits/${ids.deposit2}/settlement/items`)
        .set(O)
        .send({
          kind: 'cleaning',
          description: 'ล้างแอร์และทำความสะอาดใหญ่',
          amount: '600.00',
          evidenceDocumentIds: [receipt],
        })
        .expect(201);
      await t.http
        .post(`/v1/owner/deposits/${ids.deposit2}/settlement/actions/propose`)
        .set(O)
        .send({})
        .expect(200);
      const R = bearer(resident);
      const empty = await t.http
        .post(`/v1/resident/deposits/${ids.deposit2}/actions/dispute`)
        .set(R)
        .send({ reason: '  ' })
        .expect(422);
      expect(empty.body.code).toBe('validation.failed');
      // LIFF #9 (D-203): dispute photos — presigned for this deposit, uploaded, attached; someone else's file refused
      const presigned = await t.http
        .post('/v1/resident/uploads')
        .set(R)
        .send({
          purpose: 'deposit_dispute',
          depositId: ids.deposit2,
          contentType: 'image/png',
          sizeBytes: PNG.length,
          sha256: createHash('sha256').update(PNG).digest('hex'),
        })
        .expect(201);
      expect(presigned.body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' } });
      const key = (
        await db.admin.query<{ storage_key: string; kind: string; created_by: string | null }>(
          'SELECT storage_key, kind::text, created_by FROM core.document WHERE id = $1',
          [presigned.body.fileId],
        )
      ).rows[0]!;
      expect(key.kind).toBe('inspection_photo');
      t.app.get<FakeObjectStorage>(OBJECT_STORAGE).putDirect(key.storage_key, PNG, 'image/png');
      const tooBig = await t.http
        .post('/v1/resident/uploads')
        .set(R)
        .send({
          purpose: 'deposit_dispute',
          depositId: ids.deposit2,
          contentType: 'image/png',
          sizeBytes: 10_000_001,
          sha256: createHash('sha256').update(PNG).digest('hex'),
        })
        .expect(422);
      expect(tooBig.body.code).toBe('validation.failed');
      const notMine = await t.http
        .post(`/v1/resident/deposits/${ids.deposit2}/actions/dispute`)
        .set(R)
        .send({ reason: 'แอร์สะอาด', photoDocumentIds: [ids.wallPhoto] })
        .expect(422);
      expect(notMine.body.code).toBe('validation.failed');
      const disputed = await t.http
        .post(`/v1/resident/deposits/${ids.deposit2}/actions/dispute`)
        .set(R)
        .send({ reason: 'แอร์สะอาดตอนคืนห้อง ดูภาพตรวจคืนห้อง', photoDocumentIds: [presigned.body.fileId] })
        .expect(200);
      expect(disputed.body.settlement.disputeDocumentIds).toEqual([presigned.body.fileId]);
      const uploaded = await db.admin.query<{ upload_state: string }>(
        'SELECT upload_state::text FROM core.document WHERE id = $1',
        [presigned.body.fileId],
      );
      expect(uploaded.rows[0]!.upload_state).not.toBe('presigned');
      const ownerView = await t.http.get(`/v1/owner/deposits/${ids.deposit2}`).set(O).expect(200);
      expect(ownerView.body.settlement.disputeDocumentIds).toEqual([presigned.body.fileId]);
      await t.http
        .post('/v1/resident/uploads')
        .set(R)
        .send({
          purpose: 'deposit_dispute',
          depositId: ids.deposit2,
          contentType: 'image/png',
          sizeBytes: PNG.length,
          sha256: createHash('sha256').update(PNG).digest('hex'),
        })
        .expect(409);
      const seeded = (
        await db.admin.query<{ id: string }>('SELECT id FROM ops.deposit WHERE lease_id = $1', [DEV.leaseId])
      ).rows[0]!.id;
      expect((await t.http.get(`/v1/resident/deposits/${seeded}`).set(R)).status).toBe(404); // not my lease
      expect(disputed.body).toMatchObject({
        status: 'disputed',
        settlement: { status: 'disputed', residentResponse: 'disputed' },
      });
    });

    it('T-3 / T-1 reminders reach the owner; the breach flags the settlement late (audit + compliance evaluation)', async () => {
      t.clock.advanceDays(8);
      await t.worker.tick();
      const s = await db.admin.query<{ id: string; is_late: boolean }>(
        'SELECT id, is_late FROM ops.deposit_settlement WHERE deposit_id = $1',
        [ids.deposit2],
      );
      expect(s.rows[0]!.is_late).toBe(true);
      const events = await db.admin.query<{ event: string }>(
        `SELECT e.event FROM ops.workflow_event e JOIN ops.deposit_settlement s ON s.workflow_instance_id = e.instance_id
          WHERE s.id = $1 AND e.event LIKE 'sla_%' ORDER BY e.occurred_at, e.id`,
        [s.rows[0]!.id],
      );
      expect(events.rows.map((r) => r.event)).toEqual(['sla_reminder', 'sla_reminder', 'sla_breached']);
      const evaluation = await db.admin.query(
        `SELECT outcome::text, context->>'trigger' AS trigger FROM platform.compliance_evaluation WHERE rule_id = 'compliance.deposit_deadline' AND subject_id = $1`,
        [s.rows[0]!.id],
      );
      expect(evaluation.rows).toEqual([{ outcome: 'warn', trigger: 'sla_breached' }]);
      const audit = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'deposit.settlement_late' AND subject_id = $1`,
        [s.rows[0]!.id],
      );
      expect(audit.rows[0].n).toBe(1);
      const reminders = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
          WHERE e.type = 'workflow.sla_reminder' AND e.payload->>'subjectId' = $1`,
        [s.rows[0]!.id],
      );
      expect(reminders.rows[0].n).toBeGreaterThan(0);
    });

    it('the refund after the deadline stays flagged late; the dashboard counts it', async () => {
      owner = await ownerToken(t); // tokens expired with the clock
      const O = bearer(owner);
      const refund = await t.http
        .post(`/v1/owner/deposits/${ids.deposit2}/settlement/actions/record-refund`)
        .set(O)
        .set(idem())
        .send({ amount: '3900.00', method: 'cash', reference: 'คืนเงินสดที่สำนักงาน' })
        .expect(200);
      expect(refund.body.settlement).toMatchObject({ status: 'refunded', isLate: true });
      const evals = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.compliance_evaluation WHERE rule_id = 'compliance.deposit_deadline' AND subject_id = $1`,
        [refund.body.settlement.id],
      );
      expect(evals.rows[0].n).toBe(1); // flagged once
      const summary = await t.http.get('/v1/owner/deposits/summary').set(O).expect(200);
      expect(summary.body.lateRefunds).toBeGreaterThanOrEqual(1);
      expect(summary.body.byStatus.held).toBeGreaterThanOrEqual(1); // the seeded deposit
      const late = await t.http.get('/v1/owner/deposits?late=true').set(O).expect(200);
      expect((late.body.data as { id: string }[]).map((d) => d.id)).toEqual([ids.deposit2]);
    });
  });
});

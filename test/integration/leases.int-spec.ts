import { fakeLineIdToken } from '@collective/integrations/line';
import { bangkokDate } from '@common/time/bangkok';
import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';
import { LeasesService } from '@modules/ops-leases/leases.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
).toString('base64');
const LINE_SUB = 'U00000000000000000000000000b2b301';
const PHONE = '+66810005678';

/** A Thai ID with a valid check digit (generated fixture, not a person). */
function thaiId(prefix12: string): string {
  const sum = [...prefix12].reduce((acc, d, i) => acc + Number(d) * (13 - i), 0);
  return `${prefix12}${(11 - (sum % 11)) % 10}`;
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * B2.3 acceptance (leases): draft → send → invite → LINE login → consent → accept → refresh → sign (OTP + LINE +
 * PDF hash) → countersign → active (occupancy, unit occupied) → 30-day notice → ending → ended (occupancy closed);
 * compliance refusals with their legal reference (deposit cap, forbidden clause), overlapping leases, invitations
 * limited to the lease's own parties, one LINE login holding leases in two tenants, cross-tenant 404s and RLS on
 * every lease table including a unit grant.
 */
describe('B2.3 leases, e-signature, notices (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let other: { tenantId: string; token: string };
  let today: string;
  const ids: Record<string, string> = {};
  let resident: { accessToken: string; refreshToken: string };

  const unitId = async (unitNo: string) =>
    (
      await db.admin.query<{ id: string }>(
        'SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = $2',
        [DEV.buildingId, unitNo],
      )
    ).rows[0]!.id;

  const createParty = (token: string, name: string, idPrefix: string) =>
    t.http
      .post('/v1/owner/parties')
      .set(bearer(token))
      .send({
        type: 'person',
        displayName: name,
        phone: PHONE,
        nationality: 'TH',
        idDocumentType: 'thai_national_id',
        idNumber: thaiId(idPrefix),
      })
      .expect(201)
      .then((r) => r.body.id as string);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_leases' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'landlord-b23',
      phone: '+660000000073',
      type: 'landlord',
    });
    today = bangkokDate(t.clock.now());
    ids.unitA102 = await unitId('A-102');
    ids.unitA101 = await unitId('A-101');
    ids.unitA104 = await unitId('A-104');
    ids.party = await createParty(owner, 'ผู้เช่า สัญญา', '110000000000');
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  describe('compliance before the draft is written', () => {
    it('deposit + advance above the cap is refused with its legal reference (compliance.deposit_cap)', async () => {
      const res = await t.http
        .post('/v1/owner/leases')
        .set(bearer(owner))
        .send({
          unitId: ids.unitA102,
          lesseePartyId: ids.party,
          startDate: today,
          rent: '4500.00',
          depositAmount: '13500.00',
          advanceRentAmount: '4500.00',
        })
        .expect(422);
      expect(res.body.code).toBe('compliance.deposit_cap');
      expect(res.body.legalRef).toContain('ข้อ 5 (2)');
      expect(res.body.errors[0]).toMatchObject({ path: 'depositAmount', code: 'depositCap' });
      const evals = await db.admin.query(
        `SELECT outcome FROM platform.compliance_evaluation WHERE rule_id = 'compliance.deposit_cap' AND subject_type = 'ops.lease'`,
      );
      expect(evals.rows).toEqual([{ outcome: 'block' }]);
      const leases = await db.admin.query('SELECT count(*)::int AS n FROM ops.lease WHERE unit_id = $1', [
        ids.unitA102,
      ]);
      expect(leases.rows[0].n).toBe(0);
    });

    it('a forbidden clause is refused (compliance.forbidden_clause), by type and by wording', async () => {
      for (const clause of [
        { type: 'renewal_fee', title: 'ค่าต่อสัญญา', text: '1,000 บาท' },
        { type: 'house_rules', title: 'ค้างชำระ', text: 'ผู้ให้เช่ามีสิทธิ์ตัดไฟและเปลี่ยนกุญแจห้อง' },
      ]) {
        const res = await t.http
          .post('/v1/owner/leases')
          .set(bearer(owner))
          .send({ unitId: ids.unitA102, lesseePartyId: ids.party, startDate: today, addendum: [clause] })
          .expect(422);
        expect(res.body.code).toBe('compliance.forbidden_clause');
        expect(res.body.legalRef).toContain('ข้อ 5');
      }
    });
  });

  describe('draft → signature → active → notice → ended', () => {
    it('drafts with room-type defaults, previews the PDF and edits with If-Match', async () => {
      const res = await t.http
        .post('/v1/owner/leases')
        .set(bearer(owner))
        .send({
          unitId: ids.unitA102,
          lesseePartyId: ids.party,
          startDate: today,
          months: 12,
          addendum: [{ type: 'pets', title: 'สัตว์เลี้ยง', text: 'อนุญาตแมวได้ 1 ตัว' }],
        })
        .expect(201);
      ids.lease = res.body.id;
      expect(res.body).toMatchObject({
        status: 'draft',
        number: null,
        unitNo: 'A-102',
        lesseeName: 'ผู้เช่า สัญญา',
        months: 12,
        currency: 'THB',
        nextActions: ['update', 'preview-contract', 'send-for-signature', 'cancel'],
      });
      expect(res.body.rent).toMatch(/^\d+\.\d{2}$/);
      expect((res.body.compliance.checks as { outcome: string }[]).every((c) => c.outcome === 'pass')).toBe(
        true,
      );

      const pdf = await t.http
        .get(`/v1/owner/leases/${ids.lease}/contract-preview`)
        .set(bearer(owner))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const decrypts = await db.admin.query(
        `SELECT metadata->>'purpose' AS purpose FROM platform.audit_log WHERE action = 'pii.decrypted' AND subject_id = $1`,
        [ids.party],
      );
      expect(decrypts.rows).toContainEqual({ purpose: 'contract_preview' });

      const current = await t.http.get(`/v1/owner/leases/${ids.lease}`).set(bearer(owner)).expect(200);
      await t.http
        .patch(`/v1/owner/leases/${ids.lease}`)
        .set(bearer(owner))
        .set('If-Match', '"stale"')
        .send({ keysCount: 2 })
        .expect(412);
      const patched = await t.http
        .patch(`/v1/owner/leases/${ids.lease}`)
        .set(bearer(owner))
        .set('If-Match', current.headers.etag!)
        .send({ keysCount: 2, rent: '4500.00', depositAmount: '4500.00', advanceRentAmount: '4500.00' })
        .expect(200);
      expect(patched.body).toMatchObject({
        keysCount: 2,
        rent: '4500.00',
        version: current.body.version + 1,
      });
    });

    it('sends for signature: number, stored contract with its sha256, unit reserved; money terms frozen', async () => {
      const res = await t.http
        .post(`/v1/owner/leases/${ids.lease}/actions/send-for-signature`)
        .set(bearer(owner))
        .set(idem())
        .expect(200);
      expect(res.body.status).toBe('pending_signature');
      expect(res.body.number).toMatch(/^CTR-\d{4}-\d{5}$/);
      expect(res.body.number).not.toBe('CTR-2026-00001'); // the seeded lease holds 00001
      expect(res.body.contract.sha256).toMatch(/^[0-9a-f]{64}$/);
      ids.contractSha = res.body.contract.sha256;
      const unit = await db.admin.query('SELECT status FROM core.unit WHERE id = $1', [ids.unitA102]);
      expect(unit.rows[0].status).toBe('reserved');
      const patch = await t.http
        .patch(`/v1/owner/leases/${ids.lease}`)
        .set(bearer(owner))
        .set('If-Match', `"${ids.lease}:${res.body.version}"`)
        .send({ rent: '5000.00' });
      expect([412, 422]).toContain(patch.status);
      if (patch.status === 422) expect(patch.body.code).toBe('compliance.no_midterm_increase');
    });

    it('Staff and Accountant never see the lessee ID number in the contract (D-172, D-222, review #5)', async () => {
      const staff = bearer(await operatorToken(t, '+660000000003'));
      const fullId = thaiId('110000000000');
      const pdfOf = (token: Record<string, string>) =>
        t.http
          .get(`/v1/owner/leases/${ids.lease}/contract-preview`)
          .set(token)
          .buffer(true)
          .parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          })
          .expect(200);
      const decrypts = async () =>
        (
          await db.admin.query(
            `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'pii.decrypted' AND subject_id = $1`,
            [ids.party],
          )
        ).rows[0].n as number;
      const before = await decrypts();
      const masked = FakePdfRenderer.textOf((await pdfOf(staff)).body as Buffer);
      expect(masked).toContain('ปกปิด');
      expect(masked).not.toContain(fullId);
      expect(await decrypts()).toBe(before); // nothing decrypted for Staff
      const full = FakePdfRenderer.textOf((await pdfOf(bearer(owner))).body as Buffer);
      expect(full).toContain(fullId);
      expect(await decrypts()).toBe(before + 1);
      // the stored contract carries the full number: Owner/Manager only, on every route
      const res = await t.http.get(`/v1/owner/leases/${ids.lease}/contract`).set(staff).expect(403);
      expect(res.body.code).toBe('auth.forbidden');
      await t.http.get(`/v1/owner/leases/${ids.lease}/contract`).set(bearer(owner)).expect(200);
      const doc = (
        await db.admin.query('SELECT contract_document_id AS id FROM ops.lease WHERE id = $1', [ids.lease])
      ).rows[0].id as string;
      expect((await t.http.get(`/v1/staff/files/${doc}`).set(staff).expect(403)).body.code).toBe(
        'auth.forbidden',
      );
      await t.http.get(`/v1/owner/files/${doc}`).set(bearer(owner)).expect(200);
    });

    it('invites the lessee; the resident signs in with LINE, must consent first, then accepts', async () => {
      const inv = await t.http
        .post(`/v1/owner/leases/${ids.lease}/invitations`)
        .set(bearer(owner))
        .send({ channel: 'line_qr' })
        .expect(201);
      expect(inv.body.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);
      ids.code = inv.body.code;
      const listed = await t.http
        .get(`/v1/owner/leases/${ids.lease}/invitations`)
        .set(bearer(owner))
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toContain(ids.code);

      const login = await t.http
        .post('/v1/auth/resident/line')
        .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า LINE' }) })
        .expect(200);
      resident = login.body;
      const R = bearer(resident.accessToken);
      const preview = await t.http.get(`/v1/resident/invitations/${ids.code}`).set(R).expect(200);
      expect(preview.body).toMatchObject({ unitNo: 'A-102', leaseStatus: 'pending_signature' });
      expect(preview.body.partyDisplayName).not.toBe('ผู้เช่า สัญญา');

      const refused = await t.http.post(`/v1/resident/invitations/${ids.code}/accept`).set(R).expect(409);
      expect(refused.body.code).toBe('consent.required');

      const purposes = await t.http.get('/v1/resident/consents').set(R).expect(200);
      await t.http
        .post('/v1/resident/consents')
        .set(R)
        .send({
          items: (purposes.body as { key: string; version: number; required: boolean }[])
            .filter((p) => p.required)
            .map((p) => ({ purposeKey: p.key, version: p.version, granted: true })),
        })
        .expect(201);
      const accepted = await t.http.post(`/v1/resident/invitations/${ids.code}/accept`).set(R).expect(200);
      expect(accepted.body).toMatchObject({
        tenantId: DEV.tenantId,
        leaseId: ids.lease,
        partyId: ids.party,
        refreshRequired: true,
      });
      await t.http.post(`/v1/resident/invitations/${ids.code}/accept`).set(R).expect(409);

      // before the refresh the token has no lease scope
      await t.http.get(`/v1/resident/leases/${ids.lease}`).set(R).expect(404);
      const refreshed = await t.http
        .post('/v1/auth/refresh')
        .send({ refreshToken: resident.refreshToken })
        .expect(200);
      resident = refreshed.body;
      expect(refreshed.body.subject.scopes).toContain(`lease:${ids.lease}`);
      const me = await t.http.get('/v1/resident/me').set(bearer(resident.accessToken)).expect(200);
      expect(me.body.leaseIds).toContain(ids.lease);
      const party = await db.admin.query('SELECT line_user_id FROM core.party WHERE id = $1', [ids.party]);
      expect(party.rows[0].line_user_id).toBe(LINE_SUB);
      const consents = await db.admin.query(
        'SELECT count(*)::int AS n FROM platform.consent WHERE tenant_id = $1 AND granted',
        [DEV.tenantId],
      );
      expect(consents.rows[0].n).toBeGreaterThan(0);
    });

    it('the resident reads the contract and signs with OTP + LINE + the PDF hash', async () => {
      const R = bearer(resident.accessToken);
      const mine = await t.http.get('/v1/resident/leases').set(R).expect(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0]).toMatchObject({
        id: ids.lease,
        signatureRequired: true,
        // the addendum has a `pets` rule: the resident may acknowledge the building rules (LIFF #8, D-203)
        nextActions: ['view-contract', 'sign', 'acknowledge-rules'],
        rulesAcknowledgedAt: null,
      });
      const contract = await t.http.get(`/v1/resident/leases/${ids.lease}/contract`).set(R).expect(200);
      expect(contract.body).toMatchObject({ sha256: ids.contractSha, signed: false });

      const otp = await t.http
        .post(`/v1/resident/leases/${ids.lease}/signature/otp`)
        .set(R)
        .send({})
        .expect(200);
      expect(otp.body.phoneMasked).toContain('5678');
      const code = t.sms.lastCodeTo(PHONE)!;
      expect(code).toMatch(/^\d{6}$/);

      const changed = await t.http
        .post(`/v1/resident/leases/${ids.lease}/sign`)
        .set(R)
        .set(idem())
        .send({ challengeId: otp.body.challengeId, code, contractSha256: 'a'.repeat(64), signaturePng: PNG })
        .expect(409);
      expect(changed.body.code).toBe('lease.contract_changed');

      const key = idem();
      const signed = await t.http
        .post(`/v1/resident/leases/${ids.lease}/sign`)
        .set(R)
        .set(key)
        .send({ challengeId: otp.body.challengeId, code, contractSha256: ids.contractSha, signaturePng: PNG })
        .expect(200);
      expect(signed.body).toMatchObject({ signatureRequired: false, status: 'pending_signature' });
      // replay with the same key returns the original response
      await t.http
        .post(`/v1/resident/leases/${ids.lease}/sign`)
        .set(R)
        .set(key)
        .send({ challengeId: otp.body.challengeId, code, contractSha256: ids.contractSha, signaturePng: PNG })
        .expect(200);
      const sig = await db.admin.query<{
        line_user_id: string;
        otp: string | null;
        sha: Buffer;
        method: string;
      }>(
        `SELECT line_user_id, otp_challenge_id AS otp, pdf_sha256 AS sha, method FROM ops.lease_signature WHERE lease_id = $1`,
        [ids.lease],
      );
      expect(sig.rows).toHaveLength(1);
      expect(sig.rows[0]!).toMatchObject({ line_user_id: LINE_SUB, method: 'draw_liff' });
      expect(sig.rows[0]!.otp).not.toBeNull();
      expect(sig.rows[0]!.sha.toString('hex')).toBe(ids.contractSha);
    });

    it('the lessor countersigns: active, occupancy from the start date, unit occupied, current lease', async () => {
      const res = await t.http
        .post(`/v1/owner/leases/${ids.lease}/actions/countersign`)
        .set(bearer(owner))
        .set(idem())
        .send({ signaturePng: PNG })
        .expect(200);
      expect(res.body.status).toBe('active');
      expect(res.body.contract.signed).toBe(true);
      expect(res.body.contract.sha256).not.toBe(ids.contractSha);
      expect((res.body.signatures as { signerRole: string }[]).map((s) => s.signerRole)).toEqual([
        'lessee',
        'lessor',
      ]);
      expect(res.body.moveInAt).not.toBeNull();
      const occ = await db.admin.query(
        'SELECT role, party_id, valid_to FROM core.occupancy WHERE lease_id = $1',
        [ids.lease],
      );
      expect(occ.rows).toEqual([{ role: 'tenant', party_id: ids.party, valid_to: null }]);
      const unit = await db.admin.query(
        'SELECT u.status, d.current_lease_id FROM core.unit u JOIN ops.unit_detail d ON d.unit_id = u.id WHERE u.id = $1',
        [ids.unitA102],
      );
      expect(unit.rows[0]).toEqual({ status: 'occupied', current_lease_id: ids.lease });
      const board = await t.http
        .get(`/v1/owner/buildings/${DEV.buildingId}/board`)
        .set(bearer(owner))
        .expect(200);
      expect(JSON.stringify(board.body)).toContain(ids.lease!);
      const contract = await t.http
        .get(`/v1/resident/leases/${ids.lease}/contract`)
        .set(bearer(resident.accessToken))
        .expect(200);
      expect(contract.body.signed).toBe(true);
      const events = await t.http.get(`/v1/owner/leases/${ids.lease}/events`).set(bearer(owner)).expect(200);
      expect((events.body as { type: string }[]).map((e) => e.type)).toEqual(
        expect.arrayContaining([
          'drafted',
          'updated',
          'sent_for_signature',
          'invitation_created',
          'invitation_accepted',
          'signed',
          'activated',
        ]),
      );
      const outbox = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.domain_event e JOIN platform.outbox_message o ON o.event_id = e.id
          WHERE e.type = 'lease.activated' AND e.aggregate_id = $1`,
        [ids.lease],
      );
      expect(outbox.rows[0].n).toBe(1);
    });

    it('a notice shorter than 30 days is refused to the resident; 30+ days is recorded', async () => {
      const R = bearer(resident.accessToken);
      const short = await t.http
        .post(`/v1/resident/leases/${ids.lease}/notice`)
        .set(R)
        .set(idem())
        .send({ effectiveDate: addDays(today, 10) })
        .expect(422);
      expect(short.body.code).toBe('compliance.notice_period');
      expect(short.body.legalRef).toContain('ข้อ 4 (11)');
      // D-229: the notice is irreversible — the key is required
      const keyless = await t.http
        .post(`/v1/resident/leases/${ids.lease}/notice`)
        .set(R)
        .send({ effectiveDate: addDays(today, 31), reason: 'ย้ายที่ทำงาน' })
        .expect(400);
      expect(keyless.body.code).toBe('idempotency.key_required');
      const key = idem();
      const ok = await t.http
        .post(`/v1/resident/leases/${ids.lease}/notice`)
        .set(R)
        .set(key)
        .send({ effectiveDate: addDays(today, 31), reason: 'ย้ายที่ทำงาน' })
        .expect(200);
      expect(ok.body).toMatchObject({
        status: 'notice_given',
        notice: { by: 'lessee', effectiveDate: addDays(today, 31) },
      });
      // the answer was lost: the retry with the same key answers the recorded notice, not 409
      const retry = await t.http
        .post(`/v1/resident/leases/${ids.lease}/notice`)
        .set(R)
        .set(key)
        .send({ effectiveDate: addDays(today, 31), reason: 'ย้ายที่ทำงาน' })
        .expect(200);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(ok.body);
      const again = await t.http
        .post(`/v1/resident/leases/${ids.lease}/notice`)
        .set(R)
        .set(idem())
        .send({ effectiveDate: addDays(today, 31), reason: 'ย้ายที่ทำงาน' })
        .expect(409);
      expect(again.body.code).toBe('lease.invalid_state');
    });
  });

  describe('overlap, tenancy and invitations across tenants', () => {
    it('two leases in force on one unit for overlapping dates are refused (lease.overlap)', async () => {
      const lessee = await createParty(owner, 'ผู้เช่า ซ้อน', '110000000001');
      const draft = await t.http
        .post('/v1/owner/leases')
        .set(bearer(owner))
        .send({ unitId: ids.unitA101, lesseePartyId: lessee, startDate: today, months: 6 })
        .expect(201);
      const sent = await t.http
        .post(`/v1/owner/leases/${draft.body.id}/actions/send-for-signature`)
        .set(bearer(owner))
        .set(idem())
        .expect(200);
      // the seeded lease on A-101 stays the unit's current lease
      const cur = await db.admin.query('SELECT current_lease_id FROM ops.unit_detail WHERE unit_id = $1', [
        ids.unitA101,
      ]);
      expect(cur.rows[0].current_lease_id).toBe(DEV.leaseId);
      // the lessee's signature recorded directly (the e-signature flow is covered above)
      await db.admin.query(
        `INSERT INTO ops.lease_signature (tenant_id, lease_id, signer_role, party_id, method, signature_image_document_id, pdf_sha256, signed_at)
         SELECT tenant_id, $1, 'lessee', $2, 'scan_upload', signature_image_document_id, decode($3, 'hex'), now()
           FROM ops.lease_signature WHERE lease_id = $4 AND signer_role = 'lessee'`,
        [draft.body.id, lessee, sent.body.contract.sha256, ids.lease],
      );
      const res = await t.http
        .post(`/v1/owner/leases/${draft.body.id}/actions/countersign`)
        .set(bearer(owner))
        .set(idem())
        .send({ signaturePng: PNG })
        .expect(409);
      expect(res.body.code).toBe('lease.overlap');
      const after = await t.http.get(`/v1/owner/leases/${draft.body.id}`).set(bearer(owner)).expect(200);
      expect(after.body.status).toBe('pending_signature');
      await t.http
        .post(`/v1/owner/leases/${draft.body.id}/actions/cancel`)
        .set(bearer(owner))
        .send({ cancelReason: 'ซ้อนกับสัญญาเดิม' })
        .expect(200);
    });

    it('renews the seeded lease into a draft after its end (deposit carried over, no advance, no renewal fee)', async () => {
      const res = await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/actions/renew`)
        .set(bearer(owner))
        .send({ months: 12, rent: '4600.00' })
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'draft',
        renewedFromLeaseId: DEV.leaseId,
        startDate: '2027-10-01',
        endDate: '2028-09-30',
        rent: '4600.00',
        advanceRentAmount: '0.00',
      });
      expect(res.body.terms.depositCarriedOverFrom).toBe(DEV.leaseId);
      ids.renewal = res.body.id;
    });

    it('terminates with a ground: missing evidence is a warning to acknowledge (D-021a), then it ends', async () => {
      const body = { reasonCode: 'mutual_agreement', effectiveDate: today, notes: 'ตกลงเลิกสัญญาร่วมกัน' };
      const warn = await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/actions/terminate`)
        .set(bearer(owner))
        .set(idem())
        .send(body)
        .expect(409);
      expect(warn.body).toMatchObject({
        code: 'compliance.acknowledgement_required',
        ruleId: 'compliance.termination_notice',
        legalTextKey: 'compliance.termination_notice.warning',
      });
      expect(warn.body.legalRef).toContain('ข้อ 4 (12)');
      const ack = await t.http
        .post('/v1/owner/compliance-acknowledgements')
        .set(bearer(owner))
        .send({
          evaluationId: warn.body.evaluationId,
          legalTextKey: warn.body.legalTextKey,
          legalTextVersion: warn.body.legalTextVersion,
          language: 'th',
        })
        .expect(201);
      const done = await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/actions/terminate`)
        .set(bearer(owner))
        .set(idem())
        .send({ ...body, acknowledgementIds: [ack.body.id] })
        .expect(200);
      expect(done.body).toMatchObject({
        status: 'terminated',
        termination: { reasonCode: 'mutual_agreement', notes: 'ตกลงเลิกสัญญาร่วมกัน' },
      });
      const unit = await db.admin.query('SELECT status FROM core.unit WHERE id = $1', [ids.unitA101]);
      expect(unit.rows[0].status).toBe('vacant');
      const occ = await db.admin.query(
        'SELECT count(*)::int AS n FROM core.occupancy WHERE lease_id = $1 AND valid_to IS NULL',
        [DEV.leaseId],
      );
      expect(occ.rows[0].n).toBe(0);
      // the renewal draft of the terminated lease is cancelled
      await t.http
        .post(`/v1/owner/leases/${ids.renewal}/actions/cancel`)
        .set(bearer(owner))
        .send({ cancelReason: 'สัญญาเดิมเลิกแล้ว' })
        .expect(200);
    });

    it('another tenant: 404 on my leases, and never leases or invites with my parties', async () => {
      const B = bearer(other.token);
      for (const path of [
        `/v1/owner/leases/${ids.lease}`,
        `/v1/owner/leases/${ids.lease}/events`,
        `/v1/owner/leases/${ids.lease}/invitations`,
      ])
        expect((await t.http.get(path).set(B)).status).toBe(404);
      expect(
        (
          await t.http
            .post(`/v1/owner/leases/${ids.lease}/actions/cancel`)
            .set(B)
            .send({ cancelReason: 'แอบยกเลิก' })
        ).status,
      ).toBe(404);
      expect((await t.http.get('/v1/owner/leases').set(B).expect(200)).body.meta.total).toBe(0);
      // a unit without a grant is not leasable for them
      expect(
        (
          await t.http
            .post('/v1/owner/leases')
            .set(B)
            .send({ unitId: ids.unitA104, lesseePartyId: ids.party, startDate: today })
        ).status,
      ).toBe(404);
    });

    it('with a unit grant the landlord leases the unit; my party cannot be put on or invited to it', async () => {
      await t.http
        .post('/v1/owner/asset-grants')
        .set(bearer(owner))
        .set(idem())
        .send({
          granteeTenantId: other.tenantId,
          buildingId: DEV.buildingId,
          unitId: ids.unitA104,
          modules: ['ops.lease'],
          access: 'write',
          reason: 'landlord_unit',
        })
        .expect(201);
      const B = bearer(other.token);
      expect(
        (
          await t.http
            .post('/v1/owner/leases')
            .set(B)
            .send({ unitId: ids.unitA104, lesseePartyId: ids.party, startDate: today })
        ).status,
      ).toBe(404);
      const theirParty = await createParty(other.token, 'ผู้เช่า ห้องฝาก', '110000000002');
      const draft = await t.http
        .post('/v1/owner/leases')
        .set(B)
        .send({
          unitId: ids.unitA104,
          lesseePartyId: theirParty,
          startDate: today,
          rent: '6000.00',
          depositAmount: '6000.00',
          advanceRentAmount: '6000.00',
        })
        .expect(201);
      ids.otherLease = draft.body.id;
      await t.http
        .post(`/v1/owner/leases/${ids.otherLease}/actions/send-for-signature`)
        .set(B)
        .set(idem())
        .expect(200);
      const foreign = await t.http
        .post(`/v1/owner/leases/${ids.otherLease}/invitations`)
        .set(B)
        .send({ channel: 'link', partyId: ids.party })
        .expect(404);
      expect(foreign.body.code).toBe('http.not_found');
      const inv = await t.http
        .post(`/v1/owner/leases/${ids.otherLease}/invitations`)
        .set(B)
        .send({ channel: 'link' })
        .expect(201);
      ids.otherCode = inv.body.code;
      // the building owner sees the lease on the granted unit (read), never changes it
      const seen = await t.http.get(`/v1/owner/leases/${ids.otherLease}`).set(bearer(owner)).expect(200);
      expect(seen.body.unitNo).toBe('A-104');
      const change = await t.http
        .post(`/v1/owner/leases/${ids.otherLease}/actions/cancel`)
        .set(bearer(owner))
        .send({ cancelReason: 'เจ้าของอาคาร' })
        .expect(403);
      expect(change.body.code).toBe('asset.read_only');
    });

    it('one LINE login linked in two tenants sees both leases', async () => {
      const R = bearer(resident.accessToken);
      await t.http.post(`/v1/resident/invitations/${ids.otherCode}/accept`).set(R).expect(200);
      const refreshed = await t.http
        .post('/v1/auth/refresh')
        .send({ refreshToken: resident.refreshToken })
        .expect(200);
      resident = refreshed.body;
      const mine = await t.http.get('/v1/resident/leases').set(bearer(resident.accessToken)).expect(200);
      expect((mine.body as { id: string; tenantId: string }[]).map((l) => [l.id, l.tenantId]).sort()).toEqual(
        [
          [ids.lease, DEV.tenantId],
          [ids.otherLease, other.tenantId],
        ].sort(),
      );
      await t.http.get(`/v1/resident/leases/${ids.otherLease}`).set(bearer(resident.accessToken)).expect(200);
    });

    it('a resident never opens a lease outside their scope', async () => {
      const R = bearer(resident.accessToken);
      expect((await t.http.get(`/v1/resident/leases/${DEV.leaseId}`).set(R)).status).toBe(404);
      expect((await t.http.get(`/v1/resident/leases/${DEV.leaseId}/contract`).set(R)).status).toBe(404);
    });
  });

  describe('RLS on the B2.3 tables', () => {
    const count = (tenantId: string, table: string) =>
      db
        .prisma()
        .withTenant({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
        )
        .then((r) => r[0]!.n);

    it('lease rows: own tenant, plus the granted unit for the grantee and the building owner', async () => {
      const own = await db.admin.query<{ table: string; n: number }>(
        `SELECT 'ops.lease' AS table, count(*)::int AS n FROM ops.lease WHERE tenant_id = $1`,
        [DEV.tenantId],
      );
      // DEV sees its own leases + the landlord's lease on its building's unit A-104
      expect(await count(DEV.tenantId, 'ops.lease')).toBe(own.rows[0]!.n + 1);
      // the landlord sees its lease on A-104 only (unit grant), never the DEV leases on other units
      expect(await count(other.tenantId, 'ops.lease')).toBe(1);
      for (const table of ['ops.lease_party', 'ops.lease_line', 'ops.lease_signature', 'ops.lease_event']) {
        const theirs = (
          await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [
            other.tenantId,
          ])
        ).rows[0].n;
        expect({ table, n: await count(other.tenantId, table) }).toEqual({ table, n: theirs });
      }
      const third = (
        await db.admin.query<{ id: string }>(
          `INSERT INTO core.tenant (slug, display_name, legal_name, legal_form) VALUES ('third-b23', 'Third', 'Third Co.', 'company') RETURNING id`,
        )
      ).rows[0]!.id;
      for (const table of [
        'ops.lease',
        'ops.lease_party',
        'ops.lease_line',
        'ops.lease_signature',
        'ops.lease_event',
      ])
        expect({ table, n: await count(third, table) }).toEqual({ table, n: 0 });
      // platform templates are shared reference data
      expect(await count(third, 'ops.lease_template')).toBeGreaterThan(0);
      expect(await count(third, 'ops.lease_template_version')).toBeGreaterThan(0);
    });

    it('writes stamped with another tenant are refused; lease history is append-only', async () => {
      await expect(
        db.prisma().withTenant({ tenantId: other.tenantId }, (tx) =>
          tx.leaseEvent.create({
            data: {
              tenantId: DEV.tenantId,
              leaseId: ids.lease!,
              type: 'forged',
              occurredAt: new Date(),
              actor: {},
              data: {},
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        db.admin.query('UPDATE ops.lease_event SET type = $1 WHERE lease_id = $2', ['x', ids.lease]),
      ).rejects.toThrow();
      await expect(
        db.admin.query('DELETE FROM ops.lease_event WHERE lease_id = $1', [ids.lease]),
      ).rejects.toThrow();
      await expect(
        db
          .prisma()
          .withTenant({ tenantId: other.tenantId }, (tx) =>
            tx.leaseTemplate.create({ data: { tenantId: DEV.tenantId, key: 'forged', name: 'x' } }),
          ),
      ).rejects.toThrow(/row-level security/);
    });
  });
  describe('after the notice date (runs last: moves the clock)', () => {
    it('the notice date starts the move-out; completing it ends the lease and closes the occupancy', async () => {
      t.clock.advanceDays(32);
      expect(await t.app.get(LeasesService).sweep()).toBeGreaterThan(0);
      owner = await ownerToken(t); // the earlier tokens expired
      resident = (
        await t.http
          .post('/v1/auth/resident/line')
          .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า LINE' }) })
          .expect(200)
      ).body;
      const ending = await t.http.get(`/v1/owner/leases/${ids.lease}`).set(bearer(owner)).expect(200);
      expect(ending.body.status).toBe('ending');
      const ended = await t.http
        .post(`/v1/owner/leases/${ids.lease}/actions/complete-move-out`)
        .set(bearer(owner))
        .set(idem())
        .send({})
        .expect(200);
      expect(ended.body.status).toBe('ended');
      const occ = await db.admin.query(
        'SELECT valid_to, moved_out_at FROM core.occupancy WHERE lease_id = $1',
        [ids.lease],
      );
      expect(occ.rows[0].valid_to).not.toBeNull();
      expect(occ.rows[0].moved_out_at).not.toBeNull();
      const unit = await db.admin.query(
        'SELECT u.status, d.current_lease_id FROM core.unit u JOIN ops.unit_detail d ON d.unit_id = u.id WHERE u.id = $1',
        [ids.unitA102],
      );
      expect(unit.rows[0]).toEqual({ status: 'vacant', current_lease_id: null });
      // ended leases stay readable by the resident (history), never editable
      const R = bearer(resident.accessToken);
      expect((await t.http.get(`/v1/resident/leases/${ids.lease}`).set(R).expect(200)).body.status).toBe(
        'ended',
      );
    });
  });
});

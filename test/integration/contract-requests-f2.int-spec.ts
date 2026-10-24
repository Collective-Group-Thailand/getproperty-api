import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { fakeLineIdToken } from '@collective/integrations/line';
import {
  type FakePaymentProviders,
  fakeWebhookSecret,
  PAYMENT_PROVIDERS,
} from '@collective/integrations/payments/qr';
import { RealtimeHub } from '@core/realtime/realtime.hub';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const LINE_SUB = 'U00000000000000000000000000f2cr01';
const MERCHANT = '010555000000f21';
const PHONE_B = '+660000000172';
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
);
const slipImage = (j: Record<string, string>) =>
  Buffer.concat([PNG, Buffer.from(JSON.stringify(j))]).toString('base64');

/**
 * Consumer contract requests answered before B5 (docs/contract-requests-triage.md, D-208, D-209). Web F2: lease
 * compliance dry run, unit-profile GET + ETag, meter photo per segment, invoice QR payload, invoice delivery log,
 * reading requests with an assignee, receipt resend, meter health + last reading, one meter by asset item, loss
 * report CSV export, public pricing from the price-plan tables. LIFF: invoice line disclosure + unit (#15), billing
 * events on resident channels (#16), slip outcomes (#17), idempotent slips (#18), receipts of an invoice and one
 * receipt (#19), the full receiving account (#20), lease dates on /me (#21). Cross-tenant 404s.
 */
describe('contract requests before B5 (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let staff: string;
  let resident: string;
  let other: { tenantId: string; token: string };
  let unitId = '';
  let electricMeter = '';
  let electricAssignment = '';
  let fake: ReturnType<FakePaymentProviders['adapter']>;
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  const R = () => bearer(resident);
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_crf2' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-crf2',
      phone: PHONE_B,
      type: 'apartment',
    });
    unitId = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
    const m = (
      await q<{ id: string; asset_item_id: string }>(
        `SELECT id, asset_item_id FROM core.meter_assignment WHERE unit_id = $1 AND utility = 'electric' AND valid_to IS NULL`,
        [unitId],
      )
    )[0]!;
    electricAssignment = m.id;
    electricMeter = m.asset_item_id;
    fake = t.app.get<FakePaymentProviders>(PAYMENT_PROVIDERS).adapter('kbank');
    const account = await t.http
      .post('/v1/owner/bank-accounts')
      .set(O())
      .set(idem())
      .send({
        bankCode: '004',
        bankNameTh: 'ธนาคารตัวอย่าง',
        accountNo: '123-4-56789-0',
        accountName: 'บริษัท ตัวอย่าง จำกัด',
        isDefault: true,
        paymentProvider: 'kbank',
        providerMerchantRef: MERCHANT,
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/bank-accounts/${account.body.account.id}/actions/confirm`)
      .set(O())
      .send({ challengeId: account.body.otp.challengeId, code: t.sms.lastCodeTo('+660000000001') })
      .expect(200);
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
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า F2' }) })
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
    ).body.accessToken as string;
    void fakeWebhookSecret;
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  describe('owner console (web F2)', () => {
    it('POST /v1/owner/leases/compliance-preview: checks, problems and defaults; nothing written', async () => {
      const unit = (
        await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-102'`, [
          DEV.buildingId,
        ])
      )[0]!.id;
      const before = (await q<{ n: number }>('SELECT count(*)::int AS n FROM ops.lease'))[0]!.n;
      const evals = (
        await q<{ n: number }>('SELECT count(*)::int AS n FROM platform.compliance_evaluation')
      )[0]!.n;
      const body = {
        unitId: unit,
        lesseePartyId: DEV.residentPartyId,
        startDate: '2026-12-01',
        months: 12,
        rent: '4500.00',
        depositAmount: '45000.00',
      };
      const res = await t.http.post('/v1/owner/leases/compliance-preview').set(O()).send(body).expect(200);
      expect(res.body.inScope).toBe(true);
      const cap = (res.body.checks as { ruleId: string; outcome: string; legalRef: string }[]).find(
        (c) => c.ruleId === 'compliance.deposit_cap',
      );
      expect(cap).toMatchObject({
        outcome: expect.stringMatching(/^(warn|block)$/),
        legalRef: expect.any(String),
      });
      expect(res.body.problems).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'compliance.deposit_cap' })]),
      );
      expect(res.body.defaults).toMatchObject({
        rent: '4500.00',
        depositAmount: expect.stringMatching(/^\d+\.\d{2}$/),
        months: 12,
        endDate: '2027-11-30',
      });
      // a clean draft has no problems
      const ok = await t.http
        .post('/v1/owner/leases/compliance-preview')
        .set(O())
        .send({ ...body, depositAmount: '4500.00', advanceRentAmount: '4500.00' })
        .expect(200);
      expect(ok.body.problems).toEqual([]);
      expect((ok.body.checks as { outcome: string }[]).every((c) => c.outcome === 'pass')).toBe(true);
      expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM ops.lease'))[0]!.n).toBe(before);
      expect(
        (await q<{ n: number }>('SELECT count(*)::int AS n FROM platform.compliance_evaluation'))[0]!.n,
      ).toBe(evals);
      // another tenant's unit is a 404
      await t.http
        .post('/v1/owner/leases/compliance-preview')
        .set(bearer(other.token))
        .send(body)
        .expect(404);
    });

    it('GET /v1/owner/unit-profiles/{id} answers an ETag the PATCH accepts; 404 for another tenant', async () => {
      const created = await t.http
        .post(`/v1/owner/buildings/${DEV.buildingId}/unit-profiles`)
        .set(O())
        .send({ name: 'ห้องทดสอบ F2', defaultRent: '5100' })
        .expect(201);
      const got = await t.http.get(`/v1/owner/unit-profiles/${created.body.id}`).set(O()).expect(200);
      expect(got.headers.etag).toBeTruthy();
      expect(got.body).toMatchObject({ id: created.body.id, defaultRent: '5100.00' });
      await t.http
        .patch(`/v1/owner/unit-profiles/${created.body.id}`)
        .set(O())
        .set('If-Match', got.headers.etag as string)
        .send({ defaultRent: '5200' })
        .expect(200);
      await t.http
        .patch(`/v1/owner/unit-profiles/${created.body.id}`)
        .set(O())
        .set('If-Match', got.headers.etag as string)
        .send({ defaultRent: '5300' })
        .expect(412);
      await t.http.get(`/v1/owner/unit-profiles/${created.body.id}`).set(bearer(other.token)).expect(404);
    });

    it('reading requests: per meter with an assignee, the round shows it, the staff reading fulfils it', async () => {
      await t.http
        .put('/v1/owner/settings/readings.round_window_days')
        .set(O())
        .send({ value: 31, reason: 'test: whole month' })
        .expect(200);
      const now = t.clock.now();
      ids.cycle = (
        await q<{ id: string }>(
          `INSERT INTO ops.billing_cycle (tenant_id, property_id, period_key, period_start, period_end, cut_off_at, status,
                                          readings_window_minutes, grace_deadline_at, estimate_policy)
           VALUES ($1, $2, '2026-09', '2026-09-01', '2026-09-30', $3, 'readings_pending', 120, $4, 'block')
           RETURNING id`,
          [DEV.tenantId, DEV.propertyId, now, new Date(now.getTime() + 3 * 86_400_000)],
        )
      )[0]!.id;
      const cycle = await t.http.get(`/v1/owner/billing-cycles/${ids.cycle}`).set(O()).expect(200);
      expect(cycle.body.nextActions).toContain('request-readings');
      // an assignee who is not a member of the tenant is refused
      await t.http
        .post(`/v1/owner/billing-cycles/${ids.cycle}/actions/request-readings`)
        .set(O())
        .send({ meterAssignmentIds: [electricAssignment], assigneeUserId: randomUUID() })
        .expect(422);
      const res = await t.http
        .post(`/v1/owner/billing-cycles/${ids.cycle}/actions/request-readings`)
        .set(O())
        .send({ meterAssignmentIds: [electricAssignment], assigneeUserId: DEV.users.staff })
        .expect(200);
      expect(res.body.requests).toEqual([
        expect.objectContaining({
          meterAssignmentId: electricAssignment,
          assetItemId: electricMeter,
          assigneeUserId: DEV.users.staff,
          status: 'open',
        }),
      ]);
      // repeating re-assigns the same open request (one per meter)
      const again = await t.http
        .post(`/v1/owner/billing-cycles/${ids.cycle}/actions/request-readings`)
        .set(O())
        .send({ meterAssignmentIds: [electricAssignment], assigneeUserId: DEV.users.staff })
        .expect(200);
      expect(again.body.requests[0].id).toBe(res.body.requests[0].id);
      await settle();
      const notified = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
          WHERE e.type = 'reading.requested' AND n.recipient_id = $1`,
        [DEV.users.staff],
      );
      expect(notified[0]!.n).toBeGreaterThan(0);
      const round = await t.http.get('/v1/staff/reading-rounds/current').set(bearer(staff)).expect(200);
      const items = (round.body as { floors: { items: Record<string, unknown>[] }[] }[]).flatMap((b) =>
        b.floors.flatMap((f) => f.items),
      );
      expect(items.find((i) => i.meterAssignmentId === electricAssignment)).toMatchObject({
        requested: true,
        assignee: { userId: DEV.users.staff, displayName: expect.any(String) },
      });
      // the staff reading fulfils the request
      const photo = await uploadFile(t, db, staff, {
        kind: 'meter_photo',
        scopeType: 'building',
        scopeId: DEV.buildingId,
        fileName: 'meter.jpg',
        mimeType: 'image/jpeg',
        body: Buffer.from('fake-jpeg-meter-photo-f2'),
        surface: 'staff',
      });
      ids.meterPhoto = photo;
      await t.http
        .post('/v1/staff/meter-readings')
        .set(bearer(staff))
        .set(idem())
        .send({
          assetItemId: electricMeter,
          photoDocumentId: photo,
          typedValue: '120.000',
          readAt: now.toISOString(),
        })
        .expect(201);
      await settle();
      const req = await q<{ status: string; fulfilled_reading_id: string | null }>(
        'SELECT status::text, fulfilled_reading_id FROM smart.reading_request WHERE id = $1',
        [res.body.requests[0].id],
      );
      expect(req[0]).toMatchObject({ status: 'fulfilled', fulfilled_reading_id: expect.any(String) });
      // another tenant cannot request readings of this cycle
      await t.http
        .post(`/v1/owner/billing-cycles/${ids.cycle}/actions/request-readings`)
        .set(bearer(other.token))
        .send({})
        .expect(404);
    });

    it('meters carry health and the last reading; GET /v1/owner/meters/{assetItemId}; 404 for another tenant', async () => {
      const one = await t.http.get(`/v1/owner/meters/${electricMeter}`).set(O()).expect(200);
      expect(one.body).toMatchObject({
        assetItemId: electricMeter,
        buildingId: DEV.buildingId,
        unitNo: 'A-101',
        lastReading: { register: '120.000', photoDocumentId: ids.meterPhoto },
      });
      const list = await t.http.get(`/v1/owner/buildings/${DEV.buildingId}/meters`).set(O()).expect(200);
      expect(
        (list.body as { assetItemId: string }[]).find((x) => x.assetItemId === electricMeter),
      ).toMatchObject({ lastReading: { register: '120.000' } });
      await t.http.get(`/v1/owner/meters/${electricMeter}`).set(bearer(other.token)).expect(404);
      await t.http.get(`/v1/owner/meters/${randomUUID()}`).set(O()).expect(404);
    });

    it('an issued invoice: QR payload, meter photo per segment, delivery log, resend; 404 for another tenant', async () => {
      const tariff = (
        await q<{ id: string }>(
          `SELECT v.id FROM platform.utility_tariff_version v JOIN platform.utility_tariff u ON u.id = v.utility_tariff_id
            WHERE u.utility = 'electric' ORDER BY v.effective_from DESC LIMIT 1`,
        )
      )[0]!.id;
      const reading = (
        await q<{ id: string }>(
          `SELECT id FROM smart.meter_reading WHERE meter_assignment_id = $1 ORDER BY read_at DESC LIMIT 1`,
          [electricAssignment],
        )
      )[0]!.id;
      const inv = (
        await q<{ id: string }>(
          `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end,
                                    subtotal, total, balance)
           VALUES ($1, $2, $3, $4, $5, '2026-09-01', '2026-09-30', 4860.00, 4860.00, 4860.00) RETURNING id`,
          [DEV.tenantId, DEV.buildingId, unitId, DEV.residentPartyId, DEV.leaseId],
        )
      )[0]!.id;
      ids.inv = inv;
      await q(
        `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount)
         VALUES ($1, $2, 1, 'rent', 'rent', 'ค่าเช่าห้อง A-101', 1, 'month', 4500, 4500)`,
        [DEV.tenantId, inv],
      );
      const segments = [
        {
          assignmentId: electricAssignment,
          assetItemId: electricMeter,
          code: 'A-101-E',
          multiplier: '1.000000',
          rolloverAt: '99999.999',
          from: {
            readingId: null,
            register: '0.000',
            readAt: '2026-09-01T00:00:00.000Z',
            source: 'assignment',
            confidence: null,
            isEstimated: false,
            evidenceDocumentId: null,
          },
          to: {
            readingId: reading,
            register: '120.000',
            readAt: '2026-09-30T11:00:00.000Z',
            source: 'ocr',
            confidence: '0.950',
            isEstimated: false,
            evidenceDocumentId: ids.meterPhoto,
          },
        },
      ];
      await q(
        `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit,
                                       unit_price, amount, asset_item_id, meter_assignment_id, register_from, register_to,
                                       units, reading_source, meter_segments, utility_tariff_version_id, cap_per_unit)
         VALUES ($1, $2, 2, 'meter', 'electricity', 'ค่าไฟฟ้า 120 หน่วย × 3.0000', 120, 'kwh', 3, 360, $3, $4, 0, 120, 120,
                 'ocr', $5::jsonb, $6, 4.5)`,
        [DEV.tenantId, inv, electricMeter, electricAssignment, JSON.stringify(segments), tariff],
      );
      const issued = await t.http
        .post(`/v1/owner/invoices/${inv}/actions/issue`)
        .set(O())
        .set(idem())
        .send({})
        .expect(200);
      ids.invNumber = issued.body.number as string;
      await settle();
      const qr = (
        await q<{ payload: string }>(
          `SELECT payload FROM ops.payment_qr_code WHERE invoice_id = $1 AND status = 'active'`,
          [inv],
        )
      )[0]!.payload;
      const got = await t.http.get(`/v1/owner/invoices/${inv}`).set(O()).expect(200);
      expect(got.body.qrPayload).toBe(qr);
      const meterLine = (
        got.body.lines as { lineKind: string; meterSegments: Record<string, unknown>[] }[]
      ).find((l) => l.lineKind === 'electricity')!;
      expect(meterLine.meterSegments[0]).toMatchObject({
        from: { photoDocumentId: null },
        to: { photoDocumentId: ids.meterPhoto, readingId: reading },
      });
      // delivery log: the first send once payable, then a resend
      await t.http.post(`/v1/owner/invoices/${inv}/actions/resend`).set(O()).set(idem()).expect(200);
      await settle();
      const log = await t.http.get(`/v1/owner/invoices/${inv}/deliveries`).set(O()).expect(200);
      const kinds = (log.body.data as { kind: string; channel: string; status: string }[]).map((d) => d.kind);
      expect(kinds).toEqual(expect.arrayContaining(['issue', 'resend']));
      expect(log.body.data[0]).toMatchObject({ channel: 'line', at: expect.any(String) });
      await t.http.get(`/v1/owner/invoices/${inv}/deliveries`).set(bearer(other.token)).expect(404);
    });

    it('ExportKind loss_report_csv: the loss report with suspects as a UTF-8 CSV', async () => {
      await t.http
        .post(`/v1/owner/buildings/${DEV.buildingId}/utility-accounts`)
        .set(O())
        .send({ utility: 'electric', provider: 'mea', customerNo: '000099990001', label: 'MEA main' })
        .expect(201);
      await t.http
        .post(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices`)
        .set(O())
        .set(idem())
        .send({
          utility: 'electric',
          provider: 'mea',
          periodStart: '2026-08-28',
          periodEnd: '2026-09-27',
          invoiceNo: 'MEA-F2-0001',
          units: '1400.000',
          amount: '6000.00',
        })
        .expect(201);
      await t.http
        .post('/v1/owner/exports')
        .set(O())
        .set(idem())
        .send({ kind: 'loss_report_csv', params: { buildingId: DEV.buildingId } })
        .expect(422);
      const job = await t.http
        .post('/v1/owner/exports')
        .set(O())
        .set(idem())
        .send({
          kind: 'loss_report_csv',
          params: { buildingId: DEV.buildingId, utility: 'electric', period: '2026-09' },
        })
        .expect(202);
      await settle();
      const done = await t.http.get(`/v1/owner/exports/${job.body.id}`).set(O()).expect(200);
      expect(done.body).toMatchObject({
        kind: 'loss_report_csv',
        status: 'done',
        rowCount: expect.any(Number),
      });
      const file = await q<{ storage_key: string }>(
        `SELECT d.storage_key FROM core.document d JOIN ops.export_job j ON j.file_document_id = d.id WHERE j.id = $1`,
        [job.body.id],
      );
      expect(file).toHaveLength(1);
    });
  });

  describe('resident app (LIFF)', () => {
    it('#21 /me leases carry the term; #15 invoice lines with source type, reading time, photo and unit', async () => {
      const me = await t.http.get('/v1/resident/me').set(R()).expect(200);
      expect(me.body.leases[0]).toMatchObject({
        startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        endDate: expect.anything(),
      });
      const inv = await t.http.get(`/v1/resident/invoices/${ids.inv}`).set(R()).expect(200);
      expect(inv.body).toMatchObject({ unitId, receipts: [] });
      const lines = inv.body.lines as Record<string, unknown>[];
      expect(lines.find((l) => l.lineKind === 'rent')).toMatchObject({
        sourceType: 'rent',
        readAt: null,
        readingPhotoUrl: null,
      });
      expect(lines.find((l) => l.lineKind === 'electricity')).toMatchObject({
        sourceType: 'meter',
        readAt: expect.stringContaining('2026-09-30'),
        readingPhotoUrl: expect.stringMatching(/^https?:\/\//),
        units: '120.000',
        aboveCap: false,
      });
      const list = await t.http.get('/v1/resident/invoices').set(R()).expect(200);
      expect((list.body.data as { id: string; unitId: string }[]).find((i) => i.id === ids.inv)!.unitId).toBe(
        unitId,
      );
    });

    it('#20 the payment page shows the full receiving account while something is due (audited)', async () => {
      const page = await t.http.get(`/v1/resident/invoices/${ids.inv}/payment`).set(R()).expect(200);
      expect(page.body.account).toMatchObject({
        accountNo: '1234567890',
        bankCode: '004',
        accountNoMasked: expect.stringMatching(/7890$/),
      });
      const audit = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform.audit_log
          WHERE action = 'pii.decrypted' AND metadata->>'purpose' = 'resident_transfer' AND metadata->>'invoiceId' = $1`,
        [ids.inv],
      );
      expect(audit[0]!.n).toBeGreaterThanOrEqual(1);
    });

    it('#18 a slip retried with the same Idempotency-Key is one slip; #17 my slips with their outcome', async () => {
      const key = randomUUID();
      const body = {
        image: slipImage({
          transRef: 'SLIP-F2-0001',
          amount: '100.00',
          receiverBankCode: '004',
          receiverAccount: 'xxx-x-x7890-x',
        }),
        mimeType: 'image/png',
      };
      const first = await t.http
        .post(`/v1/resident/invoices/${ids.inv}/slips`)
        .set(R())
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const second = await t.http
        .post(`/v1/resident/invoices/${ids.inv}/slips`)
        .set(R())
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(
        (
          await q<{ n: number }>('SELECT count(*)::int AS n FROM ops.slip_review WHERE invoice_id = $1', [
            ids.inv,
          ])
        )[0]!.n,
      ).toBe(1);
      await settle();
      const mine = await t.http.get(`/v1/resident/invoices/${ids.inv}/slips`).set(R()).expect(200);
      expect(mine.body.data).toEqual([
        expect.objectContaining({
          id: first.body.id,
          status: 'pending_review',
          reasons: ['amount_below_due'],
          decidedAt: null,
        }),
      ]);
      await t.http.get(`/v1/resident/invoices/${randomUUID()}/slips`).set(R()).expect(404);
    });

    it('#16 billing events reach the unit channel; #19 receipts of the invoice and one receipt; receipt resend', async () => {
      const heard: string[] = [];
      const heardByUser: string[] = [];
      const heardElsewhere: string[] = [];
      const residentUserId = (
        await q<{ id: string }>(
          `SELECT u.id FROM core.user_account u
            WHERE u.line_user_id = $1
               OR u.id IN (SELECT user_id FROM core.user_identity WHERE provider_subject = $1)
            LIMIT 1`,
          [LINE_SUB],
        )
      )[0]?.id;
      const otherUnit = (
        await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND id <> $2 LIMIT 1`, [
          DEV.buildingId,
          unitId,
        ])
      )[0]!.id;
      const hub = t.app.get(RealtimeHub);
      const keep = (into: string[]) => (m: { type?: string }) => {
        if (m.type && m.type !== 'ready' && m.type !== 'heartbeat') into.push(m.type);
      };
      const sub = hub.stream([`unit:${unitId}`]).subscribe(keep(heard));
      sub.add(hub.stream([`user:${residentUserId}`]).subscribe(keep(heardByUser)));
      sub.add(hub.stream([`unit:${otherUnit}`]).subscribe(keep(heardElsewhere)));
      try {
        const ref = (
          await q<{ r: string }>('SELECT promptpay_ref AS r FROM ops.invoice WHERE id = $1', [ids.inv])
        )[0]!.r;
        const cb = fake.simulatePayment({
          merchantRef: MERCHANT,
          reference: ref,
          amount: '4860.00',
          providerRef: 'KB-F2-0001',
          paidAt: t.clock.now(),
        });
        await t.http
          .post('/webhooks/payments/kbank')
          .set(cb.headers)
          .set('content-type', 'application/json')
          .send(cb.body)
          .expect(200);
        await settle(6);
      } finally {
        sub.unsubscribe();
      }
      expect(heard).toEqual(expect.arrayContaining(['payment.confirmed', 'invoice.paid', 'receipt.issued']));
      // the resident's own login hears it too; another unit of the building does not
      expect(residentUserId).toBeDefined();
      expect(heardByUser).toEqual(expect.arrayContaining(['payment.confirmed', 'invoice.paid']));
      expect(heardElsewhere).not.toContain('payment.confirmed');
      expect(heardElsewhere).not.toContain('invoice.paid');
      const inv = await t.http.get(`/v1/resident/invoices/${ids.inv}`).set(R()).expect(200);
      expect(inv.body.status).toBe('paid');
      expect(inv.body.receipts).toEqual([{ id: expect.any(String), number: expect.any(String) }]);
      const receiptId = inv.body.receipts[0].id as string;
      const receipt = await t.http.get(`/v1/resident/receipts/${receiptId}`).set(R()).expect(200);
      expect(receipt.body).toMatchObject({
        id: receiptId,
        voided: false,
        invoices: [{ id: ids.inv, number: ids.invNumber }],
      });
      await t.http.get(`/v1/resident/receipts/${randomUUID()}`).set(R()).expect(404);
      // nothing due: the full account is not revealed any more
      const page = await t.http.get(`/v1/resident/invoices/${ids.inv}/payment`).set(R()).expect(200);
      expect(page.body.account.accountNo).toBeNull();
      // the owner sends the receipt again
      const resent = await t.http
        .post(`/v1/owner/receipts/${receiptId}/actions/resend`)
        .set(O())
        .set(idem())
        .expect(200);
      expect(resent.body).toMatchObject({ receiptId, channel: 'line' });
      await settle();
      const planned = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
          WHERE e.type = 'receipt.resent' AND e.aggregate_id = $1`,
        [receiptId],
      );
      expect(planned[0]!.n).toBeGreaterThan(0);
      await t.http
        .post(`/v1/owner/receipts/${receiptId}/actions/resend`)
        .set(bearer(other.token))
        .set(idem())
        .expect(404);
    });
  });

  describe('public (web)', () => {
    it('GET /v1/public/plans reads the price-plan tables: sold plans and proposals', async () => {
      const res = await t.http.get('/v1/public/plans').expect(200);
      const byKey = Object.fromEntries((res.body.data as { key: string }[]).map((p) => [p.key, p]));
      expect(byKey.apartment_starter).toMatchObject({
        pricePerUnit: '25.00',
        sold: true,
        effectiveFrom: '2026-01-01',
      });
      expect(byKey.meter_rental).toMatchObject({ priceUnit: 'meter_point_month', sold: true });
      expect(byKey.condo_juristic).toMatchObject({ sold: false, effectiveFrom: null, priceFrom: '10.00' });
    });
  });
});

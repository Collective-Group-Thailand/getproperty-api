import 'reflect-metadata';

import { ETAX_PROVIDERS } from '@integrations/etax/etax-provider.port';
import { type FakeEtaxProviders } from '@integrations/etax/fake-etax-provider';
import { type FakeObjectStorage } from '@integrations/s3/fake-object-storage';
import { OBJECT_STORAGE } from '@integrations/s3/object-storage.port';
import { EtaxService } from '@modules/ops-etax/etax.service';
import { readXlsx } from '@modules/ops-receivables/exports/sheets';
import { Tm30Service } from '@modules/ops-tm30/tm30.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
).toString('base64');

/**
 * B6.2 acceptance (docs/prompts/B6-platform-launch.md 6.2, D-050, D-052, D-215, D-216): a receipt of a VAT-registered
 * tenant with e-Tax enabled is submitted to the (fake) service provider, signed, its signed XML / PDF stored and the
 * signed PDF sent to the payer; failures retry, rejections reach the owner and can be sent again; the monthly figures
 * and register. A foreign lessee's move-in opens the TM30 duty (24 h, workflow engine: reminder, breach), the
 * Immigration Bureau upload file is generated per building with the passport decrypted, the submission is recorded.
 */
describe('B6.2 e-Tax & TM30 (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let other: { tenantId: string; token: string };
  let unitA101: string;
  let month = 0;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const O = () => bearer(owner);
  /** Access tokens are short-lived: sign in again after the clock jumped. */
  const relogin = async () => {
    owner = await ownerToken(t);
    other = { ...other, token: await operatorToken(t, '+660000000281') };
  };
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const fake = () => t.app.get<FakeEtaxProviders>(ETAX_PROVIDERS).inet;
  const count = (tenantId: string, table: string) =>
    db
      .prisma()
      .withTenant({ tenantId }, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`),
      )
      .then((r) => r[0]!.n);
  const etax = () => t.app.get(EtaxService);

  /** A draft invoice for A-101 issued through the API, then paid in cash: the receipt follows in the worker. */
  async function paidInvoice(
    subtotal: string,
    vat = '0.00',
  ): Promise<{ invoiceId: string; paymentId: string }> {
    month += 1;
    const start = `2025-${String(month).padStart(2, '0')}-01`;
    const total = (Number(subtotal) + Number(vat)).toFixed(2);
    const [inv] = await q<{ id: string }>(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end,
                                subtotal, vat_amount, total, balance)
       VALUES ($1, $2, $3, $4, $5, $6::date, ($6::date + interval '1 month - 1 day')::date, $7, $8, $9, $9)
       RETURNING id`,
      [DEV.tenantId, DEV.buildingId, unitA101, DEV.residentPartyId, DEV.leaseId, start, subtotal, vat, total],
    );
    await q(
      `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount)
       VALUES ($1, $2, 1, 'rent', 'rent', 'ค่าเช่าห้อง A-101', 1, 'month', $3, $3)`,
      [DEV.tenantId, inv!.id, subtotal],
    );
    await t.http
      .post(`/v1/owner/invoices/${inv!.id}/actions/issue`)
      .set(O())
      .set(idem())
      .send({})
      .expect(200);
    await settle();
    const pay = await t.http.post('/v1/owner/payments').set(O()).set(idem()).send({
      invoiceId: inv!.id,
      amount: total,
      method: 'cash',
      paidAt: t.clock.now().toISOString(),
      reference: 'เงินสด',
    });
    if (pay.status !== 201 && pay.status !== 200) throw new Error(JSON.stringify(pay.body));
    await settle();
    return { invoiceId: inv!.id, paymentId: pay.body.id as string };
  }

  const submissionOf = async (paymentId: string) =>
    (
      await q<{
        id: string;
        status: string;
        subject_type: string;
        document_type_code: string;
        number: string;
        attempts: number;
        signed_pdf_document_id: string | null;
        signed_xml_document_id: string | null;
        source_document_id: string | null;
        vat_amount: string;
        error: string | null;
      }>(
        `SELECT s.id, s.status::text, s.subject_type::text, s.document_type_code, s.number, s.attempts,
                s.signed_pdf_document_id, s.signed_xml_document_id, s.source_document_id, s.vat_amount::text, s.error
           FROM ops.etax_submission s
          WHERE s.subject_id IN (SELECT id FROM ops.receipt WHERE payment_id = $1
                                 UNION ALL SELECT id FROM ops.tax_invoice WHERE payment_id = $1)`,
        [paymentId],
      )
    )[0];

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_b62' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b62',
      phone: '+660000000281',
      type: 'apartment',
    });
    unitA101 = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
  }, 240_000);
  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  // ------------------------------------------------------------------------------------------------------- e-Tax

  it('nothing is submitted while the tenant is not VAT-registered or has e-Tax off', async () => {
    const off = await paidInvoice('1000.00');
    expect(await submissionOf(off.paymentId)).toBeUndefined();
    await q(`UPDATE core.tenant SET vat_registered = true, tax_id = '0105550000000' WHERE id = $1`, [
      DEV.tenantId,
    ]);
    const stillOff = await paidInvoice('1000.00');
    expect(await submissionOf(stillOff.paymentId)).toBeUndefined();
    await t.http
      .put('/v1/owner/settings/etax.enabled')
      .set(O())
      .send({ value: true, reason: 'สมัคร e-Tax กับผู้ให้บริการแล้ว' })
      .expect(200);
  });

  it('a receipt is submitted, signed by the provider, its signed XML / PDF stored and sent to the payer', async () => {
    const paid = await paidInvoice('4500.00');
    const s = await submissionOf(paid.paymentId);
    expect(s).toMatchObject({
      status: 'submitted',
      subject_type: 'receipt',
      document_type_code: 'T01',
      attempts: 1,
    });
    expect(fake().docs.size).toBe(1);
    const sent = [...fake().docs.values()][0]!.input;
    expect(sent).toMatchObject({ number: s!.number, typeCode: 'T01', total: '4500.00', vatAmount: '0.00' });
    expect(sent.seller).toMatchObject({ taxId: '0105550000000', branch: '00000' });
    expect(sent.pdf.subarray(0, 4).toString()).toBe('%PDF');

    // polled after 5 minutes: signed → artefacts stored as version 2 of the receipt PDF
    t.clock.advance(6 * 60_000);
    await etax().sweep();
    await settle();
    const signed = await submissionOf(paid.paymentId);
    expect(signed).toMatchObject({ status: 'signed', error: null });
    const docs = await q<{
      id: string;
      kind: string;
      mime_type: string;
      version_no: number;
      version_of_document_id: string;
    }>(
      `SELECT id, kind::text, mime_type, version_no, version_of_document_id FROM core.document WHERE id = ANY($1::uuid[]) ORDER BY mime_type`,
      [[signed!.signed_pdf_document_id, signed!.signed_xml_document_id]],
    );
    expect(docs).toEqual([
      expect.objectContaining({
        kind: 'pdf_receipt',
        mime_type: 'application/pdf',
        version_no: 2,
        version_of_document_id: signed!.source_document_id,
      }),
      expect.objectContaining({ kind: 'other', mime_type: 'application/xml', version_no: 2 }),
    ]);
    const storage = t.app.get<FakeObjectStorage>(OBJECT_STORAGE);
    const [pdfKey] = await q<{ storage_key: string }>('SELECT storage_key FROM core.document WHERE id = $1', [
      signed!.signed_pdf_document_id,
    ]);
    const chunks: Buffer[] = [];
    for await (const c of await storage.getStream(pdfKey!.storage_key)) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).toString('latin1')).toContain('%FAKE-ETAX-SIGNATURE');
    const [receipt] = await q<{ e_tax_ref: string; document_id: string }>(
      'SELECT e_tax_ref, document_id FROM ops.receipt WHERE payment_id = $1',
      [paid.paymentId],
    );
    expect(receipt!.e_tax_ref).toMatch(/^fake-etax-/);
    expect(receipt!.document_id).toBe(signed!.source_document_id); // our original stays the receipt's (D-044)
    // the payer is told with the signed PDF (LINE, consent and the billing topic apply)
    const notes = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'etax.signed' AND n.recipient_id = $1`,
      [DEV.residentPartyId],
    );
    expect(notes[0]!.n).toBeGreaterThanOrEqual(1);
    const audit = await q<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE subject_id = $1 ORDER BY occurred_at`,
      [signed!.id],
    );
    expect(audit.map((a) => a.action)).toEqual(['etax.queued', 'etax.signed']);
  });

  it('a receipt-tax invoice (VAT) is a T03 with its VAT split', async () => {
    const paid = await paidInvoice('1000.00', '70.00');
    const s = await submissionOf(paid.paymentId);
    expect(s).toMatchObject({ subject_type: 'tax_invoice', document_type_code: 'T03', vat_amount: '70.00' });
    const doc = [...fake().docs.values()].find((d) => d.input.number === s!.number)!.input;
    expect(doc.lines.reduce((sum, l) => sum + Number(l.amount), 0).toFixed(2)).toBe('1000.00');
    expect(doc.lines[0]!.vatRatePct).toBe('7.00');
  });

  it('provider down → retries with backoff; rejected → owner told, fixed and sent again', async () => {
    fake().failing = true;
    const down = await paidInvoice('2000.00');
    expect(await submissionOf(down.paymentId)).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await submissionOf(down.paymentId))!.error).toContain('provider unavailable');
    fake().failing = false;
    await etax().sweep(); // the backoff has not passed yet
    expect(await submissionOf(down.paymentId)).toMatchObject({ status: 'failed' });
    t.clock.advance(2 * 60_000);
    await etax().sweep();
    expect(await submissionOf(down.paymentId)).toMatchObject({ status: 'submitted', attempts: 2 });

    fake().rejectAll = true;
    const bad = await paidInvoice('2100.00');
    t.clock.advance(6 * 60_000);
    await etax().sweep();
    await settle();
    const rejected = await submissionOf(bad.paymentId);
    expect(rejected).toMatchObject({ status: 'rejected' });
    expect(rejected!.error).toContain('E101');
    const told = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'etax.rejected' AND n.recipient_id = $1`,
      [DEV.users.owner],
    );
    expect(told[0]!.n).toBeGreaterThanOrEqual(1);
    await relogin();
    const listed = await t.http.get('/v1/owner/etax/submissions?status=rejected').set(O()).expect(200);
    expect(listed.body.data).toEqual([expect.objectContaining({ id: rejected!.id, nextActions: ['retry'] })]);
    // another tenant: 404; a signed one cannot be retried
    await t.http.get(`/v1/owner/etax/submissions/${rejected!.id}`).set(bearer(other.token)).expect(404);
    const signedId = (
      await q<{ id: string }>(`SELECT id FROM ops.etax_submission WHERE status = 'signed' LIMIT 1`)
    )[0]!.id;
    const conflict = await t.http
      .post(`/v1/owner/etax/submissions/${signedId}/actions/retry`)
      .set(O())
      .set(idem());
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('etax.invalid_state');

    fake().rejectAll = false;
    const retried = await t.http
      .post(`/v1/owner/etax/submissions/${rejected!.id}/actions/retry`)
      .set(O())
      .set(idem())
      .expect(200);
    expect(retried.body).toMatchObject({ status: 'submitted', attempts: 1, error: null });
    t.clock.advance(6 * 60_000);
    await etax().sweep();
    expect(await submissionOf(bad.paymentId)).toMatchObject({ status: 'signed' });
  });

  it('monthly figures, the accountant register and the notice on the 1st', async () => {
    await relogin();
    const monthKey = new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 7);
    const summary = await t.http.get(`/v1/owner/etax/summary?month=${monthKey}`).set(O()).expect(200);
    expect(summary.body).toMatchObject({ month: monthKey, enabled: true, provider: 'inet' });
    expect(summary.body.counts.signed).toBeGreaterThanOrEqual(4);
    expect(summary.body.signed.vatAmount).toBe('70.00');
    await t.http.get('/v1/owner/etax/summary?month=2026-13').set(O()).expect(422);
    const job = await t.http
      .post('/v1/owner/exports')
      .set(O())
      .set(idem())
      .send({ kind: 'etax_monthly_xlsx', params: { period: monthKey } });
    expect([200, 201, 202]).toContain(job.status);
    await settle();
    const [exp] = await q<{ status: string; file_document_id: string; row_count: number }>(
      'SELECT status::text, file_document_id, row_count FROM ops.export_job WHERE id = $1',
      [job.body.id],
    );
    expect(exp).toMatchObject({ status: 'done' });
    const [file] = await q<{ storage_key: string }>('SELECT storage_key FROM core.document WHERE id = $1', [
      exp!.file_document_id,
    ]);
    const chunks: Buffer[] = [];
    for await (const c of await t.app.get<FakeObjectStorage>(OBJECT_STORAGE).getStream(file!.storage_key))
      chunks.push(Buffer.from(c as Buffer));
    const sheet = Object.values(await readXlsx(Buffer.concat(chunks)))[0]!;
    expect(sheet.some((r) => r[1] === 'T03')).toBe(true);

    // on the 1st of next month the owner / accountant get last month's figures, once
    const [y, m] = monthKey.split('-').map(Number) as [number, number];
    const first = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T03:00:00+07:00`;
    t.clock.set(new Date(first));
    expect(await etax().monthly()).toBe(1);
    expect(await etax().monthly()).toBe(0);
    const ev = await q<{ payload: { month: string } }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'etax.monthly_summary' AND tenant_id = $1`,
      [DEV.tenantId],
    );
    expect(ev.map((e) => e.payload.month)).toEqual([monthKey]);
  });

  it('RLS: another tenant sees no e-Tax submission', async () => {
    expect(await count(DEV.tenantId, 'ops.etax_submission')).toBeGreaterThan(0);
    expect(await count(other.tenantId, 'ops.etax_submission')).toBe(0);
  });

  // -------------------------------------------------------------------------------------------------------- TM30

  it('a foreign lessee moves in: TM30 due in 24 h, file generated with the passport, submission recorded', async () => {
    await relogin();
    const staff = await operatorToken(t, '+660000000003');
    const [a102] = await q<{ id: string }>(
      `SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-102'`,
      [DEV.buildingId],
    );
    const party = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({
        type: 'person',
        displayName: 'John Smith',
        firstName: 'John',
        lastName: 'Smith',
        phone: '+660000000282',
        nationality: 'GB',
        idDocumentType: 'passport',
        idNumber: 'AB1234567',
        dateOfBirth: '1990-04-12',
        gender: 'M',
        occupantProfile: { visaType: 'NON-B', entryPort: 'สุวรรณภูมิ' },
      })
      .expect(201);
    const partyId = (party.body.id ?? party.body.party?.id) as string;
    const today = new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(O())
      .send({ unitId: a102!.id, lesseePartyId: partyId, startDate: today, months: 6 })
      .expect(201);
    const leaseId = draft.body.id as string;
    const sent = await t.http
      .post(`/v1/owner/leases/${leaseId}/actions/send-for-signature`)
      .set(O())
      .set(idem());
    if (sent.status !== 200) throw new Error(JSON.stringify(sent.body));
    await q(
      `INSERT INTO ops.lease_signature (tenant_id, lease_id, signer_role, party_id, method, signature_image_document_id, pdf_sha256, signed_at)
       SELECT tenant_id, id, 'lessee', $2, 'scan_upload', contract_document_id, decode($3, 'hex'), now() FROM ops.lease WHERE id = $1`,
      [leaseId, partyId, sent.body.contract.sha256],
    );
    await t.http
      .post(`/v1/owner/leases/${leaseId}/actions/countersign`)
      .set(O())
      .set(idem())
      .send({ signaturePng: PNG })
      .expect(200);
    await settle();

    const list = await t.http.get(`/v1/owner/tm30-exports?building=${DEV.buildingId}`).set(O()).expect(200);
    expect(list.body.data).toHaveLength(1);
    const row = list.body.data[0] as {
      id: string;
      dueAt: string;
      movedInAt: string;
      missing: string[];
      status: string;
    };
    expect(row).toMatchObject({
      status: 'due',
      name: 'John Smith',
      nationality: 'GB',
      unitNo: 'A-102',
      missing: ['arrivalDate'],
    });
    expect(new Date(row.dueAt).getTime() - new Date(row.movedInAt).getTime()).toBe(24 * 3_600_000);
    const told = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'foreign_stay.due' AND n.recipient_id = $1`,
      [DEV.users.owner],
    );
    expect(told[0]!.n).toBeGreaterThanOrEqual(1);
    // staff have no TM30 access (passport data); another tenant sees nothing
    expect((await t.http.get('/v1/owner/tm30-exports').set(bearer(staff))).status).toBe(403);
    await t.http.get(`/v1/owner/tm30-exports/${row.id}`).set(bearer(other.token)).expect(404);

    // the arrival date is missing → 422 with the field; completed → the file
    const missing = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/tm30-exports/actions/generate`)
      .set(O())
      .send({})
      .expect(422);
    expect(missing.body.code).toBe('tm30.data_missing');
    expect(missing.body.errors[0].path).toBe(`exports.${row.id}.arrivalDate`);
    await q(`UPDATE ops.occupant_profile SET arrival_date = '2026-10-30' WHERE party_id = $1`, [partyId]);
    const file = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/tm30-exports/actions/generate`)
      .set(O())
      .send({})
      .expect(200);
    expect(file.body.exports).toEqual([
      expect.objectContaining({ id: row.id, status: 'generated', missing: [] }),
    ]);
    const [doc] = await q<{ storage_key: string; kind: string }>(
      'SELECT storage_key, kind::text FROM core.document WHERE id = $1',
      [file.body.fileDocumentId],
    );
    expect(doc!.kind).toBe('export');
    const chunks: Buffer[] = [];
    for await (const c of await t.app.get<FakeObjectStorage>(OBJECT_STORAGE).getStream(doc!.storage_key))
      chunks.push(Buffer.from(c as Buffer));
    const sheet = (await readXlsx(Buffer.concat(chunks))).TM30!;
    expect(sheet[1]!.slice(0, 9)).toEqual([
      1,
      'AB1234567',
      'GBR',
      'JOHN',
      null,
      'SMITH',
      'M',
      '12/04/2533',
      '30/10/2569',
    ]);
    const reveals = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'pii.decrypted' AND subject_id = $1
          AND metadata->>'purpose' = 'tm30_export'`,
      [partyId],
    );
    expect(reveals[0]!.n).toBe(1);
    await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/tm30-exports/actions/generate`)
      .set(bearer(other.token))
      .send({})
      .expect(404);

    // 6 h before the deadline the owner is reminded (workflow engine)
    t.clock.advance(19 * 3_600_000);
    await settle();
    const reminded = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event e
        WHERE e.type = 'workflow.sla_reminder' AND e.payload->>'definitionKey' = 'tm30_notification'`,
    );
    expect(reminded[0]!.n).toBe(1);
    await relogin();
    const dl = await t.http.get(`/v1/owner/tm30-exports/${row.id}/file`).set(O()).expect(200);
    expect(dl.body.url).toEqual(expect.any(String));
    const submitted = await t.http
      .post(`/v1/owner/tm30-exports/${row.id}/actions/mark-submitted`)
      .set(O())
      .send({ reference: 'TM30-6611-000123' })
      .expect(200);
    expect(submitted.body).toMatchObject({
      status: 'submitted_manually',
      submissionRef: 'TM30-6611-000123',
      nextActions: [],
    });
    // past the deadline nothing breaches: the workflow closed with the submission
    t.clock.advance(6 * 3_600_000);
    await settle();
    const breached = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event e
        WHERE e.type = 'workflow.sla_breached' AND e.payload->>'definitionKey' = 'tm30_notification'`,
    );
    expect(breached[0]!.n).toBe(0);
    await relogin();
    const again = await t.http
      .post(`/v1/owner/tm30-exports/${row.id}/actions/cancel`)
      .set(O())
      .send({ reason: 'ซ้ำ' + 'ซ้อน' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('tm30.invalid_state');
    const log = await q<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE subject_id = $1 OR (subject_id = $2 AND action LIKE 'foreign_stay.%')
        ORDER BY occurred_at`,
      [row.id, file.body.fileDocumentId],
    );
    expect(log.map((l) => l.action)).toEqual([
      'foreign_stay.opened',
      'foreign_stay.file_generated',
      'foreign_stay.file_downloaded',
      'foreign_stay.submitted',
    ]);
  });

  it('an unattended TM30 duty breaches at 24 h; Thai occupants open none; RLS', async () => {
    const [row] = await q<{ id: string; workflow_instance_id: string }>(
      `SELECT id, workflow_instance_id FROM ops.tm30_export WHERE status = 'submitted_manually'`,
    );
    expect(row).toBeDefined();
    await relogin();
    // a second foreign co-occupant (family) of the same lease, notified by nobody
    const [lease] = await q<{ lease_id: string }>('SELECT lease_id FROM ops.tm30_export WHERE id = $1', [
      row!.id,
    ]);
    const party = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({
        type: 'person',
        displayName: 'Mary Smith',
        nationality: 'GB',
        idDocumentType: 'passport',
        idNumber: 'AB7654321',
      })
      .expect(201);
    const partyId = (party.body.id ?? party.body.party?.id) as string;
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, lease_id, valid_from, moved_in_at)
       SELECT tenant_id, building_id, unit_id, $2, 'family', id, start_date, now() FROM ops.lease WHERE id = $1`,
      [lease!.lease_id, partyId],
    );
    const thai = await t.http
      .post('/v1/owner/parties')
      .set(O())
      .send({ type: 'person', displayName: 'สมชาย ใจดี', nationality: 'TH' })
      .expect(201);
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, lease_id, valid_from, moved_in_at)
       SELECT tenant_id, building_id, unit_id, $2, 'family', id, start_date, now() FROM ops.lease WHERE id = $1`,
      [lease!.lease_id, (thai.body.id ?? thai.body.party?.id) as string],
    );
    expect(await t.app.get(Tm30Service).sweep()).toBe(1);
    expect(await t.app.get(Tm30Service).sweep()).toBe(0);
    t.clock.advance(25 * 3_600_000);
    await settle();
    const breached = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event e
        WHERE e.type = 'workflow.sla_breached' AND e.payload->>'definitionKey' = 'tm30_notification'`,
    );
    expect(breached[0]!.n).toBe(1);
    await relogin();
    const overdue = await t.http.get('/v1/owner/tm30-exports?status=due').set(O()).expect(200);
    expect(overdue.body.data).toEqual([expect.objectContaining({ name: 'Mary Smith', overdue: true })]);

    expect(await count(DEV.tenantId, 'ops.tm30_export')).toBe(2);
    expect(await count(other.tenantId, 'ops.tm30_export')).toBe(0);
  });
});

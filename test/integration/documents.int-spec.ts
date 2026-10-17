import 'reflect-metadata';

import { unzip } from '@common/zip/zip';
import { DocumentsService } from '@core/documents/documents.service';
import { fakeLineIdToken } from '@integrations/line/fake-line-login';
import { FakePdfRenderer } from '@integrations/pdf/fake-pdf-renderer';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const LINE_SUB = 'U00000000000000000000000000b4b301';

/**
 * B4.3 acceptance (documents): 50 parallel issues take gapless numbers (5 not ready take none); the worker renders
 * each issued invoice and note once (`document.generated`); owner A4 / 80 mm downloads, the resident's download,
 * "send again"; the billed party's LINE message is the Flex template; the document archive of the month (ZIP with
 * index); the admin template preview; cross-tenant 404s.
 */
describe('B4.3 documents, series, Flex, archive (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let other: { tenantId: string; token: string };
  const issued: string[] = [];
  let unitId = '';

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_docs' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-b43',
      phone: '+660000000143',
      type: 'apartment',
    });
    unitId = (
      await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-101'`, [
        DEV.buildingId,
      ])
    )[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('50 parallel issues: 45 ready drafts get INV-…-00001…00045 without a gap, 5 not ready get none', async () => {
    const drafts: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const y = 2022 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const id = (
        await q<{ id: string }>(
          `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, period_start, period_end,
                                    subtotal, total, balance, review_flags)
           VALUES ($1, $2, $3, $4, $5, $6::date, ($6::date + interval '1 month - 1 day')::date, 100, 100, 100, $7)
           RETURNING id`,
          [
            DEV.tenantId,
            DEV.buildingId,
            unitId,
            DEV.residentPartyId,
            DEV.leaseId,
            start,
            i % 10 === 9 ? ['missing_reading:x'] : [],
          ],
        )
      )[0]!.id;
      await q(
        `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount)
         VALUES ($1, $2, 1, 'rent', 'rent', 'ค่าเช่าห้อง A-101', 1, 'month', 100, 100)`,
        [DEV.tenantId, id],
      );
      drafts.push(id);
    }
    const results = await Promise.all(
      drafts.map((id) =>
        t.http.post(`/v1/owner/invoices/${id}/actions/issue`).set(bearer(owner)).set(idem()).send({}),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status !== 200);
    expect(refused.map((r) => [r.status, (r.body as { code: string }).code])).toEqual(
      Array.from({ length: 5 }, () => [409, 'invoice.not_ready']),
    );
    const numbers = ok.map((r) => (r.body as { number: string }).number).sort();
    // gapless: exactly 00001 … 00045 of this year's series
    expect(numbers.map((n) => n.replace(/^INV-\d{4}-/, ''))).toEqual(
      Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(5, '0')),
    );
    expect(new Set(numbers).size).toBe(45);
    const series = await q<{ next_number: number }>(
      `SELECT next_number FROM ops.document_series WHERE tenant_id = $1 AND doc_type = 'invoice'`,
      [DEV.tenantId],
    );
    expect(series[0]!.next_number).toBe(46);
    issued.push(...ok.map((r) => r.body.id as string));
  }, 120_000);

  it('the worker renders each issued invoice once; the billed party’s LINE message is the Flex template', async () => {
    await t.worker.tick();
    const docs = await q<{ n: number; d: number }>(
      `SELECT count(*)::int AS n, count(document_id)::int AS d FROM ops.invoice WHERE id = ANY($1::uuid[])`,
      [issued],
    );
    expect(docs[0]).toEqual({ n: 45, d: 45 });
    const generated = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'document.generated' AND payload->>'docType' = 'invoice'`,
    );
    expect(generated[0]!.n).toBe(45);
    const rendered = await q<{ rendered: { format: string; flex: { type: string }; text: string } }>(
      `SELECT n.rendered FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'invoice.payment_ready' AND e.aggregate_id = $1`,
      [issued[0]],
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.rendered).toMatchObject({ format: 'line_flex_json', flex: { type: 'bubble' } });
    expect(rendered[0]!.rendered.text).toMatch(/^ใบแจ้งหนี้ INV-\d{4}-\d{5} ห้อง A-101 ยอด/);
    // the stored PDF is the invoice as issued
    const doc = await q<{ storage_key: string; kind: string; title: string }>(
      `SELECT d.storage_key, d.kind::text, d.title FROM core.document d JOIN ops.invoice i ON i.document_id = d.id WHERE i.id = $1`,
      [issued[0]],
    );
    expect(doc[0]).toMatchObject({ kind: 'pdf_invoice' });
    const pdf = await t.app.get(DocumentsService).bytesOf({ storageKey: doc[0]!.storage_key });
    expect(FakePdfRenderer.textOf(pdf)).toContain('ค่าเช่าห้อง A-101');
  });

  it('owner downloads A4 and the 80 mm roll; sends again; a credit note gets its PDF', async () => {
    const O = bearer(owner);
    const a4 = await t.http.get(`/v1/owner/invoices/${issued[0]}/document`).set(O).expect(200);
    const again = await t.http.get(`/v1/owner/invoices/${issued[0]}/document?paper=a4`).set(O).expect(200);
    expect(again.body.documentId).toBe(a4.body.documentId);
    const roll = await t.http
      .get(`/v1/owner/invoices/${issued[0]}/document?paper=thermal_80mm`)
      .set(O)
      .expect(200);
    expect(roll.body.documentId).not.toBe(a4.body.documentId);
    expect(roll.body.url).toMatch(/^https?:\/\//);
    const draft = (await q<{ id: string }>(`SELECT id FROM ops.invoice WHERE status = 'draft' LIMIT 1`))[0]!
      .id;
    await t.http
      .get(`/v1/owner/invoices/${draft}/document`)
      .set(O)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('invoice.invalid_state'));

    await t.http.post(`/v1/owner/invoices/${issued[0]}/actions/resend`).set(O).set(idem()).expect(200);
    await t.worker.tick();
    const resent = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'invoice.resent' AND e.aggregate_id = $1 AND n.rendered->>'format' = 'line_flex_json'`,
      [issued[0]],
    );
    expect(resent[0]!.n).toBe(1);

    const credited = await t.http
      .post(`/v1/owner/invoices/${issued[1]}/credit-notes`)
      .set(O)
      .set(idem())
      .send({
        reason: 'goodwill',
        reasonText: 'ส่วนลดพิเศษ',
        lines: [{ description: 'ส่วนลด', amount: '10.00' }],
      })
      .expect(201);
    await t.worker.tick();
    const noteId = credited.body.creditNotes[0].id as string;
    const note = await t.http.get(`/v1/owner/credit-notes/${noteId}/document`).set(O).expect(200);
    expect(note.body.number).toMatch(/^CRN-\d{4}-00001$/);
    const list = await t.http
      .get(`/v1/owner/billing-documents?period=${new Date().toISOString().slice(0, 7)}&kind=pdf_note`)
      .set(O)
      .expect(200);
    expect((list.body.data as { id: string }[]).map((d) => d.id)).toEqual([note.body.documentId]);
  });

  it('the resident downloads their own invoice; a stranger gets 404', async () => {
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
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
    const R = bearer(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200)).body
        .accessToken as string,
    );
    const mine = await t.http.get(`/v1/resident/invoices/${issued[2]}/document`).set(R).expect(200);
    expect(mine.body.number).toMatch(/^INV-/);
    const stranger = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b4b3ff', name: 'คนอื่น' }) })
      .expect(200);
    await t.http
      .get(`/v1/resident/invoices/${issued[2]}/document`)
      .set(bearer(stranger.body.accessToken))
      .expect(404);
  });

  it('document archive of the month: ZIP with every generated document and an index', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const job = await t.http
      .post('/v1/owner/exports')
      .set(bearer(owner))
      .set(idem())
      .send({ kind: 'document_archive_zip', params: { period } })
      .expect(202);
    expect(job.body).toMatchObject({ status: 'queued', kind: 'document_archive_zip', download: null });
    await t.http
      .post('/v1/owner/exports')
      .set(bearer(owner))
      .set(idem())
      .send({ kind: 'invoices_xlsx', params: { period } })
      .expect(422);
    await t.worker.tick();
    const done = await t.http.get(`/v1/owner/exports/${job.body.id}`).set(bearer(owner)).expect(200);
    expect(done.body).toMatchObject({ status: 'done', download: { url: expect.any(String) } });
    // 45 invoices + their 80 mm copy is a version (not archived) + 1 credit note
    expect(done.body.rowCount).toBe(46);
    const file = await q<{ storage_key: string }>(
      `SELECT d.storage_key FROM core.document d JOIN ops.export_job j ON j.file_document_id = d.id WHERE j.id = $1`,
      [job.body.id],
    );
    const entries = unzip(await t.app.get(DocumentsService).bytesOf({ storageKey: file[0]!.storage_key }));
    expect(entries[0]!.name).toBe('index.csv');
    expect(entries.filter((e) => e.name.startsWith('invoices/'))).toHaveLength(45);
    expect(entries.filter((e) => e.name.startsWith('credit-debit-notes/'))).toHaveLength(1);
    expect(entries[0]!.data.toString('utf8').split('\r\n').filter(Boolean)).toHaveLength(47);
    const list = await t.http.get('/v1/owner/exports').set(bearer(owner)).expect(200);
    expect(list.body.data[0].id).toBe(job.body.id);
  });

  it('admin previews a template with sample data; thermal exists only for invoices and receipts', async () => {
    const A = bearer(await adminToken(t));
    const preview = await t.http
      .post('/v1/admin/document-templates/preview')
      .set(A)
      .send({ sample: 'tax_invoice' })
      .expect(200);
    expect(preview.body).toMatchObject({ templateKey: 'tax_invoice_a4_th', templateVersion: 1 });
    expect(preview.body.text).toContain('ใบกำกับภาษี');
    expect(
      Buffer.from(preview.body.pdfBase64 as string, 'base64')
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    await t.http
      .post('/v1/admin/document-templates/preview')
      .set(A)
      .send({ sample: 'credit_note', paper: 'thermal_80mm' })
      .expect(422);
    const forbidden = await t.http
      .post('/v1/admin/document-templates/preview')
      .set(bearer(owner))
      .send({ sample: 'invoice' });
    expect([401, 403]).toContain(forbidden.status);
  });

  it('another tenant gets 404 on my documents and exports', async () => {
    const B = bearer(other.token);
    await t.http.get(`/v1/owner/invoices/${issued[0]}/document`).set(B).expect(404);
    await t.http.post(`/v1/owner/invoices/${issued[0]}/actions/resend`).set(B).set(idem()).expect(404);
    const note = (await q<{ id: string }>(`SELECT id FROM ops.credit_note LIMIT 1`))[0]!.id;
    await t.http.get(`/v1/owner/credit-notes/${note}/document`).set(B).expect(404);
    const job = (await q<{ id: string }>(`SELECT id FROM ops.export_job LIMIT 1`))[0]!.id;
    await t.http.get(`/v1/owner/exports/${job}`).set(B).expect(404);
    expect((await t.http.get('/v1/owner/exports').set(B).expect(200)).body.data).toEqual([]);
    const period = new Date().toISOString().slice(0, 7);
    expect(
      (await t.http.get(`/v1/owner/billing-documents?period=${period}`).set(B).expect(200)).body.data,
    ).toEqual([]);
  });
});

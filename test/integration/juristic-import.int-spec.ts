import 'reflect-metadata';

import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import { unzip } from '@common/zip/zip';
import { SettingsService } from '@core/settings/settings.service';
import { CollectionsService } from '@modules/ops-juristic/collections.service';
import { ReceivablesService } from '@modules/ops-receivables/receivables.service';
import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';

import { type GeneratedImport, generateImport, RATE_PER_SQM } from '../fixtures/juristic-import/generator';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const PHONE_J = '+660000000321';
const PHONE_J2 = '+660000000322';
const PHONE_COMMITTEE = '+66810003211';
const AS_OF = '2026-10-31';
const at = (d: string, time = '09:00:00') => new Date(`${d}T${time}+07:00`);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * J3.1 acceptance (D-313, D-332) on a juristic condominium moving from a legacy system: templates; row-level errors in
 * Thai / English with a bad-rows file and full ID numbers refused (never stored); 500 units with 120 in arrears imported
 * (upload → validate → reconcile → commit) in under 60 s; mismatched totals block the commit until explained with an
 * attachment; nothing of the building is issued before go-live; the rollback removes exactly what the job created (a
 * unit and a party that existed before stay); the parallel cycle against the legacy bills blocks go-live until the
 * differences are explained (or acknowledged where the setting allows it); go-live issues the opening balances (series
 * OPB), posts the opening journals and hands overdue balances to the ladder; the full export holds every juristic
 * table; another tenant gets 404 everywhere.
 */
describe('J3.1 import wizard, reconcile, parallel cycle, go-live, full export (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let jur: { tenantId: string; token: string };
  let jur2: { tenantId: string; token: string };
  let committee: string;
  const ids: Record<string, string> = {};
  let gen: GeneratedImport;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const n = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(sql, params)).n;
  const settle = async (k = 6) => {
    for (let i = 0; i < k; i += 1) await t.worker.tick();
  };
  const J = () => bearer(jur.token);
  const J2 = () => bearer(jur2.token);
  const C = () => bearer(committee);
  const relogin = async () => {
    jur = { ...jur, token: await operatorToken(t, PHONE_J) };
    jur2 = { ...jur2, token: await operatorToken(t, PHONE_J2) };
    committee = await operatorToken(t, PHONE_COMMITTEE);
  };
  const doc = async (tenantId: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO core.document (tenant_id, scope_type, kind, storage_bucket, storage_key, mime_type, size_bytes, sha256, retention_class, upload_state)
         VALUES ($1, 'tenant', 'other', 'b', 'k-' || gen_random_uuid(), 'application/pdf', 10, decode(repeat('ab', 32), 'hex'), 'legal', 'verified')
         RETURNING id`,
        [tenantId],
      )
    ).id;
  const job = async (asOfDate = AS_OF) =>
    (
      await t.http
        .post('/v1/owner/juristic/imports')
        .set(J())
        .send({ buildingId: ids.building, asOfDate })
        .expect(201)
    ).body as { id: string; state: string; number: number };
  const upload = (id: string, sheet: string, content: string, fileName = `${sheet}.csv`) =>
    t.http
      .post(`/v1/owner/juristic/imports/${id}/files`)
      .set(J())
      .send({ sheet, fileName, content: b64(content) });
  /** Row counts of every table the import writes to, for the tenant. */
  const counts = async () => {
    const tables = [
      'core.floor',
      'core.unit',
      'core.party',
      'core.unit_ownership',
      'juristic.bill_to',
      'ops.invoice',
      'ops.invoice_line',
      'juristic.legacy_payment',
      'ops.unit_detail',
    ];
    const out: Record<string, number> = {};
    for (const tbl of tables)
      out[tbl] = await n(`SELECT count(*)::int AS n FROM ${tbl} WHERE tenant_id = $1`, [jur.tenantId]);
    return out;
  };
  const extraRegister = [
    // the unit created in the console before the import: attached, its attributes kept
    [
      'อาคาร A',
      '',
      'X-0001',
      '',
      '',
      '',
      '',
      '',
      'OW-X1',
      'เจ้าของ เอ็กซ์',
      'person',
      '',
      '',
      '0899990001',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
  ];

  /** Upload + validate + reconcile (explained) + commit of the generated building; returns the job id and timing. */
  const importAll = async () => {
    const started = Date.now();
    const j = await job();
    for (const [sheet, content] of [
      ['register', gen.register],
      ['opening_balance', gen.openingBalance],
      ['payment_history', gen.paymentHistory],
      ['bank_balance', gen.bankBalance],
    ] as const)
      await upload(j.id, sheet, content).expect(200);
    await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/reconcile`)
      .set(J())
      .send({
        declaredReceivables: gen.expected.receivables,
        note: 'บัญชีกองทุนยังไม่มีรายการเดินบัญชีในระบบ — ยอดตามสมุดบัญชีแนบ',
        documentId: ids.explain,
      })
      .expect(200);
    const commit = await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/commit`)
      .set({ ...J(), ...idem() })
      .send({ billToConsentDocumentId: ids.consent });
    return { id: j.id, commit, ms: Date.now() - started };
  };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_juristic_import' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(at('2026-11-05'));
    admin = await adminToken(t);
    jur = await onboardTenant(t, admin, { slug: 'j31-condo', phone: PHONE_J, type: 'juristic' });
    jur2 = await onboardTenant(t, admin, { slug: 'j31-other', phone: PHONE_J2, type: 'juristic' });
    const property = await t.http
      .post('/v1/owner/properties')
      .set(J())
      .send({ code: 'C1', name: 'คอนโด J3.1', kind: 'condo' })
      .expect(201);
    ids.property = property.body.id;
    ids.building = (
      await t.http
        .post('/v1/owner/buildings')
        .set(J())
        .send({ propertyId: ids.property, code: 'A', name: 'อาคาร A', type: 'condo', legalForm: 'condo_act' })
        .expect(201)
    ).body.id;
    const inv = await t.http
      .post('/v1/owner/invitations')
      .set(J())
      .send({ role: 'committee', phone: PHONE_COMMITTEE, channel: 'link' })
      .expect(201);
    committee = await operatorToken(t, PHONE_COMMITTEE, inv.body.code as string);
    // a confirmed operating bank account (the OTP flow is covered elsewhere) with a J2.1 statement up to the as-of date
    ids.bank = (
      await one<{ id: string }>(
        `INSERT INTO platform.tenant_bank_account (tenant_id, bank_code, bank_name_th, account_no_enc, account_no_hash, account_no_masked,
                                                   account_name, state, is_default, confirmed_at)
         VALUES ($1, '004', 'ธนาคารกสิกรไทย', '\\x01', '\\x02', 'xxx-x-x4321-x', 'นิติบุคคลอาคารชุด J31', 'active', true, now()) RETURNING id`,
        [jur.tenantId],
      )
    ).id;
    await t.http
      .post('/v1/owner/juristic/bank-statements')
      .set({ ...J(), ...idem() })
      .send({
        bankAccountId: ids.bank,
        formatKey: 'kbank',
        fileName: 'kbank-2569-10.csv',
        content: b64(
          [
            'ธนาคารกสิกรไทย (ตัวอย่าง)',
            'วันที่,เวลา,รายการ,ถอนเงิน,ฝากเงิน,ยอดคงเหลือ,ช่องทาง,รายละเอียด',
            '30/10/2569,10:05,รับโอนเงิน,,"1,000.00","152,000.55",K PLUS,KB3010A001',
            '31/10/2569,11:00,รับโอนเงิน,,300.00,"152,300.55",K PLUS,KB3110A002',
            '02/11/2569,09:00,รับโอนเงิน,,500.00,"152,800.55",K PLUS,KB0211A003',
          ].join('\n'),
        ),
      })
      .expect(201);
    // what existed before the import and must survive its rollback
    ids.x1 = (
      await t.http
        .post('/v1/owner/units')
        .set(J())
        .send({ buildingId: ids.building, unitNo: 'X-0001', type: 'condo_unit', areaSqm: '40.00' })
        .expect(201)
    ).body.id;
    ids.oldParty = (
      await one<{ id: string }>(
        `INSERT INTO core.party (tenant_id, type, display_name, phone_e164) VALUES ($1, 'person', 'เจ้าของ 2', '+66810000001') RETURNING id`,
        [jur.tenantId],
      )
    ).id;
    ids.consent = await doc(jur.tenantId);
    ids.explain = await doc(jur.tenantId);
    gen = generateImport({ units: 500, arrears: 120, asOf: AS_OF, operatingLast4: '4321', extraRegister });
  }, 300_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('templates: XLSX with an instructions sheet (Thai) and CSV (English) for every sheet', async () => {
    const xlsx = await t.http
      .get('/v1/owner/juristic/imports/templates/register?format=xlsx&language=th')
      .set(J())
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['register', 'คำอธิบาย']);
    expect(wb.getWorksheet('register')!.getRow(1).getCell(3).text).toBe('เลขที่ห้อง / แปลง (unit_no) *');
    for (const sheet of ['opening_balance', 'payment_history', 'bank_balance', 'legacy_bills']) {
      const csv = await t.http
        .get(`/v1/owner/juristic/imports/templates/${sheet}?format=csv&language=en`)
        .set(J())
        .expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toMatch(/Unit no\. \(unit_no\) \*|Account type \(account_type\) \*/);
    }
    // committee reads, never runs an import
    await t.http.get('/v1/owner/juristic/imports/templates/register').set(C()).expect(200);
    await t.http
      .post('/v1/owner/juristic/imports')
      .set(C())
      .send({ buildingId: ids.building, asOfDate: AS_OF })
      .expect(403);
  });

  it('validation: per-row field and cross-file errors in Thai / English, bad-rows file, full ID numbers refused and never stored', async () => {
    const j = await job();
    const register = [
      'unit_no,owner_name,id_type,id_last4,phone,share_pct,area_sqm,owner_code',
      'B-0101,สมหญิง ทดสอบ,thai_national_id,1103700012345,0812345678,70,35.5,OW-1',
      'B-0101,สมปอง ทดสอบ,passport,XXXXXXXX9876,not-a-phone,50,35.5,OW-2',
      'B-0102,,thai_national_id,4321,0812345679,,abc,OW-3',
      'X-0001,เจ้าของ เอ็กซ์,,,0899990001,,55.00,OW-X1',
    ].join('\n');
    const opening = [
      'unit_no,owner_code,period,principal,surcharge',
      'B-0101,OW-1,2026-10,1000.00,',
      'Z-9999,OW-9,2026-10,500.00,',
      'B-0101,OW-1,2026-12,100.00,',
      'B-0101,OW-1,2026-13,100.00,',
      'B-0101,OW-1,2026-09,0,0',
    ].join('\n');
    const reg = await upload(j.id, 'register', register).expect(200);
    expect(reg.body.state).toBe('draft');
    await upload(j.id, 'opening_balance', opening).expect(200);
    const rows = await t.http
      .get(`/v1/owner/juristic/imports/${j.id}/rows?errorsOnly=true&perPage=50`)
      .set(J())
      .expect(200);
    const byRow = (sheet: string, rowNo: number) =>
      (
        rows.body.data as {
          sheet: string;
          rowNo: number;
          errors: { column: string; code: string; message: string }[];
        }[]
      ).find((r) => r.sheet === sheet && r.rowNo === rowNo)!;
    expect(byRow('register', 2).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: 'id_last4',
          code: 'id_full_refused',
          message: expect.stringContaining('PDPA'),
        }),
        expect.objectContaining({ column: 'share_pct', code: 'shares_exceeded' }),
      ]),
    );
    expect(byRow('register', 3).errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['phone', 'shares_exceeded']),
    );
    // a masked number keeps its last 4
    expect(
      (rows.body.data as { rowNo: number; data: Record<string, string> }[]).find((r) => r.rowNo === 3)?.data
        .id_last4,
    ).toBe('9876');
    expect(byRow('register', 4).errors.map((e) => [e.column, e.code])).toEqual(
      expect.arrayContaining([
        ['owner_name', 'required'],
        ['area_sqm', 'area'],
      ]),
    );
    // the existing unit: attached, its area kept (warning, not an error)
    expect(byRow('register', 5)).toBeUndefined();
    expect(byRow('opening_balance', 3).errors).toEqual([
      expect.objectContaining({ column: 'unit_no', code: 'unit_not_in_register' }),
    ]);
    expect(byRow('opening_balance', 4).errors[0]).toMatchObject({
      column: 'period',
      code: 'period_after_as_of',
    });
    expect(byRow('opening_balance', 5).errors[0]).toMatchObject({ column: 'period', code: 'period' });
    expect(byRow('opening_balance', 6).errors[0]).toMatchObject({ column: 'principal', code: 'amount_zero' });
    const en = await t.http
      .get(`/v1/owner/juristic/imports/${j.id}/rows?errorsOnly=true&sheet=opening_balance&language=en`)
      .set(J())
      .expect(200);
    expect(en.body.data[0].errors[0].message).toBe('unit Z-9999 is not in the register file');
    const warned = await t.http
      .get(`/v1/owner/juristic/imports/${j.id}/rows?sheet=register&perPage=10`)
      .set(J())
      .expect(200);
    expect(
      (warned.body.data as { rowNo: number; warnings: { code: string }[] }[]).find((r) => r.rowNo === 5)!
        .warnings[0],
    ).toMatchObject({ code: 'unit_attribute_differs' });
    // bad rows: the sheet's rows with errors and an errors column; the refused ID is not written back
    const bad = await t.http
      .get(`/v1/owner/juristic/imports/${j.id}/bad-rows?sheet=register&format=csv&language=th`)
      .set(J())
      .expect(200);
    const lines = bad.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r\n/);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/ข้อผิดพลาด \(errors\)$/);
    expect(lines[1]).toContain('ไม่รับเลขบัตรเต็ม');
    expect(lines[3]).toContain('abc');
    expect(bad.text).not.toContain('1103700012345');
    expect(
      await n(
        `SELECT count(*)::int AS n FROM juristic.import_row WHERE job_id = $1 AND (data::text LIKE '%1103700012345%' OR errors::text LIKE '%1103700012345%')`,
        [j.id],
      ),
    ).toBe(0);
    // a job with errors cannot be reconciled or committed; it is cancelled
    await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/reconcile`)
      .set(J())
      .send({ declaredReceivables: '1000.00' })
      .expect(409);
    await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/commit`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(409);
    // a second open job of the building is refused
    const dup = await t.http
      .post('/v1/owner/juristic/imports')
      .set(J())
      .send({ buildingId: ids.building, asOfDate: AS_OF })
      .expect(409);
    expect(dup.body.code).toBe('import.job_open');
    await t.http.post(`/v1/owner/juristic/imports/${j.id}/actions/cancel`).set(J()).expect(200);
    // an unreadable file
    const j2 = await job();
    const broken = await upload(j2.id, 'register', 'name,phone\nx,y').expect(422);
    expect(broken.body.code).toBe('import.file_invalid');
    await t.http.post(`/v1/owner/juristic/imports/${j2.id}/actions/cancel`).set(J()).expect(200);
  });

  it('500 units with 120 in arrears: mismatched totals block the commit until explained with an attachment; commit < 60 s', async () => {
    const before = await counts();
    const started = Date.now();
    const j = await job();
    for (const [sheet, content] of [
      ['register', gen.register],
      ['opening_balance', gen.openingBalance],
      ['payment_history', gen.paymentHistory],
      ['bank_balance', gen.bankBalance],
    ] as const)
      await upload(j.id, sheet, content).expect(200);
    const detail = await t.http.get(`/v1/owner/juristic/imports/${j.id}`).set(J()).expect(200);
    expect(detail.body.state).toBe('validated');
    expect(detail.body.totals).toMatchObject({
      units: 501,
      unitsNew: 500,
      unitsAttached: 1,
      ownerships: gen.expected.ownerships + 1,
      billTos: gen.expected.billTos,
      openingInvoices: 120,
      unitsInArrears: 120,
      principal: gen.expected.principal,
      surcharge: gen.expected.surcharge,
      receivables: gen.expected.receivables,
      historyCount: gen.expected.historyCount,
      historyAmount: gen.expected.historyAmount,
      bankOperating: gen.expected.bankOperating,
      bankFund: gen.expected.bankFund,
      errors: 0,
      partiesAttached: 1,
    });
    const preview = await t.http.get(`/v1/owner/juristic/imports/${j.id}/preview`).set(J()).expect(200);
    expect(preview.body.floorsToCreate).toHaveLength(25);
    expect(preview.body.openingBalances).toHaveLength(120);
    // declared total 100.00 above what the file brings: mismatch; the fund account has no statement
    const declared = new Decimal(gen.expected.receivables).plus(100).toFixed(2);
    const rec = await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/reconcile`)
      .set(J())
      .send({ declaredReceivables: declared })
      .expect(200);
    expect(rec.body.reconciliation).toMatchObject({
      explanationRequired: true,
      declaredReceivables: declared,
    });
    expect(rec.body.reconciliation.items).toEqual([
      expect.objectContaining({ key: 'receivables', status: 'mismatch', difference: '-100.00' }),
      expect.objectContaining({
        kind: 'bank',
        status: 'match',
        imported: '152300.55',
        reference: '152300.55',
      }),
      expect.objectContaining({ kind: 'bank', status: 'no_statement', reference: null }),
    ]);
    const blocked = await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/commit`)
      .set({ ...J(), ...idem() })
      .send({ billToConsentDocumentId: ids.consent })
      .expect(422);
    expect(blocked.body.code).toBe('import.reconciliation_unexplained');
    // a note alone is not an explanation
    await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/reconcile`)
      .set(J())
      .send({ declaredReceivables: declared, note: 'ระบบเดิมรวมค่าปรับที่ยกเลิกแล้ว 100 บาท' })
      .expect(422);
    await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/reconcile`)
      .set(J())
      .send({
        declaredReceivables: declared,
        note: 'ระบบเดิมรวมค่าปรับที่ยกเลิกแล้ว 100 บาท',
        documentId: ids.explain,
      })
      .expect(200);
    const noConsent = await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/commit`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(422);
    expect(noConsent.body.code).toBe('import.bill_to_consent_required');
    const commit = await t.http
      .post(`/v1/owner/juristic/imports/${j.id}/actions/commit`)
      .set({ ...J(), ...idem() })
      .send({ billToConsentDocumentId: ids.consent })
      .expect(200);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(60_000);
    expect(commit.body).toMatchObject({
      state: 'committed',
      created: {
        floor: 25,
        unit: 500,
        party: gen.expected.owners + 1 + gen.expected.billTos - 1,
        unit_ownership: gen.expected.ownerships + 1,
        bill_to: gen.expected.billTos,
        invoice: 120,
        legacy_payment: gen.expected.historyCount,
      },
      nextActions: ['parallel_cycle', 'rollback', 'go_live'],
    });
    ids.job1 = j.id;
    const after = await counts();
    expect(after['core.unit']! - before['core.unit']!).toBe(500);
    expect(after['ops.invoice']! - before['ops.invoice']!).toBe(120);
    // opening balances are drafts, flagged, not issuable; the existing party and unit were attached
    const drafts = await q<{ status: string; review_flags: string[]; total: string }>(
      `SELECT status::text, review_flags, total::text FROM ops.invoice WHERE import_job_id = $1`,
      [j.id],
    );
    expect(
      drafts.every((d) => d.status === 'draft' && d.review_flags[0] === 'opening_balance_pending_go_live'),
    ).toBe(true);
    expect(drafts.reduce((s, d) => s.plus(d.total), new Decimal(0)).toFixed(2)).toBe(
      gen.expected.receivables,
    );
    expect(
      await n(`SELECT count(*)::int AS n FROM core.unit_ownership WHERE party_id = $1`, [ids.oldParty]),
    ).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM core.unit_ownership WHERE unit_id = $1`, [ids.x1])).toBe(
      1,
    );
    expect(
      (await one<{ area: string }>(`SELECT area_sqm::text AS area FROM core.unit WHERE id = $1`, [ids.x1]))
        .area,
    ).toBe('40.00');
    // surcharge lines are late fees (never surcharged again); principal lines are opening_balance
    expect(
      await q(
        `SELECT l.line_kind::text AS kind, l.source_type::text AS source, count(*)::int AS n FROM ops.invoice_line l JOIN ops.invoice i ON i.id = l.invoice_id
          WHERE i.import_job_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
        [j.id],
      ),
    ).toEqual([
      { kind: 'late_fee', source: 'penalty', n: expect.any(Number) },
      { kind: 'opening_balance', source: 'common_fee', n: expect.any(Number) },
      { kind: 'opening_balance', source: 'fund', n: expect.any(Number) },
    ]);
    // nothing in the GL before go-live
    expect(
      await n(
        `SELECT count(*)::int AS n FROM juristic.journal WHERE tenant_id = $1 AND source_type = 'opening'`,
        [jur.tenantId],
      ),
    ).toBe(0);
  }, 180_000);

  it('before go-live the building issues nothing; the rollback removes exactly what the job created', async () => {
    // a monthly common fee by area and its cycle (computed drafts for the imported owners)
    const resolution = await one<{ id: string }>(
      `INSERT INTO juristic.resolution (tenant_id, building_id, meeting_kind, meeting_date, number, title, text, state, adopted_at)
       VALUES ($1, $2, 'agm', '2026-10-10', '1/2569', 'อัตราค่าส่วนกลาง', 'อนุมัติ', 'adopted', now()) RETURNING id`,
      [jur.tenantId, ids.building],
    );
    const plan = await t.http
      .post('/v1/owner/rate-plans')
      .set(J())
      .send({
        buildingId: ids.building,
        kind: 'common_fee',
        name: 'ค่าส่วนกลาง',
        isDefault: true,
        frequency: 'monthly',
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/rate-plans/${plan.body.id}/versions`)
      .set(J())
      .send({
        effectiveFrom: '2026-12-01',
        resolutionId: resolution.id,
        basis: 'per_sqm',
        tiers: { kind: 'flat', pricePerUnit: RATE_PER_SQM },
      })
      .expect(201);
    const cycle = await t.http
      .post('/v1/owner/billing-cycles')
      .set(J())
      .send({ propertyId: ids.property, periodKey: '2026-12' })
      .expect(200);
    ids.cycle = cycle.body.id;
    const computed = await t.http
      .post(`/v1/owner/billing-cycles/${ids.cycle}/actions/compute`)
      .set(J())
      .expect(200);
    const drafts = computed.body.invoices as { id: string }[];
    expect(drafts.length).toBeGreaterThan(500);
    // issuing is refused while the import is committed and not live (the legacy system still bills)
    const refused = await t.http
      .post(`/v1/owner/invoices/${drafts[0]!.id}/actions/issue`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(409);
    expect(refused.body.code).toBe('import.go_live_pending');
    const ob = await one<{ id: string }>(`SELECT id FROM ops.invoice WHERE import_job_id = $1 LIMIT 1`, [
      ids.job1,
    ]);
    const obIssue = await t.http
      .post(`/v1/owner/invoices/${ob.id}/actions/issue`)
      .set({ ...J(), ...idem() })
      .send({});
    expect(obIssue.body.code).toBe('invoice.not_ready');
    await settle();
    // rollback: everything the job created — and the cycle drafts computed for its units — is gone, nothing else
    const beforeImport = {
      'core.floor': 0,
      'core.unit': 1,
      'core.party': await n(
        `SELECT count(*)::int AS n FROM core.party WHERE tenant_id = $1 AND (source_ref IS NULL OR source_ref NOT LIKE 'import:%')`,
        [jur.tenantId],
      ),
    };
    const short = await t.http
      .post(`/v1/owner/juristic/imports/${ids.job1}/actions/rollback`)
      .set({ ...J(), ...idem() })
      .send({ reason: 'x' })
      .expect(422);
    expect(short.body.code).toBe('validation.failed');
    const rb = await t.http
      .post(`/v1/owner/juristic/imports/${ids.job1}/actions/rollback`)
      .set({ ...J(), ...idem() })
      .send({ reason: 'ทดสอบย้อนกลับก่อนนำเข้าใหม่' })
      .expect(200);
    expect(rb.body).toMatchObject({ state: 'rolled_back', rollbackReason: 'ทดสอบย้อนกลับก่อนนำเข้าใหม่' });
    const after = await counts();
    expect(after['core.floor']).toBe(beforeImport['core.floor']);
    expect(after['core.unit']).toBe(beforeImport['core.unit']);
    expect(after['core.party']).toBe(beforeImport['core.party']);
    expect(after['core.unit_ownership']).toBe(0);
    expect(after['juristic.bill_to']).toBe(0);
    expect(after['juristic.legacy_payment']).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM ops.invoice WHERE tenant_id = $1`, [jur.tenantId])).toBe(
      0,
    );
    expect(await n(`SELECT count(*)::int AS n FROM core.unit WHERE id = $1`, [ids.x1])).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM core.party WHERE id = $1`, [ids.oldParty])).toBe(1);
    expect(
      await n(`SELECT count(*)::int AS n FROM platform.tenant_bank_account WHERE id = $1`, [ids.bank]),
    ).toBe(1);
    expect(
      await n(`SELECT count(*)::int AS n FROM juristic.bank_statement WHERE tenant_id = $1`, [jur.tenantId]),
    ).toBe(1);
    // a rolled-back job cannot be rolled back or go live again
    await t.http
      .post(`/v1/owner/juristic/imports/${ids.job1}/actions/go-live`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(409);
  }, 180_000);

  it('import again; parallel cycle differences block go-live until explained (or acknowledged where allowed)', async () => {
    const { id, commit, ms } = await importAll();
    expect(commit.status).toBe(200);
    expect(ms).toBeLessThan(60_000);
    ids.job2 = id;
    // go-live needs the parallel cycle first
    const missing = await t.http
      .post(`/v1/owner/juristic/imports/${id}/actions/go-live`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(409);
    expect(missing.body.code).toBe('import.parallel_cycle_missing');
    await t.http.post(`/v1/owner/billing-cycles/${ids.cycle}/actions/compute`).set(J()).expect(200);
    const report = await t.http
      .post(`/v1/owner/juristic/imports/${id}/parallel-cycle`)
      .set(J())
      .send({
        billingCycleId: ids.cycle,
        fileName: 'legacy-2026-12.csv',
        content: b64(`${gen.legacyBills('2026-12')}X-0001,1200.00,2026-12\r\n`),
      })
      .expect(200);
    expect(report.body.summary).toMatchObject({ different: 1, unexplained: 1 });
    expect(report.body.summary.units).toBeGreaterThanOrEqual(500);
    const diff = (report.body.differences as { id: string; unitNo: string; difference: string }[]).find(
      (d) => d.difference !== '0.00',
    )!;
    expect(diff).toMatchObject({ unitNo: gen.differentUnit, difference: '-50.00' });
    const blocked = await t.http
      .post(`/v1/owner/juristic/imports/${id}/actions/go-live`)
      .set({ ...J(), ...idem() })
      .send({ acknowledgeDifferences: true })
      .expect(409);
    expect(blocked.body.code).toBe('import.differences_unexplained');
    // the tenant allows going live with an acknowledgement: still refused without it
    const now = t.clock.now().toISOString();
    await q(
      `INSERT INTO platform.tenant_setting_version (tenant_id, setting_id, value, effective_from, effective_to, reason, created_at)
       SELECT $1, id, 'true', $2::timestamptz - interval '1 hour', $2::timestamptz + interval '10 minutes', 'test: acknowledgement',
              $2::timestamptz - interval '1 hour'
         FROM platform.setting WHERE key = 'juristic.import.allow_unexplained_differences'`,
      [jur.tenantId, now],
    );
    t.app.get(SettingsService).invalidate('juristic.import.allow_unexplained_differences');
    const unacknowledged = await t.http
      .post(`/v1/owner/juristic/imports/${id}/actions/go-live`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(409);
    expect(unacknowledged.body).toMatchObject({ code: 'import.differences_unexplained' });
    // the tenant value ends (append-only versions): back to the default
    t.clock.advance(11 * 60_000);
    t.app.get(SettingsService).invalidate('juristic.import.allow_unexplained_differences');
    const explained = await t.http
      .post(`/v1/owner/juristic/imports/${id}/parallel-cycle/differences/${diff.id}/actions/explain`)
      .set(J())
      .send({ explanation: 'ระบบเดิมคิดค่าที่จอดรถรวมในค่าส่วนกลาง' })
      .expect(200);
    expect(explained.body.summary.unexplained).toBe(0);
    const read = await t.http.get(`/v1/owner/juristic/imports/${id}/parallel-cycle`).set(C()).expect(200);
    expect(read.body.summary).toMatchObject({ different: 1, unexplained: 0 });
  }, 180_000);

  it('go-live: opening balances issued (OPB), opening journals posted, the ladder takes over; the building issues again', async () => {
    const live = await t.http
      .post(`/v1/owner/juristic/imports/${ids.job2}/actions/go-live`)
      .set({ ...J(), ...idem() })
      .send({ notifyOpeningBalances: true })
      .expect(200);
    expect(live.body).toMatchObject({ state: 'live', nextActions: [] });
    const issued = await q<{ number: string; status: string; due_date: string; total: string }>(
      `SELECT number::text, status::text, due_date::text, total::text FROM ops.invoice WHERE import_job_id = $1 ORDER BY number`,
      [ids.job2],
    );
    expect(issued).toHaveLength(120);
    expect(issued.every((i) => /^OPB-2026-\d{5}$/.test(i.number) && i.status === 'issued')).toBe(true);
    expect(issued[0]!.number).toBe('OPB-2026-00001');
    await settle(10);
    // the resident hears about the opening balance like any invoice (payment_ready, notify not false)
    expect(
      await n(
        `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'invoice.payment_ready' AND aggregate_id IN (SELECT id FROM ops.invoice WHERE import_job_id = $1)`,
        [ids.job2],
      ),
    ).toBe(120);
    // journals: opening invoices Dr receivable / Cr accumulated surplus (fund lines → fund equity), bank openings
    const opening = await q<{ memo: string }>(
      `SELECT memo FROM juristic.journal WHERE tenant_id = $1 AND source_type = 'opening' ORDER BY memo`,
      [jur.tenantId],
    );
    expect(opening).toHaveLength(2);
    const gl = await one<{ receivable: string; surplus: string; fund_bank: string }>(
      `SELECT
         (SELECT coalesce(sum(l.debit - l.credit), 0)::text FROM juristic.journal_line l JOIN juristic.account a ON a.id = l.account_id
           WHERE a.tenant_id = $1 AND a.role = 'receivable') AS receivable,
         (SELECT coalesce(sum(l.credit - l.debit), 0)::text FROM juristic.journal_line l JOIN juristic.account a ON a.id = l.account_id
           WHERE a.tenant_id = $1 AND a.role = 'accumulated_surplus') AS surplus,
         (SELECT coalesce(sum(l.debit - l.credit), 0)::text FROM juristic.journal_line l JOIN juristic.account a ON a.id = l.account_id
           WHERE a.tenant_id = $1 AND a.role = 'fund_bank') AS fund_bank`,
      [jur.tenantId],
    );
    expect(gl.receivable).toBe(gen.expected.receivables);
    const fundOpening = (gen.openingBalance.match(/,fund,/g) ?? []).length * 1200;
    expect(gl.surplus).toBe(
      new Decimal(gen.expected.receivables).minus(fundOpening).plus(gen.expected.bankOperating).toFixed(2),
    );
    expect(gl.fund_bank).toBe(gen.expected.bankFund);
    // the building issues normally again
    const cycle = await t.http
      .post(`/v1/owner/billing-cycles/${ids.cycle}/actions/compute`)
      .set(J())
      .expect(200);
    const first = (cycle.body.invoices as { id: string }[])[0]!;
    await t.http
      .post(`/v1/owner/invoices/${first.id}/actions/issue`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(200);
    // after the due date the ladder opens a case per party × unit with an overdue opening balance
    const due = issued.map((i) => i.due_date).sort()[issued.length - 1]!;
    const d = new Date(`${due}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 2);
    t.clock.set(at(d.toISOString().slice(0, 10)));
    await relogin();
    await t.app.get(ReceivablesService).sweep();
    await settle();
    await t.app.get(CollectionsService).run();
    await settle();
    expect(
      await n(
        `SELECT count(DISTINCT c.id)::int AS n FROM juristic.collection_case c
          WHERE c.tenant_id = $1 AND c.state = 'open'
            AND EXISTS (SELECT 1 FROM ops.invoice i WHERE i.import_job_id = $2 AND i.unit_id = c.unit_id AND i.billed_party_id = c.party_id)`,
        [jur.tenantId, ids.job2],
      ),
    ).toBe(120);
    // no rollback after go-live
    const late = await t.http
      .post(`/v1/owner/juristic/imports/${ids.job2}/actions/rollback`)
      .set({ ...J(), ...idem() })
      .send({ reason: 'too late now' })
      .expect(409);
    expect(late.body.code).toBe('import.invalid_state');
  }, 240_000);

  it('full export: a ZIP with every juristic table of the tenant (+ register and billing), no encrypted columns', async () => {
    const ex = await t.http
      .post('/v1/owner/juristic/export')
      .set({ ...J(), ...idem() })
      .send({})
      .expect(202);
    expect(ex.body).toMatchObject({ kind: 'juristic_full_export', status: 'queued' });
    await settle(8);
    const row = await one<{ status: string; storage_key: string; error: string | null }>(
      `SELECT j.status::text, d.storage_key, j.error FROM ops.export_job j LEFT JOIN core.document d ON d.id = j.file_document_id WHERE j.id = $1`,
      [ex.body.id],
    );
    expect(row).toMatchObject({ status: 'done', error: null });
    const body = t.app.get<FakeObjectStorage>(OBJECT_STORAGE).objects.get(row.storage_key)!.body;
    const entries = unzip(body);
    const names = new Set(entries.map((e) => e.name));
    const juristic = await q<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'juristic' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`,
    );
    expect(juristic.length).toBeGreaterThanOrEqual(47);
    for (const tbl of juristic) expect(names.has(`juristic/${tbl.name}.csv`)).toBe(true);
    for (const tbl of [
      'core/unit.csv',
      'core/party.csv',
      'ops/invoice.csv',
      'ops/invoice_line.csv',
      'manifest.csv',
    ])
      expect(names.has(tbl)).toBe(true);
    const units = entries.find((e) => e.name === 'core/unit.csv')!.data.toString('utf8');
    expect(units.trim().split(/\r\n/)).toHaveLength(1 + 501);
    const party = entries.find((e) => e.name === 'core/party.csv')!.data.toString('utf8');
    expect(party.split(/\r\n/)[0]).not.toMatch(/id_number_enc|phone_hash/);
    const manifest = entries.find((e) => e.name === 'manifest.csv')!.data.toString('utf8');
    expect(manifest).toContain('juristic.import_job,');
    // nothing of another tenant
    expect(units).not.toContain(jur2.tenantId);
    // committee cannot export
    await t.http
      .post('/v1/owner/juristic/export')
      .set({ ...C(), ...idem() })
      .send({})
      .expect(403);
  }, 120_000);

  it('another tenant gets 404 on every import endpoint', async () => {
    const id = ids.job2!;
    await t.http.get(`/v1/owner/juristic/imports/${id}`).set(J2()).expect(404);
    await t.http.get(`/v1/owner/juristic/imports/${id}/rows`).set(J2()).expect(404);
    await t.http.get(`/v1/owner/juristic/imports/${id}/preview`).set(J2()).expect(404);
    await t.http.get(`/v1/owner/juristic/imports/${id}/bad-rows?sheet=register`).set(J2()).expect(404);
    await t.http.get(`/v1/owner/juristic/imports/${id}/parallel-cycle`).set(J2()).expect(404);
    await t.http
      .post(`/v1/owner/juristic/imports/${id}/files`)
      .set(J2())
      .send({ sheet: 'register', fileName: 'a.csv', content: b64('unit_no,owner_name\nA,B') })
      .expect(404);
    await t.http.post(`/v1/owner/juristic/imports/${id}/actions/validate`).set(J2()).expect(404);
    await t.http
      .post(`/v1/owner/juristic/imports/${id}/actions/reconcile`)
      .set(J2())
      .send({ declaredReceivables: '0.00' })
      .expect(404);
    for (const action of ['commit', 'go-live'])
      await t.http
        .post(`/v1/owner/juristic/imports/${id}/actions/${action}`)
        .set({ ...J2(), ...idem() })
        .send({})
        .expect(404);
    await t.http
      .post(`/v1/owner/juristic/imports/${id}/actions/rollback`)
      .set({ ...J2(), ...idem() })
      .send({ reason: 'not mine at all' })
      .expect(404);
    await t.http.post(`/v1/owner/juristic/imports/${id}/actions/cancel`).set(J2()).expect(404);
    await t.http
      .post(`/v1/owner/juristic/imports/${id}/parallel-cycle`)
      .set(J2())
      .send({ billingCycleId: ids.cycle, fileName: 'a.csv', content: b64('unit_no,amount\nA,1') })
      .expect(404);
    await t.http
      .post('/v1/owner/juristic/imports')
      .set(J2())
      .send({ buildingId: ids.building, asOfDate: AS_OF })
      .expect(404);
    const list = await t.http.get('/v1/owner/juristic/imports').set(J2()).expect(200);
    expect(list.body.data).toEqual([]);
  });
});

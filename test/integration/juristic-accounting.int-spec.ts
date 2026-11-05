import 'reflect-metadata';

import { LedgerService } from '@modules/ops-juristic/accounting/ledger.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const PHONE_J = '+660000000291';
const PHONE_J2 = '+660000000292';
const PHONE_COMMITTEE = '+66810002911';
const PHONE_MANAGER = '+66810002912';
const at = (d: string, time = '09:00:00') => new Date(`${d}T${time}+07:00`);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * J2.1 acceptance (D-311, D-312, D-329) on a juristic condominium: the database refuses unbalanced, one-sided and
 * edited journals and money out of a fund without a resolution; the ledger back-posts invoices / credit notes and
 * posts payments from their events; an annual invoice goes to unearned revenue and the monthly job recognises it
 * (filling `recognised_at`), a credit note takes the last months; the annual income statement equals the ledger sums,
 * the balance sheet balances and the GL receivable equals the receivables figures; expense approval bands with
 * maker-checker (also in the database), the committee never pays, the 50 ทวิ certificate (number + PDF); budget vs
 * actual has both sides; fund transfers out need a resolution and another user; petty cash spends and counts; bank
 * statement import is idempotent (file and overlapping lines) and matches payments and expenses; cross-tenant 404.
 */
describe('J2.1 light GL, expenses, funds, petty cash, bank statements (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let dev: string;
  let jur: { tenantId: string; token: string };
  let jur2: { tenantId: string; token: string };
  let committee: string;
  let manager: string;
  const ids: Record<string, string> = {};
  const acc: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const settle = async (n = 5) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const J = () => bearer(jur.token);
  const J2 = () => bearer(jur2.token);
  const C = () => bearer(committee);
  const M = () => bearer(manager);
  const ledger = () => t.app.get(LedgerService);
  const relogin = async () => {
    jur = { ...jur, token: await operatorToken(t, PHONE_J) };
    jur2 = { ...jur2, token: await operatorToken(t, PHONE_J2) };
    committee = await operatorToken(t, PHONE_COMMITTEE);
    manager = await operatorToken(t, PHONE_MANAGER);
    dev = await ownerToken(t);
  };
  const goTo = async (d: string) => {
    t.clock.set(at(d));
    await relogin();
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
  /** Balance of an account in the journals (debit − credit). */
  const gl = async (accountId: string) =>
    (
      await one<{ v: string }>(
        `SELECT COALESCE(sum(debit - credit), 0)::text AS v FROM juristic.journal_line WHERE account_id = $1`,
        [accountId],
      )
    ).v;
  const journalsOf = (sourceType: string, sourceId: string) =>
    q<{ id: string }>(`SELECT id FROM juristic.journal WHERE source_type = $1 AND source_id = $2`, [
      sourceType,
      sourceId,
    ]);

  /** An issued invoice of the juristic tenant with lines `{kind, amount, from?, to?}`. */
  async function invoice(
    unitId: string,
    partyId: string,
    lines: { kind: string; amount: string; from?: string; to?: string }[],
    opts: { issuedAt: string; dueDate: string; number: string },
  ): Promise<{ id: string; lineIds: string[] }> {
    const total = lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
    const id = (
      await one<{ id: string }>(
        `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, period_start, period_end, subtotal, total, balance)
         VALUES ($1, $2, $3, $4, '2027-01-01', '2027-12-31', $5, $5, $5) RETURNING id`,
        [jur.tenantId, ids.building, unitId, partyId, total],
      )
    ).id;
    const lineIds: string[] = [];
    for (const [i, l] of lines.entries())
      lineIds.push(
        (
          await one<{ id: string }>(
            `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit, unit_price, amount, period_from, period_to)
             VALUES ($1, $2, $3, $4::ops.invoice_line_source_type, $4::text::ops.invoice_line_kind, $4, 1, 'month', $5, $5, $6, $7) RETURNING id`,
            [jur.tenantId, id, i + 1, l.kind, l.amount, l.from ?? null, l.to ?? null],
          )
        ).id,
      );
    await q(
      `UPDATE ops.invoice SET status = 'issued', number = $2, issued_at = $3, due_date = $4, snapshot = '{}' WHERE id = $1`,
      [id, opts.number, opts.issuedAt, opts.dueDate],
    );
    return { id, lineIds };
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_juristic_accounting' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(at('2027-01-02'));
    admin = await adminToken(t);
    dev = await ownerToken(t);
    jur = await onboardTenant(t, admin, { slug: 'j21-juristic', phone: PHONE_J, type: 'juristic' });
    jur2 = await onboardTenant(t, admin, { slug: 'j21-other', phone: PHONE_J2, type: 'juristic' });
    const property = await t.http
      .post('/v1/owner/properties')
      .set(J())
      .send({ code: 'C1', name: 'คอนโด J2.1', kind: 'condo' })
      .expect(201);
    ids.building = (
      await t.http
        .post('/v1/owner/buildings')
        .set(J())
        .send({
          propertyId: property.body.id,
          code: 'A',
          name: 'อาคาร A',
          type: 'condo',
          legalForm: 'condo_act',
        })
        .expect(201)
    ).body.id;
    for (const n of [1, 2])
      ids[`u${n}`] = (
        await t.http
          .post('/v1/owner/units')
          .set(J())
          .send({ buildingId: ids.building, unitNo: `A-30${n}`, type: 'condo_unit', areaSqm: '40.00' })
          .expect(201)
      ).body.id;
    const add = async (unit: string, name: string) =>
      (
        await t.http
          .post(`/v1/owner/juristic/register/units/${unit}/owners`)
          .set(J())
          .send({ sharePct: '100', validFrom: '2020-01-01', party: { type: 'person', displayName: name } })
          .expect(201)
      ).body.owners[0].party.id as string;
    ids.P = await add(ids.u1!, 'สมชาย ห้องหนึ่ง');
    ids.Q = await add(ids.u2!, 'สมหญิง ห้องสอง');
    // the other juristic tenant: a building of its own (cross-tenant checks)
    const p2 = await t.http
      .post('/v1/owner/properties')
      .set(J2())
      .send({ code: 'C2', name: 'อื่น', kind: 'condo' })
      .expect(201);
    ids.building2 = (
      await t.http
        .post('/v1/owner/buildings')
        .set(J2())
        .send({ propertyId: p2.body.id, code: 'B', name: 'อาคาร B', type: 'condo', legalForm: 'condo_act' })
        .expect(201)
    ).body.id;
    // a confirmed tenant bank account (the OTP flow is covered elsewhere)
    ids.bank = (
      await one<{ id: string }>(
        `INSERT INTO platform.tenant_bank_account (tenant_id, bank_code, bank_name_th, account_no_enc, account_no_hash, account_no_masked,
                                                   account_name, state, is_default, confirmed_at)
         VALUES ($1, '004', 'ธนาคารกสิกรไทย', '\\x01', '\\x02', 'xxx-x-x4321-x', 'นิติบุคคลอาคารชุด J21', 'active', true, now()) RETURNING id`,
        [jur.tenantId],
      )
    ).id;
    // committee and manager members (maker-checker needs other users)
    for (const [role, phone] of [
      ['committee', PHONE_COMMITTEE],
      ['manager', PHONE_MANAGER],
    ] as const) {
      const inv = await t.http
        .post('/v1/owner/invitations')
        .set(J())
        .send({ role, phone, channel: 'link' })
        .expect(201);
      await operatorToken(t, phone, inv.body.code as string);
    }
    ids.committeeUser = (
      await one<{ user_id: string }>(
        `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = 'committee'`,
        [jur.tenantId],
      )
    ).user_id;
    ids.managerUser = (
      await one<{ user_id: string }>(
        `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = 'manager'`,
        [jur.tenantId],
      )
    ).user_id;
    ids.ownerUser = (
      await one<{ user_id: string }>(
        `SELECT user_id FROM core.membership WHERE tenant_id = $1 AND role = 'owner'`,
        [jur.tenantId],
      )
    ).user_id;
    ids.evidence = await doc(jur.tenantId);
    await relogin();
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('chart of accounts per legal form; the database refuses unbalanced, one-sided and edited journals', async () => {
    const chart = await t.http.get('/v1/owner/juristic/accounts').set(J()).expect(200);
    for (const a of chart.body.data as { code: string; id: string; role: string | null }[])
      acc[a.code] = a.id;
    expect(chart.body.data).toHaveLength(23);
    expect(chart.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: '1140', role: 'receivable', type: 'asset', isSystem: true }),
        expect.objectContaining({ code: '2130', role: 'unearned', type: 'liability' }),
        expect.objectContaining({ code: '4110', role: 'income_common_fee', nameTh: 'รายได้ค่าส่วนกลาง' }),
        expect.objectContaining({ code: '5140', role: 'exp_services', type: 'expense' }),
      ]),
    );
    // apartments have no juristic accounting
    await t.http.get('/v1/owner/juristic/accounts').set(bearer(dev)).expect(404);
    const added = await t.http
      .post('/v1/owner/juristic/accounts')
      .set(J())
      .send({ code: '5145', nameTh: 'ค่าดูแลสวน', nameEn: 'Gardening', type: 'expense' })
      .expect(201);
    acc['5145'] = added.body.id;
    const dup = await t.http
      .post('/v1/owner/juristic/accounts')
      .set(J())
      .send({ code: '5145', nameTh: 'x', nameEn: 'x', type: 'expense' })
      .expect(409);
    expect(dup.body.code).toBe('account.code_taken');
    const sys = await t.http
      .patch(`/v1/owner/juristic/accounts/${acc['1140']}`)
      .set(J())
      .send({ isActive: false })
      .expect(422);
    expect(sys.body.code).toBe('account.system');
    await t.http
      .patch(`/v1/owner/juristic/accounts/${acc['5145']}`)
      .set(J())
      .send({ nameTh: 'ค่าจ้างดูแลสวน', version: 1 })
      .expect(200);
    await t.http
      .patch(`/v1/owner/juristic/accounts/${acc['5145']}`)
      .set(J())
      .send({ nameTh: 'x', version: 1 })
      .expect(412);

    // the database: balanced at commit, at least two lines, immutable
    const tryJournal = async (lines: [string, string, string][]) => {
      const client = db.admin;
      try {
        await client.query('BEGIN');
        const j = await client.query<{ id: string }>(
          `INSERT INTO juristic.journal (tenant_id, building_id, posted_on, source_type, memo) VALUES ($1, $2, '2027-01-02', 'manual', 'db test') RETURNING id`,
          [jur.tenantId, ids.building],
        );
        for (const [i, [account, debit, credit]] of lines.entries())
          await client.query(
            `INSERT INTO juristic.journal_line (tenant_id, journal_id, line_no, account_id, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)`,
            [jur.tenantId, j.rows[0]!.id, i + 1, account, debit, credit],
          );
        await client.query('COMMIT');
        return j.rows[0]!.id;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    };
    await expect(tryJournal([[acc['1130']!, '100.00', '0']])).rejects.toThrow(/needs a debit and a credit/);
    await expect(
      tryJournal([
        [acc['1130']!, '100.00', '0'],
        [acc['4190']!, '0', '99.99'],
      ]),
    ).rejects.toThrow(/not balanced/);
    await expect(
      tryJournal([
        [acc['1130']!, '100.00', '100.00'],
        [acc['4190']!, '0', '0'],
      ]),
    ).rejects.toThrow(/journal_line_side_check/);
    const ok = await tryJournal([
      [acc['1130']!, '100.00', '0'],
      [acc['4190']!, '0', '100.00'],
    ]);
    await expect(q(`UPDATE juristic.journal SET memo = 'changed' WHERE id = $1`, [ok])).rejects.toThrow(
      /immutable/,
    );
    await expect(q(`DELETE FROM juristic.journal_line WHERE journal_id = $1`, [ok])).rejects.toThrow(
      /immutable/,
    );
    // reverse it by hand so the books are clean again (a manual journal is reversible)
    await t.http
      .post(`/v1/owner/juristic/journals/${ok}/actions/reverse`)
      .set(J())
      .set(idem())
      .send({ reason: 'ทดสอบฐานข้อมูล' })
      .expect(200);
    const again = await t.http
      .post(`/v1/owner/juristic/journals/${ok}/actions/reverse`)
      .set(J())
      .set(idem())
      .send({ reason: 'ซ้ำ' })
      .expect(409);
    expect(again.body.code).toBe('journal.already_reversed');
    expect(await gl(acc['1130']!)).toBe('0.00');

    // a fund (the sinking fund is created with the first contribution; a reserve by hand): money out needs a resolution
    const reserve = await t.http
      .post('/v1/owner/juristic/funds')
      .set(J())
      .send({
        buildingId: ids.building,
        kind: 'reserve',
        name: 'เงินสำรองซ่อมลิฟต์',
        bankAccountId: ids.bank,
      })
      .expect(201);
    ids.reserve = reserve.body.id;
    await expect(
      tryJournal([
        [acc['1130']!, '10.00', '0'],
        [reserve.body.ledgerBankAccountId as string, '0', '10.00'],
      ]),
    ).rejects.toThrow(/out of a fund without a resolution/);
    // manual journals through the API: unbalanced 422, no Idempotency-Key 400, posted 201
    const unbalanced = await t.http
      .post('/v1/owner/juristic/journals')
      .set(J())
      .set(idem())
      .send({
        buildingId: ids.building,
        postedOn: '2027-01-02',
        memo: 'x',
        lines: [
          { accountId: acc['1130'], debit: '5.00' },
          { accountId: acc['4190'], credit: '4.00' },
        ],
      })
      .expect(422);
    expect(unbalanced.body.code).toBe('journal.unbalanced');
    await t.http
      .post('/v1/owner/juristic/journals')
      .set(J())
      .send({ buildingId: ids.building, postedOn: '2027-01-02', memo: 'x', lines: [] })
      .expect(400);
    const fromFund = await t.http
      .post('/v1/owner/juristic/journals')
      .set(J())
      .set(idem())
      .send({
        buildingId: ids.building,
        postedOn: '2027-01-02',
        memo: 'ถอนจากกองทุน',
        lines: [
          { accountId: acc['1130'], debit: '5.00' },
          { accountId: reserve.body.ledgerBankAccountId, credit: '5.00' },
        ],
      })
      .expect(422);
    expect(fromFund.body.code).toBe('fund.resolution_required');
  });

  it('annual invoice → unearned → monthly recognition (fills the schedule); credit note from the last months; payments posted from events; GL receivable = receivables', async () => {
    // the annual common fee + fund contribution of A-301, billed in advance on 1 January (D-323 schedule rows)
    const annual = await invoice(
      ids.u1!,
      ids.P!,
      [
        { kind: 'common_fee', amount: '12000.00', from: '2027-01-01', to: '2027-12-31' },
        { kind: 'fund', amount: '1200.00', from: '2027-01-01', to: '2027-12-31' },
      ],
      { issuedAt: '2027-01-01T09:00:00+07:00', dueDate: '2027-01-31', number: 'INV-2027-90001' },
    );
    ids.annual = annual.id;
    ids.annualCfLine = annual.lineIds[0]!;
    for (const [lineId, monthly] of [
      [annual.lineIds[0]!, '1000.00'],
      [annual.lineIds[1]!, '100.00'],
    ] as const)
      for (let m = 1; m <= 12; m += 1)
        await q(
          `INSERT INTO juristic.revenue_schedule (tenant_id, invoice_line_id, month, amount) VALUES ($1, $2, $3, $4)`,
          [jur.tenantId, lineId, `2027-${String(m).padStart(2, '0')}-01`, monthly],
        );
    // a monthly invoice of A-302
    const monthly = await invoice(
      ids.u2!,
      ids.Q!,
      [{ kind: 'common_fee', amount: '1000.00', from: '2027-02-01', to: '2027-02-28' }],
      {
        issuedAt: '2027-02-01T09:00:00+07:00',
        dueDate: '2027-02-28',
        number: 'INV-2027-90002',
      },
    );
    ids.monthly = monthly.id;

    await goTo('2027-03-10');
    // the invoices were written without events: the job back-posts them, then recognises January … March
    const first = await ledger().run();
    expect(first.posted).toBeGreaterThanOrEqual(2);
    expect(first.recognised).toBe(6);
    expect(await journalsOf('invoice', ids.annual)).toHaveLength(1);
    const schedule = await q<{
      month: string;
      recognised_amount: string | null;
      recognised_at: Date | null;
      journal_id: string | null;
      amount: string;
    }>(
      `SELECT to_char(month, 'YYYY-MM') AS month, recognised_amount::text, recognised_at, journal_id, amount::text
         FROM juristic.revenue_schedule WHERE invoice_line_id = $1 ORDER BY month`,
      [ids.annualCfLine],
    );
    expect(
      schedule.slice(0, 3).every((r) => r.recognised_at && r.journal_id && r.recognised_amount === '1000.00'),
    ).toBe(true);
    expect(schedule.slice(3).every((r) => r.recognised_at === null)).toBe(true);
    // fund contributions are fund equity (D-329): recognised without a journal
    const fundRows = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM juristic.revenue_schedule WHERE invoice_line_id = $1 AND recognised_at IS NOT NULL AND journal_id IS NULL`,
      [annual.lineIds[1]],
    );
    expect(fundRows[0]!.n).toBe(3);
    expect(await gl(acc['2130']!)).toBe('-9000.00'); // unearned: 12,000 − 3 months
    expect(await gl(acc['4110']!)).toBe('-4000.00'); // income: 3 months + the monthly invoice
    const funds = await t.http.get('/v1/owner/juristic/funds').set(J()).expect(200);
    const sinking = (funds.body.data as { kind: string; id: string; equityBalance: string }[]).find(
      (f) => f.kind === 'sinking',
    )!;
    expect(sinking.equityBalance).toBe('1200.00');
    ids.sinking = sinking.id;
    // the job again: nothing new (idempotent)
    const before = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM juristic.journal WHERE tenant_id = $1`,
      [jur.tenantId],
    );
    expect(await ledger().run()).toEqual({ posted: 0, recognised: 0 });
    const replay = await t.http
      .post('/v1/owner/juristic/ledger/actions/back-post')
      .set(J())
      .set(idem())
      .expect(200);
    expect(replay.body).toEqual({ posted: 0, recognised: 0 });
    expect(
      (
        await one<{ n: number }>(`SELECT count(*)::int AS n FROM juristic.journal WHERE tenant_id = $1`, [
          jur.tenantId,
        ])
      ).n,
    ).toBe(before.n);

    // a payment recorded through the API is posted by the subscriber (payment.confirmed)
    const pay = await t.http
      .post('/v1/owner/payments')
      .set(J())
      .set(idem())
      .send({
        invoiceId: ids.monthly,
        amount: '1000.00',
        method: 'bank_transfer_manual',
        paidAt: '2027-03-10T10:00:00+07:00',
        evidenceDocumentId: ids.evidence,
        reference: 'KB0310A001',
        notes: 'โอนผ่านธนาคารกสิกรไทย',
      })
      .expect(201);
    ids.payment = pay.body.id ?? pay.body.payment?.id;
    await settle();
    const payJournal = await journalsOf('payment', ids.payment!);
    expect(payJournal).toHaveLength(1);
    expect(await gl(acc['1130']!)).toBe('1000.00');

    // a credit note of 3,000 on the annual common fee: taken from December, November, October (not yet earned)
    const cn = await one<{ id: string }>(
      `INSERT INTO ops.credit_note (tenant_id, building_id, unit_id, invoice_id, number, reason, reason_text, subtotal, total, issued_at)
       VALUES ($1, $2, $3, $4, 'CRN-2027-90001', 'goodwill', 'ส่วนลดตามมติ', 3000, 3000, '2027-03-10T11:00:00+07:00') RETURNING id`,
      [jur.tenantId, ids.building, ids.u1, ids.annual],
    );
    await q(
      `INSERT INTO ops.credit_note_line (tenant_id, note_id, line_no, line_kind, description, amount, ref_invoice_line_id)
       VALUES ($1, $2, 1, 'common_fee', 'ส่วนลด', 3000, $3)`,
      [jur.tenantId, cn.id, ids.annualCfLine],
    );
    await q(`UPDATE ops.invoice SET balance = balance - 3000, credited_total = 3000 WHERE id = $1`, [
      ids.annual,
    ]);
    expect((await ledger().run()).posted).toBe(1);
    const credited = await q<{ month: string; credited: string }>(
      `SELECT to_char(month, 'MM') AS month, credited_amount::text AS credited FROM juristic.revenue_schedule
        WHERE invoice_line_id = $1 AND credited_amount > 0 ORDER BY month`,
      [ids.annualCfLine],
    );
    expect(credited).toEqual([
      { month: '10', credited: '1000.00' },
      { month: '11', credited: '1000.00' },
      { month: '12', credited: '1000.00' },
    ]);
    expect(await gl(acc['2130']!)).toBe('-6000.00');

    // invariant: the GL receivable equals the receivables figures (open balances − credit + plans not invoiced)
    const lr = await t.http.get('/v1/owner/juristic/reports/ledger-receivables').set(J()).expect(200);
    expect(lr.body.total).toMatchObject({
      ledgerReceivable: '10200.00',
      openInvoices: '10200.00',
      difference: '0.00',
    });

    // December: April … September recognised; October … December credited → recognised 0 without a journal
    await goTo('2027-12-15');
    expect((await ledger().run()).recognised).toBe(18);
    const all = await q<{ month: string; recognised_amount: string; journal_id: string | null }>(
      `SELECT to_char(month, 'MM') AS month, recognised_amount::text, journal_id FROM juristic.revenue_schedule
        WHERE invoice_line_id = $1 ORDER BY month`,
      [ids.annualCfLine],
    );
    expect(all.map((r) => r.recognised_amount)).toEqual([
      ...Array(9).fill('1000.00'),
      '0.00',
      '0.00',
      '0.00',
    ]);
    expect(all.slice(9).every((r) => r.journal_id === null)).toBe(true);
    expect(await gl(acc['2130']!)).toBe('0.00');
    expect(await gl(acc['4110']!)).toBe('-10000.00');

    // the annual income statement equals the ledger sums (invariant), months add up to the year
    const year = await t.http
      .get('/v1/owner/juristic/reports/income-statement?from=2027-01-01&to=2027-12-31&granularity=year')
      .set(J())
      .expect(200);
    const sums = await one<{ income: string; expense: string }>(
      `SELECT COALESCE(sum(CASE WHEN a.type = 'income' THEN l.credit - l.debit END), 0)::text AS income,
              COALESCE(sum(CASE WHEN a.type = 'expense' THEN l.debit - l.credit END), 0)::text AS expense
         FROM juristic.journal_line l JOIN juristic.journal j ON j.id = l.journal_id JOIN juristic.account a ON a.id = l.account_id
        WHERE j.tenant_id = $1 AND j.posted_on BETWEEN '2027-01-01' AND '2027-12-31'`,
      [jur.tenantId],
    );
    expect(year.body.income.total).toBe(Number(sums.income).toFixed(2));
    expect(year.body.expense.total).toBe(Number(sums.expense).toFixed(2));
    expect(year.body.income.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: '4110', total: '10000.00' })]),
    );
    const months = await t.http
      .get('/v1/owner/juristic/reports/income-statement?from=2027-01-01&to=2027-12-31&granularity=month')
      .set(J())
      .expect(200);
    expect(months.body.periods).toHaveLength(12);
    expect(months.body.income.total).toBe(year.body.income.total);
    const quarters = await t.http
      .get('/v1/owner/juristic/reports/income-statement?from=2027-01-01&to=2027-12-31&granularity=quarter')
      .set(J())
      .expect(200);
    expect(quarters.body.periods).toEqual(['2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4']);
    expect(quarters.body.surplus).toBe(year.body.surplus);
    const bs = await t.http.get('/v1/owner/juristic/reports/balance-sheet').set(J()).expect(200);
    expect(bs.body.balanced).toBe(true);
    const tb = await t.http.get('/v1/owner/juristic/reports/trial-balance').set(J()).expect(200);
    expect(tb.body.balanced).toBe(true);

    // exports: the three formats are queued and built by the worker
    for (const format of ['csv', 'express', 'flowaccount']) {
      const ex = await t.http
        .post('/v1/owner/juristic/ledger/exports')
        .set(J())
        .set(idem())
        .send({ format, from: '2027-01-01', to: '2027-12-31', buildingId: ids.building })
        .expect(202);
      await settle();
      const job = await t.http.get(`/v1/owner/exports/${ex.body.id}`).set(J()).expect(200);
      expect(job.body).toMatchObject({ status: 'done' });
      expect(job.body.rowCount).toBeGreaterThan(10);
    }
    // a journal posted from a document is corrected by its document
    const inv = (await journalsOf('invoice', ids.annual))[0]!;
    const nr = await t.http
      .post(`/v1/owner/juristic/journals/${inv.id}/actions/reverse`)
      .set(J())
      .set(idem())
      .send({ reason: 'ทดสอบ' })
      .expect(409);
    expect(nr.body.code).toBe('journal.not_reversible');
    const got = await t.http.get(`/v1/owner/juristic/journals/${inv.id}`).set(J()).expect(200);
    expect(got.body).toMatchObject({ sourceType: 'invoice', total: '13200.00' });
    const list = await t.http
      .get(`/v1/owner/juristic/journals?sourceType=revenue_recognition&perPage=50`)
      .set(J())
      .expect(200);
    expect(list.body.meta.total).toBe(9);
  });

  it('expenses: approval bands, maker-checker (API and database), the committee never pays, 50 ทวิ certificate; budget vs actual both sides', async () => {
    const vendor = await t.http
      .post('/v1/owner/parties')
      .set(J())
      .send({ type: 'company', displayName: 'บริษัท รักษาความปลอดภัย ทดสอบ จำกัด', taxId: '0105550000017' })
      .expect(201);
    ids.vendor = vendor.body.id;
    const draft = await t.http
      .post('/v1/owner/juristic/expense-requests')
      .set(J())
      .send({
        buildingId: ids.building,
        title: 'ค่ารักษาความปลอดภัย ธันวาคม 2570',
        payeePartyId: ids.vendor,
        lines: [
          {
            accountId: acc['5140'],
            description: 'ค่าจ้างรักษาความปลอดภัย',
            amount: '42800.00',
            vatAmount: '2800.00',
            whtKey: 'service',
          },
        ],
      })
      .expect(201);
    expect(draft.body).toMatchObject({
      state: 'draft',
      amount: '42800.00',
      whtAmount: '1200.00',
      netAmount: '41600.00',
      number: null,
    });
    ids.expense = draft.body.id;
    // a line must be an expense account; unknown WHT keys refused
    await t.http
      .post('/v1/owner/juristic/expense-requests')
      .set(J())
      .send({
        buildingId: ids.building,
        title: 'x',
        payeeName: 'x',
        lines: [{ accountId: acc['1130'], description: 'x', amount: '1.00' }],
      })
      .expect(422);
    await t.http
      .post('/v1/owner/juristic/expense-requests')
      .set(J())
      .send({
        buildingId: ids.building,
        title: 'x',
        payeeName: 'x',
        lines: [{ accountId: acc['5140'], description: 'x', amount: '1.00', whtKey: 'nope' }],
      })
      .expect(422);
    const submitted = await t.http
      .post(`/v1/owner/juristic/expense-requests/${ids.expense}/actions/submit`)
      .set(J())
      .set(idem())
      .expect(200);
    expect(submitted.body).toMatchObject({
      state: 'submitted',
      number: 'EXP-2027-00001',
      approvalsRequired: 2,
      band: { key: 'le:100000.00', roles: ['owner', 'manager', 'committee'], approvals: 2 },
    });
    // the requester never approves (API 403, and the database refuses it)
    const self = await t.http
      .post(`/v1/owner/juristic/expense-requests/${ids.expense}/actions/approve`)
      .set(J())
      .set(idem())
      .send({})
      .expect(403);
    expect(self.body.code).toBe('expense.maker_checker');
    await expect(
      q(
        `INSERT INTO juristic.expense_approval (tenant_id, expense_request_id, approver_user_id, role, decision, band_key) VALUES ($1, $2, $3, 'owner', 'approved', 'x')`,
        [jur.tenantId, ids.expense, ids.ownerUser],
      ),
    ).rejects.toThrow(/maker-checker/);
    const one1 = await t.http
      .post(`/v1/owner/juristic/expense-requests/${ids.expense}/actions/approve`)
      .set(C())
      .set(idem())
      .send({ reason: 'ตรวจแล้ว' })
      .expect(200);
    expect(one1.body).toMatchObject({ state: 'submitted', approvalsGiven: 1 });
    const twice = await t.http
      .post(`/v1/owner/juristic/expense-requests/${ids.expense}/actions/approve`)
      .set(C())
      .set(idem())
      .send({})
      .expect(409);
    expect(twice.body.code).toBe('expense.already_decided');
    const awaiting = await t.http
      .get('/v1/owner/juristic/expense-requests?awaitingMe=true')
      .set(M())
      .expect(200);
    expect((awaiting.body.data as { id: string }[]).map((r) => r.id)).toEqual([ids.expense]);
    const approved = await t.http
      .post(`/v1/owner/juristic/expense-requests/${ids.expense}/actions/approve`)
      .set(M())
      .set(idem())
      .send({})
      .expect(200);
    expect(approved.body).toMatchObject({ state: 'approved', approvalsGiven: 2 });
    // the committee approves but never moves money (D-320)
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${ids.expense}/actions/pay`)
      .set(C())
      .set(idem())
      .send({ method: 'bank_transfer', paidOn: '2027-12-15', evidenceDocumentId: ids.evidence })
      .expect(403);
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${ids.expense}/actions/pay`)
      .set(M())
      .set(idem())
      .send({ method: 'bank_transfer', paidOn: '2027-12-15' })
      .expect(422);
    const paid = await t.http
      .post(`/v1/owner/juristic/expense-requests/${ids.expense}/actions/pay`)
      .set(M())
      .set(idem())
      .send({
        method: 'bank_transfer',
        paidOn: '2027-12-15',
        reference: 'KB1215-8812',
        evidenceDocumentId: ids.evidence,
      })
      .expect(200);
    expect(paid.body).toMatchObject({
      state: 'paid',
      paymentMethod: 'bank_transfer',
      certificate: { number: 'WHT-2027-00001', tax: '1200.00' },
    });
    expect(await gl(acc['5140']!)).toBe('42800.00');
    expect(await gl(acc['2120']!)).toBe('-1200.00');
    expect(await gl(acc['1130']!)).toBe('-40600.00'); // 1,000 received − 41,600 paid
    await settle();
    const cert = await t.http
      .get(`/v1/owner/juristic/withholding-certificates/${paid.body.certificate.id}`)
      .set(J())
      .expect(200);
    expect(cert.body).toMatchObject({
      form: 'pnd53',
      payeeTaxIdHint: '0017',
      base: '40000.00',
      tax: '1200.00',
    });
    expect(cert.body.documentId).toEqual(expect.any(String));
    const pdf = await t.http
      .get(`/v1/owner/juristic/withholding-certificates/${cert.body.id}/document`)
      .set(J())
      .expect(200);
    expect(pdf.body.number).toBe('WHT-2027-00001');
    // WHT needs the payee's tax id
    const noTax = await t.http
      .post('/v1/owner/parties')
      .set(J())
      .send({ type: 'person', displayName: 'ช่างไฟ ไม่มีเลขภาษี' })
      .expect(201);
    const e2 = await t.http
      .post('/v1/owner/juristic/expense-requests')
      .set(J())
      .send({
        buildingId: ids.building,
        title: 'ค่าซ่อมไฟ',
        payeePartyId: noTax.body.id,
        lines: [
          { accountId: acc['5130'], description: 'ซ่อมไฟทางเดิน', amount: '3000.00', whtKey: 'service' },
        ],
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${e2.body.id}/actions/submit`)
      .set(J())
      .set(idem())
      .expect(200);
    // ≤ 10,000: one approval is enough
    const small = await t.http
      .post(`/v1/owner/juristic/expense-requests/${e2.body.id}/actions/approve`)
      .set(C())
      .set(idem())
      .send({})
      .expect(200);
    expect(small.body).toMatchObject({ state: 'approved', approvalsRequired: 1 });
    const missingTax = await t.http
      .post(`/v1/owner/juristic/expense-requests/${e2.body.id}/actions/pay`)
      .set(M())
      .set(idem())
      .send({ method: 'cash', paidOn: '2027-12-15' })
      .expect(422);
    expect(missingTax.body.code).toBe('wht.payee_tax_id_missing');
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${e2.body.id}/actions/cancel`)
      .set(J())
      .set(idem())
      .send({ reason: 'รอเลขผู้เสียภาษี' })
      .expect(200);

    // budget vs actual — both sides (the expense line measured on its account)
    const res = await t.http
      .post('/v1/owner/juristic/resolutions')
      .set(J())
      .send({
        buildingId: ids.building,
        meetingKind: 'agm',
        meetingDate: '2026-12-10',
        number: '1/2569',
        title: 'งบประมาณ 2570',
        text: 'อนุมัติงบประมาณ',
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/juristic/resolutions/${res.body.id}/actions/adopt`)
      .set(J())
      .set(idem())
      .expect(200);
    ids.resolution = res.body.id;
    const budget = await t.http
      .post('/v1/owner/juristic/budgets')
      .set(J())
      .send({
        buildingId: ids.building,
        fiscalYear: 2027,
        name: 'งบประมาณ 2570',
        lines: [
          { kind: 'expense', label: 'รักษาความปลอดภัย', amount: '480000.00', accountId: acc['5140'] },
          { kind: 'expense', label: 'อื่น ๆ', amount: '20000.00' },
          { kind: 'income', label: 'ค่าส่วนกลาง', amount: '13000.00' },
        ],
      })
      .expect(201);
    // an account of another tenant is refused
    const foreign = await t.http.get('/v1/owner/juristic/accounts').set(J2()).expect(200);
    await t.http
      .post('/v1/owner/juristic/budgets')
      .set(J())
      .send({
        buildingId: ids.building,
        fiscalYear: 2028,
        name: 'x',
        lines: [{ kind: 'expense', label: 'x', amount: '1.00', accountId: foreign.body.data[0].id }],
      })
      .expect(404);
    await t.http
      .post(`/v1/owner/juristic/budgets/${budget.body.id}/actions/approve`)
      .set(J())
      .set(idem())
      .send({ resolutionId: ids.resolution })
      .expect(200);
    const bva = await t.http
      .get(`/v1/owner/juristic/budgets/${budget.body.id}/actual-income`)
      .set(J())
      .expect(200);
    expect(bva.body).toMatchObject({
      expenseSideAvailable: true,
      budgetedExpense: '500000.00',
      actualExpense: '42800.00',
    });
    expect(bva.body.expenseLines).toEqual([
      expect.objectContaining({
        label: 'รักษาความปลอดภัย',
        budgeted: '480000.00',
        actual: '42800.00',
        remaining: '437200.00',
      }),
      expect.objectContaining({ label: 'อื่น ๆ', actual: null }),
    ]);
    expect(bva.body.billed).toBe('11200.00'); // 13,200 + 1,000 − the 3,000 credit note
  });

  it('funds: in and out by another user, out only with a resolution (API and database); expenses from a fund need one; petty cash', async () => {
    const tin = await t.http
      .post(`/v1/owner/juristic/funds/${ids.sinking}/transfers`)
      .set(J())
      .set(idem())
      .send({ direction: 'in', amount: '1000.00', transferOn: '2027-12-15', reference: 'TRF-IN-1' })
      .expect(201);
    expect(tin.body).toMatchObject({ state: 'requested', nextActions: [] });
    const own = await t.http
      .post(`/v1/owner/juristic/fund-transfers/${tin.body.id}/actions/approve`)
      .set(J())
      .set(idem())
      .send({})
      .expect(403);
    expect(own.body.code).toBe('fund.maker_checker');
    await t.http
      .post(`/v1/owner/juristic/fund-transfers/${tin.body.id}/actions/approve`)
      .set(M())
      .set(idem())
      .send({})
      .expect(200);
    ids.transferIn = tin.body.id;
    const noRes = await t.http
      .post(`/v1/owner/juristic/funds/${ids.sinking}/transfers`)
      .set(J())
      .set(idem())
      .send({ direction: 'out', amount: '400.00', transferOn: '2027-12-15' })
      .expect(422);
    expect(noRes.body.code).toBe('fund.resolution_required');
    await expect(
      q(
        `INSERT INTO juristic.fund_transfer (tenant_id, building_id, fund_id, direction, amount, counter_account_id, transfer_on, requested_by)
         VALUES ($1, $2, $3, 'out', 1, $4, '2027-12-15', $5)`,
        [jur.tenantId, ids.building, ids.sinking, acc['1130'], ids.ownerUser],
      ),
    ).rejects.toThrow(/fund_transfer_resolution_check/);
    const out = await t.http
      .post(`/v1/owner/juristic/funds/${ids.sinking}/transfers`)
      .set(J())
      .set(idem())
      .send({ direction: 'out', amount: '400.00', transferOn: '2027-12-15', resolutionId: ids.resolution })
      .expect(201);
    const posted = await t.http
      .post(`/v1/owner/juristic/fund-transfers/${out.body.id}/actions/approve`)
      .set(C())
      .set(idem())
      .send({})
      .expect(200);
    expect(posted.body).toMatchObject({ state: 'posted', journalId: expect.any(String) });
    const fund = await t.http.get(`/v1/owner/juristic/funds/${ids.sinking}`).set(J()).expect(200);
    expect(fund.body).toMatchObject({ bankBalance: '600.00', equityBalance: '800.00' });
    const fl = await t.http.get(`/v1/owner/juristic/funds/${ids.sinking}/ledger`).set(J()).expect(200);
    expect(fl.body.meta.total).toBe(4); // contribution, in, out (bank + equity)
    // an expense paid from a fund needs a resolution (API and DB CHECK)
    const needs = await t.http
      .post('/v1/owner/juristic/expense-requests')
      .set(J())
      .send({
        buildingId: ids.building,
        title: 'ซ่อมปั๊ม',
        payeeName: 'ช่างปั๊ม',
        fundId: ids.sinking,
        lines: [{ accountId: acc['5130'], description: 'ซ่อมปั๊ม', amount: '300.00' }],
      })
      .expect(422);
    expect(needs.body.code).toBe('fund.resolution_required');
    await expect(
      q(
        `INSERT INTO juristic.expense_request (tenant_id, building_id, title, payee_name, fund_id, requested_by) VALUES ($1, $2, 'x', 'x', $3, $4)`,
        [jur.tenantId, ids.building, ids.sinking, ids.ownerUser],
      ),
    ).rejects.toThrow(/expense_request_fund_resolution_check/);

    // petty cash: float, top-up (an expense request), spend with a receipt, count
    const pc = await t.http
      .post('/v1/owner/juristic/petty-cash')
      .set(J())
      .send({
        buildingId: ids.building,
        name: 'เงินสดย่อยสำนักงาน',
        custodianUserId: ids.managerUser,
        floatAmount: '2000.00',
      })
      .expect(201);
    expect(pc.body).toMatchObject({ balance: '0.00', floatAmount: '2000.00' });
    ids.petty = pc.body.id;
    const top = await t.http
      .post('/v1/owner/juristic/expense-requests')
      .set(M())
      .send({
        buildingId: ids.building,
        kind: 'petty_cash_top_up',
        title: 'เติมเงินสดย่อย',
        pettyCashId: ids.petty,
        amount: '2000.00',
      })
      .expect(201);
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${top.body.id}/actions/submit`)
      .set(M())
      .set(idem())
      .expect(200);
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${top.body.id}/actions/approve`)
      .set(C())
      .set(idem())
      .send({})
      .expect(200);
    await t.http
      .post(`/v1/owner/juristic/expense-requests/${top.body.id}/actions/pay`)
      .set(J())
      .set(idem())
      .send({ method: 'bank_transfer', paidOn: '2027-12-15', evidenceDocumentId: ids.evidence })
      .expect(200);
    const receipt = await doc(jur.tenantId);
    const spent = await t.http
      .post(`/v1/owner/juristic/petty-cash/${ids.petty}/spends`)
      .set(M())
      .set(idem())
      .send({
        amount: '350.00',
        spentOn: '2027-12-15',
        description: 'ค่าหลอดไฟทางเดิน',
        accountId: acc['5130'],
        receiptDocumentId: receipt,
      })
      .expect(200);
    expect(spent.body).toMatchObject({ balance: '1650.00' });
    const tooMuch = await t.http
      .post(`/v1/owner/juristic/petty-cash/${ids.petty}/spends`)
      .set(M())
      .set(idem())
      .send({
        amount: '5000.00',
        spentOn: '2027-12-15',
        description: 'x',
        accountId: acc['5130'],
        receiptDocumentId: receipt,
      })
      .expect(422);
    expect(tooMuch.body.code).toBe('petty_cash.insufficient');
    const counted = await t.http
      .post(`/v1/owner/juristic/petty-cash/${ids.petty}/counts`)
      .set(J())
      .set(idem())
      .send({ countedOn: '2027-12-15', countedAmount: '1600.00' })
      .expect(200);
    expect(counted.body).toMatchObject({ balance: '1600.00', lastCount: { difference: '-50.00' } });
    expect((counted.body.entries as { kind: string }[]).map((e) => e.kind)).toEqual(
      expect.arrayContaining(['top_up', 'spend', 'count_difference']),
    );
    expect(await gl(pc.body.accountId as string)).toBe('1600.00');
    // books still balance
    const bs = await t.http.get('/v1/owner/juristic/reports/balance-sheet').set(J()).expect(200);
    expect(bs.body.balanced).toBe(true);
  });

  it('bank statement import: idempotent per file and line, auto-matches payment and expense, manual queue', async () => {
    const csv = (rows: string[]) =>
      [
        'ธนาคารกสิกรไทย (ตัวอย่าง)',
        'วันที่,เวลา,รายการ,ถอนเงิน,ฝากเงิน,ยอดคงเหลือ,ช่องทาง,รายละเอียด',
        ...rows,
      ].join('\n');
    const rows = [
      '10/03/2570,10:05,รับโอนเงิน,,"1,000.00","101,000.00",K PLUS,KB0310A001',
      '15/12/2570,14:40,ชำระเงิน,"41,600.00",,"59,400.00",K BIZ,EXP-2027-00001',
      '15/12/2570,15:00,รับโอนเงิน,,"777.00","60,177.00",PromptPay,UNKNOWN',
      '16/12/2570,08:00,ค่าธรรมเนียม,15.00,,"60,162.00",SYSTEM,ค่าธรรมเนียม',
    ];
    const first = await t.http
      .post('/v1/owner/juristic/bank-statements')
      .set(J())
      .set(idem())
      .send({ bankAccountId: ids.bank, formatKey: 'kbank', fileName: 'kbank-1.csv', content: b64(csv(rows)) })
      .expect(201);
    expect(first.body).toMatchObject({ replayed: false, imported: 4, duplicates: 0, autoMatched: 2 });
    expect(first.body.statement).toMatchObject({
      matchedCount: 2,
      unmatchedCount: 2,
      periodStart: '2027-03-10',
      periodEnd: '2027-12-16',
    });
    const matched = await t.http
      .get(`/v1/owner/juristic/bank-statement-lines?state=matched&statementId=${first.body.statement.id}`)
      .set(J())
      .expect(200);
    expect(
      (matched.body.data as { matchKind: string; matchId: string }[]).map((l) => [l.matchKind, l.matchId]),
    ).toEqual([
      ['payment', ids.payment],
      ['expense', ids.expense],
    ]);
    // the same file again: nothing new
    const again = await t.http
      .post('/v1/owner/juristic/bank-statements')
      .set(J())
      .set(idem())
      .send({
        bankAccountId: ids.bank,
        formatKey: 'kbank',
        fileName: 'kbank-1-again.csv',
        content: b64(csv(rows)),
      })
      .expect(201);
    expect(again.body).toMatchObject({
      replayed: true,
      imported: 0,
      statement: { id: first.body.statement.id },
    });
    // an overlapping file: the two known lines are skipped
    const overlap = await t.http
      .post('/v1/owner/juristic/bank-statements')
      .set(J())
      .set(idem())
      .send({
        bankAccountId: ids.bank,
        formatKey: 'kbank',
        fileName: 'kbank-2.csv',
        content: b64(
          csv([rows[2]!, rows[3]!, '17/12/2570,09:00,รับโอนเงิน,,"50.00","60,212.00",PromptPay,NEW']),
        ),
      })
      .expect(201);
    expect(overlap.body).toMatchObject({ replayed: false, imported: 1, duplicates: 2 });
    const unreadable = await t.http
      .post('/v1/owner/juristic/bank-statements')
      .set(J())
      .set(idem())
      .send({ bankAccountId: ids.bank, formatKey: 'scb', fileName: 'wrong.csv', content: b64(csv(rows)) })
      .expect(422);
    expect(unreadable.body.code).toBe('bank_statement.unreadable');
    // the unmatched queue: the fee is ignored, the unknown credit cannot take the matched payment
    const queue = await t.http.get('/v1/owner/juristic/bank-statement-lines').set(J()).expect(200);
    expect(queue.body.meta.total).toBe(3);
    const fee = (queue.body.data as { amount: string; id: string }[]).find((l) => l.amount === '-15.00')!;
    const unknown = (queue.body.data as { amount: string; id: string }[]).find((l) => l.amount === '777.00')!;
    const ignored = await t.http
      .post(`/v1/owner/juristic/bank-statement-lines/${fee.id}/actions/ignore`)
      .set(J())
      .set(idem())
      .send({ reason: 'ค่าธรรมเนียมธนาคาร' })
      .expect(200);
    expect(ignored.body).toMatchObject({ matchKind: 'ignored', ignoreReason: 'ค่าธรรมเนียมธนาคาร' });
    const mismatch = await t.http
      .post(`/v1/owner/juristic/bank-statement-lines/${unknown.id}/actions/match`)
      .set(J())
      .set(idem())
      .send({ kind: 'payment', targetId: ids.payment })
      .expect(422);
    expect(mismatch.body.code).toBe('bank_statement.amount_mismatch');
    // undo the automatic payment match and match it by hand
    const auto = (matched.body.data as { id: string }[])[0]!;
    const undone = await t.http
      .post(`/v1/owner/juristic/bank-statement-lines/${auto.id}/actions/unmatch`)
      .set(J())
      .set(idem())
      .expect(200);
    expect(undone.body).toMatchObject({ matchKind: 'none' });
    expect(undone.body.suggestions).toEqual([
      expect.objectContaining({ kind: 'payment', id: ids.payment, referenceHit: true }),
    ]);
    const manual = await t.http
      .post(`/v1/owner/juristic/bank-statement-lines/${auto.id}/actions/match`)
      .set(J())
      .set(idem())
      .send({ kind: 'payment', targetId: ids.payment })
      .expect(200);
    expect(manual.body).toMatchObject({ matchKind: 'payment', matchMethod: 'manual' });
    const list = await t.http.get('/v1/owner/juristic/bank-statements').set(J()).expect(200);
    expect(list.body.meta.total).toBe(2);
  });

  it('cross-tenant ids are 404 on every endpoint; other tenants see empty lists; apartments have no accounting', async () => {
    const journal = (
      await q<{ id: string }>(
        `SELECT id FROM juristic.journal WHERE tenant_id = $1 AND source_type = 'manual' LIMIT 1`,
        [jur.tenantId],
      )
    )[0]!.id;
    const cert = (
      await one<{ id: string }>(`SELECT id FROM juristic.withholding_certificate WHERE tenant_id = $1`, [
        jur.tenantId,
      ])
    ).id;
    const statement = (
      await one<{ id: string }>(`SELECT id FROM juristic.bank_statement WHERE tenant_id = $1 LIMIT 1`, [
        jur.tenantId,
      ])
    ).id;
    const line = (
      await one<{ id: string }>(
        `SELECT id FROM juristic.bank_statement_line WHERE tenant_id = $1 AND match_kind = 'none' LIMIT 1`,
        [jur.tenantId],
      )
    ).id;
    const budget = (
      await one<{ id: string }>(`SELECT id FROM juristic.budget WHERE tenant_id = $1 LIMIT 1`, [jur.tenantId])
    ).id;
    const X = J2();
    const B = { buildingId: ids.building };
    const calls: [string, string, Record<string, unknown>?][] = [
      ['patch', `/v1/owner/juristic/accounts/${acc['5145']}`, { nameTh: 'x' }],
      ['get', `/v1/owner/juristic/journals/${journal}`],
      ['post', `/v1/owner/juristic/journals/${journal}/actions/reverse`, { reason: 'ทดสอบ' }],
      [
        'post',
        '/v1/owner/juristic/journals',
        {
          ...B,
          postedOn: '2027-12-15',
          memo: 'x',
          lines: [
            { accountId: acc['1130'], debit: '1.00' },
            { accountId: acc['4190'], credit: '1.00' },
          ],
        },
      ],
      ['get', `/v1/owner/juristic/journals?buildingId=${ids.building}`],
      [
        'get',
        `/v1/owner/juristic/reports/income-statement?from=2027-01-01&to=2027-12-31&buildingId=${ids.building}`,
      ],
      ['get', `/v1/owner/juristic/reports/balance-sheet?buildingId=${ids.building}`],
      ['get', `/v1/owner/juristic/reports/trial-balance?buildingId=${ids.building}`],
      ['get', `/v1/owner/juristic/reports/ledger-receivables?buildingId=${ids.building}`],
      [
        'post',
        '/v1/owner/juristic/ledger/exports',
        { format: 'csv', from: '2027-01-01', to: '2027-12-31', ...B },
      ],
      ['get', `/v1/owner/juristic/expense-requests/${ids.expense}`],
      ['patch', `/v1/owner/juristic/expense-requests/${ids.expense}`, { title: 'x' }],
      [
        'post',
        `/v1/owner/juristic/expense-requests/${ids.expense}/attachments`,
        { documentId: ids.evidence, kind: 'receipt' },
      ],
      ['post', `/v1/owner/juristic/expense-requests/${ids.expense}/actions/submit`],
      ['post', `/v1/owner/juristic/expense-requests/${ids.expense}/actions/approve`, {}],
      ['post', `/v1/owner/juristic/expense-requests/${ids.expense}/actions/reject`, { reason: 'ไม่อนุมัติ' }],
      ['post', `/v1/owner/juristic/expense-requests/${ids.expense}/actions/cancel`, { reason: 'ยกเลิก' }],
      [
        'post',
        `/v1/owner/juristic/expense-requests/${ids.expense}/actions/pay`,
        { method: 'cash', paidOn: '2027-12-15' },
      ],
      ['post', '/v1/owner/juristic/expense-requests', { ...B, title: 'x', payeeName: 'x', lines: [] }],
      ['get', `/v1/owner/juristic/withholding-certificates/${cert}`],
      ['get', `/v1/owner/juristic/withholding-certificates/${cert}/document`],
      ['get', `/v1/owner/juristic/funds/${ids.sinking}`],
      ['patch', `/v1/owner/juristic/funds/${ids.sinking}`, { name: 'x' }],
      ['get', `/v1/owner/juristic/funds/${ids.sinking}/ledger`],
      [
        'post',
        `/v1/owner/juristic/funds/${ids.sinking}/transfers`,
        { direction: 'in', amount: '1.00', transferOn: '2027-12-15' },
      ],
      ['post', '/v1/owner/juristic/funds', { ...B, kind: 'other', name: 'x' }],
      ['get', `/v1/owner/juristic/funds?buildingId=${ids.building}`],
      ['get', `/v1/owner/juristic/fund-transfers/${ids.transferIn}`],
      ['post', `/v1/owner/juristic/fund-transfers/${ids.transferIn}/actions/approve`, {}],
      [
        'post',
        `/v1/owner/juristic/fund-transfers/${ids.transferIn}/actions/reject`,
        { reason: 'ไม่อนุมัติ' },
      ],
      ['get', `/v1/owner/juristic/fund-transfers?fundId=${ids.sinking}`],
      ['get', `/v1/owner/juristic/petty-cash/${ids.petty}`],
      [
        'post',
        `/v1/owner/juristic/petty-cash/${ids.petty}/spends`,
        {
          amount: '1.00',
          spentOn: '2027-12-15',
          description: 'x',
          accountId: acc['5130'],
          receiptDocumentId: ids.evidence,
        },
      ],
      [
        'post',
        `/v1/owner/juristic/petty-cash/${ids.petty}/counts`,
        { countedOn: '2027-12-15', countedAmount: '1.00' },
      ],
      [
        'post',
        '/v1/owner/juristic/petty-cash',
        { ...B, name: 'x', custodianUserId: ids.managerUser, floatAmount: '1.00' },
      ],
      ['get', `/v1/owner/juristic/bank-statements/${statement}`],
      [
        'post',
        '/v1/owner/juristic/bank-statements',
        {
          bankAccountId: ids.bank,
          formatKey: 'kbank',
          fileName: 'x.csv',
          content: b64(
            'วันที่,เวลา,รายการ,ถอนเงิน,ฝากเงิน,ยอดคงเหลือ,ช่องทาง,รายละเอียด\n01/01/2570,,x,,1.00,1.00,,x',
          ),
        },
      ],
      ['get', `/v1/owner/juristic/bank-statement-lines/${line}`],
      ['get', `/v1/owner/juristic/bank-statement-lines?statementId=${statement}`],
      [
        'post',
        `/v1/owner/juristic/bank-statement-lines/${line}/actions/match`,
        { kind: 'payment', targetId: ids.payment },
      ],
      ['post', `/v1/owner/juristic/bank-statement-lines/${line}/actions/ignore`, { reason: 'ทดสอบ' }],
      ['post', `/v1/owner/juristic/bank-statement-lines/${line}/actions/unmatch`],
      ['get', `/v1/owner/juristic/budgets/${budget}/actual-income`],
    ];
    for (const [method, path, body] of calls) {
      const req = (t.http as unknown as Record<string, (p: string) => import('supertest').Test>)[method]!(
        path,
      )
        .set(X)
        .set(idem());
      const res = await (body ? req.send(body) : req);
      expect({ path: `${method} ${path}`, status: res.status }).toEqual({
        path: `${method} ${path}`,
        status: 404,
      });
    }
    // another juristic tenant sees its own (empty) books only
    for (const path of [
      '/v1/owner/juristic/journals',
      '/v1/owner/juristic/expense-requests',
      '/v1/owner/juristic/withholding-certificates',
      '/v1/owner/juristic/fund-transfers',
      '/v1/owner/juristic/bank-statements',
      '/v1/owner/juristic/bank-statement-lines?state=all',
    ]) {
      const res = await t.http.get(path).set(X).expect(200);
      expect(res.body.meta.total).toBe(0);
    }
    expect((await t.http.get('/v1/owner/juristic/funds').set(X).expect(200)).body.data).toEqual([]);
    expect((await t.http.get('/v1/owner/juristic/petty-cash').set(X).expect(200)).body.data).toEqual([]);
    // an apartment owner: no juristic accounting at all
    for (const path of [
      '/v1/owner/juristic/journals',
      '/v1/owner/juristic/expense-requests',
      '/v1/owner/juristic/funds',
      '/v1/owner/juristic/reports/balance-sheet',
    ])
      await t.http.get(path).set(bearer(dev)).expect(404);
    // nothing of the apartment was posted
    expect(
      (
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM juristic.journal j JOIN core.tenant t ON t.id = j.tenant_id WHERE t.type::text NOT IN ('juristic', 'condo_juristic')`,
        )
      ).n,
    ).toBe(0);
  });
});

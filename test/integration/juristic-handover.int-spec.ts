import 'reflect-metadata';

import { CONTRACT_FIXTURES_V2, signIntegrationWebhook } from '@collective/asset-core/contracts';
import { fakeLineIdToken } from '@collective/integrations/line';
import { type FakeGetbuildHandoff } from '@integrations/getbuild/fake-getbuild-handoff';
import { GETBUILD_HANDOFF } from '@integrations/getbuild/getbuild-handoff.port';
import { HandoversService } from '@modules/ops-juristic/handovers/handovers.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const IN_KEY = 'h'.repeat(48);
const PHONE_J = '+660000000331';
const PHONE_J2 = '+660000000332';
const PHONE_DEV = '+660000000333';
const LINE_BUYER = 'U-j32-buyer-1';
const at = (d: string, time = '09:00:00') => new Date(`${d}T${time}+07:00`);

type Envelope = Record<string, unknown> & { payload: Record<string, unknown> };

/** A v2 handover of three units (one owner, two co-owners 60 / 40, one without money) from the asset-core fixture. */
function handover(over: {
  key: string;
  buildingRef?: string;
  requestedHandoverAt?: string;
  fund?: string;
}): Envelope {
  const base = structuredClone(CONTRACT_FIXTURES_V2['building.handover.requested']!) as Envelope;
  const p = base.payload as Record<string, unknown> & { building: Record<string, unknown> };
  const buildingRef = over.buildingRef ?? 'bldg-j32';
  return {
    ...base,
    eventId: `0199f1c2-7a00-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    idempotencyKey: over.key,
    payload: {
      ...p,
      requestedHandoverAt: over.requestedHandoverAt ?? '2026-11-01T10:00:00+07:00',
      property: {
        ref: `prj-${buildingRef}`,
        code: 'J32',
        name: 'โครงการ J3.2',
        address: { province: 'กรุงเทพมหานคร' },
      },
      building: { ref: buildingRef, code: 'A', name: 'อาคาร A', type: 'condo', floorsCount: 2 },
      floors: [
        { ref: 'fl-1', level: 1, name: 'ชั้น 1' },
        { ref: 'fl-2', level: 2, name: 'ชั้น 2' },
      ],
      units: [
        {
          ref: 'u-101',
          floorRef: 'fl-1',
          unitNo: 'A-101',
          type: 'condo_unit',
          areaSqm: '32.50',
          ownershipRatio: '0.400000',
        },
        {
          ref: 'u-102',
          floorRef: 'fl-1',
          unitNo: 'A-102',
          type: 'condo_unit',
          areaSqm: '40.00',
          ownershipRatio: '0.400000',
        },
        {
          ref: 'u-201',
          floorRef: 'fl-2',
          unitNo: 'A-201',
          type: 'condo_unit',
          areaSqm: '16.25',
          ownershipRatio: '0.200000',
        },
      ],
      parties: [
        {
          ref: 'p-1',
          type: 'person',
          displayName: 'ผู้ซื้อ หนึ่ง',
          lineUserId: LINE_BUYER,
          phone: { enc: 'ZmFrZS1lbmNyeXB0ZWQtcGhvbmU=' },
        },
        { ref: 'p-2', type: 'person', displayName: 'ผู้ซื้อ สอง' },
        { ref: 'p-3', type: 'person', displayName: 'ผู้ซื้อ สาม' },
      ],
      unitOwnerships: [
        { unitRef: 'u-101', partyRef: 'p-1', sharePct: '100', validFrom: '2026-10-01' },
        { unitRef: 'u-102', partyRef: 'p-2', sharePct: '60', validFrom: '2026-10-01' },
        { unitRef: 'u-102', partyRef: 'p-3', sharePct: '40', validFrom: '2026-10-01' },
      ],
      warrantyTerms: [{ scope: 'building', ref: buildingRef, startsOn: '2026-11-01', endsOn: '2028-10-31' }],
      finance: {
        asOf: '2026-10-31',
        currency: 'THB',
        receivingBankAccount: {
          bankCode: '014',
          bankName: 'ธนาคารตัวอย่าง',
          accountName: 'นิติบุคคลอาคารชุด J3.2',
          accountNoMasked: 'XXX-X-XX1234',
        },
        units: [
          {
            unitRef: 'u-101',
            advanceCommonFees: { amount: '14400.00', periodFrom: '2026-11-01', periodTo: '2027-10-31' },
            firstFundContribution: over.fund ?? '16250.00',
            receivablesBroughtForward: [
              { ref: 'inv-9', description: 'ค่าส่วนกลาง ต.ค. 2569', amount: '1200.00', dueOn: '2026-10-31' },
            ],
          },
          {
            unitRef: 'u-102',
            advanceCommonFees: { amount: '1000.01', periodFrom: '2026-11-01', periodTo: '2027-01-31' },
            firstFundContribution: '500.00',
            receivablesBroughtForward: [
              { description: 'ค่าส่วนกลาง ก.ย. 2569', amount: '300.01' },
              { description: 'ค่าส่วนกลาง ต.ค. 2569', amount: '200.00' },
            ],
          },
        ],
      },
    },
  };
}

/**
 * J3.2 acceptance (D-314 = D-J13, D-333): a v2 `building.handover.requested` received on the signed webhook is stored
 * once per event (replay = duplicate; a corrected re-send supersedes the open one), assigned by the platform to a
 * juristic tenant and reviewed in its inbox; acceptance writes the register (parties never duplicated, the buyer's
 * LINE login linked), advance fees as the owners' credit by share, first fund contributions into the sinking fund,
 * receivables brought forward as OPB invoices — all equal to the payload, journals balanced; the resident sees the unit
 * and the opening balance with no gap across the operator switch at the juristic person's formation; a rejection goes
 * back through the getbuild port; another tenant gets 404.
 */
describe('J3.2 developer handover from getbuild (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let fake: FakeGetbuildHandoff;
  let admin: string;
  let jur: { tenantId: string; token: string };
  let jur2: { tenantId: string; token: string };
  let dev: { tenantId: string; token: string };
  let buyer: { access: string; refresh: string };
  const ids: Record<string, string> = {};

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const settle = async (k = 6) => {
    for (let i = 0; i < k; i += 1) await t.worker.tick();
  };
  const J = () => bearer(jur.token);
  const J2 = () => bearer(jur2.token);

  async function send(envelope: Envelope) {
    const body = JSON.stringify(envelope);
    const headers = signIntegrationWebhook({
      keys: [IN_KEY],
      body,
      eventId: envelope.idempotencyKey as string,
      source: 'getbuild',
      timestamp: Math.floor(t.clock.now().getTime() / 1000),
    });
    const res = await t.http
      .post('/webhooks/integration/getbuild')
      .set('content-type', 'application/json')
      .set(headers)
      .send(body)
      .expect(200);
    return res.body as { id: string; status: string };
  }
  const handoverOf = async (eventId: string) =>
    one<{ id: string; state: string; tenant_id: string | null }>(
      `SELECT id, state::text, tenant_id FROM juristic.handover WHERE integration_event_id = $1`,
      [eventId],
    );
  const refreshBuyer = async () => {
    const r = await t.http.post('/v1/auth/refresh').send({ refreshToken: buyer.refresh }).expect(200);
    buyer = { access: r.body.accessToken as string, refresh: r.body.refreshToken as string };
  };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_juristic_handover' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { INTEGRATION_GETBUILD_VERIFY_KEYS: IN_KEY, OTP_MAX_PER_HOUR: '20' });
    t.clock.set(at('2026-11-05'));
    fake = t.app.get<FakeGetbuildHandoff>(GETBUILD_HANDOFF);
    admin = await adminToken(t);
    jur = await onboardTenant(t, admin, { slug: 'j32-condo', phone: PHONE_J, type: 'juristic' });
    jur2 = await onboardTenant(t, admin, { slug: 'j32-other', phone: PHONE_J2, type: 'juristic' });
    dev = await onboardTenant(t, admin, { slug: 'j32-developer', phone: PHONE_DEV, type: 'pm_company' });
    ids.bank = (
      await one<{ id: string }>(
        `INSERT INTO platform.tenant_bank_account (tenant_id, bank_code, bank_name_th, account_no_enc, account_no_hash, account_no_masked,
                                                   account_name, state, is_default, confirmed_at)
         VALUES ($1, '014', 'ธนาคารตัวอย่าง', '\\x01', '\\x02', 'xxx-x-x1234', 'นิติบุคคลอาคารชุด J3.2', 'active', true, now()) RETURNING id`,
        [jur.tenantId],
      )
    ).id;
    // the buyer already uses getproperty with the LINE login getbuild knows (one LINE identity, D-153)
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_BUYER, name: 'ผู้ซื้อ หนึ่ง' }) })
      .expect(200);
    buyer = { access: login.body.accessToken as string, refresh: login.body.refreshToken as string };
    const R0 = bearer(buyer.access);
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
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('stores one handover per event: a replay is a duplicate, a corrected re-send supersedes the open one', async () => {
    const first = handover({ key: 'getbuild:handover:j32:v2:1', fund: '16000.00' });
    const r1 = await send(first);
    expect(r1.status).toBe('applied');
    expect((await send(first)).status).toBe('duplicate');
    const h1 = await handoverOf(r1.id);
    expect(h1).toMatchObject({ state: 'received', tenant_id: null });
    const corrected = handover({ key: 'getbuild:handover:j32:v2:2' });
    const r2 = await send(corrected);
    expect(r2.status).toBe('applied');
    expect((await handoverOf(r1.id)).state).toBe('superseded');
    const h2 = await handoverOf(r2.id);
    expect(h2.state).toBe('received');
    ids.handover = h2.id;
    ids.event = r2.id;
    // getbuild's encrypted contact envelopes are never kept (D-025)
    const stored = await one<{ payload: string }>(
      `SELECT payload::text FROM juristic.handover WHERE id = $1`,
      [h2.id],
    );
    expect(stored.payload).not.toContain('"enc"');
    expect(
      (await q(`SELECT 1 FROM platform.audit_log WHERE action = 'juristic.handover_superseded'`)).length,
    ).toBe(1);
  });

  it('the platform assigns it to the juristic tenant (developer operates until formation); the inbox shows the totals', async () => {
    const list = await t.http
      .get('/v1/admin/juristic-handovers?state=received')
      .set(bearer(admin))
      .expect(200);
    expect((list.body.data as { id: string }[]).map((x) => x.id)).toContain(ids.handover);
    await t.http
      .post(`/v1/admin/juristic-handovers/${ids.handover}/actions/assign`)
      .set(bearer(admin))
      .set(idem())
      .send({ juristicTenantId: dev.tenantId })
      .expect(422);
    const assigned = await t.http
      .post(`/v1/admin/juristic-handovers/${ids.handover}/actions/assign`)
      .set(bearer(admin))
      .set(idem())
      .send({ juristicTenantId: jur.tenantId, developerTenantId: dev.tenantId })
      .expect(200);
    expect(assigned.body).toMatchObject({ state: 'pending_review', tenantId: jur.tenantId });
    const review = await t.http.get(`/v1/owner/juristic/handovers/${ids.handover}`).set(J()).expect(200);
    expect(review.body).toMatchObject({
      state: 'pending_review',
      contractVersion: 2,
      totals: {
        units: 3,
        parties: 3,
        ownerships: 3,
        advanceCommonFees: '15400.01',
        firstFundContributions: '16750.00',
        receivablesBroughtForward: '1700.01',
      },
      receivingBank: { accountNoMasked: 'XXX-X-XX1234', matchedBankAccountId: ids.bank },
      problems: [],
      partiesToAttach: 0,
      partiesToCreate: 3,
      nextActions: ['accept', 'reject'],
    });
    expect(review.body.units).toHaveLength(3);
    const inbox = await t.http.get('/v1/owner/juristic/handovers').set(J()).expect(200);
    expect(inbox.body.data).toHaveLength(1);
  });

  it('another tenant gets 404; a non-juristic tenant has no inbox', async () => {
    await t.http.get(`/v1/owner/juristic/handovers/${ids.handover}`).set(J2()).expect(404);
    await t.http
      .post(`/v1/owner/juristic/handovers/${ids.handover}/actions/accept`)
      .set({ ...J2(), ...idem() })
      .send({ legalForm: 'condo_act' })
      .expect(404);
    await t.http
      .post(`/v1/owner/juristic/handovers/${ids.handover}/actions/reject`)
      .set({ ...J2(), ...idem() })
      .send({ reason: 'ไม่ใช่อาคารของเรา' })
      .expect(404);
    expect((await t.http.get('/v1/owner/juristic/handovers').set(J2()).expect(200)).body.data).toHaveLength(
      0,
    );
    await t.http.get('/v1/owner/juristic/handovers').set(bearer(dev.token)).expect(404);
    // tenant operators never reach the platform's handover list or assignment
    await t.http.get('/v1/admin/juristic-handovers').set(J2()).expect(403);
    await t.http
      .post(`/v1/admin/juristic-handovers/${ids.handover}/actions/assign`)
      .set({ ...J2(), ...idem() })
      .send({ juristicTenantId: jur2.tenantId })
      .expect(403);
  });

  it('accept writes the register, credits, fund and opening balances equal to the payload; journals balance', async () => {
    // getbuild sent no legal form: the office chooses it
    await t.http
      .post(`/v1/owner/juristic/handovers/${ids.handover}/actions/accept`)
      .set({ ...J(), ...idem() })
      .send({})
      .expect(422);
    const res = await t.http
      .post(`/v1/owner/juristic/handovers/${ids.handover}/actions/accept`)
      .set({ ...J(), ...idem() })
      .send({ legalForm: 'condo_act' })
      .expect(200);
    expect(res.body).toMatchObject({
      state: 'accepted',
      applied: {
        credits: '15400.01',
        openingInvoices: 3,
        openingInvoicesTotal: '1700.01',
        fundContributions: '16750.00',
      },
      nextActions: ['juristic_formed'],
    });
    ids.building = res.body.buildingId as string;
    await t.http
      .post(`/v1/owner/juristic/handovers/${ids.handover}/actions/accept`)
      .set({ ...J(), ...idem() })
      .send({ legalForm: 'condo_act' })
      .expect(409);
    const b = await one<Record<string, unknown>>(
      `SELECT b.owner_tenant_id, b.operator_tenant_id, b.legal_form::text, p.kind::text AS kind
         FROM core.building b JOIN core.property p ON p.id = b.property_id WHERE b.id = $1`,
      [ids.building],
    );
    expect(b).toEqual({
      owner_tenant_id: jur.tenantId,
      operator_tenant_id: dev.tenantId,
      legal_form: 'condo_act',
      kind: 'condo',
    });
    expect(
      await q(
        `SELECT reason::text, operator_tenant_id FROM core.building_operator_period WHERE building_id = $1`,
        [ids.building],
      ),
    ).toEqual([{ reason: 'handover', operator_tenant_id: dev.tenantId }]);
    const counts = await one<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM core.unit WHERE building_id = $1) AS units,
              (SELECT count(*)::int FROM core.floor WHERE building_id = $1) AS floors,
              (SELECT count(*)::int FROM core.unit_ownership WHERE building_id = $1) AS ownerships,
              (SELECT count(*)::int FROM core.party WHERE tenant_id = $2) AS parties`,
      [ids.building, jur.tenantId],
    );
    expect(counts).toEqual({ units: 3, floors: 2, ownerships: 3, parties: 4 }); // + the tenant's legal party
    // co-owners split by share, the satang remainder to the largest share
    const credits = await q<{ name: string; amount: string }>(
      `SELECT p.display_name AS name, c.amount::text FROM ops.payer_credit c JOIN core.party p ON p.id = c.party_id
        WHERE c.handover_id = $1 ORDER BY p.display_name`,
      [ids.handover],
    );
    expect(credits).toEqual([
      { name: 'ผู้ซื้อ สอง', amount: '600.01' },
      { name: 'ผู้ซื้อ สาม', amount: '400.00' },
      { name: 'ผู้ซื้อ หนึ่ง', amount: '14400.00' },
    ]);
    const invoices = await q<{ number: string; status: string; total: string; due: string }>(
      `SELECT number, status::text, total::text, due_date::text AS due FROM ops.invoice i WHERE handover_id = $1 ORDER BY i.total`,
      [ids.handover],
    );
    expect(invoices.map((i) => i.total)).toEqual(['200.00', '300.01', '1200.00']);
    for (const i of invoices) {
      expect(i.number).toMatch(/^OPB/);
      expect(i.status).toBe('issued');
      expect(i.due > '2026-11-05').toBe(true); // the normal due rule (lead time), not the developer's due date
    }
    await settle();
    // journals: the advance fees and the fund per unit, the opening invoices posted by the ledger; all balanced
    const journals = await q<{ source: string; d: string; c: string }>(
      `SELECT j.source_type::text AS source, sum(l.debit)::text AS d, sum(l.credit)::text AS c
         FROM juristic.journal j JOIN juristic.journal_line l ON l.journal_id = j.id
        WHERE j.building_id = $1 GROUP BY j.id, j.source_type ORDER BY j.source_type, sum(l.debit)`,
      [ids.building],
    );
    for (const j of journals) expect(j.d).toBe(j.c);
    expect(journals.filter((j) => j.source === 'handover').map((j) => j.d)).toEqual(['1500.01', '30650.00']);
    expect(journals.filter((j) => j.source === 'invoice')).toHaveLength(3);
    const fund = await one<{ total: string }>(
      `SELECT sum(l.debit - l.credit)::text AS total FROM juristic.journal_line l JOIN juristic.account a ON a.id = l.account_id
        WHERE a.tenant_id = $1 AND a.role = 'fund_bank'`,
      [jur.tenantId],
    );
    expect(fund.total).toBe('16750.00');
    const bankLine = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM juristic.journal_line l JOIN juristic.account a ON a.id = l.account_id
        WHERE a.tenant_id = $1 AND a.role = 'bank'`,
      [jur.tenantId],
    );
    expect(bankLine.n).toBeGreaterThan(0);
    // the credit (advance fees for later periods) never pays the debt brought forward
    expect(
      (
        await q<{ balance: string }>(
          `SELECT balance::text FROM ops.invoice i WHERE handover_id = $1 ORDER BY i.total`,
          [ids.handover],
        )
      ).map((r) => r.balance),
    ).toEqual(['200.00', '300.01', '1200.00']);
  });

  it('the buyer keeps their identity: the unit and the opening balance are there; formation switches the operator with no gap', async () => {
    await refreshBuyer();
    const units = await t.http.get('/v1/resident/me/units').set(bearer(buyer.access)).expect(200);
    const mine = JSON.stringify(units.body);
    expect(mine).toContain('A-101');
    expect(mine).toContain('co_owner');
    const before = await t.http.get('/v1/resident/invoices').set(bearer(buyer.access)).expect(200);
    const beforeIds = (before.body.data as { id: string }[]).map((x) => x.id).sort();
    expect(beforeIds).toHaveLength(1);

    t.clock.advance(60_000);
    // another tenant cannot record the formation of this handover
    await t.http
      .post(`/v1/owner/juristic/handovers/${ids.handover}/actions/juristic-formed`)
      .set({ ...J2(), ...idem() })
      .send({ formedOn: '2026-11-04' })
      .expect(404);
    await t.http
      .post(`/v1/owner/juristic/handovers/${ids.handover}/actions/juristic-formed`)
      .set({ ...J(), ...idem() })
      .send({ formedOn: '2026-11-04', registrationNo: 'นต.32/2569' })
      .expect(200);
    await t.http
      .post(`/v1/owner/juristic/handovers/${ids.handover}/actions/juristic-formed`)
      .set({ ...J(), ...idem() })
      .send({ formedOn: '2026-11-04' })
      .expect(409);
    const b = await one<{ operator_tenant_id: string }>(
      `SELECT operator_tenant_id FROM core.building WHERE id = $1`,
      [ids.building],
    );
    expect(b.operator_tenant_id).toBe(jur.tenantId);
    expect(
      await q(
        `SELECT reason::text, (valid_to IS NULL) AS open FROM core.building_operator_period WHERE building_id = $1 ORDER BY valid_from`,
        [ids.building],
      ),
    ).toEqual([
      { reason: 'handover', open: false },
      { reason: 'juristic_formed', open: true },
    ]);
    expect(
      await q(
        `SELECT modules, access::text, reason::text FROM core.asset_access_grant WHERE building_id = $1 AND grantee_tenant_id = $2 AND revoked_at IS NULL`,
        [ids.building, dev.tenantId],
      ),
    ).toEqual([{ modules: ['warranty'], access: 'write', reason: 'warranty' }]);
    await settle();
    const out = await one<{ status: string; payload: { payload: Record<string, unknown> } }>(
      `SELECT status::text, payload FROM bridge.integration_event WHERE direction = 'outbound' AND event_type = 'juristic.formed'`,
    );
    expect(out.status).toBe('pending');
    expect(out.payload.payload).toMatchObject({
      buildingRef: 'bldg-j32',
      juristicTenantId: jur.tenantId,
      formedOn: '2026-11-04',
      registrationNo: 'นต.32/2569',
      legalForm: 'condo_act',
      warrantyGrantValidTo: '2028-10-31',
    });

    await refreshBuyer();
    const after = await t.http.get('/v1/resident/invoices').set(bearer(buyer.access)).expect(200);
    expect((after.body.data as { id: string }[]).map((x) => x.id).sort()).toEqual(beforeIds);
    expect(
      JSON.stringify((await t.http.get('/v1/resident/me/units').set(bearer(buyer.access)).expect(200)).body),
    ).toContain('A-101');
    // the developer keeps the warranty grant only: no billing data of the building
    const devInvoices = await t.http.get('/v1/owner/invoices').set(bearer(dev.token)).expect(200);
    expect(devInvoices.body.data).toHaveLength(0);
  });

  it('a re-send after the acceptance is refused; another building can be rejected back to getbuild', async () => {
    const again = await send(handover({ key: 'getbuild:handover:j32:v2:3' }));
    expect(again.status).toBe('rejected');
    const other = await send(
      handover({
        key: 'getbuild:handover:j32-b:v2:1',
        buildingRef: 'bldg-j32-b',
        requestedHandoverAt: '2026-12-01T10:00:00+07:00',
      }),
    );
    const h = await handoverOf(other.id);
    await t.http
      .post(`/v1/admin/juristic-handovers/${h.id}/actions/assign`)
      .set(bearer(admin))
      .set(idem())
      .send({ juristicTenantId: jur.tenantId })
      .expect(200);
    await t.http
      .post(`/v1/owner/juristic/handovers/${h.id}/actions/accept`)
      .set({ ...J(), ...idem() })
      .send({ legalForm: 'condo_act' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('handover.not_due'));
    fake.failNext = true;
    const rejected = await t.http
      .post(`/v1/owner/juristic/handovers/${h.id}/actions/reject`)
      .set({ ...J(), ...idem() })
      .send({ reason: 'ยอดเงินกองทุนไม่ตรงกับสมุดบัญชี' })
      .expect(200);
    expect(rejected.body).toMatchObject({ state: 'rejected', rejectionDeliveredAt: null });
    expect(fake.rejections).toHaveLength(0);
    expect(await t.app.get(HandoversService).maintain()).toEqual({ delivered: 1 });
    expect(fake.rejections).toEqual([
      expect.objectContaining({
        handoverId: h.id,
        idempotencyKey: 'getbuild:handover:j32-b:v2:1',
        buildingRef: 'bldg-j32-b',
        reason: 'ยอดเงินกองทุนไม่ตรงกับสมุดบัญชี',
      }),
    ]);
    expect(await t.app.get(HandoversService).maintain()).toEqual({ delivered: 0 });
    // nothing of the rejected building was written; getbuild may send a corrected handover
    expect((await q(`SELECT 1 FROM core.building WHERE source_ref LIKE '%bldg-j32-b'`)).length).toBe(0);
    const corrected = await send(
      handover({ key: 'getbuild:handover:j32-b:v2:2', buildingRef: 'bldg-j32-b' }),
    );
    expect(corrected.status).toBe('applied');
  });
});

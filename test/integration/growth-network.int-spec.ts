import { CONTRACT_FIXTURES, signIntegrationWebhook } from '@collective/asset-core/contracts';
import { fakeLineIdToken } from '@collective/integrations/line';
import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import { bangkokDate } from '@common/time/bangkok';
import { type FakeGetbuildHandoff } from '@integrations/getbuild/fake-getbuild-handoff';
import { GETBUILD_HANDOFF } from '@integrations/getbuild/getbuild-handoff.port';
import { RentalHandoffsService } from '@modules/bridge-integrations/rental-handoffs.service';
import { RelocationService } from '@modules/ops-listings/relocation.service';
import sharp from 'sharp';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const IN_KEY = 'g'.repeat(48);
const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const RESIDENT_SUB = 'U000000000000000000000000000g8r01';
const STRANGER_SUB = 'U000000000000000000000000000g8r02';

interface Signed {
  tenantId: string;
  token: string;
}

/**
 * G8 acceptance (docs/prompts/G-growth-api.md G8; D-289 (2) (4) (5), D-299; real PostgreSQL): a getbuild transfer with
 * rental intent becomes one handoff (whatever getbuild re-sends), delivered through the fake port, claimed by a
 * landlord into a prefilled listing draft with the developer campaign; employer housing addresses invoices to the
 * employer, splits the statement per occupant, exports payroll deductions and filters TM30; relocation offers exist
 * only with consent `resident.relocation`, match listings in the destination and carry the rent record only by the
 * resident's action. Cross-tenant ids are 404 on every new owner endpoint.
 */
describe('G8 getbuild handoff, employer housing, relocation network (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let landlord: Signed;
  let stranger: Signed;
  let fake: FakeGetbuildHandoff;
  let handoffId: string;
  let handoffToken: string;
  let handoffListing: { id: string; slug: string };

  const as = (s: Signed) => ({ ...bearer(s.token), 'X-Tenant-Id': s.tenantId });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };

  async function signup(kind: 'agency' | 'landlord', phone: string, displayName: string): Promise<Signed> {
    t.clock.advance(61_000);
    const challenge = await t.http.post(`/v1/public/signup/${kind}/otp`).send({ phone }).expect(200);
    const res = await t.http.post(`/v1/public/signup/${kind}`).send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName,
    });
    if (res.status !== 201) throw new Error(`signup ${res.status}: ${JSON.stringify(res.body)}`);
    return { tenantId: res.body.tenant.id as string, token: res.body.tokens.accessToken as string };
  }

  /** Sends one `unit.transferred` through the signed webhook as getbuild would. */
  async function transfer(over: {
    key: string;
    unitRef: string;
    rentalIntent: boolean;
    transferDate?: string;
  }) {
    const fixture = CONTRACT_FIXTURES['unit.transferred'] as {
      eventId: string;
      tenantId: string;
      payload: Record<string, unknown> & { transferDate: string };
    } & Record<string, unknown>;
    const envelope = {
      ...fixture,
      eventId: fixture.eventId.replace(/..$/, String(Math.floor(Math.random() * 90) + 10)),
      idempotencyKey: over.key,
      payload: {
        ...fixture.payload,
        unitRef: over.unitRef,
        rentalIntent: over.rentalIntent,
        transferDate: over.transferDate ?? fixture.payload.transferDate,
      },
    };
    const body = JSON.stringify(envelope);
    const headers = signIntegrationWebhook({
      keys: [IN_KEY],
      body,
      eventId: envelope.idempotencyKey,
      source: 'getbuild',
      timestamp: Math.floor(t.clock.now().getTime() / 1000),
    });
    return t.http
      .post('/webhooks/integration/getbuild')
      .set('content-type', 'application/json')
      .set(headers)
      .send(body)
      .expect(200);
  }

  async function publish(s: Signed, listingId: string, unitId: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const body = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7aa6c2' } })
        .jpeg()
        .toBuffer();
      const documentId = await uploadFile(t, db, s.token, {
        kind: 'listing_photo',
        scopeType: 'unit',
        scopeId: unitId,
        fileName: 'room.jpg',
        mimeType: 'image/jpeg',
        body,
        tenantId: s.tenantId,
      });
      await t.http.post(`/v1/owner/listings/${listingId}/photos`).set(as(s)).send({ documentId }).expect(201);
    }
    await t.http.post(`/v1/owner/listings/${listingId}/actions/submit`).set(as(s)).expect(200);
    const state = await q<{ state: string }>('SELECT state::text FROM ops.listing WHERE id = $1', [
      listingId,
    ]);
    if (state[0]!.state === 'pending_review')
      await t.http
        .post(`/v1/admin/listings/${listingId}/actions/approve`)
        .set(bearer(admin))
        .set(idem())
        .expect(200);
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_growth_net' });
    t = await createIntApp(db, { INTEGRATION_GETBUILD_VERIFY_KEYS: IN_KEY, OTP_MAX_PER_HOUR: '20' });
    fake = t.app.get<FakeGetbuildHandoff>(GETBUILD_HANDOFF);
    admin = await adminToken(t);
    landlord = await signup('landlord', '+66810008801', 'Somchai Test');
    stranger = await signup('landlord', '+66810008802', 'Test Stranger');
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  // ------------------------------------------------------------------------------------------- getbuild handoff

  it('one handoff per transfer: re-sends add nothing, no rental intent adds nothing, no buyer contact stored', async () => {
    expect(fake.mode).toBe('fake');
    const first = await transfer({ key: 'getbuild:transfer:g8-u1', unitRef: 'g8-u1', rentalIntent: true });
    expect(first.body.status).toBe('applied');
    const replay = await transfer({ key: 'getbuild:transfer:g8-u1', unitRef: 'g8-u1', rentalIntent: true });
    expect(replay.body.status).toBe('duplicate');
    const resent = await transfer({
      key: 'getbuild:transfer:g8-u1:again',
      unitRef: 'g8-u1',
      rentalIntent: true,
    });
    expect(resent.body.status).toBe('applied');
    const none = await transfer({ key: 'getbuild:transfer:g8-u2', unitRef: 'g8-u2', rentalIntent: false });
    expect(none.body.status).toBe('applied');
    const rows = await q<{
      id: string;
      unit_ref: string;
      tenant_id: string | null;
      state: string;
      campaign_tag: string;
      line: boolean;
      row: Record<string, unknown>;
    }>(
      `SELECT id, unit_ref, tenant_id, state::text, campaign_tag, buyer_line_hash IS NOT NULL AS line, to_jsonb(h) AS row
         FROM ops.rental_handoff h`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      unit_ref: 'g8-u1',
      tenant_id: null,
      state: 'invited',
      campaign_tag: `getbuild:${(CONTRACT_FIXTURES['unit.transferred'] as { tenantId: string }).tenantId}`,
      line: true,
    });
    expect(JSON.stringify(rows[0]!.row)).not.toContain('Ufake0000000000000000000000000001');
    handoffId = rows[0]!.id;
    // platform-only until claimed: a tenant sees nothing
    const own = await t.http.get('/v1/owner/rental-handoffs').set(as(landlord)).expect(200);
    expect(own.body.data).toEqual([]);
    const events = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'rental_handoff.created'`,
    );
    expect(events[0]!.n).toBe(1);
  });

  it('the job delivers the link through the getbuild port; the buyer previews it (first name only)', async () => {
    fake.failNext = true;
    expect(await t.app.get(RentalHandoffsService).maintain()).toEqual({ delivered: 0, expired: 0 });
    const failed = await q<{ delivery_attempts: number; last_delivery_error: string; token: boolean }>(
      'SELECT delivery_attempts, last_delivery_error, token_hash IS NOT NULL AS token FROM ops.rental_handoff WHERE id = $1',
      [handoffId],
    );
    expect(failed[0]).toMatchObject({ delivery_attempts: 1, token: false });
    expect(await t.app.get(RentalHandoffsService).maintain()).toEqual({ delivered: 1, expired: 0 });
    const sent = fake.lastFor(handoffId)!;
    expect(sent).toMatchObject({
      unitRef: 'g8-u1',
      buyerRef: 'p-1',
      campaignTag: expect.stringMatching(/^getbuild:/),
    });
    handoffToken = sent.url.split('/handoff/')[1]!;
    expect(await t.app.get(RentalHandoffsService).maintain()).toEqual({ delivered: 0, expired: 0 });

    const preview = await t.http.get(`/v1/public/handoffs/${handoffToken}`).expect(200);
    expect(preview.body).toMatchObject({
      state: 'invited',
      buyerFirstName: 'ผู้ซื้อ',
      facts: {
        projectName: 'โครงการ bldg-a',
        unitNo: 'g8-u1',
        province: 'กรุงเทพมหานคร',
        district: 'จตุจักร',
      },
    });
    expect(JSON.stringify(preview.body)).not.toContain('ตัวอย่าง');
    await t.http.get('/v1/public/handoffs/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').expect(404);
    const listed = await t.http.get('/v1/admin/rental-handoffs?state=invited').set(bearer(admin)).expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({ id: handoffId, deliveryAttempts: 2, tenantId: null });
  });

  it('a landlord claims it: portfolio unit (getbuild_transfer) + prefilled draft with the campaign; others cannot', async () => {
    const agency = await signup('agency', '+66810008803', 'Test Agency');
    const refused = await t.http
      .post('/v1/owner/rental-handoffs/actions/claim')
      .set(as(agency))
      .set(idem())
      .send({ token: handoffToken, rent: '15000' })
      .expect(422);
    expect(refused.body.code).toBe('handoff.landlord_required');
    await t.http
      .post('/v1/owner/rental-handoffs/actions/claim')
      .set(as(landlord))
      .send({ token: handoffToken, rent: '15000' })
      .expect(400);
    await t.http
      .post('/v1/owner/rental-handoffs/actions/claim')
      .set(as(landlord))
      .set(idem())
      .send({ token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', rent: '15000' })
      .expect(404);

    const claimed = await t.http
      .post('/v1/owner/rental-handoffs/actions/claim')
      .set(as(landlord))
      .set(idem())
      .send({ token: handoffToken, rent: '15000' })
      .expect(200);
    expect(claimed.body).toMatchObject({ id: handoffId, state: 'accepted', facts: { unitNo: 'g8-u1' } });
    const listing = await t.http
      .get(`/v1/owner/listings/${claimed.body.listingId}`)
      .set(as(landlord))
      .expect(200);
    expect(listing.body).toMatchObject({ state: 'draft', rent: '15000.00', unitId: claimed.body.unitId });
    expect(listing.body.titleTh).toContain('โครงการ bldg-a');
    handoffListing = { id: listing.body.id as string, slug: listing.body.slug as string };
    const stored = await q<{ campaign_tag: string; source: string; source_ref: string }>(
      `SELECT l.campaign_tag, o.source::text, o.source_ref FROM ops.listing l
         JOIN core.unit_ownership o ON o.unit_id = l.unit_id WHERE l.id = $1`,
      [handoffListing.id],
    );
    expect(stored[0]).toMatchObject({
      campaign_tag: claimed.body.campaignTag,
      source: 'getbuild_transfer',
      source_ref: expect.stringContaining('g8-u1'),
    });
    // the same landlord again answers the claim; another landlord, a decline or a resend cannot take it
    const again = await t.http
      .post('/v1/owner/rental-handoffs/actions/claim')
      .set(as(landlord))
      .set(idem())
      .send({ token: handoffToken, rent: '16000' })
      .expect(200);
    expect(again.body.listingId).toBe(claimed.body.listingId);
    const other = await t.http
      .post('/v1/owner/rental-handoffs/actions/claim')
      .set(as(stranger))
      .set(idem())
      .send({ token: handoffToken, rent: '15000' })
      .expect(409);
    expect(other.body.code).toBe('handoff.invalid_state');
    await t.http.post(`/v1/public/handoffs/${handoffToken}/actions/decline`).expect(409);
    await t.http
      .post(`/v1/admin/rental-handoffs/${handoffId}/actions/resend`)
      .set(bearer(admin))
      .set(idem())
      .expect(409);
    expect((await t.http.get('/v1/owner/rental-handoffs').set(as(stranger)).expect(200)).body.data).toEqual(
      [],
    );
    const mine = await t.http.get('/v1/owner/rental-handoffs').set(as(landlord)).expect(200);
    expect(mine.body.data).toEqual([expect.objectContaining({ id: handoffId, state: 'accepted' })]);
    await t.http.get(`/v1/owner/listings/${handoffListing.id}`).set(as(stranger)).expect(404);
  });

  it('publishing the drafted listing marks the handoff listed', async () => {
    const unitId = (
      await q<{ unit_id: string }>('SELECT unit_id FROM ops.listing WHERE id = $1', [handoffListing.id])
    )[0]!.unit_id;
    await publish(landlord, handoffListing.id, unitId);
    await settle();
    const mine = await t.http.get('/v1/owner/rental-handoffs').set(as(landlord)).expect(200);
    expect(mine.body.data[0]).toMatchObject({ state: 'listed', listingId: handoffListing.id });
    expect((await t.http.get(`/v1/public/handoffs/${handoffToken}`).expect(200)).body.state).toBe('listed');
  });

  // ------------------------------------------------------------------------------------------- employer housing

  it('employer housing: invoices to the employer, statement per occupant, payroll export, TM30 filter, 404s', async () => {
    const owner = bearer(await ownerToken(t));
    const party = async (body: Record<string, unknown>) =>
      (await t.http.post('/v1/owner/parties').set(owner).send(body).expect(201)).body.id as string;
    const employer = await party({
      type: 'company',
      displayName: 'บริษัท ตัวอย่าง จำกัด',
      companyName: 'บริษัท ตัวอย่าง จำกัด',
    });
    const workerA = await party({
      type: 'person',
      displayName: 'ก ทดสอบ',
      nationality: 'MM',
      idDocumentType: 'passport',
      idNumber: 'MA1234567',
    });
    const workerB = await party({ type: 'person', displayName: 'ข ทดสอบ' });
    for (const p of [workerA, workerB])
      await db.admin.query(
        `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, lease_id, valid_from)
         SELECT tenant_id, building_id, unit_id, $2, 'co_tenant', id, start_date FROM ops.lease WHERE id = $1`,
        [DEV.leaseId, p],
      );
    const today = bangkokDate(t.clock.now());
    const created = await t.http
      .post('/v1/owner/employer-agreements')
      .set(owner)
      .send({ employerPartyId: employer, buildingId: DEV.buildingId, validFrom: today, reference: 'HR-1' })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({
      splitRule: 'per_occupant',
      deductPercent: '100.00',
      state: 'active',
      leaseIds: [],
    });
    await t.http
      .put(`/v1/owner/employer-agreements/${id}/workers`)
      .set(owner)
      .send({
        workers: [
          { partyId: workerA, employeeNo: 'E-001' },
          { partyId: workerB, employeeNo: '=CMD()' },
        ],
      })
      .expect(200);
    const attached = await t.http
      .put(`/v1/owner/leases/${DEV.leaseId}/employer`)
      .set(owner)
      .send({ employerAgreementId: id })
      .expect(200);
    expect(attached.body).toMatchObject({ employerAgreementId: id, payerPartyId: employer });

    // billing addresses the lease's next invoice to the employer
    const cycle = await t.http
      .post('/v1/owner/billing-cycles')
      .set(owner)
      .send({ propertyId: DEV.propertyId, periodKey: today.slice(0, 7) })
      .expect(200);
    await t.http.post(`/v1/owner/billing-cycles/${cycle.body.id}/actions/compute`).set(owner).expect(200);
    const drafts = await q<{ billed_party_id: string }>(
      'SELECT billed_party_id FROM ops.invoice WHERE lease_id = $1 AND billing_cycle_id = $2',
      [DEV.leaseId, cycle.body.id],
    );
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.billed_party_id === employer)).toBe(true);

    // an issued invoice of the month → the statement splits it between the three people staying
    await db.admin.query(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, number, snapshot, period_start,
         period_end, issued_at, due_date, status, subtotal, total, paid_total, balance)
       SELECT tenant_id, building_id, unit_id, $2, id, 'INV-G8-1', '{}', start_date, start_date + 30, now(), now()::date + 7,
              'issued', 5000, 5000, 0, 5000 FROM ops.lease WHERE id = $1`,
      [DEV.leaseId, employer],
    );
    const month = today.slice(0, 7);
    const statement = await t.http
      .get(`/v1/owner/employer-agreements/${id}/statement?month=${month}`)
      .set(owner)
      .expect(200);
    expect(statement.body).toMatchObject({
      total: '5000.00',
      balance: '5000.00',
      deductions: '5000.00',
      employerPays: '0.00',
    });
    const shares = statement.body.lines[0].shares as {
      name: string;
      share: string;
      employeeNo: string | null;
    }[];
    expect(shares.map((s) => [s.name, s.share, s.employeeNo])).toEqual([
      ['ก ทดสอบ', '1666.67', 'E-001'],
      ['ข ทดสอบ', '1666.67', '=CMD()'],
      ['ผู้เช่า ตัวอย่าง (ทดสอบ)', '1666.66', null],
    ]);
    await t.http.get(`/v1/owner/employer-agreements/${id}/statement?month=2026-13`).set(owner).expect(422);

    // deduction 50 % (If-Match), then the payroll CSV
    const current = await t.http.get(`/v1/owner/employer-agreements/${id}`).set(owner).expect(200);
    await t.http
      .patch(`/v1/owner/employer-agreements/${id}`)
      .set(owner)
      .send({ deductPercent: '50' })
      .expect(428);
    await t.http
      .patch(`/v1/owner/employer-agreements/${id}`)
      .set(owner)
      .set('If-Match', current.headers.etag as string)
      .send({ deductPercent: '50' })
      .expect(200);
    const half = await t.http
      .get(`/v1/owner/employer-agreements/${id}/statement?month=${month}`)
      .set(owner)
      .expect(200);
    // each share's deduction is rounded half-up on its own: 833.34 + 833.34 + 833.33
    expect(half.body).toMatchObject({ deductions: '2500.01', employerPays: '2499.99' });
    const job = await t.http
      .post(`/v1/owner/employer-agreements/${id}/payroll-exports`)
      .set(owner)
      .set(idem())
      .send({ month })
      .expect(202);
    expect(job.body).toMatchObject({ kind: 'payroll_deduction', status: 'queued' });
    await settle();
    const done = await t.http.get(`/v1/owner/exports/${job.body.id}`).set(owner).expect(200);
    expect(done.body).toMatchObject({ status: 'done', rowCount: 3 });
    const file = await q<{ storage_key: string }>(
      'SELECT d.storage_key FROM ops.export_job j JOIN core.document d ON d.id = j.file_document_id WHERE j.id = $1',
      [job.body.id],
    );
    const csv = t.app
      .get<FakeObjectStorage>(OBJECT_STORAGE)
      .objects.get(file[0]!.storage_key)!
      .body.subarray(3)
      .toString('utf8');
    expect(csv.split('\r\n')).toEqual([
      'employee_no,worker_name,unit_no,invoice_number,share_thb,deduction_thb',
      'E-001,ก ทดสอบ,A-101,INV-G8-1,1666.67,833.34',
      "'=CMD(),ข ทดสอบ,A-101,INV-G8-1,1666.67,833.34",
      ',ผู้เช่า ตัวอย่าง (ทดสอบ),A-101,INV-G8-1,1666.66,833.33',
      '',
    ]);

    // TM30 of the employer's foreign workers
    await db.admin.query(
      `INSERT INTO ops.tm30_export (tenant_id, building_id, unit_id, lease_id, party_id, moved_in_at, due_at)
       SELECT tenant_id, building_id, unit_id, id, $2, now(), now() + interval '1 day' FROM ops.lease WHERE id = $1`,
      [DEV.leaseId, workerA],
    );
    const tm30 = await t.http.get(`/v1/owner/tm30-exports?employerAgreementId=${id}`).set(owner).expect(200);
    expect((tm30.body.data as { partyId: string }[]).map((r) => r.partyId)).toEqual([workerA]);

    // another tenant: every new path is a 404, and its TM30 filter with this agreement lists nothing
    const other = await onboardTenant(t, admin, {
      slug: 'other-g8',
      phone: '+660000000881',
      type: 'apartment',
    });
    const O = bearer(other.token);
    await t.http.get(`/v1/owner/employer-agreements/${id}`).set(O).expect(404);
    await t.http
      .patch(`/v1/owner/employer-agreements/${id}`)
      .set(O)
      .set('If-Match', current.headers.etag as string)
      .send({ end: true })
      .expect(404);
    await t.http.put(`/v1/owner/employer-agreements/${id}/workers`).set(O).send({ workers: [] }).expect(404);
    await t.http.get(`/v1/owner/employer-agreements/${id}/statement?month=${month}`).set(O).expect(404);
    await t.http
      .post(`/v1/owner/employer-agreements/${id}/payroll-exports`)
      .set(O)
      .set(idem())
      .send({ month })
      .expect(404);
    await t.http
      .put(`/v1/owner/leases/${DEV.leaseId}/employer`)
      .set(O)
      .send({ employerAgreementId: null })
      .expect(404);
    await t.http
      .post('/v1/owner/employer-agreements')
      .set(O)
      .send({ employerPartyId: employer, validFrom: today })
      .expect(404);
    expect((await t.http.get('/v1/owner/employer-agreements').set(O).expect(200)).body.data).toEqual([]);
    expect(
      (await t.http.get(`/v1/owner/tm30-exports?employerAgreementId=${id}`).set(O).expect(200)).body.data,
    ).toEqual([]);

    // ending the agreement gives the lease back to its lessee
    const fresh = await t.http.get(`/v1/owner/employer-agreements/${id}`).set(owner).expect(200);
    const ended = await t.http
      .patch(`/v1/owner/employer-agreements/${id}`)
      .set(owner)
      .set('If-Match', fresh.headers.etag as string)
      .send({ end: true })
      .expect(200);
    expect(ended.body).toMatchObject({ state: 'ended', leaseIds: [] });
    const lease = await q<{ payer_party_id: string | null }>(
      'SELECT payer_party_id FROM ops.lease WHERE id = $1',
      [DEV.leaseId],
    );
    expect(lease[0]!.payer_party_id).toBeNull();
    await t.http
      .put(`/v1/owner/leases/${DEV.leaseId}/employer`)
      .set(owner)
      .send({ employerAgreementId: id })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('employer.invalid_state'));
  });

  // ------------------------------------------------------------------------------------------- relocation

  it('relocation: no consent → no offer; consent → offer, listings in the destination, enquiry with the rent record; withdrawal stops it', async () => {
    const home = await signup('landlord', '+66810008804', 'Test Home');
    const unit = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as(home))
      .send({
        kind: 'condo_unit',
        projectName: 'ไอดีโอ ทดสอบ',
        unitNo: '8/801',
        address: ADDRESS,
        areaSqm: '28.50',
        bedrooms: 1,
        bathrooms: 1,
      })
      .expect(201);
    const lessee = (
      await t.http
        .post('/v1/owner/parties')
        .set(as(home))
        .send({
          type: 'person',
          displayName: 'Somchai Test',
          phone: '+66810008805',
          nationality: 'GB',
          idDocumentType: 'passport',
          idNumber: 'X7654388',
        })
        .expect(201)
    ).body.id as string;
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(as(home))
      .send({
        unitId: unit.body.unitId,
        lesseePartyId: lessee,
        startDate: '2026-01-01',
        months: 24,
        rent: '12000',
      })
      .expect(201);
    const leaseId = draft.body.id as string;
    const sent = await t.http
      .post(`/v1/owner/leases/${leaseId}/actions/send-for-signature`)
      .set(as(home))
      .set(idem());
    if (sent.status !== 200)
      throw new Error(`send-for-signature ${sent.status}: ${JSON.stringify(sent.body)}`);
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [leaseId],
    );
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: RESIDENT_SUB, name: 'Somchai' }) })
      .expect(200);
    await db.admin.query(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via)
       SELECT $1, $2, user_id, 'invitation' FROM core.user_identity WHERE provider_subject = $3`,
      [home.tenantId, lessee, RESIDENT_SUB],
    );
    const resident = bearer(
      (await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200)).body
        .accessToken as string,
    );
    // one confirmed month of rent so the record can travel
    const inv = await q<{ id: string; building_id: string }>(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, lease_id, number, snapshot, period_start,
         period_end, issued_at, due_date, status, subtotal, total, paid_total, balance)
       SELECT tenant_id, building_id, unit_id, $2, id, 'INV-R-1', '{}', '2026-09-01', '2026-09-30', '2026-09-01', '2026-09-05',
              'paid', 12000, 12000, 12000, 0 FROM ops.lease WHERE id = $1 RETURNING id, building_id`,
      [leaseId, lessee],
    );
    const pay = await q<{ id: string }>(
      `INSERT INTO ops.payment (tenant_id, building_id, unit_id, payer_party_id, lease_id, invoice_id, amount, method, paid_at,
         status, confirmed_at, confirmed_via)
       SELECT tenant_id, building_id, unit_id, $2, id, $3, 12000, 'qr', '2026-09-03', 'confirmed', '2026-09-03', 'webhook'
         FROM ops.lease WHERE id = $1 RETURNING id`,
      [leaseId, lessee, inv[0]!.id],
    );
    await db.admin.query(
      `INSERT INTO ops.payment_allocation (tenant_id, payment_id, invoice_id, amount) VALUES ($1, $2, $3, 12000)`,
      [home.tenantId, pay[0]!.id, inv[0]!.id],
    );

    // notice without the consent: nobody is targeted
    const effective = bangkokDate(new Date(t.clock.now().getTime() + 45 * 86_400_000));
    await t.http
      .post(`/v1/owner/leases/${leaseId}/actions/record-notice`)
      .set(as(home))
      .send({ by: 'lessee', effectiveDate: effective })
      .expect(200);
    await settle();
    expect(await q('SELECT id FROM ops.relocation_offer WHERE lease_id = $1', [leaseId])).toEqual([]);
    const empty = await t.http.get('/v1/resident/relocation-offers').set(resident).expect(200);
    expect(empty.body).toEqual({ consented: false, data: [] });

    // the resident opts in → an offer for the lease under notice, with a LINE message gated by that consent
    const purposes = await t.http.get('/v1/resident/consents').set(resident).expect(200);
    const relocation = (purposes.body as { key: string; version: number; required: boolean }[]).find(
      (p) => p.key === 'resident.relocation',
    )!;
    expect(relocation).toMatchObject({ required: false, granted: null });
    await t.http
      .post('/v1/resident/consents')
      .set(resident)
      .send({ items: [{ purposeKey: 'resident.relocation', version: relocation.version, granted: true }] })
      .expect(201);
    await settle();
    const offers = await t.http.get('/v1/resident/relocation-offers').set(resident).expect(200);
    expect(offers.body.consented).toBe(true);
    expect(offers.body.data).toEqual([
      expect.objectContaining({
        leaseId,
        unitNo: '8/801',
        state: 'open',
        moveOutDate: effective,
        destination: null,
        listings: [],
      }),
    ]);
    const offerId = offers.body.data[0].id as string;
    const notified = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'relocation.offer_ready'`,
    );
    expect(notified[0]!.n).toBeGreaterThan(0);
    // the landlord never sees the offer (platform-only rows), nor its audit
    const audit = await q<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM platform.audit_log WHERE action LIKE 'relocation.%'`,
    );
    expect(audit.every((a) => a.tenant_id === null)).toBe(true);

    // the destination → public listings there (the handed-off listing in Chatuchak)
    const set = await t.http
      .put(`/v1/resident/relocation-offers/${offerId}/destination`)
      .set(resident)
      .send({ province: 'กรุงเทพมหานคร', district: 'จตุจักร', maxRent: '20000' })
      .expect(200);
    expect(set.body.destination).toEqual({
      areaSlug: null,
      province: 'กรุงเทพมหานคร',
      district: 'จตุจักร',
      maxRent: '20000.00',
    });
    expect((set.body.listings as { slug: string }[]).map((l) => l.slug)).toContain(handoffListing.slug);
    const cheap = await t.http
      .put(`/v1/resident/relocation-offers/${offerId}/destination`)
      .set(resident)
      .send({ province: 'กรุงเทพมหานคร', district: 'จตุจักร', maxRent: '9000' })
      .expect(200);
    expect(cheap.body.listings).toEqual([]);
    await t.http
      .put(`/v1/resident/relocation-offers/${offerId}/destination`)
      .set(resident)
      .send({ province: 'กรุงเทพมหานคร', district: 'จตุจักร' })
      .expect(200);

    // enquire from the offer and send the rent record — the only way it travels
    const before = await q<{ n: number }>('SELECT count(*)::int AS n FROM platform.rent_record_share');
    expect(before[0]!.n).toBe(0);
    const enquired = await t.http
      .post(`/v1/resident/relocation-offers/${offerId}/actions/enquire`)
      .set(resident)
      .set(idem())
      .send({
        listingSlug: handoffListing.slug,
        message: 'สนใจห้องนี้ครับ',
        shareRentRecord: true,
        consent: true,
      })
      .expect(200);
    expect(enquired.body).toMatchObject({
      listingId: handoffListing.id,
      created: true,
      rentRecordShared: true,
    });
    const lead = await t.http.get(`/v1/owner/leads/${enquired.body.leadId}`).set(as(landlord)).expect(200);
    expect(lead.body.rentRecord).toMatchObject({ onTime: 1 });
    const after = await t.http.get('/v1/resident/relocation-offers').set(resident).expect(200);
    expect(after.body.data[0].enquiredListingIds).toEqual([handoffListing.id]);

    // another person cannot see or act on the offer
    const strangerLogin = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: STRANGER_SUB, name: 'Test' }) })
      .expect(200);
    const S = bearer(strangerLogin.body.accessToken as string);
    expect((await t.http.get('/v1/resident/relocation-offers').set(S).expect(200)).body.data).toEqual([]);
    await t.http
      .put(`/v1/resident/relocation-offers/${offerId}/destination`)
      .set(S)
      .send({ province: 'เชียงใหม่' })
      .expect(404);
    await t.http.post(`/v1/resident/relocation-offers/${offerId}/actions/dismiss`).set(S).expect(404);
    await t.http
      .post(`/v1/resident/relocation-offers/${offerId}/actions/enquire`)
      .set(S)
      .set(idem())
      .send({ listingSlug: handoffListing.slug, message: 'x', shareRentRecord: false, consent: true })
      .expect(404);

    // withdrawal: the offer stops at once and its destination is erased
    await t.http
      .post('/v1/resident/consents')
      .set(resident)
      .send({ items: [{ purposeKey: 'resident.relocation', version: relocation.version, granted: false }] })
      .expect(201);
    const refused = await t.http
      .put(`/v1/resident/relocation-offers/${offerId}/destination`)
      .set(resident)
      .send({ province: 'เชียงใหม่' })
      .expect(409);
    expect(refused.body.code).toBe('relocation.consent_required');
    const gone = await t.http.get('/v1/resident/relocation-offers').set(resident).expect(200);
    expect(gone.body.consented).toBe(false);
    expect(gone.body.data[0]).toMatchObject({ state: 'withdrawn', destination: null, listings: [] });
    await settle();
    const row = await q<{ state: string; province: string | null }>(
      'SELECT state::text, province FROM ops.relocation_offer WHERE id = $1',
      [offerId],
    );
    expect(row[0]).toEqual({ state: 'withdrawn', province: null });
  });

  // G review #8: a platform DSR exports the person's relocation offers and erasure erases their destination
  it('platform DSR: relocation offers are exported, and erasure withdraws them with the destination erased', async () => {
    const [user] = await q<{ user_id: string }>(
      'SELECT user_id FROM core.user_identity WHERE provider_subject = $1',
      [STRANGER_SUB],
    );
    const [offer] = await q<{ id: string }>(
      `INSERT INTO ops.relocation_offer (tenant_id, lease_id, user_id, consent_id, area_slug, province, district, max_rent, state)
       SELECT tenant_id, lease_id, $1, consent_id, 'chatuchak', 'กรุงเทพมหานคร', 'จตุจักร', 9000, 'open'
         FROM ops.relocation_offer LIMIT 1 RETURNING id`,
      [user!.user_id],
    );
    const dsr = async (kind: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO platform.data_subject_request (tenant_id, subject_type, subject_id, requester_contact_enc, kind, due_at)
           VALUES (NULL, 'user', $1, '\\x00', $2::platform.dsr_kind, now() + interval '30 days') RETURNING id`,
          [user!.user_id, kind],
        )
      )[0]!.id;
    const act = (id: string, action: string) =>
      t.http
        .post(`/v1/admin/data-subject-requests/${id}/actions/${action}`)
        .set(bearer(admin))
        .send({ notes: 'ok' });
    const access = await dsr('access');
    await act(access, 'verify').expect(200);
    await act(access, 'start').expect(200);
    const fulfilled = await act(access, 'fulfil').expect(200);
    const [doc] = await q<{ storage_key: string }>(`SELECT storage_key FROM core.document WHERE id = $1`, [
      fulfilled.body.exportDocumentId,
    ]);
    const exported = JSON.parse(
      t.app.get<FakeObjectStorage>(OBJECT_STORAGE).objects.get(doc!.storage_key)!.body.toString('utf8'),
    ) as { relocationOffers?: unknown[] };
    expect(exported.relocationOffers).toEqual([
      expect.objectContaining({
        state: 'open',
        destination: {
          areaSlug: 'chatuchak',
          province: 'กรุงเทพมหานคร',
          district: 'จตุจักร',
          maxRent: '9000.00',
        },
      }),
    ]);
    const erase = await dsr('erasure');
    await act(erase, 'start').expect(200);
    await act(erase, 'fulfil').expect(200);
    expect(
      await q(
        `SELECT state::text, area_slug, province, district, max_rent, clicked_listing_ids FROM ops.relocation_offer WHERE id = $1`,
        [offer!.id],
      ),
    ).toEqual([
      {
        state: 'withdrawn',
        area_slug: null,
        province: null,
        district: null,
        max_rent: null,
        clicked_listing_ids: [],
      },
    ]);
  });

  // ------------------------------------------------------------------------------------------- expiry (clock moves)

  it('an unused invitation expires after getbuild.handoff.valid_days; the buyer may decline before', async () => {
    await transfer({ key: 'getbuild:transfer:g8-u3', unitRef: 'g8-u3', rentalIntent: true });
    await transfer({ key: 'getbuild:transfer:g8-u4', unitRef: 'g8-u4', rentalIntent: true });
    expect(await t.app.get(RentalHandoffsService).maintain()).toEqual({ delivered: 2, expired: 0 });
    const ids = await q<{ id: string; unit_ref: string }>(
      `SELECT id, unit_ref FROM ops.rental_handoff WHERE unit_ref IN ('g8-u3', 'g8-u4')`,
    );
    const token = (ref: string) =>
      fake.lastFor(ids.find((r) => r.unit_ref === ref)!.id)!.url.split('/handoff/')[1]!;
    const declined = await t.http.post(`/v1/public/handoffs/${token('g8-u4')}/actions/decline`).expect(200);
    expect(declined.body.state).toBe('declined');
    await t.http.post(`/v1/public/handoffs/${token('g8-u4')}/actions/decline`).expect(200);
    t.clock.advance(31 * 86_400_000);
    expect((await t.http.get(`/v1/public/handoffs/${token('g8-u3')}`).expect(200)).body.state).toBe(
      'expired',
    );
    expect(await t.app.get(RentalHandoffsService).maintain()).toEqual({ delivered: 0, expired: 1 });
    const states = await q<{ unit_ref: string; state: string }>(
      `SELECT unit_ref, state::text FROM ops.rental_handoff WHERE unit_ref IN ('g8-u3', 'g8-u4') ORDER BY unit_ref`,
    );
    expect(states).toEqual([
      { unit_ref: 'g8-u3', state: 'expired' },
      { unit_ref: 'g8-u4', state: 'declined' },
    ]);
    expect(await t.app.get(RelocationService).maintain()).toBe(0);
  });
});

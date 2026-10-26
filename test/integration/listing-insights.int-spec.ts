import { createIntApp, type IntApp } from '../support/int-app';
import { bearer } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const PHAYATHAI = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const BANGRAK = { line1: 'ถนนสีลม', district: 'บางรัก', province: 'กรุงเทพมหานคร', postcode: '10500' };
const DAY = 86_400_000;

/**
 * B7.9 part 1 acceptance — listings that tell the truth: the unit's utility cost (D-265), comparables for the owner
 * (D-269), area pages (D-272) and the verified owner's public page (D-274).
 */
describe('listing insights (B7.9, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: { tenantId: string; token: string; slug: string };
  let main: { id: string };
  let lone: { id: string; slug: string };
  let shown: { id: string; slug: string; unitId: string; buildingId: string };

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });

  async function unit(
    no: string,
    address: typeof PHAYATHAI,
  ): Promise<{ unitId: string; buildingId: string }> {
    const res = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as())
      .send({
        kind: 'condo_unit',
        projectName: 'ไอดีโอ โมบิ อารีย์',
        unitNo: no,
        address,
        areaSqm: '30.00',
        bedrooms: 1,
        bathrooms: 1,
      })
      .expect(201);
    const unitId = res.body.unitId as string;
    const { rows } = await db.admin.query<{ building_id: string }>(
      'SELECT building_id FROM core.unit WHERE id = $1',
      [unitId],
    );
    return { unitId, buildingId: rows[0]!.building_id };
  }

  /** A listing written straight to the table (published, or let after `daysToLet`). */
  async function listing(
    u: { unitId: string; buildingId: string },
    rent: number,
    place: typeof PHAYATHAI,
    opts: { daysToLet?: number; station?: boolean } = {},
  ): Promise<{ id: string; slug: string }> {
    const now = t.clock.now();
    const slug = `condo-${u.unitId.slice(-12)}`;
    const closed = opts.daysToLet !== undefined;
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO ops.listing (tenant_id, unit_id, building_id, state, slug, title_th, rent, unit_kind, size_sqm,
                                bedrooms, bathrooms, province, district, transit_name, transit_line, transit_distance_m,
                                published_at, closed_at, closed_reason)
       VALUES ($1, $2, $3, $4::ops.listing_state, $5, 'คอนโด 1 ห้องนอน', $6, 'condo_unit', 30, 1, 1, $7, $8,
               $9, $10, $11, $12, $13, $14::ops.listing_close_reason)
       RETURNING id`,
      [
        owner.tenantId,
        u.unitId,
        u.buildingId,
        closed ? 'closed' : 'published',
        slug,
        rent,
        place.province,
        place.district,
        opts.station ? 'อารีย์' : null,
        opts.station ? 'BTS สุขุมวิท' : null,
        opts.station ? 300 : null,
        new Date(now.getTime() - (opts.daysToLet ?? 5) * DAY),
        closed ? now : null,
        closed ? 'leased' : null,
      ],
    );
    return { id: rows[0]!.id, slug };
  }

  /** A confirmed (paid) invoice of the unit with one electricity and one water line. */
  async function paidBill(
    u: { unitId: string; buildingId: string },
    month: number,
    power: string,
    water: string,
  ) {
    const party = await db.admin.query<{ id: string }>(
      `INSERT INTO core.party (tenant_id, type, display_name) VALUES ($1, 'person', 'ผู้เช่าเดิม') RETURNING id`,
      [owner.tenantId],
    );
    const start = `2026-${String(month).padStart(2, '0')}-01`;
    const total = (Number(power) + Number(water)).toFixed(2);
    const inv = await db.admin.query<{ id: string }>(
      `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, period_start, period_end, subtotal, total)
       VALUES ($1, $2, $3, $4, $5::date, ($5::date + interval '1 month' - interval '1 day')::date, $6, $6) RETURNING id`,
      [owner.tenantId, u.buildingId, u.unitId, party.rows[0]!.id, start, total],
    );
    const id = inv.rows[0]!.id;
    for (const [no, kind, amount] of [
      [1, 'electricity', power],
      [2, 'water', water],
    ] as const)
      await db.admin.query(
        `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, amount)
         VALUES ($1, $2, $3, 'adjustment', $4::ops.invoice_line_kind, $4, $5)`,
        [owner.tenantId, id, no, kind, amount],
      );
    await db.admin.query(
      `UPDATE ops.invoice SET status = 'paid', number = $2, snapshot = '{}'::jsonb, issued_at = now(),
              due_date = period_end, paid_total = total WHERE id = $1`,
      [id, `INV-2026-${month}`],
    );
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_insights_b79' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.advance(61_000);
    const phone = '+66810009901';
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const signup = await t.http
      .post('/v1/public/signup/landlord')
      .send({
        provider: 'phone_otp',
        challengeId: challenge.body.challengeId,
        code: t.sms.lastCodeTo(phone),
        displayName: 'มาลี มีสุข',
      })
      .expect(201);
    owner = {
      tenantId: signup.body.tenant.id as string,
      token: signup.body.tokens.accessToken as string,
      slug: signup.body.tenant.slug as string,
    };

    // the owner's own draft listing — the subject of the comparables
    const mainUnit = await unit('12/100', PHAYATHAI);
    const created = await t.http
      .post('/v1/owner/listings')
      .set(as())
      .send({
        unitId: mainUnit.unitId,
        titleTh: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
        rent: '15000',
        transit: { name: 'อารีย์', line: 'BTS สุขุมวิท', distanceM: 300 },
      });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    main = { id: created.body.id as string };

    // six published comparables near the station and one let in 20 days → 7: one short of the minimum (8)
    const rents = [12000, 13000, 14000, 15000, 16000, 17000];
    for (const [i, rent] of rents.entries()) {
      const u = await unit(`12/${101 + i}`, PHAYATHAI);
      const l = await listing(u, rent, PHAYATHAI, { station: true });
      if (i === 0) shown = { ...l, ...u };
      // owners write the station their own way; it is still one station page
      if (i === 1)
        await db.admin.query(`UPDATE ops.listing SET transit_name = 'BTS อารีย์' WHERE id = $1`, [l.id]);
    }
    await listing(await unit('12/120', PHAYATHAI), 14500, PHAYATHAI, { daysToLet: 20, station: true });
    lone = await listing(await unit('99/1', BANGRAK), 25000, BANGRAK);
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('shows no rent band below the minimum, then the band and median days to let (D-269)', async () => {
    const few = await t.http.get(`/v1/owner/listings/${main.id}/comparables`).set(as()).expect(200);
    expect(few.body).toEqual({ band: null, medianDaysToLet: null, sampleSize: 7, minimum: 8 });

    await listing(await unit('12/121', PHAYATHAI), 18000, PHAYATHAI, { station: true });
    const res = await t.http.get(`/v1/owner/listings/${main.id}/comparables`).set(as()).expect(200);
    expect(res.body).toMatchObject({ sampleSize: 8, minimum: 8, medianDaysToLet: 20 });
    expect(res.body.band).toEqual({ p25: '13750.00', p50: '14750.00', p75: '16250.00' });

    // a listing alone in its district has no comparables; another tenant's listing id is a 404
    const alone = await t.http.get(`/v1/owner/listings/${lone.id}/comparables`).set(as()).expect(200);
    expect(alone.body).toMatchObject({ band: null, sampleSize: 0 });
    await t.http
      .get('/v1/owner/listings/0192f000-0000-7000-8000-000000000001/comparables')
      .set(as())
      .expect(404);
  });

  it('lists areas and stations with counts, bands and whether they may be indexed (D-272)', async () => {
    const res = await t.http.get('/v1/public/listings/areas').expect(200);
    const areas = res.body.data as { slug: string; count: number }[];
    const district = areas.find((a) => a.slug === 'phaya-thai');
    expect(district).toMatchObject({
      kind: 'district',
      name: 'พญาไท',
      count: 7,
      indexable: true,
      band: null,
    });
    const station = areas.find((a) => a.slug === 'ari');
    expect(station).toMatchObject({
      kind: 'station',
      name: 'อารีย์',
      nameEn: 'Ari',
      line: 'BTS สุขุมวิท',
      province: 'กรุงเทพมหานคร',
      count: 7,
      indexable: true,
    });
    const bangrak = areas.find((a) => a.slug === 'bang-rak');
    expect(bangrak).toMatchObject({ count: 1, indexable: false, band: null });
    // the let listing and the owner's draft are not counted
    expect(areas.every((a) => a.count <= 7)).toBe(true);

    const search = await t.http.get('/v1/public/listings').query({ area: 'phaya-thai' }).expect(200);
    expect(search.body.total).toBe(7);
    const byStation = await t.http.get('/v1/public/listings').query({ area: 'ari' }).expect(200);
    expect(byStation.body.total).toBe(7);
    const gone = await t.http.get('/v1/public/listings').query({ area: 'no-such-area' }).expect(200);
    expect(gone.body).toMatchObject({ total: 0, data: [] });
  });

  it("shows the unit's rates and, with the owner's switch on, the average of its last bills (D-265)", async () => {
    const empty = await t.http.get(`/v1/public/listings/${shown.slug}`).expect(200);
    expect(empty.body.utility).toBeNull();

    const plan = await t.http
      .post('/v1/owner/rate-plans')
      .set(as())
      .send({ kind: 'power', name: 'ค่าไฟ', isDefault: true })
      .expect(201);
    const today = new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const saved = await t.http
      .post(`/v1/owner/rate-plans/${plan.body.id}/versions`)
      .set(as())
      .send({
        effectiveFrom: today,
        basis: 'per_unit',
        tiers: { kind: 'flat', unit: 'kwh', pricePerUnit: '3.0000' },
      });
    if (saved.status !== 201) throw new Error(JSON.stringify(saved.body));

    const rates = await t.http.get(`/v1/public/listings/${shown.slug}`).expect(200);
    expect(rates.body.utility).toMatchObject({
      electricity: { kind: 'flat', pricePerUnit: '3.0000' },
      water: null,
      averageBill3m: null,
      basedOnBills: 0,
    });

    // two bills are fewer than `listing.utility_history.min_bills` (3): no average yet
    await paidBill(shown, 6, '900.00', '150.00');
    await paidBill(shown, 7, '1200.00', '150.00');
    const two = await t.http.get(`/v1/public/listings/${shown.slug}`).expect(200);
    expect(two.body.utility).toMatchObject({ averageBill3m: null, basedOnBills: 0 });
    await paidBill(shown, 8, '1050.00', '150.00');
    await paidBill(shown, 9, '1500.00', '150.00');
    const three = await t.http.get(`/v1/public/listings/${shown.slug}`).expect(200);
    // the last three: (1350 + 1200 + 1650) / 3
    expect(three.body.utility).toMatchObject({ averageBill3m: '1400.00', basedOnBills: 3 });

    // the owner hides the history: the rates stay, the average goes
    await db.admin.query('UPDATE ops.listing SET show_utility_history = false WHERE id = $1', [shown.id]);
    const off = await t.http.get(`/v1/public/listings/${shown.slug}`).expect(200);
    expect(off.body.utility).toMatchObject({ electricity: { pricePerUnit: '3.0000' }, averageBill3m: null });

    // the owner's own listing reads its switch and what the public sees
    const own = await t.http.get(`/v1/owner/listings/${main.id}`).set(as()).expect(200);
    expect(own.body).toMatchObject({ showUtilityHistory: true });
    expect(own.body.utility).toMatchObject({ electricity: { pricePerUnit: '3.0000' } });
    const patched = await t.http
      .patch(`/v1/owner/listings/${main.id}`)
      .set(as())
      .send({ showUtilityHistory: false })
      .expect(200);
    expect(patched.body.showUtilityHistory).toBe(false);
  });

  it("opens the owner's public page only once verified, and hides it when switched off (D-274)", async () => {
    await t.http.get(`/v1/public/owners/${owner.slug}`).expect(404);
    const before = await t.http.get(`/v1/public/listings/${shown.slug}`).expect(200);
    expect(before.body.ownerProfileSlug).toBeNull();
    await db.admin.query(
      `INSERT INTO platform.listing_verification (tenant_id, unit_id, state, evidence_kind, evidence_document_ids, decided_at)
       VALUES ($1, $2, 'approved', 'condo_title', ARRAY[gen_random_uuid()], now())`,
      [owner.tenantId, shown.unitId],
    );
    const page = await t.http.get(`/v1/public/owners/${owner.slug}`).expect(200);
    expect(page.body).toMatchObject({
      slug: owner.slug,
      displayName: 'มาลี มีสุข',
      verification: { level: 'unit_ownership', verifiedUnits: 1 },
      medianReplyMinutes: null,
      listingCount: 8,
    });
    expect(page.body.listings).toHaveLength(8);
    const linked = await t.http.get(`/v1/public/listings/${shown.slug}`).expect(200);
    expect(linked.body.ownerProfileSlug).toBe(owner.slug);
    expect(JSON.stringify(page.body)).not.toContain('+6681');

    await t.http
      .put('/v1/owner/settings/listing.public_profile.enabled')
      .set(as())
      .send({ value: false, reason: 'ไม่ต้องการหน้าสาธารณะ' })
      .expect(200);
    await t.http.get(`/v1/public/owners/${owner.slug}`).expect(404);
    const hidden = await t.http.get(`/v1/public/listings/${shown.slug}`).expect(200);
    expect(hidden.body.ownerProfileSlug).toBeNull();
    await t.http.get('/v1/public/owners/no-such-owner').expect(404);
  });
});

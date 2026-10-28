import { createHash } from 'node:crypto';

import { type FakeObjectStorage, OBJECT_STORAGE } from '@collective/integrations/storage';
import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { SettingsService } from '@core/settings/settings.service';
import { BoostsService } from '@modules/platform-subscriptions/boosts.service';
import { FeeInvoicingService } from '@modules/platform-subscriptions/fee-invoicing.service';
import { monthPeriod } from '@modules/platform-subscriptions/messaging-addons.service';
import sharp from 'sharp';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, supportToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };

interface Signed {
  tenantId: string;
  token: string;
  phone: string;
  kind: 'agency' | 'landlord';
}

interface Listed {
  id: string;
  slug: string;
  unitId: string;
  buildingId: string;
}

/**
 * G5 acceptance (docs/prompts/G-growth-api.md G5; D-287, D-291, D-293, D-297, D-298; real PostgreSQL): boosts are
 * not sold until priced, bought as a purchase platform invoice line, active only once paid, shown labelled on top of
 * public search (at most `boost.search.max_per_page`, ranked by verified vacancy then freshness), queued and expired;
 * a building boost is free by setting; success / co-broke fee accruals of past months go once on one platform invoice
 * per agency with the monthly cap; a dispute is a maker-checker credit note; verified photo orders are fulfilled with
 * deliverables stored as the tenant's documents. Cross-tenant ids are 404 on every new owner endpoint.
 */
describe('G5 boost & growth billing (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let landlord: Signed;
  let stranger: Signed;
  let agency: Signed;
  let mine: Listed;
  let theirs: Listed;

  const as = (s: Signed) => ({ ...bearer(s.token), 'X-Tenant-Id': s.tenantId });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const today = () => bangkokDate(t.clock.now());

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
    return {
      tenantId: res.body.tenant.id as string,
      token: res.body.tokens.accessToken as string,
      phone,
      kind,
    };
  }

  /** Signs every party in again (access tokens expire when the clock jumps days ahead). */
  async function relogin(): Promise<void> {
    admin = await adminToken(t);
    for (const s of [landlord, stranger, agency]) {
      t.clock.advance(61_000);
      const challenge = await t.http
        .post('/v1/auth/operator/otp/request')
        .send({ phone: s.phone })
        .expect(200);
      const res = await t.http
        .post('/v1/auth/operator/otp/verify')
        .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo(s.phone) })
        .expect(200);
      s.token = res.body.accessToken as string;
    }
  }

  async function publishListing(s: Signed, unitNo: string, title: string, rent: string): Promise<Listed> {
    const unit = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as(s))
      .send({
        kind: 'condo_unit',
        projectName: `ไอดีโอ ${unitNo}`,
        unitNo,
        address: ADDRESS,
        areaSqm: '28.50',
        bedrooms: 1,
        bathrooms: 1,
      })
      .expect(201);
    const unitId = unit.body.unitId as string;
    const created = await t.http
      .post('/v1/owner/listings')
      .set(as(s))
      .send({ unitId, titleTh: title, rent, depositMonths: 2 })
      .expect(201);
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
      await t.http
        .post(`/v1/owner/listings/${created.body.id}/photos`)
        .set(as(s))
        .send({ documentId })
        .expect(201);
    }
    await t.http.post(`/v1/owner/listings/${created.body.id}/actions/submit`).set(as(s)).expect(200);
    await t.http
      .post(`/v1/admin/listings/${created.body.id}/actions/approve`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    const row = (
      await q<{ building_id: string }>('SELECT building_id FROM ops.listing WHERE id = $1', [created.body.id])
    )[0]!;
    return {
      id: created.body.id as string,
      slug: created.body.slug as string,
      unitId,
      buildingId: row.building_id,
    };
  }

  /** The admin publishes a priced version of a price plan from today (O-027 answered, in the test). */
  async function price(key: string, body: Record<string, unknown>): Promise<string> {
    const plan = (await q<{ id: string }>('SELECT id FROM platform.price_plan WHERE key = $1', [key]))[0]!;
    const version = await t.http
      .post(`/v1/admin/price-plans/${plan.id}/versions`)
      .set(bearer(admin))
      .set(idem())
      .send({ effectiveFrom: today(), vatRate: '0.07', ...body })
      .expect(201);
    await t.http
      .post(`/v1/admin/price-plans/versions/${version.body.id}/actions/publish`)
      .set(bearer(admin))
      .expect(200);
    return version.body.id as string;
  }

  async function pay(invoiceId: string, amount: string): Promise<void> {
    await t.http
      .post(`/v1/admin/platform-invoices/${invoiceId}/payments`)
      .set(bearer(admin))
      .set(idem())
      .send({
        amount,
        method: 'bank_transfer',
        paidAt: t.clock.now().toISOString(),
        reference: `KTB-G5-${invoiceId}`,
      })
      .expect(201);
    await settle();
  }

  const productId = async (s: Signed, key: string) =>
    (
      (await t.http.get('/v1/owner/boost-products').set(as(s)).expect(200)).body.products as {
        id: string;
        key: string;
      }[]
    ).find((p) => p.key === key)!.id;

  const search = async (query = '', lang = 'th') =>
    (await t.http.get(`/v1/public/listings${query}`).set('Accept-Language', lang).expect(200)).body as {
      data: { slug: string; sponsored: boolean; sponsoredLabel: string | null }[];
      nextCursor: string | null;
    };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_g5' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    // the support user also holds the Finance role: the checker of the dispute credit note (D-091)
    await q(
      `INSERT INTO platform.platform_role_assignment (user_id, role_id)
       SELECT $1, r.id FROM platform.role r WHERE r.key = 'finance'`,
      [DEV.users.support],
    );
    admin = await adminToken(t);
    landlord = await signup('landlord', '+660000000951', 'มาลี มีสุข');
    stranger = await signup('landlord', '+660000000952', 'สมชาย ทดสอบ');
    agency = await signup('agency', '+660000000953', 'บ้านดี พร็อพเพอร์ตี้');
    theirs = await publishListing(stranger, '9/101', 'คอนโดเก่า ใกล้ BTS สนามเป้า', '12000');
    t.clock.advance(60_000);
    mine = await publishListing(landlord, '12/345', 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์', '15000');
    await settle();
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('boosts: not on sale until priced → bought → paid → labelled on top → queued → expired', async () => {
    const products = await t.http.get('/v1/owner/boost-products').set(as(landlord)).expect(200);
    expect(products.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'boost_listing_7d',
          target: 'listing',
          days: 7,
          onSale: false,
          price: null,
        }),
        expect.objectContaining({ key: 'boost_listing_30d', days: 30, onSale: false }),
        expect.objectContaining({ key: 'boost_building_month', target: 'building', months: 1, free: false }),
      ]),
    );
    const sevenDays = await productId(landlord, 'boost_listing_7d');
    const refused = await t.http
      .post(`/v1/owner/listings/${mine.id}/boosts`)
      .set(as(landlord))
      .set(idem())
      .send({ productId: sevenDays })
      .expect(409);
    expect(refused.body.code).toBe('boost.not_on_sale');

    await price('boost_listing_7d', { billingUnit: 'per_listing', unitPrice: '499' });
    expect(
      (
        (await t.http.get('/v1/owner/boost-products').set(as(landlord)).expect(200)).body
          .products as unknown[]
      ).find((p) => (p as { key: string }).key === 'boost_listing_7d'),
    ).toMatchObject({ onSale: true, price: '499.00', total: '533.93', vatRate: '0.0700' });

    // bought (idempotent replay), one pending purchase per listing and product
    const key = idem();
    const bought = await t.http
      .post(`/v1/owner/listings/${mine.id}/boosts`)
      .set(as(landlord))
      .set(key)
      .send({ productId: sevenDays })
      .expect(201);
    expect(bought.body).toMatchObject({
      target: 'listing',
      listingId: mine.id,
      listingSlug: mine.slug,
      state: 'pending_payment',
      price: '533.93',
      free: false,
      startsAt: null,
      invoice: { total: '533.93', state: 'issued' },
    });
    const replay = await t.http
      .post(`/v1/owner/listings/${mine.id}/boosts`)
      .set(as(landlord))
      .set(key)
      .send({ productId: sevenDays })
      .expect(201);
    expect(replay.body.id).toBe(bought.body.id);
    const twice = await t.http
      .post(`/v1/owner/listings/${mine.id}/boosts`)
      .set(as(landlord))
      .set(idem())
      .send({ productId: sevenDays })
      .expect(409);
    expect(twice.body.code).toBe('boost.pending');
    const lines = await q<{ kind: string; amount: string }>(
      'SELECT kind::text, amount::text FROM platform.platform_invoice_line WHERE invoice_id = $1',
      [bought.body.invoice.id],
    );
    expect(lines).toEqual([{ kind: 'boost', amount: '499.00' }]);

    // cross-tenant: another tenant's listing / boost is a 404
    await t.http
      .post(`/v1/owner/listings/${mine.id}/boosts`)
      .set(as(stranger))
      .set(idem())
      .send({ productId: sevenDays })
      .expect(404);
    await t.http.get(`/v1/owner/boosts/${bought.body.id}`).set(as(stranger)).expect(404);
    expect((await t.http.get('/v1/owner/boosts').set(as(stranger)).expect(200)).body.data).toEqual([]);

    // unpaid: never shown as sponsored, nothing suspended
    let page = await search();
    expect(page.data.filter((d) => d.sponsored)).toEqual([]);

    await pay(bought.body.invoice.id as string, '533.93');
    const active = await t.http.get(`/v1/owner/boosts/${bought.body.id}`).set(as(landlord)).expect(200);
    expect(active.body).toMatchObject({ state: 'active', invoice: { state: 'paid' } });
    const firstEnd = new Date(active.body.endsAt as string);
    expect(firstEnd.getTime() - new Date(active.body.startsAt as string).getTime()).toBe(7 * 86_400_000);

    page = await search();
    expect(page.data[0]).toMatchObject({ slug: mine.slug, sponsored: true, sponsoredLabel: 'โฆษณา' });
    expect(page.data.filter((d) => d.slug === mine.slug)).toHaveLength(1);
    expect((await search('', 'en')).data[0]).toMatchObject({ slug: mine.slug, sponsoredLabel: 'Ad' });
    // the detail page is never a sponsored slot
    expect((await t.http.get(`/v1/public/listings/${mine.slug}`).expect(200)).body.sponsored).toBe(false);

    // a second boost of the same listing is queued after the first
    const second = await t.http
      .post(`/v1/owner/listings/${mine.id}/boosts`)
      .set(as(landlord))
      .set(idem())
      .send({ productId: sevenDays })
      .expect(201);
    await pay(second.body.invoice.id as string, '533.93');
    const queued = await t.http.get(`/v1/owner/boosts/${second.body.id}`).set(as(landlord)).expect(200);
    expect(queued.body.state).toBe('active');
    expect(new Date(queued.body.startsAt as string).getTime()).toBe(firstEnd.getTime());

    // N per page, ranked by verified vacancy then freshness; each boosted listing once across pages
    t.clock.advance(300_000); // five minutes later: the stranger's boost ends after the landlord's first one
    const strangersProduct = await productId(stranger, 'boost_listing_7d');
    const otherBoost = await t.http
      .post(`/v1/owner/listings/${theirs.id}/boosts`)
      .set(as(stranger))
      .set(idem())
      .send({ productId: strangersProduct })
      .expect(201);
    await pay(otherBoost.body.invoice.id as string, '533.93');
    t.clock.advance(1_000);
    await t.http
      .put('/v1/admin/settings/boost.search.max_per_page')
      .set(bearer(admin))
      .send({ value: 1, reason: 'ทดสอบ G5' })
      .expect(200);
    t.app.get(SettingsService).invalidate('boost.search.max_per_page');
    const p1 = await search('?limit=1');
    expect(p1.data.filter((d) => d.sponsored).map((d) => d.slug)).toEqual([mine.slug]); // fresher
    const p2 = await search(`?limit=1&cursor=${p1.nextCursor}`);
    expect(p2.data.filter((d) => d.sponsored).map((d) => d.slug)).toEqual([theirs.slug]);
    // the older listing is verified vacant (a lease on getproperty ended, nothing in force): it ranks first
    await q(
      `INSERT INTO ops.lease
       SELECT (jsonb_populate_record(l, jsonb_build_object(
                 'id', uuidv7(), 'tenant_id', $1::uuid, 'building_id', $2::uuid, 'unit_id', $3::uuid,
                 'number', 'G5-' || substr(md5(random()::text), 1, 8), 'status', 'ended',
                 'start_date', '2025-01-01'::date, 'end_date', '2025-12-31'::date, 'move_out_at', null,
                 'ended_at', now()))).*
         FROM ops.lease l WHERE l.id = $4`,
      [stranger.tenantId, theirs.buildingId, theirs.unitId, DEV.leaseId],
    );
    expect((await search('?limit=1')).data[0]).toMatchObject({ slug: theirs.slug, sponsored: true });
    t.clock.advance(1_000);
    await t.http
      .put('/v1/admin/settings/boost.search.max_per_page')
      .set(bearer(admin))
      .send({ value: 0, reason: 'ทดสอบ G5: ปิดช่องโฆษณา' })
      .expect(200);
    t.app.get(SettingsService).invalidate('boost.search.max_per_page');
    expect((await search()).data.filter((d) => d.sponsored)).toEqual([]);
    t.clock.advance(1_000);
    await t.http
      .put('/v1/admin/settings/boost.search.max_per_page')
      .set(bearer(admin))
      .send({ value: 3, reason: 'ทดสอบ G5: คืนค่า' })
      .expect(200);
    t.app.get(SettingsService).invalidate('boost.search.max_per_page');

    // expiry: the first ends, the queued one takes over; after both, the listing leaves the sponsored slots
    const boosts = t.app.get(BoostsService, { strict: false });
    t.clock.set(new Date(firstEnd.getTime() + 60_000));
    expect(await boosts.maintain()).toBe(1); // the first boost
    expect((await search()).data.filter((d) => d.sponsored).map((d) => d.slug)).toEqual([
      theirs.slug,
      mine.slug,
    ]);
    t.clock.set(new Date(firstEnd.getTime() + 7 * 86_400_000 + 60_000));
    expect(await boosts.maintain()).toBe(2); // the queued one and the stranger's
    expect((await search()).data.filter((d) => d.sponsored)).toEqual([]);
    const states = await q<{ state: string }>(
      'SELECT state::text FROM ops.listing_boost WHERE listing_id = $1 ORDER BY created_at',
      [mine.id],
    );
    expect(states.map((s) => s.state)).toEqual(['expired', 'expired']);
    await relogin();
  });

  it('a building boost is free by setting: active at once, no invoice, one at a time', async () => {
    const building = await productId(landlord, 'boost_building_month');
    const refused = await t.http
      .post(`/v1/owner/buildings/${mine.buildingId}/boosts`)
      .set(as(landlord))
      .set(idem())
      .send({ productId: building })
      .expect(409);
    expect(refused.body.code).toBe('boost.not_on_sale');
    await q(
      `INSERT INTO platform.tenant_setting_version (tenant_id, setting_id, value, effective_from, reason)
       SELECT $1, id, 'true', now(), 'Apartment Smart customer (test)' FROM platform.setting WHERE key = 'boost.building.free'`,
      [landlord.tenantId],
    );
    t.app.get(SettingsService).invalidate('boost.building.free');
    t.clock.advance(5_000);
    const products = await t.http.get('/v1/owner/boost-products').set(as(landlord)).expect(200);
    expect(products.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'boost_building_month', free: true, onSale: true, total: '0.00' }),
      ]),
    );
    const free = await t.http
      .post(`/v1/owner/buildings/${mine.buildingId}/boosts`)
      .set(as(landlord))
      .set(idem())
      .send({ productId: building })
      .expect(201);
    expect(free.body).toMatchObject({
      target: 'building',
      buildingId: mine.buildingId,
      free: true,
      price: '0.00',
      state: 'active',
      invoice: null,
      months: 1,
    });
    expect((await search()).data[0]).toMatchObject({ slug: mine.slug, sponsored: true });
    const again = await t.http
      .post(`/v1/owner/buildings/${mine.buildingId}/boosts`)
      .set(as(landlord))
      .set(idem())
      .send({ productId: building })
      .expect(409);
    expect(again.body.code).toBe('boost.already_active');
    // another tenant: not free for them, and the landlord's building is a 404
    await t.http
      .post(`/v1/owner/buildings/${mine.buildingId}/boosts`)
      .set(as(stranger))
      .set(idem())
      .send({ productId: building })
      .expect(404);
    expect(
      (
        (await t.http.get('/v1/owner/boost-products').set(as(stranger)).expect(200)).body
          .products as unknown[]
      ).find((p) => (p as { key: string }).key === 'boost_building_month'),
    ).toMatchObject({ free: false, onSale: false });
  });

  it('success / co-broke fees of past months: one invoice per agency with the cap, once; dispute → credit note', async () => {
    const successVersion = await price('success_fee', {
      billingUnit: 'percent_of_amount',
      unitPrice: '10',
      terms: {
        status: 'proposed',
        decision: 'D-287',
        basis: 'commission',
        capAmount: null,
        monthlyCapAmount: '2000',
      },
    });
    const coBrokeVersion = (
      await q<{ id: string }>(
        `SELECT v.id FROM platform.price_plan_version v JOIN platform.price_plan p ON p.id = v.plan_id
          WHERE p.key = 'co_broke_fee' ORDER BY v.version LIMIT 1`,
      )
    )[0]!.id;
    const deal = async (year: number) => {
      const lease = (
        await q<{ id: string }>(
          `INSERT INTO ops.lease
           SELECT (jsonb_populate_record(l, jsonb_build_object(
                     'id', uuidv7(), 'number', 'G5D-' || substr(md5(random()::text), 1, 8), 'status', 'ended',
                     'start_date', ($1 || '-01-01')::date, 'end_date', ($1 || '-06-30')::date, 'move_out_at', null,
                     'ended_at', now()))).*
             FROM ops.lease l WHERE l.id = $2
           RETURNING id`,
          [String(year), DEV.leaseId],
        )
      )[0]!.id;
      return (
        await q<{ id: string }>(
          `INSERT INTO ops.deal (tenant_id, lease_id, unit_id, building_id, listing_agency_tenant_id, co_agency_tenant_id,
                                 monthly_rent, commission_amount, closed_at)
           SELECT l.tenant_id, l.id, l.unit_id, l.building_id, $2, $2, 15000, 15000, now() FROM ops.lease l WHERE l.id = $1
           RETURNING id`,
          [lease, agency.tenantId],
        )
      )[0]!.id;
    };
    const accrue = async (dealId: string, kind: string, version: string, amount: string, on: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO ops.fee_accrual (tenant_id, deal_id, kind, price_plan_version_id, billing_unit, rate, base_amount,
                                        amount, accrued_on)
           VALUES ($1, $2, $3::ops.fee_accrual_kind, $4, 'percent_of_amount', 10, 15000, $5, $6::date) RETURNING id`,
          [agency.tenantId, dealId, kind, version, amount, on],
        )
      )[0]!.id;
    const thisMonth = today().slice(0, 7);
    const lastMonth = addCalendarDays(monthPeriod(thisMonth).start, -1).slice(0, 7);
    const [d1, d2, d3] = [await deal(2021), await deal(2022), await deal(2023)];
    const a1 = await accrue(d1, 'success_fee', successVersion, '1500.00', `${lastMonth}-05`);
    const a2 = await accrue(d2, 'success_fee', successVersion, '1000.00', `${lastMonth}-20`);
    const a3 = await accrue(d2, 'co_broke_fee', coBrokeVersion, '300.00', `${lastMonth}-20`);
    const current = await accrue(d3, 'success_fee', successVersion, '700.00', today());

    const fees = t.app.get(FeeInvoicingService, { strict: false });
    expect(await fees.invoiceDue()).toBe(1);
    expect(await fees.invoiceDue()).toBe(0); // invoiced once
    const invoices = await q<{
      id: string;
      total: string;
      discount: string;
      vat_amount: string;
      kind: string;
    }>(
      `SELECT id, total::text, discount::text, vat_amount::text, kind::text FROM platform.platform_invoice
        WHERE tenant_id = $1 AND snapshot->>'product' = 'growth_fees'`,
      [agency.tenantId],
    );
    expect(invoices).toEqual([
      {
        id: expect.any(String),
        total: '2461.00',
        discount: '500.00',
        vat_amount: '161.00',
        kind: 'purchase',
      },
    ]);
    const invoiceLines = await q<{ kind: string; amount: string }>(
      'SELECT kind::text, amount::text FROM platform.platform_invoice_line WHERE invoice_id = $1 ORDER BY line_no',
      [invoices[0]!.id],
    );
    expect(invoiceLines).toEqual([
      { kind: 'success_fee', amount: '1500.00' },
      { kind: 'success_fee', amount: '1000.00' },
      { kind: 'co_broke_fee', amount: '300.00' },
      { kind: 'discount', amount: '-500.00' },
    ]);
    const linked = await q<{ id: string; line: string | null }>(
      'SELECT id, platform_invoice_line_id AS line FROM ops.fee_accrual WHERE tenant_id = $1',
      [agency.tenantId],
    );
    expect(
      linked
        .filter((r) => r.line)
        .map((r) => r.id)
        .sort(),
    ).toEqual([a1, a2, a3].sort());
    expect(linked.find((r) => r.id === current)!.line).toBeNull();
    // the database refuses a second invoice line for an accrual
    await expect(
      q(
        `UPDATE ops.fee_accrual SET platform_invoice_line_id = (SELECT platform_invoice_line_id FROM ops.fee_accrual WHERE id = $2)
          WHERE id = $1`,
        [a1, a2],
      ),
    ).rejects.toThrow(/invoiced once|append-only|duplicate key/);
    // the agency sees them as invoiced on its deals; nothing is suspended
    const deals = await t.http.get('/v1/owner/deals').set(as(agency)).expect(200);
    expect(JSON.stringify(deals.body)).toContain('"invoiced":true');

    // admin list + dispute (maker-checker credit note)
    const listed = await t.http
      .get(`/v1/admin/fee-accruals?tenantId=${agency.tenantId}&state=uninvoiced`)
      .set(bearer(admin))
      .expect(200);
    expect((listed.body.data as { id: string }[]).map((r) => r.id)).toEqual([current]);
    const early = await t.http
      .post(`/v1/admin/fee-accruals/${current}/actions/dispute`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'ยังไม่ได้ออกใบแจ้งหนี้' })
      .expect(409);
    expect(early.body.code).toBe('fee.not_invoiced');
    const disputed = await t.http
      .post(`/v1/admin/fee-accruals/${a1}/actions/dispute`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'สัญญาเช่ายกเลิกก่อนเข้าอยู่' })
      .expect(200);
    // charged 1,200.00 after the cap (pro rata) + VAT 7 %
    expect(disputed.body).toMatchObject({
      state: 'disputed',
      invoice: { id: invoices[0]!.id },
      creditNote: { state: 'requested', amount: '1284.00', number: null },
    });
    const twice = await t.http
      .post(`/v1/admin/fee-accruals/${a1}/actions/dispute`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'อีกครั้ง' })
      .expect(409);
    expect(twice.body.code).toBe('fee.already_disputed');
    const finance = await supportToken(t);
    await t.http
      .post(`/v1/admin/platform-invoices/credit-notes/${disputed.body.creditNote.id}/actions/approve`)
      .set(bearer(finance))
      .set(idem())
      .expect(200);
    const credited = await t.http
      .get(`/v1/admin/fee-accruals?tenantId=${agency.tenantId}&state=credited`)
      .set(bearer(admin))
      .expect(200);
    expect(credited.body.data).toEqual([
      expect.objectContaining({
        id: a1,
        state: 'credited',
        creditNote: expect.objectContaining({ state: 'issued' }),
      }),
    ]);
    const inv = await q<{ credited_total: string }>(
      'SELECT credited_total::text FROM platform.platform_invoice WHERE id = $1',
      [invoices[0]!.id],
    );
    expect(inv[0]!.credited_total).toBe('1284.00');
  });

  it('verified photo orders: not on sale → priced → paid → scheduled → deliverables stored → delivered', async () => {
    const products = await t.http.get('/v1/owner/media-service-products').set(as(landlord)).expect(200);
    expect(products.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'media_verified_photo', service: 'verified_photo', onSale: false }),
        expect.objectContaining({ key: 'media_tour_360', service: 'tour_360', onSale: false }),
      ]),
    );
    const order = () =>
      t.http
        .post('/v1/owner/media-service-orders')
        .set(as(landlord))
        .set(idem())
        .send({ listingId: mine.id, service: 'verified_photo', note: 'สะดวกช่วงบ่าย' });
    expect((await order().expect(409)).body.code).toBe('media_service.not_on_sale');
    await price('media_verified_photo', { billingUnit: 'per_listing', unitPrice: '1500' });
    const ordered = await order().expect(201);
    expect(ordered.body).toMatchObject({
      service: 'verified_photo',
      state: 'pending_payment',
      listingId: mine.id,
      unitId: mine.unitId,
      price: '1605.00',
      invoice: { total: '1605.00', state: 'issued' },
    });
    expect((await order().expect(409)).body.code).toBe('media_service.order_open');
    // cross-tenant
    await t.http.get(`/v1/owner/media-service-orders/${ordered.body.id}`).set(as(stranger)).expect(404);
    await t.http
      .post('/v1/owner/media-service-orders')
      .set(as(stranger))
      .set(idem())
      .send({ listingId: mine.id, service: 'verified_photo' })
      .expect(404);
    expect(
      (await t.http.get('/v1/owner/media-service-orders').set(as(stranger)).expect(200)).body.data,
    ).toEqual([]);

    // the platform cannot schedule before payment
    await t.http
      .post(`/v1/admin/media-service-orders/${ordered.body.id}/actions/schedule`)
      .set(bearer(admin))
      .send({ scheduledFor: addCalendarDays(today(), 3) + 'T07:00:00Z' })
      .expect(409);
    await pay(ordered.body.invoice.id as string, '1605.00');
    expect(
      (await t.http.get(`/v1/owner/media-service-orders/${ordered.body.id}`).set(as(landlord)).expect(200))
        .body,
    ).toMatchObject({ state: 'requested', requestedAt: expect.any(String) });
    const scheduled = await t.http
      .post(`/v1/admin/media-service-orders/${ordered.body.id}/actions/schedule`)
      .set(bearer(admin))
      .send({ scheduledFor: addCalendarDays(today(), 3) + 'T07:00:00Z', partnerRef: 'PARTNER-G5-1' })
      .expect(200);
    expect(scheduled.body).toMatchObject({
      state: 'scheduled',
      partnerRef: 'PARTNER-G5-1',
      tenantId: landlord.tenantId,
    });

    // the partner's file is uploaded as the landlord's listing photo (counted to its storage) and delivered
    const body = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#c2a67a' } })
      .jpeg()
      .toBuffer();
    const presigned = await t.http
      .post(`/v1/admin/media-service-orders/${ordered.body.id}/deliverables`)
      .set(bearer(admin))
      .send({
        kind: 'listing_photo',
        fileName: 'verified-01.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
      .expect(201);
    const fileId = presigned.body.file.id as string;
    const doc = (
      await q<{ storage_key: string; tenant_id: string; scope_id: string }>(
        'SELECT storage_key, tenant_id, scope_id FROM core.document WHERE id = $1',
        [fileId],
      )
    )[0]!;
    expect(doc).toMatchObject({ tenant_id: landlord.tenantId, scope_id: mine.unitId });
    t.app.get<FakeObjectStorage>(OBJECT_STORAGE).putDirect(doc.storage_key, body, 'image/jpeg');
    // a document of another tenant is a 404
    const foreign = (
      await q<{ id: string }>('SELECT id FROM core.document WHERE tenant_id = $1 LIMIT 1', [
        stranger.tenantId,
      ])
    )[0]!.id;
    await t.http
      .post(`/v1/admin/media-service-orders/${ordered.body.id}/actions/deliver`)
      .set(bearer(admin))
      .send({ documentIds: [foreign] })
      .expect(404);
    const delivered = await t.http
      .post(`/v1/admin/media-service-orders/${ordered.body.id}/actions/deliver`)
      .set(bearer(admin))
      .send({ documentIds: [fileId] })
      .expect(200);
    expect(delivered.body).toMatchObject({ state: 'delivered', deliverableDocumentIds: [fileId] });
    await settle();
    const counted = await q<{ tenant_id: string; category: string }>(
      'SELECT tenant_id, category::text FROM platform.document_storage WHERE document_id = $1',
      [fileId],
    );
    expect(counted).toEqual([{ tenant_id: landlord.tenantId, category: 'listing_media' }]);
    expect(
      (await t.http.get(`/v1/owner/media-service-orders/${ordered.body.id}`).set(as(landlord)).expect(200))
        .body,
    ).toMatchObject({ state: 'delivered', deliverableDocumentIds: [fileId] });
    const cancel = await t.http
      .post(`/v1/admin/media-service-orders/${ordered.body.id}/actions/cancel`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'ส่งงานแล้ว' })
      .expect(409);
    expect(cancel.body.code).toBe('media_service.invalid_state');
    // the owner may not reach the platform endpoints
    await t.http.get('/v1/admin/media-service-orders').set(as(landlord)).expect(403);
  });
});

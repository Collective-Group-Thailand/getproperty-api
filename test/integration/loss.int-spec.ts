import 'reflect-metadata';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const GOLDEN = join(__dirname, '..', 'golden', 'loss-report-fixture.json');

/**
 * B3.4 acceptance: the golden loss report of the fixture building (the 12 units of the development building, A-206
 * vacant with usage, A-205's meter stale) — billed units from the issued October invoices of the 11 occupied units
 * (B4.2 replaced the readings stub), metered units from the readings — plus the utility invoice flows (manual entry,
 * OCR prefill, e-bill import, If-Match correction → recompute).
 */
describe('utility invoices & loss (B3.4, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  const units: Record<string, string> = {};
  const meters: Record<string, string> = {};

  /** October electricity per unit (kWh): every unit occupied except A-206 (vacant but consuming). */
  const KWH: Record<string, number> = {
    'A-101': 100,
    'A-102': 110,
    'A-103': 120,
    'A-104': 130,
    'A-105': 140,
    'A-106': 150,
    'A-201': 90,
    'A-202': 95,
    'A-203': 105,
    'A-204': 115,
    'A-205': 125,
    'A-206': 45,
  };

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_loss' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(new Date('2026-11-03T03:00:00Z')); // October is closed (end-of-month cut-off)
    owner = await ownerToken(t);
    for (const r of (
      await db.admin.query<{ unit_no: string; unit_id: string; meter_id: string }>(
        `SELECT u.unit_no, u.id AS unit_id, a.id AS meter_id FROM core.unit u
           JOIN core.asset_item a ON a.unit_id = u.id AND a.category = 'meter_electric' WHERE u.building_id = $1`,
        [DEV.buildingId],
      )
    ).rows) {
      units[r.unit_no] = r.unit_id;
      meters[r.unit_no] = r.meter_id;
    }
    // occupancy: everyone but A-206 (A-101 is the seeded lease)
    await db.admin.query(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from)
       SELECT u.tenant_id, u.building_id, u.id, $2, 'tenant', '2026-09-01' FROM core.unit u
        WHERE u.building_id = $1 AND u.unit_no NOT IN ('A-101', 'A-206')`,
      [DEV.buildingId, DEV.residentPartyId],
    );
    // the October readings (accepted, manual, staff round) — the opening register of every assignment is 0 on 10-01
    for (const [unitNo, kwh] of Object.entries(KWH))
      await db.admin.query(
        `INSERT INTO smart.meter_reading (tenant_id, building_id, asset_item_id, meter_assignment_id, unit_id, register, unit,
                                          read_at, source, confidence, review_state, consumption, submitted_via)
         SELECT m.tenant_id, m.building_id, m.asset_item_id, m.id, m.unit_id, $2, 'kwh', '2026-10-30T10:00:00+07:00',
                'manual', 0.95, 'accepted', $2, 'staff_pwa'
           FROM core.meter_assignment m WHERE m.asset_item_id = $1`,
        [meters[unitNo], kwh],
      );
    // the issued October invoices of the occupied units (B4.2): one electricity line each, billed units = the readings
    const tariff = (
      await db.admin.query<{ id: string }>(
        `SELECT v.id FROM platform.utility_tariff_version v JOIN platform.utility_tariff t ON t.id = v.utility_tariff_id
          WHERE t.utility = 'electric' ORDER BY v.effective_from LIMIT 1`,
      )
    ).rows[0]!.id;
    let n = 0;
    for (const [unitNo, kwh] of Object.entries(KWH)) {
      if (unitNo === 'A-206') continue;
      n += 1;
      const amount = (kwh * 4).toFixed(2);
      const inv = (
        await db.admin.query<{ id: string }>(
          `INSERT INTO ops.invoice (tenant_id, building_id, unit_id, billed_party_id, period_start, period_end, subtotal, total, balance)
           VALUES ($1, $2, $3, $4, '2026-10-01', '2026-10-31', $5, $5, $5) RETURNING id`,
          [DEV.tenantId, DEV.buildingId, units[unitNo], DEV.residentPartyId, amount],
        )
      ).rows[0]!.id;
      await db.admin.query(
        `INSERT INTO ops.invoice_line (tenant_id, invoice_id, line_no, source_type, line_kind, description, quantity, unit,
                                       unit_price, amount, period_from, period_to, units, utility_tariff_version_id, cap_per_unit)
         VALUES ($1, $2, 1, 'meter', 'electricity', 'ค่าไฟฟ้า', $3, 'kwh', 4, $4, '2026-10-01', '2026-10-31', $3, $5, 4.5)`,
        [DEV.tenantId, inv, kwh, amount, tariff],
      );
      await db.admin.query(
        `UPDATE ops.invoice SET status = 'issued', number = $2, snapshot = '{}'::jsonb, issued_at = '2026-11-01T09:00:00+07:00',
                due_date = '2026-11-05' WHERE id = $1`,
        [inv, `INV-2026-${String(n).padStart(5, '0')}`],
      );
    }
    // A-205's meter is stale (health job, D-034)
    await db.admin.query(
      `INSERT INTO smart.meter_status (asset_item_id, tenant_id, building_id, health, health_changed_at)
       VALUES ($1, $2, $3, 'stale', '2026-10-31T00:00:00Z')`,
      [meters['A-205'], DEV.tenantId, DEV.buildingId],
    );
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('no invoice yet → loss.no_invoice; then enter the MEA invoice (duplicates refused)', async () => {
    const none = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/loss?utility=electric&cycle=2026-10`)
      .set(bearer(owner))
      .expect(409);
    expect(none.body.code).toBe('loss.no_invoice');
    const body = {
      utility: 'electric',
      provider: 'mea',
      periodStart: '2026-09-28',
      periodEnd: '2026-10-27',
      invoiceNo: 'MEA-0001',
      units: '1400.000',
      amount: '6000.00',
      ft: '0.3972',
      vat: '392.52',
    };
    const created = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices`)
      .set(bearer(owner))
      .set(idem())
      .send(body)
      .expect(201);
    expect(created.body).toMatchObject({
      units: '1400.000',
      amount: '6000.00',
      source: 'manual',
      version: 1,
    });
    const dup = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices`)
      .set(bearer(owner))
      .set(idem())
      .send(body)
      .expect(409);
    expect(dup.body.code).toBe('utility_invoice.duplicate');
  });

  it('golden loss report: 12 units, A-206 vacant with usage (never invoiced), A-205 stale; billed units from invoices', async () => {
    const res = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/loss?utility=electric&cycle=2026-10`)
      .set(bearer(owner))
      .expect(200);
    const ids: Record<string, string> = Object.fromEntries([
      ...Object.entries(units).map(([n, id]) => [id, `<unit ${n}>`]),
      ...Object.entries(meters).map(([n, id]) => [id, `<meter ${n}>`]),
    ]);
    const normalised = JSON.parse(
      Object.entries(ids).reduce((json, [id, label]) => json.split(id).join(label), JSON.stringify(res.body)),
    ) as { report: Record<string, unknown> & { suspects: Record<string, unknown>[] }; trend: unknown[] };
    const stable = {
      report: {
        ...normalised.report,
        id: '<id>',
        computedAt: '<at>',
        suspects: normalised.report.suspects.map((s) => ({ ...s, id: '<id>' })),
      },
      trend: normalised.trend,
    };
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(stable, null, 2)}\n`);
    expect(existsSync(GOLDEN)).toBe(true);
    expect(stable).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
    // the headline numbers, independent of the file
    expect(res.body.report).toMatchObject({
      invoiceUnits: '1400.000',
      unitBilledUnits: '1280.000', // 1325 metered − A-206's 45 kWh used while vacant and never invoiced
      commonAreaUnits: '0.000',
      lossUnits: '120.000',
      lossPct: '8.5714',
      lossThb: '514.29', // 120 × 6000.00 / 1400 (no published MEA tariff in force → invoice average price)
      priceBasis: 'invoice_average',
      billedUnitsSource: 'invoices',
    });
    expect(
      (res.body.report.suspects as { kind: string; unitId: string }[]).map((s) => [s.kind, s.unitId]),
    ).toEqual([
      ['usage_while_vacant', units['A-206']],
      ['stale_meter', units['A-205']],
    ]);
    const summary = await t.http.get('/v1/owner/loss/summary').set(bearer(owner)).expect(200);
    expect(summary.body).toEqual([
      expect.objectContaining({
        buildingId: DEV.buildingId,
        utility: 'electric',
        lossUnits: '120.000',
        suspects: 2,
      }),
    ]);
  });

  it('correcting the invoice (If-Match) recomputes the stored report; a published tariff becomes the price basis', async () => {
    const list = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices?utility=electric`)
      .set(bearer(owner))
      .expect(200);
    const id = list.body[0].id as string;
    const one = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices/${id}`)
      .set(bearer(owner))
      .expect(200);
    await t.http
      .patch(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices/${id}`)
      .set(bearer(owner))
      .set('If-Match', '"stale"')
      .send({ units: '1425.000' })
      .expect(412);
    await t.http
      .patch(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices/${id}`)
      .set(bearer(owner))
      .set('If-Match', one.headers.etag as string)
      .send({ units: '1425.000' })
      .expect(200);
    await t.worker.tick();
    const after = await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/loss?utility=electric&cycle=2026-10`)
      .set(bearer(owner))
      .expect(200);
    expect(after.body.report.lossUnits).toBe('145.000');

    await db.admin.query(
      `UPDATE platform.utility_tariff_version v
          SET state = 'published', published_at = now(), verified_by = $1, verified_at = now(), needs_check = false
         FROM platform.utility_tariff t WHERE t.id = v.utility_tariff_id AND t.provider = 'mea' AND t.tariff_code LIKE '1.1%'`,
      [DEV.users.support],
    );
    const priced = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/loss/actions/recompute`)
      .set(bearer(owner))
      .send({ utility: 'electric', cycle: '2026-10' })
      .expect(200);
    expect(priced.body.report.priceBasis).toBe('utility_tariff');
    expect(Number(priced.body.report.lossThb)).toBeGreaterThan(0);
  });

  it('OCR prefill and e-bill import of the water invoice; cross-tenant 404', async () => {
    const fields = {
      invoiceNo: 'MWA-77',
      periodStart: '2026-09-28',
      periodEnd: '2026-10-27',
      units: '310.000',
      amount: '2950.00',
      vat: null,
    };
    const doc = await uploadFile(t, db, owner, {
      kind: 'utility_invoice',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'mwa.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from(JSON.stringify(fields)),
    });
    const prefill = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices/actions/prefill`)
      .set(bearer(owner))
      .send({ documentId: doc, utility: 'water' })
      .expect(200);
    expect(prefill.body.fields).toMatchObject({ invoiceNo: 'MWA-77', units: '310.000', amount: '2950.00' });
    const imported = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices/actions/import-ebill`)
      .set(bearer(owner))
      .set(idem())
      .send({ documentId: doc, utility: 'water', provider: 'mwa' })
      .expect(201);
    expect(imported.body).toMatchObject({ source: 'ebill_import', units: '310.000', invoiceDocumentId: doc });
    const empty = await uploadFile(t, db, owner, {
      kind: 'utility_invoice',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'blurry.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 unreadable'),
    });
    const refused = await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices/actions/import-ebill`)
      .set(bearer(owner))
      .set(idem())
      .send({ documentId: empty, utility: 'water', provider: 'mwa' })
      .expect(422);
    expect(refused.body.code).toBe('utility_invoice.unreadable');

    const admin = await adminToken(t);
    const other = await onboardTenant(t, admin, { slug: 'loss-other', phone: '+660000000778' });
    const B = bearer(other.token);
    await t.http.get(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices`).set(B).expect(404);
    await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices/${imported.body.id}`)
      .set(B)
      .expect(404);
    await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/loss?utility=electric&cycle=2026-10`)
      .set(B)
      .expect(404);
    await t.http
      .post(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices`)
      .set(B)
      .set(idem())
      .send({
        utility: 'water',
        provider: 'mwa',
        periodStart: '2026-09-28',
        periodEnd: '2026-10-27',
        units: '1',
        amount: '1.00',
      })
      .expect(404);
    expect((await t.http.get('/v1/owner/loss/summary').set(B).expect(200)).body).toEqual([]);
    await t.http.get(`/v1/owner/meter-readings/reviews`).set(B).expect(200);
    await t.http.get(`/v1/owner/units/${units['A-101']}/meter-history`).set(B).expect(404);
  });
});

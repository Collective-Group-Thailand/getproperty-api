import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { addCalendarDays, bangkokDate } from '@common/time/bangkok';
import { NotificationService } from '@core/notifications/notification.service';
import { AccessService } from '@core/tenancy/access.service';
import { PrismaService } from '@database/prisma.service';
import { fakeLineIdToken } from '@integrations/line/fake-line-login';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';

const LINE_SUB = 'U00000000000000000000000000b6cr01';
const HOUR = 3_600_000;

/**
 * Consumer contract requests answered before B6 (docs/contract-requests-triage.md, D-203). Web: staff building
 * switcher, staff meter points with their gateway channel, edge driver catalogue, round progress (`total`/`read`).
 * LIFF: earliest notice date (#7), building-rules acknowledgement (#8), notification preferences honoured by the
 * planner (#10), documents on file (#11), usage totals (#12). Dispute photos (#9) are in deposits.int-spec.
 * Cross-tenant 404s and the Staff building limit.
 */
describe('contract requests before B6 (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let staff: string;
  let other: { tenantId: string; token: string };
  let resident: string;
  let residentUserId: string;
  let electricMeter = '';

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_cr6' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
    other = await onboardTenant(t, await adminToken(t), {
      slug: 'other-cr6',
      phone: '+660000000161',
      type: 'apartment',
    });
    electricMeter = (
      await q<{ asset_item_id: string }>(
        `SELECT a.asset_item_id FROM core.meter_assignment a JOIN core.unit u ON u.id = a.unit_id
          WHERE u.building_id = $1 AND u.unit_no = 'A-101' AND a.utility = 'electric' AND a.valid_to IS NULL`,
        [DEV.buildingId],
      )
    )[0]!.asset_item_id;
    // the resident of the sample lease links LINE (invitation → consents → accept → refresh)
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(bearer(owner))
        .send({ channel: 'link' })
        .expect(201)
    ).body.code as string;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'ผู้เช่า B6' }) })
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
    ).body.accessToken;
    residentUserId = (
      await q<{ user_id: string }>(
        `SELECT user_id FROM core.party_user_link WHERE party_id = $1 AND state = 'active'`,
        [DEV.residentPartyId],
      )
    )[0]!.user_id;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  describe('staff PWA (web)', () => {
    it('GET /v1/staff/buildings lists my scope with counts; a Staff limit narrows it', async () => {
      const res = await t.http.get('/v1/staff/buildings').set(bearer(staff)).expect(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({ id: DEV.buildingId, code: expect.any(String), unitCount: 12 }),
      ]);
      const mine = await t.http.get('/v1/staff/buildings').set(bearer(other.token)).expect(200);
      expect((mine.body.data as { id: string }[]).map((b) => b.id)).not.toContain(DEV.buildingId);
      await q(
        `UPDATE core.membership SET module_scopes = jsonb_build_object('buildingIds', jsonb_build_array($1::text))
          WHERE user_id = $2 AND tenant_id = $3`,
        [randomUUID(), DEV.users.staff, DEV.tenantId],
      );
      t.app.get(AccessService).forget(DEV.users.staff);
      const limited = await operatorToken(t, '+660000000003');
      expect((await t.http.get('/v1/staff/buildings').set(bearer(limited)).expect(200)).body.data).toEqual(
        [],
      );
      await t.http.get(`/v1/staff/buildings/${DEV.buildingId}/meters`).set(bearer(limited)).expect(404);
      await q(
        `UPDATE core.membership SET module_scopes = '{}'::jsonb WHERE user_id = $1 AND tenant_id = $2`,
        [DEV.users.staff, DEV.tenantId],
      );
      t.app.get(AccessService).forget(DEV.users.staff);
      staff = await operatorToken(t, '+660000000003');
    });

    it('GET /v1/staff/buildings/{id}/meters: floor, last register, gateway channel; 404 for another tenant', async () => {
      const admin = await adminToken(t);
      const gateway = await t.http
        .post('/v1/admin/devices')
        .set(bearer(admin))
        .set(idem())
        .send({
          serial: 'GP-GW-CR6-0001',
          kind: 'gateway',
          model: 'rpi-cm4',
          vendor: 'Collective',
          ownership: 'platform_haas',
          tenantId: DEV.tenantId,
          buildingId: DEV.buildingId,
        })
        .expect(201);
      await q(
        `INSERT INTO smart.meter_channel (tenant_id, building_id, meter_asset_item_id, gateway_device_id, driver, bus_id,
                                          bus_type, address, valid_from)
         VALUES ($1, $2, $3, $4, 'eastron_sdm120', 'rs485-1', 'modbus_rtu', 11, now() - interval '1 day')`,
        [DEV.tenantId, DEV.buildingId, electricMeter, gateway.body.id],
      );
      const res = await t.http
        .get(`/v1/staff/buildings/${DEV.buildingId}/meters`)
        .set(bearer(staff))
        .expect(200);
      const points = res.body.data as {
        assetItemId: string;
        unitNo: string | null;
        floorName: string | null;
        lastRegister: string | null;
        channel: Record<string, unknown> | null;
      }[];
      expect(points.length).toBeGreaterThanOrEqual(24);
      const iot = points.find((p) => p.assetItemId === electricMeter)!;
      expect(iot).toMatchObject({
        unitNo: 'A-101',
        floorName: expect.any(String),
        channel: {
          gatewayDeviceId: gateway.body.id,
          busType: 'modbus_rtu',
          address: 11,
          pin: null,
          driver: 'eastron_sdm120',
          meterDeviceId: null,
        },
      });
      expect(points.filter((p) => p.assetItemId !== electricMeter).every((p) => p.channel === null)).toBe(
        true,
      );
      await t.http.get(`/v1/staff/buildings/${DEV.buildingId}/meters`).set(bearer(other.token)).expect(404);
    });

    it('GET /v1/staff/meter-drivers mirrors the edge catalogue', async () => {
      const res = await t.http.get('/v1/staff/meter-drivers').set(bearer(staff)).expect(200);
      expect(res.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'eastron_sdm120', busType: 'modbus_rtu', utility: 'electric' }),
          expect.objectContaining({ key: 'pulse_counter', busType: 'gpio', utility: 'water' }),
        ]),
      );
    });

    it('reading round: total = read + remaining, a staff reading moves one meter from remaining to read', async () => {
      const round = async () =>
        (await t.http.get('/v1/staff/reading-rounds/current').set(bearer(staff)).expect(200)).body as {
          total: number;
          read: number;
          remaining: number;
        }[];
      // a window covering today, whatever the date of the run (D-031 setting, owner-editable)
      await t.http
        .put('/v1/owner/settings/readings.round_window_days')
        .set(bearer(owner))
        .send({ value: 31, reason: 'test: whole month' })
        .expect(200);
      for (let i = 0; i < 3; i += 1) await t.worker.tick();
      const [before] = await round();
      expect(before!.total).toBe(before!.read + before!.remaining);
      expect(before!.remaining).toBeGreaterThan(0);
      const water = (
        await q<{ asset_item_id: string }>(
          `SELECT a.asset_item_id FROM core.meter_assignment a JOIN core.unit u ON u.id = a.unit_id
            WHERE u.building_id = $1 AND u.unit_no = 'A-102' AND a.utility = 'water' AND a.valid_to IS NULL`,
          [DEV.buildingId],
        )
      )[0]!.asset_item_id;
      const photo = await uploadFile(t, db, staff, {
        surface: 'staff',
        kind: 'meter_photo',
        scopeType: 'asset_item',
        scopeId: water,
        fileName: 'w.jpg',
        mimeType: 'image/jpeg',
        body: Buffer.from('fake-jpeg-meter-photo-cr6'),
      });
      await t.http
        .post('/v1/staff/meter-readings')
        .set(bearer(staff))
        .set(idem())
        .send({
          assetItemId: water,
          photoDocumentId: photo,
          typedValue: '5.000',
          readAt: t.clock.now().toISOString(),
        })
        .expect(201);
      const [after] = await round();
      expect(after).toMatchObject({
        total: before!.total,
        read: before!.read + 1,
        remaining: before!.remaining - 1,
      });
    });
  });

  describe('resident app (liff)', () => {
    const R = () => bearer(resident);

    it('#7 noticeEarliestDate = today (Bangkok) + 30 days while give-notice is offered', async () => {
      const lease = await t.http.get(`/v1/resident/leases/${DEV.leaseId}`).set(R()).expect(200);
      expect(lease.body.nextActions).toContain('give-notice');
      expect(lease.body.noticeEarliestDate).toBe(addCalendarDays(bangkokDate(t.clock.now()), 30));
      const list = await t.http.get('/v1/resident/leases').set(R()).expect(200);
      expect(list.body[0].noticeEarliestDate).toBe(lease.body.noticeEarliestDate);
    });

    it('#8 building rules: refused without rule clauses, acknowledged once (audited, evented)', async () => {
      const none = await t.http
        .post(`/v1/resident/leases/${DEV.leaseId}/rules/acknowledge`)
        .set(R())
        .expect(409);
      expect(none.body.code).toBe('lease.invalid_state');
      await q(
        `UPDATE ops.lease SET addendum = '[{"type":"house_rules","title":"กฎอาคาร","text":"งดส่งเสียงดังหลัง 22:00"}]'::jsonb WHERE id = $1`,
        [DEV.leaseId],
      );
      const before = await t.http.get(`/v1/resident/leases/${DEV.leaseId}`).set(R()).expect(200);
      expect(before.body).toMatchObject({ rulesAcknowledgedAt: null });
      expect(before.body.nextActions).toContain('acknowledge-rules');
      const ack = await t.http
        .post(`/v1/resident/leases/${DEV.leaseId}/rules/acknowledge`)
        .set(R())
        .set(idem())
        .expect(200);
      expect(ack.body.rulesAcknowledgedAt).toEqual(expect.any(String));
      expect(ack.body.nextActions).not.toContain('acknowledge-rules');
      const again = await t.http
        .post(`/v1/resident/leases/${DEV.leaseId}/rules/acknowledge`)
        .set(R())
        .expect(200);
      expect(again.body.rulesAcknowledgedAt).toBe(ack.body.rulesAcknowledgedAt);
      expect(
        await q(
          `SELECT 1 FROM platform.audit_log WHERE action = 'lease.rules_acknowledged' AND subject_id = $1`,
          [DEV.leaseId],
        ),
      ).toHaveLength(1);
      expect(
        await q(`SELECT 1 FROM ops.lease_event WHERE type = 'rules_acknowledged' AND lease_id = $1`, [
          DEV.leaseId,
        ]),
      ).toHaveLength(1);
      expect(
        await q(`SELECT rules_acknowledged_by FROM ops.lease_party WHERE lease_id = $1 AND party_id = $2`, [
          DEV.leaseId,
          DEV.residentPartyId,
        ]),
      ).toEqual([{ rules_acknowledged_by: residentUserId }]);
      await t.http.post(`/v1/resident/leases/${randomUUID()}/rules/acknowledge`).set(R()).expect(404);
    });

    it('#10 notification preferences: locked topics stay on; a topic switched off is not sent there', async () => {
      const get = await t.http.get('/v1/resident/me/notification-preferences').set(R()).expect(200);
      expect(get.body.items).toEqual([
        { topic: 'billing', line: true, sms: true, locked: true },
        { topic: 'lease', line: true, sms: true, locked: true },
        { topic: 'service_requests', line: true, sms: true, locked: false },
        { topic: 'announcements', line: true, sms: true, locked: false },
        { topic: 'parcels', line: true, sms: true, locked: false },
      ]);
      const locked = await t.http
        .put('/v1/resident/me/notification-preferences')
        .set(R())
        .send({ items: [{ topic: 'billing', line: true, sms: false }] })
        .expect(422);
      expect(locked.body.code).toBe('validation.failed');
      const put = await t.http
        .put('/v1/resident/me/notification-preferences')
        .set(R())
        .send({ items: [{ topic: 'announcements', line: false, sms: true }] })
        .expect(200);
      expect(put.body.items[3]).toEqual({ topic: 'announcements', line: false, sms: true, locked: false });
      // the planner skips LINE for an announcement to this party but still sends a (locked) billing message
      const prisma = t.app.get(PrismaService);
      const planner = t.app.get(NotificationService);
      const event = (type: string) => ({
        id: randomUUID(),
        type,
        schemaVersion: 1,
        aggregateType: 'test',
        aggregateId: randomUUID(),
        tenantId: DEV.tenantId,
        buildingId: DEV.buildingId,
        actor: { type: 'system' },
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        causationId: null,
        payload: {},
      });
      const recipient = {
        audience: 'resident' as const,
        type: 'party' as const,
        id: DEV.residentPartyId,
        tenantId: DEV.tenantId,
        language: 'th',
        line: LINE_SUB,
      };
      const announcement = event('announcement.published');
      const bill = event('invoice.issued');
      await prisma.withPlatform(async (tx) => {
        for (const e of [announcement, bill]) {
          await tx.domainEvent.create({
            data: {
              id: e.id,
              type: e.type,
              aggregateType: e.aggregateType,
              aggregateId: e.aggregateId,
              tenantId: e.tenantId,
              buildingId: e.buildingId,
              actor: e.actor,
              occurredAt: new Date(e.occurredAt),
              correlationId: e.correlationId,
              payload: {},
              schemaVersion: 1,
            },
          });
          await planner.plan(tx, e as never, { recipients: [recipient], data: {}, channels: ['line'] });
        }
      });
      const rows = await q<{ event_id: string; state: string; failed_reason: string | null }>(
        `SELECT event_id, state::text, failed_reason FROM platform.notification WHERE event_id = ANY($1::uuid[])`,
        [[announcement.id, bill.id]],
      );
      expect(rows.find((r) => r.event_id === announcement.id)).toMatchObject({
        state: 'cancelled',
        failed_reason: 'topic disabled by the recipient',
      });
      expect(rows.find((r) => r.event_id === bill.id)!.failed_reason).not.toBe(
        'topic disabled by the recipient',
      );
    });

    it('#11 documents on file: my signed contract, audited download, 404 for anything else', async () => {
      const unit = (
        await q<{ unit_id: string }>('SELECT unit_id FROM ops.lease WHERE id = $1', [DEV.leaseId])
      )[0]!.unit_id;
      const contract = await uploadFile(t, db, owner, {
        kind: 'contract',
        scopeType: 'unit',
        scopeId: unit,
        fileName: 'contract.pdf',
        mimeType: 'application/pdf',
        body: Buffer.from('%PDF-1.4 signed contract'),
      });
      await q('UPDATE ops.lease SET signed_document_id = $2 WHERE id = $1', [DEV.leaseId, contract]);
      const list = await t.http.get('/v1/resident/documents').set(R()).expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ id: contract, kind: 'lease_contract', leaseId: DEV.leaseId }),
      ]);
      const dl = await t.http.get(`/v1/resident/documents/${contract}/download`).set(R()).expect(200);
      expect(dl.body).toMatchObject({ url: expect.any(String), expiresAt: expect.any(String) });
      expect(
        await q(
          `SELECT 1 FROM platform.audit_log WHERE action = 'document.downloaded' AND subject_id = $1
              AND metadata->>'purpose' = 'resident_documents'`,
          [contract],
        ),
      ).toHaveLength(1);
      const foreign = await uploadFile(t, db, other.token, {
        kind: 'other',
        scopeType: 'tenant',
        fileName: 'x.pdf',
        mimeType: 'application/pdf',
        body: Buffer.from('%PDF-1.4 other'),
      });
      await t.http.get(`/v1/resident/documents/${foreign}/download`).set(R()).expect(404);
    });

    it('#12 usage summary: window, previous window, current period so far (estimated)', async () => {
      const now = t.clock.now();
      await q(`UPDATE ops.lease SET start_date = ($2::date - 60) WHERE id = $1`, [
        DEV.leaseId,
        bangkokDate(now),
      ]);
      const at = (hoursAgo: number) => new Date(Math.floor(now.getTime() / HOUR) * HOUR - hoursAgo * HOUR);
      const rows: [Date, string][] = [
        [at(5), '1.500'],
        [at(30), '2.000'],
        [at(60), '0.500'],
        [at(100), '1.000'],
        [at(130), '1.250'],
      ];
      for (const [bucket, usage] of rows)
        await q(
          `INSERT INTO smart.telemetry_1h (asset_item_id, bucket, tenant_id, building_id, unit, first_time, last_time,
                                           first_register, last_register, min_register, max_register, points, usage)
           VALUES ($1, $2, $3, $4, 'kwh', $2, $2, 10, 11, 10, 11, 4, $5)`,
          [electricMeter, bucket, DEV.tenantId, DEV.buildingId, usage],
        );
      const from = new Date(now.getTime() - 3 * 86_400_000).toISOString();
      const res = await t.http
        .get(`/v1/resident/leases/${DEV.leaseId}/usage?from=${from}&to=${now.toISOString()}&bucket=1h`)
        .set(R())
        .expect(200);
      const electric = (res.body.summary as { utility: string }[]).find(
        (s) => s.utility === 'electric',
      ) as unknown as {
        total: string;
        previousTotal: string | null;
        cycleToDate: { from: string; usage: string; estimated: boolean } | null;
      };
      expect(electric).toMatchObject({ unit: 'kwh', total: '4.000', previousTotal: '2.250' });
      const cycleFrom = Date.parse(electric.cycleToDate!.from);
      const expected = rows
        .filter(([b]) => b.getTime() >= cycleFrom)
        .reduce((sum, [, u]) => sum + Number(u), 0)
        .toFixed(3);
      expect(electric.cycleToDate).toMatchObject({ usage: expected, estimated: true });
      expect((res.body.summary as { utility: string }[]).some((s) => s.utility === 'water')).toBe(false);
    });
  });
});

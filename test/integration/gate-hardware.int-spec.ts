import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { SettingsService } from '@core/settings/settings.service';
import { type FakeMqttClient } from '@integrations/mqtt/fake-mqtt-client';
import { MQTT_CLIENT } from '@integrations/mqtt/mqtt-client.port';
import { DeviceCommandsService } from '@modules/smart-devices/commands.service';
import { GateHardwareService } from '@modules/smart-gate/gate-hardware.service';
import { GateRetentionService } from '@modules/smart-gate/gate-retention.service';
import { IngestPipeline } from '@modules/smart-ingest/ingest-pipeline.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, otpSignIn } from '../support/int-auth';
import { backdateSeededVersions, createIntDatabase, type IntDatabase } from '../support/int-db';

const PHONE_J = '+660000000351';
const PHONE_J2 = '+660000000352';
const PHONE_P = '+66810003511';
const PHONE_F = '+66810003512';
const PHONE_B = '+66810003513';
const PHONE_R = '+66810003514';
const PIN = '482913';
const BKK = 'กรุงเทพมหานคร';
const CAR_P = { category: '1กข', number: '1234', province: BKK };
const at = (d: string) => new Date(`${d}T09:00:00+07:00`);

type IdKey =
  | 'property'
  | 'building'
  | 'u1'
  | 'u2'
  | 'P'
  | 'R'
  | 'F'
  | 'B'
  | 'userP'
  | 'userF'
  | 'userB'
  | 'userR'
  | 'gate'
  | 'guard'
  | 'gw'
  | 'gwOther'
  | 'property2'
  | 'gate2'
  | 'guard2'
  | 'gw2'
  | 'barrier'
  | 'lpr'
  | 'carP'
  | 'visitCar'
  | 'sos';

interface Tablet {
  deviceId: string;
  deviceSecret: string;
}

/**
 * J4.2 acceptance (D-316, D-317, D-328) on a juristic estate: barrier / LPR attached to an edge gateway (config
 * `gateDevices`), device auth of gate events, `gate.open` delivered exactly once on the (fake) broker and never when
 * stale, the per-gate interval, LPR auto entry of a registered car (+ optional auto open), unknown plates waiting for
 * the guard (claim once), resident open of an own car only (cross-unit 404, geofence, switch), SOS fan-out +
 * acknowledgement + linked visits + cancel window, and isolation (another estate's guard / another tenant: 404).
 */
describe('J4.2 barrier, LPR, resident open, SOS (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let jur: { tenantId: string; token: string };
  let jur2: { tenantId: string; token: string };
  const ids = {} as Record<IdKey, string>;
  const residents: Record<string, string> = {};
  let guard: string;
  let guard2: string;
  let mqtt: FakeMqttClient;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;
  const settle = async (n = 5) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const J = () => bearer(jur.token);
  const G = () => bearer(guard);
  const R = (k: string) => bearer(residents[k]!);
  const setOwner = (token: string, key: string, value: unknown) =>
    t.http
      .put(`/v1/owner/settings/${key}`)
      .set(bearer(token))
      .send({ value, reason: 'J4.2 test' })
      .expect(200)
      .then(() => t.app.get(SettingsService).invalidate(key));
  const gateOpens = (gatewayId: string) =>
    mqtt.published
      .filter((p) => p.topic === `gp/v1/${gatewayId}/cmd`)
      .map(
        (p) =>
          JSON.parse(p.payload.toString('utf8')) as {
            cmdId: string;
            type: string;
            ttlS: number;
            args: Record<string, unknown>;
          },
      )
      .filter((c) => c.type === 'gate.open');
  const deviceEvent = (
    gatewayId: string,
    type: string,
    data: Record<string, unknown>,
    eventId: string = randomUUID(),
  ) =>
    t.app.get(IngestPipeline).handle(
      `gp/v1/${gatewayId}/events`,
      JSON.stringify({
        eventId,
        gatewayId,
        type,
        severity: 'info',
        occurredAt: t.clock.now().toISOString(),
        data,
      }),
    );
  const plate = (
    gatewayId: string,
    gateId: string,
    p: Record<string, unknown>,
    confidence = 0.97,
    eventId?: string,
  ) =>
    deviceEvent(
      gatewayId,
      'plate.detected',
      { gateId, plate: p, confidence, at: t.clock.now().toISOString() },
      eventId ?? randomUUID(),
    );
  const notified = (type: string, aggregateId: string) =>
    q<{ recipient_id: string; channel: string }>(
      `SELECT n.recipient_id, n.channel::text FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = $1 AND e.aggregate_id = $2 ORDER BY n.recipient_id, n.channel`,
      [type, aggregateId],
    );

  async function estate(token: string, code: string) {
    const property = await t.http
      .post('/v1/owner/properties')
      .set(bearer(token))
      .send({ code, name: `หมู่บ้าน ${code}`, kind: 'village' })
      .expect(201);
    const building = await t.http
      .post('/v1/owner/buildings')
      .set(bearer(token))
      .send({
        propertyId: property.body.id,
        code: 'A',
        name: 'โซน A',
        type: 'condo',
        legalForm: 'land_allocation_act',
      })
      .expect(201);
    return { propertyId: property.body.id as string, buildingId: building.body.id as string };
  }
  const unit = async (token: string, buildingId: string, unitNo: string) =>
    (
      await t.http
        .post('/v1/owner/units')
        .set(bearer(token))
        .send({ buildingId, unitNo, type: 'condo_unit', areaSqm: '40.00' })
        .expect(201)
    ).body.id as string;
  const gateway = async (tenantId: string, buildingId: string, serial: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO smart.device (serial, kind, model, vendor, tenant_id, building_id, status)
         VALUES ($1, 'gateway', 'gp-edge-pi', 'collective', $2, $3, 'online') RETURNING id`,
        [serial, tenantId, buildingId],
      )
    ).id;
  async function gateWithTablet(
    token: string,
    propertyId: string,
    name: string,
  ): Promise<{ gateId: string; tablet: Tablet }> {
    const gate = await t.http
      .post('/v1/owner/gates')
      .set(bearer(token))
      .send({ propertyId, name, kind: 'main' })
      .expect(201);
    const slot = await t.http
      .post(`/v1/owner/gates/${gate.body.id}/devices`)
      .set(bearer(token))
      .set(idem())
      .send({ name: 'แท็บเล็ต' })
      .expect(201);
    const enrolled = await t.http
      .post('/v1/auth/guard/devices/enrol')
      .send({ code: slot.body.enrolCode, name: 'แท็บเล็ต 1' })
      .expect(200);
    return {
      gateId: gate.body.id as string,
      tablet: {
        deviceId: enrolled.body.deviceId as string,
        deviceSecret: enrolled.body.deviceSecret as string,
      },
    };
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_gate_hardware' });
    await backdateSeededVersions(db.admin);
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    t.clock.set(at('2027-01-10'));
    mqtt = t.app.get<FakeMqttClient>(MQTT_CLIENT);
    admin = await adminToken(t);
    jur = await onboardTenant(t, admin, { slug: 'j42-estate', phone: PHONE_J, type: 'juristic' });
    jur2 = await onboardTenant(t, admin, { slug: 'j42-other', phone: PHONE_J2, type: 'juristic' });
    const e1 = await estate(jur.token, 'H1');
    ids.property = e1.propertyId;
    ids.building = e1.buildingId;
    await q(`UPDATE core.property SET lat = 13.690000, lng = 100.685000 WHERE id = $1`, [ids.property]);
    ids.u1 = await unit(jur.token, ids.building, 'A-101');
    ids.u2 = await unit(jur.token, ids.building, 'A-102');
    const owner = async (unitId: string, displayName: string, phone: string) =>
      (
        await t.http
          .post(`/v1/owner/juristic/register/units/${unitId}/owners`)
          .set(J())
          .send({ validFrom: '2020-01-01', sharePct: '100', party: { type: 'person', displayName, phone } })
          .expect(201)
      ).body.owners[0].party.id as string;
    ids.P = await owner(ids.u1, 'สมชาย เจ้าของ', PHONE_P);
    ids.R = await owner(ids.u2, 'สมศักดิ์ บ้านอื่น', PHONE_R);
    const party = async (displayName: string, phone: string) =>
      (
        await t.http
          .post('/v1/owner/parties')
          .set(J())
          .send({ type: 'person', displayName, phone })
          .expect(201)
      ).body.id as string;
    ids.F = await party('น้องฟ้า ครอบครัว', PHONE_F);
    ids.B = await party('บริษัท จ่ายแทน', PHONE_B);
    await q(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from) VALUES ($1, $2, $3, $4, 'family', '2020-01-01')`,
      [jur.tenantId, ids.building, ids.u1, ids.F],
    );
    const consent = await one<{ id: string }>(
      `INSERT INTO core.document (tenant_id, scope_type, kind, storage_bucket, storage_key, mime_type, size_bytes, sha256, retention_class, upload_state)
       VALUES ($1, 'tenant', 'other', 'b', 'k-' || gen_random_uuid(), 'application/pdf', 10, decode(repeat('ab', 32), 'hex'), 'legal', 'verified') RETURNING id`,
      [jur.tenantId],
    );
    await q(
      `INSERT INTO juristic.bill_to (tenant_id, building_id, unit_id, owner_party_id, bill_to_party_id, consent_document_id, valid_from)
       VALUES ($1, $2, $3, $4, $5, $6, '2020-01-01')`,
      [jur.tenantId, ids.building, ids.u1, ids.P, ids.B, consent.id],
    );
    for (const [key, phone] of [
      ['P', PHONE_P],
      ['F', PHONE_F],
      ['B', PHONE_B],
      ['R', PHONE_R],
    ] as const) {
      const signed = await otpSignIn(t, 'resident', phone, jur.token);
      residents[key] = signed.accessToken;
      ids[`user${key}`] = signed.subject.id;
      await q(`UPDATE core.user_account SET line_user_id = $2 WHERE id = $1`, [
        signed.subject.id,
        `U${key}${'0'.repeat(31)}`,
      ]);
    }
    const g1 = await gateWithTablet(jur.token, ids.property, 'ป้อมหน้า');
    ids.gate = g1.gateId;
    ids.guard = (
      await t.http
        .post('/v1/owner/gate-guards')
        .set(J())
        .set(idem())
        .send({ propertyId: ids.property, displayName: 'สมศักดิ์ กะเช้า', pin: PIN })
        .expect(201)
    ).body.id;
    guard = (
      await t.http
        .post('/v1/auth/guard/sign-in')
        .send({ ...g1.tablet, guardId: ids.guard, pin: PIN })
        .expect(200)
    ).body.accessToken;
    ids.gw = await gateway(jur.tenantId, ids.building, 'GW-J42-0001');
    ids.gwOther = await gateway(jur.tenantId, ids.building, 'GW-J42-0002');
    // another tenant's estate, gate, guard and gateway
    const e2 = await estate(jur2.token, 'H2');
    ids.property2 = e2.propertyId;
    const g2 = await gateWithTablet(jur2.token, e2.propertyId, 'ป้อมอื่น');
    ids.gate2 = g2.gateId;
    ids.guard2 = (
      await t.http
        .post('/v1/owner/gate-guards')
        .set(bearer(jur2.token))
        .set(idem())
        .send({ propertyId: e2.propertyId, displayName: 'ป้อมอื่น', pin: '730154' })
        .expect(201)
    ).body.id;
    guard2 = (
      await t.http
        .post('/v1/auth/guard/sign-in')
        .send({ ...g2.tablet, guardId: ids.guard2, pin: '730154' })
        .expect(200)
    ).body.accessToken;
    ids.gw2 = await gateway(jur2.tenantId, e2.buildingId, 'GW-J42-0003');
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await db?.drop();
  });

  it('attaches a barrier and an LPR camera to an edge gateway of the estate; the gateway config carries them', async () => {
    const barrier = await t.http
      .post(`/v1/owner/gates/${ids.gate}/edge-devices`)
      .set(J())
      .set(idem())
      .send({
        kind: 'barrier',
        name: 'ไม้กั้นขาเข้า',
        edgeDeviceId: ids.gw,
        channel: 'relay-1',
        pulseMs: 900,
      })
      .expect(201);
    expect(barrier.body).toMatchObject({
      kind: 'barrier',
      state: 'active',
      edgeDeviceId: ids.gw,
      channel: 'relay-1',
      pulseMs: 900,
    });
    ids.barrier = barrier.body.id;
    const lpr = await t.http
      .post(`/v1/owner/gates/${ids.gate}/edge-devices`)
      .set(J())
      .set(idem())
      .send({ kind: 'lpr', name: 'กล้องขาเข้า', edgeDeviceId: ids.gw, channel: 'cam:entry' })
      .expect(201);
    ids.lpr = lpr.body.id;
    // the same channel twice: 409; another tenant's gateway: 422; another tenant's gate: 404
    expect(
      (
        await t.http
          .post(`/v1/owner/gates/${ids.gate}/edge-devices`)
          .set(J())
          .set(idem())
          .send({ kind: 'barrier', name: 'ซ้ำ', edgeDeviceId: ids.gw, channel: 'relay-1' })
          .expect(409)
      ).body.code,
    ).toBe('gate.channel_taken');
    expect(
      (
        await t.http
          .post(`/v1/owner/gates/${ids.gate}/edge-devices`)
          .set(J())
          .set(idem())
          .send({ kind: 'barrier', name: 'อื่น', edgeDeviceId: ids.gw2, channel: 'relay-9' })
          .expect(422)
      ).body.code,
    ).toBe('gate.edge_device_invalid');
    await t.http
      .post(`/v1/owner/gates/${ids.gate}/edge-devices`)
      .set(bearer(jur2.token))
      .set(idem())
      .send({ kind: 'barrier', name: 'x', edgeDeviceId: ids.gw2, channel: 'relay-1' })
      .expect(404);
    const gate = await t.http.get(`/v1/owner/gates/${ids.gate}`).set(J()).expect(200);
    expect(gate.body).toMatchObject({ barrier: true, lpr: true });
    const config = await one<{
      document: { gateDevices?: { kind: string; channel: string; pulseMs?: number }[] };
    }>(
      `SELECT document FROM smart.gateway_config WHERE gateway_device_id = $1 ORDER BY version DESC LIMIT 1`,
      [ids.gw],
    );
    expect(config.document.gateDevices).toHaveLength(2);
    expect(config.document.gateDevices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'barrier',
          channel: 'relay-1',
          pulseMs: 900,
          gateId: ids.gate,
          deviceId: ids.barrier,
        }),
        expect.objectContaining({ kind: 'lpr', channel: 'cam:entry', gateId: ids.gate, deviceId: ids.lpr }),
      ]),
    );
    const hw = await t.http.get('/v1/guard/hardware').set(G()).expect(200);
    expect((hw.body as { kind: string }[]).map((d) => d.kind).sort()).toEqual(['barrier', 'lpr']);
  });

  it('guard open: gate.open delivered once on the broker, never re-sent, never sent when stale; 3-s interval; audit', async () => {
    await settle();
    const before = gateOpens(ids.gw).length;
    const opened = await t.http
      .post(`/v1/guard/gates/${ids.gate}/actions/open`)
      .set(G())
      .send({ reason: 'visit' })
      .expect(202);
    expect(opened.body.commands).toHaveLength(1);
    const commandId = opened.body.commands[0].commandId as string;
    // too soon: 429 with Retry-After
    const again = await t.http
      .post(`/v1/guard/gates/${ids.gate}/actions/open`)
      .set(G())
      .send({ reason: 'visit' });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('gate.open_rate_limited');
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    await settle();
    const sent = gateOpens(ids.gw).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      cmdId: commandId,
      type: 'gate.open',
      ttlS: 30,
      args: { commandId, gateId: ids.gate, deviceId: ids.barrier, reason: 'visit', pulseMs: 900 },
    });
    expect(
      new Date(sent[0]!.args.expiresAt as string).getTime() - t.clock.now().getTime(),
    ).toBeLessThanOrEqual(30_000);
    // no ack: the sweep never re-sends a gate.open, it expires it
    t.clock.advance(61_000);
    await t.app.get(DeviceCommandsService).sweep();
    await settle();
    expect(gateOpens(ids.gw).slice(before)).toHaveLength(1);
    expect(
      (
        await one<{ status: string }>(`SELECT status::text FROM smart.device_command WHERE id = $1`, [
          commandId,
        ])
      ).status,
    ).toBe('expired');
    // a command whose delivery comes after its 30 s is never published
    const late = await t.http
      .post(`/v1/guard/gates/${ids.gate}/actions/open`)
      .set(G())
      .send({ reason: 'delivery' })
      .expect(202);
    t.clock.advance(31_000);
    await settle();
    await t.app.get(DeviceCommandsService).sweep();
    expect(gateOpens(ids.gw).map((c) => c.cmdId)).not.toContain(late.body.commands[0].commandId);
    expect(
      (
        await one<{ status: string }>(`SELECT status::text FROM smart.device_command WHERE id = $1`, [
          late.body.commands[0].commandId,
        ])
      ).status,
    ).toBe('expired');
    // other reasons need a note; another gate (of another estate) is a 404
    t.clock.advance(5_000);
    await t.http
      .post(`/v1/guard/gates/${ids.gate}/actions/open`)
      .set(G())
      .send({ reason: 'other' })
      .expect(422);
    await t.http
      .post(`/v1/guard/gates/${ids.gate2}/actions/open`)
      .set(G())
      .send({ reason: 'visit' })
      .expect(404);
    await t.http
      .post(`/v1/guard/gates/${ids.gate}/actions/open`)
      .set(bearer(guard2))
      .send({ reason: 'visit' })
      .expect(404);
    const audit = await q(
      `SELECT 1 FROM platform.audit_log WHERE action = 'gate.open_requested' AND subject_id = $1`,
      [ids.gate],
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('device auth: gate events from a gateway that does not drive the device are refused and audited', async () => {
    const before = await one<{ n: number }>(`SELECT count(*)::int AS n FROM smart.plate_detection`);
    await plate(ids.gwOther, ids.gate, { category: '9ขค', number: '5555', province: BKK });
    await plate(ids.gw2, ids.gate, { category: '9ขค', number: '5555', province: BKK });
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM smart.plate_detection`)).n).toBe(
      before.n,
    );
    const refused = await q(`SELECT 1 FROM platform.audit_log WHERE action = 'gate.device_event_refused'`);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // a barrier state from the right gateway updates the device
    await deviceEvent(ids.gw, 'gate.state', {
      gateId: ids.gate,
      state: 'closed',
      at: t.clock.now().toISOString(),
    });
    expect(
      (
        await one<{ hw_state: string }>(`SELECT hw_state::text FROM smart.gate_device WHERE id = $1`, [
          ids.barrier,
        ])
      ).hw_state,
    ).toBe('closed');
    // the stored device event keeps no plate
    const stored = await q<{ data: Record<string, unknown> }>(
      `SELECT data FROM smart.device_event WHERE type = 'plate_detected'`,
    );
    for (const s of stored) expect(JSON.stringify(s.data)).not.toContain('5555');
  });

  it('a registered car enters by LPR (one visit per car, redelivery idempotent); auto open only when the estate enables it', async () => {
    // household registers its car; family may read but not add; another unit 404
    await t.http.post(`/v1/resident/units/${ids.u1}/vehicles`).set(R('F')).send({ plate: CAR_P }).expect(404);
    const car = await t.http
      .post(`/v1/resident/units/${ids.u1}/vehicles`)
      .set(R('P'))
      .send({ plate: CAR_P, label: 'รถคุณพ่อ' })
      .expect(201);
    ids.carP = car.body.id;
    await t.http.post(`/v1/resident/units/${ids.u1}/vehicles`).set(R('P')).send({ plate: CAR_P }).expect(409);
    expect(
      (await t.http.get(`/v1/resident/units/${ids.u1}/vehicles`).set(R('F')).expect(200)).body,
    ).toHaveLength(1);
    await t.http.get(`/v1/resident/units/${ids.u1}/vehicles`).set(R('R')).expect(404);
    t.clock.advance(10_000);
    const before = gateOpens(ids.gw).length;
    const eventId = randomUUID();
    await plate(ids.gw, ids.gate, { category: '๑ กข', number: '๑๒๓๔', province: ` ${BKK} ` }, 0.96, eventId);
    await plate(ids.gw, ids.gate, CAR_P, 0.96, eventId); // redelivery
    await plate(ids.gw, ids.gate, CAR_P, 0.96); // same car, next frame
    const visits = await q<{ id: string; state: string; kind: string; entry_basis: string; unit_id: string }>(
      `SELECT id, state::text, kind::text, entry_basis::text, unit_id FROM smart.visit WHERE client_ref = $1`,
      [eventId],
    );
    expect(visits).toEqual([
      expect.objectContaining({
        state: 'entered',
        kind: 'resident_vehicle',
        entry_basis: 'resident_vehicle',
        unit_id: ids.u1,
      }),
    ]);
    ids.visitCar = visits[0]!.id;
    const det = await q<{ state: string; match: string }>(
      `SELECT state::text, match::text FROM smart.plate_detection WHERE gate_id = $1 AND plate_number = '1234'`,
      [ids.gate],
    );
    expect(det).toEqual([{ state: 'matched', match: 'resident_vehicle' }]);
    await settle();
    expect(gateOpens(ids.gw).length).toBe(before); // auto open off by default
    // the household is not told about its own car coming home
    expect(await notified('gate.visit.entered', ids.visitCar)).toEqual([]);
    // the estate enables auto open: the next known read opens the barrier
    t.clock.advance(61_000);
    await setOwner(jur.token, 'gate.auto_open_known_plates', true);
    t.clock.advance(1_000);
    await plate(ids.gw, ids.gate, CAR_P, 0.99);
    await settle();
    const auto = gateOpens(ids.gw).slice(before);
    expect(auto).toHaveLength(1);
    expect(auto[0]!.args).toMatchObject({ reason: 'lpr_known_plate', gateId: ids.gate });
    expect(auto[0]!.args.visitId).toBeTruthy();
    await setOwner(jur.token, 'gate.auto_open_known_plates', false);
  });

  it('CR-017: a plate read delivered late after an edge outage never opens the barrier nor enters as live', async () => {
    t.clock.advance(61_000);
    await setOwner(jur.token, 'gate.auto_open_known_plates', true);
    t.clock.advance(1_000);
    const before = gateOpens(ids.gw).length;
    // queued on the edge during an outage: read 2 minutes ago, delivered now (> gate.lpr.max_event_age_seconds 20)
    const lateId = randomUUID();
    const readAt = new Date(t.clock.now().getTime() - 120_000).toISOString();
    await deviceEvent(
      ids.gw,
      'plate.detected',
      { gateId: ids.gate, plate: CAR_P, confidence: 0.99, at: readAt },
      lateId,
    );
    // the queue flushes several frames of the same car: one past read kept
    await deviceEvent(ids.gw, 'plate.detected', {
      gateId: ids.gate,
      plate: CAR_P,
      confidence: 0.99,
      at: new Date(t.clock.now().getTime() - 118_000).toISOString(),
    });
    await settle();
    expect(gateOpens(ids.gw).length).toBe(before); // no automatic open
    expect(await q(`SELECT 1 FROM smart.visit WHERE client_ref = $1`, [lateId])).toEqual([]); // no automatic entry
    const late = await q<{
      id: string;
      state: string;
      match: string;
      visit_id: string | null;
      unit_id: string;
    }>(
      `SELECT id, state::text, match::text, visit_id, unit_id FROM smart.plate_detection WHERE event_id = $1`,
      [lateId],
    );
    expect(late).toEqual([
      expect.objectContaining({
        state: 'historical',
        match: 'resident_vehicle',
        visit_id: null,
        unit_id: ids.u1,
      }),
    ]);
    expect(
      (await q(`SELECT 1 FROM smart.plate_detection WHERE state = 'historical' AND gate_id = $1`, [ids.gate]))
        .length,
    ).toBe(1);
    expect(
      await q(`SELECT 1 FROM platform.audit_log WHERE action = 'gate.plate_read_late' AND subject_id = $1`, [
        late[0]!.id,
      ]),
    ).toHaveLength(1);
    // the guard sees it as a past read: not pending (nothing to claim), listed in the recent reads
    const pending = (await t.http.get('/v1/guard/plate-detections').set(G()).expect(200)).body as {
      id: string;
    }[];
    expect(pending.map((d) => d.id)).not.toContain(late[0]!.id);
    const recent = (await t.http.get('/v1/guard/plate-detections?view=recent').set(G()).expect(200)).body as {
      id: string;
      state: string;
    }[];
    expect(recent.find((d) => d.id === late[0]!.id)).toMatchObject({ state: 'historical' });
    expect(
      (await t.http.post(`/v1/guard/plate-detections/${late[0]!.id}/actions/claim`).set(G()).expect(409)).body
        .code,
    ).toBe('plate_detection.invalid_state');
    // a read within the age limit is live: the same car arriving now still enters and opens (a late read never
    // suppresses the next live read)
    const liveId = randomUUID();
    await deviceEvent(
      ids.gw,
      'plate.detected',
      {
        gateId: ids.gate,
        plate: CAR_P,
        confidence: 0.99,
        at: new Date(t.clock.now().getTime() - 5_000).toISOString(),
      },
      liveId,
    );
    await settle();
    expect(await q(`SELECT 1 FROM smart.visit WHERE client_ref = $1`, [liveId])).toHaveLength(1);
    const opened = gateOpens(ids.gw).slice(before);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.args).toMatchObject({ reason: 'lpr_known_plate' });
    await setOwner(jur.token, 'gate.auto_open_known_plates', false);
  });

  it('unknown and low-confidence plates wait for the guard: listed, claimed once, then 409', async () => {
    t.clock.advance(5_000);
    await plate(ids.gw, ids.gate, { category: 'ฌก', number: '777', province: 'ชลบุรี' }, 0.93, undefined);
    t.clock.advance(1_000);
    await plate(ids.gw, ids.gate, CAR_P, 0.5); // low confidence (after the repeat window? no — same plate → ignored)
    const pending = await t.http.get('/v1/guard/plate-detections').set(G()).expect(200);
    const unknown = (pending.body as { id: string; plate: { number: string } }[]).find(
      (d) => d.plate.number === '777',
    )!;
    expect(unknown).toMatchObject({
      state: 'pending',
      match: 'none',
      unit: null,
      plate: { category: 'ฌก', province: 'ชลบุรี' },
    });
    const claimed = await t.http
      .post(`/v1/guard/plate-detections/${unknown.id}/actions/claim`)
      .set(G())
      .expect(200);
    expect(claimed.body.state).toBe('claimed');
    expect(
      (await t.http.post(`/v1/guard/plate-detections/${unknown.id}/actions/claim`).set(G()).expect(409)).body
        .code,
    ).toBe('plate_detection.invalid_state');
    // another estate's guard cannot see it
    await t.http
      .post(`/v1/guard/plate-detections/${unknown.id}/actions/dismiss`)
      .set(bearer(guard2))
      .expect(404);
    // a known car read with low confidence pre-fills (with its unit) instead of entering
    t.clock.advance(61_000);
    await plate(ids.gw, ids.gate, CAR_P, 0.5);
    const low = (
      (await t.http.get('/v1/guard/plate-detections').set(G()).expect(200)).body as {
        plate: { number: string };
      }[]
    ).find((d: { plate: { number: string } }) => d.plate.number === '1234');
    expect(low).toMatchObject({
      state: 'pending',
      match: 'low_confidence',
      unit: { id: ids.u1, unitNo: 'A-101' },
      visitId: null,
    });
    // pending reads expire after gate.lpr.pending_minutes (backdated: access tokens live 15 min of the fake clock)
    await q(
      `UPDATE smart.plate_detection SET received_at = received_at - interval '11 minutes' WHERE state = 'pending'`,
    );
    await t.worker.tick();
    expect(await t.app.get(GateHardwareService).expireDetections()).toBeGreaterThanOrEqual(0);
    expect((await t.http.get('/v1/guard/plate-detections').set(G()).expect(200)).body).toEqual([]);
    expect((await q(`SELECT 1 FROM smart.plate_detection WHERE state = 'pending'`)).length).toBe(0);
  });

  it('J review A2 / A6: a future-stamped read is history (clock suspect); a province-less read waits for the guard', async () => {
    t.clock.advance(61_000);
    await setOwner(jur.token, 'gate.auto_open_known_plates', true);
    t.clock.advance(1_000);
    const before = gateOpens(ids.gw).length;
    // A2: the gateway clock is an hour ahead — the read cannot be proven live (CR-017 bypass otherwise)
    const futureId = randomUUID();
    await deviceEvent(
      ids.gw,
      'plate.detected',
      {
        gateId: ids.gate,
        plate: CAR_P,
        confidence: 0.99,
        at: new Date(t.clock.now().getTime() + 3_600_000).toISOString(),
      },
      futureId,
    );
    await settle();
    expect(gateOpens(ids.gw).length).toBe(before);
    expect(await q(`SELECT 1 FROM smart.visit WHERE client_ref = $1`, [futureId])).toEqual([]);
    const future = await one<{ id: string; state: string; visit_id: string | null }>(
      `SELECT id, state::text, visit_id FROM smart.plate_detection WHERE event_id = $1`,
      [futureId],
    );
    expect(future).toMatchObject({ state: 'historical', visit_id: null });
    expect(
      await q<{ reason: string }>(
        `SELECT metadata->>'reason' AS reason FROM platform.audit_log WHERE action = 'gate.plate_read_late' AND subject_id = $1`,
        [future.id],
      ),
    ).toEqual([{ reason: 'clock_suspect' }]);
    // A6: the camera missed the province — the same category + number may be another province's car: no automatic
    // entry nor open; the read waits for the guard with the unit pre-filled
    const blindId = randomUUID();
    await plate(ids.gw, ids.gate, { category: '1กข', number: '1234' }, 0.99, blindId);
    await settle();
    expect(gateOpens(ids.gw).length).toBe(before);
    expect(await q(`SELECT 1 FROM smart.visit WHERE client_ref = $1`, [blindId])).toEqual([]);
    const blind = await one<{ id: string; state: string; match: string; unit_id: string }>(
      `SELECT id, state::text, match::text, unit_id FROM smart.plate_detection WHERE event_id = $1`,
      [blindId],
    );
    expect(blind).toMatchObject({ state: 'pending', match: 'low_confidence', unit_id: ids.u1 });
    await t.http.post(`/v1/guard/plate-detections/${blind.id}/actions/dismiss`).set(G()).expect(200);
    await setOwner(jur.token, 'gate.auto_open_known_plates', false);
  });

  it('resident open: own registered car only (other unit / payer-only 404), switch, geofence, hourly cap', async () => {
    t.clock.advance(10_000);
    const gates = await t.http.get('/v1/resident/gates').set(R('P')).expect(200);
    expect(gates.body).toEqual([
      expect.objectContaining({
        gateId: ids.gate,
        enabled: true,
        requireGeofence: false,
        vehicles: [expect.objectContaining({ id: ids.carP })],
      }),
    ]);
    const before = gateOpens(ids.gw).length;
    const ok = await t.http
      .post(`/v1/resident/gates/${ids.gate}/actions/open`)
      .set(R('P'))
      .send({ vehicleId: ids.carP })
      .expect(202);
    expect(ok.body.commands).toHaveLength(1);
    await settle();
    expect(gateOpens(ids.gw).slice(before)[0]!.args).toMatchObject({ reason: 'resident_app' });
    // family of the unit may open the household's car; another unit's resident and the payer-only party may not
    t.clock.advance(4_000);
    await t.http
      .post(`/v1/resident/gates/${ids.gate}/actions/open`)
      .set(R('F'))
      .send({ vehicleId: ids.carP })
      .expect(202);
    t.clock.advance(4_000);
    await t.http
      .post(`/v1/resident/gates/${ids.gate}/actions/open`)
      .set(R('R'))
      .send({ vehicleId: ids.carP })
      .expect(404);
    await t.http
      .post(`/v1/resident/gates/${ids.gate}/actions/open`)
      .set(R('B'))
      .send({ vehicleId: ids.carP })
      .expect(404);
    await t.http
      .post(`/v1/resident/gates/${ids.gate2}/actions/open`)
      .set(R('P'))
      .send({ vehicleId: ids.carP })
      .expect(404);
    // geofence: required → location needed; far → 403 (only the decision audited); near → 202
    await setOwner(jur.token, 'gate.resident_open.require_geofence', true);
    t.clock.advance(4_000);
    await t.http
      .post(`/v1/resident/gates/${ids.gate}/actions/open`)
      .set(R('P'))
      .send({ vehicleId: ids.carP })
      .expect(422);
    const far = await t.http
      .post(`/v1/resident/gates/${ids.gate}/actions/open`)
      .set(R('P'))
      .send({ vehicleId: ids.carP, location: { lat: 13.75, lng: 100.5 } })
      .expect(403);
    expect(far.body.code).toBe('gate.outside_geofence');
    const denied = await q<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM platform.audit_log WHERE action = 'gate.open_requested' AND outcome = 'denied'`,
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]!.metadata).toMatchObject({ geofence: 'outside' });
    expect(JSON.stringify(denied[0]!.metadata)).not.toContain('13.75');
    await t.http
      .post(`/v1/resident/gates/${ids.gate}/actions/open`)
      .set(R('P'))
      .send({ vehicleId: ids.carP, location: { lat: 13.6915, lng: 100.685, accuracyM: 15 } })
      .expect(202);
    await setOwner(jur.token, 'gate.resident_open.require_geofence', false);
    await setOwner(jur.token, 'gate.resident_open.enabled', false);
    t.clock.advance(4_000);
    expect(
      (
        await t.http
          .post(`/v1/resident/gates/${ids.gate}/actions/open`)
          .set(R('P'))
          .send({ vehicleId: ids.carP })
          .expect(403)
      ).body.code,
    ).toBe('gate.resident_open_disabled');
    await setOwner(jur.token, 'gate.resident_open.enabled', true);
    // the household removes the car: it no longer opens
    await t.http.get(`/v1/owner/gate-vehicles?unitId=${ids.u1}`).set(J()).expect(200);
    const spare = await t.http
      .post(`/v1/resident/units/${ids.u1}/vehicles`)
      .set(R('P'))
      .send({ plate: { category: 'กก', number: '1', province: BKK } })
      .expect(201);
    await t.http.delete(`/v1/resident/units/${ids.u1}/vehicles/${spare.body.id}`).set(R('P')).expect(204);
    t.clock.advance(4_000);
    await t.http
      .post(`/v1/resident/gates/${ids.gate}/actions/open`)
      .set(R('P'))
      .send({ vehicleId: spare.body.id })
      .expect(404);
  });

  it('SOS: fan-out to every gate stream, office, staff and committee; acknowledged by the guard; linked visits; cancel window', async () => {
    t.clock.advance(60_000);
    // a visitor of A-102 inside the estate, one that left long ago
    const inside = await one<{ id: string }>(
      `INSERT INTO smart.visit (tenant_id, gate_id, property_id, unit_id, kind, state, entry_basis, client_ref, entered_at)
       VALUES ($1, $2, $3, $4, 'guest', 'entered', 'approval', gen_random_uuid(), $5) RETURNING id`,
      [jur.tenantId, ids.gate, ids.property, ids.u2, new Date(t.clock.now().getTime() - 3_600_000)],
    );
    const left = await one<{ id: string }>(
      `INSERT INTO smart.visit (tenant_id, gate_id, property_id, unit_id, kind, state, entry_basis, client_ref, entered_at, exited_at)
       VALUES ($1, $2, $3, $4, 'guest', 'exited', 'approval', gen_random_uuid(), $5, $6) RETURNING id`,
      [
        jur.tenantId,
        ids.gate,
        ids.property,
        ids.u2,
        new Date(t.clock.now().getTime() - 5 * 3_600_000),
        new Date(t.clock.now().getTime() - 4 * 3_600_000),
      ],
    );
    // a staff member of the estate hears it too
    const sos = await t.http
      .post('/v1/resident/sos')
      .set(R('P'))
      .set(idem())
      .send({ unitId: ids.u1, kind: 'medical', note: 'คุณพ่อหมดสติ' })
      .expect(201);
    expect(sos.body).toMatchObject({
      state: 'open',
      existing: false,
      unit: { id: ids.u1, unitNo: 'A-101' },
      kind: 'medical',
    });
    expect(sos.body.cancellableUntil).toBeTruthy();
    ids.sos = sos.body.id;
    const row = await one<{ visit_ids: string[] }>(`SELECT visit_ids FROM smart.incident WHERE id = $1`, [
      ids.sos,
    ]);
    expect(row.visit_ids).toContain(inside.id);
    expect(row.visit_ids).toContain(ids.visitCar);
    expect(row.visit_ids).not.toContain(left.id);
    // a second press returns the open one; another unit is a 404
    const second = await t.http
      .post('/v1/resident/sos')
      .set(R('P'))
      .set(idem())
      .send({ unitId: ids.u1, kind: 'medical' })
      .expect(201);
    expect(second.body).toMatchObject({ id: ids.sos, existing: true });
    await t.http
      .post('/v1/resident/sos')
      .set(R('R'))
      .set(idem())
      .send({ unitId: ids.u1, kind: 'fire' })
      .expect(404);
    await t.http
      .post('/v1/resident/sos')
      .set(R('B'))
      .set(idem())
      .send({ unitId: ids.u1, kind: 'fire' })
      .expect(404);
    await settle();
    // office notified urgently (in-app + LINE), the gate stream got the event
    const office = await notified('gate.incident.raised', ids.sos);
    expect(office.length).toBeGreaterThanOrEqual(1);
    const ev = await one<{ type: string; payload: { gateIds: string[] } }>(
      `SELECT type, payload FROM platform.domain_event WHERE type = 'gate.incident.raised' AND aggregate_id = $1`,
      [ids.sos],
    );
    expect(ev.payload.gateIds).toEqual([ids.gate]);
    // the gate sees it, acknowledges; the resident is told
    const active = await t.http.get('/v1/guard/incidents').set(G()).expect(200);
    expect((active.body as { id: string }[]).map((i) => i.id)).toContain(ids.sos);
    await t.http.get(`/v1/guard/incidents/${ids.sos}`).set(bearer(guard2)).expect(404);
    const ack = await t.http
      .post(`/v1/guard/incidents/${ids.sos}/actions/acknowledge`)
      .set(G())
      .send({})
      .expect(200);
    expect(ack.body.state).toBe('acknowledged');
    await t.http.post(`/v1/guard/incidents/${ids.sos}/actions/acknowledge`).set(G()).send({}).expect(200); // idempotent
    await settle();
    expect((await notified('gate.incident.acknowledged', ids.sos)).map((n) => n.recipient_id)).toContain(
      ids.userP,
    );
    const mine = await t.http.get(`/v1/resident/sos/${ids.sos}`).set(R('P')).expect(200);
    expect(mine.body).toMatchObject({ state: 'acknowledged' });
    expect(mine.body.acknowledgedAt).toBeTruthy();
    await t.http.get(`/v1/resident/sos/${ids.sos}`).set(R('R')).expect(404);
    // the owner log needs a reason (audited) and links the visits; another tenant 404
    await t.http.get('/v1/owner/incidents').set(J()).expect(422);
    const log = await t.http.get('/v1/owner/incidents?reason=ตรวจสอบเหตุ SOS').set(J()).expect(200);
    expect((log.body.data as { id: string }[]).map((i) => i.id)).toContain(ids.sos);
    const detail = await t.http
      .get(`/v1/owner/incidents/${ids.sos}?reason=ตรวจสอบเหตุ SOS`)
      .set(J())
      .expect(200);
    expect((detail.body.visits as { id: string }[]).map((v) => v.id)).toEqual(
      expect.arrayContaining([inside.id, ids.visitCar]),
    );
    expect((detail.body.events as { kind: string }[]).map((e) => e.kind)).toEqual(['raised', 'acknowledged']);
    await t.http
      .get(`/v1/owner/incidents/${ids.sos}?reason=ตรวจสอบเหตุ SOS`)
      .set(bearer(jur2.token))
      .expect(404);
    expect((await q(`SELECT 1 FROM platform.audit_log WHERE action = 'gate.incident_log_read'`)).length).toBe(
      2,
    );
    await t.http
      .post(`/v1/guard/incidents/${ids.sos}/actions/resolve`)
      .set(G())
      .send({ note: 'รถพยาบาลมาแล้ว' })
      .expect(200);
    // the resident cancels a mistaken SOS within 30 s; not after
    const mistake = await t.http
      .post('/v1/resident/sos')
      .set(R('R'))
      .set(idem())
      .send({ unitId: ids.u2, kind: 'fire' })
      .expect(201);
    t.clock.advance(10_000);
    const cancelled = await t.http
      .post(`/v1/resident/sos/${mistake.body.id}/actions/cancel`)
      .set(R('R'))
      .send({ reason: 'กดผิด' })
      .expect(200);
    expect(cancelled.body.state).toBe('cancelled');
    const late = await t.http
      .post('/v1/resident/sos')
      .set(R('R'))
      .set(idem())
      .send({ unitId: ids.u2, kind: 'other' })
      .expect(201);
    t.clock.advance(31_000);
    expect(
      (await t.http.post(`/v1/resident/sos/${late.body.id}/actions/cancel`).set(R('R')).send({}).expect(409))
        .body.code,
    ).toBe('incident.cancel_window_passed');
    // the tablet's own SOS button
    const fromGate = await t.http
      .post('/v1/guard/incidents')
      .set(G())
      .set(idem())
      .send({ kind: 'intrusion', note: 'มีคนปีนรั้ว' })
      .expect(201);
    expect(fromGate.body).toMatchObject({ source: 'guard', gate: { id: ids.gate } });
  });

  it('abuse guard: more SOS than gate.sos.max_per_hour in an hour → 429', async () => {
    // earlier SOS of R are more than an hour old (backdated: access tokens live 15 min of the fake clock)
    await q(
      `UPDATE smart.incident SET created_at = created_at - interval '2 hours',
              state = CASE WHEN state IN ('open', 'acknowledged') THEN 'resolved' ELSE state END,
              acknowledged_at = CASE WHEN state IN ('open', 'acknowledged') THEN COALESCE(acknowledged_at, now()) ELSE acknowledged_at END,
              resolved_at = CASE WHEN state IN ('open', 'acknowledged') THEN now() ELSE resolved_at END
        WHERE raised_by_user_id = $1`,
      [ids.userR],
    );
    for (let i = 0; i < 5; i += 1) {
      const r = await t.http
        .post('/v1/resident/sos')
        .set(R('R'))
        .set(idem())
        .send({ unitId: ids.u2, kind: 'other' })
        .expect(201);
      const c = await t.http.post(`/v1/resident/sos/${r.body.id}/actions/cancel`).set(R('R')).send({});
      expect(c.status).toBe(200);
    }
    expect(
      (await t.http.post('/v1/resident/sos').set(R('R')).set(idem()).send({ unitId: ids.u2, kind: 'other' }))
        .status,
    ).toBe(429);
  });

  it('detaching the camera refuses its reads; retention removes a car whose owner left and deletes old reads', async () => {
    await t.http
      .post(`/v1/owner/gates/${ids.gate}/edge-devices/${ids.lpr}/actions/detach`)
      .set(J())
      .set(idem())
      .send({ reason: 'ถอดกล้องซ่อม' })
      .expect(200);
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM smart.plate_detection`);
    t.clock.advance(120_000);
    await plate(ids.gw, ids.gate, { category: 'ขข', number: '42', province: BKK });
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM smart.plate_detection`)).n).toBe(n.n);
    expect((await t.http.get(`/v1/owner/gates/${ids.gate}`).set(J()).expect(200)).body.lpr).toBe(false);
    // P sells A-101: the car he registered is removed by the retention job
    await q(`UPDATE core.unit_ownership SET valid_to = '2027-01-11' WHERE unit_id = $1`, [ids.u1]);
    t.clock.advanceDays(100);
    await t.app.get(GateRetentionService).run();
    const car = await one<{ removed_at: Date | null; remove_reason: string | null }>(
      `SELECT removed_at, remove_reason FROM smart.resident_vehicle WHERE id = $1`,
      [ids.carP],
    );
    expect(car.remove_reason).toBe('resident_left');
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM smart.plate_detection`)).n).toBe(0);
  });
});

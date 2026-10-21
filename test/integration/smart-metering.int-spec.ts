import 'reflect-metadata';

import { createHash, generateKeyPairSync, randomBytes, sign, webcrypto } from 'node:crypto';

import { AppConfig } from '@config/app-config';
import { fakeLineIdToken } from '@integrations/line/fake-line-login';
import { MQTT_CLIENT, type MqttClientPort } from '@integrations/mqtt/mqtt-client.port';
import { OBJECT_STORAGE, type ObjectStorage } from '@integrations/s3/object-storage.port';
import { IngestService } from '@modules/ingest/ingest.service';
import { IngestSubscriber } from '@modules/ingest/ingest.subscriber';
import { GatewayConfigService } from '@modules/smart-devices/gateway-config.service';
import { canonicalManifest } from '@modules/smart-devices/ota.service';
import { MeterHealthService } from '@modules/smart-health/meter-health.service';
import { IngestPipeline } from '@modules/smart-ingest/ingest-pipeline.service';
import { TelemetryMaintenanceService } from '@modules/smart-ingest/telemetry-maintenance.service';
import * as x509 from '@peculiar/x509';
import Decimal from 'decimal.js';
import { connectAsync, type MqttClient } from 'mqtt';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { uploadFile } from '../support/int-files';
import { startTestBroker, type TestBroker } from '../support/mqtt-broker';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

async function provisioningCsr(): Promise<string> {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=gw-provisioning',
    keys,
    signingAlgorithm: alg,
  });
  return csr.toString('pem');
}

async function waitFor<T>(probe: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (done(v) || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const OTA_KEYS = generateKeyPairSync('ed25519');
const OTA_PUBLIC = OTA_KEYS.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

const strip = (doc: unknown, ids: Record<string, string>): unknown =>
  JSON.parse(
    Object.entries(ids).reduce((json, [id, label]) => json.split(id).join(label), JSON.stringify(doc)),
  ) as unknown;

/**
 * B3 acceptance against real PostgreSQL and a real MQTT broker (aedes in a child process; EMQX in production):
 * 3.1 provision → install → config v1 → health → swap → config v2 · tenant isolation · fleet inventory;
 * 3.2 1,000 readings over 2 gateways with 10 % duplicates → 900 points · unbound meter refused and audited · LWT ·
 * series · HTTPS batch; 3.3 IoT promotion, staff reading → review → correction, reading round; 3.4 meter health.
 */
describe('smart metering B3 (real PostgreSQL + MQTT broker)', () => {
  let broker: TestBroker;
  let db: IntDatabase;
  let t: IntApp;
  let ingest: IngestSubscriber;
  let gw: MqttClient;
  let admin: string;
  let staff: string;
  let owner: string;
  const meters: Record<string, string> = {};
  let gw1 = '';
  let gw2 = '';
  let deviceToken = '';
  const meterDevices: Record<string, string> = {};
  let photo = '';

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];

  beforeAll(async () => {
    broker = await startTestBroker();
    db = await createIntDatabase({ prefix: 'gp_smart' });
    t = await createIntApp(db, {
      OTP_MAX_PER_HOUR: '20',
      MQTT_MODE: 'real',
      MQTT_URL: broker.url,
      MQTT_PROTOCOL_VERSION: '4',
      MQTT_SHARED_SUBSCRIPTION: 'false',
      OTA_SIGNING_PUBLIC_KEYS: JSON.stringify({ 'gp-ota-test': OTA_PUBLIC }),
    });
    ingest = new IngestSubscriber(
      t.app.get(AppConfig),
      t.app.get(IngestService),
      t.app.get(IngestPipeline),
      t.app.get<MqttClientPort>(MQTT_CLIENT),
    );
    await ingest.onApplicationBootstrap();
    gw = await connectAsync(broker.url, { protocolVersion: 4, clientId: 'test-gateway', clean: true });
    admin = await adminToken(t);
    owner = await ownerToken(t);
    staff = await operatorToken(t, '+660000000003');
    for (const row of await q<{ id: string; key: string }>(
      `SELECT a.id, u.unit_no || ':' || a.category AS key FROM core.asset_item a JOIN core.unit u ON u.id = a.unit_id
        WHERE a.building_id = $1`,
      [DEV.buildingId],
    ))
      meters[row.key] = row.id;
    photo = await uploadFile(t, db, staff, {
      kind: 'meter_photo',
      scopeType: 'building',
      scopeId: DEV.buildingId,
      fileName: 'meter.jpg',
      mimeType: 'image/jpeg',
      body: Buffer.from('fake-jpeg-meter-photo'),
      surface: 'staff',
    });
  }, 120_000);

  afterAll(async () => {
    ingest?.onApplicationShutdown();
    await gw?.endAsync().catch(() => undefined);
    await t?.close();
    await db?.drop();
    await broker?.stop();
  });

  const install = async (
    gateway: string,
    unitNo: string,
    serial: string,
    address: number,
    register: string,
  ) => {
    const res = await t.http
      .post('/v1/staff/devices/actions/install')
      .set(bearer(staff))
      .set(idem())
      .send({
        meterAssetItemId: meters[`${unitNo}:meter_electric`],
        gatewayDeviceId: gateway,
        meterDevice: { serial, model: 'SDM120', vendor: 'Eastron', driver: 'sdm120' },
        wiring: { busId: 'rs485-1', busType: 'modbus_rtu', address },
        installRegister: register,
        photoDocumentId: photo,
        installedAt: '2026-10-05T00:00:00+07:00',
      });
    expect(res.status).toBe(201);
    return res.body as { device: { id: string }; channelId: string; readingId: string };
  };

  // ------------------------------------------------------------------------------------------------ 3.1

  it('3.1 provision (fake CSR) → install 2 meters → config v1 → health v1 → swap → config v2, no gap/overlap', async () => {
    const created = await t.http
      .post('/v1/admin/devices')
      .set(bearer(admin))
      .set(idem())
      .send({
        serial: 'GP-GW-B3-0001',
        kind: 'gateway',
        model: 'rpi-cm4',
        vendor: 'Collective',
        ownership: 'platform_haas',
        tenantId: DEV.tenantId,
        buildingId: DEV.buildingId,
      })
      .expect(201);
    gw1 = created.body.id;

    // staff scans the gateway QR on site → single-use code → the agent bootstraps with a CN=gw-provisioning CSR
    // review #13: provisioning is irreversible (it voids the unused code) → Idempotency-Key required, replayed once
    const provision = { serial: 'GP-GW-B3-0001', buildingId: DEV.buildingId };
    const missing = await t.http
      .post('/v1/staff/devices/actions/provision')
      .set(bearer(staff))
      .send(provision)
      .expect(400);
    expect(missing.body.code).toBe('idempotency.key_required');
    const key = idem();
    const code = await t.http
      .post('/v1/staff/devices/actions/provision')
      .set(bearer(staff))
      .set(key)
      .send(provision)
      .expect(200);
    const replay = await t.http
      .post('/v1/staff/devices/actions/provision')
      .set(bearer(staff))
      .set(key)
      .send(provision)
      .expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.code).toBe(code.body.code);
    const boot = await t.http
      .post('/v1/device/bootstrap')
      .send({
        provisioningCode: code.body.code,
        csrPem: await provisioningCsr(),
        agentVersion: '0.3.0',
        hardware: { arch: 'arm64', hostname: 'gw-b3-01' },
      })
      .expect(201);
    expect(boot.body.gatewayId).toBe(gw1);
    deviceToken = boot.body.deviceToken.accessToken;

    const retained: unknown[] = [];
    gw.on('message', (topic, payload) => {
      if (topic === `gp/v1/${gw1}/config`) retained.push(JSON.parse(payload.toString('utf8')));
    });
    await gw.subscribeAsync(`gp/v1/${gw1}/config`, { qos: 1 });

    const a = await install(gw1, 'A-101', 'SDM120-0001', 1, '100.000');
    const b = await install(gw1, 'A-102', 'SDM120-0002', 2, '200.000');
    meterDevices['A-101'] = a.device.id;
    meterDevices['A-102-old'] = b.device.id;
    // one meter per bus address of a gateway, and one channel per meter
    for (const [unitNo, address] of [
      ['A-103', 1],
      ['A-101', 9],
    ] as const) {
      const clash = await t.http
        .post('/v1/staff/devices/actions/install')
        .set(bearer(staff))
        .set(idem())
        .send({
          meterAssetItemId: meters[`${unitNo}:meter_electric`],
          gatewayDeviceId: gw1,
          meterDevice: {
            serial: `SDM120-CLASH-${address}`,
            model: 'SDM120',
            vendor: 'Eastron',
            driver: 'sdm120',
          },
          wiring: { busId: 'rs485-1', busType: 'modbus_rtu', address },
          installRegister: '300.000',
          photoDocumentId: photo,
          installedAt: '2026-10-05T00:00:00+07:00',
        });
      expect([clash.status, clash.body.code]).toEqual([409, 'meter.channel_exists']);
    }
    // the install register is the first reading of the channel (manual, is_install, photo)
    const installs = await q<{
      register: string;
      source: string;
      is_install: boolean;
      evidence_document_id: string;
    }>(
      `SELECT register::text, source::text, is_install, evidence_document_id::text FROM smart.meter_reading WHERE id = ANY($1::uuid[])`,
      [[a.readingId, b.readingId]],
    );
    expect(installs).toEqual(
      expect.arrayContaining([
        { register: '100.000', source: 'manual', is_install: true, evidence_document_id: photo },
        { register: '200.000', source: 'manual', is_install: true, evidence_document_id: photo },
      ]),
    );

    await t.worker.tick();
    const v1 = await q<{ version: number; document: unknown; published_at: Date | null }>(
      `SELECT version, document, published_at FROM smart.gateway_config WHERE gateway_device_id = $1 ORDER BY version`,
      [gw1],
    );
    expect(v1.map((r) => r.version)).toEqual([1]);
    expect(v1[0]!.published_at).not.toBeNull();
    expect(
      strip(v1[0]!.document, { [a.device.id]: '<meter-A-101>', [b.device.id]: '<meter-A-102>' }),
    ).toEqual({
      buses: [{ baud: 9600, device: '/dev/ttyUSB0', id: 'rs485-1', parity: 'none', type: 'modbus_rtu' }],
      heartbeatS: 60,
      meters: [
        {
          address: 1,
          bus: 'rs485-1',
          driver: 'sdm120',
          meterId: '<meter-A-101>',
          registerMap: 'driver_default',
          roomCode: 'A-101',
          scale: '1',
          unit: 'kwh',
        },
        {
          address: 2,
          bus: 'rs485-1',
          driver: 'sdm120',
          meterId: '<meter-A-102>',
          registerMap: 'driver_default',
          roomCode: 'A-102',
          scale: '1',
          unit: 'kwh',
        },
      ],
      pollIntervalS: 900,
      version: 1,
    });
    // published retained on MQTT and served over HTTPS for a cold start
    await waitFor(
      () => Promise.resolve(retained.length),
      (n) => n > 0,
      10_000,
    );
    expect((retained.at(-1) as { version: number }).version).toBe(1);
    const cold = await t.http.get('/v1/device/config').set(bearer(deviceToken)).expect(200);
    expect(cold.body.version).toBe(1);

    // health reports v1 → applied
    await gw.publishAsync(
      `gp/v1/${gw1}/health`,
      JSON.stringify({
        gatewayId: gw1,
        agentVersion: '0.3.0',
        configVersion: 1,
        uptimeS: 120,
        bufferedReadings: 0,
        diskFreeMb: 900,
        cpuPct: 5,
        memPct: 30,
        link: 'ethernet',
        rssi: null,
        meters: [],
      }),
      { qos: 1 },
    );
    const applied = await waitFor(
      () =>
        q<{ config_applied_version: number | null; status: string }>(
          `SELECT config_applied_version, status::text FROM smart.device WHERE id = $1`,
          [gw1],
        ),
      (rows) => rows[0]?.config_applied_version === 1,
    );
    expect(applied[0]).toEqual({ config_applied_version: 1, status: 'online' });

    // swap the A-102 meter: final + initial registers with photos, new device on the same channel wiring
    const swap = await t.http
      .post('/v1/staff/devices/actions/swap')
      .set(bearer(staff))
      .set(idem())
      .send({
        meterAssetItemId: meters['A-102:meter_electric'],
        oldFinalRegister: '230.500',
        oldPhotoDocumentId: photo,
        newMeter: { serial: 'NEW-A102', manufacturer: 'Eastron', model: 'SDM120' },
        newMeterDevice: { serial: 'SDM120-0003', model: 'SDM120', vendor: 'Eastron', driver: 'sdm120' },
        newInitialRegister: '0.000',
        newPhotoDocumentId: photo,
        reason: 'display broken',
        swappedAt: '2026-10-06T12:00:00+07:00',
      })
      .expect(200);
    meterDevices['A-102'] = swap.body.newDeviceId;
    meters['A-102:new'] = swap.body.newAssetItemId;
    await t.worker.tick();
    const versions = await q<{ version: number; document: { meters: { meterId: string }[] } }>(
      `SELECT version, document FROM smart.gateway_config WHERE gateway_device_id = $1 ORDER BY version`,
      [gw1],
    );
    expect(versions.map((r) => r.version)).toEqual([1, 2]);
    expect(versions[1]!.document.meters.map((m) => m.meterId).sort()).toEqual(
      [a.device.id, swap.body.newDeviceId].sort(),
    );
    const assignments = await q<{
      valid_from: Date;
      valid_to: Date | null;
      final_reading: string | null;
      initial_reading: string;
    }>(
      `SELECT valid_from, valid_to, final_reading::text, initial_reading::text FROM core.meter_assignment
        WHERE id = ANY($1::uuid[]) ORDER BY valid_from`,
      [[swap.body.oldAssignmentId, swap.body.newAssignmentId]],
    );
    expect(assignments).toHaveLength(2);
    expect(assignments[0]!.valid_to!.getTime()).toBe(assignments[1]!.valid_from.getTime()); // no gap, no overlap
    expect(assignments[0]!.final_reading).toBe('230.500');
    expect(assignments[1]!.initial_reading).toBe('0.000');
    // the owner sees the history of the unit continuous across the swap
    const history = await t.http
      .get(
        `/v1/owner/units/${(await q<{ id: string }>(`SELECT id FROM core.unit WHERE building_id = $1 AND unit_no = 'A-102'`, [DEV.buildingId]))[0]!.id}/meter-history?utility=electric`,
      )
      .set(bearer(owner))
      .expect(200);
    expect(history.body.assignments).toHaveLength(2);
    expect(history.body.swaps).toHaveLength(1);
  });

  it('a gateway config whose after-commit publish was lost is published by the sweep (review #11, D-225)', async () => {
    const latest = (
      await q<{ id: string }>(
        `SELECT id FROM smart.gateway_config WHERE gateway_device_id = $1 ORDER BY version DESC LIMIT 1`,
        [gw1],
      )
    )[0]!.id;
    await q(`UPDATE smart.gateway_config SET published_at = NULL, compiled_at = $2 WHERE id = $1`, [
      latest,
      new Date(t.clock.now().getTime() - 2 * 60_000),
    ]);
    const configs = t.app.get(GatewayConfigService);
    expect(await configs.publishPending()).toBe(1);
    const row = (
      await q<{ published_at: Date | null }>('SELECT published_at FROM smart.gateway_config WHERE id = $1', [
        latest,
      ])
    )[0]!;
    expect(row.published_at).not.toBeNull();
    expect(await configs.publishPending()).toBe(0);
  });

  it('3.1 tenant isolation (404 + RLS) and the fleet view counts inventory devices', async () => {
    const other = await onboardTenant(t, admin, { slug: 'smart-other', phone: '+660000000777' });
    await t.http.get(`/v1/owner/devices/${gw1}`).set(bearer(other.token)).expect(404);
    await t.http
      .post(`/v1/owner/devices/${gw1}/commands`)
      .set(bearer(other.token))
      .send({ type: 'identify' })
      .expect(404);
    const list = await t.http.get('/v1/owner/devices').set(bearer(other.token)).expect(200);
    expect(list.body.meta.total).toBe(0);
    await t.http
      .get(`/v1/owner/meters/${meters['A-101:meter_electric']}/readings`)
      .set(bearer(other.token))
      .expect(404);
    await t.http
      .get(
        `/v1/owner/meters/${meters['A-101:meter_electric']}/series?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`,
      )
      .set(bearer(other.token))
      .expect(404);
    await t.http
      .get(`/v1/owner/buildings/${DEV.buildingId}/utility-invoices`)
      .set(bearer(other.token))
      .expect(404);
    const B = bearer(other.token);
    await t.http.get(`/v1/owner/devices/${gw1}/commands`).set(B).expect(404);
    await t.http
      .post('/v1/owner/devices/actions/provision')
      .set(B)
      .set(idem())
      .send({ serial: 'GP-GW-B3-0001', buildingId: DEV.buildingId })
      .expect(404);
    await t.http
      .post('/v1/owner/devices/actions/install')
      .set(B)
      .set(idem())
      .send({
        meterAssetItemId: meters['A-103:meter_water'],
        gatewayDeviceId: gw1,
        meterDevice: { serial: 'X-1', model: 'M', vendor: 'V', driver: 'pulse' },
        wiring: { busId: 'gpio', busType: 'gpio', pin: 4, litresPerPulse: 10 },
        installRegister: '1.000',
        photoDocumentId: photo,
      })
      .expect(404);
    await t.http
      .post('/v1/owner/devices/actions/remove')
      .set(B)
      .set(idem())
      .send({
        meterAssetItemId: meters['A-101:meter_electric'],
        register: '1.000',
        photoDocumentId: photo,
        reason: 'test',
      })
      .expect(404);
    await t.http
      .post('/v1/owner/meter-readings')
      .set(B)
      .set(idem())
      .send({ assetItemId: meters['A-103:meter_water'], typedValue: '1.000' })
      .expect(404);
    await t.http.get(`/v1/owner/reading-rounds/current?buildingId=${DEV.buildingId}`).set(B).expect(404);
    await t.http
      .get(
        `/v1/owner/buildings/${DEV.buildingId}/meter-readings/export?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`,
      )
      .set(B)
      .expect(404);
    expect((await t.http.get('/v1/owner/meter-readings/reviews').set(B).expect(200)).body.meta.total).toBe(0);
    // operator surfaces need an operator token; the admin zone needs a platform token
    await t.http.get('/v1/admin/devices').set(B).expect(403);
    await t.http.get('/v1/owner/devices').set(bearer(admin)).expect(403);
    // RLS: the application role sees nothing of another tenant
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE gp_app');
      await db.admin.query(`SELECT set_config('app.tenant_id', $1, true)`, [other.tenantId]);
      for (const table of [
        'smart.device',
        'smart.meter_channel',
        'smart.gateway_config',
        'smart.meter_reading',
        'smart.device_command',
      ]) {
        const seen = await db.admin.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect([table, seen.rows[0].n]).toEqual([table, 0]);
      }
    } finally {
      await db.admin.query('ROLLBACK');
    }
    // the owner of DEV sees its devices
    const mine = await t.http.get('/v1/owner/devices?kind=gateway').set(bearer(owner)).expect(200);
    expect((mine.body.data as { id: string }[]).map((d) => d.id)).toContain(gw1);

    const imported = await t.http
      .post('/v1/admin/devices/actions/import')
      .set(bearer(admin))
      .set(idem())
      .send({
        csv: 'serial,kind,model,vendor\nINV-E-1,electric_meter,SDM120,Eastron\nINV-E-2,electric_meter,SDM120,Eastron\nINV-W-1,water_meter,PULSE,Generic\n',
      })
      .expect(200);
    expect(imported.body).toEqual({ created: 3, skipped: [], errors: [] });
    const again = await t.http
      .post('/v1/admin/devices/actions/import')
      .set(bearer(admin))
      .set(idem())
      .send({ csv: 'serial,kind,model,vendor\nINV-E-1,electric_meter,SDM120,Eastron\n' })
      .expect(200);
    expect(again.body.skipped).toEqual([{ line: 2, serial: 'INV-E-1', reason: 'exists' }]);
    const fleet = await t.http.get('/v1/admin/devices/fleet').set(bearer(admin)).expect(200);
    const inv = Object.fromEntries(
      (fleet.body.inventory as { kind: string; count: number }[]).map((r) => [r.kind, r.count]),
    );
    expect(inv.electric_meter).toBe(2);
    expect(inv.water_meter).toBe(1);
    expect(
      (fleet.body.byBuilding as { buildingId: string; kind: string; count: number }[]).some(
        (r) => r.buildingId === DEV.buildingId && r.kind === 'gateway',
      ),
    ).toBe(true);
    const inventory = await t.http.get('/v1/admin/devices?inventory=true').set(bearer(admin)).expect(200);
    expect(inventory.body.meta.total).toBe(3);
  });

  it('3.1 commands: operator command queued, published, acknowledged', async () => {
    const cmds: string[] = [];
    gw.on('message', (topic, payload) => {
      if (topic === `gp/v1/${gw1}/cmd`) cmds.push(payload.toString('utf8'));
    });
    await gw.subscribeAsync(`gp/v1/${gw1}/cmd`, { qos: 1 });
    const sent = await t.http
      .post(`/v1/staff/devices/${gw1}/commands`)
      .set(bearer(staff))
      .send({ type: 'identify', args: { seconds: 10 } })
      .expect(202);
    expect(sent.body).toMatchObject({ type: 'identify', status: 'queued', args: { seconds: 10 } });
    await t.http
      .post(`/v1/owner/devices/${gw1}/commands`)
      .set(bearer(owner))
      .send({ type: 'ota_apply' })
      .expect(422);
    await t.worker.tick();
    await waitFor(
      () => Promise.resolve(cmds.length),
      (n) => n > 0,
      10_000,
    );
    const command = JSON.parse(cmds[0]!) as { cmdId: string; type: string };
    expect(command).toMatchObject({ cmdId: sent.body.id, type: 'identify', args: { seconds: 10 } });
    await gw.publishAsync(
      `gp/v1/${gw1}/cmd/ack`,
      JSON.stringify({
        cmdId: command.cmdId,
        status: 'done',
        result: { blinked: true },
        error: null,
        finishedAt: new Date().toISOString(),
      }),
      { qos: 1 },
    );
    const done = await waitFor(
      async () =>
        (await t.http.get(`/v1/owner/devices/${gw1}/commands`).set(bearer(owner))).body as {
          status: string;
        }[],
      (rows) => rows[0]?.status === 'done',
    );
    expect(done[0]!.status).toBe('done');
  });

  it('3.1 OTA: signed release → ring order → canary rollout → ota_apply → manifest → artefact → applied → completed', async () => {
    // D-231: the artefact lives in the product bucket under releases/edge/ and is served on the device surface
    const binary = randomBytes(4096);
    const file = 'getproperty-edge-0.4.0-linux-arm64';
    const unsigned = {
      schema: 1,
      version: '0.4.0',
      channel: 'stable',
      arch: 'arm64',
      artifact: {
        url: `https://device.getproperty.invalid/v1/device/ota/artifacts/0.4.0/${file}`,
        sha256: createHash('sha256').update(binary).digest('hex'),
        size: binary.length,
      },
      minAgentVersion: '0.3.0',
      releasedAt: '2026-10-15T09:00:00Z',
    };
    const manifest = {
      ...unsigned,
      signature: {
        alg: 'ed25519',
        keyId: 'gp-ota-test',
        value: sign(null, Buffer.from(canonicalManifest(unsigned as never)), OTA_KEYS.privateKey).toString(
          'base64',
        ),
      },
    };
    const forged = await t.http
      .post('/v1/admin/ota/releases')
      .set(bearer(admin))
      .set(idem())
      .send({ manifest: { ...manifest, version: '0.4.1' } })
      .expect(422);
    expect(forged.body.code).toBe('ota.signature_invalid');
    // not uploaded yet → refused; the wrong size → refused
    const storage = t.app.get<ObjectStorage>(OBJECT_STORAGE);
    const missing = await t.http
      .post('/v1/admin/ota/releases')
      .set(bearer(admin))
      .set(idem())
      .send({ manifest })
      .expect(422);
    expect(missing.body.code).toBe('ota.artifact_missing');
    await storage.put(`releases/edge/0.4.0/${file}`, binary.subarray(0, 100), 'application/octet-stream');
    await t.http.post('/v1/admin/ota/releases').set(bearer(admin)).set(idem()).send({ manifest }).expect(422);
    await storage.put(`releases/edge/0.4.0/${file}`, binary, 'application/octet-stream');
    const release = await t.http
      .post('/v1/admin/ota/releases')
      .set(bearer(admin))
      .set(idem())
      .send({ manifest, notes: 'test' })
      .expect(201);
    await t.http.post('/v1/admin/ota/releases').set(bearer(admin)).set(idem()).send({ manifest }).expect(409);
    const early = await t.http
      .post(`/v1/admin/ota/releases/${release.body.id}/rollouts`)
      .set(bearer(admin))
      .set(idem())
      .send({ ring: 'pilot' })
      .expect(409);
    expect(early.body.code).toBe('ota.ring_order');
    await t.http
      .post(`/v1/admin/devices/${gw1}/actions/set-ring`)
      .set(bearer(admin))
      .send({ otaRing: 'canary' })
      .expect(200);
    const rollout = await t.http
      .post(`/v1/admin/ota/releases/${release.body.id}/rollouts`)
      .set(bearer(admin))
      .set(idem())
      .send({ ring: 'canary', maxFailuresPct: '50' })
      .expect(201);
    expect(rollout.body).toMatchObject({ status: 'planned', nextActions: ['start', 'abort'] });
    const started = await t.http
      .post(`/v1/admin/ota/rollouts/${rollout.body.id}/actions/start`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    expect(started.body.devices).toEqual([
      expect.objectContaining({ deviceId: gw1, status: 'commanded', fromVersion: '0.3.0' }),
    ]);
    const command = await q<{ type: string; args: { manifestUrl: string } }>(
      `SELECT type::text, args FROM smart.device_command WHERE gateway_device_id = $1 AND type = 'ota_apply'`,
      [gw1],
    );
    // edge CR-012: relative (DEVICE_PUBLIC_BASE_URL unset), never on PUBLIC_API_BASE_URL
    expect(command[0]!.args.manifestUrl).toBe(`/v1/device/ota/manifest?releaseId=${release.body.id}`);
    const served = await t.http.get(command[0]!.args.manifestUrl).set(bearer(deviceToken)).expect(200);
    expect(served.body).toEqual(manifest);
    const artefact = await t.http
      .get(new URL(manifest.artifact.url).pathname)
      .set(bearer(deviceToken))
      .buffer(true)
      .parse((res, done) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => done(null, Buffer.concat(parts)));
      })
      .expect(200);
    expect(artefact.headers['content-type']).toBe('application/octet-stream');
    expect(artefact.headers['content-length']).toBe(String(binary.length));
    expect(artefact.headers.etag).toBe(`"${manifest.artifact.sha256}"`);
    expect(Buffer.compare(artefact.body as Buffer, binary)).toBe(0);
    // only registered artefacts of a release, only to devices
    await t.http
      .get('/v1/device/ota/artifacts/0.4.0/getproperty-edge-0.4.0-linux-x64')
      .set(bearer(deviceToken))
      .expect(404);
    await t.http.get('/v1/device/ota/artifacts/0.9.9/x').set(bearer(deviceToken)).expect(404);
    await t.http.get(new URL(manifest.artifact.url).pathname).expect(401);
    await t.http.get(new URL(manifest.artifact.url).pathname).set(bearer(owner)).expect(403); // another audience
    for (const type of ['ota_started', 'ota_applied'])
      await gw.publishAsync(
        `gp/v1/${gw1}/events`,
        JSON.stringify({
          eventId: (await q<{ id: string }>(`SELECT uuidv7()::text AS id`))[0]!.id,
          gatewayId: gw1,
          type,
          severity: 'info',
          occurredAt: new Date().toISOString(),
          data: { version: '0.4.0' },
        }),
        { qos: 1 },
      );
    const done = await waitFor(
      async () =>
        (await t.http.get(`/v1/admin/ota/rollouts/${rollout.body.id}`).set(bearer(admin)).expect(200))
          .body as { status: string },
      (r) => r.status === 'completed',
    );
    expect(done).toMatchObject({ status: 'completed', counts: { applied: 1 }, nextActions: [] });
    const firmware = await q<{ firmware_version: string }>(
      `SELECT firmware_version FROM smart.device WHERE id = $1`,
      [gw1],
    );
    expect(firmware[0]!.firmware_version).toBe('0.4.0');
    await t.http
      .post(`/v1/admin/ota/rollouts/${rollout.body.id}/actions/pause`)
      .set(bearer(admin))
      .expect(409);
    await t.http.get('/v1/admin/ota/releases').set(bearer(owner)).expect(403);
  });

  // ------------------------------------------------------------------------------------------------ 3.2

  it('3.2 1,000 readings across 2 gateways (one duplicates 10 %) → exactly 900 points; unbound meter refused and audited', async () => {
    const created = await t.http
      .post('/v1/admin/devices')
      .set(bearer(admin))
      .set(idem())
      .send({
        serial: 'GP-GW-B3-0002',
        kind: 'gateway',
        model: 'rpi-cm4',
        vendor: 'Collective',
        ownership: 'platform_haas',
        tenantId: DEV.tenantId,
        buildingId: DEV.buildingId,
      })
      .expect(201);
    gw2 = created.body.id;
    meterDevices['A-103'] = (await install(gw2, 'A-103', 'SDM120-0103', 3, '50.000')).device.id;
    meterDevices['A-104'] = (await install(gw2, 'A-104', 'SDM120-0104', 4, '70.000')).device.id;
    await t.worker.tick();

    const start = Date.parse('2026-10-07T00:00:00+07:00');
    const readingsOf = (meterId: string, base: number, from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        meterId,
        seq: from + i,
        readAt: new Date(start + (from + i) * 900_000).toISOString(),
        register: new Decimal(base).plus(new Decimal(from + i + 1).mul('0.25')).toFixed(3),
        unit: 'kwh',
        quality: 'good',
      }));
    const batch = (gateway: string, readings: unknown[]) =>
      JSON.stringify({ gatewayId: gateway, configVersion: 2, sentAt: new Date().toISOString(), readings });
    const publish = async (gateway: string, all: unknown[]) => {
      for (let i = 0; i < all.length; i += 100)
        await gw.publishAsync(`gp/v1/${gateway}/telemetry`, batch(gateway, all.slice(i, i + 100)), {
          qos: 1,
        });
    };
    // gateway 1: 2 meters × 250 readings, all unique
    await publish(gw1, [
      ...readingsOf(meterDevices['A-101']!, 100, 0, 250),
      ...readingsOf(meterDevices['A-102']!, 0, 0, 250),
    ]);
    // gateway 2: 2 meters × 200 unique + 100 re-sent (10 % of its 500) after a reconnect
    const g2 = [
      ...readingsOf(meterDevices['A-103'], 50, 0, 200),
      ...readingsOf(meterDevices['A-104'], 70, 0, 200),
    ];
    await publish(gw2, g2);
    await publish(gw2, [...g2.slice(150, 200), ...g2.slice(350, 400)]);

    const count = async () =>
      Number((await q<{ n: number }>(`SELECT count(*)::int AS n FROM smart.telemetry_point`))[0]!.n);
    await waitFor(count, (n) => n >= 900, 60_000);
    await new Promise((r) => setTimeout(r, 500));
    await ingest.drain();
    expect(await count()).toBe(900);
    const marks = await q<{ n: number }>(`SELECT count(*)::int AS n FROM smart.ingest_seq_mark`);
    expect(marks[0]!.n).toBe(900);

    // an unbound meter (bound to gateway 1, published by gateway 2) is refused, audited and recorded as an event
    await gw.publishAsync(
      `gp/v1/${gw2}/telemetry`,
      batch(gw2, readingsOf(meterDevices['A-101']!, 100, 999, 1)),
      { qos: 1 },
    );
    const audit = await waitFor(
      () =>
        q<{ action: string; outcome: string; metadata: { meterIds: string[] } }>(
          `SELECT action, outcome::text, metadata FROM platform.audit_log WHERE action = 'ingest.unbound_meter_rejected'`,
        ),
      (rows) => rows.length > 0,
    );
    expect(audit[0]).toMatchObject({ outcome: 'denied', metadata: { meterIds: [meterDevices['A-101']] } });
    expect(await count()).toBe(900);
    const events = await q(
      `SELECT type::text FROM smart.device_event WHERE gateway_device_id = $1 AND type = 'unbound_meter'`,
      [gw2],
    );
    expect(events.length).toBe(1);
  });

  it('3.2 refused payloads become dead letters the admin can replay; oversized batches are refused', async () => {
    await gw.publishAsync(`gp/v1/${gw1}/telemetry`, '{"gatewayId": "not json', { qos: 1 });
    const big = JSON.stringify({
      gatewayId: gw1,
      configVersion: 2,
      sentAt: new Date().toISOString(),
      readings: Array.from({ length: 201 }, (_, i) => ({
        meterId: meterDevices['A-101'],
        seq: 5000 + i,
        readAt: '2026-10-09T00:00:00.000Z',
        register: '200.000',
        unit: 'kwh',
        quality: 'good',
      })),
    });
    await gw.publishAsync(`gp/v1/${gw1}/telemetry`, big, { qos: 1 });
    const letters = await waitFor(
      async () =>
        (await t.http.get('/v1/admin/ingest/dead-letters').set(bearer(admin)).expect(200)).body as {
          data: { id: string; reason: string }[];
        },
      (b) => b.data.length >= 2,
    );
    expect(letters.data.map((d) => d.reason).sort()).toEqual(['batch_too_large', 'malformed_json']);
    const tooBig = await q(
      `SELECT 1 FROM smart.device_event WHERE gateway_device_id = $1 AND type = 'batch_too_large'`,
      [gw1],
    );
    expect(tooBig.length).toBe(1);
    const malformed = letters.data.find((d) => d.reason === 'malformed_json')!;
    const replay = await t.http
      .post(`/v1/admin/ingest/dead-letters/${malformed.id}/actions/replay`)
      .set(bearer(admin))
      .set(idem())
      .expect(200);
    expect(replay.body).toMatchObject({
      outcome: 'dead_letter',
      deadLetter: { replayOutcome: 'refused: malformed_json' },
    });
    await t.http.get('/v1/admin/ingest/dead-letters').set(bearer(owner)).expect(403);
  });

  it('3.2 series endpoint returns bucketed usage from the rollups; resident sees daily usage', async () => {
    await t.app.get(TelemetryMaintenanceService).rollup();
    const id = meters['A-101:meter_electric']!;
    const hourly = await t.http
      .get(
        `/v1/owner/meters/${id}/series?from=2026-10-07T00:00:00%2B07:00&to=2026-10-08T00:00:00%2B07:00&bucket=1h`,
      )
      .set(bearer(owner))
      .expect(200);
    expect(hourly.body.unit).toBe('kwh');
    expect(hourly.body.points).toHaveLength(24);
    // 4 readings per hour × 0.250 kWh; the first bucket starts from the install register
    expect(
      (hourly.body.points as { usage: string; points: number }[])
        .slice(1)
        .every((p) => p.usage === '1.000' && p.points === 4),
    ).toBe(true);
    const daily = await t.http
      .get(
        `/v1/staff/meters/${id}/series?from=2026-10-07T00:00:00%2B07:00&to=2026-10-10T00:00:00%2B07:00&bucket=1d`,
      )
      .set(bearer(staff))
      .expect(200);
    const total = (daily.body.points as { usage: string }[]).reduce(
      (s, p) => s.plus(p.usage),
      new Decimal(0),
    );
    // telemetry-only usage: from the first point (100.250) to the last (162.500); the install reading is not telemetry
    expect(total.toFixed(3)).toBe('62.250');
    await t.http
      .get(`/v1/owner/meters/${id}/series?from=2026-10-01T00:00:00Z&to=2026-12-01T00:00:00Z&bucket=15m`)
      .set(bearer(owner))
      .expect(422);
    // the resident of A-101 (DEV lease) links LINE through an invitation and reads daily usage of the leased unit
    const code = (
      await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(bearer(owner))
        .send({ channel: 'link' })
        .expect(201)
    ).body.code;
    const login = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000b3b301', name: 'ผู้เช่า' }) })
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
    const resident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200)
    ).body.accessToken as string;
    const usage = await t.http
      .get(
        `/v1/resident/leases/${DEV.leaseId}/usage?from=2026-10-07T00:00:00%2B07:00&to=2026-10-10T00:00:00%2B07:00&bucket=1d`,
      )
      .set(bearer(resident))
      .expect(200);
    expect((usage.body.series as { utility: string }[]).map((x) => x.utility)).toEqual(['electric', 'water']);
    const electric = usage.body.series[0] as { unit: string; points: { usage: string }[] };
    expect(electric.unit).toBe('kwh');
    expect(electric.points.reduce((sum, p) => sum.plus(p.usage), new Decimal(0)).toFixed(3)).toBe('62.250');
    // another lease is not mine
    const other = (
      await q<{ id: string }>(`SELECT id FROM ops.lease WHERE id <> $1 LIMIT 1`, [DEV.leaseId])
    )[0];
    if (other) await t.http.get(`/v1/resident/leases/${other.id}/usage`).set(bearer(resident)).expect(404);
    await t.http
      .get(`/v1/resident/leases/${'0199f2a0-0000-7000-8000-00000000ffff'}/usage`)
      .set(bearer(resident))
      .expect(404);
  });

  it('3.2 HTTPS batch fallback shares the pipeline (replays are duplicates)', async () => {
    const replay = {
      gatewayId: gw1,
      configVersion: 2,
      sentAt: new Date().toISOString(),
      readings: [
        {
          meterId: meterDevices['A-101'],
          seq: 0,
          readAt: '2026-10-06T17:00:00.000Z',
          register: '100.250',
          unit: 'kwh',
          quality: 'good',
        },
        {
          meterId: meterDevices['A-101'],
          seq: 250,
          readAt: '2026-10-09T15:30:00.000Z',
          register: '162.750',
          unit: 'kwh',
          quality: 'good',
        },
      ],
    };
    const res = await t.http
      .post('/v1/device/readings/batch')
      .set(bearer(deviceToken))
      .send(replay)
      .expect(200);
    expect(res.body).toEqual({ accepted: 1, duplicates: 1, rejected: [] });
    const again = await t.http
      .post('/v1/device/readings/batch')
      .set(bearer(deviceToken))
      .send(replay)
      .expect(200);
    expect(again.body).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    // another gateway's batch with this token is refused
    await t.http
      .post('/v1/device/readings/batch')
      .set(bearer(deviceToken))
      .send({ ...replay, gatewayId: gw2 })
      .expect(422);
  });

  it('a re-flashed gateway restarting its seqs under a new epoch is not dropped as duplicates (review #4, D-227)', async () => {
    // the gateway lost its state (same promotion bucket as seq 250 above: no extra billing candidate): new seqEpoch, seq restarts at numbers the old state already used
    const reflashed = {
      gatewayId: gw1,
      configVersion: 2,
      sentAt: new Date().toISOString(),
      seqEpoch: '7b1e0c2a-5f44-4d0e-9a51-2f9a3c6d8e10',
      readings: [
        {
          meterId: meterDevices['A-101'],
          seq: 0,
          readAt: '2026-10-09T15:31:00.000Z',
          register: '162.800',
          unit: 'kwh',
          quality: 'good',
        },
        {
          meterId: meterDevices['A-101'],
          seq: 250,
          readAt: '2026-10-09T15:32:00.000Z',
          register: '162.850',
          unit: 'kwh',
          quality: 'good',
        },
      ],
    };
    const res = await t.http
      .post('/v1/device/readings/batch')
      .set(bearer(deviceToken))
      .send(reflashed)
      .expect(200);
    expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
    const points = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM smart.telemetry_point WHERE device_id = $1 AND time IN ('2026-10-09T15:31:00Z', '2026-10-09T15:32:00Z')`,
      [meterDevices['A-101']],
    );
    expect(points[0]!.n).toBe(2);
    // within the new epoch a replay is still a duplicate
    const again = await t.http
      .post('/v1/device/readings/batch')
      .set(bearer(deviceToken))
      .send(reflashed)
      .expect(200);
    expect(again.body).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
    // a malformed epoch is refused like any invalid payload
    await t.http
      .post('/v1/device/readings/batch')
      .set(bearer(deviceToken))
      .send({ ...reflashed, seqEpoch: 'x' })
      .expect(422);
  });

  it('3.2 health: LWT → offline (event + notification), heartbeat → online', async () => {
    await gw.publishAsync(`gp/v1/${gw1}/health`, JSON.stringify({ status: 'offline_lwt' }), { qos: 1 });
    const offline = await waitFor(
      () => q<{ status: string }>(`SELECT status::text FROM smart.device WHERE id = $1`, [gw1]),
      (rows) => rows[0]?.status === 'offline',
    );
    expect(offline[0]!.status).toBe('offline');
    const outbox = await q(
      `SELECT type FROM platform.domain_event WHERE type = 'device.offline' AND aggregate_id = $1`,
      [gw1],
    );
    expect(outbox.length).toBe(1);
    await gw.publishAsync(
      `gp/v1/${gw1}/health`,
      JSON.stringify({
        gatewayId: gw1,
        agentVersion: '0.3.0',
        configVersion: 2,
        uptimeS: 10,
        bufferedReadings: 12,
        diskFreeMb: 900,
        cpuPct: 5,
        memPct: 30,
        link: 'ethernet',
        rssi: null,
        meters: [],
      }),
      { qos: 1 },
    );
    const online = await waitFor(
      () =>
        q<{ status: string; config_applied_version: number }>(
          `SELECT status::text, config_applied_version FROM smart.device WHERE id = $1`,
          [gw1],
        ),
      (rows) => rows[0]?.status === 'online',
    );
    expect(online[0]).toEqual({ status: 'online', config_applied_version: 2 });
    await t.worker.tick();
  });

  // ------------------------------------------------------------------------------------------------ 3.3

  it('3.3 IoT candidates are promoted to accepted readings (one per promotion interval)', async () => {
    await t.worker.tick();
    const rows = await q<{ n: number; min: string; max: string; bad: number }>(
      `SELECT count(*)::int AS n, min(register)::text AS min, max(register)::text AS max,
              count(*) FILTER (WHERE review_state <> 'accepted')::int AS bad
         FROM smart.meter_reading WHERE asset_item_id = $1 AND source = 'iot'`,
      [meters['A-101:meter_electric']],
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(62);
    expect(rows[0]!.n).toBeLessThanOrEqual(64);
    expect(rows[0]!.bad).toBe(0);
    // accepted IoT readings are a monotonic series
    const series = await q<{ register: string }>(
      `SELECT register::text FROM smart.meter_reading WHERE asset_item_id = $1 AND review_state = 'accepted' ORDER BY read_at`,
      [meters['A-101:meter_electric']],
    );
    for (let i = 1; i < series.length; i += 1)
      expect(new Decimal(series[i]!.register).gte(series[i - 1]!.register)).toBe(true);
    const page = await t.http
      .get(`/v1/owner/meters/${meters['A-101:meter_electric']}/readings?perPage=5`)
      .set(bearer(owner))
      .expect(200);
    // the newest came through the HTTPS fallback (seq 250), the others over MQTT
    expect(page.body.data[0]).toMatchObject({
      source: 'iot',
      via: 'https_batch',
      reviewState: 'accepted',
      meterCode: 'A-101-E',
    });
    expect(page.body.data[1]).toMatchObject({ source: 'iot', via: 'mqtt', reviewState: 'accepted' });
  });

  it('3.3 staff reading accepted → out of band → review → corrected (superseded row kept)', async () => {
    const water = meters['A-105:meter_water']!;
    const read = (typedValue: string, readAt: string) =>
      t.http
        .post('/v1/staff/meter-readings')
        .set(bearer(staff))
        .set(idem())
        .send({ assetItemId: water, photoDocumentId: photo, typedValue, readAt });
    expect((await read('10.000', '2026-10-02T09:00:00+07:00')).body).toMatchObject({
      reviewState: 'accepted',
      source: 'manual',
      consumption: '10.000',
    });
    expect((await read('20.000', '2026-10-06T09:00:00+07:00')).body).toMatchObject({
      reviewState: 'accepted',
      consumption: '10.000',
    });
    const odd = await read('500.000', '2026-10-10T09:00:00+07:00');
    expect(odd.status).toBe(201);
    expect(odd.body).toMatchObject({ reviewState: 'pending_review', reviewId: expect.any(String) });
    // a decrease without a swap is never accepted silently
    const lower = await read('5.000', '2026-10-11T09:00:00+07:00');
    expect(lower.body.reviewState).toBe('pending_review');

    const queue = await t.http.get('/v1/owner/meter-readings/reviews').set(bearer(owner)).expect(200);
    const review = (queue.body.data as { id: string; reason: string; reading: { id: string } }[]).find(
      (r) => r.reading.id === odd.body.id,
    )!;
    expect(review.reason).toBe('out_of_band');
    await t.http
      .post(`/v1/owner/meter-readings/reviews/${review.id}/actions/decide`)
      .set(bearer(owner))
      .set(idem())
      .send({ action: 'correct' })
      .expect(422);
    const decided = await t.http
      .post(`/v1/owner/meter-readings/reviews/${review.id}/actions/decide`)
      .set(bearer(owner))
      .set(idem())
      .send({ action: 'correct', register: '30.000', note: 'OCR misread' })
      .expect(200);
    expect(decided.body).toMatchObject({ status: 'corrected', correctedRegister: '30.000', nextActions: [] });
    const rows = await q<{
      id: string;
      register: string;
      review_state: string;
      superseded_by_reading_id: string | null;
    }>(
      `SELECT id, register::text, review_state::text, superseded_by_reading_id FROM smart.meter_reading
        WHERE asset_item_id = $1 AND read_at = '2026-10-10T09:00:00+07:00' ORDER BY created_at`,
      [water],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      register: '500.000',
      review_state: 'corrected',
      superseded_by_reading_id: rows[1]!.id,
    });
    expect(rows[1]).toMatchObject({
      register: '30.000',
      review_state: 'accepted',
      superseded_by_reading_id: null,
    });
    await t.http
      .post(`/v1/owner/meter-readings/reviews/${review.id}/actions/decide`)
      .set(bearer(owner))
      .set(idem())
      .send({ action: 'accept' })
      .expect(409);
    // the decreasing reading is rejected
    const decrease = (
      (await t.http.get('/v1/owner/meter-readings/reviews').set(bearer(owner))).body.data as {
        id: string;
        reason: string;
        reading: { id: string };
      }[]
    ).find((r) => r.reading.id === lower.body.id)!;
    expect(decrease.reason).toBe('decreasing_without_swap');
    await t.http
      .post(`/v1/owner/meter-readings/reviews/${decrease.id}/actions/decide`)
      .set(bearer(owner))
      .set(idem())
      .send({ action: 'reject', note: 'wrong meter photographed' })
      .expect(200);

    // export CSV (audited)
    const csv = await t.http
      .get(
        `/v1/owner/buildings/${DEV.buildingId}/meter-readings/export?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`,
      )
      .set(bearer(owner))
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('A-105-W,water,unit,30.000');
    // a staff photo without a value OCRs to nothing → unreadable
    const unreadable = await t.http.post('/v1/staff/meter-readings').set(bearer(staff)).set(idem()).send({
      assetItemId: meters['A-106:meter_water'],
      photoDocumentId: photo,
      readAt: '2026-10-12T09:00:00+07:00',
    });
    expect(unreadable.status).toBe(422);
    expect(unreadable.body.code).toBe('reading.unreadable');
  });

  it('3.3 the reading round shrinks as readings arrive; 3.4 meter health', async () => {
    t.clock.set(new Date('2026-10-27T03:00:00Z')); // inside the 7-day window before the end-of-month cut-off
    staff = await operatorToken(t, '+660000000003');
    owner = await ownerToken(t);
    const round = async () =>
      (
        await t.http
          .get(`/v1/staff/reading-rounds/current?buildingId=${DEV.buildingId}`)
          .set(bearer(staff))
          .expect(200)
      ).body[0] as {
        remaining: number;
        periodKey: string;
        floors: { items: { assetItemId: string; iot: boolean }[] }[];
      };
    const before = await round();
    expect(before.periodKey).toBe('2026-10');
    const items = before.floors.flatMap((f) => f.items);
    // the 4 IoT meters are not listed while their health is unknown/ok; every manual meter is
    expect(items.some((i) => i.assetItemId === meters['A-101:meter_electric'])).toBe(false);
    expect(items.some((i) => i.assetItemId === meters['A-201:meter_water'])).toBe(true);
    await t.http
      .post('/v1/staff/meter-readings')
      .set(bearer(staff))
      .set(idem())
      .send({ assetItemId: meters['A-201:meter_water'], photoDocumentId: photo, typedValue: '12.000' })
      .expect(201);
    const after = await round();
    expect(after.remaining).toBe(before.remaining - 1);

    // 3.4: no telemetry since 10-09 → the IoT meters are silent (> 3 days); manual meters have no device
    const result = await t.app.get(MeterHealthService).run();
    expect(result.changed).toBeGreaterThan(0);
    const health = await q<{ asset_item_id: string; health: string }>(
      `SELECT asset_item_id, health::text FROM smart.meter_status`,
    );
    const of = (id: string) => health.find((h) => h.asset_item_id === id)?.health;
    expect(of(meters['A-101:meter_electric']!)).toBe('silent');
    expect(of(meters['A-201:meter_water']!)).toBe('no_device');
    const silentEvents = await q(`SELECT 1 FROM platform.domain_event WHERE type = 'meter.silent'`);
    expect(silentEvents.length).toBeGreaterThanOrEqual(3);
    const autoRequests = await q(
      `SELECT 1 FROM platform.domain_event WHERE type = 'service.auto_request_requested'`,
    );
    expect(autoRequests.length).toBe(silentEvents.length);
    await t.worker.tick();
    // silent IoT meters join the round
    const withIot = await round();
    expect(
      withIot.floors
        .flatMap((f) => f.items)
        .some((i) => i.assetItemId === meters['A-101:meter_electric'] && i.iot),
    ).toBe(true);
  });
});

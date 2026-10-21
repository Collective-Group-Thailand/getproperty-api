import 'reflect-metadata';

import { webcrypto } from 'node:crypto';

import * as x509 from '@peculiar/x509';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

async function csrFor(deviceId: string): Promise<string> {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=gw-${deviceId}`,
    keys,
    signingAlgorithm: alg,
  });
  return csr.toString('pem');
}

/** B1.3 acceptance — gateway bootstrap: provisioning code + CSR → certificate from the platform CA, device JWT, EMQX ACL. */
describe('device bootstrap (B1.3 acceptance, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let deviceId: string;
  let code: string;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_device' });
    // MQTT_PUBLIC_WS_URL is set, but `mqtt.wsUrl` goes only to a gateway whose WebSocket fallback is on (D-239)
    t = await createIntApp(db, {
      OTP_MAX_PER_HOUR: '20',
      MQTT_PUBLIC_WS_URL: 'wss://mqtt-ws.test.invalid/mqtt',
      DEVICE_MTLS_SOURCE: 'pem_header',
    });
    const admin = await adminToken(t);
    const device = await t.http
      .post('/v1/admin/devices')
      .set(bearer(admin))
      .set(idem())
      .send({
        serial: 'GP-GW-TEST-0001',
        kind: 'gateway',
        model: 'rpi-cm4',
        vendor: 'Collective',
        ownership: 'platform_haas',
        tenantId: DEV.tenantId,
        buildingId: DEV.buildingId,
      })
      .expect(201);
    deviceId = device.body.id;
    const issued = await t.http
      .post(`/v1/admin/devices/${deviceId}/provisioning-codes`)
      .set(bearer(admin))
      .expect(201);
    code = issued.body.code;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('a CSR with the wrong subject is refused', async () => {
    const res = await t.http
      .post('/v1/device/bootstrap')
      .send({
        serial: 'GP-GW-TEST-0001',
        provisioningCode: code,
        csrPem: await csrFor('00000000-0000-7000-8000-000000000000'),
      })
      .expect(422);
    expect(res.body.code).toBe('device.csr_invalid');
  });

  it('bootstrap → certificate signed by the platform CA → device JWT → EMQX ACL rows', async () => {
    const res = await t.http
      .post('/v1/device/bootstrap')
      .send({ serial: 'GP-GW-TEST-0001', provisioningCode: code, csrPem: await csrFor(deviceId) })
      .expect(201);
    expect(res.body).toMatchObject({
      deviceId,
      tenantId: DEV.tenantId,
      buildingId: DEV.buildingId,
      mqtt: { username: expect.any(String), password: 'device_jwt' },
    });
    expect(res.body.mqtt.wsUrl).toBeUndefined();
    const cert = new x509.X509Certificate(res.body.certificatePem);
    const ca = new x509.X509Certificate(res.body.caCertificatePem);
    expect(cert.subject).toBe(`CN=gw-${deviceId}`);
    expect(await cert.verify({ publicKey: ca.publicKey, signatureOnly: true })).toBe(true);

    const acl = await db.admin.query(
      `SELECT username, permission, action, topic FROM smart.mqtt_acl WHERE device_id = $1 AND revoked_at IS NULL ORDER BY topic, action`,
      [deviceId],
    );
    expect(acl.rows.length).toBeGreaterThan(0);
    expect(
      (acl.rows as { username: string; topic: string }[]).every(
        (r) =>
          r.username === (res.body as { mqtt: { username: string } }).mqtt.username &&
          r.topic.startsWith('gp/v1/'),
      ),
    ).toBe(true);
    // T-9: four explicit publish topics; no wildcard that would also match config / cmd (D-235)
    expect((acl.rows as { topic: string }[]).some((r) => r.topic.endsWith('/+'))).toBe(false);
    const certRow = await db.admin.query(
      `SELECT serial_number AS serial FROM smart.device_certificate WHERE device_id = $1`,
      [deviceId],
    );
    expect(certRow.rows[0].serial).toBe(res.body.certificateSerial);

    // the device token is a device-audience token: refused on every other surface
    const wrong = await t.http.get('/v1/owner/me').set(bearer(res.body.accessToken)).expect(403);
    expect(wrong.body.code).toBe('auth.wrong_audience');
    // edge CR-015 (D-249): the mTLS token refresh carries the current MQTT endpoints — no wsUrl while the
    // gateway's fallback is off, even though the platform publishes one
    const refreshed = await t.http
      .post('/v1/device/token')
      .set('x-client-cert', encodeURIComponent(res.body.certificatePem))
      .send({})
      .expect(200);
    expect(refreshed.body).toEqual({
      accessToken: expect.any(String),
      expiresAt: expect.stringMatching(/\+07:00$/),
      mqtt: { url: res.body.mqtt.url },
    });
    // device refresh rotates like any other session
    await t.http.post('/v1/auth/refresh').send({ refreshToken: res.body.refreshToken }).expect(200);
  });

  it('the provisioning code is single-use', async () => {
    const res = await t.http
      .post('/v1/device/bootstrap')
      .send({ serial: 'GP-GW-TEST-0001', provisioningCode: code, csrPem: await csrFor(deviceId) })
      .expect(401);
    expect(res.body.code).toBe('device.provisioning_code_invalid');
  });
});

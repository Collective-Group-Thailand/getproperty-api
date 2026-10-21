import 'reflect-metadata';

import { webcrypto } from 'node:crypto';

import * as x509 from '@peculiar/x509';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const TOKEN = 'emqx-test-token-0123456789abcdef0123456789';

async function csr(): Promise<string> {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  return (
    await x509.Pkcs10CertificateRequestGenerator.create({
      name: 'CN=gw-provisioning',
      keys,
      signingAlgorithm: alg,
    })
  ).toString('pem');
}

interface Gw {
  id: string;
  username: string;
  jwt: string;
}

/**
 * D-235 / T-7–T-9 / D-239 (O-012): EMQX HTTP authn + authz on the API, as collective-infra's EMQX calls them
 * (`x-emqx-auth-token`, `transport` mtls | ws, `{"result": …}`), the gateway's WebSocket fallback switch, and the
 * retired PostgreSQL ACL path (0037).
 */
describe('EMQX HTTP authn / authz (D-235, D-239, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let gw: Gw;
  let other: Gw;

  const authn = (body: Record<string, unknown>, token = TOKEN) =>
    t.http.post('/internal/emqx/authn').set('x-emqx-auth-token', token).send(body);
  const authz = (body: Record<string, unknown>) =>
    t.http.post('/internal/emqx/authz').set('x-emqx-auth-token', TOKEN).send(body);
  const mtls = (g: Gw, password = g.jwt, cn = g.username) => ({
    transport: 'mtls',
    clientid: g.username,
    username: g.username,
    password,
    cert_common_name: cn,
    cert_subject: `CN=${cn}`,
    peerhost: '203.0.113.7',
  });
  const ws = (g: Gw, password = g.jwt) => ({
    transport: 'ws',
    clientid: g.username,
    username: g.username,
    password,
    cert_common_name: '',
    cert_subject: '',
    peerhost: '203.0.113.8',
  });

  async function gateway(serial: string): Promise<Gw> {
    const created = await t.http
      .post('/v1/admin/devices')
      .set(bearer(admin))
      .set(idem())
      .send({
        serial,
        kind: 'gateway',
        model: 'rpi-cm4',
        vendor: 'Collective',
        ownership: 'platform_haas',
        tenantId: DEV.tenantId,
        buildingId: DEV.buildingId,
      })
      .expect(201);
    const code = await t.http
      .post(`/v1/admin/devices/${created.body.id}/provisioning-codes`)
      .set(bearer(admin))
      .expect(201);
    const boot = await t.http
      .post('/v1/device/bootstrap')
      .send({ provisioningCode: code.body.code, csrPem: await csr() })
      .expect(201);
    return { id: boot.body.deviceId, username: boot.body.mqtt.username, jwt: boot.body.accessToken };
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_emqx' });
    t = await createIntApp(db, {
      EMQX_AUTH_TOKEN: TOKEN,
      MQTT_USERNAME: 'getproperty-api',
      MQTT_PUBLIC_WS_URL: 'wss://mqtt.test.invalid/mqtt',
      OTP_MAX_PER_HOUR: '20',
    });
    admin = await adminToken(t);
    gw = await gateway('GP-GW-EMQX-0001');
    other = await gateway('GP-GW-EMQX-0002');
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('refuses a missing or wrong x-emqx-auth-token (403) before looking at the body', async () => {
    await t.http.post('/internal/emqx/authn').send(mtls(gw)).expect(403);
    const wrong = await authn(mtls(gw), 'x'.repeat(TOKEN.length)).expect(403);
    expect(wrong.body.code).toBe('auth.forbidden');
  });

  it('is not part of the public contract and never needs a bearer token', async () => {
    const res = await authn({ username: 'getpack-api', password: 'pw', transport: 'mtls' }).expect(200);
    expect(res.body).toEqual({ result: 'ignore' }); // other products' clients fall through
  });

  it('bootstrap hands out the 1.2 MQTT identity: four explicit publish topics, device JWT as password, no wsUrl', async () => {
    const acl = await db.admin.query<{ action: string; topic: string }>(
      `SELECT action::text, topic FROM smart.mqtt_acl WHERE device_id = $1 AND revoked_at IS NULL ORDER BY action, topic`,
      [gw.id],
    );
    const base = `gp/v1/${gw.id}`;
    expect(acl.rows).toEqual([
      { action: 'publish', topic: `${base}/cmd/ack` },
      { action: 'publish', topic: `${base}/events` },
      { action: 'publish', topic: `${base}/health` },
      { action: 'publish', topic: `${base}/telemetry` },
      { action: 'subscribe', topic: `${base}/cmd` },
      { action: 'subscribe', topic: `${base}/config` },
    ]);
  });

  it('mtls: certificate CN + own device JWT → allow; a wrong CN, a missing, foreign or garbage JWT → deny', async () => {
    expect((await authn(mtls(gw)).expect(200)).body).toEqual({ result: 'allow', is_superuser: false });
    expect((await authn(mtls(gw, gw.jwt, other.username)).expect(200)).body.result).toBe('deny');
    expect((await authn(mtls(gw, '')).expect(200)).body.result).toBe('deny'); // mqtt.authn.require_device_jwt = on
    expect((await authn(mtls(gw, other.jwt)).expect(200)).body.result).toBe('deny');
    expect((await authn(mtls(gw, 'not-a-jwt')).expect(200)).body.result).toBe('deny');
    expect((await authn({ ...mtls(gw), clientid: 'someone' }).expect(200)).body.result).toBe('deny');
    expect((await authn({ ...mtls(gw), transport: 'tcp' }).expect(200)).body.result).toBe('deny');
    expect(
      (await authn({ ...mtls(gw), username: 'gw-nope', clientid: 'gw-nope' }).expect(200)).body.result,
    ).toBe('deny');
    const audited = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log
        WHERE action = 'mqtt.authn_denied' AND subject_id = $1 AND outcome = 'denied'
          AND metadata::text NOT LIKE '%' || $2 || '%'`,
      [gw.id, other.jwt.slice(-20)],
    );
    expect(audited.rows[0]!.n).toBeGreaterThanOrEqual(4); // never the password in the audit row
  });

  it('ws (O-012 → D-239): denied until the platform admin enables the gateway’s fallback; then JWT-only', async () => {
    expect((await authn(ws(gw)).expect(200)).body.result).toBe('deny');
    // platform audience only: an operator token is refused on /v1/admin
    const owner = await ownerToken(t);
    await t.http
      .post(`/v1/admin/devices/${gw.id}/actions/set-mqtt-transport`)
      .set(bearer(owner))
      .set(idem())
      .send({ wsFallback: true, reason: 'firewall blocks 8883' })
      .expect(403);
    const on = await t.http
      .post(`/v1/admin/devices/${gw.id}/actions/set-mqtt-transport`)
      .set(bearer(admin))
      .set(idem())
      .send({ wsFallback: true, reason: 'firewall blocks 8883' })
      .expect(200);
    expect(on.body).toMatchObject({ id: gw.id, mqttWsFallback: true });
    expect(on.body.nextActions).toContain('set-mqtt-transport');
    expect((await authn(ws(gw)).expect(200)).body.result).toBe('allow');
    expect((await authn(ws(gw, '')).expect(200)).body.result).toBe('deny');
    expect((await authn(ws(gw, other.jwt)).expect(200)).body.result).toBe('deny');
    expect((await authn(ws(other)).expect(200)).body.result).toBe('deny'); // per gateway
    const audit = await db.admin.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM platform.audit_log WHERE action = 'device.mqtt_transport_changed' AND subject_id = $1`,
      [gw.id],
    );
    expect(audit.rows).toEqual([{ before: { mqttWsFallback: false }, after: { mqttWsFallback: true } }]);
    const events = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'device.mqtt_transport_changed' AND aggregate_id = $1`,
      [gw.id],
    );
    expect(events.rows[0]!.n).toBe(1);
    // a meter (not a gateway) cannot get the fallback; an unknown id is 404
    await t.http
      .post(`/v1/admin/devices/00000000-0000-7000-8000-000000000000/actions/set-mqtt-transport`)
      .set(bearer(admin))
      .set(idem())
      .send({ wsFallback: true, reason: 'nope nope' })
      .expect(404);
  });

  it('authz: a gateway publishes only its four topics (QoS ≤ 1, not retained) and subscribes only to config / cmd', async () => {
    const base = `gp/v1/${gw.id}`;
    const ask = (topic: string, action: string, extra: Record<string, unknown> = {}) =>
      authz({
        username: gw.username,
        clientid: gw.username,
        topic,
        action,
        qos: '1',
        retain: 'false',
        ...extra,
      });
    for (const leaf of ['telemetry', 'health', 'events', 'cmd/ack'])
      expect((await ask(`${base}/${leaf}`, 'publish').expect(200)).body).toEqual({ result: 'allow' });
    for (const leaf of ['config', 'cmd'])
      expect((await ask(`${base}/${leaf}`, 'subscribe').expect(200)).body.result).toBe('allow');
    // T-9: the old wildcard grant no longer covers config / cmd
    expect((await ask(`${base}/config`, 'publish').expect(200)).body.result).toBe('deny');
    expect((await ask(`${base}/cmd`, 'publish').expect(200)).body.result).toBe('deny');
    expect((await ask(`${base}/telemetry`, 'publish', { retain: 'true' }).expect(200)).body.result).toBe(
      'deny',
    );
    expect((await ask(`${base}/telemetry`, 'publish', { qos: '2' }).expect(200)).body.result).toBe('deny');
    expect((await ask(`${base}/+`, 'subscribe').expect(200)).body.result).toBe('deny');
    expect((await ask(`gp/v1/${other.id}/cmd`, 'subscribe').expect(200)).body.result).toBe('deny');
    expect((await ask(`gp/v1/${other.id}/telemetry`, 'publish').expect(200)).body.result).toBe('deny');
    expect((await ask(`$share/x/${base}/cmd`, 'subscribe').expect(200)).body.result).toBe('deny');
    expect((await ask('other/product/topic', 'publish').expect(200)).body.result).toBe('deny');
    const audited = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'mqtt.authz_denied' AND subject_id = $1`,
      [gw.id],
    );
    expect(audited.rows[0]!.n).toBeGreaterThanOrEqual(5);
  });

  it('authz: the service user may use the namespace (shared subscriptions too); strangers are denied inside, ignored outside', async () => {
    const svc = (topic: string, action: string) =>
      authz({
        username: 'getproperty-api',
        clientid: 'getproperty-api-1',
        topic,
        action,
        qos: '1',
        retain: 'false',
      });
    expect((await svc('$share/ingest/gp/v1/+/telemetry', 'subscribe').expect(200)).body.result).toBe('allow');
    expect((await svc(`gp/v1/${gw.id}/config`, 'publish').expect(200)).body.result).toBe('allow');
    expect((await svc('getpack/orders', 'publish').expect(200)).body.result).toBe('ignore');
    const stranger = (topic: string) =>
      authz({
        username: 'getpack-worker',
        clientid: 'c',
        topic,
        action: 'subscribe',
        qos: '0',
        retain: 'false',
      });
    expect((await stranger('gp/v1/+/telemetry').expect(200)).body.result).toBe('deny');
    expect((await stranger('getpack/orders').expect(200)).body.result).toBe('ignore');
  });

  it('a gateway whose certificates were revoked cannot connect even with a still-valid certificate', async () => {
    await t.http
      .post(`/v1/admin/devices/${other.id}/actions/revoke-certificates`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'gateway stolen from the meter room' })
      .expect(200);
    expect((await authn(mtls(other)).expect(200)).body.result).toBe('deny');
    const pub = await authz({
      username: other.username,
      clientid: other.username,
      topic: `gp/v1/${other.id}/telemetry`,
      action: 'publish',
      qos: '1',
      retain: 'false',
    }).expect(200);
    expect(pub.body.result).toBe('deny');
  });

  it('0037 retired the broker’s PostgreSQL read path (policy and grants of gp_mqtt)', async () => {
    const policies = await db.admin.query(
      `SELECT 1 FROM pg_policies WHERE schemaname = 'smart' AND tablename = 'mqtt_acl' AND policyname = 'mqtt_acl_rls_broker'`,
    );
    expect(policies.rows).toHaveLength(0);
    const grants = await db.admin.query<{ can: boolean; usage: boolean }>(
      `SELECT has_table_privilege('gp_mqtt', 'smart.mqtt_acl', 'SELECT') AS can,
              has_schema_privilege('gp_mqtt', 'smart', 'USAGE') AS usage`,
    );
    expect(grants.rows[0]).toEqual({ can: false, usage: false });
  });
});

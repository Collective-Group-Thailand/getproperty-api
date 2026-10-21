import 'reflect-metadata';

import { webcrypto } from 'node:crypto';

import { fakeLineIdToken } from '@integrations/line/fake-line-login';
import * as x509 from '@peculiar/x509';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, onboardTenant, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

async function csr(cn: string): Promise<string> {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const req = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${cn}`,
    keys,
    signingAlgorithm: alg,
  });
  return req.toString('pem');
}

/**
 * Contract requests of getproperty-web, getproperty-liff and getproperty-edge that belong to B1–B3 (see
 * docs/contract-requests-triage.md): public plans and tariff ceiling, owner search, web vitals, per-role invitation
 * links, resident link / language / entitlements / push subscriptions, the OTP magic link, device bootstrap shape,
 * mTLS token, certificate renewal and log presign.
 */
describe('consumer contract requests (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let owner: string;
  let admin: string;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_cr' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20', DEVICE_MTLS_SOURCE: 'pem_header' });
    owner = await ownerToken(t);
    admin = await adminToken(t);
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  describe('public surface (web)', () => {
    it('GET /v1/public/plans lists the D-156 plans without a token, cacheable', async () => {
      const res = await t.http.get('/v1/public/plans').expect(200);
      expect(res.headers['cache-control']).toContain('max-age=300');
      const starter = (res.body.data as { key: string }[]).find((p) => p.key === 'apartment_starter');
      expect(starter).toMatchObject({
        kind: 'plan',
        tenantType: 'apartment',
        pricePerUnit: '25.00',
        priceUnit: 'unit_month',
        minimumUnits: 20,
        currency: 'THB',
        vatIncluded: false,
        status: 'proposed',
      });
    });

    it('GET /v1/public/utility-tariffs/current: 404 until published, then the ceiling', async () => {
      const none = await t.http
        .get('/v1/public/utility-tariffs/current?utility=electric&provider=mea')
        .expect(404);
      expect(none.body.code).toBe('tariff.not_found');
      await db.admin.query(
        `UPDATE platform.utility_tariff_version v SET state = 'published', needs_check = false, entered_by = NULL,
                verified_by = $1, verified_at = now(), published_at = now()
           FROM platform.utility_tariff t
          WHERE t.id = v.utility_tariff_id AND t.provider = 'mea' AND t.utility = 'electric'
            AND v.effective_from <= current_date AND (v.effective_to IS NULL OR v.effective_to > current_date)`,
        [DEV.users.platformAdmin],
      );
      const res = await t.http
        .get('/v1/public/utility-tariffs/current?utility=electric&provider=mea')
        .expect(200);
      expect(res.body).toMatchObject({ utility: 'electric', provider: 'mea' });
      expect(res.body.ceilingPerUnit).toMatch(/^\d+\.\d{4}$/);
      expect(res.body.tariffCode).toMatch(/^1\.1/);
    });
  });

  describe('owner console (web)', () => {
    it('GET /v1/owner/search finds units, buildings and parties of my tenant only', async () => {
      const short = await t.http.get('/v1/owner/search?q=A').set(bearer(owner)).expect(422);
      expect(short.body.code).toBe('validation.failed');
      const res = await t.http.get('/v1/owner/search?q=A-10').set(bearer(owner)).expect(200);
      const labels = (res.body.data as { type: string; label: string }[]).map((h) => `${h.type}:${h.label}`);
      expect(labels).toContain('unit:A-101');
      expect(res.body.data.length).toBeLessThanOrEqual(20);
      const party = await t.http
        .get(`/v1/owner/search?q=${encodeURIComponent('ตัวอย่าง')}`)
        .set(bearer(owner));
      expect(party.status).toBe(200);
      const other = await onboardTenant(t, admin, { slug: 'search-b', phone: '+660000000081' });
      const foreign = await t.http.get('/v1/owner/search?q=A-10').set(bearer(other.token)).expect(200);
      expect(foreign.body.data).toEqual([]);
    });

    it('web vitals are accepted anonymously and with a token (202)', async () => {
      const body = {
        metrics: [
          { name: 'LCP', value: 1834.2, rating: 'good', id: 'v4-a', route: '/buildings/[buildingId]' },
        ],
      };
      await t.http.post('/v1/owner/telemetry/web-vitals').send(body).expect(202);
      await t.http.post('/v1/staff/telemetry/web-vitals').set(bearer(owner)).send(body).expect(202);
      await t.http.post('/v1/admin/telemetry/web-vitals').set(bearer(admin)).send(body).expect(202);
      await t.http
        .post('/v1/owner/telemetry/web-vitals')
        .send({ metrics: [{ ...body.metrics[0], route: 'https://x.invalid/?phone=1' }] })
        .expect(422);
      await t.http.post('/v1/admin/telemetry/web-vitals').set(bearer(owner)).send(body).expect(403);
    });

    it('staff invitations link to the staff host, others to the owner console', async () => {
      const staff = await t.http
        .post('/v1/owner/invitations')
        .set(bearer(owner))
        .set(idem())
        .send({ role: 'staff', phone: '+660000000082', channel: 'link' })
        .expect(201);
      expect(staff.body.inviteUrl).toMatch(/^http:\/\/staff\.localhost:3001\/join\?code=/);
      expect(staff.body.nextActions).toEqual(['revoke']);
      const manager = await t.http
        .post('/v1/owner/invitations')
        .set(bearer(owner))
        .set(idem())
        .send({ role: 'manager', phone: '+660000000083', channel: 'link' })
        .expect(201);
      expect(manager.body.inviteUrl).toMatch(/^http:\/\/localhost:3001\/join\?code=/);
    });

    it('menus are named enums; units carry nextActions', async () => {
      const me = await t.http.get('/v1/owner/me').set(bearer(owner)).expect(200);
      expect(me.body.menu).toEqual(expect.arrayContaining(['dashboard', 'devices', 'readings']));
      const staff = await t.http.get('/v1/staff/me').set(bearer(owner)).expect(200);
      expect(staff.body.menu).toEqual(expect.arrayContaining(['readings', 'reading_rounds', 'installs']));
      const units = await t.http
        .get(`/v1/owner/units?buildingId=${DEV.buildingId}&perPage=100`)
        .set(bearer(owner))
        .expect(200);
      const occupied = (units.body.data as { status: string; nextActions: string[] }[]).find(
        (u) => u.status === 'occupied',
      )!;
      expect(occupied.nextActions).toEqual([]);
      const vacant = (units.body.data as { status: string; nextActions: string[] }[]).find(
        (u) => u.status === 'vacant',
      )!;
      expect(vacant.nextActions).toEqual(['set-status']);
    });
  });

  describe('resident app (liff)', () => {
    let resident: { accessToken: string; refreshToken: string };
    let code: string;

    it('POST /v1/resident/link links my login from an invitation code, then the token refresh scopes me', async () => {
      const inv = await t.http
        .post(`/v1/owner/leases/${DEV.leaseId}/invitations`)
        .set(bearer(owner))
        .send({ channel: 'line_qr' })
        .expect(201);
      code = inv.body.code;
      expect(inv.body.url).toMatch(/^http:\/\/localhost:3300\/link\?code=/);
      const login = await t.http
        .post('/v1/auth/resident/line')
        .send({ idToken: fakeLineIdToken({ sub: 'U00000000000000000000000000cr001', name: 'ผู้เช่า CR' }) })
        .expect(200);
      resident = login.body;
      const R = bearer(resident.accessToken);
      const before = await t.http.get('/v1/resident/me').set(R).expect(200);
      expect(before.body.entitlements).toEqual([]);
      const refused = await t.http.post('/v1/resident/link').set(R).send({ code }).expect(409);
      expect(refused.body.code).toBe('consent.required');
      const purposes = await t.http.get('/v1/resident/consents').set(R).expect(200);
      await t.http
        .post('/v1/resident/consents')
        .set(R)
        .send({
          items: (purposes.body as { key: string; version: number; required: boolean }[])
            .filter((p) => p.required)
            .map((p) => ({ purposeKey: p.key, version: p.version, granted: true })),
        })
        .expect(201);
      const linked = await t.http.post('/v1/resident/link').set(R).send({ code, via: 'line_qr' }).expect(200);
      expect(linked.body).toMatchObject({
        tenantId: DEV.tenantId,
        leaseId: DEV.leaseId,
        partyId: DEV.residentPartyId,
        refreshRequired: true,
      });
      expect((linked.body.units as { unitNo: string }[]).map((u) => u.unitNo)).toEqual(['A-101']);
      const again = await t.http.post('/v1/resident/link').set(R).send({ code }).expect(409);
      expect(again.body.code).toBe('invitation.not_pending');
      await t.http.post('/v1/resident/link').set(R).send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }).expect(404);
      const refreshed = await t.http
        .post('/v1/auth/refresh')
        .send({ refreshToken: resident.refreshToken })
        .expect(200);
      resident = refreshed.body;
    });

    it('GET /v1/resident/me lists entitlements; PATCH changes my language', async () => {
      const R = bearer(resident.accessToken);
      const me = await t.http.get('/v1/resident/me').set(R).expect(200);
      expect(me.body.entitlements).toEqual(['bills', 'lease']);
      expect(me.body.units[0].role).toBe('tenant');
      const patched = await t.http.patch('/v1/resident/me').set(R).send({ language: 'en' }).expect(200);
      expect(patched.body.user.language).toBe('en');
      await t.http.patch('/v1/resident/me').set(R).send({ language: 'fr' }).expect(422);
    });

    it('registers and removes a resident web-push subscription (idempotent)', async () => {
      const R = bearer(resident.accessToken);
      const body = {
        endpoint: 'https://push.example.com/send/resident-1',
        keys: {
          p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
          auth: 'tBHItJI5svbpez7KI4CCXg',
        },
      };
      const key = idem();
      const first = await t.http
        .post('/v1/resident/push-subscriptions')
        .set(R)
        .set(key)
        .send(body)
        .expect(201);
      const replay = await t.http
        .post('/v1/resident/push-subscriptions')
        .set(R)
        .set(key)
        .send(body)
        .expect(201);
      expect(replay.body.id).toBe(first.body.id);
      await t.http.delete(`/v1/resident/push-subscriptions/${first.body.id}`).set(R).expect(204);
      await t.http.delete(`/v1/resident/push-subscriptions/${first.body.id}`).set(R).expect(404);
    });

    it('the resident OTP SMS links to the LIFF with the challenge id', async () => {
      const res = await t.http
        .post('/v1/auth/resident/otp/request')
        .send({ phone: '+660000000011' })
        .expect(200);
      expect(t.sms.lastTo('+660000000011')).toContain(
        `http://localhost:3300/auth/otp?c=${res.body.challengeId}`,
      );
    });
  });

  describe('device identity (edge CR-001…CR-004)', () => {
    let gatewayId: string;
    let certificatePem: string;
    let accessToken: string;

    it('bootstraps with the code only, a gw-provisioning CSR, agent version and hardware', async () => {
      const created = await t.http
        .post('/v1/admin/devices')
        .set(bearer(admin))
        .set(idem())
        .send({
          serial: 'GP-GW-CR-0001',
          kind: 'gateway',
          model: 'rpi-cm4',
          vendor: 'Collective',
          ownership: 'platform_haas',
          tenantId: DEV.tenantId,
          buildingId: DEV.buildingId,
        })
        .expect(201);
      gatewayId = created.body.id;
      const issued = await t.http
        .post(`/v1/admin/devices/${gatewayId}/provisioning-codes`)
        .set(bearer(admin))
        .expect(201);
      const res = await t.http
        .post('/v1/device/bootstrap')
        .send({
          provisioningCode: issued.body.code,
          csrPem: await csr('gw-provisioning'),
          agentVersion: '0.1.0',
          hardware: { arch: 'arm64', hostname: 'gw-pilot-01', serial: '10000000abcdef01' },
        })
        .expect(201);
      expect(res.body).toMatchObject({
        gatewayId,
        deviceId: gatewayId,
        mqtt: { url: expect.stringMatching(/^mqtts:\/\//) },
        deviceToken: { accessToken: res.body.accessToken, expiresAt: res.body.accessTokenExpiresAt },
      });
      // edge CR-013 / D-231: no WSS URL while O-012 is open (MQTT_PUBLIC_WS_URL unset)
      expect(res.body.mqtt).not.toHaveProperty('wsUrl');
      expect(res.body.caChainPem).toContain('BEGIN CERTIFICATE');
      certificatePem = res.body.certificatePem;
      expect(new x509.X509Certificate(certificatePem).subject).toBe(`CN=gw-${gatewayId}`);
      const row = await db.admin.query('SELECT firmware_version FROM smart.device WHERE id = $1', [
        gatewayId,
      ]);
      expect(row.rows[0].firmware_version).toBe('0.1.0');
    });

    it('POST /v1/device/token mints a device JWT from the client certificate', async () => {
      await t.http.post('/v1/device/token').send({}).expect(401);
      const res = await t.http
        .post('/v1/device/token')
        .set('x-client-cert', encodeURIComponent(certificatePem))
        .send({})
        .expect(200);
      accessToken = res.body.accessToken;
      expect(res.body.expiresAt).toMatch(/\+07:00$/);
    });

    it('renews the certificate (old one stays valid) and presigns a log bundle', async () => {
      const renewed = await t.http
        .post('/v1/device/certificate/renew')
        .set(bearer(accessToken))
        .set('x-client-cert', encodeURIComponent(certificatePem))
        .send({ csrPem: await csr(`gw-${gatewayId}`) })
        .expect(200);
      expect(new x509.X509Certificate(renewed.body.certificatePem).subject).toBe(`CN=gw-${gatewayId}`);
      // the previous certificate still mints tokens until it expires
      await t.http
        .post('/v1/device/token')
        .set('x-client-cert', encodeURIComponent(certificatePem))
        .send({})
        .expect(200);
      await db.admin.query(
        `UPDATE smart.device_certificate SET revoked_at = now(), revoke_reason = 'test' WHERE certificate_pem = $1`,
        [certificatePem],
      );
      await t.http
        .post('/v1/device/token')
        .set('x-client-cert', encodeURIComponent(certificatePem))
        .send({})
        .expect(401);
      const logs = await t.http
        .post('/v1/device/logs/presign')
        .set(bearer(accessToken))
        .send({
          contentType: 'application/gzip',
          sizeBytes: 18234,
          sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        })
        .expect(200);
      expect(logs.body).toMatchObject({ method: 'PUT', fileId: expect.any(String) });
      const doc = await db.admin.query('SELECT kind, building_id FROM core.document WHERE id = $1', [
        logs.body.fileId,
      ]);
      expect(doc.rows[0]).toEqual({ kind: 'log_bundle', building_id: DEV.buildingId });
      // an operator token is refused on the device surface
      await t.http.post('/v1/device/logs/presign').set(bearer(owner)).send({}).expect(403);
      // a staff of another tenant cannot see the gateway
      const other = await operatorToken(t, '+660000000081');
      const hits = await t.http.get('/v1/owner/search?q=GP-GW-CR').set(bearer(other)).expect(200);
      expect(hits.body.data).toEqual([]);
    });
  });
});

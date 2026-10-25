import { randomUUID } from 'node:crypto';

import { TokenService } from '@core/identity/token.service';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { type Audience } from '../../src/surfaces/surfaces';
import { createE2eApp } from '../support/e2e-app';

/** The `/me` route of every authenticated surface and the audience it accepts (contract §2, D-151). */
const SURFACE_ME: Record<string, Audience> = {
  '/v1/owner/me': 'operator',
  '/v1/staff/me': 'operator',
  '/v1/resident/me': 'resident',
  '/v1/technician/me': 'technician',
  '/v1/prospect/me': 'prospect',
  '/v1/admin/me': 'platform',
};

/** B1.3 acceptance: a token of one audience is rejected on every other prefix (fake data stores, no database). */
describe('audience guard (e2e, fake data stores)', () => {
  let app: INestApplication;
  let tokens: TokenService;

  beforeAll(async () => {
    ({ app } = await createE2eApp());
    tokens = app.get(TokenService);
  });
  afterAll(async () => {
    await app.close();
  });

  const tokenFor = (aud: Audience) =>
    tokens.issue({
      sub: randomUUID(),
      aud,
      sid: randomUUID(),
      scopes: aud === 'device' ? [`device:${randomUUID()}`] : [],
    }).token;

  it.each(['operator', 'resident', 'technician', 'platform', 'device', 'prospect'] as const)(
    'a %s token is refused on the other surfaces',
    async (aud) => {
      const token = tokenFor(aud);
      for (const [path, accepted] of Object.entries(SURFACE_ME)) {
        if (accepted === aud) continue;
        const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
        expect({ path, status: res.status, code: res.body.code }).toEqual({
          path,
          status: 403,
          code: 'auth.wrong_audience',
        });
        expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      }
    },
  );

  it('no token, a malformed token or a forged signature is 401', async () => {
    const valid = tokenFor('resident');
    const [h, p] = valid.split('.');
    for (const auth of [
      undefined,
      'Bearer nope',
      `Bearer ${h}.${p}.AAAA`,
      `Basic ${Buffer.from('a:b').toString('base64')}`,
    ]) {
      const req = request(app.getHttpServer()).get('/v1/resident/me');
      const res = await (auth ? req.set('Authorization', auth) : req);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('auth.unauthenticated');
    }
  });

  it('routes are case-sensitive: an upper-case prefix never reaches a handler past the audience guard (review #7)', async () => {
    const resident = tokenFor('resident');
    for (const path of [
      '/V1/ADMIN/me',
      '/V1/OWNER/me',
      '/v1/Admin/me',
      '/V1/RESIDENT/me',
      '/v1/ADMIN/tenants',
    ]) {
      for (const auth of [undefined, `Bearer ${resident}`]) {
        const req = request(app.getHttpServer()).get(path);
        const res = await (auth ? req.set('Authorization', auth) : req);
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
      }
    }
  });

  it('JWKS is public and lists the EdDSA key', async () => {
    const res = await request(app.getHttpServer()).get('/v1/auth/.well-known/jwks.json').expect(200);
    expect(res.body.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
  });
});

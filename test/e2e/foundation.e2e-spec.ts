import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { SURFACES } from '../../src/surfaces/surfaces';
import { createE2eApp } from '../support/e2e-app';

describe('B1.1 foundation (e2e, fake data stores)', () => {
  let app: INestApplication;
  let served: unknown;

  beforeAll(async () => {
    const e2e = await createE2eApp();
    app = e2e.app;
    served = e2e.openapi;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports every dependency up (fake mode)', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    for (const dep of ['database', 'redis', 'storage', 'mqtt']) {
      expect(res.body.details[dep]).toEqual({ status: 'up', mode: 'fake' });
    }
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it.each(Object.values(SURFACES).filter((s) => s !== 'webhooks'))(
    'GET /v1/%s/ping answers the surface, time and version',
    async (surface) => {
      const res = await request(app.getHttpServer()).get(`/v1/${surface}/ping`).expect(200);
      expect(res.body.surface).toBe(surface);
      expect(res.body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
      expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    },
  );

  it('GET /webhooks/ping is version-neutral', async () => {
    const res = await request(app.getHttpServer()).get('/webhooks/ping').expect(200);
    expect(res.body.surface).toBe('webhooks');
    await request(app.getHttpServer()).get('/v1/webhooks/ping').expect(404);
  });

  it('GET /v1/admin/system/info shows version, commit and the environment badge', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/system/info').expect(200);
    expect(res.body).toMatchObject({ environment: 'test', fakes: true });
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body).toHaveProperty('commit');
  });

  it('GET /docs renders Scalar', async () => {
    const res = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('getproperty API reference');
    expect(res.text).toContain('/docs/assets/scalar.js');
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'nonce-");
  });

  it('GET /docs/swagger renders Swagger UI and /docs.yaml the YAML document', async () => {
    const swagger = await request(app.getHttpServer()).get('/docs/swagger').expect(200);
    expect(swagger.text).toContain('swagger-ui');
    const yaml = await request(app.getHttpServer()).get('/docs.yaml').expect(200);
    expect(yaml.text).toContain('openapi: 3.1.0');
  });

  it('GET /docs-json is the committed contract/openapi.json', async () => {
    const res = await request(app.getHttpServer()).get('/docs-json').expect(200);
    const committed = JSON.parse(readFileSync(join(process.cwd(), 'contract', 'openapi.json'), 'utf8'));
    expect(res.body).toEqual(committed);
    expect(served).toEqual(committed);
  });

  it('an unknown route is a problem+json 404 with the stable code', async () => {
    const res = await request(app.getHttpServer()).get('/v1/owner/nothing-here').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.headers['content-language']).toBe('th');
    expect(res.body).toMatchObject({
      type: 'https://errors.getproperty.co/http.not_found',
      code: 'http.not_found',
      status: 404,
      title: 'ไม่พบข้อมูล',
    });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('Accept-Language: en localises the problem', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/nothing')
      .set('Accept-Language', 'en')
      .expect(404);
    expect(res.body.title).toBe('Not found');
    expect(res.headers['content-language']).toBe('en');
  });

  it('malformed JSON is 400 http.malformed_json', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/owner/ping')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
    expect(res.body.code).toBe('http.malformed_json');
  });

  it('X-Tenant-Id that is not a uuid is refused on the owner surface with 400 tenant.context_invalid', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/owner/ping')
      .set('X-Tenant-Id', 'not-a-uuid')
      .expect(400);
    expect(res.body.code).toBe('tenant.context_invalid');
    expect(res.body.errors).toEqual([
      { path: 'x-tenant-id', code: 'isUuid', message: 'X-Tenant-Id must be a uuid' },
    ]);
    // The header is ignored on surfaces that are not tenant-scoped (resident, technician).
    await request(app.getHttpServer()).get('/v1/resident/ping').set('X-Tenant-Id', 'not-a-uuid').expect(200);
    await request(app.getHttpServer())
      .get('/v1/technician/ping')
      .set('X-Tenant-Id', 'not-a-uuid')
      .expect(200);
  });

  it('the retired /v1/tenant surface no longer exists (renamed to /v1/resident, D-151)', async () => {
    await request(app.getHttpServer()).get('/v1/tenant/ping').expect(404);
  });

  it('a valid X-Tenant-Id is accepted on the staff surface', async () => {
    await request(app.getHttpServer())
      .get('/v1/staff/ping')
      .set('X-Tenant-Id', '0d0c7a4e-5b0e-4c55-9d7c-3f2b8a1e6c11')
      .expect(200);
  });

  it('echoes a safe incoming X-Request-Id and mints one otherwise', async () => {
    const echoed = await request(app.getHttpServer())
      .get('/v1/owner/ping')
      .set('X-Request-Id', 'bff-request-0001')
      .expect(200);
    expect(echoed.headers['x-request-id']).toBe('bff-request-0001');
    const minted = await request(app.getHttpServer())
      .get('/v1/owner/ping')
      .set('X-Request-Id', 'bad id!')
      .expect(200);
    expect(minted.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

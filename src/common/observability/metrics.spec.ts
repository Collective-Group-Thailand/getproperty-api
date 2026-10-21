import { type AddressInfo } from 'node:net';

import express from 'express';
import request from 'supertest';

import { trustProxy } from '../http/trust-proxy';
import { metricsHandler, ProcessMetrics, processServiceName, startOpsServer } from './metrics';

describe('process metrics and the ops port (D-230, Collective platform image contract)', () => {
  it('names the processes: api as configured, worker / ingest suffixed once', () => {
    expect(processServiceName('getproperty-api', 'api')).toBe('getproperty-api');
    expect(processServiceName('getproperty-api', 'worker')).toBe('getproperty-worker');
    expect(processServiceName('getproperty-worker', 'worker')).toBe('getproperty-worker');
    expect(processServiceName('getproperty', 'ingest')).toBe('getproperty-ingest');
  });

  it('API /metrics: runtime + request histogram by route pattern for the docker network, 404 through Caddy', async () => {
    const metrics = new ProcessMetrics('getproperty-api');
    const app = express();
    app.set('trust proxy', trustProxy(1, '172.30.0.0/16'));
    app.use(metrics.httpMiddleware());
    app.use('/metrics', metricsHandler(metrics, '127.0.0.0/8'));
    app.get('/v1/things/:id', (_req, res) => {
      res.json({ ok: true });
    });
    await request(app).get('/v1/things/0193a1b2-0000-7000-8000-000000000001').expect(200);

    const scraped = await request(app).get('/metrics').expect(200);
    expect(scraped.headers['content-type']).toContain('text/plain');
    expect(scraped.text).toContain('process_cpu_user_seconds_total');
    expect(scraped.text).toMatch(
      /http_server_request_duration_seconds_count\{service="getproperty-api",method="GET",route="\/v1\/things\/:id",status="2xx"\} 1/,
    );
    expect(scraped.text).not.toContain('0193a1b2');

    // Through Caddy the right-most X-Forwarded-For entry is the public client: not allowed.
    await request(app).get('/metrics').set('X-Forwarded-For', '203.0.113.9').expect(404);
  });

  it('worker / ingest ops port: /health 200 when every check is up, 503 when one is down; /metrics; 404 elsewhere', async () => {
    let redisUp = true;
    const server = await startOpsServer({
      port: 0,
      host: '127.0.0.1',
      metrics: new ProcessMetrics('getproperty-worker'),
      checks: () => [
        { name: 'database', probe: () => Promise.resolve() },
        { name: 'redis', probe: () => (redisUp ? Promise.resolve() : Promise.reject(new Error('down'))) },
      ],
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ok = await fetch(`${base}/health`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        status: 'ok',
        info: { database: { status: 'up' }, redis: { status: 'up' } },
      });
      redisUp = false;
      const down = await fetch(`${base}/health`);
      expect(down.status).toBe(503);
      expect(((await down.json()) as { info: Record<string, unknown> }).info.redis).toEqual({
        status: 'down',
      });
      const m = await fetch(`${base}/metrics`);
      expect(m.status).toBe(200);
      expect(await m.text()).toContain('service="getproperty-worker"');
      expect((await fetch(`${base}/other`)).status).toBe(404);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

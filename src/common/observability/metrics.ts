import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ipAllowed, parseCidrList } from '@common/http/cidr';
import { collectDefaultMetrics, Histogram, Registry } from '@prometheus-io/client';
import { type NextFunction, type Request, type Response } from 'express';

/**
 * Prometheus metrics of one process (D-230, the Collective platform's image contract: Grafana Alloy scrapes
 * `/metrics` of every container labelled `collective.metrics`). One registry per process with the Node.js runtime
 * metrics and, for the API, an HTTP request histogram by method, matched route pattern and status class — never by
 * raw URL (ids would explode the series and could carry personal data).
 */
export class ProcessMetrics {
  readonly registry = new Registry();
  private httpDuration?: Histogram<'method' | 'route' | 'status'>;

  constructor(readonly service: string) {
    this.registry.setDefaultLabels({ service });
    collectDefaultMetrics({ register: this.registry });
  }

  /** Express middleware recording `http_server_request_duration_seconds` (API process only). */
  httpMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
    this.httpDuration ??= new Histogram({
      name: 'http_server_request_duration_seconds',
      help: 'HTTP requests served by the API, by method, route pattern and status class',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10],
      registers: [this.registry],
    });
    const histogram = this.httpDuration;
    return (req, res, next) => {
      const end = histogram.startTimer();
      res.on('finish', () => {
        const route = (req.route as { path?: string } | undefined)?.path;
        end({
          method: req.method,
          route: route ? `${req.baseUrl}${route}` : 'unmatched',
          status: `${Math.floor(res.statusCode / 100)}xx`,
        });
      });
      next();
    };
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}

/**
 * The service name of a process: `OTEL_SERVICE_NAME` (e.g. `getproperty-api`) for the API, with `-worker` /
 * `-ingest` appended for the other processes unless the deployment already named it so (the platform compose file
 * sets `getproperty-worker` on the worker container).
 */
export function processServiceName(base: string, role: 'api' | 'worker' | 'ingest'): string {
  if (role === 'api' || base.endsWith(`-${role}`)) return base;
  return `${base.replace(/-api$/, '')}-${role}`;
}

/** Default `METRICS_ALLOWED_CIDRS`: loopback and the private ranges (the platform's docker network, Alloy). */
export const PRIVATE_RANGES = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7';

/**
 * Express handler for `GET /metrics` on the API. The caller is `req.ip` (after `trust proxy`, D-229): Alloy scrapes
 * the container directly from the docker network, while a request through Caddy carries the public client address
 * and is answered 404 — the public hostnames never expose metrics (Caddy also blocks the path).
 */
export function metricsHandler(metrics: ProcessMetrics, allowedCidrs: string | undefined) {
  const allowed = parseCidrList(allowedCidrs || PRIVATE_RANGES);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' || !ipAllowed(allowed, req.ip)) {
      res.status(404).json({ type: 'about:blank', title: 'Not Found', status: 404, code: 'route.not_found' });
      return;
    }
    metrics
      .render()
      .then(({ contentType, body }) => {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');
        res.send(body);
      })
      .catch(next);
  };
}

export interface OpsCheck {
  name: string;
  /** Resolves when the dependency is up; rejects (or times out) when it is down. */
  probe: () => Promise<void>;
}

const PROBE_TIMEOUT_MS = 2_000;

async function runChecks(
  checks: OpsCheck[],
): Promise<{ ok: boolean; info: Record<string, { status: string }> }> {
  const results = await Promise.all(
    checks.map(async (c) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          c.probe(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS);
          }),
        ]);
        return [c.name, 'up'] as const;
      } catch {
        return [c.name, 'down'] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return {
    ok: results.every(([, s]) => s === 'up'),
    info: Object.fromEntries(results.map(([n, s]) => [n, { status: s }])),
  };
}

/**
 * The worker's and the ingest process's own HTTP port (they serve no API): `GET /health` (200 when every check is up,
 * 503 otherwise — the platform's container healthcheck and deploy gate) and `GET /metrics`. Nothing else; bound on
 * all interfaces inside the container, never published by the platform compose file.
 */
export function startOpsServer(options: {
  port: number;
  metrics: ProcessMetrics;
  checks: () => OpsCheck[];
  host?: string;
}): Promise<Server> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    const reply = (status: number, contentType: string, body: string) => {
      res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'GET') return reply(405, 'application/json', '{"status":405}');
    if (path === '/health') {
      runChecks(options.checks())
        .then(({ ok, info }) =>
          reply(ok ? 200 : 503, 'application/json', JSON.stringify({ status: ok ? 'ok' : 'error', info })),
        )
        .catch(() => reply(503, 'application/json', '{"status":"error"}'));
      return;
    }
    if (path === '/metrics') {
      options.metrics
        .render()
        .then(({ contentType, body }) => reply(200, contentType, body))
        .catch(() => reply(500, 'text/plain', 'metrics unavailable'));
      return;
    }
    reply(404, 'application/json', '{"status":404}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve(server));
  });
}

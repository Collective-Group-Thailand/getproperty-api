import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  CONTRACT_FIXTURES,
  signIntegrationWebhook,
  verifyIntegrationWebhook,
  WEBHOOK_HEADERS,
} from '@collective/asset-core/contracts';
import { TenantTx } from '@database/tenant-tx';
import {
  IntegrationDeliveryService,
  MAX_DELIVERY_ATTEMPTS,
} from '@modules/bridge-integrations/integration-delivery.service';
import { IntegrationEventsService } from '@modules/bridge-integrations/integration-events.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const OUT_KEY = 'o'.repeat(48);
const IN_KEY = 'i'.repeat(48);

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

/** D-238 / T-16: outbox → HTTP webhook to a partner product, and the signed receiver for events from one. */
describe('cross-product integration webhooks (D-238, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let partner: Server;
  const received: Received[] = [];
  let answer = 200;

  beforeAll(async () => {
    partner = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = answer;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => partner.listen(0, '127.0.0.1', () => r()));
    const port = (partner.address() as { port: number }).port;
    db = await createIntDatabase({ prefix: 'gp_bridge' });
    t = await createIntApp(db, {
      INTEGRATION_GETBUILD_TRANSPORT: 'webhook',
      INTEGRATION_GETBUILD_WEBHOOK_URL: `http://127.0.0.1:${port}/webhooks/integration/getproperty`,
      INTEGRATION_GETBUILD_SIGNING_KEYS: OUT_KEY,
      INTEGRATION_GETBUILD_VERIFY_KEYS: IN_KEY,
      INTEGRATION_GETPACK_TRANSPORT: 'none',
    });
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
    await new Promise((r) => partner.close(r));
  });

  async function outbound(key: string): Promise<string> {
    const envelope = { ...CONTRACT_FIXTURES['warranty.defect.reported'], idempotencyKey: key } as never;
    const row = await t.app
      .get(TenantTx)
      .platform((tx) =>
        t.app.get(IntegrationEventsService).outbound(tx, { platform: 'getbuild', envelope, tenantId: null }),
      );
    return row.id;
  }
  const status = async (id: string) =>
    (
      await db.admin.query<{ status: string; attempts: number; last_error: string | null }>(
        `SELECT status::text, attempts, last_error FROM bridge.integration_event WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  it('delivers a pending event, signed, once; the partner’s 2xx acknowledges it', async () => {
    const id = await outbound('getproperty:service_request:t16-1:reported');
    const delivery = t.app.get(IntegrationDeliveryService);
    expect(await delivery.sweep()).toBe(1);
    expect(await delivery.sweep()).toBe(0);
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.headers[WEBHOOK_HEADERS.source]).toBe('getproperty');
    expect(r.headers[WEBHOOK_HEADERS.eventId]).toBe('getproperty:service_request:t16-1:reported');
    expect(r.headers['idempotency-key']).toBe('getproperty:service_request:t16-1:reported');
    expect(verifyIntegrationWebhook({ keys: [OUT_KEY], body: r.body, headers: r.headers }).ok).toBe(true);
    expect(JSON.parse(r.body)).toMatchObject({ type: 'warranty.defect.reported' });
    expect(await status(id)).toMatchObject({ status: 'acked', attempts: 1, last_error: null });
  });

  it('a 5xx is retried later with backoff; a 422 parks the event dead; getpack (transport none) waits', async () => {
    const delivery = t.app.get(IntegrationDeliveryService);
    answer = 503;
    const id = await outbound('getproperty:service_request:t16-2:reported');
    expect(await delivery.sweep()).toBe(0);
    expect(await status(id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await delivery.sweep()).toBe(0); // not due yet
    expect(
      received.filter(
        (r) => r.headers[WEBHOOK_HEADERS.eventId] === 'getproperty:service_request:t16-2:reported',
      ),
    ).toHaveLength(1);
    t.clock.advance(31_000);
    answer = 200;
    expect(await delivery.sweep()).toBe(1);
    expect(await status(id)).toMatchObject({ status: 'acked', attempts: 2 });

    answer = 422;
    const bad = await outbound('getproperty:service_request:t16-3:reported');
    await delivery.sweep();
    expect(await status(bad)).toMatchObject({
      status: 'dead',
      attempts: 1,
      last_error: expect.stringContaining('422'),
    });
    answer = 200;
    expect(MAX_DELIVERY_ATTEMPTS).toBeGreaterThanOrEqual(10);

    const pack = await t.app.get(TenantTx).platform((tx) =>
      t.app.get(IntegrationEventsService).outbound(tx, {
        platform: 'getpack',
        envelope: {
          ...CONTRACT_FIXTURES['procurement.rfq.requested'],
          idempotencyKey: 'getproperty:rfq:t16:requested',
        } as never,
        tenantId: null,
      }),
    );
    await delivery.sweep();
    expect(await status(pack.id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('receives a signed event from getbuild once; refuses bad signatures, wrong sources and unknown platforms', async () => {
    const envelope = {
      ...CONTRACT_FIXTURES['warranty.defect.closed'],
      idempotencyKey: 'getbuild:defect:t16:closed',
    };
    const body = JSON.stringify(envelope);
    const now = Math.floor(t.clock.now().getTime() / 1000);
    const sign = (keys: string[], source = 'getbuild') =>
      signIntegrationWebhook({ keys, body, eventId: envelope.idempotencyKey, source, timestamp: now });
    const post = (headers: Record<string, string>, path = 'getbuild') =>
      t.http
        .post(`/webhooks/integration/${path}`)
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);

    const forged = await post(sign([OUT_KEY])).expect(401);
    expect(forged.body.code).toBe('webhook.signature_invalid');
    await post(sign([IN_KEY], 'getpack')).expect(401);
    await post(sign([IN_KEY]), 'getpop').expect(404);
    await post({ 'content-type': 'application/json' }).expect(401);

    const first = await post(sign([IN_KEY])).expect(200);
    expect(['applied', 'rejected']).toContain(first.body.status); // stored either way; the consumer decides
    const again = await post(sign([IN_KEY])).expect(200);
    expect(again.body).toEqual({ id: first.body.id, status: 'duplicate' });
    const stored = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bridge.integration_event WHERE direction = 'inbound' AND idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    expect(stored.rows[0]!.n).toBe(1);
  });
});

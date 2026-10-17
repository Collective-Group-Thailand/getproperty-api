import 'reflect-metadata';

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { connectAsync, type MqttClient } from 'mqtt';

import { createIntDatabase, type IntDatabase } from '../support/int-db';
import { startTestBroker, type TestBroker } from '../support/mqtt-broker';

/** `pnpm sim:gateway --setup --once` against a seeded database and the test broker. */
describe('pnpm sim:gateway', () => {
  let broker: TestBroker;
  let db: IntDatabase;
  let client: MqttClient;

  beforeAll(async () => {
    broker = await startTestBroker();
    db = await createIntDatabase({ prefix: 'gp_sim' });
    client = await connectAsync(broker.url, { protocolVersion: 4, clientId: 'sim-observer' });
  });
  afterAll(async () => {
    await client?.endAsync();
    await db?.drop();
    await broker?.stop();
  });

  it('creates a simulated gateway with 6 meter channels and publishes telemetry + health', async () => {
    const seen: {
      topic: string;
      body: { readings?: { meterId: string; seq: number; register: string }[] };
    }[] = [];
    client.on('message', (topic, payload) =>
      seen.push({ topic, body: JSON.parse(payload.toString('utf8')) }),
    );
    await client.subscribeAsync('gp/v1/+/+', { qos: 1 });
    const run = (extra: string[]) =>
      spawnSync(
        process.execPath,
        [
          join(__dirname, '../../scripts/sim-gateway.mjs'),
          '--once',
          '--url',
          broker.url,
          '--database',
          db.url,
          ...extra,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, MQTT_PROTOCOL_VERSION: '4' },
        },
      );
    const first = run(['--setup']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('6 meter channel(s) ready');
    await new Promise((r) => setTimeout(r, 300));
    const telemetry = seen.filter((m) => m.topic.endsWith('/telemetry'));
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]!.body.readings).toHaveLength(6);
    expect(seen.some((m) => m.topic.endsWith('/health'))).toBe(true);
    const channels = await db.admin.query(
      `SELECT count(*)::int AS n FROM smart.meter_channel WHERE valid_to IS NULL`,
    );
    expect(channels.rows[0].n).toBe(6);
    // a second run (setup is idempotent) continues seq/registers from the database, never backwards
    await db.admin.query(`UPDATE smart.device SET last_seq = 41 WHERE kind = 'electric_meter'`);
    expect(run(['--setup']).status).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    const second = seen.filter((m) => m.topic.endsWith('/telemetry'))[1]!;
    expect(second.body.readings!.every((r) => r.seq === 42)).toBe(true);
  });
});

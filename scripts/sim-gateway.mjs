#!/usr/bin/env node
// `pnpm sim:gateway` — a fake gateway for development (B3.2): publishes TelemetryBatch and Health messages
// (contract/device-protocol.json) for the gateways and meter channels of a seeded building, so the ingest process,
// the rollups and the series endpoints have data without hardware.
//
//   pnpm sim:gateway --setup            create a simulated gateway + 6 electric meter devices bound to A-101…A-106
//                                       of the development building (`pnpm db:seed:dev`), then publish
//   pnpm sim:gateway                    publish every --interval seconds for every gateway with open channels
//   options: --building <uuid>  --interval <s> (5)  --count <n> (∞)  --once  --duplicates <pct> (0)
//            --url <mqtt://…> (MQTT_URL)  --broker (start the in-process aedes broker on the --url port)
//            --database <postgres://…> (DATABASE_ADMIN_URL | DATABASE_URL)
//
// Registers continue from the last telemetry point (or accepted reading) of each meter; `seq` continues from the
// device's `last_seq`, so restarts never go backwards (D-030, D-143). The gateway publishes with QoS 1 like the
// agent; the broker must let it (EMQX dev config, or `--broker`).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import * as mqtt from 'mqtt';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_BUILDING = '0199f2a0-0000-7000-8000-000000000004';
const DEV_TENANT = '0199f2a0-0000-7000-8000-000000000001';

function loadDotEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const { values: args } = parseArgs({
  options: {
    building: { type: 'string', default: DEV_BUILDING },
    interval: { type: 'string', default: '5' },
    count: { type: 'string' },
    once: { type: 'boolean', default: false },
    duplicates: { type: 'string', default: '0' },
    url: { type: 'string' },
    broker: { type: 'boolean', default: false },
    database: { type: 'string' },
    setup: { type: 'boolean', default: false },
  },
});

loadDotEnv();
const mqttUrl = args.url ?? process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const databaseUrl = args.database ?? process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('sim:gateway: set DATABASE_URL (or --database) to the development database');
  process.exit(1);
}
const iterations = args.once ? 1 : args.count ? Number(args.count) : Infinity;
const intervalMs = Math.max(1, Number(args.interval)) * 1000;
const duplicatePct = Math.min(100, Math.max(0, Number(args.duplicates)));

let brokerProcess;
async function startBroker() {
  const port = new URL(mqttUrl).port || '1883';
  brokerProcess = spawn(process.execPath, [join(root, 'test/support/mqtt-broker.mjs'), port], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    brokerProcess.stdout.once('data', resolve);
    brokerProcess.once('exit', (code) => reject(new Error(`broker exited (${code})`)));
  });
  console.log(
    `sim:gateway: in-process MQTT broker on ${port} (MQTT 3.1.1; run the API with MQTT_PROTOCOL_VERSION=4 MQTT_SHARED_SUBSCRIPTION=false)`,
  );
}

const db = new pg.Client({ connectionString: databaseUrl });

async function setup() {
  await db.query('BEGIN');
  try {
    const gw = await db.query(
      `INSERT INTO smart.device (serial, kind, model, vendor, ownership, tenant_id, building_id, status, arch)
       SELECT 'GP-GW-SIM-0001', 'gateway', 'simulator', 'Collective', 'platform_haas', b.operator_tenant_id, b.id, 'online', 'x64'
         FROM core.building b WHERE b.id = $1
       ON CONFLICT (serial) DO UPDATE SET status = 'online' RETURNING id, tenant_id`,
      [args.building],
    );
    if (!gw.rows[0]) throw new Error(`building ${args.building} not found — run pnpm db:seed:dev`);
    const { id: gatewayId, tenant_id: tenantId } = gw.rows[0];
    const meters = await db.query(
      `SELECT a.id, u.unit_no FROM core.asset_item a JOIN core.unit u ON u.id = a.unit_id
        WHERE a.building_id = $1 AND a.category = 'meter_electric' AND a.deleted_at IS NULL
          AND u.unit_no IN ('A-101','A-102','A-103','A-104','A-105','A-106') ORDER BY u.unit_no`,
      [args.building],
    );
    let address = 1;
    for (const m of meters.rows) {
      const device = await db.query(
        `INSERT INTO smart.device (serial, kind, model, vendor, driver, ownership, tenant_id, building_id, asset_item_id,
                                   gateway_device_id, status)
         VALUES ($1, 'electric_meter', 'SDM120', 'Eastron', 'sdm120', 'tenant_owned', $2, $3, $4, $5, 'online')
         ON CONFLICT (serial) DO UPDATE SET status = 'online' RETURNING id`,
        [`SIM-${m.unit_no}`, tenantId ?? DEV_TENANT, args.building, m.id, gatewayId],
      );
      await db.query(
        `INSERT INTO smart.meter_channel (tenant_id, building_id, meter_asset_item_id, meter_device_id, gateway_device_id,
                                          bus_id, bus_type, address, driver, valid_from)
         SELECT $1, $2, $3, $4, $5, 'rs485-1', 'modbus_rtu', $6, 'sdm120', now()
          WHERE NOT EXISTS (SELECT 1 FROM smart.meter_channel c WHERE c.meter_asset_item_id = $3 AND c.valid_to IS NULL)`,
        [tenantId ?? DEV_TENANT, args.building, m.id, device.rows[0].id, gatewayId, address],
      );
      address += 1;
    }
    await db.query('COMMIT');
    console.log(`sim:gateway: gateway ${gatewayId} with ${meters.rows.length} meter channel(s) ready`);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function channels() {
  const { rows } = await db.query(
    `SELECT c.gateway_device_id AS gateway, c.meter_device_id AS meter, a.category,
            coalesce(d.last_seq, -1) AS last_seq,
            coalesce((SELECT max(t.register) FROM smart.telemetry_point t WHERE t.device_id = c.meter_device_id),
                     (SELECT r.register FROM smart.meter_reading r WHERE r.asset_item_id = c.meter_asset_item_id
                         AND r.review_state = 'accepted' ORDER BY r.read_at DESC LIMIT 1), 0)::text AS register
       FROM smart.meter_channel c
       JOIN core.asset_item a ON a.id = c.meter_asset_item_id
       JOIN smart.device d ON d.id = c.meter_device_id
      WHERE c.building_id = $1 AND c.valid_to IS NULL AND c.meter_device_id IS NOT NULL
        AND c.bus_type IN ('modbus_rtu', 'gpio')`,
    [args.building],
  );
  return rows;
}

function round3(n) {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

async function main() {
  await db.connect();
  if (args.setup) await setup();
  if (args.broker) await startBroker();
  const meters = await channels();
  if (!meters.length) {
    console.error('sim:gateway: no open meter channels in the building — install meters or run with --setup');
    process.exit(1);
  }
  const state = new Map(
    meters.map((m) => [m.meter, { seq: Number(m.last_seq) + 1, register: Number(m.register) }]),
  );
  const gateways = [...new Set(meters.map((m) => m.gateway))];
  const client = await mqtt.connectAsync(mqttUrl, {
    clientId: `gp-sim-${process.pid}`,
    protocolVersion: Number(process.env.MQTT_PROTOCOL_VERSION ?? 4),
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  });
  console.log(`sim:gateway: ${gateways.length} gateway(s), ${meters.length} meter(s) → ${mqttUrl}`);
  const sent = [];
  for (let i = 0; i < iterations; i += 1) {
    const now = new Date();
    for (const gateway of gateways) {
      const readings = meters
        .filter((m) => m.gateway === gateway)
        .map((m) => {
          const s = state.get(m.meter);
          s.register +=
            m.category === 'meter_water' ? 0.002 + Math.random() * 0.02 : 0.05 + Math.random() * 0.35;
          const reading = {
            meterId: m.meter,
            seq: s.seq,
            readAt: now.toISOString(),
            register: round3(s.register),
            unit: m.category === 'meter_water' ? 'm3' : 'kwh',
            quality: 'good',
            extra:
              m.category === 'meter_water'
                ? { flowLpm: 0 }
                : { voltage: 228 + Math.random() * 4, powerW: 300 + Math.random() * 900 },
          };
          s.seq += 1;
          return reading;
        });
      if (duplicatePct > 0)
        readings.push(...sent.filter(() => Math.random() * 100 < duplicatePct).slice(0, 20));
      const unique = [...new Map(readings.map((r) => [`${r.meterId}|${r.seq}`, r])).values()];
      sent.splice(0, sent.length, ...unique.slice(-50));
      const batch = { gatewayId: gateway, configVersion: 1, sentAt: now.toISOString(), readings: unique };
      await client.publishAsync(`gp/v1/${gateway}/telemetry`, JSON.stringify(batch), { qos: 1 });
      if (i % 12 === 0)
        await client.publishAsync(
          `gp/v1/${gateway}/health`,
          JSON.stringify({
            gatewayId: gateway,
            agentVersion: '0.0.0-sim',
            configVersion: 1,
            uptimeS: Math.round(process.uptime()),
            bufferedReadings: 0,
            diskFreeMb: 1024,
            cpuPct: 3,
            memPct: 20,
            link: 'ethernet',
            rssi: null,
            meters: meters
              .filter((m) => m.gateway === gateway)
              .map((m) => ({ meterId: m.meter, lastReadAt: now.toISOString(), status: 'ok' })),
          }),
          { qos: 1 },
        );
      console.log(`sim:gateway: ${gateway} published ${unique.length} reading(s)`);
    }
    if (i + 1 < iterations) await new Promise((r) => setTimeout(r, intervalMs));
  }
  await client.endAsync();
  await db.end();
  brokerProcess?.kill('SIGTERM');
}

main().catch((error) => {
  console.error(`sim:gateway: ${error.message}`);
  brokerProcess?.kill('SIGTERM');
  process.exit(1);
});

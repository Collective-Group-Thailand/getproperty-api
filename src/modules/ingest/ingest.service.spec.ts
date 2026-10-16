import { FakeMqttClient } from '@integrations/mqtt/fake-mqtt-client';
import { topicMatches } from '@integrations/mqtt/mqtt-client.port';
import { Logger } from '@nestjs/common';

import { IngestService } from './ingest.service';
import { ingestFilters } from './ingest.subscriber';
import { MAX_READINGS_PER_BATCH } from './protocol/formats';

const GW = '2f6c1d7e-9a3b-4c5d-8e7f-0a1b2c3d4e5f';
const METER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const reading = (seq: number, extra: Record<string, unknown> = {}) => ({
  meterId: METER,
  seq,
  readAt: '2026-11-01T00:15:00+07:00',
  register: '12345.678',
  unit: 'kwh',
  quality: 'good',
  ...extra,
});

const batch = (readings: unknown[]) => ({
  gatewayId: GW,
  configVersion: 12,
  sentAt: '2026-11-01T00:15:03+07:00',
  readings,
});

describe('IngestService (MQTT DTO validation, device-protocol.md)', () => {
  let ingest: IngestService;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterAll(() => {
    Logger.overrideLogger(['log', 'warn', 'error']);
  });

  beforeEach(() => {
    ingest = new IngestService();
  });

  it('accepts a valid telemetry batch and summarises it', async () => {
    const outcome = await ingest.handle(
      `gp/v1/${GW}/telemetry`,
      JSON.stringify(batch([reading(1), reading(2, { extra: { voltage: 228.1 } })])),
    );
    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') return;
    expect(outcome.kind).toBe('telemetry');
    expect(outcome.summary).toBe(`telemetry gw=${GW} cfg=12 readings=2 meters=1`);
    expect(ingest.counters).toMatchObject({ accepted: 1, rejected: 0 });
  });

  it('refuses a batch that repeats a (meterId, seq) pair', async () => {
    const outcome = await ingest.handle(
      `gp/v1/${GW}/telemetry`,
      JSON.stringify(batch([reading(5), reading(5)])),
    );
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'invalid_payload' });
    expect((outcome as { detail?: string }).detail).toContain('readings:uniqueReadingSeq');
  });

  it('refuses invalid payloads: wrong register format, unknown unit, unknown field, too many readings, JSON number money', async () => {
    const cases: unknown[] = [
      batch([reading(1, { register: 12345.678 })]),
      batch([reading(1, { register: '1234567890.1' })]),
      batch([reading(1, { unit: 'litre' })]),
      batch([reading(1, { bogus: true })]),
      batch(Array.from({ length: MAX_READINGS_PER_BATCH + 1 }, (_, i) => reading(i))),
      batch([]),
      { ...batch([reading(1)]), gatewayId: 'not-a-uuid' },
    ];
    for (const payload of cases) {
      const outcome = await ingest.handle(`gp/v1/${GW}/telemetry`, JSON.stringify(payload));
      expect(outcome).toMatchObject({ status: 'rejected', reason: 'invalid_payload' });
    }
    expect(ingest.counters.rejected).toBe(cases.length);
    expect(ingest.counters.byReason.invalid_payload).toBe(cases.length);
  });

  it('refuses malformed JSON, unknown topics and a body gatewayId that differs from the topic', async () => {
    expect(await ingest.handle(`gp/v1/${GW}/telemetry`, '{not json')).toMatchObject({
      reason: 'malformed_json',
    });
    expect(await ingest.handle(`gp/v1/${GW}/config`, '{}')).toMatchObject({ reason: 'unknown_topic' });
    expect(await ingest.handle('other/topic', '{}')).toMatchObject({ reason: 'unknown_topic' });
    expect(
      await ingest.handle(`gp/v1/${METER}/telemetry`, JSON.stringify(batch([reading(1)]))),
    ).toMatchObject({ reason: 'gateway_mismatch' });
  });

  it('recognises the broker LWT on the health topic', async () => {
    expect(await ingest.handle(`gp/v1/${GW}/health`, '{"status":"offline_lwt"}')).toEqual({
      status: 'lwt',
      gatewayId: GW,
    });
    expect(ingest.counters.lwt).toBe(1);
  });

  it('validates health, events and command acks', async () => {
    const health = {
      gatewayId: GW,
      agentVersion: '1.4.2',
      configVersion: 12,
      uptimeS: 86400,
      bufferedReadings: 0,
      diskFreeMb: 1800,
      cpuPct: 7,
      memPct: 31,
      link: 'ethernet',
      rssi: null,
      meters: [
        { meterId: METER, lastReadAt: '2026-11-01T00:15:00+07:00', status: 'ok' },
        { meterId: METER, lastReadAt: null, status: 'timeout' },
      ],
    };
    expect(await ingest.handle(`gp/v1/${GW}/health`, JSON.stringify(health))).toMatchObject({
      status: 'accepted',
      summary: `health gw=${GW} agent=1.4.2 cfg=12 buffered=0 meters=2 notOk=1`,
    });
    expect(
      await ingest.handle(`gp/v1/${GW}/health`, JSON.stringify({ ...health, cpuPct: 101 })),
    ).toMatchObject({ reason: 'invalid_payload' });

    const event = {
      eventId: '3b241101-e2bb-4255-8caf-4136c566a962',
      gatewayId: GW,
      type: 'config_applied',
      severity: 'info',
      occurredAt: '2026-11-01T00:15:00+07:00',
      configVersion: '12',
    };
    expect(await ingest.handle(`gp/v1/${GW}/events`, JSON.stringify(event))).toMatchObject({
      status: 'accepted',
      summary: `event gw=${GW} type=config_applied severity=info`,
    });

    const ack = {
      cmdId: '3b241101-e2bb-4255-8caf-4136c566a962',
      status: 'done',
      result: {},
      error: null,
      finishedAt: '2026-11-01T00:15:04+07:00',
    };
    expect(await ingest.handle(`gp/v1/${GW}/cmd/ack`, JSON.stringify(ack))).toMatchObject({
      status: 'accepted',
      kind: 'cmd/ack',
    });
  });

  it('is fed by the fake broker through the shared-subscription filters', async () => {
    const mqtt = new FakeMqttClient();
    const filters = ingestFilters('ingest');
    expect(filters).toEqual([
      '$share/ingest/gp/v1/+/telemetry',
      '$share/ingest/gp/v1/+/health',
      '$share/ingest/gp/v1/+/events',
      '$share/ingest/gp/v1/+/cmd/ack',
    ]);
    expect(topicMatches('$share/ingest/gp/v1/+/telemetry', `gp/v1/${GW}/telemetry`)).toBe(true);
    expect(topicMatches('gp/v1/+/telemetry', `gp/v1/${GW}/health`)).toBe(false);
    expect(topicMatches('gp/v1/+/#', `gp/v1/${GW}/cmd/ack`)).toBe(true);

    const handled: string[] = [];
    mqtt.onMessage(async ({ topic, payload }) => {
      const outcome = await ingest.handle(topic, payload);
      handled.push(outcome.status);
    });
    await mqtt.subscribe(filters, { qos: 1 });
    await mqtt.publish(`gp/v1/${GW}/telemetry`, JSON.stringify(batch([reading(1)])), { qos: 1 });
    await mqtt.publish(`gp/v1/${GW}/config`, '{}', { qos: 1, retain: true }); // cloud → gateway, not subscribed
    expect(handled).toEqual(['accepted']);
    expect(mqtt.published).toHaveLength(2);
  });
});

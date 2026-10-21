import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { buildDeviceProtocolSchema, PROTOCOL_PAYLOADS } from './device-protocol-schema';

describe('device-protocol.json generation', () => {
  const schema = buildDeviceProtocolSchema('0.1.0') as {
    $defs: Record<string, Record<string, unknown>>;
  } & Record<string, unknown>;

  it('is deterministic (byte-for-byte on repeated builds)', () => {
    expect(JSON.stringify(buildDeviceProtocolSchema('0.1.0'))).toBe(JSON.stringify(schema));
    const keys = Object.keys(schema);
    expect(keys).toEqual([...keys].sort());
  });

  it('is a draft 2020-12 document with one definition per payload class and named enums', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    for (const payload of PROTOCOL_PAYLOADS) expect(schema.$defs[payload.name]).toBeDefined();
    for (const name of [
      'MeterUnit',
      'ReadingQuality',
      'LinkType',
      'MeterHealthStatus',
      'DeviceEventType',
      'BusType',
      'CommandType',
      'CommandAckStatus',
    ]) {
      expect(schema.$defs[name]).toMatchObject({ type: 'string' });
      expect(Array.isArray(schema.$defs[name]!.enum)).toBe(true);
    }
    expect(schema.$defs.Reading!.properties).toMatchObject({
      unit: { $ref: '#/$defs/MeterUnit' },
      quality: { $ref: '#/$defs/ReadingQuality' },
      register: { type: 'string', pattern: '^\\d{1,9}(\\.\\d{1,3})?$' },
      readAt: { type: 'string', format: 'date-time' },
    });
    expect(schema.$defs.TelemetryBatch!.properties).toMatchObject({
      readings: { items: { $ref: '#/$defs/Reading' }, maxItems: 200, minItems: 1 },
    });
    expect(schema.$defs.MeterHealth!.required).toEqual(['lastReadAt', 'meterId', 'status']);
    expect(schema.$defs.MeterUnit!.enum).toEqual(['kwh', 'm3']);
    expect(schema['x-topics']).toHaveProperty(
      'gp/v1/<gatewayId>/config',
      expect.objectContaining({ retained: true }),
    );
  });

  it('protocol 1.2 publishes the MQTT identity and the exact gateway ACL (D-235, T-9)', () => {
    const schema = buildDeviceProtocolSchema('0.0.0-test') as unknown as {
      'x-protocol-version': string;
      'x-acl': { publish: string[] };
      'x-mqtt-auth': { transports: Record<string, unknown> };
    };
    expect(schema['x-protocol-version']).toBe('1.2');
    expect(schema['x-acl'].publish).toEqual([
      'gp/v1/<gatewayId>/telemetry',
      'gp/v1/<gatewayId>/health',
      'gp/v1/<gatewayId>/events',
      'gp/v1/<gatewayId>/cmd/ack',
    ]);
    expect(schema['x-acl'].publish.some((t) => t.endsWith('/+'))).toBe(false);
    expect(Object.keys(schema['x-mqtt-auth'].transports)).toEqual(['mtls', 'ws']);
  });

  it('validates the documented payload examples with a JSON Schema validator (edge-side behaviour)', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(schema);
    const validate = (name: string, value: unknown) =>
      ajv.validate(`${String(schema.$id)}#/$defs/${name}`, value);

    expect(
      validate('TelemetryBatch', {
        gatewayId: '2f6c1d7e-9a3b-4c5d-8e7f-0a1b2c3d4e5f',
        configVersion: 12,
        sentAt: '2026-11-01T00:15:03+07:00',
        readings: [
          {
            meterId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            seq: 48213,
            readAt: '2026-11-01T00:15:00+07:00',
            register: '12345.678',
            unit: 'kwh',
            quality: 'good',
            extra: { voltage: 228.1, current: 3.2, powerW: 710 },
          },
        ],
      }),
    ).toBe(true);
    expect(validate('TelemetryBatch', { gatewayId: 'x', readings: [] })).toBe(false);
    expect(
      validate('GatewayConfig', {
        version: 12,
        pollIntervalS: 900,
        heartbeatS: 60,
        buses: [{ id: 'rs485-1', type: 'modbus_rtu', device: '/dev/ttyUSB0', baud: 9600, parity: 'none' }],
        meters: [
          {
            meterId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            roomCode: 'A-201',
            driver: 'eastron_sdm120',
            bus: 'rs485-1',
            address: 21,
            unit: 'kwh',
            registerMap: 'driver_default',
            scale: '1',
          },
          {
            meterId: 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            roomCode: 'A-201W',
            driver: 'pulse_counter',
            bus: 'gpio',
            pin: 17,
            unit: 'm3',
            litresPerPulse: 10,
            initialRegister: '1532.040',
          },
        ],
      }),
    ).toBe(true);
    expect(
      validate('Command', {
        cmdId: '3b241101-e2bb-4255-8caf-4136c566a962',
        type: 'read_now',
        args: { meterIds: ['x'] },
        issuedAt: '2026-11-01T00:15:00+07:00',
      }),
    ).toBe(true);
    expect(
      validate('CommandAck', {
        cmdId: '3b241101-e2bb-4255-8caf-4136c566a962',
        status: 'done',
        result: {},
        error: null,
        finishedAt: '2026-11-01T00:15:04+07:00',
      }),
    ).toBe(true);
    expect(validate('CommandAck', { cmdId: '3b241101-e2bb-4255-8caf-4136c566a962', status: 'maybe' })).toBe(
      false,
    );
  });

  it('matches the committed contract/device-protocol.json when it exists', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    const file = `${process.cwd()}/contract/device-protocol.json`;
    if (!existsSync(file)) return;
    const committed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect({ ...schema, 'x-api-version': committed['x-api-version'] }).toEqual(committed);
  });
});

import { generateKeyPairSync, sign } from 'node:crypto';

import { DomainException } from '@common/errors/domain.exception';
import { validateAs } from '@common/validation/validation';
import { GatewayConfig } from '@modules/ingest/protocol/config.dto';

import { commandArgs } from './commands.service';
import { type ChannelInput, compileGatewayConfig, configContentHash } from './config-compiler';
import {
  canonicalManifest,
  compareSemver,
  deviceArtifact,
  deviceUrl,
  manifestProblems,
  type OtaManifest,
  rolloutNextActions,
  verifyManifest,
} from './ota.service';

const M1 = '0192a000-0000-7000-8000-000000000001';
const M2 = '0192a000-0000-7000-8000-000000000002';

const electric: ChannelInput = {
  meterDeviceId: M2,
  roomCode: 'A-201',
  utility: 'electric',
  driver: 'sdm120',
  busId: 'rs485-1',
  busType: 'modbus_rtu',
  address: 12,
  pin: null,
  registerMap: 'driver_default',
  customRegisterMap: null,
  scale: '1.000',
  litresPerPulse: null,
  initialRegister: null,
};
const water: ChannelInput = {
  meterDeviceId: M1,
  roomCode: 'A-201',
  utility: 'water',
  driver: 'pulse',
  busId: 'gpio',
  busType: 'gpio',
  address: null,
  pin: 17,
  registerMap: 'driver_default',
  customRegisterMap: null,
  scale: '1',
  litresPerPulse: '10',
  initialRegister: '812.4',
};

/** Golden: the B3.1 acceptance building (2 meters on one gateway) → config v1. */
const GOLDEN_V1 = {
  buses: [
    { id: 'gpio', type: 'gpio' },
    { baud: 9600, device: '/dev/ttyUSB0', id: 'rs485-1', parity: 'none', type: 'modbus_rtu' },
  ],
  heartbeatS: 60,
  meters: [
    {
      bus: 'gpio',
      driver: 'pulse',
      initialRegister: '812.400',
      litresPerPulse: 10,
      meterId: M1,
      pin: 17,
      registerMap: 'driver_default',
      roomCode: 'A-201',
      scale: '1',
      unit: 'm3',
    },
    {
      address: 12,
      bus: 'rs485-1',
      driver: 'sdm120',
      meterId: M2,
      registerMap: 'driver_default',
      roomCode: 'A-201',
      scale: '1',
      unit: 'kwh',
    },
  ],
  pollIntervalS: 900,
  version: 1,
};

describe('gateway config compiler (D-131, protocol §3)', () => {
  const compile = (version: number, channels: ChannelInput[]) =>
    compileGatewayConfig({ version, pollIntervalS: 900, heartbeatS: 60, configuredBuses: [], channels });

  it('compiles the golden v1 document, valid against the protocol GatewayConfig', async () => {
    const doc = compile(1, [electric, water]);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(GOLDEN_V1);
    expect(JSON.stringify(doc)).toBe(JSON.stringify(GOLDEN_V1));
    await expect(validateAs(GatewayConfig, JSON.parse(JSON.stringify(doc)))).resolves.toBeDefined();
  });

  it('is deterministic: channel order does not matter and an unchanged content hashes the same', () => {
    const a = compile(1, [electric, water]);
    const b = compile(7, [water, electric]);
    expect(configContentHash(a).equals(configContentHash(b))).toBe(true);
    const c = compile(2, [electric, { ...water, meterDeviceId: '0192a000-0000-7000-8000-000000000003' }]);
    expect(configContentHash(a).equals(configContentHash(c))).toBe(false);
  });

  it('emits a custom register map only for registerMap = custom and drops cloud-to-cloud meters', async () => {
    const custom = {
      energy: { address: 342, function: 'input', dataType: 'float32', wordOrder: 'big_endian', scale: '1' },
    };
    const doc = compile(3, [
      { ...electric, registerMap: 'custom', customRegisterMap: custom },
      { ...water, meterDeviceId: '0192a000-0000-7000-8000-000000000009', busType: 'nb_iot', busId: 'nb' },
    ]);
    expect(doc.meters).toHaveLength(1);
    expect(doc.meters[0]!.customRegisterMap).toEqual(custom);
    expect(doc.buses.map((b) => b.id)).toEqual(['rs485-1']);
    await expect(validateAs(GatewayConfig, JSON.parse(JSON.stringify(doc)))).resolves.toBeDefined();
  });
});

describe('gateway commands (protocol §2, D-131)', () => {
  it('validates and normalises arguments', () => {
    expect(commandArgs('identify', undefined)).toEqual({ seconds: 30 });
    expect(commandArgs('upload_logs', { hours: 2 })).toEqual({ hours: 2 });
    expect(commandArgs('read_now', { meterIds: [M1] })).toEqual({ meterIds: [M1] });
    expect(commandArgs('restart', { anything: 1 })).toEqual({});
    expect(() => commandArgs('identify', { seconds: 9999 })).toThrow(DomainException);
    expect(() => commandArgs('set_log_level', { level: 'trace' })).toThrow(DomainException);
    expect(() => commandArgs('ota_apply', { manifestUrl: 'ftp://x' })).toThrow(DomainException);
    // relative device paths (protocol §6, D-231) and absolute https URLs; nothing else
    expect(commandArgs('ota_apply', { manifestUrl: '/v1/device/ota/manifest?releaseId=x' })).toEqual({
      manifestUrl: '/v1/device/ota/manifest?releaseId=x',
    });
    expect(
      commandArgs('ota_apply', { manifestUrl: 'https://device.getproperty.co/v1/device/ota/manifest' }),
    ).toEqual({ manifestUrl: 'https://device.getproperty.co/v1/device/ota/manifest' });
    for (const bad of ['/v1/owner/x', '//evil.example/v1/device/x', 'https://', 'javascript:alert(1)'])
      expect(() => commandArgs('ota_apply', { manifestUrl: bad })).toThrow(DomainException);
  });
});

describe('device-facing URLs (D-231, edge CR-012)', () => {
  it('builds device URLs on the device host or relative, never on the public API host', () => {
    expect(deviceUrl(undefined, '/v1/device/ota/manifest?releaseId=r')).toBe(
      '/v1/device/ota/manifest?releaseId=r',
    );
    expect(deviceUrl('https://device.getproperty.co', '/v1/device/ota/manifest?releaseId=r')).toBe(
      'https://device.getproperty.co/v1/device/ota/manifest?releaseId=r',
    );
  });

  it('maps device-hosted artefact URLs to the releases prefix and nothing else', () => {
    const file = 'getproperty-edge-0.4.0-linux-arm64';
    expect(deviceArtifact(`https://device.getproperty.co/v1/device/ota/artifacts/0.4.0/${file}`)).toEqual({
      version: '0.4.0',
      file,
      key: `releases/edge/0.4.0/${file}`,
    });
    expect(deviceArtifact(`/v1/device/ota/artifacts/0.4.0-rc.1/${file}`)?.key).toBe(
      `releases/edge/0.4.0-rc.1/${file}`,
    );
    for (const other of [
      'https://releases.getproperty.co/edge/0.4.0/x',
      'https://device.getproperty.co/v1/device/ota/artifacts/0.4.0',
      'https://device.getproperty.co/v1/device/ota/artifacts/latest/x',
      'https://device.getproperty.co/v1/device/ota/artifacts/0.4.0/a/b',
      'https://device.getproperty.co/v1/device/ota/artifacts/0.4.0/..',
      'https://device.getproperty.co/v1/device/ota/artifacts/0.4.0/x..y',
      'https://device.getproperty.co/v1/device/ota/artifacts/0.4.0/%2e%2e%2fsecret',
    ])
      expect(deviceArtifact(other)).toBeNull();
  });
});

describe('OTA manifests and rollouts (D-131, edge CR-011)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const unsigned = {
    schema: 1 as const,
    version: '0.4.0',
    channel: 'stable' as const,
    arch: 'arm64' as const,
    artifact: {
      url: 'https://releases.getproperty.co/edge/0.4.0/arm64.tar.zst',
      sha256: 'a'.repeat(64),
      size: 1234,
    },
    minAgentVersion: '0.3.0',
    releasedAt: '2026-10-15T09:00:00Z',
  };
  const signed = (m = unsigned): OtaManifest => ({
    ...m,
    signature: {
      alg: 'ed25519',
      keyId: 'k1',
      value: sign(null, Buffer.from(canonicalManifest(m)), privateKey).toString('base64'),
    },
  });

  it('verifies the ed25519 signature over the canonical manifest (raw or PEM key)', () => {
    expect(verifyManifest(signed(), { k1: raw })).toBe(true);
    expect(
      verifyManifest(signed(), { k1: publicKey.export({ format: 'pem', type: 'spki' }).toString() }),
    ).toBe(true);
    expect(manifestProblems(signed())).toEqual([]);
  });

  it('refuses a tampered manifest, an unknown key id or a malformed shape', () => {
    const tampered = { ...signed(), artifact: { ...unsigned.artifact, size: 9999 } };
    expect(verifyManifest(tampered, { k1: raw })).toBe(false);
    expect(verifyManifest(signed(), { other: raw })).toBe(false);
    expect(
      manifestProblems({ ...signed(), version: 'v1', artifact: { ...unsigned.artifact, url: 'http://x' } }),
    ).toEqual(['version must be semver', 'artifact.url must be https']);
  });

  it('orders versions by semver and lists rollout actions per status', () => {
    expect(['0.10.0', '0.4.0', '0.4.0-rc.1', '1.0.0'].sort(compareSemver)).toEqual([
      '0.4.0-rc.1',
      '0.4.0',
      '0.10.0',
      '1.0.0',
    ]);
    expect(rolloutNextActions('planned')).toEqual(['start', 'abort']);
    expect(rolloutNextActions('running')).toEqual(['pause', 'abort']);
    expect(rolloutNextActions('paused')).toEqual(['resume', 'abort']);
    expect(rolloutNextActions('completed')).toEqual([]);
  });
});

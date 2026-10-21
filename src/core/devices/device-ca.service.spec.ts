import 'reflect-metadata';

import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AppConfig } from '@config/app-config';
import * as x509 from '@peculiar/x509';

import { DeviceCaService, pemCertificates } from './device-ca.service';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

async function selfSignedCa(name: string): Promise<{ cert: string; key: string }> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return { cert: cert.toString('pem'), key: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY') };
}

const configOf = (values: Record<string, unknown>) =>
  ({ get: (k: string) => values[k], isTest: true }) as unknown as AppConfig;
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('DeviceCaService — the platform device CA secret (T-6)', () => {
  it('hands gateways DEVICE_CA_CHAIN when set (base64 as rendered from collective/<env>/platform/device-ca)', async () => {
    const issuing = await selfSignedCa('getproperty device CA');
    const root = await selfSignedCa('Collective root');
    const ca = new DeviceCaService(
      configOf({
        DEVICE_CA_CERT: b64(issuing.cert),
        DEVICE_CA_KEY: b64(issuing.key),
        DEVICE_CA_CHAIN: b64(`${issuing.cert}\n${root.cert}`),
      }),
    );
    await ca.onModuleInit();
    expect(ca.caCertificatePem.trim()).toBe(issuing.cert.trim());
    expect(pemCertificates(ca.caChainPem)).toHaveLength(2);
  });

  it('falls back to the issuing CA and refuses a chain without it', async () => {
    const issuing = await selfSignedCa('getproperty device CA');
    const other = await selfSignedCa('someone else');
    const alone = new DeviceCaService(configOf({ DEVICE_CA_CERT: issuing.cert, DEVICE_CA_KEY: issuing.key }));
    await alone.onModuleInit();
    expect(alone.caChainPem).toBe(alone.caCertificatePem);
    const wrong = new DeviceCaService(
      configOf({ DEVICE_CA_CERT: issuing.cert, DEVICE_CA_KEY: issuing.key, DEVICE_CA_CHAIN: other.cert }),
    );
    await expect(wrong.onModuleInit()).rejects.toThrow('DEVICE_CA_CHAIN does not contain DEVICE_CA_CERT');
  });

  it('pnpm device:broker-cert writes the platform secret JSON (0600) with a broker certificate from the CA', async () => {
    const issuing = await selfSignedCa('getproperty device CA');
    const out = mkdtempSync(join(tmpdir(), 'gp-broker-'));
    execFileSync(process.execPath, ['scripts/broker-cert.mjs', '--host', 'mqtt.test.invalid', '--out', out], {
      env: { ...process.env, DEVICE_CA_CERT: b64(issuing.cert), DEVICE_CA_KEY: b64(issuing.key) },
      stdio: 'pipe',
    });
    const file = join(out, 'device-ca-secret.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const secret = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    // the keys collective-infra's render-device-ca.sh and getproperty hook read (PEM strings)
    expect(Object.keys(secret).sort()).toEqual([
      'broker_cert_pem',
      'broker_key_pem',
      'ca_chain_pem',
      'issuing_cert_pem',
      'issuing_key_pem',
    ]);
    expect(secret.issuing_cert_pem!.trim()).toBe(issuing.cert.trim());
    expect(secret.broker_key_pem).toContain('BEGIN PRIVATE KEY');
    const broker = pemCertificates(secret.broker_cert_pem!);
    expect(broker).toHaveLength(2); // leaf + issuing CA
    const caCert = new x509.X509Certificate(issuing.cert);
    expect(broker[0]!.subject).toBe('CN=mqtt.test.invalid');
    expect(await broker[0]!.verify({ publicKey: caCert.publicKey, signatureOnly: true })).toBe(true);
  });
});

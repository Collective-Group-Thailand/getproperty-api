// `pnpm device:broker-cert --host mqtt.getproperty.co [--out dir] [--days 397]` — issues the TLS server certificate
// of getproperty's EMQX device listener from the platform device CA (device protocol §1: the `caChainPem` gateways
// receive at bootstrap is also the trust anchor of the broker's server certificate, so a public Let's Encrypt
// certificate would not verify on a gateway). D-230, docs/deployment.md §5.
//
// Reads DEVICE_CA_CERT and DEVICE_CA_KEY from the environment (PEM with \n escapes, or base64 of the PEM — as the
// API reads them). Writes <out>/server.pem (leaf + CA), <out>/server.key (PKCS#8, 0600) and <out>/ca.pem. The private
// key never leaves the machine that runs this; store the three files in Secrets Manager
// `collective/<env>/getproperty/mqtt-tls` (JSON {"server_pem", "server_key", "ca_pem"}) for the platform box.
import 'reflect-metadata';

import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto);
const EC_SIGN = { name: 'ECDSA', hash: 'SHA-256' };

function pemFromEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (the device CA, as the API reads it)`);
  const unescaped = value.replace(/\\n/g, '\n').trim();
  if (unescaped.startsWith('-----BEGIN')) return `${unescaped}\n`;
  const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
  if (!decoded.startsWith('-----BEGIN')) throw new Error(`${name}: expected a PEM or base64 of a PEM`);
  return `${decoded}\n`;
}

const { values } = parseArgs({
  options: {
    host: { type: 'string' },
    out: { type: 'string', default: '.local/broker-cert' },
    days: { type: 'string', default: '397' },
  },
});
if (!values.host || !/^[a-z0-9.-]+$/i.test(values.host)) {
  console.error('usage: pnpm device:broker-cert --host <mqtt hostname> [--out dir] [--days 397]');
  process.exit(64);
}

const caCert = new x509.X509Certificate(pemFromEnv('DEVICE_CA_CERT'));
const caKey = await webcrypto.subtle.importKey(
  'pkcs8',
  x509.PemConverter.decodeFirst(pemFromEnv('DEVICE_CA_KEY')),
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
);
const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);
const now = Date.now();
const cert = await x509.X509CertificateGenerator.create({
  serialNumber: `02${randomBytes(15).toString('hex')}`,
  subject: `CN=${values.host}`,
  issuer: caCert.subject,
  notBefore: new Date(now - 5 * 60_000),
  notAfter: new Date(now + Number(values.days) * 86_400_000),
  signingAlgorithm: EC_SIGN,
  publicKey: keys.publicKey,
  signingKey: caKey,
  extensions: [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
    new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: values.host }]),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    await x509.AuthorityKeyIdentifierExtension.create(caCert),
  ],
});
if (!(await cert.verify({ publicKey: caCert.publicKey, date: new Date() })))
  throw new Error(
    'the issued certificate does not verify against DEVICE_CA_CERT (is DEVICE_CA_KEY its key?)',
  );

const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'server.pem'), `${cert.toString('pem')}\n${caCert.toString('pem')}\n`);
writeFileSync(join(out, 'server.key'), `${x509.PemConverter.encode(pkcs8, 'PRIVATE KEY')}\n`, {
  mode: 0o600,
});
chmodSync(join(out, 'server.key'), 0o600);
writeFileSync(join(out, 'ca.pem'), `${caCert.toString('pem')}\n`);
const fingerprint = createHash('sha256').update(Buffer.from(cert.rawData)).digest('hex');
console.log(
  `broker certificate for ${values.host} (sha256 ${fingerprint}, until ${cert.notAfter.toISOString()}) → ${out}`,
);

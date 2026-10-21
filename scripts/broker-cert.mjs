// `pnpm device:broker-cert --host mqtt.getproperty.co [--out dir] [--days 397]` — issues the TLS server certificate
// of getproperty's EMQX device listener from the platform device CA (device protocol §1: the `caChainPem` gateways
// receive at bootstrap is also the trust anchor of the broker's server certificate, so a public Let's Encrypt
// certificate would not verify on a gateway). D-230, docs/deployment.md §5.
//
// Reads DEVICE_CA_CERT, DEVICE_CA_KEY and the optional DEVICE_CA_CHAIN from the environment (PEM with \n escapes, or
// base64 of the PEM — as the API reads them). Writes <out>/server.pem (leaf + chain), <out>/server.key (PKCS#8, 0600),
// <out>/ca.pem (the chain) and <out>/device-ca-secret.json (0600): the platform-owned Secrets Manager secret
// `collective/<env>/platform/device-ca` (D-235, blueprint T-6) exactly as collective-infra reads it — flat JSON of PEM
// strings `ca_chain_pem`, `issuing_cert_pem`, `issuing_key_pem` (collective-infra's getproperty hook renders these
// three into the API env as DEVICE_CA_CHAIN / DEVICE_CA_CERT / DEVICE_CA_KEY, base64) and `broker_cert_pem` (leaf +
// issuing CA), `broker_key_pem` (EMQX's 8883 / WSS listener only; never in a product env). The private keys never
// leave the machine that runs this: `aws secretsmanager put-secret-value --secret-id collective/<env>/platform/device-ca
// --secret-string file://<out>/device-ca-secret.json`, then delete the folder.
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

/** Every certificate of a PEM bundle (x509.X509Certificates reads PKCS#7, not concatenated PEM). */
function pemCertificates(pem) {
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(
    (block) => new x509.X509Certificate(block),
  );
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

const caCertPem = pemFromEnv('DEVICE_CA_CERT');
const caKeyPem = pemFromEnv('DEVICE_CA_KEY');
const caCert = new x509.X509Certificate(caCertPem);
// the chain gateways trust (issuing CA first, then its issuers); the issuing CA alone when unset
const chainPem = process.env.DEVICE_CA_CHAIN ? pemFromEnv('DEVICE_CA_CHAIN') : caCertPem;
if (!pemCertificates(chainPem).some((c) => c.equal(caCert)))
  throw new Error('DEVICE_CA_CHAIN does not contain DEVICE_CA_CERT');
const caKey = await webcrypto.subtle.importKey(
  'pkcs8',
  x509.PemConverter.decodeFirst(caKeyPem),
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
const serverPem = `${cert.toString('pem')}\n${caCert.toString('pem')}\n`;
const serverKey = `${x509.PemConverter.encode(pkcs8, 'PRIVATE KEY')}\n`;
writeFileSync(join(out, 'server.pem'), serverPem);
writeFileSync(join(out, 'server.key'), serverKey, { mode: 0o600 });
chmodSync(join(out, 'server.key'), 0o600);
writeFileSync(join(out, 'ca.pem'), chainPem);
writeFileSync(
  join(out, 'device-ca-secret.json'),
  `${JSON.stringify(
    {
      ca_chain_pem: chainPem,
      issuing_cert_pem: caCertPem,
      issuing_key_pem: caKeyPem,
      broker_cert_pem: serverPem,
      broker_key_pem: serverKey,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
chmodSync(join(out, 'device-ca-secret.json'), 0o600);
const fingerprint = createHash('sha256').update(Buffer.from(cert.rawData)).digest('hex');
console.log(
  `broker certificate for ${values.host} (sha256 ${fingerprint}, until ${cert.notAfter.toISOString()}) → ${out}`,
);

import { createHash } from 'node:crypto';

import { type Request } from 'express';

import { clientCertificateOf } from './device-identity.service';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const fp = (pem: string) => createHash('sha256').update(pem).digest();
const req = (headers: Record<string, string>, socket: object = {}) =>
  ({ headers, socket }) as unknown as Request;

describe('clientCertificateOf (mTLS sources, CR-002)', () => {
  it('pem_header: URL-encoded PEM from a trusted proxy', () => {
    const cert = clientCertificateOf(
      req({ 'x-client-cert': encodeURIComponent(PEM) }),
      'pem_header',
      'x-client-cert',
      fp,
    );
    expect(cert).toEqual({ fingerprint: fp(PEM), pem: PEM });
    expect(clientCertificateOf(req({}), 'pem_header', 'x-client-cert', fp)).toBeNull();
    expect(
      clientCertificateOf(req({ 'x-client-cert': '%E0%A4%A' }), 'pem_header', 'x-client-cert', fp),
    ).toBeNull();
    expect(
      clientCertificateOf(req({ 'x-client-cert': 'garbage' }), 'pem_header', 'x-client-cert', fp),
    ).toBeNull();
  });

  it('sha256_header: hex or base64 fingerprints of 32 bytes', () => {
    const digest = fp(PEM);
    for (const value of [digest.toString('hex'), digest.toString('base64'), `:${digest.toString('base64')}:`])
      expect(clientCertificateOf(req({ 'x-hash': value }), 'sha256_header', 'x-hash', fp)).toEqual({
        fingerprint: digest,
        pem: null,
      });
    expect(clientCertificateOf(req({ 'x-hash': 'abcd' }), 'sha256_header', 'x-hash', fp)).toBeNull();
  });

  it('socket: ignores headers and requires an authorised TLS peer', () => {
    expect(
      clientCertificateOf(req({ 'x-client-cert': encodeURIComponent(PEM) }), 'socket', 'x-client-cert', fp),
    ).toBeNull();
    const raw = Buffer.from('der-bytes');
    const socket = { encrypted: true, authorized: true, getPeerCertificate: () => ({ raw }) };
    const cert = clientCertificateOf(req({}, socket), 'socket', 'x-client-cert', fp);
    expect(cert?.pem).toContain(raw.toString('base64'));
    const unauthorised = { ...socket, authorized: false };
    expect(clientCertificateOf(req({}, unauthorised), 'socket', 'x-client-cert', fp)).toBeNull();
  });
});

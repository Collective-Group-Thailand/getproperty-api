import 'reflect-metadata';

import { createHash, randomBytes, webcrypto } from 'node:crypto';

import { pemFromEnv } from '@common/crypto/pem';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import * as x509 from '@peculiar/x509';

type CryptoKey = webcrypto.CryptoKey;

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const EC_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Every certificate of a concatenated PEM bundle (x509.X509Certificates parses PKCS#7 only). */
export function pemCertificates(pem: string): x509.X509Certificate[] {
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(
    (block) => new x509.X509Certificate(block),
  );
}

/** Placeholder subject of the agent's first CSR (getproperty-edge CR-001); the CA replaces it. */
export const PROVISIONING_CN = 'gw-provisioning';

export interface IssuedCertificate {
  certificatePem: string;
  serialNumber: string;
  fingerprintSha256: Buffer;
  subjectCn: string;
  notBefore: Date;
  notAfter: Date;
  csrSha256: Buffer;
}

/**
 * The platform device CA (D-130, device protocol §1): signs each gateway's CSR at bootstrap into an X.509 client
 * certificate with `CN = gw-<deviceId>`, `clientAuth` only, valid `DEVICE_CERT_VALIDITY_DAYS`. The CA certificate, its
 * EC P-256 private key and the chain gateways trust come from the platform-owned secret
 * `collective/<env>/platform/device-ca`, rendered by the box into this process's env file (`DEVICE_CA_CERT`,
 * `DEVICE_CA_KEY`, optional `DEVICE_CA_CHAIN`; D-235, blueprint T-6; required in production); development and tests
 * generate an ephemeral CA per process. Accepted CSR keys: EC P-256/P-384 or
 * RSA ≥ 2048.
 */
@Injectable()
export class DeviceCaService implements OnModuleInit {
  private readonly logger = new Logger(DeviceCaService.name);
  private caCert!: x509.X509Certificate;
  private caKey!: CryptoKey;
  private chainPem: string | null = null;

  constructor(private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    const certPem = this.config.get('DEVICE_CA_CERT');
    const keyPem = this.config.get('DEVICE_CA_KEY');
    if (certPem && keyPem) {
      this.caCert = new x509.X509Certificate(pemFromEnv(certPem));
      const der = x509.PemConverter.decodeFirst(pemFromEnv(keyPem));
      this.caKey = await webcrypto.subtle.importKey(
        'pkcs8',
        der,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      );
      const chain = this.config.get('DEVICE_CA_CHAIN');
      if (chain) {
        const pem = pemFromEnv(chain);
        // the chain gateways trust must contain the CA that signs them (T-6: a mismatch is a wrong secret)
        if (!pemCertificates(pem).some((c) => c.equal(this.caCert)))
          throw new Error('DEVICE_CA_CHAIN does not contain DEVICE_CA_CERT');
        this.chainPem = pem;
      }
      return;
    }
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const now = Date.now();
    this.caCert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString('hex'),
      name: 'CN=getproperty development device CA, O=Collective Group (Thailand)',
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 10 * 365 * 86_400_000),
      signingAlgorithm: EC_SIGN,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    this.caKey = keys.privateKey;
    if (!this.config.isTest)
      this.logger.warn('DEVICE_CA_CERT/DEVICE_CA_KEY not set: using an ephemeral development CA');
  }

  get caCertificatePem(): string {
    return this.caCert.toString('pem');
  }

  /**
   * Trust chain handed to gateways (also the anchor of the broker's server certificate): `DEVICE_CA_CHAIN` of the
   * platform secret `collective/<env>/platform/device-ca` (issuing CA, then its issuers — T-6), else the issuing CA.
   */
  get caChainPem(): string {
    return this.chainPem ?? this.caCertificatePem;
  }

  /** SHA-256 of a PEM certificate's DER (the `smart.device_certificate.fingerprint_sha256` key). */
  fingerprintOf(certificatePem: string): Buffer {
    const cert = new x509.X509Certificate(certificatePem);
    return createHash('sha256').update(Buffer.from(cert.rawData)).digest();
  }

  async sign(csrPem: string, deviceId: string, now: Date): Promise<IssuedCertificate> {
    let csr: x509.Pkcs10CertificateRequest;
    try {
      csr = new x509.Pkcs10CertificateRequest(csrPem);
    } catch {
      throw this.invalid('not a PEM PKCS#10 certificate request');
    }
    if (!(await csr.verify())) throw this.invalid('the CSR signature does not verify');
    // The CA sets the subject: the CSR carries either the final CN or the agent's placeholder (CR-001).
    const expectedCn = `gw-${deviceId}`;
    const cn = csr.subjectName.getField('CN')[0];
    if (cn !== expectedCn && cn !== PROVISIONING_CN)
      throw this.invalid(`the CSR subject CN must be ${expectedCn} or ${PROVISIONING_CN}`);
    const alg = csr.publicKey.algorithm as { name: string; namedCurve?: string; modulusLength?: number };
    const rsa = alg.name === 'RSASSA-PKCS1-v1_5' || alg.name === 'RSA-PSS';
    const okKey =
      (alg.name === 'ECDSA' && (alg.namedCurve === 'P-256' || alg.namedCurve === 'P-384')) ||
      (rsa && (alg.modulusLength ?? 0) >= 2048);
    if (!okKey) throw this.invalid('the CSR key must be EC P-256/P-384 or RSA ≥ 2048');

    const notBefore = new Date(now.getTime() - 5 * 60_000);
    const notAfter = new Date(now.getTime() + this.config.get('DEVICE_CERT_VALIDITY_DAYS') * 86_400_000);
    const serialNumber = `01${randomBytes(15).toString('hex')}`;
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber,
      subject: `CN=${expectedCn}`,
      issuer: this.caCert.subject,
      notBefore,
      notAfter,
      signingAlgorithm: EC_SIGN,
      publicKey: csr.publicKey,
      signingKey: this.caKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | (rsa ? x509.KeyUsageFlags.keyEncipherment : 0),
          true,
        ),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
        await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(this.caCert),
      ],
    });
    return {
      certificatePem: cert.toString('pem'),
      serialNumber,
      fingerprintSha256: createHash('sha256').update(Buffer.from(cert.rawData)).digest(),
      subjectCn: expectedCn,
      notBefore,
      notAfter,
      csrSha256: createHash('sha256').update(Buffer.from(csr.rawData)).digest(),
    };
  }

  /** Verifies that a certificate was issued by this CA (tests, renewal checks). */
  async issued(certificatePem: string): Promise<boolean> {
    const cert = new x509.X509Certificate(certificatePem);
    return cert.verify({ publicKey: this.caCert.publicKey, signatureOnly: true });
  }

  private invalid(message: string): DomainException {
    return new DomainException('device.csr_invalid', {
      errors: [{ path: 'csrPem', code: 'csr', message }],
    });
  }
}

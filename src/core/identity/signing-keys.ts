import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { pemFromEnv } from '@common/crypto/pem';
import { AppConfig } from '@config/app-config';
import { Injectable, Logger } from '@nestjs/common';

export interface Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg: 'EdDSA';
}

/**
 * The Ed25519 keys behind access tokens (contract §4: JWT EdDSA, JWKS at `/v1/auth/.well-known/jwks.json`).
 * Production: `AUTH_JWT_PRIVATE_KEY` + `AUTH_JWT_KID`, with previous public keys in `AUTH_JWT_PREVIOUS_KEYS`
 * during a rotation. Elsewhere a key pair is generated per process.
 */
@Injectable()
export class SigningKeys {
  readonly kid: string;
  readonly privateKey: KeyObject;
  /** Every key a token may be signed with (current + previous), by kid. */
  readonly verificationKeys: ReadonlyMap<string, KeyObject>;

  constructor(config: AppConfig) {
    this.kid = config.get('AUTH_JWT_KID');
    const configured = config.get('AUTH_JWT_PRIVATE_KEY');
    if (configured) {
      this.privateKey = createPrivateKey(pemFromEnv(configured));
      if (this.privateKey.asymmetricKeyType !== 'ed25519')
        throw new Error('AUTH_JWT_PRIVATE_KEY must be an Ed25519 key (EdDSA)');
    } else {
      this.privateKey = generateKeyPairSync('ed25519').privateKey;
      if (!config.isTest)
        new Logger(SigningKeys.name).warn(
          'AUTH_JWT_PRIVATE_KEY not set: tokens are signed with a per-process key',
        );
    }
    const keys = new Map<string, KeyObject>([[this.kid, createPublicKey(this.privateKey)]]);
    const previous = config.get('AUTH_JWT_PREVIOUS_KEYS');
    if (previous) {
      for (const k of JSON.parse(previous) as { kid: string; publicKeyPem: string }[]) {
        if (k.kid !== this.kid) keys.set(k.kid, createPublicKey(pemFromEnv(k.publicKeyPem)));
      }
    }
    this.verificationKeys = keys;
  }

  jwks(): { keys: Jwk[] } {
    return {
      keys: [...this.verificationKeys.entries()].map(([kid, key]) => {
        const jwk = key.export({ format: 'jwk' }) as { x: string };
        return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, use: 'sig', alg: 'EdDSA' };
      }),
    };
  }
}

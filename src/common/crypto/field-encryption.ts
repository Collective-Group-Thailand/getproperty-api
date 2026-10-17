import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { AppConfig } from '@config/app-config';
import { Injectable, Logger } from '@nestjs/common';

import { bytes } from './hashing';

const VERSION = 1;

/** Development-only key material: fixed so a local database stays readable across restarts. Never in production. */
export const DEV_FIELD_ENCRYPTION_KEY = createHash('sha256')
  .update('getproperty-dev-field-encryption-key')
  .digest();

/**
 * AES-256-GCM with the **platform key** for secrets that belong to no tenant (`platform.user_credential.totp_secret_enc`)
 * and as the local key-encryption key that wraps tenant data keys until Cloud KMS (schema-design §4.7, D-160/B6.5).
 * Layout: version (1) · iv (12) · tag (16) · ciphertext. The key comes from `FIELD_ENCRYPTION_KEY` (required in
 * production, validate-env); development and tests use a fixed development key (B1.3: a per-process key could not
 * read a local database after a restart). Tenant PII uses the per-tenant envelope (`TenantDataKeys`).
 */
@Injectable()
export class FieldEncryption {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    const configured = config.get('FIELD_ENCRYPTION_KEY');
    this.key = configured ? Buffer.from(configured, 'base64') : DEV_FIELD_ENCRYPTION_KEY;
    if (this.key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes (base64)');
    if (!configured && !config.isTest)
      new Logger(FieldEncryption.name).warn('FIELD_ENCRYPTION_KEY not set: using the development key');
  }

  encrypt(plain: string | Buffer, aad?: string): Uint8Array<ArrayBuffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.concat([
      cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain),
      cipher.final(),
    ]);
    return bytes(Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), data]));
  }

  decryptBuffer(sealed: Uint8Array, aad?: string): Buffer {
    const buffer = Buffer.from(sealed);
    if (buffer[0] !== VERSION) throw new Error('unknown field-encryption version');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buffer.subarray(1, 13));
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(buffer.subarray(13, 29));
    return Buffer.concat([decipher.update(buffer.subarray(29)), decipher.final()]);
  }

  decrypt(sealed: Uint8Array, aad?: string): string {
    return this.decryptBuffer(sealed, aad).toString('utf8');
  }
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AppConfig } from '@config/app-config';
import { Injectable } from '@nestjs/common';

import { bytes } from './hashing';

const VERSION = 1;

/**
 * AES-256-GCM for secrets kept in the database (`*_enc` columns: national ids, TOTP secrets — D-025). Layout:
 * version (1) · iv (12) · tag (16) · ciphertext. The key comes from `FIELD_ENCRYPTION_KEY`
 * (required in production); elsewhere a per-process key is generated.
 */
@Injectable()
export class FieldEncryption {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    const configured = config.get('FIELD_ENCRYPTION_KEY');
    this.key = configured ? Buffer.from(configured, 'base64') : randomBytes(32);
    if (this.key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes (base64)');
  }

  encrypt(plain: string): Uint8Array<ArrayBuffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return bytes(Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), data]));
  }

  decrypt(sealed: Uint8Array): string {
    const buffer = Buffer.from(sealed);
    if (buffer[0] !== VERSION) throw new Error('unknown field-encryption version');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buffer.subarray(1, 13));
    decipher.setAuthTag(buffer.subarray(13, 29));
    return Buffer.concat([decipher.update(buffer.subarray(29)), decipher.final()]).toString('utf8');
  }
}

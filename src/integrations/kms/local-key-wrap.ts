import { type FieldEncryption } from '@common/crypto/field-encryption';

import { type KeyWrapPort } from './key-wrap.port';

/** AES-256-GCM wrap with the platform key; the tenant id is the AAD so a wrapped key cannot move between tenants. */
export class LocalKeyWrap implements KeyWrapPort {
  readonly kekRef = 'local:field-encryption-key:v1';

  constructor(private readonly platformKey: FieldEncryption) {}

  wrap(dek: Buffer, tenantId: string): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.platformKey.encrypt(dek, `tenant_dek:${tenantId}`)));
  }

  unwrap(wrapped: Buffer, tenantId: string, kekRef: string): Promise<Buffer> {
    if (kekRef !== this.kekRef) return Promise.reject(new Error(`unknown KEK ${kekRef}`));
    return Promise.resolve(this.platformKey.decryptBuffer(wrapped, `tenant_dek:${tenantId}`));
  }
}

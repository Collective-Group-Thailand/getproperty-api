export const KEY_WRAP = Symbol('KEY_WRAP');

/**
 * Wraps tenant data-encryption keys with a key-encryption key (schema-design §4.7). Production target: AWS KMS on
 * the Collective platform (D-230, an adapter behind this port); until then the local wrap uses the platform key
 * (`FIELD_ENCRYPTION_KEY`, from Secrets Manager).
 */
export interface KeyWrapPort {
  /** Recorded in `core.tenant_data_key.kek_ref`. */
  readonly kekRef: string;
  wrap(dek: Buffer, tenantId: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, tenantId: string, kekRef: string): Promise<Buffer>;
}

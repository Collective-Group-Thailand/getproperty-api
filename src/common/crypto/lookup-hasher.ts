import { createHmac } from 'node:crypto';

import { lookupHash } from '@collective/asset-core';
import { AppConfig } from '@config/app-config';
import { Injectable } from '@nestjs/common';

import { bytes } from './hashing';

/** Development-only HMAC key (lookups must survive restarts of a local database). Never in production. */
export const DEV_FIELD_HASH_KEY = 'getproperty-dev-field-hash-key';

/**
 * Lookup hashes (`*_hash` columns, schema-design §4.7, D-148): HMAC-SHA256(FIELD_HASH_KEY, scope || value).
 * Tenant data uses the tenant id as scope (equality search inside a tenant); login identifiers use '' (tenant-less).
 * Also keys the HMAC of short secrets (OTP codes, provisioning codes) so a database dump cannot brute-force them.
 */
@Injectable()
export class LookupHasher {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    this.key = Buffer.from(config.get('FIELD_HASH_KEY') ?? DEV_FIELD_HASH_KEY, 'utf8');
  }

  /** `core.user_account.phone_hash` / OTP challenges: tenant-less. */
  phone(e164: string): Uint8Array<ArrayBuffer> {
    return bytes(lookupHash(this.key, '', e164));
  }

  /** Tenant-scoped values: `core.party.phone_hash`, `id_number_hash`, `tenant_bank_account.account_no_hash`. */
  tenantValue(tenantId: string, normalised: string): Uint8Array<ArrayBuffer> {
    return bytes(lookupHash(this.key, tenantId, normalised));
  }

  /** HMAC of a short secret bound to its record (OTP code ↔ challenge id, provisioning code). */
  secret(binding: string, value: string): Uint8Array<ArrayBuffer> {
    return bytes(createHmac('sha256', this.key).update(`${binding}|${value}`, 'utf8').digest());
  }
}

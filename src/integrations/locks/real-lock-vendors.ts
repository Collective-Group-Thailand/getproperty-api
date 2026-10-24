import { createCipheriv, createDecipheriv, createHash, createHmac, randomUUID } from 'node:crypto';

import { ProviderError, providerFetch } from '@collective/integrations/http';

import {
  type CreatedCredential,
  type CredentialInput,
  type LockRef,
  type LockStatus,
  type LockVendorAdapter,
  LockVendorError,
  type LockVendorKey,
  type LockVendorRegistry,
  type VendorUnlockEvent,
} from './lock-vendor.port';

const need = (lock: LockRef, key: string): string => {
  const v = lock.credentials[key];
  if (!v) throw new LockVendorError(lock.vendor, `vendor credential ${key} missing`);
  return v;
};

/**
 * TTLock Open Platform (cloud API v3, `application/x-www-form-urlencoded`): OAuth password grant
 * `POST /oauth2/token` (client id / secret + the tenant's TTLock account, password MD5), keypad codes
 * `POST /v3/keyboardPwd/add` (type 2 permanent, 3 period; added through the gateway, `addType=2`) and
 * `POST /v3/keyboardPwd/delete`, the unlock records `GET /v3/lockRecord/list`, the battery
 * `GET /v3/lock/queryElectricQuantity`. Secrets: `clientId`, `clientSecret`, `username`, `password`.
 * // UNVERIFIED against live provider: written from the public TTLock Open Platform documentation (B5.2).
 */
export class TtlockAdapter implements LockVendorAdapter {
  readonly vendor = 'ttlock' as const;
  readonly mode = 'real' as const;
  private readonly tokens = new Map<string, { token: string; until: number }>();

  constructor(private readonly baseUrl: string) {}

  private async token(lock: LockRef): Promise<string> {
    const key = need(lock, 'clientId') + need(lock, 'username');
    const hit = this.tokens.get(key);
    if (hit && hit.until > Date.now()) return hit.token;
    const res = await providerFetch({
      provider: 'ttlock',
      url: `${this.baseUrl}/oauth2/token`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          clientId: need(lock, 'clientId'),
          clientSecret: need(lock, 'clientSecret'),
          username: need(lock, 'username'),
          password: createHash('md5').update(need(lock, 'password')).digest('hex'),
        }).toString(),
      },
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; errmsg?: string };
    if (!res.ok || !json.access_token)
      throw new LockVendorError('ttlock', `token: ${json.errmsg ?? res.status}`);
    this.tokens.set(key, {
      token: json.access_token,
      until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000,
    });
    return json.access_token;
  }

  private async call<T>(lock: LockRef, method: 'GET' | 'POST', path: string, params: Record<string, string>) {
    const query = new URLSearchParams({
      clientId: need(lock, 'clientId'),
      accessToken: await this.token(lock),
      date: String(Date.now()),
      ...params,
    }).toString();
    const res = await providerFetch({
      provider: 'ttlock',
      url: method === 'GET' ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`,
      init:
        method === 'GET'
          ? { method }
          : { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: query },
    });
    const json = (await res.json()) as T & { errcode?: number; errmsg?: string };
    if (!res.ok || (json.errcode !== undefined && json.errcode !== 0))
      throw new LockVendorError('ttlock', `${path}: ${json.errmsg ?? res.status}`);
    return json;
  }

  async createCredential(lock: LockRef, input: CredentialInput): Promise<CreatedCredential> {
    if (input.type !== 'pin')
      throw new LockVendorError('ttlock', `credential type ${input.type} not supported`);
    const json = await this.call<{ keyboardPwdId?: number }>(lock, 'POST', '/v3/keyboardPwd/add', {
      lockId: lock.vendorLockId,
      keyboardPwd: input.pin,
      keyboardPwdName: input.holderName.slice(0, 50),
      keyboardPwdType: input.validTo ? '3' : '2',
      startDate: String(input.validFrom.getTime()),
      ...(input.validTo ? { endDate: String(input.validTo.getTime()) } : {}),
      addType: '2',
    });
    if (!json.keyboardPwdId) throw new LockVendorError('ttlock', 'no keyboardPwdId');
    return { vendorCredentialRef: String(json.keyboardPwdId) };
  }

  async revokeCredential(lock: LockRef, ref: string): Promise<void> {
    await this.call(lock, 'POST', '/v3/keyboardPwd/delete', {
      lockId: lock.vendorLockId,
      keyboardPwdId: ref,
      deleteType: '2',
    });
  }

  async unlockLog(lock: LockRef, since: Date, until: Date): Promise<VendorUnlockEvent[]> {
    const out: VendorUnlockEvent[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const json = await this.call<{
        list?: {
          recordId: number;
          lockDate: number;
          recordType: number;
          success: number;
          keyboardPwd?: string;
        }[];
        pages?: number;
      }>(lock, 'GET', '/v3/lockRecord/list', {
        lockId: lock.vendorLockId,
        startDate: String(since.getTime()),
        endDate: String(until.getTime()),
        pageNo: String(page),
        pageSize: '100',
      });
      for (const r of json.list ?? [])
        out.push({
          vendorEventId: String(r.recordId),
          at: new Date(r.lockDate),
          result: r.success === 1 ? 'success' : 'denied',
          // recordType 4 = keypad code, 7 = IC card, 8 = fingerprint, 1 = app (TTLock record types)
          source:
            r.recordType === 4
              ? 'pin'
              : r.recordType === 7
                ? 'card'
                : r.recordType === 8
                  ? 'fingerprint'
                  : 'app',
          vendorCredentialRef: null,
          detail: { recordType: r.recordType },
        });
      if (!json.pages || page >= json.pages) break;
    }
    return out.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  async status(lock: LockRef): Promise<LockStatus> {
    const json = await this.call<{ electricQuantity?: number }>(
      lock,
      'GET',
      '/v3/lock/queryElectricQuantity',
      {
        lockId: lock.vendorLockId,
      },
    );
    return { batteryPct: json.electricQuantity ?? null, online: null };
  }
}

/**
 * Tuya OpenAPI (cloud project of the tenant): HMAC-SHA256 signed requests (`client_id + [access_token] + t + nonce +
 * stringToSign`), token `GET /v1.0/token?grant_type=1`, temporary passwords through a ticket
 * (`POST /v1.0/devices/{id}/door-lock/password-ticket`, the PIN AES-128-ECB encrypted with the ticket key that is
 * itself AES-256-ECB encrypted with the access secret) `POST /v1.0/devices/{id}/door-lock/temp-password`, deletion
 * `DELETE /v1.0/devices/{id}/door-lock/temp-passwords/{password_id}`, unlock records
 * `GET /v1.0/devices/{id}/door-lock/open-logs`, battery from `GET /v1.0/devices/{id}/status`
 * (`residual_electricity` / `battery_state`). Secrets: `accessId`, `accessSecret`.
 * // UNVERIFIED against live provider: written from the public Tuya Smart Lock OpenAPI documentation (B5.2).
 */
export class TuyaAdapter implements LockVendorAdapter {
  readonly vendor = 'tuya' as const;
  readonly mode = 'real' as const;
  private readonly tokens = new Map<string, { token: string; until: number }>();

  constructor(private readonly baseUrl: string) {}

  private sign(lock: LockRef, method: string, path: string, body: string, token: string) {
    const t = String(Date.now());
    const nonce = randomUUID();
    const stringToSign = [method, createHash('sha256').update(body).digest('hex'), '', path].join('\n');
    const sign = createHmac('sha256', need(lock, 'accessSecret'))
      .update(need(lock, 'accessId') + token + t + nonce + stringToSign)
      .digest('hex')
      .toUpperCase();
    return { client_id: need(lock, 'accessId'), sign, t, nonce, sign_method: 'HMAC-SHA256' };
  }

  private async token(lock: LockRef): Promise<string> {
    const hit = this.tokens.get(need(lock, 'accessId'));
    if (hit && hit.until > Date.now()) return hit.token;
    const path = '/v1.0/token?grant_type=1';
    const res = await providerFetch({
      provider: 'tuya',
      url: `${this.baseUrl}${path}`,
      init: { method: 'GET', headers: this.sign(lock, 'GET', path, '', '') },
    });
    const json = (await res.json()) as {
      success?: boolean;
      result?: { access_token: string; expire_time: number };
    };
    if (!json.success || !json.result) throw new LockVendorError('tuya', 'token refused');
    this.tokens.set(need(lock, 'accessId'), {
      token: json.result.access_token,
      until: Date.now() + Math.max(60, json.result.expire_time - 300) * 1000,
    });
    return json.result.access_token;
  }

  private async call<T>(
    lock: LockRef,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.token(lock);
    const text = body === undefined ? '' : JSON.stringify(body);
    const res = await providerFetch({
      provider: 'tuya',
      url: `${this.baseUrl}${path}`,
      init: {
        method,
        headers: {
          ...this.sign(lock, method, path, text, token),
          access_token: token,
          'content-type': 'application/json',
        },
        ...(text ? { body: text } : {}),
      },
    });
    const json = (await res.json()) as { success?: boolean; result?: T; msg?: string };
    if (!json.success) throw new LockVendorError('tuya', `${path.split('?')[0]}: ${json.msg ?? res.status}`);
    return json.result as T;
  }

  async createCredential(lock: LockRef, input: CredentialInput): Promise<CreatedCredential> {
    if (input.type !== 'pin')
      throw new LockVendorError('tuya', `credential type ${input.type} not supported`);
    const ticket = await this.call<{ ticket_id: string; ticket_key: string }>(
      lock,
      'POST',
      `/v1.0/devices/${lock.vendorLockId}/door-lock/password-ticket`,
    );
    // the ticket key is AES-256-ECB(hex) under the access secret; the PIN is AES-128-ECB(hex) under the ticket key
    const keyDecipher = createDecipheriv(
      'aes-256-ecb',
      Buffer.from(need(lock, 'accessSecret'), 'utf8'),
      null,
    );
    const ticketKey = Buffer.concat([
      keyDecipher.update(Buffer.from(ticket.ticket_key, 'hex')),
      keyDecipher.final(),
    ]);
    const pinCipher = createCipheriv('aes-128-ecb', ticketKey.subarray(0, 16), null);
    const password = Buffer.concat([pinCipher.update(input.pin, 'utf8'), pinCipher.final()]).toString('hex');
    const result = await this.call<{ id: number }>(
      lock,
      'POST',
      `/v1.0/devices/${lock.vendorLockId}/door-lock/temp-password`,
      {
        name: input.holderName.slice(0, 30),
        password,
        password_type: 'ticket',
        ticket_id: ticket.ticket_id,
        effective_time: Math.floor(input.validFrom.getTime() / 1000),
        // a resident code stays until the lease ends: the far end of Tuya's range, revoked by the platform
        invalid_time: Math.floor((input.validTo ?? new Date('2099-12-31T00:00:00Z')).getTime() / 1000),
      },
    );
    return { vendorCredentialRef: String(result.id) };
  }

  async revokeCredential(lock: LockRef, ref: string): Promise<void> {
    await this.call(lock, 'DELETE', `/v1.0/devices/${lock.vendorLockId}/door-lock/temp-passwords/${ref}`);
  }

  async unlockLog(lock: LockRef, since: Date, until: Date): Promise<VendorUnlockEvent[]> {
    const result = await this.call<{
      logs?: { update_time: number; status?: { code: string; value: unknown }[]; record_id?: string }[];
    }>(
      lock,
      'GET',
      `/v1.0/devices/${lock.vendorLockId}/door-lock/open-logs?page_no=1&page_size=100&start_time=${since.getTime()}&end_time=${until.getTime()}`,
    );
    return (result.logs ?? [])
      .map((l): VendorUnlockEvent => {
        const code = l.status?.[0]?.code ?? '';
        return {
          vendorEventId: l.record_id ?? `${l.update_time}-${code}`,
          at: new Date(l.update_time),
          result: 'success',
          source: code.includes('password')
            ? 'pin'
            : code.includes('card')
              ? 'card'
              : code.includes('finger')
                ? 'fingerprint'
                : 'app',
          vendorCredentialRef: null,
          detail: { code },
        };
      })
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  async status(lock: LockRef): Promise<LockStatus> {
    const result = await this.call<{ code: string; value: unknown }[]>(
      lock,
      'GET',
      `/v1.0/devices/${lock.vendorLockId}/status`,
    );
    const residual = result.find((s) => s.code === 'residual_electricity')?.value;
    const state = result.find((s) => s.code === 'battery_state')?.value;
    const pct =
      typeof residual === 'number'
        ? residual
        : state === 'low'
          ? 10
          : state === 'middle'
            ? 50
            : state === 'high'
              ? 90
              : null;
    return { batteryPct: pct, online: null };
  }
}

/** Real vendor clouds (INTEGRATIONS_MODE=real); each vendor is enabled per tenant by `locks.vendor.<vendor>`. */
export class RealLockVendors implements LockVendorRegistry {
  readonly mode = 'real' as const;
  private readonly adapters: Record<LockVendorKey, LockVendorAdapter>;

  constructor(urls: Record<LockVendorKey, string>) {
    this.adapters = { ttlock: new TtlockAdapter(urls.ttlock), tuya: new TuyaAdapter(urls.tuya) };
  }

  adapter(vendor: LockVendorKey): LockVendorAdapter {
    const a = this.adapters[vendor];
    if (!a) throw new ProviderError(vendor, 'unknown lock vendor', undefined, false);
    return a;
  }
}

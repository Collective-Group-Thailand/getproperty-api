import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';

import { resetProviderBreakers } from '@collective/integrations/http';

import { type LockRef } from './lock-vendor.port';
import { TtlockAdapter, TuyaAdapter } from './real-lock-vendors';

type Call = { url: string; init: RequestInit };

function mockFetch(responses: unknown[]): Call[] {
  const calls: Call[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    calls.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init: init ?? {},
    });
    const body = responses.shift();
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  return calls;
}

afterEach(() => {
  jest.restoreAllMocks();
  resetProviderBreakers();
});

describe('TtlockAdapter (UNVERIFIED against the live API)', () => {
  const lock: LockRef = {
    vendor: 'ttlock',
    vendorLockId: '8123456',
    credentials: { clientId: 'cid', clientSecret: 'csec', username: 'owner@example.com', password: 'secret' },
  };

  it('signs in with the MD5 password and adds a period keypad code through the gateway', async () => {
    const calls = mockFetch([{ access_token: 'tok', expires_in: 7200 }, { keyboardPwdId: 991 }]);
    const created = await new TtlockAdapter('https://ttlock.example').createCredential(lock, {
      type: 'pin',
      holderName: 'Visitor',
      pin: '482913',
      validFrom: new Date('2026-11-01T02:00:00Z'),
      validTo: new Date('2026-11-01T06:00:00Z'),
    });
    expect(created).toEqual({ vendorCredentialRef: '991' });
    const token = new URLSearchParams(calls[0]!.init.body as string);
    expect(calls[0]!.url).toBe('https://ttlock.example/oauth2/token');
    expect(token.get('password')).toBe(createHash('md5').update('secret').digest('hex'));
    const add = new URLSearchParams(calls[1]!.init.body as string);
    expect(calls[1]!.url).toBe('https://ttlock.example/v3/keyboardPwd/add');
    expect(Object.fromEntries(add)).toMatchObject({
      clientId: 'cid',
      accessToken: 'tok',
      lockId: '8123456',
      keyboardPwd: '482913',
      keyboardPwdType: '3',
      startDate: String(Date.parse('2026-11-01T02:00:00Z')),
      endDate: String(Date.parse('2026-11-01T06:00:00Z')),
      addType: '2',
    });
  });

  it('a permanent resident code is type 2 without an end; errors surface', async () => {
    const calls = mockFetch([
      { access_token: 'tok', expires_in: 7200 },
      { errcode: -3, errmsg: 'invalid lock' },
    ]);
    await expect(
      new TtlockAdapter('https://ttlock.example').createCredential(lock, {
        type: 'pin',
        holderName: 'Resident',
        pin: '123456',
        validFrom: new Date(),
        validTo: null,
      }),
    ).rejects.toThrow('invalid lock');
    const add = new URLSearchParams(calls[1]!.init.body as string);
    expect(add.get('keyboardPwdType')).toBe('2');
    expect(add.has('endDate')).toBe(false);
  });

  it('maps the unlock records and the battery', async () => {
    mockFetch([
      { access_token: 'tok', expires_in: 7200 },
      { list: [{ recordId: 7, lockDate: 1_793_500_000_000, recordType: 4, success: 1 }], pages: 1 },
      { electricQuantity: 15 },
    ]);
    const a = new TtlockAdapter('https://ttlock.example');
    expect(await a.unlockLog(lock, new Date(0), new Date())).toEqual([
      expect.objectContaining({ vendorEventId: '7', result: 'success', source: 'pin' }),
    ]);
    expect(await a.status(lock)).toEqual({ batteryPct: 15, online: null });
  });
});

describe('TuyaAdapter (UNVERIFIED against the live API)', () => {
  const secret = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 bytes (AES-256 key of the ticket)
  const lock: LockRef = {
    vendor: 'tuya',
    vendorLockId: 'dev123',
    credentials: { accessId: 'aid', accessSecret: secret },
  };

  it('signs every request and sends the PIN encrypted with the ticket key', async () => {
    const ticketKey = Buffer.from('0123456789abcdef');
    const enc = createCipheriv('aes-256-ecb', Buffer.from(secret, 'utf8'), null);
    const ticketKeyHex = Buffer.concat([enc.update(ticketKey), enc.final()]).toString('hex');
    const calls = mockFetch([
      { success: true, result: { access_token: 'tok', expire_time: 7200 } },
      { success: true, result: { ticket_id: 'T1', ticket_key: ticketKeyHex } },
      { success: true, result: { id: 55 } },
    ]);
    const created = await new TuyaAdapter('https://tuya.example').createCredential(lock, {
      type: 'pin',
      holderName: 'Technician',
      pin: '482913',
      validFrom: new Date('2026-11-01T02:00:00Z'),
      validTo: new Date('2026-11-01T06:00:00Z'),
    });
    expect(created).toEqual({ vendorCredentialRef: '55' });
    // the token call is signed with client_id + t + nonce + stringToSign
    const h = calls[0]!.init.headers as Record<string, string>;
    const stringToSign = [
      'GET',
      createHash('sha256').update('').digest('hex'),
      '',
      '/v1.0/token?grant_type=1',
    ].join('\n');
    expect(h.sign).toBe(
      createHmac('sha256', secret).update(`aid${h.t}${h.nonce}${stringToSign}`).digest('hex').toUpperCase(),
    );
    const body = JSON.parse(calls[2]!.init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      ticket_id: 'T1',
      password_type: 'ticket',
      effective_time: Date.parse('2026-11-01T02:00:00Z') / 1000,
      invalid_time: Date.parse('2026-11-01T06:00:00Z') / 1000,
    });
    const dec = createDecipheriv('aes-128-ecb', ticketKey, null);
    expect(
      Buffer.concat([dec.update(Buffer.from(body.password as string, 'hex')), dec.final()]).toString(),
    ).toBe('482913');
    expect((calls[2]!.init.headers as Record<string, string>).access_token).toBe('tok');
  });

  it('reads the battery from the status codes', async () => {
    mockFetch([
      { success: true, result: { access_token: 'tok', expire_time: 7200 } },
      { success: true, result: [{ code: 'residual_electricity', value: 12 }] },
    ]);
    expect(await new TuyaAdapter('https://tuya.example').status(lock)).toEqual({
      batteryPct: 12,
      online: null,
    });
  });
});

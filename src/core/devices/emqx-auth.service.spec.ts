import { type AppConfig } from '@config/app-config';
import { type TenantTx } from '@database/tenant-tx';
import { type ExecutionContext } from '@nestjs/common';

import { InternalEmqxGuard } from '../../surfaces/internal/emqx-auth.controller';
import { type AuditService } from '../audit/audit.service';
import { FakeClock } from '../clock/clock';
import { type TokenService } from '../identity/token.service';
import { type SettingsService } from '../settings/settings.service';
import { EmqxAuthService, stripShare } from './emqx-auth.service';

const ID = '0199f2a0-0000-7000-8000-0000000000c1';
const USER = `gw-${ID}`;
const now = new Date('2026-11-01T00:00:00Z');

function service(opts: { requireJwt: boolean; device?: Record<string, unknown> }) {
  const device = {
    id: ID,
    kind: 'gateway',
    status: 'online',
    tenantId: 't',
    buildingId: 'b',
    mqttClientId: USER,
    certFingerprint: Buffer.alloc(32),
    certNotAfter: new Date('2027-11-01T00:00:00Z'),
    mqttWsFallback: false,
    ...opts.device,
  };
  const tx = { device: { findUnique: jest.fn().mockResolvedValue(device) } };
  const db = { platform: (work: (t: typeof tx) => unknown) => work(tx) } as unknown as TenantTx;
  const tokens = {
    verify: jest.fn((token: string) =>
      token === 'good' ? Promise.resolve({ aud: 'device', sub: ID }) : Promise.reject(new Error('bad')),
    ),
  } as unknown as TokenService;
  const settings = { valueAt: jest.fn().mockResolvedValue(opts.requireJwt) } as unknown as SettingsService;
  const audit = { recordAlone: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = { get: () => undefined } as unknown as AppConfig;
  return { svc: new EmqxAuthService(db, tokens, settings, audit, config, new FakeClock(now)), audit };
}

const mtls = (password: string) => ({
  transport: 'mtls',
  clientid: USER,
  username: USER,
  password,
  cert_common_name: USER,
});

describe('EmqxAuthService (D-235, D-239)', () => {
  it('mqtt.authn.require_device_jwt off: the certificate alone is accepted, a sent password is still checked', async () => {
    const { svc } = service({ requireJwt: false });
    await expect(svc.authenticate(mtls(''))).resolves.toBe('allow');
    await expect(svc.authenticate(mtls('forged'))).resolves.toBe('deny');
    await expect(svc.authenticate(mtls('good'))).resolves.toBe('allow');
  });

  it('on (default): no JWT → deny, audited once per minute and never with the password', async () => {
    const { svc, audit } = service({ requireJwt: true });
    await expect(svc.authenticate(mtls(''))).resolves.toBe('deny');
    await expect(svc.authenticate(mtls(''))).resolves.toBe('deny');
    expect(audit.recordAlone).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((audit.recordAlone as jest.Mock).mock.calls[0])).toContain('device_jwt_missing');
  });

  it('refuses expired or revoked certificates and non-connectable states', async () => {
    for (const device of [
      { certNotAfter: new Date('2026-10-01T00:00:00Z') },
      { certFingerprint: null },
      { status: 'retired' },
      { status: 'assigned' },
      { kind: 'meter' },
    ])
      await expect(service({ requireJwt: true, device }).svc.authenticate(mtls('good'))).resolves.toBe(
        'deny',
      );
  });

  it('strips EMQX shared-subscription prefixes', () => {
    expect(stripShare('$share/ingest/gp/v1/+/telemetry')).toBe('gp/v1/+/telemetry');
    expect(stripShare('gp/v1/x/cmd')).toBe('gp/v1/x/cmd');
  });
});

describe('InternalEmqxGuard (/internal/* is docker-network only)', () => {
  const guard = (env: Record<string, string>) =>
    new InternalEmqxGuard({ get: (k: string) => env[k] } as unknown as AppConfig);
  const ctx = (ip: string, token?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ ip, headers: token ? { 'x-emqx-auth-token': token } : {} }),
      }),
    }) as unknown as ExecutionContext;

  it('404 for a public caller, 403 for a wrong token or an empty EMQX_AUTH_TOKEN', () => {
    const g = guard({ EMQX_AUTH_TOKEN: 'secret-token' });
    expect(() => g.canActivate(ctx('203.0.113.7', 'secret-token'))).toThrow(
      expect.objectContaining({ code: 'http.not_found' }),
    );
    expect(() => g.canActivate(ctx('172.30.0.5', 'wrong-token!'))).toThrow(
      expect.objectContaining({ code: 'auth.forbidden' }),
    );
    expect(() => guard({}).canActivate(ctx('172.30.0.5', ''))).toThrow(
      expect.objectContaining({ code: 'auth.forbidden' }),
    );
    expect(g.canActivate(ctx('::ffff:172.30.0.5', 'secret-token'))).toBe(true);
  });
});

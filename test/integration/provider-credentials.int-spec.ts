import { ProviderCredentialsService } from '@core/credentials/provider-credentials.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, ownerToken, supportToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

/**
 * O-013 resolved → D-240: per-merchant provider credentials in PostgreSQL, sealed with the tenant data key, values
 * write-only, every decrypt audited; the legacy Secrets Manager paths only as a migration fallback + import.
 */
describe('provider credentials in the database (D-240, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let store: ProviderCredentialsService;
  const values = { apiKey: 'k_live_SECRET_123', apiSecret: 's3cr3t-value', webhookSecret: 'whsec_abc' };
  const set = (body: Record<string, unknown>, token = admin) =>
    t.http.post('/v1/admin/provider-credentials').set(bearer(token)).set(idem()).send(body);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_creds' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20', PROVIDER_CREDENTIALS_LEGACY_SECRETS: 'false' });
    admin = await adminToken(t);
    store = t.app.get(ProviderCredentialsService);
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('platform admin seals a tenant merchant credential; the API never returns values', async () => {
    const res = await set({
      tenantId: DEV.tenantId,
      kind: 'payment',
      provider: 'kbank',
      merchantRef: 'KB-M-000042',
      values,
      reason: 'new key from the bank portal',
    }).expect(201);
    expect(res.body).toMatchObject({
      tenantId: DEV.tenantId,
      kind: 'payment',
      provider: 'kbank',
      accountRefHint: '0042',
      keyNames: ['apiKey', 'apiSecret', 'webhookSecret'],
      source: 'admin',
      revokedAt: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('SECRET_123');
    const row = await db.admin.query<{ secret_enc: Buffer; account_ref_hash: Buffer }>(
      `SELECT secret_enc, account_ref_hash FROM platform.provider_credential WHERE id = $1`,
      [res.body.id],
    );
    expect(row.rows[0]!.secret_enc.toString('latin1')).not.toContain('SECRET_123');
    expect(row.rows[0]!.account_ref_hash.toString('latin1')).not.toContain('KB-M-000042');
    const list = await t.http
      .get(`/v1/admin/provider-credentials?tenantId=${DEV.tenantId}`)
      .set(bearer(admin))
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('s3cr3t');
    const audit = await db.admin.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM platform.audit_log WHERE action = 'provider_credential.set' AND subject_id = $1`,
      [res.body.id],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({ kind: 'payment', provider: 'kbank' });
    expect(JSON.stringify(audit.rows)).not.toContain('SECRET_123');
    const event = await db.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.domain_event WHERE type = 'provider_credential.changed' AND aggregate_id = $1`,
      [res.body.id],
    );
    expect(event.rows[0]!.payload).toMatchObject({ change: 'set', kind: 'payment' });
  });

  it('adapters read it back (tenant data key); every decrypt is audited, then cached for 5 minutes', async () => {
    const ref = {
      tenantId: DEV.tenantId,
      kind: 'payment' as const,
      provider: 'kbank',
      merchantRef: 'KB-M-000042',
    };
    expect(await store.get(ref, 'test')).toEqual(values);
    expect(await store.get(ref, 'test')).toEqual(values);
    const decrypts = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE action = 'provider_credential.decrypted' AND tenant_id = $1`,
      [DEV.tenantId],
    );
    expect(decrypts.rows[0]!.n).toBe(1);
    // another merchant reference of the same tenant has no credential
    expect(await store.get({ ...ref, merchantRef: 'KB-M-OTHER' }, 'test')).toBeNull();
  });

  it('a replacement revokes the previous credential; a revoke leaves the adapter without one', async () => {
    const ref = {
      tenantId: DEV.tenantId,
      kind: 'payment' as const,
      provider: 'kbank',
      merchantRef: 'KB-M-000042',
    };
    const next = await set({ ...ref, values: { apiKey: 'k_live_NEW' }, reason: 'rotated' }).expect(201);
    expect(await store.get(ref, 'test')).toEqual({ apiKey: 'k_live_NEW' });
    const all = await t.http
      .get(`/v1/admin/provider-credentials?tenantId=${DEV.tenantId}&includeRevoked=true`)
      .set(bearer(admin))
      .expect(200);
    expect(all.body).toHaveLength(2);
    expect((all.body as { revokedAt: string | null }[]).filter((c) => c.revokedAt === null)).toHaveLength(1);
    await t.http
      .post(`/v1/admin/provider-credentials/${next.body.id}/actions/revoke`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'leaked in an e-mail' })
      .expect(200);
    expect(await store.get(ref, 'test')).toBeNull();
    await t.http
      .post(`/v1/admin/provider-credentials/${next.body.id}/actions/revoke`)
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'again again' })
      .expect(422);
  });

  it('lock and e-Tax accounts per tenant; the platform merchant with the platform key', async () => {
    await set({
      tenantId: DEV.tenantId,
      kind: 'lock',
      provider: 'ttlock',
      values: { clientId: 'c', clientSecret: 's' },
      reason: 'onboarding',
    }).expect(201);
    expect(await store.get({ tenantId: DEV.tenantId, kind: 'lock', provider: 'ttlock' }, 'test')).toEqual({
      clientId: 'c',
      clientSecret: 's',
    });
    await set({
      tenantId: null,
      kind: 'payment',
      provider: 'scb',
      merchantRef: 'GP-PLATFORM',
      values: { apiKey: 'p' },
      reason: 'platform merchant',
    }).expect(201);
    expect(
      await store.get(
        { tenantId: null, kind: 'payment', provider: 'scb', merchantRef: 'GP-PLATFORM' },
        'test',
      ),
    ).toEqual({ apiKey: 'p' });
  });

  it('validation, unknown tenant (404) and who may call it', async () => {
    const lockForPlatform = await set({
      tenantId: null,
      kind: 'lock',
      provider: 'ttlock',
      values: { a: 'b' },
      reason: 'nope',
    }).expect(422);
    expect(lockForPlatform.body.code).toBe('validation.failed');
    await set({
      tenantId: DEV.tenantId,
      kind: 'payment',
      provider: 'paypal',
      merchantRef: 'x',
      values: { a: 'b' },
      reason: 'nope',
    }).expect(422);
    await set({
      tenantId: DEV.tenantId,
      kind: 'payment',
      provider: 'kbank',
      values: { a: 'b' },
      reason: 'no merchant ref',
    }).expect(422);
    await set({
      tenantId: DEV.tenantId,
      kind: 'etax',
      provider: 'inet',
      values: { 'bad key': 'b' },
      reason: 'nope',
    }).expect(422);
    await set({
      tenantId: '0199f2a0-0000-7000-8000-00000000ffff',
      kind: 'etax',
      provider: 'inet',
      values: { a: 'b' },
      reason: 'unknown tenant',
    }).expect(404);
    await t.http
      .post('/v1/admin/provider-credentials/0199f2a0-0000-7000-8000-00000000ffff/actions/revoke')
      .set(bearer(admin))
      .set(idem())
      .send({ reason: 'nope nope' })
      .expect(404);
    // operators never reach it (platform audience); support lacks the permission
    await set(
      { tenantId: DEV.tenantId, kind: 'etax', provider: 'inet', values: { a: 'b' }, reason: 'owner' },
      await ownerToken(t),
    ).expect(403);
    await set(
      { tenantId: DEV.tenantId, kind: 'etax', provider: 'inet', values: { a: 'b' }, reason: 'support' },
      await supportToken(t),
    ).expect(403);
  });

  it('the application role cannot read the table at all (platform only)', async () => {
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE gp_app');
      await expect(db.admin.query('SELECT count(*) FROM platform.provider_credential')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await db.admin.query('ROLLBACK');
    }
  });

  it('migration: the legacy Secrets Manager path is read only with PROVIDER_CREDENTIALS_LEGACY_SECRETS; import copies it', async () => {
    expect(store.legacyPath({ tenantId: DEV.tenantId, kind: 'etax', provider: 'inet' })).toBe(
      `getproperty/etax/inet/${DEV.tenantId}`,
    );
    // off: no row → null even though the fake secret store would answer
    expect(await store.get({ tenantId: DEV.tenantId, kind: 'etax', provider: 'inet' }, 'test')).toBeNull();
    const legacyApp = await createIntApp(db, {
      OTP_MAX_PER_HOUR: '20',
      PROVIDER_CREDENTIALS_LEGACY_SECRETS: 'true',
    });
    try {
      const legacy = legacyApp.app.get(ProviderCredentialsService);
      expect(await legacy.get({ tenantId: DEV.tenantId, kind: 'etax', provider: 'inet' }, 'test')).toEqual({
        fake: 'true',
      });
      const result = await legacy.importLegacy();
      // the platform merchant of the seeded setting (kbank / GP-PLATFORM) had no row yet
      expect(result.imported).toBeGreaterThanOrEqual(1);
      const imported = await db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform.provider_credential WHERE source = 'import' AND tenant_id IS NULL AND provider = 'kbank' AND revoked_at IS NULL`,
      );
      expect(imported.rows[0]!.n).toBe(1);
      expect((await legacy.importLegacy()).imported).toBe(0); // idempotent
    } finally {
      await legacyApp.close();
    }
  });
});

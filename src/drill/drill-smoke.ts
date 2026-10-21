import { assetCoreStatus } from '@collective/asset-core';
import { type INestApplication } from '@nestjs/common';
import { Client } from 'pg';

import { listMigrations } from '../database/migrations/app-migrations';

export type SmokeOutcome = 'ok' | 'fail' | 'skip';

export interface SmokeLine {
  check: string;
  outcome: SmokeOutcome;
  detail: string;
}

export interface DrillSmokeOptions {
  databaseUrl: string;
  /** The backup is this box's environment: its keys are present, so the application checks can run. */
  sameEnv: boolean;
  /** Application role for the RLS check (`DATABASE_APP_ROLE`, `gp_app`). */
  appRole?: string;
  /** Boots the API in-process with the drill's database (fakes for Valkey, MQTT, S3, providers); undefined = skip. */
  bootApp?: () => Promise<{ app: INestApplication; lastOtp: (phone: string) => string | undefined }>;
  log?: (line: string) => void;
}

/**
 * The getproperty part of the platform's monthly restore drill (collective-infra `bin/restore-drill.sh` →
 * `platform/products/getproperty/hooks/drill-smoke.sh` → `node dist/src/drill-smoke.js`; blueprint T-15, RUNBOOK §9).
 * Runs against the restored throw-away instance only, on the drill's isolated network (no Valkey, EMQX, S3 or
 * internet), within 512 MB. Prints one line per check — `SMOKE <check> ok|fail|skip <detail>` — and the caller exits 0
 * only when no check failed:
 * - `migrations`: every asset-core `core` migration and every app migration of this image is applied with its
 *   checksum (the backup is not older or newer than the code that will run on it);
 * - `rls_cross_tenant`: under the application role, a tenant's context reads none of another tenant's buildings, units,
 *   invoices or meter readings — and does read its own;
 * - `freshness` (information): the newest audit row, meter reading and invoice — how much the restore point lost;
 * - with the same environment's keys (`DRILL_SAME_ENV=true`): `owner_login` — an Owner signs in by SMS OTP through the
 *   real HTTP surface (fake SMS) and reads `/v1/owner/me`; `cross_tenant_api` — that Owner gets 404 for another tenant's
 *   building; `billing_preview` — the current billing cycle of one of the Owner's properties is opened and computed
 *   (drafts only; the drill database is discarded). Without those keys they are `skip` (a prod backup restored on uat).
 */
export async function runDrillSmoke(options: DrillSmokeOptions): Promise<SmokeLine[]> {
  const out: SmokeLine[] = [];
  const log = options.log ?? (() => undefined);
  const report = (check: string, outcome: SmokeOutcome, detail: string) => {
    out.push({ check, outcome, detail });
    log(`SMOKE ${check} ${outcome} ${detail}`);
  };
  const started = Date.now();
  const db = new Client({
    connectionString: options.databaseUrl,
    application_name: 'getproperty-drill-smoke',
  });
  await db.connect();
  let owner: { tenantId: string; phone: string | null } | null = null;
  let foreignBuilding: string | null = null;
  try {
    // 1. migrations ------------------------------------------------------------------------------------------
    try {
      const core = await assetCoreStatus({ client: db });
      const coreBad = core.filter((s) => s.state !== 'applied').map((s) => `${s.id}:${s.state}`);
      const { rows } = await db.query<{ migration_name: string }>(
        `SELECT migration_name FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      );
      const applied = new Set(rows.map((r) => r.migration_name));
      const expected = listMigrations().map((m) => m.name);
      const missing = expected.filter((m) => !applied.has(m));
      const unknown = [...applied].filter((m) => !expected.includes(m));
      report(
        'migrations',
        coreBad.length || missing.length || unknown.length ? 'fail' : 'ok',
        `core=${core.length - coreBad.length}/${core.length} app=${expected.length - missing.length}/${expected.length}` +
          (coreBad.length ? ` core_problems=${coreBad.join(',')}` : '') +
          (missing.length ? ` missing=${missing.join(',')}` : '') +
          (unknown.length ? ` unknown=${unknown.join(',')}` : ''),
      );
    } catch (error) {
      report('migrations', 'fail', (error as Error).message.slice(0, 200));
    }

    // 2. tenant isolation under RLS --------------------------------------------------------------------------
    try {
      const tenants = await db.query<{ id: string; buildings: number }>(
        `SELECT t.id::text, count(b.id)::int AS buildings FROM core.tenant t
           JOIN core.building b ON b.owner_tenant_id = t.id AND b.operator_tenant_id = t.id AND b.deleted_at IS NULL
          GROUP BY t.id ORDER BY count(b.id) DESC, t.id LIMIT 2`,
      );
      const ownerRow = await db.query<{ tenant_id: string; phone: string | null }>(
        `SELECT m.tenant_id::text, u.phone_e164 AS phone FROM core.membership m
           JOIN core.user_account u ON u.id = m.user_id
          WHERE m.role = 'owner' AND m.status = 'active' AND u.status = 'active'
          ORDER BY (SELECT count(*) FROM core.building b WHERE b.operator_tenant_id = m.tenant_id) DESC,
                   u.phone_e164 IS NULL, m.created_at LIMIT 1`,
      );
      owner = ownerRow.rows[0]
        ? { tenantId: ownerRow.rows[0].tenant_id, phone: ownerRow.rows[0].phone }
        : null;
      if (tenants.rows.length < 2) {
        report(
          'rls_cross_tenant',
          'skip',
          `only ${tenants.rows.length} tenant(s) with own buildings in this backup`,
        );
      } else {
        const a = tenants.rows[0]!;
        const b = tenants.rows[1]!;
        const foreign = await db.query<{ id: string }>(
          `SELECT b.id::text FROM core.building b
            WHERE b.owner_tenant_id = $1 AND b.operator_tenant_id = $1 AND b.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM core.asset_access_grant g WHERE g.tenant_id = $1 AND g.grantee_tenant_id = $2 AND g.revoked_at IS NULL)
            LIMIT 1`,
          [b.id, a.id],
        );
        foreignBuilding = foreign.rows[0]?.id ?? null;
        await db.query('BEGIN');
        try {
          await db.query(`SET LOCAL ROLE ${options.appRole ?? 'gp_app'}`);
          await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.id]);
          const seen = await db.query<{
            own: number;
            buildings: number;
            units: number;
            invoices: number;
            readings: number;
          }>(
            `SELECT (SELECT count(*) FROM core.building WHERE owner_tenant_id = $1)::int AS own,
                    (SELECT count(*) FROM core.building WHERE owner_tenant_id = $2 AND operator_tenant_id = $2)::int AS buildings,
                    (SELECT count(*) FROM core.unit WHERE tenant_id = $2)::int AS units,
                    (SELECT count(*) FROM ops.invoice WHERE tenant_id = $2)::int AS invoices,
                    (SELECT count(*) FROM smart.meter_reading WHERE tenant_id = $2)::int AS readings`,
            [a.id, b.id],
          );
          const r = seen.rows[0]!;
          const leaked = r.buildings + r.units + r.invoices + r.readings;
          report(
            'rls_cross_tenant',
            leaked === 0 && r.own > 0 ? 'ok' : 'fail',
            `own_buildings=${r.own} foreign_rows_seen=${leaked}`,
          );
        } finally {
          await db.query('ROLLBACK');
        }
      }
    } catch (error) {
      report('rls_cross_tenant', 'fail', (error as Error).message.slice(0, 200));
    }

    // 3. freshness (information) -------------------------------------------------------------------------------
    try {
      const f = await db.query<{ audit: Date | null; reading: Date | null; invoice: Date | null }>(
        `SELECT (SELECT max(occurred_at) FROM platform.audit_log) AS audit,
                (SELECT max(created_at) FROM smart.meter_reading) AS reading,
                (SELECT max(created_at) FROM ops.invoice) AS invoice`,
      );
      const r = f.rows[0]!;
      const iso = (d: Date | null) => (d ? d.toISOString() : 'n/a');
      report(
        'freshness',
        'ok',
        `audit=${iso(r.audit)} meter_reading=${iso(r.reading)} invoice=${iso(r.invoice)}`,
      );
    } catch (error) {
      report('freshness', 'fail', (error as Error).message.slice(0, 200));
    }
  } finally {
    await db.end();
  }

  // 4. application checks (same environment only) -------------------------------------------------------------
  const appChecks = ['owner_login', 'cross_tenant_api', 'billing_preview'];
  if (!options.sameEnv || !options.bootApp) {
    for (const c of appChecks)
      report(c, 'skip', 'DRILL_SAME_ENV is not true: the source environment’s keys are not on this box');
  } else if (!owner?.phone) {
    for (const c of appChecks) report(c, 'fail', 'no active Owner with a phone in this backup');
  } else {
    let booted: Awaited<ReturnType<NonNullable<DrillSmokeOptions['bootApp']>>> | null = null;
    try {
      booted = await options.bootApp();
      await appSmoke(booted, owner as { tenantId: string; phone: string }, foreignBuilding, report);
    } catch (error) {
      for (const c of appChecks.filter((c) => !out.some((l) => l.check === c)))
        report(c, 'fail', (error as Error).message.slice(0, 200));
    } finally {
      await booted?.app.close().catch(() => undefined);
    }
  }
  log(`SMOKE_ELAPSED_MS ${Date.now() - started}`);
  return out;
}

async function appSmoke(
  booted: { app: INestApplication; lastOtp: (phone: string) => string | undefined },
  owner: { tenantId: string; phone: string },
  foreignBuilding: string | null,
  report: (check: string, outcome: SmokeOutcome, detail: string) => void,
): Promise<void> {
  const server = booted.app.getHttpServer() as { address(): { port: number } | string | null };
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the smoke API is not listening');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}`, 'x-tenant-id': owner.tenantId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  // owner login through the real auth surface (SMS OTP — the fake SMS gateway hands the code back)
  const challenge = await call('POST', '/v1/auth/operator/otp/request', { phone: owner.phone });
  const code = booted.lastOtp(owner.phone);
  const verified =
    challenge.status === 200 && code
      ? await call('POST', '/v1/auth/operator/otp/verify', { challengeId: challenge.body.challengeId, code })
      : null;
  const token = typeof verified?.body.accessToken === 'string' ? verified.body.accessToken : null;
  const me = token ? await call('GET', '/v1/owner/me', undefined, token) : null;
  report(
    'owner_login',
    me?.status === 200 ? 'ok' : 'fail',
    `otp_request=${challenge.status} verify=${verified?.status ?? 'n/a'} me=${me?.status ?? 'n/a'}`,
  );
  if (!token) {
    report('cross_tenant_api', 'fail', 'no owner token');
    report('billing_preview', 'fail', 'no owner token');
    return;
  }

  if (!foreignBuilding) report('cross_tenant_api', 'skip', 'no building of another tenant in this backup');
  else {
    const res = await call('GET', `/v1/owner/buildings/${foreignBuilding}`, undefined, token);
    report('cross_tenant_api', res.status === 404 ? 'ok' : 'fail', `foreign_building=${res.status}`);
  }

  const properties = await call('GET', '/v1/owner/properties', undefined, token);
  // the list answers a plain array (or a page envelope)
  const body: unknown = properties.body;
  const items = (Array.isArray(body) ? body : (body as { data?: unknown }).data) as
    { id: string }[] | undefined;
  const propertyId = items?.[0]?.id;
  if (!propertyId) {
    report('billing_preview', 'skip', `no property for the Owner (properties=${properties.status})`);
    return;
  }
  const t0 = Date.now();
  const opened = await call('POST', '/v1/owner/billing-cycles', { propertyId }, token);
  const cycleId = typeof opened.body.id === 'string' ? opened.body.id : null;
  const state = typeof opened.body.status === 'string' ? opened.body.status : 'n/a';
  if (!cycleId) {
    report('billing_preview', 'fail', `open=${opened.status}`);
    return;
  }
  if (!['open', 'readings_pending', 'computed'].includes(state)) {
    report('billing_preview', 'ok', `cycle=${state} (already past compute; not recomputed)`);
    return;
  }
  const computed = await call('POST', `/v1/owner/billing-cycles/${cycleId}/actions/compute`, {}, token);
  report(
    'billing_preview',
    computed.status === 200 || computed.status === 202 ? 'ok' : 'fail',
    `compute=${computed.status} status=${typeof computed.body.status === 'string' ? computed.body.status : 'n/a'} ms=${Date.now() - t0}`,
  );
}

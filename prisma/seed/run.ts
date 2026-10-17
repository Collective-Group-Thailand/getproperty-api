// `pnpm db:seed` (reference data) and `pnpm db:seed:dev` (reference + the development tenant).
//   node dist/prisma/seed/run.js reference|dev
// Idempotent: every insert is ON CONFLICT DO NOTHING / DO UPDATE on a natural key, so running twice changes
// nothing (the integration suite proves it). Seeds write platform catalogues and core rows, so they run with a
// role that bypasses RLS: a superuser (local embedded cluster), or a login that is a member of gp_platform
// (the script switches with SET ROLE gp_platform). Business values come from src/core/* catalogues and
// prisma/seed/data/* with their decision ids and sources.
import { lookupHash } from '@collective/asset-core';
import { Client, type ClientBase } from 'pg';

import { DEV_FIELD_HASH_KEY } from '../../src/common/crypto/lookup-hasher';
import { COMPLIANCE_RULES } from '../../src/core/compliance/rules';
import { FEATURE_FLAGS } from '../../src/core/feature-flags/catalogue';
import { hashPassword } from '../../src/core/identity/crypto/password';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, splitPermission } from '../../src/core/rbac/catalogue';
import { SETTINGS } from '../../src/core/settings/catalogue';
import { WORKFLOW_DEFINITIONS } from '../../src/core/workflow/definitions';
import { specToRow } from '../../src/core/workflow/engine';
import { LINE_KIND_RULES } from '../../src/modules/ops-billing/engine/line-kinds';
import {
  DEFAULT_INSPECTION_ITEMS,
  DEFAULT_INSPECTION_TEMPLATE_NAME,
} from '../../src/modules/ops-deposits/inspection-checklist';
import {
  CLAUSE_SCHEMA,
  FORBIDDEN_CLAUSE_TYPES,
  STANDARD_TEMPLATE_BODY,
  STANDARD_TEMPLATE_EFFECTIVE_FROM,
  STANDARD_TEMPLATE_KEY,
  STANDARD_TEMPLATE_LEGAL_REF,
  STANDARD_TEMPLATE_NAME,
  STANDARD_TEMPLATE_VERSION,
} from '../../src/modules/ops-leases/contract-template';
import { HOLIDAYS } from './data/holidays';
import { NOTIFICATION_ROUTES, NOTIFICATION_TEMPLATES } from './data/notifications';
import { CONSENT_PURPOSES, RETENTION_POLICIES } from './data/privacy';
import { UTILITY_TARIFFS } from './data/utility-tariffs';

export type SeedMode = 'reference' | 'dev';

/** Date the reference data was authored (retention policies are keyed by it). */
const SEED_DATE = '2026-10-17';

/** Fixed ids of the development data (uuidv7-shaped) so re-runs and tests can find them. */
export const DEV = {
  tenantId: '0199f2a0-0000-7000-8000-000000000001',
  legalPartyId: '0199f2a0-0000-7000-8000-000000000002',
  propertyId: '0199f2a0-0000-7000-8000-000000000003',
  buildingId: '0199f2a0-0000-7000-8000-000000000004',
  /** B2.3 sample lease on A-101 with a fake resident (signed on paper, active). */
  residentPartyId: '0199f2a0-0000-7000-8000-000000000005',
  leaseId: '0199f2a0-0000-7000-8000-000000000006',
  users: {
    owner: '0199f2a0-0000-7000-8000-0000000000a1',
    manager: '0199f2a0-0000-7000-8000-0000000000a2',
    staff: '0199f2a0-0000-7000-8000-0000000000a3',
    platformAdmin: '0199f2a0-0000-7000-8000-0000000000b1',
    support: '0199f2a0-0000-7000-8000-0000000000b2',
  },
  /**
   * Password of the development operators and platform users (dev seed only, never in production: the dev tenant
   * and its `example.invalid` accounts exist only with `db:seed:dev`). Platform users enrol TOTP at first sign-in.
   */
  password: 'getproperty-dev-only-password',
} as const;

type Log = (line: string) => void;

async function tx<T>(db: ClientBase, work: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const result = await work();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/** Seeds the reference data (and, in dev mode, the development tenant). Returns row counts per seeded table. */
export async function runSeed(
  db: ClientBase,
  mode: SeedMode,
  log: Log = () => undefined,
): Promise<Record<string, number>> {
  const { rows: who } = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  if (!who[0]?.rolsuper && !who[0]?.rolbypassrls) {
    await db.query('SET ROLE gp_platform');
    log('seed: running as gp_platform (BYPASSRLS)');
  }

  await tx(db, () => seedRbac(db));
  await tx(db, () => seedSettings(db));
  await tx(db, () => seedComplianceRules(db));
  await tx(db, () => seedInvoiceLineKinds(db));
  await tx(db, () => seedUtilityTariffs(db));
  await tx(db, () => seedCalendar(db));
  await tx(db, () => seedPrivacy(db));
  await tx(db, () => seedNotificationTemplates(db));
  await tx(db, () => seedNotificationRoutes(db));
  await tx(db, () => seedFeatureFlags(db));
  await tx(db, () => seedWorkflowDefinitions(db));
  await tx(db, () => seedLeaseTemplates(db));
  await tx(db, () => seedInspectionTemplates(db));
  if (mode === 'dev') await tx(db, () => seedDev(db));

  const counts = await countRows(db);
  for (const [table, n] of Object.entries(counts)) log(`seed: ${table.padEnd(42)} ${n}`);
  return counts;
}

async function seedRbac(db: ClientBase): Promise<void> {
  for (const r of ROLES) {
    await db.query(
      `INSERT INTO platform.role (key, scope_kind, name_th, name_en, description, is_system)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (key) DO UPDATE SET scope_kind = EXCLUDED.scope_kind, name_th = EXCLUDED.name_th,
         name_en = EXCLUDED.name_en, description = EXCLUDED.description
       WHERE (platform.role.scope_kind, platform.role.name_th, platform.role.name_en, platform.role.description)
             IS DISTINCT FROM (EXCLUDED.scope_kind, EXCLUDED.name_th, EXCLUDED.name_en, EXCLUDED.description)`,
      [r.key, r.scopeKind, r.nameTh, r.nameEn, r.description],
    );
  }
  for (const p of PERMISSIONS) {
    const { resource, action } = splitPermission(p.key);
    await db.query(
      `INSERT INTO platform.permission (key, resource, action, description, surfaces) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, surfaces = EXCLUDED.surfaces
       WHERE (platform.permission.description, platform.permission.surfaces) IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.surfaces)`,
      [p.key, resource, action, p.description, p.surfaces],
    );
  }
  for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
    await db.query(
      `INSERT INTO platform.role_permission (role_id, permission_id)
       SELECT r.id, p.id FROM platform.role r JOIN platform.permission p ON p.key = ANY ($2::text[]) WHERE r.key = $1
       ON CONFLICT DO NOTHING`,
      [role, keys],
    );
    // the catalogue is the truth: drop grants removed from code (system roles only)
    await db.query(
      `DELETE FROM platform.role_permission rp USING platform.role r, platform.permission p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.key = $1 AND r.is_system AND NOT (p.key = ANY ($2::text[]))`,
      [role, keys],
    );
  }
}

async function seedSettings(db: ClientBase): Promise<void> {
  for (const s of SETTINGS) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform.setting (key, value_type, scope_allowed, description, editable_by)
       VALUES ($1, $2, $3::platform.setting_scope[], $4, $5)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, scope_allowed = EXCLUDED.scope_allowed,
         editable_by = EXCLUDED.editable_by
       RETURNING id`,
      [s.key, s.valueType, s.scopeAllowed, s.description, s.editableBy],
    );
    // the first platform value only; later changes are new versions made by the platform admin (never backdated)
    await db.query(
      `INSERT INTO platform.setting_version (setting_id, value, effective_from, reason)
       SELECT $1, $2::jsonb, now(), $3
        WHERE NOT EXISTS (SELECT 1 FROM platform.setting_version WHERE setting_id = $1)`,
      [rows[0]!.id, JSON.stringify(s.value), s.reason],
    );
  }
}

async function seedComplianceRules(db: ClientBase): Promise<void> {
  for (const r of COMPLIANCE_RULES) {
    // status is never overwritten: a rule the legal team verified stays verified (D-149)
    await db.query(
      `INSERT INTO platform.compliance_rule (id, legal_ref, default_severity, applies_to, description_th, description_en, settings_used, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_legal_verification')
       ON CONFLICT (id) DO UPDATE SET legal_ref = EXCLUDED.legal_ref, default_severity = EXCLUDED.default_severity,
         applies_to = EXCLUDED.applies_to, description_th = EXCLUDED.description_th,
         description_en = EXCLUDED.description_en, settings_used = EXCLUDED.settings_used, synced_at = now()
       WHERE (platform.compliance_rule.legal_ref, platform.compliance_rule.default_severity, platform.compliance_rule.applies_to,
              platform.compliance_rule.description_th, platform.compliance_rule.description_en, platform.compliance_rule.settings_used)
             IS DISTINCT FROM (EXCLUDED.legal_ref, EXCLUDED.default_severity, EXCLUDED.applies_to,
              EXCLUDED.description_th, EXCLUDED.description_en, EXCLUDED.settings_used)`,
      [r.id, r.legalRef, r.defaultSeverity, r.appliesTo, r.descriptionTh, r.descriptionEn, r.settingsUsed],
    );
  }
}

/** The invoice line kind catalogue (B4.2, D-041): reference data the engine and the invoice_line FK rely on. */
async function seedInvoiceLineKinds(db: ClientBase): Promise<void> {
  for (const r of LINE_KIND_RULES) {
    await db.query(
      `INSERT INTO ops.invoice_line_kind_rule (line_kind, source_type, requires_lease_line, requires_meter, compliance_rule_id, allowed_when_setting, description)
       VALUES ($1::ops.invoice_line_kind, $2::ops.invoice_line_source_type, $3, $4, $5, $6, $7)
       ON CONFLICT (line_kind) DO UPDATE SET source_type = EXCLUDED.source_type,
         requires_lease_line = EXCLUDED.requires_lease_line, requires_meter = EXCLUDED.requires_meter,
         compliance_rule_id = EXCLUDED.compliance_rule_id, allowed_when_setting = EXCLUDED.allowed_when_setting,
         description = EXCLUDED.description, updated_at = now()
       WHERE (ops.invoice_line_kind_rule.source_type, ops.invoice_line_kind_rule.requires_lease_line,
              ops.invoice_line_kind_rule.requires_meter, ops.invoice_line_kind_rule.compliance_rule_id,
              ops.invoice_line_kind_rule.allowed_when_setting, ops.invoice_line_kind_rule.description)
             IS DISTINCT FROM (EXCLUDED.source_type, EXCLUDED.requires_lease_line, EXCLUDED.requires_meter,
              EXCLUDED.compliance_rule_id, EXCLUDED.allowed_when_setting, EXCLUDED.description)`,
      [
        r.lineKind,
        r.sourceType,
        r.requiresLeaseLine,
        r.requiresMeter,
        r.complianceRuleId,
        r.allowedWhenSetting,
        r.description,
      ],
    );
  }
}

async function seedUtilityTariffs(db: ClientBase): Promise<void> {
  for (const t of UTILITY_TARIFFS) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform.utility_tariff (utility, provider, tariff_code, name_th, name_en)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, tariff_code) DO UPDATE SET name_th = EXCLUDED.name_th, name_en = EXCLUDED.name_en
       RETURNING id`,
      [t.utility, t.provider, t.tariffCode, t.nameTh, t.nameEn],
    );
    for (const v of t.versions) {
      await db.query(
        `INSERT INTO platform.utility_tariff_version (utility_tariff_id, effective_from, effective_to, structure, ceiling_per_unit,
           source_url, source_published_at, state, needs_check, notes)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'entered', $8, $9)
         ON CONFLICT (utility_tariff_id, effective_from) DO NOTHING`,
        [
          rows[0]!.id,
          v.effectiveFrom,
          v.effectiveTo,
          JSON.stringify(v.structure),
          v.structure.ceilingPerUnit,
          v.sourceUrl,
          v.sourcePublishedAt,
          v.needsCheck,
          v.notes,
        ],
      );
    }
  }
}

async function seedCalendar(db: ClientBase): Promise<void> {
  for (const h of HOLIDAYS) {
    await db.query(
      `INSERT INTO platform.business_calendar (calendar, holiday_date, name_th, name_en, source_url)
       VALUES ('th_public', $1, $2, $3, $4) ON CONFLICT (calendar, holiday_date) DO NOTHING`,
      [h.date, h.nameTh, h.nameEn, h.sourceUrl],
    );
  }
}

async function seedPrivacy(db: ClientBase): Promise<void> {
  for (const p of CONSENT_PURPOSES) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform.consent_purpose (key, audience, required) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET audience = EXCLUDED.audience RETURNING id`,
      [p.key, p.audience, p.required],
    );
    for (const [language, text] of [
      ['th', p.th],
      ['en', p.en],
    ] as const) {
      await db.query(
        `INSERT INTO platform.consent_purpose_version (purpose_id, version, language, title, body_markdown, effective_from)
         VALUES ($1, 1, $2, $3, $4, now()) ON CONFLICT (purpose_id, language, version) DO NOTHING`,
        [rows[0]!.id, language, text.title, text.body],
      );
    }
  }
  for (const r of RETENTION_POLICIES) {
    await db.query(
      `INSERT INTO platform.retention_policy (target, target_key, retain_for, basis, action, legal_ref, effective_from)
       VALUES ($1, $2, $3::interval, $4, $5, $6, $7) ON CONFLICT (target, target_key, effective_from) DO NOTHING`,
      [r.target, r.targetKey, r.retainFor, r.basis, r.action, r.legalRef, SEED_DATE],
    );
  }
}

async function seedNotificationTemplates(db: ClientBase): Promise<void> {
  for (const t of NOTIFICATION_TEMPLATES) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform.notification_template (key, channel, audience, description) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key, channel, audience) DO UPDATE SET description = EXCLUDED.description RETURNING id`,
      [t.key, t.channel, t.audience, t.description],
    );
    for (const v of t.versions) {
      const version = v.version ?? 1;
      // a seeded later version retires the published earlier one of its language (one published per language);
      // it never overrides a version the platform admin published since (only versions below it are retired)
      if (version > 1)
        await db.query(
          `UPDATE platform.notification_template_version SET state = 'retired'
            WHERE template_id = $1 AND language = $2 AND state = 'published' AND version < $3
              AND NOT EXISTS (SELECT 1 FROM platform.notification_template_version x
                               WHERE x.template_id = $1 AND x.language = $2 AND x.version >= $3)`,
          [rows[0]!.id, v.language, version],
        );
      await db.query(
        `INSERT INTO platform.notification_template_version (template_id, version, language, subject, body, format, state, published_at)
         SELECT $1, $5, $2, $3, $4, $6::platform.template_format,
                CASE WHEN EXISTS (SELECT 1 FROM platform.notification_template_version x
                                   WHERE x.template_id = $1 AND x.language = $2 AND x.state = 'published')
                     THEN 'retired'::platform.template_version_state ELSE 'published' END,
                now()
         ON CONFLICT (template_id, language, version) DO NOTHING`,
        [rows[0]!.id, v.language, v.subject, v.body, version, v.format ?? 'handlebars_text'],
      );
    }
  }
}

async function seedNotificationRoutes(db: ClientBase): Promise<void> {
  for (const r of NOTIFICATION_ROUTES) {
    await db.query(
      `INSERT INTO platform.notification_route (tenant_id, event_type, audience, channel, enabled, urgent)
       VALUES (NULL, $1, $2, $3, true, $4) ON CONFLICT (tenant_id, event_type, audience, channel) DO NOTHING`,
      [r.eventType, r.audience, r.channel, r.urgent],
    );
  }
}

async function seedFeatureFlags(db: ClientBase): Promise<void> {
  for (const f of FEATURE_FLAGS) {
    // defaults are seeded once; later changes are made by the platform admin (audited)
    await db.query(
      `INSERT INTO platform.feature_flag (key, description, default_enabled, rollout_pct) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description
       WHERE platform.feature_flag.description IS DISTINCT FROM EXCLUDED.description`,
      [f.key, f.description, f.defaultEnabled, f.rolloutPct],
    );
  }
}

/** Workflow definitions live in code (D-159) and are versioned: a version once seeded is never rewritten. */
async function seedWorkflowDefinitions(db: ClientBase): Promise<void> {
  for (const spec of WORKFLOW_DEFINITIONS) {
    const row = specToRow(spec);
    await db.query(
      `INSERT INTO ops.workflow_definition (tenant_id, key, version, states, transitions, sla, is_active)
       SELECT NULL, $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, true
        WHERE NOT EXISTS (SELECT 1 FROM ops.workflow_definition WHERE tenant_id IS NULL AND key = $1 AND version = $2)`,
      [
        row.key,
        row.version,
        JSON.stringify(row.states),
        JSON.stringify(row.transitions),
        JSON.stringify(row.sla),
      ],
    );
  }
}

/** The platform default inspection checklist (B2.4, D-023) — tenant_id NULL; tenants may add their own. */
async function seedInspectionTemplates(db: ClientBase): Promise<void> {
  await db.query(
    `INSERT INTO ops.inspection_template (tenant_id, name, items) VALUES (NULL, $1, $2::jsonb)
     ON CONFLICT (tenant_id, name) DO NOTHING`,
    [DEFAULT_INSPECTION_TEMPLATE_NAME, JSON.stringify(DEFAULT_INSPECTION_ITEMS)],
  );
}

/** The platform สคบ. 2568 standard contract (D-020), version 1 — tenant_id NULL, published. */
async function seedLeaseTemplates(db: ClientBase): Promise<void> {
  await db.query(
    `INSERT INTO ops.lease_template (tenant_id, key, name) VALUES (NULL, $1, $2)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [STANDARD_TEMPLATE_KEY, STANDARD_TEMPLATE_NAME],
  );
  await db.query(
    `INSERT INTO ops.lease_template_version (template_id, tenant_id, version, language, body_html, clause_schema,
                                            forbidden_clause_types, legal_ref, state, effective_from, published_at)
     SELECT t.id, NULL, $2, 'th', $3, $4::jsonb, $5::text[], $6, 'published', $7, now()
       FROM ops.lease_template t
      WHERE t.tenant_id IS NULL AND t.key = $1
        AND NOT EXISTS (SELECT 1 FROM ops.lease_template_version v WHERE v.template_id = t.id AND v.language = 'th' AND v.version = $2)`,
    [
      STANDARD_TEMPLATE_KEY,
      STANDARD_TEMPLATE_VERSION,
      STANDARD_TEMPLATE_BODY,
      JSON.stringify(CLAUSE_SCHEMA),
      [...FORBIDDEN_CLAUSE_TYPES],
      STANDARD_TEMPLATE_LEGAL_REF,
      STANDARD_TEMPLATE_EFFECTIVE_FROM,
    ],
  );
}

/**
 * B2.3 development lease: a fake resident (no ID number — sealing needs the tenant key, enter it in the console)
 * renting A-101 from 2026-10-01 for 12 months, signed on paper (no e-signature rows), active: occupancy, unit
 * occupied, current lease, contract number CTR-2026-00001 taken from the series.
 */
async function seedDevLease(db: ClientBase): Promise<void> {
  await db.query(
    `INSERT INTO core.party (id, tenant_id, type, display_name, first_name, last_name, phone_e164, language, nationality)
     VALUES ($1, $2, 'person', 'ผู้เช่า ตัวอย่าง (ทดสอบ)', 'ผู้เช่า', 'ตัวอย่าง', '+660000000011', 'th', 'TH')
     ON CONFLICT (id) DO NOTHING`,
    [DEV.residentPartyId, DEV.tenantId],
  );
  await db.query(
    `INSERT INTO ops.document_series (tenant_id, doc_type, fiscal_year, prefix, next_number)
     VALUES ($1, 'contract', 2026, 'CTR', 2)
     ON CONFLICT (tenant_id, doc_type, fiscal_year) DO NOTHING`,
    [DEV.tenantId],
  );
  await db.query(
    `INSERT INTO ops.lease (id, tenant_id, building_id, unit_id, lessee_party_id, template_version_id, number, status,
                            start_date, end_date, months, move_in_at, rent, deposit_amount, advance_rent_amount,
                            advance_rent_months, billing_day, utility_billing_mode, keys_count, terms, addendum,
                            sent_for_signature_at, activated_at, compliance_snapshot)
     SELECT $1, $2, $3, u.id, $4, v.id, 'CTR-2026-00001', 'active', '2026-10-01', '2027-09-30', 12,
            '2026-10-01T10:00:00+07:00', 4500, 4500, 4500, 1, 5, 'metered', 2,
            '{"signedOnPaper": true, "source": "dev seed"}'::jsonb, '[]'::jsonb,
            '2026-09-25T10:00:00+07:00', '2026-09-25T10:00:00+07:00', '{"inScope": true, "checks": [], "seeded": true}'::jsonb
       FROM core.unit u, ops.lease_template_version v JOIN ops.lease_template t ON t.id = v.template_id
      WHERE u.building_id = $3 AND u.unit_no = 'A-101' AND t.tenant_id IS NULL AND t.key = $5 AND v.version = 1
     ON CONFLICT (id) DO NOTHING`,
    [DEV.leaseId, DEV.tenantId, DEV.buildingId, DEV.residentPartyId, STANDARD_TEMPLATE_KEY],
  );
  await db.query(
    `INSERT INTO ops.lease_party (tenant_id, lease_id, party_id, role, is_signer) VALUES ($1, $2, $3, 'lessee', true)
     ON CONFLICT (lease_id, party_id) DO NOTHING`,
    [DEV.tenantId, DEV.leaseId, DEV.residentPartyId],
  );
  await db.query(
    `INSERT INTO ops.lease_line (tenant_id, lease_id, kind, description, amount, recurrence, effective_from)
     SELECT $1, $2, 'internet', 'อินเทอร์เน็ต', 300, 'monthly', '2026-10-01'
      WHERE NOT EXISTS (SELECT 1 FROM ops.lease_line WHERE lease_id = $2)`,
    [DEV.tenantId, DEV.leaseId],
  );
  await db.query(
    `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, lease_id, valid_from, moved_in_at)
     SELECT l.tenant_id, l.building_id, l.unit_id, $2, 'tenant', l.id, l.start_date, l.move_in_at FROM ops.lease l
      WHERE l.id = $1 AND NOT EXISTS (SELECT 1 FROM core.occupancy o WHERE o.lease_id = $1)`,
    [DEV.leaseId, DEV.residentPartyId],
  );
  await db.query(
    `UPDATE core.unit u SET status = 'occupied', status_changed_at = '2026-10-01T10:00:00+07:00'
       FROM ops.lease l WHERE l.id = $1 AND u.id = l.unit_id AND u.status <> 'occupied'`,
    [DEV.leaseId],
  );
  await db.query(
    `UPDATE ops.unit_detail d SET current_lease_id = $1 FROM ops.lease l
      WHERE l.id = $1 AND d.unit_id = l.unit_id AND d.current_lease_id IS DISTINCT FROM $1`,
    [DEV.leaseId],
  );
  await db.query(
    `INSERT INTO ops.lease_event (tenant_id, lease_id, type, occurred_at, actor, data)
     SELECT $1, $2, 'activated', '2026-09-25T10:00:00+07:00', '{"type":"system","name":"seed"}', '{"signedOnPaper": true}'
      WHERE NOT EXISTS (SELECT 1 FROM ops.lease_event WHERE lease_id = $2)`,
    [DEV.tenantId, DEV.leaseId],
  );
}

/** Development data: one apartment tenant "หอพักตัวอย่าง" with obviously fake people (+66 0… numbers). */
async function seedDev(db: ClientBase): Promise<void> {
  const users: [string, string, string, string][] = [
    [DEV.users.owner, 'เจ้าของ ตัวอย่าง (ทดสอบ)', '+660000000001', 'owner@example.invalid'],
    [DEV.users.manager, 'ผู้จัดการ ตัวอย่าง (ทดสอบ)', '+660000000002', 'manager@example.invalid'],
    [DEV.users.staff, 'พนักงาน ตัวอย่าง (ทดสอบ)', '+660000000003', 'staff@example.invalid'],
    [DEV.users.platformAdmin, 'Platform Admin (test)', '+660000000091', 'admin@getproperty.invalid'],
    [DEV.users.support, 'Support (test)', '+660000000092', 'support@getproperty.invalid'],
  ];
  const hashKey = Buffer.from(process.env.FIELD_HASH_KEY ?? DEV_FIELD_HASH_KEY, 'utf8');
  const passwordHash = await hashPassword(DEV.password);
  for (const [id, name, phone, email] of users) {
    await db.query(
      `INSERT INTO core.user_account (id, display_name, phone_e164, phone_hash, email, phone_verified_at, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (id) DO UPDATE SET phone_hash = EXCLUDED.phone_hash WHERE core.user_account.phone_hash IS NULL`,
      [id, name, phone, lookupHash(hashKey, '', phone), email],
    );
    await db.query(
      `INSERT INTO platform.user_credential (user_id, password_hash, password_changed_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO NOTHING`,
      [id, passwordHash],
    );
  }
  await db.query(
    `INSERT INTO core.tenant (id, type, slug, display_name, legal_name, legal_form, vat_registered, address, plan)
     VALUES ($1, 'apartment', 'sample-dormitory', 'หอพักตัวอย่าง', 'บริษัท หอพักตัวอย่าง จำกัด (ข้อมูลทดสอบ)', 'company', false,
             $2::jsonb, 'apartment_starter')
     ON CONFLICT (id) DO NOTHING`,
    [
      DEV.tenantId,
      JSON.stringify({
        line1: '99/9 ถนนตัวอย่าง',
        district: 'เขตตัวอย่าง',
        province: 'กรุงเทพมหานคร',
        postcode: '10000',
        country: 'TH',
      }),
    ],
  );
  await db.query(
    `INSERT INTO core.party (id, tenant_id, type, display_name, company_name) VALUES ($1, $2, 'company', $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [DEV.legalPartyId, DEV.tenantId, 'บริษัท หอพักตัวอย่าง จำกัด (ข้อมูลทดสอบ)'],
  );
  await db.query(
    `UPDATE core.tenant SET legal_party_id = $2 WHERE id = $1 AND legal_party_id IS DISTINCT FROM $2`,
    [DEV.tenantId, DEV.legalPartyId],
  );
  for (const [user, role] of [
    [DEV.users.owner, 'owner'],
    [DEV.users.manager, 'manager'],
    [DEV.users.staff, 'staff'],
  ] as const) {
    await db.query(
      `INSERT INTO core.membership (tenant_id, user_id, role, status, joined_at) VALUES ($1, $2, $3, 'active', now())
       ON CONFLICT (tenant_id, user_id) WHERE deleted_at IS NULL DO NOTHING`,
      [DEV.tenantId, user, role],
    );
  }
  await db.query(
    `INSERT INTO core.property (id, tenant_id, code, name, address, province_code)
     VALUES ($1, $2, 'MAIN', 'หอพักตัวอย่าง', $3::jsonb, '10') ON CONFLICT (id) DO NOTHING`,
    [
      DEV.propertyId,
      DEV.tenantId,
      JSON.stringify({
        line1: '99/9 ถนนตัวอย่าง',
        province: 'กรุงเทพมหานคร',
        postcode: '10000',
        country: 'TH',
      }),
    ],
  );
  // apartment: owner = operator = the tenant (§4.6)
  await db.query(
    `INSERT INTO core.building (id, tenant_id, property_id, code, name, type, floors_count, owner_tenant_id, operator_tenant_id)
     VALUES ($1, $2, $3, 'A', 'อาคาร A', 'apartment', 2, $2, $2) ON CONFLICT (id) DO NOTHING`,
    [DEV.buildingId, DEV.tenantId, DEV.propertyId],
  );
  await db.query(
    `INSERT INTO core.building_operator_period (tenant_id, building_id, owner_tenant_id, operator_tenant_id, valid_from, reason)
     SELECT $1, $2, $1, $1, '2026-10-01T00:00:00+07:00', 'initial'
      WHERE NOT EXISTS (SELECT 1 FROM core.building_operator_period WHERE building_id = $2)`,
    [DEV.tenantId, DEV.buildingId],
  );
  await seedDevUnits(db);
  await seedDevLease(db);
  await seedDevDeposit(db);
  for (const [user, role] of [
    [DEV.users.platformAdmin, 'platform_admin'],
    [DEV.users.support, 'support'],
  ] as const) {
    await db.query(
      `INSERT INTO platform.platform_role_assignment (user_id, role_id)
       SELECT $1, r.id FROM platform.role r WHERE r.key = $2
       ON CONFLICT (user_id, role_id) WHERE revoked_at IS NULL DO NOTHING`,
      [user, role],
    );
  }
}

/**
 * B2.1 development data in the dev building: two room types, floors 1–2 with six units each (A-101 … A-206), the
 * tenant's legal party as owner of every unit (apartment rule), and one manual electric and water meter per unit.
 */
async function seedDevUnits(db: ClientBase): Promise<void> {
  const profiles: [string, string, string, string][] = [
    [
      'ห้องสตูดิโอ',
      '24.00',
      '4500.00',
      JSON.stringify([{ kind: 'internet', description: 'อินเทอร์เน็ต', amount: '300.00' }]),
    ],
    [
      'ห้องใหญ่',
      '32.00',
      '6500.00',
      JSON.stringify([
        { kind: 'internet', description: 'อินเทอร์เน็ต', amount: '300.00' },
        { kind: 'parking', description: 'ที่จอดรถ 1 คัน', amount: '500.00' },
      ]),
    ],
  ];
  for (const [name, area, rent, lines] of profiles)
    await db.query(
      `INSERT INTO ops.unit_profile (tenant_id, building_id, name, area_sqm, default_rent, default_deposit_months,
                                    default_advance_rent_months, default_lease_lines)
       VALUES ($1, $2, $3, $4, $5, 1, 1, $6::jsonb)
       ON CONFLICT (building_id, name) WHERE deleted_at IS NULL DO NOTHING`,
      [DEV.tenantId, DEV.buildingId, name, area, rent, lines],
    );
  for (const level of [1, 2]) {
    await db.query(
      `INSERT INTO core.floor (tenant_id, building_id, level, name, sort_order) VALUES ($1, $2, $3, $4, $3)
       ON CONFLICT (building_id, level) WHERE deleted_at IS NULL DO NOTHING`,
      [DEV.tenantId, DEV.buildingId, level, `ชั้น ${level}`],
    );
    for (let n = 1; n <= 6; n += 1) {
      const unitNo = `A-${level}${String(n).padStart(2, '0')}`;
      const profile = n <= 4 ? 'ห้องสตูดิโอ' : 'ห้องใหญ่';
      await db.query(
        `INSERT INTO core.unit (tenant_id, building_id, property_id, floor_id, unit_no, type, area_sqm, base_rent, status_changed_at)
         SELECT $1, $2, $3, f.id, $5, 'room', p.area_sqm, p.default_rent, now()
           FROM core.floor f, ops.unit_profile p
          WHERE f.building_id = $2 AND f.level = $4 AND f.deleted_at IS NULL
            AND p.building_id = $2 AND p.name = $6 AND p.deleted_at IS NULL
         ON CONFLICT (building_id, unit_no) WHERE deleted_at IS NULL DO NOTHING`,
        [DEV.tenantId, DEV.buildingId, DEV.propertyId, level, unitNo, profile],
      );
      await db.query(
        `INSERT INTO ops.unit_detail (unit_id, tenant_id, building_id, unit_profile_id)
         SELECT u.id, u.tenant_id, u.building_id, p.id FROM core.unit u, ops.unit_profile p
          WHERE u.building_id = $1 AND u.unit_no = $2 AND u.deleted_at IS NULL AND p.building_id = $1 AND p.name = $3
         ON CONFLICT (unit_id) DO NOTHING`,
        [DEV.buildingId, unitNo, profile],
      );
    }
  }
  await db.query(
    `INSERT INTO core.unit_ownership (tenant_id, building_id, unit_id, party_id, share_pct, valid_from, source)
     SELECT u.tenant_id, u.building_id, u.id, $2, 100, '2026-10-01', 'manual' FROM core.unit u
      WHERE u.building_id = $1 AND u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM core.unit_ownership o WHERE o.unit_id = u.id)`,
    [DEV.buildingId, DEV.legalPartyId],
  );
  for (const [utility, category, suffix, label] of [
    ['electric', 'meter_electric', 'E', 'มิเตอร์ไฟฟ้า'],
    ['water', 'meter_water', 'W', 'มิเตอร์น้ำ'],
  ] as const) {
    await db.query(
      `INSERT INTO core.asset_item (tenant_id, building_id, floor_id, unit_id, category, name, meta)
       SELECT u.tenant_id, u.building_id, u.floor_id, u.id, $2::core.asset_category, $3 || ' ' || u.unit_no, '{"reading":"manual"}'
         FROM core.unit u
        WHERE u.building_id = $1 AND u.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM core.asset_item a WHERE a.unit_id = u.id AND a.category = $2::core.asset_category)`,
      [DEV.buildingId, category, label],
    );
    await db.query(
      `INSERT INTO core.meter_assignment (tenant_id, building_id, asset_item_id, unit_id, purpose, utility, code, valid_from, initial_reading)
       SELECT a.tenant_id, a.building_id, a.id, a.unit_id, 'unit', $2::core.utility, u.unit_no || '-' || $3, '2026-10-01T00:00:00+07:00', 0
         FROM core.asset_item a JOIN core.unit u ON u.id = a.unit_id
        WHERE a.building_id = $1 AND a.category = $4::core.asset_category
          AND NOT EXISTS (SELECT 1 FROM core.meter_assignment m WHERE m.asset_item_id = a.id)`,
      [DEV.buildingId, utility, suffix, category],
    );
  }
}

/**
 * B2.4: the deposit of the development lease, received at signing (receipt DPR-2026-00001 from the series; no PDF —
 * documents need object storage, which seeds do not touch).
 */
async function seedDevDeposit(db: ClientBase): Promise<void> {
  await db.query(
    `INSERT INTO ops.document_series (tenant_id, doc_type, fiscal_year, prefix, next_number)
     VALUES ($1, 'deposit_receipt', 2026, 'DPR', 2)
     ON CONFLICT (tenant_id, doc_type, fiscal_year) DO NOTHING`,
    [DEV.tenantId],
  );
  await db.query(
    `INSERT INTO ops.deposit (tenant_id, building_id, unit_id, lease_id, amount_security, amount_advance_rent, status,
                              received_at, held_at, receipt_number, receipt_reference)
     SELECT l.tenant_id, l.building_id, l.unit_id, l.id, l.deposit_amount, l.advance_rent_amount, 'held',
            '2026-09-25T10:00:00+07:00', '2026-09-25T10:00:00+07:00', 'DPR-2026-00001', 'เงินสด ณ วันทำสัญญา'
       FROM ops.lease l WHERE l.id = $1
     ON CONFLICT (lease_id) DO NOTHING`,
    [DEV.leaseId],
  );
}

const COUNTED_TABLES = [
  'platform.role',
  'platform.permission',
  'platform.role_permission',
  'platform.setting',
  'platform.setting_version',
  'platform.compliance_rule',
  'ops.invoice_line_kind_rule',
  'platform.utility_tariff',
  'platform.utility_tariff_version',
  'platform.business_calendar',
  'platform.consent_purpose',
  'platform.consent_purpose_version',
  'platform.retention_policy',
  'platform.notification_template',
  'platform.notification_template_version',
  'platform.notification_route',
  'platform.feature_flag',
  'ops.workflow_definition',
  'platform.platform_role_assignment',
  'platform.user_credential',
  'core.tenant',
  'core.user_account',
  'core.membership',
  'core.party',
  'core.property',
  'core.building',
  'core.building_operator_period',
  'core.floor',
  'core.unit',
  'core.unit_ownership',
  'core.asset_item',
  'core.meter_assignment',
  'ops.unit_profile',
  'ops.unit_detail',
  'ops.lease_template',
  'ops.lease_template_version',
  'ops.lease',
  'ops.lease_party',
  'core.occupancy',
  'ops.inspection_template',
  'ops.deposit',
];

export async function countRows(db: ClientBase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
    counts[t] = rows[0]!.n;
  }
  return counts;
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? 'reference';
  if (arg !== 'reference' && arg !== 'dev') {
    console.error(`usage: run.js reference|dev (got "${arg}")`);
    process.exit(64);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required (see .env.example; `pnpm db:local` prints it)');
    process.exit(64);
  }
  const db = new Client({ connectionString: url, application_name: 'getproperty-seed' });
  await db.connect();
  try {
    await runSeed(db, arg, (line) => console.log(line));
    console.log(`seed: ${arg} done`);
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

-- getproperty-api 0009 — row-level security (ENABLE + FORCE) and policies on every table of 0002–0008, table
-- privileges for gp_app / gp_platform / gp_reporting (schema-design v2 §4.5, D-152).
-- Session: core.current_tenant_id() = current_setting('app.tenant_id', true), set with SET LOCAL by withTx /
-- withTenant; core.current_actor_id() = app.actor_id. gp_platform has BYPASSRLS (admin, identity, relays,
-- cross-tenant jobs); superusers bypass RLS too, so the application must connect as (a member of) gp_app.

-- platform.apply_rls(table, kind, module) — reused by later migrations (B2–B6). Kinds:
--   tenant            RLS:T  — tenant_id = current tenant (read + write)
--   tenant_or_shared  RLS:T  + rows with tenant_id NULL (platform defaults) are readable, not writable
--   building          RLS:B(module) — own rows, buildings the tenant owns/operates, building grants for module;
--                     writes: own rows, rows written for the owner (core.acts_for), write grants for module
--   unit              RLS:U(module) — building + unit-scope grants (requires unit_id)
--   platform          RLS:P  — catalogue: readable by everyone, written by gp_platform only
--   platform_only     RLS on, no policy — invisible to gp_app/gp_reporting (gp_platform only)
CREATE OR REPLACE FUNCTION platform.apply_rls(tbl regclass, kind text, module text DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  name text := (SELECT relname FROM pg_class WHERE oid = tbl);
  cur constant text := '(SELECT core.current_tenant_id())';
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  CASE kind
    WHEN 'tenant' THEN
      EXECUTE format('CREATE POLICY %I ON %s FOR ALL USING (tenant_id = %s) WITH CHECK (tenant_id = %s)',
                     name || '_rls_t', tbl, cur, cur);
    WHEN 'tenant_or_shared' THEN
      EXECUTE format('CREATE POLICY %I ON %s FOR SELECT USING (tenant_id = %s OR tenant_id IS NULL)', name || '_rls_read', tbl, cur);
      EXECUTE format('CREATE POLICY %I ON %s FOR ALL USING (tenant_id = %s) WITH CHECK (tenant_id = %s)',
                     name || '_rls_write', tbl, cur, cur);
    WHEN 'building', 'unit' THEN
      IF module IS NULL THEN RAISE EXCEPTION 'apply_rls(%): kind % needs a module key', tbl, kind; END IF;
      EXECUTE format(
        'CREATE POLICY %I ON %s FOR SELECT USING (tenant_id = %s OR building_id = ANY ((SELECT core.accessible_building_ids(%L))::uuid[])%s)',
        name || '_rls_read', tbl, cur, module,
        CASE WHEN kind = 'unit' THEN format(' OR unit_id = ANY ((SELECT core.accessible_unit_ids(%L))::uuid[])', module) ELSE '' END);
      EXECUTE format(
        'CREATE POLICY %I ON %s FOR ALL USING (tenant_id = %s OR core.acts_for(tenant_id, building_id) OR building_id = ANY ((SELECT core.accessible_building_ids(%L, %L))::uuid[])%s) WITH CHECK (tenant_id = %s OR core.acts_for(tenant_id, building_id))',
        name || '_rls_write', tbl, cur, module, 'write',
        CASE WHEN kind = 'unit' THEN format(' OR unit_id = ANY ((SELECT core.accessible_unit_ids(%L, %L))::uuid[])', module, 'write') ELSE '' END,
        cur);
    WHEN 'platform' THEN
      EXECUTE format('CREATE POLICY %I ON %s FOR SELECT USING (true)', name || '_rls_p', tbl);
    WHEN 'platform_only' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'apply_rls(%): unknown kind %', tbl, kind;
  END CASE;
END
$$;
COMMENT ON FUNCTION platform.apply_rls(regclass, text, text) IS 'Enables + forces RLS and creates the standard policies of schema-design §4.5 (kinds: tenant, tenant_or_shared, building, unit, platform, platform_only).';

-- 0002 platform configuration
SELECT platform.apply_rls('platform.setting', 'platform');
SELECT platform.apply_rls('platform.setting_version', 'platform');
SELECT platform.apply_rls('platform.tenant_setting_version', 'tenant');
SELECT platform.apply_rls('platform.property_setting_version', 'tenant');
SELECT platform.apply_rls('platform.feature_flag', 'platform');
SELECT platform.apply_rls('platform.feature_flag_override', 'tenant');
SELECT platform.apply_rls('platform.utility_tariff', 'platform');
SELECT platform.apply_rls('platform.utility_tariff_version', 'platform');
SELECT platform.apply_rls('platform.business_calendar', 'platform');
-- 0003 identity
SELECT platform.apply_rls('platform.user_credential', 'platform_only');
SELECT platform.apply_rls('platform.auth_session', 'platform_only');
SELECT platform.apply_rls('platform.otp_challenge', 'platform_only');
SELECT platform.apply_rls('platform.role', 'platform');
SELECT platform.apply_rls('platform.permission', 'platform');
SELECT platform.apply_rls('platform.role_permission', 'platform');
SELECT platform.apply_rls('platform.platform_role_assignment', 'platform');
SELECT platform.apply_rls('platform.support_grant', 'tenant');
SELECT platform.apply_rls('platform.invitation', 'tenant');
SELECT platform.apply_rls('platform.tenant_bank_account', 'tenant');
SELECT platform.apply_rls('platform.tenant_bank_account_history', 'tenant');
-- 0004 audit, events, outbox, idempotency
SELECT platform.apply_rls('platform.attachment', 'tenant');
SELECT platform.apply_rls('platform.audit_log', 'tenant');
SELECT platform.apply_rls('platform.domain_event', 'tenant');
SELECT platform.apply_rls('platform.outbox_message', 'platform_only');
-- the app writes the outbox row in the event's transaction; it may read it back (RETURNING) when it can see
-- the event; the relay (gp_platform) updates and deletes.
CREATE POLICY outbox_message_rls_via_event ON platform.outbox_message FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform.domain_event e WHERE e.id = event_id));
CREATE POLICY outbox_message_rls_insert ON platform.outbox_message FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM platform.domain_event e WHERE e.id = event_id));
SELECT platform.apply_rls('platform.idempotency_key', 'platform_only');
-- no tenant column: keys are scoped by actor in `scope`; the interceptor (gp_app) owns them.
CREATE POLICY idempotency_key_rls_app ON platform.idempotency_key FOR ALL USING (true) WITH CHECK (true);
-- 0005 notifications & privacy
SELECT platform.apply_rls('platform.notification_template', 'platform');
SELECT platform.apply_rls('platform.notification_template_version', 'platform');
SELECT platform.apply_rls('platform.notification_route', 'tenant_or_shared');
SELECT platform.apply_rls('platform.notification_preference', 'platform_only');
CREATE POLICY notification_preference_rls_t ON platform.notification_preference FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id()) OR (user_id IS NOT NULL AND user_id = (SELECT core.current_actor_id())))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()) OR (tenant_id IS NULL AND user_id = (SELECT core.current_actor_id())));
SELECT platform.apply_rls('platform.notification', 'tenant');
SELECT platform.apply_rls('platform.web_push_subscription', 'platform_only');
CREATE POLICY web_push_subscription_rls_self ON platform.web_push_subscription FOR ALL
  USING (user_id = (SELECT core.current_actor_id())) WITH CHECK (user_id = (SELECT core.current_actor_id()));
SELECT platform.apply_rls('platform.consent_purpose', 'platform');
SELECT platform.apply_rls('platform.consent_purpose_version', 'platform');
SELECT platform.apply_rls('platform.consent', 'tenant');
SELECT platform.apply_rls('platform.data_subject_request', 'tenant');
SELECT platform.apply_rls('platform.retention_policy', 'platform');
-- 0006 compliance
SELECT platform.apply_rls('platform.compliance_rule', 'platform');
SELECT platform.apply_rls('platform.compliance_evaluation', 'tenant');
SELECT platform.apply_rls('platform.compliance_acknowledgement', 'tenant');
-- 0007 workflow & numbering
SELECT platform.apply_rls('ops.workflow_definition', 'tenant_or_shared');
-- instances: own rows and rows of buildings the tenant owns/operates (module key ops.workflow is never
-- granted except through '*').
SELECT platform.apply_rls('ops.workflow_instance', 'building', 'ops.workflow');
SELECT platform.apply_rls('ops.workflow_event', 'platform_only');
CREATE POLICY workflow_event_rls_read ON ops.workflow_event FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id())
         OR EXISTS (SELECT 1 FROM ops.workflow_instance i WHERE i.id = instance_id));
CREATE POLICY workflow_event_rls_write ON ops.workflow_event FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id())
              OR EXISTS (SELECT 1 FROM ops.workflow_instance i
                          WHERE i.id = instance_id AND i.tenant_id = workflow_event.tenant_id
                            AND core.acts_for(i.tenant_id, i.building_id)));
SELECT platform.apply_rls('ops.workflow_timer', 'platform_only');
CREATE POLICY workflow_timer_rls_read ON ops.workflow_timer FOR SELECT
  USING (tenant_id = (SELECT core.current_tenant_id())
         OR EXISTS (SELECT 1 FROM ops.workflow_instance i WHERE i.id = instance_id));
CREATE POLICY workflow_timer_rls_write ON ops.workflow_timer FOR ALL
  USING (tenant_id = (SELECT core.current_tenant_id())
         OR EXISTS (SELECT 1 FROM ops.workflow_instance i
                     WHERE i.id = instance_id AND i.tenant_id = workflow_timer.tenant_id AND core.acts_for(i.tenant_id, i.building_id)))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id())
              OR EXISTS (SELECT 1 FROM ops.workflow_instance i
                          WHERE i.id = instance_id AND i.tenant_id = workflow_timer.tenant_id
                            AND core.acts_for(i.tenant_id, i.building_id)));
SELECT platform.apply_rls('ops.document_series', 'tenant');
-- 0008 bridge
SELECT platform.apply_rls('bridge.integration_event', 'tenant');

-- ---------------------------------------------------------------------------------------------------------
-- Privileges. RLS decides rows; grants decide statements.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform, ops, bridge TO gp_app, gp_platform;
GRANT SELECT ON ALL TABLES IN SCHEMA platform, ops, bridge TO gp_reporting;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA platform, ops, bridge TO gp_app, gp_platform, gp_reporting;
REVOKE EXECUTE ON FUNCTION platform.apply_rls(regclass, text, text) FROM PUBLIC, gp_app, gp_reporting;

-- Identity secrets are platform-only; the outbox is insert-only for the app.
REVOKE ALL ON platform.user_credential, platform.auth_session, platform.otp_challenge FROM gp_app, gp_reporting;
REVOKE UPDATE, DELETE ON platform.outbox_message FROM gp_app;
REVOKE ALL ON platform.idempotency_key FROM gp_reporting;
-- Catalogues are written by gp_platform only (RLS:P has no write policy; the grants say the same).
REVOKE INSERT, UPDATE, DELETE ON platform.setting, platform.setting_version, platform.feature_flag, platform.utility_tariff,
  platform.utility_tariff_version, platform.business_calendar, platform.role, platform.permission, platform.role_permission,
  platform.platform_role_assignment, platform.notification_template, platform.notification_template_version,
  platform.consent_purpose, platform.consent_purpose_version, platform.retention_policy, platform.compliance_rule FROM gp_app;

-- Reporting never reads encrypted columns: replace the table grant by a column grant without them.
DO $cols$
DECLARE
  spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['platform.tenant_bank_account', 'account_no_enc,promptpay_id_enc,provider_merchant_ref_enc'],
    ['platform.data_subject_request', 'requester_contact_enc']] LOOP
    EXECUTE format('REVOKE SELECT ON %s FROM gp_reporting', spec[1]);
    EXECUTE format('GRANT SELECT (%s) ON %s TO gp_reporting',
      (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
         FROM pg_attribute a
        WHERE a.attrelid = spec[1]::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname <> ALL (string_to_array(spec[2], ','))),
      spec[1]);
  END LOOP;
END
$cols$;

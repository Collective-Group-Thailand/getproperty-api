-- 0008_rls_reporting_role — the reporting role, RLS policies on every B1 org_id table (schema-design §4.5),
-- updated_at triggers, append-only triggers (§4.8) and version-closing triggers (§4.1).
-- Later deliverables re-run the same pattern for their tables.

-- ---------------------------------------------------------------------------------------------------
-- 1. Reporting role: exports, analytics, BI, support read-only views. Non-owner, so RLS applies to it;
--    the application role owns the tables and bypasses RLS (repositories enforce tenancy, contract §8).
--    Roles are cluster-wide: CREATE only when missing so several databases (shadow, tests) share it.
-- ---------------------------------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'getproperty_reporting') THEN
    CREATE ROLE getproperty_reporting NOLOGIN NOINHERIT;
  END IF;
END
$do$;
GRANT USAGE ON SCHEMA public TO getproperty_reporting;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO getproperty_reporting;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO getproperty_reporting;
-- Secrets never reach reporting, whatever the policy says.
REVOKE SELECT ON otp_challenges, auth_sessions, idempotency_keys FROM getproperty_reporting;
REVOKE SELECT (password_hash, totp_secret_enc, totp_recovery_codes_hash) ON users FROM getproperty_reporting;
REVOKE SELECT (account_no_enc, promptpay_id_enc, provider_merchant_ref_enc) ON org_bank_accounts FROM getproperty_reporting;
REVOKE SELECT (requester_contact_enc) ON data_subject_requests FROM getproperty_reporting;

-- ---------------------------------------------------------------------------------------------------
-- 2. RLS — `app.org_id` is set per org loop iteration (`SET LOCAL app.org_id = …`) by the worker/exports.
--    Tables whose org_id is NOT NULL: strict policy. Nullable org_id (platform-level rows mixed in): NULL rows visible.
-- ---------------------------------------------------------------------------------------------------
-- orgs: the org row itself
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY orgs_org_isolation ON orgs USING (id = current_org_id());

-- strict org_id tables
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_members_org_isolation ON org_members USING (org_id = current_org_id());
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_org_isolation ON invitations USING (org_id = current_org_id());
ALTER TABLE org_bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_bank_accounts_org_isolation ON org_bank_accounts USING (org_id = current_org_id());
ALTER TABLE org_bank_account_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_bank_account_history_org_isolation ON org_bank_account_history USING (org_id = current_org_id());
ALTER TABLE org_setting_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_setting_versions_org_isolation ON org_setting_versions USING (org_id = current_org_id());
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_grants_org_isolation ON support_grants USING (org_id = current_org_id());
ALTER TABLE feature_flag_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY feature_flag_overrides_org_isolation ON feature_flag_overrides USING (org_id = current_org_id());
ALTER TABLE compliance_acknowledgements ENABLE ROW LEVEL SECURITY;
CREATE POLICY compliance_acknowledgements_org_isolation ON compliance_acknowledgements USING (org_id = current_org_id());

-- nullable org_id tables (platform rows have org_id IS NULL)
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_roles_org_isolation ON user_roles USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE file_objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_objects_org_isolation ON file_objects USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachments_org_isolation ON attachments USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_org_isolation ON audit_logs USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY domain_events_org_isolation ON domain_events USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE notification_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_routes_org_isolation ON notification_routes USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_org_isolation ON notification_preferences USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_org_isolation ON notifications USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY consents_org_isolation ON consents USING (org_id IS NULL OR org_id = current_org_id());
ALTER TABLE data_subject_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_subject_requests_org_isolation ON data_subject_requests USING (org_id IS NULL OR org_id = current_org_id());

-- ---------------------------------------------------------------------------------------------------
-- 3. updated_at triggers on every table that carries the column.
-- ---------------------------------------------------------------------------------------------------
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_identities_set_updated_at BEFORE UPDATE ON user_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER auth_sessions_set_updated_at BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_roles_set_updated_at BEFORE UPDATE ON user_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER support_grants_set_updated_at BEFORE UPDATE ON support_grants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orgs_set_updated_at BEFORE UPDATE ON orgs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER org_members_set_updated_at BEFORE UPDATE ON org_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invitations_set_updated_at BEFORE UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER org_bank_accounts_set_updated_at BEFORE UPDATE ON org_bank_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER settings_set_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER feature_flags_set_updated_at BEFORE UPDATE ON feature_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER feature_flag_overrides_set_updated_at BEFORE UPDATE ON feature_flag_overrides FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tariffs_set_updated_at BEFORE UPDATE ON tariffs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tariff_versions_set_updated_at BEFORE UPDATE ON tariff_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER business_calendars_set_updated_at BEFORE UPDATE ON business_calendars FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER file_objects_set_updated_at BEFORE UPDATE ON file_objects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER attachments_set_updated_at BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER outbox_messages_set_updated_at BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER idempotency_keys_set_updated_at BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_templates_set_updated_at BEFORE UPDATE ON notification_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_template_versions_set_updated_at BEFORE UPDATE ON notification_template_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_routes_set_updated_at BEFORE UPDATE ON notification_routes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_preferences_set_updated_at BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER web_push_subscriptions_set_updated_at BEFORE UPDATE ON web_push_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER consent_purposes_set_updated_at BEFORE UPDATE ON consent_purposes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER consent_purpose_versions_set_updated_at BEFORE UPDATE ON consent_purpose_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER data_subject_requests_set_updated_at BEFORE UPDATE ON data_subject_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER retention_policies_set_updated_at BEFORE UPDATE ON retention_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER compliance_rules_set_updated_at BEFORE UPDATE ON compliance_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- 4. Append-only tables (§4.8): audit_logs, domain_events, consents, org_bank_account_history,
--    compliance_acknowledgements. The retention job deletes with `SET LOCAL session_replication_role = replica`
--    (bypasses user triggers) under its own audit row.
-- ---------------------------------------------------------------------------------------------------
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER domain_events_append_only BEFORE UPDATE OR DELETE ON domain_events FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER consents_append_only BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER org_bank_account_history_append_only BEFORE UPDATE OR DELETE ON org_bank_account_history FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER compliance_acknowledgements_append_only BEFORE UPDATE OR DELETE ON compliance_acknowledgements FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ---------------------------------------------------------------------------------------------------
-- 5. Effective dating (§4.1): a new version closes the previous open one of the same parent.
-- ---------------------------------------------------------------------------------------------------
CREATE TRIGGER setting_versions_close_previous BEFORE INSERT ON setting_versions
  FOR EACH ROW EXECUTE FUNCTION close_previous_version('setting_id');
CREATE TRIGGER org_setting_versions_close_previous BEFORE INSERT ON org_setting_versions
  FOR EACH ROW EXECUTE FUNCTION close_previous_version('org_id', 'setting_id');

-- getproperty-api 0068 — adopt @collective/asset-core 0.8.0 (Phase J step JA, D-J01). Needs asset-core >= 0.8.0:
-- core 0014 adds tenant type `juristic` (the deprecated `condo_juristic` is stored as `juristic` by
-- core trigger tenant_type_normalise) and 0015 moved the core.tenant rows. The app keeps one more column of that enum,
-- platform.price_plan.tenant_type: its condo plans move to `juristic` too (otherwise a juristic tenant would no longer
-- match its plans), and a trigger stores the alias as `juristic` there as well. Plan keys (`condo_juristic`,
-- `juristic_pro`) are stable identifiers and do not change. No core.* change.

CREATE OR REPLACE FUNCTION platform.price_plan_tenant_type_normalise() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.tenant_type::text = 'condo_juristic' THEN
    NEW.tenant_type := 'juristic';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION platform.price_plan_tenant_type_normalise() IS 'D-J01 / asset-core 0.8.0: stores the deprecated tenant type condo_juristic as juristic.';
CREATE TRIGGER price_plan_tenant_type_normalise BEFORE INSERT OR UPDATE OF tenant_type ON platform.price_plan
  FOR EACH ROW EXECUTE FUNCTION platform.price_plan_tenant_type_normalise();

-- Data runs as gp_platform (BYPASSRLS; the migrating login is a member): FORCE RLS restricts the owner login.
SET ROLE gp_platform;
UPDATE platform.price_plan SET tenant_type = 'juristic' WHERE tenant_type::text = 'condo_juristic';
RESET ROLE;

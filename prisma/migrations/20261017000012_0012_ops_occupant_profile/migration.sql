-- getproperty-api 0012 — A1 parties: the TM30 / resident extension of core.party (B2.2; schema-design v2 §3.3.2,
-- D-052). Vehicles and pets (blueprint A1.4) stay ◇ until C1.

CREATE TABLE ops.occupant_profile (
  party_id                uuid NOT NULL,
  tenant_id               uuid NOT NULL,
  visa_type               text,
  arrival_date            date,
  entry_port              text,
  passport_issued_country char(2),
  occupation              text,
  notes                   text,
  created_at              timestamptz(6) NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz(6) NOT NULL DEFAULT now(),
  updated_by              uuid,
  CONSTRAINT occupant_profile_pkey PRIMARY KEY (party_id),
  CONSTRAINT occupant_profile_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT occupant_profile_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenant (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT occupant_profile_country_check CHECK (passport_issued_country IS NULL OR passport_issued_country ~ '^[A-Z]{2}$'),
  CONSTRAINT occupant_profile_visa_type_check CHECK (visa_type IS NULL OR length(visa_type) <= 50),
  CONSTRAINT occupant_profile_entry_port_check CHECK (entry_port IS NULL OR length(entry_port) <= 100)
);
COMMENT ON TABLE ops.occupant_profile IS '1:1 extension of core.party for residents: TM30 fields (visa type, arrival date, port of entry, D-052) and occupation.';
CREATE INDEX occupant_profile_tenant_id_idx ON ops.occupant_profile (tenant_id);

CREATE TRIGGER occupant_profile_set_updated_at BEFORE UPDATE ON ops.occupant_profile FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

SELECT platform.apply_rls('ops.occupant_profile', 'tenant');
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.occupant_profile TO gp_app, gp_platform;
GRANT SELECT ON ops.occupant_profile TO gp_reporting;

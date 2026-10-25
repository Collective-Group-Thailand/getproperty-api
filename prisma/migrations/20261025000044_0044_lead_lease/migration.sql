-- getproperty-api 0044 — B7.4 lead → lease, auto-close and re-list (D-252, D-253). schema-design §7.5 rows 116–117.
-- A lead remembers the lease drafted from it; a listing remembers the lease that closed it (`leased`) and when the
-- owner was reminded to re-list before that lease ends.

ALTER TABLE ops.listing_lead ADD COLUMN lease_id uuid;
ALTER TABLE ops.listing_lead ADD CONSTRAINT listing_lead_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE INDEX listing_lead_lease_id_idx ON ops.listing_lead (lease_id);
COMMENT ON COLUMN ops.listing_lead.lease_id IS 'The lease drafted from this lead (POST /v1/owner/leads/{id}/lease-draft); its activation wins the lead.';

ALTER TABLE ops.listing ADD COLUMN lease_id uuid;
ALTER TABLE ops.listing ADD COLUMN relist_reminded_at timestamptz(6);
ALTER TABLE ops.listing ADD CONSTRAINT listing_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES ops.lease (id) ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE INDEX listing_lease_id_idx ON ops.listing (lease_id);
COMMENT ON COLUMN ops.listing.lease_id IS 'The lease whose activation closed this listing (closed_reason leased).';
COMMENT ON COLUMN ops.listing.relist_reminded_at IS 'When the owner was reminded to re-list, listing.relist.remind_days_before the lease ends (once).';

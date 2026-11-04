-- getproperty-api 0069 — resident identity by unit (Phase J step JR, D-309 = D-J08, D-322). schema-design §7.5 row 203
-- (§7.6 JR-a). A juristic tenant invites a co-owner of a unit to the resident app (single use, OTP to the phone of the
-- ownership party): invitation kind `unit_resident` with the unit, and an OTP purpose for the redemption.
-- Additive; no data change; no core.* change.

ALTER TYPE platform.invitation_kind ADD VALUE IF NOT EXISTS 'unit_resident';
ALTER TYPE platform.otp_purpose ADD VALUE IF NOT EXISTS 'unit_invitation';

ALTER TABLE platform.invitation ADD COLUMN unit_id uuid;
ALTER TABLE platform.invitation
  ADD CONSTRAINT invitation_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES core.unit (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
-- the new enum value cannot be used in this transaction: compare as text
ALTER TABLE platform.invitation DROP CONSTRAINT invitation_kind_check;
ALTER TABLE platform.invitation ADD CONSTRAINT invitation_kind_check CHECK (
  (kind::text = 'tenant_member' AND role IS NOT NULL)
  OR (kind::text = 'lease_resident' AND lease_id IS NOT NULL)
  OR (kind::text = 'unit_resident' AND unit_id IS NOT NULL AND party_id IS NOT NULL)
);
CREATE INDEX invitation_unit_id_idx ON platform.invitation (unit_id) WHERE unit_id IS NOT NULL;

-- getproperty-api 0045 — B7.5 landlord document set, part 1: stamp duty on leases (D-253, O-019). schema-design §7.5 row 118.
-- Model only: the duty is computed from the rent over the term (setting lease.stamp_duty.baht_per_thousand), who pays
-- is agreed in the lease (default the lessor, who is liable under the Revenue Code), and the payment is recorded —
-- through the e-Stamp adapter when one is configured, otherwise by hand with the receipt attached.

CREATE TYPE ops.stamp_duty_payer AS ENUM ('lessor', 'lessee', 'shared');
CREATE TYPE ops.stamp_duty_channel AS ENUM ('e_stamp', 'manual');

ALTER TABLE ops.lease ADD COLUMN stamp_duty_payer ops.stamp_duty_payer NOT NULL DEFAULT 'lessor';
ALTER TABLE ops.lease ADD COLUMN stamp_duty_amount numeric(14,2);
ALTER TABLE ops.lease ADD COLUMN stamp_duty_channel ops.stamp_duty_channel;
ALTER TABLE ops.lease ADD COLUMN stamp_duty_reference text;
ALTER TABLE ops.lease ADD COLUMN stamp_duty_paid_at timestamptz(6);
ALTER TABLE ops.lease ADD COLUMN stamp_duty_document_id uuid;
ALTER TABLE ops.lease ADD CONSTRAINT lease_stamp_duty_document_id_fkey FOREIGN KEY (stamp_duty_document_id) REFERENCES core.document (id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE ops.lease ADD CONSTRAINT lease_stamp_duty_amount_check CHECK (stamp_duty_amount IS NULL OR stamp_duty_amount >= 0);
ALTER TABLE ops.lease ADD CONSTRAINT lease_stamp_duty_paid_check CHECK (
  (stamp_duty_paid_at IS NULL AND stamp_duty_channel IS NULL)
  OR (stamp_duty_paid_at IS NOT NULL AND stamp_duty_channel IS NOT NULL AND stamp_duty_amount IS NOT NULL)
);
ALTER TABLE ops.lease ADD CONSTRAINT lease_stamp_duty_reference_check CHECK (stamp_duty_reference IS NULL OR length(stamp_duty_reference) <= 100);
CREATE INDEX lease_stamp_duty_document_id_idx ON ops.lease (stamp_duty_document_id);

COMMENT ON COLUMN ops.lease.stamp_duty_payer IS 'Who pays the stamp duty on the lease (O-019 default lessor; shared = half each).';
COMMENT ON COLUMN ops.lease.stamp_duty_amount IS 'Stamp duty fixed when the lease is sent for signature: ceil(total rent over the term / 1000) × lease.stamp_duty.baht_per_thousand.';
COMMENT ON COLUMN ops.lease.stamp_duty_channel IS 'How the duty was paid: e_stamp (Revenue Department e-Stamp through the adapter) or manual (recorded by the owner).';
COMMENT ON COLUMN ops.lease.stamp_duty_reference IS 'e-Stamp / receipt reference.';
COMMENT ON COLUMN ops.lease.stamp_duty_paid_at IS 'When the duty was paid.';
COMMENT ON COLUMN ops.lease.stamp_duty_document_id IS 'The stamp duty receipt (core.document).';

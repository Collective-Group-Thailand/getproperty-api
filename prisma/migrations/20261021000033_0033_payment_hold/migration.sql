-- getproperty-api 0033 — release review #2 (D-220): one bank transfer is booked once.
-- A provider payment (QR webhook or settlement file) that looks like a transfer already booked — its QR already paid,
-- or a slip / hand-recorded transfer of the same amount for the same payer × unit within
-- `payments.duplicate_window_hours` — is stored `pending` (held) without allocation, receipt or credit, and waits for
-- the owner: confirm (booked as a second payment) or dismiss (never booked).
-- Deviation (schema-design §7.5 row 98): five ops.payment columns the v2 design did not list.

ALTER TABLE ops.payment
  ADD COLUMN held_reason             text,
  ADD COLUMN duplicate_of_payment_id uuid,
  ADD COLUMN dismissed_at            timestamptz(6),
  ADD COLUMN dismissed_by            uuid,
  ADD COLUMN dismiss_reason          text,
  ADD CONSTRAINT payment_duplicate_of_payment_id_fkey FOREIGN KEY (duplicate_of_payment_id) REFERENCES ops.payment (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT payment_dismissed_by_fkey FOREIGN KEY (dismissed_by) REFERENCES core.user_account (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT payment_held_reason_check CHECK (held_reason IS NULL OR held_reason IN ('qr_already_paid', 'possible_duplicate_transfer')),
  ADD CONSTRAINT payment_dismissed_check CHECK ((dismissed_at IS NULL) = (dismiss_reason IS NULL));
COMMENT ON COLUMN ops.payment.held_reason IS 'D-220: why a provider payment was held for the owner instead of booked (qr_already_paid, possible_duplicate_transfer).';
COMMENT ON COLUMN ops.payment.duplicate_of_payment_id IS 'D-220: the payment this held one probably duplicates (same transfer booked by slip or by hand).';
CREATE INDEX payment_duplicate_of_payment_id_idx ON ops.payment (duplicate_of_payment_id);
CREATE INDEX payment_dismissed_by_idx ON ops.payment (dismissed_by);

-- getproperty-api 0052 — listings that tell the truth (B7 deliverable 7.9 part 1, D-265): the owner's switch for the
-- average of the last confirmed utility bills on a listing (on by default; the rates are always shown when the unit
-- has a power / water rate plan). schema-design §7.5 row 133.

ALTER TABLE ops.listing ADD COLUMN show_utility_history boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN ops.listing.show_utility_history IS 'D-265: show the average of the unit''s last confirmed utility bills (with at least listing.utility_history.min_bills of them).';

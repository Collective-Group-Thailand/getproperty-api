-- getproperty-api 0054 — condition reports in LINE (B7 deliverable 7.10 part 1, D-266): the resident's own note and
-- photos when countersigning a move-in / move-out report, and a note with an accepted deposit settlement.
-- schema-design §7.5 rows 137–138.

ALTER TABLE ops.inspection
  ADD COLUMN resident_note text,
  ADD COLUMN resident_photo_document_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT inspection_resident_note_check CHECK (
    (resident_note IS NULL OR length(resident_note) <= 1000) AND cardinality(resident_photo_document_ids) <= 6
  );
COMMENT ON COLUMN ops.inspection.resident_note IS 'D-266: what the resident adds when countersigning the report in LINE (with up to 6 photos of their own, resident_photo_document_ids).';

ALTER TABLE ops.deposit_settlement
  ADD COLUMN resident_note text,
  ADD CONSTRAINT deposit_settlement_resident_note_check CHECK (resident_note IS NULL OR length(resident_note) <= 1000);
COMMENT ON COLUMN ops.deposit_settlement.resident_note IS 'D-266: the resident''s note when accepting the proposed settlement (a dispute keeps its dispute_reason).';

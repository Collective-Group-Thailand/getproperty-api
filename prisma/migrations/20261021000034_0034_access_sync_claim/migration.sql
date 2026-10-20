-- getproperty-api 0034 — release review #8 (D-223): one owner of each vendor call of a door credential.
-- `sync()` claims the credential (sync_claimed_until = now + 2 min) before calling the lock vendor; the after-commit
-- sync, the 60-s sweep and other worker replicas skip a claimed row, so a credential is created at the vendor once
-- and never leaves an orphaned live code behind.
-- Deviation (schema-design §7.5 row 99): one smart.access_credential column the v2 design did not list.

ALTER TABLE smart.access_credential ADD COLUMN sync_claimed_until timestamptz(6);
COMMENT ON COLUMN smart.access_credential.sync_claimed_until IS 'D-223: a vendor sync of this credential is in progress until then (claim lease against double creation).';

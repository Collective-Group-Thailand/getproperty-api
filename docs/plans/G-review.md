# G review fixes — independent review of pack G (plan)

Source: the independent review of getproperty-api pack G (G0–G9, migrations 0058–0066): 2 high, 1 medium, 5 low
findings and one hardening note. Every finding was re-verified against the code before fixing; each fix has a
regression test that fails on the code before the fix (run on a clean worktree of `0fefa43` with only the new tests)
and passes after. No public API shape change (web / LIFF adopted api `02ab053`); no rule changes, so no D-302 — the
fixes enforce D-301, D-294, D-286, D-300 and D-299 as already written.

## 1. (High) `review.publish` withdrawal — D-301 (1), (5)
- `BuildingReviewsService` subscribes to `consent.changed`: a withdrawal of `review.publish` (any channel, any tenant
  of the consent row) withdraws every non-withdrawn review the person submitted at or before the withdrawal (text
  erased, audit `by: consent`, event `building_review.withdrawn`). A later review carries its own newer grant.
- `forListing` (public) skips reviews whose author's latest `review.publish` state is "not granted" (defence in depth
  until the subscriber ran).
- `withdraw(leaseId)` authorises by `review.authorUserId === userId` only (no lease scope / party link needed), so the
  owner unlinking the login cannot lock the author out. Same route, same answers (404 for anyone else).
- Tests: `growth-insight.int-spec` "withdrawing the review.publish consent withdraws the published review …",
  "the author can still withdraw after the owner unlinks their login".

## 2. (High) `energy.insight` withdrawal — D-301 (8), (9)
- `EnergyInsightService` subscribes to `consent.changed`: a purpose-level withdrawal (consent row without a tenant =
  the owner consent page) opts out every `opted_in` building whose opt-in rests on that person (opted_in_by or the
  opt-in's consent subject) and was made at or before the withdrawal — same body as the opt-out (`stopIn`: state,
  park unsent snapshots, audit, `energy_insight.opted_out` → `energy.insight.withdrawn`).
- `share()` re-checks at send time: the latest purpose-level row of the subject since the opt-in is a withdrawal →
  opted out, nothing written. Building-level opt-out / opt-in rows carry the owner tenant and speak for that building
  only (so opting out one building does not stop the owner's other buildings).
- Tests: `growth-insight.int-spec` "withdrawing the energy.insight consent opts the building out …", "the share job
  re-checks the consent at send time …".

## 3. (Medium) Contract-template whitelist bypass — D-294
- `htmlProblems` first replaces every `{{…}}` with a marker (value / block), refuses quotes and angle brackets inside a
  mustache, parses tags quote-aware (a `>` inside a quoted value does not end the tag, as in Chromium), tokenises
  attributes strictly (malformed rest refused), refuses a variable as an attribute name, refuses any tag-like `<`
  that did not parse, refuses comments (`<!-->` closes at once in a browser while the text extractor hides what
  follows), and requires `<img>` to carry the signature `src` (`{{signatures.<role>.imageDataUrl}}` exactly).
- `forbiddenFindings` reads image alt text like visible text.
- Tests: `contract-library.spec.ts` "G review #3: a {{…}} inside an attribute value …" (the reviewer's payloads +
  variants), "G review #3: wording in an image alt text is checked like visible text".

## 4. (Low) OG card documents — D-286, D-296
- Re-render path under `pg_advisory_xact_lock(hashtext('og-image:<listing>'))` with the hash re-read inside the lock
  (the second request serves the first one's card); the superseded card (kind `other`, never legal) is purged after
  the commit (`purgeStored` + `deleteObjects`, quota freed).
- Test: `distribution.int-spec` "parallel renders after a change leave one live card; the old card is purged".

## 5. (Low) Sponsored campaign completed twice — D-300
- Completion extracted to `finishPass(id, plan)`; it locks the campaign row (`SELECT … FOR UPDATE`) and re-reads the
  state under the lock.
- Test: `audience-broadcast.int-spec` "two overlapping completions of one campaign issue one invoice".

## 6. (Low) Listing-assistant monthly limit — D-301 (6), O-009
- `AiUsageService.reserve` (per tenant + feature advisory lock; `ok` records of the month + live reservations <
  limit) inserts a `platform.ai_usage_reservation` before the AI call; `record({reservationId})` deletes it in the
  same transaction as the usage row; an orphan expires after 5 minutes. Migration 0067.
- Test: `growth-insight.int-spec` "concurrent drafts at limit − 1: exactly one succeeds …".

## 7. (Low) Objects deleted before the guarded DB update — D-286
- `DocumentsService.purgeStored` locks the row, checks the hold (core columns + `platform.document_legal_hold`, also
  for an already soft-deleted row) → `storage.legal_hold`, updates the row and **returns** the keys; callers delete
  them with `deleteObjects` after their transaction committed (reclaim purge, listing evidence purge, OG card).
  Retention and tenant DSR erasure: row update first, objects after the commit.
- Test: `storage-quota.int-spec` "purging a held document refuses before its file is touched …".

## 8. (Low) DSR and relocation offers — D-025, D-299
- Platform DSR export lists `relocationOffers` (state, move-out date, destination, clicks); erasure erases every
  offer's destination and clicks and withdraws the open ones.
- Test: `growth-network.int-spec` "platform DSR: relocation offers are exported, and erasure withdraws them …".

## 9. (Hardening) Review state only through the platform role — D-301 (3)
- Migration 0067 replaces `ops.building_review_guard`: a change of state / published / moderation / withdrawn columns
  is refused unless the current role is (a member of) `gp_platform`.
- Test: `growth-insight.int-spec` "the owner tenant database role cannot change a review state or its moderation".

## Gates
format · lint · typecheck · unit · contract build + lint (no path / shape change expected) · build · integration in
5 batches · drift check (`db:diff` = 0) · migrations.int-spec 67 migrations / platform 90 tables.

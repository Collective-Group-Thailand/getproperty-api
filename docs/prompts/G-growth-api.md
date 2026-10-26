# G — Listing & Growth (module E) · getproperty-api

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md`, `docs/schema-design.md`, `docs/deployment.md`, `docs/prompts/G-README.md` ก่อน · ทำทีละ step ต่อ 1 session · Plan Mode ทุกครั้ง · ตารางใหม่ทุกตารางลง `schema-design.md` §7.5 ก่อนเขียน migration

---

You are a senior backend engineer on **`getproperty-api`**. The founder decisions listed in `docs/prompts/G-README.md` are requirements. Existing rules still hold: tenancy + RLS + cross-tenant 404 (D-152), money as decimal strings, every state change = one transaction + audit + outbox event, irreversible POSTs take `Idempotency-Key`, PDPA consent and minimisation (D-025), no funds held for others (ADR-0008), the platform never cuts power or access for arrears (D-024/D-071/D-157), deployment on collective-infra only (D-230, D-233). Every value the founder may change (quota size, prices, frequency caps, windows) is an effective-dated setting or price-plan version, never a constant.

Build on what B7 already shipped (listings, interested parties, e-KYC B7.10, rent record + renewal reminders B7.11, guides B7.13). **Never duplicate**: extend those modules; where this pack and B7 overlap, the B7 behaviour stays and this pack fills the gap.

## G0 — Reconcile, decisions, schema plan
1. Inventory B7.x in code and `docs/PROGRESS.md`; write `docs/growth-gap.md`: a table module E1–E15 (strategy doc) × status (done in B7.n / partial / missing) × the G step that closes it.
2. Record the founder decisions of 2026-10-26 (G-README items 1–8) as D-### rows (Accepted, founder decision 2026-10-26), mark the Landlord 99/299 line of D-156 superseded for `landlord`, and add O-### rows for what is still open (storage package prices, LINE sponsored-listing confirmation, insurance partner, e-KYC provider O-021, gateway O-020).
3. Draft every new table for G1–G9 in `schema-design.md` §7.5 (owner schema, columns, RLS policy, indexes, retention) and list contract paths per step. No code beyond docs in this step.
4. Acceptance: gap table complete, decisions/O rows added, schema rows reviewed against tenancy and retention rules.

## G1 — Storage quota & storage packages (E6)
1. Accounting: `platform.storage_usage` per tenant (bytes, object count, by category `listing_media | attachment | system_legal | system_other`), maintained transactionally on every `core.document` / object write and delete (and thumbnails/derivatives), plus a nightly reconciliation job against S3 `ListObjectsV2` per tenant prefix that corrects drift and reports it.
2. Quota: setting `storage.free_quota_bytes` (platform default 5 GiB, per-tenant override by Platform admin, audited), effective quota = free + active storage packages. Images are re-encoded to WebP on upload (max edge configurable) before counting; originals not kept unless a setting says so.
3. **Legal hold**: documents the system issues and the law requires to keep (lease, receipt, tax invoice, credit/debit note, slip, deposit settlement, TM30 export) carry `retention_until` (from a retention policy table per document kind, defaults per legal-reference; ⚖ pending legal verification) — **counted in the quota, never deletable** before `retention_until` (API refuses with `storage.legal_hold`, DB trigger too).
4. Enforcement: at ≥ 100 % user uploads are refused with `storage.quota_exceeded` (problem + current usage + link to packages); **system-issued legal documents are always written** even over quota (assert: issuing a receipt over quota succeeds). Notifications at 80 % and 100 % (LINE + email to owner/admin roles), once per threshold crossing.
5. Reclaim: list largest files, bulk delete of deletable media (soft delete → purge after 7 days, setting), usage drops on purge.
6. **Storage packages**: admin CRUD of package definitions as price-plan add-ons (`kind = storage`, size bytes, price, billing period, active window, visibility) — prices empty until set by admin (O-###); owner purchase → line on the platform invoice (B6.1) → active on payment; expiry/renewal; downgrade when usage exceeds the new quota = uploads blocked, nothing deleted.
7. Endpoints: owner `GET /v1/owner/storage` (usage, quota, breakdown, packages), purchase, delete/restore media; admin package definitions, per-tenant override, usage report.
8. Acceptance: usage stays exact through upload/derivative/delete (property test), reconciliation fixes injected drift, legal document undeletable + counted, receipt issued over quota, package purchase raises quota after payment, cross-tenant 404.

## G2 — Agency tenant, owner grants, co-broke (E5)
1. `collective-asset-core`: add `agency` to `tenant.type` (release + bump); memberships unlimited (no seat billing).
2. Owner → agency **listing mandate**: `ops.listing_mandate` (unit, owner tenant/party, agency tenant, scope `list | list_and_lease | manage`, exclusive flag, commission terms as text + numbers, valid from/to, state `invited → accepted → active → ended | revoked`), backed by `core.asset_access_grant` rows (module-scoped, expiring). An agency sees only granted units; revocation removes access immediately (test). Landlord (unit owner) can mandate several agencies unless exclusive.
3. **Co-broke**: `ops.co_broke_agreement` (listing agency, co-agency, unit/listing, split %, validity, signed via e-sign G3) and `ops.deal` (lease signed through the platform, parties, agencies, commission amounts recorded — money moves outside the platform, ADR-0008).
4. Accruals for G5: `deal.closed` event (lease e-signed + first rent payment confirmed) → success fee / co-broke fee accrual rows per price plan.
5. Acceptance: mandate flow with grants, agency cross-tenant isolation, exclusive conflict refused, revoke cuts access, deal closes once (idempotent), cross-tenant 404.

## G3 — Contract library & lifecycle (E14)
1. Extend `ops.lease_template` / versions (already platform + tenant scoped) to a **contract library**: `kind` (`lease_apartment_ocpb` existing, `lease_condo_private`, `reservation`, `brokerage_mandate`, `co_broke`, `addendum`, `notice_termination`, `notice_renewal`), language `th | en` (zh later), `legal_review_state` (`pending_legal_verification` until counsel signs off; shown on every draft).
2. Users copy a platform draft into their own template (`derived_from_version_id`), edit text and clauses; the API returns a clause-level diff against the base and runs the compliance checker: where the สคบ. scope applies (D-158, ≥ 3 units) forbidden clause types are **blocked**; elsewhere they are **warnings** with the legal reason. Variables auto-filled from unit/lease/rate plan; unknown variables refused.
3. Every kind can be e-signed (existing e-sign), hashed and archived as a legal-hold document (G1).
4. **Renewals**: extend B7.11 reminders into a workflow (60/30 days, settings): offer renewal with a suggested rent from the k ≥ 5 benchmark (B6.3) or the owner's figure, resident accepts/declines in LIFF, new lease version signed, old one closed; decline → move-out notice flow (D-219).
5. Disclaimer setting shown with every draft ("ตัวอย่างสัญญาเพื่ออำนวยความสะดวก ไม่ใช่คำแนะนำทางกฎหมาย").
6. Acceptance: copy → edit → diff → compliance block in scope / warn out of scope; all kinds sign and archive; renewal accept and decline paths; template version pinned on signed contracts.

## G4 — Distribution: public listings, Facebook Page, share kit, agency LINE OA (E2, E7)
1. Public listing API for the web's public zone (if B7 lacks it): verified-vacant badge (from lease/occupancy/notice data), average real electricity/water cost per month (smart rollups, last 3 full months, hidden when < 2 months), price from the rate plan, JSON-LD fields, OG image rendering (via the PDF/HTML renderer path, D-236).
2. **Facebook Page** auto-post adapter (Graph API Page publish; page token per tenant sealed with the tenant key like O-013 credentials; fake in tests; `// UNVERIFIED against live provider`); post on publish/price change; delete on let.
3. **Share kit** for Facebook groups: text (th/en) + image bundle + short link with UTM, per listing; no group automation.
4. **Agency LINE OA integration**: per-tenant LINE channel credentials (sealed), webhook route per tenant, lead/viewing/bill/service messages through the agency's OA; usage billed by LINE to them; setup + monthly fee = price-plan add-on.
5. Acceptance: badge and cost only from real data, FB adapter fake e2e, share kit content, tenant-routed LINE webhook isolation.

## G5 — Boost & growth billing (E6)
1. Boost products as price-plan items (listing 7/30 days, building monthly; free building boost for Apartment Smart — setting): purchase → platform invoice line → active window on payment; ranking: boosted results labelled "โฆษณา", at most N boosted per results page (setting), ties broken by verified-vacant and freshness.
2. Success fee and co-broke fee accruals from G2 → platform invoice lines (monthly), caps per price plan; disputes → credit note.
3. Verified photo/360° service order (partner fulfils; status, deliverables stored as media).
4. No stored-value wallet (no prepaid credits balance) — every purchase is an invoice line (conservative under e-money rules; record as D-###).
5. Acceptance: purchase → paid → boosted → expiry; label and cap enforced; accrual once per deal; credit note path.

## G6 — Audience, consent & sponsored broadcast (E4)
1. Marketing consent separate from service consent (versioned purpose, no pre-ticked, withdraw any time, DSR export/erase), preferences (areas, budget band, unit type, move-in window, language) set by the person; profiling transparency text.
2. Segments computed from preferences + consented behaviour; **frequency cap** (≤ 2 sponsored/person/week, setting); quiet hours.
3. `platform.sponsored_campaign` (buyer tenant, listings on getproperty only, segment, max recipients, price per recipient from price plan, minimum, schedule, state), delivery via the getproperty OA (Messaging API multicast; LINE's ≥ 100 target-reach rule applies to OA Manager targeted broadcasts, not the API — enforce our own minimum from the price plan, default 500), reports aggregated only (sent, opened if available, clicks, leads) — **no personal data to the buyer**; a lead reaches the buyer only when the person taps contact/viewing.
4. Gate: `broadcast.sponsored.enabled` false until LINE Thailand confirms (O-###); internal (non-sponsored) recommendations may run.
5. Acceptance: no consent → never targeted, withdrawal effective immediately, cap enforced, buyer sees aggregates only, billing per delivered recipient, cross-tenant 404.

## G7 — Self-viewing with time-boxed door codes (E8)
1. `ops.viewing_slot` (unit, window, mode `accompanied | self`), `ops.viewing` (prospect party, verified identity required for `self` — e-KYC B7.10 + phone, state, code ref, entry/exit log, no-show, incident report).
2. Self mode only for units with no active occupancy and a lock; code via `LockVendorAdapter` valid 30 min (setting) around the slot; staff/owner alerted on entry; second visit blocked while one is open; incident → work order.
3. Never touches resident credentials; never usable for occupied units (test); D-071 rules unchanged.
4. Acceptance: verified prospect gets one code, unverified refused, occupied unit refused, code expires, log visible to owner/agency only.

## G8 — getbuild handoff, employer housing, relocation network (E9, E10, E11)
1. Consume `unit.transferred` with `rental_intent` (integration contract in asset-core) → invite the buyer to the landlord tier, prefilled listing draft, developer campaign tag; idempotent.
2. **Employer housing**: payer = employer party/organisation on leases (bill split per occupant, employer statement, payroll-deduction export CSV), TM30 for the employer's foreign workers, LIFF languages already present.
3. **Relocation**: on move-out notice, offer listings in the destination area to the leaving resident (consented, G6 rules); with the resident's share action, the B7.11 rent record travels to the new landlord.
4. Acceptance: handoff once per transfer, employer billing totals, relocation offer only with consent.

## G9 — Verified reviews, listing assistant, energy insight (E13, E15)
1. Reviews only by parties with a past/current lease in that building (verified), one per lease, owner reply, no deletion by owner, moderation for abuse; shown with tenure dates.
2. Listing assistant: AI gateway (D-161) writes th/en/zh descriptions from unit facts + photos; usage recorded per tenant (`platform.ai_usage_record`); never alters photos' content.
3. Energy insight: building score from smart rollups (common-area load, pump hours, peak) → `bridge.integration_event` lead to getenergy (D-238), owner opt-in.
4. Acceptance: unverified review refused, AI usage recorded, energy event only after opt-in.

After each step: `docs/PROGRESS.md`, `contract/openapi.json` regenerated + linted, deployment needs listed in `docs/deployment.md`, commit.

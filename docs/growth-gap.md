# Growth gap — pack G (module E) vs what getproperty-api already has

> G0 of `docs/prompts/G-growth-api.md`, 2026-10-27. Requirements: founder decisions 2026-10-26 (`docs/prompts/G-README.md`) = **D-284–D-291**; open items **O-022–O-029**. Inventory taken from the code (`prisma/schema/*`, `src/modules/*`, `src/core/*`, `collective-asset-core` 0.6.0) and `docs/PROGRESS.md` rows B7.0–B7.13 at sandbox HEAD `8db24ef`.
> Rule of the pack: **never duplicate B7** — where the pack and B7 overlap, B7 behaviour stays and G fills the gap.
> The strategy document (claude.ai artifact S1WTXcvCeUaaQ8qpKttrzS) could not be read from the build sandbox. Module names E2, E4–E11, E13–E15 come from the E numbers used in the G pack files; **E1, E3 and E12 are inferred** (marked †) from the founder's revenue / blue-ocean lists.

## 1. Module × status × closing step

| Module | Scope (as the pack uses it) | Status today | Exists in code (B7 / earlier) | Closed by |
|---|---|---|---|---|
| E1 † | Listings marketplace core (publish, photos, moderation, public search, owner verification) | **done** B7.2, B7.9 | `ops.listing*`, `platform.listing_verification`, `platform.listing_report`, `/v1/owner/listings*`, `/v1/public/listings*`, areas, owner page | — (G4/G5 extend) |
| E2 | Public listing distribution: badges, real utility cost, JSON-LD, OG image | **partial** | public detail with D-265 utility average (≥ 3 confirmed bills, setting), `ownerIdentityVerified`, sitemap, area pages; **missing**: verified-vacant badge, JSON-LD block in the DTO, 1200×630 OG image | G4 |
| E3 † | Leads / interested parties / viewings, lead → lease, prospect audience | **done** B7.3, B7.4 | `ops.listing_lead*`, `ops.listing_viewing` (gist no-overlap), `ops.listing_availability`, `/v1/prospect/*`, owner inbox | — (G7 extends viewings) |
| E4 | Audience, marketing consent, sponsored broadcast via getproperty OA | **missing** (pieces exist) | consent purposes (`resident.marketing` is the *lessor's* purpose, not the platform's), shared-OA delivery + `platform.message_usage` metering (B7.7) | G6 |
| E5 | Agency tenant, owner → agency mandates, co-broke, deals | **done** G2 (asset-core 0.7.0, migration 0059, D-293) — was missing | `core.asset_access_grant` (unit/building scope, modules, expiry, revoke) — no `agency` tenant type, no `listing_mandate` grant reason | G2 (+ asset-core) |
| E6 | Storage quota & packages; boost & growth billing | **partial** | D-276/D-279 slice: `platform.storage_usage_daily` (hourly snapshot), `platform.storage_notice`, settings `storage.free_gb` (5 per type) / `storage.price_per_gb_month` (null) / `storage.packs` ([]) / `storage.record_bytes` / `storage.notice_at_percent`, `GET /v1/owner/storage`, `GET /v1/admin/storage/tenants`, presign admission `409 storage.allowance_exceeded`; price plans + platform invoices (B6.1). **Missing**: transactional usage by category, reconciliation, legal hold, package purchase, boosts, fee accruals | G1 (storage), G5 (boost, fees) |
| E7 | Facebook Page auto-post, share kit, agency LINE OA | **partial** | share kit **done** B7.9 (D-268: captions th/en, 1080 cards, short links + UTM, lead channel); own LINE OA per tenant/building **done** B7.7 (sealed credentials, per-channel webhook, account linking, health, metering). **Missing**: Facebook Page adapter + post log, OA setup/monthly fee as add-on, OA for tenant type `agency` | G4 |
| E8 | Self-viewing with time-boxed door codes | **done in G7** (2026-10-28, D-295; behind `viewing.self.enabled`, O-024 / O-031) — was: missing (pieces exist) | `ops.listing_viewing` + availability, e-KYC (B7.10, `platform.identity_verification`), locks + `smart.access_credential` (holder kind `visitor`), lock vendor port + fakes | G7 |
| E9 | getbuild → rental handoff | **missing** (contract exists) | asset-core 0.6.0 `unit.transferred` with `rentalIntent`; inbound framework `IntegrationEventsService.onInbound` (only `warranty.defect.closed` registered); landlord sign-up (B7.1), `platform.invitation` | G8 |
| E10 | Employer / worker housing B2B | **missing** | company parties, lease parties (`lessee`, `co_tenant`, `guarantor`, `occupant`), TM30 export (B5), six LIFF languages | G8 |
| E11 | Relocation network | **missing** (pieces exist) | move-out notice (`ops.lease` notice columns, B7.5 notices), rent record + per-enquiry share (B7.11) | G8 (needs G6 consent) |
| E12 † | Deposit-free (insurance partner) | **blocked** | D-257 accepted, no partner → O-024 | none in G (stays off) |
| E13 | Verified reviews | **done in G9** (2026-10-29, migration 0066, D-301; moderation policy O-035) — was missing | — | G9 |
| E14 | Contract library & renewals | **done** G3 (migration 0060, D-294) — was partial | `ops.lease_template` / `_version` (platform + tenant scope, language, `clause_schema`, `forbidden_clause_types`, `legal_ref`), landlord templates th/en (B7.5), compliance checker (`lease-compliance.ts`), e-sign for leases (`ops.lease_signature`), notices incl. `renewal_offer` (B7.5), `renew` lease action, lease-end reminder (B7.11). **Missing**: kinds, legal-review state, copy-from-platform + diff, signing of non-lease kinds, renewal offer workflow with resident answer | G3 |
| E15 | Listing assistant (AI) and energy insight → getenergy | **done in G9** (2026-10-29, migration 0066, D-301; AI fake adapter, getenergy provisional contract + fake transport, O-028 / O-036) — was missing (pieces exist) | AI gateway port (D-278), `platform.ai_usage_record` (feature enum lacks `listing_assistant`), hourly/daily telemetry rollups; bridge has partners `getbuild`, `getpack` only | G9 (+ asset-core contract) |

Revenue items of D-287 not owned by any G step: **move-in referral** (D-259 partner integrations — no partner yet) and **market insight** (a paid product beyond B7.9 comparables / B6.3 `rent_per_m2` benchmark). Both stay unbuilt; their prices are part of O-027. Renter Passport = B7.11 rent record (free to residents; no charge until a price-plan item exists).

## 2. Cross-cutting gaps (several steps depend on them)

1. **Platform invoices without a subscription.** `platform.platform_invoice.subscription_id` is `NOT NULL` and `PlatformBillingService.issue()` takes a `Subscription`; subscriptions are off (D-250, B7.0). G1 (storage packages) and G5 (boosts, fees, verified photo) need a **purchase invoice**: `subscription_id` nullable, new `platform_invoice_kind` value `purchase`, line kinds `boost`, `success_fee`, `co_broke_fee`, `media_service`, `messaging_addon` (`storage` and `addon` exist). Unpaid purchase = not activated; **no suspension / read-only for unpaid growth invoices** (D-250 switched that off; D-024 spirit). Owner of the change: **G1** (first purchase), G5 reuses.
2. **Issuer and merchant of platform invoices** are still placeholders (O-008): purchases can be issued and recorded manually by Finance; the Thai QR stays disabled until `platform.payments.merchant` exists. This is the platform's own merchant, **not** the sub-merchant gateway of O-020.
3. **Price plans for add-ons.** `platform.price_plan` has `kind addon|service` but `billing_unit` lacks `per_package`, `per_listing_day`, `per_recipient`, `per_deal`. Recommendation: one enum migration in G1 adding `per_package`, `per_listing`, `per_recipient`, `per_deal`, `percent_of_amount` (fees) and use `terms` jsonb for size bytes / duration days / caps; versions stay published-never-edited (D-204). Every growth price starts as a **draft version with no price** (O-022, O-027).
4. **asset-core release(s)** before G2 / G9: `core.tenant_type` + `agency`; `core.grant_reason` + `listing_mandate`; RBAC / menu for tenant type `agency`; integration contract for getenergy (`energy.lead.created` or similar, O-028) and the `bridge.integration_platform` + `getenergy` value (app enum; event-type CHECK allows only the eight contract types today, §7.5 row 6).
5. **Tenant-type lists in code** (`TENANT_TYPES` in `storage-settings.ts`, menus, signup, price-plan tenant types) must learn `agency` in G2.
6. **Consent purposes owned by the platform** (tenant_id NULL): `platform.recommendations` (G6, marketing), `review.publish` (G9), `energy.insight` (owner opt-in, G9), `relocation.offer` (G8, may reuse G6's).

## 3. Per step — reuse vs build

### G1 — Storage quota & packages (E6)
- **Reuse**: `StorageMeteringService` (record counting, notices, `monthlyCharge`), settings `storage.free_gb` (keep the name; per-tenant override = existing tenant setting versions, audited), `storage.notice_at_percent`, `platform.storage_notice`, `GET /v1/owner/storage` (extend the body, keep fields), admin storage page, `platform.retention_policy` (already seeded per document class with legal refs ⚖ — **do not add a second retention table**), `core.document.retention_class` / `deleted_at`, WebP renditions of listing photos (B7.2).
- **Build**: `platform.storage_usage` (current bytes/objects per tenant × category, updated in the same transaction as each document write/delete/derivative), `platform.storage_reconciliation` (nightly `ListObjectsV2` per tenant prefix, drift report), `platform.document_legal_hold` (retention_until per legal document, DB trigger refusing delete), `platform.storage_package` (purchased packs; definitions are price-plan add-ons), purchase invoice path (§2.1), media reclaim (soft delete → purge after setting days), re-encode uploads to WebP (setting max edge; originals kept only by setting).
- **Keep B7**: error code `storage.allowance_exceeded` (409) already exists — G1 adds the problem fields (usage, quota, packages link) rather than a second code; the pack's `storage.quota_exceeded` is an alias only if web needs it. D-276: never lock data; legal documents always issued (assert receipt over quota). Residents' payment slips and signatures are never refused (D-286).
- **Open**: package prices (O-022), retention periods per kind (O-025).

### G2 — Agency tenant, mandates, co-broke (E5)
- **Reuse**: `core.asset_access_grant` (unit scope, `modules`, `valid_to`, `revoked_at`) — the mandate *is* a grant plus business terms; RLS helpers `accessible_unit_ids(module)`; memberships / invitations; landlord sign-up pattern (B7.1) for agency self-serve.
- **Build**: asset-core release (§2.4); `ops.listing_mandate`, `ops.co_broke_agreement`, `ops.deal`, `ops.fee_accrual`; agency RBAC role set; exclusive-mandate conflict (partial unique); `deal.closed` = lease e-signed + first rent payment confirmed (subscriber, idempotent per lease).
- **Design point to settle in G2**: who owns an agency's listing row. Recommendation: `ops.listing.tenant_id` = the agency (writer stamps its own tenant, §4.5) with `mandate_id` FK; the unit stays the owner's; revocation closes the agency's live listings.
- **Money**: commissions recorded only (ADR-0008); fees per price plan (O-027).

### G3 — Contract library & renewals (E14)
- **Reuse**: `ops.lease_template(_version)` (scope, language, `clause_schema`, `forbidden_clause_types`, `legal_ref`), landlord templates, `contract-renderer.ts`, `lease-compliance.ts` (D-158 scope ≥ 3 units → block; else warn), lease e-sign + sha256 + document archive, `renewal_offer` notice (B7.5), `renew` action, lease-end reminder job (B7.11), comparables (D-269) and `rent_per_m2` benchmark (k ≥ 5, B6.3).
- **Build**: template columns `kind`, `legal_review_state`, `derived_from_version_id`, `disclaimer_key`; `ops.contract_document` + `ops.contract_signature` for non-lease kinds (reservation, brokerage mandate, co-broke, addendum); `ops.lease_renewal_offer` (offer → resident accept/decline → new lease version / move-out notice D-219); clause-level diff on read.
- **Keep B7**: notices stay B7.5 letters (`ops.lease_notice`); library kinds `notice_termination` / `notice_renewal` are editable *texts* rendered through that flow, not a second notice store. `lease_apartment_ocpb` = the existing standard template key.
- **Open**: legal review of every draft (O-025, extends O-017).

### G4 — Distribution (E2, E7)
- **Reuse**: public listings API (B7.2/B7.9), D-265 utility average (setting `listing.utility_history.min_bills` — B7 stays; the pack's "smart rollups, ≥ 2 months" is **not** a second figure), share kit (B7.9 — done; only the saved-groups list for the web is new and optional), own LINE OA channels + webhook per channel (B7.7 — already per tenant/building; agency gets it once `agency` exists), PDF/HTML renderer path (D-236) for the OG image.
- **Build**: verified-vacant flag (computed: no active occupancy/lease, no lease starting before `available_from`, notice data), JSON-LD fields, OG image 1200×630, `platform.social_channel` (Facebook Page token sealed with the tenant DEK like `messaging_channel`), `ops.listing_social_post` (post / update on price change / delete on let), Facebook adapter fake + real `// UNVERIFIED` (O-029), OA setup/monthly fee price-plan add-on.
- **Keep B7**: no group automation (D-268, D-288).

### G5 — Boost & growth billing (E6)
- **Reuse**: price plans, purchase invoice (§2.1, from G1), platform credit notes (maker-checker, D-091), public search ordering (add a boosted tier), `ops.fee_accrual` (G2).
- **Build**: `ops.listing_boost` (listing 7/30 days, building monthly; window active on payment), ranking rule (≤ N boosted per page, setting; label "โฆษณา"; ties by verified-vacant then freshness), monthly accrual → invoice lines with caps, `platform.media_service_order` (verified photo/360°, partner fulfils, deliverables as documents).
- **Record** in G5: D-### "no stored-value wallet — every purchase is an invoice line" (pack G5 item 4).
- **Open**: all growth prices (O-027); free building boost for Apartment Smart is a setting (D-250 removed the Smart *subscription*, so the setting keys on tenant type / HaaS meters — G5 decides and records).

### G6 — Audience, consent, sponsored broadcast (E4)
- **Reuse**: consent service + purposes/versions (`platform.consent`, DSR export/erase), shared-OA delivery and `platform.message_usage`, notification quiet hours if present (else setting), prospect audience (D-281).
- **Build**: purpose `platform.recommendations` (controller Collective, tenant NULL), `platform.audience_preference`, `platform.sponsored_campaign`, `platform.sponsored_delivery` (per recipient, frequency cap ≤ 2/week setting, minimum recipients from price plan default 500), aggregate reports only, gate `broadcast.sponsored.enabled=false` (O-023); internal recommendations may run.

### G7 — Self-viewing (E8)
- **Reuse — do not create parallel tables**: `ops.listing_viewing` (state machine, gist no-overlap, reminders) and `ops.listing_availability` (slots); e-KYC outcome; `smart.lock` + `smart.access_credential` + lock vendor port (fake); work orders for incidents.
- **Build**: `mode accompanied|self` on availability slots and viewings; `ops.viewing_access` (code ref → `smart.access_credential` with holder kind `visitor`, validity window setting 30 min, entry/exit log, no-show, incident → work order); one open self-viewing per prospect; refusal for occupied units / units without a lock / unverified prospects.
- **Rules**: never touches resident credentials; D-071 unchanged; self mode behind setting `viewing.self.enabled` (default false in production until O-024 insurance / terms are settled).

### G8 — getbuild handoff, employer housing, relocation (E9, E10, E11)
- **Reuse**: inbound integration framework (`onInbound('unit.transferred', …)`), asset-core contract (`rentalIntent`), landlord sign-up + invitations, listing draft creation (B7.2), TM30 export, lease parties, rent-record share (B7.11), G6 consent.
- **Build**: handler → `ops.rental_handoff` (idempotent per transfer, invite, prefilled draft, campaign tag); `ops.employer_agreement` + `ops.lease.payer_party_id` (employer pays), occupant split rules, employer statement, payroll-deduction CSV export; `ops.relocation_offer` (on move-out notice, consented).

### G9 — Reviews, listing assistant, energy insight (E13, E15)
- **Reuse**: leases (verification of tenure), moderation pattern of `platform.listing_report`, AI gateway + `platform.ai_usage_record` (add feature `listing_assistant`), telemetry rollups, outbound integration delivery (D-247).
- **Build**: `ops.building_review` (+ owner reply, moderation), assistant endpoint (th/en/zh text only, never edits photos), `platform.energy_insight_optin` + score job → `bridge.integration_event` to getenergy (asset-core contract, partner enum, transport env `INTEGRATION_GETENERGY_*`; O-028).

## 4. Conflicts found and how G resolves them
| Topic | Earlier text | G-README | Resolution |
|---|---|---|---|
| Landlord price | D-156 / D-204 landlord steps (free ≤ 3, 99, 299) | free, unlimited (+ agency) | D-284 supersedes the landlord line; D-250 had already switched subscriptions off |
| Apartment / condo / PM price | D-250: apartments free, payment fee; condo / juristic / PM packages sold separately | "still per D-156" | D-284 changes nothing for them; reading confirmed with the founder in **O-026** (assumed: D-250 stands) |
| Storage overage | D-276/D-279: price per GB-month or packs, overage billed | packages or delete old files | D-285: packages are the purchase path; per-GB overage setting stays null (not sold) unless the admin sets it |
| Boosts / commission | D-252: no commission, paid boosts out of scope | boost, success fee, co-broke fee approved | D-287 amends D-252 |
| Facebook | D-268: no auto-posting | no group posting; **Page** auto-post | D-288 amends D-268 for the owner's own Page only |
| Utility on listings | D-265: avg of last 3 confirmed bills | G4: smart rollups, last 3 months, hide < 2 | B7 stays (pack rule); the threshold is already a setting |
| Viewings | B7.3 `ops.listing_viewing` | G7 `ops.viewing_slot` / `ops.viewing` | extend B7 tables (§3 G7) |
| Retention | `platform.retention_policy` seeded | G1 "retention policy table per kind" | reuse it; legal periods → O-025 |

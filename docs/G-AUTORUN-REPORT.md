# G-AUTORUN report — pack G "Listing & Growth" (module E)

Run: 2026-10-27 01:55 → 2026-10-29 16:55 Bangkok. Orchestrated by Cowork session `session_0118jx8J2EKuBp9EDzJFed3B` (G0–G3, GW1–GW2), then Claude session `session_0168nuZ6jHAs2SKQZX8MK5kb` (from 2026-10-28 10:20: GW3 onward, review, this report). Every commit is on the Mac repos' local `main`, authored Superball <Piyapan.pa@abbon.co.th>, no trailers, **nothing pushed, nothing deployed, collective-infra untouched**. Bases: api `d04b8f8`, web `3c1f7f6`, liff `cf6dcce`, asset-core `8d7dc54` (0.6.0).

## Steps

| Step | Repo | Status | Commit (Mac merge / feature) | Contract | Notes |
|---|---|---|---|---|---|
| G0 | api | done | aabd83b | 650 paths | D-284…D-291, O-022…O-029 (docs) |
| G1 storage quota & packages | api | done | f44bf20 | 661 | D-292 |
| G2 agency, mandates, co-broke, deals | api + asset-core | done | api 5931568, core 0.7.0 (re-pushed as 2065010) | 678 | D-293 |
| G3 contract library & renewals | api | done | 36c7c79 | 712 | D-294, O-030 |
| G7 self-viewing | api | done | d69d6c8 (fddfd93) | 721 | D-295, O-031; migration 0061; off by default |
| G4 distribution (FB Page, OG/JSON-LD, share kit, agency OA fee) | api | done | 65e874d (f8ad203) | 730 | D-296; migration 0062 |
| G5 boosts, growth fees, media orders | api | done | 8195e78 (9761cdb) | 746 | D-297, D-298, O-032; migration 0063 |
| G8 getbuild handoff, employer housing, relocation | api | done | 3dbf3be (3a6c9f8) | 762 | D-299, O-033, O-034; migration 0064 |
| G6 audience, consent, sponsored broadcast | api | done | b22571d (8b6c493) | 779 | D-300; migration 0065; switch off |
| G9 reviews, listing assistant, energy insight | api | done | 02ab053 (28d09c1) | 798 | D-301, O-035, O-036; migration 0066 |
| GW1 storage | web | done | a115699 | api 5931568 | |
| GW2 agency workspace | web | done | d326a41 | — | |
| GW3 contract library & renewals | web | done | b65047e (7e73385) | api 36c7c79 | |
| GW4 distribution & growth billing | web | done | dfafe19 (b108536) | api 8195e78 | |
| GW5 sponsored broadcast | web | done | 6ef2c24 (3d70ef7) | api b22571d | |
| GW6 self-viewing, handoff, employer housing, reviews, AI drafts, energy | web | done | 7076f4b (c3a5aa7) | api 02ab053 | |
| GL3 contracts & renewals | liff | done | 0e341e9 (ba4e437) | api 36c7c79 | |
| GL2 self-viewing | liff | done | e97e41f (52e9d65) | api d69d6c8 | |
| GL1 marketing consent & preferences | liff | done | 510d4f1 (be0532c) | api b22571d | |
| GL4 relocation & reviews | liff | done | 49382e7 (722ad86) | api 02ab053 | |
| Deferred e2e (web, first pass) | web | done | 72a56c4 (ef54ddb) | — | 218/219, 1 flaky |
| Review fixes | api | done | 48c598f (2cf3458) | 798 (unchanged) | migration 0067 |
| Review fixes | web | done | 9aaedfb (3e8a4e3) | — | 13 findings |
| Final e2e fixes | web | done | 0789bbb (8ead5fa) | — | 233/233 |
| Deferred e2e (LIFF) | liff | done | e50742c (4a0b38b) | — | 167/167 |
| Review fixes | liff | done | (merge pending — Mac offline at report time) | — | |

## Test counts (final heads)

| Repo | lint / format / typecheck | Unit | e2e | Integration / other |
|---|---|---|---|---|
| api | green | 614 passed, 2 skipped (87 suites) | 35 passed (3 suites; on the final api incl. review fixes) | 512 passed, 1 skipped (70 suites, 5 batches); contract 798 paths, lint clean; build |
| web | green | 1,401 passed | 233/233, 0 flaky (full run incl. build) | build-storybook; Lighthouse owner + admin budgets met; `gen:api --check` 916 ops |
| liff | green | 794 passed | 172/172, 0 flaky | build, build-storybook, shared:check 0 warnings, every page ≤ 180 KB |

Founder change 2026-10-28: e2e was skipped per step (specs written) and run once at the end — web 233/233, LIFF 172/172, 0 flaky, api 35/35.

## Independent review (Finish §2)

Three read-only reviewers who had not written the code (api, web, LIFF) covered tenancy leaks, legal-hold deletion paths, consent bypass, money/e-money and secrets. Every confirmed finding was fixed with a regression test that fails on the old code.

- **api — 0 critical, 2 high, 1 medium, 5 low (+1 hardening), all fixed** (migration 0067):
  - H: withdrawing `review.publish` consent left the review public; author lost the withdraw path after the owner unlinked their login → consent subscriber takes reviews down; withdraw by author identity.
  - H: withdrawing `energy.insight` consent kept data flowing to getenergy → withdrawal opts out and emits `energy.insight.withdrawn`; `share()` re-checks consent at send time.
  - M: contract-template HTML whitelist bypass via `{{…}}` inside an attribute → placeholders neutralised before checking, quoted attributes parsed like a browser.
  - L: OG card documents piling up (single-flight + purge), sponsored campaign double completion (row lock), AI quota race (atomic reservation), S3 delete before the legal-hold check (DB first, delete after commit), DSR ignored relocation offers; hardening: owner DB role cannot change review state (trigger).
  - Clean: RLS on every new table, mandate grants, boosts only after payment, fee accruals once, credit notes capped, FB token sealed, door codes redacted, sponsored consent re-checked, no wallet.
- **web — 0 critical/high, 3 medium, 10 low, all fixed**: OAuth sign-up lost `next` (getbuild buyers never reached the claim page); dotted error codes shown as raw key paths; renewal offer could go out with a rent the owner never saw; plus stale signature, energy consent retry, VAT % truncation, handoff token in Sentry URLs, hard-coded reminder days / invented reach, duplicate id, password-manager on token fields, idempotency key reuse.
- **LIFF — 0 critical/high, 3 medium, 6 low**: all fixed — e-sign could post a signature drawn for another document version and let the resident re-read stale terms then sign the new hash (now it reads, draws and signs one version and refreshes on change); no one-tap withdraw while a consent was "outdated" (recommendations, relocation); plus idempotency fingerprint by length, door code cleared asynchronously on hide, stale screens on three error codes, history page dropped on redirect, e-KYC return lost the booking, 5-minute PDF link fetched once.
- e2e runs also found and fixed real bugs: nested form in self-viewing booking sent the phone number in a GET URL; slot buttons failed WCAG 2.5.3; notice done screen (with the relocation prompt) vanished after refresh; doubled alerts; missing platform-invoice line labels (7 kinds); `a is not iterable` on the storage card; realtime notification race (TanStack Query joined a stale request).

## New decisions and open questions

**D-### (all "founder pre-approved recommendation" unless noted):**
D-284 agency + landlord free and unlimited · D-285 storage quota 5 GB + packages · D-286 every file counts, legal documents kept and always issued · D-287 growth revenue streams · D-288 Facebook: no group auto-posting; share kit + Page auto-post · D-289 six blue-ocean features approved · D-290 contract library & renewals · D-291 every price is data · D-292 G1 storage rules · D-293 G2 agency/mandates/co-broke/deals · D-294 G3 contract library, signable documents, renewal offers · D-295 G7 self-viewing · D-296 G4 distribution · D-297 G5 boosts, growth fees, media orders · D-298 no stored-value wallet · D-299 G8 getbuild handoff, employer housing, relocation · D-300 G6 audience, consent, sponsored broadcast · D-301 G9 reviews, listing assistant, energy insight.

**O-### (open — waiting on the founder or a partner):**
O-022 storage package prices · O-023 LINE Thailand written OK for sponsored listings via getproperty's OA (switch stays off) · O-024 insurance partner (deposit-free; self-viewing cover) · O-025 legal review of every contract draft · O-026 pricing reading of G-README item 1 vs D-250 · O-027 growth prices (boosts, sponsored per recipient, OA fees, success/co-broke fees, free building boost, sponsored slots) · O-028 getenergy endpoint + asset-core event contract · O-029 Meta app review for Page posting · O-030 contract library legal points (e-signature level, etc.) · O-031 self-viewing beyond insurance (agency on owner's lock, visitor terms, log retention, e-KYC level) · O-032 verified photo / 360° partner · O-033 getbuild API for unit facts and invitation delivery · O-034 payroll deductions under LPA s.76, TM30 split · O-035 review moderation policy and legal points · O-036 energy score model, getenergy retention, owner contact in leads. Still open from before: O-020 payment gateway, O-021 e-KYC provider.

## Deployment needs for collective-infra (not changed from here)

- **Release order**: `@collective/asset-core` **0.7.0** must be published/tagged and the api dependency bumped before the G2+ image (core migration `0013_agency_mandates`, then app migrations 0058…0067). The Mac asset-core `dist` must be rebuilt (`pnpm build`) after pulling.
- **Env (all default to off / fake; keep off in uat and prod until the O-### is answered)**: `FACEBOOK_MODE` (+ optional `FACEBOOK_GRAPH_VERSION`; O-029), `GETBUILD_MODE` (O-033), `INTEGRATION_GETENERGY_TRANSPORT` / `INTEGRATION_GETENERGY_WEBHOOK_URL` / `INTEGRATION_GETENERGY_SIGNING_KEYS` (secret; O-028), `AI_TEXT_MODEL` (reuses `AI_GATEWAY_URL` / `AI_GATEWAY_API_KEY`). The LINE multicast reuses `LINE_MESSAGING_ACCESS_TOKEN`; keep setting `broadcast.sponsored.enabled=false` (O-023).
- **IAM / bucket**: api/worker role needs `s3:ListBucket` on the getproperty bucket restricted to `${S3_KEY_PREFIX}t/*` (G1 nightly reconcile); `s3:DeleteObject` on `t/*` already used, now also by reclaim purge and OG-card supersede. No new bucket or prefix — contract PDFs, signatures, OG cards, media deliverables, payroll CSVs all go under `t/<tenant>/…` and count to the quota.
- **Egress**: `graph.facebook.com:443` from the worker once `FACEBOOK_MODE=real`; getenergy webhook host once agreed.
- **Worker jobs (existing `worker` container)**: `storage-reconcile` (24 h), `storage-maintenance` (1 h), `mandates-maintenance` (1 h), `lease-renewals` (1 h), `social-posts` (1 min), `messaging-addons` (1 h), `boosts` (15 min), `growth-fees` (1 h), `rental-handoffs` (5 min), `relocation-offers` (1 h), `sponsored-broadcasts` (1 min), plus the G7 self-viewing sweep and the G9 energy-insight daily job (see `docs/deployment.md`).
- **Seed**: run `pnpm db:seed` / the image seed step on existing databases — new consent purposes (`resident.relocation`, `platform.recommendations`, `review.publish`, `energy.insight`), library drafts (6 × th/en), price plans without price, settings.
- No new containers, buckets or secrets beyond the getenergy signing keys.

## What still waits on the founder

1. **Push** every repo (api, web, liff; asset-core already pushed at 0.7.0) and rebuild asset-core `dist` on the Mac.
2. **Prices** (O-022, O-027): storage packages, boosts, sponsored broadcast, OA integration fees, success/co-broke fees, media services — until then every product shows "not on sale yet".
3. **Partners / providers**: payment gateway (O-020), e-KYC (O-021), insurance (O-024), photo/360° (O-032), getbuild API (O-033), getenergy (O-028, O-036), Meta app review (O-029), LINE Thailand confirmation (O-023).
4. **Legal**: every contract draft and consent text is a ⚖ draft (O-025, O-030, O-034, O-035); visitor terms for self-viewing (O-031).
5. **Native read** of my/km/lo/zh copy in the LIFF (drafted by Claude).
6. **Contract requests** filed by web/LIFF (menu keys `contracts`, `contract_library`, `promotion`, `reviews`, `employer_housing`; unit/lessee labels on renewal/contract DTOs; legal-review fields on `ResidentLeaseDto`; contact for accompanied viewings (PDPA question); listing ids on relocation offers; `review.publish` in the resident consent list) — see each repo's `docs/contract-requests.md`.
7. **Open product question**: the resident lease-sign screen still cites the OCPB standard lease for leases on a landlord's own template.

# B6 — Platform business, compliance add-ons, analytics, support, launch

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md`, `docs/schema-design.md` ก่อน · 6.1, 6.4, 6.5 เป็น R1 (ต้องทำ B1–B4) · 6.2, 6.3 เป็น R2 · ทำทีละ Deliverable ต่อ 1 session · Plan Mode ทุกครั้ง

---

You are a senior backend engineer on **`getproperty-api`**. Decisions D-050–D-052, D-080–D-083, D-090 rule here.

## Deliverable 6.1 — Subscriptions, price plans, platform invoicing, HaaS assets (R1)
1. `price_plans` (+ versions, D-080: Lite, Smart HaaS 36 m, Smart purchased, Access add-on; per-room price, minimum, term, VAT), `subscriptions` (org, plan version, state D-082, trial_ends_at, term dates, room counting rule, discount/pilot terms D-083), `subscription_usage` (monthly room snapshot on the 1st from B2.1), `platform_invoices` + `platform_receipts` (issued by Collective Group (Thailand) from platform settings; number series; PDF; Thai QR through the platform's own payment adapter), `haas_assets` (device ref, org, install date, term, monthly value, state, replacement history, de-install work order ref).
2. Lifecycle job: trial → active on first platform payment; past_due after due + grace; suspended = read-only mode enforced by a guard on `/v1/owner|staff` mutations with a clear problem `subscription.suspended` (tenants can still view and pay issued bills, D-082); cancellation → de-install work order (B5.4 when present, else a task record).
3. Admin endpoints: plans, subscriptions, invoices, pilot agreements, HaaS register; owner endpoints: current plan, usage, invoices, upgrade Lite → Smart (creates a site-survey request for Field engineers).
4. Acceptance: e2e trial → invoice → paid → active → past_due → suspended (owner mutation blocked, tenant payment allowed) → paid → active; room counting on fixtures; pilot discount applied.

## Deliverable 6.2 — e-Tax Invoice & e-Receipt, TM30 data pack (R2)
1. `EtaxProviderAdapter` (submit document, poll status, fetch signed XML/PDF; provider chosen per org; fake in tests); org onboarding fields (certificate / provider credentials held by the provider, not us); on `document.issued` for VAT-registered orgs with e-Tax enabled → submit → store provider refs and signed artefacts → tenant receives the signed PDF; monthly e-Tax summary for the org's accountant.
2. TM30 (D-052): capture passport, nationality, arrival date, visa type at move-in for foreign tenants (B2.2 fields); generate the Immigration Bureau upload file per property; reminder at move-in + 24 h; export log.
3. Acceptance: e2e e-Tax submit/sign (fake) → artefacts; TM30 file golden test.

## Deliverable 6.3 — Analytics, pilot KPIs, benchmarks (R2; the KPI endpoint in R1)
1. Analytics events + rollups (worker): billing time per cycle (cut-off → issued), bill correction rate, on-time payment %, auto-reconciled %, reminder effectiveness, loss % trend, meter uptime, tenant CSAT (ratings from B5.1 and a periodic 1-question LIFF survey), compliance score (B4.1).
2. **Pilot KPI endpoint** (R1, D-083): `GET /v1/admin/orgs/{id}/pilot-kpis?window=90d` with baseline vs current for the 7 KPIs; owner sees their own at `/v1/owner/insights`.
3. Anonymised benchmarks for owners (k ≥ 5 orgs per bucket): loss %, on-time payment %, rent per m² by district (opt-in).
4. Acceptance: rollups on fixtures; k-anonymity test; KPI endpoint golden.

## Deliverable 6.4 — Platform admin & support (R1)
1. Admin endpoints not yet covered: org list/search/detail with health (subscription, device fleet, last cycle), tariff management UI endpoints (B1.3) with verification workflow (two platform users: enter → verify → publish), platform settings, notification template management, DSR console (D-025), audit log search, outbox/dead-letter replay, feature flags per org.
2. Support grants (D-090): request/approve/expire; every read under a grant audited with the grant id; "view as org" read-only context for Support (no mutations possible — guard test).
3. Acceptance: e2e Support without grant → 403; with grant → reads audited; tariff publish requires a second user.

## Deliverable 6.5 — Launch readiness & gateway simulator (R1)
1. `pnpm sim:gateway --property <id> --days 30 --rooms 50`: publishes realistic telemetry (daily profiles, a stale meter, a vacant room with usage, a swap) through MQTT for the dev/UAT building so the whole loop can be demoed and load-tested without hardware; also used by e2e.
2. `docs/RUNBOOK.md` (deploy, processes, EMQX ACL sync, certificate rotation, OTA rings, backup/restore incl. hypertables, incident playbooks: broker down, payment webhooks down, tariff change), `docs/LAUNCH-CHECKLIST.md` (legal ⚖ items from `decisions.md`, PDPA notices, payment provider go-live, LINE OA verified, pilot KPIs baseline captured), `docs/launch/UAT.md` scripts for the pilot building (install day, first cut-off, first payments, first move-out).
3. Load test: 300 meters × 15-min polling × 30 days through the simulator; cycle job for 300 rooms < 60 s; ingest lag < 5 s at 10× pilot volume.
4. Acceptance: simulator runs; runbook reviewed; checklist items linked to settings/evidence.

After each deliverable: `docs/PROGRESS.md`, contract regenerated, commit.

# J — Juristic, Common Charges & Gate · getproperty-api (+ collective-asset-core)

Kickoff prefix: `Read CLAUDE.md, docs/prompts/00-master-plan.md, docs/decisions.md, docs/contract/api-conventions.md, docs/schema-design.md and docs/prompts/J-README.md. Then read docs/prompts/J-juristic-api.md. Do <step> only. Plan first (docs/plans/<step>.md), then execute without waiting.`

Numbering at pack time: next decision **D-302**, next open question **O-038**, next migration **0068**, asset-core **0.8.0**. Re-check before writing; parallel steps may have taken numbers.

---

## J0 — Gap analysis, decisions and schema drafts (docs only)
Deliver:
1. `docs/juristic-gap.md`: for every row of the plan's "current state" table, verify against the code (`src/modules/ops-billing`, `ops-leases`, `ops-units`, `smart-*` access/visitor, resident surfaces, LIFF features bound to lease) and record reuse vs build per J step. List every place that reads `condo_juristic`, every resident endpoint keyed by `leaseId`, every place that assumes monthly cycles.
2. `docs/decisions.md`: D-302… for D-J01 … D-J20 of `J-README.md` (Accepted, founder 2026-11-04), O-038 … O-042. Mark D-150 group B "superseded by D-302", D-270 "folded into J1.2", D-156 condo juristic line "see D-318 (D-J17)".
3. `docs/schema-design.md` §7.6 (new) — draft rows for every table/column of J1–J4, J2, J3 with owner schema, RLS, indexes, retention: `juristic.budget`, `budget_line`, `resolution`, `resolution_document`, `collection_ladder`, `collection_step`, `collection_case`, `collection_event`, `payment_plan`, `payment_plan_instalment`, `debt_clearance`, `statement`, `account`, `journal`, `journal_line`, `fund`, `expense_request`, `expense_approval`, `petty_cash`, `withholding_certificate`, `bank_statement`, `bank_statement_line`, `vendor`, `vendor_contract`, `quotation_round`, `quotation`, `vendor_evaluation`, `pm_schedule`, `import_job`, `import_row`, `management_contract`; `smart.gate`, `gate_device`, `visit`, `visit_event`, `visit_invite`, `remembered_vehicle`, `house_gate_policy`, `incident`; columns `ops.billing_cycle.frequency`, `ops.rate_plan_version.charge_basis`, `ops.payment.transaction_ref` (unique), `ops.receivable` unearned split.
4. Compliance rule drafts (seed later in J1.2): `condo_act` and `land_allocation_act` sets — identifiers and section numbers only, never copied text; `pending_legal_verification`.
5. `docs/plans/J0.md`; prompt corrections if the code contradicts this pack (edit this file, note it in PROGRESS).
Gate: `pnpm format:check`.

## JA — collective-asset-core 0.8.0 (repo `collective-asset-core`)
- Migration `0014_juristic_kinds`: `tenant_type` value `juristic` (keep `condo_juristic`, mapped on read; new rows must use `juristic`; data migration of existing rows); `core.property.kind` enum + column (default `apartment` for existing apartment tenants, `condo` for condo stubs, `village` none); `core.building.legal_form` enum + column (nullable; required when the operator tenant is `juristic` — check constraint via trigger); `core.unit.land_area_sqwa numeric(10,2)`, `plot_no text`, `title_deed_no text`; unit `type` gains `plot`.
- Helpers `core.own_unit_ids()` extended: a party sees units through active `unit_ownership` **and** active `occupancy` (any role), not only leases.
- Zod contracts: `juristic.formed` + `legal_form`; `building.handover.requested` v2 payload (advance fees per unit, first fund contribution, receivables brought forward, bank account masked) — additive.
- Tests (embedded PG), CHANGELOG, version 0.8.0, tag. Then bump in api (`link:`) and run api gates.

## JR — Resident identity by unit (D-J08)
- `ResidentContext` carries `unitRoles[]` `{unitId, buildingId, propertyId, tenantId, role: co_owner|tenant|co_tenant|family|payer, source: ownership|occupancy|lease, from, to}` computed at token refresh from ownership + occupancy + leases. Token keeps a hash of the set; changes force refresh.
- Every `/v1/resident/*` endpoint scopes by `unitRoles` (not `leaseId`): invoices (by billed party: co-owner sees common-fee invoices of their units, tenant sees rent invoices), service requests, parcels, bookings, visitors, notices, polls, documents. Lease-bound endpoints (lease, renewal, review, move-out, relocation) require role `tenant|co_tenant` on that lease.
- Co-owner onboarding: juristic issues a unit invite code (`POST /v1/owner/units/{id}/resident-invites`, single use, 14 days, delivered by LINE/SMS/printed QR) → resident redeems with OTP to the phone on the ownership record → party link. One account can hold many units across tenants; `GET /v1/resident/me/units`.
- Migration: no data loss; existing apartment residents keep exactly the same view.
- Acceptance: **every existing resident integration spec passes unchanged**; new specs — co-owner without lease sees own common-fee invoices only; co-owner of 2 units in 2 tenants sees both, switching unit changes scope; occupant (family) sees notices and parcels but not invoices unless `payer`; former owner after transfer loses access at the transfer date; cross-tenant 404.

## J1.1 — Juristic tenant, register, charge bases, budgets, frequencies
- Onboarding: platform admin creates a `juristic` tenant (no self-serve) or claims a landlord stub (D-280) → building gets `legal_form`, property `kind`. Juristic menu: overview, co-owner register, common charges, accounting & funds (J2), vendors (J2), gate (J4), settings.
- Co-owner register: several `unit_ownership` rows per unit with shares; bill-to party per unit (`juristic.bill_to`: owner / named party / agency) with consent of the owner; contact channels; transfer = close old ownership, open new at the transfer date, emit `unit.transferred` (internal) → prorate.
- Rate plans: add `land_area`, `per_unit`, `budget_split` to the engine (`ownership_ratio`, `floor_area`, `fixed` exist). `budget_split` divides a budget line by the chosen basis. Fund plans kind `fund`. Rounding per setting (satang, half-up) with the remainder on the largest share; golden cases.
- Budgets & resolutions: `juristic.budget` per fiscal year with lines by account; `resolution` (meeting kind AGM/EGM/committee, date, number, text, attachments, votes summary as text); a `rate_plan_version` for a juristic building **requires** a resolution reference (setting `juristic.rate_requires_resolution`, default true).
- Cycles: `frequency`; the worker opens cycles for properties with ownerships (not only leases); annual invoice → receivable with unearned part recognised monthly (`juristic.revenue_schedule` rows or a view) ; transfer mid-period → credit note to the seller's unpaid/paid portion per policy (`juristic.transfer_proration`: `refund_seller | carry_to_buyer`, default `carry_to_buyer` = buyer billed from transfer date, seller credited), recorded on both parties.
- Endpoints under `/v1/owner/juristic/*` (register, bill-to, budgets, resolutions) and extended rate plans / cycles; menu keys.
- Golden: village 248 plots per sq. wah annual; condo 312 units by ratio semiannual; two co-owners 60/40; transfer on 15 Mar in an annual cycle; budget_split of 1,234,567.89 over 312 ratios sums exactly.

## J1.2 — Collections, statements, payments, debt clearance
- Statements: `juristic.statement` per owner party per period across units (PDF, LINE Flex summary, e-mail); printable letter batch (A4 with address window) for parties without digital channels.
- Ladder: `collection_ladder` (per tenant, default from the legal_form template), steps `{offset_days, action: remind|surcharge|notice_letter|suspend_services|lawyer_letter|legal_action, channel, template, requires_approval}`; `collection_case` per (party, unit) opened on overdue; job `collections` hourly runs due steps; pause when a plan is active or a dispute is open; every event audited. Surcharge computed by compliance rule of the legal_form (`juristic.surcharge.*` settings, **disabled** until O-038). `suspend_services` and `lawyer_letter` require approval by `committee` or `manager` and are disabled by default.
- Payments: `transaction_ref` unique (DB) across tenants for verified slips (`409 payment.duplicate_slip`); slip check of destination account, amount, date window; partial payments; allocation policy setting (`oldest_first`, `surcharge_first`); overpayment → credit balance; `manual` channel requires an attachment and a note (foreign transfers); `recurring` channel: mandate entity + fake adapter; `POST /webhooks/recurring/{provider}` idempotent.
- Payment plans: proposal by staff or request from resident, approval, instalments as invoice charges, default after N days late (setting) → plan `defaulted`, ladder resumes.
- Debt clearance: `POST /v1/resident/units/{id}/debt-clearance-requests` and owner equivalent; fee per setting (default 0); issued automatically when receivable = 0 (including surcharges and unbilled due charges up to the requested date), else `409 debt_clearance.outstanding` with the amount; PDF `pdf_certificate` number series `DCL`, QR to `GET /v1/public/documents/verify/{code}`, validity days setting; issuing on `unit.transferred` flow from getbuild handoff too.
- Reports: aging buckets (0–30, 31–90, 91–365, >365), collection rate per cycle and within 30 days (KPI), arrears list export, budget vs actual (needs J2 accounts — return income side now, expense side after J2.1).
- D-270 juristic workspace folded in: a landlord's invitation creates a `juristic` tenant workspace limited to linked units through grants.
- Notifications templates th/en (LINE + e-mail + SMS): statement issued, reminder per step, plan approved/defaulted, debt clearance issued/refused.
- Acceptance: duplicate slip refused across tenants; allocation paths; plan default resumes ladder; ladder paused by dispute; surcharge disabled by default and correct when enabled with the seeded rule; debt clearance refused with 1 satang outstanding, issued at 0, verify page shows validity and no personal data beyond unit + name initials; KPI figures from fixtures; cross-tenant 404 everywhere.

## J4.1 — Gate & visitor
- `smart.gate` (property, name, kind main/side, devices), audience **`guard`** (`/v1/guard/*`, token from a registered tablet device + guard PIN, shift start/end), role `guard`.
- Visits: `requested → approved | denied | timed_out → entered → exited` (+ `cancelled`); kinds guest · delivery · contractor · resident_vehicle · other; plate (category + number + province), optional photo (document, retention class `visitor`), name optional, ID last 4 optional; destination unit.
- Notify every resident of the unit with role ≠ none (LINE push with quick actions approve / deny / call me); `GET /v1/guard/events` SSE for the gate; idempotent decisions; first answer wins, others see the result.
- House policy (`house_gate_policy`): timeout seconds (default 180) and action `allow_and_log | deny | guard_calls` (default `guard_calls`); delivery kind may skip approval per estate setting (drop point).
- Invites: resident creates single/multi-use invite with time window and optional plate → QR token; guard scans → `entered` without waiting. Contractors need a window and approval.
- Remembered vehicles: per unit, 30 days default, entry becomes notify-only.
- Exit stamp by guard or resident; open visits > 24 h notify the committee.
- Blacklist (estate-level, reason required, audit).
- PDPA: consent text/purpose shown at the gate surface (from API), retention job deletes visits, photos and plates after `gate.retention_days` (90); residents read only their unit; committee reads all with a logged reason.
- Arrears flag at the gate: setting `gate.show_arrears` **false** until O-038.
- Acceptance: full loop incl. concurrent answers, every timeout policy, invites single/multi, remembered car, offline-created visit synced later with client id idempotency, retention deletes rows and files, resident of another unit 404, guard of another estate 404.

## J4.2 — Barrier, LPR, resident open, SOS
- Device protocol v2 additive messages: `gate.open {gateId, reason, visitId?}` (server → edge), `gate.state`, `plate.detected {gateId, plate, confidence, imageRef?}` (edge → server); contract `device-protocol.json` updated.
- Plate detected → matches remembered / resident vehicles → auto `entered` + optional open; else pre-fills the guard form.
- Resident open: `POST /v1/resident/gates/{id}/actions/open` for the resident's own registered vehicles, rate-limited, audit, requires the resident to be within the estate (client geofence claim + setting to disable).
- SOS: `POST /v1/resident/sos` (unit, kind fire/medical/intrusion/other, optional note/photo) → gate SSE + committee + staff push, incident record; guard acknowledges; incident timeline links visits active at that time.
- Acceptance: device auth, open command delivered once (idempotency), plate auto entry, SOS fan-out, incident links visits.

## J2.1 — Accounting, funds, expenses
- Chart of accounts seed per legal_form (juristic standard) editable per tenant; journals posted from invoices, payments, credit notes, expenses, fund movements (double-entry, balanced constraint in DB).
- Expense requests with approval bands (`juristic.approval_bands`: amount → roles + count), maker-checker; payment records; receipt attachments; WHT rates as data (O-041) and 50 ทวิ PDF series `WHT`.
- Petty cash float, top-ups, reconciliation.
- Funds: sinking fund ledger and bank account; out-transfer requires a resolution reference (DB check).
- Reports: income/expense monthly/annual, budget vs actual (now complete), simple balance sheet, receivables aging; exports CSV + Express + FlowAccount formats (documented column maps).
- Bank statement import (CSV of KBank / SCB / BBL / KTB, column maps as data) → matching to payments and expenses, unmatched queue.
- Acceptance: journals always balance (DB), fund transfer without resolution refused, approval bands, annual statement equals ledger sums (invariant test), statement import idempotent.

## J2.2 — Vendors & contracts
- Vendors, contracts (scope, SLA terms, instalments → scheduled expense requests, expiry alerts 90/60/30), quotation rounds (≥ 3 above `juristic.quotation_threshold`), selection by resolution or approval band, evaluations monthly (score, incidents, SLA breaches from service requests), preventive maintenance schedules linked to `core.asset_item` and a vendor contract (reuses inspections).
- Acceptance: contract instalment creates expense requests on schedule, expiry alerts, quotation rule enforced, evaluation pulls SLA breaches.

## J3.1 — Import wizard
- Templates (CSV/XLSX) for register + ownership + opening balances + 12-month history; `import_job` with validate → preview → reconcile (totals vs declared + bank statement) → commit in one transaction → rollback window until go-live; parallel cycle mode: drafts compared against the legacy bills file; full export of every juristic table (CSV zip).
- Acceptance: 500 units with 120 in arrears imported < 60 s in tests, rollback complete, mismatched totals block commit unless explained with an attachment.

## J3.2 — Developer handover
- Consume `building.handover.requested` v2 (fake transport until O-033): create/attach juristic tenant, set operator period developer → juristic at `juristic.formed`, carry advance fees as credits, first fund contributions into the fund ledger, receivables brought forward, residents keep identity.
- Acceptance: idempotent per event, balances equal payload totals, residents see no gap.

## J3.3 — PM company portfolio
- `pm_company` operates many juristic buildings (`acts_for` + grants exist): portfolio overview (collection rate, arrears, budget use, SLA per building), staff assignment across buildings, management contracts with each juristic (fee → platform-side invoice from PM to juristic as an ordinary juristic expense).
- Committee of building A never sees building B.
- Acceptance: PM sees 3 buildings, committee sees 1, management fee becomes an expense request in the juristic tenant.

## Every step
Plan file, PROGRESS row, decisions/O rows, contract regenerated (`contract:build` + `contract:lint`), `docs/deployment.md` for new jobs/env, integration green (5 batches if memory is tight), unit, lint, format, typecheck, build. One feat commit (or a few) per step, merge `--no-ff`.

# B4 — Billing, compliance, documents, payments & receivables

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md`, `docs/schema-design.md` ก่อน · ต้องทำ B1, B2 และ B3.3 เสร็จแล้ว (4.1 เริ่มได้หลัง B1) · ทำทีละ Deliverable (4.1 → 4.5) ต่อ 1 session · Plan Mode ทุกครั้ง
> นี่คือหัวใจของผลิตภัณฑ์ (D-011) — golden tests ทุกสูตร, ห้ามเดาค่าทางกฎหมาย (เขียน `O-###` แทน)

---

You are a senior backend engineer on **`getproperty-api`**. Decisions D-020–D-025, D-030–D-032, D-040–D-046, D-050–D-051 rule here.

## Deliverable 4.1 — Compliance engine (ADR-0007)
1. `compliance` module: a rule registry where each rule has `id` (`compliance.tariff_cap`, `compliance.bill_disclosure`, `compliance.deposit_cap`, `compliance.deposit_wear`, `compliance.deposit_deadline`, `compliance.no_renewal_fee`, `compliance.no_midterm_increase`, `compliance.notice_period`, `compliance.no_cutoff` (D-024), `compliance.late_fee_policy` ⚖), `legalRef` (announcement section), `severity` (`block | warn`), `appliesTo` (lease, bill, deposit, access), an `evaluate(context)` function and a unit test proving both the pass and the refusal. Rules read thresholds from settings (effective-dated).
2. `ComplianceError` → problem `422` with `code`, `legalRef`, `detail` th/en; `@ApiCompliance()` decorator lists the rules an operation can raise.
3. Org **compliance score** materialised per month (bills issued within cap, deposits refunded on time, contracts on the standard template) — used by B6 analytics and shown on the owner dashboard.
4. ADR-0007 (rule engine) and ADR-0008 (payment adapters, no funds held).
5. Acceptance: every rule has tests; `pnpm compliance:report` prints the rule table (id, legalRef, severity, covered operations) into `docs/compliance.md`.

## Deliverable 4.2 — Billing cycles & bills
1. Migrations: `billing_cycles` (property, period, cut_off_at, state `open → readings_pending → computed → issued → closed`, stats), `bills` (org, property, lease, room, tenant, number from series, period, due_at, state `draft → issued → partially_paid → paid | void | overdue`, totals, snapshot jsonb: tariff versions, readings used, lease lines, settings; immutable after issue — append-only trigger), `bill_lines` (type enum D-041, description, quantity `numeric(12,3)`, unit, price_per_unit `numeric(14,4)`, amount, meter_point, previous/current reading refs, tariff_version, compliance flags), `credit_notes`, `debit_notes` (reference bill, reason, lines), `estimate_settlements`.
2. Cycle job (D-031): at cut-off per property → for each active lease: select readings per meter point (highest confidence inside the window; else request a reading → `reading_round` item; after the grace deadline apply the org's `estimate_policy`) → compute lines: rent (pro-rata by calendar days for partial months), lease lines, electricity and water units × **tariff** (platform tariff version at the period end; `price_per_unit` = org's configured rate ≤ cap, `compliance.tariff_cap` blocks otherwise; structure can be tiered as MEA/PEA residential — port the tier maths exactly from the published tables with golden tests), common fees, one-offs queued for the period, prior balance carry-over, estimate settlement from the previous cycle → bill draft with totals (D-046 rounding).
3. Owner review: `GET /v1/owner/billing-cycles/{id}` (per-room table: readings, units, amount, flags), edit one-offs, re-compute, **issue** (`POST .../actions/issue`, idempotent) → bills become immutable, numbered (4.3), event `bill.issued` → LINE Flex + PDF (4.3) → tenant. Auto-issue setting (`billing.auto_issue` after N hours without owner action, default off).
4. Corrections: void a bill before any payment (new bill in the same period), or credit/debit note after; both re-open the receivable balance (4.5).
5. Tenant endpoints: `GET /v1/tenant/bills`, `/bills/{id}` (lines with readings and photos where they exist, D-022), `/bills/by-number/{n}`.
6. Acceptance: **golden tests** — fixtures for: full month, move-in mid-month, move-out mid-month, MEA tiered tariff vs flat org rate, rate above cap refused, water minimum charge, estimate then settlement, prior balance, credit note; property tests: Σ lines = total, rounding stable; e2e cycle → readings pending → staff reading → computed → issued → tenant sees it → void → re-issue.

## Deliverable 4.3 — Documents: series, PDF, LINE Flex
1. `document_series` (org, type, year, next number, gapless assignment in the issuing transaction), `documents` (type, number, subject refs, file ref, hash, issued_at, issued_by, voided_at), types: bill, receipt, receipt_tax_invoice, tax_invoice, credit_note, debit_note, deposit_receipt, deposit_statement, contract, inspection_report.
2. Renderer: Handlebars templates → Puppeteer PDF (A4 and 80 mm thermal variant for bills), Thai fonts embedded, org company data and logo from org settings, VAT block only for VAT-registered orgs (O-004), bill disclosure fields (D-022), QR embedded (4.4). LINE Flex message builders for bill, receipt, reminder, deposit statement (bubble carousel for multi-room tenants).
3. Endpoints: owner list/download/resend; tenant download; admin template preview; document archive export (zip per period).
4. Acceptance: snapshot tests of PDF text per document type; number series gapless under concurrent issue (integration test with 50 parallel issues); Flex JSON validated against LINE's schema.

## Deliverable 4.4 — Payments: Thai QR per bill, webhooks, slips, receipts
1. `QrPaymentAdapter` interface (create dynamic QR for amount + reference, query status, parse webhook, settlement file) with providers behind feature flags (KBank API, SCB, Opn — O-001; fake in tests) configured **per org** with the org's own merchant/bank account (D-042). `payments` (bill, amount, method `qr | transfer_slip | cash | bank_transfer_manual`, provider ref, state `pending → confirmed | failed | refunded`, confirmed_at, evidence), `payment_allocations` (payment → bills, for multi-bill payments), `slip_reviews`.
2. Flow: bill issued → QR created (reference = bill number) → embedded in PDF/Flex → `POST /webhooks/payments/{provider}` (signature verified, idempotent on provider ref) → payment confirmed → allocation → bill `paid`/`partially_paid` (org setting `payments.allow_partial`) → event `bill.paid` → receipt issued (4.3) and sent. Daily settlement reconcile job catches missed webhooks and flags discrepancies to the owner.
3. Slip fallback (D-043): `POST /v1/tenant/bills/{id}/slips` (image) → slip-verify adapter → match amount + org account + not previously used → auto-confirm; else owner review queue (`/v1/owner/slip-reviews*`) with approve/reject and duplicate warnings. Owner manual record for cash/transfer with evidence (audited).
4. Refunds and overpayment: credit to the tenant's balance by default; refund record with transfer evidence; receipts for overpayments as advance receipts.
5. Acceptance: e2e QR webhook → paid → receipt; duplicate webhook ignored; partial payments; slip verified auto; forged/duplicate slip → review; settlement file with a missing webhook creates the payment; org B's webhook reference cannot pay org A's bill.

## Deliverable 4.5 — Receivables, reminders, late fees, exports
1. `receivable_balances` (per lease: open bills, credits, balance), aging buckets; arrears list endpoint with filters and totals; dashboard numbers (`/v1/owner/dashboard` first version: income this month, collected %, arrears, due today, cycle state, compliance score, loss % from B3.4).
2. Reminders (D-045): schedule setting (`1,3,7` days after due), LINE Flex reminder with QR, quiet hours respected, stop when paid, owner-triggered "send reminder now"; late fee line only when `late_fee.enabled` and `compliance.late_fee_policy` allows (⚖ O-002) — added to the next cycle's bill, never to the issued bill.
3. Exports: Excel (bills, payments, arrears per period), **FlowAccount** and **PEAK** import formats (sales documents + receipts), VAT output working figures for VAT-registered orgs (ภ.พ.30 figures per month), income/expense summary (expenses = utility invoices + maintenance costs from B5 when present).
4. Acceptance: e2e overdue → reminder sent on schedule → paid → stops; export files open in the target format (golden CSV/XLSX snapshots); aging buckets correct on fixtures.

After each deliverable: `docs/PROGRESS.md`, contract regenerated, commit.

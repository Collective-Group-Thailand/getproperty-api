# Prompt pack J — Juristic, Common Charges & Gate (all property kinds) · getproperty

**getproperty — บิลทำเอง เก็บเงินเอง ถูกกฎหมาย** · Collective Group (Thailand) · pack date 2026-11-04

Source: the founder's plan "getproperty — แผน Phase J" (Claude Docs, https://claude.ai/artifact/23kqUR4FHTm2FKC2Snrv5Q) and the founder decisions of 2026-11-04 below. Applies to the latest Mac `main`: api `143943c`, web `77b4f25`, liff `1f8ce19`, edge `2d508c0`, asset-core `2065010` (v0.7.0) or newer.

## Files
| File | Where |
|---|---|
| `J-README.md` (this file) | `getproperty-api/docs/prompts/J-README.md` |
| `J-juristic-api.md` | `getproperty-api/docs/prompts/J-juristic-api.md` |
| `J-juristic-web.md` | `getproperty-web/docs/prompts/J-juristic-web.md` |
| `J-juristic-liff.md` | `getproperty-liff/docs/prompts/J-juristic-liff.md` |
| `J-gate-edge.md` | `getproperty-edge/docs/prompts/J-gate-edge.md` |
| `J-AUTORUN.md` | `getproperty-api/docs/prompts/J-AUTORUN.md` (orchestrator) |
| `J-DESIGN.md` | `docs/design/J-DESIGN.md` (design lead brief, Stitch references in `docs/design/stitch/j/`) |
| `J-AUTORUN-STATE.md` | `getproperty-api/docs/J-AUTORUN-STATE.md` (orchestrator log) |

Step names use **J** (api), **JW** (web), **JL** (liff), **JE** (edge) so they never collide with B/F/L/G.

## Goal in one line
Sell getproperty to every juristic person — condominium, housing estate, voluntary community, office / retail / industrial landlord — on the existing core, with property kind as **data**, not modules; the thing customers pay for is **getting the money in**, not computing the bill.

## Founder decisions this pack treats as requirements (J0 records them as D-302 onward, in this order)
1. **D-J01 One juristic tenant type for every property kind.** `core.tenant_type` `condo_juristic` → `juristic` (asset-core 0.8.0 keeps `condo_juristic` as a deprecated alias accepted on input for getbuild until its next major). Three data axes: `core.property.kind` (`apartment · condo · village · community · office · retail · industrial · mixed`), `core.building.legal_form` (`condo_act` พ.ร.บ.อาคารชุด · `land_allocation_act` พ.ร.บ.การจัดสรรที่ดิน 2543 · `voluntary` · `lease_contract`), `ops.rate_plan_version` `charge_basis` (`ownership_ratio · land_area · floor_area · per_unit · fixed · budget_split`). `legal_form` lives on the **building**, so a mixed-use project has several. No module per property kind. Supersedes group B of D-150.
2. **D-J02 Billing frequency.** `ops.billing_cycle.frequency` monthly · quarterly · semiannual · annual. Money billed in advance is unearned revenue recognised monthly. A `unit.transferred` mid-period prorates by calendar days between seller and buyer.
3. **D-J03 Budget → resolution → rate.** `juristic.budget` + `budget_line` and `juristic.resolution` (meeting date, resolution text, attachments) link to `rate_plan_version`; residents see budget vs actual.
4. **D-J04 Collections ladder.** Reminder / surcharge / suspension of common services / lawyer letter / lawsuit steps are data per `legal_form`; a payment plan or a dispute pauses the ladder. Surcharge caps and suspension measures are compliance rules `pending_legal_verification` and **off by default** until counsel confirms (O-038).
5. **D-J05 Debt clearance certificate** (หนังสือรับรองการปลอดหนี้): document kind `debt_clearance`, issued only when the unit's receivable is 0 at issue time; validity from a setting; gapless number; verification QR; requested from LINE or web.
6. **D-J06 Owner-centric billing.** Billed party = the co-owner(s) or a bill-to party the owner names; one statement across all units of an owner; channels LINE / e-mail / SMS / printed letter PDF.
7. **D-J07 Slips, partial payment, plans, recurring.** Slip `transaction_ref` unique across the platform; allocation oldest debt first and surcharge before principal (setting); payment plans with instalments and default; new channel `recurring` (direct debit / tokenised card) through the gateway port — fake until O-020.
8. **D-J08 Resident identity.** A resident relates to a **unit** through `core.occupancy` or `core.unit_ownership`; a lease is optional context. Roles co_owner · tenant · co_tenant · family · payer.
9. **D-J09 Vendor & service contracts** with SLA, instalments, expiry, evaluation and ≥ 3 quotations above a threshold.
10. **D-J10 Expenses & funds.** Request → approval by amount band (maker-checker, D-091) → payment → receipt → GL; petty cash; withholding tax + 50 ทวิ; the sinking fund is its own ledger and bank account, transfers out need a resolution.
11. **D-J11 Light GL**: standard juristic chart of accounts, income/expense statement, simple balance sheet, export CSV / Express / FlowAccount. No full accounting.
12. **D-J12 Migration**: import wizard (register, opening balance per unit, 12 months of payment history), reconcile to the bank statement before go-live, one parallel billing cycle.
13. **D-J13 Developer handover (D1)**: `building.handover.requested` from getbuild carries advance common fees, first sinking-fund contributions, receivables brought forward and the receiving bank account, not only the register.
14. **D-J14 Gate & visitor**: guard surface; pre-registered QR invites; per-house policy when nobody answers (`allow_and_log` · `deny` · `guard_calls`, default `guard_calls` after 3 min); visitor kinds; "remember this car 30 days"; retention 90 days; name + last 4 ID digits only, no full ID photo; never force every visit to wait for the owner.
15. **D-J15 Edge → barrier / LPR / resident opens**: `getproperty-edge` relay / RS-485 barrier output and LPR plate input; HaaS bundle like meters; residents open from LINE.
16. **D-J16 SOS / incident**: LINE button → gate + committee with the house location; incident log tied to the visitor log; reuses service request + notification.
17. **D-J17 Juristic revenue**: per-payment fee (D-250) **or** a flat fee per building per year that fits the juristic budget; price plans exist, prices not set (O-039).
18. **D-J18 Order and exclusions**: J0 → JR → J1 → J4 → J2 → J3. Not in Phase J: AGM e-voting, AI juristic assistant, energy, full accounting.
19. **D-J19 Roles**: new tenant roles `committee` (approves budgets/expenses by band, reads reports, never moves money), `auditor` (read-only, time-boxed), `guard` (gate only); new audience `guard`.
20. **D-J20 Design lead authority** (founder 2026-11-04): Claude acts as design lead and team lead for every open UX/product question in this pack; decisions are recorded in `docs/design/J-DESIGN.md` with their reason and are not asked.

Open questions J0 opens (next free numbers): **O-038** surcharge caps / suspension measures / letter wording per legal_form (counsel) · **O-039** juristic flat price · **O-040** pilot condominium + housing estate (names, data under NDA) · **O-041** withholding-tax treatment of juristic persons (condo vs land allocation) · **O-042** barrier / LPR reference hardware and HaaS price.

## Order (details per step in each repo's pack file)
| Step | Repo | What | After |
|---|---|---|---|
| J0 | api (+ docs) | gap analysis, decisions D-302…, O-038…, schema-design §7.6, plans | — |
| JA | asset-core | 0.8.0: `juristic` type, legal_form, property.kind, land/plot/deed, own-unit helpers for occupancy/ownership, event fields | J0 |
| JR | api | resident identity by unit (D-J08) | JA |
| JRL | liff | unit switcher, co-owner home, lease-only features gated by role | JR |
| J1.1 | api | juristic tenant, co-owner register, charge bases, budgets/resolutions, frequencies, prorate on transfer | JR |
| J1.2 | api | collections ladder, statements, slips/allocation/plans/recurring, debt clearance, aging, D-270 merge | J1.1 |
| JW1 | web | juristic console: register, budgets → rates, cycles, receivables, plans, debt clearance, import entry | J1.2 |
| JL1 | liff | my common fees, statement, pay, plans, debt clearance request, budget vs actual | J1.2, JRL |
| J4.1 | api | guard audience, gates, visits, invites, policies, retention, SSE | J1.1 |
| J4.2 | api | barrier/LPR device messages, resident open, SOS / incident | J4.1 |
| JE1 | edge | barrier relay / RS-485, LPR input, offline queue | J4.2 |
| JW4 | web | gate tablet surface (`/gate`), gate settings, visitor & incident logs | J4.2 |
| JL4 | liff | visitor approval, invites, remembered cars, open barrier, SOS | J4.2 |
| J2.1 | api | chart of accounts, expenses with approval bands, WHT + 50 ทวิ, petty cash, funds, statements, bank statement import | J1.2 |
| J2.2 | api | vendors, contracts, quotations, evaluations, preventive schedules | J2.1 |
| JW2 | web | accounting, funds, expenses, approvals, vendors, contracts | J2.2 |
| J3.1 | api | import wizard + reconcile + parallel cycle + full export | J2.1 |
| J3.2 | api | developer handover payload + operator period switch | J3.1 |
| J3.3 | api | PM company portfolio, management contracts, committee scoping | J3.1 |
| JW3 | web | import wizard, handover inbox, PM portfolio | J3.3 |
| Review | all | 3 independent read-only reviews, fixes with failing-first tests | all |

API steps run one at a time (shared migrations, numbering, `openapi.json`). Web / LIFF / edge steps run beside the next API step once their API step is merged.

## Rules (all in force from AGENT-BRIEF, G-AUTORUN and RESUME)
- Never ask; decide by the docs, else the most conservative legally safe option, record it (api `decisions.md`, others `PROGRESS.md` / `contract-requests.md`).
- Gateway / billing provider skipped (O-020): recurring and gateway adapters stay **fake**. LINE, SMS, slip-verify, e-KYC, AI, LPR / barrier vendors stay fake. Mark real adapters `// UNVERIFIED against live provider`.
- Legal measures (surcharge caps, suspending services, showing arrears at the gate) ship **off** behind settings until O-038 is answered.
- PDPA: purpose notice at the gate, minimal data, retention jobs that really delete, residents see only their own house.
- Money as decimal strings; tenancy tests (cross-tenant → 404) for every endpoint; idempotency on irreversible POSTs; audit + outbox; maker-checker where money leaves.
- UI: `DESIGN.md` + `J-DESIGN.md`; Anuphan only; all text via i18n (th/en; LIFF resident screens 6 languages); money and configurable values only from the API; designed like a real product — never AI-looking.
- Commits on the Mac as `Superball <Piyapan.pa@abbon.co.th>`, no Co-Authored-By / Claude-Session trailers, `feat/` branch, merge `--no-ff` into `main`, never push, never deploy, never touch `collective-infra` (list needs in `docs/deployment.md`).
- Never commit or discard the founder's own files listed in `HANDOFF-G-AUTORUN.md`.
- e2e: api `test:e2e` and web/LIFF Playwright specs are written per step and run together before the Review (founder change 2026-10-28); api integration runs per step.

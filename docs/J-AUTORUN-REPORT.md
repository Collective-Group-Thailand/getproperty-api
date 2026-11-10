# J-AUTORUN report — pack J "Juristic, common charges & gate"

Run: 2026-11-05 00:20 → 2026-11-10 Bangkok (J0 merged 2026-11-05 00:58; review fixes merged 2026-11-10). Orchestrated by
Claude cloud sessions; from 2026-11-09 21:20 by `session_01UnpBfz2oYacVHd9Vgetpo4` (J3.2 onward, chores, e2e, review, this
report). The cloud lost its Mac connection on 2026-11-05 ~14:30: J1.2b → J3.1, JW1–JW3a, JL1, JL4 and JE1 were built in
the sandbox and carried to the Mac as bundles (`_xfer/j/resume/`), imported fast-forward. Every commit is authored
Superball <Piyapan.pa@abbon.co.th> with no trailers; **nothing pushed, nothing deployed, collective-infra untouched,
founder files untouched**. Baseline (2026-11-05): api `143943c` · web `77b4f25` · liff `1f8ce19` · edge `2d508c0` ·
asset-core `2065010` (v0.7.0). Step log: `docs/J-AUTORUN-STATE.md`. Design log: `../docs/design/J-DESIGN.md` §7.

## 1. Summary — what pack J delivered

getproperty now runs a **juristic person** (นิติบุคคล) end to end, on one tenant type for every property kind (D-302):
`core.tenant_type` `juristic` (asset-core 0.8.0; `condo_juristic` kept as a deprecated input alias), with
`property.kind`, `building.legal_form` and unit plots as data — no module per property kind. The console changes words
and layout by kind (floors / ตร.ม. / ownership ratio for a condominium, soi / plots / ตร.วา for a housing estate), not
screens.

**Every juristic kind (condominium, housing estate, community, office, mixed)**

- **Resident identity by unit** (JR, D-309/D-322): a resident relates to a unit through ownership or occupancy, roles
  `co_owner · tenant · co_tenant · family · payer`; unit invitations; LIFF unit switcher and co-owner home (JRL).
- **Register and billing** (J1.1, D-303/D-304/D-307/D-323/D-324): co-owner register with shares, whole-unit transfers
  with calendar-day proration (credit notes after an issued advance invoice), bill-to parties with consent, billing
  frequency monthly / quarterly / semiannual / annual with advance revenue recognised monthly, charge bases `per_sqwa`
  and `budget_split`, budgets → resolutions → rates, committee and auditor roles. Golden-first fixes of three existing
  bugs (co-owners billed the full fee each, transfer double billing, ownership-only properties skipped by the sweep).
- **Collections** (J1.2, D-305/D-306/D-308/D-325/D-326): platform-unique slip reference, allocation policy (surcharge
  before principal as a setting), credit, payment plans with instalments and default, a recurring channel (fake only,
  off in uat/prod until O-020), the collections ladder per legal form (reminders run; surcharge, suspension, notice /
  lawyer letters and legal action are built **behind switches that stay off until counsel answers O-038**), owner
  statements across units, aging / KPI, the D-270 landlord workspace, and the **debt clearance certificate** (series
  DCL, public `/verify/<code>` page with unit + initials only).
- **Light GL and funds** (J2.1, D-311/D-312/D-329): chart of accounts per legal form, double-entry journals posted by
  subscribers, income statement and simple balance sheet, sinking fund as its own ledger (fund equity), expenses with
  maker-checker approval bands, petty cash, withholding tax + 50 ทวิ (rates unverified, O-041), bank statement import
  and matching, exports CSV / Express / FlowAccount (unverified, O-043).
- **Vendors** (J2.2, D-310/D-331): vendors, service contracts with instalments and expiry alerts, quotation rounds with
  the ≥ 3-quotation rule above `juristic.quotation_threshold`, monthly evaluations, preventive maintenance under a
  contract.
- **Migration from a legacy system** (J3.1, D-313/D-332): import wizard (register, ownership, opening balances,
  12 months of history), reconcile to the bank, one parallel billing cycle, go-live / rollback, full ZIP export.
- **Developer handover from getbuild** (J3.2, D-314/D-333): `building.handover.requested` v1/v2 intake, inbox,
  review / accept / reject, advance fees → owner credit, first fund contributions, receivables brought forward,
  `juristic.formed` back to getbuild (transport fake until O-033).
- **PM company portfolio** (J3.3, D-334): management contracts between a `pm_company` and a juristic tenant, the
  monthly fee requested in arrears as an expense request, read-only aggregate grant for the PM, staff board, committee
  isolation.

**Housing estates and gated communities in particular (also condominiums with a gate)**

- **Gate and visitors** (J4.1, D-315/D-320/D-327): new `guard` audience, enrolled gate tablets with PIN shifts
  (`/gate` kiosk on the web, ≤ 180 KB, offline queue), visits, QR invites, per-house policy when nobody answers,
  "remember this car", 90-day retention, last 4 ID digits only.
- **Barrier, LPR, resident open, SOS** (J4.2 + JE1, D-316/D-317/D-328/D-330): device protocol 1.3 (`gate.open`,
  `gate.state`, `plate.detected`), edge relay GPIO / Modbus RS-485 and LPR http-push input, late or future-stamped reads
  are history (never open the barrier), residents open from LINE for their own registered cars, SOS from LINE to the
  gate and committee (JL4).

**Apartments, dormitories, landlords, agencies**: unchanged behaviour (regression suites green); the juristic menu
narrows `leases` / `deposits` only for juristic tenants.

## 2. Steps

Feature commit first, merge commit in brackets (as in the state log). Contract = api `contract/openapi.json` paths
after the step (G ended at 798).

| Step | Repo | Status | Commit (merge) | Contract | Migrations | Notes |
|---|---|---|---|---|---|---|
| J0 gap analysis & decisions | api | done | 246d7cf (8b9b8bb) | — (docs only) | — | D-302–D-321, O-038–O-042; `docs/juristic-gap.md` |
| JA asset-core 0.8.0 | asset-core + api | done | core 7dcf39c (c175eac), tag v0.8.0 · api 51c7593 (21df284) | regenerated (enum `juristic`) | core 0014–0015, api 0068 | asset-core 96 tests |
| JR resident identity by unit | api | done | 1c5aa77 (56236c3; clock fix 12f1513) | +7 operations | 0069 | D-322; clock-pinned int tests |
| JRL units & roles | liff | done | 4985566 (49e684b) | sourceCommit c66e284 | — | unit 862 |
| J1.1a shares, proration, frequency | api | done | 72b3a97a (d02f9e0) | 804 | 0070 | D-323; golden-first fixes |
| J1.1b register, bill-to, budgets | api | done | a03b192 (31fc29f) | 821 | 0071 | D-324; LIFF CR #41 |
| J1.2a slips, plans, recurring, DCL | api | done | ba8ee73 (16bfc67) | 843 | 0072 | D-325; duplicate slip-ref pre-check |
| J1.2b ladder, statements, D-270 | api | done | ed938f2 (b04a1ff) | 875 | 0073 | D-326 |
| JW1 (a register · b receivables) | web | done | 684d12d (dc450a1) · 3d513cf (59aaf17) | — | — | unit 1534 → 1591 |
| JL1 my common fees | liff | done | 1905695 (a3ec548) | — | — | fees, statements, plans, DCL, auto-pay |
| J4.1 gate & visitors | api | done | 5127e3f (21cf453) | 920 | 0074 | D-327; guard audience |
| J4.2 barrier, LPR, SOS | api | done | b3e89b8 (d39c3f0) | 943 | 0075 | D-328; device protocol 1.3 |
| JE1 barrier relay, RS-485, LPR | edge | done | 559653b (cf549ad) | protocol 1.3 | — | 232 unit, 29 int |
| JW4 gate kiosk & admin | web | done | 40726d1 (b8c0360) | — | — | `/gate` 175.1 KB |
| JL4 visitors, barrier, SOS | liff | done | e0c3972 (dc1d4ab) | — | — | |
| J2.1 light GL, expenses, funds | api | done | c0a216c (9232500) | 984 | 0076 | D-329, O-043 |
| CR-017 late LPR reads + J2.2 vendors | api | done | fb2a22f (6b4084e fix + 7810317) | 1001 | 0077–0078 | D-330, D-331 |
| JW2 (a accounting · b vendors) | web | done | 9dae497 (d86f05b) · 6911ce7 (ed8e1a3) | — | — | unit 1729 → 1775 |
| J3.1 import wizard | api | done | 0b42645 (d2991e6) | 1018 | 0079 | D-332 |
| J3.2 developer handover | api | done | a5332b0 (ac28baa) | 1025 | 0080 | D-333; getbuild fake (O-033) |
| J3.3 PM portfolio | api | done | ae3c0d7 (b4ff761) | 1043 | 0081 | D-334, O-044 |
| JW3 (a import · b handover, portfolio) | web | done | 32f942e (6d3755e) · 7899e05 (749376d) | apiCommit 1e364785afaf | — | unit 1850 |
| J-CR cheap contract requests | api | done | 1b89544 (1ad0276) | 1052 (+9) | — | D-335, O-045; rest → backlog |
| JS-ui shared UI re-sync | liff | done | 764621c (4a1bb52) | — | — | shared:check 0 drift; unit 996 |
| JS-adopt contract re-adopt | web, liff, edge | done | web ad0e414 (6848b58) · liff adf6e50 (fe8b56f) · edge cd8a037 | api d33fed1 | — | decisions.md synced |
| e2e deferred e2e | all | done | api 6c2830a (9407b8d) · web bbbab2b (ce1a992) · liff 750ace8 (fb42f33) | liff sourceCommit 6c2830a | — | api 36/36, web 278/278, LIFF 208/208 |
| Review fixes | all | done | api 3321b18 (abd0c1b) · web 67e5776 (241b48f) · liff c96166a (393ce93) + adopt cab2e35 · edge 6baceca (2543f42) + 1a84474 | web/liff lock 3321b18 | none | D-336; 20 findings fixed |
| Report | api | done | this branch `docs/J-report` | — | — | this file |

## 3. Final heads and contract locks

| Repo | Final head (`main`) | Note |
|---|---|---|
| collective-asset-core | `7dcf39c` | tag **v0.8.0** |
| getproperty-api | `a5a8f33` before this report (code head `3321b18`) | contract **1052 paths / 1213 operations**; this report's merge on top |
| getproperty-web | `67e5776` | `contract.lock.json` apiCommit **`3321b18b11b9`** |
| getproperty-liff | `cab2e35` | `contract.lock.json` sourceCommit **`3321b18b11b9b967e633ce22f728887e0382ff14`** (290 operations used) |
| getproperty-edge | `1a84474` | device protocol **1.3** (re-adopted from api, description-only change of `PlateDetectedData.at`) |

web and LIFF lock the same contract (sha256 `645555b0…`).

## 4. Test counts at the final heads

| Repo | Static | Unit | e2e | Other |
|---|---|---|---|---|
| api | lint · format · typecheck · build · contract:build + contract:lint green | **757 passed + 2 skipped** | **36/36** | integration **83 suites, 622 passed + 1 skipped, 0 failed** (embedded PostgreSQL 18); contract **1052 paths** |
| web | lint · format · typecheck · gen:api --check · build · build-storybook green | **1882** | Playwright (`chromium` + `owner`) **279/279** (first deferred run 209/278) | Lighthouse `/gate` **176.2 KB** (≤ 180), juristic set max **248.8 KB** (≤ 260); e2e:visual 11/11 |
| liff | lint · format · typecheck · shared:check --strict (362 copies, 0 drift) · gen:api --check · build · build-storybook green | **1010** (87 files) | Playwright **208/208** (first deferred run 197) | `pnpm lhci` every page ≤ 180 KB, max technician work order **179.8 KB**, visitors 177.5 KB |
| edge | lint · format · typecheck · build · gen:protocol:check green | **240** | 2 soak | integration **29** |
| asset-core | — | 96 (at v0.8.0) | — | — |

e2e was deferred per step (specs written) and run once at the end on the final heads (founder change of pack G kept).
The e2e pass fixed real defects: served-contract `ImportSheet` enum (api), accessibility and focus defects, gate
offline queue replay, DCL code dialog, clock-dependent seeds (web), redeem / error-summary focus, field labels, script
fonts regression (LIFF); 7 web and 3 LIFF snapshots were re-baselined to the redesign after inspection.

## 5. Decisions and open questions of the run

| ID | Title | Status |
|---|---|---|
| D-302 | One juristic tenant type for every property kind (`juristic`, property kind, legal form) | Accepted (founder 2026-11-04) |
| D-303 | Billing frequency; advance billing recognised monthly; transfer proration | Accepted (founder 2026-11-04) |
| D-304 | Budget → resolution → rate | Accepted (founder 2026-11-04) |
| D-305 | Collections ladder as data per legal form | Accepted (founder 2026-11-04) |
| D-306 | Debt clearance certificate (DCL, public verify) | Accepted (founder 2026-11-04) |
| D-307 | Owner-centric billing (co-owners by share, bill-to, one statement) | Accepted (founder 2026-11-04) |
| D-308 | Platform-unique slips, partial payment, plans, recurring channel | Accepted (founder 2026-11-04) |
| D-309 | Resident identity by unit | Accepted (founder 2026-11-04) |
| D-310 | Vendors & service contracts, ≥ 3 quotations | Accepted (founder 2026-11-04) |
| D-311 | Expenses & funds (approval bands, WHT, sinking fund) | Accepted (founder 2026-11-04) |
| D-312 | Light GL, no full accounting | Accepted (founder 2026-11-04) |
| D-313 | Migration: import, reconcile, parallel cycle | Accepted (founder 2026-11-04) |
| D-314 | Developer handover carries money, not only the register | Accepted (founder 2026-11-04) |
| D-315 | Gate & visitor (policy, retention 90 days, last 4 ID digits) | Accepted (founder 2026-11-04) |
| D-316 | Edge → barrier / LPR / resident opens | Accepted (founder 2026-11-04) |
| D-317 | SOS / incident | Accepted (founder 2026-11-04) |
| D-318 | Juristic revenue: per-payment fee or flat fee per building (prices not set) | Accepted (founder 2026-11-04) |
| D-319 | Order and exclusions of pack J | Accepted (founder 2026-11-04) |
| D-320 | Roles committee, auditor, guard; audience `guard` | Accepted (founder 2026-11-04) |
| D-321 | Claude as design / team lead for pack J | Accepted (founder 2026-11-04) |
| D-322 | JR implementation (resident identity by unit) | Accepted (D-321, 2026-11-05) |
| D-323 | J1.1a implementation (shares, proration, owner sweep, frequency) | Accepted (D-321, 2026-11-05) |
| D-324 | J1.1b implementation (onboarding, register, bill-to, budgets, committee / auditor) | Accepted (D-321, 2026-11-05) |
| D-325 | J1.2a implementation (slips, allocation, plans, recurring, DCL) | Accepted (D-321, 2026-11-05) |
| D-326 | J1.2b implementation (ladder, statements, D-270 workspace, reports) | Accepted (D-321, 2026-11-05) |
| D-327 | J4.1 implementation (gate & visitor, guard audience) | Accepted (D-321, 2026-11-05) |
| D-328 | J4.2 implementation (barrier, LPR, resident open, SOS) | Accepted (D-321, 2026-11-05) |
| D-329 | J2.1 implementation (light GL, expenses, WHT, funds, bank statements) | Accepted (D-321, 2026-11-06) |
| D-330 | Late LPR reads are history (edge CR-017 safety fix) | Accepted (D-321, 2026-11-06) |
| D-331 | J2.2 implementation (vendors, contracts, quotations, evaluations) | Accepted (D-321, 2026-11-06) |
| D-332 | J3.1 implementation (import wizard, reconcile, go-live, export) | Accepted (D-321, 2026-11-06) |
| D-333 | J3.2 implementation (developer handover from getbuild) | Accepted (D-321, 2026-11-06) |
| D-334 | J3.3 implementation (PM portfolio, management contracts, committee scoping) | Accepted (D-321, 2026-11-09) |
| D-335 | J-CR cheap contract requests of web (JW1–JW4) and LIFF (#37–#52) | Accepted (D-321) |
| D-336 | J review fixes api A1–A6 | Accepted (founder pre-approved, 2026-11-10) |
| O-038 | Juristic collections law per legal form (surcharge caps, suspension, letter wording, DCL wording, arrears at the gate) | Open — legal counsel |
| O-039 | Juristic price (flat fee per building vs per-payment fee) | Open — founder · finance |
| O-040 | Pilot customers: one condominium and one housing estate | Open — founder |
| O-041 | Withholding tax of juristic persons, 50 ทวิ | Open — accountant · tax counsel |
| O-042 | Gate hardware (barrier controller, LPR) and HaaS price | Open — founder · IoT engineer |
| O-043 | Light GL: chart of accounts, fund equity, revenue recognition, Express / FlowAccount layouts | Open — accountant |
| O-044 | PM company: fee VAT / WHT, write access, billing in advance | Open — accountant · counsel · founder |
| O-045 | Personal data at the gate (household first names) and per-action consents in the list | Open — founder · DPO / counsel |

Still open from before and touched by J: O-020 payment gateway (recurring channel), O-033 getbuild API (handover
rejection / handoff transport).

## 6. Design decisions

D-321 made Claude the design lead; every UX decision is in `../docs/design/J-DESIGN.md` §7 with its reason —
**142 entries**: JRL 1, JW1a 16, JW1b 11, JW4 14, JW2a 19, JW2b 16, JW3a 12, JW3b 18, JL1 13, JL4 16, JS-adopt-liff 3,
J-review-fixes 3. The main lines:

- **Money only from the API.** The console and LIFF never add money up (no bulk-selection total, no previewed
  proration, instalment plans in words until the API schedules them, "same as sent" compared as strings). The one
  exception is the manual journal, which sums the debits / credits the office typed, in integer satang.
- **Property kind changes words, not screens** (`KIND_TRAITS` + i18n words per kind); an estate's soi is a building;
  measures in the place's own unit from the register (ownership ratio printed as the API's 6-decimal ratio).
- **Calm and honest states**: one filled action per screen; disabled actions keep their reason visible; expiry is
  never red; a refused debt clearance is a calm card; the barrier says "open command sent", never "open"; "saved, will
  send" only when it is.
- **Legal gates are visible, not hidden**: ladder steps locked "until counsel confirms", unverified WHT rates marked
  "(รอยืนยัน)", no legal wording in UI chrome (paper / PDF only).
- **Privacy visible**: codes shown once, minimal fields on the public verify page re-picked field by field, last 4 tax-id
  digits, aggregate-only PM portfolio with a privacy line, no household names at the gate (O-045).
- **Gate kiosk**: its own frame / cookies / BFF under the owner host, no query or overlay library (≤ 180 KB), IndexedDB
  queue for every visit, landscape on one screen, large targets and type scale, SOS takeover, server-side lock.
- **New shared pieces**: `PeriodStatement`, `StepTrack`, `SimpleTable` wide phone slot, `Chart` domain / ticks, new
  finance icons; the LIFF re-synced `src/ui` from web with 0 drift.

**Screenshots**: `_shots/j-JW1a`, `j-JW1b`, `j-JW2a`, `j-JW2b`, `j-JW3a`, `j-JW3b`, `j-JW4`, `j-JL1`, `j-JL4` (1440 + 390
px, prod build + mock). In the sandbox only `_shots/j-JW3b/` exists (36 files); the founder's Mac holds the earlier ones
under `~/Collective/getproperty/_shots/`.

## 7. Independent review

Three read-only reviewers (api; web; LIFF + edge) found **20 findings: 0 critical, 0 high, 9 medium or medium-low,
11 low / low-medium** (api 6, web 7, LIFF 3, edge 4). **All 20 fixed with a regression test** (D-336 for the api part).

| # | Repo | Severity | Finding | Fix | Test |
|---|---|---|---|---|---|
| A1 | api | Medium | A guard's second sign-in superseded the shift but left the old tablet token valid ≤ 15 min | Superseded shifts' refresh families revoked after commit (`afterClose`) | int: first token 401 on `/v1/guard/me` and gate open; refresh 401 |
| A2 | api | Medium | Future-stamped LPR reads bypassed the late-read rule (CR-017) | Read > receivedAt + `gate.lpr.max_clock_skew_seconds` (60) → historical, audit `clock_suspect` | unit `isLateRead(now+1h)`; int no visit, no `gate.open` |
| A3 | api | Low-Med | `RECURRING_PAYMENTS_MODE=fake` allowed in production; webhook secret fell back to a public constant | `validateEnv` refuses fake in production and requires `RECURRING_WEBHOOK_SECRET` when not off | `validate-env.spec` |
| A4 | api | Low | Gate `hasArrears` used balance > 0 | Overdue balances only, net of the payer's credit | unit + int both cases |
| A5 | api | Low | Manual bank-line match ignored account / direction | Same filters as candidates → 422 `bank_statement.account_mismatch` | int cross-account match 422 |
| A6 | api | Low | Province-less LPR read auto-entered a same-number car of another province | No province → low_confidence / pending, guard confirms | unit + int |
| W1 | web | Medium | Kiosk lock was client state; reload skipped the PIN | `POST /bff/guard/session/lock`, httpOnly lock cookie; BFF 423 `gate.locked` on writes | e2e `gate-lock.spec.ts` + BFF unit |
| W2 | web | Medium | Pending visit after 5xx / 429 / 408 never retried while the stream was open | Timer on the earliest `nextAttemptAt`, same Idempotency-Key | `useDesk.test.tsx` fake timers |
| W3 | web | Med-Low | "Queued" shown without IndexedDB or after a 422 / 409 refusal | `unsaved` (red) and `refused` states, `scan()` too | `useDesk.test.tsx` |
| W4 | web | Medium (PDPA) | Offline queue kept PII forever; forget / revoke cleared nothing; `hasArrears` cached | Prune other gates / sent / > 24 h; delete DB and unit cache on forget; never cache arrears | `queue.test.ts`, `plate.test.ts` |
| W5 | web | Low | Receivables bulk actions made a new Idempotency-Key per run | One key per action × row until answered | `bulk.test.ts` |
| W6 | web | Low | Sentry scrub missed `/verify/<code>` | Masked on page and API path | `scrub.test.ts` |
| W7 | web | Low (UX) | Oversize import files silently ignored | "Too large" message where chosen (5 MB sheet, 10 MB evidence) | unit |
| L1 | liff | Medium | Invite form rotated the key after network / 5xx → duplicate passes | `useIdempotentAttempt` frozen on the pass; rotate only on 4xx refusal | unit |
| L2 | liff | Med-Low | SOS key per mount with a rebuilt body → `key_reused` failure forever | One attempt per {unit, kind, note}; on `key_reused` resend → existing SOS | unit |
| L3 | liff | Low | Barrier open made a new key per request | Stable key per press intent (gate + vehicle) for ~30 s | unit |
| E1 | edge | Medium | Relay "on" retried, pulse timed from ack, force-off queued → relay held ~15 s | 0 retries on "on", pulse from first transmit, urgent force-off | virtual RS-485 pair tests |
| E2 | edge | Low-Med | LPR snapshots pruned only on save; no free-space floor | Prune at start / teardown / hourly; skip below `lpr.minFreeMb` (256) | unit |
| E3 | edge | Low | 30 s future skew allowance; `clockSuspect` ignored | 5 s allowance; `gate.open` refused `clock_suspect` while NTP is lost | unit |
| E4 | edge | Low | Failed Modbus init leaked the port refcount; no recovery after replug | Release on failure; close + reopen after an I/O error | unit |

The review also confirmed RLS on every new table, tenant-pair RLS on management contracts, maker-checker triggers,
append-only collection events and immutable journals.

## 8. collective-infra needs (not changed from here)

From `docs/deployment.md` § requests for collective-infra (one row per J step). **No new container, bucket, prefix,
IAM permission or broker topic / ACL.**

**Release order**: tag / publish `@collective/asset-core` **0.8.0** (core migrations `0014_juristic_kinds`,
`0015_juristic_kinds_data`) before the image; the migrate command applies core 0014–0015, then app **0068–0081**:
0068 juristic tenant type · 0069 unit resident invitations · 0070 billing frequency · 0071 juristic register / budgets ·
0072 payments / plans / clearance · 0073 collections / statements / workspace · 0074 gate visitors · 0075 gate hardware
/ SOS · 0076 accounting / funds / expenses · 0077 LPR late reads · 0078 vendors / contracts · 0079 juristic import ·
0080 juristic handover · 0081 PM portfolio (all DDL only).

**Pre-checks before migrating**

- Before **0072** — the platform-wide slip index refuses to build if a live bank reference is used by two tenants:
  ```sql
  SELECT trans_ref FROM ops.slip_review
  WHERE trans_ref IS NOT NULL AND status NOT IN ('duplicate','rejected')
  GROUP BY 1 HAVING count(DISTINCT tenant_id) > 1;
  ```
  must return nothing; resolve by hand — never rewrite a booked slip.
- Before **0076**: `SELECT count(*) FROM juristic.budget_line b WHERE b.account_id IS NOT NULL` returns 0.

**Env / secrets**

| Variable | Value in uat / prod | Note |
|---|---|---|
| `RECURRING_PAYMENTS_MODE` | unset / `off` | `fake` is **refused at start-up when `NODE_ENV=production`** (D-336); residents get `recurring.unavailable` until O-020 |
| `RECURRING_WEBHOOK_SECRET` | only when a provider is on (≥ 16 chars) | required in production whenever the mode is not `off`; Secrets Manager `collective/<env>/getproperty/recurring-webhook-secret` → task env |
| `GETBUILD_MODE` | unset / `off` | handover rejections and handoffs wait until O-033; intake uses the existing `INTEGRATION_GETBUILD_VERIFY_KEYS` on `/webhooks/integration/getbuild`; `juristic.formed` leaves through `INTEGRATION_GETBUILD_TRANSPORT` |
| `GUARD_REFRESH_TOKEN_TTL_HOURS` | optional, default 14 (1–24) | one guard shift on a gate tablet |

**Routes / proxy**

- Public `POST /webhooks/recurring/{provider}` behind the ALB like `/webhooks/payments/*` (signature-checked); public
  `GET /v1/public/documents/verify/{code}` (anonymous, `no-store`, public rate limit); web page
  `<PUBLIC_WEB_APP_URL>/verify/<code>` (printed QR).
- Do not buffer `GET /v1/guard/events` (SSE, heartbeat 25 s, idle timeout ≥ 60 s).
- **Request body 7 MB** on `…/juristic/imports/{id}/files` and `…/parallel-cycle` (`LARGE_BODY_ROUTES`; inline base64
  ≤ 5 MB) — Caddy / the load balancer must allow the same.

**Buckets**: none new — DCL, statements, letters, 50 ทวิ, bank files, import files, visit / SOS photos, contract
documents and exports are tenant documents under the existing `t/<tenant>/…` prefix. LPR snapshots stay on the edge.

**Worker jobs (existing `worker` container)**

| Job | Schedule | Purpose |
|---|---|---|
| `payment-plans` | hourly | queue instalments, mark paid, default plans |
| `collections` | hourly | open / resolve collection cases, run the next due ladder step once |
| `gate-visits` | every 15 s | house-policy timeouts, open-visit alerts, pending plate reads expire |
| `gate-retention` | daily | delete visits, photos, plates, invites, cars after `gate.retention_days` |
| `juristic-ledger` | hourly | back-post documents, recognise advance revenue |
| `vendor-contracts` | hourly | instalment expense requests, expiry alerts, contracts → expired |
| `juristic-imports` | daily | delete import rows 90 days after go-live / rollback / cancel |
| `juristic-handovers` | every 10 min | retry rejected handovers to getbuild (≤ 10 attempts; nothing while the port is off) |
| `management-contracts` | hourly | PM fee per ended period → one submitted expense request; end contracts, revoke PM grant |
| `billing-cycles` (existing) | unchanged | now also opens quarterly / semiannual / annual cycles |

**Settings seed** — run the image seed step (`pnpm db:seed`) on existing databases. Keep the legal switches off until
O-038: `juristic.surcharge.enabled` false, `juristic.surcharge.*` null, `juristic.suspend_services.enabled` false,
`juristic.legal_action.enabled` false, `juristic.letters.*.template_version` null, **`gate.show_arrears` false**,
`juristic.rate_requires_resolution` true. Gate: `gate.retention_days` 90, `gate.policy.timeout_seconds` 180,
`gate.policy.action` guard_calls, `gate.offline_max_hours` 24, `gate.auto_open_known_plates` false,
`gate.lpr.min_confidence` 0.90, `gate.lpr.max_event_age_seconds` 20, **`gate.lpr.max_clock_skew_seconds` 60**,
**`gate.tablet.auto_lock_minutes` 5**, `gate.barrier.pulse_ms` 800, resident open / SOS limits; flag `module.gate` off.
Money: `payments.allocation_policy` oldest_first, `payments.slip_max_age_days` 30, `juristic.plan_*`,
`juristic.debt_clearance.*`, `juristic.approval_bands`, **`juristic.wht_rates` (marked unverified, O-041)**,
`juristic.quotation_threshold` 50000.00, contract alert / lead days, `juristic.import.*`, **`pm.portfolio_expiring_days`
90**, `billing.advance_open_days` 0. Also roles `committee`, `auditor`, `guard`, the new permissions, the 7 compliance
rules `pending_legal_verification`, workflow `collection_case`, notification templates / routes.

**Edge**: gateways driving a barrier / camera get JE1 after the api (protocol 1.3 is additive); hardware file
`lpr.minFreeMb` (default 256 MB) — the free-space floor below which no LPR snapshot is stored; keep gate edges on NTP
(reads stamped > 60 s ahead are history; the edge refuses `gate.open` while NTP is lost).

## 9. Founder to-do

1. **Bump `ASSET_CORE_REF` to `v0.8.0`** in `getproperty-api/.github/workflows/build-image.yml` (founder file, still
   v0.7.0; `.github/actions/setup` is already v0.8.0).
2. **Rebuild asset-core `dist` on the Mac** (`pnpm build` in collective-asset-core at v0.8.0).
3. **Push** asset-core (with tag v0.8.0), api, web, liff, edge.
4. **Counsel — O-038**: surcharge caps, suspension, letter and DCL wording per legal form, arrears at the gate. Until
   then only reminders run.
5. **Tax adviser — O-041**: WHT rates and forms of juristic persons, 50 ทวิ.
6. **Accountant — O-043**: chart of accounts, fund equity, revenue recognition, Express / FlowAccount layouts.
7. **Payment gateway — O-020**: needed for the recurring channel (and the per-payment fee).
8. **Pilot customers — O-040**: one condominium and one housing estate, data under NDA.
9. **Barrier / LPR hardware — O-042**: reference controller and camera, HaaS price; then live verification of the
   edge relay / Modbus / LPR drivers.
10. **getbuild API — O-033**: handover rejection and handoff transport.
11. **PM fee — O-044**: VAT / WHT on the management fee, PM write access, billing in advance.
12. **Gate privacy — O-045**: household first names on the guard's unit list; per-action consents in the list.
13. **Juristic price — O-039**.
14. **Backlog contract requests**: api `docs/PROGRESS.md` § Backlog (J-CR) — 18 web rows (+ older G / F rows) and LIFF
    #34, #35, #40, #43, #46, #47; web `docs/contract-requests.md` has 51 open rows (25 from pack J, incl.
    `GuardMeDto.offlineMaxHours`, handover `developerName`, management-contract counts, PM company lookup).
15. **UNVERIFIED adapters** (fakes in tests; real paths not checked against a live system): recurring payments port
    (no real provider), Express / FlowAccount journal exports, bank statement formats, edge GPIO / Modbus relay and
    serial driver, plus the earlier LINE / SMS / slip-verify / e-KYC / AI / lock vendors.

## 10. Known follow-ups

- **Management contract draft editor** on the office side (web) — needs the PM company lookup by code (contract request).
- **Admin handover assignment screen** and handover notifications (`admin.juristicHandovers.*`) on the web.
- **LIFF budget card expense side** (`expenseSideAvailable`, budgeted / actual expense lines) — a new card section.
- **`GuardMeDto.offlineMaxHours`** contract request (web prunes with the 24 h default until then).
- Gate admin settings list lacks `gate.lpr.max_clock_skew_seconds` and `gate.lpr.max_event_age_seconds`.
- Handover `developerName`, review `legalForm` / `propertyKind` as sent, state counts on handovers / management
  contracts, staff-board assignment ids (web contract requests of JW3b).
- `PaymentMandateDto.partyName` not shown in the LIFF; web vendors `categories` / `register?propertyId=` adopted but
  unused.
- Monthly evaluation reminders, instalment schedule preview, band previews, import inline row edit, go-live readiness,
  JV journal numbers, work-order numbers, ledger `asOf` (api backlog, sizes S–M).
- Edge: barrier position feedback (limit switch), XML / multipart camera adapters, snapshot upload on request.
- The full export may need the export subscriber's statement timeout raised for a large tenant (watch the first pilot).
- The LIFF technician work order is at 179.8 KB of 180: its next client widget must be lazy.

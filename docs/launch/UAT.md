# UAT — pilot building (R1)

User acceptance on the **uat** environment with the pilot owner, a staff member, two residents and Collective's
field engineer and finance user. Run top to bottom; each step lists who does it, where, and what must be true.
Write ✅ / ❌ + note in the right column; a ❌ needs a ticket and an accepted workaround before go-live.

Preparation (platform admin): tenant onboarded, subscription on the pilot's plan with the pilot discount, pilot
agreement recorded, utility tariff of the provider published (maker + checker), owner invited.

Environment: the uat box of the Collective platform (D-230, `docs/deployment.md`) — it runs **Mon–Fri 08:00–20:00
Asia/Bangkok** only; for a session outside those hours wake it first (collective-infra `platform/bin/wake.sh uat`)
and keep the field engineer's gateway buffering meanwhile (store and forward). Before A1: LAUNCH-CHECKLIST §3 lines
for uat ticked (secrets, migrate incl. the TimescaleDB step, EMQX mutual TLS, device host, client IP smoke check).

## A. Install day (Smart buildings; Starter skips A3–A6)

| # | Who / where | Step | Expected | Result |
|---|---|---|---|---|
| A1 | Owner · console | Accept the invitation (SMS OTP), complete company data and bank account, create the building, floors and units | Units listed with numbers and floors; plan page shows units counted | |
| A2 | Owner · console | Ask to upgrade to Smart (`Upgrade`) for the building | Site survey `requested` | |
| A3 | Platform · admin | Schedule and complete the survey with findings | Install order opened: 1 gateway + 1 meter device per unit × utility | |
| A4 | Field engineer · staff PWA | Open the install order; claim the gateway with its provisioning code; bind each meter (bus, address, driver) per unit | Items move to done; meter points show their channel | |
| A5 | Field engineer · staff PWA | Complete the order | Order `done`; HaaS assets `installed` with term and book value | |
| A6 | Owner · console | Devices page: gateway online, meters reporting within 15 minutes | Health green, first telemetry in usage charts | |
| A7 | Owner · console | Create leases for the two residents (rent, deposit, contract), send for signing | Contracts generated with compliance checks; residents invited | |
| A8 | Residents · LIFF | Log in with LINE, link the invitation, read and e-sign the contract, acknowledge the building rules | Lease `active`; rules acknowledged; deposit invoice issued | |
| A9 | Staff · staff PWA | Move-in inspection with photos per item | Inspection report PDF; photos visible to the resident | |

## B. First cut-off (billing cycle)

| # | Who / where | Step | Expected | Result |
|---|---|---|---|---|
| B1 | Staff · staff PWA | Manual readings round (Starter) — photo + register for each meter; OCR suggests the value | Round progress `read / total`; outliers go to review | |
| B2 | Owner · console | Review queue: accept or correct flagged readings | Queue empty | |
| B3 | Owner · console | Billing cycle of the month: cut-off, draft invoices with metered lines (rate, registers, sources), compliance checks pass or are acknowledged | Drafts correct to the satang against the hand calculation | |
| B4 | Owner · console | Issue the invoices | Numbered (INV series), PDFs, LINE Flex sent to residents (not in quiet hours) | |
| B5 | Residents · LIFF | Open the bill, see usage summary and the Thai QR | Amount due matches; QR present | |
| B6 | Owner · console | Utility invoice of the provider entered (or OCR'd); loss report | Loss % per utility shown | |

## C. First payments

| # | Who / where | Step | Expected | Result |
|---|---|---|---|---|
| C1 | Resident 1 · LIFF | Pay by Thai QR (provider sandbox) | Callback confirmed; invoice `paid`; receipt (RCP) PDF in LINE | |
| C2 | Resident 2 · LIFF | Upload a transfer slip | Slip waits for review; owner approves; receipt issued | |
| C3 | Owner · console | Dashboard: collected %, arrears | Figures match C1–C2 | |
| C4 | Platform · worker | Day after due + grace: unpaid invoice becomes overdue; dunning reminder per `reminders.schedule` | Reminder in LINE outside quiet hours | |
| C5 | Platform · job | 1st of the next month: platform invoice to the owner (PIV) with Thai QR and PDF, units counted = active units | Owner sees it under Plan → Invoices | |
| C6 | Owner · console | Pay the platform invoice by QR (sandbox) or Finance records a transfer | Platform receipt (PRC); subscription `active` | |
| C7 | Finance · admin | Request a credit note on a platform invoice; a second user approves | PCN numbered; invoice credited; the requester cannot approve | |

## D. First move-out

| # | Who / where | Step | Expected | Result |
|---|---|---|---|---|
| D1 | Resident 1 · LIFF | Give notice — earliest date offered = today + 30 days | Notice recorded with evidence | |
| D2 | Staff · staff PWA | Move-out inspection, photos per item, final readings | Report; deductions proposed with move-in photos side by side | |
| D3 | Owner · console | Deposit settlement: deductions within the rules, refund within `deposit.refund_days` | Statement PDF; compliance checks pass | |
| D4 | Resident 1 · LIFF | Dispute one deduction with up to 6 photos | Dispute visible to the owner with photos | |
| D5 | Owner · console | Resolve the dispute; pay the refund | Deposit closed; receipts/statements under "documents on file" | |
| D6 | Owner · console | Unit back to vacant; next month's units counted unchanged (status not inactive) | Plan usage correct | |

## E. Cross-cutting checks

| # | Check | Expected | Result |
|---|---|---|---|
| E1 | A second test tenant cannot see any pilot data (search, ids in URLs) | 404 everywhere | |
| E2 | Support user without grant → 403; with the Owner's grant → read only (writes refused) | as stated, all audited | |
| E3 | Suspend the test tenant's subscription | Owner/staff writes 403 `tenant.read_only`; residents still see and pay invoices; reinstate restores | |
| E4 | `GET /v1/admin/tenants/{id}/pilot-kpis` after C | Time to bill, auto-reconciled %, on-time % computed from real data | |
| E5 | Thai and English copy, Buddhist-era dates in Thai | correct | |

Sign-off: pilot owner, Collective founder, QA — date and signature.

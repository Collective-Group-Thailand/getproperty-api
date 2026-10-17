# Launch checklist — Phase 1 pilot (R1)

Go / no-go list for the first paying pilot building (D-083). Each line has an owner and evidence; the launch is a
**go** only when every **blocking** line is ticked. Open items (O-###) are in `docs/decisions.md`.

Legend: **B** = blocking · ☐ open · ☑ done (with date and link to the evidence).

## 1. Legal and business

| | Item | Owner | Evidence |
|---|---|---|---|
| B ☐ | สคบ. 2568 texts confirmed: deposit caps, late fee, estimate billing (O-002) — settings updated, ⚖ marks removed | Legal counsel | settings versions |
| B ☐ | Pilot agreement signed and recorded (`PUT /v1/admin/tenants/{id}/pilot-agreement`): paid discount, term, reference rights, anonymised data use, KPI targets, **baseline captured** | Founder | pilot agreement row + PDF |
| B ☐ | Pilot org VAT status known (O-004); `tax.vat` and VAT-able line kinds set (O-007) | Pilot org + accountant | settings versions |
| B ☐ | Platform issuer data (`platform.company`) and the platform merchant (`platform.payments.merchant`) confirmed — legal name, tax id, branch, address; merchant account (O-008) | Finance | settings versions, provider contract |
| B ☐ | Payment provider chosen and live credentials stored (O-001) — tenant merchant + platform merchant; feature flag `payments.provider.<p>` on for the pilot tenant | Founder + Finance | secret versions (no values), flag audit |
| B ☐ | D-156 price plan versions reviewed for the pilot (Proposed → the price the pilot pays) | Founder | `/v1/admin/price-plans` |
| ☐ | AI unit costs entered (`ai.unit_costs`, O-009) so OCR cost per tenant is real | Finance | setting version |
| B ☐ | Privacy notice (TH/EN) and consent texts published; DPA with the pilot org (processor role, D-025) | Legal counsel | documents |
| ☐ | Terms of service accepted by the pilot Owner in the console | Founder | audit `consent.*` |

## 2. Reference data

| | Item | Owner | Evidence |
|---|---|---|---|
| B ☐ | Utility tariffs of the pilot's provider entered by one admin and **verified by another** (O-006, D-021a), published | Platform admins (maker + checker) | tariff versions `published` |
| B ☐ | Notification templates (TH) reviewed: invoice, receipt, reminder, deposit statement, OTP, platform invoice | Ops | template versions published |
| ☐ | Building rules clauses in the contract template of the pilot (D-203 acknowledgement) | Pilot owner | lease template |

## 3. Infrastructure (prod workspace)

| | Item | Owner | Evidence |
|---|---|---|---|
| B ☐ | `terraform validate` + `plan` reviewed, `apply` on prod (UNVERIFIED in the sandbox — run in CI with the real providers) | Platform engineer | CI run |
| B ☐ | Cloud SQL PG 18 private, PITR on, backups 30 days; **restore drill done** (RUNBOOK §9) with measured RTO | Platform engineer | drill notes |
| B ☐ | Secrets created and versioned (no value in state); runtime accounts least-privilege | Platform engineer | IAM review |
| B ☐ | GCS adapter checked against the real bucket: presigned PUT, multipart (≥ 2 parts), signed GET, copy, delete — the GCS/Secret Manager adapters are **UNVERIFIED** until this passes | Platform engineer | smoke script output |
| B ☐ | EMQX on GKE Autopilot with mTLS, gateway certificates issued, public MQTT address in the gateway config | IoT engineer | `kubectl` + gateway log |
| B ☐ | Alerts wired (RUNBOOK §3) and a test alert received | Platform engineer | screenshot |
| ☐ | Cloud Armor / rate limits on public services; `/docs` only from the allow-list | Platform engineer | policy |
| ☐ | Egress NAT IP given to the bank(s) if they allow-list | Finance | email |

## 4. Product acceptance

| | Item | Owner | Evidence |
|---|---|---|---|
| B ☐ | All CI gates green on the release commit (api, web, liff) | Engineering | CI |
| B ☐ | Load test: 300 meters × 15 min × 30 days through ingest + a 300-unit cycle under 60 s (`load.int-spec.ts`) | Engineering | PROGRESS entry |
| B ☐ | UAT script `docs/launch/UAT.md` executed on uat with the pilot owner: install day, first cut-off, first payments, first move-out — every step passed or has an accepted workaround | QA + pilot owner | signed UAT sheet |
| B ☐ | Cross-tenant isolation checked on uat (a second tenant cannot read the pilot's data; support without grant gets 403) | QA | test notes |
| ☐ | Accessibility and Thai copy review of the LIFF bill and pay flow | Design | review notes |

## 5. Operations

| | Item | Owner | Evidence |
|---|---|---|---|
| B ☐ | On-call rota for the first 90 days and escalation numbers (provider, bank, LINE) | Founder | rota |
| B ☐ | Support process: grants requested only with the Owner's approval, read-only (D-090) | Support lead | process doc |
| ☐ | Bi-weekly pilot feedback meeting booked; KPI review date = `kpiReviewAt` (90 days) | Founder | calendar |
| ☐ | First `GET /v1/admin/tenants/{id}/pilot-kpis` snapshot taken on day 1 (baseline vs current) | Founder | KPI snapshot |

## 6. Go / no-go

Decision meeting with Founder, Engineering, Finance, Legal. Record: date, attendees, blocking lines open (must be
none), accepted risks, rollback plan (pilot runs the previous process in parallel for the first billing cycle).

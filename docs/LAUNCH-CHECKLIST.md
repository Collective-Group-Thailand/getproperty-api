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

## 3. Infrastructure (Collective platform, D-230 — `docs/deployment.md`)

| | Item | Owner | Evidence |
|---|---|---|---|
| B ☐ | collective-infra branch `getproperty/r1-platform` reviewed, merged and tagged (`v1` moved or `v2`); `terraform plan/apply` of uat and prod through its CI (`terraform fmt -check` / `validate` were not run in the getproperty sandbox) | Platform engineer | collective-infra PR + CI run |
| B ☐ | Secrets filled: the one product secret `collective/<env>/getproperty/app` and `collective/<env>/platform/device-ca` (D-233, D-235; until T-4 / T-6 / T-7 land: `…/getproperty/{app,web,liff,mqtt-tls}` and `getproperty_mqtt_password` in `platform/postgres`) — no value in git, tfvars or GitHub | Platform engineer | `fetch-secrets.sh getproperty` log (key counts only) |
| B ☐ | `postgres/init/20-getproperty.sh` applied (roles `gp_*`, `getproperty_mqtt`, timescaledb); first `deploy-product.sh getproperty` ran the migrate service: core + app migrations and **the TimescaleDB step `applied`** (UNVERIFIED until then) | Platform engineer | deploy log |
| B ☐ | pgBackRest full + WAL for the cluster (RPO ≤ 5 min); **restore drill done** (RUNBOOK §9) including the getproperty smoke tests and the DSR re-apply step, measured RTO against the 30-min target (D-233) | Platform engineer | drill report in `s3://…-backups/drills/` |
| B ☐ | S3 adapter checked against the real bucket from the box (instance role): presigned PUT from a browser (CORS), multipart (≥ 2 parts), signed GET, copy, delete — same adapter as getpack's, which runs on uat already | Platform engineer | smoke output |
| B ☐ | SES identity verified (DKIM), out of the sandbox, `SES_FROM_ADDRESS` sends an invitation | Platform engineer | message id |
| B ☐ | EMQX 8883 with mutual TLS: broker certificate from the device CA (`pnpm device:broker-cert`), a test gateway connects, publishes its own topics, is **refused** on another gateway's topic; a client without a certificate is refused; with D-235 also: authn / authz answered by getproperty-api's internal endpoints, a retired gateway refused (UNVERIFIED until then) | IoT engineer | gateway log + EMQX log |
| B ☐ | Device host: bootstrap without a certificate works, `/v1/device/*` with the gateway certificate works, without it 401 | IoT engineer | edge log |
| B ☐ | Client IP smoke check (RUNBOOK §11) on uat and prod | Platform engineer | audit rows |
| B ☐ | Alerts wired (RUNBOOK §3) and a test alert received; Grafana shows getproperty api/worker/ingest metrics and traces | Platform engineer | screenshot |
| B ☐ | Memory under the D-233 budget (getproperty ≈ 1.8 GB: api 512M, worker 512M, ingest 192M, web 384M, liff 192M; `docs/deployment.md` §6) on uat under load: no OOM kill during a 300-unit cycle — or the accepted exception of O-015 (worker 1.5 GB with its ADR) | Platform engineer | Grafana panel |
| ☐ | Rate limits on public hosts; `/docs` only from the allow-list; `/metrics` 404 from outside | Platform engineer | curl output |
| ☐ | The box's Elastic IP given to the bank(s) if they allow-list | Finance | email |
| ☐ | Broker certificate renewal (397 days) and device CA expiry in the ops calendar | IoT engineer | calendar |
| B ☐ | Gap tasks marked "before pilot go-live" in `docs/platform-blueprint.md` § Gap tasks (T-1–T-4, T-6–T-11, T-15) closed or accepted by the founder | Engineering + platform engineer | task list |

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

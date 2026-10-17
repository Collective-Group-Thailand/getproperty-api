# Contract requests — triage in getproperty-api

The consumer repositories list what they need in their own `docs/contract-requests.md`
(`getproperty-edge`, `getproperty-web`, `getproperty-liff`); this file records what the API did with each request.
The consumers update their files (and drop their `// CONTRACT-REQUEST` mocks) when they re-sync the contract
(`pnpm gen:api` / `pnpm gen:protocol`). Requests that belong to a later deliverable are implemented when that
deliverable lands. Decisions: D-180 (triage, public surface, named enums, nextActions), D-181 (resident app),
D-182 (device identity).

Commit ids: **A** = `feat(contract): consumer contract requests for B1–B3` · **B3.1–B3.4** = the B3 commits (see
`docs/PROGRESS.md`); the short hashes are filled in below.

## getproperty-edge (`docs/contract-requests.md` CR-001…CR-011)

| # | Request | What the API did | Status |
|---|---|---|---|
| CR-001 | `POST /v1/device/bootstrap` shape | Code-only bootstrap (serial optional, must match when sent); CSR `CN=gw-provisioning` accepted, the CA sets `CN=gw-<id>`; `agentVersion` stored as `firmware_version`, `hardware` accepted; answer adds `gatewayId`, `caChainPem`, `mqtt.wsUrl`, `deviceToken { accessToken, expiresAt }` (token pair kept). A reused code answers **401** `device.provisioning_code_invalid` (the agent treats any 4xx as "new code"). Protocol §1. | done in A |
| CR-002 | `POST /v1/device/token` (mTLS) | Client certificate only (`DEVICE_MTLS_SOURCE` socket \| pem_header \| sha256_header) → `200 { accessToken, expiresAt }`; 401 `device.certificate_invalid` for unknown/revoked/expired/retired. | done in A |
| CR-003 | `POST /v1/device/certificate/renew` | mTLS + bearer, `{ csrPem }` → `{ certificatePem, caChainPem, notAfter }`; the old certificate stays valid until it expires. | done in A |
| CR-004 | `POST /v1/device/logs/presign` | `{ contentType: application/gzip, sizeBytes ≤ 50 MB, sha256 }` → `{ fileId, uploadUrl, method: PUT, headers, expiresAt }`; the bundle is a `core.document` of kind `log_bundle`. | done in A |
| CR-005 | `registerMap = custom` has no map | `MeterConfig.customRegisterMap` (`energy` required; `voltage`/`current`/`power` optional; address, `function`, `dataType`, `wordOrder`, `scale`), present exactly when `registerMap = custom`. The config compiler emits it from `smart.meter_channel.custom_register_map` (B3.1). | done in A (schema) / B3.1 (compiler) |
| CR-006 | ACL for `…/cmd/ack` | Already granted explicitly since B1.3 (`smart.mqtt_acl`: publish `gp/v1/<id>/+` **and** `gp/v1/<id>/cmd/ack`); protocol §1 now says so. | done in A (doc; ACL since B1.3) |
| CR-007 | Quality for a decreasing register | `ReadingQuality.register_decrease`; the cloud stores it as telemetry and sends the candidate to the owner review queue (`decreasing_without_swap`), never to billing as is. | done in A (protocol) / B3.3 (handling) |
| CR-008 | Buffer figure in protocol §4 | Corrected to 864,000 readings (30 × 96 × 300; agent default 1,000,000). | done in A |
| CR-009 | `POST /v1/device/readings/batch` response + idempotency | Same pipeline as MQTT; `200 { accepted, duplicates, rejected[] }`; replays are harmless (dedup `(meterId, seq)`), `Idempotency-Key` optional. | done in B3.2 |
| CR-010 | `DeviceEvent.configVersion` string vs integer | Kept as a string on the wire (documented in protocol §3); the cloud parses it. | done in A (info) |
| CR-011 | OTA manifest (`GET /v1/device/ota/manifest`) | Signed manifest stored per release and served per ring/arch; `ota_apply.args.manifestUrl` points at it. | done in B3.1 |

## getproperty-web (`docs/contract-requests.md`)

| Request | What the API did | Status |
|---|---|---|
| `OperatorMeDto.menu`, `AdminMeDto.menu` as named enums | `OwnerMenuKey`, `StaffMenuKey` (staff `me` = `StaffMeDto`), `AdminMenuKey`; a unit test keeps them equal to `src/core/rbac/menu.ts`. New keys: owner `devices`, staff `reading_rounds`, admin `ota_releases`, `ingest_dead_letters`. Roles: `TenantRole`, `PlatformRole`. | done in A |
| `InvitationCreatedDto.inviteUrl` per role | Staff → `PUBLIC_STAFF_APP_URL/join?code=`; Owner/Manager/Accountant → `PUBLIC_WEB_APP_URL/join?code=`. | done in A |
| `GET /v1/owner/search?q=` | Buildings, units, parties (display name), leases, devices; ≥ 2 chars, ≤ 20 hits, tenant + Staff building scope. Invoices join with B4. | done in A (invoices: B4) |
| `GET /v1/public/plans` | New `/v1/public` surface; projection of `pricing.price_plans` (D-156): `pricePerUnit` or `priceFrom`/`priceTo`, `priceUnit` (`unit_month`, `building_month`, `building_year`, `month`, `report`), `status: proposed`. | done in A |
| `GET /v1/public/utility-tariffs/current` | `{ utility, provider, nameTh, tariffCode, ceilingPerUnit, effectiveFrom, sourceUrl }`; 404 `tariff.not_found` while nothing is published. | done in A |
| `POST /v1/{owner,staff,admin}/telemetry/web-vitals` | Optional auth, 202, route patterns only. | done in A |
| `POST /v1/staff/readings` | Implemented as **`POST /v1/staff/meter-readings`** (the B3.3 prompt path) with `Idempotency-Key`; body `{ assetItemId, readAt, photoDocumentId, typedValue? }` (OCR fills the register when no value is typed); refusals as problems. | done in B3.3 (path per prompt) |
| `nextActions` on editable aggregates | `nextActions: string[]` on units, inspections, invitations, bank accounts, support grants, DSRs, tariff versions (leases and deposits had it); B3 adds it to devices, OTA rollouts and reading reviews. | done in A / B3 |
| Status enums as named components | Already in the contract: `LeaseStatus`, `LeasePartyRole`, `OccupancyRole`, `DocumentKind`, `UserStatus`, `DepositStatus`. B3: `ReadingSource`, `ReadingReviewState`, `MeterHealth`, `DeviceStatus` (+ the other smart enums). | done in A / B3; `InvoiceStatus`, `PaymentStatus` → B4; `ServiceRequestStatus`, `WorkOrderStatus` → B5 |

## getproperty-liff (`docs/contract-requests.md` #1…#6)

| # | Request | What the API did | Status |
|---|---|---|---|
| 1 | `POST /v1/resident/link` | `{ code, via? }` → `200 { tenantId, leaseId, partyId, units[], refreshRequired: true }`; 404 `invitation.not_found`, 409 `invitation.not_pending` / `consent.required` / `invitation.party_mismatch`, 422. The new scopes arrive with the next refresh. Lease invitation links now open `/link?code=`. | done in A |
| 2 | `ResidentMeDto.entitlements` | `ResidentEntitlement[]` (D-181). | done in A |
| 3 | `PATCH /v1/resident/me` language | `{ language: th\|en\|my\|km\|lo\|zh }` → `ResidentMeDto`. | done in A |
| 4 | SMS magic link + default port | Link `PUBLIC_RESIDENT_APP_URL/auth/otp?c=<challengeId>`; default `PUBLIC_RESIDENT_APP_URL=http://localhost:3300`. | done in A |
| 5 | Resident push subscriptions | `POST /v1/resident/push-subscriptions` (optional `Idempotency-Key`), `DELETE …/{id}`. | done in A |
| 6 | Status enums | `LeaseStatus`, `DepositStatus` now; `ReadingSource` with B3; `InvoiceStatus`, `PaymentStatus` with B4; `ServiceRequestStatus`, `WorkOrderStatus`, `ParcelStatus` with B5. | partly done (A, B3); rest deferred to B4/B5 |

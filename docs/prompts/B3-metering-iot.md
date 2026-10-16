# B3 — Metering & IoT: devices, ingest, readings, health, utility loss

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/api-conventions.md`, **`docs/contract/device-protocol.md`**, `docs/schema-design.md` ก่อน · ต้องทำ B1 และ B2.1 เสร็จแล้ว · ทำทีละ Deliverable (3.1 → 3.4) ต่อ 1 session · Plan Mode ทุกครั้ง
> ส่วนที่รันบน gateway อยู่ใน repo `getproperty-edge` — repo นี้ทำฝั่ง cloud เท่านั้น

---

You are a senior backend/IoT engineer on **`getproperty-api`**. Decisions D-012, D-013, D-030–D-035, D-130–D-132 rule here. The billing engine (B4) will read only the `readings` table you build in 3.3.

## Deliverable 3.1 — Device registry, provisioning, config push, OTA (ADR-0005, 0006)
1. Migrations: `devices` (serial, model, kind `gateway | electric_meter | water_meter | lock`, driver, firmware, ownership `platform_haas | org_owned`, org, property, state D-033, certificate fingerprint, last_seen), `device_bindings` (meter device ↔ `meter_point` with `bound_from/to`, bus/address/pin config), `gateway_configs` (version, document jsonb, published_at, applied_at, applied_version from health), `provisioning_codes`, `meter_swaps` (old/new device, last old register, first new register, staff, photos), `ota_releases` (version, artefact, signature, ring), `ota_rollouts`.
2. Admin endpoints (`/v1/admin/devices*`): inventory import (CSV of serials/models), assign to org/property, fleet views (online/offline/degraded per property), OTA releases & rollouts (rings canary → pilot → all), certificate revoke/retire.
3. Staff endpoints (`/v1/staff/devices*`): provisioning by scanning the gateway QR (`POST .../provision` → provisioning code issued), bind a meter device to a meter point with bus/address/pin and the **physical register value at install** (photo required; this becomes the first `reading` with `source: manual`), unbind/swap flow with both register values and photos, "identify" command (LED blink).
4. Config compiler: `GatewayConfig` document per gateway from current bindings (D-131) → published retained on `gp/v1/<gatewayId>/config` through the mqtt integration (fake in tests) → `config_applied` event updates `applied_version`; drift detector job flags gateways whose health reports an older version for > 15 min.
5. Commands: `POST /v1/owner|staff|admin/devices/{id}/commands` (read_now, restart, identify, upload_logs; `ota_apply` admin only), `cmd/ack` consumer, expiry + retries.
6. Acceptance: e2e provision gateway (fake CSR) → bind 2 meters with install readings → config v1 published (snapshot test of the document) → health reports v1 → swap one meter → config v2; org A cannot see org B's devices; platform fleet view counts.

## Deliverable 3.2 — MQTT ingest & telemetry
1. `ingest` process: EMQX shared subscription; validate `TelemetryBatch`/`Health`/`DeviceEvent` against the DTO classes (the same classes export `contract/device-protocol.json`); authorise `(gatewayId, meterId)` against current bindings; dedup on `(meter_id, seq)` with a Redis bloom + DB unique index; write `telemetry_points` (TimescaleDB hypertable, chunk 7 days, compression after 30 days, retention 24 months raw, continuous aggregates `15m/1h/1d` kept 5 years) and `device_health` (latest row per device + hypertable history); emit events `reading.candidate` (per reading with `quality`), `device.online/offline/degraded`, `device.event.*`.
2. HTTPS fallback `POST /v1/device/readings/batch` with the same pipeline; `GET /v1/device/config`; `GET /v1/device/ota/manifest`; `POST /v1/device/logs/presign`.
3. Owner/tenant series endpoints: `GET /v1/owner/meter-points/{id}/series?from&to&bucket`, `GET /v1/tenant/leases/{id}/usage?bucket=1d` (D-063) — from continuous aggregates, never raw billing data.
4. Backpressure: batches > 200 readings rejected with `device.batch_too_large` event; ingest lag metric; dead-letter for invalid payloads with admin replay.
5. Acceptance: integration test with Testcontainers EMQX: publish 1,000 readings across 2 gateways (one duplicates 10 %) → exactly 900 points; a gateway publishing for an unbound meter is rejected and audited; series endpoint returns bucketed usage; health transitions online → offline on LWT.

## Deliverable 3.3 — Readings from every source (the billing source of truth)
1. `readings` (meter_point, device nullable, register `numeric(12,3)`, unit, read_at, source `iot | ocr | manual | estimated`, confidence, quality, evidence file refs, submitted_by, review state `accepted | pending_review | rejected`, previous_reading ref, consumption since previous); unique `(meter_point, read_at, source)`; monotonicity check with overflow handling (meter rollover at 99999.999 or a swap) — a decreasing register without a swap goes to review.
2. `reading.candidate` subscriber (from 3.2): promote IoT candidates with `quality: good` to accepted readings; `estimated_by_gateway` / `clock_suspect` → accepted with lower confidence and flagged; the billing cut-off selector (B4.2) will prefer the highest-confidence reading inside the window.
3. Staff OCR/manual readings (D-035): `POST /v1/staff/readings` (meter point, photo, optional typed value) → OCR adapter (vision model, fake returns the typed value in tests) → plausibility band vs trailing consumption (setting per utility, default ±60 %) and monotonicity → accepted or `pending_review` with the photo; owner review queue `GET/POST /v1/owner/readings/review*` (accept, correct with reason, reject); org setting `readings.require_photo`.
4. Reading rounds: `GET /v1/staff/reading-rounds/current` lists meter points that still need a reading before the cut-off (no IoT, or IoT stale), grouped by floor, with the last reading and photo thumbnail — the staff PWA's main screen for Lite buildings.
5. Owner views: meter point history with source badges and photos; export CSV.
6. Acceptance: property tests (monotonic series, rollover, swap); e2e manual reading accepted / out of band → review → corrected; IoT candidate promoted; reading round shrinks as readings arrive; cross-org 404s.

## Deliverable 3.4 — Meter health, utility invoices & loss
1. Health rules (D-034) as org-overridable settings: `stale_after` per utility, `silent_after`, gateway offline after 5 missed heartbeats; worker job every 5 min computes `meter_point.health` (`ok | stale | silent | no_device`) and emits `meter.stale/silent` → notifications to owner & staff, and `maintenance.auto_ticket_requested` (consumed in B5; until then logged).
2. `utility_invoices` (D-032): owner enters the MEA/PEA/MWA/PWA invoice per property per period (period, units, amount, photo; OCR adapter prefill), or imports from the utility's e-bill PDF; `loss_reports` computed per property per billing cycle after bills are issued (B4): `invoice_units − Σ tenant_billed_units − Σ common_area_units` in units and THB at the tariff, loss %, trend, suspects: zero-consumption occupied rooms, consumption in vacant rooms, meters with `estimated` readings, night-time water flow (from `15m` aggregates), meters whose consumption changed > 2σ.
3. Endpoints `/v1/owner/properties/{id}/utility-invoices*`, `/v1/owner/properties/{id}/loss?cycle=`; dashboard widget data (B6 reads it).
4. Acceptance: golden test of a loss report from a fixture building (12 rooms, 1 vacant with usage, 1 stale meter); e2e enter invoice → loss report after bills exist (use B4 fixtures or a stubbed billed-units provider until B4.2 lands — mark in PROGRESS).

After each deliverable: `docs/PROGRESS.md`, both contracts regenerated, commit, and tell `getproperty-edge` when `device-protocol.json` changed.

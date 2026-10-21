# ADR-0014 — Telemetry storage on the platform: platform-only compressed raw points, 15-minute series from raw, RLS rollups

**Status:** Accepted (2026-10-22; founder decision O-014 resolved as recommended → D-241)
**Decision ids:** D-234, D-241, D-184 (amended), D-162, D-030 · blueprint T-12, T-13, T-14, A-2, A-3 · related: ADR-0001

## Context
At the Phase 4 KPI (10,000 devices) getproperty's IoT tables would hold ≈ 485 GB after one year as built (blueprint
§ Infrastructure asks). Three things dominated: (1) raw points uncompressed — TimescaleDB native compression is not
available on a hypertable with row-level security; (2) `smart.telemetry_15m` held **one row per raw point** at 15-minute
polling (a duplicate of `telemetry_point`, ≈ 280 B per point) and kept it 5 years; (3) every 60-s gateway heartbeat
stored the full `meters[]` array (≈ 18 KB per sample at 300 meters). Continuous aggregates cannot carry RLS either, so
"just use caggs" would have opened a cross-tenant read path.

## Decision
1. **Raw points are platform-only** (T-12). `smart.telemetry_point` has never been granted to `gp_app` / `gp_reporting`
   (0016; re-asserted by 0039): ingest writes and the rollup job reads it as `gp_platform`. The optional TimescaleDB
   step 2 (`prisma/optional/timescale/002_telemetry_compression.sql`, applied by the migrate command after step 1)
   drops its RLS and enables compression after 30 days (`segmentby asset_item_id`, `orderby time DESC, seq DESC`).
   Without TimescaleDB (tests, plain PostgreSQL) the native monthly partitions stay; nothing above the database changes.
2. **No stored 15-minute rollup** (T-14). `smart.telemetry_15m` is dropped. 15-minute series are computed from raw points
   on read by `smart.telemetry_15m_series(asset_item_ids, from, to)` — SECURITY DEFINER owned by `gp_platform`, applying
   the **same visibility as the former table's read policy** (the row's tenant, or a building granted for
   `smart.metering`) — and, for platform reads that proved access themselves (a resident's own lease) or cross-tenant
   jobs, `smart.telemetry_15m_rows(…)` (EXECUTE for `gp_platform` only). Usage per bucket keeps the former rule (last
   register − last register of the previous bucket, rollover-aware). A request is still limited to 3,000 buckets
   (31 days). The hourly rollup is folded from raw points directly; `_1h` / `_1d` stay tables **with RLS** — the API's
   tenant-safe read path for anything longer than raw retention.
3. **Retention (O-014 → D-241)**: raw 24 months — and therefore 15-minute series 24 months, like raw points —; hourly
   and daily rollups 5 years; health samples 6 months; dedup marks 90 days (`telemetry.retention`).
4. **Slim health samples** (T-13): `device_health_sample` drops `meters`; the per-meter state lives in
   `device_health_latest.meters` (and `smart.meter_status`), each change of a meter's status is one `device_event`
   `meter_status_changed` (from, to, lastReadAt).
5. **DB-box trigger (O-014 → D-241)**: getproperty's database > 100 GB **or** the box's `/data` > 70 % → plan the move
   to a separate DB box (locked decision 2) within one quarter; Grafana alert on both (collective-infra).

## Consequences
- + Planned volume after one year at 10,000 devices: ≈ 142 GB → lower still, as the 15-minute duplicate (≈ 30 % of the
  "after T-12–T-14" figure) is gone entirely; pilot ≈ 4 GB/year.
- + Tenant isolation is unchanged and tested: another tenant's context gets no rows from the function; `gp_app` cannot
  read raw points or call the platform function (`test/integration/smart-metering.int-spec.ts`).
- − D-184's "the API never reads raw points" is amended: the API reads raw points **only** through the tenant-checking
  function, never billing (D-030 unchanged — billing reads `smart.meter_reading`).
- − 15-minute reads over compressed chunks (> 30 days) decompress the segment of each meter read — acceptable for a
  31-day window per request; **UNVERIFIED** on a live TimescaleDB until the first UAT deploy, like the compression ratio.

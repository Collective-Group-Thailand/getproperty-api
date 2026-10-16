# ADR-0001 — PostgreSQL 18 + TimescaleDB

**Status:** Accepted (2026-10-16, B1.1)
**Decision ids:** D-002, D-004, D-030, D-032, D-034, D-040, D-046 · master plan §3, §5

## Context
getproperty stores two very different kinds of data under one roof:
- **Business records** — orgs, properties, rooms, leases, deposits, bills, receipts, payments, settings, audit. Relational, transactional, `org_id` on every row (D-004), immutable financial documents with gapless numbering (D-040), money as `numeric(14,2)` (D-046).
- **Telemetry** — interval readings from meters every 15 minutes (electric and water), gateway heartbeats every 60 s. A 300-room building produces ~30 k rows a day; the pilot fleet is small, but the insight features (utility loss, D-032; stale/silent rules, D-034; R2 daily usage and anomalies) query it by time bucket.

D-030 keeps the two apart in meaning: bills come only from `readings` (one accepted cumulative register reading per meter per cut-off), never from summed telemetry. Lost telemetry must never produce a wrong bill.

## Decision
- **PostgreSQL 18** is the single database of record; **TimescaleDB** (extension, image `timescale/timescaledb-ha:pg18`) hosts the time-series tables in the same cluster.
- `readings` is a normal table (billing source of truth, FKs, check constraints, evidence columns). `telemetry_points` (and later `gateway_health`) are **hypertables** chunked by time with continuous aggregates `15m`, `1h`, `1d` for the series endpoints (`?from&to&bucket`), compression after 7 days and a retention policy per setting (B3.2).
- Prisma (current major) owns the relational schema and migrations; hypertables, continuous aggregates, compression and retention policies are created in **raw SQL migrations** alongside, because Prisma does not model them.
- Extensions enabled in `0001_extensions` (B1.2): `timescaledb`, `pgcrypto`, `pg_trgm`, `citext`.
- Local development (`docker-compose.yml`), Testcontainers and production run the **same image** so behaviour never differs by environment. `DATA_STORES_MODE=fake` (B1.1) keeps the processes bootable without any database — for unit/e2e tests, the contract build and laptops without Docker — but the fake never replaces an integration test: the `e2e-real` CI job runs the suites against the real image.
- Connection handling: `pg` pool for health probes and raw SQL; Prisma over the `pg` driver adapter from B1.2; `withTx` wraps every state change with its audit row and outbox event in one transaction.

## Alternatives considered
- **Separate time-series store (InfluxDB, ClickHouse):** one more system to operate, back up and secure, and cross-store joins (meter ↔ room ↔ lease) for the loss report. Rejected for R1–R2; revisit above ~10 k meters.
- **Plain PostgreSQL partitioning:** workable, but continuous aggregates, compression and retention are exactly what the insight features need and would be re-implemented by hand.
- **MySQL / managed NoSQL:** no `numeric` discipline, weaker constraints, no row-level security for the reporting role.

## Consequences
- One backup/restore story, one tenancy model (`org_id` + RLS as a second line for the reporting role).
- Managed hosting must offer the TimescaleDB extension (Timescale Cloud, or self-managed on a VM); plain RDS does not — noted as an infrastructure constraint for the launch runbook (B6.5).
- Series queries go through the aggregates only; raw `telemetry_points` is never read by an API endpoint.

# ADR-0004 — Effective-dated configuration & platform tariffs

**Status:** Accepted (2026-10-16, B1.1) — implemented in B1.2 (schema) and B1.3 (services)
**Decision ids:** D-020, D-021, D-022, D-023, D-031, D-034, D-040, D-045, D-080, D-082 · CLAUDE.md hard rules · master plan §5

> **Amendment (D-021a, D-151, ADR-0009, 2026-10-17).** v2 names: `settings`/`setting_versions` → `platform.setting`/`platform.setting_version`; `org_settings` → `platform.tenant_setting_version`; property overrides → `platform.property_setting_version`; `tariffs`/`tariff_versions` → `platform.utility_tariff`/`platform.utility_tariff_version` (the สคบ. cap reference). Tenants set their own rates as effective-dated `ops.rate_plan` + `ops.rate_plan_version` (tiers jsonb, D-151); a rate above the utility's effective average rate is a **warning with acknowledgement** (`platform.compliance_acknowledgement`), not a refusal, unless the platform admin set severity `block` (D-021a supersedes the "refuses any bill line above the cap" sentence below). Price plans follow D-156 (supersedes D-080).

## Context
Almost every number getproperty applies is a business or legal value that changes over time and must be provable afterwards: the utility tariffs (MEA/PEA electricity with Ft and service charge, MWA/PWA water) that cap what an org may bill (D-021); the deposit cap and refund timeline (D-023); billing cut-off, reading windows and estimate policy (D-031); stale/silent thresholds (D-034); reminder schedules and late-fee permission (D-045); price plans and trial length (D-080, D-082); token and OTP policies (ADR-0003). A bill issued in November must be explainable with the values that were in force in November even if they changed in December (D-040), and a สคบ. dispute may ask for exactly that.

## Decision
- **No business value is a constant in code.** Every configurable value a decision names is a **setting**: typed, with `effective_from`, versioned (a change inserts a new row, never updates in place), audited (who, when, why), and editable only by the role the decision names. A code comment cites the decision id where the setting is read.
- **Three scopes:** `settings` (platform-wide, Platform admin), `org_settings` (per org: billing cut-off, estimate policy, reminder schedule, late fee on/off, `payments.allow_slip`, company data for documents — Owner, some by Manager), and per-property overrides where a decision says so (`billing_cycle`, D-031). Resolution is property → org → platform, always **as of a date**: `settings.at(key, date)`.
- **Platform tariffs are first-class, not settings:** `tariffs` + `tariff_versions` (utility, region, structure — tiers or flat, Ft, service charge, VAT handling — `effective_from`, source document URL and date, `verified_by`). The Platform admin publishes a version when a utility changes its rates; an org may configure *lower* rates, and the compliance engine refuses any bill line above the cap in force on the reading date (`compliance.tariff_cap`, with the legal reference). `GET /v1/owner/tariffs/current?utility=&region=` returns the structure and the **cap per unit**.
- **Snapshots on documents:** a bill stores the tariff version id and the resolved settings it used (`jsonb` snapshot) together with the readings and lease lines (D-040, D-022). Corrections are credit/debit notes, never edits.
- **Cache with invalidation:** settings and tariffs are read on every bill computation, so each process keeps a short-TTL cache invalidated through `InvalidationBus` (in-process in B1.1; Redis pub/sub fan-out between replicas in B1.3).
- **Future-dated changes are allowed, backdating is not** (`settings.backdated`): a change takes effect at a chosen future date or now; what already happened keeps its snapshot.
- **Environment variables are infrastructure only** (`src/config/env.schema.ts`: URLs, modes, ports, secrets). If a value would change a bill, a deadline or a permission, it is a setting.

## Alternatives considered
- **Constants / `.env` for tariffs:** a tariff change would be a deployment, and yesterday's bills could not be explained. Rejected by D-021 and D-040.
- **A single mutable `settings` row per key:** no history, no proof for disputes, no scheduled changes.
- **Per-org tariff tables:** owners would enter their own rates — the very overcharging the product exists to remove (D-021). Tariffs stay platform-maintained; orgs may only go lower.

## Consequences
- B1.2 designs `settings` + `setting_versions`, `org_settings` + versions, `tariffs` + `tariff_versions`, `feature_flags`, and the seed lists every decision value with its decision id in the description (billing cut-off default, reading window ±2 h, stale/silent thresholds, deposit cap months ⚖, reminder schedule 1/3/7, late fee off, estimate policy, trial 30 days, price plans as proposed) and the current MEA/PEA/MWA/PWA residential tariffs with source URLs, `verified_by` empty until confirmed.
- B1.3 implements the typed accessors, admin/owner endpoints, audit and cache; B4.1's compliance engine reads caps only through the tariff service **as of the reading date**.
- Golden tests of the billing engine are keyed by tariff version (master plan §7).

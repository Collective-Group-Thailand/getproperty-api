# ADR-0007 — Compliance rule engine

**Status:** Accepted (2026-10-17, B4.1) — founder pre-approved recommendation (D-189)
**Decision ids:** D-020–D-025, D-021a, D-140, D-141, D-149, D-157, D-158 · legal-reference.md · CLAUDE.md "Compliance before convenience"

## Context
The สคบ. 2568 residential-rental announcement (D-020) is the product's reason to exist: an owner who bills through getproperty must not be able to break it by accident, and must be able to prove later what the platform checked and what the owner acknowledged. The rules touch every A1/A2 module — leases (deposit cap, forbidden clauses, notices), rate plans and invoices (utility cap, disclosure, lead time, water minimum, late fees), deposits (evidence, wear, forfeiture, the 7-day deadline) and collections (no cut-off). The founder decided (D-021a) that the utility cap is a **warning the Owner acknowledges**, not a refusal, unless the platform admin sets `block`; other rules are refusals by nature. B2 already used a `ComplianceGate` and per-module checks; B4 needs one registry, one semantics and one report.

## Decision
- **Registry in code** (`src/core/compliance/rules.ts`), mirrored into `platform.compliance_rule` by the seed (code is the truth; `status = pending_legal_verification` until the legal team verifies legal-reference.md, D-149). Each rule has an `id` (`compliance.*`, also its problem code), a `legalRef` (clauses of legal-reference.md), a `defaultSeverity` (`block | warn`), `appliesTo` (tenant, lease, rate_plan, invoice, deposit, access, notice), the settings it reads, and a **pure `evaluate(context)`** (`evaluators.ts`) returning a `RuleCheck`: violated or not, the values compared (evidence), field errors for a refusal, and what a warning shows. Modules gather the context (settings in force, the utility tariff version, readings) and never re-implement a rule.
- **One semantics** (`outcomeOf`, `ComplianceGate.enforce`): not violated → pass; violated + `block` → **422 `compliance.<rule>`** with `legalRef`, `ruleId` and field errors; violated + `warn` → **409 `compliance.acknowledgement_required`** with the evaluation id, the legal text key/version and the values shown; the Owner acknowledges (`POST /v1/owner/compliance-acknowledgements` → `platform.compliance_acknowledgement`: who, when, IP, user agent, values shown, text version) and repeats the request with the acknowledgement id. Actors that cannot acknowledge (residents, jobs) get warnings as refusals (`refuseWarnings`). Every warn/block outcome is a `platform.compliance_evaluation` row written in its own transaction, so refusals stay on record.
- **Severity is configuration, not code** (D-021a): `<rule>.severity` where the catalogue has a dedicated setting (`compliance.tariff_cap.severity`), else the platform admin's `compliance.severity_overrides` map (platform version or a tenant version written by the platform), else the registry default.
- **Scope** (D-158): rules apply while `tenant.subject_to_ocpb_2568` is true (default; ≥ 3 units); `compliance.scope` flags a tenant renting ≥ 3 units whose setting says otherwise.
- **Documentation**: `@ApiCompliance(...)` lists the rules an operation can raise (`x-compliance-rules` in the contract, problem examples with `legalRef`); `pnpm compliance:report` writes `docs/compliance.md` (rule, legal reference, severity, subjects, settings, covered operations) and a unit test keeps it fresh.
- **Score**: `platform.compliance_score` per tenant × month (invoices within the utility rate, above-cap lines acknowledged, deposits refunded on time, leases on the standard template; D-190), computed nightly and on request, shown on the owner dashboard and used by B6 analytics.

## Alternatives considered
- **Rules as database rows with an expression language**: editable without a deploy, but legal rules need tests and code review more than speed; the DB mirror keeps verification status and the admin overrides the severity.
- **Block everything**: superseded by D-021a for the utility cap; owners remain the liable party and need a documented path.
- **Checks spread across modules (B2 state)**: kept as thin wrappers over the registry evaluators so behaviour did not change.

## Consequences
- Adding a rule = registry entry + evaluator + fixtures in `rules.spec.ts` (pass, warning, refusal) + problem code + `pnpm compliance:report`.
- ⚖ The legal team still verifies legal-reference.md and the warning wording (D-149); until then every rule reports `pending_legal_verification` in the admin view.

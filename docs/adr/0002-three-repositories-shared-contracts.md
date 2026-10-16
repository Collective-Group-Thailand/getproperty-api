# ADR-0002 — Three repositories and the shared contracts

**Status:** Accepted (2026-10-16, B1.1)
**Decision ids:** D-002, D-003, D-013, D-130 · contract: `docs/contract/api-conventions.md` §1, §5, §7; `docs/contract/device-protocol.md`

> **Amendment (D-153, D-154; ADR-0009/0010, 2026-10-17).** The product now has four application repositories plus one shared package: `getproperty-api`, `getproperty-web` (owner console, staff PWA, platform admin), **`getproperty-liff`** (LINE Mini App for residents, technicians and landlords — consumes `contract/openapi.json` like the web), `getproperty-edge`, and the package **`collective-asset-core`** (the `core` schema, its migrations and the integration event contracts). Surfaces are `/v1/auth`, `/v1/owner`, `/v1/staff`, `/v1/resident` (was `/v1/tenant`), `/v1/technician`, `/v1/admin`, `/v1/device`, `/webhooks`. The rest of this ADR stands.

## Context
getproperty has three deployables with different lifecycles and runtimes: the backend (NestJS, three processes), the web app (one Next.js app with owner / tenant / staff / admin zones and a BFF) and the gateway agent (a Node binary on Linux ARM64 inside each building, updated by OTA rings). They are built by the same small team but released at different cadences: a gateway fleet cannot be redeployed with every API change, and the web app must be able to work ahead of the backend.

## Decision
- **Three repositories**: `getproperty-api` (this repo), `getproperty-web`, `getproperty-edge`. No shared code between them; getpack is a *conventions* reference only (D-003).
- **Two published contracts, both owned by the backend and generated from code:**
  1. `contract/openapi.json` — OpenAPI 3.1, written by `pnpm contract:build` from the Nest controllers and DTOs (`@nestjs/swagger`), linted by `pnpm contract:lint` (Spectral ruleset, contract §5), committed, drift-checked in CI, diffed with `oasdiff breaking` against the base branch, attached to every `vX.Y.Z` release. The web generates its types from it (`openapi-typescript`) and can mock against it (MSW).
  2. `contract/device-protocol.json` — JSON Schema draft 2020-12 of every MQTT payload (`TelemetryBatch`, `Reading`, `Health`, `MeterHealth`, `DeviceEvent`, `GatewayConfig`, `BusConfig`, `MeterConfig`, `Command`, `CommandAck`), generated from the **same class-validator DTO classes the ingest process validates with**, so the edge agent and the cloud can never disagree on a payload. Attached to releases; `getproperty-edge` generates its types from it.
- **Shared documents by copy, not by package**: `docs/contract/api-conventions.md`, `docs/contract/device-protocol.md` and `docs/decisions.md` are identical files in all three repos, changed by a same-day PR to each.
- **Surfaces as the unit of compatibility** (contract §2): `/v1/auth`, `/v1/owner`, `/v1/tenant`, `/v1/staff`, `/v1/admin`, `/v1/device`, `/webhooks`. A breaking change gets a new prefix for the affected surface only (`/v2/owner/...`); `/v1` stays until every consumer has moved. Operation ids and tags are surface-prefixed so generated clients stay navigable.
- **Documentation is enforced, not reviewed**: every operation needs an operationId, summary, description with the decision id, security, the full status-code set with problem examples and examples on every body; Spectral fails CI otherwise. Scalar (`/docs`), Swagger UI (`/docs/swagger`) and the raw document (`/docs-json`, `/docs.yaml`) serve the same document; gated by `DOCS_ENABLED` + CIDR allow-list outside development (platform-token access in B1.3).

## Alternatives considered
- **Monorepo** with workspace packages for shared types: tighter coupling between a fleet of gateways and the web release train, one CI for three very different test stacks (Testcontainers, Playwright, hardware-in-the-loop). Rejected for now; the contracts give the same type safety.
- **Hand-written OpenAPI** as the source and generated server stubs: drifts from the code the moment someone edits a DTO. Generation from code with lint gates keeps a single source of truth.
- **Protobuf / MQTT binary payloads** for the device protocol: smaller on the wire, but JSON with schemas is debuggable from a building with `mosquitto_sub`, and the volumes (≤ 200 readings per batch every 15 min) do not need it. Revisit if LTE data cost becomes an issue.

## Consequences
- `pnpm contract:build` and `pnpm contract:lint` run on every endpoint or payload change, and the generated files are committed in the same commit (CLAUDE.md hard rule).
- The device protocol document is **normative**: a payload change is a protocol version decision (`gp/v1/...` → `gp/v2/...` when breaking) coordinated with an edge release and OTA ring.
- The B1.1 placeholder operations (`GET /v1/{surface}/ping`, `GET /v1/admin/system/info`) exist so the pipeline is exercised from day one; they stay as cheap liveness checks per surface.

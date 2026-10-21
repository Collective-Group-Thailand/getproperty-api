# ADRs — getproperty-api
| # | Title | Status |
|---|---|---|
| 0001 | [PostgreSQL 18 + TimescaleDB](0001-postgresql-timescaledb.md) | Accepted (B1.1); **Amended 2026-10-21** (D-234) |
| 0002 | [Three repositories and the shared contracts](0002-three-repositories-shared-contracts.md) | Accepted (B1.1; repo list extended by ADR-0010 / D-154) |
| 0003 | [Auth audiences & tokens (operator, resident, technician, platform, device)](0003-auth-audiences-and-tokens.md) | Accepted (B1.1); amended by 0009; implemented in B1.3 |
| 0004 | [Effective-dated configuration & platform tariffs](0004-effective-dated-configuration-and-tariffs.md) | Accepted (B1.1; implemented in B1.2/B1.3) |
| 0005 | Readings vs telemetry (cumulative-register billing) | B3.1 |
| 0006 | MQTT device protocol & store-and-forward | B3.1 |
| 0007 | [Compliance rule engine](0007-compliance-rule-engine.md) | Accepted (B4.1, D-189) |
| 0008 | [Payment adapters and the no-funds-held model](0008-payment-adapters-no-funds-held.md) | Accepted (B4.1; implemented in B4.4, D-197) |
| 0009 | [Platform blueprint: tenant types, neutral asset core, schemas](0009-platform-blueprint-tenant-types-asset-core-schemas.md) | Accepted (schema lock) |
| 0010 | [`collective-asset-core` as a separate package](0010-collective-asset-core-separate-package.md) | Accepted (schema lock); **Amended 2026-10-21** (D-238) |
| 0011 | [Prisma with a package-owned schema (`core` from `@collective/asset-core`)](0011-prisma-with-a-package-owned-schema.md) | Accepted (B1.2 step 2b) |
| 0012 | [PDF rendering: the shared `pdf-render` queue, own Chromium as a time-boxed interim](0012-pdf-rendering-queue-and-interim-chromium.md) | Accepted (2026-10-22, D-242) |
| 0013 | [The migrate command is `node dist/src/migrate.js`](0013-migrate-command-node-dist-migrate.md) | Accepted (2026-10-22, T-3, D-246) |
| 0014 | [Telemetry storage: platform-only compressed raw points, 15-minute series from raw, RLS rollups](0014-telemetry-storage-platform-only-raw-and-15-minute-reads.md) | Accepted (2026-10-22, D-241) |
| 0015 | [Gateways on the shared EMQX: HTTP authn/authz, device JWT as MQTT password, per-gateway WSS fallback](0015-emqx-http-authn-authz-and-wss-fallback.md) | Accepted (2026-10-22, D-239, D-244) |

# getproperty-api

NestJS 12 backend of **getproperty** — Collective Group's Building Operations platform (D-150). Start with
`CLAUDE.md` (rules and vocabulary), `docs/decisions.md`, `docs/schema-design.md` (v2) and `docs/PROGRESS.md`.

## Quick start
```bash
pnpm i                 # also generates the Prisma client (src/generated/prisma)
pnpm dev               # API on :3000 with DATA_STORES_MODE=fake (no database needed)
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:e2e
pnpm contract:build && pnpm contract:lint && pnpm build
```
The package `@collective/asset-core` (schema `core`, migrations, contracts) is consumed from the sibling checkout
`../collective-asset-core` (`link:` dependency, ADR-0011); build it once with `pnpm i && pnpm build` there. CI checks
it out at the pinned tag; once the private registry exists the dependency becomes a normal version.

## Database
PostgreSQL 18 (ADR-0001 as amended by D-162). Schemas: `core` (owned by `@collective/asset-core`), `platform`,
`ops`, `smart`, `bridge`, `juristic`. Row-level security on every table; the application runs as `gp_app`.

| Command | What |
|---|---|
| `pnpm db:migrate` | `asset-core migrate` (schema `core`, roles, helper functions) then `prisma migrate deploy` (this repo) |
| `pnpm db:migrate:deploy` | the image's migrate command (`node dist/src/migrate.js`, after `pnpm build`): asset-core, then `prisma/migrations` without the Prisma CLI, then the optional TimescaleDB step (D-162, D-230) |
| `pnpm db:diff` | `prisma migrate diff` between the database and `prisma/schema` — must be empty |
| `pnpm db:seed` / `pnpm db:seed:dev` | reference data (roles, permissions, settings, compliance rules, utility tariffs, holidays, consents, templates, retention) / + the development tenant "หอพักตัวอย่าง" — idempotent |
| `pnpm prisma:core` | regenerate `prisma/schema/core.prisma` from the package (after changing a relation to a core model or bumping the package) |
| `pnpm rbac:build` | regenerate `docs/rbac.md` from `src/core/rbac/catalogue.ts` |
| `EMBEDDED_PG=1 pnpm test:int` | integration suite on an embedded PostgreSQL 18 (migrations, drift, seeds, RLS, append-only, settings, idempotency, tariffs) |

### Local database without Docker
```bash
pnpm db:local            # embedded PostgreSQL 18 on 127.0.0.1:55432 (foreground; Ctrl-C stops it)
                         # prints DATABASE_URL / SHADOW_DATABASE_URL — put them in .env with DATABASE_APP_ROLE=gp_app
pnpm db:migrate          # in a second shell
pnpm db:seed:dev
DATA_STORES_MODE=real pnpm dev   # Redis and the MQTT broker are still needed in real mode (docker compose or fakes)
```
- PostgreSQL refuses to run as root: when the shell is root, the cluster runs as the OS user `postgres`
  (`LOCAL_PG_OS_USER`) and the data directory's parent must belong to it (`LOCAL_PG_DIR`, default `.local/pg/data`).
- The embedded build has pgcrypto, citext, btree_gist and pg_trgm — everything the migrations need — but no
  TimescaleDB, which is optional since D-162.
- `prisma migrate deploy/diff` need Prisma's native schema engine (downloaded from binaries.prisma.sh on first
  use). Where that host is blocked, `pnpm i`/`pnpm prisma:generate` still work (WebAssembly) and
  `EMBEDDED_PG=1 pnpm test:int` applies the migrations with its own runner; see ADR-0011.
- Docker users: `docker compose up -d` (PostgreSQL, Redis, EMQX, LocalStack, Mailpit) and the same `db:*` commands.

## Deployment
getproperty runs on **Collective's shared AWS platform** like getpack (D-230): one EC2 box per environment in
`ap-southeast-7` running docker compose (Caddy, PostgreSQL 18 + TimescaleDB, Valkey, EMQX, Grafana Alloy), S3, SES,
Secrets Manager and ECR per product. Infrastructure lives only in **collective-infra**; this repo ships the image and
`.github/workflows/deploy.yml` (main → uat, tag → production). What getproperty needs from the platform — image
contract (`main` / `worker` / `ingest` / `migrate`, `/health` + `/metrics` on 3000 / 3001 / 3002), secrets, hosts, MQTT
mutual TLS (`pnpm device:broker-cert`), sizing — is in `docs/deployment.md`; operations in `docs/RUNBOOK.md`.

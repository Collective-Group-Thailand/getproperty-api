# syntax=docker/dockerfile:1.7
# One image, four commands (master plan §2; Collective platform image contract, docs/deployment.md):
#   node dist/src/main.js     API            :3000  /health, /metrics            (default)
#   node dist/src/worker.js   BullMQ worker  :3001  /health, /metrics            (WORKER_HEALTH_PORT)
#   node dist/src/ingest.js   MQTT ingest    :3002  /health, /metrics            (INGEST_HEALTH_PORT)
#   node dist/src/migrate.js  one-shot: @collective/asset-core migrations, then prisma/migrations, then the optional
#                             TimescaleDB step where the extension exists (D-162, D-230)
# `PROCESS=main|worker|ingest|migrate` selects one when no command is given. Built natively for linux/arm64 on the
# Collective platform (t4g, Graviton) and for amd64 in CI. Debian slim (not Alpine): Chromium + Thai fonts for the
# server-side PDFs (Debian ships chromium for arm64 and amd64).

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# --- @collective/asset-core: until the package is published to GitHub Packages the app depends on the sibling
#     checkout (`link:../collective-asset-core`, ADR-0011). Pass its source as a named build context; it is built
#     here, so a fresh clone is enough:
#       docker build --build-context asset-core-src=../collective-asset-core .
FROM base AS asset-core-build
WORKDIR /collective-asset-core
COPY --from=asset-core-src package.json pnpm-lock.yaml tsconfig.json tsconfig.esm.json tsconfig.cjs.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
COPY --from=asset-core-src src ./src
COPY --from=asset-core-src scripts ./scripts
COPY --from=asset-core-src migrations ./migrations
COPY --from=asset-core-src prisma ./prisma
COPY --from=asset-core-src schemas ./schemas
RUN pnpm build

#     Runtime-only dependencies of the package (pg, zod) + its build output.
FROM base AS asset-core
WORKDIR /collective-asset-core
COPY --from=asset-core-src package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=asset-core-build /collective-asset-core/dist ./dist
COPY --from=asset-core-build /collective-asset-core/migrations ./migrations
COPY --from=asset-core-build /collective-asset-core/prisma ./prisma

# --- build: full install, generate the Prisma client, compile -------------------------------------------
FROM base AS build
COPY --from=asset-core /collective-asset-core /collective-asset-core
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm prisma:generate && pnpm build

# --- prod-deps: runtime dependencies only --------------------------------------------------------------
FROM base AS prod-deps
COPY --from=asset-core /collective-asset-core /collective-asset-core
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts

# --- runtime -----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# Chromium renders the PDFs (puppeteer-core drives the system binary); the documents embed Sarabun as data URLs,
# Thai TLWG + Noto fonts are the fallback for any glyph outside it. tzdata: TZ=Asia/Bangkok for log timestamps
# (business rules use Asia/Bangkok explicitly either way).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates tzdata chromium fonts-thai-tlwg fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
ARG GIT_COMMIT=
ENV NODE_ENV=production PROCESS=main GIT_COMMIT=${GIT_COMMIT} TZ=Asia/Bangkok \
    PDF_RENDERER_MODE=real PDF_CHROMIUM_EXECUTABLE=/usr/bin/chromium
WORKDIR /app
COPY --from=asset-core --chown=node:node /collective-asset-core /collective-asset-core
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
# SQL migrations applied by dist/src/migrate.js (the image has no Prisma CLI; the runner keeps `_prisma_migrations`
# exactly as `prisma migrate deploy` does, so either tool can follow the other).
COPY --from=build --chown=node:node /app/prisma/migrations ./prisma/migrations
COPY --from=build --chown=node:node /app/prisma/optional ./prisma/optional
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh
USER node
EXPOSE 3000 3001 3002
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

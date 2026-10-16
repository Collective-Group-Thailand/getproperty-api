# syntax=docker/dockerfile:1.7
# One image, three processes (master plan §2): PROCESS=main (default) | worker | ingest.
# Debian slim (not Alpine): Chromium + Thai fonts for server-side PDFs are added in B4.3 (documents).

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# --- @collective/asset-core: until the private registry exists the app depends on the sibling checkout
#     (`link:../collective-asset-core`, ADR-0011). Pass it as a named build context (built beforehand: dist/):
#       docker build --build-context asset-core-src=../collective-asset-core .
#     Runtime-only dependencies of the package (pg, zod) are installed here.
FROM base AS asset-core
WORKDIR /collective-asset-core
COPY --from=asset-core-src package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=asset-core-src dist ./dist
COPY --from=asset-core-src migrations ./migrations
COPY --from=asset-core-src prisma ./prisma

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
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG GIT_COMMIT=
ENV NODE_ENV=production PROCESS=main GIT_COMMIT=${GIT_COMMIT}
WORKDIR /app
COPY --from=asset-core --chown=node:node /collective-asset-core /collective-asset-core
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

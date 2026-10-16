# syntax=docker/dockerfile:1.7
# One image, three processes (master plan §2): PROCESS=main (default) | worker | ingest.
# Debian slim (not Alpine): Chromium + Thai fonts for server-side PDFs are added in B4.3 (documents).

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# --- build: full install, compile ------------------------------------------------------------------
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# --- prod-deps: runtime dependencies only --------------------------------------------------------------
FROM base AS prod-deps
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
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node docker/entrypoint.sh /app/entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

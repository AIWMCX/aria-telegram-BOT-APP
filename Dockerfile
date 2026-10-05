# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — aria-engine packaging (hosted PAPER engine, Task 7)
#
# WHY THIS STAGE EXISTS: before it, nothing put any `aria-engine` code into
# this container at all. `FleetManager` spawned
# `node --import tsx src/cli.ts paper start` with cwd = CONFIG.ARIA_ENGINE_REPO_PATH,
# whose default is the DEV-MACHINE sibling checkout `../aria-engine`. The
# final stage below COPYs only package.json/tsconfig.json/src/public/scripts/
# migrations — never aria-engine — so that path does not exist in the image
# and every hosted `/paper_start` would have failed at spawn. `/healthz`
# reported `engineSha: null` honestly for exactly this reason.
#
# The engine is fetched here, at an EXACT 40-char commit SHA, at IMAGE BUILD
# TIME. Never a runtime clone, never a branch name, never "latest". Given
# (control-plane SHA A, ARIA_ENGINE_COMMIT_SHA B), rebuilding reproduces the
# same combination: the clone is pinned to an immutable commit object and the
# build FAILS (below) if the checked-out HEAD is not byte-identical to B.
#
# The two repos stay separate: no aria-engine source is committed into this
# repository. This solves distribution, not duplication.
#
# CREDENTIALS: aria-engine is a private repo in the same GitHub org. The token
# is consumed ONLY in this builder stage and is never present in the final
# image (the final stage copies the checked-out tree, not this stage's
# environment or history). `.git` is deleted before the copy so no remote URL
# containing a token can survive into the shipped layers either.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS engine

# Pinned engine release. There is deliberately NO default: an unset ARG would
# be the empty string, and the verification step below turns that into a hard
# build failure rather than a silently engine-less image (fail-closed, per the
# packaging charter — never deploy an apparently-healthy service with no real
# engine behind it).
ARG ARIA_ENGINE_COMMIT_SHA
ARG ARIA_ENGINE_GIT_URL=https://github.com/AIWMCX/aria-engine.git
ARG ARIA_ENGINE_GIT_TOKEN=

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# ONE packaging implementation, shared with the local production-equivalent
# integration test (scripts/packaged-engine-integration-test.mts), so the
# artifact that test exercises is produced by the SAME code that produces the
# shipped image's artifact. See that script's header for the full list of
# fail-closed guarantees (exact-SHA pin, fetch-by-SHA, post-checkout HEAD
# re-verification, ARIA_RUNTIME_DIR support check, marker write, .git removal).
#
# The token is passed as a plain build ARG rather than a BuildKit
# `--mount=type=secret`: the latter needs a `# syntax=docker/dockerfile:1.x`
# directive and BuildKit-specific support on the builder, and Railway's
# Dockerfile builds are not verified here to provide either (this task does
# not deploy, so that could not be tested — see the report). The ARG is
# acceptable because it is consumed ONLY in this builder stage: the final
# stage below copies the checked-out TREE, not this stage's environment or
# history, and package-engine.mjs deletes `.git` (and the token-bearing
# remote URL with it) before the copy. It is never echoed to the build log.
COPY scripts/package-engine.mjs /tmp/package-engine.mjs
RUN node /tmp/package-engine.mjs --sha "$ARIA_ENGINE_COMMIT_SHA" --url "$ARIA_ENGINE_GIT_URL" --dest /opt/aria-engine

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — control plane (unchanged base; additive)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim
# node:sqlite (used instead of better-sqlite3) needs the flag dropped in
# 22.13.0 (existed but required --experimental-sqlite from 22.5–22.12) — do
# not pin this to an exact patch below 22.13, and don't downgrade below 22
# at all without reverting src/db.ts to a native driver.

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY migrations ./migrations

# Build/release identity (2026-09-19 release-integrity charter — see
# src/release.ts). RAILWAY_GIT_COMMIT_SHA/RAILWAY_GIT_BRANCH are Railway's
# own automatically-supplied git metadata, but for a Dockerfile build
# they only reach the build as ARGs — an unnamed ARG is silently empty,
# it never fails the build, so this is safe on any other host (plain
# `docker build`, a future non-Railway target) too. Promoting to ENV
# makes them readable by src/release.ts via process.env at runtime; the
# .build-sha/.build-time files are a second, independent source so the
# value survives even if Railway ever stops populating those ARGs.
ARG RAILWAY_GIT_COMMIT_SHA
ARG RAILWAY_GIT_BRANCH
ENV APP_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
ENV APP_GIT_BRANCH=$RAILWAY_GIT_BRANCH
RUN echo -n "$RAILWAY_GIT_COMMIT_SHA" > .build-sha
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > .build-time

# ── Packaged aria-engine ─────────────────────────────────────────────────────
# Same ARG re-declared: ARGs do not cross stage boundaries in Docker. This is
# the control plane's OWN record of what it expects, promoted to a runtime ENV
# that src/fleet/engine-identity.ts reads and compares against
# /opt/aria-engine/.engine-sha (copied from the builder stage).
ARG ARIA_ENGINE_COMMIT_SHA
ENV ARIA_ENGINE_COMMIT_SHA=$ARIA_ENGINE_COMMIT_SHA
COPY --from=engine /opt/aria-engine /opt/aria-engine
# This is the ONLY production/local-dev divergence in the engine invocation:
# the PATH. FleetManager's realEngineInvocation() is byte-identical in both
# environments (`node --import tsx src/cli.ts paper start`, cwd = this dir) —
# it is the same code path, pointed at a different directory. Unset locally,
# CONFIG.ARIA_ENGINE_REPO_PATH falls back to the `../aria-engine` sibling
# checkout exactly as before, so local dev is unchanged.
ENV ARIA_ENGINE_REPO_PATH=/opt/aria-engine

RUN mkdir -p /data
ENV DB_PATH=/data/aria.db
# Per-tenant engine state MUST live on the mounted Railway volume (/data), not
# under /app. The config defaults are `./data/tenants` and `./data/tenant-logs`
# — relative to WORKDIR that resolves to /app/data/*, which is IMAGE-layer
# storage and is DESTROYED on every redeploy. `state/paper-snapshot.json` and
# the append-only `state/events.jsonl` (aria-engine src/runtime/paths.ts) are
# the tenant's real trading journal; losing them on redeploy is silent data
# loss, not a cosmetic issue. Pinning both roots under /data puts them on the
# same persistent volume the SQLite DB already uses.
ENV FLEET_TENANTS_ROOT=/data/tenants
ENV FLEET_LOGS_ROOT=/data/tenant-logs
ENV NODE_ENV=production

EXPOSE 8080
CMD ["npm", "start"]

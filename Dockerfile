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

RUN mkdir -p /data
ENV DB_PATH=/data/aria.db
ENV NODE_ENV=production

EXPOSE 8080
CMD ["npm", "start"]

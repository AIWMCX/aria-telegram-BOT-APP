#!/usr/bin/env bash
# Restore a backup made by backup.sh. DESTRUCTIVE: replaces the live Postgres
# database and the live SQLite file. Refuses to run without --yes-overwrite.
# Usage: ./restore.sh <backup-dir> --yes-overwrite [--pg-only|--sqlite-only]
set -euo pipefail
cd "$(dirname "$0")"

SRC="${1:-}"; shift || true
CONFIRM=0; DO_PG=1; DO_SQLITE=1
for a in "$@"; do
  case "$a" in
    --yes-overwrite) CONFIRM=1 ;;
    --pg-only) DO_SQLITE=0 ;;
    --sqlite-only) DO_PG=0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done
[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "usage: $0 <backup-dir> --yes-overwrite [--pg-only|--sqlite-only]" >&2; exit 2; }
if [ "$CONFIRM" != 1 ]; then
  echo "REFUSING: this overwrites live data. Re-run with --yes-overwrite after taking a fresh ./backup.sh." >&2
  exit 1
fi
if [ -f "$SRC/SHA256SUMS" ]; then ( cd "$SRC" && sha256sum -c SHA256SUMS ); fi

echo "[restore] stopping app"
docker compose stop app || true
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U aria -d aria >/dev/null 2>&1; do sleep 2; done

if [ "$DO_PG" = 1 ]; then
  [ -s "$SRC/aria.pgdump" ] || { echo "missing aria.pgdump" >&2; exit 1; }
  echo "[restore] Postgres: recreate database and load dump"
  docker compose exec -T postgres psql -U aria -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS aria WITH (FORCE);" -c "CREATE DATABASE aria OWNER aria;"
  docker compose exec -T postgres pg_restore -U aria -d aria --no-owner --exit-on-error < "$SRC/aria.pgdump"
fi

if [ "$DO_SQLITE" = 1 ]; then
  [ -s "$SRC/aria.sqlite" ] || { echo "missing aria.sqlite" >&2; exit 1; }
  echo "[restore] SQLite: replace /data/aria.db (stale -wal/-shm removed)"
  docker compose create app >/dev/null
  docker compose run --rm --no-deps --entrypoint sh app -c 'rm -f /data/aria.db /data/aria.db-wal /data/aria.db-shm'
  docker compose cp "$SRC/aria.sqlite" app:/data/aria.db
fi

echo "[restore] starting app"
docker compose up -d app
echo "[restore] done. Verify: curl -s http://127.0.0.1:8080/healthz"

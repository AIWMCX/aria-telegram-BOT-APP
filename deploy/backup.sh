#!/usr/bin/env bash
# Consistent backup of BOTH datastores: Postgres (pg_dump, custom format) and
# SQLite (VACUUM INTO via the app image's node:sqlite - the image has no sqlite3
# CLI; VACUUM INTO is transactionally consistent even while the app is writing
# in WAL mode). Run from anywhere:  ./backup.sh   (cron-friendly)
# Env: BACKUP_DIR (default ./backups), RETENTION_DAYS (default 14)
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$TS"
mkdir -p "$DEST"
umask 077

echo "[backup] Postgres -> $DEST/aria.pgdump"
docker compose exec -T postgres pg_dump -U aria -d aria --format=custom > "$DEST/aria.pgdump"
[ -s "$DEST/aria.pgdump" ] || { echo "[backup] ERROR: empty pg dump" >&2; exit 1; }

echo "[backup] SQLite -> $DEST/aria.sqlite"
# /backups inside the container is ./backups on the host (see docker-compose.yml).
# That mapping is fixed to ./backups; if BACKUP_DIR differs we move the file after.
INNER="/backups/.sqlite-$TS.db"
docker compose exec -T app node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.DB_PATH||'/data/aria.db');
db.exec(\"VACUUM INTO '$INNER'\");
const c=db.prepare('PRAGMA integrity_check').get();
console.log('sqlite source integrity:',JSON.stringify(c));
" 2>&1 | grep -v -i "ExperimentalWarning\|--trace-warnings"
mv "$PWD/backups/.sqlite-$TS.db" "$DEST/aria.sqlite"
[ -s "$DEST/aria.sqlite" ] || { echo "[backup] ERROR: empty sqlite copy" >&2; exit 1; }

( cd "$DEST" && sha256sum aria.pgdump aria.sqlite > SHA256SUMS )

# Retention: delete timestamped backup dirs older than RETENTION_DAYS.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '2*T*Z' -mtime +"$RETENTION_DAYS" -exec rm -rf {} + || true

# Optional offsite copy (uncomment and configure `rclone config` first):
# rclone copy "$DEST" "remote:aria-backups/$TS" --immutable

echo "[backup] OK: $DEST"

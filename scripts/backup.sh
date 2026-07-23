#!/usr/bin/env bash
set -euo pipefail

# LEO-235 — back up the persistent volumes of a daily-os-feishu install:
#   ./data          (SQLite account/artifact store, scheduler state, memory, snapshots)
#   ./memory-vault  (decision policy and other local library files)
#   ./config        (config.yaml — lives in a mounted volume in the Docker shape)
#
# Output: backups/daily-os-backup-<timestamp>.tgz (override dir with $1 or --out).
#
# SQLite consistency: better-sqlite3 runs in WAL mode, so a raw tar taken while
# the service is writing can capture a torn db + wal. This script prefers an
# online-consistent snapshot via the `sqlite3` CLI (`.backup`). If `sqlite3` is
# not installed, it strips the transient -wal/-shm files and warns you to stop
# the service first — stopping the service is always the safest option:
#   docker compose stop      (Docker/Linux shape)
#   daily-os service uninstall / Ctrl+C on `npm run start`   (macOS shape)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="backups"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --out=*) OUT_DIR="${1#--out=}"; shift ;;
    -h|--help)
      echo "Usage: scripts/backup.sh [--out <dir>]"
      exit 0 ;;
    *) OUT_DIR="$1"; shift ;;
  esac
done

DB_PATH="data/runtime/daily-os.db"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT_DIR/daily-os-backup-${TIMESTAMP}.tgz"

VOLUMES=()
for dir in data memory-vault config; do
  [ -e "$dir" ] && VOLUMES+=("$dir")
done
if [ ${#VOLUMES[@]} -eq 0 ]; then
  echo "Nothing to back up: none of data/, memory-vault/, config/ exist." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "Staging volumes: ${VOLUMES[*]}"
for dir in "${VOLUMES[@]}"; do
  cp -R "$dir" "$STAGE/"
done

# Transient WAL sidecars must never be restored on their own.
rm -f "$STAGE/${DB_PATH}-wal" "$STAGE/${DB_PATH}-shm"

if [ -f "$DB_PATH" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    echo "Taking a consistent SQLite snapshot via sqlite3 .backup ..."
    rm -f "$STAGE/${DB_PATH}"
    sqlite3 "$DB_PATH" ".backup '$STAGE/${DB_PATH}'"
  else
    echo "WARNING: sqlite3 CLI not found — backing up the raw db file." >&2
    echo "         For a guaranteed-consistent backup, stop the service first" >&2
    echo "         (docker compose stop) or install sqlite3." >&2
  fi
fi

mkdir -p "$OUT_DIR"
tar czf "$ARCHIVE" -C "$STAGE" "${VOLUMES[@]}"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "Backup written: $ARCHIVE ($SIZE)"
echo "Restore with:   scripts/restore.sh $ARCHIVE"

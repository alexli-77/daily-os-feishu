#!/usr/bin/env bash
set -euo pipefail

# LEO-235 — restore ./data, ./memory-vault, ./config from an archive produced by
# scripts/backup.sh.
#
# Safety:
#   - Stop the service before restoring so nothing is writing to the volumes:
#       docker compose stop      (Docker/Linux shape)
#       Ctrl+C on `npm run start` / daily-os service uninstall   (macOS shape)
#   - If a target dir already has contents, the restore aborts unless you pass
#     --force. With --force, the current dir is moved aside to
#     <dir>.pre-restore-<timestamp> instead of being deleted, so a bad restore is
#     itself reversible.
#
# Usage: scripts/restore.sh <archive.tgz> [--force]

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCHIVE=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help)
      echo "Usage: scripts/restore.sh <archive.tgz> [--force]"
      exit 0 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

if [ -z "$ARCHIVE" ]; then
  echo "Usage: scripts/restore.sh <archive.tgz> [--force]" >&2
  exit 1
fi
if [ ! -f "$ARCHIVE" ]; then
  echo "Archive not found: $ARCHIVE" >&2
  exit 1
fi

# Which top-level dirs does the archive carry?
MEMBERS="$(tar tzf "$ARCHIVE" | awk -F/ '{print $1}' | sort -u)"
if [ -z "$MEMBERS" ]; then
  echo "Archive is empty: $ARCHIVE" >&2
  exit 1
fi
echo "Archive contains: $(echo "$MEMBERS" | tr '\n' ' ')"

# Refuse to clobber non-empty targets unless --force.
NON_EMPTY=()
for dir in $MEMBERS; do
  if [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null || true)" ]; then
    NON_EMPTY+=("$dir")
  fi
done
if [ ${#NON_EMPTY[@]} -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  echo "" >&2
  echo "Refusing to overwrite non-empty target(s): ${NON_EMPTY[*]}" >&2
  echo "Stop the service, then re-run with --force to move them aside and restore." >&2
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
for dir in "${NON_EMPTY[@]}"; do
  BAK="${dir}.pre-restore-${TIMESTAMP}"
  echo "Moving current $dir -> $BAK"
  mv "$dir" "$BAK"
done

echo "Extracting $ARCHIVE ..."
tar xzf "$ARCHIVE" -C "$ROOT"

echo "Restore complete."
if [ ${#NON_EMPTY[@]} -gt 0 ]; then
  echo "Previous data preserved at: ${NON_EMPTY[*]/%/.pre-restore-${TIMESTAMP}}"
  echo "Delete those once you have verified the restore."
fi
echo "Start the service again (docker compose up -d / npm run start) and log in to verify."

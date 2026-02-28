#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP_DIR=$(cat .codex-backups/LATEST_PRE_ROLLBACK_BACKUP)
if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "Backup dir not found: $BACKUP_DIR" >&2
  exit 1
fi
while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  src="$BACKUP_DIR/$rel"
  dst="$rel"
  mkdir -p "$(dirname "$dst")"
  cp -f "$src" "$dst"
  echo "restored $dst"
done < "$BACKUP_DIR/FILES.list"

if [[ -f "$BACKUP_DIR/NEW_FILES.list" ]]; then
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    if [[ -e "$rel" ]]; then
      rm -rf "$rel"
      echo "removed $rel"
    fi
  done < "$BACKUP_DIR/NEW_FILES.list"
fi

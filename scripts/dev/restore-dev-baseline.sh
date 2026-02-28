#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LATEST_FILE="$ROOT_DIR/.codex-backups/refactor-baseline-latest.txt"

if [[ ! -f "$LATEST_FILE" ]]; then
  echo "Baseline pointer not found: $LATEST_FILE" >&2
  exit 1
fi

BASE_REL="$(cat "$LATEST_FILE" | tr -d '\n')"
BASE_DIR="$ROOT_DIR/${BASE_REL#./}"
SNAPSHOT_DIR="$BASE_DIR/snapshot"

if [[ ! -d "$SNAPSHOT_DIR" ]]; then
  echo "Baseline snapshot not found: $SNAPSHOT_DIR" >&2
  exit 1
fi

rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='web/node_modules' \
  --exclude='scripts/node_modules' \
  --exclude='tmp' \
  --exclude='data' \
  --exclude='.codex-backups' \
  "$SNAPSHOT_DIR/" "$ROOT_DIR/"

echo "Restored DEV baseline from: $BASE_REL"

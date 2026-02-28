#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LATEST="$ROOT_DIR/tmp/real-e2e/latest-run.json"

if [[ ! -f "$LATEST" ]]; then
  echo "No latest-run metadata found: $LATEST"
  exit 1
fi

RUN_ROOT=$(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(p.runRoot||'');" "$LATEST")
PORT=$(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(p.port||''));" "$LATEST")

if [[ -z "$PORT" ]]; then
  echo "No port in latest-run metadata"
  exit 1
fi

PIDS=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN || true)
if [[ -n "$PIDS" ]]; then
  echo "Stopping real-e2e server on port $PORT (PIDs: $PIDS)"
  kill $PIDS || true
else
  echo "No listening process on port $PORT"
fi

echo "Run root: $RUN_ROOT"

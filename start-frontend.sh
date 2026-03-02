#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

export PORT="${PORT:-3475}"
export HM_DATA_DIR="${HM_DATA_DIR:-$ROOT_DIR/data}"
export HM_AGENTS_CONFIG_PATH="${HM_AGENTS_CONFIG_PATH:-$ROOT_DIR/agents.json}"

echo "Starting frontend at http://localhost:${PORT}"
echo "Data dir: ${HM_DATA_DIR}"
echo "Agents config: ${HM_AGENTS_CONFIG_PATH}"

cd "$ROOT_DIR"
exec node web/server.js

#!/bin/bash
# Hierarchical Memory System Startup Script

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_FILE="$RUN_DIR/server.log"
PID_FILE="$RUN_DIR/server.pid"
LEGACY_PID_FILE="/tmp/hierarchical-memory-server.pid"

cd "$ROOT_DIR"
mkdir -p "$RUN_DIR"

# Use local defaults only when env is not already configured by deployment.
export HM_DATA_DIR="${HM_DATA_DIR:-$ROOT_DIR/data}"
export HM_AGENTS_CONFIG_PATH="${HM_AGENTS_CONFIG_PATH:-$ROOT_DIR/agents.json}"

echo "🧠 Starting Hierarchical Memory System..."
echo ""

# Stop previous instance cleanly if it is still running.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    bash "$ROOT_DIR/stop.sh" >/dev/null
fi

# Clean legacy pid file if present for this repo migration.
if [ -f "$LEGACY_PID_FILE" ]; then
    rm -f "$LEGACY_PID_FILE"
fi

nohup node "$ROOT_DIR/web/server.js" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$PID_FILE"

sleep 2

if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✅ Server started (PID: $SERVER_PID)"
    echo "📊 Dashboard: http://localhost:3458"
    echo "🔧 API: http://localhost:3458/api/agents"
    echo ""
    echo "Logs: $LOG_FILE"
    echo ""
    echo "To stop: bash $ROOT_DIR/stop.sh"
else
    rm -f "$PID_FILE"
    echo "❌ Failed to start server"
    echo "Check logs: $LOG_FILE"
    exit 1
fi

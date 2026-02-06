#!/bin/bash
# Start hierarchical memory watcher for main agent
# Usage: ./start-watcher.sh [agentId] [sessionId]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_ID="${1:-main}"

# Find the most recent session for this agent
if [ -z "$2" ]; then
    SESSION_FILE=$(ls -t ~/.openclaw/agents/${AGENT_ID}/sessions/*.jsonl 2>/dev/null | head -1)
    if [ -z "$SESSION_FILE" ]; then
        echo "❌ No session found for agent: ${AGENT_ID}"
        exit 1
    fi
    SESSION_ID=$(basename "$SESSION_FILE" .jsonl)
else
    SESSION_ID="$2"
fi

echo "============================================"
echo "Hierarchical Memory Watcher"
echo "============================================"
echo "Agent:   ${AGENT_ID}"
echo "Session: ${SESSION_ID}"
echo "JSONL:   ~/.openclaw/agents/${AGENT_ID}/sessions/${SESSION_ID}.jsonl"
echo "============================================"
echo ""

cd "$SCRIPT_DIR"

# Export gateway token from config
export GATEWAY_TOKEN=$(node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(config.gateway?.auth?.token || '');
} catch { console.log(''); }
")

if [ -z "$GATEWAY_TOKEN" ]; then
    echo "⚠️  Warning: No gateway token found"
fi

# Run watcher
exec node watch.js "$AGENT_ID" "$SESSION_ID"

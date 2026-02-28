#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMD="${1:-start}"

case "$CMD" in
  start)
    shift || true
    exec bash "$ROOT_DIR/scripts/dev/run-real-e2e.sh" "$@"
    ;;
  stop)
    shift || true
    exec bash "$ROOT_DIR/scripts/dev/stop-real-e2e.sh" "$@"
    ;;
  *)
    echo "Usage: ./e2e.sh [start|stop] [args...]"
    echo "Examples:"
    echo "  ./e2e.sh start --agent hm-real-e2e-agent --model openai-codex/gpt-5.1-codex-mini --port 3475 --keep-alive"
    echo "  ./e2e.sh stop"
    exit 1
    ;;
esac

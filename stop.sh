#!/bin/bash
# Hierarchical Memory System Stop Script

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/server.pid"
LEGACY_PID_FILE="/tmp/hierarchical-memory-server.pid"

stop_pid() {
    local pid="$1"
    if ! kill -0 "$pid" 2>/dev/null; then
        return 2
    fi

    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..20}; do
        if ! kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        sleep 0.5
    done

    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.2
    if kill -0 "$pid" 2>/dev/null; then
        return 1
    fi
    return 0
}

stop_watcher_locks() {
    local lock
    for lock in "$ROOT_DIR"/data/*/watch.pid; do
        [ -f "$lock" ] || continue
        local wpid
        wpid="$(cat "$lock" 2>/dev/null || true)"
        if [ -n "${wpid:-}" ]; then
            if stop_pid "$wpid"; then
                stopped=1
            elif [ $? -eq 1 ]; then
                echo "❌ Failed to stop watcher pid $wpid ($lock)"
                failed=1
            fi
        fi
        rm -f "$lock"
    done
}

cleanup_orphan_tails() {
    local orphan_pids=""
    # Clean up orphan tails left after crashes/restarts (PPID=1).
    orphan_pids="$(ps -eo pid=,ppid=,args= | awk '$2==1 && $0 ~ /tail -F -n 0 \/home\/molt\/\.openclaw\/agents\/.+\/sessions\/.+\.jsonl/ {print $1}')"
    [ -z "${orphan_pids:-}" ] && return 0

    echo "🧹 Cleaning orphan tail processes..."
    while IFS= read -r pid; do
        [ -z "${pid:-}" ] && continue
        if stop_pid "$pid"; then
            stopped=1
            echo "   ✓ tail pid $pid"
        elif [ $? -eq 1 ]; then
            echo "❌ Failed to stop orphan tail pid $pid"
            failed=1
        fi
    done <<< "$orphan_pids"
}

echo "🛑 Stopping Hierarchical Memory System..."

stopped=0
failed=0

if [ -f "$PID_FILE" ]; then
    pid_from_file="$(cat "$PID_FILE" || true)"
    if [ -n "${pid_from_file:-}" ]; then
        if stop_pid "$pid_from_file"; then
            stopped=1
        elif [ $? -eq 1 ]; then
            echo "❌ Failed to stop pid $pid_from_file"
            failed=1
        fi
    fi
    rm -f "$PID_FILE"
fi

# Legacy pid migration path.
if [ -f "$LEGACY_PID_FILE" ]; then
    legacy_pid="$(cat "$LEGACY_PID_FILE" || true)"
    if [ -n "${legacy_pid:-}" ] && ps -p "$legacy_pid" -o args= | grep -Fq "$ROOT_DIR/web/server.js"; then
        if stop_pid "$legacy_pid"; then
            stopped=1
        elif [ $? -eq 1 ]; then
            echo "❌ Failed to stop legacy pid $legacy_pid"
            failed=1
        fi
    fi
    rm -f "$LEGACY_PID_FILE"
fi

# Scoped fallback: only server process started from this repository path.
while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    if stop_pid "$pid"; then
        stopped=1
    elif [ $? -eq 1 ]; then
        echo "❌ Failed to stop pid $pid (repo-scoped fallback)"
        failed=1
    fi
done < <(pgrep -f -- "$ROOT_DIR/web/server.js" || true)

# Legacy server fallback: handles old start mode "node server.js" (cwd=web).
while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    if pgrep -P "$pid" -f -- "node watch.js" >/dev/null 2>&1; then
        if stop_pid "$pid"; then
            stopped=1
        elif [ $? -eq 1 ]; then
            echo "❌ Failed to stop legacy server pid $pid"
            failed=1
        fi
    fi
done < <(pgrep -f -- "node server.js" || true)

# Repo-scoped watcher locks (handles orphan watcher processes).
stop_watcher_locks

# Orphan tail cleanup (crash leftovers).
cleanup_orphan_tails

if [ "$failed" -eq 1 ]; then
    echo "❌ Some processes could not be stopped"
    exit 1
elif [ "$stopped" -eq 1 ]; then
    echo "✅ Service stopped"
else
    echo "ℹ️ Service is not running"
fi

echo "Run: bash $ROOT_DIR/start.sh"

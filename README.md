# Hierarchical Memory System — Dev Environment

## Paths

| Environment | Path |
|---|---|
| **DEV** | `~/Consilium/hierarchical-memory/` |
| **PRODUCTION** | `~/clawd/council/hierarchical-memory/` |

> ⚠️ **NEVER edit production directly.** All changes go through dev → tests → deploy.

## Quick Start

```bash
cd ~/Consilium/hierarchical-memory

# Install dependencies (all three package.json dirs)
npm install && cd scripts && npm install && cd ../web && npm install && cd ..
```

## Run Tests

Uses Node.js built-in test runner (no extra deps):

```bash
# Run all tests
node --test tests/*.test.js

# Run specific test file
node --test tests/store.test.js
node --test tests/context.test.js
node --test tests/watch.test.js
```

### Test Coverage

- **store.test.js** — `createEmptyStore`, `addMessage`, `addArtifact`, `compareTimestamps`, `formatTimestamp`, `getLastSummarizedTimestamp`, `filterForCounting` (27 tests)
- **context.test.js** — `formatMessages`, `formatArtifacts`, `generateContext` (8 tests)
- **watch.test.js** — `extractContent`, `parseMessage` (13 tests)

## Run Dev Server (Web Dashboard)

```bash
cd web && node server.js
# Dashboard: http://localhost:3458
```

## Run Watcher (message tracking)

```bash
cd scripts && node watch.js <agentId>
# Example: node watch.js main
```

## Deploy to Production

After tests pass:

```bash
# Sync dev → production (excludes node_modules, data, logs)
rsync -av --exclude='node_modules' --exclude='data' --exclude='*.log' --exclude='.git' --exclude='tests' \
  ~/Consilium/hierarchical-memory/ ~/clawd/council/hierarchical-memory/

# Then restart the production server
cd ~/clawd/council/hierarchical-memory && bash start.sh
```

## Architecture

Key modules:

- **scripts/store.js** — Data layer: load/save stores, add messages/artifacts, threshold checking
- **scripts/context.js** — Context generator: builds CONTEXT.md from hierarchical memory
- **scripts/watch.js** — File watcher: tracks JSONL sessions, triggers summarization
- **scripts/watch-ws.js** — WebSocket watcher: alternative using Gateway WS subscription
- **scripts/trigger-ws.js** — Summarization trigger: sends prompts to agents via Gateway WS
- **scripts/gateway-client.js** — WebSocket client for OpenClaw Gateway with Ed25519 auth
- **web/server.js** — Express server: API + dashboard + process manager
- **agents.json** — Agent configuration (which agents are tracked)
- **config.json** — Global config (thresholds, data directory)

## Git Workflow

```bash
cd ~/Consilium/hierarchical-memory
git add -A && git commit -m "description of changes"
```

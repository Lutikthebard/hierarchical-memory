# DEV Environment — Hierarchical Memory (actual)

## Topology

- DEV repo: `~/Consilium/hierarchical-memory` (`/home/molt/Consilium/hierarchical-memory`)
- PROD repo: `~/clawd/council/hierarchical-memory` (`/home/molt/clawd/council/hierarchical-memory`)
- Runtime data root: `data/` (or `HM_DATA_DIR` override)
- Agents registry: `agents.json` (or `HM_AGENTS_CONFIG_PATH` override)

Main operational rule:
`develop in DEV -> run tests -> sync code/config`

## PROD Safety Rule (mandatory)

`PROD is sync-only.`

Categorical prohibition:
- `DO NOT start/stop/restart any service in PROD.`
- `DO NOT run server/watcher/manual runtime commands in PROD.`
- `Only allowed action in PROD: code/config synchronization from DEV (rsync).`

## Requirements

- Node.js `>=20.18.1`
- npm `>=10`

## Initial Setup

```bash
cd ~/Consilium/hierarchical-memory
npm install
cd scripts && npm install && cd ..
cd web && npm install && cd ..
```

## DEV Runtime

### Start dashboard/api

```bash
cd ~/Consilium/hierarchical-memory
npm run dev
```

Default URL: `http://localhost:3458`

### Long-running local service

```bash
bash start.sh
bash stop.sh
```

Service files:
- `.run/server.pid`
- `.run/server.log`

## Runtime Variables

- `PORT` (default `3458`)
- `HM_DATA_DIR` (default from `config.json:dataDir`, usually `./data`)
- `HM_AGENTS_CONFIG_PATH` (default `./agents.json`)
- `GATEWAY_URL` (default `ws://127.0.0.1:18789`)
- `OPENCLAW_AGENTS_DIR` (default `~/.openclaw/agents`)
- `HM_LLM_MODE` (`openclaw`|`mock`, default `openclaw`)
- `GATEWAY_TOKEN` (optional)
- `GATEWAY_PASSWORD` (optional; fallback to `~/.openclaw/openclaw.json` if present)
- `TRIGGER_TIMEOUT_SEC` (default `300`)
- `TRIGGER_ARTIFACT_WAIT_MS` (default `360000`; watcher stream artifact wait window)

## Runtime Behavior Summary

- `web/server.js` starts enabled watchers and exposes API/UI.
- `scripts/watch.js`:
  - resolves active session (`gateway` preferred, fallback rules by agent kind),
  - tails JSONL stream,
  - parses/classifies/filters messages,
  - updates store,
  - triggers summarization when thresholds are met,
  - handles auto-compact flow,
  - regenerates/debounces `CONTEXT.md`,
  - auto-switches sessions when gateway confirms new active session.
- `scripts/trigger-ws.js` performs L1 and aggregation via `HM_LLM_MODE` adapter.

## Tests

```bash
cd ~/Consilium/hierarchical-memory
npm test
npm run test:watch
npm run test:multiagent:offline
```

Latest local full suite run:
- Date: `2026-03-01`
- Result: `130 passed, 0 failed`

## Deploy DEV -> PROD

### 1) Verify in DEV

```bash
cd ~/Consilium/hierarchical-memory
npm test
```

### 2) Dry-run sync

```bash
rsync -av --dry-run \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='*.log' \
  --exclude='tests' \
  ~/Consilium/hierarchical-memory/ ~/clawd/council/hierarchical-memory/
```

### 3) Apply sync

```bash
rsync -av \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='*.log' \
  --exclude='tests' \
  ~/Consilium/hierarchical-memory/ ~/clawd/council/hierarchical-memory/
```

## Data Safety

`data/` must stay environment-local.
Do not copy DEV runtime state into PROD.

Includes:
- `store.json`
- `messages/*.jsonl`
- `CONTEXT.md`
- watcher lock/log runtime artifacts

## Daily Checklist

1. `cd ~/Consilium/hierarchical-memory`
2. `git status`
3. change code in DEV only
4. `npm test`
5. `rsync --dry-run ...`
6. `rsync ...`
7. done

# Hierarchical Memory System — DEV (actual)

## Environments

| Environment | Path |
|---|---|
| **DEV** | `~/Consilium/hierarchical-memory/` |
| **PRODUCTION** | `~/clawd/council/hierarchical-memory/` |

Rule: code changes are made in DEV first.
Pipeline: `DEV -> tests -> rsync (code/config only)`.

## Requirements

- Node.js `>=20.18.1`
- npm `>=10`

## Setup

```bash
cd ~/Consilium/hierarchical-memory
npm install
cd scripts && npm install && cd ..
cd web && npm install && cd ..
```

No project `.env` files are used. Runtime is controlled by shell env vars + defaults in code.

## Run

```bash
cd ~/Consilium/hierarchical-memory
npm run dev
```

Dashboard/API default: `http://localhost:3458`

Service mode:

```bash
bash start.sh
bash stop.sh
```

Runtime files:
- `.run/server.log`
- `.run/server.pid`

## Tests

```bash
cd ~/Consilium/hierarchical-memory
npm test
npm run test:watch
npm run test:multiagent:offline
```

Current offline suite: `135 tests / 135 passed` (last local run: `2026-03-02`).

## Useful Scripts

```bash
npm run demo:multiagent:offline
npm run demo:view:offline
npm run loadtest:offline
```

- `demo:multiagent:offline` runs isolated 3-agent scenario on `PORT` (default `3459`).
- `demo:view:offline` opens read-only UI over latest snapshot/demo data.
- `loadtest:offline` runs parallel stress scenarios; report -> `tmp/load-test-offline/reports/latest.{json,md}`.

## Runtime Configuration (actual defaults)

- `PORT` (default `3458`) — web server port.
- `HM_DATA_DIR` (default `./data`) — runtime data root.
- `HM_AGENTS_CONFIG_PATH` (default `./agents.json`) — agents registry.
- `GATEWAY_URL` (default `ws://127.0.0.1:18789`) — gateway WS endpoint.
- `OPENCLAW_AGENTS_DIR` (default `~/.openclaw/agents`) — sessions source for resolver/API.
- `HM_LLM_MODE` (default `openclaw`, optional `mock`) — summarization adapter.
- `GATEWAY_TOKEN` (optional) — gateway auth token.
- `GATEWAY_PASSWORD` (optional) — gateway auth password (used when token is absent).
- `TRIGGER_TIMEOUT_SEC` (default `300`) — trigger timeout for openclaw mode.
- `TRIGGER_ARTIFACT_WAIT_MS` (default `360000`) — artifact wait window in watcher stream mode.

Global `config.json`:
- `thresholds.L1` / `thresholds.default`
- `contextOverlap`
- `includeTimestamps`
- `dataDir`
- `startFromTimestamp` (lower bound for L0 unsummarized selection)
- `autoCompact.postCompactMessage`

## API (current endpoints)

Agent registry/lifecycle:
- `GET /api/agents/available`
- `GET /api/agents`
- `POST /api/agents`
- `DELETE /api/agents/:id`
- `POST /api/agents/:id/enable`
- `POST /api/agents/:id/disable`

Per-agent runtime/state:
- `GET /api/agents/:id/status`
- `GET /api/agents/:id/stats`
- `GET /api/agents/:id/store`
- `GET /api/agents/:id/context`
- `GET /api/agents/:id/logs`
- `GET /api/agents/:id/session/active`
- `POST /api/agents/:id/session/sync`

Per-agent operations:
- `POST /api/agents/:id/context/rebuild`
- `POST /api/agents/:id/context/inject`
- `POST /api/agents/:id/compact`
- `POST /api/agents/:id/compact-with-inject`
- `POST /api/agents/:id/memory/summarize-full`
- `POST /api/agents/:id/memory/learn-context`
- `POST /api/agents/:id/memory/clear`

Rollback:
- `POST /api/agents/:id/memory/rollback/preview`
- `POST /api/agents/:id/memory/rollback`
- `POST /api/agents/:id/memory/rollback/restore/:backupId`
- `GET /api/agents/:id/memory/rollback/backups`

Per-agent config/history/artifacts:
- `GET /api/agents/:id/config`
- `PUT /api/agents/:id/config`
- `GET /api/agents/:id/messages-dates`
- `GET /api/agents/:id/messages/:date`
- `GET /api/agents/:id/artifact/:level/:index/messages`
- `GET /api/agents/:id/artifacts`
- `GET /api/agents/:id/artifacts/search`
- `GET /api/agents/:id/artifacts/:artifactId/drilldown`

Legacy (`main` compatibility):
- `/api/status`, `/api/stats`, `/api/store`, `/api/context`, `/api/logs`, `/api/control`, `/api/artifact/:level/:index/messages`

## Full Summarize

Purpose: force compression of accumulated memory from L0 upward in one controlled run (watcher is paused during operation).

Endpoint:
- `POST /api/agents/:id/memory/summarize-full`

Optional request fields:
- `maxTargetLevel` (number) — upper target level limit.
- `aggregateBatch` (number) — batch size override for aggregate passes (L1+).

Behavior:
- runs iterative summarization passes (`L0->L1`, `L1->L2`, ...),
- archives summarized L0 messages,
- rebuilds `CONTEXT.md`,
- resumes watcher and returns pass telemetry.

## Learn Context

Purpose: ingest an external text as learned memory for selected agent while reusing standard summarization pipeline.

Endpoint:
- `POST /api/agents/:id/memory/learn-context`

Core request fields:
- `text` (string) — source text to learn from.
- `wordsPerBlock` (number) — word chunk size.
- `fromBlock` / `toBlock` (number, optional) — process only selected block range.
- `learningIntent` (string, optional) — intent added into L1 learning prompt.
- `l1ArtifactPrompt` (string, optional) — additional L1 prompt instructions.
- `runFullSummarize` (boolean, default `true`) — run post-ingest full summarization.

Prompt overrides:
- `aggregatePrompt` (string, optional) — global aggregate prompt override.
- `aggregatePromptsByLevel` (object, optional) — per-source-level aggregate prompts (`L1`, `L2`, ...).

Threshold overrides:
- `thresholds` (object, optional) — temporary thresholds for this run (`L1`, `default`, `L2+`).
- `maxTargetLevel` / `aggregateBatch` (number, optional) — full summarize options after learning.

Behavior:
- splits text into word blocks,
- sends selected blocks to active agent session as regular chat messages,
- ingests those blocks into L0 store,
- optionally runs full summarization from `sourceLevel=0` upward,
- rebuilds `CONTEXT.md`,
- resumes watcher and returns ingestion/summarization report.

## Agent Prompt Configuration

`PUT /api/agents/:id/config` supports:
- `prompts.l1` — base L1 prompt.
- `prompts.aggregate` — fallback aggregate prompt for all levels > L1.
- `prompts.aggregateBySourceLevel` — optional per-source-level aggregate prompts (`L1`, `L2`, ...).

Prompt priority for aggregation:
1. runtime `aggregatePromptsByLevel` (request-level override),
2. config `prompts.aggregateBySourceLevel`,
3. runtime/config `prompts.aggregate` fallback.

## Deploy DEV -> Production

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

### 3) Real sync

```bash
rsync -av \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='*.log' \
  --exclude='tests' \
  ~/Consilium/hierarchical-memory/ ~/clawd/council/hierarchical-memory/
```

## Safety Notes

- Never sync `data/` from DEV to PROD.
- Runtime memory state is environment-local (`store.json`, `messages/*.jsonl`, `CONTEXT.md`).
- Watcher process has per-agent lock file: `data/<agentId>/watch.pid`.

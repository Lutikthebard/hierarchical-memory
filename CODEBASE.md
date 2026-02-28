# Codebase Guide — Hierarchical Memory (actual)

`ENVIRONMENT.md` describes ops/deploy.
This file maps current code behavior.

## End-to-End Flow

1. `watch.js` resolves active session for agent.
2. Session JSONL is tailed and parsed (`message-parser.js`).
3. Message class/filters are applied (`message-classifier.js`).
4. Accepted messages are appended to store (`store.js`).
5. Threshold checks trigger summarization orchestrator.
6. `trigger-ws.js` creates L1/L2/L3 artifacts via adapter (`llm-adapter.js`).
7. Summarized L0 messages are archived to `messages/YYYY-MM-DD.jsonl`.
8. `context.js` regenerates `CONTEXT.md` from hierarchical state.

## Key Modules

### `scripts/store.js`

Responsibilities:
- global config + per-agent config loading/merging
- store load/save
- timestamp identity + comparisons
- unsummarized selection (`startFromTimestamp` aware)
- counting/context filtering
- daily archive IO

Important details:
- IDs are timestamp-based.
- `filterForCounting` and `filterForContext` use class filters + role filters.

### `scripts/message-classifier.js`

Message classes:
- `dialogue`
- `heartbeat`
- `command`
- `system_noise`
- `memory_internal`

Defaults:
- store/count/context include only `dialogue`.

### `scripts/message-parser.js`

- parses JSONL lines (`type=message`)
- normalizes content/timestamps
- applies store filters
- sets `shouldCount` for compact/threshold logic

### `scripts/session-policy.js` + `scripts/session-resolver.js`

- agent kind rules: `main`, `agent`, `subagent`
- gateway session key priority (`agent:<id>:main` vs `agent:<id>`)
- lookup/fallback directory policy
- subagent requires gateway, with pinned-cache behavior handled in watcher

### `scripts/watch.js`

Runtime orchestrator:
- per-agent lock file (`data/<agentId>/watch.pid`)
- active session detection and rebinding
- tail processing queue (sequential)
- threshold drain loop + global summarization lock
- periodic threshold safety sweep
- compaction event handling
- auto-compact retry strategy (via `compact-controller.js`)
- context auto-inject on new session/compaction (if enabled)

### `scripts/summarization-orchestrator.js`

- shells out to `trigger-ws.js` + `context.js`
- archives/removes summarized L0 messages
- recursive aggregation checks

### `scripts/trigger-ws.js`

Commands:
- `status <agentId>`
- `test <agentId>`
- `l1 <agentId> <sessionKey>`
- `aggregate <agentId> <sessionKey> <sourceLevel>`

Notes:
- adapter mode from `HM_LLM_MODE`
- artifact extraction via level-aware tags: `<memory_artifact_LN>...</memory_artifact_LN>`
- retries up to 3 attempts

### `scripts/llm-adapter.js`

- `openclaw` adapter (gateway transport)
- `mock` adapter (deterministic offline summaries)

### `scripts/gateway-client.js`

- gateway websocket handshake/auth
- RPC helper with timeout
- `sendToAgent` flow: `chat.send -> agent.wait -> chat.history polling`

### `web/server.js`

- process manager for watchers
- multi-agent API + legacy `main` API
- context rebuild and memory clear operations
- rollback preview/apply/restore endpoints
- session sync/pin endpoint
- websocket endpoint for logs (`/ws/logs`)

### `scripts/rollback-service.js`

- timestamp-based rollback planner
- rollback apply for store/archive/artifacts + active session JSONL
- backup manifest and rollback history
- restore flow for previous state recovery

## Data Model

### Message (`store.messages[]`)

- `role`
- `content`
- `timestamp`
- optional `messageClass`

### Artifact (`store.artifacts[level][]`)

- `content`
- `level`
- `startTimestamp`
- `endTimestamp`
- `createdAt`
- L1 metadata: `messageCount`
- L2+ metadata: `sourceLevel`, `artifactCount`

## Runtime Files

Per agent (`data/<agentId>/`):
- `store.json`
- `config.json`
- `CONTEXT.md`
- `messages/*.jsonl`
- `watch.log`
- `watch.pid`
- `last-session.json`
- `rollback-backups/<backupId>/...`
- `rollback-history.jsonl`

## Change Map

- thresholds, archive, unsummarized logic -> `scripts/store.js`
- line parse / filters / class behavior -> `scripts/message-parser.js`, `scripts/message-classifier.js`
- session resolution behavior -> `scripts/session-resolver.js`, `scripts/session-policy.js`, `tests/session-resolver.test.js`
- watcher runtime behavior -> `scripts/watch.js`, `tests/watch.test.js`, `tests/watcher-runtime.test.js`
- summarization prompt/adapter -> `scripts/trigger-ws.js`, `scripts/llm-adapter.js`
- api/process-control -> `web/server.js`, `tests/api-smoke.test.js`
- rollback behavior -> `scripts/rollback-service.js`, `tests/rollback-service.test.js`, `tests/api-smoke.test.js`

## Safety

- Do not sync `data/` from DEV to PROD.
- Run tests before deploy.
- Deployment is code/config sync only.

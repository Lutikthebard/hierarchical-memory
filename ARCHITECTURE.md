# Hierarchical Memory — Architecture (actual)

**Status:** active DEV codebase
**Last verification against code/tests:** 2026-03-01

## Goal

Preserve long-term agent memory by compressing conversation into hierarchical artifacts (L1/L2/L3...) while keeping recent context usable.

## System Components

- `scripts/watch.js` + `scripts/watch-runtime/*` — watcher runtime orchestration and session/file internals.
- `scripts/store.js` + `scripts/store/*` — store facade + modular storage internals (repo/messages/artifacts/archive/stats).
- `scripts/trigger-ws.js` — summarization/aggregation trigger.
- `scripts/gateway-client.js` + `scripts/gateway/*` — gateway transport + history/retry/artifact extraction.
- `scripts/llm-adapter.js` — transport mode (`openclaw` or `mock`).
- `scripts/context.js` — CONTEXT.md generation.
- `scripts/rollback-service.js` — rollback planner/apply/restore with backup.
- `web/server.js` + `web/routes/*` + `web/services/*` — dashboard/api + watcher process manager.
- `web/public/app*.js` — frontend dashboard split by state/method domains.

## Code Organization Philosophy

The codebase follows a layered + feature-split approach:

- server HTTP handlers by domain (`web/routes/*`);
- service helpers (`web/services/*`);
- runtime internals by subdomain (`scripts/watch-runtime/*`, `scripts/store/*`, `scripts/gateway/*`);
- frontend split into `state`, `methods`, and feature method modules;
- developer/demo tooling isolated under `scripts/dev/*`, CLI tooling under `scripts/cli/*`, with compatibility wrappers at legacy script paths.

## Refactor Guardrails

Hard rules for future changes:

1. Single responsibility per module.
2. Keep runtime files under ~300 LOC target; if a file grows past ~350 LOC, split it by domain.
3. Keep external API stable (CLI entrypoints, REST routes, module exports) when refactoring internals.
4. Any module extraction or routing split must ship with tests that cover the moved behavior.
5. No direct PROD edits; all refactor and verification in DEV first, then deploy.

## Storage Model

`data/<agentId>/store.json`:

```json
{
  "messages": [],
  "artifacts": {
    "1": [],
    "2": [],
    "3": []
  }
}
```

Message fields:
- `role`
- `content`
- `timestamp` (timestamp-based identity)
- optional `messageClass`
- optional inter-agent metadata (`direction`, `fromSessionKey`, `toSessionKey`, `toolName`, `toolCallId`, `runId`, `status`, `sourceType`)

Artifact fields:
- `content`
- `level`
- `startTimestamp`
- `endTimestamp`
- `createdAt`
- optional `messageCount` (L1)
- optional `sourceLevel` + `artifactCount` (L2+)

## Runtime Pipeline

1. Watcher resolves active session (`gateway` preferred; fallback policy depends on agent kind).
2. JSONL lines are tailed and parsed.
3. Message class filters are applied for store/count/context targets.
4. New L0 messages are appended to store.
5. If threshold is met, summarization starts (global in-process lock prevents parallel runs).
6. L1/L2/L3 artifacts are produced by trigger script.
7. Summarized L0 messages are archived to `messages/YYYY-MM-DD.jsonl` and removed from `store.messages`.
8. `CONTEXT.md` is regenerated (debounced).

## Filtering Model

Message classes:
- `dialogue`
- `inter_agent`
- `heartbeat`
- `command`
- `system_noise`
- `memory_internal`

Default inclusion:
- store/context -> `dialogue`, `inter_agent`
- count -> only `dialogue`

Additional filters:
- `countRoles`, `storeRoles`
- `exclude` substring list
- `excludePatterns` regex list
- `commandAllowlist`

## Session Model

- Main and regular agents can use gateway lookup with file fallback policy.
- Subagents require gateway mapping; pinned cache is used for temporary gateway outages.
- Watcher hot-switches session only when gateway confirms active session change.

## Rollback Model (timestamp rollback)

Rollback target: all memory state up to `cutoffTs` (UTC ISO).

Applied layers:
- `data/<agent>/store.json`
- `data/<agent>/messages/*.jsonl`
- `data/<agent>/artifacts*`
- `data/<agent>/CONTEXT.md` (regenerated after rollback)
- active OpenClaw session JSONL from `last-session.json` binding

Key points:
- rollback is timestamp-based, not snapshot-based;
- backup is always created before apply;
- restore returns both memory files and bound session JSONL.

## Auto-Compact / Auto-Inject

Per-agent config supports:
- `autoCompact.enabled`, `messageThreshold`, `retries`, `retryDelayMs`, `postCompactMessage`
- `autoInjectContext.enabled`, `onNewSession`, `onCompaction`

On compaction event:
- session message counter resets,
- optional context reinjection is scheduled.

## API Surface (high-level)

Per-agent endpoints include:
- lifecycle (`enable/disable`)
- session (`session/active`, `session/sync`)
- data (`stats`, `store`, `context`, logs)
- maintenance (`context/rebuild`, `context/inject`, `compact`, `compact-with-inject`, `memory/clear`)
- rollback (`memory/rollback/preview`, `memory/rollback`, `memory/rollback/restore/:backupId`, `memory/rollback/backups`)
- config (`GET/PUT config`)
- history/drilldown (`messages-dates`, `messages/:date`, `artifact/:level/:index/messages`, `artifacts/search`, `artifacts/:artifactId/drilldown`)

Legacy main-agent compatibility API is still available.

## Operational Rules

- Develop/test in DEV path.
- Before deploy: run `npm test`.
- Deploy via `rsync` excluding `data/`, `node_modules`, tests, logs.
- Follow `ENVIRONMENT.md` deploy policy for PROD runtime actions.

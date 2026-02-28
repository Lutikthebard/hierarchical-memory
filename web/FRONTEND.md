# Frontend Documentation (actual)

Dashboard UI for monitoring and controlling hierarchical memory agents.

## Stack

- Alpine.js (CDN)
- Tailwind CSS (CDN)
- Vanilla JS (`fetch`, `WebSocket`)
- Express + `ws` backend (`web/server.js`)

## Files

```
web/
├── server.js
├── package.json
└── public/
    ├── index.html
    └── app.js
```

## Core UI Features

- Multi-agent selector with running/subagent indicators.
- Controls:
  - start/stop watcher
  - sync active session from gateway
  - rebuild `CONTEXT.md`
  - clear agent memory
  - rollback memory to selected date/time (with preview/apply/restore)
- Tabs:
  - `Context`
  - `L1`, `L2`, `L3`
  - `Messages`
  - `Logs`
  - `Config`
- Drilldown modal:
  - L1 -> archived messages
  - L2/L3 -> source artifacts
- Date-based archived message browsing (`messages/YYYY-MM-DD.jsonl`).

## Frontend Runtime Behavior

`app.js` lifecycle:
- `init()` loads agents/config/data, starts websocket, starts polling.
- Polling interval: **20 seconds**.
- WebSocket: `/ws/logs` for live watcher log lines.
- `destroy()` closes interval/socket.

## Agent Config in UI

Editable areas:
- thresholds
- prompts
- filters
- autoInjectContext
- autoCompact

Class-based filters supported:
- `storeMessageClasses`
- `countMessageClasses`
- `contextMessageClasses`
- `commandAllowlist`

Message classes:
- `dialogue`, `heartbeat`, `command`, `system_noise`, `memory_internal`

## API Used by Frontend

- `GET /api/agents`
- `GET /api/agents/available`
- `POST /api/agents`
- `DELETE /api/agents/:id`
- `POST /api/agents/:id/enable`
- `POST /api/agents/:id/disable`
- `GET /api/agents/:id/stats`
- `GET /api/agents/:id/store`
- `GET /api/agents/:id/context`
- `POST /api/agents/:id/context/rebuild`
- `POST /api/agents/:id/memory/clear`
- `POST /api/agents/:id/memory/rollback/preview`
- `POST /api/agents/:id/memory/rollback`
- `POST /api/agents/:id/memory/rollback/restore/:backupId`
- `GET /api/agents/:id/memory/rollback/backups`
- `GET /api/agents/:id/logs?lines=100`
- `GET /api/agents/:id/config`
- `PUT /api/agents/:id/config`
- `GET /api/agents/:id/session/active`
- `POST /api/agents/:id/session/sync`
- `GET /api/agents/:id/messages-dates`
- `GET /api/agents/:id/messages/:date`
- `GET /api/agents/:id/artifact/:level/:index/messages`
- WebSocket: `WS /ws/logs`

## Rollback UX Flow

1. Open rollback modal.
2. Select local date/time cutoff (converted to UTC ISO in UI).
3. Run preview (`/memory/rollback/preview`) and inspect counts.
4. Apply rollback (`/memory/rollback`) only after successful preview.
5. Optionally restore previous state (`/memory/rollback/restore/:backupId`).

After apply/restore UI reloads:
- stats/store/context/logs/session info
- archived message dates
- agent list/status

## Local Run

From repository root:

```bash
npm run dev
```

Or from `web/` directly:

```bash
npm install
npm run start
```

Default URL: `http://localhost:3458`

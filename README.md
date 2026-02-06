# Hierarchical Memory System

Автоматическая многоуровневая суммаризация разговоров с иерархической структурой (L0 → L1 → L2 → L3...).

## Быстрый старт

```bash
./start.sh
```

Открыть: http://localhost:3458

Всё! Сервер автоматически запустит watchers для включённых агентов.

**Альтернативно:**
```bash
cd web && node server.js
```

## Возможности

- **Мультиагент**: управление памятью нескольких агентов из одного UI
- **Автодетект сессий**: watcher сам находит активную сессию через Gateway API
- **Рекурсивная агрегация**: L1 → L2 → L3 → ... автоматически при достижении threshold
- **Drill-down**: просмотр исходных сообщений для любого артефакта
- **Real-time**: мгновенная реакция на новые сообщения (tail -F)
- **CONTEXT.md**: автогенерация контекста для восстановления после compaction

## Структура данных

### Message (L0)
```javascript
{
  role: "user" | "assistant",
  content: string,
  timestamp: string  // ISO 8601, уникальный ID
}
```

### Artifact (L1, L2, L3...)
```javascript
{
  content: string,          // текст саммари
  level: number,            // 1, 2, 3...
  startTimestamp: string,   // ISO 8601 первого элемента
  endTimestamp: string,     // ISO 8601 последнего элемента
  createdAt: string,        // ISO 8601
  
  // Для L1 (messages → artifact):
  messageCount: number,
  
  // Для L2+ (artifacts → artifact):
  sourceLevel: number,
  artifactCount: number
}
```

**Ключевая особенность:** Timestamp-based ID система вместо числовых ID.

## Архитектура

```
hierarchical-memory/
├── web/
│   ├── server.js          # Главный сервер + Process Manager
│   └── public/            # Dashboard UI
│
├── scripts/
│   ├── watch.js           # Watcher (один на агента)
│   ├── trigger-ws.js      # WebSocket клиент для суммаризации
│   ├── store.js           # API хранилища
│   ├── context.js         # Генерация CONTEXT.md
│   └── gateway-client.js  # WebSocket клиент Gateway
│
├── data/{agentId}/
│   ├── store.json         # Артефакты + unsummarized pool
│   ├── messages/          # Архив по дням (для drill-down)
│   │   ├── 2026-02-03.jsonl
│   │   └── 2026-02-04.jsonl
│   ├── CONTEXT.md         # Сгенерированный контекст
│   └── watch.log          # Логи watcher
│
├── agents.json            # Конфиг агентов (enabled/disabled)
└── config.json            # Thresholds и настройки
```

## Web Dashboard

### Управление агентами

**⚙️ Manage Agents** → добавить/удалить агенты, toggle Enable/Disable

При Enable:
- Автоматически запускается watcher для агента
- Автодетект активной сессии через Gateway API
- Начинается отслеживание новых сообщений

При Disable:
- Watcher останавливается
- Данные сохраняются

### Просмотр данных

- **Agent selector**: выбор агента для просмотра
- **Stats bar**: messages, progress, L1/L2/L3 counts
- **Tabs**: Context, L1, L2, L3, Messages, Logs
- **Drill-down**: клик на 📜/📂 для просмотра источников

## API

### Agents Management

```
GET  /api/agents                    # Список агентов со статусом
GET  /api/agents/available          # Доступные агенты из OpenClaw
POST /api/agents                    # Добавить агента {id, name}
DELETE /api/agents/:id              # Удалить агента
POST /api/agents/:id/enable         # Включить память
POST /api/agents/:id/disable        # Выключить память
```

### Agent Data

```
GET /api/agents/:id/status          # Статус watcher
GET /api/agents/:id/stats           # Статистика
GET /api/agents/:id/store           # Артефакты + messages
GET /api/agents/:id/context         # CONTEXT.md
GET /api/agents/:id/logs            # Watch logs
GET /api/agents/:id/artifact/:level/:index/messages  # Drill-down
```

### Legacy (backwards compatible, agent=main)

```
GET  /api/status, /api/stats, /api/store, /api/context, /api/logs
POST /api/control {action: start|stop|restart}
```

## Конфигурация

### config.json

```json
{
  "thresholds": {
    "L1": 60,      // Сообщений для создания L1
    "default": 5   // Артефактов для L2, L3, ...
  },
  "contextOverlap": 1,
  "dataDir": "./data"
}
```

### agents.json

```json
{
  "agents": [
    {"id": "main", "name": "main", "enabled": true},
    {"id": "council-architect", "name": "council-architect", "enabled": false}
  ]
}
```

### Per-Agent Config (`data/{agentId}/config.json`)

```json
{
  "thresholds": {
    "L1": 60,           // Messages before L1 summarization
    "default": 5        // Artifacts before L2/L3/... aggregation
  },
  "prompts": {
    "l1": "Custom L1 summarization prompt...",
    "aggregate": "Custom aggregation prompt (use {level} placeholder)..."
  },
  "filters": {
    "exclude": ["HEARTBEAT_OK", "NO_REPLY"],    // Exact strings to exclude
    "excludePatterns": ["^Read HEARTBEAT"],      // Regex patterns to exclude
    "countRoles": ["user", "assistant"],         // Roles counted toward threshold
    "storeRoles": ["user", "assistant"]          // Roles stored in memory
  }
}
```

Edit via Dashboard → Config tab or API: `PUT /api/agents/:id/config`

### Auto-Inject Context

Automatically inject CONTEXT.md into agent session:

```json
{
  "autoInjectContext": {
    "enabled": true,
    "onNewSession": true,    // Inject when watcher starts
    "onCompaction": true     // Inject when compaction detected in JSONL
  }
}
```

Context is injected as a user message so the agent can read it.

**Triggers:**
- **New session:** When watcher detects new JSONL file (fs.watch)
- **Compaction:** When `{"type":"compaction"}` appears in JSONL stream

### Auto-Compact

Automatically trigger session compaction when message count exceeds threshold:

```json
{
  "autoCompact": {
    "enabled": true,
    "messageThreshold": 90,   // Trigger /compact at N messages
    "retries": 5,             // Max retry attempts
    "retryDelayMs": 3000      // Delay between retries
  }
}
```

**How it works:**
1. Watcher counts session messages (applies `countRoles` + `excludePatterns` filters)
2. When count >= threshold → send `/compact` via Gateway WebSocket API
3. Verify compaction by checking JSONL for new `{"type":"compaction"}` entry
4. On success: reset counter, auto-inject CONTEXT.md
5. On failure: retry up to `retries` times with `retryDelayMs` delay

**Benefits:**
- Prevents context overflow
- Maintains agent performance
- Seamless - agent receives fresh CONTEXT.md after each compaction
- Non-blocking - uses WebSocket queue instead of CLI

## Как это работает

### Цикл суммаризации

1. **Watcher** следит за JSONL сессии (tail -F)
2. При новом сообщении → добавляет в store
3. При достижении threshold (60 msgs, с учётом фильтров) → trigger-ws.js
4. **Промпт агенту:**
   ```
   🧠 MEMORY TASK: Create L1 Summary
   
   Summarize N messages from: <start> → <end>
   
   [instructions]
   
   **Wrap your entire response in <memory_artifact>...</memory_artifact> tags.**
   ```
5. **Агент** отвечает в тегах `<memory_artifact>...</memory_artifact>`
6. Парсинг ответа → создание Artifact
7. Архивация messages → `messages/YYYY-MM-DD.jsonl`
8. Удаление суммаризированных из store
9. **Рекурсивная проверка**: если L1 >= 5 → создать L2, и т.д.
10. **CONTEXT.md** регенерируется (debounce 10 сек)

### Структура CONTEXT.md

```markdown
# Memory Context

## MEMORY (LEVEL 2)
[старые L2 артефакты, последний "развёрнут" ниже]

## MEMORY (LEVEL 1)  
[L1 артефакты из периода последнего L2 + новые]

## RECENT CONVERSATION
[сообщения после последнего L1]
```

Бесшовный контекст без дублирования — от общего к частному.

## Размеры

| Компонент | Размер | Описание |
|-----------|--------|----------|
| store.json | ~40-200KB | Только unsummarized + артефакты |
| messages/ | ~1-2MB/день | Архив для drill-down |
| CONTEXT.md | ~30-50KB | Регенерируется автоматически |

## Технические детали

### Timestamp-based система
- Используются ISO 8601 timestamps как уникальные ID
- Не числовые ID — упрощает работу с архивами и drill-down
- `startTimestamp` / `endTimestamp` определяют диапазон

### WebSocket коммуникация
- Gateway client с reconnect
- `sessions_send` RPC вместо `openclaw agent` CLI
- Timeout: 300 секунд (5 минут) для суммаризации

### Session Key Format
- **Формат:** `agent:${agentId}:main` (полный формат с тремя частями)
- **Пример:** для агента `main` → `agent:main:main`
- **Формирование:** `gateway-client.js` → метод `sendToAgent()`
- **Фильтрация:** `watch.js` → метод `getActiveSession()` принимает только этот формат
- **Отклоняются:**
  - `agent:main` (короткий формат)
  - `agent:main:subagent:xxx` (subagent sessions)
  - `agent:main:poet` (labeled subsessions)
- **Критично:** Использование единого формата устраняет двусмысленность в роутинге сообщений между Gateway и агентами

### Global lock
- Предотвращает параллельные суммаризации
- Критично для систем с `tail -F` (real-time stream)

### Фильтры threshold
- `exclude`: точные строки для исключения
- `excludePatterns`: regex паттерны
- `countRoles`: какие роли считать (по умолчанию user/assistant)
- HEARTBEAT_OK, NO_REPLY автоматически исключаются

### Daily архивы
- После L1: messages → `messages/YYYY-MM-DD.jsonl`
- store.json остаётся компактным (~40-200KB)
- Drill-down читает из архивов

## История изменений

### 2026-02-05
- ✅ NO_REPLY fix: артефакты больше не отправляются в Telegram
- ✅ Improved response extraction: searches 3-message range for `<memory_artifact>` tag
- ✅ Unified start script (`start.sh` в корне)
- ✅ Удалены legacy файлы (trigger.js, index-old.html, app-old.js)
- ✅ Документация: добавлены разделы Auto-Compact и Auto-Inject

### 2026-02-04
- ✅ Мультиагент поддержка (Process Manager)
- ✅ Автодетект сессий через Gateway API
- ✅ Drill-down UI
- ✅ Архивация в daily files
- ✅ Store уменьшен в ~8 раз
- ✅ Per-agent configuration (thresholds, prompts, filters)
- ✅ Config UI в Dashboard
- ✅ Auto-inject CONTEXT.md (on new session, on compaction)
- ✅ Auto-Compact feature (message threshold + retry verification)
- ✅ Counting filters for threshold
- ✅ Очистка кодовой базы (удалены legacy файлы)

### 2026-02-03
- ✅ Initial implementation (timestamp-based)
- ✅ Web dashboard
- ✅ Lock mechanism
- ✅ Recursive aggregation
- ✅ WebSocket migration

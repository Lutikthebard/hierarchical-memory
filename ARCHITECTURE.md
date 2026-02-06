# Иерархическая память — Архитектура

**Статус:** ✅ PRODUCTION READY  
**Дата:** 2026-02-04

---

## Цель

Многоуровневая долгосрочная память для агентов OpenClaw. При переполнении контекста агент не теряет информацию — она сохраняется в иерархии артефактов.

---

## Ключевые концепции

### Структура хранения

```javascript
// store.json
{
  messages: Message[],      // L0 — несуммаризированные сообщения
  artifacts: {              // L1, L2, L3... — артефакты
    "1": Artifact[],
    "2": Artifact[],
    "3": Artifact[],
    ...
  }
}

// Message (L0)
{
  role: "user" | "assistant",
  content: string,
  timestamp: string         // ISO 8601 - уникальный ID
}

// Artifact (L1, L2, L3...)
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

**Ключевая особенность:** Используются **timestamps как уникальные ID**, а не числовые ID. Это упрощает работу с архивными данными и drill-down.

### Алгоритм суммаризации

1. **L0 → L1**: каждые N messages → артефакт L1
2. **L1 → L2**: каждые M artifacts L1 → артефакт L2
3. **L2 → L3**: каждые M artifacts L2 → артефакт L3
4. **... рекурсивно** — уровней может быть сколько угодно

**Триггер:** `countableItems.length >= threshold`

**Фильтрация перед подсчётом:**
- Исключение по тексту: `filters.exclude` (например, "HEARTBEAT_OK", "NO_REPLY")
- Исключение по regex: `filters.excludePatterns`
- Только определённые роли: `filters.countRoles` (по умолчанию ["user", "assistant"])

### Алгоритм сборки контекста (CONTEXT.md)

Сверху вниз с "раскрытием" последних (contextOverlap):

```
maxLevel = наивысший уровень с артефактами

for level = maxLevel+1 down to 1:
    sourceLevel = level - 1
    
    # Найти границу — что уже суммаризировано
    lastSummarizedTimestamp = max(endTimestamp) среди артефактов level, 
                              кроме последних contextOverlap
    
    # Взять "недавние" элементы sourceLevel
    recentItems = items where timestamp > lastSummarizedTimestamp
    
    # Добавить в контекст
    if sourceLevel == 0:
        → ## RECENT CONVERSATION
    else:
        → ## MEMORY (LEVEL sourceLevel)
```

**Результат:** высокоуровневые саммари + детали недавнего

---

## Архитектура системы

### Компоненты

```
┌───────────────────────────────────────────────────────────┐
│                MEMORY SERVICE (Node.js)                   │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────┐  │
│  │   STORE     │    │   MONITOR    │    │  SUMMARIZE  │  │
│  │             │    │              │    │             │  │
│  │ store.js    │◄───│  watch.js    │───►│ trigger-    │  │
│  │ (data API)  │    │  (tail -F)   │    │   ws.js     │  │
│  └─────────────┘    │              │    │ (WebSocket) │  │
│         │            │  • Gateway   │    └─────────────┘  │
│         │            │    API       │            │        │
│         │            │  • Auto-     │            │        │
│         │            │    detect    │            │        │
│         │            └──────────────┘            │        │
│         │                                        │        │
│         │            ┌──────────────┐            │        │
│         └───────────►│   CONTEXT    │◄───────────┘        │
│                      │              │                     │
│                      │  context.js  │                     │
│                      │  → CONTEXT.md│                     │
│                      └──────────────┘                     │
│                                                           │
│  ┌───────────────────────────────────────────────────┐   │
│  │              WEB DASHBOARD (Express)              │   │
│  │  • Process Manager (start/stop watchers)          │   │
│  │  • API endpoints                                  │   │
│  │  • Real-time stats                                │   │
│  │  • Drill-down UI                                  │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### Файловая структура

```
council/hierarchical-memory/
├── config.json          # Глобальные настройки
├── agents.json          # Список агентов (enabled/disabled)
│
├── scripts/
│   ├── store.js         # Работа с хранилищем (timestamp-based)
│   ├── watch.js         # Мониторинг сессии (tail -F + Gateway API)
│   ├── trigger-ws.js    # Суммаризация через WebSocket
│   ├── context.js       # Генерация CONTEXT.md
│   ├── gateway-client.js # WebSocket клиент Gateway
│   └── start-watcher.sh # Запуск watcher с логированием
│
├── web/
│   ├── server.js        # Express API + Process Manager
│   ├── start.sh         # Запуск dashboard
│   └── public/          # Frontend (HTML/CSS/JS)
│       └── index.html   # Dashboard UI
│
└── data/
    └── {agentId}/
        ├── config.json      # Конфиг агента (thresholds, prompts, filters)
        ├── store.json       # Хранилище (messages + artifacts)
        ├── CONTEXT.md       # Сгенерированный контекст
        └── messages/        # Архив по дням (для drill-down)
            ├── 2026-02-03.jsonl
            └── 2026-02-04.jsonl
```

### Конфигурация

**Глобальная** (`config.json`):
```json
{
  "thresholds": {
    "L1": 60,           // Сообщений для L1 (default)
    "default": 5        // Артефактов для L2, L3, ...
  },
  "contextOverlap": 1,  // Сколько последних артефактов "раскрывать"
  "includeTimestamps": true,
  "dataDir": "./data"
}
```

**Per-agent** (`data/{agentId}/config.json`):
```json
{
  "thresholds": {
    "L1": 60,
    "default": 5
  },
  "prompts": {
    "l1": "Custom L1 summarization prompt...",
    "aggregate": "Custom aggregation prompt (use {level} placeholder)..."
  },
  "filters": {
    "exclude": ["HEARTBEAT_OK", "NO_REPLY"],
    "excludePatterns": ["^Read HEARTBEAT"],
    "countRoles": ["user", "assistant"],
    "storeRoles": ["user", "assistant"]
  },
  "autoInjectContext": {
    "enabled": true,
    "onNewSession": true,
    "onCompaction": true
  }
}
```

---

## Как это работает

### 1. Мониторинг сессии (watch.js)

```
[START] watch.js main
   ↓
[1] Gateway API → getActiveSession("main")
   ↓ активная сессия: 00f3a4be-...
   ↓
[2] tail -F ~/.openclaw/agents/main/sessions/00f3a4be-....jsonl
   ↓
[3] Парсинг строк:
   • type === "message"
   • role in ["user", "assistant"]
   ↓
[4] addMessage(store, {role, content, timestamp})
   ↓
[5] saveStore()
   ↓
[6] checkThreshold(store, 0, agentConfig)
   ↓ если >= 60 (с учётом фильтров)
   ↓
[7] Вызов trigger-ws.js l1
```

**Auto-detect сессий:**
- `watchSessionDirectory()` следит за `~/.openclaw/agents/{agentId}/sessions/`
- При создании нового `.jsonl` → автопереключение на новую сессию
- При `/new` watcher автоматически находит активную сессию

**Auto-inject контекста:**
- При запуске watcher (если `onNewSession: true`)
- При обнаружении compaction event (если `onCompaction: true`)
- Инжектит CONTEXT.md как user message через WebSocket

### 2. Суммаризация (trigger-ws.js)

```
[START] trigger-ws.js l1 main <sessionKey>
   ↓
[1] loadStore(main)
   ↓
[2] getUnsummarized(store, 0) → messages
   ↓ применить фильтры (exclude, countRoles)
   ↓
[3] Создать промпт:
      🧠 MEMORY TASK: Create L1 Summary
      
      Summarize N messages from: <start> → <end>
      
      [instructions]
      
      **Wrap your entire response in <memory_artifact>...</memory_artifact> tags.**
   ↓
[4] WebSocket sessions_send(agentId, prompt)
   ↓ timeout: 300 sec
   ↓
[5] Парсинг ответа:
      • Извлечь текст между <memory_artifact>...</memory_artifact>
      • Если пусто → retry с доп. инструкцией
   ↓
[6] addArtifact(store, 1, {
      content,
      startTimestamp,
      endTimestamp,
      messageCount,
      createdAt
    })
   ↓
[7] Архивация: messages → messages/YYYY-MM-DD.jsonl
   ↓
[8] Удаление суммаризированных из store.messages
   ↓
[9] saveStore()
   ↓
[10] checkThreshold(store, 1, agentConfig)
   ↓ если >= 5 L1 artifacts
   ↓
[11] Рекурсивно: trigger-ws.js aggregate main <sessionKey> 1
```

**Агрегация L1→L2, L2→L3, ...:**
- Аналогичный процесс
- Промпт содержит тексты артефактов source level
- Artifact содержит `sourceLevel` и `artifactCount` вместо `messageCount`

### 3. Генерация контекста (context.js)

```
[START] context.js generate main
   ↓
[1] loadStore(main)
   ↓
[2] Найти maxLevel (наивысший уровень с артефактами)
   ↓
[3] for level = maxLevel+1 down to 1:
      sourceLevel = level - 1
      
      # Найти границу (с учётом overlap)
      lastSummarizedTimestamp = max(endTimestamp) среди artifacts[level],
                                кроме последних contextOverlap
      
      # Взять недавние элементы sourceLevel
      if sourceLevel == 0:
        recentItems = messages where timestamp > lastSummarizedTimestamp
        → "## RECENT CONVERSATION"
      else:
        recentItems = artifacts[sourceLevel] where endTimestamp > lastSummarizedTimestamp
        → "## MEMORY (LEVEL sourceLevel)"
   ↓
[4] Форматирование markdown
   ↓
[5] Запись в data/main/CONTEXT.md
```

**Debounce:** Регенерация откладывается на 10 секунд после последнего изменения store, чтобы не перегенерировать слишком часто.

### 4. Web Dashboard

- **Process Manager:** автоматический запуск/остановка watchers
- **API:** `/api/agents`, `/api/agents/:id/stats`, `/api/agents/:id/store`, и т.д.
- **Frontend:** Alpine.js + TailwindCSS, real-time обновления
- **Drill-down:** просмотр исходных messages для любого артефакта

---

## Критические особенности реализации

### 1. Timestamp-based ID система

**Почему не числовые ID:**
- Messages могут добавляться не по порядку (архивные данные)
- Drill-down требует сопоставления с JSONL (где есть только timestamps)
- Daily архивы легко фильтровать по timestamp

**Как работает:**
- `timestamp` (ISO 8601) = уникальный ID
- `startTimestamp` / `endTimestamp` определяют диапазон
- Сортировка по `compareTimestamps()`

### 2. WebSocket вместо CLI

**Почему WebSocket:**
- `openclaw agent --agent <id>` работает только с registered agents
- `sessions_spawn` не подходит для main agent
- WebSocket sessions_send() универсален и быстрее

**Как работает:**
- Gateway client с reconnect
- RPC вызов `sessions_send(sessionKey, message, timeoutSeconds)`
- Парсинг ответа из `result` payload

### 3. Глобальный lock

```javascript
let summarizationInProgress = false;

async function onThresholdReached(...) {
  if (summarizationInProgress) {
    console.log('🔒 Summarization already in progress, skipping...');
    return;
  }
  
  summarizationInProgress = true;
  try {
    await triggerSummarization(...);
  } finally {
    summarizationInProgress = false;
  }
}
```

**Почему нужен:**
- `tail -F` продолжает поставлять сообщения во время `await`
- Без lock: 20+ параллельных попыток суммаризации
- С lock: только одна суммаризация за раз

### 4. Фильтры для подсчёта threshold

Не все сообщения считаются для порога:

```javascript
function filterForCounting(items, agentConfig) {
  const filters = agentConfig.filters || {};
  const exclude = filters.exclude || [];
  const excludePatterns = (filters.excludePatterns || []).map(p => new RegExp(p));
  const countRoles = filters.countRoles || ['user', 'assistant'];
  
  return items.filter(item => {
    // Роль
    if (!countRoles.includes(item.role)) return false;
    
    // Exact match
    if (exclude.includes(item.content)) return false;
    
    // Regex
    if (excludePatterns.some(re => re.test(item.content))) return false;
    
    return true;
  });
}
```

**Результат:** HEARTBEAT_OK, NO_REPLY и системные сообщения не считаются для threshold.

### 5. Daily архивы

После создания L1 артефакта:

```javascript
// Архивация
archiveMessages(agentId, messagesToArchive); 
// → data/main/messages/YYYY-MM-DD.jsonl

// Удаление из store
removeSummarizedMessages(store, lastSummarizedTimestamp);
```

**Почему:**
- store.json остаётся маленьким (~40-200KB)
- Drill-down работает через daily архивы
- Легко искать по датам

---

## Текущий статус

**Фаза:** ✅ **PRODUCTION** — работает для main agent

**Протестировано:**
- [x] L0→L1 суммаризация (60 messages → L1 artifact)
- [x] L1→L2 агрегация (5 L1 artifacts → L2 artifact)
- [x] Рекурсивная проверка (L2→L3 автоматически)
- [x] CONTEXT.md генерация (top-down с overlap)
- [x] Auto-inject context (on new session, on compaction)
- [x] Multi-agent поддержка (web dashboard)
- [x] Drill-down UI (просмотр исходных messages)
- [x] Фильтры для threshold (exclude, countRoles)
- [x] Per-agent конфигурация
- [x] Gateway API автодетект сессий
- [x] Daily архивы

**В production:**
- main agent: полностью настроен и работает
- council-architect: готов к включению
- Другие агенты: добавляются через web dashboard

**Следующие шаги:**
- [ ] Мониторинг размера store.json (предупреждение если > 500KB)
- [ ] UI для drill-down по дням (calendar view)
- [ ] Экспорт/импорт памяти агента
- [ ] Бекапы store.json перед критическими операциями

---

## Размеры (типичные)

| Компонент | Размер | Описание |
|-----------|--------|----------|
| store.json | 40-200KB | Только unsummarized + артефакты |
| messages/YYYY-MM-DD.jsonl | 1-2MB | Архив за день |
| CONTEXT.md | 30-80KB | Регенерируется автоматически |
| L1 artifact | ~500-2000 chars | Саммари 60 messages |
| L2 artifact | ~1000-4000 chars | Агрегация 5 L1 |

---

## История изменений

### 2026-02-04
- ✅ Мультиагент поддержка (Process Manager)
- ✅ Автодетект сессий через Gateway API
- ✅ Drill-down UI
- ✅ Архивация в daily files
- ✅ Store уменьшен в ~8 раз
- ✅ Per-agent configuration (thresholds, prompts, filters)
- ✅ Config UI в Dashboard
- ✅ Auto-inject CONTEXT.md (on new session, on compaction)
- ✅ Counting filters for threshold
- ✅ Очистка кодовой базы (удалены тестовые файлы, старые версии, документация)

### 2026-02-03
- ✅ Initial implementation (timestamp-based)
- ✅ Web dashboard (Express + Alpine.js)
- ✅ Lock mechanism (prevent parallel summarizations)
- ✅ Recursive aggregation (L1→L2→L3→...)
- ✅ WebSocket migration (sessions_send вместо CLI)
- ✅ Bug fixes (infinite loop, timeout, context pollution)
- ✅ V3 storage refactoring (daily archives)

# Frontend Documentation

Web dashboard для мониторинга и управления иерархической памятью агентов.

---

## Технологии

### Frontend
- **Alpine.js v3** (CDN) — реактивный фреймворк
- **TailwindCSS v3** (CDN) — utility-first CSS
- **Vanilla JS** — WebSocket, fetch API
- **Single Page Application** — без роутинга, tab-based navigation

### Backend
- **Express.js** — API server
- **ws** — WebSocket server для real-time логов
- **tail** — мониторинг watch.log в реальном времени

**Причина выбора:** Минимальные зависимости, простота деплоя, CDN для фронтенда.

---

## Структура файлов

```
web/
├── server.js           # Express API + WebSocket + Process Manager
├── start.sh            # Запуск сервера
├── package.json        # Dependencies
│
└── public/
    ├── index.html      # Single page app
    └── app.js          # Alpine.js component (dashboard logic)
```

---

## Alpine.js Component

### State (app.js)

```javascript
function dashboard() {
  return {
    // Agent management
    agents: [],                    // Список всех агентов {id, name, enabled, running, pid, uptime}
    selectedAgent: 'main',         // Текущий выбранный агент
    currentAgentStatus: {},        // Статус watcher текущего агента
    availableAgents: [],           // Доступные агенты из OpenClaw
    
    // Data for selected agent
    stats: {},                     // {messagesCount, artifacts: {L1, L2, L3}, threshold, unsummarized, progress}
    artifacts: {L1:[], L2:[], L3:[]}, // Артефакты по уровням
    contextSections: [],           // Секции из CONTEXT.md
    messages: [],                  // Recent messages (L0)
    logs: [],                      // Watch logs (real-time via WebSocket)
    agentConfig: {},               // Per-agent configuration
    
    // UI state
    activeTab: 'context',          // Текущий таб: context|L1|L2|L3|messages|logs|config
    expanded: {},                  // {key: boolean} для collapse/expand артефактов
    showAgentManager: false,       // Показать модал управления агентами
    
    // Drill-down modal
    drilldownModal: {
      open: false,                 // Показать drill-down modal
      loading: false,              // Загрузка данных
      title: '',                   // Заголовок модала
      type: 'messages' | 'artifacts', // Тип drill-down
      messages: [],                // Исходные messages (для L1)
      sourceArtifacts: []          // Исходные artifacts (для L2+)
    },
    
    // WebSocket & intervals
    ws: null,                      // WebSocket для real-time логов
    refreshInterval: null          // setInterval для polling stats
  };
}
```

### Lifecycle Methods

**`init()`** — вызывается при монтировании Alpine component

```javascript
init() {
  this.loadAgents();              // Загрузить список агентов
  this.loadAvailableAgents();     // Загрузить доступные агенты из OpenClaw
  this.connectWebSocket();        // Подключить WebSocket для логов
  
  // Polling каждые 3 секунды
  this.refreshInterval = setInterval(() => {
    this.loadAgents();            // Обновить статусы watchers
    if (this.selectedAgent) {
      this.loadAgentData();       // Обновить данные агента
    }
  }, 3000);
}
```

**`destroy()`** — cleanup (Alpine вызывает автоматически при unmount)

```javascript
destroy() {
  if (this.refreshInterval) clearInterval(this.refreshInterval);
  if (this.ws) this.ws.close();
}
```

### Data Loading Methods

| Method | Endpoint | Description |
|--------|----------|-------------|
| `loadAgents()` | `GET /api/agents` | Список агентов + статус watchers |
| `loadAvailableAgents()` | `GET /api/agents/available` | Доступные агенты из OpenClaw |
| `loadStats()` | `GET /api/agents/:id/stats` | Статистика (messages, artifacts, progress) |
| `loadArtifacts()` | `GET /api/agents/:id/store` | Все артефакты L1/L2/L3 |
| `loadContext()` | `GET /api/agents/:id/context` | CONTEXT.md (parsed sections) |
| `loadMessages()` | `GET /api/agents/:id/store` | Recent messages (L0) |
| `loadLogs()` | `GET /api/agents/:id/logs` | Watch logs (100 последних строк) |
| `loadAgentConfig()` | `GET /api/agents/:id/config` | Конфигурация агента |
| `loadAgentData()` | — | Вызывает все load* методы параллельно |

### Agent Management Methods

**`switchAgent()`** — переключение на другого агента

```javascript
async switchAgent() {
  this.expanded = {};            // Сбросить expanded state
  this.loadAgentData();          // Загрузить данные нового агента
  
  // Переключить WebSocket на нового агента
  if (this.ws && this.ws.readyState === 1) {
    this.ws.send(JSON.stringify({ agentId: this.selectedAgent }));
  }
  this.logs = [];                // Очистить старые логи
}
```

**`toggleAgent()`** — включить/выключить watcher текущего агента

```javascript
async toggleAgent() {
  const endpoint = this.currentAgentStatus.running 
    ? `/api/agents/${this.selectedAgent}/disable`
    : `/api/agents/${this.selectedAgent}/enable`;
  
  await fetch(endpoint, { method: 'POST' });
  await this.loadAgents();       // Обновить статусы
}
```

**`addAgent(id)`** — добавить нового агента в систему

```javascript
async addAgent() {
  await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: this.newAgentId, name: this.newAgentId })
  });
  this.newAgentId = '';
  await this.loadAgents();
}
```

**`removeAgent(id)`** — удалить агента

```javascript
async removeAgent(agentId) {
  if (!confirm(`Remove agent "${agentId}"?`)) return;
  
  await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
  await this.loadAgents();
  
  // Если удалили текущего — переключиться на первого
  if (this.selectedAgent === agentId && this.agents.length > 0) {
    this.selectedAgent = this.agents[0].id;
    this.loadAgentData();
  }
}
```

### Drill-down

**`drilldown(level, index)`** — просмотр исходных данных артефакта

```javascript
async drilldown(level, index) {
  this.drilldownModal.open = true;
  this.drilldownModal.loading = true;
  
  const artifact = this.artifacts[`L${level}`][index];
  this.drilldownModal.title = `L${level} → ${this.extractTitle(artifact.content)}`;
  
  // Загрузить исходные данные
  const response = await fetch(
    `/api/agents/${this.selectedAgent}/artifact/${level}/${index}/messages`
  );
  const data = await response.json();
  
  if (level === 1) {
    // L1: показать messages
    this.drilldownModal.type = 'messages';
    this.drilldownModal.messages = data.messages || [];
  } else {
    // L2+: показать source artifacts
    this.drilldownModal.type = 'artifacts';
    this.drilldownModal.sourceArtifacts = data.sourceArtifacts || [];
  }
  
  this.drilldownModal.loading = false;
}
```

### Config Management

**`saveAgentConfig()`** — сохранить изменения конфигурации

```javascript
async saveAgentConfig() {
  await fetch(`/api/agents/${this.selectedAgent}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(this.agentConfig)
  });
  alert('Config saved!');
}
```

### WebSocket (Real-time Logs)

```javascript
connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/logs`;
  
  this.ws = new WebSocket(wsUrl);
  
  this.ws.onopen = () => {
    // Подписка на логи текущего агента
    this.ws.send(JSON.stringify({ agentId: this.selectedAgent }));
  };
  
  this.ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'log') {
      this.logs.push(data.line);
      if (this.logs.length > 200) {
        this.logs = this.logs.slice(-200);  // Keep last 200 lines
      }
      // Auto-scroll если на табе Logs
      if (this.activeTab === 'logs') {
        this.$nextTick(() => {
          const container = this.$refs.logContainer;
          if (container) container.scrollTop = container.scrollHeight;
        });
      }
    }
  };
  
  this.ws.onclose = () => {
    setTimeout(() => this.connectWebSocket(), 3000);  // Reconnect
  };
}
```

### Helper Methods

**`toggle(key)`** — expand/collapse артефакт

```javascript
toggle(key) {
  this.expanded[key] = !this.expanded[key];
}
```

**`extractTitle(content)`** — извлечь заголовок из markdown

```javascript
extractTitle(content) {
  const match = content.match(/^##\s*(.+)$/m);  // Ищем ## Заголовок
  if (match) return match[1].trim();
  
  // Fallback: первая непустая строка (до 80 символов)
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed.substring(0, 80);
    }
  }
  return 'Untitled';
}
```

**`formatTime(timestamp)`** — форматирование ISO timestamp

```javascript
formatTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toISOString().substring(0, 16).replace('T', ' ');
  // Результат: "2026-02-04 14:30"
}
```

---

## API Endpoints

### Agent Management

```
GET  /api/agents                    # Список агентов
     → {agents: [{id, name, enabled, running, pid, uptime, sessionId}]}

GET  /api/agents/available          # Доступные агенты из OpenClaw
     → {agents: [{id, name}]}

POST /api/agents                    # Добавить агента
     ← {id, name}
     → {success, agent}

DELETE /api/agents/:id              # Удалить агента
     → {success}

POST /api/agents/:id/enable         # Включить watcher
     → {success, running}

POST /api/agents/:id/disable        # Выключить watcher
     → {success, running}
```

### Agent Data

```
GET /api/agents/:id/status          # Статус watcher
    → {running, pid, uptime, sessionId}

GET /api/agents/:id/stats           # Статистика памяти
    → {messagesCount, artifacts: {L1, L2, L3}, threshold, unsummarized, progress}

GET /api/agents/:id/store           # Артефакты + messages
    → {artifacts: {L1: [...], L2: [...], L3: [...]}, recentMessages: [...]}

GET /api/agents/:id/context         # CONTEXT.md (parsed)
    → {sections: [{level, title, content}]}

GET /api/agents/:id/logs?lines=100  # Watch logs
    → {logs: [...]}

GET /api/agents/:id/config          # Конфигурация агента
    → {thresholds, prompts, filters, autoInjectContext}

PUT /api/agents/:id/config          # Обновить конфигурацию
    ← {thresholds, prompts, filters, autoInjectContext}
    → {success}
```

### Drill-down

```
GET /api/agents/:id/artifact/:level/:index/messages
    
    Для L1:
    → {type: 'messages', messages: [...], artifact: {...}}
    
    Для L2+:
    → {type: 'artifacts', sourceArtifacts: [...], artifact: {...}}
```

### Legacy (backwards compatible с agent=main)

```
GET /api/status        → /api/agents/main/status
GET /api/stats         → /api/agents/main/stats
GET /api/store         → /api/agents/main/store
GET /api/context       → /api/agents/main/context
GET /api/logs          → /api/agents/main/logs
GET /api/artifact/:level/:index/messages → /api/agents/main/artifact/...
POST /api/control      → start|stop|restart для main
```

### WebSocket

```
WS /ws/logs
   
   Client → Server:
   {agentId: 'main'}              # Подписка на логи агента
   
   Server → Client:
   {type: 'log', line: '...'}     # Новая строка в логе
```

---

## UI Components

### Header
- Название + agent selector (dropdown)
- Toggle watcher button (Start/Stop)
- Manage Agents button (открывает modal)

### Stats Bar
```
Messages: 413 | L1: 22 | L2: 2 | L3: 0 | Unsummarized: 0 | Progress: [=====] 100%
```

### Tabs Navigation
- **Context** — CONTEXT.md (секции)
- **L1, L2, L3** — артефакты соответствующих уровней
- **Messages** — recent messages (L0)
- **Logs** — watch.log (real-time)
- **Config** — настройки агента (thresholds, prompts, filters)

### Context Tab
- Секции CONTEXT.md
- Каждая секция: level, title, content
- Markdown рендерится как HTML (innerHTML)

### Artifact Tabs (L1, L2, L3)
- Список артефактов
- Для каждого:
  - Header: title (извлекается из content)
  - Collapse/expand
  - Drill-down button (📜 для L1, 📂 для L2+)
  - Metadata: timestamp range, count

### Drill-down Modal
- Overlay modal (full screen)
- Заголовок: "L1 → Title" или "L2 → Title"
- Loading state
- Для L1: список messages (role, content, timestamp)
- Для L2+: список source artifacts (expandable)

### Agent Manager Modal
- Список всех агентов
- Для каждого:
  - Name
  - Status: enabled ✓ / disabled ✗
  - Running: ✓ (PID xxx) / ✗
  - Toggle enabled button
  - Remove button
- Add new agent:
  - Dropdown из availableAgents
  - Add button

### Config Tab
- Форма редактирования agentConfig:
  - Thresholds (L1, default)
  - Prompts (L1, aggregate)
  - Filters (exclude, excludePatterns, countRoles, storeRoles)
  - Auto-inject context (enabled, onNewSession, onCompaction)
- Save button

---

## Расширение фронтенда

### Добавление нового таба

1. **Добавить в HTML** (`index.html`):
```html
<button @click="activeTab = 'mytab'" 
        :class="{'border-b-2 border-blue-500': activeTab === 'mytab'}">
  My Tab
</button>
```

2. **Добавить контент таба**:
```html
<div x-show="activeTab === 'mytab'" class="flex-1 overflow-auto p-4">
  <!-- Ваш контент -->
  <div x-text="myData"></div>
</div>
```

3. **Добавить state в Alpine** (`app.js`):
```javascript
return {
  // ... existing state
  myData: '',
  
  async loadMyData() {
    const response = await fetch(`/api/agents/${this.selectedAgent}/myendpoint`);
    this.myData = await response.text();
  }
};
```

4. **Вызывать в `loadAgentData()`**:
```javascript
async loadAgentData() {
  await Promise.all([
    this.loadStats(),
    // ...
    this.loadMyData()  // <-- добавить
  ]);
}
```

### Добавление нового API endpoint

1. **Backend** (`server.js`):
```javascript
app.get('/api/agents/:id/myendpoint', (req, res) => {
  const { id } = req.params;
  // ... логика
  res.json({ data: '...' });
});
```

2. **Frontend** (`app.js`):
```javascript
async loadMyData() {
  try {
    const response = await fetch(`/api/agents/${this.selectedAgent}/myendpoint`);
    const data = await response.json();
    this.myData = data.data;
  } catch (e) {
    console.error('Failed to load my data:', e);
  }
}
```

### Добавление real-time обновления

**Опция 1: Polling** (текущий подход)
```javascript
// В init() уже есть setInterval
this.refreshInterval = setInterval(() => {
  this.loadMyData();  // добавить свой метод
}, 3000);
```

**Опция 2: WebSocket** (для интенсивных данных)
```javascript
// В server.js добавить обработку нового типа сообщений
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.type === 'subscribe-mydata') {
      // ... логика подписки
    }
  });
});

// В app.js добавить обработку
this.ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'mydata-update') {
    this.myData = data.content;
  }
};
```

---

## Стилизация

### TailwindCSS классы

Используются в `index.html`:

- **Layout**: `flex`, `flex-col`, `h-screen`, `overflow-auto`, `p-4`, `space-y-4`
- **Spacing**: `mt-4`, `mb-2`, `px-4`, `py-2`, `gap-4`
- **Typography**: `text-sm`, `text-lg`, `font-bold`, `text-gray-500`
- **Colors**: `bg-gray-50`, `bg-blue-500`, `text-white`, `border-gray-300`
- **Interactive**: `hover:bg-gray-100`, `focus:outline-none`, `cursor-pointer`
- **Responsive**: `md:w-1/2`, `lg:w-1/3`

### Кастомные стили

Нет отдельного CSS файла — всё через Tailwind utility classes.

Если нужны кастомные стили:

```html
<style>
.my-custom-class {
  /* ... */
}
</style>
```

---

## Debugging

### Browser DevTools

**Console:**
```javascript
// Получить Alpine component
const app = Alpine.$data(document.querySelector('[x-data]'));

// Проверить state
console.log(app.agents);
console.log(app.stats);

// Вызвать методы
await app.loadAgents();
await app.drilldown(1, 0);
```

**Network tab:**
- Смотреть API requests/responses
- Проверить WebSocket frames

### Server Logs

```bash
cd web
node server.js
```

Логи в консоли:
- `[process-manager] Agent main watcher started (PID: xxx)`
- `[WebSocket] Client connected`
- `[WebSocket] Client subscribed to agent: main`

---

## Performance

### Polling Interval
- **Текущее:** 3000ms (3 секунды)
- **Оптимизация:** Увеличить до 5000-10000ms если агентов много

### WebSocket Buffer
- **Текущее:** Хранится 200 последних строк логов
- **Оптимизация:** Можно уменьшить до 100 если памяти мало

### API Response Size
- **store.json:** ~40-200KB (OK)
- **CONTEXT.md:** ~30-80KB (OK)
- **messages:** Ограничено 100 последними (в loadMessages)

Если размеры растут:
- Пагинация для messages
- Lazy loading для artifacts (подгружать по требованию)

---

## Deployment

### Development
```bash
cd web
npm install
node server.js
# → http://localhost:3458
```

### Production
```bash
cd web
npm install --production
./start.sh
# или
nohup node server.js > server.log 2>&1 &
```

### Reverse Proxy (Nginx)
```nginx
server {
  listen 80;
  server_name memory.example.com;
  
  location / {
    proxy_pass http://localhost:3458;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
  
  location /ws/ {
    proxy_pass http://localhost:3458;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

---

## TODO / Future Improvements

- [ ] Calendar view для drill-down по дням
- [ ] Export/import памяти агента (JSON download)
- [ ] Search по артефактам (full-text)
- [ ] Dark mode
- [ ] Keyboard shortcuts (j/k navigation)
- [ ] Diff view для сравнения версий артефактов
- [ ] Графики (timeline, message count over time)
- [ ] Notifications (browser push для threshold events)
- [ ] Mobile responsive improvements

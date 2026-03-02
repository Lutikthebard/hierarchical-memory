function dashboard() {
  const H = window.HmAppHelpers;
  const methodsFactory = window.HmAppMethods?.createMethods;
  const methods = typeof methodsFactory === 'function' ? methodsFactory(H) : {};
  const messageClassOptions = [
    { key: 'dialogue', label: 'Dialogue (agent/user/agent)' },
    { key: 'inter_agent', label: 'Inter-agent events (sessions_send)' },
    { key: 'heartbeat', label: 'Heartbeat messages' },
    { key: 'command', label: 'Commands (/...)' },
    { key: 'system_noise', label: 'System and technical noise' },
    { key: 'memory_internal', label: 'Memory internals (tasks/inject/artifacts)' }
  ];

  const defaultClassFilters = H.defaultClassFilters;
  const stateFactory = window.HmAppState?.createState;
  const baseState = typeof stateFactory === 'function'
    ? stateFactory(defaultClassFilters, messageClassOptions)
    : {};

  return {
    ...baseState,

    init() {
      this.loadAgents();
      this.loadAvailableAgents();
      this.loadAgentConfig();
      this.loadMessageDates();
      this.connectWebSocket();

      this.refreshInterval = setInterval(() => {
        this.loadAgents();
        if (this.selectedAgent) {
          this.loadAgentData();
        }
      }, 20000);
    },

    get rollbackCutoffIso() {
      if (!this.rollbackCutoffLocal) return '';
      const date = new Date(this.rollbackCutoffLocal);
      if (Number.isNaN(date.getTime())) return '';
      return date.toISOString();
    },

    ...methods,

    toggle(key) {
      this.expanded[key] = !this.expanded[key];
    },

    autoInjectFilesText(field) {
      return H.formatTextareaList(this.agentConfig?.autoInjectContext?.[field]);
    },

    setAutoInjectFiles(field, value) {
      if (!this.agentConfig.autoInjectContext) {
        this.agentConfig.autoInjectContext = {};
      }
      this.agentConfig.autoInjectContext[field] = H.parseTextareaList(value);
    },

    promptMapText(field) {
      return H.formatKeyValueMap(this.agentConfig?.prompts?.[field]);
    },

    setPromptMap(field, value) {
      if (!this.agentConfig.prompts) {
        this.agentConfig.prompts = {};
      }
      this.agentConfig.prompts[field] = H.parseKeyValueMap(value);
    },

    extractTitle(content) {
      return H.extractTitle(content);
    },

    formatTime(timestamp) {
      return H.formatTime(timestamp);
    },

    levelNumber(levelKey) {
      return H.levelNumberFromKey(levelKey) || 1;
    },

    artifactLevelKeys() {
      return H.sortLevelKeys(Object.keys(this.artifacts || {}));
    },

    statsLevelKeys() {
      return H.sortLevelKeys(Object.keys(this.stats?.artifacts || {}));
    },

    allLevelKeys() {
      const keys = new Set([
        ...this.artifactLevelKeys(),
        ...this.statsLevelKeys()
      ]);
      return H.sortLevelKeys(Array.from(keys));
    },

    levelPalette(levelNum) {
      const mod = ((Number(levelNum || 1) - 1) % 6) + 1;
      if (mod === 1) {
        return {
          badge: 'bg-purple-500 text-white',
          border: 'border-purple-300',
          header: 'bg-purple-50 hover:bg-purple-100',
          text: 'text-purple-700',
          button: 'text-purple-600'
        };
      }
      if (mod === 2) {
        return {
          badge: 'bg-blue-500 text-white',
          border: 'border-blue-300',
          header: 'bg-blue-50 hover:bg-blue-100',
          text: 'text-blue-700',
          button: 'text-blue-600'
        };
      }
      if (mod === 3) {
        return {
          badge: 'bg-green-500 text-white',
          border: 'border-green-300',
          header: 'bg-green-50 hover:bg-green-100',
          text: 'text-green-700',
          button: 'text-green-600'
        };
      }
      if (mod === 4) {
        return {
          badge: 'bg-amber-500 text-white',
          border: 'border-amber-300',
          header: 'bg-amber-50 hover:bg-amber-100',
          text: 'text-amber-700',
          button: 'text-amber-600'
        };
      }
      if (mod === 5) {
        return {
          badge: 'bg-rose-500 text-white',
          border: 'border-rose-300',
          header: 'bg-rose-50 hover:bg-rose-100',
          text: 'text-rose-700',
          button: 'text-rose-600'
        };
      }
      return {
        badge: 'bg-indigo-500 text-white',
        border: 'border-indigo-300',
        header: 'bg-indigo-50 hover:bg-indigo-100',
        text: 'text-indigo-700',
        button: 'text-indigo-600'
      };
    },

    levelBadgeClass(levelKey) {
      return this.levelPalette(this.levelNumber(levelKey)).badge;
    },

    levelCardBorderClass(levelKey) {
      return this.levelPalette(this.levelNumber(levelKey)).border;
    },

    levelCardHeaderClass(levelKey) {
      return this.levelPalette(this.levelNumber(levelKey)).header;
    },

    levelTabTextClass(levelKey) {
      return this.levelPalette(this.levelNumber(levelKey)).text;
    },

    levelDrilldownButtonClass(levelKey) {
      return this.levelPalette(this.levelNumber(levelKey)).button;
    },

    levelExpandedKey(levelKey, idx) {
      return `${String(levelKey || '').toLowerCase()}-${idx}`;
    },

    connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/logs`;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        if (this.selectedAgent) {
          this.ws.send(JSON.stringify({ agentId: this.selectedAgent }));
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'log') {
            this.logs.push(data.line);
            if (this.logs.length > 200) {
              this.logs = this.logs.slice(-200);
            }
            if (this.activeTab === 'logs') {
              this.$nextTick(() => {
                const container = this.$refs.logContainer;
                if (container) container.scrollTop = container.scrollHeight;
              });
            }
          }
        } catch (_e) {}
      };

      this.ws.onclose = () => {
        setTimeout(() => this.connectWebSocket(), 3000);
      };
    },

    destroy() {
      if (this.refreshInterval) clearInterval(this.refreshInterval);
      if (this.ws) this.ws.close();
    }
  };
}

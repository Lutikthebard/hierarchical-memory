function dashboard() {
  const messageClassOptions = [
    { key: 'dialogue', label: 'Dialogue (agent/user/agent)' },
    { key: 'heartbeat', label: 'Heartbeat messages' },
    { key: 'command', label: 'Commands (/...)' },
    { key: 'system_noise', label: 'System and technical noise' },
    { key: 'memory_internal', label: 'Memory internals (tasks/inject/artifacts)' }
  ];

  const defaultClassFilters = {
    storeMessageClasses: ['dialogue'],
    countMessageClasses: ['dialogue'],
    contextMessageClasses: ['dialogue'],
    commandAllowlist: []
  };

  function normalizeClassFilterArrays(filters = {}) {
    const out = { ...defaultClassFilters };
    for (const key of Object.keys(defaultClassFilters)) {
      if (Array.isArray(filters[key])) {
        out[key] = filters[key].map((x) => String(x || '').trim()).filter(Boolean);
      }
    }
    return out;
  }

  return {
    // State
    agents: [],
    selectedAgent: '',
    currentAgentStatus: { running: false },
    stats: { messagesCount: 0, artifacts: { L1: 0, L2: 0, L3: 0 }, threshold: 60, unsummarized: 0, progress: 0, sessionMessageCount: 0, compactThreshold: 150, compactProgress: 0 },
    artifacts: { L1: [], L2: [], L3: [] },
    contextSections: [],
    messages: [],
    logs: [],
    activeTab: 'context',
    expanded: {},
    showAgentManager: false,
    newAgentId: '',
    newAgentName: '',
    newAgentIsSubagent: false,
    availableAgents: [],
    sessionSyncInProgress: false,
    sessionSyncMessage: '',
    contextRebuildInProgress: false,
    contextRebuildMessage: '',
    sessionInfo: { sessionId: null, sessionKey: null, source: null, jsonlPath: null },
    ws: null,
    refreshInterval: null,
    drilldownModal: {
      open: false,
      loading: false,
      title: '',
      type: '',
      messages: [],
      sourceArtifacts: []
    },
    messageDates: [],
    selectedMessageDate: '',
    archivedMessages: [],
    archivedMessagesLoading: false,
    messageClassOptions,
    agentConfig: {
      thresholds: { L1: 60, default: 5 },
      prompts: { l1: '', aggregate: '' },
      filters: {
        exclude: [],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant'],
        ...defaultClassFilters
      },
      autoInjectContext: { enabled: false, onNewSession: false, onCompaction: false },
      autoCompact: { enabled: false, messageThreshold: 150, retries: 5, retryDelayMs: 3000 }
    },
    
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
    
    async loadAvailableAgents() {
      try {
        const response = await fetch('/api/agents/available');
        const data = await response.json();
        this.availableAgents = data.agents || [];
      } catch (e) {
        console.error('Failed to load available agents:', e);
      }
    },
    
    async loadAgents() {
      try {
        const response = await fetch('/api/agents');
        const data = await response.json();
        this.agents = data.agents || [];
        
        // Update current agent status
        const current = this.agents.find(a => a.id === this.selectedAgent);
        if (current) {
          this.currentAgentStatus = { running: current.running, pid: current.pid, uptime: current.uptime };
        }
        
        // Ensure selected agent exists in the current list.
        // This matters for snapshot/demo mode where "main" may not be present.
        const selectedExists = this.agents.some(a => a.id === this.selectedAgent);
        if ((!this.selectedAgent || !selectedExists) && this.agents.length > 0) {
          this.selectedAgent = this.agents[0].id;
          this.loadAgentData();
          this.loadAgentConfig();
          this.loadMessageDates();
        }
      } catch (e) {
        console.error('Failed to load agents:', e);
      }
    },
    
    async switchAgent() {
      this.expanded = {};
      this.logs = [];
      await Promise.all([
        this.loadAgentData(),
        this.loadAgentConfig(),
        this.loadMessageDates()
      ]);
      
      // Switch WebSocket to new agent
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ agentId: this.selectedAgent }));
      }
    },
    
    async loadAgentData() {
      if (!this.selectedAgent) return;
      
      await Promise.all([
        this.loadStats(),
        this.loadArtifacts(),
        this.loadContext(),
        this.loadMessages(),
        this.loadLogs(),
        this.loadSessionInfo()
      ]);
    },
    
    async loadStats() {
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/stats`);
        this.stats = await response.json();
      } catch (e) {}
    },
    
    async loadArtifacts() {
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/store`);
        const data = await response.json();
        this.artifacts = data.artifacts || { L1: [], L2: [], L3: [] };
      } catch (e) {}
    },
    
    async loadContext() {
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/context`);
        const data = await response.json();
        this.contextSections = data.sections || [];
      } catch (e) {}
    },
    
    async loadMessages() {
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/store`);
        const data = await response.json();
        this.messages = data.recentMessages || [];
      } catch (e) {}
    },
    
    async loadLogs() {
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/logs?lines=100`);
        const data = await response.json();
        this.logs = data.logs || [];
      } catch (e) {}
    },
    
    async loadAgentConfig() {
      if (!this.selectedAgent) return;
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/config`);
        const data = await response.json();
        const classFilters = normalizeClassFilterArrays(data.filters || {});
        this.agentConfig = {
          thresholds: data.thresholds || { L1: 60, default: 5 },
          prompts: data.prompts || { l1: '', aggregate: '' },
          filters: {
            ...(data.filters || {}),
            exclude: data.filters?.exclude || [],
            excludePatterns: data.filters?.excludePatterns || [],
            countRoles: data.filters?.countRoles || ['user', 'assistant'],
            storeRoles: data.filters?.storeRoles || ['user', 'assistant'],
            ...classFilters
          },
          autoInjectContext: data.autoInjectContext || { enabled: false, onNewSession: false, onCompaction: false },
          autoCompact: data.autoCompact || { enabled: false, messageThreshold: 150, retries: 5, retryDelayMs: 3000 }
        };
      } catch (e) {
        console.error('Failed to load agent config:', e);
      }
    },

    async loadSessionInfo() {
      if (!this.selectedAgent) return;
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/session/active`);
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }
        this.sessionInfo = {
          sessionId: data.sessionId || null,
          sessionKey: data.sessionKey || null,
          source: data.source || null,
          jsonlPath: data.jsonlPath || null
        };
      } catch (e) {
        this.sessionInfo = { sessionId: null, sessionKey: null, source: null, jsonlPath: null };
        console.error('Failed to load session info:', e);
      }
    },
    
    async saveAgentConfig() {
      if (!this.selectedAgent) return;
      try {
        this.agentConfig.filters = {
          ...(this.agentConfig.filters || {}),
          ...normalizeClassFilterArrays(this.agentConfig.filters || {})
        };
        const response = await fetch(`/api/agents/${this.selectedAgent}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.agentConfig)
        });
        const data = await response.json();
        if (data.success) {
          alert('Config saved!');
        } else {
          alert('Error: ' + (data.error || 'Unknown error'));
        }
      } catch (e) {
        console.error('Failed to save agent config:', e);
        alert('Failed to save config');
      }
    },
    
    async toggleAgent() {
      const endpoint = this.currentAgentStatus.running 
        ? `/api/agents/${this.selectedAgent}/disable`
        : `/api/agents/${this.selectedAgent}/enable`;
      
      try {
        await fetch(endpoint, { method: 'POST' });
        await this.loadAgents();
      } catch (e) {
        console.error('Toggle failed:', e);
      }
    },

    async syncSessionFromGateway() {
      if (!this.selectedAgent || this.sessionSyncInProgress) return;
      this.sessionSyncInProgress = true;
      this.sessionSyncMessage = '';

      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/session/sync`, {
          method: 'POST'
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }

        this.sessionSyncMessage = `Synced: ${data.session?.sessionId || 'unknown session'}`;
        await Promise.all([
          this.loadAgents(),
          this.loadAgentData(),
          this.loadSessionInfo()
        ]);
      } catch (e) {
        console.error('Session sync failed:', e);
        this.sessionSyncMessage = `Sync failed: ${e.message}`;
      } finally {
        this.sessionSyncInProgress = false;
        setTimeout(() => {
          this.sessionSyncMessage = '';
        }, 6000);
      }
    },

    async rebuildContext() {
      if (!this.selectedAgent || this.contextRebuildInProgress) return;
      this.contextRebuildInProgress = true;
      this.contextRebuildMessage = '';

      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/context/rebuild`, {
          method: 'POST'
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }

        this.contextSections = data.sections || [];
        this.activeTab = 'context';
        this.contextRebuildMessage = 'Context rebuilt successfully';
      } catch (e) {
        console.error('Context rebuild failed:', e);
        this.contextRebuildMessage = `Rebuild failed: ${e.message}`;
      } finally {
        this.contextRebuildInProgress = false;
        setTimeout(() => {
          this.contextRebuildMessage = '';
        }, 6000);
      }
    },
    
    async toggleAgentEnabled(agentId) {
      const agent = this.agents.find(a => a.id === agentId);
      if (!agent) return;
      
      const endpoint = agent.enabled 
        ? `/api/agents/${agentId}/disable`
        : `/api/agents/${agentId}/enable`;
      
      try {
        await fetch(endpoint, { method: 'POST' });
        await this.loadAgents();
      } catch (e) {
        console.error('Toggle failed:', e);
      }
    },
    
    async addAgent() {
      if (!this.newAgentId.trim()) return;
      
      try {
        await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            id: this.newAgentId.trim(), 
            name: this.newAgentName.trim() || this.newAgentId.trim(),
            isSubagent: this.newAgentIsSubagent
          })
        });
        this.newAgentId = '';
        this.newAgentName = '';
        this.newAgentIsSubagent = false;
        await this.loadAgents();
      } catch (e) {
        console.error('Add agent failed:', e);
      }
    },
    
    async removeAgent(agentId) {
      if (!confirm(`Remove agent "${agentId}"?`)) return;
      
      try {
        await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
        await this.loadAgents();
        
        if (this.selectedAgent === agentId && this.agents.length > 0) {
          this.selectedAgent = this.agents[0].id;
          this.loadAgentData();
        }
      } catch (e) {
        console.error('Remove agent failed:', e);
      }
    },
    
    async loadMessageDates() {
      if (!this.selectedAgent) return;
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/messages-dates`);
        const data = await response.json();
        this.messageDates = data.dates || [];
        this.selectedMessageDate = '';
        this.archivedMessages = [];
      } catch (e) {
        console.error('Failed to load message dates:', e);
      }
    },
    
    async loadArchivedMessages() {
      if (!this.selectedAgent || !this.selectedMessageDate) return;
      this.archivedMessagesLoading = true;
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/messages/${this.selectedMessageDate}`);
        const data = await response.json();
        this.archivedMessages = data.messages || [];
      } catch (e) {
        console.error('Failed to load archived messages:', e);
        this.archivedMessages = [];
      } finally {
        this.archivedMessagesLoading = false;
      }
    },
    
    async drilldown(level, index) {
      this.drilldownModal.open = true;
      this.drilldownModal.loading = true;
      this.drilldownModal.messages = [];
      this.drilldownModal.sourceArtifacts = [];
      
      const artifact = level === 1 ? this.artifacts.L1[index] : 
                       level === 2 ? this.artifacts.L2[index] : 
                       this.artifacts.L3[index];
      
      this.drilldownModal.title = `L${level} → ${this.extractTitle(artifact?.content || 'Artifact')}`;
      
      try {
        const response = await fetch(`/api/agents/${this.selectedAgent}/artifact/${level}/${index}/messages`);
        const data = await response.json();
        
        if (level === 1) {
          this.drilldownModal.type = 'messages';
          this.drilldownModal.messages = data.messages || [];
        } else {
          this.drilldownModal.type = 'artifacts';
          this.drilldownModal.sourceArtifacts = data.sourceArtifacts || [];
        }
      } catch (e) {
        console.error('Drilldown failed:', e);
      } finally {
        this.drilldownModal.loading = false;
      }
    },

    classFilterField(scope) {
      if (scope === 'store') return 'storeMessageClasses';
      if (scope === 'count') return 'countMessageClasses';
      return 'contextMessageClasses';
    },

    classEnabled(scope, className) {
      const field = this.classFilterField(scope);
      const list = this.agentConfig.filters?.[field] || [];
      return list.includes(className);
    },

    toggleClass(scope, className, checked) {
      const field = this.classFilterField(scope);
      if (!this.agentConfig.filters[field]) {
        this.agentConfig.filters[field] = [];
      }
      const list = this.agentConfig.filters[field];
      const idx = list.indexOf(className);
      if (checked && idx === -1) list.push(className);
      if (!checked && idx !== -1) list.splice(idx, 1);
    },
    
    toggle(key) {
      this.expanded[key] = !this.expanded[key];
    },
    
    extractTitle(content) {
      if (!content) return 'Untitled';
      const match = content.match(/^##\s*(.+)$/m);
      if (match) return match[1].trim();
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          return trimmed.substring(0, 80);
        }
      }
      return 'Untitled';
    },
    
    formatTime(timestamp) {
      if (!timestamp) return '';
      return new Date(timestamp).toISOString().substring(0, 16).replace('T', ' ');
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
        } catch (e) {}
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

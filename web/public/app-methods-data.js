(function attachHmAppDataMethods(globalObj) {
  function createMethods(H) {
    return {
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

          const current = this.agents.find((a) => a.id === this.selectedAgent);
          if (current) {
            this.currentAgentStatus = { running: current.running, pid: current.pid, uptime: current.uptime };
          }

          const selectedExists = this.agents.some((a) => a.id === this.selectedAgent);
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
        this.rollbackPreview = null;
        this.rollbackLastBackupId = '';
        this.rollbackMessage = '';
        await Promise.all([
          this.loadAgentData(),
          this.loadAgentConfig(),
          this.loadMessageDates()
        ]);

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
          const payload = await response.json();
          this.stats = {
            ...this.stats,
            ...payload,
            artifacts: H.normalizeArtifactCounts(payload?.artifacts)
          };
        } catch (_e) {}
      },

      async loadArtifacts() {
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/store`);
          const data = await response.json();
          this.artifacts = H.normalizeArtifactMap(data?.artifacts);

          if (String(this.activeTab || '').startsWith('level-')) {
            const levelKey = String(this.activeTab).slice('level-'.length);
            if (!this.artifacts[levelKey]) {
              this.activeTab = 'context';
            }
          }
        } catch (_e) {}
      },

      async loadContext() {
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/context`);
          const data = await response.json();
          this.contextSections = data.sections || [];
        } catch (_e) {}
      },

      async loadMessages() {
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/store`);
          const data = await response.json();
          this.messages = data.recentMessages || [];
        } catch (_e) {}
      },

      async loadLogs() {
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/logs?lines=100`);
          const data = await response.json();
          this.logs = data.logs || [];
        } catch (_e) {}
      },

      async loadAgentConfig() {
        if (!this.selectedAgent) return;
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/config`);
          const data = await response.json();
          const classFilters = H.normalizeClassFilterArrays(data.filters || {});
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
            autoInjectContext: {
              enabled: false,
              onNewSession: false,
              onCompaction: false,
              preText: '',
              postText: '',
              preMdFiles: [],
              postMdFiles: [],
              ...(data.autoInjectContext || {})
            },
            autoCompact: {
              enabled: false,
              messageThreshold: 150,
              postCompactMessage: '',
              retries: 5,
              retryDelayMs: 3000,
              ...(data.autoCompact || {})
            },
            learnContext: {
              wordsPerBlock: 180,
              fromBlock: null,
              toBlock: null,
              learningIntent: '',
              l1ArtifactPrompt: '',
              aggregatePrompt: '',
              aggregatePromptsByLevel: {},
              runFullSummarize: true,
              maxTargetLevel: 8,
              aggregateBatch: null,
              thresholds: {},
              ...(data.learnContext || {})
            }
          };
          if (typeof this.fillLearnContextFormFromConfig === 'function') {
            this.fillLearnContextFormFromConfig();
          }
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
            ...H.normalizeClassFilterArrays(this.agentConfig.filters || {})
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
            alert(`Error: ${data.error || 'Unknown error'}`);
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
      }
    };
  }

  globalObj.HmAppDataMethods = { createMethods };
}(window));

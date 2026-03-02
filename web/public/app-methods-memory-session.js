(function attachHmAppMemorySessionMethods(globalObj) {
  function createMethods() {
    return {
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

      async injectContextNow() {
        if (!this.selectedAgent || this.contextInjectInProgress) return;
        this.contextInjectInProgress = true;
        this.contextInjectMessage = '';

        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/context/inject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rebuild: true })
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          this.contextInjectMessage = 'Context injected successfully';
          await Promise.all([
            this.loadAgentData(),
            this.loadSessionInfo()
          ]);
        } catch (e) {
          console.error('Context inject failed:', e);
          this.contextInjectMessage = `Inject failed: ${e.message}`;
        } finally {
          this.contextInjectInProgress = false;
          setTimeout(() => {
            this.contextInjectMessage = '';
          }, 6000);
        }
      },

      async compactWithInject() {
        if (!this.selectedAgent || this.compactInjectInProgress) return;
        this.compactInjectInProgress = true;
        this.compactInjectMessage = '';

        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/compact-with-inject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          this.compactInjectMessage = 'Compact + inject completed';
          await Promise.all([
            this.loadAgentData(),
            this.loadSessionInfo()
          ]);
        } catch (e) {
          console.error('Compact + inject failed:', e);
          this.compactInjectMessage = `Compact+Inject failed: ${e.message}`;
        } finally {
          this.compactInjectInProgress = false;
          setTimeout(() => {
            this.compactInjectMessage = '';
          }, 6000);
        }
      },

      async fullSummarize() {
        if (!this.selectedAgent || this.fullSummarizeInProgress) return;
        this.fullSummarizeInProgress = true;
        this.fullSummarizeMessage = '';

        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/memory/summarize-full`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }

          const passes = Array.isArray(data.run?.passes) ? data.run.passes.length : 0;
          this.fullSummarizeMessage = `Full summarize completed (${passes} passes)`;
          await Promise.all([
            this.loadAgentData(),
            this.loadSessionInfo()
          ]);
        } catch (e) {
          console.error('Full summarize failed:', e);
          this.fullSummarizeMessage = `Full summarize failed: ${e.message}`;
        } finally {
          this.fullSummarizeInProgress = false;
          setTimeout(() => {
            this.fullSummarizeMessage = '';
          }, 6000);
        }
      },

      async clearAgentMemory() {
        if (!this.selectedAgent || this.memoryClearInProgress) return;
        const warning = [
          `Clear memory for agent "${this.selectedAgent}"?`,
          '',
          'This will delete:',
          '- current store.json (messages + artifacts)',
          '- archived messages (messages/*.jsonl)',
          '- CONTEXT.md'
        ].join('\n');
        if (!confirm(warning)) return;

        this.memoryClearInProgress = true;
        this.memoryClearMessage = '';

        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/memory/clear`, {
            method: 'POST'
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }

          this.activeTab = 'context';
          this.memoryClearMessage = 'Memory cleared successfully';
          await Promise.all([
            this.loadAgentData(),
            this.loadMessageDates(),
            this.loadSessionInfo(),
            this.loadAgents()
          ]);
        } catch (e) {
          console.error('Memory clear failed:', e);
          this.memoryClearMessage = `Clear failed: ${e.message}`;
        } finally {
          this.memoryClearInProgress = false;
          setTimeout(() => {
            this.memoryClearMessage = '';
          }, 6000);
        }
      }
    };
  }

  globalObj.HmAppMemorySessionMethods = { createMethods };
}(window));

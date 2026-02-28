(function attachHmAppAgentMethods(globalObj) {
  function createMethods(H) {
    return {
      async toggleAgentEnabled(agentId) {
        const agent = this.agents.find((a) => a.id === agentId);
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
        this.drilldownModal.sourceLevel = null;
        this.drilldownModal.messages = [];
        this.drilldownModal.sourceArtifacts = [];

        const levelNum = Number(level);
        const levelKey = `L${levelNum}`;
        const artifact = (this.artifacts[levelKey] || [])[index];
        if (!artifact) {
          this.drilldownModal.loading = false;
          this.drilldownModal.title = `L${levelNum} artifact not found`;
          return;
        }

        this.drilldownModal.title = `L${levelNum} → ${H.extractTitle(artifact?.content || 'Artifact')}`;

        try {
          let response;
          if (artifact?.artifactId) {
            const artifactId = encodeURIComponent(artifact.artifactId);
            response = await fetch(`/api/agents/${this.selectedAgent}/artifacts/${artifactId}/drilldown`);
          } else {
            response = await fetch(`/api/agents/${this.selectedAgent}/artifact/${levelNum}/${index}/messages`);
          }
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const data = await response.json();

          if (levelNum === 1) {
            this.drilldownModal.type = 'messages';
            this.drilldownModal.messages = data.messages || [];
          } else {
            this.drilldownModal.type = 'artifacts';
            this.drilldownModal.sourceLevel = levelNum - 1;
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
      }
    };
  }

  globalObj.HmAppAgentMethods = { createMethods };
}(window));

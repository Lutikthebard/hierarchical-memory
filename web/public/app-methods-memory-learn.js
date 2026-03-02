(function attachHmAppMemoryLearnMethods(globalObj) {
  function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  }

  function createMethods(H) {
    return {
      fillLearnContextFormFromConfig() {
        const defaults = this.agentConfig?.learnContext || {};
        this.learnContextForm = {
          ...this.learnContextForm,
          wordsPerBlock: toPositiveInt(defaults.wordsPerBlock) || 180,
          fromBlock: toPositiveInt(defaults.fromBlock) || '',
          toBlock: toPositiveInt(defaults.toBlock) || '',
          learningIntent: String(defaults.learningIntent || ''),
          l1ArtifactPrompt: String(defaults.l1ArtifactPrompt || '')
        };
      },

      onLearnContextFileSelected(event) {
        const file = event?.target?.files?.[0];
        if (!file) {
          this.learnContextForm.fileName = '';
          this.learnContextForm.fileText = '';
          return;
        }

        const reader = new FileReader();
        reader.onload = () => {
          this.learnContextForm.fileName = String(file.name || '');
          this.learnContextForm.fileText = String(reader.result || '');
        };
        reader.onerror = () => {
          this.learnContextMessage = 'Failed to read file';
          this.learnContextForm.fileName = '';
          this.learnContextForm.fileText = '';
        };
        reader.readAsText(file, 'utf-8');
      },

      buildLearnContextPayload() {
        return {
          text: String(this.learnContextForm.fileText || ''),
          wordsPerBlock: toPositiveInt(this.learnContextForm.wordsPerBlock) || 180,
          fromBlock: toPositiveInt(this.learnContextForm.fromBlock) || undefined,
          toBlock: toPositiveInt(this.learnContextForm.toBlock) || undefined,
          learningIntent: String(this.learnContextForm.learningIntent || ''),
          l1ArtifactPrompt: String(this.learnContextForm.l1ArtifactPrompt || '')
        };
      },

      async runLearnContext() {
        if (!this.selectedAgent || this.learnContextInProgress) return;
        if (!String(this.learnContextForm.fileText || '').trim()) {
          this.learnContextMessage = 'Select a text file first';
          return;
        }

        this.learnContextInProgress = true;
        this.learnContextMessage = '';

        try {
          const payload = this.buildLearnContextPayload();
          const response = await fetch(`/api/agents/${this.selectedAgent}/memory/learn-context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            if (response.status === 409 && data.cancelled) {
              this.learnContextMessage = `Learn Context cancelled (${data.run?.sentToSession || 0}/${data.run?.totalChunks || 0} chunks sent)`;
              this.learnContextResult = data.run || null;
              return;
            }
            throw new Error(data.error || `HTTP ${response.status}`);
          }

          this.learnContextResult = data.run || null;
          const blockSelected = data.run?.blocks?.selected || 0;
          const sent = data.run?.sentToSession || 0;
          this.learnContextMessage = `Learn Context completed: sent ${sent}/${blockSelected} chunks`;
          this.activeTab = 'context';
          await Promise.all([
            this.loadAgentData(),
            this.loadSessionInfo(),
            this.loadMessageDates()
          ]);
        } catch (e) {
          console.error('Learn Context failed:', e);
          this.learnContextMessage = `Learn Context failed: ${e.message}`;
        } finally {
          this.learnContextInProgress = false;
          setTimeout(() => {
            this.learnContextMessage = '';
          }, 8000);
        }
      },

      async stopLearnContextRun() {
        if (!this.selectedAgent || !this.learnContextInProgress || this.learnContextStopInProgress) return;
        this.learnContextStopInProgress = true;
        try {
          const response = await fetch(`/api/agents/${this.selectedAgent}/memory/learn-context/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          this.learnContextMessage = data.running
            ? 'Stop requested for current Learn Context run'
            : 'No active Learn Context run';
        } catch (e) {
          console.error('Stop Learn Context failed:', e);
          this.learnContextMessage = `Stop failed: ${e.message}`;
        } finally {
          this.learnContextStopInProgress = false;
        }
      },

      async saveLearnContextDefaults() {
        if (!this.selectedAgent) return;

        try {
          const payload = this.buildLearnContextPayload();
          this.agentConfig.learnContext = {
            wordsPerBlock: payload.wordsPerBlock,
            fromBlock: payload.fromBlock || null,
            toBlock: payload.toBlock || null,
            learningIntent: payload.learningIntent,
            l1ArtifactPrompt: payload.l1ArtifactPrompt
          };

          const response = await fetch(`/api/agents/${this.selectedAgent}/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.agentConfig)
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          this.learnContextMessage = 'Learn Context defaults saved for this agent';
        } catch (e) {
          console.error('Failed to save Learn Context defaults:', e);
          this.learnContextMessage = `Save defaults failed: ${e.message}`;
        }
      }
    };
  }

  globalObj.HmAppMemoryLearnMethods = { createMethods };
}(window));

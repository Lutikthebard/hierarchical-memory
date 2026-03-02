(function attachHmAppMemoryLearnMethods(globalObj) {
  function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  }

  function parseMapLines(text) {
    const out = {};
    const lines = String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!key || !value) continue;
      out[key] = value;
    }
    return out;
  }

  function formatMapLines(map) {
    if (!map || typeof map !== 'object') return '';
    return Object.entries(map)
      .filter(([, value]) => String(value || '').trim())
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
  }

  function createMethods() {
    return {
      fillLearnContextFormFromConfig() {
        const defaults = this.agentConfig?.learnContext || {};
        this.learnContextForm = {
          ...this.learnContextForm,
          wordsPerBlock: toPositiveInt(defaults.wordsPerBlock) || 180,
          fromBlock: toPositiveInt(defaults.fromBlock) || '',
          toBlock: toPositiveInt(defaults.toBlock) || '',
          learningIntent: String(defaults.learningIntent || ''),
          l1ArtifactPrompt: String(defaults.l1ArtifactPrompt || ''),
          aggregatePrompt: String(defaults.aggregatePrompt || ''),
          aggregatePromptsByLevelText: formatMapLines(defaults.aggregatePromptsByLevel || {}),
          thresholdL1: toPositiveInt(defaults.thresholds?.L1) || '',
          thresholdDefault: toPositiveInt(defaults.thresholds?.default) || '',
          thresholdByLevelText: formatMapLines(
            Object.fromEntries(
              Object.entries(defaults.thresholds || {}).filter(([key]) => /^L\d+$/i.test(String(key || '')))
            )
          ),
          runFullSummarize: defaults.runFullSummarize !== false,
          maxTargetLevel: toPositiveInt(defaults.maxTargetLevel) || '',
          aggregateBatch: toPositiveInt(defaults.aggregateBatch) || ''
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
        const thresholds = {};
        const l1 = toPositiveInt(this.learnContextForm.thresholdL1);
        const def = toPositiveInt(this.learnContextForm.thresholdDefault);
        if (l1) thresholds.L1 = l1;
        if (def) thresholds.default = def;

        const thresholdLines = parseMapLines(this.learnContextForm.thresholdByLevelText);
        for (const [key, value] of Object.entries(thresholdLines)) {
          const parsed = toPositiveInt(value);
          if (!parsed) continue;
          const trimmed = String(key || '').trim();
          if (!/^L\d+$/i.test(trimmed)) continue;
          thresholds[trimmed.toUpperCase()] = parsed;
        }

        return {
          text: String(this.learnContextForm.fileText || ''),
          wordsPerBlock: toPositiveInt(this.learnContextForm.wordsPerBlock) || 180,
          fromBlock: toPositiveInt(this.learnContextForm.fromBlock) || undefined,
          toBlock: toPositiveInt(this.learnContextForm.toBlock) || undefined,
          learningIntent: String(this.learnContextForm.learningIntent || ''),
          l1ArtifactPrompt: String(this.learnContextForm.l1ArtifactPrompt || ''),
          aggregatePrompt: String(this.learnContextForm.aggregatePrompt || ''),
          aggregatePromptsByLevel: parseMapLines(this.learnContextForm.aggregatePromptsByLevelText),
          thresholds,
          runFullSummarize: this.learnContextForm.runFullSummarize !== false,
          maxTargetLevel: toPositiveInt(this.learnContextForm.maxTargetLevel) || undefined,
          aggregateBatch: toPositiveInt(this.learnContextForm.aggregateBatch) || undefined
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
            throw new Error(data.error || `HTTP ${response.status}`);
          }

          this.learnContextResult = data.run || null;
          const l1Created = data.run?.l1?.created || 0;
          const blockSelected = data.run?.blocks?.selected || 0;
          this.learnContextMessage = `Learn Context completed: ${l1Created}/${blockSelected} L1 artifacts`;
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

      async saveLearnContextDefaults() {
        if (!this.selectedAgent) return;

        try {
          const payload = this.buildLearnContextPayload();
          this.agentConfig.learnContext = {
            wordsPerBlock: payload.wordsPerBlock,
            fromBlock: payload.fromBlock || null,
            toBlock: payload.toBlock || null,
            learningIntent: payload.learningIntent,
            l1ArtifactPrompt: payload.l1ArtifactPrompt,
            aggregatePrompt: payload.aggregatePrompt,
            aggregatePromptsByLevel: payload.aggregatePromptsByLevel,
            runFullSummarize: payload.runFullSummarize,
            maxTargetLevel: payload.maxTargetLevel || null,
            aggregateBatch: payload.aggregateBatch || null,
            thresholds: payload.thresholds
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

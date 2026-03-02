(function attachHmAppMemoryExportMethods(globalObj) {
  function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  }

  function toIsoOrNull(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid date: ${raw}`);
    }
    return parsed.toISOString();
  }

  function toTreeText(roots) {
    const lines = [];

    function walk(node, indent) {
      const pad = '  '.repeat(indent);
      if (!node || typeof node !== 'object') return;

      if (node.type === 'message') {
        const archived = node.archived ? ' [ARCHIVED]' : '';
        const role = String(node.role || 'unknown').toUpperCase();
        lines.push(`${pad}- L0 message${archived} [${node.timestamp || 'unknown'}] ${role}`);
        const content = String(node.content || '').replace(/\s+/g, ' ').trim();
        if (content) {
          lines.push(`${pad}  ${content}`);
        }
        return;
      }

      lines.push(
        `${pad}- L${Number(node.level || 0)} artifact ${node.artifactId || 'no-id'} ` +
        `(${node.startTimestamp || 'unknown'} -> ${node.endTimestamp || 'unknown'})`
      );
      const content = String(node.content || '').replace(/\s+/g, ' ').trim();
      if (content) {
        lines.push(`${pad}  ${content.slice(0, 240)}${content.length > 240 ? '...' : ''}`);
      }
      for (const child of node.children || []) {
        walk(child, indent + 1);
      }
    }

    for (const root of roots || []) {
      walk(root, 0);
    }
    return lines.join('\n');
  }

  function createMethods() {
    return {
      buildExportContextPayload() {
        return {
          fromLevel: toPositiveInt(this.exportContextForm.fromLevel) || 1,
          toLevel: toPositiveInt(this.exportContextForm.toLevel) || undefined,
          dateFrom: toIsoOrNull(this.exportContextForm.dateFrom) || undefined,
          dateTo: toIsoOrNull(this.exportContextForm.dateTo) || undefined,
          includeArchivedMessages: this.exportContextForm.includeArchivedMessages !== false,
          outputFileName: String(this.exportContextForm.outputFileName || '').trim() || undefined,
          maxNodes: toPositiveInt(this.exportContextForm.maxNodes) || undefined
        };
      },

      async exportLearnedContext() {
        if (!this.selectedAgent || this.exportContextInProgress) return;
        this.exportContextInProgress = true;
        this.exportContextMessage = '';

        try {
          const payload = this.buildExportContextPayload();
          const response = await fetch(`/api/agents/${this.selectedAgent}/memory/export-context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }

          this.exportContextResult = data.run || null;
          this.exportContextTreeText = toTreeText(data.run?.tree?.roots || []);
          const rootCount = data.run?.stats?.rootArtifacts || 0;
          this.exportContextMessage = `Export completed: ${rootCount} root artifacts`;
        } catch (e) {
          console.error('Export Context failed:', e);
          this.exportContextMessage = `Export failed: ${e.message}`;
        } finally {
          this.exportContextInProgress = false;
          setTimeout(() => {
            this.exportContextMessage = '';
          }, 8000);
        }
      }
    };
  }

  globalObj.HmAppMemoryExportMethods = { createMethods };
}(window));
